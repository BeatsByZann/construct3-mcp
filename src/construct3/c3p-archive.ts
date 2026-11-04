/**
 * A project served from a single-file .c3p archive.
 *
 * The tools work on a folder project, so the archive is unpacked into a
 * private session folder (a new folder under the system's temp folder):
 * the project files into its project/ folder, which the server loads, and
 * the archive's entries the tools could overwrite (those the packer leaves
 * out, and *.tmp files) into its held/ folder, which no tool writes. The
 * archive and the folder are kept in step between tool calls
 * (withArchiveSync in src/tools/archive-sync.ts calls them around the calls):
 * - before a call (refresh), when the archive changed on disk since the
 *   server opened or last wrote it and the project folder holds no change
 *   of the session's that the archive lacks, the archive is unpacked into
 *   a fresh session folder, which is renamed into place; the reader's own
 *   change detection then reads what changed.
 * - after the tool calls (sync), when the project folder changed, the
 *   archive is written back: built in memory from the folder's files and
 *   the held entries, read back and compared with them, staged beside the
 *   archive, and put in place without replacing anything: the archive is
 *   moved aside, compared by content with what this session last read or
 *   wrote, and the new one placed with link (or an exclusive copy), which
 *   fails when a file is there. The first write-back of a session keeps
 *   the archive as it was before it in <archive>.bak; a file already
 *   named so is never replaced (the copy then gets a second name, and the
 *   result says so).
 * - when another program changed the archive and the folder changed too,
 *   the archive is never written: the conflict sticks, every later sync
 *   and refresh reports it, and the folder is kept with the session's
 *   changes until the server stops (close).
 * No step replaces or deletes a version of the archive this server did not
 * write. The folder's files are compared by size and modification time,
 * and by content for files modified less than `recentMs` ago; the archive,
 * at a write-back, by content.
 *
 * The archive and the session folder are written here directly, not
 * through the project writer: the archive is outside the project, and the
 * folder is the server's own copy of it.
 *
 * refresh, sync and close must not overlap on one instance: a refresh that
 * ran during a write-back would see the archive moved aside. The caller
 * serializes them (withArchiveSync holds a gate for it).
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathKey, readZipArchive, type ZipReadEntry } from '../runtime/zip-reader.js';
import { crc32, zipBuffer, type ZipEntry } from '../runtime/zip-writer.js';
import { isPackedProjectFile } from '../runtime/project-files.js';
import { isFileNotFoundError } from './project-reader.js';
import { nameKey } from './names.js';

const PROJECT_FILE = 'project.c3proj';
const SESSION_PREFIX = 'c3p-';
const MARKER_SUFFIX = '.session.json';
/** Default for `recentMs`: a file modified this recently is also compared by content (a write of the same size within one timestamp tick). */
const RECENT_MS = 2000;
/** Error codes of a folder another program holds for a moment (a scanner, an indexer); a rename is tried again on them. */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** How many times a folder rename is tried, and the default wait before the next try (multiplied by the try number). */
const RENAME_ATTEMPTS = 5;
const RETRY_DELAY_MS = 50;

/** What a write-back did: nothing to write, written, refused because the archive changed (the conflict), or failed. */
export type ArchiveSyncStatus = 'unchanged' | 'saved' | 'conflict' | 'failed';

/** What a write-back did. */
export interface ArchiveSyncResult {
  status: ArchiveSyncStatus;
  /** Files written into the archive, when saved */
  fileCount?: number;
  /** Why nothing was written, on a conflict or a failure */
  reason?: string;
  /** What else the user should know: a write-back not confirmed, a file left beside the archive */
  notes?: string[];
  /** The archive stopped (the working folder could not be put back), so only a restart helps */
  stopped?: boolean;
}

/** What a refresh from the archive did. */
export interface ArchiveRefreshResult {
  status: 'unchanged' | 'refreshed' | 'conflict' | 'failed';
  reason?: string;
  notes?: string[];
  /** The archive stopped (the working folder could not be put back), so only a restart helps */
  stopped?: boolean;
}

