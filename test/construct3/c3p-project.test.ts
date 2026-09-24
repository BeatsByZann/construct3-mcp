/**
 * Opening a .c3p archive through a working folder, and writing it back after
 * each tool call without ever overwriting a newer archive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { C3pProject, isC3pPath, syncAfterEveryTool } from '../../src/construct3/c3p-project.js';
import { collectProjectFiles } from '../../src/runtime/project-files.js';
import { readZip } from '../../src/runtime/zip-reader.js';
import { buildZip } from '../../src/runtime/zip-writer.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let root: string;
let workRoot: string;
let archivePath: string;
const opened: C3pProject[] = [];

/** The fixture project packed as Construct packs it: compressed, project.c3proj at the root. */
async function fixtureArchive(): Promise<Buffer> {
  const files = await collectProjectFiles(FIXTURE_DIR);
  return buildZip(await Promise.all(files.map(async path => ({ path, data: await readFile(join(FIXTURE_DIR, path)) }))), { compress: true });
}

async function open(): Promise<C3pProject> {
  const project = await C3pProject.open(archivePath, workRoot);
  opened.push(project);
  return project;
}

/** The archive's files as a path -> text map. */
async function archiveFiles(path = archivePath): Promise<Record<string, string>> {
  return Object.fromEntries(readZip(await readFile(path)).map(e => [e.path, e.data.toString('utf-8')]));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'c3p-test-'));
  workRoot = join(root, 'work');
  await import('node:fs/promises').then(fs => fs.mkdir(workRoot));
  archivePath = join(root, 'Game.c3p');
  await writeFile(archivePath, await fixtureArchive());
});

afterEach(async () => {
  for (const project of opened.splice(0)) project.closeSync();
  await rm(root, { recursive: true, force: true });
});

describe('isC3pPath', () => {
  it('matches .c3p in any case and nothing else', () => {
    expect(isC3pPath('C:/games/Game.c3p')).toBe(true);
    expect(isC3pPath('Game.C3P')).toBe(true);
    expect(isC3pPath('Game/project.c3proj')).toBe(false);
    expect(isC3pPath('Game.c3p.bak')).toBe(false);
  });
});

