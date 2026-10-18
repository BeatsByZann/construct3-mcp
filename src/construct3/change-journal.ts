/**
 * What recent tool calls changed on disk, for list_changes and
 * revert_last_change. When a tool call ends, withProjectSync records the
 * call from its tool call scope (disk-state.ts): the files it wrote,
 * created, deleted or renamed, in order, the backup each write left, and
 * the state it left each file in (unknown for a file another write landed
 * on). The journal is kept in memory for each open project (by reader), the
 * last MAX_JOURNAL_ENTRIES calls; a server restart starts with an empty
 * journal (the .bak files stay).
 *
 * A revert puts the last call's files back from those backups, last change
 * first, through the writer (RevertPort). It refuses before restoring
 * anything when a file or a backup is no longer as expected, stops at the
 * first step it cannot undo, and keeps its progress, so the next revert
 * resumes there.
 */

import {
  fileKey,
  sameFileState,
  statFileState,
  StaleFileError,
  type CallChange,
  type CallMove,
  type FileState,
  type ToolCallScope,
} from './disk-state.js';

/** How many calls the journal keeps per project. */
export const MAX_JOURNAL_ENTRIES = 50;

/** One change a call made: a file written, created or deleted, or renamed. */
export type JournalChange =
  | { readonly kind: 'write' | 'create' | 'delete'; readonly file: CallChange }
  | { readonly kind: 'move'; readonly move: CallMove };

/** A file a call's changes involve. */
export interface JournalFile {
  readonly key: string;
  readonly path: string;
  readonly label: string;
}

/** One recorded tool call. */
export interface JournalEntry {
  readonly id: number;
  readonly tool: string;
  /** When the call started (entries are in the order calls ended). */
  readonly startedAt: number;
  /** In the order the call made them. */
  readonly changes: readonly JournalChange[];
  /** Every file the changes involve (both ends of a rename), once. */
  readonly files: readonly JournalFile[];
  /**
   * The state each file is expected in now, by key: the state the call left
   * it in, or the one a partial revert left it in (undefined: not known,
   * which a revert never restores over).
   */
  readonly expected: Map<string, FileState | undefined>;
  /** How many changes, from the last, a revert already undid. */
  undone: number;
  /** Set when every change was undone. */
  reverted: boolean;
}

/** An entry as list_changes and revert_last_change show it. */
export interface DescribedEntry {
  id: number;
  tool: string;
  at: string;
  reverted: boolean;
  changes: Array<{ kind: string; file: string; from?: string; backup?: string }>;
}

/** What one revert attempt did. */
export interface RevertReport {
  restored: Array<{ file: string; how: string }>;
  notRestored: Array<{ file: string; reason: string }>;
}

/**
 * What the port reports for a file it put back: not done, or done with the
 * state it left the file in (null: removed), read under the file's lock.
 * The state is undefined (not known) when the restore was made but the file
 * could not be read back; the entry then expects no known state of the file,
 * so no later step restores or renames over it and changedSinceCall lists it.
 * A file that holds other bytes after the restore is not done.
 */
export type PutBackOutcome =
  | { readonly done: false }
  | { readonly done: true; readonly state: FileState | undefined };

/**
 * What the port reports for a file it renamed back: not done, or done with
 * the states of both ends, read under the file's lock (the target is null).
 */
export type RenameOutcome =
  | { readonly done: false }
  | { readonly done: true; readonly fromState: FileState; readonly toState: null };

/**
 * What a revert needs from the project writer. A step that was done reports
 * the state it left its files in, so the revert never reads one again after
 * the step (outside the lock, and a read that fails there must not turn a
 * step that worked into a failure).
 */
export interface RevertPort {
  putBackChange(change: CallChange, asLeft: () => FileState | undefined): Promise<PutBackOutcome>;
  renameBack(move: CallMove, toState: FileState | undefined): Promise<RenameOutcome>;
  afterRevert(projectPutBack: boolean): Promise<void>;
  withAnimationLock<T>(fn: () => Promise<T>): Promise<T>;
}

interface Journal {
  entries: JournalEntry[];
  nextId: number;
  lock: Promise<unknown>;
}

const journals = new WeakMap<object, Journal>();

function journalOf(owner: object): Journal {
  let journal = journals.get(owner);
  if (!journal) {
    journal = { entries: [], nextId: 1, lock: Promise.resolve() };
    journals.set(owner, journal);
  }
  return journal;
}

/** The state the call left a file in, or undefined when it is not known to be the call's. */
function leftState(scope: ToolCallScope, key: string): FileState | undefined {
  return scope.unowned.has(key) ? undefined : scope.reads.get(key);
}

/**
 * The changes a tool call scope recorded, in order. A change the writer
 * undid, and a file the call owns that ends in the state it had before the
 * call (created and removed again, a rolled-back frame change), are left
 * out.
 */
