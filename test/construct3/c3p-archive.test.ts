/**
 * Single-file projects: a .c3p archive unpacked into a session folder, kept in
 * step with it between tool calls, and written back without replacing a save
 * another program made. The archives are synthetic (built here with the zip
 * writer, or in the ZIP64 shape Construct 3 saved); failures are injected
 * through the file operations the archive takes as an option.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  C3pArchive,
  describeArchiveRefresh,
  describeArchiveSync,
  findLeftWorkFolders,
  isC3pPath,
  isHeldEntry,
  type C3pArchiveOptions,
  type C3pFs,
} from '../../src/construct3/c3p-archive.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { runInToolCall } from '../../src/construct3/disk-state.js';
import { readZip, readZipArchive } from '../../src/runtime/zip-reader.js';
import { zipBuffer, crc32, type ZipEntry } from '../../src/runtime/zip-writer.js';
import { collectProjectFiles } from '../../src/runtime/project-files.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
/** A whole second, so a modification time can be restored exactly. */
const SECOND = 1_700_000_000;

const PROJECT = Buffer.from('{"name":"T"}');
const MAIN = Buffer.from('{"events":[]}');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

let root: string;
let work: string;
let archivePath: string;

/** The archive's entries: a project file, an event sheet and an image. */
const baseEntries = (main: Buffer = MAIN): ZipEntry[] => [
  { path: 'project.c3proj', data: PROJECT },
  { path: 'eventSheets/Main.json', data: main },
  { path: 'images/a.png', data: PNG },
];
/** The entries with an event sheet of another size and content. */
const variant = (tag: string): ZipEntry[] => baseEntries(Buffer.from(`{"events":["${tag}"]}`));

const setTime = (path: string) => nodeFs.utimes(path, SECOND, SECOND);
const writeArchive = (entries: ZipEntry[]) => nodeFs.writeFile(archivePath, zipBuffer(entries));
/** Write an archive of the size and modification time of the one on disk, with other content. */
async function sameShape(entries: ZipEntry[]): Promise<Buffer> {
  const size = (await nodeFs.stat(archivePath)).size;
  const data = zipBuffer(entries);
  expect(data.length).toBe(size);
  await nodeFs.writeFile(archivePath, data);
  await setTime(archivePath);
  return data;
}

const exists = (path: string) => nodeFs.access(path).then(() => true, () => false);
const rootNames = async () => (await nodeFs.readdir(root)).filter(name => name !== 'work').sort();
const bytesAt = (path: string) => nodeFs.readFile(path);

/** Every file below `dir`: path (forward slashes) to content. */
async function snapshot(dir: string, sub = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await nodeFs.readdir(sub ? join(dir, sub) : dir, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [k, v] of await snapshot(dir, rel)) out.set(k, v);
    else out.set(rel, (await nodeFs.readFile(join(dir, rel))).toString('base64'));
  }
  return out;
}

