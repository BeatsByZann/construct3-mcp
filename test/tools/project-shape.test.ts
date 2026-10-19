/**
 * A write to project.c3proj through the writer leaves the file in the save
 * shape. Real reader, writer and ID generator on a copy of
 * the c3-loadable-minimal fixture (saved by release 44903).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { applyJsonTextStyle, jsonTextStyleOf, stripBom } from '../../src/construct3/json-format.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { expectShaped, shapeByHand, type ProjectJson } from '../helpers/project-shape.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'c3-loadable-minimal');

const BOM = '\uFEFF';

type Result ={ content: Array<{ type: string; text: string }>; isError?: boolean };

let dir: string;
const dirs: string[] = [];
let projectPath: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
/** The fixture's project.c3proj text and parsed form, as copied. */
let originalText: string;
let before: ProjectJson;

/** Copy the fixture to a new temp folder and open it with the real reader and writer. */
async function openCopy(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'c3-shape-'));
  dirs.push(dir);
  await cp(FIXTURE_DIR, dir, { recursive: true });
  projectPath = join(dir, 'project.c3proj');
  originalText = await readFile(projectPath, 'utf-8');
  before = JSON.parse(stripBom(originalText)) as ProjectJson;
  await openFolder();
}

/** Open the current folder with a new reader and writer and register the tools. */
async function openFolder(): Promise<void> {
  reader = new Construct3ProjectReader(projectPath);
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as unknown as Parameters<typeof registerProjectTools>[0];
  registerProjectTools(deps);
  registerTimelineTools(deps as unknown as Parameters<typeof registerTimelineTools>[0]);
}

/** The project.c3proj on disk, parsed. */
async function onDisk(): Promise<ProjectJson> {
  return JSON.parse(stripBom(await readFile(projectPath, 'utf-8'))) as ProjectJson;
}

/** Call a tool and require that it succeeded. */
async function ok(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await server.callTool(tool, args) as Result;
  expect(result.isError, `${tool}: ${result.content[0]?.text}`).toBeFalsy();
  return result;
}

/** `project` serialized in the text style of the fixture. */
function inFixtureStyle(project: ProjectJson): string {
  return applyJsonTextStyle(JSON.stringify(project, null, '\t'), jsonTextStyleOf(originalText));
}

/** Run `fn` right before the next writer.updateProject call, which then goes on. */
function beforeNextProjectUpdate(fn: () => Promise<void>): { calls: () => number } {
  const original = writer.updateProject.bind(writer);
  let calls = 0;
  let first = true;
  vi.spyOn(writer, 'updateProject').mockImplementation(async change => {
    calls++;
    if (first) {
      first = false;
      await fn();
    }
    return original(change);
  });
  return { calls: () => calls };
}

/** Addon ids of a parsed project. */
function addonIds(project: ProjectJson): string[] {
  return (project.usedAddons as Array<{ id: string }>).map(addon => addon.id);
}

/** The first script entry of a parsed project. */
function firstScript(project: ProjectJson): Record<string, unknown> {
  return (project.rootFileFolders as { script: { items: Array<Record<string, unknown>> } }).script.items[0]!;
}

