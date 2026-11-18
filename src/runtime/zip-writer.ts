/**
 * Minimal ZIP file writer using Node.js built-ins, for .c3p archives: the
 * ones pack_project writes, and a single-file project written back after a
 * tool call (c3p-archive.ts).
 *
 * Entries are stored (no compression). A name with characters outside
 * ASCII is marked as UTF-8 (flag bit 11), so a reader that honours the flag
 * reads it back as written. A zip without ZIP64 records counts at most
 * 65,535 entries and 4 GiB; more entries are refused, and a larger archive
 * fails with Node's range error.
 */

import { writeFile } from 'node:fs/promises';
import * as zlib from 'node:zlib';

/** A file to put in a zip: its path inside (forward slashes; a directory ends with "/" and has no data), its data, and its CRC-32 when it is known. */
export interface ZipEntry {
  path: string;
  data: Buffer;
  crc?: number;
}

const MAX_ENTRIES = 0xffff;
const UTF8_FLAG = 0x800;

let table: Uint32Array | undefined;

/** CRC-32 (IEEE 802.3) with a lookup table, for a Node without zlib.crc32. */
export function tableCrc32(data: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const nativeCrc32 = (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32;

/** CRC-32 of the ZIP headers: zlib's when Node has it (Node 22.2 and 20.15 on), else the table. */
export function crc32(data: Buffer): number {
  return nativeCrc32 ? nativeCrc32(data) >>> 0 : tableCrc32(data);
}

/** Build a ZIP archive of `entries` in memory, every entry stored. */
export function zipBuffer(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`A zip without ZIP64 records holds at most ${MAX_ENTRIES} entries; this one would hold ${entries.length}.`);
  }
  const parts: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuf = Buffer.from(entry.path, 'utf-8');
    const flags = /[^\u0000-\u007f]/.test(entry.path) ? UTF8_FLAG : 0;
    const crc = entry.crc ?? crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);   // Local file header signature
    localHeader.writeUInt16LE(20, 4);            // Version needed to extract (2.0)
    localHeader.writeUInt16LE(flags, 6);         // General purpose bit flag
    localHeader.writeUInt16LE(0, 8);             // Compression method: STORE
    localHeader.writeUInt16LE(0, 10);            // Last mod file time
    localHeader.writeUInt16LE(0, 12);            // Last mod file date
    localHeader.writeUInt32LE(crc, 14);          // CRC-32
    localHeader.writeUInt32LE(size, 18);         // Compressed size
    localHeader.writeUInt32LE(size, 22);         // Uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);            // Extra field length

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);      // Central directory signature
    cdHeader.writeUInt16LE(20, 4);               // Version made by (2.0)
    cdHeader.writeUInt16LE(20, 6);               // Version needed to extract
    cdHeader.writeUInt16LE(flags, 8);            // General purpose bit flag
    cdHeader.writeUInt16LE(0, 10);               // Compression method: STORE
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(size, 20);
    cdHeader.writeUInt32LE(size, 24);
    cdHeader.writeUInt16LE(pathBuf.length, 28);
    cdHeader.writeUInt32LE(offset, 42);          // Relative offset of local header

    parts.push(localHeader, pathBuf, entry.data);
    centralDirectory.push(cdHeader, pathBuf);
    offset += localHeader.length + pathBuf.length + entry.data.length;
  }

  const cd = Buffer.concat(centralDirectory);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);            // End of central directory signature
  eocd.writeUInt16LE(entries.length, 8);         // Number of CD records on this disk
  eocd.writeUInt16LE(entries.length, 10);        // Total number of CD records
  eocd.writeUInt32LE(cd.length, 12);             // Size of central directory
  eocd.writeUInt32LE(offset, 16);                // Offset of start of CD
  return Buffer.concat([...parts, cd, eocd]);
}

/** Build a ZIP file from a list of entries and write it to disk, every entry stored. */
export async function writeZip(entries: readonly ZipEntry[], outputPath: string): Promise<void> {
  await writeFile(outputPath, zipBuffer(entries));
}