/** What zip64 Construct 3 saved: placeholder sizes, DEFLATE entries, backslash paths, UTF-8 names. */
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
    const flags = 0x800 | 0x4;
    const localExtra = zip64Extra([data.length, packed.length]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(flags, 6);
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
    header.writeUInt16LE(flags, 8);
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

/** Calls to run before or after a file operation, by operation (the first two arguments are passed on). */
type Hook = (a: string, b: unknown) => void | Promise<void>;
interface Hooks {
  before: Partial<Record<keyof C3pFs, Hook>>;
  after: Partial<Record<keyof C3pFs, Hook>>;
  calls: Array<{ op: string; a: string }>;
}

const fault = (code = 'EBUSY') => Object.assign(new Error(`${code}: simulated failure`), { code });

/** File operations that call node's, with hooks that can fail an operation or act around it. */
function hookedFs(): { hooks: Hooks; fs: Partial<C3pFs> } {
  const hooks: Hooks = { before: {}, after: {}, calls: [] };
  const real: C3pFs = {
    stat: path => nodeFs.stat(path),
    readFile: path => nodeFs.readFile(path),
    writeFile: (path, data) => nodeFs.writeFile(path, data),
    rename: (from, to) => nodeFs.rename(from, to),
    link: (existing, path) => nodeFs.link(existing, path),
    copyFileExclusive: (from, to) => nodeFs.copyFile(from, to, constants.COPYFILE_EXCL),
    unlink: path => nodeFs.unlink(path),
    rm: path => nodeFs.rm(path, { recursive: true, force: true }),
  };
  const wrap = (op: keyof C3pFs) => async (a: string, b?: unknown): Promise<unknown> => {
    hooks.calls.push({ op, a });
    await hooks.before[op]?.(a, b);
    const out = await (real[op] as (x: string, y?: unknown) => Promise<unknown>)(a, b);
    await hooks.after[op]?.(a, b);
    return out;
  };
  const fs = Object.fromEntries((Object.keys(real) as Array<keyof C3pFs>).map(op => [op, wrap(op)])) as Partial<C3pFs>;
  return { hooks, fs };
}

const openArchive = (options: C3pArchiveOptions = {}) => C3pArchive.open(archivePath, { workRoot: work, ...options });
const mainPath = (archive: C3pArchive) => join(archive.workDir, 'eventSheets', 'Main.json');
const CHANGED = '{"events":["changed in the folder"]}';
const changeFolder = (archive: C3pArchive, text = CHANGED) => nodeFs.writeFile(mainPath(archive), text);
/** The archive's files as the zip reader gives them: path to content. */
const archiveFiles = async () => new Map(readZip(await bytesAt(archivePath)).map(entry => [entry.path, entry.data.toString('base64')]));
type Build = (...a: unknown[]) => Promise<Buffer>;
const buildSpy = (archive: C3pArchive) => vi.spyOn(archive as unknown as { buildArchive: Build }, 'buildArchive');
/** Run `act` right after the archive's bytes are built, before anything is staged or moved. */
function afterBuild(archive: C3pArchive, act: () => Promise<void>) {
  const build = (archive as unknown as { buildArchive: Build }).buildArchive.bind(archive);
  return buildSpy(archive).mockImplementation(async (...args: unknown[]) => {
    const bytes = await build(...args);
    await act();
    return bytes;
  });
}

beforeEach(async () => {
  root = await nodeFs.mkdtemp(join(tmpdir(), 'c3p-archive-'));
  work = join(root, 'work');
  await nodeFs.mkdir(work);
  archivePath = join(root, 'game.c3p');
  await writeArchive(baseEntries());
  await setTime(archivePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await nodeFs.rm(root, { recursive: true, force: true });
});

describe('isC3pPath and isHeldEntry', () => {
  it('recognizes archive paths and the entries held apart', () => {
    expect(isC3pPath('a/game.c3p')).toBe(true);
    expect(isC3pPath('GAME.C3P')).toBe(true);
    expect(isC3pPath('a/project.c3proj')).toBe(false);
    for (const held of ['files/notes.bak', 'files/NOTES.BAK', 'Thumbs.db', '.DS_Store', 'files/data.tmp', 'files/DATA.TMP', 'node_modules/x.js', '__MACOSX/a']) {
      expect(isHeldEntry(held), held).toBe(true);
    }
    for (const packed of ['project.c3proj', 'eventSheets/Main.json', 'images/a.png', 'files/notes.bakery']) {
      expect(isHeldEntry(packed), packed).toBe(false);
    }
  });
});

describe('opening an archive', () => {
  it('unpacks into a new session folder', async () => {
    const before = await bytesAt(archivePath);
    const archive = await openArchive();
    expect(archive.sessionDir.startsWith(work)).toBe(true);
    expect(archive.workDir).toBe(join(archive.sessionDir, 'project'));
    expect(archive.projectFile).toBe(join(archive.workDir, 'project.c3proj'));
    expect(await snapshot(archive.workDir)).toEqual(new Map(baseEntries().map(e => [e.path, e.data.toString('base64')])));
    const marker = JSON.parse(await nodeFs.readFile(`${archive.sessionDir}.session.json`, 'utf-8'));
    expect(marker.pid).toBe(process.pid);
    expect(marker.archive).toBe(resolve(archivePath));
    expect(await bytesAt(archivePath)).toEqual(before);
    expect(await rootNames()).toEqual(['game.c3p']);
  });

  it('opens the ZIP64 shape Construct saved, with backslash paths', async () => {
    await nodeFs.writeFile(archivePath, constructStyleZip64([
      { path: 'project.c3proj', data: PROJECT },
      { path: 'objectTypes\\System Objects\\Keyboard.json', data: Buffer.from('{"name":"Keyboard"}') },
    ]));
    const archive = await openArchive();
    expect(await bytesAt(join(archive.workDir, 'objectTypes', 'System Objects', 'Keyboard.json'))).toEqual(Buffer.from('{"name":"Keyboard"}'));
  });

  it('refuses an archive without a project file at its root, an unreadable one, and one whose entries collide, leaving no folder behind', async () => {
    await writeArchive([{ path: 'eventSheets/Main.json', data: MAIN }]);
    await expect(openArchive()).rejects.toThrow('has no project.c3proj at its root');
    expect(await nodeFs.readdir(work)).toEqual([]);
    await nodeFs.writeFile(archivePath, Buffer.from('this is not a zip archive at all'));
    await expect(openArchive()).rejects.toThrow(/Cannot read ".*game\.c3p" as a \.c3p archive/);
    expect(await nodeFs.readdir(work)).toEqual([]);
    await writeArchive([...baseEntries(), { path: 'Images/b.png', data: PNG }]);
    await expect(openArchive()).rejects.toThrow('two ways');
    expect(await nodeFs.readdir(work)).toEqual([]);
  });

  it('reads the archive\'s state around the read at open', async () => {
    let calls = 0;
    const second = zipBuffer(variant('second'));
    const archive = await openArchive({
      afterRead: async () => {
        calls++;
        if (calls === 1) await nodeFs.writeFile(archivePath, second);
      },
    });
    expect(calls).toBeGreaterThan(1);
    expect(await nodeFs.readFile(mainPath(archive), 'utf-8')).toBe('{"events":["second"]}');
  });
});

describe('writing the folder back', () => {
  it('writes nothing when the folder did not change', async () => {
    const before = await bytesAt(archivePath);
    const archive = await openArchive();
    expect((await archive.sync()).status).toBe('unchanged');
    expect(await bytesAt(archivePath)).toEqual(before);
    expect(await rootNames()).toEqual(['game.c3p']);
  });

  it('writes the folder back after a change, keeping the archive as it was before this session\'s first write-back in .bak', async () => {
    const original = await bytesAt(archivePath);
    const archive = await openArchive();
    await changeFolder(archive);
    const result = await archive.sync();
    expect(result).toMatchObject({ status: 'saved', fileCount: 3 });
    const expected = new Map<string, string>();
    for (const path of await collectProjectFiles(archive.workDir)) {
      expected.set(path, (await bytesAt(join(archive.workDir, ...path.split('/')))).toString('base64'));
    }
    expect(await archiveFiles()).toEqual(expected);
    expect(await bytesAt(`${archivePath}.bak`)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p', 'game.c3p.bak']);
    await changeFolder(archive, '{"events":["a second change"]}');
    expect((await archive.sync()).status).toBe('saved');
    expect(await bytesAt(`${archivePath}.bak`)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p', 'game.c3p.bak']);
  });

  it('writes added and removed files, and carries through the archive\'s own entries the packer would leave out', async () => {
    const held = [
      { path: 'files/notes.bak', data: Buffer.from('NOTES BACKUP') },
      { path: 'files/OTHER.BAK', data: Buffer.from('OTHER BACKUP') },
      { path: 'Thumbs.db', data: Buffer.from('THUMBS') },
      { path: 'files/data.tmp', data: Buffer.from('DATA TEMP') },
    ];
    await writeArchive([...baseEntries(), ...held, { path: 'files/empty/', data: Buffer.alloc(0) }]);
    const archive = await openArchive();
    for (const entry of held) expect(await exists(join(archive.workDir, ...entry.path.split('/')))).toBe(false);
    for (const entry of held) expect(await bytesAt(join(archive.sessionDir, 'held', ...entry.path.split('/')))).toEqual(entry.data);
    await nodeFs.writeFile(join(archive.workDir, 'images', 'b.png'), PNG);
    await nodeFs.rm(join(archive.workDir, 'images', 'a.png'));
    await nodeFs.writeFile(`${mainPath(archive)}.bak`, 'writer backup');
    await nodeFs.writeFile(`${mainPath(archive)}.tmp`, 'stray temp file');
    expect((await archive.sync()).status).toBe('saved');
    const files = await archiveFiles();
    expect(files.has('images/b.png')).toBe(true);
    expect(files.has('images/a.png')).toBe(false);
    for (const entry of held) expect(files.get(entry.path), entry.path).toBe(entry.data.toString('base64'));
    expect(files.has('eventSheets/Main.json.bak')).toBe(false);
    expect(files.has('eventSheets/Main.json.tmp')).toBe(false);
    expect(readZipArchive(await bytesAt(archivePath)).directories).toEqual(['files/empty/']);
  });

  it('keeps archive entries the tools could overwrite, through real writes', async () => {
    const read = (rel: string) => nodeFs.readFile(join(FIXTURE_DIR, ...rel.split('/')));
    const sheet = JSON.parse((await read('eventSheets/MainSheet.json')).toString('utf-8'));
    await writeArchive([
      { path: 'project.c3proj', data: await read('project.c3proj') },
      { path: 'eventSheets/MainSheet.json', data: await read('eventSheets/MainSheet.json') },
      { path: 'layouts/Layout 1.json', data: await read('layouts/Layout 1.json') },
      { path: 'objectTypes/Sprite.json', data: await read('objectTypes/Sprite.json') },
      { path: 'eventSheets/MainSheet.json.BAK', data: Buffer.from('ORIGINAL BACKUP') },
      { path: 'project.c3proj.bak', data: Buffer.from('ORIGINAL PROJECT BACKUP') },
    ]);
    const archive = await openArchive();
    const reader = new Construct3ProjectReader(archive.projectFile);
    await reader.loadProject();
    const writer = new Construct3ProjectWriter(reader, new IdGenerator());
    sheet.events.push({ eventType: 'comment', text: 'written through the writer' });
    await runInToolCall(async () => {
      await writer.writeEntityFile('eventSheets', 'MainSheet', sheet);
      await writer.updateProject(project => {
        project.name = 'Renamed';
        return true;
      });
    });
    expect((await archive.sync()).status).toBe('saved');
    const files = await archiveFiles();
    expect(Buffer.from(files.get('eventSheets/MainSheet.json.BAK') ?? '', 'base64').toString()).toBe('ORIGINAL BACKUP');
    expect(Buffer.from(files.get('project.c3proj.bak') ?? '', 'base64').toString()).toBe('ORIGINAL PROJECT BACKUP');
    expect(Buffer.from(files.get('eventSheets/MainSheet.json') ?? '', 'base64').toString()).toContain('written through the writer');
    expect(Buffer.from(files.get('project.c3proj') ?? '', 'base64').toString()).toContain('Renamed');
  });
});

describe('a save made by another program', () => {
  it('keeps a save that landed before the archive was moved aside', async () => {
    const archive = await openArchive();
    await changeFolder(archive);
    const put = zipBuffer(variant('saved elsewhere'));
    afterBuild(archive, () => nodeFs.writeFile(archivePath, put));
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(await bytesAt(archivePath)).toEqual(put);
    expect(await rootNames()).toEqual(['game.c3p']);
    const written = await bytesAt(archivePath);
    expect((await archive.sync()).status).toBe('conflict');
    expect((await archive.refresh()).status).toBe('conflict');
    expect(await bytesAt(archivePath)).toEqual(written);
    expect(archive.status().conflict).toBeDefined();
    const closed = await archive.close();
    expect(closed.kept).toBe(archive.workDir);
    expect(await bytesAt(archivePath)).toEqual(put);
    expect(await exists(mainPath(archive))).toBe(true);
  });

  it('decides by content when the size and time are restored', async () => {
    const archive = await openArchive();
    await changeFolder(archive);
    let put: Buffer | undefined;
    afterBuild(archive, async () => {
      put = await sameShape(baseEntries(Buffer.from('{"events":{}}')));
    });
    expect((await archive.sync()).status).toBe('conflict');
    expect(await bytesAt(archivePath)).toEqual(put);
  });

  it('sees an archive of the same size and time but other content before anything is built', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    const put = await sameShape(baseEntries(Buffer.from('{"events":{}}')));
    const spy = buildSpy(archive);
    expect((await archive.sync()).status).toBe('conflict');
    expect(spy).not.toHaveBeenCalled();
    expect(hooks.calls.filter(call => call.op === 'writeFile' && call.a.endsWith('.tmp'))).toEqual([]);
    expect(await bytesAt(archivePath)).toEqual(put);
    expect(await rootNames()).toEqual(['game.c3p']);
  });

  it('keeps a save that landed after the archive was moved aside', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    const put = zipBuffer(variant('landed after the move'));
    hooks.after.rename = async (from, to) => {
      if (from === resolve(archivePath) && String(to).endsWith('.previous')) await nodeFs.writeFile(archivePath, put);
    };
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('while this server was writing it back');
    expect(await bytesAt(archivePath)).toEqual(put);
    expect(await bytesAt(`${archivePath}.bak`)).toEqual(original);
    expect((await rootNames()).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps both saves when one lands before the move and another while it is put back', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    const saveA = zipBuffer(variant('save A'));
    const saveB = zipBuffer(variant('save B, longer'));
    afterBuild(archive, () => nodeFs.writeFile(archivePath, saveA));
    let first = true;
    hooks.before.link = async () => {
      if (first) {
        first = false;
        await nodeFs.writeFile(archivePath, saveB);
      }
    };
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    const previous = (await rootNames()).filter(name => name.endsWith('.previous'));
    expect(previous).toHaveLength(1);
    expect(result.reason).toContain(previous[0]);
    expect(await bytesAt(archivePath)).toEqual(saveB);
    expect(await bytesAt(join(root, previous[0]))).toEqual(saveA);
    await archive.close();
    expect(await bytesAt(archivePath)).toEqual(saveB);
    expect(await bytesAt(join(root, previous[0]))).toEqual(saveA);
  });

  it('places the archive by copy where links are not supported', async () => {
    const { hooks, fs } = hookedFs();
    hooks.before.link = () => {
      throw fault('EPERM');
    };
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    expect((await archive.sync()).status).toBe('saved');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from(CHANGED).toString('base64'));
    expect(hooks.calls.some(call => call.op === 'copyFileExclusive')).toBe(true);

    const put = zipBuffer(variant('landed after the move'));
    hooks.after.rename = async (from, to) => {
      if (from === resolve(archivePath) && String(to).endsWith('.previous')) await nodeFs.writeFile(archivePath, put);
    };
    await changeFolder(archive, '{"events":["changed again in the folder"]}');
    expect((await archive.sync()).status).toBe('conflict');
    expect(await bytesAt(archivePath)).toEqual(put);
  });

  it('sees a save that lands right after the write-back', async () => {
    const { hooks, fs } = hookedFs();
    let committed = false;
    let replaced = false;
    const put = zipBuffer(variant('right after'));
    hooks.after.link = () => {
      committed = true;
    };
    const archive = await openArchive({
      fs,
      afterRead: async () => {
        if (committed && !replaced) {
          replaced = true;
          await nodeFs.writeFile(archivePath, put);
        }
      },
    });
    await changeFolder(archive);
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('right after this server wrote it back');
    expect((await archive.sync()).status).toBe('conflict');
    expect(await bytesAt(archivePath)).toEqual(put);
  });
});

describe('a write-back that fails', () => {
  it('reports a failed write-back without changing the archive', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);

    hooks.before.writeFile = path => {
      if (path.endsWith('.tmp')) throw fault();
    };
    const staging = await archive.sync();
    expect(staging.status).toBe('failed');
    expect(staging.reason).toContain('could not be staged');
    expect(await bytesAt(archivePath)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p']);
    delete hooks.before.writeFile;

    hooks.before.rename = from => {
      if (from === resolve(archivePath)) throw fault();
    };
    const aside = await archive.sync();
    expect(aside.status).toBe('failed');
    expect(aside.reason).toContain('could not be moved aside');
    expect(await bytesAt(archivePath)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p']);
    delete hooks.before.rename;

    hooks.before.link = (existing) => {
      if (existing.endsWith('.tmp')) throw fault('EIO');
    };
    hooks.before.copyFileExclusive = (from) => {
      if (from.endsWith('.tmp')) throw fault('EIO');
    };
    const place = await archive.sync();
    expect(place.status).toBe('failed');
    expect(place.reason).toContain('could not be put in place');
    expect(await bytesAt(archivePath)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p']);
    expect(hooks.calls.some(call => call.op === 'copyFileExclusive' && call.a.endsWith('.tmp'))).toBe(true);
    delete hooks.before.link;
    delete hooks.before.copyFileExclusive;

    expect((await archive.sync()).status).toBe('saved');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from(CHANGED).toString('base64'));
  });

  it('a committed write-back that cannot be read back', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    let committed = false;
    hooks.after.link = () => {
      committed = true;
    };
    hooks.before.readFile = path => {
      if (committed && path === resolve(archivePath)) throw fault('EIO');
    };
    const result = await archive.sync();
    expect(result.status).toBe('saved');
    expect(result.notes?.join(' ')).toContain('could not be read back to confirm');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from(CHANGED).toString('base64'));
    delete hooks.before.readFile;
    await changeFolder(archive, '{"events":["another change"]}');
    expect((await archive.sync()).status).toBe('saved');
  });

  it('does not write an archive that does not read back as the working folder holds it', async () => {
    const original = await bytesAt(archivePath);
    const archive = await openArchive();
    await changeFolder(archive);
    buildSpy(archive).mockResolvedValue(zipBuffer(baseEntries(Buffer.from('{"events":["other bytes"]}'))));
    const result = await archive.sync();
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('did not read back as the working folder holds eventSheets/Main.json');
    expect(await bytesAt(archivePath)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p']);
  });

  it('does not build or stage when the archive already changed', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    const put = zipBuffer(variant('changed meanwhile'));
    await nodeFs.writeFile(archivePath, put);
    const spy = buildSpy(archive);
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(spy).not.toHaveBeenCalled();
    expect(hooks.calls.filter(call => call.op === 'writeFile' && call.a.endsWith('.tmp'))).toEqual([]);
    expect(await bytesAt(archivePath)).toEqual(put);
  });
});

