/**
 * Minimal ZIP reader using Node.js built-ins, for .c3p project archives.
 *
 * Reads the central directory, then each entry's data, and inflates DEFLATE
 * entries with node:zlib. Construct 3 r495.2 saved a .c3p as a ZIP64 archive
 * whose entries are STORE or DEFLATE (a count of three editor-saved archives
 * found both methods, and a UTF-8 flag on every entry), with backslashes in
 * its paths; a save read in the editor page on r506-2 showed a ZIP64 central
 * directory, DEFLATE entries and backslash names. Encrypted entries,
 * multi-disk archives, other compression methods, entry paths that are unsafe
 * or name their file ambiguously, names that carry the UTF-8 flag but are not
 * valid UTF-8, and two entries that would land on one file or folder are
 * refused rather than guessed at.
 */

import { inflateRawSync } from 'node:zlib';
import { nameKey } from '../construct3/names.js';
import { crc32 } from './zip-writer.js';

export interface ZipReadEntry {
  /** Path inside the zip (forward slashes, no leading slash) */
  path: string;
  /** Uncompressed file data */
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX32 = 0xffffffff;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Whether `bytes` are valid UTF-8. */
function isUtf8(bytes: Buffer): boolean {
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Code page 437's characters for the bytes 0x80 to 0xFF (0x00 to 0x7F are ASCII). */
const CP437_HIGH =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';

/** A name stored in code page 437, as Unicode. */
export function decodeCp437(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

/** The UTF-8 name of an Info-ZIP Unicode Path field (0x7075) written for these name bytes, or undefined. */
function unicodePathField(extra: Buffer, nameBytes: Buffer): string | undefined {
  for (let q = 0; q + 4 <= extra.length; q += 4 + extra.readUInt16LE(q + 2)) {
    const size = extra.readUInt16LE(q + 2);
    if (extra.readUInt16LE(q) !== 0x7075 || size < 5 || q + 4 + size > extra.length) continue;
    if (extra[q + 4] !== 1 || extra.readUInt32LE(q + 5) !== crc32(nameBytes)) continue;
    const name = extra.subarray(q + 9, q + 4 + size);
    if (isUtf8(name)) return name.toString('utf-8');
  }
  return undefined;
}

/** A ZIP64 eight-byte field, which must fit in a JavaScript number. */
function read64(buf: Buffer, at: number, what: string): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The zip ${what} is too large`);
  return Number(value);
}

/** Where the central directory is, from the end record or, in a ZIP64 archive, its ZIP64 end record. */
function centralDirectory(buf: Buffer, eocd: number): { count: number; offset: number; size: number; end: number } {
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    if (buf.readUInt32LE(eocd - 16) !== 0 || buf.readUInt32LE(eocd - 4) > 1) throw new Error('Multi-disk zip archives are not supported');
    const record = read64(buf, eocd - 12, 'ZIP64 end record offset');
    if (record + 56 > eocd - 20 || buf.readUInt32LE(record) !== ZIP64_EOCD_SIGNATURE) throw new Error('The ZIP64 end record is damaged');
    if (buf.readUInt32LE(record + 16) !== 0 || buf.readUInt32LE(record + 20) !== 0) throw new Error('Multi-disk zip archives are not supported');
    return {
      count: read64(buf, record + 32, 'entry count'),
      size: read64(buf, record + 40, 'central directory size'),
      offset: read64(buf, record + 48, 'central directory offset'),
      end: record,
    };
  }
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('Multi-disk zip archives are not supported');
  }
  return { count: buf.readUInt16LE(eocd + 10), size: buf.readUInt32LE(eocd + 12), offset: buf.readUInt32LE(eocd + 16), end: eocd };
}

/**
 * Replace each four-byte field that holds its placeholder 0xFFFFFFFF with the
 * eight-byte value from the entry's ZIP64 extra field, which lists only the
 * replaced fields, in this order.
 */
function applyZip64(extra: Buffer, fields: { size: number; compressedSize: number; localOffset: number }, path: string): void {
  const wanted = (['size', 'compressedSize', 'localOffset'] as const).filter(name => fields[name] === MAX32);
  if (wanted.length === 0) return;
  for (let q = 0; q + 4 <= extra.length; q += 4 + extra.readUInt16LE(q + 2)) {
    if (extra.readUInt16LE(q) !== ZIP64_EXTRA_ID) continue;
    const length = extra.readUInt16LE(q + 2);
    if (length < wanted.length * 8 || q + 4 + length > extra.length) break;
    wanted.forEach((name, i) => { fields[name] = read64(extra, q + 4 + i * 8, `entry "${path}"`); });
    return;
  }
  throw new Error(`Zip entry "${path}" is missing its ZIP64 sizes`);
}

/**
 * The entry's path with forward slashes, or an error when it could land
 * outside the extraction folder or name its file ambiguously. A backslash is
 * read as a folder separator (archives saved on Windows use it). Every
 * accepted path names its file exactly: no empty, `.` or `..` segment, no
 * segment ending in a dot or a space (Windows drops them), no colon and no
 * Windows device name.
 */
export function checkEntryPath(rawPath: string): string {
  const path = rawPath.replaceAll('\\', '/');
  if (path.length === 0) throw new Error('A zip entry has an empty name');
  if (path.includes('\0')) throw new Error(`Zip entry "${path}" contains a NUL character`);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`Zip entry "${path}" is an absolute path`);
  // Each segment names one file or folder exactly, on every platform: archives move between machines
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..') throw new Error(`Zip entry "${path}" has an empty, "." or ".." path segment`);
    if (/[. ]$/.test(part)) throw new Error(`Zip entry "${path}" has a name ending in a dot or a space, which Windows drops`);
    if (part.includes(':')) throw new Error(`Zip entry "${path}" has a colon in its name`);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part)) throw new Error(`Zip entry "${path}" uses a name Windows reserves for a device`);
  }
  return path;
}

/** A path's comparison key: each segment as names.ts compares names (NFC, lowercased). */
export function pathKey(path: string): string {
  return path.split('/').map(nameKey).join('/');
}

/** Find the end-of-central-directory record, which may be followed by a comment. */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new Error('Not a zip archive: no end-of-central-directory record');
}

/** What a read may keep and how much of it. Every field is optional; without one, nothing is filtered or limited. */
export interface ZipReadOptions {
  /** Whether the entry at this path is kept; an entry that is not kept is checked for structure but never inflated. */
  wanted?: (path: string) => boolean;
  /** The most bytes one kept entry may declare */
  maxEntryBytes?: number;
  /** The most entries that may be kept */
  maxKept?: number;
  /** The most bytes the kept entries may declare in all */
  maxKeptBytes?: number;
}

/** A size in whole megabytes for a message (limits are whole megabytes). */
function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Read a zip archive: its file entries, and the directory entries it lists
 * (each with a trailing "/"). Every structure check runs while the central
 * directory is read, for every entry, before any entry's data is returned.
 * With `options.wanted`, only the entries it accepts are inflated, sized and
 * checked against their CRC; the others still have their path, local header,
 * extent and file-or-folder rules checked. A kept entry's declared size is
 * checked against the limits in `options` before it is inflated, and its
 * inflation never produces more than the declared size.
 */
export function readZipArchive(buf: Buffer, options?: ZipReadOptions): { files: ZipReadEntry[]; directories: string[] } {
  const eocd = findEocd(buf);
  const { count, offset: cdOffset, size: cdSize, end } = centralDirectory(buf, eocd);
  if (cdOffset + cdSize > end) throw new Error('The zip central directory lies outside the archive');

  const entries: ZipReadEntry[] = [];
  const skipped: string[] = [];
  let keptBytes = 0;
  const directories: string[] = [];
  const seen = new Set<string>();
  const folders = new Map<string, string>();

  // One spelling per folder: a folder spelled two ways would be one folder on Windows and macOS
  const claimFolders = (path: string, includeSelf: boolean): void => {
    const parts = path.split('/');
    const last = includeSelf ? parts.length : parts.length - 1;
    for (let i = 1; i <= last; i++) {
      const folder = parts.slice(0, i).join('/');
      const spelled = folders.get(pathKey(folder));
      if (spelled !== undefined && spelled !== folder) throw new Error(`The archive spells the folder "${folder}" two ways ("${spelled}")`);
      folders.set(pathKey(folder), folder);
    }
  };

  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new Error(`Zip central directory entry ${n + 1} is damaged`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const fields = { compressedSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), localOffset: buf.readUInt32LE(p + 42) };
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLength);
    const extra = buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    // Bit 11 marks a UTF-8 name. Without it: Info-ZIP's Unicode Path field
    // (0x7075) when its CRC matches these name bytes, else the bytes as
    // UTF-8 when they are valid UTF-8 (writers that store UTF-8 without the
    // flag exist), else code page 437, ZIP's own default
    if (flags & 0x800 && !isUtf8(nameBytes)) {
      throw new Error(`Zip central directory entry ${n + 1} has the UTF-8 flag, but its name is not valid UTF-8`);
    }
    const rawPath = flags & 0x800 ? nameBytes.toString('utf-8')
      : unicodePathField(extra, nameBytes) ?? (isUtf8(nameBytes) ? nameBytes.toString('utf-8') : decodeCp437(nameBytes));
    p += 46 + nameLength + extraLength + commentLength;

    if (rawPath.endsWith('/') || rawPath.endsWith('\\')) {
      const directory = checkEntryPath(rawPath.slice(0, -1));
      claimFolders(directory, true);
      if (!directories.includes(`${directory}/`)) directories.push(`${directory}/`);
      continue;
    }
    const path = checkEntryPath(rawPath);
    if (flags & 0x1) throw new Error(`Zip entry "${path}" is encrypted`);
    applyZip64(extra, fields, path);
    const { compressedSize, size, localOffset } = fields;
    claimFolders(path, false);
    const key = pathKey(path);
    if (seen.has(key)) throw new Error(`Zip entry "${path}" appears more than once`);
    seen.add(key);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Zip entry "${path}" has a damaged local header`);
    }
    // Sizes come from the central directory: the local header may hold zeros
    // when bit 3 (data descriptor) is set, or 0xFFFFFFFF in a ZIP64 archive.
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buf.length) throw new Error(`Zip entry "${path}" runs past the end of the archive`);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (options?.wanted && !options.wanted(path)) {
      skipped.push(path);
      continue;
    }
    if (options?.maxEntryBytes !== undefined && size > options.maxEntryBytes) {
      throw new Error(`Zip entry "${path}" is larger than ${megabytes(options.maxEntryBytes)}MB`);
    }
    if (options?.maxKept !== undefined && entries.length + 1 > options.maxKept) {
      throw new Error(`The archive holds more than ${options.maxKept} addon definition files`);
    }
    if (options?.maxKeptBytes !== undefined && keptBytes + size > options.maxKeptBytes) {
      throw new Error(`The addon definition files in the archive together hold more than ${megabytes(options.maxKeptBytes)}MB`);
    }
    keptBytes += size;

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch (error) {
        // Output past the declared size: the entry is not what the archive says, and nothing more was inflated
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error(`Zip entry "${path}" is more than ${size} bytes, but the archive says ${size}`, { cause: error });
        }
        throw error;
      }
    } else throw new Error(`Zip entry "${path}" uses compression method ${method}; only STORE and DEFLATE are supported`);
    if (data.length !== size) throw new Error(`Zip entry "${path}" is ${data.length} bytes, but the archive says ${size}`);
    if (crc32(data) !== crc) throw new Error(`Zip entry "${path}" fails its CRC check`);
    entries.push({ path, data });
  }

  // A path that is a file and also a folder (of another entry, or a directory entry) cannot be unpacked
  for (const path of [...entries.map(entry => entry.path), ...skipped]) {
    if (folders.has(pathKey(path))) throw new Error(`The archive's "${path}" is both a file and a folder`);
  }
  return { files: entries, directories };
}

/** Read every file entry of a zip archive (directory entries are left out: readZipArchive lists them). */
export function readZip(buf: Buffer, options?: ZipReadOptions): ZipReadEntry[] {
  return readZipArchive(buf, options).files;
}
