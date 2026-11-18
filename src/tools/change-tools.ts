/**
 * Change journal tools: list_changes and revert_last_change. Every tool call
 * that changed a project file is recorded when it ends (withProjectSync,
 * change-journal.ts); these tools list the recorded calls and undo the most
 * recent one from the .bak backups its writes left.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import { toolResult, toolError } from './shared.js';
import { withProjectSync } from './project-sync.js';
import {
  MAX_JOURNAL_ENTRIES,
  changedSinceCall,
  describeEntry,
  journalEntries,
  lastUnrevertedEntry,
  reasonOf,
  revertEntry,
  withJournalLock,
} from '../construct3/change-journal.js';

/** Registers list_changes and revert_last_change, which read and use the change journal. */
export function registerChangeTools({ server: mcpServer, reader, writer }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);

  // ─── list_changes ─────────────────────────────────────────

  server.tool(
    'list_changes',
    'List what recent tool calls changed on disk, newest first: each call with the files it wrote, created, deleted or moved and the .bak backup '
      + 'each write left. Only calls that changed a file appear.',
    {
      limit: z.number().int().min(1).max(MAX_JOURNAL_ENTRIES).optional().default(20).describe('How many calls to list (default 20, newest first)'),
    },
    async (args) => {
      try {
        return toolResult({ calls: journalEntries(reader, args.limit).map(describeEntry) });
      } catch (error) {
        console.error('[list_changes] failed:', error);
        return toolError(`Error listing changes: ${reasonOf(error)}.`);
      }
    }
  );

  // ─── revert_last_change ───────────────────────────────────

  server.tool(
    'revert_last_change',
    'Undo the most recent tool call that changed files, from the .bak backups its writes left: written files are restored, created files '
      + 'removed, deleted files restored, moved files moved back. Only the most recent call that changed a file can be reverted: each file keeps '
      + 'one backup, which the next call that writes it replaces, so a call whose files a later call backed up again cannot be. Images are the '
      + 'exception: each call takes the first free .N.bak name, so a later call does not replace an earlier call\'s image backup and image '
      + 'backups accumulate. Refused, restoring nothing, when any of the files or their '
      + 'backups changed since the call (saved in the Construct 3 editor, for example). A revert that stops part way is finished by the next call.',
    {},
    async () => {
      try {
        return await withJournalLock(reader, async () => {
          const entry = lastUnrevertedEntry(reader);
          if (!entry) return toolError('No tool call of this server has changed a file yet, or every such call was already reverted.');
          const { files, backups } = await changedSinceCall(entry);
          if (backups.length > 0) {
            return toolError(`The last change (call ${entry.id}, ${entry.tool}) cannot be reverted: its backup(s) ${backups.join(', ')} no longer hold `
              + 'the state from before that call (a later call backed the same file(s) up again, since one backup per file is kept, or the backup '
              + 'was changed by hand). Nothing was restored. Only the most recent call that changed a file can be reverted.');
          }
          if (files.length > 0) {
            return toolError(`The last change (call ${entry.id}, ${entry.tool}) cannot be reverted: ${files.join(', ')} changed after that call by something `
              + 'the change journal does not record (Construct, another program, or a tool write outside the journal), so restoring the backups would '
              + 'not return the project to its state before the call. Nothing was restored. Restore the .bak files by hand if that is still what you want.');
          }
          const report = await revertEntry(entry, writer);
          return toolResult({
            success: report.notRestored.length === 0,
            reverted: describeEntry(entry),
            restored: report.restored,
            ...(report.notRestored.length > 0 ? { notRestored: report.notRestored } : {}),
          }, { projectWritten: report.restored.length > 0 });
        });
      } catch (error) {
        console.error('[revert_last_change] failed:', error);
        return toolError(`Could not revert: ${reasonOf(error)}`);
      }
    }
  );
}
