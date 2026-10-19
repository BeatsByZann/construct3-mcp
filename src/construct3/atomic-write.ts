/**
 * Atomic file replacement that keeps an existing file's name on disk.
 *
 * Files are replaced by writing a temp file beside them and renaming it onto <file>. On a
 * case-insensitive file system (Windows, default macOS) the path can name an
 * existing file whose name differs in case — "layout1.json" finds
 * "Layout1.json" when project.c3proj spells the entity "layout1" — and the
 * rename would silently change the name on disk to the path's spelling. With
 * git's core.ignorecase=true nothing shows the change until a checkout on a
 * case-sensitive file system. So writes first resolve the path to the name on
 * disk (existingSpelling).
 */

import { randomBytes } from 'crypto';
import { link, lstat, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { nameKey } from './names.js';

/** The file system calls used to resolve names on disk (injectable for tests). */
export interface DirectoryLookup {
  stat(path: string): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
}

const nodeLookup: DirectoryLookup = {
  stat: (path) => stat(path),
  readdir: (path) => readdir(path),
};

/**
 * The entries of `filePath`'s directory whose name equals its file name
 * ignoring case, the exact name first. Empty when the directory cannot be read.
 */
async function caseVariants(filePath: string, fs: DirectoryLookup): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirname(filePath));
  } catch {
    return [];
  }
  const base = basename(filePath);
  const key = nameKey(base);
  const matches = entries.filter(e => nameKey(e) === key);
  return matches.sort((a, b) => Number(b === base) - Number(a === base));
}

/**
 * `filePath` spelled the way the file it refers to is named on disk. Only the
 * file name is resolved. The path comes back unchanged when it does not exist,
 * when the directory lists it with exactly this spelling, or when the name is
 * ambiguous (several entries match ignoring case). The file must exist at
 * `filePath` (stat succeeds), so on a case-sensitive file system a write never
 * lands on another file whose name differs only in case.
 */
export async function existingSpelling(filePath: string, fs: DirectoryLookup = nodeLookup): Promise<string> {
  try {
    await fs.stat(filePath);
  } catch {
    return filePath; // new file (or unreadable): the write itself reports errors
  }
  const variants = await caseVariants(filePath, fs);
  if (variants.length !== 1) return filePath;
  return variants[0] === basename(filePath) ? filePath : join(dirname(filePath), variants[0]);
}

/**
 * The file on disk whose name equals `filePath`'s file name ignoring case
 * (the exact name when present), or undefined. Unlike existingSpelling this
 * does not depend on the file system's case sensitivity: create tools use it
 * to refuse a name that would share its file on Windows and macOS.
 */
export async function findFileIgnoringCase(filePath: string, fs: DirectoryLookup = nodeLookup): Promise<string | undefined> {
  const variants = await caseVariants(filePath, fs);
  return variants.length > 0 ? join(dirname(filePath), variants[0]) : undefined;
}

/** How many fresh names a write tries for one of its own files when the name drawn already exists. */
const MAX_NAME_ATTEMPTS = 5;

/**
 * Replace (or create) a file atomically: write a temp file in the same
 * folder, then rename it onto the file, keeping an existing file's name on
 * disk (see existingSpelling). Returns the path written.
 *
 * The files this function makes for itself are named
 * .c3mcp-<16 random hex digits>.<tmp|link|old>, the same length whatever the
 * file is called, and each is claimed exclusively: a name that already exists
 * is never written over, and another one is drawn.
 *
 * When the rename fails with EEXIST and the path is a regular file, the
 * function first checks that the folder can make hard links, then renames the
 * file aside (.old) and links the temp file in. A link never replaces an
 * existing name, so nothing another write put at the file's name meanwhile is
 * replaced. When the link in fails, the file is linked back (the same file,
 * with its size, modification time and file id). When the folder cannot make
 * hard links, the file is not moved and the error says so. When the name was
 * taken meanwhile, or putting the file back fails, nothing is removed and the
 * error names the aside file (what was at the name before the write) and the
 * temp file (the new content). When the path is not a regular file, the EEXIST
 * error is thrown as it is.
 *
 * The new errors have the named failure as `cause` and keep its `code`.
 * Removing the function's own files afterwards is best effort: one that
 * cannot be removed stays next to the file.
 */
export async function atomicReplace(filePath: string, content: string | Buffer): Promise<string> {
  const target = await existingSpelling(filePath);
  const tmpPath = await withFreshName(dirname(target), 'tmp', path =>
    writeFile(path, content, { encoding: typeof content === 'string' ? 'utf-8' : undefined, flag: 'wx' }));
  try {
    await rename(tmpPath, target);
  } catch (e: unknown) {
    if (errorCode(e) !== 'EEXIST' || !(await isFile(target))) {
      await removeIfPossible(tmpPath);
      throw e;
    }
    await replaceThroughAside(target, tmpPath, e);
  }
  return target;
}

