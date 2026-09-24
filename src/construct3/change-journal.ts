/**
 * Two records the tools keep about project files, for runs where the
 * Construct editor and the tools may take turns on one project:
 *
 * File stamps: the size and modification time of every project file this
 * process last read or wrote. Before a file is overwritten or deleted, its
 * stamp is compared with the disk; a file that changed in between was saved
 * by Construct or another program, and the write is refused until
 * `reload_project` picks the change up. The `.c3p` route has the same
 * protection for its archive; this gives folder projects theirs.
 *
 * Change journal: what each tool call did to which file, grouped per call
 * through an async context the tool gate opens. `list_changes` shows it and
 * `revert_last_change` undoes the most recent call from the backups every
 * write already leaves.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { platform } from 'node:os';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export type ChangeKind = 'write' | 'create' | 'delete' | 'move' | 'copy' | 'overwrite-no-backup';

export interface Change {
  kind: ChangeKind;
  /** The file as it is after the change (for a move, its new path). */
  path: string;
  /** The `.bak` copy of the previous content, for a write or delete. */
  backupPath?: string;
  /** For a move: where the file was. */
  from?: string;
}

export interface JournalEntry {
  id: number;
  tool: string;
  startedAt: number;
  changes: Change[];
  /** Files the call found changed on disk since this process last saw them: Construct or another program saved them. */
  outside: string[];
  reverted?: boolean;
}

export class ExternalChangeError extends Error {
  constructor(readonly path: string, readonly stamp: FileStamp, readonly now: FileStamp) {
    super(
      `"${path}" changed on disk after this server last read it (size ${stamp.size} to ${now.size}, modified ${new Date(stamp.mtimeMs).toISOString()} to ${new Date(now.mtimeMs).toISOString()}): Construct or another program saved it. Call reload_project to pick that change up, then repeat this call.`,
    );
    this.name = 'ExternalChangeError';
  }
}

const MAX_ENTRIES = 50;
const stamps = new Map<string, FileStamp & { path: string }>();
const entries: JournalEntry[] = [];
const context = new AsyncLocalStorage<JournalEntry>();
let nextId = 1;

/** Stamp keys: absolute, and without case where the file system ignores it. */
function key(path: string): string {
  const absolute = resolve(path);
  return platform() === 'win32' ? absolute.toLowerCase() : absolute;
}

// ─── Stamps ────────────────────────────────────────────────

/**
 * Remember a file as just read or written. A file whose stamp no longer
 * matched what was read was saved by something else since; the call in
 * progress is told, so its result can say so.
 */
export function noteSeen(path: string, stats: { mtimeMs: number; size: number }): void {
  const k = key(path);
  const previous = stamps.get(k);
  if (previous && (previous.size !== stats.size || Math.abs(previous.mtimeMs - stats.mtimeMs) > 1)) {
    const entry = context.getStore();
    if (entry && !entry.outside.some(p => key(p) === k)) entry.outside.push(resolve(path));
  }
  stamps.set(k, { mtimeMs: stats.mtimeMs, size: stats.size, path: resolve(path) });
}

/**
 * Stamp the file from its current state on disk after this process wrote
 * or restored it, silently: its own change is not an outside one. A
 * missing file clears its stamp.
 */
export async function restamp(path: string): Promise<void> {
  try {
    const stats = await stat(path);
    stamps.set(key(path), { mtimeMs: stats.mtimeMs, size: stats.size, path: resolve(path) });
  } catch {
    stamps.delete(key(path));
  }
}

export function forgetStamp(path: string): void {
  stamps.delete(key(path));
}

export function stampOf(path: string): FileStamp | undefined {
  const stamp = stamps.get(key(path));
  return stamp ? { mtimeMs: stamp.mtimeMs, size: stamp.size } : undefined;
}

/**
 * Refuse to touch a file that changed since this process last read or
 * wrote it. A file never seen, or gone, passes: nothing is known about it.
 */
export async function assertUnchanged(path: string): Promise<void> {
  const stamp = stamps.get(key(path));
  if (!stamp) return;
  let now;
  try {
    now = await stat(path);
  } catch {
    return;
  }
  // A modification time within a millisecond is the same write on file
  // systems that round; a size change is a change whatever the time says.
  if (now.size !== stamp.size || Math.abs(now.mtimeMs - stamp.mtimeMs) > 1) {
    throw new ExternalChangeError(path, stamp, { mtimeMs: now.mtimeMs, size: now.size });
  }
}