/** The file operations the archive uses (injectable for tests). */
export interface C3pFs {
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Make `path` a second name of `existing`; fails with EEXIST when `path` exists */
  link(existing: string, path: string): Promise<void>;
  /** Copy `from` to `to`; fails with EEXIST when `to` exists */
  copyFileExclusive(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Remove a folder and everything in it */
  rm(path: string): Promise<void>;
}

const NODE_FS: C3pFs = {
  stat: (path) => nodeFs.stat(path),
  readFile: (path) => nodeFs.readFile(path),
  writeFile: (path, data) => nodeFs.writeFile(path, data),
  rename: (from, to) => nodeFs.rename(from, to),
  link: (existing, path) => nodeFs.link(existing, path),
  copyFileExclusive: (from, to) => nodeFs.copyFile(from, to, constants.COPYFILE_EXCL),
  unlink: (path) => nodeFs.unlink(path),
  rm: (path) => nodeFs.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
};

/** Options of C3pArchive.open. */
export interface C3pArchiveOptions {
  /** Where the session folder is made (default: the system's temp folder) */
  workRoot?: string;
  /** Files of the project folder modified less than this many milliseconds ago are compared by content too (default: 2000) */
  recentMs?: number;
  /** File operations to use instead of node's (each one given replaces node's) */
  fs?: Partial<C3pFs>;
  /** Called after each read of the archive, before its second stat (tests act there) */
  afterRead?: (path: string) => Promise<void>;
  /** Milliseconds to wait before the first new try of a folder rename that failed with EPERM, EBUSY or EACCES, growing with each try (default: 50) */
  retryDelayMs?: number;
}

interface ArchiveStamp {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** The archive's content, split as the session folder holds it. */
interface ArchiveContent {
  project: ZipReadEntry[];
  held: ZipReadEntry[];
  directories: string[];
}

/** What the marker records of a step under way, for the next start to report if this process dies. */
interface PendingStep {
  staging?: string;
  previousArchive?: string;
  nextSession?: string;
}

type FolderStamp = Map<string, string>;

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
const codeOf = (error: unknown): unknown => (error && typeof error === 'object' && 'code' in error ? error.code : undefined);

/** Whether a path names a single-file project archive. */
export function isC3pPath(path: string): boolean {
  return /\.c3p$/i.test(path);
}

/**
 * Whether an archive entry is held apart from the project folder: one the
 * packer leaves out, a *.tmp file (the writer's temp files have that name)
 * or a *.bak file in any case (the writer's backups are copied onto
 * <file>.bak, which on a file system that ignores case would replace a
 * *.BAK entry).
 */
export function isHeldEntry(path: string): boolean {
  return !isPackedProjectFile(path) || /\.(tmp|bak)$/i.test(path);
}

const markerOf = (sessionDir: string): string => `${sessionDir}${MARKER_SUFFIX}`;

/** Every file below `dir`, as paths with forward slashes, in sorted order; none when `dir` does not exist. */
async function folderFiles(dir: string, sub = ''): Promise<string[]> {
  let entries;
  try {
    entries = await nodeFs.readdir(sub ? join(dir, ...sub.split('/')) : dir, { withFileTypes: true });
  } catch (error) {
    if (!sub && isFileNotFoundError(error)) return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await folderFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** The archive's entries, or an error that names the archive as the user gave it. */
function readArchive(label: string, data: Buffer): ArchiveContent {
  let read: { files: ZipReadEntry[]; directories: string[] };
  try {
    read = readZipArchive(data);
  } catch (error) {
    throw new Error(`Cannot read "${label}" as a .c3p archive: ${messageOf(error)}`);
  }
  if (!read.files.some(entry => entry.path === PROJECT_FILE)) {
    throw new Error(`"${label}" has no ${PROJECT_FILE} at its root, so it is not a Construct 3 project archive.`);
  }
  return {
    project: read.files.filter(entry => !isHeldEntry(entry.path)),
    held: read.files.filter(entry => isHeldEntry(entry.path)),
    directories: read.directories,
  };
}

/** Write entries into a folder (the reader refuses paths that would leave it or land on one file). */
async function writeFiles(dir: string, files: readonly ZipReadEntry[]): Promise<void> {
  await nodeFs.mkdir(dir, { recursive: true });
  for (const entry of files) {
    const target = join(dir, ...entry.path.split('/'));
    await nodeFs.mkdir(dirname(target), { recursive: true });
    await nodeFs.writeFile(target, entry.data);
  }
}

/** A single-file project and its session folder (see the module comment). */
export class C3pArchive {
  private conflictReason: string | undefined;
  private stoppedReason: string | undefined;
  private savedThisSession = false;
  private writes = 0;
  private folder: FolderStamp = new Map();
  private directories: string[] = [];
  private readonly fs: C3pFs;

  private constructor(
    /** The archive's path as the user gave it, for messages */
    readonly archivePath: string,
    private readonly resolved: string,
    /** The session folder: project/ (the working folder) and held/ */
    readonly sessionDir: string,
    private stamp: ArchiveStamp,
    private readonly options: C3pArchiveOptions,
  ) {
    this.fs = { ...NODE_FS, ...options.fs };
  }

  /** The working folder: the folder project the server loads. */
  get workDir(): string {
    return join(this.sessionDir, 'project');
  }

  /** The folder project's .c3proj inside the working folder. */
  get projectFile(): string {
    return join(this.workDir, PROJECT_FILE);
  }

  private get heldDir(): string {
    return join(this.sessionDir, 'held');
  }

  /**
   * What `path` is when a tool must not write a file there: the archive, a
   * backup of it (<archive>.bak or <archive>.<anything>.bak), a file a
   * write-back stages or moves aside (<archive>.previous, or
   * <archive>.<anything>.previous or .tmp), or a place in the session
   * folder. Paths are compared as names.ts compares names
   * (NFC, ignoring case). Undefined for any other path.
   */
  protectedPath(path: string): string | undefined {
    const keyOf = (p: string): string => pathKey(resolve(p).replaceAll('\\', '/'));
    const key = keyOf(path);
    const archiveKey = keyOf(this.resolved);
    if (key === archiveKey) return `the open archive "${this.archivePath}"`;
    const sessionKey = keyOf(this.sessionDir);
    if (key === sessionKey || key.startsWith(`${sessionKey}/`)) {
      return `inside the server's working folder "${this.sessionDir}" for the open archive "${this.archivePath}"`;
    }
    // Name and folder come from the resolved path: a raw path ending in "\." or ".." has no name of its own
    const archiveName = pathKey(basename(this.resolved));
    const name = pathKey(basename(resolve(path)));
    if (keyOf(dirname(resolve(path))) === keyOf(dirname(this.resolved)) && name.startsWith(`${archiveName}.`)) {
      if (name.endsWith('.bak')) return `a backup of the open archive "${this.archivePath}"`;
      if (name.endsWith('.previous') || name.endsWith('.tmp')) {
        return `a file the server keeps for the open archive while it writes it back (its previous version or the new archive being put in place) "${this.archivePath}"`;
      }
    }
    return undefined;
  }

  /** Whether the archive is in conflict, or stopped because the session folder could not be put back. */
  status(): { conflict?: string; stopped?: string } {
    return { ...(this.conflictReason ? { conflict: this.conflictReason } : {}), ...(this.stoppedReason ? { stopped: this.stoppedReason } : {}) };
  }

  /** Read the archive with its state taken before and after the read, again while they differ (a save under way). */
  private async readStamped(): Promise<{ data: Buffer; stamp: ArchiveStamp }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.fs.stat(this.resolved);
      const data = await this.fs.readFile(this.resolved);
      await this.options.afterRead?.(this.resolved);
      const after = await this.fs.stat(this.resolved);
      if (before.size === after.size && before.mtimeMs === after.mtimeMs && after.size === data.length) {
        return { data, stamp: { size: after.size, mtimeMs: after.mtimeMs, sha256: sha256(data) } };
      }
    }
    throw new Error(`"${this.archivePath}" kept changing while it was read (a save under way?)`);
  }

  /** Record (or clear) a step under way in the session marker. */
  private async mark(pending?: PendingStep): Promise<void> {
    await this.fs.writeFile(markerOf(this.sessionDir), JSON.stringify({ pid: process.pid, archive: this.resolved, ...(pending ? { pending } : {}) }));
  }

  /** Unpack an archive into a new session folder under `options.workRoot` (default: the system's temp folder). */
  static async open(archivePath: string, options: C3pArchiveOptions = {}): Promise<C3pArchive> {
    const resolved = resolve(archivePath);
    const reading = new C3pArchive(archivePath, resolved, '', { size: -1, mtimeMs: -1, sha256: '' }, options);
    let read;
    try {
      read = await reading.readStamped();
    } catch (error) {
      throw isFileNotFoundError(error) ? await missingArchiveError(archivePath, resolved, options.workRoot ?? tmpdir(), error) : error;
    }
    const { data, stamp } = read;
    const content = readArchive(archivePath, data);
    const sessionDir = await nodeFs.mkdtemp(join(options.workRoot ?? tmpdir(), SESSION_PREFIX));
    const archive = new C3pArchive(archivePath, resolved, sessionDir, stamp, options);
    try {
      await archive.unpackInto(sessionDir, content);
      await archive.mark();
      archive.directories = content.directories;
      archive.folder = await archive.folderStamp(await archive.projectFiles());
      return archive;
    } catch (error) {
      await nodeFs.rm(sessionDir, { recursive: true, force: true });
      await nodeFs.rm(markerOf(sessionDir), { force: true });
      throw error;
    }
  }

  /** The project folder's files the write-back packs: those the packer packs, without temp files and backups. */
  private async projectFiles(): Promise<string[]> {
    return (await folderFiles(this.workDir)).filter(path => !isHeldEntry(path));
  }

  /** Each file's size and modification time in nanoseconds, and its content hash when it was modified recently. */
  private async folderStamp(files: readonly string[]): Promise<FolderStamp> {
    const recentMs = this.options.recentMs ?? RECENT_MS;
    const now = Date.now();
    const stamps: Array<readonly [string, string]> = [];
    for (const path of files) {
      const full = join(this.workDir, ...path.split('/'));
      const info = await nodeFs.stat(full, { bigint: true });
      const base = `${info.size}:${info.mtimeNs}`;
      stamps.push([path, now - Number(info.mtimeMs) < recentMs ? `${base}:${sha256(await nodeFs.readFile(full))}` : base]);
    }
    return new Map(stamps);
  }

  /** Stamps agree when they list the same files with the same size, time and (where both have one) hash. */
  private static sameStamp(a: FolderStamp, b: FolderStamp): boolean {
    if (a.size !== b.size) return false;
    for (const [path, stamp] of a) {
      const other = b.get(path);
      if (other === undefined) return false;
      const [sizeA, timeA, hashA] = stamp.split(':');
      const [sizeB, timeB, hashB] = other.split(':');
      if (sizeA !== sizeB || timeA !== timeB) return false;
      if (hashA !== undefined && hashB !== undefined && hashA !== hashB) return false;
    }
    return true;
  }

  /**
   * How the archive on disk stands against what this session last read or
   * wrote. With `byContent`, its content is compared even when its size
   * and time agree (the write-back's check); else agreeing size and time
   * count as no change (the refresh's check, which never writes the archive).
   */
  private async externalChange(byContent: boolean): Promise<
    { kind: 'none' } | { kind: 'missing' } | { kind: 'unreadable'; reason: string } | { kind: 'changed'; data: Buffer; stamp: ArchiveStamp }
  > {
    let info;
    try {
      info = await this.fs.stat(this.resolved);
    } catch (error) {
      return isFileNotFoundError(error) ? { kind: 'missing' } : { kind: 'unreadable', reason: messageOf(error) };
    }
    if (!byContent && info.size === this.stamp.size && info.mtimeMs === this.stamp.mtimeMs) return { kind: 'none' };
    let read;
    try {
      read = await this.readStamped();
    } catch (error) {
      return isFileNotFoundError(error) ? { kind: 'missing' } : { kind: 'unreadable', reason: messageOf(error) };
    }
    if (read.stamp.sha256 === this.stamp.sha256) {
      // A new time stamp alone is no change
      this.stamp = read.stamp;
      return { kind: 'none' };
    }
    return { kind: 'changed', ...read };
  }

  /** Stop writing: a conflict sticks until the server stops. */
  private stop(reason: string, notes?: string[]): { status: 'conflict'; reason: string; notes?: string[] } {
    this.conflictReason = reason;
    return { status: 'conflict', reason, ...(notes?.length ? { notes } : {}) };
  }

  /** The result while the archive is in conflict or stopped, or undefined. */
  private stuck(): { status: 'conflict' | 'failed'; reason: string; stopped?: boolean } | undefined {
    if (this.stoppedReason) return { status: 'failed', reason: this.stoppedReason, stopped: true };
    if (this.conflictReason) return { status: 'conflict', reason: this.conflictReason };
    return undefined;
  }

  /**
   * Rename a session folder. A folder another program holds for a moment
   * (a virus scanner or indexer on files just written) fails with EPERM,
   * EBUSY or EACCES on Windows; the rename is tried again a few times
   * before the failure is returned.
   */
  private async renameFolder(from: string, to: string): Promise<void> {
    const delay = this.options.retryDelayMs ?? RETRY_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.fs.rename(from, to);
        return;
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_CODES.has(String(codeOf(error)))) throw error;
        if (delay > 0) await new Promise<void>(resolveWait => setTimeout(resolveWait, delay * attempt));
      }
    }
  }

  /** Unpack an archive's content into a session folder (a step of its own, so a test can fail it). */
  private async unpackInto(sessionDir: string, content: ArchiveContent): Promise<void> {
    await writeFiles(join(sessionDir, 'project'), content.project);
    await writeFiles(join(sessionDir, 'held'), content.held);
  }

  /**
   * Replace the session folder with one unpacked from `content`. Returns
   * the old folder's name once the new one is in place (removing it is
   * left to the caller); throws with the session folder as it was when a
   * step before that fails. An old folder left by an earlier refresh is
   * removed first (it holds only a superseded state), else the move aside
   * would fail against it. When the old folder cannot be put back after
   * the new one failed to move in, the archive stops.
   */
  private async publish(content: ArchiveContent): Promise<string> {
    const previous = `${this.sessionDir}.previous`;
    await this.fs.rm(previous);
    const next = await nodeFs.mkdtemp(`${this.sessionDir}.next-`);
    try {
      await this.unpackInto(next, content);
      await this.mark({ nextSession: next });
    } catch (error) {
      await this.fs.rm(next).catch(() => undefined);
      throw error;
    }
    try {
      await this.renameFolder(this.sessionDir, previous);
    } catch (error) {
      await this.fs.rm(next).catch(() => undefined);
      await this.mark().catch(() => undefined);
      throw error;
    }
    try {
      await this.renameFolder(next, this.sessionDir);
    } catch (error) {
      try {
        await this.renameFolder(previous, this.sessionDir);
      } catch (back) {
        this.stoppedReason = `the working folder could not be put back after a failed refresh (${messageOf(back)}); `
          + `this session's files are in "${previous}", and the archive was read into "${next}"`;
        throw error;
      }
      await this.fs.rm(next).catch(() => undefined);
      await this.mark().catch(() => undefined);
      throw error;
    }
    return previous;
  }

  /** Before a call: take the archive as it is on disk when it changed and the folder holds nothing unsaved. Never throws. */
  async refresh(): Promise<ArchiveRefreshResult> {
    const stuck = this.stuck();
    if (stuck) return stuck;
    try {
      const change = await this.externalChange(false);
      if (change.kind === 'none') return { status: 'unchanged' };
      if (change.kind === 'unreadable') return { status: 'failed', reason: change.reason };
      const dirty = !C3pArchive.sameStamp(await this.folderStamp(await this.projectFiles()), this.folder);
      if (change.kind === 'missing') {
        return dirty
          ? this.stop(`"${this.archivePath}" no longer exists, and this session changed the project`)
          : { status: 'failed', reason: `"${this.archivePath}" no longer exists` };
      }
      if (dirty) return this.stop(`"${this.archivePath}" was changed on disk (saved in Construct 3?) after this session changed the project`);
      let content: ArchiveContent;
      try {
        content = readArchive(this.archivePath, change.data);
      } catch (error) {
        // Possibly a save still under way: the next call tries again
        return { status: 'failed', reason: messageOf(error) };
      }
      const previous = await this.publish(content);
      // Published: the new folder and its baseline go together
      this.stamp = change.stamp;
      this.directories = content.directories;
      const notes: string[] = [];
      try {
        this.folder = await this.folderStamp(await this.projectFiles());
      } catch (error) {
        // The folder was replaced, so the old baseline is wrong; an empty one makes the next sync write back (nothing is lost)
        this.folder = new Map();
        notes.push(`the state of the new working folder could not be recorded (${messageOf(error)}); the next write-back may rewrite the archive with the same content`);
      }
      try {
        await this.fs.rm(previous);
      } catch (error) {
        notes.push(`the old working folder "${previous}" could not be removed (${messageOf(error)}); it can be deleted`);
      }
      await this.mark().catch(() => undefined);
      return { status: 'refreshed', ...(notes.length ? { notes } : {}) };
    } catch (error) {
      return this.stuck() ?? { status: 'failed', reason: messageOf(error) };
    }
  }

  /** The archive bytes of the project folder's files and the held entries (read now, their CRCs computed now) and its directory entries. */
  private async buildArchive(projectFiles: readonly string[], heldFiles: readonly string[]): Promise<Buffer> {
    const entries: ZipEntry[] = [];
    for (const [dir, files] of [[this.workDir, projectFiles], [this.heldDir, heldFiles]] as const) {
      for (const path of files) {
        const data = await nodeFs.readFile(join(dir, ...path.split('/')));
        entries.push({ path, data, crc: crc32(data) });
      }
    }
    for (const directory of this.directories) entries.push({ path: directory, data: Buffer.alloc(0) });
    return zipBuffer(entries);
  }

  /** Throw unless `bytes` read back as exactly the session folder's files, read again now. */
  private async checkReadsBack(bytes: Buffer, projectFiles: readonly string[], heldFiles: readonly string[]): Promise<void> {
    const back = readZipArchive(bytes).files;
    const byPath = new Map(back.map(entry => [entry.path, entry.data]));
    const expected = projectFiles.length + heldFiles.length;
    if (back.length !== expected) throw new Error(`The new archive did not read back as the working folder holds it (${back.length} files for ${expected})`);
    for (const [dir, files] of [[this.workDir, projectFiles], [this.heldDir, heldFiles]] as const) {
      for (const path of files) {
        const onDisk = await nodeFs.readFile(join(dir, ...path.split('/')));
        if (!byPath.get(path)?.equals(onDisk)) throw new Error(`The new archive did not read back as the working folder holds ${path}`);
      }
    }
  }

  /**
   * Put a file at `target` (default: the archive's path) without replacing
   * one: 'placed', 'exists' (a file is there), or the error. A link that
   * fails for any reason but an existing file (a volume without hard links
   * reports various codes) is followed by the exclusive copy, which refuses
   * to replace a file just the same.
   */
  private async placeAt(source: string, target: string = this.resolved): Promise<'placed' | 'exists' | { error: unknown }> {
    try {
      await this.fs.link(source, target);
      return 'placed';
    } catch (error) {
      if (codeOf(error) === 'EEXIST') return 'exists';
    }
    try {
      await this.fs.copyFileExclusive(source, target);
      return 'placed';
    } catch (error) {
      return codeOf(error) === 'EEXIST' ? 'exists' : { error };
    }
  }

  /** After the calls: write the folder back when it changed, unless the archive changed on disk too. Never throws. */
  async sync(): Promise<ArchiveSyncResult> {
    const stuck = this.stuck();
    if (stuck) return stuck;
    let projectFiles: string[];
    let heldFiles: string[];
    let current: FolderStamp;
    let bytes: Buffer;
    try {
      projectFiles = await this.projectFiles();
      current = await this.folderStamp(projectFiles);
      if (C3pArchive.sameStamp(current, this.folder)) return { status: 'unchanged' };
      // Before anything is built or staged: an archive that already changed is a conflict
      const before = await this.externalChange(true);
      if (before.kind === 'unreadable') return { status: 'failed', reason: before.reason };
      if (before.kind !== 'none') {
        return this.stop(before.kind === 'missing'
          ? `"${this.archivePath}" no longer exists`
          : `"${this.archivePath}" was changed on disk (saved in Construct 3?) after this server read it`);
      }
      heldFiles = await folderFiles(this.heldDir);
      bytes = await this.buildArchive(projectFiles, heldFiles);
      await this.checkReadsBack(bytes, projectFiles, heldFiles);
    } catch (error) {
      return { status: 'failed', reason: messageOf(error) };
    }
    return this.replaceArchive(bytes, current, projectFiles.length + heldFiles.length);
  }

  /** The steps of "Replacing the archive": stage, move aside, compare, place, read again. Never throws. */
  private async replaceArchive(bytes: Buffer, current: FolderStamp, fileCount: number): Promise<ArchiveSyncResult> {
    const n = ++this.writes;
    const staging = `${this.resolved}.${process.pid}.${n}.tmp`;
    const previousArchive = `${this.resolved}.${process.pid}.${n}.previous`;
    const removeStaging = () => this.fs.unlink(staging).catch(() => undefined);
    const hash = sha256(bytes);

    // 1. The whole new archive staged beside the archive and read back, before the archive is touched
    try {
      await this.fs.writeFile(staging, bytes);
      if (sha256(await this.fs.readFile(staging)) !== hash) throw new Error('the staged copy did not read back as written');
      await this.mark({ staging, previousArchive });
    } catch (error) {
      await removeStaging();
      return { status: 'failed', reason: `the new archive could not be staged beside "${this.archivePath}" (${messageOf(error)}); the archive was not changed` };
    }

    // 2. The archive moved aside in one rename: whatever is at its path now, a save that just landed included, is kept
    try {
      await this.fs.rename(this.resolved, previousArchive);
    } catch (error) {
      await removeStaging();
      await this.mark().catch(() => undefined);
      if (isFileNotFoundError(error)) return this.stop(`"${this.archivePath}" no longer exists`);
      return { status: 'failed', reason: `"${this.archivePath}" could not be moved aside to be replaced (${messageOf(error)}); it was not changed` };
    }

    // 3. What was moved aside must be this session's own last version, compared by content
    let moved: string | undefined;
    try {
      moved = sha256(await this.fs.readFile(previousArchive));
    } catch {
      moved = undefined;
    }
    if (moved !== this.stamp.sha256) {
      await removeStaging();
      const back = await this.placeAt(previousArchive);
      if (back === 'placed') {
        await this.fs.unlink(previousArchive).catch(() => undefined);
        await this.mark().catch(() => undefined);
        return moved === undefined
          ? { status: 'failed', reason: `"${this.archivePath}" could not be read after it was moved aside; it was put back unchanged` }
          : this.stop(`"${this.archivePath}" was changed on disk (saved in Construct 3?) after this server read it`);
      }
      await this.mark({ previousArchive }).catch(() => undefined);
      if (back === 'exists') {
        // Another file arrived at the path meanwhile: both are kept
        return this.stop(`"${this.archivePath}" was saved on disk (saved in Construct 3?) twice while this server was writing it back; `
          + `the newer save is at its path, the earlier one in "${previousArchive}"`);
      }
      return this.stop(`"${this.archivePath}" was moved aside to be replaced and could not be put back (${messageOf(back.error)}); `
        + `the file that was at its path is in "${previousArchive}"`);
    }

    // 4. The new archive placed without replacing anything: a save that lands meanwhile makes this fail, and is kept
    const placed = await this.placeAt(staging);
    if (placed !== 'placed') {
      await removeStaging();
      if (placed === 'exists') {
        try {
          await this.keepPrevious(previousArchive, n);
          await this.mark().catch(() => undefined);
        } catch {
          await this.mark({ previousArchive }).catch(() => undefined);
        }
        return this.stop(`"${this.archivePath}" was saved on disk (saved in Construct 3?) while this server was writing it back`);
      }
      const back = await this.placeAt(previousArchive);
      if (back === 'placed') {
        await this.fs.unlink(previousArchive).catch(() => undefined);
        await this.mark().catch(() => undefined);
        return { status: 'failed', reason: `the new archive could not be put in place (${messageOf(placed.error)}); "${this.archivePath}" is as it was` };
      }
      await this.mark({ previousArchive }).catch(() => undefined);
      return this.stop(back === 'exists'
        ? `"${this.archivePath}" was saved on disk (saved in Construct 3?) while this server was writing it back; `
          + `its version before that is in "${previousArchive}"`
        : `the new archive could not be put in place (${messageOf(placed.error)}), and "${this.archivePath}" `
          + `could not be put back (${messageOf(back.error)}); the file that was at its path is in "${previousArchive}"`);
    }

    // Committed: this session's own bytes are at the archive's path
    const notes: string[] = [];
    this.stamp = { size: bytes.length, mtimeMs: (await this.fs.stat(this.resolved).catch(() => undefined))?.mtimeMs ?? -1, sha256: hash };
    this.folder = current;
    await removeStaging();
    try {
      const kept = await this.keepPrevious(previousArchive, n);
      if (kept && kept !== `${this.resolved}.bak`) {
        notes.push(`"${this.resolved}.bak" already existed and was not replaced; the archive's previous version is kept as "${kept}"`);
      }
    } catch (error) {
      notes.push(`the archive's previous version is left in "${previousArchive}" (${messageOf(error)})`);
    }
    await this.mark().catch(() => undefined);

    // 5. Read again: a save that lands right after the write-back is seen
    try {
      const written = await this.readStamped();
      if (written.stamp.sha256 !== hash) {
        return this.stop(`"${this.archivePath}" was changed on disk (saved in Construct 3?) right after this server wrote it back`, notes);
      }
      this.stamp = written.stamp;
    } catch (error) {
      if (isFileNotFoundError(error)) return this.stop(`"${this.archivePath}" no longer exists right after this server wrote it back`, notes);
      notes.push(`it could not be read back to confirm the write (${messageOf(error)})`);
    }
    return { status: 'saved', fileCount, ...(notes.length ? { notes } : {}) };
  }

  /**
   * The version moved aside, which is this session's own: the session's
   * first write-back keeps it as <archive>.bak (or, where that name is
   * taken, under a second name; no file is replaced), later ones remove it.
   * Returns the name it was kept under, if any.
   */
  private async keepPrevious(previousArchive: string, n: number): Promise<string | undefined> {
    if (this.savedThisSession) {
      await this.fs.unlink(previousArchive);
      return undefined;
    }
    for (const target of [`${this.resolved}.bak`, `${this.resolved}.${process.pid}.${n}.bak`]) {
      const placed = await this.placeAt(previousArchive, target);
      if (placed === 'placed') {
        this.savedThisSession = true;
        await this.fs.unlink(previousArchive);
        return target;
      }
      if (placed !== 'exists') throw placed.error;
    }
    throw new Error('both names for a backup of the archive are taken');
  }

  /**
   * When the server stops: write back what is left, then remove the
   * session folder and its marker, unless the folder holds changes the
   * archive lacks (a conflict or a failed write) or the archive stopped,
   * in which case they are kept and the folder returned. A folder that
   * could not be removed after a write-back that went through is kept too,
   * and named in the notes of the (still saved) result; `kept` then is only
   * a folder to delete, so the caller tells it from kept changes by
   * `sync.status` (describeArchiveClose does). Never throws.
   */
  async close(): Promise<{ kept?: string; sync: ArchiveSyncResult }> {
    if (this.stoppedReason) return { kept: `${this.sessionDir}.previous`, sync: { status: 'failed', reason: this.stoppedReason, stopped: true } };
    const sync = await this.sync();
    if (sync.status === 'conflict' || sync.status === 'failed') return { kept: this.workDir, sync };
    if (sync.status === 'unchanged' && (await this.externalChange(false)).kind === 'missing') {
      // The folder may be the last copy of the project
      return { kept: this.workDir, sync: this.stop(`"${this.archivePath}" no longer exists`) };
    }
    try {
      await this.fs.rm(this.sessionDir);
      await nodeFs.rm(markerOf(this.sessionDir), { force: true });
      return { sync };
    } catch (error) {
      const note = `the working folder "${this.sessionDir}" could not be removed (${messageOf(error)}); it can be deleted`;
      return { kept: this.workDir, sync: { ...sync, notes: [...(sync.notes ?? []), note] } };
    }
  }
}

