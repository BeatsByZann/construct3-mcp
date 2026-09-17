/**
 * Real-reader/writer tests for the rename tools.
 *
 * Each test runs against a temp copy of `test/fixtures/rename-project`, whose
 * `Main` sheet deliberately exercises every reference kind the scanner
 * rewrites: objectClass on conditions and actions, a custom-ace-block owner,
 * the bare-name parameter keys, expression text (including a decoy string
 * literal and a `PlayerShip` near-miss), array-form custom-action arguments,
 * `layer` and `layout` parameters in both their bare and quoted forms, the
 * `variable` key next to an `instance-variable` decoy, an include, layout
 * instance types in a nested sub-layer and a non-world instance, family
 * members, and `containers[].members`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat, mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerRenameTools } from '../../src/tools/rename-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function readJson(...segments: string[]): Promise<any> {
  return JSON.parse(await readFile(join(tmpDir, ...segments), 'utf-8'));
}

async function exists(...segments: string[]): Promise<boolean> {
  try {
    await stat(join(tmpDir, ...segments));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-rename-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });

  // Images are generated rather than committed, so the fixture stays text-only.
  await mkdir(join(tmpDir, 'images'), { recursive: true });
  for (const name of ['player-default-000.png', 'player-idle-001.png', 'playership-default-000.png', 'tiles.png']) {
    await writeFile(join(tmpDir, 'images', name), generatePlaceholderPng(1, 1));
  }

  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerRenameTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('rename_object_type', () => {
  it('reports every reference kind and writes nothing on a dry run', async () => {
    const result = parseResult(await server.callTool('rename_object_type', {
      name: 'Player', newName: 'Hero', dryRun: true,
    }));

    expect(result.action).toBe('dry-run');
    expect(result.filesWritten).toEqual([]);
    expect(result.references.byKind).toEqual({
      objectClass: 4,
      parameterObjectName: 3,
      expression: 6,
      instanceType: 2,
      familyMember: 1,
      containerMember: 1,
      projectTree: 1,
      entityName: 1,
      entityFile: 1,
      imageFile: 2,
    });
    // Player owns no custom action, and the Tilemap brush file belongs to Tiles.
    expect(result.references.byKind.customAceObjectClass).toBeUndefined();
    expect(result.references.byKind.tilemapBrushFile).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('script bodies, comments or variable initial values');

    // Nothing on disk moved.
    expect(await exists('objectTypes', 'Actors', 'Player.json')).toBe(true);
    expect(await exists('objectTypes', 'Actors', 'Hero.json')).toBe(false);
    const sheet = await readJson('eventSheets', 'Main.json');
    expect(JSON.stringify(sheet)).not.toContain('Hero');
  });

  /**
   * Revert check (a): dropping the `objectClass` branch from
   * collectObjectNameRefsInSheet makes this fail.
   */
  it('rewrites objectClass on conditions, actions and the custom-action owner', async () => {
    const result = parseResult(await server.callTool('rename_object_type', { name: 'Player', newName: 'Hero' }));
    expect(result.success).toBe(true);

    const sheet = await readJson('eventSheets', 'Main.json');
    const block = sheet.events[2];
    expect(block.conditions[0].objectClass).toBe('System');
    expect(block.actions[0].objectClass).toBe('Hero');
    expect(block.actions[3].objectClass).toBe('Hero');
    expect(JSON.stringify(sheet)).not.toContain('"objectClass": "Player"');
    expect(result.references.byKind.objectClass).toBeGreaterThan(0);

    const family = sheet.events[3].children[0];
    expect(family.objectClass).toBe('Hostiles');
  });

  it('rewrites bare-name parameters and expression text without touching near-misses', async () => {
    await server.callTool('rename_object_type', { name: 'Player', newName: 'Hero' });
    const sheet = await readJson('eventSheets', 'Main.json');
    const block = sheet.events[2];

    expect(block.conditions[1].parameters.object).toBe('Hero');
    expect(block.conditions[1].parameters.expression).toBe('Hero.X > Hostiles.health');
    expect(block.actions[1].parameters['object-to-create']).toBe('Hero');
    expect(block.actions[2].parameters.parent).toBe('Hero');
    expect(block.actions[2].parameters.child).toBe('Enemy');

    // PlayerShip is a different object type; Enemy.Player is a member name.
    expect(block.actions[0].parameters.x).toBe('Hero.X + PlayerShip.X');
    expect(block.actions[0].parameters.y).toBe('Enemy.Player + 10');

    // Revert check (d): the "Player wins" and " PlayerShip" literals survive.
    expect(block.actions[3].parameters.text).toBe('"Player wins" & Hero.AnimationName & " PlayerShip"');

    // Array-form custom action arguments.
    expect(sheet.events[3].children[0].actions[0].parameters).toEqual(['Hero.UID', '"Player"', 'score']);

    // Script bodies and comments are left alone, and reported as a warning.
    expect(JSON.stringify(block.actions[11].script)).toContain('Player');
    expect(sheet.events[1].text).toContain('Player');
  });

  it('rewrites layout instances, family members, containers and the registration', async () => {
    await server.callTool('rename_object_type', { name: 'Player', newName: 'Hero' });

    const level1 = await readJson('layouts', 'Level 1.json');
    expect(level1.layers[0].instances[0].type).toBe('Hero');
    expect(level1.layers[0].subLayers[0].instances[0].type).toBe('Hero');
    expect(level1.layers[0].instances[1].type).toBe('Enemy');

    const family = await readJson('families', 'Groups', 'Hostiles.json');
    expect(family.members).toEqual(['Enemy', 'Hero']);

    const project = await readJson('project.c3proj');
    expect(project.containers[0].members).toEqual(['Hero', 'Enemy']);
    // Renamed in place: position and subfolder are preserved.
    expect(project.objectTypes.subfolders[0].items).toEqual(['Hero', 'PlayerShip', 'Enemy']);

    expect(await exists('objectTypes', 'Actors', 'Hero.json')).toBe(true);
    expect(await exists('objectTypes', 'Actors', 'Player.json')).toBe(false);
    expect((await readJson('objectTypes', 'Actors', 'Hero.json')).name).toBe('Hero');
  });

  /**
   * Revert check (b): skipping the image-file rename makes this fail.
   */
  it('renames the object type\'s image files and leaves another object\'s alone', async () => {
    const result = parseResult(await server.callTool('rename_object_type', { name: 'Player', newName: 'Hero' }));

    const images = (await readdir(join(tmpDir, 'images'))).sort();
    expect(images).toEqual(['hero-default-000.png', 'hero-idle-001.png', 'playership-default-000.png', 'tiles.png']);
    expect(result.filesWritten).toContain('images/hero-default-000.png');
    expect(result.references.byKind.imageFile).toBe(2);
  });

  it('rewrites a non-world instance type', async () => {
    const result = parseResult(await server.callTool('rename_object_type', { name: 'Keyboard', newName: 'Keys' }));
    expect(result.references.byKind.instanceType).toBe(1);
    const layout = await readJson('layouts', 'Level 1.json');
    expect(layout['nonworld-instances'][0].type).toBe('Keys');
    expect((await readJson('project.c3proj')).objectTypes.items).toEqual(['Tiles', 'Keys']);
  });

  it('moves the tilemap brush file with its object type', async () => {
    const result = parseResult(await server.callTool('rename_object_type', { name: 'Tiles', newName: 'Ground' }));
    expect(result.references.byKind.tilemapBrushFile).toBe(1);
    expect(await exists('tilemapBrushes', 'objectTypes', 'Ground.brush.json')).toBe(true);
    expect(await exists('tilemapBrushes', 'objectTypes', 'Tiles.brush.json')).toBe(false);
    expect(await exists('images', 'ground.png')).toBe(true);
  });

  it('refuses a name that collides with an object type or a family', async () => {
    const objectClash = await server.callTool('rename_object_type', { name: 'Player', newName: 'Enemy' });
    expect(objectClash.isError).toBe(true);
    expect(objectClash.content[0].text).toContain('already exists');

    const familyClash = await server.callTool('rename_object_type', { name: 'Player', newName: 'Hostiles' });
    expect(familyClash.isError).toBe(true);
    expect(familyClash.content[0].text).toContain('family');

    // Nothing was written by either refusal.
    expect(await exists('objectTypes', 'Actors', 'Player.json')).toBe(true);
  });

  it('refuses an unknown object type and an invalid new name', async () => {
    const missing = await server.callTool('rename_object_type', { name: 'Nope', newName: 'Hero' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('not found');

    const invalid = await server.callTool('rename_object_type', { name: 'Player', newName: '9Bad' });
    expect(invalid.isError).toBe(true);
  });

  it('is idempotent enough to resume: a second identical call finds nothing left to rewrite', async () => {
    await server.callTool('rename_object_type', { name: 'Player', newName: 'Hero' });
    const second = await server.callTool('rename_object_type', { name: 'Player', newName: 'Hero' });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('not found');

    // And the renamed project still has no stale reference.
    const dump = JSON.stringify([
      await readJson('eventSheets', 'Main.json'),
      await readJson('layouts', 'Level 1.json'),
      await readJson('project.c3proj'),
    ]);
    expect(dump).not.toContain('"objectClass": "Player"');
    expect(dump).not.toContain('"type": "Player"');
  });
});

