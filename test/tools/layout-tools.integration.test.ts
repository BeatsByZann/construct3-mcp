/**
 * Real-writer tests for delete_layout ordering.
 *
 * delete_* handlers deregister the entity from project.c3proj BEFORE deleting
 * its file, so a failure between the two steps leaves an orphaned file (info)
 * rather than a dangling registration (a file-existence error, and formerly a
 * UID-minting block). The mock-writer tests pin the call order; these prove
 * the on-disk outcome and the failure path through the real reader, writer,
 * project index and IdGenerator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { getProjectIndex, resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('delete_layout (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-layout-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerLayoutTools({ server, reader, writer, idGen } as any);

    // The fixture's only layout is the startup layout and has references;
    // work on a fresh, unreferenced one instead.
    const created = parseResult(await server.callTool('create_layout', { name: 'Level 2' }));
    expect(created.success).toBe(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function registeredLayouts(): Promise<string[]> {
    const project = JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
    return project.layouts.items;
  }

  it('removes both the c3proj registration and the file', async () => {
    const result = parseResult(await server.callTool('delete_layout', { name: 'Level 2' }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('deleted');

    await expect(stat(join(tmpDir, 'layouts', 'Level 2.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(tmpDir, 'layouts', 'Level 2.json.bak'))).resolves.toBeDefined();
    expect(await registeredLayouts()).not.toContain('Level 2');
    expect(await reader.listLayouts()).not.toContain('Level 2');
  });

  it('leaves an orphaned file, not a dangling registration, when the file delete fails', async () => {
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('simulated unlink failure'));

    const result = await server.callTool('delete_layout', { name: 'Level 2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('simulated unlink failure');
    // The caller is told which file to clean up: delete_layout cannot retry
    // an unregistered name.
    expect(result.content[0].text).toContain('layouts/Level 2.json');

    // Deregistered on disk, file still present
    expect(await registeredLayouts()).not.toContain('Level 2');
    await expect(stat(join(tmpDir, 'layouts', 'Level 2.json'))).resolves.toBeDefined();

    // Nothing downstream still believes the layout is registered: the index
    // was built inside the handler before deregistration and must have been
    // invalidated (this is the assertion that pins invalidateAll on
    // removeFromProject); the handler's own generator and validate_project
    // see a consistent project.
    expect((await getProjectIndex(reader)).allLayouts).not.toContain('Level 2');
    expect(await idGen.generateUid(reader)).toBe(1);
    const integrity = await validateProjectIntegrity(reader);
    expect(integrity.errors.find(e => e.entity === 'layouts/Level 2')).toBeUndefined();
    // The orphan is surfaced where the error message promised it would be
    expect(integrity.info.find(i => i.check === 'orphaned-file' && i.entity.includes('Level 2'))).toBeDefined();
  });
});

/**
 * Layer nesting, ordering and instance hierarchy through the real reader and
 * writer: these tools reshape arrays in place and maintain two-sided links, so
 * the on-disk JSON is the only proof the result is what Construct will load.
 */