/**
 * Claim a fresh name .c3mcp-<16 random hex digits>.<ext> in `dir` by running
 * `claim` on it. `claim` must fail with EEXIST, having changed nothing, when
 * the name exists; another name is then drawn, up to MAX_NAME_ATTEMPTS
 * times. Returns the name claimed; any other error is thrown at once.
 */
async function withFreshName(dir: string, ext: 'tmp' | 'link' | 'old', claim: (path: string) => Promise<void>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const path = join(dir, `.c3mcp-${randomBytes(8).toString('hex')}.${ext}`);
    try {
      await claim(path);
      return path;
    } catch (e: unknown) {
      if (errorCode(e) !== 'EEXIST' || attempt >= MAX_NAME_ATTEMPTS) throw e;
    }
  }
}

/**
 * The EEXIST fallback of atomicReplace (see there): check hard links, move
 * `target` aside, link `tmpPath` in, or link `target` back. `first` is the
 * EEXIST of the first rename.
 */
async function replaceThroughAside(target: string, tmpPath: string, first: unknown): Promise<void> {
  const name = basename(target);
  const dir = dirname(target);
  try {
    const probe = await withFreshName(dir, 'link', path => link(tmpPath, path));
    await removeIfPossible(probe);
  } catch (e: unknown) {
    await removeIfPossible(tmpPath);
    throw replaceError(`Could not replace ${name}: ${messageOf(first)}, and the way around that error needs a hard link `
      + `in this folder, which failed (${messageOf(e)}). This write did not change it.`, first);
  }
  let asidePath: string;
  try {
    asidePath = await withFreshName(dir, 'old', async path => {
      if (await exists(path)) throw Object.assign(new Error(`EEXIST: file already exists, '${path}'`), { code: 'EEXIST' });
      await rename(target, path);
    });
  } catch (e: unknown) {
    await removeIfPossible(tmpPath);
    throw replaceError(`Could not replace ${name}: ${messageOf(e)}. This write did not change it.`, e);
  }
  const left = (lead: string | undefined, taken: unknown, cause: unknown): Error => replaceError(
    `Could not replace ${name}${lead === undefined ? '' : `: ${lead}`}. ${name} was created again while this write had it `
    + `moved aside (${messageOf(taken)}), and that file was left as it is. At that point what was at ${name} before this `
    + `write was in ${basename(asidePath)} and this write's content in ${basename(tmpPath)}, both in the same folder, `
    + 'and neither was removed.', cause);

  // Another program may have put something other than a file at the name after the check above
  const isRegular = await isFile(asidePath);
  let lead = `${messageOf(first)}, and ${name} is not a regular file`;
  let cause: unknown = first;
  if (isRegular) {
    try {
      await link(tmpPath, target);
      await removeIfPossible(tmpPath);
      await removeIfPossible(asidePath);
      return;
    } catch (e: unknown) {
      if (errorCode(e) === 'EEXIST') throw left(undefined, e, e);
      lead = messageOf(e);
      cause = e;
    }
  }
  try {
    if (isRegular) {
      await link(asidePath, target);
      await removeIfPossible(asidePath);
    } else {
      // A directory cannot be linked; a rename puts it back only onto a missing name or an empty directory
      await rename(asidePath, target);
    }
  } catch (e: unknown) {
    if (errorCode(e) === 'EEXIST') throw left(lead, e, cause);
    throw replaceError(`Could not replace ${name}: ${lead}. Putting it back failed too (${messageOf(e)}). At that point `
      + `what was at ${name} before this write was in ${basename(asidePath)} and this write's content in `
      + `${basename(tmpPath)}, both in the same folder, and neither was removed. If ${name} is missing, rename `
      + `${basename(asidePath)} to ${name} to put it back.`, cause);
  }
  await removeIfPossible(tmpPath);
  throw replaceError(`Could not replace ${name}: ${lead}. It was put back, so this write did not change it.`, cause);
}

/** Whether `path` is a regular file; false when it is something else or cannot be read. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether anything (a file, a folder, a link) has the name `path`; errors other than ENOENT are thrown. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e: unknown) {
    if (errorCode(e) === 'ENOENT') return false;
    throw e;
  }
}

/** The `code` of a file system error, or undefined. */
function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
}

/** An error's message, or the value as text, without a trailing full stop. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.+$/, '');
}

/** A new Error with `message`, `cause` as its cause and the cause's `code`, so callers that check the code see the same one. */
function replaceError(message: string, cause: unknown): Error {
  const error = new Error(message, { cause });
  const code = errorCode(cause);
  return code === undefined ? error : Object.assign(error, { code });
}

/** Remove a name this module created; a failure is ignored (best effort). */
async function removeIfPossible(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort
  }
}
