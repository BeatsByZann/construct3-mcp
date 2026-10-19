/**
 * replace_object_in_events on a temp copy of test/fixtures/rename-project,
 * with the real reader, writer and ID generator.
 *
 * Setup gives Player a Platform behavior, a "score" instance variable and an
 * effect "Tint", and Enemy only the "score" variable, so an event that uses
 * Player's Platform cannot be swapped to Enemy while the others can.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { Construct3ProjectReader, ProjectReadError } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { MAX_EVENT_DEPTH, expressionMembers, registerReplaceTools } from '../../src/tools/replace-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');
const MAIN_BLOCK = 610000000000015;
const PLATFORM_BLOCK = 700000000000010;
const MEMBER_BLOCK = 700000000000020;
const DEPTH_MESSAGE = `nested deeper than ${MAX_EVENT_DEPTH} levels; the events below it were not checked`;

interface Ace {
  id?: string;
  objectClass?: string;
  customAction?: string;
  customActionObjectClass?: string;
  behaviorType?: string;
  parameters?: Record<string, unknown> | unknown[];
  sid?: number;
  [key: string]: unknown;
}
interface Ev {
  eventType: string;
  sid?: number;
  conditions?: Ace[];
  actions?: Ace[];
  children?: Ev[];
  [key: string]: unknown;
}
interface SheetFile { events: Ev[] }
interface Entry { name: string; [key: string]: unknown }
interface ObjectFile { instanceVariables: Entry[]; behaviorTypes: Entry[]; effectTypes: Entry[]; [key: string]: unknown }
interface Result {
  success: boolean;
  action: string;
  category: string;
  sheetsScanned: number;
  references: { total: number; byKind: Record<string, number>; byFile: Array<{ file: string; count: number; kinds: Record<string, number> }> };
  skippedEvents: Array<{ file: string; path: string; eventSid?: number; references: number; reasons: string[] }>;
  notChanged: { total: number; byKind: Record<string, number> };
  filesWritten: string[];
  dryRun: boolean;
  complete?: boolean;
  warnings?: string[];
  unscannedFiles?: Array<{ file: string; reason: string; textSearch: string; names?: string[] }>;
}
type Call = { content: Array<{ type: string; text: string }>; isError?: boolean };

let tmpDir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

const parse = (result: Call): Result => JSON.parse(result.content[0].text) as Result;
const textOf = (result: Call): string => result.content[0].text;
const swap = (args: Record<string, unknown>): Promise<Call> => server.callTool('replace_object_in_events', { fromObject: 'Player', toObject: 'Enemy', ...args });
const path = (...segments: string[]): string => join(tmpDir, ...segments);

async function readJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(path(...segments), 'utf-8')) as T;
}

async function editJson<T>(rel: string[], fn: (data: T) => void): Promise<void> {
  const data = await readJson<T>(...rel);
  fn(data);
  await writeFile(path(...rel), JSON.stringify(data, null, '\t'));
}

/** Path to bytes of every file of the project, leaving out the writer's *.bak files. */
async function snapshotProject(dir: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.bak')) continue;
    const full = join(entry.parentPath, entry.name);
    files[relative(dir, full).replace(/\\/g, '/')] = await readFile(full);
  }
  return files;
}

