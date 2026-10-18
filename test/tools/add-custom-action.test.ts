/**
 * add_custom_action adds a custom action definition (a custom action block) to
 * an event sheet, and move_events_between_sheets refuses to copy one. All data
 * is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { withProjectSync } from '../../src/tools/project-sync.js';
import { Construct3ProjectReader, type ReadFailure } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { searchText, type RawTextTerm } from '../../src/construct3/raw-text-search.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const tick = { id: 'every-tick', objectClass: 'System' };

/** A custom action block as the editor saves it. */
function customAction(owner: string, name: string, sid: number, extra: Ev = {}): Ev {
  return {
    aceType: 'action', aceName: name, objectClass: owner, functionDescription: '', functionCategory: '', functionReturnType: 'none',
    functionCopyPicked: false, functionIsAsync: false, functionParameters: [], eventType: 'custom-ace-block', conditions: [], actions: [], sid, ...extra,
  };
}

const DUPLICATE_RULE = 'A call names a custom action by its name, so it could not tell two apart (Construct 3 r506-2 (Free edition) opened such a project, ran the first definition, and renamed the second one when it saved: DoK became DoK2). Choose another name.';
const TRAVERSAL = 'The check for custom actions of that name stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown.';

/**
 * Group "G" (variable "hp"), block 20 (sub-event 21), block 30 and its else block 31,
 * custom actions Alpha.Hurt (70) and Fam.Wave (71).
 */
function sheetEvents(): Ev[] {
  return [
    { eventType: 'group', disabled: false, title: 'G', description: '', isActiveOnStart: true, sid: 10,
      children: [{ eventType: 'variable', name: 'hp', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 11 }] },
    block(20, { conditions: [tick], children: [block(21)] }),
    block(30, { conditions: [{ ...tick, sid: 32 }] }),
    block(31, { conditions: [{ id: 'else', objectClass: 'System', sid: 33 }] }),
    customAction('Alpha', 'Hurt', 70, { functionParameters: [{ name: 'amount', type: 'number', initialValue: '0', comment: '', sid: 72 }] }),
    customAction('Fam', 'Wave', 71),
  ];
}

/** A reader that also registers event sheets it cannot parse (name to text), as the real reader reports them: absent from the bulk read, searchable as text. */
class UnparsableSheetsReader extends MockReader {
  constructor(data: ConstructorParameters<typeof MockReader>[0], private readonly unparsable: Record<string, string | null>) {
    super(data);
  }
  override async listEventSheets(): Promise<string[]> {
    return [...await super.listEventSheets(), ...Object.keys(this.unparsable)];
  }
  override getReadFailures(category: string): Map<string, ReadFailure> {
    if (category !== 'eventSheets') return super.getReadFailures(category);
    return new Map(Object.keys(this.unparsable).map(name => [name, { code: 'E_INVALID_JSON', message: 'not valid JSON' } as ReadFailure]));
  }
  override async searchEntityTextRaw(category: Parameters<MockReader['searchEntityTextRaw']>[0], name: string, terms: readonly RawTextTerm[]): Promise<Set<string>> {
    const text = this.unparsable[name];
    if (category === 'eventSheets' && text === null) throw new Error(`${name}: cannot be read as text either`);
    return category === 'eventSheets' && typeof text === 'string' ? searchText(text, terms) : super.searchEntityTextRaw(category, name, terms);
  }
}

/**
 * The sheet events plus: block 40 (On start) with the group 41 below it, block 50 with the group 51 below it,
 * function block 80 with the group 81 below it, and the group 60 "Outer" holding the group 61 "Inner".
 */
function nestedEvents(): Ev[] {
  const group = (title: string, sid: number, children: Ev[] = []): Ev => ({ eventType: 'group', disabled: false, title, description: '', isActiveOnStart: true, sid, children });
  return [
    ...sheetEvents(),
    block(40, { conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 42 }], children: [group('UnderStart', 41)] }),
    block(50, { conditions: [tick], children: [group('UnderBlock', 51)] }),
    { functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
      functionParameters: [], eventType: 'function-block', conditions: [], actions: [], sid: 80, children: [group('UnderFunction', 81)] },
    group('Outer', 60, [group('Inner', 61)]),
  ];
}

