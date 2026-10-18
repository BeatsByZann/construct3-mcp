/**
 * The tools that write project files themselves back each one up once per
 * call through the writer, and keep the images the frame tools park as
 * .bak. Real reader, writer and ID generator on a copy of the minimal
 * fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

describe('delete_object renames the frame images under the animation lock', () => {
  it('an animation tool called meanwhile waits until the rename and the delete are done', async () => {
    await ok('create_object', HERO);
    await ok('create_object', { name: 'Other', pluginId: 'Sprite' });
    // Hold delete_object at its first image rename, which must be inside the lock
    const reached = gate();
    const release = gate();
    const renameImageFiles = writer.renameImageFiles.bind(writer);
    let held = false;
    vi.spyOn(writer, 'renameImageFiles').mockImplementation(async renames => {
      if (!held) {
        held = true;
        reached.open();
        await release.opened;
      }
      return renameImageFiles(renames);
    });
    // Once delete_object is held, the next request of the animation lock is the animation tool's:
    // `arrived` opens when it asks, `ranInLock` when its work starts
    const arrived = gate();
    let held2 = false;
    let ranInLock = false;
    const withAnimationLock = writer.withAnimationLock.bind(writer);
    vi.spyOn(writer, 'withAnimationLock').mockImplementation(<T>(fn: () => Promise<T>) => {
      if (!held2) return withAnimationLock(fn);
      arrived.open();
      return withAnimationLock(() => {
        ranInLock = true;
        return fn();
      });
    });

    const deleting = track(server.callTool('delete_object', { name: 'Hero', force: true }));
    await reached.opened;
    held2 = true;
    const adding = track(server.callTool('add_animation_to_sprite', { objectName: 'Other', animationName: 'Run' }));
    await arrived.opened;
    await letOthersRun();
    expect(ranInLock, 'the animation tool ran while delete_object was renaming images').toBe(false);
    expect(adding.settled()).toBe(false);

    release.open();
    const deleted = await deleting.promise;
    expect(deleted.isError, deleted.content[0].text).toBeFalsy();
    const added = await adding.promise;
    expect(added.isError, added.content[0].text).toBeFalsy();
    expect(ranInLock).toBe(true);
    const objects = await reader.listObjectTypes();
    expect(objects).toContain('Other');
    expect(objects).not.toContain('Hero');
  });
});

/**
 * The editor saves project.c3proj with `change` applied to its addon list,
 * right before the writer's update of it; `saved()` is what it saved.
 */
function editorChangesAddonsBeforeUpdate(change: (addons: Array<{ id: string }>) => Array<{ id: string }>): { saved: () => string } {
  let saved = '';
  const original = writer.updateProject.bind(writer);
  vi.spyOn(writer, 'updateProject').mockImplementation(update => {
    const project = JSON.parse(readFileSync(rel('project.c3proj'), 'utf-8'));
    project.usedAddons = change(project.usedAddons);
    saved = JSON.stringify(project, null, '\t');
    writeFileSync(rel('project.c3proj'), saved, 'utf-8');
    return original(update);
  });
  return { saved: () => saved };
}

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

  it('reports it as already registered, writing nothing, when the editor registered it first', async () => {
    const editor = editorChangesAddonsBeforeUpdate(addons => [...addons, { type: 'plugin', id: 'Gamepad', name: 'Gamepad', author: 'Scirra', bundled: false } as never]);

    const result = await ok('register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' });

    expect(JSON.parse(result.content[0].text)).toMatchObject({ action: 'already_registered' });
    expect(editor.saved()).not.toBe('');
    expect(await text('project.c3proj')).toBe(editor.saved());
    expect(existsSync(rel('project.c3proj.bak'))).toBe(false);
  });
});

describe('unregister_addon', () => {
  it('reports it as not registered, writing nothing, when the editor removed it first', async () => {
    const editor = editorChangesAddonsBeforeUpdate(addons => addons.filter(a => a.id !== 'Sprite'));

    const result = await server.callTool('unregister_addon', { type: 'plugin', id: 'Sprite', force: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Addon "Sprite" (plugin) is not registered in this project.');
    expect(editor.saved()).not.toBe('');
    expect(await text('project.c3proj')).toBe(editor.saved());
    expect(existsSync(rel('project.c3proj.bak'))).toBe(false);
  });
});
