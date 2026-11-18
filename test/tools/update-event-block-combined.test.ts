/**
 * update_event_block with several kinds of change in one call: a refusal
 * leaves the block as it was on disk and writes nothing. All data is synthetic.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;

/** Custom action Alpha.Hurt(amount) (500), and block 600 with one condition and two actions. */
function sheetEvents(): Ev[] {
  return [
    {
      aceType: 'action',
      aceName: 'Hurt',
      objectClass: 'Alpha',
      functionDescription: '',
      functionCategory: '',
      functionReturnType: 'none',
      functionCopyPicked: false,
      functionIsAsync: false,
      functionParameters: [{ name: 'amount', type: 'number', sid: 501, initialValue: '0', comment: '' }],
      eventType: 'custom-ace-block',
      conditions: [],
      actions: [],
      sid: 500,
    },
    {
      eventType: 'block',
      conditions: [{ id: 'is-visible', objectClass: 'Alpha', sid: 601 }],
      actions: [
        { id: 'set-visible', objectClass: 'Alpha', sid: 602, parameters: { visibility: 'visible' } },
        { type: 'comment', text: 'a note' },
      ],
      sid: 600,
    },
    // 610 calls the custom action, 620 is an else block, 630 holds a function block, 700 is a variable
    {
      eventType: 'block',
      conditions: [],
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', sid: 611, parameters: ['1'] }],
      sid: 610,
    },
    {
      eventType: 'block',
      conditions: [{ id: 'else', objectClass: 'System', sid: 621 }, { id: 'is-visible', objectClass: 'Alpha', sid: 622 }],
      actions: [],
      sid: 620,
    },
    {
      eventType: 'block',
      conditions: [],
      actions: [],
      sid: 630,
      children: [{
        eventType: 'function-block',
        functionName: 'F',
        functionDescription: '',
        functionCategory: '',
        functionReturnType: 'none',
        functionCopyPicked: false,
        functionIsAsync: false,
        functionParameters: [],
        conditions: [],
        actions: [],
        sid: 631,
      }],
    },
    { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 700 },
  ];
}

/**
 * The event tools on a mock project: `onDisk` is the text of the sheet's events
 * before any call, `inMemory` the same for the sheet the reader holds now, and
 * `bareBlock` adds a block with no conditions or actions keys (SID 640).
 */
function setup() {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([
      ['Alpha', { name: 'Alpha', 'plugin-id': 'Sprite', sid: 1 }],
      ['Beta', { name: 'Beta', 'plugin-id': 'Sprite', sid: 2 }],
    ]),
    families: new Map<string, Ev>([['Fam', { name: 'Fam', members: ['Alpha'], sid: 3 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events: sheetEvents() }]]),
  });
  const writer = new MockWriter();
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  const onDisk = JSON.stringify(sheetEvents());
  const inMemory = async () => JSON.stringify((await reader.readEventSheet('Sheet1')).events);
  /** Adds the bare block to the sheet and returns the sheet as it is then. */
  const bareBlock = async () => {
    (await reader.readEventSheet('Sheet1')).events.push({ eventType: 'block', sid: 640 } as never);
    return inMemory();
  };
  return { server, writer, onDisk, inMemory, bareBlock };
}

/** The text of an error result, or '' for a result that is not an error. */
const errorText = (result: { content: Array<{ text: string }>; isError?: boolean }) => (result.isError ? result.content[0].text : '');

describe('update_event_block: a refusal after other changes', () => {
  it('refuses an inserted custom action call that the custom action checks refuse, with no toggle or update left applied', async () => {
    const { server, writer, onDisk, inMemory } = setup();
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1',
      sid: 600,
      disabled: true,
      updateActions: [{ index: 0, disabled: true }],
      insertActions: [{ index: 0, action: { customAction: 'Hurt', objectClass: 'Nope' } }],
    }));
    expect(text).toBe('Unknown objectClass "Nope". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await inMemory()).toBe(onDisk);
  });

  it('puts the block back and says nothing was changed when an update index is out of range after a toggle', async () => {
    const { server, writer, onDisk, inMemory } = setup();
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1',
      sid: 600,
      disabled: true,
      updateConditions: [{ index: 3, isInverted: true }],
    }));
    expect(text).toBe('Condition index 3 is out of range (block has 1 condition(s), indices 0-0). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await inMemory()).toBe(onDisk);
  });

  it('puts the block back and says nothing was changed when an action update is refused after an earlier one was applied', async () => {
    const { server, writer, onDisk, inMemory } = setup();
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1',
      sid: 600,
      isOrBlock: true,
      updateActions: [{ index: 0, disabled: true }, { index: 7, disabled: true }],
    }));
    expect(text).toBe('Action index 7 is out of range (block has 2 action(s), indices 0-1). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await inMemory()).toBe(onDisk);
  });
});

