/**
 * Real-reader/writer tests for the structure tools (Project Bar moves and
 * duplicates) and the copy mode of move_event_block_items, on a temp copy of
 * test/fixtures/rename-project.
 *
 * Shapes checked against Construct r495 samples: a folder is
 * `{ items, subfolders, name }`; a foldered entity lives at
 * `<category>/<folder path>/<name>.json` with its `.uistate.json` beside it
 * and a layout's `layouts/uistate/<folder path>/<name>.instancesBar.json`;
 * `instanceFolderItem.sid` equals the instance SID and
 * `scene-graphs-folder-root` items address hierarchy roots by instance SID.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Lets a test make one fs unlink fail (a locked file) without touching the rest.
const fsControl = vi.hoisted(() => ({ failUnlink: null as null | ((path: string) => boolean) }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const unlink = async (path: Parameters<typeof actual.unlink>[0]) => {
    if (fsControl.failUnlink?.(String(path))) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return actual.unlink(path);
  };
  return { ...actual, default: { ...actual, unlink }, unlink };
});
import { mkdtemp, cp, rm, readFile, writeFile, stat, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerStructureTools } from '../../src/tools/structure-tools.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function readJson(...segments: string[]): Promise<any> {
  return JSON.parse(await readFile(join(tmpDir, ...segments), 'utf-8'));
}

async function editJson(rel: string[], fn: (data: any) => void) {
  const data = await readJson(...rel);
  fn(data);
  await writeFile(join(tmpDir, ...rel), JSON.stringify(data, null, '\t'));
}

async function exists(...segments: string[]): Promise<boolean> {
  try {
    await stat(join(tmpDir, ...segments));
    return true;
  } catch {
    return false;
  }
}

async function reload() {
  await reader.reloadProject();
}

/** Every numeric sid in a JSON value. */
function sidsOf(value: unknown): number[] {
  const out: number[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'sid' && typeof v === 'number') out.push(v);
        else walk(v);
      }
    }
  };
  walk(value);
  return out;
}

function allInstances(layout: any): any[] {
  const out: any[] = [];
  const walk = (layers: any[] | undefined) => {
    for (const l of layers ?? []) {
      out.push(...(l.instances ?? []));
      walk(l.subLayers);
    }
  };
  walk(layout.layers);
  out.push(...(layout['nonworld-instances'] ?? []));
  return out;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-structure-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await mkdir(join(tmpDir, 'images'), { recursive: true });
  for (const name of ['player-default-000.png', 'player-idle-001.png', 'playership-default-000.png', 'tiles.png']) {
    await writeFile(join(tmpDir, 'images', name), generatePlaceholderPng(1, 1));
  }
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  const deps = { server, reader, writer, idGen } as any;
  registerStructureTools(deps);
  registerEventTools(deps);
});

