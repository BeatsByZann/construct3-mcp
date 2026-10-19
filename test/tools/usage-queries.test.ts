/**
 * find_behavior_usage, find_effect_usage and find_instance_variable_references
 * on a temp copy of the minimal fixture with the real reader.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerUsageTools } from '../../src/tools/usage-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

type Json = Record<string, unknown>;

/** A result of the three tools, as the tests read it. */
interface UsageResult {
  complete: boolean;
  unscannedFiles?: Array<{ file: string; reason: string; textSearch: string }>;
  partlyIndexedSheets?: string[];
  unreadableScripts?: string[];
  scriptsNotWalked?: string[];
  declarations?: Array<{ owner: string; ownerKind: string; name: string; id?: string }>;
  eventReferences?: Array<{ eventSheet: string; objectClass: string; name?: string; form?: string; context?: string; nameAlsoDeclaredBy?: string; sid?: number }>;
  eventReferenceCount?: number;
  sheets?: string[];
  instanceSettings?: Array<{ layout: string; uid: number; type: string; behavior: string }>;
  uses?: Array<{ targetType: string; target: string; layout?: string; name: string; effectId?: string }>;
  instanceStates?: Array<{ layout: string; uid: number; type: string; effect: string; isEnabled?: boolean }>;
  unresolvedEventReferences?: Array<{ objectClass: string; expression: string }>;
  notFollowed?: string;
  references?: Array<{ eventSheet: string; objectClass: string; name: string; form: string }>;
  storedValues?: Array<{ layout: string; uid: number; type: string; variable: string; value: unknown }>;
  scriptReads?: Array<{ path: string; eventSheet?: string; name: string }>;
  variableUnconfirmed?: boolean;
  owner?: string;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;
let nextSid = 700000000000000;

async function editProject(change: (project: Record<string, { items: unknown[]; subfolders: Array<{ name: string; items: unknown[]; subfolders: unknown[] }> }>) => void): Promise<void> {
  const path = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(path, 'utf-8')) as Record<string, never>;
  change(project);
  await writeFile(path, JSON.stringify(project, null, '\t'));
}

async function addEntity(category: 'objectTypes' | 'families' | 'eventSheets' | 'layouts', name: string, data: Json): Promise<void> {
  await editProject(project => { project[category].items.push(name); });
  await mkdir(join(tmpDir, category), { recursive: true });
  await writeFile(join(tmpDir, category, `${name}.json`), JSON.stringify({ name, sid: nextSid++, ...data }, null, '\t'));
}

const variable = (name: string) => ({ name, type: 'number', initialValue: '0', sid: nextSid++ });
const behavior = (name: string, behaviorId = name) => ({ behaviorId, name, sid: nextSid++ });
const effect = (name: string, effectId: string) => ({ effectId, name, sid: nextSid++ });

async function addObject(name: string, extra: Json = {}): Promise<void> {
  await addEntity('objectTypes', name, {
    'plugin-id': 'Sprite', isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    animations: { items: [], subfolders: [] }, ...extra,
  });
}

async function addFamily(name: string, members: string[], extra: Json = {}): Promise<void> {
  await addEntity('families', name, { 'plugin-id': 'Sprite', members, instanceVariables: [], behaviorTypes: [], effectTypes: [], ...extra });
}

const block = (actions: unknown[], children: unknown[] = [], conditions: unknown[] = []) =>
  ({ eventType: 'block', conditions, actions, children, sid: nextSid++ });
const action = (objectClass: string, id: string, extra: Json = {}) =>
  ({ id, objectClass, sid: nextSid++, parameters: {}, ...extra });

async function addSheet(name: string, events: unknown[]): Promise<void> {
  await addEntity('eventSheets', name, { events });
}

/** One event holding `leaf`, below `levels` events that each hold the next. */
function nested(levels: number, leaf: unknown): unknown[] {
  let event = leaf;
  for (let i = 0; i < levels; i++) event = block([], [event]);
  return [event];
}

const instance = (uid: number, type: string, extra: Json = {}) => ({
  type, uid, sid: nextSid++, properties: {}, instanceVariables: {}, behaviors: {},
  world: { x: 0, y: 0, width: 64, height: 64 }, ...extra,
});

async function addLayout(name: string, instances: unknown[], extra: Json = {}): Promise<void> {
  await addEntity('layouts', name, {
    layers: [{ name: 'Main', sid: nextSid++, instances, subLayers: [], isInitiallyVisible: true, ...extra }],
    'nonworld-instances': [], eventSheet: '', width: 1920, height: 1080,
  });
}

