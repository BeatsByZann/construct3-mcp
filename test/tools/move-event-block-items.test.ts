/**
 * move_event_block_items moves, reorders and copies conditions or actions
 * within a block and between blocks of one event sheet. Refused, changing
 * nothing: an else condition moved or copied, or an item put before one,
 * indexes that do not fit, a target over 100 items, an event that holds no
 * conditions and actions, an unknown object class, a new load-time error and
 * (without force) a move after which a use finds no declaration or another
 * one. A failed write is rolled back. All data is synthetic.
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
import { REFERENCE_CHECK_MAX_EVENTS, REBOUND_USE_CONSEQUENCE } from '../../src/construct3/analyzers/delete-references.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };

const cond = (sid: number, id: string, extra: Ev = {}): Ev => ({ id, objectClass: 'Sprite1', sid, ...extra });
const act = (sid: number): Ev => ({ id: 'set-visible', objectClass: 'Sprite1', sid, parameters: { visibility: 'visible' } });
const elseCond = (sid: number, extra: Ev = {}): Ev => ({ id: 'else', objectClass: 'System', sid, ...extra });
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const variable = (name: string, sid: number): Ev => ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid });
const group = (title: string, sid: number, children: Ev[] = []): Ev => ({ eventType: 'group', disabled: false, title, description: '', isActiveOnStart: true, sid, children });
const useOf = (sid: number, name: string): Ev => ({ id: 'compare-eventvar', objectClass: 'System', sid, parameters: { variable: name, comparison: 0, value: '1' } });

/**
 * Block 100 (two conditions, two actions), block 200 (enabled else first), block 300 (disabled else
 * first), block 400 (On start) with sub-event 401, function block 500 (parameter p, a condition that
 * uses it and Set return value) and an empty group 600.
 */
function sheetEvents(): Ev[] {
  return [
    block(100, { conditions: [cond(101, 'is-visible'), cond(102, 'is-on-screen')], actions: [act(103), act(104)] }),
    block(200, { conditions: [elseCond(201), cond(202, 'is-visible')] }),
    block(300, { conditions: [elseCond(301, { disabled: true }), cond(302, 'is-visible')] }),
    block(400, { conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 402 }], children: [block(401)] }),
    {
      functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'number', functionCopyPicked: false, functionIsAsync: false,
      functionParameters: [{ name: 'p', type: 'number', initialValue: '0', comment: '', sid: 501 }],
      eventType: 'function-block', sid: 500,
      conditions: [useOf(502, 'p')],
      actions: [{ id: 'set-function-return-value', objectClass: 'Functions', sid: 503, parameters: { value: '1' } }],
    },
    group('G', 600),
  ];
}

function setup(prepare?: (events: Ev[]) => void, other?: Ev[]) {
  const events = sheetEvents();
  prepare?.(events);
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
    eventSheets: new Map([
      ['Sheet1', { name: 'Sheet1', sid: 10, events }],
      ...(other ? [['Other', { name: 'Other', sid: 11, events: other }] as const] : []),
    ]),
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as unknown as Parameters<typeof registerEventTools>[0]);
  return { server, reader, writer, idGen };
}

const parse = (result: Result) => JSON.parse(result.content[0].text) as Record<string, unknown> & { warnings?: string[]; sids?: number[] };
const errorText = (result: Result): string => {
  expect(result.isError).toBe(true);
  return result.content[0].text;
};
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const blockOf = (events: Ev[], sid: number): Ev => events.find(e => e.sid === sid)!;
const sidsOf = (items: unknown): unknown[] => (items as Ev[]).map(i => i.sid);
const sheetJson = async (reader: MockReader) => JSON.stringify(await reader.readEventSheet('Sheet1'));
const manyBlocks = (): Ev[] => Array.from({ length: REFERENCE_CHECK_MAX_EVENTS + 1 }, (_, i) => block(500000 + i));
const deepBlock = (): Ev => {
  let inner: Ev = block(98);
  for (let depth = 0; depth < 52; depth++) inner = block(99000 + depth, { children: [inner] });
  return inner;
};
const fillActions = (events: Ev[]) => { (events[0].actions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => act(1000 + i))); };
const fillConditions = (events: Ev[]) => { (events[0].conditions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => cond(1000 + i, 'is-visible'))); };

