#!/usr/bin/env node

/**
 * Construct3 MCP Server
 * Model Context Protocol server for Construct 3 game engine projects
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Construct3ProjectReader } from './construct3/project-reader.js';
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
import { startC3pSession } from './construct3/project-source.js';
import { findLeftWorkFolders } from './construct3/c3p-archive.js';
import { describeArchiveClose, withArchiveSync } from './tools/archive-sync.js';

// The project: a folder, its .c3proj file, or a single-file .c3p (served through a working folder); else the working directory
const projectPath: string = process.argv[2] || process.env.C3_PROJECT_PATH || process.cwd();

const server = new McpServer(
  { name: 'construct3-mcp-server', version: '1.10.0' },
  { capabilities: { resources: {}, tools: {}, prompts: {} } }
);

async function initializeProject(path: string): Promise<Construct3ProjectReader> {
  let projectFile = path;
  if (!path.endsWith('.c3proj')) {
    const found = await Construct3ProjectReader.findProjectFile(path);
    if (!found) {
      throw new Error(`No .c3proj file found in directory: ${path}`);
    }
    projectFile = found;
  }

  const isValid = await Construct3ProjectReader.isValidProject(projectFile);
  if (!isValid) {
    throw new Error(`Invalid Construct3 project file: ${projectFile}`);
  }

  const reader = new Construct3ProjectReader(projectFile);
  await reader.loadProject();
  console.error(`Loaded Construct3 project: ${reader.getMetadata().name}`);
  return reader;
}

async function main() {
  try {
    console.error('Construct3 MCP Server starting...');
    console.error(`Project path: ${projectPath}`);

    await startC3pSession(projectPath, async (sourcePath, archive) => {
      const reader = await initializeProject(sourcePath);
      let served = server;
      let closeArchive: () => Promise<void> = async () => {};
      if (archive) {
        console.error(`Opened ${archive.archivePath} in the working folder ${archive.workDir}`);
        const left = await findLeftWorkFolders();
        const startupNote = left.length > 0
          ? `Working folder(s) left by a session that stopped without closing (they may hold changes never written back): `
            + `${left.map(l => `${l.sessionDir} (from ${l.archivePath}${l.leftovers.length ? `; also ${l.leftovers.join(', ')}` : ''})`).join('; ')}.`
          : undefined;
        if (startupNote) console.error(startupNote);
        // A .c3p is refreshed before the calls and written back after them
        const wrapped = withArchiveSync(server, archive, { startupNote });
        served = wrapped.server;
        closeArchive = async () => {
          const message = describeArchiveClose(archive, await wrapped.close());
          if (message) console.error(message);
        };
      }

      // Register all modular handlers
      registerProjectResources(served, reader);
      registerDocsResources(served);
      registerQueryTools(served, reader);
      registerWorkflowPrompts(served, reader);
      registerAnalysisTools(served, reader);
      registerUsageTools(served, reader);

      // Phase 3: Safe Modifications
      const idGen = new IdGenerator();
      const writer = new Construct3ProjectWriter(reader, idGen);
      registerMutationTools(served, reader, writer, idGen);

      // Runtime Control (for live game testing via browser automation)
      const runtimeTools = registerRuntimeTools({ server: served, reader, writer, archive });

      // Start transport
      const transport = new StdioServerTransport();
      await server.connect(transport);

      /** Close the runtime tools, then the archive through its gate; once, whatever fails. */
      let stopping: Promise<void> | undefined;
      const shutdown = () => (stopping ??= runtimeTools.close()
        .catch(error => { console.error('Closing the runtime tools failed:', error); })
        .finally(() => closeArchive().catch(error => { console.error('Closing the archive failed:', error); })));
      process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
      process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
      process.stdin.once('end', () => { void shutdown(); });
    });

    console.error('Construct3 MCP Server ready');
  } catch (error) {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
