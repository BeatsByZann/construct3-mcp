/**
 * Minimal ZIP reader using Node.js built-ins, for .c3p project archives.
 *
 * Reads the central directory, then each entry's data, and inflates DEFLATE
 * entries with node:zlib. Construct saves .c3p files as ZIP64 archives (every
 * size and offset in the ZIP64 records, even for a small project) with a mix
 * of STORE and DEFLATE entries. Encrypted entries, multi-disk archives, other
 * compression methods and unsafe entry paths are refused rather than guessed
 * at.
 */

import { inflateRawSync } from 'node:zlib';
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
 * outside the extraction folder. Construct on Windows writes every path inside
 * a .c3p with backslashes, so a backslash is read as a folder separator.
 */
export function checkEntryPath(rawPath: string): string {
  const path = rawPath.replaceAll('\\', '/');
  if (path.length === 0) throw new Error('A zip entry has an empty name');
  if (path.includes('\0')) throw new Error(`Zip entry "${path}" contains a NUL character`);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`Zip entry "${path}" is an absolute path`);
  if (path.split('/').some(part => part === '..')) throw new Error(`Zip entry "${path}" leaves the archive folder`);
  return path;
}

/** Find the end-of-central-directory record, which may be followed by a comment. */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new Error('Not a zip archive: no end-of-central-directory record');
}

/** Read every file entry of a zip archive. Directory entries are skipped. */
export function readZip(buf: Buffer): ZipReadEntry[] {
  const eocd = findEocd(buf);
  const { count, offset: cdOffset, size: cdSize, end } = centralDirectory(buf, eocd);
  if (cdOffset + cdSize > end) throw new Error('The zip central directory lies outside the archive');

  const entries: ZipReadEntry[] = [];
  const seen = new Set<string>();
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
    // Bit 11 marks a UTF-8 name; otherwise the name is code page 437, which
    // agrees with latin1 for the printable ASCII range project files use.
    const rawPath = nameBytes.toString(flags & 0x800 ? 'utf-8' : 'latin1');
    const extra = buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (rawPath.endsWith('/') || rawPath.endsWith('\\')) continue;
    const path = checkEntryPath(rawPath);
    if (flags & 0x1) throw new Error(`Zip entry "${path}" is encrypted`);
    applyZip64(extra, fields, path);
    const { compressedSize, size, localOffset } = fields;
    const key = path.toLowerCase();
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

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Zip entry "${path}" uses compression method ${method}; only STORE and DEFLATE are supported`);
    if (data.length !== size) throw new Error(`Zip entry "${path}" is ${data.length} bytes, but the archive says ${size}`);
    if (crc32(data) !== crc) throw new Error(`Zip entry "${path}" fails its CRC check`);
    entries.push({ path, data });
  }
  return entries;
}