/** Whether a process with this id runs. */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === 'EPERM';
  }
}

/** A session a killed process left: its folder, its archive, and the files of a step it did not finish. */
export interface LeftSession {
  sessionDir: string;
  archivePath: string;
  leftovers: string[];
}

/**
 * Session folders under `workRoot` (default: the system's temp folder)
 * whose process no longer runs: left by a session that was killed, they
 * may hold changes that were never written back, and a write-back or
 * refresh it did not finish (named in `leftovers`). They are named, never
 * removed here.
 */
export async function findLeftWorkFolders(workRoot: string = tmpdir()): Promise<LeftSession[]> {
  const left: LeftSession[] = [];
  let names: string[];
  try {
    names = await nodeFs.readdir(workRoot);
  } catch {
    return left;
  }
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX) || !name.endsWith(MARKER_SUFFIX)) continue;
    try {
      const marker = JSON.parse(await nodeFs.readFile(join(workRoot, name), 'utf-8')) as { pid?: unknown; archive?: unknown; pending?: PendingStep };
      if (typeof marker.pid !== 'number' || processRuns(marker.pid)) continue;
      const sessionName = name.slice(0, -MARKER_SUFFIX.length);
      const siblings = names.filter(n => n !== name && n.startsWith(`${sessionName}.`)).map(n => join(workRoot, n));
      const pending = Object.values(marker.pending ?? {}).filter((p): p is string => typeof p === 'string');
      left.push({ sessionDir: join(workRoot, sessionName), archivePath: String(marker.archive), leftovers: [...siblings, ...pending] });
    } catch {
      // A marker that cannot be read names nothing
    }
  }
  return left;
}