const NOTHING_CHANGED = 'Nothing was changed.';
/** The refusal for a custom action call on an owner that is not an object type or family. */
const unknownOwner = (name: string) => `Unknown objectClass "${name}". A custom action belongs to an object type or family (not System or the Functions object). ${NOTHING_CHANGED}`;
const tick = { id: 'every-tick', objectClass: 'System' };

/** Every refusal the handler can produce, each with the arguments that reach it. */
const refusals: Array<{ title: string; args: Ev; text: string }> = [
  {
    title: 'no update given',
    args: { sheetName: 'Sheet1', sid: 600 },
    text: `No updates provided. Specify at least one of: disabled, isElse, isOrBlock, updateActions, updateConditions, addActions, addConditions, insertActions, insertConditions, replaceConditions, removeActionIndices, removeConditionIndices. ${NOTHING_CHANGED}`,
  },
  {
    title: 'a SID that is not in the sheet',
    args: { sheetName: 'Sheet1', sid: 999, disabled: true },
    text: [
      'Event with SID 999 not found in sheet "Sheet1".',
      '',
      'Sheet "Sheet1" contains 6 top-level events:',
      '  - custom-ace-block',
      '  - block (SID 600): 1 condition(s), 2 action(s)',
      '  - block (SID 610): 0 condition(s), 1 action(s)',
      '  - block (SID 620): 2 condition(s), 0 action(s)',
      '  - block (SID 630): 0 condition(s), 0 action(s)',
      '  - variable "score" (SID 700)',
      '',
      'Use get_eventsheet_details to see the full event tree with SIDs. Nothing was changed.',
    ].join('\n'),
  },
  {
    title: 'an event sheet that does not exist',
    args: { sheetName: 'Missing', sid: 600, disabled: true },
    text: 'Event sheet "Missing" not found.\nUse list_eventsheets to see all available names. Nothing was changed.',
  },
  {
    title: 'an added condition with two different behavior keys',
    args: { sheetName: 'Sheet1', sid: 600, addConditions: [{ id: 'is-visible', objectClass: 'Alpha', behaviorType: 'Solid', 'behavior-type': 'Bullet' }] },
    text: 'The change was stopped before anything was written: Conflicting behavior keys for "is-visible" on "Alpha": behaviorType "Solid" vs deprecated "behavior-type" "Bullet". Pass only behaviorType. Nothing was changed.',
  },
  {
    title: 'a function call with named arguments for a function that does not exist, after a toggle',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, addActions: [{ id: 'call-function', objectClass: 'System', callFunction: 'NoSuch', parameters: { nope: 'x' } }] },
    text: `The change was stopped before anything was written: Block (SID 600), call to "NoSuch": parameters are keyed by name, but no function block with that name exists to map them to positions. Pass the arguments as an array in parameter order. ${NOTHING_CHANGED}`,
  },
  {
    title: 'an event that is not a block',
    args: { sheetName: 'Sheet1', sid: 700, disabled: true },
    text: 'Event with SID 700 is a "variable", not a block, function-block or custom action block. Only those can be updated with this tool. Nothing was changed.',
  },
  {
    title: 'isElse on a custom action block',
    args: { sheetName: 'Sheet1', sid: 500, isElse: true },
    text: 'isElse applies to block events only; a function block or custom action block cannot be an else block. Nothing was changed.',
  },
  {
    title: 'object arguments for a custom action call',
    args: { sheetName: 'Sheet1', sid: 610, updateActions: [{ index: 0, parameters: { amount: '1' } }] },
    text: `Action 0 is a custom action call: pass its arguments as an array in parameter order. ${NOTHING_CHANGED}`,
  },
  {
    title: 'an added custom action call on an unknown owner',
    args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'Nope' }] },
    text: unknownOwner('Nope'),
  },
  {
    title: 'an inserted custom action call on an unknown owner',
    args: { sheetName: 'Sheet1', sid: 600, insertActions: [{ index: 0, action: { customAction: 'Hurt', objectClass: 'Nope' } }] },
    text: unknownOwner('Nope'),
  },
  {
    title: 'a custom action call naming a family its owner is not in',
    args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'Beta', customActionObjectClass: 'Fam' }] },
    text: `A custom action call names customActionObjectClass "Fam", but "Beta" is not a member of that family. ${NOTHING_CHANGED}`,
  },
  {
    title: 'an added condition on an unknown object class',
    args: { sheetName: 'Sheet1', sid: 600, addConditions: [{ id: 'is-visible', objectClass: 'Nope' }] },
    text: 'Object class validation failed:\nUnknown objectClass "Nope". Nothing was changed.',
  },
  {
    title: 'a per-condition isOr flag on a block that is not an OR block',
    args: { sheetName: 'Sheet1', sid: 600, addConditions: [{ ...tick, isOr: true }] },
    text: 'isOr on a condition is not written: Construct 3 ORs a whole event. Set isOrBlock: true to make this block an OR block. Nothing was changed.',
  },
  {
    title: 'a condition removal index past the end, after a toggle',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, removeConditionIndices: [4] },
    text: `Condition index 4 is out of range (block has 1 condition(s), indices 0-0). ${NOTHING_CHANGED}`,
  },
  {
    title: 'an action removal index past the end, after a toggle',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, removeActionIndices: [5] },
    text: `Action index 5 is out of range (block has 2 action(s), indices 0-1). ${NOTHING_CHANGED}`,
  },
  {
    title: 'a condition insert index past the end',
    args: { sheetName: 'Sheet1', sid: 600, insertConditions: [{ index: 3, condition: tick }] },
    text: `Condition insert index 3 is out of range: after the removals the block has 1 condition(s), so indexes 0-1. ${NOTHING_CHANGED}`,
  },
  {
    title: 'two condition inserts at one index',
    args: { sheetName: 'Sheet1', sid: 600, insertConditions: [{ index: 1, condition: tick }, { index: 1, condition: tick }] },
    text: `Two condition inserts at index 1; give each insert its own index. ${NOTHING_CHANGED}`,
  },
  {
    title: 'an action insert index past the end',
    args: { sheetName: 'Sheet1', sid: 600, insertActions: [{ index: 9, action: { id: 'set-visible', objectClass: 'Alpha', parameters: { visibility: 'visible' } } }] },
    text: `Action insert index 9 is out of range: after the removals the block has 2 action(s), so indexes 0-2. ${NOTHING_CHANGED}`,
  },
  {
    title: 'two action inserts at one index',
    args: {
      sheetName: 'Sheet1',
      sid: 600,
      insertActions: [
        { index: 0, action: { id: 'set-visible', objectClass: 'Alpha', parameters: { visibility: 'visible' } } },
        { index: 0, action: { id: 'set-visible', objectClass: 'Alpha', parameters: { visibility: 'invisible' } } },
      ],
    },
    text: `Two action inserts at index 0; give each insert its own index. ${NOTHING_CHANGED}`,
  },
  {
    title: 'a replacement index past the end',
    args: { sheetName: 'Sheet1', sid: 600, replaceConditions: [{ index: 2, condition: tick }] },
    text: `Condition index 2 is out of range (block has 1 condition(s), indices 0-0). ${NOTHING_CHANGED}`,
  },
  {
    title: 'a condition replaced twice',
    args: { sheetName: 'Sheet1', sid: 600, replaceConditions: [{ index: 0, condition: tick }, { index: 0, condition: tick }] },
    text: `replaceConditions names condition 0 twice. ${NOTHING_CHANGED}`,
  },
  {
    title: 'a condition replaced and removed',
    args: { sheetName: 'Sheet1', sid: 600, replaceConditions: [{ index: 0, condition: tick }], removeConditionIndices: [0] },
    text: `Condition 0 is both replaced and removed. ${NOTHING_CHANGED}`,
  },
  {
    title: 'a condition updated and replaced',
    args: { sheetName: 'Sheet1', sid: 600, replaceConditions: [{ index: 0, condition: tick }], updateConditions: [{ index: 0, isInverted: true }] },
    text: `Condition 0 is both updated and replaced; replace it with the condition you want. ${NOTHING_CHANGED}`,
  },
  {
    title: 'an insert in front of the else condition',
    args: { sheetName: 'Sheet1', sid: 620, insertConditions: [{ index: 0, condition: tick }] },
    text: `Condition 0 of this block is a System "else" condition, which stays first (also when it is disabled); insert at index 1 or later. ${NOTHING_CHANGED}`,
  },
  {
    title: 'more conditions than a block holds',
    args: { sheetName: 'Sheet1', sid: 600, addConditions: Array.from({ length: 100 }, () => tick) },
    text: `Block (SID 600) would hold 101 conditions (max 100). ${NOTHING_CHANGED}`,
  },
  {
    title: 'more actions than a block holds',
    args: { sheetName: 'Sheet1', sid: 600, addActions: Array.from({ length: 99 }, () => ({ type: 'comment', text: 'c' })) },
    text: `Block (SID 600) would hold 101 actions (max 100). ${NOTHING_CHANGED}`,
  },
  {
    title: 'a condition update index past the end, after a toggle',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, updateConditions: [{ index: 3, isInverted: true }] },
    text: `Condition index 3 is out of range (block has 1 condition(s), indices 0-0). ${NOTHING_CHANGED}`,
  },
  {
    title: 'an action update index past the end, after a toggle',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, updateActions: [{ index: 8, disabled: true }] },
    text: `Action index 8 is out of range (block has 2 action(s), indices 0-1). ${NOTHING_CHANGED}`,
  },
  {
    title: 'comment text on an action that is not a comment row',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, updateActions: [{ index: 0, text: 'x' }] },
    text: `Action 0 is not a comment row: text, "text-color" and "background-color" apply to comment rows only. ${NOTHING_CHANGED}`,
  },
  {
    title: 'parameters for a comment row',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, updateActions: [{ index: 1, parameters: { a: 'b' } }] },
    text: `Action 1 is a comment row, which has no parameters. To change its text or colours, use update_event_block with updateActions [{ index: 1, text, "text-color", "background-color" }]: the row keeps its place and the keys it has. ${NOTHING_CHANGED}`,
  },
  {
    title: 'disabling a comment row',
    args: { sheetName: 'Sheet1', sid: 600, isOrBlock: true, updateActions: [{ index: 1, disabled: true }] },
    text: `Action 1 is a comment row, which cannot be disabled (editor-saved comment rows are { type, text } with optional "text-color" and "background-color"; none carries "disabled"). ${NOTHING_CHANGED}`,
  },
  {
    title: 'array parameters for an action that is not a function call',
    args: { sheetName: 'Sheet1', sid: 600, disabled: true, updateActions: [{ index: 0, parameters: ['visible'] }] },
    text: `Action 0 is not a function call: pass its parameters as key-value pairs, not an array. ${NOTHING_CHANGED}`,
  },
  {
    title: 'a trigger added to a block that holds a function block',
    args: { sheetName: 'Sheet1', sid: 630, addConditions: [{ id: 'on-start-of-layout', objectClass: 'System' }] },
    text: 'Construct 3 load-time check failed; nothing was written. The editor enforces these rules when it opens the project, and breaking them can make the whole project fail to open:\n'
      + '- eventSheets/Sheet1 > block (sid 630) > function "F" (sid 631): The function block function "F" (sid 631) is inside the event branch of block (sid 630), which already acts as a trigger. A function block and a custom action block are trigger roots of their own, and an event branch may contain only one trigger; Construct 3 fails to open the project with "cannot add another trigger to event branch". Move the function block out of the triggered branch (e.g. to the top level or into a group), or remove the trigger from the event above it. Nothing was changed.',
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('update_event_block: every refusal says why, writes nothing and leaves the sheet as it was', () => {
  it.each(refusals)('refuses $title', async ({ args, text }) => {
    // A refusal thrown by a check is logged by the handler
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, writer, onDisk, inMemory } = setup();
    const result = await server.callTool('update_event_block', args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(text);
    expect(result.content[0].text.endsWith(NOTHING_CHANGED)).toBe(true);
    expect(result.content[0].text.split(NOTHING_CHANGED).length - 1).toBe(1);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await inMemory()).toBe(onDisk);
  });
});