/** A new reader, writer and server over the files as they are now. */
async function start(): Promise<void> {
  resetProjectIndex();
  reader = new Construct3ProjectReader(path('project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerReplaceTools({ server, reader, writer, idGen } as unknown as Parameters<typeof registerReplaceTools>[0]);
}

/** Add events to Main and start again. */
async function addEvents(...events: Ev[]): Promise<void> {
  await editJson<SheetFile>(['eventSheets', 'Main.json'], s => { s.events.push(...events); });
  await start();
}

async function editObject(name: string, fn: (o: ObjectFile) => void): Promise<void> {
  await editJson<ObjectFile>(['objectTypes', 'Actors', `${name}.json`], fn);
  await start();
}

function block(sid: number, actions: Ace[], conditions: Ace[] = []): Ev {
  return { eventType: 'block', sid, conditions, actions };
}

function bySid(events: Ev[], sid: number): Ev {
  for (const e of events) {
    if (e.sid === sid) return e;
    const hit = Array.isArray(e.children) ? findSid(e.children, sid) : undefined;
    if (hit) return hit;
  }
  throw new Error(`no event ${sid}`);
}

function findSid(events: Ev[], sid: number): Ev | undefined {
  try { return bySid(events, sid); } catch { return undefined; }
}

async function mainEvent(sid: number): Promise<Ev> {
  return bySid((await readJson<SheetFile>('eventSheets', 'Main.json')).events, sid);
}

/** How many leaf values differ between two parsed files. */
function changedLeaves(before: unknown, after: unknown): number {
  if (typeof before !== 'object' || before === null || typeof after !== 'object' || after === null) return before === after ? 0 : 1;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let total = 0;
  for (const key of keys) total += changedLeaves((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key]);
  return total;
}

const noPath = (text: string) => {
  expect(text).not.toContain(tmpDir);
  expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-replace-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await editJson<ObjectFile>(['objectTypes', 'Actors', 'Player.json'], o => {
    o.behaviorTypes = [{ behaviorId: 'Platform', name: 'Platform', sid: 700000000000001 }];
    o.instanceVariables = [{ name: 'score', type: 'number', desc: '', show: true, sid: 700000000000002 }];
    o.effectTypes = [{ effectId: 'hsladjust', name: 'Tint' }];
  });
  await editJson<ObjectFile>(['objectTypes', 'Actors', 'Enemy.json'], o => {
    o.instanceVariables = [{ name: 'score', type: 'number', desc: '', show: true, sid: 700000000000003 }];
  });
  await editJson<SheetFile>(['eventSheets', 'Main.json'], s => {
    s.events.push(block(PLATFORM_BLOCK,
      [{ id: 'destroy', objectClass: 'Player', sid: 700000000000012 }],
      [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', sid: 700000000000011 }]));
    s.events.push(block(MEMBER_BLOCK,
      [{ id: 'set-eventvar-value', objectClass: 'System', sid: 700000000000022, parameters: { variable: 'score', value: 'Player.Platform.MaxSpeed' } }],
      [{ id: 'every-tick', objectClass: 'System', sid: 700000000000021 }]));
  });
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('expressionMembers', () => {
  it('finds members of whole object tokens outside string literals', () => {
    expect(expressionMembers('Player.X + PlayerShip.Y + a.Player.Z + "Player.W" + Player.Platform.Speed', 'Player'))
      .toEqual(['X', 'Platform']);
  });

  it('reads Player(0).X and Player . X', () => {
    expect(expressionMembers('Player(0).X + Player . Y + Player (Player.Count - 1).Z', 'Player')).toEqual(['X', 'Y', 'Z', 'Count']);
  });

  it('matches the name ignoring case', () => {
    expect(expressionMembers('player.X + PLAYER.Y', 'Player')).toEqual(['X', 'Y']);
  });

  it('counts Self.X and self.Platform.Speed only when selfIsObject is true', () => {
    expect(expressionMembers('Self.X + self.Platform.Speed', 'Player')).toEqual([]);
    expect(expressionMembers('Self.X + self.Platform.Speed', 'Player', true)).toEqual(['X', 'Platform']);
  });
});

describe('replace_object_in_events', () => {
  it('reports swaps and skipped events on a dry run without writing', async () => {
    const before = await snapshotProject(tmpDir);
    const writes = vi.spyOn(writer, 'writeEntityFile');
    const result = await swap({ dryRun: true });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.action).toBe('dry-run');
    expect(data.references.byKind.objectClass).toBe(4);
    expect(data.references.byKind['object parameter']).toBe(3);
    expect(data.filesWritten).toEqual([]);
    const platform = data.skippedEvents.find(s => s.eventSid === PLATFORM_BLOCK)!;
    expect(platform.reasons[0]).toContain('behavior "Platform"');
    const member = data.skippedEvents.find(s => s.eventSid === MEMBER_BLOCK)!;
    expect(member.reasons[0]).toContain('Player.Platform');
    expect(writes).not.toHaveBeenCalled();
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('swaps compatible events and leaves incompatible ones whole', async () => {
    const beforeMain = await readJson<unknown>('eventSheets', 'Main.json');
    const beforeHelpers = await readJson<unknown>('eventSheets', 'Shared', 'Helpers.json');
    const result = await swap({});
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.filesWritten).toEqual(['eventSheets/Main.json', 'eventSheets/Shared/Helpers.json']);

    const mainAfter = await readJson<SheetFile>('eventSheets', 'Main.json');
    const helpersAfter = await readJson<SheetFile>('eventSheets', 'Shared', 'Helpers.json');
    expect(data.references.total).toBe(changedLeaves(beforeMain, mainAfter) + changedLeaves(beforeHelpers, helpersAfter));
    expect(data.references.byFile.map(f => f.file)).toEqual(['eventSheets/Main.json', 'eventSheets/Shared/Helpers.json']);
    expect(data.references.byFile.reduce((n, f) => n + f.count, 0)).toBe(data.references.total);

    const main = bySid(mainAfter.events, MAIN_BLOCK);
    expect(main.conditions![1].parameters).toEqual({ object: 'Enemy', expression: 'Enemy.X > Hostiles.health' });
    expect(main.actions![0].objectClass).toBe('Enemy');
    expect(main.actions![0].parameters).toEqual({ x: 'Enemy.X + PlayerShip.X', y: 'Enemy.Player + 10' });
    expect(main.actions![3].parameters).toEqual({ text: '"Player wins" & Enemy.AnimationName & " PlayerShip"' });
    expect(main.actions![5].objectClass).toBe('Enemy');

    expect(bySid(mainAfter.events, PLATFORM_BLOCK).conditions![0].objectClass).toBe('Player');
    expect(bySid(mainAfter.events, PLATFORM_BLOCK).actions![0].objectClass).toBe('Player');
    expect(bySid(mainAfter.events, MEMBER_BLOCK).actions![0].parameters).toEqual({ variable: 'score', value: 'Player.Platform.MaxSpeed' });
    expect(helpersAfter.events[2].actions![0].parameters).toEqual({ variable: 'score', value: 'score + Enemy.X' });

    // Custom action arguments under a Hostiles-owned definition are ordinary references
    expect(bySid(mainAfter.events, 610000000000023).actions![0].parameters).toEqual(['Enemy.UID', '"Player"', 'score']);
  });

  it('leaves a whole branch alone when one of its sub-events cannot be swapped', async () => {
    await editJson<SheetFile>(['eventSheets', 'Main.json'], s => {
      s.events[2].children![1].actions!.push({ id: 'set-enabled', objectClass: 'Player', behaviorType: 'Platform', sid: 700000000000050, parameters: { state: 'enabled' } });
    });
    await start();
    const data = parse(await swap({ sheetName: 'Main' }));
    const main = data.skippedEvents.find(s => s.eventSid === MAIN_BLOCK)!;
    expect(main.reasons).toEqual(['sub-event events[2].children[1]: "set-enabled" uses behavior "Platform": Enemy does not have it']);
    const events = (await readJson<SheetFile>('eventSheets', 'Main.json')).events;
    const block = bySid(events, MAIN_BLOCK);
    expect(block.actions![0].objectClass).toBe('Player');
    expect(block.children![1].actions![1].objectClass).toBe('Player');
    // Branches without the object still swap independently
    expect(bySid(events, 610000000000023).actions![0].parameters).toEqual(['Enemy.UID', '"Player"', 'score']);
  });

  describe('instance variables', () => {
    const SKIP = 700000000000100;
    const skippedSids = async (sheetName = 'Main') => parse(await swap({ sheetName, dryRun: true })).skippedEvents.map(s => s.eventSid);
    const instvar = (objectClass: string, variable: unknown): Ace => ({ id: 'set-instvar-value', objectClass, parameters: { 'instance-variable': variable, value: '1' } });

    it('skips an event whose instance variable the replacement lacks, in the string form and the object form', async () => {
      await editObject('Enemy', o => { o.instanceVariables = []; });
      const data = parse(await swap({ sheetName: 'Main', dryRun: true }));
      expect(data.skippedEvents.find(s => s.eventSid === MAIN_BLOCK)!.reasons)
        .toContain('"set-instvar-value" uses instance variable "score", which Enemy does not have');
      await addEvents(block(SKIP, [instvar('Player', { name: 'hp', objectClass: 'Player' })]));
      const recorded = parse(await swap({ sheetName: 'Main', dryRun: true })).skippedEvents.find(s => s.eventSid === SKIP)!;
      expect(recorded.reasons).toEqual(['"set-instvar-value" uses instance variable "hp", which Enemy does not have']);
    });

    it('does not block on a record that names another owner, also when the action is on the replaced object', async () => {
      await addEvents(
        block(SKIP, [{ id: 'destroy', objectClass: 'Player' }, instvar('Other', { name: 'hp', objectClass: 'Other' })]),
        block(SKIP + 1, [instvar('Player', { name: 'hp', objectClass: 'Other' })]),
      );
      expect(await skippedSids()).not.toContain(SKIP);
      expect(await skippedSids()).not.toContain(SKIP + 1);
      await swap({ sheetName: 'Main' });
      const second = await mainEvent(SKIP + 1);
      expect(second.actions![0].objectClass).toBe('Enemy');
      expect(second.actions![0].parameters).toEqual({ 'instance-variable': { name: 'hp', objectClass: 'Other' }, value: '1' });
    });

    it('blocks on a record that names the replaced object, whatever the action is on', async () => {
      await addEvents(block(SKIP, [instvar('Other', { name: 'hp', objectClass: 'Player' })]));
      expect(await skippedSids()).toContain(SKIP);
    });

    it('lets a record without an objectClass follow the action\'s own object', async () => {
      await addEvents(
        block(SKIP, [instvar('Player', { name: 'hp' })]),
        block(SKIP + 1, [{ id: 'destroy', objectClass: 'Player' }, instvar('Other', { name: 'hp' })]),
      );
      const skipped = await skippedSids();
      expect(skipped).toContain(SKIP);
      expect(skipped).not.toContain(SKIP + 1);
    });
  });

  it('counts family instance variables as members of both objects', async () => {
    await addEvents(block(700000000000040, [
      { id: 'set-instvar-value', objectClass: 'Player', sid: 700000000000041, parameters: { 'instance-variable': 'health', value: 'Player.health - 1' } },
    ]));
    const data = parse(await swap({ sheetName: 'Main' }));
    expect(data.skippedEvents.map(s => s.eventSid)).not.toContain(700000000000040);
    expect((await mainEvent(700000000000040)).actions![0])
      .toMatchObject({ objectClass: 'Enemy', parameters: { 'instance-variable': 'health', value: 'Enemy.health - 1' } });
  });

  it('skips an event whose effect the replacement lacks', async () => {
    await addEvents(block(700000000000030, [
      { id: 'set-effect-enabled', objectClass: 'Player', sid: 700000000000031, parameters: { mode: 'enabled', effect: '"Tint"' } },
    ]));
    const skipped = parse(await swap({ sheetName: 'Main', dryRun: true })).skippedEvents.find(s => s.eventSid === 700000000000030)!;
    expect(skipped.reasons[0]).toContain('effect "Tint"');
  });

  it('warns, and swaps, when a named animation is missing', async () => {
    await addEvents(block(700000000000032, [{ id: 'set-animation', objectClass: 'Player', parameters: { animation: '"Run"' } }]));
    const data = parse(await swap({ sheetName: 'Main' }));
    expect(data.skippedEvents.map(s => s.eventSid)).not.toContain(700000000000032);
    expect(data.warnings).toContain('"set-animation" names animation "Run", which Enemy does not have; it was swapped anyway.');
    expect((await mainEvent(700000000000032)).actions![0].objectClass).toBe('Enemy');
  });

  it('skips a behavior of the same name but another behavior type', async () => {
    await editObject('Enemy', o => { o.behaviorTypes = [{ behaviorId: 'Solid', name: 'Platform' }]; });
    const platform = parse(await swap({ sheetName: 'Main', dryRun: true })).skippedEvents.find(s => s.eventSid === PLATFORM_BLOCK)!;
    expect(platform.reasons).toEqual(['"is-on-floor" uses behavior "Platform": it is a Platform behavior on Player but a Solid behavior on Enemy']);
  });

  it('skips a custom action definition owned by the replaced family, and a call of one of its custom actions', async () => {
    await editJson<{ families: { subfolders: Array<{ items: string[] }> } }>(['project.c3proj'], p => { p.families.subfolders[0].items.push('Others'); });
    await writeFile(path('families', 'Groups', 'Others.json'), JSON.stringify({
      name: 'Others', 'plugin-id': 'Sprite', sid: 650000000000009, instanceVariables: [{ name: 'health', type: 'number', sid: 650000000000010 }], behaviorTypes: [], effectTypes: [], members: [],
    }));
    await addEvents(block(700000000000070, [
      { customAction: 'Alert', objectClass: 'Player', customActionObjectClass: 'Hostiles', sid: 700000000000071, parameters: [] },
    ]));
    const result = await server.callTool('replace_object_in_events', { fromObject: 'Hostiles', toObject: 'Others', dryRun: true });
    expect(result.isError).not.toBe(true);
    const data = parse(result);
    expect(data.skippedEvents.find(s => s.eventSid === 610000000000023)!.reasons[0]).toContain('custom action definition');
    expect(data.skippedEvents.find(s => s.eventSid === 700000000000070)!.reasons).toEqual(['"Alert" calls a custom action; whether Others has it is not checked']);
    // The pick-by-evaluate expression reads Hostiles.health, which Others has
    expect(data.references.byKind.expression).toBeGreaterThan(0);
  });

  describe('custom actions in a branch', () => {
    const OWNER = 700000000000150;

    it('skips a call made on the replaced object itself, whatever family owns the custom action', async () => {
      await addEvents(block(OWNER, [{ customAction: 'Alert', objectClass: 'Player', customActionObjectClass: 'Hostiles', parameters: [] }]));
      const data = parse(await swap({ sheetName: 'Main' }));
      expect(data.skippedEvents.find(s => s.eventSid === OWNER)!.reasons).toEqual(['"Alert" calls a custom action; whether Enemy has it is not checked']);
      expect((await mainEvent(OWNER)).actions![0].objectClass).toBe('Player');
    });

    it('keeps the owner of a custom action definition nested under an event that uses the replaced family', async () => {
      await editJson<{ families: { subfolders: Array<{ items: string[] }> } }>(['project.c3proj'], p => { p.families.subfolders[0].items.push('Others'); });
      await writeFile(path('families', 'Groups', 'Others.json'), JSON.stringify({
        name: 'Others', 'plugin-id': 'Sprite', sid: 650000000000009, instanceVariables: [{ name: 'health', type: 'number', sid: 650000000000010 }], behaviorTypes: [], effectTypes: [], members: [],
      }));
      await addEvents({
        ...block(OWNER, [{ id: 'destroy', objectClass: 'Hostiles' }]),
        children: [{ eventType: 'custom-ace-block', aceType: 'action', aceName: 'Nested', objectClass: 'Hostiles', functionParameters: [], sid: OWNER + 1, conditions: [], actions: [] }],
      });
      const args = { fromObject: 'Hostiles', toObject: 'Others', sheetName: 'Main' };
      const row = parse(await server.callTool('replace_object_in_events', { ...args, dryRun: true })).skippedEvents.find(s => s.eventSid === OWNER)!;
      expect(row.reasons).toHaveLength(1);
      expect(row.reasons[0]).toMatch(/^sub-event events\[\d+\]\.children\[0\]: custom action definition owned by Hostiles$/);
      await server.callTool('replace_object_in_events', args);
      const event = await mainEvent(OWNER);
      expect(event.actions![0].objectClass).toBe('Hostiles');
      expect(event.children![0].objectClass).toBe('Hostiles');
    });
  });

  describe('an unexpected error', () => {
    it('is refused before any write, with no path in the text', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const before = await snapshotProject(tmpDir);
      const writes = vi.spyOn(writer, 'writeEntityFile');
      vi.spyOn(reader, 'listObjectTypes').mockRejectedValue(new Error(`boom at ${path('x.json')} and ${tmpDir} and D:\\elsewhere\\y.json`));
      const result = await swap({});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Error replacing object: boom at <project>[\\/]x\.json and <project> and <path>\. Nothing was changed\.$/);
      noPath(textOf(result));
      expect(writes).not.toHaveBeenCalled();
      expect(await snapshotProject(tmpDir)).toEqual(before);
    });

    it('names a failing file by its code and its place in the project', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(reader, 'listObjectTypes').mockRejectedValue(Object.assign(new Error(`EACCES: permission denied, open '${path('objectTypes', 'x.json')}'`), { code: 'EACCES', path: path('objectTypes', 'x.json') }));
      const result = await swap({});
      expect(textOf(result)).toBe('Error replacing object: EACCES on objectTypes/x.json. Nothing was changed.');
    });
  });

  describe('refusals', () => {
    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ['the same object', { fromObject: 'Player', toObject: 'Player' }, 'fromObject and toObject are the same.'],
      ['an unknown object', { toObject: 'Nope' }, 'Object or family "Nope" not found.'],
      ['a case variant', { fromObject: 'player' }, 'Object or family "player" not found: names are matched with their letter case. Did you mean "Player"?'],
      ['objects of different plugins', { toObject: 'Tiles' }, 'Replace object only swaps objects of the same plugin'],
      ['an unknown sheet', { sheetName: 'Nope' }, 'Event sheet "Nope" not found.'],
    ];
    it.each(refusals)('refuses %s and changes nothing', async (_name, args, expected) => {
      const before = await snapshotProject(tmpDir);
      const writes = vi.spyOn(writer, 'writeEntityFile');
      const result = await swap(args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(expected);
      expect(textOf(result).endsWith('Nothing was changed.')).toBe(true);
      expect(textOf(result).match(/Nothing was changed\./g)).toHaveLength(1);
      expect(writes).not.toHaveBeenCalled();
      expect(await snapshotProject(tmpDir)).toEqual(before);
    });

    it('leaves readAllEventSheets as it was', async () => {
      const before = await reader.readAllEventSheets();
      const copy = structuredClone(before);
      await swap({ toObject: 'Tiles' });
      expect(await reader.readAllEventSheets()).toEqual(copy);
    });
  });

  it('limits the swap to one sheet', async () => {
    const helpersBefore = await readFile(path('eventSheets', 'Shared', 'Helpers.json'));
    const data = parse(await swap({ sheetName: 'Main' }));
    expect(data.filesWritten).toEqual(['eventSheets/Main.json']);
    expect(data.sheetsScanned).toBe(1);
    expect(await readFile(path('eventSheets', 'Shared', 'Helpers.json'))).toEqual(helpersBefore);
  });

  it('refuses a named sheet it cannot parse', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Helpers.json'), '{ broken');
    await start();
    const before = await snapshotProject(tmpDir);
    const result = await swap({ sheetName: 'Helpers' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Cannot read event sheet "Helpers" (not valid JSON). Nothing was changed.');
    noPath(textOf(result));
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('lists sheets it cannot parse in unscannedFiles with a text search, never changes them', async () => {
    const broken = '{ "events": [ broken "Player" ';
    await writeFile(path('eventSheets', 'Shared', 'Helpers.json'), broken);
    await start();
    const data = parse(await swap({}));
    expect(data.filesWritten).toEqual(['eventSheets/Main.json']);
    expect(data.complete).toBe(false);
    expect(data.unscannedFiles).toEqual([{ file: 'eventSheets/Helpers', reason: 'not valid JSON', textSearch: 'possible-use', names: ['Player'] }]);
    expect(data.warnings).toContain('eventSheets/Helpers (not valid JSON) could not be parsed; its text names "Player". It was not changed.');
    expect(await readFile(path('eventSheets', 'Shared', 'Helpers.json'), 'utf-8')).toBe(broken);
    // A call limited to a sheet that parses does not claim the broken one
    const limited = parse(await swap({ sheetName: 'Main', dryRun: true }));
    expect(limited.complete).toBeUndefined();
    expect(limited.unscannedFiles).toBeUndefined();
  });

  it('says so when a sheet it cannot parse does not mention the object, or cannot be searched as text', async () => {
    await writeFile(path('eventSheets', 'Shared', 'Helpers.json'), '{ broken');
    await start();
    const noMention = parse(await swap({ dryRun: true }));
    expect(noMention.unscannedFiles).toEqual([{ file: 'eventSheets/Helpers', reason: 'not valid JSON', textSearch: 'no-match', searchedFor: ['Player'] }]);
    expect(noMention.warnings).toContain('eventSheets/Helpers (not valid JSON) could not be parsed and was only searched as text; no mention was found. It was not changed.');

    vi.spyOn(reader, 'searchEntityTextRaw').mockRejectedValue(new Error('read failed'));
    const unreadable = parse(await swap({ dryRun: true }));
    expect(unreadable.unscannedFiles).toEqual([{ file: 'eventSheets/Helpers', reason: 'not valid JSON', textSearch: 'unreadable' }]);
    expect(unreadable.warnings).toContain('eventSheets/Helpers (not valid JSON, not even as text) could not be searched either. It was not changed.');
  });

  it('leaves a sheet with unusual shapes (null lists, null entries) to the same swap', async () => {
    await addEvents({
      eventType: 'block', sid: 700000000000140, conditions: null, actions: [null, { id: 'destroy', objectClass: 'Player' }],
      children: [3, null, { eventType: 'block', sid: 700000000000141, conditions: null, actions: null }],
    } as unknown as Ev);
    const dry = parse(await swap({ sheetName: 'Main', dryRun: true }));
    expect(dry.skippedEvents.map(s => s.eventSid)).not.toContain(700000000000140);
    await swap({ sheetName: 'Main' });
    expect((await mainEvent(700000000000140)).actions![1].objectClass).toBe('Enemy');
  });

  it('reports what it leaves: scripts and string literals are counted and not changed', async () => {
    const data = parse(await swap({ sheetName: 'Main' }));
    expect(data.notChanged.byKind.script).toBe(1);
    expect(data.notChanged.byKind['string literal']).toBe(1);
    expect(data.notChanged.total).toBe(Object.values(data.notChanged.byKind).reduce((n, c) => n + c, 0));
    expect(data.warnings!.some(w => w.includes('mention(s) of "Player" were listed and not changed'))).toBe(true);
    const main = bySid((await readJson<SheetFile>('eventSheets', 'Main.json')).events, MAIN_BLOCK);
    expect(main.actions![11].script).toEqual(['// Player is mentioned here and must stay as it is', 'runtime.objects.Player.getFirstInstance();']);
    expect(main.actions![3].parameters).toEqual({ text: '"Player wins" & Enemy.AnimationName & " PlayerShip"' });
  });

  it('warns when the replacement\'s name cannot appear in an expression', async () => {
    await editJson<{ objectTypes: { subfolders: Array<{ items: string[] }> } }>(['project.c3proj'], p => { p.objectTypes.subfolders[0].items.push('Enemy Two'); });
    const enemy = await readJson<Record<string, unknown>>('objectTypes', 'Actors', 'Enemy.json');
    await writeFile(path('objectTypes', 'Actors', 'Enemy Two.json'), JSON.stringify({ ...enemy, name: 'Enemy Two', sid: 660000000000099 }));
    await start();
    const data = parse(await swap({ toObject: 'Enemy Two', dryRun: true }));
    expect(data.warnings).toContain('"Enemy Two" cannot appear in expression text (it contains a delimiter such as a space); swapped expressions will not parse.');
  });

  describe('a failed write', () => {
    it('puts the sheets back when the second write fails', async () => {
      const before = await snapshotProject(tmpDir);
      const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
      const verify = internals.verifyWrittenFile.bind(writer);
      internals.verifyWrittenFile = async (file, name, text) => {
        if (file.endsWith('Helpers.json')) throw new Error(`Post-write verification failed for "${name}": file may be corrupted.`);
        return verify(file, name, text);
      };
      const result = await swap({});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Post-write verification failed for "Helpers": file may be corrupted. '
        + 'The call was rolled back: eventSheets/Shared/Helpers.json, eventSheets/Main.json are as before the call.');
      expect(await snapshotProject(tmpDir)).toEqual(before);
    });

    it('refuses a sheet changed on disk after it was read and puts the earlier one back', async () => {
      const before = await snapshotProject(tmpDir);
      const write = writer.writeEntityFile.bind(writer);
      let first = true;
      vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (...args) => {
        const written = await write(...args);
        if (first) {
          first = false;
          await writeFile(path('eventSheets', 'Shared', 'Helpers.json'), `${await readFile(path('eventSheets', 'Shared', 'Helpers.json'), 'utf-8')} `);
        }
        return written;
      });
      const result = await swap({});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('eventSheets/Shared/Helpers.json was changed on disk after this server read it');
      expect(textOf(result)).toContain('The files this tool call had already changed were put back as they were before the call (eventSheets/Main.json), so the call changed nothing.');
      const after = await snapshotProject(tmpDir);
      expect(after['eventSheets/Main.json']).toEqual(before['eventSheets/Main.json']);
    });
  });

  it('compares object names ignoring case in the sheets', async () => {
    await addEvents(block(700000000000080, [{ id: 'destroy', objectClass: 'player' }]));
    await swap({ sheetName: 'Main' });
    expect((await mainEvent(700000000000080)).actions![0].objectClass).toBe('Enemy');
  });

  describe('files it cannot parse', () => {
    it('refuses an object type file it cannot parse, as fromObject and as toObject', async () => {
      await writeFile(path('objectTypes', 'Actors', 'Player.json'), '{ broken');
      await start();
      const before = await snapshotProject(tmpDir);
      for (const args of [{ fromObject: 'Player', toObject: 'Enemy' }, { fromObject: 'Enemy', toObject: 'Player' }]) {
        const result = await server.callTool('replace_object_in_events', args);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe('Cannot read object type "Player" (not valid JSON). Nothing was changed.');
        noPath(textOf(result));
      }
      expect(await snapshotProject(tmpDir)).toEqual(before);
    });

    it('refuses a family file that fails to read when its members are read', async () => {
      await editJson<{ families: { subfolders: Array<{ items: string[] }> } }>(['project.c3proj'], p => { p.families.subfolders[0].items.push('Others'); });
      await writeFile(path('families', 'Groups', 'Others.json'), JSON.stringify({
        name: 'Others', 'plugin-id': 'Sprite', sid: 650000000000009, instanceVariables: [], behaviorTypes: [], effectTypes: [], members: [],
      }));
      await start();
      vi.spyOn(reader, 'readFamily').mockRejectedValue(new ProjectReadError('E_INVALID_JSON', `Unexpected token in ${path('families', 'Groups', 'Hostiles.json')}`));
      const before = await snapshotProject(tmpDir);
      const result = await server.callTool('replace_object_in_events', { fromObject: 'Hostiles', toObject: 'Others' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Cannot read family "Hostiles" (not valid JSON). Nothing was changed.');
      noPath(textOf(result));
      expect(await snapshotProject(tmpDir)).toEqual(before);
    });

    it('refuses when a family file cannot be parsed', async () => {
      await writeFile(path('families', 'Groups', 'Hostiles.json'), '{ broken');
      await start();
      const before = await snapshotProject(tmpDir);
      const result = await swap({});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Cannot read family "Hostiles" (not valid JSON); what it gives its members is unknown, so whether an event can be swapped cannot be decided. Nothing was changed.');
      noPath(textOf(result));
      expect(await snapshotProject(tmpDir)).toEqual(before);
    });
  });

  it('warns about a missing animation only for an event it swaps', async () => {
    await addEvents(
      block(700000000000090, [{ id: 'set-animation', objectClass: 'Player', parameters: { animation: '"Run"' } }]),
      block(700000000000091, [
        { id: 'set-animation', objectClass: 'Player', parameters: { animation: '"Jump"' } },
        { id: 'set-enabled', objectClass: 'Player', behaviorType: 'Platform', parameters: { state: 'enabled' } },
      ]),
    );
    const data = parse(await swap({ sheetName: 'Main', dryRun: true }));
    expect(data.skippedEvents.map(s => s.eventSid)).toContain(700000000000091);
    expect(data.warnings!.filter(w => w.includes('names animation'))).toEqual(['"set-animation" names animation "Run", which Enemy does not have; it was swapped anyway.']);
  });

  it('counts the uses inside a custom action definition it leaves', async () => {
    const OWNED = 700000000000110;
    await addEvents({
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'Own', objectClass: 'Hostiles', functionParameters: [], sid: OWNED,
      conditions: [{ id: 'is-visible', objectClass: 'Hostiles' }], actions: [{ id: 'destroy', objectClass: 'Hostiles' }],
    });
    await editJson<{ families: { subfolders: Array<{ items: string[] }> } }>(['project.c3proj'], p => { p.families.subfolders[0].items.push('Others'); });
    await writeFile(path('families', 'Groups', 'Others.json'), JSON.stringify({
      name: 'Others', 'plugin-id': 'Sprite', sid: 650000000000009, instanceVariables: [], behaviorTypes: [], effectTypes: [], members: [],
    }));
    await start();
    const data = parse(await server.callTool('replace_object_in_events', { fromObject: 'Hostiles', toObject: 'Others', dryRun: true }));
    const row = data.skippedEvents.find(s => s.eventSid === OWNED)!;
    expect(row.references).toBe(3);
    expect(row.reasons).toEqual(['custom action definition: its owner and the events inside it are not replaced']);
  });

  describe('names that share the object\'s name', () => {
    const SHARED = 700000000000120;
    const sharing: Ev = block(SHARED, [
      { id: 'a', objectClass: 'System', parameters: { timeline: 'Player' } },
      { id: 'b', objectClass: 'System', parameters: { property: 'Player' } },
      { id: 'c', objectClass: 'System', parameters: { function: 'Player' } },
      { id: 'd', objectClass: 'System', parameters: { file: 'Player' } },
      { id: 'e', objectClass: 'System', parameters: { object: 'Player' } },
    ]);

    it('leaves a timeline, property, function or file name, in a real call and a dry run', async () => {
      const baseline = parse(await swap({ sheetName: 'Main', dryRun: true }));
      await addEvents(sharing);
      const dry = parse(await swap({ sheetName: 'Main', dryRun: true }));
      expect(dry.references.byKind['object parameter']).toBe(baseline.references.byKind['object parameter'] + 1);
      expect(dry.references.total).toBe(baseline.references.total + 1);
      expect(dry.notChanged).toEqual(baseline.notChanged);
      await swap({ sheetName: 'Main' });
      expect((await mainEvent(SHARED)).actions!.map(a => a.parameters)).toEqual([
        { timeline: 'Player' }, { property: 'Player' }, { function: 'Player' }, { file: 'Player' }, { object: 'Enemy' },
      ]);
    });
  });

  describe('Self and behavior ids in expressions', () => {
    const SELF = 700000000000130;
    const selfCase = (sid: number, objectClass: string, value: string, withPlayer = false): Ev =>
      block(sid, [...(withPlayer ? [{ id: 'destroy', objectClass: 'Player' }] : []), { id: 'set-x', objectClass, parameters: { x: value } }]);
    const skippedSids = async () => parse(await swap({ sheetName: 'Main', dryRun: true })).skippedEvents.map(s => s.eventSid);

    it('checks Self members against the object the action is on', async () => {
      await editObject('Player', o => { o.instanceVariables.push({ name: 'hp', type: 'number' }); });
      await addEvents(
        selfCase(SELF, 'Player', 'Self.hp'),
        selfCase(SELF + 1, 'Other', 'Self.hp', true),
        selfCase(SELF + 2, 'Player', 'Self.Platform.Speed'),
      );
      const dry = parse(await swap({ sheetName: 'Main', dryRun: true }));
      const row = dry.skippedEvents.find(s => s.eventSid === SELF)!;
      expect(row.reasons).toEqual(['"set-x" reads Self.hp, an instance variable Enemy does not have']);
      expect(dry.skippedEvents.map(s => s.eventSid)).not.toContain(SELF + 1);
      expect(dry.skippedEvents.find(s => s.eventSid === SELF + 2)!.reasons).toEqual(['"set-x" reads Self.Platform, a behavior: Enemy does not have it']);
      await swap({ sheetName: 'Main' });
      expect((await mainEvent(SELF)).actions![0].objectClass).toBe('Player');
      expect((await mainEvent(SELF + 1)).actions![0].objectClass).toBe('Enemy');
      expect((await mainEvent(SELF + 2)).actions![0].objectClass).toBe('Player');
      // With the variable on Enemy the event is swapped
      await editObject('Enemy', o => { o.instanceVariables.push({ name: 'hp', type: 'number' }); });
      expect(await skippedSids()).not.toContain(SELF);
    });

    it('compares behavior ids in expressions, not only in conditions and actions', async () => {
      await editObject('Player', o => { o.behaviorTypes.push({ behaviorId: 'Car', name: 'Motion' }); });
      await editObject('Enemy', o => { o.behaviorTypes.push({ behaviorId: 'Bullet', name: 'Motion' }); });
      await addEvents(selfCase(SELF, 'Player', 'Player.Motion.Speed'), selfCase(SELF + 1, 'Player', 'Self.Motion.Speed'));
      const dry = parse(await swap({ sheetName: 'Main', dryRun: true }));
      for (const sid of [SELF, SELF + 1]) {
        const reasons = dry.skippedEvents.find(s => s.eventSid === sid)!.reasons;
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('it is a Car behavior on Player but a Bullet behavior on Enemy');
      }
      await swap({ sheetName: 'Main' });
      expect((await mainEvent(SELF)).actions![0].parameters).toEqual({ x: 'Player.Motion.Speed' });
      // Equal ids: swapped
      await editObject('Enemy', o => { o.behaviorTypes = o.behaviorTypes.filter(b => b.name !== 'Motion').concat({ behaviorId: 'Car', name: 'Motion' }); });
      expect(await skippedSids()).not.toContain(SELF);
      expect(await skippedSids()).not.toContain(SELF + 1);
      await swap({ sheetName: 'Main' });
      expect((await mainEvent(SELF)).actions![0].parameters).toEqual({ x: 'Enemy.Motion.Speed' });
      expect((await mainEvent(SELF + 1)).actions![0].objectClass).toBe('Enemy');
    });
  });

  describe('depth limit', () => {
    /** A chain of `length` nested events, each in the children of the last; `fill` makes the event at a level. */
    function chain(length: number, fill: (level: number) => Ev): Ev {
      const root = fill(0);
      let tail = root;
      for (let level = 1; level < length; level++) {
        const next = fill(level);
        tail.children = [next];
        tail = next;
      }
      return root;
    }
    const plain = (sid: number): Ev => block(sid, [{ id: 'wait', objectClass: 'System', parameters: { seconds: '1' } }]);
    const withPlayer = (sid: number, extra: Ace[] = []): Ev => block(sid, [{ id: 'destroy', objectClass: 'Player' }, ...extra]);
    const CHAIN = 700000000000200;

    it('refuses a branch nested deeper than the limit, whole', async () => {
      const levels = MAX_EVENT_DEPTH + 2;
      const root = chain(levels, level => (level === 0 ? withPlayer(CHAIN) : level === levels - 1
        ? withPlayer(CHAIN + level, [{ id: 'set-enabled', objectClass: 'Player', behaviorType: 'Platform' }]) : plain(CHAIN + level)));
      await addEvents(root);
      const data = parse(await swap({ sheetName: 'Main' }));
      const row = data.skippedEvents.find(s => s.eventSid === CHAIN)!;
      expect(row.reasons.some(r => r.endsWith(DEPTH_MESSAGE))).toBe(true);
      expect(row.references).toBe(3);
      let event = await mainEvent(CHAIN);
      expect(event.actions![0].objectClass).toBe('Player');
      while (event.children) event = event.children[0];
      expect(event.actions![0].objectClass).toBe('Player');
    });

    it('lists what is below the limit when nothing above it references the object', async () => {
      const levels = MAX_EVENT_DEPTH + 2;
      await addEvents(chain(levels, level => (level === levels - 1 ? withPlayer(CHAIN + level) : plain(CHAIN + level))));
      const data = parse(await swap({ sheetName: 'Main' }));
      const row = data.skippedEvents.find(s => s.reasons.includes(DEPTH_MESSAGE))!;
      expect(row.references).toBe(1);
      let event = await mainEvent(CHAIN);
      while (event.children) event = event.children[0];
      expect(event.actions![0].objectClass).toBe('Player');
    });

    it('leaves a branch within the limit alone', async () => {
      const levels = MAX_EVENT_DEPTH - 2;
      await addEvents(chain(levels, level => (level === 0 || level === levels - 1 ? withPlayer(CHAIN + level) : plain(CHAIN + level))));
      const data = parse(await swap({ sheetName: 'Main' }));
      expect(data.skippedEvents.map(s => s.eventSid)).not.toContain(CHAIN);
      let event = await mainEvent(CHAIN);
      expect(event.actions![0].objectClass).toBe('Enemy');
      while (event.children) event = event.children[0];
      expect(event.actions![0].objectClass).toBe('Enemy');
    });
  });
});