/**
 * The error for an archive path with no file: the original error, unless a
 * write-back that was stopped part way left the archive's versions beside it
 * (a `<archive>.<pid>.<n>.previous` file, or a file a session marker under
 * `workRoot` records for it), in which case the message names them and says
 * to rename one back.
 */
async function missingArchiveError(archivePath: string, resolved: string, workRoot: string, original: unknown): Promise<unknown> {
  const prefix = `${nameKey(basename(resolved))}.`;
  const found = new Set<string>();
  try {
    for (const name of await nodeFs.readdir(dirname(resolved))) {
      if (nameKey(name).startsWith(prefix) && /\.previous$/i.test(name)) found.add(join(dirname(resolved), name));
    }
  } catch {
    // A folder that cannot be listed names nothing
  }
  for (const session of await findLeftWorkFolders(workRoot)) {
    if (nameKey(resolve(session.archivePath)) !== nameKey(resolved)) continue;
    for (const leftover of session.leftovers) {
      if (leftover.startsWith(`${resolved}.`) && await nodeFs.stat(leftover).then(() => true, () => false)) found.add(leftover);
    }
  }
  if (found.size === 0) return original;
  return new Error(
    `"${archivePath}" does not exist, but a write-back to it that stopped part way left ${found.size === 1 ? 'this file' : 'these files'} beside it: `
    + `${[...found].map(file => `"${file}"`).join(', ')}. `
    + 'A .previous file is the archive as it was before that write-back; a .tmp file is the new archive that was being put in place. '
    + `Rename the one you want to "${archivePath}", then start the server again.`,
  );
}