describe('taking the archive as it changed', () => {
  it('takes the archive as saved when the folder holds nothing unsaved', async () => {
    const archive = await openArchive();
    await writeArchive([
      { path: 'project.c3proj', data: PROJECT },
      { path: 'eventSheets/Main.json', data: Buffer.from('{"events":["from the archive"]}') },
      { path: 'layouts/L.json', data: Buffer.from('{"name":"L"}') },
    ]);
    expect((await archive.refresh()).status).toBe('refreshed');
    expect(await nodeFs.readFile(mainPath(archive), 'utf-8')).toBe('{"events":["from the archive"]}');
    expect(await bytesAt(join(archive.workDir, 'layouts', 'L.json'))).toEqual(Buffer.from('{"name":"L"}'));
    expect(await exists(join(archive.workDir, 'images', 'a.png'))).toBe(false);
    expect((await archive.sync()).status).toBe('unchanged');
  });

  it('takes a file renamed only in letter case, in both directions', async () => {
    const archive = await openArchive();
    const sheets = async () => (await collectProjectFiles(archive.workDir)).filter(path => path.startsWith('eventSheets/'));
    const entries = (name: string, text: string): ZipEntry[] => [
      { path: 'project.c3proj', data: PROJECT },
      { path: `eventSheets/${name}`, data: Buffer.from(text) },
    ];
    await writeArchive(entries('main.json', '{"events":["lower case"]}'));
    expect((await archive.refresh()).status).toBe('refreshed');
    expect(await sheets()).toEqual(['eventSheets/main.json']);
    expect(await nodeFs.readFile(join(archive.workDir, 'eventSheets', 'main.json'), 'utf-8')).toBe('{"events":["lower case"]}');
    await writeArchive(entries('MAIN.json', '{"events":["upper case, longer"]}'));
    expect((await archive.refresh()).status).toBe('refreshed');
    expect(await sheets()).toEqual(['eventSheets/MAIN.json']);
    await nodeFs.writeFile(join(archive.workDir, 'eventSheets', 'MAIN.json'), '{"events":["edited in the folder"]}');
    expect((await archive.sync()).status).toBe('saved');
    const files = await archiveFiles();
    expect([...files.keys()].filter(path => path.startsWith('eventSheets/'))).toEqual(['eventSheets/MAIN.json']);
    expect(Buffer.from(files.get('eventSheets/MAIN.json') ?? '', 'base64').toString()).toBe('{"events":["edited in the folder"]}');
  });

  it('refreshes nothing when the folder holds a change the archive lacks', async () => {
    const archive = await openArchive();
    await changeFolder(archive);
    const put = zipBuffer(variant('saved elsewhere'));
    await nodeFs.writeFile(archivePath, put);
    expect((await archive.refresh()).status).toBe('conflict');
    expect(await nodeFs.readFile(mainPath(archive), 'utf-8')).toBe(CHANGED);
    expect(await bytesAt(archivePath)).toEqual(put);
  });

  it('a new modification time alone is no change', async () => {
    const archive = await openArchive();
    await nodeFs.utimes(archivePath, SECOND + 100, SECOND + 100);
    expect((await archive.refresh()).status).toBe('unchanged');
    expect((await archive.sync()).status).toBe('unchanged');
  });

  it('a refresh that fails before it publishes leaves the folder as it was', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    const before = await snapshot(archive.workDir);
    await writeArchive(variant('replaced'));

    const unpack = vi.spyOn(archive as unknown as { unpackInto: (dir: string) => Promise<void> }, 'unpackInto');
    unpack.mockImplementation(async (dir: string) => {
      await nodeFs.mkdir(join(dir, 'project'), { recursive: true });
      await nodeFs.writeFile(join(dir, 'project', 'half.txt'), 'half');
      throw new Error('unpacking failed');
    });
    expect((await archive.refresh()).status).toBe('failed');
    unpack.mockRestore();
    const clean = async () => {
      expect(await snapshot(archive.workDir)).toEqual(before);
      expect(await nodeFs.readdir(work)).toEqual([archive.sessionDir.slice(work.length + 1), `${archive.sessionDir.slice(work.length + 1)}.session.json`].sort());
      expect(JSON.parse(await nodeFs.readFile(`${archive.sessionDir}.session.json`, 'utf-8')).pending).toBeUndefined();
    };
    await clean();

    hooks.before.rename = (from, to) => {
      if (from === archive.sessionDir && String(to).endsWith('.previous')) throw fault();
    };
    expect((await archive.refresh()).status).toBe('failed');
    await clean();
    delete hooks.before.rename;
    expect((await archive.refresh()).status).toBe('refreshed');
  });

  it('a refresh whose new folder cannot be moved in puts the old one back', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    const before = await snapshot(archive.workDir);
    await writeArchive(variant('replaced'));
    hooks.before.rename = (from, to) => {
      if (to === archive.sessionDir && from.includes('.next-')) throw fault();
    };
    expect((await archive.refresh()).status).toBe('failed');
    expect(await snapshot(archive.workDir)).toEqual(before);
    const names = await nodeFs.readdir(work);
    expect(names.filter(name => name.includes('.next-') || name.endsWith('.previous'))).toEqual([]);
    expect(archive.status().stopped).toBeUndefined();
  });

  it('a session folder that cannot be put back stops the archive and names where the files are', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await writeArchive(variant('replaced'));
    const previous = `${archive.sessionDir}.previous`;
    hooks.before.rename = (_from, to) => {
      if (to === archive.sessionDir) throw fault();
    };
    const result = await archive.refresh();
    expect(result.status).toBe('failed');
    expect(result.reason).toContain(previous);
    expect(archive.status().stopped).toContain(previous);
    delete hooks.before.rename;
    const archiveBytes = await bytesAt(archivePath);
    for (const later of [await archive.refresh(), await archive.sync()]) {
      expect(later.status).toBe('failed');
      expect(later.reason).toContain(previous);
    }
    expect(await bytesAt(archivePath)).toEqual(archiveBytes);
    const closed = await archive.close();
    expect(closed.kept).toBe(previous);
    expect(await exists(previous)).toBe(true);
    expect(await exists(`${archive.sessionDir}.session.json`)).toBe(true);
  });

  it('a refresh published with a leftover old folder keeps its baseline', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await writeArchive(variant('replaced'));
    const previous = `${archive.sessionDir}.previous`;
    hooks.before.rm = async path => {
      if (path === previous && await exists(previous)) throw fault();
    };
    const result = await archive.refresh();
    expect(result.status).toBe('refreshed');
    expect(result.notes?.join(' ')).toContain(previous);
    expect((await archive.sync()).status).toBe('unchanged');

    const markerPath = `${archive.sessionDir}.session.json`;
    const marker = JSON.parse(await nodeFs.readFile(markerPath, 'utf-8'));
    expect(marker.pending).toBeUndefined();
    await nodeFs.writeFile(markerPath, JSON.stringify({ ...marker, pid: 0x7fffffff }));
    const left = await findLeftWorkFolders(work);
    expect(left).toHaveLength(1);
    expect(left[0].leftovers).toContain(previous);

    delete hooks.before.rm;
    await writeArchive(variant('replaced a second time'));
    expect((await archive.refresh()).status).toBe('refreshed');
    expect(await exists(previous)).toBe(false);
  });
});