function setup(other: Ev[] = [], unparsable: Record<string, string | null> = {}, events: Ev[] = sheetEvents()) {
  const server = new MockServer();
  const reader = new UnparsableSheetsReader({
    objects: new Map([
      ['Alpha', { name: 'Alpha', 'plugin-id': 'Sprite', sid: 1 }],
      ['Beta', { name: 'Beta', 'plugin-id': 'Sprite', sid: 2 }],
    ]),
    families: new Map([['Fam', { name: 'Fam', members: ['Alpha'], sid: 3 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 1, events }], ['Other', { name: 'Other', sid: 2, events: other }]]),
  }, unparsable);
  const writer = new MockWriter();
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  return { server, reader, writer, events };
}
const parse = (r: Result) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const errorText = (r: Result) => (r.isError ? r.content[0].text : '');
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const eventWith = (events: Ev[], sid: number): Ev => {
  const found = events.find(e => e.sid === sid);
  if (!found) throw new Error(`no event ${sid}`);
  return found;
};

/** A sheet of 100,000 comments and then the custom action Alpha.DoK, past what a scan visits. */
function bigSheetEvents(): Ev[] {
  return [...Array.from({ length: 100_000 }, () => ({ eventType: 'comment', text: 'x' })), customAction('Alpha', 'DoK', 900)];
}