const withNotes = (text: string, notes?: string[]): string => (notes?.length ? `${text} Also: ${notes.join('; ')}.` : text);

/** The note added to a tool result about a write-back, or undefined when there is nothing to say. */
export function describeArchiveSync(archive: Pick<C3pArchive, 'archivePath' | 'workDir'>, result: ArchiveSyncResult): string | undefined {
  switch (result.status) {
    case 'unchanged':
      return undefined;
    case 'saved':
      return withNotes(`Saved the project to "${archive.archivePath}" (${result.fileCount} files).`, result.notes);
    case 'conflict':
      return withNotes(`The project was NOT saved to "${archive.archivePath}": ${result.reason}. This session's changes are kept in the working `
        + `folder "${archive.workDir}". Take what you need from it, then restart the server to load the archive as it is now.`, result.notes);
    case 'failed':
      return withNotes(`The project was NOT saved to "${archive.archivePath}": ${result.reason}. `
        + (result.stopped
          ? 'Restart the server after taking what you need from the folders named.'
          : 'The next tool call writes it back again.'), result.notes);
  }
}

/** The note or refusal text about a refresh, or undefined when there is nothing to say. */
export function describeArchiveRefresh(archive: Pick<C3pArchive, 'archivePath' | 'workDir'>, result: ArchiveRefreshResult): string | undefined {
  switch (result.status) {
    case 'unchanged':
      return undefined;
    case 'refreshed':
      return withNotes(`"${archive.archivePath}" changed on disk, so the project was read again from it before this call.`, result.notes);
    case 'failed':
      return result.stopped
        ? `Nothing was run: ${result.reason}. Restart the server after taking what you need from the folders named.`
        : `"${archive.archivePath}" changed on disk and could not be read again (${result.reason}). Nothing was run. Try the call again.`;
    case 'conflict':
      return describeArchiveSync(archive, { status: 'conflict', reason: result.reason });
  }
}