describe('rename_family', () => {
  it('rewrites objectClass, the custom-action owner, expressions and the registration', async () => {
    const result = parseResult(await server.callTool('rename_family', { name: 'Hostiles', newName: 'Threats' }));
    expect(result.success).toBe(true);

    const sheet = await readJson('eventSheets', 'Main.json');
    const custom = sheet.events[3].children[0];
    expect(custom.objectClass).toBe('Threats');
    expect(custom.conditions[0].objectClass).toBe('Threats');
    expect(custom.conditions[0].parameters.value).toBe('Threats.health');
    expect(sheet.events[2].conditions[1].parameters.expression).toBe('Player.X > Threats.health');

    const project = await readJson('project.c3proj');
    expect(project.families.subfolders[0].items).toEqual(['Threats']);
    expect(await exists('families', 'Groups', 'Threats.json')).toBe(true);
    expect(await exists('families', 'Groups', 'Hostiles.json')).toBe(false);
    // Members are object types and are untouched by a family rename.
    expect((await readJson('families', 'Groups', 'Threats.json')).members).toEqual(['Enemy', 'Player']);
  });
});

describe('rename_layout', () => {
  /**
   * Revert check (c): dropping the `firstLayout` rewrite makes this fail.
   */
  it('rewrites firstLayout, the tree, the timeline and the layout parameters', async () => {
    const result = parseResult(await server.callTool('rename_layout', { name: 'Level 1', newName: 'Stage 1' }));
    expect(result.success).toBe(true);
    expect(result.references.byKind.firstLayout).toBe(1);

    const project = await readJson('project.c3proj');
    expect(project.firstLayout).toBe('Stage 1');
    expect(project.layouts.items).toEqual(['Stage 1']);

    expect((await readJson('timelines', 'Intro.json')).startOnLayout).toBe('Stage 1');
    expect(result.references.byKind.timelineStartOnLayout).toBe(1);

    expect(await exists('layouts', 'Stage 1.json')).toBe(true);
    expect(await exists('layouts', 'Level 1.json')).toBe(false);
    expect((await readJson('layouts', 'Stage 1.json')).name).toBe('Stage 1');
  });

  it('rewrites both layout parameter forms and leaves firstLayout alone for another layout', async () => {
    const result = parseResult(await server.callTool('rename_layout', { name: 'Level 2', newName: 'Stage 2' }));
    expect(result.references.byKind.firstLayout).toBeUndefined();
    expect(result.references.byKind.layoutParameter).toBe(2);

    const sheet = await readJson('eventSheets', 'Main.json');
    expect(sheet.events[2].actions[6].parameters.layout).toBe('Stage 2');
    expect(sheet.events[2].actions[7].parameters.layout).toBe('"Stage 2"');

    const project = await readJson('project.c3proj');
    expect(project.firstLayout).toBe('Level 1');
    expect(project.layouts.subfolders[0].items).toEqual(['Stage 2']);
    expect(await exists('layouts', 'Extra', 'Stage 2.json')).toBe(true);
  });

  it('refuses a colliding layout name', async () => {
    const result = await server.callTool('rename_layout', { name: 'Level 1', newName: 'Level 2' });
    expect(result.isError).toBe(true);
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
  });
});