async function addScript(path: string, content: string | undefined): Promise<void> {
  const parts = path.split('/');
  await editProject(project => {
    let folder = project.rootFileFolders as unknown as { items: unknown[]; subfolders: Array<{ name: string; items: unknown[]; subfolders: unknown[] }> };
    folder = (folder as unknown as { script: typeof folder }).script;
    for (const part of parts.slice(0, -1)) {
      let sub = folder.subfolders.find(s => s.name === part);
      if (!sub) {
        sub = { name: part, items: [], subfolders: [] };
        folder.subfolders.push(sub);
      }
      folder = sub as typeof folder;
    }
    folder.items.push({ name: parts[parts.length - 1], type: 'external-script-module', sid: nextSid++ });
  });
  if (content !== undefined) {
    const file = join(tmpDir, 'scripts', ...parts);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function overwrite(category: string, name: string, text: string): Promise<void> {
  await writeFile(join(tmpDir, category, `${name}.json`), text);
}

async function startServer(): Promise<void> {
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  server = new MockServer();
  registerUsageTools(server as never, reader);
  resetProjectIndex(reader);
}

async function raw(tool: string, args: Json) {
  return server.callTool(tool, args);
}

async function call(tool: string, args: Json): Promise<UsageResult> {
  const result = await raw(tool, args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text) as UsageResult;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-usage-queries-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('find_behavior_usage', () => {
  /** Sprite declares Platform; family Movers (member Enemy) declares Sin as Wave. */
  async function setup(): Promise<void> {
    await addObject('Sprite', { behaviorTypes: [behavior('Platform')] });
    await addObject('Enemy');
    await addObject('Rock');
    await addFamily('Movers', ['Enemy'], { behaviorTypes: [behavior('Wave', 'Sin')] });
    await addSheet('Logic', [
      block([action('Sprite', 'set-max-speed', { behaviorType: 'Platform' })]),
      block([action('System', 'set-var', { parameters: { value: 'Sprite.Platform.Speed + 1' } })]),
      block([action('Enemy', 'set-magnitude', { behaviorType: 'Wave' })]),
      block([action('Movers', 'set-magnitude', { behaviorType: 'wave' })]),
      block([action('Rock', 'set-magnitude', { behaviorType: 'Wave' })]),
    ]);
    await addLayout('Layout 2', [
      instance(11, 'Sprite', { behaviors: { Platform: { properties: { 'max-speed': 330 } } } }),
      instance(12, 'Enemy', { behaviors: { Wave: { properties: { magnitude: 5 } } } }),
      instance(13, 'Rock', { behaviors: { Wave: { properties: { magnitude: 9 } } } }),
      instance(14, 'Sprite', { behaviors: { Platform: { properties: {} } } }),
    ]);
    await startServer();
  }

  it('finds a behavior by name in any letter case: declarations, references written in actions and in an expression, sheets and instance settings', async () => {
    await setup();
    const result = await call('find_behavior_usage', { behaviorName: 'platform' });
    expect(result.declarations).toEqual([{ owner: 'Sprite', ownerKind: 'object', name: 'Platform', id: 'Platform' }]);
    expect(result.eventReferences?.map(r => `${r.objectClass}|${r.name}|${r.form}|${r.context}`)).toEqual([
      'Sprite|Platform|behaviorType|action',
      'Sprite|Platform|behavior-expression|expression',
    ]);
    expect(result.eventReferenceCount).toBe(2);
    expect(result.sheets).toEqual(['Logic']);
    expect(result.instanceSettings).toEqual([expect.objectContaining({ layout: 'Layout 2', uid: 11, type: 'Sprite', behavior: 'Platform' })]);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('editorNote');
  });

  it('follows a family behavior to its members and to the family, by id and by name, and not to other objects', async () => {
    await setup();
    for (const args of [{ behaviorId: 'Sin' }, { behaviorName: 'WAVE' }, { behaviorId: 'Sin', behaviorName: 'Wave' }]) {
      const result = await call('find_behavior_usage', args);
      expect(result.declarations, JSON.stringify(args)).toEqual([{ owner: 'Movers', ownerKind: 'family', name: 'Wave', id: 'Sin' }]);
      expect(result.eventReferences?.map(r => r.objectClass), JSON.stringify(args)).toEqual(['Enemy', 'Movers']);
      expect(result.instanceSettings?.map(s => s.uid), JSON.stringify(args)).toEqual([12]);
    }
    const neither = await raw('find_behavior_usage', {});
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toBe('Specify behaviorName, behaviorId, or both. Nothing was returned.');
  });

  it('names an unparsable object type and event sheets, and what a text search of each found', async () => {
    await setup();
    await addSheet('Holds', []);
    await addSheet('Quiet', []);
    await overwrite('eventSheets', 'Holds', '{ "behaviorType": "Platform" broken');
    await overwrite('eventSheets', 'Quiet', '{ broken');
    await overwrite('objectTypes', 'Rock', '{ broken');
    await startServer();
    const result = await call('find_behavior_usage', { behaviorName: 'Platform' });
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'objectTypes/Rock', textSearch: 'no-match' }),
      expect.objectContaining({ file: 'eventSheets/Holds', textSearch: 'possible-use' }),
      expect.objectContaining({ file: 'eventSheets/Quiet', textSearch: 'no-match' }),
    ]));
    expect(result.unscannedFiles).toHaveLength(3);
    expect(result.eventReferenceCount).toBe(2);
  });

  it('says a sheet the index only partly walked is incomplete, and does not claim the deeper use', async () => {
    await addObject('Sprite', { behaviorTypes: [behavior('Platform')] });
    const use = block([action('Sprite', 'set-max-speed', { behaviorType: 'Platform' })]);
    await addSheet('Deep', nested(52, use));
    await startServer();
    const deep = await call('find_behavior_usage', { behaviorName: 'Platform' });
    expect(deep.partlyIndexedSheets).toEqual(['eventSheets/Deep']);
    expect(deep.complete).toBe(false);
    expect(deep.eventReferences).toEqual([]);

    await addSheet('Shallow', nested(3, use));
    await overwrite('eventSheets', 'Deep', JSON.stringify({ name: 'Deep', events: [], sid: 1 }));
    await startServer();
    const shallow = await call('find_behavior_usage', { behaviorName: 'Platform' });
    expect(shallow.complete).toBe(true);
    expect(shallow.eventReferences?.map(r => r.eventSheet)).toEqual(['Shallow']);
  });

  it('skips entries of a behavior list that are not named objects', async () => {
    await addObject('Sprite', { behaviorTypes: [null, 'Platform', { behaviorId: 'Platform' }, behavior('Platform')] });
    await startServer();
    const result = await call('find_behavior_usage', { behaviorId: 'Platform' });
    expect(result.declarations).toEqual([{ owner: 'Sprite', ownerKind: 'object', name: 'Platform', id: 'Platform' }]);
  });

  it('returns a reader failure as an error', async () => {
    await startServer();
    vi.spyOn(reader, 'readAllObjectTypes').mockRejectedValue(new Error('objects gone'));
    const result = await raw('find_behavior_usage', { behaviorName: 'Platform' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error finding behavior usage: objects gone');
  });
});