describe('an archive that is missing or cannot be read', () => {
  it('tells a missing archive from a conflict: after a folder change, sync finds it gone', async () => {
    const archive = await openArchive();
    await changeFolder(archive);
    await nodeFs.rm(archivePath);
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('no longer exists');
    expect(await exists(archivePath)).toBe(false);
  });

  it('tells a missing archive from a conflict: refresh with no folder change fails, with one it conflicts', async () => {
    const archive = await openArchive();
    await nodeFs.rm(archivePath);
    const gone = await archive.refresh();
    expect(gone.status).toBe('failed');
    expect(gone.reason).toContain('no longer exists');
    await changeFolder(archive);
    expect((await archive.refresh()).status).toBe('conflict');
  });

  it('tells an archive it cannot read from a conflict', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    hooks.before.stat = path => {
      if (path === resolve(archivePath)) throw fault('EACCES');
    };
    const refresh = await archive.refresh();
    expect(refresh.status).toBe('failed');
    expect(refresh.reason).toContain('EACCES');
    await changeFolder(archive);
    const sync = await archive.sync();
    expect(sync.status).toBe('failed');
    expect(sync.reason).toContain('EACCES');
    expect(archive.status().conflict).toBeUndefined();
    delete hooks.before.stat;
    expect((await archive.sync()).status).toBe('saved');
  });

  it('reports a refresh it could not read, and tries again at the next call', async () => {
    const archive = await openArchive();
    const before = await snapshot(archive.workDir);
    const whole = zipBuffer(variant('whole archive'));
    await nodeFs.writeFile(archivePath, whole.subarray(0, Math.floor(whole.length / 2)));
    expect((await archive.refresh()).status).toBe('failed');
    expect(await snapshot(archive.workDir)).toEqual(before);
    await nodeFs.writeFile(archivePath, whole);
    expect((await archive.refresh()).status).toBe('refreshed');
    expect(await nodeFs.readFile(mainPath(archive), 'utf-8')).toBe('{"events":["whole archive"]}');
  });
});

