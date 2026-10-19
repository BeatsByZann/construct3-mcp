/**
 * Third-party addon definitions for ACE validation.
 *
 * The built-in catalogue knows Construct's own plugins and behaviors. A
 * third-party addon ships the same kind of definition in its own `aces.json`
 * beside `addon.json`, unpacked in a folder. This module reads those files
 * into a registry that the ACE checks consult when an ACE's owner is not in
 * the catalogue.
 *
 * Only paths inside the allowed roots are read: the project folder (for a
 * `.c3p` project, the folder that holds the archive) and each path named in
 * the `C3_ADDON_DEFINITIONS` variable. A path is judged by its real path, so
 * a link that leads out of a root is refused. The registry belongs to one
 * project reader and keeps its roots, so a later call needs no environment
 * lookup. Reports name sources by base name only, never by absolute path, and
 * never carry text from a file.
 */

import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readZipArchive, type ZipReadEntry } from '../runtime/zip-reader.js';
import { flatten } from './ace-catalog-source.js';
import type { AddonDefinition, AddonLookup } from './ace-types.js';

/** The largest addon.json or aces.json that is read. */
export const MAX_DEFINITION_BYTES = 10 * 1024 * 1024;

/** The largest .c3addon archive that is read. */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

/** The definition files an archive may hold: the root or one folder deep. */
const ARCHIVE_DEFINITION_FILE = /^(?:[^/]+\/)?(?:addon|aces)\.json$/;

/** The most entries a .c3addon archive may list, far above any real addon. */
export const MAX_ARCHIVE_ENTRIES = 10000;

/** The most folders deep an entry of a .c3addon archive may be, far above any real addon. */
export const MAX_ARCHIVE_PATH_DEPTH = 16;

/** Fixed reasons for what the zip reader can refuse, tried in order against its message; entry names are archive text and never reach a report. */
const ARCHIVE_FAILURES: Array<[test: (message: string) => boolean, reason: string]> = [
  [m => m.endsWith('is larger than 10MB'), 'the archive holds a definition file larger than 10MB'],
  [m => m.includes('addon definition files') && m.includes('together hold more than'), 'the definition files in the archive together hold more than 20MB'],
  [m => m.startsWith('The archive holds more than 4 addon definition files'), 'the archive holds more than 4 definition files'],
  [m => m.startsWith('The archive lists more than'), 'the archive lists too many entries'],
  [m => m.startsWith('The archive holds a path more than'), 'the archive holds a path nested too deeply'],
  [m => /, but the archive says \d+$/.test(m), 'a definition file is not the size the archive says'],
  [m => m.endsWith('has a damaged local header') || m.endsWith('runs past the end of the archive') || /damaged$|lies outside the archive$/.test(m), 'the archive is damaged'],
  [m => m.endsWith('is both a file and a folder') || m.endsWith('appears more than once') || m.includes('two ways ('), 'the archive has entries with conflicting names'],
  [m => m.endsWith('is encrypted') || m.includes('uses compression method') || m.includes('Multi-disk'), 'the archive uses a zip feature that is not supported'],
  [m => m.includes('path segment') || m.endsWith('is an absolute path') || m.endsWith('has an empty name') || m.endsWith('contains a NUL character') ||
    m.endsWith('which Windows drops') || m.endsWith('in its name') || m.endsWith('reserves for a device') || m.includes('UTF-8'), 'the archive has an entry name that is not accepted'],
  [m => m.endsWith('fails its CRC check'), 'a definition file fails its checksum'],
];

/** The report's reason for a failed read of an archive: fixed text chosen by kind, never the reader's message. */
function archiveFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (typeof code === 'string' && code.startsWith('Z_')) return 'a definition file holds damaged data';
    for (const [matches, reason] of ARCHIVE_FAILURES) if (matches(error.message)) return reason;
  }
  return 'the archive could not be read as a zip archive';
}