describe('add_custom_action', () => {
  it('writes the definition in the key order the editor saves, with parameter SIDs', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_custom_action', {
      sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Jump', description: 'Jumps', category: 'Moves',
      parameters: [{ name: 'height', type: 'number' }, { name: 'high', type: 'boolean' }, { name: 'label', type: 'string', initialValue: 'x', comment: 'c' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    expect(data.eventPath).toBe('events[6]');
    const event = eventWith(written(writer), data.generatedSid as number);
    expect(Object.keys(event)).toEqual([
      'aceType', 'aceName', 'objectClass', 'functionDescription', 'functionCategory', 'functionReturnType', 'functionCopyPicked',
      'functionIsAsync', 'functionParameters', 'eventType', 'conditions', 'actions', 'sid',
    ]);
    expect(event).toMatchObject({
      aceType: 'action', aceName: 'Jump', objectClass: 'Alpha', functionDescription: 'Jumps', functionCategory: 'Moves',
      functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false, eventType: 'custom-ace-block', conditions: [], actions: [],
    });
    const parameters = event.functionParameters as Ev[];
    expect(parameters.map(p => Object.keys(p))).toEqual(Array(3).fill(['name', 'type', 'initialValue', 'comment', 'sid']));
    expect(parameters.map(p => p.initialValue)).toEqual(['0', 'false', 'x']);
    expect(data.parameterSids).toEqual(parameters.map(p => ({ name: p.name, sid: p.sid })));
    expect(new Set([event.sid, ...parameters.map(p => p.sid)]).size).toBe(4);
  });

  it('writes the options as given', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Fam', aceName: 'Pulse', isAsync: true, copyPicked: true }));
    expect(eventWith(written(writer), data.generatedSid as number)).toMatchObject({ functionIsAsync: true, functionCopyPicked: true });
    expect(data.parameterSids).toBeUndefined();
  });

  it('refuses System, the Functions object, and a name that is no object type or family, with a hint for a case variant', async () => {
    const { server, writer } = setup();
    const refuse = async (objectClass: string) => errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass, aceName: 'New' }));
    const general = (name: string) => `Unknown objectClass "${name}". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.`;
    expect(await refuse('System')).toBe(general('System'));
    expect(await refuse('Functions')).toBe(general('Functions'));
    expect(await refuse('Nope')).toBe(general('Nope'));
    expect(await refuse('alpha')).toBe('Unknown objectClass "alpha": object type and family names are matched with their letter case. Did you mean "Alpha"? Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses an empty aceName', async () => {
    const { server } = setup();
    expect(errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: '  ' }))).toBe('aceName is empty. Nothing was changed.');
  });

  it('refuses a second custom action of the same name on the same owner, ignoring case, naming the sheet', async () => {
    const { server, writer } = setup([customAction('Beta', 'Dup', 80)]);
    const same = errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'hurt' }));
    expect(same).toBe(`"Alpha" already has a custom action "Hurt" (sheet "Sheet1", events[4], SID 70). ${DUPLICATE_RULE} Nothing was changed.`);
    const other = errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Beta', aceName: 'DUP' }));
    expect(other).toBe(`"Beta" already has a custom action "Dup" (sheet "Other", events[0], SID 80). ${DUPLICATE_RULE} Nothing was changed.`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('allows the same name on another object type, and a member\'s override of its family\'s action', async () => {
    const { server } = setup();
    expect(parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Beta', aceName: 'Hurt' })).success).toBe(true);
    expect(parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Wave' })).success).toBe(true);
  });

  it('refuses parameter names the editor refuses for function parameters', async () => {
    const { server, writer } = setup();
    const call = async (names: string[]) => errorText(await server.callTool('add_custom_action', {
      sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'New', parameters: names.map(name => ({ name, type: 'number' })),
    }));
    const caseClash = await call(['a', 'A']);
    expect(caseClash).toMatch(/^parameters lists "a" and "A", which differ only in case\. /);
    expect(caseClash).toMatch(/Nothing was changed\.$/);
    expect(await call(['random'])).toMatch(/^"random" is the name of the System expression "random"\..*Nothing was changed\.$/);
    expect(await call(['b', 'b'])).toMatch(/^parameters lists "b" more than once\. /);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('places the definition at the top level and in a group, and refuses it in a block or a custom action block', async () => {
    const { server, writer } = setup();
    const top = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'A1' }));
    expect(top.eventPath).toBe('events[6]');
    const group = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'A2', groupPath: 'G' }));
    expect(group.eventPath).toBe('events[0].children[1]');
    const before = JSON.stringify(written(writer));
    const inBlock = errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'A3', parentSid: 20 }));
    expect(inBlock).toMatch(/^A custom action block is not placed among the sub-events of a block: .*Nothing was changed\.$/);
    const inCustom = errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'A4', parentSid: 70 }));
    expect(inCustom).toMatch(/^A custom action block is not placed among the sub-events of a custom action block: .*Nothing was changed\.$/);
    expect(JSON.stringify(written(writer))).toBe(before);
  });

  it('checks parameter names against the variables of the group it goes into', async () => {
    const { server } = setup();
    const text = errorText(await server.callTool('add_custom_action', {
      sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'New', groupPath: 'G', parameters: [{ name: 'hp', type: 'number' }],
    }));
    expect(text).toContain('"hp"');
    expect(text).toMatch(/Nothing was changed\.$/);
    const top = parse(await server.callTool('add_custom_action', {
      sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'New', parameters: [{ name: 'hp', type: 'number' }],
    }));
    expect(top.success).toBe(true);
  });

  it('refuses when an event sheet it could not parse may define a custom action of that name', async () => {
    const { server, writer } = setup([], { Bad: '{"events":[{"aceName":"Jump","objectClass":"Alpha"' });
    const result = await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Jump' });
    const data = parse(result);
    expect(data.success).toBe(false);
    expect(data.action).toBe('add_blocked');
    expect(String(data.message)).toMatch(/One of them may already define a custom action "Jump" on "Alpha"\. Use force=true to add it anyway\. Nothing was changed\.$/);
    expect(data.unscannedFiles).toHaveLength(1);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses while a registered sheet cannot be read at all, and adds with force and a warning', async () => {
    const { server, writer } = setup([], { Gone: null });
    const refused = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Jump' }));
    expect(refused.action).toBe('add_blocked');
    expect(String(refused.message)).toMatch(/Use force=true to add it anyway\. Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Jump', force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('Added with force=true:');
  });

  it('adds with force while a sheet cannot be parsed and may define the name, and warns', async () => {
    const { server, writer } = setup([], { Bad: '{"events":[{"aceName":"Jump","objectClass":"Alpha"' });
    const data = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Jump', force: true }));
    expect(data.success).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(String(data.warnings)).toContain('Added with force=true:');
    expect(data.unscannedFiles).toHaveLength(1);
  });

  it('warns about a sheet it searched as text and found no match in', async () => {
    const { server } = setup([], { Bad: '{"events":[{"aceName":"Other"' });
    const data = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Jump' }));
    expect(data.success).toBe(true);
    expect(String(data.warnings)).toContain('could not be parsed and was only searched as text');
    expect(String(data.warnings)).toContain('none of these was found');
  });

  it('refuses to add while the scan for a custom action of that name stopped at its limit, and adds with force', async () => {
    const { server, writer } = setup(bigSheetEvents());
    const refused = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'DoK2' }));
    expect(refused.action).toBe('add_blocked');
    expect(refused.message).toBe(`${TRAVERSAL} Use force=true to add it anyway. Nothing was changed.`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'DoK2', force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings).toEqual([`Added with force=true: ${TRAVERSAL}`]);
  });

  it('warns when the new block separates a block from its else block', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Gap', siblingSid: 30, position: 'after' }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain(`The else block with SID 31 now follows the event with SID ${String(data.generatedSid)} instead of the event with SID 30, so it runs when that event's conditions are false.`);
    expect(String(data.warnings)).toContain('eventSheets/Sheet1 > block (sid 31): Else block: the event before it is a custom-ace-block (comments aside), so there is no block for it to be the else of');
  });

  it('puts the sheet in memory back when a scan after the insert throws, and says nothing was changed', async () => {
    // The else-block scan refuses events nested deeper than 50; force gets past the incomplete-scan refusal
    let deep: Ev = block(98);
    for (let depth = 0; depth < 52; depth++) deep = block(99000 + depth, { children: [deep] });
    const { server, reader, writer } = setup([], {}, [...sheetEvents(), deep]);
    const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
    const result = await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Late', force: true });
    expect(errorText(result)).toBe('The change was stopped before anything was written: Sub-event scan exceeded depth 50. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
  });

  it('puts the sheet in memory back when its write fails, and keeps the write error', async () => {
    const { server, reader, writer } = setup();
    const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
    (writer as unknown as { writeEntityFile: () => Promise<string> }).writeEntityFile = async () => { throw new Error('disk full'); };
    const result = await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Late' });
    expect(errorText(result)).toContain('disk full');
    expect(errorText(result)).not.toContain('stopped before anything was written');
    expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup();
    await expect(server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'New', bogus: 1 })).rejects.toThrow();
    await expect(server.callTool('add_custom_action', {
      sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'New', parameters: [{ name: 'a', type: 'number', bogus: 1 }],
    })).rejects.toThrow();
  });

  it('says a sheet that is not registered is not found, and a registered sheet that cannot be read could not be read', async () => {
    const { server } = setup([], { Bad: '{"events"' });
    const missing = errorText(await server.callTool('add_custom_action', { sheetName: 'sheet1', objectClass: 'Alpha', aceName: 'New' }));
    expect(missing).toMatch(/Did you mean "Sheet1"\? Nothing was changed\.$/);
    const unreadable = errorText(await server.callTool('add_custom_action', { sheetName: 'Bad', objectClass: 'Alpha', aceName: 'New' }));
    expect(unreadable).toBe('Event sheet "Bad" is registered in the project but could not be read. Nothing was changed.');
  });

  it('allows a definition only where every event above it is a group', async () => {
    const { server } = setup([], {}, nestedEvents());
    const inner = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Deep', groupPath: 'Outer > Inner' }));
    expect(inner.eventPath).toBe('events[9].children[0].children[0]');
    const beside = parse(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Beside', siblingSid: 61, position: 'after' }));
    expect(beside.eventPath).toBe('events[9].children[1]');
  });

  it('refuses a definition in a group below an On start block, a block, a function block or a custom action block', async () => {
    const { server, writer } = setup([], {}, nestedEvents());
    for (const [parentSid, what] of [[41, 'a block with conditions (SID 40)'], [51, 'a block with conditions (SID 50)'], [81, 'a function block (SID 80)']] as const) {
      const text = errorText(await server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Deep', parentSid }));
      expect(text, String(parentSid)).toMatch(new RegExp(`^A custom action block is not placed in a group that stands below ${what.replace(/[()]/g, '\\$&')}: Construct 3 r506-2 \\(Free edition\\) was seen accepting one only at the top level and in a top-level group, `));
      expect(text, String(parentSid)).toContain('a trigger root');
      expect(text, String(parentSid)).toMatch(/Nothing was changed\.$/);
    }
    // Beside an event of such a group
    const events = nestedEvents();
    (events.find(e => e.sid === 40)!.children as Ev[])[0].children = [block(43)];
    const beside = setup([], {}, events);
    expect(errorText(await beside.server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Deep', siblingSid: 43, position: 'before' })))
      .toContain('stands below a block with conditions (SID 40)');
    // A custom action block among the ancestors of a group (a sheet saved that way)
    const custom = nestedEvents();
    (custom.find(e => e.sid === 70)!).children = [{ eventType: 'group', disabled: false, title: 'InCustom', description: '', isActiveOnStart: true, sid: 71000, children: [] }];
    const inCustom = setup([], {}, custom);
    expect(errorText(await inCustom.server.callTool('add_custom_action', { sheetName: 'Sheet1', objectClass: 'Alpha', aceName: 'Deep', parentSid: 71000 })))
      .toContain('stands below a custom action block (SID 70)');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const big = bigSheetEvents();
    const cases: Array<{ args: Record<string, unknown>; other?: Ev[]; unparsable?: Record<string, string | null>; nested?: boolean }> = [
      { args: { objectClass: 'Alpha', aceName: 'New', parentSid: 41 }, nested: true },
      { args: { objectClass: 'Alpha', aceName: 'New', parentSid: 51 }, nested: true },
      { args: { objectClass: 'Alpha', aceName: 'New', parentSid: 81 }, nested: true },
      { args: { sheetName: 'sheet1', objectClass: 'Alpha', aceName: 'New' } },
      { args: { sheetName: 'Bad', objectClass: 'Alpha', aceName: 'New' }, unparsable: { Bad: '{"events"' } },
      { args: { objectClass: 'Alpha', aceName: 'Jump' }, unparsable: { Gone: null } },
      { args: { objectClass: 'System', aceName: 'New' } },
      { args: { objectClass: 'Functions', aceName: 'New' } },
      { args: { objectClass: 'Nope', aceName: 'New' } },
      { args: { objectClass: 'alpha', aceName: 'New' } },
      { args: { objectClass: 'Alpha', aceName: '' } },
      { args: { objectClass: 'Alpha', aceName: 'HURT' } },
      { args: { objectClass: 'Alpha', aceName: 'New', parameters: [{ name: 'a', type: 'number' }, { name: 'A', type: 'number' }] } },
      { args: { objectClass: 'Alpha', aceName: 'New', parameters: [{ name: 'random', type: 'number' }] } },
      { args: { objectClass: 'Alpha', aceName: 'New', parentSid: 20 } },
      { args: { objectClass: 'Alpha', aceName: 'New', parentSid: 70 } },
      { args: { objectClass: 'Alpha', aceName: 'New', groupPath: 'G', parameters: [{ name: 'hp', type: 'number' }] } },
      { args: { objectClass: 'Alpha', aceName: 'New', groupPath: 'Missing' } },
      { args: { objectClass: 'Alpha', aceName: 'Jump' }, unparsable: { Bad: '{"events":[{"aceName":"Jump","objectClass":"Alpha"' } },
      { args: { objectClass: 'Alpha', aceName: 'New' }, other: big },
    ];
    for (const { args, other, unparsable, nested } of cases) {
      const { server, writer, events } = setup(other ?? [], unparsable ?? {}, nested ? nestedEvents() : sheetEvents());
      const before = JSON.stringify(events);
      const result = await server.callTool('add_custom_action', { sheetName: 'Sheet1', ...args });
      const text = result.isError ? result.content[0].text : String(parse(result).message);
      expect(text, JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
      expect(text.match(/Nothing was changed\./g), JSON.stringify(args)).toHaveLength(1);
      expect(JSON.stringify(events), JSON.stringify(args)).toBe(before);
      expect(writer.callsFor('writeEntityFile'), JSON.stringify(args)).toHaveLength(0);
    }
  });
});

describe('move_events_between_sheets and custom actions', () => {
  it('refuses to copy a custom action block, and moves one', async () => {
    const { server, writer } = setup();
    const copy = errorText(await server.callTool('move_events_between_sheets', { sourceSheet: 'Sheet1', targetSheet: 'Other', sids: [70], deleteSource: false }));
    expect(copy).toMatch(/^Copying these events to "Other" would leave two custom actions of one name on one object type or family:\n- "Alpha\.Hurt": sheet "Sheet1" \(events\[4\]\), sheet "Other" \(events\[0\]\)\n\n/);
    expect(copy).toContain(DUPLICATE_RULE);
    expect(copy).toMatch(/ Move the custom action instead \(deleteSource: true\)\. Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const move = parse(await server.callTool('move_events_between_sheets', { sourceSheet: 'Sheet1', targetSheet: 'Other', sids: [70], deleteSource: true }));
    expect(move.success).toBe(true);
  });

  it('still copies events that define no custom action', async () => {
    const { server } = setup();
    const copy = parse(await server.callTool('move_events_between_sheets', { sourceSheet: 'Sheet1', targetSheet: 'Other', sids: [20], deleteSource: false }));
    expect(copy.success).toBe(true);
  });

  it('lists at most ten of the custom actions a copy would duplicate', async () => {
    const many = Array.from({ length: 11 }, (_, i) => customAction('Alpha', `N${i}`, 200 + i));
    const { server, writer } = setup([], {}, [...sheetEvents(), ...many]);
    const text = errorText(await server.callTool('move_events_between_sheets', {
      sourceSheet: 'Sheet1', targetSheet: 'Other', sids: many.map(e => e.sid as number), deleteSource: false,
    }));
    expect(text.match(/^- "Alpha\.N\d+":/gm)).toHaveLength(10);
    expect(text).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('moves events while the scan for custom actions stopped at its limit', async () => {
    const { server } = setup(bigSheetEvents());
    const move = parse(await server.callTool('move_events_between_sheets', { sourceSheet: 'Sheet1', targetSheet: 'Other', sids: [20], deleteSource: true }));
    expect(move.success).toBe(true);
  });

  it('refuses to copy events while the scan for custom actions stopped at its limit', async () => {
    const { server, writer } = setup(bigSheetEvents());
    const copy = errorText(await server.callTool('move_events_between_sheets', { sourceSheet: 'Sheet1', targetSheet: 'Other', sids: [20], deleteSource: false }));
    expect(copy).toBe(`The check for custom actions the copy would duplicate stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown. Move the events instead (deleteSource: true). Nothing was changed.`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('add_custom_action on disk', () => {
  const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
  let tmpDir: string;
  let server: MockServer;
  let writer: Construct3ProjectWriter;
  const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');

  /** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
  async function editorSave(path: string, text: string): Promise<void> {
    await writeFile(path, text);
    const { mtime } = await stat(path);
    const later = new Date(mtime.getTime() + 2000);
    await utimes(path, later, later);
  }

  /** The writer's read-back of the sheet fails once with an ordinary error; `before` runs first. */
  function failReadBack(before: () => Promise<void> = async () => {}): void {
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    let failed = false;
    internals.verifyWrittenFile = async (path, name, text) => {
      if (!failed && path.endsWith('MainSheet.json')) {
        failed = true;
        await before();
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(path, name, text);
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-add-custom-action-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    writer = new Construct3ProjectWriter(reader, new IdGenerator());
    server = new MockServer();
    // Through withProjectSync, so each call runs in a tool call scope and the writer records its backups
    registerEventTools({ server: withProjectSync(server, reader), reader, writer, idGen: new IdGenerator() } as unknown as MutationToolDeps);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes the definition to the sheet', async () => {
    const data = parse(await server.callTool('add_custom_action', { sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'Hurt' }));
    expect(data.success).toBe(true);
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    expect(sheet.events[1]).toMatchObject({ eventType: 'custom-ace-block', aceName: 'Hurt', objectClass: 'Sprite', sid: data.generatedSid });
  });

  it('puts the sheet back when its write fails its read-back', async () => {
    const before = await readFile(sheetPath(), 'utf8');
    failReadBack();
    const result = await server.callTool('add_custom_action', { sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'Hurt' });
    expect(errorText(result)).toContain('The call was rolled back: eventSheets/MainSheet.json is as before the call.');
    expect(await readFile(sheetPath(), 'utf8')).toBe(before);
  });

  it('leaves a sheet the editor saved after the failed write as it is and names its .bak', async () => {
    const saved = `${await readFile(sheetPath(), 'utf8')}\n\n`;
    failReadBack(() => editorSave(sheetPath(), saved));
    const result = await server.callTool('add_custom_action', { sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'Hurt' });
    expect(errorText(result)).toContain('left as it is: eventSheets/MainSheet.json');
    expect(errorText(result)).toContain('eventSheets/MainSheet.json.bak');
    expect(errorText(result)).not.toContain('Nothing was changed');
    // The left-as-it-is reason is the editor's save, not a missing tool call scope
    expect(errorText(result)).not.toContain('is no longer the copy this call made');
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
  });
});