describe('what counts as a change in the folder', () => {
  /** Open, put the event sheet on a whole second and write back once, so a same-size edit can restore that time. */
  async function sameSizeEdit(recentMs: number) {
    const archive = await openArchive({ recentMs });
    await nodeFs.utimes(mainPath(archive), SECOND, SECOND);
    expect((await archive.sync()).status).toBe('saved');
    await nodeFs.writeFile(mainPath(archive), '{"events":{}}');
    await nodeFs.utimes(mainPath(archive), SECOND, SECOND);
    return { archive, result: await archive.sync() };
  }

  it('sees a same-size change within one timestamp tick through the content hash', async () => {
    const { result } = await sameSizeEdit(Number.POSITIVE_INFINITY);
    expect(result.status).toBe('saved');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from('{"events":{}}').toString('base64'));
  });

  it('does not see it without the hash, which is the stamp\'s limit', async () => {
    const { result } = await sameSizeEdit(0);
    expect(result.status).toBe('unchanged');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(MAIN.toString('base64'));
  });
});

describe('placing the archive when the file system or a save interferes', () => {
  it('places the archive by copy whatever code a file system without hard links reports', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    hooks.before.link = () => {
      throw fault('EISDIR');
    };
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    expect((await archive.sync()).status).toBe('saved');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from(CHANGED).toString('base64'));
    expect(await bytesAt(`${archivePath}.bak`)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p', 'game.c3p.bak']);
  });

  it('says where the archive is when it can be neither placed nor put back, and names no file that was removed', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    hooks.before.link = () => {
      throw fault('EIO');
    };
    hooks.before.copyFileExclusive = () => {
      throw fault('EIO');
    };
    const result = await archive.sync();
    const previous = (await rootNames()).filter(name => name.endsWith('.previous'));
    expect(previous).toHaveLength(1);
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('could not be put in place');
    expect(result.reason).toContain('could not be put back');
    expect(result.reason).toContain(previous[0]);
    expect(result.reason).not.toContain('.tmp');
    expect(await exists(archivePath)).toBe(false);
    expect(await bytesAt(join(root, previous[0]))).toEqual(original);
    expect((await rootNames()).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await archive.sync()).status).toBe('conflict');
    const text = describeArchiveSync(archive, result);
    expect(text).not.toContain('The next tool call writes it back again');
  });

  it('says only what happened when the file moved aside was not the session\'s own and cannot be put back', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    const saveA = zipBuffer(variant('save A'));
    afterBuild(archive, () => nodeFs.writeFile(archivePath, saveA));
    hooks.before.link = (existing) => {
      if (existing.endsWith('.previous')) throw fault('EIO');
    };
    hooks.before.copyFileExclusive = (from) => {
      if (from.endsWith('.previous')) throw fault('EIO');
    };
    const result = await archive.sync();
    const previous = (await rootNames()).filter(name => name.endsWith('.previous'));
    expect(previous).toHaveLength(1);
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('could not be put back');
    expect(result.reason).toContain(previous[0]);
    expect(result.reason).not.toContain('newer save is at its path');
    expect(await exists(archivePath)).toBe(false);
    expect(await bytesAt(join(root, previous[0]))).toEqual(saveA);
    expect(JSON.parse(await nodeFs.readFile(`${archive.sessionDir}.session.json`, 'utf-8')).pending).toEqual({ previousArchive: join(root, previous[0]) });
  });

  it('reports an archive that vanished before it could be moved aside as missing', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    hooks.before.rename = from => {
      if (from === resolve(archivePath)) throw fault('ENOENT');
    };
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('no longer exists');
    expect(await bytesAt(archivePath)).toEqual(original);
    expect((await rootNames()).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await archive.sync()).status).toBe('conflict');
  });

  it('puts the archive back unchanged when what was moved aside cannot be read', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    hooks.before.readFile = path => {
      if (path.endsWith('.previous')) throw fault('EIO');
    };
    const result = await archive.sync();
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('could not be read after it was moved aside');
    expect(await bytesAt(archivePath)).toEqual(original);
    expect(await rootNames()).toEqual(['game.c3p']);
    delete hooks.before.readFile;
    expect((await archive.sync()).status).toBe('saved');
  });

  it('keeps both files when placing the new archive fails and a save arrives before the old one is put back', async () => {
    const original = await bytesAt(archivePath);
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    const saveB = zipBuffer(variant('save B'));
    hooks.before.link = async (existing) => {
      if (existing.endsWith('.tmp')) throw fault('EIO');
      await nodeFs.writeFile(archivePath, saveB);
    };
    hooks.before.copyFileExclusive = (from) => {
      if (from.endsWith('.tmp')) throw fault('EIO');
    };
    const result = await archive.sync();
    const previous = (await rootNames()).filter(name => name.endsWith('.previous'));
    expect(previous).toHaveLength(1);
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain(previous[0]);
    expect(result.reason).toContain('while this server was writing it back; its version before that is in');
    expect(await bytesAt(archivePath)).toEqual(saveB);
    expect(await bytesAt(join(root, previous[0]))).toEqual(original);
  });

  it('reports an archive that vanished right after the write-back', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    hooks.after.link = async (existing) => {
      if (existing.endsWith('.tmp')) await nodeFs.rm(archivePath);
    };
    const result = await archive.sync();
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('no longer exists right after this server wrote it back');
    expect((await archive.sync()).status).toBe('conflict');
  });

  it('never replaces a backup that is already there', async () => {
    const original = await bytesAt(archivePath);
    await nodeFs.writeFile(`${archivePath}.bak`, 'USER BACKUP');
    const archive = await openArchive();
    await changeFolder(archive);
    const result = await archive.sync();
    expect(result.status).toBe('saved');
    expect(result.notes?.join(' ')).toContain('already existed and was not replaced');
    expect(await nodeFs.readFile(`${archivePath}.bak`, 'utf-8')).toBe('USER BACKUP');
    const second = (await rootNames()).filter(name => name.endsWith('.bak') && name !== 'game.c3p.bak');
    expect(second).toHaveLength(1);
    expect(await bytesAt(join(root, second[0]))).toEqual(original);
    expect((await rootNames()).filter(name => name.endsWith('.previous'))).toEqual([]);
  });
});

