/**
 * The .c3p zip reader, round-tripped against the project's zip writer and
 * against archives built as Construct 3 r506-2 saved one (ZIP64 records,
 * DEFLATE, backslash paths), damaged, or crafted to be unsafe. The archives are
 * synthetic.
 */

import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readZip, readZipArchive, checkEntryPath, decodeCp437 } from '../../src/runtime/zip-reader.js';
import { zipBuffer, crc32, tableCrc32 } from '../../src/runtime/zip-writer.js';

const json = Buffer.from(JSON.stringify({ name: 'Game', items: Array(50).fill('repeated text') }));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Offsets of each central directory entry in an archive. */
function centralEntries(zip: Buffer): number[] {
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= zip.length; i++) if (zip.readUInt32LE(i) === 0x02014b50) offsets.push(i);
  return offsets;
}

/** One entry of a Construct-style archive; the optional fields change how it is written. */
interface StyledEntry {
  path: string;
  data: Buffer;
  /** The name bytes to write, when they are not the UTF-8 of `path` */
  nameBytes?: Buffer;
  /** The general purpose flags, when they are not UTF-8 name (0x800) plus sizes-after-data (0x4) */
  flags?: number;
  /** Extra field records written beside the ZIP64 one in the central entry */
  extraField?: Buffer;
  /** Write the extra field records before the ZIP64 one */
  extraFirst?: boolean;
  /** Store the data instead of compressing it */
  store?: boolean;
}

/** An extra field record: its id, its size and its data. */
function extraRecord(id: number, data: Buffer): Buffer {
  const record = Buffer.alloc(4 + data.length);
  record.writeUInt16LE(id, 0);
  record.writeUInt16LE(data.length, 2);
  data.copy(record, 4);
  return record;
}

/** An Info-ZIP Unicode Path field (0x7075) for `nameBytes`, with the CRC-32 it carries and the UTF-8 name. */
function unicodePathRecord(nameBytes: Buffer, unicodeName: string, crc = crc32(nameBytes)): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(1, 0);
  head.writeUInt32LE(crc, 1);
  return extraRecord(0x7075, Buffer.concat([head, Buffer.from(unicodeName)]));
}

/**
 * A ZIP64 archive shaped like the ones Construct r506-2 saves: every size and
 * offset in the local and central headers is the 0xFFFFFFFF placeholder, the
 * real values sit in each entry's ZIP64 extra field, and the end record points
 * to a ZIP64 end record through a locator. Entries are DEFLATE-compressed
 * unless they ask to be stored.
 */
