/**
 * Serve a single-file .c3p project.
 *
 * The tools work on a folder-format project, so the archive is unpacked into
 * a private working folder and the server loads that folder. After every tool
 * call that changed the folder, the archive is written back: the new archive
 * is built in memory, read back as a check, written beside the original and
 * renamed over it. The first write of a session keeps the archive as it was
 * opened in <name>.c3p.bak.
 *
 * The archive on disk is never overwritten with content it no longer matches:
 * if something else (usually Construct saving the project) changed the
 * archive since it was opened or last written, the write is refused and the
 * working folder is kept so no change is lost.
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { collectProjectFiles } from '../runtime/project-files.js';
import { readZip } from '../runtime/zip-reader.js';
import { assembleZip, packZipEntry } from '../runtime/zip-writer.js';
import type { PackedZipEntry } from '../runtime/zip-writer.js';

/** The project file Construct puts at the root of every .c3p. */
const PROJECT_FILE = 'project.c3proj';
const WORK_PREFIX = 'c3p-';

export type C3pSyncStatus = 'unchanged' | 'saved' | 'conflict' | 'failed';

export interface C3pSyncResult {
  status: C3pSyncStatus;
  /** Files written into the archive when status is 'saved' */
  fileCount?: number;
  /** Why the archive was not written, when status is 'conflict' or 'failed' */
  reason?: string;
}

interface ArchiveStamp {
  size: number;
  mtimeMs: number;
  sha256: string;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export function isC3pPath(path: string): boolean {
  return /\.c3p$/i.test(path);
}

export class C3pProject {
  private conflict: string | undefined;
  /** The last write failed, so the working folder holds changes the archive does not. */
  private unsaved = false;
  private savedThisSession = false;
  /** Each file as last packed, with the stamp it had then. */
  private readonly packed = new Map<string, { stamp: string; entry: PackedZipEntry }>();

  private constructor(
    /** The .c3p file the project was opened from and is written back to */
    readonly archivePath: string,
    /** The working folder the server loads */
    readonly workDir: string,
    private archiveStamp: ArchiveStamp,
    private folderStamp: FolderStamp,
  ) {}

  /** The folder project's .c3proj inside the working folder. */
  get projectFile(): string {
    return join(this.workDir, PROJECT_FILE);
  }

