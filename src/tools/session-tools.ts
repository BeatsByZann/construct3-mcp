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
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import { changedSinceSeen, clearStamps, journalEntries, lastEntry, revertEntry, supersededBy, type JournalEntry } from '../construct3/change-journal.js';
import { relative, sep } from 'node:path';

export function registerSessionTools(server: McpServer, session: ProjectSession, idGen: IdGenerator): void {
  const rel = (path: string) => relative(session.reader.getProjectDir(), path).split(sep).join('/');
  const describeEntry = (entry: JournalEntry) => ({
    id: entry.id,
    tool: entry.tool,
    at: new Date(entry.startedAt).toISOString(),
    reverted: entry.reverted === true,
    changes: entry.changes.map(c => ({
      kind: c.kind,
      file: rel(c.path),
      ...(c.from ? { from: rel(c.from) } : {}),
      ...(c.backupPath ? { backup: rel(c.backupPath) } : {}),
    })),
  });

  server.tool(
    'reload_project',
    'Re-read the project from disk after Construct or another program saved it: every cached file, the project index and the file stamps the '
      + 'tools keep. A write to a file that changed on disk since the server last read it is refused until this is called. Reports which '
      + 'files had changed.',
    {},
    async () => {
      try {
        const changed = await changedSinceSeen();
        clearStamps();
        await session.reader.reloadProject();
        resetProjectIndex();
        return toolResult({
          success: true,
          project: session.reader.getMetadata().name,
          changedOnDisk: changed.map(c => ({ file: rel(c.path), state: c.state })),
        });
      } catch (error) {
        return toolError(`Could not reload the project: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'list_changes',
    'List what recent tool calls changed on disk, newest first: each call with the files it wrote, created, deleted or moved and the .bak backup '
      + 'each write left. Only calls that changed a file appear.',
    {
      limit: z.number().int().min(1).max(50).optional().default(20).describe('How many calls to list (default 20, newest first)'),
    },
    async ({ limit }) => toolResult({ calls: journalEntries(limit).map(describeEntry) }),
  );

  server.tool(
    'revert_last_change',
    'Undo the most recent tool call that changed files, from the .bak backups its writes left: written files are restored, created files '
      + 'removed, deleted files restored, moved files moved back. Refused when a later call touched the same files, because their backups '
      + 'then hold that later state. A change without a backup (a placeholder image overwritten) is reported as not restorable.',
    {},
    async () => {
      try {
        const entry = lastEntry();
        if (!entry) return toolError('No tool call of this server has changed a file yet, or every such call was already reverted.');
        const later = supersededBy(entry);
        if (later.length > 0) {
          return toolError(`The last change (call ${entry.id}, ${entry.tool}) cannot be reverted: later call(s) ${later.map(e => `${e.id} (${e.tool})`).join(', ')} touched the same file(s), and the backups now hold that later state. Revert those first, or restore the .bak files by hand.`);
        }
        const report = await revertEntry(entry);
        clearStamps();
        await session.reader.reloadProject();
        resetProjectIndex();
        return toolResult({
          success: report.failed.length === 0,
          reverted: describeEntry(entry),
          restored: report.restored.map(r => ({ file: rel(r.path), how: r.how })),
          ...(report.failed.length > 0 ? { notRestored: report.failed.map(f => ({ file: rel(f.path), reason: f.reason })) } : {}),
        });
      } catch (error) {
        return toolError(`Could not revert: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
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
