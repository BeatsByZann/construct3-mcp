/**
 * Minimal ZIP file writer using Node.js built-ins.
 *
 * Produces ZIP files compatible with the .c3p format (standard ZIP).
 * Uses STORE by default. With `compress`, each entry is DEFLATE-compressed
 * when that makes it smaller, as Construct itself does when it saves a .c3p.
 *
 * No external dependencies — only uses node:fs and node:buffer.
 */

import { writeFile } from 'node:fs/promises';
import * as zlib from 'node:zlib';
import { deflateRawSync } from 'node:zlib';

interface ZipEntry {
  /** Path inside the zip (forward slashes) */
  path: string;
  /** File data */
  data: Buffer;
}

export interface ZipWriteOptions {
  /** DEFLATE each entry that gets smaller by it; the rest are stored */
  compress?: boolean;
}

/**
 * Build a ZIP file from a list of entries and write it to disk.
 * Uses STORE method (no compression) unless `compress` is set.
 */
export async function writeZip(entries: ZipEntry[], outputPath: string, options: ZipWriteOptions = {}): Promise<void> {
  await writeFile(outputPath, buildZip(entries, options));
}

/** An entry with its checksum taken and its data compressed or stored, ready to assemble. */
export interface PackedZipEntry {
  path: string;
  crc: number;
  size: number;
  method: number;
  stored: Buffer;
}

/** Checksum and, with `compress`, DEFLATE one entry. */
export function packZipEntry(entry: ZipEntry, options: ZipWriteOptions = {}): PackedZipEntry {
  const size = entry.data.length;
  let method = 0;
  let stored = entry.data;
  if (options.compress && size > 0) {
    const deflated = deflateRawSync(entry.data);
    if (deflated.length < size) {
      method = 8;
      stored = deflated;
    }
  }
  return { path: entry.path, crc: crc32(entry.data), size, method, stored };
}

function checkEntryCount(count: number): void {
  if (count > 0xffff) {
    throw new Error(`A zip without ZIP64 holds at most 65535 entries; this one would hold ${count}`);
  }
}

/** Build a ZIP archive in memory. */
export function buildZip(entries: ZipEntry[], options: ZipWriteOptions = {}): Buffer {
  checkEntryCount(entries.length);
  return assembleZip(entries.map(entry => packZipEntry(entry, options)));
}

/** Build a ZIP archive in memory from entries already packed. */
export function assembleZip(entries: PackedZipEntry[]): Buffer {
  checkEntryCount(entries.length);
  const parts: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuf = Buffer.from(entry.path, 'utf-8');
    const { crc, size, method, stored } = entry;
    // Bit 11: the name is UTF-8. Set only when it matters, so ASCII-only
    // archives stay byte-identical to what earlier versions wrote.
    const flags = /[^\x00-\x7f]/.test(entry.path) ? 0x800 : 0;

    // Local file header (30 bytes + path + data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);  // Local file header signature
    localHeader.writeUInt16LE(20, 4);           // Version needed to extract (2.0)
    localHeader.writeUInt16LE(flags, 6);        // General purpose bit flag
    localHeader.writeUInt16LE(method, 8);       // Compression method: STORE or DEFLATE
    localHeader.writeUInt16LE(0, 10);           // Last mod file time
    localHeader.writeUInt16LE(0, 12);           // Last mod file date
    localHeader.writeUInt32LE(crc, 14);         // CRC-32
    localHeader.writeUInt32LE(stored.length, 18); // Compressed size
    localHeader.writeUInt32LE(size, 22);        // Uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28);           // Extra field length

    // Central directory file header (46 bytes + path)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);     // Central directory signature
    cdHeader.writeUInt16LE(20, 4);              // Version made by (2.0)
    cdHeader.writeUInt16LE(20, 6);              // Version needed to extract
    cdHeader.writeUInt16LE(flags, 8);           // General purpose bit flag
    cdHeader.writeUInt16LE(method, 10);         // Compression method: STORE or DEFLATE
    cdHeader.writeUInt16LE(0, 12);              // Last mod file time
    cdHeader.writeUInt16LE(0, 14);              // Last mod file date
    cdHeader.writeUInt32LE(crc, 16);            // CRC-32
    cdHeader.writeUInt32LE(stored.length, 20);  // Compressed size
    cdHeader.writeUInt32LE(size, 24);           // Uncompressed size
    cdHeader.writeUInt16LE(pathBuf.length, 28); // File name length
    cdHeader.writeUInt16LE(0, 30);              // Extra field length
    cdHeader.writeUInt16LE(0, 32);              // File comment length
    cdHeader.writeUInt16LE(0, 34);              // Disk number start
    cdHeader.writeUInt16LE(0, 36);              // Internal file attributes
    cdHeader.writeUInt32LE(0, 38);              // External file attributes
    cdHeader.writeUInt32LE(offset, 42);         // Relative offset of local header

    parts.push(localHeader, pathBuf, stored);
    centralDirectory.push(cdHeader, pathBuf);
    offset += localHeader.length + pathBuf.length + stored.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDirectory) {
    cdSize += cd.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // End of central directory signature
  eocd.writeUInt16LE(0, 4);                     // Number of this disk
  eocd.writeUInt16LE(0, 6);                     // Disk where CD starts
  eocd.writeUInt16LE(entries.length, 8);         // Number of CD records on this disk
  eocd.writeUInt16LE(entries.length, 10);        // Total number of CD records
  eocd.writeUInt32LE(cdSize, 12);               // Size of central directory
  eocd.writeUInt32LE(cdOffset, 16);             // Offset of start of CD
  eocd.writeUInt16LE(0, 20);                     // Comment length

  return Buffer.concat([...parts, ...centralDirectory, eocd]);
}

/**
 * CRC-32 implementation (IEEE 802.3 polynomial).
 * Used for ZIP local/central file headers.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib's native CRC-32, present from Node 20.15 and 22.2. */
const nativeCrc32 = (zlib as { crc32?: (data: Buffer) => number }).crc32;

export function crc32(data: Buffer): number {
  return nativeCrc32 ? nativeCrc32(data) : tableCrc32(data);
}

export function tableCrc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