describe('a refresh whose baseline cannot be recorded', () => {
  it('reports the refresh as done and writes the folder back at the next sync', async () => {
    const archive = await openArchive();
    await writeArchive(variant('replaced'));
    const target = archive as unknown as { folderStamp: (...a: unknown[]) => Promise<Map<string, string>> };
    const original = target.folderStamp.bind(archive);
    let calls = 0;
    const spy = vi.spyOn(target, 'folderStamp').mockImplementation(async (...args: unknown[]) => {
      calls++;
      if (calls === 2) throw new Error('stat failed');
      return original(...args);
    });
    const result = await archive.refresh();
    expect(result.status).toBe('refreshed');
    expect(result.notes?.join(' ')).toContain('could not be recorded');
    expect(await nodeFs.readFile(mainPath(archive), 'utf-8')).toBe('{"events":["replaced"]}');
    spy.mockRestore();
    expect((await archive.sync()).status).toBe('saved');
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from('{"events":["replaced"]}').toString('base64'));
  });
});

describe('closing', () => {
  it('keeps the working folder when the archive no longer exists', async () => {
    const archive = await openArchive();
    await nodeFs.rm(archivePath);
    const closed = await archive.close();
    expect(closed.kept).toBe(archive.workDir);
    expect(closed.sync.status).toBe('conflict');
    expect(closed.sync.reason).toContain('no longer exists');
    expect(await exists(mainPath(archive))).toBe(true);
    expect(await exists(archivePath)).toBe(false);
  });

  it('writes back and removes the session folder, or keeps it', async () => {
    const archive = await openArchive();
    await changeFolder(archive);
    const closed = await archive.close();
    expect(closed.sync.status).toBe('saved');
    expect(closed.kept).toBeUndefined();
    expect(await exists(archive.sessionDir)).toBe(false);
    expect(await exists(`${archive.sessionDir}.session.json`)).toBe(false);

    const { hooks, fs } = hookedFs();
    const second = await openArchive({ fs });
    await changeFolder(second);
    hooks.before.writeFile = path => {
      if (path.endsWith('.tmp')) throw fault();
    };
    const kept = await second.close();
    expect(kept.kept).toBe(second.workDir);
    expect(kept.sync.status).toBe('failed');
    expect(await exists(second.workDir)).toBe(true);
    expect(await exists(`${second.sessionDir}.session.json`)).toBe(true);
  });

  it('reports a saved project whose working folder could not be removed as saved', async () => {
    const { hooks, fs } = hookedFs();
    const archive = await openArchive({ fs });
    await changeFolder(archive);
    hooks.before.rm = path => {
      if (path === archive.sessionDir) throw fault();
    };
    const closed = await archive.close();
    expect(closed.sync.status).toBe('saved');
    expect(closed.sync.notes?.join(' ')).toContain('could not be removed');
    expect(closed.sync.notes?.join(' ')).toContain(archive.sessionDir);
    expect(closed.kept).toBe(archive.workDir);
    expect(await exists(`${archive.sessionDir}.session.json`)).toBe(true);
    expect((await archiveFiles()).get('eventSheets/Main.json')).toBe(Buffer.from(CHANGED).toString('base64'));
  });
});

