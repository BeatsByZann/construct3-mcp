/**
 * update_event_block inserts actions and conditions at an index and replaces
 * conditions in place. Indexes of inserts count the list after the call's
 * removals; every refusal comes before the first change and ends with
 * "Nothing was changed.". All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };

const cond = (sid: number, id: string, extra: Ev = {}): Ev => ({ id, objectClass: 'Sprite1', sid, ...extra });
const act = (sid: number): Ev => ({ id: 'set-visible', objectClass: 'Sprite1', sid, parameters: { visibility: 'visible' } });
const elseCond = (sid: number, extra: Ev = {}): Ev => ({ id: 'else', objectClass: 'System', sid, ...extra });
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });

/**
 * Block 100 (two conditions, two actions), block 200 (starts with an enabled
 * else), block 300 (starts with a disabled else), block 400 (On start) with
 * sub-event 401, and function block 500 with a parameter.
 */
function sheetEvents(): Ev[] {
  return [
    block(100, { conditions: [cond(101, 'is-visible'), cond(102, 'is-on-screen')], actions: [act(103), act(104)] }),
    block(200, { conditions: [elseCond(201), cond(202, 'is-visible')] }),
    block(300, { conditions: [elseCond(301, { disabled: true }), cond(302, 'is-visible')] }),
    block(400, { conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 402 }], children: [block(401)] }),
    {
      functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'number', functionCopyPicked: false, functionIsAsync: false,
      functionParameters: [{ name: 'p', type: 'number', initialValue: '0', comment: '', sid: 502 }],
      eventType: 'function-block', conditions: [], actions: [], sid: 500,
    },
  ];
}

function setup(prepare?: (events: Ev[]) => void) {
  const events = sheetEvents();
  prepare?.(events);
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events }]]),
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as unknown as Parameters<typeof registerEventTools>[0]);
  return { server, reader, writer, idGen };
}

const parse = (result: Result) => JSON.parse(result.content[0].text) as { success: boolean; warnings?: string[] };
const errorText = (result: Result): string => {
  expect(result.isError).toBe(true);
  return result.content[0].text;
};
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const blockOf = (events: Ev[], sid: number): Ev => events.find(e => e.sid === sid)!;
const sidsOf = (items: unknown): unknown[] => (items as Ev[]).map(i => i.sid);
const sheetJson = async (reader: MockReader) => JSON.stringify(await reader.readEventSheet('Sheet1'));

const isMoving = { id: 'is-moving', objectClass: 'Sprite1' };
const setVisible = { id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'invisible' } };

