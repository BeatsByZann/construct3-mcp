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