  /** Unpack an archive into a new working folder under `workRoot` (default: the system temp folder). */
  static async open(archivePath: string, workRoot: string = tmpdir()): Promise<C3pProject> {
    const archive = resolve(archivePath);
    const data = await readFile(archive);
    let entries;
    try {
      entries = readZip(data);
    } catch (error) {
      throw new Error(`Cannot read "${archive}" as a .c3p archive: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!entries.some(entry => entry.path === PROJECT_FILE)) {
      throw new Error(`"${archive}" has no ${PROJECT_FILE} at its root, so it is not a Construct project archive`);
    }

    const workDir = await mkdtemp(join(workRoot, WORK_PREFIX));
    try {
      for (const entry of entries) {
        const target = join(workDir, ...entry.path.split('/'));
        if (!target.startsWith(workDir + sep)) throw new Error(`Zip entry "${entry.path}" leaves the archive folder`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.data);
      }
      const info = await stat(archive);
      const stamp = { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(data) };
      return new C3pProject(archive, workDir, stamp, await folderStamp(workDir));
    } catch (error) {
      await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Write the working folder back to the archive if a file in it changed. */
  async sync(): Promise<C3pSyncResult> {
    if (this.conflict) return { status: 'conflict', reason: this.conflict };
    const current = await folderStamp(this.workDir);
    if (sameStamp(current, this.folderStamp)) return { status: 'unchanged' };

    const external = await this.externalChange();
    if (external) {
      this.conflict = external;
      return { status: 'conflict', reason: external };
    }

    const temp = `${this.archivePath}.${process.pid}.tmp`;
    try {
      // A file whose size and time stamp are unchanged since the last write is
      // not read or compressed again.
      const entries = await Promise.all([...current].map(async ([path, fileStamp]) => {
        const cached = this.packed.get(path);
        if (cached?.stamp === fileStamp) return cached.entry;
        const entry = packZipEntry({ path, data: await readFile(join(this.workDir, path)) }, { compress: true });
        this.packed.set(path, { stamp: fileStamp, entry });
        return entry;
      }));
      for (const path of this.packed.keys()) if (!current.has(path)) this.packed.delete(path);
      const archive = assembleZip(entries);
      // Read the new archive back before it replaces the old one.
      if (readZip(archive).length !== entries.length) throw new Error('The new archive did not read back with every file');
      if (!this.savedThisSession) await copyFile(this.archivePath, `${this.archivePath}.bak`);
      await writeFile(temp, archive);
      await rename(temp, this.archivePath);
      const info = await stat(this.archivePath);
      this.archiveStamp = { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(archive) };
      this.folderStamp = current;
      this.savedThisSession = true;
      this.unsaved = false;
      return { status: 'saved', fileCount: entries.length };
    } catch (error) {
      this.unsaved = true;
      await rm(temp, { force: true });
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Why the archive on disk no longer matches what this session last read or wrote, if it does not. */
  private async externalChange(): Promise<string | undefined> {
    let info;
    try {
      info = await stat(this.archivePath);
    } catch {
      return `"${this.archivePath}" no longer exists`;
    }
    if (info.size === this.archiveStamp.size && info.mtimeMs === this.archiveStamp.mtimeMs) return undefined;
    // A new time stamp alone is not a change; compare the content.
    if (sha256(await readFile(this.archivePath)) === this.archiveStamp.sha256) return undefined;
    return `"${this.archivePath}" was changed by something else, probably Construct saving it, after this server opened it`;
  }

  /**
   * Remove the working folder, unless it holds changes the archive does not.
   * Returns the folder when it is kept.
   */
  closeSync(): string | undefined {
    if (this.conflict || this.unsaved) return this.workDir;
    if (!basename(this.workDir).startsWith(WORK_PREFIX)) return this.workDir;
    rmSync(this.workDir, { recursive: true, force: true });
    return undefined;
  }
}

/** Each packed file's size and modification time in nanoseconds, by path, in path order. */
type FolderStamp = Map<string, string>;

async function folderStamp(dir: string): Promise<FolderStamp> {
  const files = (await collectProjectFiles(dir)).sort();
  const stamps = await Promise.all(files.map(async path => {
    const info = await stat(join(dir, path), { bigint: true });
    return [path, `${info.size}:${info.mtimeNs}`] as const;
  }));
  return new Map(stamps);
}

function sameStamp(a: FolderStamp, b: FolderStamp): boolean {
  if (a.size !== b.size) return false;
  for (const [path, stamp] of a) if (b.get(path) !== stamp) return false;
  return true;
}

/** The note added to a tool result when the call changed the archive or could not. */
export function describeSync(project: C3pProject, sync: C3pSyncResult): string | undefined {
  switch (sync.status) {
    case 'unchanged':
      return undefined;
    case 'saved':
      return `Saved the project to "${project.archivePath}" (${sync.fileCount} files).`;
    case 'conflict':
      return `The project was NOT saved to "${project.archivePath}": ${sync.reason}. `
        + `This session's changes are kept in the working folder "${project.workDir}". `
        + 'Restart the server to load the archive as it is now.';
    case 'failed':
      return `The project was NOT saved to "${project.archivePath}": ${sync.reason}. `
        + 'The next tool call that changes the project tries again.';
  }
}

type ToolRegistrar = (...args: unknown[]) => unknown;
interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 5));

/**
 * Wraps every tool registered on a server after `install`, so that:
 *
 * - the archive being served, if any, is written back after a call. When
 *   calls overlap, the last one to finish writes, and new calls wait until
 *   that write is done, so an archive never captures a tool halfway through
 *   its changes;
 * - a call can run a step with `exclusive`, which waits until no other call
 *   is running and holds new calls until the step is done. `open_project`
 *   switches projects this way.
 *
 * The archive is looked up at each call, because `open_project` changes it.
 */
export class ToolGate {
  private running = 0;
  private exclusiveCalls = 0;
  private writing: Promise<C3pSyncResult> | undefined;
  private held: Promise<unknown> | undefined;
  private exclusiveChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly archive: () => C3pProject | undefined) {}

  install(server: McpServer): void {
    const register = (server.tool as ToolRegistrar).bind(server);
    (server as unknown as { tool: ToolRegistrar }).tool = (...args: unknown[]) => {
      const last = args.length - 1;
      const handler = args[last];
      if (typeof handler === 'function') args[last] = (...callArgs: unknown[]) => this.run(() => handler(...callArgs));
      return register(...args);
    };
  }

  private async run(handler: () => unknown): Promise<unknown> {
    for (let wait = this.writing ?? this.held; wait; wait = this.writing ?? this.held) await wait.catch(() => undefined);
    this.running++;
    let result: unknown;
    let failure: { error: unknown } | undefined;
    try {
      result = await handler();
    } catch (error) {
      failure = { error };
    }
    this.running--;
    const project = this.archive();
    let sync: C3pSyncResult | undefined;
    // The calls still running are the exclusive ones waiting for this one.
    if (project && this.running === this.exclusiveCalls) {
      this.writing = project.sync();
      try {
        sync = await this.writing;
      } finally {
        this.writing = undefined;
      }
    }
    if (failure) throw failure.error;
    const note = project && sync && describeSync(project, sync);
    const content = (result as ToolResultLike | undefined)?.content;
    if (note && Array.isArray(content)) content.push({ type: 'text', text: note });
    return result;
  }

  /** From inside a tool call: run `step` once no other call is running or writing, holding new calls meanwhile. */
  async exclusive<T>(step: () => Promise<T>): Promise<T> {
    this.exclusiveCalls++;
    const run = this.exclusiveChain.then(async () => {
      while (this.running > this.exclusiveCalls || this.writing) await pause();
      return step();
    });
    const settled = run.then(() => undefined, () => undefined);
    this.exclusiveChain = settled;
    this.held = settled;
    try {
      return await run;
    } finally {
      this.exclusiveCalls--;
      if (this.held === settled) this.held = undefined;
    }
  }
}

/**
 * Make every tool registered on `server` from now on write `project` back
 * after it runs; see ToolGate.
 */
export function syncAfterEveryTool(server: McpServer, project: C3pProject): ToolGate {
  const gate = new ToolGate(() => project);
  gate.install(server);
  return gate;
}
