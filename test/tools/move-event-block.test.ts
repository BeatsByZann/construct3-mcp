/**
 * move_event_block moves an event with its sub-events to another place in
 * its sheet. Refused, changing nothing: a move into itself, a place the
 * placement rules do not allow, a function block placed where a function
 * block is not placed, a new load-time error, a name clash in the new scope,
 * and (without force) a move that takes a variable or parameter out of its
 * users' scope. A failed write is rolled back. Synthetic data.
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
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const variable = (name: string, sid: number): Ev => ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid });
const useOf = (name: string, sid: number): Ev => ({ id: 'compare-eventvar', objectClass: 'System', sid, parameters: { variable: name, comparison: 0, value: '1' } });
const onStart = (sid: number): Ev => ({ id: 'on-start-of-layout', objectClass: 'System', sid });
const functionBlock = (name: string, sid: number, extra: Ev = {}): Ev => ({
  functionName: name, functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
  functionParameters: [], eventType: 'function-block', conditions: [], actions: [], sid, ...extra,
});

/**
 * Group "G" (local "loc", block 11 using it), block 20 (sub-event 21), block 30 (On start),
 * function "F" (parameter "p", block 41 using it), group "H", global "glob", custom action "Alpha.Do" (70).
 */
function sheetEvents(): Ev[] {
  return [
    { eventType: 'group', disabled: false, title: 'G', description: '', isActiveOnStart: true, sid: 10, children: [variable('loc', 12), block(11, { conditions: [useOf('loc', 13)] })] },
    block(20, { children: [block(21)] }),
    block(30, { conditions: [onStart(31)] }),
    { functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
      functionParameters: [{ name: 'p', type: 'number', initialValue: '0', comment: '', sid: 42 }], eventType: 'function-block',
      conditions: [], actions: [], sid: 40, children: [block(41, { conditions: [useOf('p', 43)] })] },
    { eventType: 'group', disabled: false, title: 'H', description: '', isActiveOnStart: true, sid: 50, children: [] },
    variable('glob', 60),
    { aceType: 'action', aceName: 'Do', objectClass: 'Alpha', functionParameters: [], eventType: 'custom-ace-block', conditions: [], actions: [], sid: 70 },
  ];
}

function setup(other: Ev[] = []) {
  const server = new MockServer();
  const reader = new MockReader({
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 1, events: sheetEvents() }], ['Other', { name: 'Other', sid: 2, events: other }]]),
  });
  const writer = new MockWriter();
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  return { server, reader, writer };
}
const parse = (r: Result) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const errorText = (r: Result) => (r.isError ? r.content[0].text : '');
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const sids = (list: unknown): unknown[] => (list as Ev[]).map(e => e.sid);
const sheetOf = async (reader: MockReader) => (await reader.readEventSheet('Sheet1')).events as unknown as Ev[];

/** Adds function block "F2" (95), and block 90 with sub-event 91 that holds function block "F3" (92), at the top level; gives the custom action a sub-event block 71. */
async function addNested(reader: MockReader): Promise<void> {
  const events = await sheetOf(reader);
  events.push(functionBlock('F2', 95), block(90, { children: [block(91, { children: [functionBlock('F3', 92)] })] }));
  events[6].children = [block(71)];
}

