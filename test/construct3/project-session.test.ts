/**
 * open_project: one running server switching between folder projects and
 * .c3p archives, with the tools it registered at start still working on
 * whichever project is open.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSession } from '../../src/construct3/project-session.js';
import { collectProjectFiles } from '../../src/runtime/project-files.js';
import { readZip } from '../../src/runtime/zip-reader.js';
import { buildZip } from '../../src/runtime/zip-writer.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerSessionTools } from '../../src/tools/session-tools.js';
import { registerUsageTools } from '../../src/tools/usage-tools.js';

const FIXTURES = join(__dirname, '..', 'fixtures');
/** Every object type of the rename fixture, subfolders included. */
const RENAME_OBJECTS = ['Enemy', 'Keyboard', 'Player', 'PlayerShip', 'Tiles'];

let root: string;
let folderProject: string;
let otherFolder: string;
let archivePath: string;
let workRoot: string;
const sessions: ProjectSession[] = [];

async function pack(dir: string): Promise<Buffer> {
  const files = await collectProjectFiles(dir);
  return buildZip(await Promise.all(files.map(async path => ({ path, data: await readFile(join(dir, path)) }))), { compress: true });
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** A server started on `startPath` with the layout, query and session tools, wired as index.ts wires them. */
async function serve(startPath: string) {
  resetProjectIndex();
  const session = await ProjectSession.start(startPath, { workRoot });
  sessions.push(session);
  const server = new MockServer();
  session.install(server as any);
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(session.reader, idGen);
  registerQueryTools(server as any, session.reader);
  registerLayoutTools({ server, reader: session.reader, writer, idGen } as any);
  registerSessionTools(server as any, session, idGen);
  registerUsageTools(server as any, session.reader);
  return { session, server };
}

async function objectNames(server: MockServer): Promise<string[]> {
  const listed = parse(await server.callTool('list_objects', {}));
  return listed.objects.map((o: any) => o.name ?? o).sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'c3-session-test-'));
  folderProject = join(root, 'Folder');
  otherFolder = join(root, 'Other');
  await cp(join(FIXTURES, 'minimal-project'), folderProject, { recursive: true });
  await cp(join(FIXTURES, 'rename-project'), otherFolder, { recursive: true });
  archivePath = join(root, 'Game.c3p');
  await writeFile(archivePath, await pack(join(FIXTURES, 'rename-project')));
  workRoot = join(root, 'work');
  await mkdir(workRoot);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.closeSync();
  await rm(root, { recursive: true, force: true });
});