afterEach(async () => {
  vi.restoreAllMocks();
  fsControl.failUnlink = null;
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

// ─── move_project_item ─────────────────────────────────────

describe('move_project_item', () => {
  it('moves a layout into a new nested folder with its editor files', async () => {
    await writeFile(join(tmpDir, 'layouts', 'Level 1.uistate.json'), '{"a":1}');
    await mkdir(join(tmpDir, 'layouts', 'uistate'), { recursive: true });
    await writeFile(join(tmpDir, 'layouts', 'uistate', 'Level 1.instancesBar.json'), '{"b":2}');

    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder: 'Maps/World' });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.from).toBe('');
    expect(data.to).toBe('Maps/World');
    expect(data.foldersCreated).toEqual(['Maps', 'Maps/World']);
    expect(data.filesMoved.map((f: any) => f.to)).toEqual([
      'layouts/Maps/World/Level 1.json',
      'layouts/Maps/World/Level 1.uistate.json',
      'layouts/uistate/Maps/World/Level 1.instancesBar.json',
    ]);

    expect(await exists('layouts', 'Level 1.json')).toBe(false);
    expect(await exists('layouts', 'Level 1.uistate.json')).toBe(false);
    expect(await exists('layouts', 'uistate', 'Level 1.instancesBar.json')).toBe(false);
    expect((await readJson('layouts', 'Maps', 'World', 'Level 1.json')).name).toBe('Level 1');
    expect(await readFile(join(tmpDir, 'layouts', 'uistate', 'Maps', 'World', 'Level 1.instancesBar.json'), 'utf-8')).toBe('{"b":2}');

    const project = await readJson('project.c3proj');
    expect(project.layouts.items).toEqual([]);
    const maps = project.layouts.subfolders[1];
    expect(Object.keys(maps)).toEqual(['items', 'subfolders', 'name']);
    expect(maps.name).toBe('Maps');
    expect(maps.subfolders[0]).toEqual({ items: ['Level 1'], subfolders: [], name: 'World' });

    // The reader follows the new location.
    expect((await reader.readLayout('Level 1')).name).toBe('Level 1');
  });

  it('moves an object type to the root and keeps the rest of its folder in order', async () => {
    const result = await server.callTool('move_project_item', { category: 'objectType', name: 'PlayerShip', folder: '' });
    expect(result.isError).not.toBe(true);
    expect(await exists('objectTypes', 'PlayerShip.json')).toBe(true);
    expect(await exists('objectTypes', 'Actors', 'PlayerShip.json')).toBe(false);
    const project = await readJson('project.c3proj');
    expect(project.objectTypes.items).toEqual(['Tiles', 'Keyboard', 'PlayerShip']);
    expect(project.objectTypes.subfolders[0].items).toEqual(['Player', 'Enemy']);
  });

  it('moves a tilemap object type together with its brush file', async () => {
    const result = await server.callTool('move_project_item', { category: 'objectType', name: 'Tiles', folder: 'Terrain' });
    expect(result.isError).not.toBe(true);
    expect(await exists('tilemapBrushes', 'objectTypes', 'Tiles.brush.json')).toBe(false);
    expect(await exists('tilemapBrushes', 'objectTypes', 'Terrain', 'Tiles.brush.json')).toBe(true);
    expect(await exists('objectTypes', 'Terrain', 'Tiles.json')).toBe(true);
  });

  it('moves an event sheet out of a folder and keeps the emptied folder', async () => {
    const result = await server.callTool('move_project_item', { category: 'eventSheet', name: 'Helpers', folder: '' });
    const data = parse(result);
    expect(data.warnings.join(' ')).toContain('"Shared" is now empty');
    const project = await readJson('project.c3proj');
    expect(project.eventSheets.items).toEqual(['Main', 'Helpers']);
    expect(project.eventSheets.subfolders).toEqual([{ items: [], subfolders: [], name: 'Shared' }]);
    expect(await exists('eventSheets', 'Helpers.json')).toBe(true);
  });

  it('moves a family between folders', async () => {
    const result = await server.callTool('move_project_item', { category: 'family', name: 'Hostiles', folder: 'Teams' });
    expect(result.isError).not.toBe(true);
    expect(await exists('families', 'Teams', 'Hostiles.json')).toBe(true);
    expect((await readJson('project.c3proj')).families.subfolders.map((f: any) => f.name)).toEqual(['Groups', 'Teams']);
  });

  it('moves a registered script file and keeps its registration entry', async () => {
    await mkdir(join(tmpDir, 'scripts'), { recursive: true });
    await writeFile(join(tmpDir, 'scripts', 'main.js'), 'export const x = 1;\n');
    await editJson(['project.c3proj'], p => {
      p.rootFileFolders.script.items.push({ name: 'main.js', type: 'application/javascript', sid: 640000000000001, 'script-info': { purpose: 'main-script' } });
    });
    await reload();

    const result = await server.callTool('move_project_item', { category: 'script', name: 'main.js', folder: 'lib' });
    expect(result.isError).not.toBe(true);
    expect(parse(result).warnings.join(' ')).toContain('import');
    expect(await exists('scripts', 'main.js')).toBe(false);
    expect(await readFile(join(tmpDir, 'scripts', 'lib', 'main.js'), 'utf-8')).toBe('export const x = 1;\n');
    const script = (await readJson('project.c3proj')).rootFileFolders.script;
    expect(script.items).toEqual([]);
    expect(script.subfolders).toEqual([{
      items: [{ name: 'main.js', type: 'application/javascript', sid: 640000000000001, 'script-info': { purpose: 'main-script' } }],
      subfolders: [],
      name: 'lib',
    }]);
  });

  it('refuses a move to the current folder', async () => {
    const result = await server.callTool('move_project_item', { category: 'objectType', name: 'Player', folder: 'Actors' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already in');
  });

  it('refuses a missing folder when createFolders is false and writes nothing', async () => {
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder: 'Nowhere', createFolders: false });
    expect(result.isError).toBe(true);
    expect(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).toBe(before);
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
  });

  it('refuses when the destination file already exists and leaves no copies behind', async () => {
    await writeFile(join(tmpDir, 'layouts', 'Extra', 'Level 1.uistate.json'), '{}');
    await writeFile(join(tmpDir, 'layouts', 'Level 1.uistate.json'), '{}');
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder: 'Extra' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('layouts/Extra/Level 1.uistate.json already exists');
    expect(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).toBe(before);
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
    // The layout file itself was checked first but must not have been copied.
    expect(await exists('layouts', 'Extra', 'Level 1.json')).toBe(false);
  });

  it('refuses a flowchart move when the project has no flowcharts tree', async () => {
    const result = await server.callTool('move_project_item', { category: 'flowchart', name: 'Graph', folder: 'A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('flowcharts');
  });
});

// ─── duplicate_layout ──────────────────────────────────────

async function addHierarchy() {
  await editJson(['layouts', 'Level 1.json'], l => {
    const [player, enemy] = l.layers[0].instances;
    const flags = { x: true, y: true };
    player.instanceFolderItem = { sid: player.sid, expanded: true };
    enemy.instanceFolderItem = { sid: enemy.sid, expanded: true };
    player.sceneGraphData = { uid: 1, 'parent-uid': null, children: [{ uid: 2, flags }], flags };
    enemy.sceneGraphData = { uid: 2, 'parent-uid': 1, flags };
    l['scene-graphs-folder-root'] = { items: [{ sid: player.sid, expanded: true }], subfolders: [] };
  });
}

describe('duplicate_layout', () => {
  it('copies every layer and instance with fresh SIDs, new UIDs and remapped hierarchy links', async () => {
    await addHierarchy();
    const source = await readJson('layouts', 'Level 1.json');
    const sourceSids = new Set(sidsOf(source));

    const result = await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Level 1 Copy' });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.instances).toBe(4);
    expect(data.warnings.join(' ')).toContain('Keyboard');

    const copy = await readJson('layouts', 'Level 1 Copy.json');
    expect(copy.name).toBe('Level 1 Copy');
    expect(copy.eventSheet).toBe('Main');
    expect(Object.keys(copy)).toEqual(Object.keys(source));

    const copySids = sidsOf(copy);
    expect(copySids.some(sid => sourceSids.has(sid))).toBe(false);

    const instances = allInstances(copy);
    const uids = instances.map(i => i.uid);
    expect(Math.min(...uids)).toBeGreaterThan(4);
    expect(new Set(uids).size).toBe(4);
    expect(new Set(instances.map(i => i.sid)).size).toBe(4);

    const [player, enemy] = copy.layers[0].instances;
    expect(player.sceneGraphData.uid).toBe(player.uid);
    expect(player.sceneGraphData.children[0].uid).toBe(enemy.uid);
    expect(enemy.sceneGraphData['parent-uid']).toBe(player.uid);
    expect(player.sceneGraphData['parent-uid']).toBeNull();
    expect(player.instanceFolderItem.sid).toBe(player.sid);
    expect(enemy.instanceFolderItem.sid).toBe(enemy.sid);
    expect(copy['scene-graphs-folder-root'].items).toEqual([{ sid: player.sid, expanded: true }]);

    // The source is untouched and the copy is registered right after it.
    expect(await readJson('layouts', 'Level 1.json')).toEqual(source);
    expect((await readJson('project.c3proj')).layouts.items).toEqual(['Level 1', 'Level 1 Copy']);
  });

  it('allocates UIDs above sub-layer instances when duplicating twice', async () => {
    // Every instance of Level 2 sits on a sub-layer and holds the highest UID.
    await editJson(['layouts', 'Extra', 'Level 2.json'], l => {
      l.layers = [{ ...l.layers[0], name: 'Top', sid: 631000000000001, instances: [], subLayers: [{ ...l.layers[0], instances: l.layers[0].instances.map((i: any, n: number) => ({ ...i, uid: 900 + n })) }] }];
    });
    const first = await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy A' });
    const second = await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy B' });
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const uids = [
      ...allInstances(await readJson('layouts', 'Level 1.json')),
      ...allInstances(await readJson('layouts', 'Extra', 'Level 2.json')),
      ...allInstances(await readJson('layouts', 'Copy A.json')),
      ...allInstances(await readJson('layouts', 'Copy B.json')),
    ].map(i => i.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(Math.min(...allInstances(await readJson('layouts', 'Copy A.json')).map(i => i.uid))).toBeGreaterThan(900);
  });

  it('keeps the copy in the source folder', async () => {
    const result = await server.callTool('duplicate_layout', { layoutName: 'Level 2', newName: 'Level 3' });
    expect(result.isError).not.toBe(true);
    expect(await exists('layouts', 'Extra', 'Level 3.json')).toBe(true);
    expect((await readJson('project.c3proj')).layouts.subfolders[0].items).toEqual(['Level 2', 'Level 3']);
  });

  it('refuses a layout holding a template instance and writes nothing', async () => {
    await editJson(['layouts', 'Level 1.json'], l => {
      l.layers[0].instances[0].template = { mode: 'template', templateName: 'Hero', sourceTemplateName: '', replicasUIDs: null };
    });
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const result = await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('template');
    expect(await exists('layouts', 'Copy.json')).toBe(false);
    expect(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).toBe(before);
  });

  it('copies replica instances', async () => {
    await editJson(['layouts', 'Level 1.json'], l => {
      l.layers[0].instances[0].template = { mode: 'replica', templateName: '', sourceTemplateName: 'Hero', replicasUIDs: null };
    });
    const result = await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
    expect(result.isError).not.toBe(true);
  });

  it('refuses a name that differs from an existing layout only by case', async () => {
    const result = await server.callTool('duplicate_layout', { layoutName: 'Level 2', newName: 'level 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Level 1"');
  });
});

// ─── duplicate_layer ───────────────────────────────────────

describe('duplicate_layer', () => {
  it('inserts a copy above the source layer with fresh IDs', async () => {
    await editJson(['layouts', 'Level 1.json'], l => {
      const ui = l.layers[0].subLayers[0];
      ui.instances[0].instanceFolderItem = { sid: ui.instances[0].sid, expanded: false };
      l['scene-graphs-folder-root'] = { items: [], subfolders: [{ items: [{ sid: ui.instances[0].sid, expanded: false }], subfolders: [], name: 'F' }] };
    });
    const result = await server.callTool('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    const layout = await readJson('layouts', 'Level 1.json');
    const [ui, ui2] = layout.layers[0].subLayers;
    expect(ui.name).toBe('UI');
    expect(ui2.name).toBe('UI2');
    expect(ui2.sid).not.toBe(ui.sid);
    expect(data.generatedSid).toBe(ui2.sid);
    const copy = ui2.instances[0];
    expect(copy.uid).toBeGreaterThan(4);
    expect(copy.sid).not.toBe(ui.instances[0].sid);
    expect(copy.instanceFolderItem.sid).toBe(copy.sid);
    expect(layout['scene-graphs-folder-root'].subfolders[0].items).toEqual([
      { sid: ui.instances[0].sid, expanded: false },
      { sid: copy.sid, expanded: false },
    ]);
  });

  it('refuses a layer with sub-layers', async () => {
    const result = await server.callTool('duplicate_layer', { layoutName: 'Level 1', layerName: 'Game', newName: 'Game2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sub-layers');
  });

  it('refuses a layer whose instances have hierarchy links to other layers', async () => {
    await editJson(['layouts', 'Level 1.json'], l => {
      const flags = { x: true };
      l.layers[0].instances[0].sceneGraphData = { uid: 1, 'parent-uid': null, children: [{ uid: 3, flags }], flags };
      l.layers[0].subLayers[0].instances[0].sceneGraphData = { uid: 3, 'parent-uid': 1, flags };
    });
    const before = await readFile(join(tmpDir, 'layouts', 'Level 1.json'), 'utf-8');
    const result = await server.callTool('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'UI2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('parent uid 1');
    expect(await readFile(join(tmpDir, 'layouts', 'Level 1.json'), 'utf-8')).toBe(before);
  });

  it('refuses a name already used by a layer of the layout', async () => {
    const result = await server.callTool('duplicate_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'Game' });
    expect(result.isError).toBe(true);
  });
});

// ─── duplicate_event_sheet ─────────────────────────────────

describe('duplicate_event_sheet', () => {
  it('refuses a sheet that declares global variables or custom actions', async () => {
    const result = await server.callTool('duplicate_event_sheet', { sheetName: 'Main', newName: 'Main2' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('global variable "score"');
    expect(text).toContain('custom action "Alert"');
    expect(await exists('eventSheets', 'Main2.json')).toBe(false);
  });

  it('copies a sheet with fresh SIDs into the source folder', async () => {
    await editJson(['eventSheets', 'Shared', 'Helpers.json'], s => {
      s.events = s.events.filter((e: any) => e.eventType !== 'variable');
    });
    const source = await readJson('eventSheets', 'Shared', 'Helpers.json');
    const result = await server.callTool('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Helpers2' });
    expect(result.isError).not.toBe(true);
    const copy = await readJson('eventSheets', 'Shared', 'Helpers2.json');
    expect(copy.name).toBe('Helpers2');
    expect(copy.events.length).toBe(source.events.length);
    expect(copy.events[0]).toEqual({ eventType: 'include', includeSheet: 'Main' });
    const sourceSids = new Set(sidsOf(source));
    const copySids = sidsOf(copy);
    expect(copySids.length).toBe(sourceSids.size);
    expect(copySids.some(sid => sourceSids.has(sid))).toBe(false);
    expect((await readJson('project.c3proj')).eventSheets.subfolders[0].items).toEqual(['Helpers', 'Helpers2']);
  });
});

// ─── duplicate_object_type ─────────────────────────────────

describe('duplicate_object_type', () => {
  it('copies a sprite with fresh SIDs and its image files under the new name', async () => {
    await editJson(['objectTypes', 'Actors', 'Player.json'], o => {
      o.instanceVariables = [{ name: 'hp', type: 'number', desc: '', show: true, sid: 660000000000021 }];
      o.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 660000000000022 }];
      o.animations.items[0].frames[0].imageSpriteId = 7654321;
    });
    const source = await readJson('objectTypes', 'Actors', 'Player.json');
    const result = await server.callTool('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.filesCopied.map((f: any) => f.to)).toEqual(['images/hero-default-000.png', 'images/hero-idle-001.png']);
    expect(data.warnings.join(' ')).toContain('Hostiles');

    const copy = await readJson('objectTypes', 'Actors', 'Hero.json');
    expect(copy.name).toBe('Hero');
    expect(Object.keys(copy)).toEqual(Object.keys(source));
    const sourceSids = new Set(sidsOf(source));
    expect(sidsOf(copy)).toHaveLength(sourceSids.size);
    expect(sidsOf(copy).some(sid => sourceSids.has(sid))).toBe(false);
    expect(copy.animations.items[0].frames[0].imageSpriteId).not.toBe(7654321);
    expect(copy.instanceVariables[0].name).toBe('hp');

    expect(await exists('images', 'hero-default-000.png')).toBe(true);
    expect(await exists('images', 'player-default-000.png')).toBe(true);
    expect(await exists('images', 'heroship-default-000.png')).toBe(false);
    expect((await readJson('project.c3proj')).objectTypes.subfolders[0].items).toEqual(['Player', 'Hero', 'PlayerShip', 'Enemy']);
    // Families are not changed.
    expect((await readJson('families', 'Groups', 'Hostiles.json')).members).toEqual(['Enemy', 'Player']);
  });

  it('copies a tilemap with a new image ID, its image and its brush file', async () => {
    const result = await server.callTool('duplicate_object_type', { objectName: 'Tiles', newName: 'Tiles2' });
    expect(result.isError).not.toBe(true);
    const copy = await readJson('objectTypes', 'Tiles2.json');
    expect(copy.image.imageSpriteId).not.toBe(1234567);
    expect(await exists('images', 'tiles2.png')).toBe(true);
    expect(await exists('tilemapBrushes', 'objectTypes', 'Tiles2.brush.json')).toBe(true);
  });

  it('refuses a single-global object', async () => {
    await editJson(['objectTypes', 'Keyboard.json'], o => {
      o['singleglobal-inst'] = { type: 'Keyboard', properties: {}, tags: '', instanceVariables: {}, uid: 9, sid: 660000000000099 };
    });
    await reload();
    const result = await server.callTool('duplicate_object_type', { objectName: 'Keyboard', newName: 'Keyboard2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('single-global');
  });

  it('refuses a family name', async () => {
    const result = await server.callTool('duplicate_object_type', { objectName: 'Player', newName: 'hostiles' });
    expect(result.isError).toBe(true);
    expect(await exists('images', 'hostiles-default-000.png')).toBe(false);
  });

  it('refuses when a target image file already exists', async () => {
    await writeFile(join(tmpDir, 'images', 'hero-idle-001.png'), 'x');
    const result = await server.callTool('duplicate_object_type', { objectName: 'Player', newName: 'Hero' });
    expect(result.isError).toBe(true);
    expect(await exists('images', 'hero-default-000.png')).toBe(false);
    expect(await exists('objectTypes', 'Actors', 'Hero.json')).toBe(false);
  });
});

// ─── duplicate_timeline ────────────────────────────────────

describe('duplicate_timeline', () => {
  it('copies a timeline under a new name next to the source', async () => {
    const source = await readJson('timelines', 'Intro.json');
    const result = await server.callTool('duplicate_timeline', { timelineName: 'Intro', newName: 'Intro2' });
    expect(result.isError).not.toBe(true);
    const copy = await readJson('timelines', 'Intro2.json');
    expect(copy).toEqual({ ...source, name: 'Intro2' });
    expect(Object.keys(copy)).toEqual(Object.keys(source));
    expect((await readJson('project.c3proj')).timelines.items).toEqual(['Intro', 'Intro2']);
  });

  it('refuses a custom ease', async () => {
    const result = await server.callTool('duplicate_timeline', { timelineName: 'Swipe', newName: 'Swipe2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is a custom ease');
  });

  it('refuses a name already used by a transition', async () => {
    const result = await server.callTool('duplicate_timeline', { timelineName: 'Intro', newName: 'swipe' });
    expect(result.isError).toBe(true);
  });
});

// ─── move_event_block_items copy mode ──────────────────────

describe('move_event_block_items with copy', () => {
  const BLOCK = 610000000000015;
  const INNER = 610000000000019;

  it('copies actions into another block with fresh SIDs and leaves the source alone', async () => {
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'Main', sourceBlockSid: BLOCK, targetBlockSid: INNER,
      itemType: 'actions', indices: [0, 2], targetIndex: 1, copy: true,
    });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.copiedSids).toHaveLength(2);
    expect(data.movedSids).toBeUndefined();

    const sheet = await readJson('eventSheets', 'Main.json');
    const block = sheet.events[2];
    expect(block.actions.map((a: any) => a.sid).slice(0, 3)).toEqual([610000000000004, 610000000000005, 610000000000006]);
    const inner = block.children[1];
    expect(inner.actions.map((a: any) => a.id)).toEqual(['destroy', 'set-position', 'add-child']);
    expect(inner.actions[1].sid).not.toBe(610000000000004);
    expect(inner.actions[2].sid).not.toBe(610000000000006);
    expect(inner.actions.slice(1).map((a: any) => a.sid)).toEqual(data.copiedSids);
    expect(inner.actions[1].parameters).toEqual(block.actions[0].parameters);
  });

  it('copies within the same block measuring targetIndex before any removal', async () => {
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'Main', sourceBlockSid: INNER, targetBlockSid: INNER,
      itemType: 'actions', indices: [0], targetIndex: 1, copy: true,
    });
    expect(result.isError).not.toBe(true);
    const inner = (await readJson('eventSheets', 'Main.json')).events[2].children[1];
    expect(inner.actions.map((a: any) => a.id)).toEqual(['destroy', 'destroy']);
    expect(inner.actions[0].sid).toBe(610000000000018);
    expect(inner.actions[1].sid).not.toBe(610000000000018);
  });

  it('refuses to copy an else condition', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events[2].children[1].conditions.unshift({ id: 'else', objectClass: 'System', sid: 610000000000099 });
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'Main', sourceBlockSid: INNER, targetBlockSid: BLOCK,
      itemType: 'conditions', indices: [0], targetIndex: 1, copy: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot be copied');
  });
});

// ─── Review follow-ups ─────────────────────────────────────

describe('move_project_item folder names and failures', () => {
  it('reuses an existing folder that differs only by case', async () => {
    const result = await server.callTool('move_project_item', { category: 'objectType', name: 'Tiles', folder: 'actors/Sub' });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.to).toBe('Actors/Sub');
    expect(data.foldersCreated).toEqual(['Actors/Sub']);
    expect(data.warnings.join(' ')).toContain('"actors/Sub" matches the existing folder "Actors/Sub"');
    const project = await readJson('project.c3proj');
    expect(project.objectTypes.subfolders.map((f: any) => f.name)).toEqual(['Actors']);
    expect(project.objectTypes.subfolders[0].subfolders).toEqual([{ items: ['Tiles'], subfolders: [], name: 'Sub' }]);
    expect(await exists('objectTypes', 'Actors', 'Sub', 'Tiles.json')).toBe(true);
  });

  it('treats a case-only difference from the current folder as the same folder', async () => {
    const result = await server.callTool('move_project_item', { category: 'objectType', name: 'Player', folder: 'ACTORS' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already in "Actors"');
  });

  it.each([
    ['Enemies.', 'end with a space or a dot'],
    ['Enemies ', 'end with a space or a dot'],
    [' Enemies', 'must not start with a space'],
    ['a:b', 'does not allow'],
    ['what?', 'does not allow'],
    ['tab\there', 'does not allow'],
    ['CON', 'reserved on Windows'],
    ['Lpt1.txt', 'reserved on Windows'],
    ['x/nul', 'reserved on Windows'],
  ])('rejects the folder name %j', async (folder, message) => {
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(message);
    expect(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).toBe(before);
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
  });

  it('removes the copies when the project update fails', async () => {
    await writeFile(join(tmpDir, 'layouts', 'Level 1.uistate.json'), '{}');
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    vi.spyOn(writer, 'mutateProjectJson').mockRejectedValueOnce(new Error('disk full'));
    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder: 'Maps' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk full');
    expect(await exists('layouts', 'Maps', 'Level 1.json')).toBe(false);
    expect(await exists('layouts', 'Maps', 'Level 1.uistate.json')).toBe(false);
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
    expect(await exists('layouts', 'Level 1.uistate.json')).toBe(true);
    expect(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).toBe(before);
  });

  it('keeps the moved files when project.c3proj was written but could not be re-read', async () => {
    const reload = reader.reloadProject.bind(reader);
    vi.spyOn(reader, 'reloadProject')
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockImplementation(reload);
    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder: 'Maps' });
    expect(result.isError).not.toBe(true);
    expect(parse(result).warnings.join(' ')).toContain('reload failed');
    expect(await exists('layouts', 'Maps', 'Level 1.json')).toBe(true);
    expect(await exists('layouts', 'Level 1.json')).toBe(false);
    expect((await readJson('project.c3proj')).layouts.subfolders[1]).toEqual({ items: ['Level 1'], subfolders: [], name: 'Maps' });
  });

  it('warns when an old file cannot be deleted after the move', async () => {
    fsControl.failUnlink = path => path.replace(/\\/g, '/').endsWith('layouts/Level 1.json');
    const result = await server.callTool('move_project_item', { category: 'layout', name: 'Level 1', folder: 'Maps' });
    fsControl.failUnlink = null;
    expect(result.isError).not.toBe(true);
    expect(parse(result).warnings.join(' ')).toContain('Could not delete the old file layouts/Level 1.json');
    expect(await exists('layouts', 'Maps', 'Level 1.json')).toBe(true);
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
  });
});

describe('duplicate rollbacks and warnings', () => {
  it('removes a layout copy without leaving a backup when registration fails', async () => {
    vi.spyOn(writer, 'mutateProjectJson').mockRejectedValueOnce(new Error('disk full'));
    const result = await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy' });
    expect(result.isError).toBe(true);
    expect(await exists('layouts', 'Copy.json')).toBe(false);
    expect(await exists('layouts', 'Copy.json.bak')).toBe(false);
  });

  it('removes an event sheet copy without leaving a backup when registration fails', async () => {
    await editJson(['eventSheets', 'Shared', 'Helpers.json'], s => {
      s.events = s.events.filter((e: any) => e.eventType !== 'variable');
    });
    vi.spyOn(writer, 'mutateProjectJson').mockRejectedValueOnce(new Error('disk full'));
    const result = await server.callTool('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Helpers2' });
    expect(result.isError).toBe(true);
    expect(await exists('eventSheets', 'Shared', 'Helpers2.json')).toBe(false);
    expect(await exists('eventSheets', 'Shared', 'Helpers2.json.bak')).toBe(false);
  });

  it('leaves no files behind when an object type copy cannot be registered', async () => {
    vi.spyOn(writer, 'mutateProjectJson').mockRejectedValueOnce(new Error('disk full'));
    const result = await server.callTool('duplicate_object_type', { objectName: 'Tiles', newName: 'Tiles2' });
    expect(result.isError).toBe(true);
    expect(await exists('objectTypes', 'Tiles2.json')).toBe(false);
    expect(await exists('objectTypes', 'Tiles2.json.bak')).toBe(false);
    expect(await exists('images', 'tiles2.png')).toBe(false);
    expect(await exists('tilemapBrushes', 'objectTypes', 'Tiles2.brush.json')).toBe(false);
  });

  it('warns about timelines and fixed-UID picks only when they target the source layout', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events.push({
        eventType: 'block', sid: 700000000000070,
        conditions: [{ id: 'pick-by-unique-id', objectClass: 'Player', sid: 700000000000071, parameters: { 'unique-id': '1' } }],
        actions: [],
      });
    });
    const level1 = parse(await server.callTool('duplicate_layout', { layoutName: 'Level 1', newName: 'Copy 1' }));
    expect(level1.warnings.join(' ')).toContain('timelines/Intro.json');
    expect(level1.warnings.join(' ')).toContain('Event sheet(s) Main pick instances');
    // The first copy's instances have fresh UIDs that nothing addresses.
    const level2 = parse(await server.callTool('duplicate_layout', { layoutName: 'Copy 1', newName: 'Copy 2' }));
    expect((level2.warnings ?? []).join(' ')).not.toContain('Timeline');
    expect((level2.warnings ?? []).join(' ')).not.toContain('fixed UID');
  });

  it('refuses a sheet that declares a function or a group', async () => {
    await editJson(['eventSheets', 'Shared', 'Helpers.json'], s => {
      s.events = s.events.filter((e: any) => e.eventType !== 'variable');
      s.events.push({ eventType: 'function-block', functionName: 'Heal', functionReturnType: 'none', sid: 700000000000080, conditions: [], actions: [] });
      s.events.push({ eventType: 'group', title: 'Helpers group', disabled: false, sid: 700000000000081, children: [] });
    });
    const result = await server.callTool('duplicate_event_sheet', { sheetName: 'Helpers', newName: 'Helpers2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('function "Heal"');
    expect(result.content[0].text).toContain('group "Helpers group"');
    expect(await exists('eventSheets', 'Shared', 'Helpers2.json')).toBe(false);
  });

  it('refuses a timeline that sits in a named folder', async () => {
    await writeFile(join(tmpDir, 'timelines', 'Deep.json'), JSON.stringify({ name: 'Deep', tracks: [] }));
    await editJson(['project.c3proj'], p => { p.timelines.subfolders.push({ items: ['Deep'], subfolders: [], name: 'Folder' }); });
    await reload();
    const result = await server.callTool('duplicate_timeline', { timelineName: 'Deep', newName: 'Deep2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is in folder "Folder"');
    expect(await exists('timelines', 'Deep2.json')).toBe(false);
  });
});

describe('move_event_block_items copy limits', () => {
  it('refuses to copy a condition to index 0 of an else block', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events.push({ eventType: 'block', sid: 700000000000090, conditions: [{ id: 'else', objectClass: 'System', sid: 700000000000091 }], actions: [] });
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'Main', sourceBlockSid: 610000000000015, targetBlockSid: 700000000000090,
      itemType: 'conditions', indices: [0], targetIndex: 0, copy: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('else condition must stay first');
  });

  it('refuses a copy that would exceed the block item limit, including within one block', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events.push({
        eventType: 'block', sid: 700000000000095, conditions: [],
        actions: Array.from({ length: 100 }, (_, n) => ({ id: 'destroy', objectClass: 'Player', sid: 700000000001000 + n })),
      });
    });
    const before = await readFile(join(tmpDir, 'eventSheets', 'Main.json'), 'utf-8');
    for (const source of [610000000000015, 700000000000095]) {
      const result = await server.callTool('move_event_block_items', {
        sheetName: 'Main', sourceBlockSid: source, targetBlockSid: 700000000000095,
        itemType: 'actions', indices: [0], targetIndex: 0, copy: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('maximum');
    }
    expect(await readFile(join(tmpDir, 'eventSheets', 'Main.json'), 'utf-8')).toBe(before);
  });
});
