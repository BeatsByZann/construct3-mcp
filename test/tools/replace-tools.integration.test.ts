/**
 * Real-reader/writer tests for replace_object_in_events and
 * replace_in_expressions on a temp copy of test/fixtures/rename-project.
 *
 * Setup gives Player a Platform behavior and a "score" instance variable, and
 * Enemy only the "score" variable, so an event that uses Player's Platform
 * cannot be swapped to Enemy while the others can.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerReplaceTools, expressionMembers, matchAllBounded, RegexTimeoutError } from '../../src/tools/replace-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');
const MAIN_BLOCK = 610000000000015;
const PLATFORM_BLOCK = 700000000000010;
const MEMBER_BLOCK = 700000000000020;

let tmpDir: string;
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

async function snapshot(): Promise<string> {
  return [
    await readFile(join(tmpDir, 'eventSheets', 'Main.json'), 'utf-8'),
    await readFile(join(tmpDir, 'eventSheets', 'Shared', 'Helpers.json'), 'utf-8'),
  ].join('\n');
}

function bySid(events: any[], sid: number): any {
  for (const e of events) {
    if (e.sid === sid) return e;
    const hit = Array.isArray(e.children) ? bySid(e.children, sid) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-replace-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await editJson(['objectTypes', 'Actors', 'Player.json'], o => {
    o.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 700000000000001 }];
    o.instanceVariables = [{ name: 'score', type: 'number', desc: '', show: true, sid: 700000000000002 }];
    o.effectTypes = [{ effectId: 'hsladjust', name: 'Tint' }];
  });
  await editJson(['objectTypes', 'Actors', 'Enemy.json'], o => {
    o.instanceVariables = [{ name: 'score', type: 'number', desc: '', show: true, sid: 700000000000003 }];
  });
  await editJson(['eventSheets', 'Main.json'], s => {
    s.events.push({
      eventType: 'block', sid: PLATFORM_BLOCK,
      conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', sid: 700000000000011 }],
      actions: [{ id: 'destroy', objectClass: 'Player', sid: 700000000000012 }],
    });
    s.events.push({
      eventType: 'block', sid: MEMBER_BLOCK,
      conditions: [{ id: 'every-tick', objectClass: 'System', sid: 700000000000021 }],
      actions: [{ id: 'set-eventvar-value', objectClass: 'System', sid: 700000000000022, parameters: { variable: 'score', value: 'Player.Platform.MaxSpeed' } }],
    });
  });
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerReplaceTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('expressionMembers', () => {
  it('finds members of whole object tokens outside string literals', () => {
    expect(expressionMembers('Player.X + PlayerShip.Y + a.Player.Z + "Player.W" + Player.Platform.Speed', 'Player'))
      .toEqual(['X', 'Platform']);
  });
});

describe('replace_object_in_events', () => {
  it('reports swaps and skipped events on a dry run without writing', async () => {
    const before = await snapshot();
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', dryRun: true });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.action).toBe('dry-run');
    expect(data.references.byKind.objectClass).toBe(4);
    expect(data.references.byKind.parameterObjectName).toBe(3);
    expect(data.filesWritten).toEqual([]);
    const skipped = data.skippedEvents.map((s: any) => s.eventSid);
    expect(skipped).toEqual(expect.arrayContaining([PLATFORM_BLOCK, MEMBER_BLOCK]));
    const platform = data.skippedEvents.find((s: any) => s.eventSid === PLATFORM_BLOCK);
    expect(platform.reasons[0]).toContain('behavior "Platform"');
    const member = data.skippedEvents.find((s: any) => s.eventSid === MEMBER_BLOCK);
    expect(member.reasons[0]).toContain('Player.Platform');
    expect(await snapshot()).toBe(before);
  });

  it('swaps compatible events and leaves incompatible ones whole', async () => {
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy' });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.filesWritten).toEqual(['eventSheets/Main.json', 'eventSheets/Shared/Helpers.json']);

    const events = (await readJson('eventSheets', 'Main.json')).events;
    const main = bySid(events, MAIN_BLOCK);
    expect(main.conditions[1].parameters).toEqual({ object: 'Enemy', expression: 'Enemy.X > Hostiles.health' });
    expect(main.actions[0].objectClass).toBe('Enemy');
    expect(main.actions[0].parameters).toEqual({ x: 'Enemy.X + PlayerShip.X', y: 'Enemy.Player + 10' });
    expect(main.actions[3].parameters.text).toBe('"Player wins" & Enemy.AnimationName & " PlayerShip"');
    expect(main.actions[5].objectClass).toBe('Enemy');

    const platform = bySid(events, PLATFORM_BLOCK);
    expect(platform.conditions[0].objectClass).toBe('Player');
    expect(platform.actions[0].objectClass).toBe('Player');
    expect(bySid(events, MEMBER_BLOCK).actions[0].parameters.value).toBe('Player.Platform.MaxSpeed');

    // Custom action arguments under a Hostiles-owned definition are ordinary references.
    const custom = bySid(events, 610000000000023);
    expect(custom.actions[0].parameters).toEqual(['Enemy.UID', '"Player"', 'score']);
  });

  it('leaves a whole branch alone when one of its sub-events cannot be swapped', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      const inner = s.events[2].children[1];
      inner.actions.push({ id: 'set-enabled', objectClass: 'Player', behaviorType: 'Platform', sid: 700000000000050, parameters: { state: 'enabled' } });
    });
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', sheetName: 'Main' });
    const data = parse(result);
    const main = data.skippedEvents.find((s: any) => s.eventSid === MAIN_BLOCK);
    expect(main.reasons).toEqual(['sub-event events[2].children[1]: "set-enabled" uses behavior "Platform", which Enemy does not have']);
    const events = (await readJson('eventSheets', 'Main.json')).events;
    const block = bySid(events, MAIN_BLOCK);
    expect(block.actions[0].objectClass).toBe('Player');
    expect(block.children[1].actions[1].objectClass).toBe('Player');
    // Branches without the object still swap independently.
    expect(bySid(events, 610000000000023).actions[0].parameters[0]).toBe('Enemy.UID');
  });

  it('skips an event whose instance variable the replacement lacks', async () => {
    await editJson(['objectTypes', 'Actors', 'Enemy.json'], o => { o.instanceVariables = []; });
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', sheetName: 'Main', dryRun: true });
    const main = parse(result).skippedEvents.find((s: any) => s.eventSid === MAIN_BLOCK);
    expect(main.reasons).toContain('"set-instvar-value" uses instance variable "score", which Enemy does not have');
  });

  it('counts family instance variables as members of both objects', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events.push({
        eventType: 'block', sid: 700000000000040,
        conditions: [],
        actions: [{ id: 'set-instvar-value', objectClass: 'Player', sid: 700000000000041, parameters: { 'instance-variable': 'health', value: 'Player.health - 1' } }],
      });
    });
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', sheetName: 'Main' });
    const data = parse(result);
    expect(data.skippedEvents.map((s: any) => s.eventSid)).not.toContain(700000000000040);
    const block = bySid((await readJson('eventSheets', 'Main.json')).events, 700000000000040);
    expect(block.actions[0]).toMatchObject({ objectClass: 'Enemy', parameters: { 'instance-variable': 'health', value: 'Enemy.health - 1' } });
  });

  it('skips an event whose effect the replacement lacks', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events.push({
        eventType: 'block', sid: 700000000000030,
        conditions: [],
        actions: [{ id: 'set-effect-enabled', objectClass: 'Player', sid: 700000000000031, parameters: { mode: 'enabled', effect: '"Tint"' } }],
      });
    });
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', sheetName: 'Main', dryRun: true });
    const skipped = parse(result).skippedEvents.find((s: any) => s.eventSid === 700000000000030);
    expect(skipped.reasons[0]).toContain('effect "Tint"');
  });

  it('refuses an unknown replacement', async () => {
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Hostiles', toObject: 'Hostiles2', dryRun: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Hostiles2" not found');
  });

  it('limits the swap to one sheet', async () => {
    const helpersBefore = await readFile(join(tmpDir, 'eventSheets', 'Shared', 'Helpers.json'), 'utf-8');
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', sheetName: 'Main' });
    expect(parse(result).filesWritten).toEqual(['eventSheets/Main.json']);
    expect(await readFile(join(tmpDir, 'eventSheets', 'Shared', 'Helpers.json'), 'utf-8')).toBe(helpersBefore);
  });

  it('refuses objects of different plugins', async () => {
    const before = await snapshot();
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Tiles' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('same plugin');
    expect(await snapshot()).toBe(before);
  });

  it('skips a custom action definition owned by the replaced family', async () => {
    await editJson(['project.c3proj'], p => { p.families.subfolders[0].items.push('Others'); });
    await writeFile(join(tmpDir, 'families', 'Groups', 'Others.json'), JSON.stringify({
      name: 'Others', 'plugin-id': 'Sprite', sid: 650000000000009, instanceVariables: [{ name: 'health', type: 'number', sid: 650000000000010 }], behaviorTypes: [], effectTypes: [], members: [],
    }));
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const local = new MockServer();
    registerReplaceTools({ server: local, reader, writer: new Construct3ProjectWriter(reader, idGen), idGen } as any);
    const result = await local.callTool('replace_object_in_events', { fromObject: 'Hostiles', toObject: 'Others', dryRun: true });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    const definition = data.skippedEvents.find((s: any) => s.eventSid === 610000000000023);
    expect(definition.reasons[0]).toContain('custom action definition');
    // The pick-by-evaluate expression reads Hostiles.health, which Others has.
    expect(data.references.byKind.expression).toBeGreaterThan(0);
  });
});

describe('replace_in_expressions', () => {
  it('counts matches on a dry run and writes nothing', async () => {
    const before = await snapshot();
    const result = await server.callTool('replace_in_expressions', { find: 'Player.X', replace: 'Player.Y', dryRun: true });
    const data = parse(result);
    expect(data.totalMatches).toBe(4);
    expect(data.parametersChanged).toBe(4);
    expect(data.bySheet).toEqual([
      { sheet: 'Main', parameters: 3, matches: 3 },
      { sheet: 'Helpers', parameters: 1, matches: 1 },
    ]);
    expect(data.changes[0]).toEqual({
      sheet: 'Main', eventSid: MAIN_BLOCK, path: 'events[2].conditions[1].parameters.expression', key: 'expression',
      before: 'Player.X > Hostiles.health', after: 'Player.Y > Hostiles.health',
    });
    expect(await snapshot()).toBe(before);
  });

  it('changes only the chosen parameter keys', async () => {
    const result = await server.callTool('replace_in_expressions', { find: 'Player.X', replace: 'Player.Y', parameterKeys: ['value'] });
    expect(parse(result).parametersChanged).toBe(2);
    const main = bySid((await readJson('eventSheets', 'Main.json')).events, MAIN_BLOCK);
    expect(main.conditions[1].parameters.expression).toBe('Player.X > Hostiles.health');
    expect(main.actions[4].parameters.value).toBe('score + Player.Y');
    expect((await readJson('eventSheets', 'Shared', 'Helpers.json')).events[2].actions[0].parameters.value).toBe('score + Player.Y');
  });

  it('expands regex groups and keeps a plain replacement literal', async () => {
    await server.callTool('replace_in_expressions', { find: 'score \\+ (\\w+)\\.X', replace: '$1.X + score', regex: true, sheets: ['Main'] });
    let main = bySid((await readJson('eventSheets', 'Main.json')).events, MAIN_BLOCK);
    expect(main.actions[4].parameters.value).toBe('Player.X + score');
    await server.callTool('replace_in_expressions', { find: 'Hostiles.health', replace: '$1&$$', sheets: ['Main'] });
    main = bySid((await readJson('eventSheets', 'Main.json')).events, MAIN_BLOCK);
    expect(main.conditions[1].parameters.expression).toBe('Player.X > $1&$$');
    expect((await readJson('eventSheets', 'Shared', 'Helpers.json')).events[2].actions[0].parameters.value).toBe('score + Player.X');
  });

  it('matches case-insensitively and by whole word when asked', async () => {
    const result = await server.callTool('replace_in_expressions', { find: 'player', replace: 'Hero', caseSensitive: false, wholeWord: true, dryRun: true });
    const data = parse(result);
    expect(data.changes.every((c: any) => !c.after.includes('HeroShip'))).toBe(true);
    expect(data.changes.some((c: any) => c.before.includes('PlayerShip') && c.after.includes('PlayerShip'))).toBe(true);
  });

  it('changes positional custom action arguments', async () => {
    await server.callTool('replace_in_expressions', { find: 'Player.UID', replace: 'Player.IID', parameterKeys: ['0'] });
    const custom = bySid((await readJson('eventSheets', 'Main.json')).events, 610000000000023);
    expect(custom.actions[0].parameters).toEqual(['Player.IID', '"Player"', 'score']);
  });

  it('rejects a pattern that matches empty text', async () => {
    const result = await server.callTool('replace_in_expressions', { find: 'x*', replace: 'y', regex: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('empty text');
  });

  it('leaves name and combo parameters alone unless parameterKeys names them', async () => {
    await editJson(['eventSheets', 'Main.json'], s => {
      s.events.push({
        eventType: 'block', sid: 700000000000060, conditions: [],
        actions: [{ id: 'set-visible', objectClass: 'Player', sid: 700000000000061, parameters: { visibility: 'visible', state: 'visible' } }],
      });
    });
    const result = await server.callTool('replace_in_expressions', { find: 'score', replace: 'points', sheets: ['Main'] });
    const data = parse(result);
    expect(data.warnings[0]).toContain('variable (2)');
    expect(data.warnings[0]).toContain('instance-variable (1)');
    let main = bySid((await readJson('eventSheets', 'Main.json')).events, MAIN_BLOCK);
    expect(main.actions[4].parameters).toEqual({ variable: 'score', value: 'points + Player.X' });
    expect(main.actions[5].parameters).toEqual({ 'instance-variable': 'score', value: '1' });

    const combo = await server.callTool('replace_in_expressions', { find: 'visible', replace: 'shown', sheets: ['Main'] });
    expect(parse(combo).parametersChanged).toBe(0);
    expect(bySid((await readJson('eventSheets', 'Main.json')).events, 700000000000060).actions[0].parameters).toEqual({ visibility: 'visible', state: 'visible' });

    await server.callTool('replace_in_expressions', { find: 'score', replace: 'points', parameterKeys: ['variable'], sheets: ['Main'] });
    main = bySid((await readJson('eventSheets', 'Main.json')).events, MAIN_BLOCK);
    expect(main.actions[4].parameters.variable).toBe('points');
  });

  it('refuses a pattern that matches zero characters between words', async () => {
    const before = await snapshot();
    const result = await server.callTool('replace_in_expressions', { find: 'a?', replace: 'Z', regex: true, wholeWord: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('zero characters (in Main events[2]');
    expect(await snapshot()).toBe(before);
  });

  it('counts a repeated sheet once', async () => {
    const result = await server.callTool('replace_in_expressions', { find: 'Player.X', replace: 'Player.Y', sheets: ['Main', 'Main'] });
    const data = parse(result);
    expect(data.bySheet).toEqual([{ sheet: 'Main', parameters: 3, matches: 3 }]);
    expect(data.filesWritten).toEqual(['eventSheets/Main.json']);
  });

  it('stops a catastrophically backtracking pattern at the time limit', () => {
    const started = Date.now();
    expect(() => matchAllBounded(/(a+)+$/g, 'x', ['a'.repeat(40) + '!'], 100)).toThrow(RegexTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(matchAllBounded(/a/g, 'b', ['aa'], 100)).toEqual([{ count: 2, empty: false, after: 'bb' }]);
  });

  it('rejects an unknown sheet', async () => {
    const result = await server.callTool('replace_in_expressions', { find: 'a', replace: 'b', sheets: ['Nope'] });
    expect(result.isError).toBe(true);
  });
});