/** Groups A and B, each with a local variable n; block 700 in A holds a use of n, block 710 in B is empty. */
const withTwoScopes = (events: Ev[]) => {
  events.push(
    group('A', 690, [variable('n', 691), block(700, { actions: [{ id: 'add-to-eventvar', objectClass: 'System', sid: 701, parameters: { variable: 'n', value: '1' } }] })]),
    group('B', 695, [variable('n', 696), block(710)]),
  );
};

const call = (server: MockServer, args: Ev) => server.callTool('move_event_block_items', { sheetName: 'Sheet1', ...args });

describe('move_event_block_items', () => {
  it('reorders the actions of one block', async () => {
    const { server, writer } = setup();
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 }));
    expect(data).toMatchObject({ success: true, action: 'updated', sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', copy: false, targetIndex: 1, sids: [103] });
    expect(sidsOf(blockOf(written(writer), 100).actions)).toEqual([104, 103]);
  });

  it('moves conditions to another block at an index', async () => {
    const { server, writer } = setup();
    const data = parse(await call(server, { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'conditions', indices: [1], targetIndex: 1 }));
    expect(data.success).toBe(true);
    expect(data.sids).toEqual([202]);
    expect(data.warnings).toBeUndefined();
    expect(sidsOf(blockOf(written(writer), 200).conditions)).toEqual([201]);
    expect(sidsOf(blockOf(written(writer), 100).conditions)).toEqual([101, 202, 102]);
  });

  it('moves several items, which keep their order whatever order the indices are given in', async () => {
    const { server, writer } = setup();
    await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [1, 0], targetIndex: 0 });
    expect(sidsOf(blockOf(written(writer), 200).actions)).toEqual([103, 104]);
    expect(sidsOf(blockOf(written(writer), 100).actions)).toEqual([]);
  });

  it('moves an item to index 0 of a block that does not start with an else condition', async () => {
    const { server, writer } = setup();
    const data = parse(await call(server, { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'conditions', indices: [1], targetIndex: 0 }));
    expect(data.success).toBe(true);
    expect(sidsOf(blockOf(written(writer), 100).conditions)).toEqual([202, 101, 102]);
  });

  it('copies actions with new SIDs and leaves the source', async () => {
    const { server, writer } = setup();
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0, 1], targetIndex: 0, copy: true }));
    expect(data.success).toBe(true);
    expect(data.copy).toBe(true);
    const copies = blockOf(written(writer), 200).actions as Ev[];
    expect(copies).toHaveLength(2);
    expect(data.sids).toEqual(copies.map(c => c.sid));
    for (const [i, original] of [act(103), act(104)].entries()) {
      expect(copies[i].sid).not.toBe(original.sid);
      expect(copies[i].sid).toBeGreaterThanOrEqual(100_000_000_000_001);
      expect({ ...copies[i], sid: 0 }).toEqual({ ...original, sid: 0 });
    }
    expect(sidsOf(blockOf(written(writer), 100).actions)).toEqual([103, 104]);
  });

  it('copies within one block up to the end of its list', async () => {
    const { server, writer } = setup();
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 2, copy: true }));
    expect(data.success).toBe(true);
    const actions = blockOf(written(writer), 100).actions as Ev[];
    expect(actions).toHaveLength(3);
    expect(actions.map(a => a.sid).slice(0, 2)).toEqual([103, 104]);
  });

  it('copies an item that has no SID without giving it one', async () => {
    const script = { type: 'script', script: ['x();'] };
    const { server, writer } = setup(events => { (events[0].actions as Ev[]).push(script); });
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [2], targetIndex: 0, copy: true }));
    expect(data.success).toBe(true);
    expect(data.sids).toEqual([]);
    expect((blockOf(written(writer), 200).actions as Ev[])[0]).toEqual(script);
  });

  it('puts an item into a block that has no list of that kind', async () => {
    const { server, writer } = setup(events => { delete (events[1] as Ev).actions; });
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0], targetIndex: 0 }));
    expect(data.success).toBe(true);
    expect(sidsOf(blockOf(written(writer), 200).actions)).toEqual([103]);
  });

  it('takes items out of a function block and puts them into a custom action block', async () => {
    const custom = { aceType: 'action', aceName: 'Hit', objectClass: 'Sprite1', functionParameters: [], eventType: 'custom-ace-block', conditions: [], actions: [], sid: 800 };
    const { server, writer } = setup(events => { events.push(custom); });
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 800, itemType: 'actions', indices: [0], targetIndex: 0 }));
    expect(data.success).toBe(true);
    expect(sidsOf(blockOf(written(writer), 800).actions)).toEqual([103]);
  });

  it('reports a reorder that leaves the order as it was as unchanged and writes nothing', async () => {
    const { server, writer } = setup();
    const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 }));
    expect(data).toMatchObject({ success: true, action: 'unchanged', sids: [103] });
    expect(data.editorNote).toBeUndefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  describe('else conditions', () => {
    it('refuses moving or copying an else condition', async () => {
      for (const copy of [false, true]) {
        const { server, reader, writer } = setup();
        const before = await sheetJson(reader);
        const text = errorText(await call(server, { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 1, copy }));
        expect(text).toBe(copy
          ? 'An else condition cannot be copied: it stays first in its own block. Copy the other conditions instead. Nothing was changed.'
          : 'An else condition cannot be moved: it stays first in its own block. Move the other conditions instead. Nothing was changed.');
        expect(await sheetJson(reader)).toBe(before);
        expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      }
    });

    it('refuses putting a condition before the else condition of the target, enabled or disabled', async () => {
      for (const target of [200, 300]) {
        const { server, reader, writer } = setup();
        const before = await sheetJson(reader);
        const text = errorText(await call(server, { sourceBlockSid: 100, targetBlockSid: target, itemType: 'conditions', indices: [0], targetIndex: 0 }));
        expect(text, `target ${target}`).toBe('The else condition of the target block stays first (also when it is disabled); use targetIndex 1 or later. Nothing was changed.');
        expect(await sheetJson(reader)).toBe(before);
        expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      }
    });

    it('refuses putting a condition before the else condition of its own block', async () => {
      const { server, reader } = setup();
      const before = await sheetJson(reader);
      const text = errorText(await call(server, { sourceBlockSid: 200, targetBlockSid: 200, itemType: 'conditions', indices: [1], targetIndex: 0 }));
      expect(text).toContain('The else condition of the target block stays first');
      expect(await sheetJson(reader)).toBe(before);
    });

    it('puts a condition after the else condition of the target', async () => {
      const { server, writer } = setup();
      const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 300, itemType: 'conditions', indices: [0], targetIndex: 1 }));
      expect(data.success).toBe(true);
      expect(sidsOf(blockOf(written(writer), 300).conditions)).toEqual([301, 101, 302]);
    });

    it('does not treat an action as an else condition', async () => {
      const { server, writer } = setup(events => { (events[0].actions as Ev[]).push({ id: 'else', objectClass: 'System', sid: 105 }); });
      const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [2], targetIndex: 0 }));
      expect(data.success).toBe(true);
      expect(sidsOf(blockOf(written(writer), 200).actions)).toEqual([105]);
    });

    it('moves actions to index 0 of a block that starts with an else condition', async () => {
      const { server } = setup();
      const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(data.success).toBe(true);
    });
  });

  describe('refuses indexes that do not fit', () => {
    const cases: Array<[string, Ev, string, ((events: Ev[]) => void)?]> = [
      ['an index given twice',
        { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0, 0], targetIndex: 0 },
        'indices lists an index more than once. Nothing was changed.'],
      ['an index past the end of the source',
        { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [2], targetIndex: 0 },
        'Index 2 is out of range: the source has 2 action(s). Nothing was changed.'],
      ['an index past the end of a source that has no list of that kind',
        { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 },
        'Index 0 is out of range: the source has 0 action(s). Nothing was changed.',
        events => { delete (events[1] as Ev).actions; }],
      ['a targetIndex past the end of another block',
        { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0], targetIndex: 1 },
        'targetIndex 1 is out of range: the target has 0 action(s) there, so 0-0. Nothing was changed.'],
      ['a targetIndex counted before the items are taken out of one block',
        { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 2 },
        'targetIndex 2 is out of range: the target has 1 action(s) there, so 0-1. Nothing was changed.'],
      ['a targetIndex past the end of one block for a copy',
        { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 3, copy: true },
        'targetIndex 3 is out of range: the target has 2 action(s) there, so 0-2. Nothing was changed.'],
      ['a move into a block that would hold more than 100 actions',
        { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 },
        'The target would hold 101 actions (max 100). Nothing was changed.',
        events => { fillActions(events); (events[1].actions as Ev[]).push(act(2000)); }],
      ['a copy within a block that would hold more than 100 conditions',
        { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 0, copy: true },
        'The target would hold 101 conditions (max 100). Nothing was changed.',
        fillConditions],
    ];
    for (const [title, args, message, prepare] of cases) {
      it(title, async () => {
        const { server, reader, writer } = setup(prepare);
        const before = await sheetJson(reader);
        expect(errorText(await call(server, args))).toBe(message);
        expect(await sheetJson(reader)).toBe(before);
        expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      });
    }

    it('reorders a block that already holds 100 items', async () => {
      const { server, writer } = setup(fillActions);
      const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 99 }));
      expect(data.success).toBe(true);
      expect(sidsOf(blockOf(written(writer), 100).actions).at(-1)).toBe(1000);
    });
  });

  describe('finding the events', () => {
    const duplicate = (events: Ev[]) => { events.push(block(100, { actions: [act(900)] })); };

    it('refuses a source SID several events share, names sourceEventPath, and takes it', async () => {
      const { server, reader, writer } = setup(duplicate);
      const before = await sheetJson(reader);
      const text = errorText(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(text).toMatch(/^Source: /);
      expect(text).toContain('sourceEventPath');
      expect(text).toMatch(/Nothing was changed\.$/);
      expect(await sheetJson(reader)).toBe(before);

      const data = parse(await call(server, { sourceBlockSid: 100, sourceEventPath: 'events[6]', targetBlockSid: 200, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(data.success).toBe(true);
      expect(sidsOf(blockOf(written(writer), 200).actions)).toEqual([900]);
    });

    it('refuses a target SID several events share, names targetEventPath, and takes it', async () => {
      const { server, reader, writer } = setup(duplicate);
      const before = await sheetJson(reader);
      const text = errorText(await call(server, { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'conditions', indices: [1], targetIndex: 1 }));
      expect(text).toMatch(/^Target: /);
      expect(text).toContain('targetEventPath');
      expect(await sheetJson(reader)).toBe(before);

      const data = parse(await call(server, { sourceBlockSid: 200, targetBlockSid: 100, targetEventPath: 'events[6]', itemType: 'conditions', indices: [1], targetIndex: 0 }));
      expect(data.success).toBe(true);
      const events = written(writer);
      expect(sidsOf(events[6].conditions)).toEqual([202]);
      expect(sidsOf(events[0].conditions)).toEqual([101, 102]);
    });

    it('refuses a source or a target SID that no event has', async () => {
      const { server, reader } = setup();
      const before = await sheetJson(reader);
      const noSource = errorText(await call(server, { sourceBlockSid: 999, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(noSource).toMatch(/^Source: .*Nothing was changed\.$/s);
      const noTarget = errorText(await call(server, { sourceBlockSid: 100, targetBlockSid: 999, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(noTarget).toMatch(/^Target: .*Nothing was changed\.$/s);
      expect(await sheetJson(reader)).toBe(before);
    });

    it('refuses a target that holds no conditions and actions, and a source that holds none', async () => {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      const target = errorText(await call(server, { sourceBlockSid: 100, targetBlockSid: 600, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(target).toBe('Target event with SID 600 is a "group", not a block, function block or custom action block. Nothing was changed.');
      const source = errorText(await call(server, { sourceBlockSid: 600, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(source).toBe('Source event with SID 600 is a "group", not a block, function block or custom action block. Nothing was changed.');
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });

    it('refuses a registered event sheet that cannot be read', async () => {
      const { server, reader, writer } = setup(undefined, []);
      const read = reader.readEventSheet.bind(reader);
      reader.readEventSheet = async name => {
        if (name === 'Other') throw new Error('not valid JSON');
        return read(name);
      };
      const text = errorText(await server.callTool('move_event_block_items', { sheetName: 'Other', sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 }));
      expect(text).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });

    it('refuses an event sheet that is not registered, also under another letter case', async () => {
      const { server, writer } = setup();
      for (const sheetName of ['Nope', 'sheet1']) {
        const text = errorText(await server.callTool('move_event_block_items', { sheetName, sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 }));
        expect(text, sheetName).toMatch(/Nothing was changed\.$/);
        if (sheetName === 'sheet1') expect(text).toContain('Did you mean "Sheet1"?');
      }
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });
  });

  describe('object classes', () => {
    it('refuses an item whose object class is no object type', async () => {
      for (const itemType of ['actions', 'conditions']) {
        const { server, reader, writer } = setup(events => {
          (events[0].actions as Ev[]).push({ id: 'set-visible', objectClass: 'Nope', sid: 105 });
          (events[0].conditions as Ev[]).push({ id: 'is-visible', objectClass: 'Nope', sid: 106 });
        });
        const before = await sheetJson(reader);
        const text = errorText(await call(server, { sourceBlockSid: 100, targetBlockSid: 300, itemType, indices: [2], targetIndex: itemType === 'actions' ? 0 : 1 }));
        expect(text, itemType).toContain('Object class validation failed:');
        expect(text).toMatch(/Nothing was changed\.$/);
        expect(await sheetJson(reader)).toBe(before);
        expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      }
    });

    it('warns when "Set return value" is moved out of a function block, and not within one', async () => {
      const out = setup();
      const moved = parse(await call(out.server, { sourceBlockSid: 500, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(moved.success).toBe(true);
      expect(moved.warnings?.some(w => w.includes('is not inside a function block'))).toBe(true);

      const within = setup();
      const kept = parse(await call(within.server, { sourceBlockSid: 500, targetBlockSid: 500, itemType: 'actions', indices: [0], targetIndex: 0, copy: true }));
      expect(kept.success).toBe(true);
      expect(kept.warnings).toBeUndefined();
    });

    it('does not warn when "Set return value" is moved into a function block', async () => {
      const { server } = setup(events => { (events[0].actions as Ev[]).push({ id: 'set-function-return-value', objectClass: 'Functions', sid: 105, parameters: { value: '2' } }); });
      const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 500, itemType: 'actions', indices: [2], targetIndex: 0 }));
      expect(data.success).toBe(true);
      expect(data.warnings).toBeUndefined();
    });
  });

  describe('load-time rules', () => {
    it('refuses a trigger copied into a sub-event of a triggered block, and writes nothing', async () => {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      const text = errorText(await call(server, { sourceBlockSid: 400, targetBlockSid: 401, itemType: 'conditions', indices: [0], targetIndex: 0, copy: true }));
      expect(text).toContain('cannot add another trigger to event branch');
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });

    it('writes a trigger moved behind another condition with the gate\'s warning, and warns that the source lost all its conditions', async () => {
      const { server, writer } = setup();
      const data = parse(await call(server, { sourceBlockSid: 400, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 1 }));
      expect(data.success).toBe(true);
      expect(data.warnings?.some(w => w.includes('is condition 1, but a trigger must be the first condition'))).toBe(true);
      expect(data.warnings).toContain('All conditions of the source (SID 400) were moved: it now runs whenever its parent runs (every tick at the top level, every call in a function or custom action).');
      expect(blockOf(written(writer), 400).conditions).toEqual([]);
    });

    it('does not warn about an empty source when actions are moved out of it', async () => {
      const { server } = setup();
      const data = parse(await call(server, { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0, 1], targetIndex: 0 }));
      expect(data.success).toBe(true);
      expect(data.warnings).toBeUndefined();
    });
  });

  describe('scopes', () => {
    it('refuses a condition moved out of the function whose parameter it uses, and moves it with force', async () => {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      const blocked = parse(await call(server, { sourceBlockSid: 500, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 0 }));
      expect(blocked.action).toBe('move_blocked');
      expect(blocked.success).toBe(false);
      expect(String(blocked.message)).toContain('Event variable "p" is still used 1 time(s) where it is no longer in scope after the move');
      expect(String(blocked.message)).toMatch(/Move them to a place where the same declaration is in scope, or use force=true to move anyway\. Nothing was changed\.$/);
      expect(blocked.references).toEqual({ variableReferences: [expect.objectContaining({ variable: 'p', sheet: 'Sheet1', path: 'block > condition:0', sid: 100 })] });
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

      const forced = parse(await call(server, { sourceBlockSid: 500, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 0, force: true }));
      expect(forced.success).toBe(true);
      expect(forced.warnings?.some(w => w.startsWith('Moved with force=true: Event variable "p" is still used'))).toBe(true);
      expect(forced.references).toEqual({ variableReferences: [expect.objectContaining({ variable: 'p' })] });
      expect(sidsOf(blockOf(written(writer), 100).conditions)).toEqual([502, 101, 102]);
    });

    it('moves a condition within the function whose parameter it uses without a scope warning', async () => {
      const { server } = setup(events => { (events[4].conditions as Ev[]).push(cond(504, 'is-visible')); });
      const data = parse(await call(server, { sourceBlockSid: 500, targetBlockSid: 500, itemType: 'conditions', indices: [0], targetIndex: 1 }));
      expect(data.success).toBe(true);
      expect(data.warnings).toBeUndefined();
      expect(data.references).toBeUndefined();
    });

    it('refuses moving or copying an action into a block where its variable\'s name finds another variable, and moves it with force', async () => {
      for (const copy of [false, true]) {
        const { server, reader, writer } = setup(withTwoScopes);
        const before = await sheetJson(reader);
        const blocked = parse(await call(server, { sourceBlockSid: 700, targetBlockSid: 710, itemType: 'actions', indices: [0], targetIndex: 0, copy }));
        expect(blocked.action, `copy ${copy}`).toBe('move_blocked');
        expect(String(blocked.message)).toContain(REBOUND_USE_CONSEQUENCE);
        expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
        expect(blocked.reboundReferences).toEqual({ variableReferences: [expect.objectContaining({ variable: 'n' })] });
        expect(blocked.references).toEqual({});
        expect(await sheetJson(reader)).toBe(before);
        expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

        const forced = parse(await call(server, { sourceBlockSid: 700, targetBlockSid: 710, itemType: 'actions', indices: [0], targetIndex: 0, copy, force: true }));
        expect(forced.success).toBe(true);
        expect(forced.warnings?.some(w => w.startsWith('Moved with force=true:') && w.includes(REBOUND_USE_CONSEQUENCE))).toBe(true);
        expect(forced.reboundReferences).toEqual({ variableReferences: [expect.objectContaining({ variable: 'n' })] });
        expect((blockOf((blockOf(written(writer), 695).children as Ev[]), 710).actions as Ev[])).toHaveLength(1);
      }
    });

    it('moves an action to a block in the same scope without a warning', async () => {
      const { server } = setup(events => {
        withTwoScopes(events);
        (events[events.length - 2].children as Ev[]).push(block(705));
      });
      const data = parse(await call(server, { sourceBlockSid: 700, targetBlockSid: 705, itemType: 'actions', indices: [0], targetIndex: 0 }));
      expect(data.success).toBe(true);
      expect(data.warnings).toBeUndefined();
    });

    it('refuses a condition moved out of the custom action whose parameter it uses', async () => {
      const custom = {
        aceType: 'action', aceName: 'Hit', objectClass: 'Sprite1',
        functionParameters: [{ name: 'amt', type: 'number', initialValue: '0', comment: '', sid: 801 }],
        eventType: 'custom-ace-block', conditions: [useOf(802, 'amt')], actions: [], sid: 800,
      };
      const { server, reader, writer } = setup(events => { events.push(custom); });
      const before = await sheetJson(reader);
      const blocked = parse(await call(server, { sourceBlockSid: 800, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 0 }));
      expect(blocked.action).toBe('move_blocked');
      expect(String(blocked.message)).toContain('"amt"');
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    });

    it('refuses when the check of the uses stops at its event limit, and moves with force', async () => {
      const { server, reader } = setup(undefined, manyBlocks());
      const before = await sheetJson(reader);
      const args = { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 };
      const blocked = parse(await call(server, args));
      expect(blocked.action).toBe('move_blocked');
      expect(String(blocked.message)).toContain('stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown. Move them to a place where the same declaration is in scope, or use force=true to move anyway. Nothing was changed.');
      expect(await sheetJson(reader)).toBe(before);
      const forced = parse(await call(server, { ...args, force: true }));
      expect(forced.success).toBe(true);
      expect(forced.warnings).toContain('Moved with force=true: The check for uses of the event variables and function parameters of this sheet stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown.');
    });

    it('names the nesting-depth limit when the check of the uses stops there', async () => {
      const { server } = setup(events => { events.push(deepBlock()); });
      const args = { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 };
      const blocked = parse(await call(server, args));
      expect(blocked.action).toBe('move_blocked');
      expect(String(blocked.message)).toContain('stopped at its nesting-depth limit (events nested more than 50 deep), so uses further on are unknown.');
      const forced = parse(await call(server, { ...args, force: true }));
      expect(forced.warnings?.some(w => w.includes('nesting-depth limit'))).toBe(true);
    });
  });

  it('refuses an argument it does not take, an empty list of indices and more than 100 indices', async () => {
    const { server } = setup();
    const valid = { sheetName: 'Sheet1', sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 };
    await expect(server.callTool('move_event_block_items', { ...valid, bogus: 1 })).rejects.toThrow();
    await expect(server.callTool('move_event_block_items', { ...valid, indices: [] })).rejects.toThrow();
    await expect(server.callTool('move_event_block_items', { ...valid, indices: Array.from({ length: 101 }, (_, i) => i) })).rejects.toThrow();
    await expect(server.callTool('move_event_block_items', { ...valid, itemType: 'comments' })).rejects.toThrow();
    await expect(server.callTool('move_event_block_items', { ...valid, targetIndex: -1 })).rejects.toThrow();
  });

  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const trigger = { sourceBlockSid: 400, targetBlockSid: 401, itemType: 'conditions', indices: [0], targetIndex: 0, copy: true };
    const calls: Array<{ args: Ev; prepare?: (events: Ev[]) => void; other?: Ev[] }> = [
      { args: { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0, 0], targetIndex: 0 } },
      { args: { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [2], targetIndex: 0 } },
      { args: { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 }, prepare: events => { delete (events[1] as Ev).actions; } },
      { args: { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [0], targetIndex: 1 } },
      { args: { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 2 } },
      { args: { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 0, copy: true }, prepare: fillConditions },
      { args: { sourceBlockSid: 200, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 1 } },
      { args: { sourceBlockSid: 100, targetBlockSid: 300, itemType: 'conditions', indices: [0], targetIndex: 0 } },
      { args: { sourceBlockSid: 999, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 0 } },
      { args: { sourceBlockSid: 100, targetBlockSid: 600, itemType: 'actions', indices: [0], targetIndex: 0 } },
      { args: { sourceBlockSid: 100, targetBlockSid: 200, itemType: 'actions', indices: [2], targetIndex: 0 }, prepare: events => { (events[0].actions as Ev[]).push({ id: 'set-visible', objectClass: 'Nope', sid: 105 }); } },
      // Refused after the items were moved in memory: the load-time gate and the scope checks
      { args: trigger },
      { args: { sourceBlockSid: 500, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 0 } },
      { args: { sourceBlockSid: 700, targetBlockSid: 710, itemType: 'actions', indices: [0], targetIndex: 0 }, prepare: withTwoScopes },
      { args: { sourceBlockSid: 700, targetBlockSid: 710, itemType: 'actions', indices: [0], targetIndex: 0, copy: true }, prepare: withTwoScopes },
      { args: { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 }, other: manyBlocks() },
      { args: { sourceBlockSid: 100, targetBlockSid: 100, itemType: 'actions', indices: [0], targetIndex: 1 }, prepare: events => { events.push(deepBlock()); } },
    ];
    for (const { args, prepare, other } of calls) {
      const { server, reader, writer } = setup(prepare, other);
      const before = await sheetJson(reader);
      const result = await call(server, args);
      const text = result.isError ? result.content[0].text : String(parse(result).message);
      expect(text, JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
      expect(text.match(/Nothing was changed\./g), JSON.stringify(args)).toHaveLength(1);
      expect(await sheetJson(reader), JSON.stringify(args)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  describe('a failure after the change was made in memory', () => {
    it('puts the sheet in memory back and says nothing was changed when a step before the write throws', async () => {
      // The trigger condition makes the load-time gate list the object types, which fails once the items have moved
      const trigger = cond(151, 'on-collision-with-another-object', { parameters: { object: 'Sprite1' } });
      const { server, reader, writer } = setup(events => { events.push(block(150, { conditions: [trigger] })); });
      const stored = await reader.readEventSheet('Sheet1');
      const before = JSON.stringify(stored);
      const list = reader.listObjectTypes.bind(reader);
      reader.listObjectTypes = async () => {
        if (JSON.stringify(stored) !== before) throw new Error('object types unavailable');
        return list();
      };
      const text = errorText(await call(server, { sourceBlockSid: 150, targetBlockSid: 100, itemType: 'conditions', indices: [0], targetIndex: 1 }));
      expect(text).toBe('The change was stopped before anything was written: object types unavailable. Nothing was changed.');
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(stored)).toBe(before);
    });
  });
});

describe('move_event_block_items on disk', () => {
  const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
  let tmpDir: string;
  let server: MockServer;
  let writer: Construct3ProjectWriter;
  const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');
  const reorder = { sheetName: 'MainSheet', sourceBlockSid: 410000000000010, targetBlockSid: 410000000000010, itemType: 'actions', indices: [0], targetIndex: 1 };
  const setPosition = (sid: number) => ({ id: 'set-position', objectClass: 'Sprite', sid, parameters: { x: '1', y: '2' } });

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
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-move-event-block-items-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    sheet.events.push({ eventType: 'block', conditions: [], actions: [setPosition(410000000000011), setPosition(410000000000012)], sid: 410000000000010 });
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

  it('reorders the actions on disk', async () => {
    const data = parse(await server.callTool('move_event_block_items', reorder));
    expect(data.success).toBe(true);
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    expect(sidsOf(sheet.events[1].actions)).toEqual([410000000000012, 410000000000011]);
  });

  it('puts the sheet back when its write fails its read-back', async () => {
    const before = await readFile(sheetPath(), 'utf8');
    failReadBack();
    const result = await server.callTool('move_event_block_items', reorder);
    expect(errorText(result)).toContain('The call was rolled back: eventSheets/MainSheet.json is as before the call.');
    expect(errorText(result)).not.toContain('stopped before anything was written');
    expect(await readFile(sheetPath(), 'utf8')).toBe(before);
  });

  it('leaves a sheet the editor saved after the failed write as it is and names its .bak', async () => {
    const saved = `${await readFile(sheetPath(), 'utf8')}\n\n`;
    failReadBack(() => editorSave(sheetPath(), saved));
    const result = await server.callTool('move_event_block_items', reorder);
    expect(errorText(result)).toContain('left as it is: eventSheets/MainSheet.json');
    expect(errorText(result)).toContain('eventSheets/MainSheet.json.bak');
    expect(errorText(result)).not.toContain('Nothing was changed');
    // The left-as-it-is reason is the editor's save, not a missing tool call scope
    expect(errorText(result)).not.toContain('is no longer the copy this call made');
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
  });
});