function constructStyleZip64(entries: StyledEntry[]): Buffer {
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
  for (const { path, data, nameBytes, flags = 0x800 | 0x4, extraField = Buffer.alloc(0), extraFirst, store } of entries) {
    const name = nameBytes ?? Buffer.from(path);
    const packed = store ? data : deflateRawSync(data);
    const localExtra = zip64Extra([data.length, packed.length]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const zip64Central = zip64Extra([data.length, packed.length, offset]);
    const centralExtra = extraFirst ? Buffer.concat([extraField, zip64Central]) : Buffer.concat([zip64Central, extraField]);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(45, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(store ? 0 : 8, 10);
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
  it('reads back what the writer stores, with UTF-8 names and empty files', () => {
    const entries = [
      { path: 'project.c3proj', data: json },
      { path: 'images/player-idle-000.png', data: png },
      { path: 'files/données.txt', data: Buffer.from('café') },
      { path: 'files/empty.txt', data: Buffer.alloc(0) },
    ];
    expect(readZip(zipBuffer(entries))).toEqual(entries);
  });

  it('stores every entry and marks only non-ASCII names as UTF-8', () => {
    const zip = zipBuffer([
      { path: 'project.c3proj', data: json },
      { path: 'a.png', data: png },
      { path: 'files/données.txt', data: Buffer.from('x') },
    ]);
    const offsets = centralEntries(zip);
    expect(offsets.map(o => zip.readUInt16LE(o + 10))).toEqual([0, 0, 0]);
    expect(offsets.map(o => zip.readUInt16LE(o + 8))).toEqual([0, 0, 0x800]);
    expect(zip.readUInt32LE(offsets[0] + 20)).toBe(json.length);
  });

  it('uses a CRC given with an entry', () => {
    const data = Buffer.from('some data');
    expect(readZip(zipBuffer([{ path: 'a', data, crc: crc32(data) }]))).toEqual([{ path: 'a', data }]);
    expect(() => readZip(zipBuffer([{ path: 'a', data, crc: (crc32(data) ^ 1) >>> 0 }]))).toThrow(/fails its CRC check/);
  });

  it('leaves directory entries out of readZip and reads past an archive comment', () => {
    const zip = zipBuffer([{ path: 'project.c3proj', data: json }]);
    const comment = Buffer.from('saved by a tool');
    const withComment = Buffer.concat([zip, comment]);
    withComment.writeUInt16LE(comment.length, zip.length - 2);
    expect(readZip(withComment).map(e => e.path)).toEqual(['project.c3proj']);

    const withDir = zipBuffer([{ path: 'images/', data: Buffer.alloc(0) }, { path: 'images/a.png', data: png }]);
    expect(readZip(withDir).map(e => e.path)).toEqual(['images/a.png']);
  });

  it('lists directory entries apart from files', () => {
    const zip = zipBuffer([{ path: 'files/', data: Buffer.alloc(0) }, { path: 'files/a.txt', data: Buffer.from('a') }]);
    const archive = readZipArchive(zip);
    expect(archive.directories).toEqual(['files/']);
    expect(archive.files).toEqual([{ path: 'files/a.txt', data: Buffer.from('a') }]);
    expect(readZip(zip)).toEqual([{ path: 'files/a.txt', data: Buffer.from('a') }]);
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
      expect(() => readZip(zipBuffer([{ path, data: png }])), path).toThrow();
    }
    expect(checkEntryPath('images/..hidden/ok.png')).toBe('images/..hidden/ok.png');
  });

  it('refuses paths that name their file ambiguously, before anything is read', () => {
    const ambiguous = [
      'images//a.png', 'images/./a.png', './a.png', 'images/a.png.', 'images/a.png ', 'images /a.png',
      'images/a:b.png', 'aux.json', 'images/nul.png', 'files/COM1.txt',
    ];
    for (const path of ambiguous) {
      expect(() => checkEntryPath(path), path).toThrow();
    }
    expect(checkEntryPath('images/auxiliary.png')).toBe('images/auxiliary.png');
    expect(checkEntryPath('images/a.b.png')).toBe('images/a.b.png');

    const archive = zipBuffer([{ path: 'images/a.png', data: png }, { path: 'images/./a.png', data: png }]);
    expect(() => readZipArchive(archive)).toThrow(/images\/\.\/a\.png/);
  });

  it('reads backslashes as folder separators, as Construct on Windows writes its paths', () => {
    expect(checkEntryPath('objectTypes\\System Objects\\Keyboard.json')).toBe('objectTypes/System Objects/Keyboard.json');
    const zip = zipBuffer([{ path: 'project.c3proj', data: json }, { path: 'images\\', data: Buffer.alloc(0) }, { path: 'images\\a.png', data: png }]);
    expect(readZip(zip).map(e => e.path)).toEqual(['project.c3proj', 'images/a.png']);
    expect(() => readZip(zipBuffer([{ path: 'images\\A.png', data: png }, { path: 'images/a.png', data: png }]))).toThrow(/more than once/);
  });

  it('refuses two entries whose names differ only by case, which would collide on Windows', () => {
    expect(() => readZip(zipBuffer([{ path: 'a/B.png', data: png }, { path: 'a/b.png', data: png }]))).toThrow(/more than once/);
  });

  it('refuses an archive that spells one folder two ways', () => {
    const zip = zipBuffer([{ path: 'Layouts/a.json', data: json }, { path: 'layouts/b.json', data: json }]);
    expect(() => readZip(zip)).toThrow(/spells the folder "layouts" two ways/);
  });

  it('refuses two entries that name one file in two spellings', () => {
    const cases = zipBuffer([{ path: 'eventSheets/Main.json', data: json }, { path: 'eventSheets/main.json', data: json }]);
    expect(() => readZip(cases)).toThrow(/appears more than once/);
    const normalized = zipBuffer([{ path: 'files/\u00e9.txt', data: json }, { path: 'files/e\u0301.txt', data: json }]);
    expect(() => readZip(normalized)).toThrow(/appears more than once/);
  });

  it('refuses a file whose path is also a folder of another entry', () => {
    const nested = zipBuffer([{ path: 'files/a', data: json }, { path: 'files/a/b.txt', data: json }]);
    expect(() => readZip(nested)).toThrow(/is both a file and a folder/);
    const directory = zipBuffer([{ path: 'files/a/', data: Buffer.alloc(0) }, { path: 'files/a', data: json }]);
    expect(() => readZip(directory)).toThrow(/is both a file and a folder/);
  });

  it('refuses encrypted entries, other compression methods, bad CRCs and wrong sizes', () => {
    const base = () => zipBuffer([{ path: 'project.c3proj', data: json }]);
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
    const zip = zipBuffer([{ path: 'project.c3proj', data: json }]);
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

  it('reads stored entries and other extra fields in a ZIP64 archive', () => {
    const timestamp = extraRecord(0x5455, Buffer.from([1, 0, 0, 0, 0]));
    const ntfs = extraRecord(0x000a, Buffer.alloc(32));
    const zip = constructStyleZip64([
      { path: 'project.c3proj', data: json, extraField: Buffer.concat([timestamp, ntfs]) },
      { path: 'images\\a.png', data: png, store: true, extraField: Buffer.concat([timestamp, ntfs]), extraFirst: true },
      { path: 'files\\empty.txt', data: Buffer.alloc(0), store: true },
    ]);
    expect(readZip(zip)).toEqual([
      { path: 'project.c3proj', data: json },
      { path: 'images/a.png', data: png },
      { path: 'files/empty.txt', data: Buffer.alloc(0) },
    ]);
  });

  describe('names without the UTF-8 flag', () => {
    const cafe = Buffer.concat([Buffer.from('files/caf'), Buffer.from([0x82]), Buffer.from('.txt')]);
    const unflagged = (entry: Omit<StyledEntry, 'flags'>) => constructStyleZip64([{ ...entry, flags: 0x4 }]);

    it('decodes an unflagged name by its Unicode Path field, else as UTF-8 when valid, else as code page 437', () => {
      const data = Buffer.from('x');
      const utf8 = unflagged({ path: 'files/donn\u00e9es.txt', data });
      expect(readZip(utf8).map(e => e.path)).toEqual(['files/donn\u00e9es.txt']);

      const cp437 = unflagged({ path: 'ignored', nameBytes: cafe, data });
      expect(readZip(cp437).map(e => e.path)).toEqual(['files/caf\u00e9.txt']);

      const withField = unflagged({
        path: 'ignored', nameBytes: cafe, data, extraField: unicodePathRecord(cafe, 'files/cafe-unicode.txt'),
      });
      expect(readZip(withField).map(e => e.path)).toEqual(['files/cafe-unicode.txt']);

      const forOtherName = unflagged({
        path: 'ignored', nameBytes: cafe, data, extraField: unicodePathRecord(cafe, 'files/cafe-unicode.txt', (crc32(cafe) ^ 1) >>> 0),
      });
      expect(readZip(forOtherName).map(e => e.path)).toEqual(['files/caf\u00e9.txt']);

      expect(decodeCp437(Buffer.from([0x80, 0x82, 0xe1]))).toBe('\u00c7\u00e9\u00df');
    });

    it('decodes all 128 high bytes of code page 437 to one character each', () => {
      const high = Buffer.from(Array.from({ length: 128 }, (_, i) => 0x80 + i));
      const decoded = decodeCp437(high);
      expect(decoded).toHaveLength(128);
      expect(decoded).not.toContain('undefined');
      expect(new Set(decoded).size).toBe(128);
    });

    it('writes a decoded name back as UTF-8, with the flag', () => {
      const entries = readZip(unflagged({ path: 'ignored', nameBytes: cafe, data: Buffer.from('x') }));
      const zip = zipBuffer(entries);
      expect(readZip(zip).map(e => e.path)).toEqual(['files/caf\u00e9.txt']);
      expect(zip.readUInt16LE(centralEntries(zip)[0] + 8)).toBe(0x800);
    });
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

describe('zipBuffer', () => {
  it('refuses more entries than a zip without ZIP64 can count', () => {
    const entries = Array.from({ length: 0x10000 }, (_, i) => ({ path: `f${i}`, data: Buffer.alloc(0) }));
    expect(() => zipBuffer(entries)).toThrow('A zip without ZIP64 records holds at most 65535 entries; this one would hold 65536.');
    expect(readZip(zipBuffer(entries.slice(1)))).toHaveLength(0xffff);
  });
});