describe('move_event_block', () => {
  it('moves a block into a group, keeping its SID and sub-events', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 20, groupPath: 'H' }));
    expect(data).toMatchObject({ success: true, action: 'updated', movedSid: 20, movedType: 'block', from: 'events[1]', to: 'events[3].children[0]', childrenMoved: 1 });
    const events = written(writer);
    expect(sids(events)).toEqual([10, 30, 40, 50, 60, 70]);
    expect(sids((events[3].children as Ev[]))).toEqual([20]);
    expect(sids(((events[3].children as Ev[])[0]).children)).toEqual([21]);
  });

  it('moves before and after a sibling, also within the same list', async () => {
    const { server, writer } = setup();
    await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 20, siblingSid: 50, position: 'after' });
    expect(sids(written(writer))).toEqual([10, 30, 40, 50, 20, 60, 70]);
    const second = setup();
    await second.server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 60, siblingSid: 20, position: 'before' });
    expect(sids(written(second.writer))).toEqual([10, 60, 20, 30, 40, 50, 70]);
  });

  it('reports a move to where the event already is as unchanged and writes nothing', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 30, siblingSid: 20, position: 'after' }));
    expect(data.action).toBe('unchanged');
    expect(data.editorNote).toBeUndefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a move into its own sub-events, and beside itself', async () => {
    const { server } = setup();
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 20, parentSid: 21 })))
      .toBe('The event with SID 20 cannot go into its own sub-events: the destination is inside the event being moved. Nothing was changed.');
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 20, parentSid: 20 })))
      .toBe('The event with SID 20 cannot go into its own sub-events: the destination is inside the event being moved. Nothing was changed.');
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 20, siblingSid: 20, position: 'after' })))
      .toBe('An event cannot be placed beside itself. Nothing was changed.');
  });

  it('refuses a place the placement rules do not allow', async () => {
    const { server } = setup();
    // PLACEMENT never allows a variable in a custom action block
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 60, parentSid: 70 })))
      .toMatch(/^An event variable is not placed among the sub-events of a custom action block: .+ Nothing was changed\.$/s);
  });

  it('refuses a sid, parentSid or siblingSid several events share, naming the eventPath argument that picks one', async () => {
    const { server, reader } = setup();
    const sheet = await reader.readEventSheet('Sheet1');
    (sheet.events as unknown as Ev[]).push(block(21));
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 21, groupPath: 'H' })))
      .toContain('Call again with eventPath set to the path of the event you mean');
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 30, parentSid: 21 })))
      .toContain('Call again with parentEventPath set to the path of the event you mean');
    expect(errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 30, siblingSid: 21, position: 'after' })))
      .toContain('Call again with siblingEventPath set to the path of the event you mean');
    const picked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 21, eventPath: 'events[7]', groupPath: 'H' }));
    expect(picked.from).toBe('events[7]');
  });

  it('leaves no empty sub-event list on a block whose last sub-event moved away', async () => {
    const { server, writer } = setup();
    await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 21, groupPath: 'H' });
    expect('children' in written(writer)[1]).toBe(false);
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup();
    await expect(server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 20, groupPath: 'H', bogus: 1 })).rejects.toThrow();
  });

  it('refuses a move that takes a used local variable away from its users, lists the uses, and moves with force', async () => {
    const { server, writer } = setup();
    const blocked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 12, groupPath: 'H' }));
    expect(blocked).toMatchObject({ success: false, action: 'move_blocked' });
    expect(String(blocked.message)).toContain('Event variable "loc" is still used 1 time(s)');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 12, groupPath: 'H', force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('Moved with force=true');
  });

  it('refuses a move of a block out of the function whose parameter it uses', async () => {
    const { server } = setup();
    const blocked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 41, groupPath: 'H' }));
    expect(blocked.action).toBe('move_blocked');
    expect(String(blocked.message)).toContain('"p"');
  });

  it('refuses a move that makes a use find another variable of the same name, and moves with force', async () => {
    const { server, reader, writer } = setup();
    const sheet = await reader.readEventSheet('Sheet1');
    // Group H gets its own local "loc"; block 11 in G uses G's "loc"
    ((sheet.events as unknown as Ev[])[4].children as Ev[]).push(variable('loc', 51));
    const blocked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 11, groupPath: 'H' }));
    expect(blocked).toMatchObject({ success: false, action: 'move_blocked' });
    expect(String(blocked.message)).toContain('where the name now finds another event variable or function parameter after the move');
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(JSON.stringify(blocked.reboundReferences)).toContain('"sheet":"Sheet1"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 11, groupPath: 'H', force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('reads or sets that one instead');
  });

  it('refuses a move of a block out of the custom action body whose parameter it uses', async () => {
    const { server, reader } = setup();
    const sheet = await reader.readEventSheet('Sheet1');
    const customAction = (sheet.events as unknown as Ev[])[6];
    customAction.functionParameters = [{ name: 'amt', type: 'number', initialValue: '0', comment: '', sid: 73 }];
    customAction.children = [block(71, { conditions: [useOf('amt', 72)] })];
    const blocked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 71, groupPath: 'H' }));
    expect(blocked.action).toBe('move_blocked');
    expect(String(blocked.message)).toContain('"amt"');
  });

  it('warns when an else block continues another block after the move', async () => {
    const { server, reader } = setup();
    const sheet = await reader.readEventSheet('Sheet1');
    (sheet.events as unknown as Ev[]).push(block(80), block(81), block(82, { conditions: [{ id: 'else', objectClass: 'System', sid: 83 }] }));
    const data = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 81, groupPath: 'H' }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('The else block with SID 82 now follows the event with SID 80 instead of the event with SID 81, so it runs when that event\'s conditions are false.');
  });

  it('refuses a global variable moved into a group while another sheet uses it', async () => {
    const { server } = setup([block(70, { conditions: [useOf('glob', 71)] })]);
    const blocked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 60, groupPath: 'H' }));
    expect(blocked.action).toBe('move_blocked');
    expect(JSON.stringify(blocked.references)).toContain('"sheet":"Other"');
  });

  it('refuses a variable whose name clashes in its new scope', async () => {
    const { server, reader } = setup();
    const sheet = await reader.readEventSheet('Sheet1');
    ((sheet.events as unknown as Ev[])[4].children as Ev[]).push(variable('LOC', 51));
    const result = await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 12, groupPath: 'H', force: true });
    expect(errorText(result)).toContain('"loc"');
    expect(errorText(result)).toMatch(/Nothing was changed\.$/);
  });

  it('refuses a trigger moved into a function block (load-time error)', async () => {
    const { server, writer } = setup();
    // A function block acts as a trigger for its sub-events, so "On start of layout" under it is an error of the gate
    const result = await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 30, parentSid: 40 });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a function block moved under a block that has a trigger, and a block that holds one at any depth', async () => {
    const cases: Array<Record<string, unknown>> = [
      { sid: 95, parentSid: 30 },
      { sid: 90, parentSid: 30 },
    ];
    for (const args of cases) {
      const { server, reader, writer } = setup();
      await addNested(reader);
      const text = errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', ...args }));
      expect(text, JSON.stringify(args)).toContain('cannot add another trigger to event branch');
      expect(text).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('refuses a function block moved under a function block or a custom action block, and a block that holds one', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['function block', { sid: 95, parentSid: 41 }],
      ['function block', { sid: 90, parentSid: 41 }],
      ['custom action block', { sid: 95, parentSid: 71 }],
      ['custom action block', { sid: 90, parentSid: 71 }],
    ];
    for (const [kind, args] of cases) {
      const { server, reader, writer } = setup();
      await addNested(reader);
      const text = errorText(await server.callTool('move_event_block', { sheetName: 'Sheet1', ...args }));
      expect(text, JSON.stringify(args)).toContain(`A function block is not placed under or below the ${kind} with SID`);
      expect(text).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('still moves a function block, and a block that holds one, where no trigger or function block encloses them', async () => {
    for (const args of [{ sid: 95, parentSid: 20 }, { sid: 95, groupPath: 'H' }, { sid: 90, groupPath: 'H' }, { sid: 90, parentSid: 20 }]) {
      const { server, reader } = setup();
      await addNested(reader);
      const data = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', ...args }));
      expect(data.success, JSON.stringify(args)).toBe(true);
    }
  });

  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const calls: Array<Record<string, unknown>> = [
      { sheetName: 'Sheet1', sid: 999, groupPath: 'H' },
      { sheetName: 'Sheet1', sid: 20, groupPath: 'Nope' },
      { sheetName: 'Sheet1', sid: 20, groupPath: 'H', parentSid: 10 },
      { sheetName: 'Sheet1', sid: 20, parentSid: 60 },
      { sheetName: 'Sheet1', sid: 20, parentSid: 21 },
      { sheetName: 'Sheet1', sid: 20, siblingSid: 20, position: 'before' },
      { sheetName: 'Sheet1', sid: 60, parentSid: 70 },
      // Refused after the event was moved in memory: a name clash and a load-time error
      { sheetName: 'Sheet1', sid: 12, groupPath: 'H', force: true, clash: true },
      { sheetName: 'Sheet1', sid: 30, parentSid: 40 },
      // A function block under a trigger, under a function block and under a custom action block
      { sheetName: 'Sheet1', sid: 95, parentSid: 30 },
      { sheetName: 'Sheet1', sid: 90, parentSid: 30 },
      { sheetName: 'Sheet1', sid: 95, parentSid: 41 },
      { sheetName: 'Sheet1', sid: 90, parentSid: 41 },
      { sheetName: 'Sheet1', sid: 95, parentSid: 71 },
    ];
    for (const { clash, ...args } of calls) {
      const { server, reader, writer } = setup();
      await addNested(reader);
      if (clash) ((await sheetOf(reader))[4].children as Ev[]).push(variable('LOC', 51));
      const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
      const result = await server.callTool('move_event_block', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(errorText(result), JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    }
  });

  it('a move refused for the scope of a variable leaves the sheet as it was', async () => {
    for (const args of [{ sid: 12, groupPath: 'H' }, { sid: 41, groupPath: 'H' }]) {
      const { server, reader, writer } = setup();
      const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
      const blocked = parse(await server.callTool('move_event_block', { sheetName: 'Sheet1', ...args }));
      expect(blocked.action, JSON.stringify(args)).toBe('move_blocked');
      expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    }
  });
});