describe('open_project', () => {
  it('switches a server started on a folder to a .c3p, and the tools edit the archive', async () => {
    const { server } = await serve(folderProject);
    expect(await objectNames(server)).toEqual(['Sprite']);
    expect(parse(await server.callTool('get_open_project', {}))).toMatchObject({ name: 'TestProject', format: 'folder' });

    const opened = parse(await server.callTool('open_project', { path: archivePath }));
    expect(opened.success).toBe(true);
    expect(opened.opened).toMatchObject({ name: 'RenameProject', format: 'c3p', archivePath });
    expect(opened.closed.name).toBe('TestProject');
    expect(await objectNames(server)).toEqual(RENAME_OBJECTS);

    const layouts = parse(await server.callTool('list_layouts', {}));
    const layoutName = (layouts.layouts ?? layouts)[0].name ?? (layouts.layouts ?? layouts)[0];
    const added = await server.callTool('add_layer', { layoutName, layerName: 'From Session' });
    expect(parse(added).success).toBe(true);
    expect(added.content.at(-1)!.text).toMatch(/^Saved the project to /);
    const entry = readZip(await readFile(archivePath)).find(e => e.path === `layouts/${layoutName}.json`)!;
    expect(JSON.parse(entry.data.toString('utf-8')).layers.map((l: any) => l.name)).toContain('From Session');
    // The folder project the server left is untouched.
    expect(await readFile(join(folderProject, 'project.c3proj'))).toEqual(await readFile(join(FIXTURES, 'minimal-project', 'project.c3proj')));
  });

  it('writes the archive it leaves, removes its working folder, and serves the next project', async () => {
    const { session, server } = await serve(archivePath);
    const workDir = session.archive!.workDir;
    // A change a tool made that is not yet in the archive is written on the way out.
    await writeFile(join(workDir, 'files-note.txt'), 'late');
    const opened = parse(await server.callTool('open_project', { path: otherFolder }));
    expect(opened.opened).toMatchObject({ name: 'RenameProject', format: 'folder' });
    expect(opened.warnings).toBeUndefined();
    expect(existsSync(workDir)).toBe(false);
    expect(readZip(await readFile(archivePath)).some(e => e.path === 'files-note.txt')).toBe(true);
    expect(parse(await server.callTool('get_open_project', {})).format).toBe('folder');
  });

  it('keeps serving the current project when the new one cannot be opened', async () => {
    const { server } = await serve(folderProject);
    const before = await readFile(archivePath);
    await writeFile(join(root, 'Broken.c3p'), Buffer.from('not a zip'));
    for (const path of [join(root, 'Broken.c3p'), join(root, 'missing-folder'), join(root, 'Missing.c3p')]) {
      const refused = await server.callTool('open_project', { path });
      expect(refused.isError, path).toBe(true);
      expect(refused.content[0].text).toMatch(/still serves the project it had/);
    }
    // An archive without a project file is refused after unpacking, and its working folder removed.
    await writeFile(join(root, 'NoProject.c3p'), buildZip([{ path: 'readme.txt', data: Buffer.from('x') }]));
    expect((await server.callTool('open_project', { path: join(root, 'NoProject.c3p') })).isError).toBe(true);
    expect(await objectNames(server)).toEqual(['Sprite']);
    expect(await readFile(archivePath)).toEqual(before);
  });

  it('reports and keeps the working folder of an archive it could not write before leaving', async () => {
    const { session, server } = await serve(archivePath);
    const workDir = session.archive!.workDir;
    await writeFile(archivePath, buildZip([{ path: 'project.c3proj', data: Buffer.from('{"saved":"by Construct"}') }]));
    await writeFile(join(workDir, 'files-note.txt'), 'unsaved');
    const opened = parse(await server.callTool('open_project', { path: folderProject }));
    expect(opened.success).toBe(true);
    expect(opened.warnings.join(' ')).toMatch(/was not written before leaving it: .*changed by something else/);
    expect(opened.warnings.join(' ')).toContain(workDir);
    expect(existsSync(join(workDir, 'files-note.txt'))).toBe(true);
    await rm(workDir, { recursive: true, force: true });
  });

  it('waits for a running call to finish before switching, and holds calls that arrive meanwhile', async () => {
    const { server } = await serve(folderProject);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    server.tool('slow_read', '', {}, async () => {
      await gate;
      order.push('slow read');
      return { content: [{ type: 'text', text: '{}' }] };
    });
    const slow = server.callTool('slow_read');
    const switching = server.callTool('open_project', { path: otherFolder }).then(r => { order.push('switched'); return r; });
    await new Promise(r => setTimeout(r, 30));
    const later = objectNames(server).then(names => { order.push('later call'); return names; });
    await new Promise(r => setTimeout(r, 30));
    expect(order).toEqual([]);
    release();
    await slow;
    expect(parse(await switching).success).toBe(true);
    // The call that arrived during the switch ran afterwards, on the new project.
    expect(await later).toEqual(RENAME_OBJECTS);
    expect(order).toEqual(['slow read', 'switched', 'later call']);
  });

  it('starts the server on a .c3p and back on its own archive again', async () => {
    const { session, server } = await serve(archivePath);
    const first = session.archive!.workDir;
    const reopened = parse(await server.callTool('open_project', { path: archivePath }));
    expect(reopened.opened.workDir).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(await objectNames(server)).toEqual(RENAME_OBJECTS);
  });

  it('drops the ID and index state of the project it left', async () => {
    const { server } = await serve(folderProject);
    // Build the index and mint UIDs on the first project without a write,
    // which would reset both anyway. Its only instance is UID 0.
    expect((await server.callTool('get_instance_counts', {})).content[0].text).toContain('Sprite');
    const preview = parse(await server.callTool('add_instances_to_layout', {
      layoutName: 'Layout 1', dryRun: true, instances: [{ layerName: 'Main', objectType: 'Sprite', x: 1, y: 1 }],
    }));
    expect(preview.dryRun ?? preview.success).toBeTruthy();

    await server.callTool('open_project', { path: otherFolder });
    const counts = (await server.callTool('get_instance_counts', {})).content[0].text;
    expect(counts).toContain('Player');
    expect(counts).not.toContain('Sprite');
    // The rename project already uses UIDs 1, 2 and 10.
    const placed = parse(await server.callTool('add_instance_to_layout', { layoutName: 'Level 1', layerName: 'Game', objectType: 'Player', x: 1, y: 1 }));
    expect(placed.success).toBe(true);
    expect(typeof placed.generatedUid).toBe('number');
    expect([1, 2, 10]).not.toContain(placed.generatedUid);
  });

  it('leaves no working folder behind when a .c3p cannot be switched to', async () => {
    const { session, server } = await serve(folderProject);
    // A project file that is present but not a project.
    await writeFile(join(root, 'NotAProject.c3p'), buildZip([{ path: 'project.c3proj', data: Buffer.from('{ not json') }]));
    expect((await server.callTool('open_project', { path: join(root, 'NotAProject.c3p') })).isError).toBe(true);
    expect(await readdir(workRoot)).toEqual([]);
    // A switch that fails after the archive was unpacked.
    const failing = vi.spyOn(session.reader, 'switchProject').mockRejectedValueOnce(new Error('disk gone'));
    expect((await server.callTool('open_project', { path: archivePath })).isError).toBe(true);
    failing.mockRestore();
    expect(await readdir(workRoot)).toEqual([]);
    expect(await objectNames(server)).toEqual(['Sprite']);
  });

  it('leaves the reader on its project when the new project file does not parse', async () => {
    const { session } = await serve(folderProject);
    await writeFile(join(root, 'bad.c3proj'), '{ not json');
    await expect(session.reader.switchProject(join(root, 'bad.c3proj'))).rejects.toThrow(/Failed to load/);
    expect(session.reader.getProjectPath()).toBe(join(folderProject, 'project.c3proj'));
    expect(session.reader.getMetadata().name).toBe('TestProject');
  });
});