describe('layer nesting and instance hierarchy (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-layer-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerLayoutTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function layoutOnDisk(): Promise<any> {
    return JSON.parse(await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf-8'));
  }

  it('nests, reorders and moves layers, and the file stays loadable', async () => {
    expect(parseResult(await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' })).success).toBe(true);
    expect(parseResult(await server.callTool('add_layer', {
      layoutName: 'Layout 1', layerName: 'HUD Back', parentLayer: 'HUD',
    })).success).toBe(true);
    expect(parseResult(await server.callTool('add_layer', {
      layoutName: 'Layout 1', layerName: 'HUD Front', parentLayer: 'HUD',
    })).success).toBe(true);

    let layout = await layoutOnDisk();
    expect(layout.layers.map((l: any) => l.name)).toEqual(['Main', 'HUD']);
    expect(layout.layers[1].subLayers.map((l: any) => l.name)).toEqual(['HUD Back', 'HUD Front']);
    // The sub-layer carries the full layer template Construct writes
    expect(layout.layers[1].subLayers[0].sampling).toBe('auto');
    expect(layout.layers[1].subLayers[0].drawOrder).toBe('z-order');

    expect(parseResult(await server.callTool('reorder_layers', {
      layoutName: 'Layout 1', layerNames: ['HUD Front', 'HUD Back'], parentLayer: 'HUD',
    })).success).toBe(true);
    expect(parseResult(await server.callTool('reorder_layers', {
      layoutName: 'Layout 1', layerNames: ['HUD', 'Main'],
    })).success).toBe(true);

    layout = await layoutOnDisk();
    expect(layout.layers.map((l: any) => l.name)).toEqual(['HUD', 'Main']);
    expect(layout.layers[0].subLayers.map((l: any) => l.name)).toEqual(['HUD Front', 'HUD Back']);

    // Move a sub-layer out to the top level, then back under another layer
    expect(parseResult(await server.callTool('move_layer', {
      layoutName: 'Layout 1', layerName: 'HUD Back', index: 0,
    })).success).toBe(true);
    layout = await layoutOnDisk();
    expect(layout.layers.map((l: any) => l.name)).toEqual(['HUD Back', 'HUD', 'Main']);
    expect(layout.layers[1].subLayers.map((l: any) => l.name)).toEqual(['HUD Front']);

    expect(parseResult(await server.callTool('move_layer', {
      layoutName: 'Layout 1', layerName: 'HUD Back', parentLayer: 'Main',
    })).success).toBe(true);
    layout = await layoutOnDisk();
    expect(layout.layers.map((l: any) => l.name)).toEqual(['HUD', 'Main']);
    expect(layout.layers[1].subLayers.map((l: any) => l.name)).toEqual(['HUD Back']);

    // update_layer reaches a nested layer and update_layout sets view state
    expect(parseResult(await server.callTool('update_layer', {
      layoutName: 'Layout 1', layerName: 'HUD Back', sampling: 'nearest', backgroundColor: [0, 0, 0, 1], global: true,
    })).success).toBe(true);
    expect(parseResult(await server.callTool('update_layout', {
      name: 'Layout 1', unboundedScrolling: true, projection: 'orthographic', vpX: 0.25, vpY: 0.75, sampling: 'bilinear',
    })).success).toBe(true);

    layout = await layoutOnDisk();
    expect(layout.layers[1].subLayers[0].sampling).toBe('nearest');
    expect(layout.layers[1].subLayers[0].backgroundColor).toEqual([0, 0, 0, 1]);
    expect(layout.layers[1].subLayers[0].global).toBe(true);
    expect(layout.unboundedScrolling).toBe(true);
    expect(layout.projection).toBe('orthographic');
    expect(layout.vpX).toBe(0.25);
    expect(layout.vpY).toBe(0.75);
    expect(layout.sampling).toBe('bilinear');

    const integrity = await validateProjectIntegrity(reader);
    expect(integrity.errors).toEqual([]);
  });

  it('refuses to move a layer into its own sub-layer and leaves the file untouched', async () => {
    await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD Back', parentLayer: 'HUD' });
    const before = await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf-8');

    const result = await server.callTool('move_layer', {
      layoutName: 'Layout 1', layerName: 'HUD', parentLayer: 'HUD Back',
    });
    expect(result.isError).toBe(true);
    expect(await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf-8')).toBe(before);
  });

  it('writes both sides of an instance hierarchy and clears them again', async () => {
    const added = parseResult(await server.callTool('add_instance_to_layout', {
      layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 10, y: 20,
    }));
    expect(added.success).toBe(true);
    const childUid = added.generatedUid as number;
    expect(typeof childUid).toBe('number');

    expect(parseResult(await server.callTool('set_instance_parent', {
      layoutName: 'Layout 1', childUid, parentUid: 0, flags: { o: true },
    })).success).toBe(true);

    let layout = await layoutOnDisk();
    const instances = layout.layers[0].instances as any[];
    const parent = instances.find(i => i.uid === 0);
    const child = instances.find(i => i.uid === childUid);
    expect(parent.sceneGraphData['parent-uid']).toBeNull();
    expect(parent.sceneGraphData.children).toHaveLength(1);
    expect(parent.sceneGraphData.children[0].uid).toBe(childUid);
    // Both sides carry identical flags, as Construct writes them
    expect(parent.sceneGraphData.children[0].flags).toEqual(child.sceneGraphData.flags);
    expect(child.sceneGraphData.flags).toEqual({
      x: true, y: true, z: true, w: true, h: true, d: true, a: true, o: true, v: false, sm: 'normal',
    });
    expect(child.sceneGraphData['parent-uid']).toBe(0);

    expect(parseResult(await server.callTool('remove_instance_children', {
      layoutName: 'Layout 1', parentUid: 0,
    })).success).toBe(true);

    layout = await layoutOnDisk();
    const after = layout.layers[0].instances as any[];
    expect(after.find(i => i.uid === 0).sceneGraphData.children).toBeUndefined();
    expect(after.find(i => i.uid === childUid).sceneGraphData['parent-uid']).toBeNull();

    const integrity = await validateProjectIntegrity(reader);
    expect(integrity.errors).toEqual([]);
  });
});