describe('update_event_block: a refusal leaves a block without conditions or actions keys as it was', () => {
  const conflicting = { id: 'is-visible', objectClass: 'Alpha', behaviorType: 'Solid', 'behavior-type': 'Bullet' };

  it('puts the block back when a check throws after the lists were created', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, writer, inMemory, bareBlock } = setup();
    const stored = await bareBlock();
    const text = errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 640, addConditions: [conflicting] }));
    expect(text).toBe(`The change was stopped before anything was written: Conflicting behavior keys for "is-visible" on "Alpha": behaviorType "Solid" vs deprecated "behavior-type" "Bullet". Pass only behaviorType. ${NOTHING_CHANGED}`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await inMemory()).toBe(stored);
  });

  it('puts the block back when a check returns a refusal after the lists were created', async () => {
    const { server, writer, inMemory, bareBlock } = setup();
    const stored = await bareBlock();
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1',
      sid: 640,
      insertActions: [{ index: 3, action: { id: 'set-visible', objectClass: 'Alpha', parameters: { visibility: 'visible' } } }],
    }));
    expect(text).toBe(`Action insert index 3 is out of range: after the removals the block has 0 action(s), so indexes 0-0. ${NOTHING_CHANGED}`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(await inMemory()).toBe(stored);
  });
});
