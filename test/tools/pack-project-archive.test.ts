/**
 * pack_project on a server that serves a single-file .c3p: it does not write
 * onto the open archive, its backups or its working folder, whatever the
 * letter case of the path, and says what the path is. A folder project, and
 * any other output path, are unaffected. Real archive, reader, writer and
 * tool handlers on a copy of the minimal fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { C3pArchive } from '../../src/construct3/c3p-archive.js';
import { withArchiveSync } from '../../src/tools/archive-sync.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { zipBuffer, type ZipEntry } from '../../src/runtime/zip-writer.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let root: string;
let archivePath: string;
let archive: C3pArchive;
let server: MockServer;
let close: (() => Promise<unknown>) | undefined;

async function fixtureEntries(sub = ''): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const entry of await nodeFs.readdir(sub ? join(FIXTURE_DIR, sub) : FIXTURE_DIR, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await fixtureEntries(rel));
    else out.push({ path: rel, data: await nodeFs.readFile(join(FIXTURE_DIR, ...rel.split('/'))) });
  }
  return out;
}

/** Every file below a folder with its content, for before and after comparisons. */
async function snapshot(dir: string, sub = ''): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const entry of await nodeFs.readdir(sub ? join(dir, sub) : dir, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await snapshot(dir, rel));
    else out.push([rel, (await nodeFs.readFile(join(dir, rel))).toString('base64')]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** Serve the real runtime tools for the open archive, or for a folder project when `withArchive` is false. */
async function start(withArchive: boolean): Promise<void> {
  archive = await C3pArchive.open(archivePath, { workRoot: join(root, 'work') });
  const reader = new Construct3ProjectReader(archive.projectFile);
  await reader.loadProject();
  const writer = new Construct3ProjectWriter(reader, new IdGenerator());
  server = new MockServer();
  const wrapped = withArchiveSync(server, archive);
  close = wrapped.close;
  registerRuntimeTools({ server: wrapped.server as never, reader, writer, ...(withArchive ? { archive } : {}) });
}

const pack = (outputPath: string, injectBridge = true) => server.callTool('pack_project', { outputPath, injectBridge });

beforeEach(async () => {
  root = await nodeFs.mkdtemp(join(tmpdir(), 'c3p-pack-'));
  await nodeFs.mkdir(join(root, 'work'));
  archivePath = join(root, 'game.c3p');
  await nodeFs.writeFile(archivePath, zipBuffer(await fixtureEntries()));
});

afterEach(async () => {
  await close?.();
  close = undefined;
  await nodeFs.rm(root, { recursive: true, force: true });
});

describe('pack_project on a served .c3p', () => {
  it.each([
    ['the archive', 'game.c3p', 'the open archive'],
    ['the archive in another letter case', 'GAME.C3P', 'the open archive'],
    ['the archive by a path with a parent segment', join('sub', '..', 'game.c3p'), 'the open archive'],
    ['its .bak', 'game.c3p.bak', 'a backup of the open archive'],
    ['its .bak in another letter case', 'Game.C3p.BAK', 'a backup of the open archive'],
    ['a numbered .bak', 'game.c3p.4242.7.bak', 'a backup of the open archive'],
  ])('refuses %s before writing anything', async (_label, name, what) => {
    await nodeFs.mkdir(join(root, 'sub'));
    await nodeFs.writeFile(join(root, 'game.c3p.bak'), 'the earlier version');
    await nodeFs.writeFile(join(root, 'game.c3p.4242.7.bak'), 'a later backup');
    await start(true);
    const archiveBefore = await nodeFs.readFile(archivePath);
    const rootBefore = await snapshot(root);
    const folderBefore = await snapshot(archive.sessionDir);

    const result = await pack(join(root, name));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(what);
    expect(result.content[0].text).toContain('Nothing was written');
    expect(await nodeFs.readFile(archivePath)).toEqual(archiveBefore);
    expect(await snapshot(root)).toEqual(rootBefore);
    expect(await snapshot(archive.sessionDir)).toEqual(folderBefore);
  });

  it('refuses a path inside the working folder or the held folder, and says what it is', async () => {
    await start(true);
    const folderBefore = await snapshot(archive.sessionDir);
    for (const where of [join(archive.workDir, 'out.c3p'), join(archive.workDir, 'files', 'out.c3p'), join(archive.sessionDir, 'held', 'out.c3p')]) {
      const result = await pack(where);
      expect(result.isError, where).toBe(true);
      expect(result.content[0].text, where).toContain('inside the server\'s working folder');
    }
    expect(await snapshot(archive.sessionDir)).toEqual(folderBefore);
  });

  it('names the output path and the archive as given', async () => {
    await start(true);
    const result = await pack(archivePath);
    expect(result.content[0].text).toContain(`"${archivePath}" is the open archive "${archivePath}"`);
  });

  it('packs to any other path, next to the archive too', async () => {
    await start(true);
    for (const name of ['packed.c3p', 'game.bak', 'game.c3p.old']) {
      const result = await pack(join(root, name), false);
      expect(JSON.parse(result.content[0].text).success, name).toBe(true);
      expect((await nodeFs.stat(join(root, name))).size, name).toBeGreaterThan(0);
    }
  });

  it('does not refuse any path on a folder project', async () => {
    await start(false);
    const target = join(root, 'game.c3p.bak');
    const result = await pack(target, false);
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect((await nodeFs.stat(target)).size).toBeGreaterThan(0);
  });
});