describe('find_effect_usage', () => {
  it('lists the declarations, the instance states and the event uses of one effect id, and not another type\'s unrelated effect of the same name', async () => {
    await addObject('Sprite', { effectTypes: [effect('Glow', 'glowhorizontal')] });
    await addObject('Enemy', { effectTypes: [effect('Glow', 'blur')] });
    await addSheet('Fx', [
      block([action('Sprite', 'set-effect-parameter', { parameters: { effect: '"Glow"', 'parameter-index': '0', value: '1' } })]),
      block([action('Enemy', 'set-effect-parameter', { parameters: { effect: '"Glow"', 'parameter-index': '0', value: '1' } })]),
      block([action('Sprite', 'set-effect-parameter', { parameters: { effect: '"Other"', 'parameter-index': '0', value: '1' } })]),
    ]);
    await addLayout('Layout 2', [
      instance(21, 'Sprite', { effects: { Glow: { isEnabled: false } } }),
      instance(22, 'Enemy', { effects: { Glow: { isEnabled: true } } }),
    ]);
    await startServer();
    const result = await call('find_effect_usage', { effectId: 'glowhorizontal' });
    expect(result.uses).toEqual([{ targetType: 'objectType', target: 'Sprite', name: 'Glow', effectId: 'glowhorizontal' }]);
    expect(result.eventReferences?.map(r => r.objectClass)).toEqual(['Sprite']);
    expect(result.instanceStates).toEqual([{ layout: 'Layout 2', uid: 21, type: 'Sprite', effect: 'Glow', isEnabled: false }]);
    expect(result.unresolvedEventReferences).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('notFollowed');

    const byName = await call('find_effect_usage', { effectName: 'GLOW' });
    expect(byName.uses?.map(u => u.target)).toEqual(['Sprite', 'Enemy']);
    expect(byName.eventReferences?.map(r => r.objectClass)).toEqual(['Sprite', 'Enemy']);
  });

  it('follows a family effect to its members, marks a member that declares the name itself, and sets aside a use that is not a quoted name', async () => {
    await addObject('Crate');
    await addObject('Sprite', { effectTypes: [effect('Tint', 'blur')] });
    await addFamily('FX', ['Crate', 'Sprite'], { effectTypes: [effect('Tint', 'hsladjust')] });
    await addSheet('Fx', [
      block([action('Crate', 'set-effect-enabled', { parameters: { effect: '"tint"', enabled: 'true' } })]),
      block([action('Sprite', 'set-effect-enabled', { parameters: { effect: '"Tint"', enabled: 'true' } })]),
      block([action('FX', 'set-effect-enabled', { parameters: { effect: '"Tint"', enabled: 'true' } })]),
      block([action('Crate', 'set-effect-enabled', { parameters: { effect: '"Ti" & "nt"', enabled: 'true' } })]),
    ]);
    await addLayout('Layout 2', [instance(31, 'Crate', { effects: { Tint: { isEnabled: true } } })]);
    await startServer();

    const byName = await call('find_effect_usage', { effectName: 'Tint' });
    expect(byName.uses?.map(u => `${u.targetType}|${u.target}|${u.effectId}`)).toEqual(['objectType|Sprite|blur', 'family|FX|hsladjust']);
    expect(byName.eventReferences?.map(r => `${r.objectClass}|${r.nameAlsoDeclaredBy ?? ''}`)).toEqual(['Crate|', 'Sprite|Sprite', 'FX|']);
    expect(byName.unresolvedEventReferences?.map(r => r.objectClass)).toEqual(['Crate']);
    expect(byName.instanceStates?.map(s => s.uid)).toEqual([31]);

    const byId = await call('find_effect_usage', { effectId: 'hsladjust' });
    expect(byId.uses?.map(u => u.target)).toEqual(['FX']);
    expect(byId.eventReferences?.map(r => `${r.objectClass}|${r.nameAlsoDeclaredBy ?? ''}`)).toEqual(['Crate|', 'Sprite|Sprite', 'FX|']);
    expect(byId.unresolvedEventReferences).toHaveLength(1);
  });

  it('says that layer and layout effect uses in System actions are not listed', async () => {
    await addObject('Sprite');
    await addSheet('Fx', [block([action('System', 'set-layer-effect-enabled', { parameters: { layer: '"Main"', effect: '"Blur"', enabled: 'true' } })])]);
    await addLayout('Layout 2', [instance(41, 'Sprite')], { effectTypes: [effect('Blur', 'blur'), effect('Tone', 'hsladjust')] });
    await editLayoutEffect('Layout 2');
    await startServer();
    const result = await call('find_effect_usage', { effectId: 'blur' });
    expect(result.uses?.map(u => `${u.targetType}|${u.target}|${u.layout ?? ''}`)).toEqual(['layout|Layout 2|', 'layer|Main|Layout 2']);
    expect(result.eventReferences).toEqual([]);
    expect(result.notFollowed).toBe('Layer and layout effect uses in System actions are not listed.');
  });

  it('names an unparsable file and what a text search of it found', async () => {
    await addObject('Sprite', { effectTypes: [effect('Glow', 'glowhorizontal')] });
    await addSheet('Holds', []);
    await addSheet('Quiet', []);
    await overwrite('eventSheets', 'Holds', '{ "effect": "\\"Glow\\"" broken');
    await overwrite('eventSheets', 'Quiet', '{ broken');
    await startServer();
    const result = await call('find_effect_usage', { effectName: 'Glow' });
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles).toEqual([
      expect.objectContaining({ file: 'eventSheets/Holds', textSearch: 'possible-use' }),
      expect.objectContaining({ file: 'eventSheets/Quiet', textSearch: 'no-match' }),
    ]);
  });

  it('lists a use nested deeper than the index walks, and is complete (the tool walks every level)', async () => {
    await addObject('Sprite', { effectTypes: [effect('Glow', 'glowhorizontal')] });
    const use = block([action('Sprite', 'set-effect-enabled', { parameters: { effect: '"Glow"', enabled: 'true' } })]);
    await addSheet('Deep', nested(52, use));
    await startServer();
    const result = await call('find_effect_usage', { effectName: 'Glow' });
    expect(result.eventReferences?.map(r => r.eventSheet)).toEqual(['Deep']);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('partlyIndexedSheets');
  });

  it('refuses neither argument and returns a reader failure as an error', async () => {
    await startServer();
    const neither = await raw('find_effect_usage', {});
    expect(neither.content[0].text).toBe('Specify effectId, effectName, or both. Nothing was returned.');
    vi.spyOn(reader, 'readAllObjectTypes').mockRejectedValue(new Error('objects gone'));
    const failed = await raw('find_effect_usage', { effectName: 'Glow' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe('Error finding effect usage: objects gone');
  });
});

/** The layout's own effect list (addLayout puts effects on the layer only). */
async function editLayoutEffect(name: string): Promise<void> {
  const file = join(tmpDir, 'layouts', `${name}.json`);
  const layout = JSON.parse(await readFile(file, 'utf-8')) as Json;
  layout.effectTypes = [effect('Blur', 'blur'), effect('Tone', 'hsladjust')];
  await writeFile(file, JSON.stringify(layout, null, '\t'));
}

describe('find_instance_variable_references', () => {
  /** Hero (hp, mp); Enemy; family Foes (hp) with member Enemy. */
  async function setup(): Promise<void> {
    await addObject('Hero', { instanceVariables: [variable('hp'), variable('mp')] });
    await addObject('Enemy');
    await addFamily('Foes', ['Enemy'], { instanceVariables: [variable('hp')] });
    await addSheet('Logic', [
      block([action('Hero', 'set-instvar-value', { parameters: { 'instance-variable': 'hp', value: '1' } })]),
      block([action('System', 'set-var', { parameters: { value: 'Hero.HP + 1' } })]),
      block([action('Functions', 'call-function', { parameters: ['"Go"', 'Hero.hp', '2'] })]),
      block([action('Enemy', 'set-instvar-value', { parameters: { 'instance-variable': 'hp', value: '1' } })]),
      block([action('Foes', 'set-instvar-value', { parameters: { 'instance-variable': 'hp', value: '1' } })]),
      block([action('Hero', 'set-instvar-value', { parameters: { 'instance-variable': 'mp', value: '1' } })]),
      { eventType: 'script', language: 'javascript', script: ['const v = inst.instVars.hp;'], sid: nextSid++ },
    ]);
    await addLayout('Layout 2', [
      instance(51, 'Hero', { instanceVariables: { hp: 5, mp: 1 } }),
      instance(52, 'Enemy', { instanceVariables: { HP: 7 } }),
      instance(53, 'Hero', { instanceVariables: { mp: 2 } }),
    ]);
    await addScript('lib/ai.js', 'export const x = inst.instVars.hp;');
    await startServer();
  }

  it('lists the references of an object type\'s variable in every form, the stored values, and the scripts that may read it', async () => {
    await setup();
    const result = await call('find_instance_variable_references', { objectName: 'hero', variableName: 'HP' });
    expect(result.owner).toBe('Hero');
    expect(result.references?.map(r => `${r.objectClass}|${r.name}|${r.form}`)).toEqual([
      'Hero|hp|instance-variable',
      'Hero|HP|member-expression',
      'Hero|hp|member-expression',
    ]);
    expect(result.storedValues).toEqual([{ layout: 'Layout 2', uid: 51, type: 'Hero', variable: 'hp', value: 5 }]);
    expect(result.scriptReads?.map(r => r.path)).toEqual(expect.arrayContaining(['scripts/lib/ai.js']));
    expect(result.scriptReads).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('editorNote');
  });

  it('follows a family\'s variable to the family and its members', async () => {
    await setup();
    const result = await call('find_instance_variable_references', { familyName: 'foes', variableName: 'hp' });
    expect(result.owner).toBe('Foes');
    expect(result.references?.map(r => r.objectClass)).toEqual(['Enemy', 'Foes']);
    expect(result.storedValues).toEqual([{ layout: 'Layout 2', uid: 52, type: 'Enemy', variable: 'HP', value: 7 }]);
  });

  it('refuses a missing or double owner, an unknown owner and an unknown variable, naming what exists', async () => {
    await setup();
    for (const args of [{ variableName: 'hp' }, { objectName: 'Hero', familyName: 'Foes', variableName: 'hp' }]) {
      const result = await raw('find_instance_variable_references', args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Specify exactly one of objectName or familyName. Nothing was returned.');
    }
    const object = await raw('find_instance_variable_references', { objectName: 'Nope', variableName: 'hp' });
    expect(object.content[0].text).toContain('Object "Nope" not found. Available: Sprite, Hero, Enemy.');
    expect(object.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
    const family = await raw('find_instance_variable_references', { familyName: 'Nope', variableName: 'hp' });
    expect(family.content[0].text).toContain('Family "Nope" not found. Available: Foes');
    expect(family.content[0].text.endsWith(' Nothing was returned.')).toBe(true);
    const unknown = await raw('find_instance_variable_references', { objectName: 'Hero', variableName: 'nope' });
    expect(unknown.content[0].text).toBe('Instance variable "nope" not found on object "Hero". Available: hp, mp. Nothing was returned.');
  });

  it('names unparsable sheets and layouts and what a text search of each found, needing both the variable and the owner', async () => {
    await setup();
    await addSheet('Both', []);
    await addSheet('OnlyVar', []);
    await addLayout('Broken', []);
    await overwrite('eventSheets', 'Both', '{ "objectClass": "Hero", "instance-variable": "hp" broken');
    await overwrite('eventSheets', 'OnlyVar', '{ "instance-variable": "hp" broken');
    await overwrite('layouts', 'Broken', '{ "type": "Hero", "hp" broken');
    await startServer();
    const result = await call('find_instance_variable_references', { objectName: 'Hero', variableName: 'hp' });
    expect(result.complete).toBe(false);
    expect(result.unscannedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'eventSheets/Both', textSearch: 'possible-use' }),
      expect.objectContaining({ file: 'eventSheets/OnlyVar', textSearch: 'no-match' }),
      expect.objectContaining({ file: 'layouts/Broken', textSearch: 'possible-use' }),
    ]));
    expect(result.unscannedFiles).toHaveLength(3);
  });

  it('is incomplete while a registered script cannot be read or sits below the walk depth, and complete when every script is read', async () => {
    await setup();
    expect((await call('find_instance_variable_references', { objectName: 'Hero', variableName: 'hp' })).complete).toBe(true);

    await addScript('gone.js', undefined);
    await addScript(`${'d/'.repeat(52)}deep.js`, 'inst.instVars.hp');
    await startServer();
    const result = await call('find_instance_variable_references', { objectName: 'Hero', variableName: 'hp' });
    expect(result.complete).toBe(false);
    expect(result.unreadableScripts).toEqual(['scripts/gone.js']);
    expect(result.scriptsNotWalked).toEqual([`scripts/${'d/'.repeat(51)}`]);
    expect(result.scriptReads).toHaveLength(2);
  });

  it('answers for an owner whose own file cannot be parsed, with the references the index holds and the variable unconfirmed', async () => {
    await setup();
    await overwrite('objectTypes', 'Hero', '{ broken');
    await startServer();
    const result = await call('find_instance_variable_references', { objectName: 'Hero', variableName: 'hp' });
    expect(result.complete).toBe(false);
    expect(result.variableUnconfirmed).toBe(true);
    expect(result.unscannedFiles).toEqual([expect.objectContaining({ file: 'objectTypes/Hero' })]);
    expect(result.references?.map(r => r.form)).toContain('instance-variable');
    expect(result.storedValues?.map(v => v.uid)).toEqual([51]);
  });

  it('says a sheet the index only partly walked is incomplete, and does not claim the deeper reference', async () => {
    await addObject('Hero', { instanceVariables: [variable('hp')] });
    await addSheet('Deep', nested(52, block([action('Hero', 'set-instvar-value', { parameters: { 'instance-variable': 'hp', value: '1' } })])));
    await startServer();
    const result = await call('find_instance_variable_references', { objectName: 'Hero', variableName: 'hp' });
    expect(result.partlyIndexedSheets).toEqual(['eventSheets/Deep']);
    expect(result.complete).toBe(false);
    expect(result.references).toEqual([]);
  });

  it('returns a reader failure as an error', async () => {
    await startServer();
    vi.spyOn(reader, 'listFamilies').mockRejectedValue(new Error('families gone'));
    const result = await raw('find_instance_variable_references', { familyName: 'Foes', variableName: 'hp' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error finding instance variable references: families gone');
  });
});
