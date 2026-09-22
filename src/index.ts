#!/usr/bin/env node

/**
 * Construct3 MCP Server
 * Model Context Protocol server for Construct 3 game engine projects
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerProjectResources } from './resources/project.js';
import { registerDocsResources } from './resources/docs.js';
import { registerQueryTools } from './tools/query.js';
import { registerWorkflowPrompts } from './prompts/workflows.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerUsageTools } from './tools/usage-tools.js';
import { registerMutationTools } from './tools/mutations.js';
import { Construct3ProjectWriter } from './construct3/project-writer.js';
import { IdGenerator } from './construct3/id-generator.js';
import { registerRuntimeTools } from './tools/runtime-tools.js';
import { ProjectSession } from './construct3/project-session.js';
import { registerSessionTools } from './tools/session-tools.js';

// Use explicit path if given, otherwise auto-detect .c3proj in current working directory.
// A .c3p path opens the archive through a working folder that is written back after each change;
// open_project switches to another project while the server runs.
const projectPath: string = process.argv[2] || process.env.C3_PROJECT_PATH || process.cwd();

const server = new McpServer(
  { name: 'construct3-mcp-server', version: '1.8.2' },
  { capabilities: { resources: {}, tools: {}, prompts: {} } }
);

async function main() {
  try {
    console.error('Construct3 MCP Server starting...');
    console.error(`Project path: ${projectPath}`);

    const session = await ProjectSession.start(projectPath);
    const reader = session.reader;
    if (session.archive) console.error(`Opened ${session.archive.archivePath} in the working folder ${session.archive.workDir}`);
    console.error(`Loaded Construct3 project: ${reader.getMetadata().name}`);
    process.once('exit', () => {
      const kept = session.closeSync();
      if (kept) console.error(`Kept the working folder with unsaved changes: ${kept}`);
    });
    // Every tool goes through the session's gate: a .c3p is written back after
    // each change, and open_project switches projects between calls.
    session.install(server);

    // Register all modular handlers
    registerProjectResources(server, reader);
    registerDocsResources(server);
    registerQueryTools(server, reader);
    registerWorkflowPrompts(server, reader);
    registerAnalysisTools(server, reader);
    registerUsageTools(server, reader);

    // Phase 3: Safe Modifications
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    registerMutationTools(server, reader, writer, idGen);
    registerSessionTools(server, session, idGen);

    // Runtime Control (for live game testing via browser automation)
    const runtimeTools = registerRuntimeTools({ server, reader, writer });

    // Start transport
    const transport = new StdioServerTransport();
    server.server.onclose = () => {
      void runtimeTools.close();
    };
    process.stdin.once('end', () => {
      void server.close();
    });
    const stopForSignal = () => {
      void runtimeTools.close()
        .then(() => server.close())
        .finally(() => process.exit(0));
    };
    process.once('SIGINT', stopForSignal);
    process.once('SIGTERM', stopForSignal);
    await server.connect(transport);

    console.error('Construct3 MCP Server ready');
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
