import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectSource, startC3pSession } from '../../src/construct3/project-source.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { zipBuffer, type ZipEntry } from '../../src/runtime/zip-writer.js';
import { MockServer } from '../mocks/mock-server.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let root: string;
let workRoot: string;

/** The entries of a loadable archive: the fixture project's files. */
async function fixtureEntries(): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const path of ['project.c3proj', 'eventSheets/MainSheet.json', 'layouts/Layout 1.json', 'objectTypes/Sprite.json']) {
    entries.push({ path, data: await nodeFs.readFile(join(FIXTURE_DIR, ...path.split('/'))) });
  }
  return entries;
}

/** What the work root holds that a session leaves: its folders and markers. */
async function sessionLeftovers(): Promise<string[]> {
  return (await nodeFs.readdir(workRoot)).filter(name => name.startsWith('c3p-'));
}

beforeEach(async () => {
  root = await nodeFs.mkdtemp(join(tmpdir(), 'c3-source-'));
  workRoot = join(root, 'work');
  await nodeFs.mkdir(workRoot);
});

afterEach(async () => {
  await nodeFs.rm(root, { recursive: true, force: true });
});

describe('openProjectSource', () => {
  it('uses a folder as it is, with no archive', async () => {
    const source = await openProjectSource(FIXTURE_DIR, { workRoot });
    expect(source).toEqual({ projectPath: FIXTURE_DIR });
    expect(await sessionLeftovers()).toEqual([]);
  });

  it('uses a .c3proj file as it is, with no archive', async () => {
    const file = join(FIXTURE_DIR, 'project.c3proj');
    const source = await openProjectSource(file, { workRoot });
    expect(source).toEqual({ projectPath: file });
  });

  it.each(['game.c3p', 'GAME.C3P'])('opens %s through a working folder whose project file it returns', async (name) => {
    const archivePath = join(root, name);
    await nodeFs.writeFile(archivePath, zipBuffer(await fixtureEntries()));
    const source = await openProjectSource(archivePath, { workRoot });
    try {
      expect(source.archive).toBeDefined();
      expect(source.projectPath).toBe(source.archive!.projectFile);
      const reader = new Construct3ProjectReader(source.projectPath);
      await reader.loadProject();
      expect(reader.getMetadata().name).toBe('TestProject');
    } finally {
      await source.archive?.close();
    }
  });

  it('rejects a .c3p that is not an archive and leaves no session folder', async () => {
    const archivePath = join(root, 'broken.c3p');
    await nodeFs.writeFile(archivePath, Buffer.from('this is not a zip archive at all'));
    await expect(openProjectSource(archivePath, { workRoot })).rejects.toThrow();
    expect(await sessionLeftovers()).toEqual([]);
  });
});

describe('startC3pSession', () => {
  it('returns what start returns, leaving the working folder to the caller', async () => {
    const archivePath = join(root, 'game.c3p');
    await nodeFs.writeFile(archivePath, zipBuffer(await fixtureEntries()));
    const archive = await startC3pSession(archivePath, async (_projectPath, opened) => opened, { workRoot });
    try {
      expect(archive).toBeDefined();
      expect((await sessionLeftovers()).length).toBeGreaterThan(0);
    } finally {
      await archive?.close();
    }
  });

  it('passes a folder project with no archive', async () => {
    const seen = await startC3pSession(FIXTURE_DIR, async (projectPath, archive) => ({ projectPath, archive }), { workRoot });
    expect(seen).toEqual({ projectPath: FIXTURE_DIR, archive: undefined });
  });

  describe('removes the working folder when the start fails', () => {
    it('when the project cannot be loaded', async () => {
      const archivePath = join(root, 'bad.c3p');
      await nodeFs.writeFile(archivePath, zipBuffer([{ path: 'project.c3proj', data: Buffer.from('{ "name": "T" }') }]));
      await expect(startC3pSession(archivePath, async (projectPath) => {
        const reader = new Construct3ProjectReader(projectPath);
        await reader.loadProject();
      }, { workRoot })).rejects.toThrow();
      expect(await sessionLeftovers()).toEqual([]);
    });

    it('when the transport fails after the project was loaded and a tool registered', async () => {
      const archivePath = join(root, 'game.c3p');
      await nodeFs.writeFile(archivePath, zipBuffer(await fixtureEntries()));
      const server = new MockServer();
      await expect(startC3pSession(archivePath, async (projectPath) => {
        const reader = new Construct3ProjectReader(projectPath);
        await reader.loadProject();
        server.tool('probe', 'probe', {}, async () => ({ content: [] }));
        throw new Error('connect failed');
      }, { workRoot })).rejects.toThrow('connect failed');
      expect(server.hasTool('probe')).toBe(true);
      expect(await sessionLeftovers()).toEqual([]);
    });
  });
});
