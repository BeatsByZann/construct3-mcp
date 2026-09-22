/**
 * Which project the server serves: get_open_project and open_project.
 *
 * The server starts on the project its command line names. open_project
 * switches to another folder project or .c3p archive while it runs, so one
 * registered server can edit any project.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type { ProjectSession } from '../construct3/project-session.js';
import { toolResult, toolError } from './shared.js';

export function registerSessionTools(server: McpServer, session: ProjectSession, idGen: IdGenerator): void {
  server.tool(
    'get_open_project',
    'Report the project this server serves: its name and .c3proj path, and for a .c3p the archive path and the working folder it is served through.',
    {},
    async () => {
      const archive = session.archive;
      return toolResult({
        name: session.reader.getMetadata().name,
        projectFile: session.reader.getProjectPath(),
        format: archive ? 'c3p' : 'folder',
        ...(archive ? { archivePath: archive.archivePath, workDir: archive.workDir } : {}),
      });
    },
  );

  server.tool(
    'open_project',
    'Switch the server to another project: a project folder, its .c3proj file, or a single-file .c3p. A .c3p is unpacked into a working folder '
      + 'and written back after every tool call that changes it, never over a copy Construct saved in the meantime. The switch waits for other '
      + 'tool calls to finish. The project being left is written back first when it is a .c3p. If the new project cannot be opened, the current '
      + 'one stays open. Close the project in Construct before editing it here.',
    {
      path: z.string().min(1).describe('Absolute path of a project folder, a .c3proj file, or a .c3p file'),
    },
    async ({ path }) => {
      try {
        const { opened, closed } = await session.open(path, idGen);
        const warnings: string[] = [];
        if (closed.lastWrite && (closed.lastWrite.status === 'conflict' || closed.lastWrite.status === 'failed')) {
          warnings.push(`"${closed.archivePath}" was not written before leaving it: ${closed.lastWrite.reason}.`);
        }
        if (closed.keptWorkDir) {
          warnings.push(`The working folder "${closed.keptWorkDir}" was kept, because it holds changes "${closed.archivePath}" does not.`);
        }
        return toolResult({
          success: true,
          opened: { ...opened, format: opened.archivePath ? 'c3p' : 'folder' },
          closed: { name: closed.name, projectFile: closed.projectFile, ...(closed.archivePath ? { archivePath: closed.archivePath } : {}) },
          ...(warnings.length ? { warnings } : {}),
        });
      } catch (error) {
        return toolError(`The server still serves the project it had. Could not open the new one: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
