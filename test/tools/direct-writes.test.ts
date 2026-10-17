/**
 * The tools that write project files themselves back each one up once per
 * call through the writer, and keep the images the frame tools park as
 * .bak. Real reader, writer and ID generator on a copy of the minimal
 * fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { getImageFileName } from '../../src/construct3/png-generator.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { sameFileState, statFileState } from '../../src/construct3/disk-state.js';
import { gate, letOthersRun, track } from '../helpers/barrier.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
// A 1x1 opaque PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HERO = { name: 'Hero', pluginId: 'Sprite' };

let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let runtime: { close(): Promise<void> };

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function ok(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await server.callTool(tool, args);
  expect(result.isError, `${tool}: ${result.content[0].text}`).toBeFalsy();
  return result;
}

const rel = (path: string) => join(dir, ...path.split('/'));
const text = (path: string) => readFile(rel(path), 'utf-8');

/** Saving project.c3proj in the editor: a new author (synchronous, so a spied method can do it). */
function saveProjectInEditor(): void {
  const project = JSON.parse(readFileSync(rel('project.c3proj'), 'utf-8'));
  project.properties.author = 'Editor';
  writeFileSync(rel('project.c3proj'), JSON.stringify(project, null, '\t'), 'utf-8');
}

/**
 * Hold the writer's next atomic write of project.c3proj (inside its lock)
 * until `release` opens; `reached` opens when it is held.
 */
function holdNextProjectWrite(): { reached: ReturnType<typeof gate>; release: ReturnType<typeof gate> } {
  const reached = gate();
  const release = gate();
  const internals = writer as unknown as { atomicWrite: (p: string, c: string | Buffer) => Promise<void> };
  const original = internals.atomicWrite.bind(writer);
  let held = false;
  vi.spyOn(internals, 'atomicWrite').mockImplementation(async (p, c) => {
    if (!held && p.toLowerCase().endsWith('project.c3proj')) {
      held = true;
      reached.open();
      await release.opened;
    }
    return original(p, c);
  });
  return { reached, release };
}

/**
 * Opens the returned gate when the writer's replaceFile is called for
 * project.c3proj (`replaceFile`) or updateProjectProperties is called
 * (`updateProjectProperties`): the call has read what it needs and goes to
 * the file's lock next, with nothing before it that waits on the disk.
 */
function arrivesAt(method: 'replaceFile' | 'updateProjectProperties'): ReturnType<typeof gate> {
  const arrived = gate();
  const original = writer[method].bind(writer) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(writer, method).mockImplementation(((...args: unknown[]) => {
    if (method === 'updateProjectProperties' || String(args[0]).toLowerCase().endsWith('project.c3proj')) arrived.open();
    return original(...args);
  }) as never);
  return arrived;
}

/**
 * Watches for a call that takes the lock of project.c3proj: every writer backs
 * the file up only inside that lock. `stayedOutFor(ms)` waits until one has
 * got in or `ms` have passed; `entered()` says whether one did.
 */