describe('rename_event_sheet', () => {
  it('rewrites the layout binding, includes and the registration', async () => {
    const result = parseResult(await server.callTool('rename_event_sheet', { name: 'Main', newName: 'Core' }));
    expect(result.success).toBe(true);
    expect(result.references.byKind.layoutEventSheet).toBe(1);
    expect(result.references.byKind.includeSheet).toBe(1);

    expect((await readJson('layouts', 'Level 1.json')).eventSheet).toBe('Core');
    expect((await readJson('layouts', 'Extra', 'Level 2.json')).eventSheet).toBe('Helpers');
    expect((await readJson('eventSheets', 'Shared', 'Helpers.json')).events[0].includeSheet).toBe('Core');

    const project = await readJson('project.c3proj');
    expect(project.eventSheets.items).toEqual(['Core']);
    expect(await exists('eventSheets', 'Core.json')).toBe(true);
    expect(await exists('eventSheets', 'Main.json')).toBe(false);
    expect((await readJson('eventSheets', 'Core.json')).name).toBe('Core');
  });
});

describe('rename_layer', () => {
  it('renames the layer and rewrites parameter and literal references', async () => {
    const result = parseResult(await server.callTool('rename_layer', {
      layoutName: 'Level 1', layerName: 'UI', newName: 'HUD',
    }));
    expect(result.success).toBe(true);
    expect(result.references.byKind.layerName).toBe(1);
    expect(result.references.byKind.layerParameter).toBe(4);
    expect(result.references.byKind.layerLiteral).toBe(2);

    const layout = await readJson('layouts', 'Level 1.json');
    expect(layout.layers[0].subLayers[0].name).toBe('HUD');

    const main = await readJson('eventSheets', 'Main.json');
    expect(main.events[2].actions[1].parameters.layer).toBe('"HUD"');
    expect(main.events[2].actions[8].parameters.scale).toBe('LayerScale("HUD") + 0.1');
    expect(main.events[2].actions[9].parameters.layer).toBe('HUD');
    expect(main.events[2].actions[10].parameters.layer).toBe('Self.LayerName');

    const helpers = await readJson('eventSheets', 'Shared', 'Helpers.json');
    expect(helpers.events[2].actions[1].parameters['scroll-x']).toBe('ViewportLeft("HUD")');
    expect(helpers.events[2].actions[1].parameters['scroll-y']).toBe('ViewportTop("Shared")');
  });

  it('skips the sheet rewrite, with a warning, when another layout has the same layer name', async () => {
    const result = parseResult(await server.callTool('rename_layer', {
      layoutName: 'Level 1', layerName: 'Game', newName: 'World',
    }));
    expect(result.success).toBe(true);
    expect(result.references.byKind).toEqual({ layerName: 1 });
    expect(result.warnings.join(' ')).toContain('Level 2');

    expect((await readJson('layouts', 'Level 1.json')).layers[0].name).toBe('World');
    expect((await readJson('layouts', 'Extra', 'Level 2.json')).layers[0].name).toBe('Game');
  });

  it('refuses an unknown layer and a name already used in the same layout', async () => {
    const missing = await server.callTool('rename_layer', { layoutName: 'Level 1', layerName: 'Nope', newName: 'X' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Layers in this layout');

    const clash = await server.callTool('rename_layer', { layoutName: 'Level 1', layerName: 'UI', newName: 'Game' });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('unique within a layout');
  });
});

describe('rename_event_variable', () => {
  it('rewrites a global variable across every sheet', async () => {
    const result = parseResult(await server.callTool('rename_event_variable', {
      sheetName: 'Main', sid: 610000000000001, newName: 'points',
    }));
    expect(result.success).toBe(true);
    expect(result.references.byKind.variableDeclaration).toBe(1);
    // One "variable"-keyed parameter in each sheet.
    expect(result.references.byKind.variableParameter).toBe(2);

    const main = await readJson('eventSheets', 'Main.json');
    expect(main.events[0].name).toBe('points');
    expect(main.events[2].actions[4].parameters).toMatchObject({ variable: 'points', value: 'points + Player.X' });
    // The instance-variable decoy keeps the old name: a different namespace.
    expect(main.events[2].actions[5].parameters['instance-variable']).toBe('score');
    expect(main.events[2].children[1].conditions[0].parameters.value).toBe('localTally + points');
    expect(main.events[3].children[0].actions[0].parameters).toContain('points');

    const helpers = await readJson('eventSheets', 'Shared', 'Helpers.json');
    expect(helpers.events[2].actions[0].parameters).toMatchObject({ variable: 'points', value: 'points + Player.X' });
  });

  it('keeps a local variable inside its own sheet', async () => {
    const result = parseResult(await server.callTool('rename_event_variable', {
      sheetName: 'Main', sid: 610000000000016, newName: 'tally',
    }));
    expect(result.success).toBe(true);
    expect(result.warnings.join(' ')).toContain('local variable');
    expect(result.references.byFile.map((entry: { file: string }) => entry.file))
      .toEqual(['eventSheets/Main.json']);

    const main = await readJson('eventSheets', 'Main.json');
    expect(main.events[2].children[0].name).toBe('tally');
    expect(main.events[2].children[1].conditions[0].parameters.variable).toBe('tally');
    expect(main.events[2].children[1].conditions[0].parameters.value).toBe('tally + score');
  });

  it('reports a dry run and refuses a duplicate name or a non-variable SID', async () => {
    const dry = parseResult(await server.callTool('rename_event_variable', {
      sheetName: 'Main', sid: 610000000000001, newName: 'points', dryRun: true,
    }));
    expect(dry.filesWritten).toEqual([]);
    expect((await readJson('eventSheets', 'Main.json')).events[0].name).toBe('score');

    // A global colliding with another sheet's global is refused...
    const clash = await server.callTool('rename_event_variable', {
      sheetName: 'Main', sid: 610000000000001, newName: 'highScore',
    });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('global event variable named "highScore"');

    // ...while a local of the same name is allowed but warned about.
    const shadow = parseResult(await server.callTool('rename_event_variable', {
      sheetName: 'Main', sid: 610000000000001, newName: 'localTally', dryRun: true,
    }));
    expect(shadow.warnings.join(' ')).toContain('A local variable named "localTally"');

    const wrongKind = await server.callTool('rename_event_variable', {
      sheetName: 'Main', sid: 610000000000015, newName: 'points',
    });
    expect(wrongKind.isError).toBe(true);
    expect(wrongKind.content[0].text).toContain('not a variable event');
  });
});
