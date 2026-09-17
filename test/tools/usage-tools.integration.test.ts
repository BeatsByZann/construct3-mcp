/**
 * Read-only usage queries on a temp copy of test/fixtures/rename-project,
 * extended in setup with behaviors, effects, a script file and events that
 * use them. Every test also checks that nothing on disk changed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerUsageTools } from '../../src/tools/usage-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let server: MockServer;
let snapshot: string;

function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function editJson(rel: string, fn: (data: any) => void) {
  const path = join(tmpDir, rel);
  const data = JSON.parse(await readFile(path, 'utf-8'));
  fn(data);
  await writeFile(path, JSON.stringify(data, null, '\t'));
}

async function tree(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d)) {
      const p = join(d, entry);
      if ((await stat(p)).isDirectory()) await walk(p);
      else out.push(`${p}:${await readFile(p, 'utf-8')}`);
    }
  };
  await walk(dir);
  return out.sort().join('\n');
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-usage-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });

  await editJson('objectTypes/Actors/Player.json', o => {
    o.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 700000000000001 }];
    o.effectTypes = [{ effectId: 'hsladjust', name: 'Tint' }];
  });
  await editJson('families/Groups/Hostiles.json', f => {
    f.behaviorTypes = [{ behaviorId: 'Sin', name: 'Wobble', sid: 700000000000002 }];
  });
  await editJson('layouts/Level 1.json', l => {
    l.effectTypes = [{ effectId: 'hsladjust', name: 'hsladjust', instance: { isEnabled: true, parameters: {} } }];
    const player = l.layers[0].instances.find((i: any) => i.type === 'Player');
    player.behaviors = { Platform: { properties: { 'max-speed': 400 } } };
    player.effects = { Tint: { isEnabled: false, parameters: {} } };
    const enemy = l.layers[0].instances.find((i: any) => i.type === 'Enemy');
    enemy.instanceVariables = { ...(enemy.instanceVariables ?? {}), health: 7 };
  });
  await editJson('eventSheets/Main.json', s => {
    s.events.push({
      eventType: 'block', sid: 700000000000010,
      conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', sid: 700000000000011 }],
      actions: [
        { id: 'set-enabled', objectClass: 'Enemy', behaviorType: 'Wobble', sid: 700000000000012, parameters: { state: 'enabled' } },
        { id: 'set-instvar-value', objectClass: 'Hostiles', sid: 700000000000013, parameters: { 'instance-variable': 'health', value: '5' } },
        { callFunction: 'Hurt', sid: 700000000000014, parameters: ['Enemy.health - 1'] },
        { type: 'comment', text: 'Needle comment for search' },
      ],
    });
  });
  await mkdir(join(tmpDir, 'scripts'), { recursive: true });
  await writeFile(join(tmpDir, 'scripts', 'main.js'), 'const x = 1;\n// needle in a script\n');
  await editJson('project.c3proj', p => {
    p.rootFileFolders.script.items.push({ name: 'main.js', type: 'application/javascript', sid: 700000000000020 });
  });

  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  server = new MockServer();
  registerUsageTools(server as any, reader);
  snapshot = await tree(tmpDir);
});

afterEach(async () => {
  expect(await tree(tmpDir)).toBe(snapshot);
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('get_project_properties', () => {
  it('returns the whole properties bag and top-level settings, without entity trees', async () => {
    const data = parse(await server.callTool('get_project_properties', {}));
    expect(Object.keys(data.properties).length).toBe(37);
    expect(data.topLevel).toHaveProperty('bundleAddons', false);
    expect(data.topLevel).not.toHaveProperty('objectTypes');
    expect(data.topLevel).not.toHaveProperty('rootFileFolders');
  });
});

describe('search_project', () => {
  it('finds text in event sheets and script files, case-insensitively by default', async () => {
    const data = parse(await server.callTool('search_project', { query: 'NEEDLE' }));
    expect(data.totalHits).toBe(2);
    const where = data.hits.map((h: any) => [h.where, h.file]);
    expect(where).toContainEqual(['event-sheet', 'Main']);
    expect(where).toContainEqual(['script', 'scripts/main.js']);
    expect(data.hits.find((h: any) => h.where === 'event-sheet').eventSid).toBe(700000000000010);
    expect(data.hits.find((h: any) => h.where === 'script').path).toBe('line 2');
  });

  it('honours case, whole-word, regex, scope and the result limit', async () => {
    expect(parse(await server.callTool('search_project', { query: 'NEEDLE', caseSensitive: true })).totalHits).toBe(0);
    expect(parse(await server.callTool('search_project', { query: 'needl', wholeWord: true })).totalHits).toBe(0);
    expect(parse(await server.callTool('search_project', { query: 'Enemy\\.health', regex: true })).totalHits).toBe(1);
    expect(parse(await server.callTool('search_project', { query: 'needle', scopes: ['scripts'] })).totalHits).toBe(1);
    const limited = parse(await server.callTool('search_project', { query: 'Player', maxResults: 1 }));
    expect(limited.returned).toBe(1);
    expect(limited.truncated).toBe(true);
    const bad = await server.callTool('search_project', { query: '(', regex: true });
    expect(bad.isError).toBe(true);
  });

  it('searches layout instance values when asked', async () => {
    const data = parse(await server.callTool('search_project', { query: '400', scopes: ['layouts'] }));
    expect(data.totalHits).toBe(0); // numbers are not text
    const named = parse(await server.callTool('search_project', { query: 'Player', scopes: ['layouts'] }));
    expect(named.hits.every((h: any) => h.where === 'layout')).toBe(true);
  });
});

describe('find_behavior_usage', () => {
  it('reports declarations, event references and instance settings', async () => {
    const data = parse(await server.callTool('find_behavior_usage', { behaviorName: 'Platform' }));
    expect(data.declarations).toEqual([{ owner: 'Player', ownerKind: 'object', name: 'Platform', behaviorId: 'Platform' }]);
    expect(data.eventReferenceCount).toBe(1);
    expect(data.eventReferences[0]).toMatchObject({ objectClass: 'Player', context: 'condition', eventSheet: 'Main' });
    expect(data.instanceSettings).toEqual([expect.objectContaining({ uid: 1, behavior: 'Platform', properties: { 'max-speed': 400 } })]);
  });

  it('follows a family behavior to calls on its members', async () => {
    const data = parse(await server.callTool('find_behavior_usage', { behaviorId: 'Sin' }));
    expect(data.declarations[0]).toMatchObject({ owner: 'Hostiles', ownerKind: 'family', name: 'Wobble' });
    expect(data.eventReferences).toEqual([expect.objectContaining({ objectClass: 'Enemy', behaviorType: 'Wobble', context: 'action' })]);
  });

  it('requires a behavior name or id', async () => {
    expect((await server.callTool('find_behavior_usage', {})).isError).toBe(true);
  });
});

describe('find_effect_usage', () => {
  it('lists object type, layout and instance uses of an effect', async () => {
    const data = parse(await server.callTool('find_effect_usage', { effectId: 'hsladjust' }));
    expect(data.uses).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: 'objectType', target: 'Player', name: 'Tint' }),
      expect.objectContaining({ targetType: 'layout', target: 'Level 1' }),
    ]));
    expect(data.instanceStates).toEqual([expect.objectContaining({ uid: 1, effect: 'Tint', isEnabled: false })]);
  });
});

describe('find_instance_variable_references', () => {
  it('finds ACE parameters and expressions, including call arguments, and stored values', async () => {
    const data = parse(await server.callTool('find_instance_variable_references', { familyName: 'Hostiles', variableName: 'health' }));
    const kinds = data.references.map((r: any) => [r.kind, r.field]);
    expect(kinds).toContainEqual(['ace-parameter', 'instance-variable']);
    expect(kinds).toContainEqual(['expression', 'parameters[0]']);
    expect(data.references.every((r: any) => r.eventSid === 700000000000010 || typeof r.eventSid === 'number')).toBe(true);
    expect(data.storedValues).toEqual(expect.arrayContaining([expect.objectContaining({ uid: 2, value: 7 })]));
  });

  it('refuses an unknown variable', async () => {
    const result = await server.callTool('find_instance_variable_references', { familyName: 'Hostiles', variableName: 'mana' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Available: health');
  });
});

describe('get_instance_counts', () => {
  it('counts instances on every layer depth and non-world instances', async () => {
    const data = parse(await server.callTool('get_instance_counts', {}));
    const keyboard = data.objectTypes.find((r: any) => r.objectType === 'Keyboard');
    expect(keyboard.total).toBeGreaterThanOrEqual(1);
    expect(data.totalInstances).toBe(data.objectTypes.reduce((n: number, r: any) => n + r.total, 0));
    const one = parse(await server.callTool('get_instance_counts', { objectName: 'Player', layoutName: 'Level 1' }));
    // Player uid 1 on the Game layer and uid 3 on its sub-layer.
    expect(one.objectTypes).toEqual([{ objectType: 'Player', total: 2, byLayout: { 'Level 1': 2 } }]);
    expect((await server.callTool('get_instance_counts', { objectName: 'Nope' })).isError).toBe(true);
  });
});