export function callChanges(scope: ToolCallScope): JournalChange[] {
  const out: JournalChange[] = [];
  for (const step of scope.steps) {
    if ('move' in step) {
      out.push({ kind: 'move', move: step.move });
      continue;
    }
    const file = scope.changes.get(step.file);
    if (!file) continue;
    const left = leftState(scope, step.file);
    const before = scope.before.get(step.file);
    if (left !== undefined && before !== undefined && sameFileState(left, before)) continue;
    out.push({ kind: !file.backup.existed ? 'create' : left === null ? 'delete' : 'write', file });
  }
  return out;
}

/**
 * Record a finished tool call of the project `owner` (its reader). Returns
 * the entry, or undefined when the call changed nothing.
 */
export function recordToolCall(owner: object, tool: string, startedAt: number, scope: ToolCallScope): JournalEntry | undefined {
  const changes = callChanges(scope);
  if (changes.length === 0) return undefined;
  const files = new Map<string, JournalFile>();
  const add = (path: string, label: string) => {
    const key = fileKey(path);
    if (!files.has(key)) files.set(key, { key, path, label });
  };
  for (const c of changes) {
    if (c.kind === 'move') {
      add(c.move.from, c.move.fromLabel);
      add(c.move.to, c.move.toLabel);
    } else {
      add(c.file.path, c.file.label);
    }
  }
  const expected = new Map([...files.keys()].map(key => [key, leftState(scope, key)]));
  const journal = journalOf(owner);
  const entry: JournalEntry = {
    id: journal.nextId++, tool, startedAt, changes, files: [...files.values()], expected, undone: 0, reverted: false,
  };
  journal.entries.push(entry);
  if (journal.entries.length > MAX_JOURNAL_ENTRIES) journal.entries.splice(0, journal.entries.length - MAX_JOURNAL_ENTRIES);
  return entry;
}

/**
 * The project's last `limit` entries, newest first. `limit` is whole and
 * kept between 1 and MAX_JOURNAL_ENTRIES (NaN gives the default 20).
 */
export function journalEntries(owner: object, limit = 20): JournalEntry[] {
  const count = Number.isNaN(limit) ? 20 : Math.min(Math.max(Math.trunc(limit), 1), MAX_JOURNAL_ENTRIES);
  return journalOf(owner).entries.slice(-count).reverse();
}

/** The most recent entry that was not (fully) reverted. */
export function lastUnrevertedEntry(owner: object): JournalEntry | undefined {
  const { entries } = journalOf(owner);
  for (let i = entries.length - 1; i >= 0; i--) if (!entries[i].reverted) return entries[i];
  return undefined;
}

/** The label of the file a change leaves (for a rename, its new name). */
function changedLabel(change: JournalChange): string {
  return change.kind === 'move' ? change.move.toLabel : change.file.label;
}

/** The line a tool result ends with: the files the call changed. */
export function changedFilesLine(entry: JournalEntry): string {
  const files = [...new Set(entry.changes.map(changedLabel))];
  const backups = entry.changes.filter(c => c.kind === 'write' || c.kind === 'delete').length;
  const list = files.slice(0, 12).join(', ') + (files.length > 12 ? `, and ${files.length - 12} more` : '');
  return `Changed ${files.length} file(s): ${list}${backups > 0 ? ` (${backups} with a .bak backup; revert_last_change undoes this call)` : ''}.`;
}

/** An entry as list_changes shows it; paths relative to the project. */
export function describeEntry(entry: JournalEntry): DescribedEntry {
  return {
    id: entry.id,
    tool: entry.tool,
    at: new Date(entry.startedAt).toISOString(),
    reverted: entry.reverted,
    changes: entry.changes.map(c => {
      if (c.kind === 'move') return { kind: c.kind, file: c.move.toLabel, from: c.move.fromLabel };
      return c.kind === 'create'
        ? { kind: c.kind, file: c.file.label }
        : { kind: c.kind, file: c.file.label, backup: c.file.backupLabel };
    }),
  };
}

/** Run `fn` after every earlier withJournalLock call of the project has finished (one revert at a time). */
export function withJournalLock<T>(owner: object, fn: () => Promise<T>): Promise<T> {
  const journal = journalOf(owner);
  const run = journal.lock.then(fn);
  journal.lock = run.catch(() => undefined);
  return run;
}

/** The changes a revert has not undone yet, in call order. */
function remaining(entry: JournalEntry): readonly JournalChange[] {
  return entry.changes.slice(0, entry.changes.length - entry.undone);
}

/** The keys of the files a list of changes involves. */
function keysOf(changes: readonly JournalChange[]): Set<string> {
  const keys = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'move') {
      keys.add(fileKey(c.move.from));
      keys.add(fileKey(c.move.to));
    } else {
      keys.add(fileKey(c.file.path));
    }
  }
  return keys;
}