beforeEach(async () => {
  resetProjectIndex();
  await openCopy();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of dirs.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('project.c3proj shape on write', () => {
  it('B1w: update_project_metadata shapes the file and leaves zAxisScale as saved', async () => {
    await ok('update_project_metadata', { name: 'Renamed' });
    const project = await onDisk();
    expectShaped(project, before);
    expect(project.name).toBe('Renamed');
    expect((project.properties as Record<string, unknown>).zAxisScale).toBe('normalized');
    expect(Object.keys(firstScript(project))).toEqual(['name', 'type', 'sid', 'script-info']);
  });

  it('B2w: register_addon and unregister_addon shape the file', async () => {
    await ok('register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' });
    expectShaped(await onDisk(), before, { addonDelta: 1 });

    await openCopy();
    await ok('unregister_addon', { type: 'plugin', id: 'iframe', force: true });
    const project = await onDisk();
    expectShaped(project, before, { addonDelta: -1 });
    expect(addonIds(project)).toEqual(addonIds(before).filter(id => id !== 'iframe'));
  });

  it('B3w: create_timeline and delete_timeline shape the file', async () => {
    await ok('create_timeline', { name: 'Intro' });
    const created = await onDisk();
    expectShaped(created, before);
    const timelineText = await readFile(join(dir, 'timelines', 'Intro.json'), 'utf-8');

    // A fresh copy that holds the timeline file and its registration, unshaped
    await rm(dir, { recursive: true, force: true });
    await openCopy();
    const registered = structuredClone(before);
    registered.timelines = { items: ['Intro'], subfolders: [] };
    await writeFile(projectPath, inFixtureStyle(registered), 'utf-8');
    await mkdir(join(dir, 'timelines'), { recursive: true });
    await writeFile(join(dir, 'timelines', 'Intro.json'), timelineText, 'utf-8');
    await openFolder();

    await ok('delete_timeline', { name: 'Intro' });
    expectShaped(await onDisk(), registered);
  });

  it('B4w: addToProject and removeFromProject shape the file', async () => {
    await writer.addToProject('layouts', 'Extra');
    expectShaped(await onDisk(), before);

    await openCopy();
    await writer.removeFromProject('layouts', 'Start');
    expectShaped(await onDisk(), before);
  });

  it('B5w: an update that writes nothing reshapes nothing', async () => {
    const unshapedWithTouch = structuredClone(before);
    (unshapedWithTouch.usedAddons as unknown[]).push({ type: 'plugin', id: 'Gamepad', name: 'Gamepad', author: 'Scirra', bundled: false });
    let written = '';
    const spy = beforeNextProjectUpdate(async () => {
      written = inFixtureStyle(unshapedWithTouch);
      await writeFile(projectPath, written, 'utf-8');
    });

    const result = await ok('register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' });
    expect(result.content[0]!.text).toContain('already_registered');
    expect(await readFile(projectPath, 'utf-8')).toBe(written);
    expect('models3d' in (await onDisk())).toBe(false);
    expect(spy.calls()).toBe(1);

    await openCopy();
    await writer.updateProject(() => false);
    expect(await readFile(projectPath, 'utf-8')).toBe(originalText);
  });

  it('B6w: keeps a BOM, CRLF line ends and the trailing line end', async () => {
    const styled = BOM + JSON.stringify(before, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
    await writeFile(projectPath, styled, 'utf-8');
    await openFolder();

    await ok('update_project_metadata', { name: 'Styled' });
    const text = await readFile(projectPath, 'utf-8');
    expect(text.startsWith(BOM)).toBe(true);
    expect(BOM).toHaveLength(1);
    expect(/(?<!\r)\n/.test(text)).toBe(false);
    expect(text.endsWith('\r\n')).toBe(true);
    expectShaped(await onDisk(), before);
  });

  it('B7w: a project already in the shape changes only by the write itself', async () => {
    const shaped = shapeByHand(before);
    expectShaped(shaped, before);
    shaped.savedWithRelease = 49502;
    await writeFile(projectPath, inFixtureStyle(shaped), 'utf-8');
    await openFolder();

    await ok('update_project_metadata', { name: 'Same Shape' });
    const expected = structuredClone(shaped);
    expected.name = 'Same Shape';
    expect(JSON.stringify(await onDisk())).toBe(JSON.stringify(expected));
  });

  it('B9w: inject_runtime_bridge writes project.c3proj with its own text and does not reshape it (characterization)', async () => {
    // The fixture already registers the bridge script; take the entry out so the tool must write the file
    const unregistered = structuredClone(before);
    (unregistered.rootFileFolders as { script: { items: unknown[] } }).script.items = [];
    await writeFile(projectPath, inFixtureStyle(unregistered), 'utf-8');
    await openFolder();
    const deps = { server, reader, writer } as unknown as Parameters<typeof registerRuntimeTools>[0];
    registerRuntimeTools(deps);

    await ok('inject_runtime_bridge');
    const project = await onDisk();
    expect(firstScript(project).name).toBe('c3-runtime-bridge.js');
    expect(Object.keys(firstScript(project))).toContain('script-info');
    expect('models3d' in project).toBe(false);
    expect(Object.keys(project.properties as Record<string, unknown>)).toEqual(Object.keys(before.properties as Record<string, unknown>));
    expect((project.properties as Record<string, unknown>).zAxisScale).toBe('normalized');
  });

  it('B8w: an update merged into a change saved meanwhile is shaped too', async () => {
    beforeNextProjectUpdate(async () => {
      const saved = structuredClone(before);
      (saved.properties as Record<string, unknown>).description = 'Saved in the editor';
      await writeFile(projectPath, inFixtureStyle(saved), 'utf-8');
    });

    await ok('register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' });
    const project = await onDisk();
    expect((project.properties as Record<string, unknown>).description).toBe('Saved in the editor');
    expect(addonIds(project)).toContain('Gamepad');
    expectShaped(project, before, { addonDelta: 1 });
  });
});