describe('update_event_block insertActions, insertConditions and replaceConditions', () => {
  it('inserts an action and a condition at an index, with new SIDs', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100,
      insertActions: [{ index: 1, action: setVisible }],
      insertConditions: [{ index: 0, condition: isMoving }],
    }));
    expect(data.success).toBe(true);
    const target = blockOf(written(writer), 100);
    const actions = target.actions as Ev[];
    const conditions = target.conditions as Ev[];
    expect(actions.map(a => a.sid)).toEqual([103, actions[1].sid, 104]);
    expect(actions[1]).toMatchObject({ id: 'set-visible', parameters: { visibility: 'invisible' } });
    expect(conditions.map(c => c.sid)).toEqual([conditions[0].sid, 101, 102]);
    expect(conditions[0].id).toBe('is-moving');
    for (const sid of [actions[1].sid, conditions[0].sid] as number[]) expect(sid).toBeGreaterThanOrEqual(100_000_000_000_001);
  });

  it('counts insert indexes after the removals', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, removeActionIndices: [0], insertActions: [{ index: 1, action: setVisible }],
    }));
    expect(data.success).toBe(true);
    const actions = blockOf(written(writer), 100).actions as Ev[];
    expect(actions).toHaveLength(2);
    expect(actions[0].sid).toBe(104);
    expect(actions[1].parameters).toEqual({ visibility: 'invisible' });
  });

  it('applies several inserts at their own indexes', async () => {
    const { server, writer } = setup();
    const first = { id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'first' } };
    const second = { id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'second' } };
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, insertActions: [{ index: 0, action: first }, { index: 2, action: second }],
    }));
    expect(data.success).toBe(true);
    const actions = blockOf(written(writer), 100).actions as Ev[];
    expect(actions.map(a => (a.parameters as Ev | undefined)?.visibility)).toEqual(['first', 'visible', 'visible', 'second']);
    expect([actions[1].sid, actions[2].sid]).toEqual([103, 104]);
  });

  it('applies several condition inserts at their own indexes', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100,
      insertConditions: [{ index: 0, condition: { id: 'is-moving', objectClass: 'Sprite1' } }, { index: 2, condition: { id: 'is-on-floor', objectClass: 'Sprite1' } }],
    }));
    expect(data.success).toBe(true);
    const conditions = blockOf(written(writer), 100).conditions as Ev[];
    expect(conditions.map(c => c.id)).toEqual(['is-moving', 'is-visible', 'is-on-screen', 'is-on-floor']);
    expect([conditions[1].sid, conditions[2].sid]).toEqual([101, 102]);
  });

  it('replaces a condition in place with a new SID, keeping its neighbours', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, replaceConditions: [{ index: 1, condition: isMoving }],
    }));
    expect(data.success).toBe(true);
    const conditions = blockOf(written(writer), 100).conditions as Ev[];
    expect(conditions).toHaveLength(2);
    expect(conditions[0].sid).toBe(101);
    expect(conditions[1].id).toBe('is-moving');
    expect(conditions[1].sid).not.toBe(102);
    expect(conditions[1].sid).toBeGreaterThanOrEqual(100_000_000_000_001);
  });

  it('warns when the else condition in first place is replaced by another condition', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 200, replaceConditions: [{ index: 0, condition: isMoving }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('Block (SID 200): condition 0 was the System "else" condition; replacing it makes the block an ordinary block.');
    expect((blockOf(written(writer), 200).conditions as Ev[])[0].id).toBe('is-moving');
  });

  it('warns when a replacement puts a System else condition anywhere but first', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, replaceConditions: [{ index: 1, condition: { id: 'else', objectClass: 'System' } }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('Block (SID 100): a replacing System "else" condition is condition 1, but Construct 3 saves Else as the first condition. Use isElse: true instead.');
  });

  it('warns when an insert puts a System else condition anywhere but first', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, insertConditions: [{ index: 1, condition: { id: 'else', objectClass: 'System' } }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('Block (SID 100): an inserted System "else" condition is condition 1, but Construct 3 saves Else as the first condition. Use isElse: true instead.');
  });

  it('refuses an insert before the else condition, enabled or disabled', async () => {
    for (const sid of [200, 300]) {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      const text = errorText(await server.callTool('update_event_block', {
        sheetName: 'Sheet1', sid, insertConditions: [{ index: 0, condition: isMoving }],
      }));
      expect(text, `block ${sid}`).toBe('Condition 0 of this block is a System "else" condition, which stays first (also when it is disabled); insert at index 1 or later. Nothing was changed.');
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('refuses an insert at 0 in front of an else condition the same call puts first by a replacement', async () => {
    const { server, reader, writer } = setup();
    const before = await sheetJson(reader);
    const elseReplacement = { id: 'else', objectClass: 'System' };
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100,
      replaceConditions: [{ index: 0, condition: elseReplacement }],
      insertConditions: [{ index: 0, condition: isMoving }],
    }));
    expect(text).toBe('Condition 0 of this block is a System "else" condition, which stays first (also when it is disabled); insert at index 1 or later. Nothing was changed.');
    expect(await sheetJson(reader)).toBe(before);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    // The replacement alone is written: a block whose first condition becomes Else
    const alone = setup();
    const data = parse(await alone.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, replaceConditions: [{ index: 0, condition: elseReplacement }],
    }));
    expect(data.success).toBe(true);
    expect((blockOf(written(alone.writer), 100).conditions as Ev[])[0].id).toBe('else');
  });

  it('allows an insert at 0 when the same call removes the else condition', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 200, removeConditionIndices: [0], insertConditions: [{ index: 0, condition: isMoving }],
    }));
    expect(data.success).toBe(true);
    const conditions = blockOf(written(writer), 200).conditions as Ev[];
    expect(conditions.map(c => c.id)).toEqual(['is-moving', 'is-visible']);
    expect(conditions[1].sid).toBe(202);
  });

  it('refuses an insert index that fits only before the removals', async () => {
    const { server, reader, writer } = setup();
    const before = await sheetJson(reader);
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, removeActionIndices: [0], insertActions: [{ index: 2, action: setVisible }],
    }));
    expect(text).toBe('Action insert index 2 is out of range: after the removals the block has 1 action(s), so indexes 0-1. Nothing was changed.');
    expect(await sheetJson(reader)).toBe(before);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  describe('refuses indexes that do not fit', () => {
    const cases: Array<[string, Ev, string, ((events: Ev[]) => void)?]> = [
      ['an action insert past the end after the removals',
        { insertActions: [{ index: 3, action: setVisible }] },
        'Action insert index 3 is out of range: after the removals the block has 2 action(s), so indexes 0-2. Nothing was changed.'],
      ['a condition insert past the end after the removals',
        { removeConditionIndices: [0], insertConditions: [{ index: 2, condition: isMoving }] },
        'Condition insert index 2 is out of range: after the removals the block has 1 condition(s), so indexes 0-1. Nothing was changed.'],
      ['two action inserts at one index',
        { insertActions: [{ index: 1, action: setVisible }, { index: 1, action: setVisible }] },
        'Two action inserts at index 1; give each insert its own index. Nothing was changed.'],
      ['two condition inserts at one index',
        { insertConditions: [{ index: 1, condition: isMoving }, { index: 1, condition: isMoving }] },
        'Two condition inserts at index 1; give each insert its own index. Nothing was changed.'],
      ['a condition both replaced and removed',
        { replaceConditions: [{ index: 1, condition: isMoving }], removeConditionIndices: [1] },
        'Condition 1 is both replaced and removed. Nothing was changed.'],
      ['a condition both replaced and updated',
        { replaceConditions: [{ index: 1, condition: isMoving }], updateConditions: [{ index: 1, isInverted: true }] },
        'Condition 1 is both updated and replaced; replace it with the condition you want. Nothing was changed.'],
      ['a replace index out of range',
        { replaceConditions: [{ index: 2, condition: isMoving }] },
        'Condition index 2 is out of range (block has 2 condition(s), indices 0-1). Nothing was changed.'],
      ['a condition named twice by replaceConditions',
        { replaceConditions: [{ index: 1, condition: isMoving }, { index: 1, condition: isMoving }] },
        'replaceConditions names condition 1 twice. Nothing was changed.'],
      ['an insert that takes the block over 100 actions',
        { insertActions: [{ index: 0, action: setVisible }] },
        'Block (SID 100) would hold 101 actions (max 100). Nothing was changed.',
        events => { (events[0].actions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => act(1000 + i))); }],
      ['an insert that takes the block over 100 conditions',
        { insertConditions: [{ index: 0, condition: isMoving }] },
        'Block (SID 100) would hold 101 conditions (max 100). Nothing was changed.',
        events => { (events[0].conditions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => cond(1000 + i, 'is-visible'))); }],
      ['an added action that takes the block over 100 actions',
        { addActions: [setVisible] },
        'Block (SID 100) would hold 101 actions (max 100). Nothing was changed.',
        events => { (events[0].actions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => act(1000 + i))); }],
      ['an added condition that takes the block over 100 conditions',
        { addConditions: [isMoving] },
        'Block (SID 100) would hold 101 conditions (max 100). Nothing was changed.',
        events => { (events[0].conditions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => cond(1000 + i, 'is-visible'))); }],
    ];
    for (const [title, args, message, prepare] of cases) {
      it(title, async () => {
        const { server, reader, writer } = setup(prepare);
        const before = await sheetJson(reader);
        const text = errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, ...args }));
        expect(text).toBe(message);
        expect(await sheetJson(reader)).toBe(before);
        expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      });
    }
  });

  it('edits a block that already holds more than 100 actions when the call adds none', async () => {
    const { server, writer } = setup(events => {
      (events[0].actions as Ev[]).splice(0, 2, ...Array.from({ length: 101 }, (_, i) => act(1000 + i)));
    });
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, updateActions: [{ index: 0, disabled: true }],
    }));
    expect(data.success).toBe(true);
    const actions = blockOf(written(writer), 100).actions as Ev[];
    expect(actions).toHaveLength(101);
    expect(actions[0].disabled).toBe(true);
  });

  it('checks the object classes of inserted and replaced items', async () => {
    const nope = { id: 'is-visible', objectClass: 'Nope' };
    const calls: Array<Ev> = [
      { insertConditions: [{ index: 0, condition: nope }] },
      { replaceConditions: [{ index: 0, condition: nope }] },
      { insertActions: [{ index: 0, action: { id: 'set-visible', objectClass: 'Nope', parameters: { visibility: 'visible' } } }] },
    ];
    for (const args of calls) {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      const text = errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, ...args }));
      expect(text, JSON.stringify(args)).toContain('Object class validation failed:');
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('runs the load-time gate on inserted conditions', async () => {
    const trigger = { id: 'on-start-of-layout', objectClass: 'System' };
    const warned = setup();
    const data = parse(await warned.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, insertConditions: [{ index: 1, condition: trigger }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings?.some(w => w.includes('is condition 1, but a trigger must be the first condition'))).toBe(true);

    const refused = setup();
    const before = await sheetJson(refused.reader);
    const text = errorText(await refused.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 401, insertConditions: [{ index: 0, condition: trigger }],
    }));
    expect(text).toContain('cannot add another trigger to event branch');
    expect(await sheetJson(refused.reader)).toBe(before);
    expect(refused.writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses isOr on an inserted or replacing condition of a block that is not an OR block', async () => {
    for (const args of [
      { insertConditions: [{ index: 0, condition: { ...isMoving, isOr: true } }] },
      { replaceConditions: [{ index: 0, condition: { ...isMoving, isOr: true } }] },
    ]) {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      const text = errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, ...args }));
      expect(text, JSON.stringify(args)).toContain('isOr on a condition is not written');
      expect(await sheetJson(reader)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('writes Set return value into a function block, and warns outside one without refusing', async () => {
    const setReturn = { id: 'set-function-return-value', objectClass: 'Functions', parameters: { value: 'p * 2' } };
    const inFunction = setup();
    const ok = parse(await inFunction.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 500, insertActions: [{ index: 0, action: setReturn }],
    }));
    expect(ok.success).toBe(true);
    expect(ok.warnings).toBeUndefined();
    expect((blockOf(written(inFunction.writer), 500).actions as Ev[])[0]).toMatchObject(setReturn);

    const outside = setup();
    const warned = parse(await outside.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 100, insertActions: [{ index: 0, action: setReturn }],
    }));
    expect(warned.success).toBe(true);
    expect(warned.warnings?.some(w => w.includes('is not inside a function block'))).toBe(true);
  });

  it('refuses an argument it does not take, and entries with unknown keys or too many entries', async () => {
    const { server } = setup();
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, insertActions: [{ index: 0, action: setVisible }], bogus: 1 })).rejects.toThrow();
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, insertActions: [{ index: 0, action: setVisible, bogus: 1 }] })).rejects.toThrow();
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, insertConditions: [{ index: 0, condition: isMoving, bogus: 1 }] })).rejects.toThrow();
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, replaceConditions: [{ index: 0, condition: isMoving, bogus: 1 }] })).rejects.toThrow();
    const many = (key: string, item: Ev) => Array.from({ length: 101 }, (_, i) => ({ index: i, [key]: item }));
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, insertActions: many('action', setVisible) })).rejects.toThrow();
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, insertConditions: many('condition', isMoving) })).rejects.toThrow();
    await expect(server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 100, replaceConditions: many('condition', isMoving) })).rejects.toThrow();
  });

  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const fillActions = (events: Ev[]) => { (events[0].actions as Ev[]).splice(0, 2, ...Array.from({ length: 100 }, (_, i) => act(1000 + i))); };
    const calls: Array<{ args: Ev; prepare?: (events: Ev[]) => void }> = [
      { args: { sid: 100, insertActions: [{ index: 3, action: setVisible }] } },
      { args: { sid: 100, insertConditions: [{ index: 3, condition: isMoving }] } },
      { args: { sid: 100, removeActionIndices: [0], insertActions: [{ index: 2, action: setVisible }] } },
      { args: { sid: 100, insertActions: [{ index: 1, action: setVisible }, { index: 1, action: setVisible }] } },
      { args: { sid: 100, insertConditions: [{ index: 1, condition: isMoving }, { index: 1, condition: isMoving }] } },
      { args: { sid: 100, replaceConditions: [{ index: 2, condition: isMoving }] } },
      { args: { sid: 100, replaceConditions: [{ index: 1, condition: isMoving }, { index: 1, condition: isMoving }] } },
      { args: { sid: 100, replaceConditions: [{ index: 1, condition: isMoving }], removeConditionIndices: [1] } },
      { args: { sid: 100, replaceConditions: [{ index: 1, condition: isMoving }], updateConditions: [{ index: 1, isInverted: true }] } },
      { args: { sid: 200, insertConditions: [{ index: 0, condition: isMoving }] } },
      { args: { sid: 300, insertConditions: [{ index: 0, condition: isMoving }] } },
      { args: { sid: 100, replaceConditions: [{ index: 0, condition: { id: 'else', objectClass: 'System' } }], insertConditions: [{ index: 0, condition: isMoving }] } },
      { args: { sid: 100, insertActions: [{ index: 0, action: setVisible }] }, prepare: fillActions },
      { args: { sid: 100, addActions: [setVisible] }, prepare: fillActions },
      // Earlier changes in the same call: a block toggle, a condition update and an action update come before the refused operation
      { args: { sid: 100, disabled: true, updateConditions: [{ index: 1, isInverted: true }], replaceConditions: [{ index: 1, condition: isMoving }] } },
      { args: { sid: 100, disabled: true, isOrBlock: true, updateActions: [{ index: 0, disabled: true }], insertActions: [{ index: 3, action: setVisible }] } },
      { args: { sid: 200, disabled: true, updateConditions: [{ index: 1, isInverted: true }], insertConditions: [{ index: 0, condition: isMoving }] } },
      { args: { sid: 100, disabled: true, updateActions: [{ index: 0, disabled: true }], addActions: [setVisible] }, prepare: fillActions },
    ];
    for (const { args, prepare } of calls) {
      const { server, reader, writer } = setup(prepare);
      const before = await sheetJson(reader);
      const text = errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', ...args }));
      expect(text, JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
      expect(text.match(/Nothing was changed\./g), JSON.stringify(args)).toHaveLength(1);
      expect(await sheetJson(reader), JSON.stringify(args)).toBe(before);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  describe('a failure after the change was made in memory', () => {
    it('puts the sheet in memory back and says nothing was changed when a step after the toggles throws', async () => {
      const { server, reader, writer, idGen } = setup();
      const before = await sheetJson(reader);
      // The block is disabled in memory first; the insert then fails to get a SID
      idGen.generateSid = async () => { throw new Error('no free SID'); };
      const text = errorText(await server.callTool('update_event_block', {
        sheetName: 'Sheet1', sid: 100, disabled: true, insertActions: [{ index: 0, action: setVisible }],
      }));
      expect(text).toBe('The change was stopped before anything was written: no free SID. Nothing was changed.');
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(await sheetJson(reader)).toBe(before);
    });

    it('puts the sheet in memory back when the write fails, and keeps the write error', async () => {
      const { server, reader, writer } = setup();
      const before = await sheetJson(reader);
      (writer as unknown as { writeEntityFile: () => Promise<string> }).writeEntityFile = async () => { throw new Error('disk full'); };
      const text = errorText(await server.callTool('update_event_block', {
        sheetName: 'Sheet1', sid: 100, disabled: true, insertActions: [{ index: 0, action: setVisible }],
      }));
      expect(text).toContain('disk full');
      expect(text).not.toContain('stopped before anything was written');
      expect(await sheetJson(reader)).toBe(before);
    });
  });
});