/** Read an archive file whole, refusing one over 25MB without reading it, and one that grows past its size while it is read. */
async function readArchiveFile(real: string): Promise<Buffer> {
  const handle = await open(real, 'r');
  try {
    const { size } = await handle.stat();
    if (size > MAX_ARCHIVE_BYTES) throw new DefinitionProblem(`the archive is larger than 25MB. ${NOTHING_LOADED}`);
    const buffer = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > size) throw new DefinitionProblem(`the archive changed while it was read. ${NOTHING_LOADED}`);
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** True for the name of a .c3addon archive. */
function isArchiveName(name: string): boolean {
  return /\.c3addon$/i.test(name);
}

/** The folder part of an archive path: '' at the root. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** What a load did: the definitions now held, and what was refused or skipped, each by base name. */
export interface LoadReport {
  loaded: Array<Omit<AddonDefinition, 'aces'>>;
  skipped: Array<{ name: string; reason: string }>;
}

const OUTSIDE = 'outside the project folder and the roots named in C3_ADDON_DEFINITIONS';
const NOTHING_LOADED = 'Nothing was loaded.';

/** A problem with fixed text that is safe to report: it carries no path and no text from a file. */
class DefinitionProblem extends Error {}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The last segment of a path written with either separator, whatever the platform. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** True for a network path: two separators of either kind lead it (`\\server\share`, `//server/share`, `/\server`), which Windows reads as a network root. */
function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** The case a path comparison uses: the file systems of Windows and macOS ignore case. */
function fold(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

/** True when `target` is `root` or lies below it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** Parse a definition file; some addons save their JSON with a byte-order mark, which JSON.parse refuses. */
function parseJson(text: string, what: string): unknown {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(clean);
  } catch {
    throw new DefinitionProblem(`${what} is not valid JSON`);
  }
}

/** Build a definition from the contents of an addon's two files. */
export function parseAddonDefinition(addonJson: string, acesJson: string, sourceName: string): AddonDefinition {
  const addon = parseJson(addonJson, 'addon.json');
  if (!isRecord(addon)) throw new DefinitionProblem('addon.json is not an object');
  const type = addon.type;
  if (type !== 'plugin' && type !== 'behavior') {
    throw new DefinitionProblem('addon.json declares a type other than plugin or behavior; only plugins and behaviors define conditions and actions');
  }
  if (typeof addon.id !== 'string' || addon.id.length === 0) throw new DefinitionProblem('addon.json has no id');
  const aces = parseJson(acesJson, 'aces.json');
  if (!isRecord(aces)) throw new DefinitionProblem('aces.json is not an object');
  const set = flatten(aces);
  return {
    id: addon.id,
    type,
    name: typeof addon.name === 'string' ? addon.name : addon.id,
    version: typeof addon.version === 'string' ? addon.version : undefined,
    source: sourceName,
    aces: set,
    counts: {
      conditions: Object.keys(set.conditions).length,
      actions: Object.keys(set.actions).length,
      expressions: Object.keys(set.expressions).length,
    },
  };
}

/** The addon definitions one project reader's checks consult, and the roots they may be read from. */
export class AddonDefinitions implements AddonLookup {
  private readonly definitions = new Map<string, AddonDefinition>();
  private realRoots: string[] = [];

  /** The definition of a plugin or behavior, or undefined. */
  get(type: 'plugin' | 'behavior', id: string): AddonDefinition | undefined {
    return this.definitions.get(`${type}:${id}`);
  }

  /** Every definition loaded so far. */
  list(): AddonDefinition[] {
    return [...this.definitions.values()];
  }

  /** Forget the loaded definitions; the roots stay. */
  clear(): void {
    this.definitions.clear();
  }

  /** The real paths of the allowed roots. */
  roots(): readonly string[] {
    return this.realRoots;
  }

  /** Replace the allowed roots by their real paths; a root that does not exist is dropped and named once on stderr. */
  async setRoots(roots: readonly string[]): Promise<void> {
    const real: string[] = [];
    for (const root of roots) {
      // A network root would be contacted by realpath, and load refuses network paths anyway
      if (isNetworkPath(root)) {
        console.error(`Addon definitions root not accepted: ${baseName(root)}`);
        continue;
      }
      try {
        const resolved = await realpath(resolve(root));
        if (!real.includes(resolved)) real.push(resolved);
      } catch {
        console.error(`Addon definitions root not found: ${baseName(root)}`);
      }
    }
    this.realRoots = real;
  }

  /** The real path of `path` when it lies inside an allowed root; undefined when it does not exist or lies outside. */
  async realContained(path: string): Promise<string | undefined> {
    const real = await this.realPathOf(path);
    return real !== undefined && this.isInsideRoots(real) ? real : undefined;
  }

  /** The real path of `path`, or undefined when it does not exist or cannot be resolved. */
  private async realPathOf(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  }

  /** True when the real path `real` lies inside one of the stored roots. */
  private isInsideRoots(real: string): boolean {
    return this.realRoots.some(root => isInside(root, real));
  }

  /**
   * Load the definitions at `path`: an addon folder, a .c3addon archive, or
   * a folder holding several folders and archives (one level deep). The path must lie inside an allowed root once
   * its links are resolved. Every failure is reported and does not stop the
   * other entries.
   */
  async load(path: string): Promise<LoadReport> {
    const report: LoadReport = { loaded: [], skipped: [] };
    const name = baseName(path);
    if (isNetworkPath(path) || isNetworkPath(resolve(path))) {
      report.skipped.push({ name, reason: `a network path is not accepted. ${NOTHING_LOADED}` });
      return report;
    }
    const real = await this.realPathOf(resolve(path));
    if (real === undefined) {
      report.skipped.push({ name, reason: 'not found' });
      return report;
    }
    if (!this.isInsideRoots(real)) {
      report.skipped.push({ name, reason: `${OUTSIDE}. ${NOTHING_LOADED}` });
      return report;
    }
    let isDirectory = false;
    try {
      isDirectory = (await stat(real)).isDirectory();
    } catch {
      report.skipped.push({ name, reason: 'not found' });
      return report;
    }
    if (!isDirectory) {
      if (isArchiveName(name) && await this.isFile(real)) await this.attemptArchive(name, real, report);
      else report.skipped.push({ name, reason: 'not an addon folder' });
      return report;
    }
    if (await this.isAddonFolder(real)) {
      await this.attempt(name, real, report);
      return report;
    }
    let found = 0;
    let entries: string[];
    try {
      entries = (await readdir(real)).sort();
    } catch {
      report.skipped.push({ name, reason: 'could not be read' });
      return report;
    }
    for (const entry of entries) {
      const childReal = await this.realPathOf(join(real, entry));
      if (childReal === undefined) {
        found++;
        report.skipped.push({ name: entry, reason: 'could not be read' });
        continue;
      }
      if (!this.isInsideRoots(childReal)) {
        found++;
        report.skipped.push({ name: entry, reason: OUTSIDE });
        continue;
      }
      if (isArchiveName(entry) && await this.isFile(childReal)) {
        found++;
        await this.attemptArchive(entry, childReal, report);
      } else if (await this.isAddonFolder(childReal)) {
        found++;
        await this.attempt(entry, childReal, report);
      }
    }
    if (found === 0) report.skipped.push({ name, reason: `no addon.json under ${name}` });
    return report;
  }

  /** True when the folder holds an addon.json (the file's real path is checked when it is read). */
  private async isAddonFolder(folder: string): Promise<boolean> {
    try {
      await stat(join(folder, 'addon.json'));
      return true;
    } catch {
      return false;
    }
  }

  /** True when `path` is a regular file. */
  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Load one .c3addon archive by its real path (already checked against the
   * roots); a failure is reported by `label` and nothing else is lost. The
   * archive is read only when it is at most 25MB; of its entries only the
   * addon.json and aces.json at its root or one folder deep are inflated.
   */
  private async attemptArchive(label: string, real: string, report: LoadReport): Promise<void> {
    try {
      const buffer = await readArchiveFile(real);
      let files: ZipReadEntry[];
      try {
        files = readZipArchive(buffer, {
          wanted: path => ARCHIVE_DEFINITION_FILE.test(path),
          maxEntryBytes: MAX_DEFINITION_BYTES,
          maxKept: 4,
          maxKeptBytes: 2 * MAX_DEFINITION_BYTES,
          maxEntries: MAX_ARCHIVE_ENTRIES,
          maxPathDepth: MAX_ARCHIVE_PATH_DEPTH,
        }).files;
      } catch (error) {
        throw new DefinitionProblem(archiveFailureReason(error));
      }
      const addons = files.filter(file => file.path.endsWith('addon.json'));
      const aces = files.filter(file => file.path.endsWith('aces.json'));
      if (addons.length === 0) throw new DefinitionProblem('the archive holds no addon.json at its root or one folder deep');
      if (aces.length === 0) throw new DefinitionProblem('the archive holds no aces.json at its root or one folder deep');
      if (addons.length > 1) throw new DefinitionProblem('the archive holds more than one addon.json');
      if (aces.length > 1) throw new DefinitionProblem('the archive holds more than one aces.json');
      if (folderOf(addons[0].path) !== folderOf(aces[0].path)) {
        throw new DefinitionProblem('addon.json and aces.json are not in the same folder');
      }
      const definition = parseAddonDefinition(addons[0].data.toString('utf8'), aces[0].data.toString('utf8'), label);
      this.definitions.set(`${definition.type}:${definition.id}`, definition);
      const { aces: _aces, ...summary } = definition;
      report.loaded.push(summary);
    } catch (error) {
      report.skipped.push({ name: label, reason: error instanceof DefinitionProblem ? error.message : 'could not be read' });
    }
  }

  /** Load one addon folder; a failure is reported by `label` and nothing else is lost. */
  private async attempt(label: string, folder: string, report: LoadReport): Promise<void> {
    try {
      const addonJson = await this.readDefinition(folder, 'addon.json');
      const acesJson = await this.readDefinition(folder, 'aces.json');
      const definition = parseAddonDefinition(addonJson, acesJson, label);
      this.definitions.set(`${definition.type}:${definition.id}`, definition);
      const { aces: _aces, ...summary } = definition;
      report.loaded.push(summary);
    } catch (error) {
      report.skipped.push({ name: label, reason: error instanceof DefinitionProblem ? error.message : 'could not be read' });
    }
  }

  /** Read one definition file by its real path, after checking that the path lies inside a root and the file is small enough. */
  private async readDefinition(folder: string, file: 'addon.json' | 'aces.json'): Promise<string> {
    const real = await this.realPathOf(join(folder, file));
    if (real === undefined) throw new DefinitionProblem(`${file} is missing`);
    if (!this.isInsideRoots(real)) throw new DefinitionProblem(`${file} is ${OUTSIDE}`);
    const info = await stat(real);
    if (!info.isFile()) throw new DefinitionProblem(`${file} is not a file`);
    if (info.size > MAX_DEFINITION_BYTES) throw new DefinitionProblem(`${file} is larger than 10MB`);
    return readFile(real, 'utf8');
  }
}

const registries = new WeakMap<object, AddonDefinitions>();

/** The registry of one project reader; a new one has no roots and loads nothing until `setRoots` is called. */
export function addonDefinitionsOf(reader: object): AddonDefinitions {
  let defs = registries.get(reader);
  if (!defs) {
    defs = new AddonDefinitions();
    registries.set(reader, defs);
  }
  return defs;
}

/**
 * The folders addon definitions may be read from: the project folder (for a
 * `.c3p` session, the folder that holds the archive instead of the temporary
 * working folder), then each path named in the variable.
 */
export function addonRootsFor(projectDir: string, archivePath: string | undefined, envValue: string | undefined, delimiter: string): string[] {
  const named = (envValue ?? '').split(delimiter).map(p => p.trim()).filter(Boolean);
  return [archivePath !== undefined ? dirname(archivePath) : projectDir, ...named];
}

/** Load every path in `C3_ADDON_DEFINITIONS` (separated by the path delimiter); returns the combined report. */
export async function loadAddonDefinitionsFromEnv(defs: AddonDefinitions, envValue: string | undefined, delimiter: string): Promise<LoadReport> {
  const report: LoadReport = { loaded: [], skipped: [] };
  for (const path of (envValue ?? '').split(delimiter).map(p => p.trim()).filter(Boolean)) {
    const part = await defs.load(path);
    report.loaded.push(...part.loaded);
    report.skipped.push(...part.skipped);
  }
  return report;
}