/**
 * The files of a recorded call's remaining changes that are no longer in
 * the state expected (saved in the Construct 3 editor, git, another
 * program, or not known to be the call's), and the backups those changes
 * rely on that no longer hold the state from before the call (a later call
 * backed the same file up again, or a hand edit). Both empty: the rest of
 * the call can be reverted.
 *
 * A file or backup that cannot be read (a stat that fails with anything but
 * "no such file") is listed like one that changed: this check cannot tell
 * the two apart and refuses either way. A revert that then fails on an I/O
 * error reports its error code instead (reasonOf).
 */
export async function changedSinceCall(entry: JournalEntry): Promise<{ files: string[]; backups: string[] }> {
  const rest = remaining(entry);
  const keys = keysOf(rest);
  const files: string[] = [];
  const backups: string[] = [];
  for (const file of entry.files) {
    if (!keys.has(file.key)) continue;
    const expected = entry.expected.get(file.key);
    const now = await statFileState(file.path).catch(() => undefined);
    if (expected === undefined || now === undefined || !sameFileState(now, expected)) files.push(file.label);
  }
  for (const c of rest) {
    if (c.kind === 'move' || !c.file.backup.existed) continue;
    const now = await statFileState(c.file.backup.path).catch(() => undefined);
    if (now === undefined || !sameFileState(now, c.file.backup.state)) backups.push(c.file.backupLabel);
  }
  return { files, backups };
}

/**
 * Why an operation failed, for a message that leaves the server: an fs
 * error code (also from a wrapped cause), the message of a stale-file
 * refusal (it names files by project-relative label), or a fixed generic
 * reason. Callers log the full error.
 */
export function reasonOf(error: unknown): string {
  if (error instanceof StaleFileError) return error.message;
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return 'an unexpected error (details are in the server log)';
}

/**
 * Put back what a recorded call changed and a revert has not undone yet,
 * last change first, under the animation lock (renames of frame images
 * cannot interleave with an animation tool). Each undone step is kept on
 * the entry (undone, expected), so a revert that stops at a step it cannot
 * undo resumes there next time. Run changedSinceCall first. A step the port
 * did reports the states it left, which are kept as they are: nothing is
 * read from disk after a step, so nothing can turn a step that worked into a
 * failed one.
 *
 * What a step reports when it does not complete: "changed on disk" (or
 * "while the revert ran") when the file or backup is not in the expected
 * state, which includes a file that holds other bytes right after the
 * restore (a read-back that cannot be made is not that: the step is done,
 * with the file's state unknown, see PutBackOutcome); the
 * error code (reasonOf) when a step threw, such as a stat or write that
 * failed with EACCES. A rename is only tried when the call is known to have
 * left a file at its target (a null or undefined state is never "the call
 * left it absent" for a target).
 */
export async function revertEntry(entry: JournalEntry, port: RevertPort): Promise<RevertReport> {
  return port.withAnimationLock(async () => {
    const report: RevertReport = { restored: [], notRestored: [] };
    const steps = [...remaining(entry)].reverse();
    let projectPutBack = false;
    for (let i = 0; i < steps.length; i++) {
      const change = steps[i];
      let done = false;
      let reason = 'it, or its backup, changed on disk while the revert ran';
      try {
        if (change.kind === 'move') {
          const fromKey = fileKey(change.move.from);
          const toKey = fileKey(change.move.to);
          const renamed = await port.renameBack(change.move, entry.expected.get(toKey));
          done = renamed.done;
          if (renamed.done) {
            entry.expected.set(fromKey, renamed.fromState);
            entry.expected.set(toKey, renamed.toState);
            report.restored.push({ file: change.move.fromLabel, how: `moved back from ${change.move.toLabel}` });
          } else {
            reason = `${change.move.toLabel} changed on disk, or a file is in the way at ${change.move.fromLabel}`;
          }
        } else {
          const key = fileKey(change.file.path);
          const putBack = await port.putBackChange(change.file, () => entry.expected.get(key));
          done = putBack.done;
          if (putBack.done) {
            entry.expected.set(key, putBack.state);
            if (change.file.isProjectFile) projectPutBack = true;
            report.restored.push({
              file: change.file.label,
              how: change.file.backup.existed ? `restored from ${change.file.backupLabel}` : 'removed (the call created it)',
            });
          }
        }
      } catch (error) {
        console.error('[revert_last_change] a step failed:', error);
        done = false;
        reason = reasonOf(error);
      }
      if (!done) {
        report.notRestored.push({ file: changedLabel(change), reason });
        for (const rest of steps.slice(i + 1)) {
          report.notRestored.push({ file: changedLabel(rest), reason: 'not attempted: an earlier step could not be undone' });
        }
        break;
      }
      entry.undone++;
    }
    if (entry.undone === entry.changes.length) entry.reverted = true;
    await port.afterRevert(projectPutBack);
    return report;
  });
}
