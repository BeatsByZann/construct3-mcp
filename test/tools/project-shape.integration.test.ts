/**
 * Roadmap C5 (HANDOFF W94): every tool path that writes project.c3proj leaves
 * an older release's file in the r495.2 save shape, and none of them prunes
 * usedAddons.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import { registerRenameTools } from '../../src/tools/rename-tools.js';
import { registerFlowchartTools } from '../../src/tools/flowchart-tools.js';
import { registerContainerTools } from '../../src/tools/container-tools.js';

const FIXTURES = join(__dirname, '..', 'fixtures');

let tmpDir: string;
let server: MockServer;

/** Copy a fixture, let `prepare` edit the copy on disk, then open a tool session on it. */
async function open(fixture: string, prepare?: (dir: string) => Promise<void>): Promise<void> {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-shape-'));
  await cp(join(FIXTURES, fixture), tmpDir, { recursive: true });
  if (prepare) await prepare(tmpDir);
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as any;
  registerProjectTools(deps);
  registerRenameTools(deps);
  registerFlowchartTools(deps);
  registerContainerTools(deps);
}

async function readProject(dir = tmpDir): Promise<Record<string, any>> {
  return JSON.parse((await readFile(join(dir, 'project.c3proj'), 'utf-8')).replace(/^﻿/, ''));
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await server.callTool(name, args);
  expect(result.isError, result.content[0].text).toBeFalsy();
  return result;
}

/** The r495.2 shape, and the content C5 must not touch. */
function expectR495Shape(p: Record<string, any>, before: Record<string, any>, addonDelta = 0) {
  const keys = Object.keys(p.properties);
  expect(keys[keys.length - 1]).toBe('scriptsType');
  expect(keys.indexOf('uidAllocationMode')).toBe(keys.indexOf('preloadSounds') + 1);
  expect(p.models3d).toEqual({ items: [], subfolders: [] });
  expect(p.usedAddons).toHaveLength(before.usedAddons.length + addonDelta);
  // Both fixtures predate release 44903 and hold "normalized", which r495.2 reads as "regular".
  expect(before.properties.zAxisScale).toBe('normalized');
  expect(p.properties.zAxisScale).toBe('regular');
  expect(p.savedWithRelease).toBe(before.savedWithRelease);
}

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('tool writes of project.c3proj on the release-44903 fixture', () => {
  let before: Record<string, any>;
  beforeEach(async () => {
    before = await readProject(join(FIXTURES, 'c3-loadable-minimal'));
    expect(Object.keys(before.properties).at(-1)).not.toBe('scriptsType');
    expect('models3d' in before).toBe(false);
  });

  it('through the project writer (update_project_properties), including the script rename', async () => {
    await open('c3-loadable-minimal');
    await call('update_project_properties', { properties: { zFar: 9000 } });
    const p = await readProject();
    expectR495Shape(p, before);
    expect(p.properties.zFar).toBe(9000);
    const script = p.rootFileFolders.script.items[0];
    expect(Object.keys(script)).toEqual(['name', 'type', 'sid', 'script-info']);
  });

  it('through register_addon, which adds without pruning', async () => {
    await open('c3-loadable-minimal');
    await call('register_addon', { type: 'plugin', id: 'Gamepad', name: 'Gamepad' });
    expectR495Shape(await readProject(), before, 1);
  });

  it('through unregister_addon, which removes only what it was asked to', async () => {
    await open('c3-loadable-minimal');
    await call('unregister_addon', { type: 'plugin', id: 'iframe', force: true });
    const p = await readProject();
    expectR495Shape(p, before, -1);
    expect(p.usedAddons.map((a: any) => a.id)).toEqual(before.usedAddons.map((a: any) => a.id).filter((id: string) => id !== 'iframe'));
  });

  it('through create_flowchart', async () => {
    await open('c3-loadable-minimal');
    await call('create_flowchart', { name: 'Shape' });
    expectR495Shape(await readProject(), before);
  });

  it('through delete_flowchart', async () => {
    // Make a flowchart with the tools once, then register it in a fresh old-shape copy.
    await open('c3-loadable-minimal');
    await call('create_flowchart', { name: 'Shape' });
    const flowchart = await readFile(join(tmpDir, 'flowcharts', 'Shape.json'), 'utf-8');
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });

    await open('c3-loadable-minimal', async (dir) => {
      await mkdir(join(dir, 'flowcharts'), { recursive: true });
      await writeFile(join(dir, 'flowcharts', 'Shape.json'), flowchart, 'utf-8');
      const p = await readProject(dir);
      p.flowcharts.items.push('Shape');
      await writeFile(join(dir, 'project.c3proj'), JSON.stringify(p, null, '\t'), 'utf-8');
    });
    await call('delete_flowchart', { name: 'Shape' });
    const p = await readProject();
    expectR495Shape(p, before);
    expect(p.flowcharts.items).toEqual([]);
  });
});

describe('tool writes of project.c3proj on the release-44000 rename fixture', () => {
  let before: Record<string, any>;
  beforeEach(async () => {
    before = await readProject(join(FIXTURES, 'rename-project'));
    expect('models3d' in before).toBe(false);
    await open('rename-project');
  });

  it.each([
    ['rename_object_type', { name: 'Tiles', newName: 'Floor' }],
    ['rename_family', { name: 'Hostiles', newName: 'Foes' }],
    ['rename_layout', { name: 'Level 1', newName: 'Opening' }],
    ['rename_event_sheet', { name: 'Main', newName: 'Core' }],
  ])('through %s', async (tool, args) => {
    await call(tool, args);
    expectR495Shape(await readProject(), before);
  });

  it('through the container tools (create_container)', async () => {
    await call('create_container', { members: ['PlayerShip', 'Keyboard'] });
    expectR495Shape(await readProject(), before);
  });
});
