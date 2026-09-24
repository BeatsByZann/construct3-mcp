/**
 * Regression tests for the 2026-09-17 fork-review findings fixed in the
 * roadmap run of 2026-09-24 (roadmap items A-O3, A-N1, A-N3, A-E1, A-E3).
 * Each test fails when its fix is reverted. They run on a temp copy of
 * test/fixtures/rename-project: layout "Level 1" has a top-level layer Game
 * with a sub-layer UI, object types Player and Enemy, family Hostiles, and
 * sheets Main and Shared/Helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerRenameTools } from '../../src/tools/rename-tools.js';
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

async function writeJson(data: unknown, ...segments: string[]): Promise<void> {
  await writeFile(join(tmpDir, ...segments), JSON.stringify(data, null, '\t'), 'utf-8');
}

async function exists(...segments: string[]): Promise<boolean> {
  try {
    await stat(join(tmpDir, ...segments));
    return true;
  } catch {
    return false;
  }
}

function findBySid(events: any[], sid: number): any {
  for (const e of events) {
    if (e.sid === sid) return e;
    const hit = Array.isArray(e.children) ? findBySid(e.children, sid) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-review-defects-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  registerRenameTools({ server, reader, writer, idGen } as any);
  registerEventTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('A-O3 delete_layer counts sub-layers and their instances', () => {
  async function addTopLevelLayer(): Promise<void> {
    // Game is the only top-level layer, so give the layout a second one.
    const layout = await readJson('layouts', 'Level 1.json');
    layout.layers.push({ name: 'HUD', sid: 999000000000001, instances: [] });
    await writeJson(layout, 'layouts', 'Level 1.json');
  }

  it('refuses without force when only the sub-layers hold instances', async () => {
    await addTopLevelLayer();
    // Move Game's own instances away so the parent looks empty by itself.
    const layout = await readJson('layouts', 'Level 1.json');
    layout.layers[0].subLayers[0].instances.push(...layout.layers[0].instances.splice(0));
    await writeJson(layout, 'layouts', 'Level 1.json');

    const result = parse(await server.callTool('delete_layer', { layoutName: 'Level 1', layerName: 'Game' }));
    expect(result.success).toBe(false);
    expect(result.action).toBe('delete_blocked');
    expect(result.subLayers).toEqual(['UI']);
    expect(result.instanceCount).toBe(3);
    expect(result.message).toContain('0 instance(s) of its own');
    expect(result.message).toContain('1 sub-layer(s) (UI) holding 3 more');

    const after = await readJson('layouts', 'Level 1.json');
    expect(after.layers.map((l: any) => l.name)).toEqual(['Game', 'HUD']);
  });

  it('refuses an empty parent whose sub-layers are empty too, and deletes them all with force', async () => {
    await addTopLevelLayer();
    const layout = await readJson('layouts', 'Level 1.json');
    layout.layers[0].instances = [];
    layout.layers[0].subLayers[0].instances = [];
    await writeJson(layout, 'layouts', 'Level 1.json');

    const refused = parse(await server.callTool('delete_layer', { layoutName: 'Level 1', layerName: 'Game' }));
    expect(refused.action).toBe('delete_blocked');
    expect(refused.subLayers).toEqual(['UI']);

    const forced = parse(await server.callTool('delete_layer', { layoutName: 'Level 1', layerName: 'Game', force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('1 sub-layer(s) (UI)');
    const after = await readJson('layouts', 'Level 1.json');
    expect(after.layers.map((l: any) => l.name)).toEqual(['HUD']);
  });

  it('deletes a sub-layer by name, with force for its instance', async () => {
    const refused = parse(await server.callTool('delete_layer', { layoutName: 'Level 1', layerName: 'UI' }));
    expect(refused.action).toBe('delete_blocked');
    expect(refused.instanceCount).toBe(1);

    const forced = parse(await server.callTool('delete_layer', { layoutName: 'Level 1', layerName: 'UI', force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings.join(' ')).toContain('1 instance(s) (1 of its own, 0 on sub-layers)');
    const after = await readJson('layouts', 'Level 1.json');
    expect(after.layers.map((l: any) => l.name)).toEqual(['Game']);
    expect(after.layers[0].subLayers).toEqual([]);
    expect(after.layers[0].instances).toHaveLength(2);
  });

  it('still refuses to delete the last top-level layer', async () => {
    const result = await server.callTool('delete_layer', { layoutName: 'Level 1', layerName: 'Game', force: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('last layer');
  });
});

describe('A-N1 renames compare names without case', () => {
  it('refuses an object type rename that differs from another object only by case', async () => {
    const result = await server.callTool('rename_object_type', { name: 'Player', newName: 'enemy' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Enemy" already exists');
    expect((await readJson('objectTypes', 'Actors', 'Enemy.json')).name).toBe('Enemy');
    expect((await readJson('objectTypes', 'Actors', 'Player.json')).name).toBe('Player');
  });

  it('refuses a family, layout and event sheet rename onto a case variant of an existing name', async () => {
    const layout = await readJson('layouts', 'Level 1.json');
    layout.name = 'Level 1';
    await writeJson(layout, 'layouts', 'Level 1.json');
    const family = await server.callTool('rename_family', { name: 'Hostiles', newName: 'PLAYER' });
    expect(family.isError).toBe(true);
    expect(family.content[0].text).toContain('"Player" already exists');

    const sheet = await server.callTool('rename_event_sheet', { name: 'Main', newName: 'helpers' });
    expect(sheet.isError).toBe(true);
    expect(sheet.content[0].text).toContain('"Helpers" already exists');
  });

  it('refuses a rename that only changes the case of the same name, which would delete the file', async () => {
    // The rename writes the new file and then deletes the old; on Windows
    // those are one file, so Main.json was being deleted.
    const result = await server.callTool('rename_event_sheet', { name: 'Main', newName: 'MAIN' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('only in case');
    expect(await exists('eventSheets', 'Main.json')).toBe(true);
    expect((await readJson('eventSheets', 'Main.json')).name).toBe('Main');

    const layout = await server.callTool('rename_layout', { name: 'Level 1', newName: 'level 1' });
    expect(layout.isError).toBe(true);
    expect(layout.content[0].text).toContain('only in case');
    expect(await exists('layouts', 'Level 1.json')).toBe(true);
  });
});

describe('A-N3 renaming a local variable stays inside its container', () => {
  const GROUP_A = 620000000000001;
  const GROUP_B = 620000000000002;
  const LOCAL_A = 620000000000003;
  const LOCAL_B = 620000000000004;

  function group(sid: number, title: string, localSid: number, use: string) {
    return {
      eventType: 'group', sid, title, description: '', isActiveOnStart: true, children: [
        { eventType: 'variable', sid: localSid, name: 'Score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false },
        {
          eventType: 'block', sid: localSid + 10,
          conditions: [{ id: 'every-tick', objectClass: 'System', sid: localSid + 11 }],
          actions: [{ id: 'set-eventvar-value', objectClass: 'System', sid: localSid + 12, parameters: { variable: 'Score', value: use } }],
        },
      ],
    };
  }

  beforeEach(async () => {
    const sheet = await readJson('eventSheets', 'Main.json');
    sheet.events = [group(GROUP_A, 'A', LOCAL_A, 'Score + 1'), group(GROUP_B, 'B', LOCAL_B, 'Score * 2')];
    await writeJson(sheet, 'eventSheets', 'Main.json');
    resetProjectIndex();
  });

  it('rewrites only the declaring group and leaves a sibling group\'s local alone', async () => {
    const result = parse(await server.callTool('rename_event_variable', { sheetName: 'Main', sid: LOCAL_A, newName: 'points' }));
    expect(result.success).toBe(true);
    expect(result.references.byKind).toEqual({ variableDeclaration: 1, variableParameter: 1, expression: 1 });
    expect(result.warnings.join(' ')).not.toContain('rewritten too');

    const events = (await readJson('eventSheets', 'Main.json')).events;
    expect(findBySid(events, LOCAL_A).name).toBe('points');
    expect(findBySid(events, LOCAL_A + 10).actions[0].parameters).toEqual({ variable: 'points', value: 'points + 1' });
    expect(findBySid(events, LOCAL_B).name).toBe('Score');
    expect(findBySid(events, LOCAL_B + 10).actions[0].parameters).toEqual({ variable: 'Score', value: 'Score * 2' });
  });

  it('lists only the declaring group\'s sites in a dry run', async () => {
    const result = parse(await server.callTool('rename_event_variable', { sheetName: 'Main', sid: LOCAL_B, newName: 'tally', dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.references.total).toBe(3);
    expect(result.references.byFile).toEqual([{ file: 'eventSheets/Main.json', count: 3, kinds: { variableDeclaration: 1, variableParameter: 1, expression: 1 } }]);
  });
});

describe('A-E1 an else block must follow an event block', () => {
  it('refuses an else with nothing before it, or after a group, and accepts one after a block', async () => {
    const empty = await server.callTool('add_event_block', {
      sheetName: 'Main', isElse: true, conditions: [], actions: [], position: 'start',
    });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain('cannot be the first event');

    // Main's last root event is the group "Hostile handling".
    const afterGroup = await server.callTool('add_event_block', {
      sheetName: 'Main', isElse: true, conditions: [], actions: [],
    });
    expect(afterGroup.isError).toBe(true);
    expect(afterGroup.content[0].text).toContain('"group" event');

    const block = parse(await server.callTool('add_event_block', {
      sheetName: 'Main', conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [],
    }));
    const elseBlock = parse(await server.callTool('add_event_block', {
      sheetName: 'Main', isElse: true, conditions: [], actions: [], siblingSid: block.generatedSid, position: 'after',
    }));
    expect(elseBlock.success).toBe(true);

    // Moving the else to the front loses its partner; moving the partner away warns.
    const moved = await server.callTool('move_event_block', { sheetName: 'Main', sid: elseBlock.generatedSid, position: 'start' });
    expect(moved.isError).toBe(true);
    expect(moved.content[0].text).toContain('cannot be the first event');
    const partnerMoved = parse(await server.callTool('move_event_block', { sheetName: 'Main', sid: block.generatedSid, position: 'start' }));
    expect(partnerMoved.success).toBe(true);
    expect(partnerMoved.warnings.join(' ')).toContain('no longer follows an event block');
  });
});

describe('A-E3 update_function reports a write that failed part way', () => {
  it('writes callers first, names the sheets written, and resumes on the same call', async () => {
    const def = parse(await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Hostiles', aceName: 'Retreat' }));
    const call = parse(await server.callTool('add_event_block', {
      sheetName: 'Helpers',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ customAction: 'Retreat', objectClass: 'Hostiles' }],
    }));

    const original = writer.writeEntityFile.bind(writer);
    const spy = vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, data, subfolder) => {
      if (name === 'Main') throw new Error('disk full');
      return original(category, name, data, subfolder);
    });
    const failed = await server.callTool('update_function', { sheetName: 'Main', sid: def.generatedSid, functionName: 'Flee', renameCallers: true });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('disk full');
    expect(failed.content[0].text).toContain('Sheets already written (in order): Helpers; not written: Main');
    spy.mockRestore();

    // The caller was renamed, the definition was not, and the same call finishes the job.
    const helpers = await readJson('eventSheets', 'Shared', 'Helpers.json');
    expect(findBySid(helpers.events, call.generatedSid).actions[0].customAction).toBe('Flee');
    expect(findBySid((await readJson('eventSheets', 'Main.json')).events, def.generatedSid).aceName).toBe('Retreat');

    const resumed = parse(await server.callTool('update_function', { sheetName: 'Main', sid: def.generatedSid, functionName: 'Flee', renameCallers: true }));
    expect(resumed.success).toBe(true);
    expect(findBySid((await readJson('eventSheets', 'Main.json')).events, def.generatedSid).aceName).toBe('Flee');
  });
});