describe('sessions a killed process left', () => {
  it('names sessions a killed process left, with their leftovers', async () => {
    const staging = join(root, 'game.c3p.1.1.tmp');
    const previousArchive = join(root, 'game.c3p.1.1.previous');
    await nodeFs.mkdir(join(work, 'c3p-old', 'project'), { recursive: true });
    await nodeFs.mkdir(join(work, 'c3p-old.previous'));
    await nodeFs.writeFile(join(work, 'c3p-old.session.json'), JSON.stringify({
      pid: 0x7fffffff,
      archive: join(root, 'game.c3p'),
      pending: { staging, previousArchive },
    }));
    const live = await openArchive();
    const left = await findLeftWorkFolders(work);
    expect(left).toHaveLength(1);
    expect(left[0].sessionDir).toBe(join(work, 'c3p-old'));
    expect(left[0].archivePath).toBe(join(root, 'game.c3p'));
    expect([...left[0].leftovers].sort()).toEqual([join(work, 'c3p-old.previous'), previousArchive, staging].sort());
    expect(left.some(session => session.sessionDir === live.sessionDir)).toBe(false);
  });

  it('names nothing in a folder that does not exist', async () => {
    expect(await findLeftWorkFolders(join(root, 'missing'))).toEqual([]);
  });
});