describe('C3pProject.open', () => {
  it('unpacks every file into a working folder the reader loads', async () => {
    const project = await open();
    expect(relative(workRoot, project.workDir).startsWith('c3p-')).toBe(true);
    expect((await collectProjectFiles(project.workDir)).sort()).toEqual((await collectProjectFiles(FIXTURE_DIR)).sort());
    const reader = new Construct3ProjectReader(project.projectFile);
    await reader.loadProject();
    expect(reader.getProjectDir()).toBe(project.workDir);
    expect(reader.getMetadata().name).toBeTruthy();
  });

  it('refuses an archive without project.c3proj at its root and leaves no working folder', async () => {
    await writeFile(archivePath, buildZip([{ path: 'Game/project.c3proj', data: Buffer.from('{}') }]));
    await expect(open()).rejects.toThrow(/no project\.c3proj at its root/);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('refuses a damaged or unsafe archive and leaves no working folder', async () => {
    await writeFile(archivePath, Buffer.from('not a zip'));
    await expect(open()).rejects.toThrow(/Cannot read .* as a \.c3p archive/);
    await writeFile(archivePath, buildZip([
      { path: 'project.c3proj', data: Buffer.from('{}') },
      { path: '../escaped.txt', data: Buffer.from('x') },
    ]));
    await expect(open()).rejects.toThrow(/leaves the archive folder/);
    expect(await readdir(workRoot)).toEqual([]);
    expect(existsSync(join(workRoot, '..', 'escaped.txt'))).toBe(false);
  });

  it('removes the half-unpacked working folder when unpacking fails', async () => {
    // "files" is both a file and a folder, so the second entry cannot be written.
    await writeFile(archivePath, buildZip([
      { path: 'project.c3proj', data: Buffer.from('{}') },
      { path: 'files', data: Buffer.from('x') },
      { path: 'files/data.json', data: Buffer.from('{}') },
    ]));
    await expect(open()).rejects.toThrow();
    expect(await readdir(workRoot)).toEqual([]);
  });
});

describe('C3pProject.sync', () => {
  it('leaves the archive alone when nothing changed', async () => {
    const project = await open();
    const before = await stat(archivePath);
    expect(await project.sync()).toEqual({ status: 'unchanged' });
    expect((await stat(archivePath)).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(`${archivePath}.bak`)).toBe(false);
  });

  it('writes a changed, added or removed file back, keeping the opened archive once as .bak', async () => {
    const original = await readFile(archivePath);
    const project = await open();
    await writeFile(join(project.workDir, 'eventSheets', 'MainSheet.json'), '{"changed":1}');
    await writeFile(join(project.workDir, 'layouts', 'New.json'), '{}');
    expect(await project.sync()).toEqual({ status: 'saved', fileCount: 5 });
    let files = await archiveFiles();
    expect(files['eventSheets/MainSheet.json']).toBe('{"changed":1}');
    expect(files['layouts/New.json']).toBe('{}');
    expect(await readFile(`${archivePath}.bak`)).toEqual(original);

    await unlink(join(project.workDir, 'layouts', 'New.json'));
    expect((await project.sync()).status).toBe('saved');
    files = await archiveFiles();
    expect(files['layouts/New.json']).toBeUndefined();
    // The backup is still the archive as it was opened, not the first save.
    expect(await readFile(`${archivePath}.bak`)).toEqual(original);
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('neither packs nor reacts to the writer\'s .bak files', async () => {
    const project = await open();
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json.bak'), '{}');
    expect(await project.sync()).toEqual({ status: 'unchanged' });
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":1}');
    expect((await project.sync()).status).toBe('saved');
    expect(Object.keys(await archiveFiles()).some(path => path.endsWith('.bak'))).toBe(false);
  });

  it('refuses to overwrite an archive something else saved, and keeps the working folder', async () => {
    const project = await open();
    const construct = buildZip([{ path: 'project.c3proj', data: Buffer.from('{"saved":"by Construct"}') }]);
    await writeFile(archivePath, construct);
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":1}');
    const sync = await project.sync();
    expect(sync.status).toBe('conflict');
    expect(sync.reason).toMatch(/changed by something else/);
    expect(await readFile(archivePath)).toEqual(construct);
    // Every later write is refused too, not only the first.
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":2}');
    expect((await project.sync()).status).toBe('conflict');
    expect(await readFile(archivePath)).toEqual(construct);
    // Putting the old archive back does not end the conflict: the server
    // has not loaded whatever happened in between.
    await writeFile(archivePath, await fixtureArchive());
    expect((await project.sync()).status).toBe('conflict');
    expect(project.closeSync()).toBe(project.workDir);
    expect(existsSync(join(project.workDir, 'layouts', 'Layout 1.json'))).toBe(true);
  });

  it('refuses a conflict found after an earlier save of its own', async () => {
    const project = await open();
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":1}');
    expect((await project.sync()).status).toBe('saved');
    const construct = buildZip([{ path: 'project.c3proj', data: Buffer.from('{}') }]);
    await writeFile(archivePath, construct);
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":2}');
    expect((await project.sync()).status).toBe('conflict');
    expect(await readFile(archivePath)).toEqual(construct);
  });

  it('tells two writes of the same size within one time stamp apart', async () => {
    const project = await open();
    const file = join(project.workDir, 'layouts', 'Layout 1.json');
    await writeFile(file, '{"a":1}');
    expect((await project.sync()).status).toBe('saved');
    const same = await stat(file);
    await writeFile(file, '{"a":2}');
    await utimes(file, same.atime, same.mtime); // the same second write a file system may give it
    expect((await project.sync()).status).toBe('saved');
    expect(JSON.parse(readZip(await readFile(archivePath)).find(e => e.path === 'layouts/Layout 1.json')!.data.toString('utf-8'))).toEqual({ a: 2 });
  });

  it('treats a new time stamp on the same content as no change', async () => {
    const project = await open();
    const later = new Date(Date.now() + 60_000);
    await utimes(archivePath, later, later);
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":1}');
    expect((await project.sync()).status).toBe('saved');
  });

  it('reports a deleted archive as a conflict rather than recreating it', async () => {
    const project = await open();
    await unlink(archivePath);
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":1}');
    const sync = await project.sync();
    expect(sync).toEqual({ status: 'conflict', reason: `"${archivePath}" no longer exists` });
    expect(existsSync(archivePath)).toBe(false);
  });

  it('reports a failed write and tries again on the next change', async () => {
    const project = await open();
    await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"a":1}');
    // A folder where the backup file must go makes the first write fail.
    await import('node:fs/promises').then(fs => fs.mkdir(`${archivePath}.bak`));
    const failed = await project.sync();
    expect(failed.status).toBe('failed');
    expect(await readFile(archivePath)).toEqual(await fixtureArchive());
    // Closing now would lose the change, so the working folder is kept.
    expect(project.closeSync()).toBe(project.workDir);
    expect(existsSync(project.workDir)).toBe(true);
    await rm(`${archivePath}.bak`, { recursive: true });
    expect((await project.sync()).status).toBe('saved');
    expect((await archiveFiles())['layouts/Layout 1.json']).toBe('{"a":1}');
    expect(project.closeSync()).toBeUndefined();
  });

  it('packs a file again after each change, and never an older version of it', async () => {
    const project = await open();
    const layout = join(project.workDir, 'layouts', 'Layout 1.json');
    for (const text of ['{"v":1}', '{"v":22}', '{"v":3}']) {
      await writeFile(layout, text);
      expect((await project.sync()).status).toBe('saved');
      expect((await archiveFiles())['layouts/Layout 1.json']).toBe(text);
    }
    // Files that did not change keep their content through every write.
    const files = await archiveFiles();
    expect(files['eventSheets/MainSheet.json']).toBe(await readFile(join(FIXTURE_DIR, 'eventSheets', 'MainSheet.json'), 'utf-8'));
  });

  it('removes the working folder on close when the archive holds every change', async () => {
    const project = await open();
    expect(project.closeSync()).toBeUndefined();
    expect(existsSync(project.workDir)).toBe(false);
  });
});

describe('syncAfterEveryTool', () => {
  function parse(result: { content: Array<{ type: string; text: string }> }) {
    return JSON.parse(result.content[0].text);
  }

  async function serve() {
    resetProjectIndex();
    const project = await open();
    const reader = new Construct3ProjectReader(project.projectFile);
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const server = new MockServer();
    syncAfterEveryTool(server as any, project);
    registerLayoutTools({ server, reader, writer, idGen } as any);
    return { project, server };
  }

  it('writes a real tool\'s change into the archive and says so, and adds nothing to a call that changed nothing', async () => {
    const { server } = await serve();
    const before = await readFile(archivePath);
    const refused = await server.callTool('delete_layer', { layoutName: 'Layout 1', layerName: 'No such layer' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toHaveLength(1);
    expect(await readFile(archivePath)).toEqual(before);

    const added = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'Top' });
    expect(parse(added).success).toBe(true);
    expect(added.content).toHaveLength(3);
    expect(added.content[1].text).toBe('Changed 1 file(s): layouts/Layout 1.json (1 with a .bak backup; revert_last_change undoes this call).');
    expect(added.content[2].text).toBe(`Saved the project to "${archivePath}" (4 files).`);
    const layout = JSON.parse((await archiveFiles())['layouts/Layout 1.json']);
    expect(layout.layers.map((l: any) => l.name)).toContain('Top');
  });

  it('tells the caller when the archive was not saved', async () => {
    const { project, server } = await serve();
    await writeFile(archivePath, buildZip([{ path: 'project.c3proj', data: Buffer.from('{}') }]));
    const added = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'Top' });
    expect(added.content[2].text).toMatch(/^The project was NOT saved to .*changed by something else.*working folder/);
    expect(added.content[2].text).toContain(project.workDir);
  });

  it('writes once after overlapping calls finish, and holds new calls until the write is done', async () => {
    const project = await open();
    const server = new MockServer();
    syncAfterEveryTool(server as any, project);
    const order: string[] = [];
    const sync = vi.spyOn(project, 'sync');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    server.tool('slow', '', {}, async () => {
      await gate;
      order.push('slow');
      return { content: [{ type: 'text', text: '{}' }] };
    });
    server.tool('fast', '', {}, async () => {
      await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"fast":1}');
      order.push('fast');
      return { content: [{ type: 'text', text: '{}' }] };
    });
    const slow = server.callTool('slow');
    const fast = await server.callTool('fast');
    expect(sync).not.toHaveBeenCalled();
    expect(fast.content).toHaveLength(1);
    release();
    const slowResult = await slow;
    expect(sync).toHaveBeenCalledTimes(1);
    expect(slowResult.content.at(-1)!.text).toMatch(/^Saved the project/);
    expect(order).toEqual(['fast', 'slow']);

    // A call that starts while a write is under way runs after it.
    let finishWrite!: () => void;
    sync.mockImplementationOnce(() => new Promise(r => { finishWrite = () => r({ status: 'unchanged' }); }));
    const first = server.callTool('fast');
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    const second = server.callTool('fast');
    await new Promise(r => setTimeout(r, 20));
    expect(order).toEqual(['fast', 'slow', 'fast']);
    finishWrite();
    await first;
    await second;
    expect(order).toEqual(['fast', 'slow', 'fast', 'fast']);
  });

  it('still writes the archive when a tool throws, then passes the error on', async () => {
    const project = await open();
    const server = new MockServer();
    syncAfterEveryTool(server as any, project);
    server.tool('half', '', {}, async () => {
      await writeFile(join(project.workDir, 'layouts', 'Layout 1.json'), '{"half":1}');
      throw new Error('stopped halfway');
    });
    await expect(server.callTool('half')).rejects.toThrow('stopped halfway');
    expect((await archiveFiles())['layouts/Layout 1.json']).toBe('{"half":1}');
  });
});
