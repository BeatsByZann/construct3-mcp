/**
 * The .c3p zip reader, and the writer's compression option, round-tripped
 * against each other and against archives damaged or crafted to be unsafe.
 */

import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readZip, checkEntryPath } from '../../src/runtime/zip-reader.js';
import { buildZip, crc32, tableCrc32 } from '../../src/runtime/zip-writer.js';

const json = Buffer.from(JSON.stringify({ name: 'Game', items: Array(50).fill('repeated text') }));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Offsets of each central directory entry in an archive. */
function centralEntries(zip: Buffer): number[] {
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= zip.length; i++) if (zip.readUInt32LE(i) === 0x02014b50) offsets.push(i);
  return offsets;
}

/**
 * A ZIP64 archive shaped like the ones Construct r495.2 saves: every size and
 * offset in the local and central headers is the 0xFFFFFFFF placeholder, the
 * real values sit in each entry's ZIP64 extra field, and the end record points
 * to a ZIP64 end record through a locator. Entries are DEFLATE-compressed.
 */
function constructStyleZip64(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const zip64Extra = (values: number[]) => {
    const extra = Buffer.alloc(4 + values.length * 8);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(values.length * 8, 2);
    values.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
    return extra;
  };
  for (const { path, data } of entries) {
    const name = Buffer.from(path);
    const packed = deflateRawSync(data);
    const localExtra = zip64Extra([data.length, packed.length]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x800 | 0x4, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const centralExtra = zip64Extra([data.length, packed.length, offset]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(45, 6);
    header.writeUInt16LE(0x800 | 0x4, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc32(data), 16);
    header.writeUInt32LE(0xffffffff, 20);
    header.writeUInt32LE(0xffffffff, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(centralExtra.length, 30);
    header.writeUInt32LE(0xffffffff, 42);
    parts.push(local, name, localExtra, packed);
    central.push(header, name, centralExtra);
    offset += local.length + name.length + localExtra.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entries.length), 24);
  record.writeBigUInt64LE(BigInt(entries.length), 32);
  record.writeBigUInt64LE(BigInt(cd.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([...parts, cd, record, locator, eocd]);
}

describe('readZip', () => {
  it('reads back what the writer stores or compresses, with UTF-8 names and empty files', () => {
    const entries = [
      { path: 'project.c3proj', data: json },
      { path: 'images/player-idle-000.png', data: png },
      { path: 'files/données.txt', data: Buffer.from('café') },
      { path: 'files/empty.txt', data: Buffer.alloc(0) },
    ];
    for (const compress of [false, true]) {
      expect(readZip(buildZip(entries, { compress }))).toEqual(entries);
    }
  });

  it('compresses only the entries that get smaller, and marks only non-ASCII names as UTF-8', () => {
    const zip = buildZip([
      { path: 'project.c3proj', data: json },
      { path: 'a.png', data: png },
      { path: 'files/données.txt', data: Buffer.from('x') },
    ], { compress: true });
    const [c3proj, image, accented] = centralEntries(zip);
    expect(zip.readUInt16LE(c3proj + 10)).toBe(8);
    expect(zip.readUInt32LE(c3proj + 20)).toBeLessThan(json.length);
    expect(zip.readUInt16LE(image + 10)).toBe(0);
    expect(zip.readUInt16LE(c3proj + 8)).toBe(0);
    expect(zip.readUInt16LE(accented + 8)).toBe(0x800);
    // Without the option every entry is stored, as pack_project has always written.
    const stored = buildZip([{ path: 'project.c3proj', data: json }]);
    expect(centralEntries(stored).map(o => stored.readUInt16LE(o + 10))).toEqual([0]);
  });

  it('skips directory entries and reads past an archive comment', () => {
    const zip = buildZip([{ path: 'project.c3proj', data: json }]);
    const comment = Buffer.from('saved by a tool');
    const withComment = Buffer.concat([zip, comment]);
    withComment.writeUInt16LE(comment.length, zip.length - 2);
    expect(readZip(withComment).map(e => e.path)).toEqual(['project.c3proj']);

    const withDir = buildZip([{ path: 'images/', data: Buffer.alloc(0) }, { path: 'images/a.png', data: png }]);
    expect(readZip(withDir).map(e => e.path)).toEqual(['images/a.png']);
  });

  it('takes sizes from the central directory when the local header leaves them zero', () => {
    const data = deflateRawSync(json);
    const name = Buffer.from('project.c3proj');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 6); // bit 3: sizes follow the data
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(json), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(json.length, 24);
    central.writeUInt16LE(name.length, 28);
    const descriptor = Buffer.alloc(16);
    const eocd = Buffer.alloc(22);
    const cdOffset = local.length + name.length + data.length + descriptor.length;
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const zip = Buffer.concat([local, name, data, descriptor, central, name, eocd]);
    expect(readZip(zip)).toEqual([{ path: 'project.c3proj', data: json }]);
  });

  it('refuses entry paths that would land outside the extraction folder', () => {
    for (const path of ['../evil.txt', 'images/../../evil.txt', '/etc/evil', 'C:/evil.txt', '\\evil.txt', '..\\evil.txt', 'images\\..\\..\\evil.png', 'a\0b']) {
      expect(() => checkEntryPath(path), path).toThrow();
      expect(() => readZip(buildZip([{ path, data: png }])), path).toThrow();
    }
    expect(checkEntryPath('images/..hidden/ok.png')).toBe('images/..hidden/ok.png');
  });

  it('reads backslashes, which Construct on Windows writes in every path, as folder separators', () => {
    expect(checkEntryPath('objectTypes\\System Objects\\Keyboard.json')).toBe('objectTypes/System Objects/Keyboard.json');
    const zip = buildZip([{ path: 'project.c3proj', data: json }, { path: 'images\\', data: Buffer.alloc(0) }, { path: 'images\\a.png', data: png }]);
    expect(readZip(zip).map(e => e.path)).toEqual(['project.c3proj', 'images/a.png']);
    expect(() => readZip(buildZip([{ path: 'images\\A.png', data: png }, { path: 'images/a.png', data: png }]))).toThrow(/more than once/);
  });

  it('refuses two entries whose names differ only by case, which would collide on Windows', () => {
    expect(() => readZip(buildZip([{ path: 'a/B.png', data: png }, { path: 'a/b.png', data: png }]))).toThrow(/more than once/);
  });

  it('refuses encrypted entries, other compression methods, bad CRCs and wrong sizes', () => {
    const base = () => buildZip([{ path: 'project.c3proj', data: json }]);
    const [central] = centralEntries(base());

    const encrypted = base();
    encrypted.writeUInt16LE(1, central + 8);
    expect(() => readZip(encrypted)).toThrow(/encrypted/);

    const bzip = base();
    bzip.writeUInt16LE(12, central + 10);
    expect(() => readZip(bzip)).toThrow(/compression method 12/);

    const badCrc = base();
    badCrc.writeUInt32LE((crc32(json) ^ 1) >>> 0, central + 16);
    expect(() => readZip(badCrc)).toThrow(/CRC/);

    const badSize = base();
    badSize.writeUInt32LE(json.length + 1, central + 24);
    expect(() => readZip(badSize)).toThrow(/archive says/);
  });

  it('refuses what is not a zip, a truncated zip, and a ZIP64 placeholder with no ZIP64 field', () => {
    expect(() => readZip(json)).toThrow(/end-of-central-directory/);
    const zip = buildZip([{ path: 'project.c3proj', data: json }]);
    expect(() => readZip(zip.subarray(40))).toThrow();

    const [central] = centralEntries(zip);
    const placeholder = Buffer.from(zip);
    placeholder.writeUInt32LE(0xffffffff, central + 20);
    expect(() => readZip(placeholder)).toThrow(/missing its ZIP64 sizes/);
  });

  it('reads a ZIP64 archive laid out as Construct saves a .c3p', () => {
    const entries = [
      { path: 'project.c3proj', data: json },
      { path: 'objectTypes\\System Objects\\Keyboard.json', data: Buffer.from('{"name":"Keyboard"}') },
      { path: 'images\\a.png', data: png },
    ];
    expect(readZip(constructStyleZip64(entries))).toEqual([
      { path: 'project.c3proj', data: json },
      { path: 'objectTypes/System Objects/Keyboard.json', data: Buffer.from('{"name":"Keyboard"}') },
      { path: 'images/a.png', data: png },
    ]);
    const damaged = constructStyleZip64(entries);
    damaged.writeUInt32LE(0, damaged.length - 22 - 20 - 56);
    expect(() => readZip(damaged)).toThrow(/ZIP64 end record is damaged/);
  });
});

describe('crc32', () => {
  it('gives the same checksum from zlib and from the table fallback', () => {
    for (const data of [Buffer.alloc(0), Buffer.from('123456789'), json, png]) {
      expect(crc32(data)).toBe(tableCrc32(data));
    }
    expect(tableCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('buildZip', () => {
  it('refuses more entries than a zip without ZIP64 can count', () => {
    const entries = Array.from({ length: 0x10000 }, (_, i) => ({ path: `f${i}`, data: Buffer.alloc(0) }));
    expect(() => buildZip(entries)).toThrow(/65535/);
    expect(readZip(buildZip(entries.slice(1)))).toHaveLength(0xffff);
  });
});