describe('move_event_block on disk', () => {
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
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-move-event-block-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    sheet.events.push({ eventType: 'group', disabled: false, title: 'H', description: '', isActiveOnStart: true, children: [], sid: 410000000000001 });
    await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
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

  it('puts the sheet back when its write fails its read-back', async () => {
    const before = await readFile(sheetPath(), 'utf8');
    failReadBack();
    const result = await server.callTool('move_event_block', { sheetName: 'MainSheet', sid: 400000000000003, groupPath: 'H' });
    expect(errorText(result)).toContain('The call was rolled back: eventSheets/MainSheet.json is as before the call.');
    expect(await readFile(sheetPath(), 'utf8')).toBe(before);
  });

  it('leaves a sheet the editor saved after the failed write as it is and names its .bak', async () => {
    const saved = `${await readFile(sheetPath(), 'utf8')}\n\n`;
    failReadBack(() => editorSave(sheetPath(), saved));
    const result = await server.callTool('move_event_block', { sheetName: 'MainSheet', sid: 400000000000003, groupPath: 'H' });
    expect(errorText(result)).toContain('left as it is: eventSheets/MainSheet.json');
    expect(errorText(result)).toContain('eventSheets/MainSheet.json.bak');
    expect(errorText(result)).not.toContain('Nothing was changed');
    // The left-as-it-is reason is the editor's save, not a missing tool call scope
    expect(errorText(result)).not.toContain('is no longer the copy this call made');
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
  });

  it('moves the block on disk', async () => {
    const data = parse(await server.callTool('move_event_block', { sheetName: 'MainSheet', sid: 400000000000003, groupPath: 'H' }));
    expect(data.to).toBe('events[0].children[0]');
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    expect(((sheet.events[0].children as Ev[])[0]).sid).toBe(400000000000003);
  });
});