/** Files whose stamp no longer matches the disk (changed, or gone). */
export async function changedSinceSeen(): Promise<Array<{ path: string; state: 'changed' | 'missing' }>> {
  const out: Array<{ path: string; state: 'changed' | 'missing' }> = [];
  for (const stamp of stamps.values()) {
    const path = stamp.path;
    try {
      const now = await stat(path);
      if (now.size !== stamp.size || Math.abs(now.mtimeMs - stamp.mtimeMs) > 1) out.push({ path, state: 'changed' });
    } catch {
      out.push({ path, state: 'missing' });
    }
  }
  return out;
}

export function clearStamps(): void {
  stamps.clear();
}

// ─── Journal ───────────────────────────────────────────────

/** Run a tool call with its own journal entry; the entry is kept when it changed anything. */
export async function withJournalEntry<T>(tool: string, run: () => Promise<T>): Promise<{ result: T; entry: JournalEntry }> {
  const entry: JournalEntry = { id: nextId++, tool, startedAt: Date.now(), changes: [], outside: [] };
  try {
    const result = await context.run(entry, run);
    return { result, entry };
  } finally {
    if (entry.changes.length > 0) {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    }
  }
}

/** The entry of the tool call in progress, if any (none outside a gated call, such as in unit tests). */
export function currentEntry(): JournalEntry | undefined {
  return context.getStore();
}

export function recordChange(change: Change): void {
  context.getStore()?.changes.push(change);
}

/** Drop the record of a change that was undone by the tool itself (a rolled-back move). */
export function forgetChange(path: string): void {
  const entry = context.getStore();
  if (!entry) return;
  for (let i = entry.changes.length - 1; i >= 0; i--) {
    if (key(entry.changes[i].path) === key(path)) { entry.changes.splice(i, 1); return; }
  }
}

export function journalEntries(limit = 20): JournalEntry[] {
  return entries.slice(-limit).reverse();
}

/** The most recent entry that has not been reverted. */
export function lastEntry(): JournalEntry | undefined {
  return [...entries].reverse().find(e => !e.reverted);
}

/**
 * Entries after `entry` that touched any of its files, which makes its
 * backups stale. A reverted later entry counts too: its revert copied the
 * same `.bak` back, so that backup no longer holds what preceded `entry`.
 */
export function supersededBy(entry: JournalEntry): JournalEntry[] {
  const paths = new Set(entry.changes.flatMap(c => [key(c.path), ...(c.from ? [key(c.from)] : [])]));
  return entries.filter(e => e.id > entry.id && e.changes.some(c => paths.has(key(c.path)) || (c.from !== undefined && paths.has(key(c.from)))));
}

export function clearJournal(): void {
  entries.length = 0;
}

export interface RevertReport {
  restored: Array<{ path: string; how: string }>;
  failed: Array<{ path: string; reason: string }>;
}

/** Undo an entry's changes, last first, from the backups its writes left. */
export async function revertEntry(entry: JournalEntry): Promise<RevertReport> {
  const report: RevertReport = { restored: [], failed: [] };
  for (let i = entry.changes.length - 1; i >= 0; i--) {
    const change = entry.changes[i];
    try {
      switch (change.kind) {
        case 'write':
        case 'delete':
          if (!change.backupPath) throw new Error('no backup was recorded');
          await mkdir(dirname(change.path), { recursive: true });
          await copyFile(change.backupPath, change.path);
          await restamp(change.path);
          report.restored.push({ path: change.path, how: `restored from ${change.backupPath}` });
          break;
        case 'create':
        case 'copy':
          await unlink(change.path);
          forgetStamp(change.path);
          report.restored.push({ path: change.path, how: 'removed (the call created it)' });
          break;
        case 'move':
          if (!change.from) throw new Error('the move recorded no origin');
          await mkdir(dirname(change.from), { recursive: true });
          await rename(change.path, change.from);
          forgetStamp(change.path);
          await restamp(change.from);
          report.restored.push({ path: change.from, how: `moved back from ${change.path}` });
          break;
        case 'overwrite-no-backup':
          throw new Error('the previous content was not backed up');
      }
    } catch (error) {
      report.failed.push({ path: change.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  entry.reverted = true;
  return report;
}
