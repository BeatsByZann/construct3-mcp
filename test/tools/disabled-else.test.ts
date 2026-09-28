/**
 * A System "else" condition saved with "disabled": true is ignored when the event
 * runs, so its block is an ordinary block. The event tools treat it that way:
 * isElse: true enables the condition instead of adding a second one, isElse: false
 * removes it, and the block needs no event before it. All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

function setup(events: unknown[]) {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events }]]),
  });
  const writer = new MockWriter();
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as any);
  return { server, writer };
}

const parseResult = (result: any) => JSON.parse(result.content[0].text);
const writtenEvents = (writer: MockWriter) => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as any).events;

const everyTick = { id: 'every-tick', objectClass: 'System', sid: 101 };
const compare = { id: 'compare-two-values', objectClass: 'System', sid: 103, parameters: { 'first-value': '1', comparison: 0, 'second-value': '1' } };
const disabledElse = () => ({ id: 'else', objectClass: 'System', sid: 102, disabled: true });
const enabledElse = () => ({ id: 'else', objectClass: 'System', sid: 102 });
const sheetWith = (first: unknown) => [
  { eventType: 'block', sid: 20, conditions: [everyTick], actions: [], children: [
    { eventType: 'comment', text: 'c' },
    first,
  ] },
];
const block30 = (elseCondition: unknown) => ({ eventType: 'block', sid: 30, conditions: [elseCondition, compare], actions: [] });
const child = (writer: MockWriter) => writtenEvents(writer)[0].children[1];

describe('update_event_block isElse on a block with a disabled else condition', () => {
  it('isElse: true enables the disabled condition in place instead of adding a second else', async () => {
    const { server, writer } = setup(sheetWith(block30(disabledElse())));
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, isElse: true }));
    expect(data.success).toBe(true);
    const conditions = child(writer).conditions;
    expect(conditions.map((c: any) => c.id)).toEqual(['else', 'compare-two-values']);
    expect(conditions[0]).toEqual({ id: 'else', objectClass: 'System', sid: 102 });
    expect(Object.keys(conditions[0])).toEqual(['id', 'objectClass', 'sid']);
    expect(data.warnings.join('\n')).toContain('enabled the disabled System "else" condition');
  });

  it('isElse: false removes the disabled else condition', async () => {
    const { server, writer } = setup(sheetWith(block30(disabledElse())));
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, isElse: false }));
    expect(data.success).toBe(true);
    expect(child(writer).conditions.map((c: any) => c.id)).toEqual(['compare-two-values']);
  });

  it('isElse: false still removes an enabled else, and isElse: true leaves it alone', async () => {
    const off = setup(sheetWith(block30(enabledElse())));
    await off.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, isElse: false });
    expect(child(off.writer).conditions.map((c: any) => c.id)).toEqual(['compare-two-values']);
    const on = setup(sheetWith(block30(enabledElse())));
    const data = parseResult(await on.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, isElse: true }));
    expect(child(on.writer).conditions).toHaveLength(2);
    expect((data.warnings ?? []).join('\n')).not.toContain('enabled the disabled');
  });

  it('warns about removing an enabled else by index but not a disabled one, and refuses an insert before either', async () => {
    const disabled = setup(sheetWith(block30(disabledElse())));
    const removed = parseResult(await disabled.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, removeConditionIndices: [0] }));
    expect((removed.warnings ?? []).join('\n')).not.toContain('turns the block into an ordinary block');
    const enabled = setup(sheetWith(block30(enabledElse())));
    const warned = parseResult(await enabled.server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, removeConditionIndices: [0] }));
    expect(warned.warnings.join('\n')).toContain('turns the block into an ordinary block');

    const insert = setup(sheetWith(block30(disabledElse())));
    const refused = await insert.server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 30, insertConditions: [{ index: 0, condition: { id: 'is-visible', objectClass: 'Sprite1' } }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('must stay first');
  });
});

describe('a block-level isElse key written by older versions next to a disabled else condition', () => {
  it('update_event_block drops the key and neither adds an else nor enables the disabled one', async () => {
    const legacy = { ...block30(disabledElse()), isElse: true };
    const { server, writer } = setup(sheetWith(legacy));
    const data = parseResult(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 30, disabled: false }));
    expect(data.success).toBe(true);
    const written = child(writer);
    expect(written).not.toHaveProperty('isElse');
    expect(written.conditions.map((c: any) => [c.id, c.disabled])).toEqual([['else', true], ['compare-two-values', undefined]]);
    expect(data.warnings.join(' ')).toContain('stays an ordinary block');
  });
});

describe('add_event_block with a disabled else condition', () => {
  const secondCondition = { id: 'is-visible', objectClass: 'Sprite1' };

  it('writes an ordinary block that needs no event before it, keeping the else disabled', async () => {
    const { server, writer } = setup([]);
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', position: 'start',
      conditions: [{ id: 'else', objectClass: 'System', disabled: true }, secondCondition],
    }));
    expect(data.success).toBe(true);
    const conditions = writtenEvents(writer)[0].conditions;
    expect(conditions.map((c: any) => [c.id, c.disabled])).toEqual([['else', true], ['is-visible', undefined]]);
  });

  it('refuses the same block with the else enabled, as no event stands before it', async () => {
    const { server } = setup([]);
    const refused = await server.callTool('add_event_block', {
      sheetName: 'Sheet1', position: 'start',
      conditions: [{ id: 'else', objectClass: 'System' }, secondCondition],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('needs an event block before it');
  });

  it('isElse: true enables a disabled else given first instead of writing two', async () => {
    const { server, writer } = setup(sheetWith(block30(enabledElse())));
    const data = parseResult(await server.callTool('add_event_block', {
      sheetName: 'Sheet1',
      conditions: [{ id: 'else', objectClass: 'System', disabled: true }, secondCondition], isElse: true,
    }));
    expect(data.success).toBe(true);
    const conditions = writtenEvents(writer).at(-1).conditions;
    expect(conditions.map((c: any) => c.id)).toEqual(['else', 'is-visible']);
    expect(conditions[0].disabled).toBeUndefined();
    expect(data.warnings.join('\n')).toContain('enabled the disabled System "else" condition');
  });
});

describe('move_event_block with a disabled else condition', () => {
  const topLevel = () => [
    { eventType: 'block', sid: 20, conditions: [everyTick], actions: [] },
    block30(disabledElse()),
    { eventType: 'block', sid: 40, conditions: [], actions: [] },
  ];

  it('moves a block with a disabled else to the start, where an else block would have no block before it', async () => {
    const { server, writer } = setup(topLevel());
    const data = parseResult(await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 30, position: 'start' }));
    expect(data.success).toBe(true);
    expect(writtenEvents(writer).map((e: any) => e.sid)).toEqual([30, 20, 40]);
  });

  it('still refuses to move a block with an enabled else to the start', async () => {
    const events = topLevel();
    events[1] = block30(enabledElse());
    const { server } = setup(events);
    const refused = await server.callTool('move_event_block', { sheetName: 'Sheet1', sid: 30, position: 'start' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('needs an event block before it');
  });
});
