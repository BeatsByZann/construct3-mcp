/**
 * Archive builders for the zip reader and addon archive tests. `zipBuffer`
 * writes STORE entries only, so an entry whose compressed stream must really
 * be inflated is built here by hand.
 */

import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/runtime/zip-writer.js';

/** One entry of an archive built by `zipWithDeflate`. */
export interface FixtureEntry {
  path: string;
  data: Buffer;
  /** 0 stores the data; 8 writes `deflateRawSync(data)` */
  method: 0 | 8;
  /** Method 8 only: overwrite the first byte of the compressed stream with a reserved block type, leaving sizes, CRC and offsets as they were */
  damage?: boolean;
  /** The uncompressed size to write in both headers, when it is not the data's length */
  declaredSize?: number;
}

const compressedByData = new WeakMap<Buffer, Buffer>();
const crcByData = new WeakMap<Buffer, number>();

/** DEFLATE of `data`, computed once per buffer so an archive of thousands of identical entries stays cheap. */
function deflated(data: Buffer): Buffer {
  let packed = compressedByData.get(data);
  if (!packed) {
    packed = deflateRawSync(data);
    compressedByData.set(data, packed);
  }
  return packed;
}

/** CRC-32 of `data`, computed once per buffer. */
function crcOf(data: Buffer): number {
  let crc = crcByData.get(data);
  if (crc === undefined) {
    crc = crc32(data);
    crcByData.set(data, crc);
  }
  return crc;
}

/**
 * Build an archive in memory. A method-8 entry holds a real DEFLATE stream,
 * with method 8 in the local and the central header, its compressed size, its
 * uncompressed size, the CRC-32 of the original data and its local offset. A
 * damaged one then has the first byte of its stream replaced by 0x07 (a
 * reserved block type), which inflation refuses whatever the stream holds.
 */
export function zipWithDeflate(entries: readonly FixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf-8');
    const stored = entry.method === 8 ? deflated(entry.data) : entry.data;
    const payload = entry.damage && entry.method === 8 ? Buffer.from(stored) : stored;
    if (entry.damage && entry.method === 8) payload[0] = 0x07;
    const crc = crcOf(entry.data);
    const size = entry.declaredSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(entry.method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(payload.length, 20);
    head.writeUInt32LE(size, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);

    parts.push(local, name, payload);
    central.push(head, name);
    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The offset of each central directory entry, found through the end record (never by scanning for the signature). */
export function centralEntryOffsets(zip: Buffer): number[] {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = zip.readUInt16LE(eocd + 10);
  const offsets: number[] = [];
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    offsets.push(p);
    p += 46 + zip.readUInt16LE(p + 28) + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return offsets;
}

/** Where the local header of the central entry at `central` starts. */
export function localOffsetOf(zip: Buffer, central: number): number {
  return zip.readUInt32LE(central + 42);
}

/** JSON text of `target` bytes: `json` followed by whitespace, so it compresses to almost nothing and still parses. */
export function paddedJson(json: string, target: number): Buffer {
  return Buffer.concat([Buffer.from(json), Buffer.alloc(Math.max(0, target - json.length), 0x20)]);
}