describe('describing a result', () => {
  const archive = { archivePath: 'game.c3p', workDir: join('w', 'project') };

  it('describes a write-back', () => {
    expect(describeArchiveSync(archive, { status: 'unchanged' })).toBeUndefined();
    const saved = describeArchiveSync(archive, { status: 'saved', fileCount: 3, notes: ['one note', 'another note'] });
    expect(saved).toContain('"game.c3p"');
    expect(saved).toContain('3 files');
    expect(saved).toContain('one note');
    expect(saved).toContain('another note');
    const conflict = describeArchiveSync(archive, { status: 'conflict', reason: 'it was changed on disk' });
    expect(conflict).toContain('NOT saved');
    expect(conflict).toContain('"game.c3p"');
    expect(conflict).toContain('it was changed on disk');
    expect(conflict).toContain(archive.workDir);
    expect(conflict).toContain('restart the server to load the archive as it is now');
    const failed = describeArchiveSync(archive, { status: 'failed', reason: 'the disk is full' });
    expect(failed).toContain('NOT saved');
    expect(failed).toContain('the disk is full');
    expect(failed).toContain('The next tool call writes it back again.');
    const stopped = describeArchiveSync(archive, { status: 'failed', reason: 'it stopped', stopped: true });
    expect(stopped).toContain('Restart the server');
    expect(stopped).not.toContain('The next tool call');
    const reworded = describeArchiveSync(archive, { status: 'failed', reason: 'the working folder could not be put back after a failed refresh (x)' });
    expect(reworded).toContain('The next tool call writes it back again.');
  });

  it('describes a refresh', () => {
    expect(describeArchiveRefresh(archive, { status: 'unchanged' })).toBeUndefined();
    const refreshed = describeArchiveRefresh(archive, { status: 'refreshed', notes: ['a leftover folder'] });
    expect(refreshed).toContain('the project was read again from it');
    expect(refreshed).toContain('a leftover folder');
    const failed = describeArchiveRefresh(archive, { status: 'failed', reason: 'truncated' });
    expect(failed).toContain('changed on disk and could not be read again');
    expect(failed).toContain('Nothing was run.');
    expect(failed).toContain('Try the call again.');
    const conflict = describeArchiveRefresh(archive, { status: 'conflict', reason: 'it was changed on disk' });
    expect(conflict).toContain('NOT saved');
    expect(conflict).toContain('it was changed on disk');
    const stopped = describeArchiveRefresh(archive, { status: 'failed', reason: 'it stopped', stopped: true });
    expect(stopped).toContain('Nothing was run: it stopped.');
    expect(stopped).toContain('Restart the server');
    expect(describeArchiveRefresh(archive, { status: 'failed', reason: 'the working folder could not be put back' })).toContain('Try the call again.');
  });
});