function watchProjectLock(): { stayedOutFor: (ms: number) => Promise<void>; entered: () => boolean } {
  const inside = gate();
  let entered = false;
  const original = (writer as unknown as { createBackup: (p: string, o?: unknown) => Promise<unknown> }).createBackup.bind(writer);
  vi.spyOn(writer as never, 'createBackup').mockImplementation((async (p: string, o?: unknown) => {
    if (p.toLowerCase().endsWith('project.c3proj')) {
      entered = true;
      inside.open();
    }
    return original(p, o);
  }) as never);
  return {
    stayedOutFor: ms => Promise.race([inside.opened, new Promise<void>(resolve => setTimeout(resolve, ms))]),
    entered: () => entered,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-direct-write-tools-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerQueryTools(server as never, reader);
  registerMutationTools(server as never, reader, writer, idGen);
  runtime = registerRuntimeTools({ server: server as never, reader, writer });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('a tool that writes a project file itself backs it up first', () => {
  it.each([
    ['register_addon', [], { type: 'plugin', id: 'Gamepad', name: 'Gamepad' }, 'project.c3proj'],
    ['unregister_addon', [], { type: 'plugin', id: 'Sprite', force: true }, 'project.c3proj'],
    ['create_timeline', [], { name: 'T1' }, 'project.c3proj'],
    ['update_timeline', [['create_timeline', { name: 'T1' }]], { name: 'T1', loop: true }, 'timelines/T1.json'],
    ['delete_timeline', [['create_timeline', { name: 'T1' }]], { name: 'T1' }, 'timelines/T1.json'],
    ['replace_sprite_image', [['create_object', HERO]],
      { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, pngBase64: PNG }, `images/${getImageFileName('Hero', 'Animation 1', 0, 'Sprite')}`],
    ['inject_runtime_bridge', [], {}, 'project.c3proj'],
    ['remove_runtime_bridge', [['inject_runtime_bridge', {}]], {}, 'scripts/c3-runtime-bridge.js'],
  ] as Array<[string, Array<[string, Record<string, unknown>]>, Record<string, unknown>, string]>)('%s', async (tool, setup, args, file) => {
    for (const [name, a] of setup) await ok(name, a);
    const before = await text(file);
    await ok(tool, args);
    expect(await text(`${file}.bak`)).toBe(before);
  });
});

describe('images the frame tools park as .bak', () => {
  it('are kept when the frame\'s image is replaced afterwards', async () => {
    await ok('create_object', HERO);
    await ok('add_frame_to_animation', { objectName: 'Hero', animationName: 'Animation 1' });
    await ok('add_frame_to_animation', { objectName: 'Hero', animationName: 'Animation 1' });
    const image = (i: number) => `images/${getImageFileName('Hero', 'Animation 1', i, 'Sprite')}`;
    for (const i of [0, 1, 2]) await writeFile(rel(image(i)), `artwork ${i}`);

    await ok('delete_frame_from_animation', { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 1 });
    expect(await text(`${image(1)}.bak`)).toBe('artwork 1');
    await ok('replace_sprite_image', { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 1, pngBase64: PNG });

    expect(await text(`${image(1)}.bak`)).toBe('artwork 1');
    expect(await text(`${image(1)}.1.bak`)).toBe('artwork 2');
  });
});

describe('inject_runtime_bridge refused before it writes project.c3proj', () => {
  it('leaves an existing project.c3proj.bak as it was', async () => {
    await writeFile(rel('project.c3proj.bak'), 'an older backup');
    const original = writer.assertProjectFileCurrent.bind(writer);
    let calls = 0;
    vi.spyOn(writer, 'assertProjectFileCurrent').mockImplementation(async () => {
      if (++calls === 2) saveProjectInEditor();
      return original();
    });
    const refused = await server.callTool('inject_runtime_bridge', {});
    expect(refused.isError).toBe(true);
    expect(await text('project.c3proj.bak')).toBe('an older backup');
  });
});

describe('project.c3proj has one lock for every writer', () => {
  it('a project update waits for the bridge\'s write of project.c3proj, then merges it', async () => {
    const { reached, release } = holdNextProjectWrite();
    const inject = track(server.callTool('inject_runtime_bridge', {}));
    await reached.opened;
    const arrived = arrivesAt('updateProjectProperties');
    const lock = watchProjectLock();
    const update = track(server.callTool('update_project_metadata', { author: 'Parallel' }));
    await arrived.opened;
    await letOthersRun();
    await lock.stayedOutFor(300);
    expect(lock.entered(), 'the update took the lock while the bridge held it').toBe(false);
    expect(update.settled()).toBe(false);
    release.open();
    const injected = await inject.promise;
    expect(injected.isError, injected.content[0].text).toBeFalsy();
    const updated = await update.promise;
    expect(updated.isError, updated.content[0].text).toBeFalsy();
    const project = JSON.parse(await text('project.c3proj'));
    expect(project.properties.author).toBe('Parallel');
    expect(JSON.stringify(project.rootFileFolders)).toContain('c3-runtime-bridge.js');
  });

  it('the bridge waits for a project update, then refuses to write over it and rolls back', async () => {
    const { reached, release } = holdNextProjectWrite();
    const update = track(server.callTool('update_project_metadata', { author: 'First' }));
    await reached.opened;
    const arrived = arrivesAt('replaceFile');
    const lock = watchProjectLock();
    const inject = track(server.callTool('inject_runtime_bridge', {}));
    await arrived.opened;
    await letOthersRun();
    await lock.stayedOutFor(300);
    expect(lock.entered(), 'the bridge took the lock while the update held it').toBe(false);
    expect(inject.settled()).toBe(false);
    release.open();
    const updated = await update.promise;
    expect(updated.isError, updated.content[0].text).toBeFalsy();
    const refused = await inject.promise;
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('was changed on disk after this server read it');
    const project = JSON.parse(await text('project.c3proj'));
    expect(project.properties.author).toBe('First');
    expect(JSON.stringify(project.rootFileFolders ?? {})).not.toContain('c3-runtime-bridge.js');
    await expect(text('scripts/c3-runtime-bridge.js')).rejects.toThrow();
  });
});

describe('the bridge script is stamped by the bytes the writer confirmed', () => {
  it('a save of it right after the call wrote it is seen as a change made outside the server', async () => {
    const bridge = rel('scripts/c3-runtime-bridge.js');
    const afterDirectWrites = writer.afterDirectWrites.bind(writer);
    vi.spyOn(writer, 'afterDirectWrites').mockImplementationOnce(async writes => {
      await writeFile(bridge, '// saved in the editor');
      return afterDirectWrites(writes);
    });
    await ok('inject_runtime_bridge');
    expect(await text('scripts/c3-runtime-bridge.js')).toBe('// saved in the editor');
    expect(sameFileState(reader.stateAsRead(bridge) ?? null, await statFileState(bridge))).toBe(false);
  });
});

describe('register_addon', () => {
  it('merges a project.c3proj the editor saved during the call', async () => {
    const original = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementation(change => {
      saveProjectInEditor();
      return original(change);
    });
    await ok('register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' });
    const project = JSON.parse(await text('project.c3proj'));
    expect(project.properties.author).toBe('Editor');
    expect(project.usedAddons.map((a: { id: string }) => a.id)).toContain('Gamepad');
  });
});
