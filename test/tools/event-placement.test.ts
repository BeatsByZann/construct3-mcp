/**
 * add_event_block and add_event_to_sheet place a new event at the top level,
 * in a group, among the sub-events of an event (parentSid) or beside one
 * (siblingSid), where the placement rules allow it, with the name rules of
 * its new scope. All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
const onStart = { id: 'on-start-of-layout', objectClass: 'System' };
const setVisible = { id: 'set-visible', objectClass: 'Sprite1', parameters: { visibility: 'visible' } };
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });

/** Block 100 (On start, sub-event block 101), group "G" (local variable "inner"), function "F", global variable "score". */
function sheetEvents(): Ev[] {
  return [
    block(100, { conditions: [{ ...onStart, sid: 900 }], children: [block(101)] }),
    { eventType: 'group', disabled: false, title: 'G', description: '', isActiveOnStart: true, sid: 200,
      children: [{ eventType: 'variable', name: 'inner', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 201 }] },
    { functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'none', functionCopyPicked: false,
      functionIsAsync: false, functionParameters: [], eventType: 'function-block', conditions: [], actions: [], sid: 300 },
    { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 400 },
  ];
}

/** A custom action block, which no block, comment or function is placed into. */
const customActionBlock: Ev = { eventType: 'custom-ace-block', objectClass: 'Sprite1', aceName: 'Do', conditions: [], actions: [], sid: 700 };

function setup(events: Ev[] = sheetEvents()) {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events }]]),
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  return { server, reader, writer };
}
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text) as Record<string, unknown>;
const errorText = (result: { content: Array<{ text: string }>; isError?: boolean }) => (result.isError ? result.content[0].text : '');
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;

describe('add_event_block destinations', () => {
  it('adds a block as a sub-event of parentSid and returns its eventPath', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', parentSid: 100, actions: [setVisible] }));
    expect(data.success).toBe(true);
    expect(data.eventPath).toBe('events[0].children[1]');
    const children = written(writer)[0].children as Ev[];
    expect(children.map(c => c.sid)).toEqual([101, data.generatedSid]);
  });

  it('adds a block before and after a sibling, in the sibling\'s own list', async () => {
    const { server, writer } = setup();
    await server.callTool('add_event_block', { sheetName: 'Sheet1', siblingSid: 101, position: 'before', actions: [setVisible] });
    const before = written(writer)[0].children as Ev[];
    expect(before[1].sid).toBe(101);
    const after = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', siblingSid: 400, position: 'after', actions: [setVisible] }));
    expect(after.eventPath).toBe('events[4]');
  });

  it('takes the function context of the destination for the Set return value warning', async () => {
    const setReturn = { id: 'set-function-return-value', objectClass: 'Functions', parameters: { value: '1' } };
    const { server } = setup();
    const inFunction = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', parentSid: 300, actions: [setReturn] }));
    expect(inFunction.success).toBe(true);
    expect(String(inFunction.warnings ?? '')).not.toContain('is not inside a function block');
    // Upstream warns, and does not refuse, outside a function block
    const outside = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', parentSid: 100, actions: [setReturn] }));
    expect(outside.success).toBe(true);
    expect(String(outside.warnings)).toContain('is not inside a function block');
  });

  it('refuses a sid, parentSid or siblingSid several events share, naming the eventPath argument that picks one', async () => {
    const shared = [block(100, { children: [block(7)] }), block(7)];
    const forBlock = setup(shared);
    const parentText = errorText(await forBlock.server.callTool('add_event_block', { sheetName: 'Sheet1', parentSid: 7 }));
    expect(parentText).toContain('Call again with parentEventPath set to the path of the event you mean');
    expect(parentText).toMatch(/Nothing was changed\.$/);
    const siblingText = errorText(await forBlock.server.callTool('add_event_block', { sheetName: 'Sheet1', siblingSid: 7, position: 'after' }));
    expect(siblingText).toContain('Call again with siblingEventPath set to the path of the event you mean');
    const forSheet = setup([block(100, { children: [block(7)] }), block(7)]);
    const toSheetText = errorText(await forSheet.server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'comment', commentText: 'x', parentSid: 7 }));
    expect(toSheetText).toContain('Call again with parentEventPath');
    const picked = parse(await forSheet.server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'comment', commentText: 'x', parentSid: 7, parentEventPath: 'events[1]' }));
    expect(picked.eventPath).toBe('events[1].children[0]');
  });

  it('treats an empty groupPath as not given, as before', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', groupPath: '', actions: [setVisible] }));
    expect(data.eventPath).toBe('events[4]');
  });

  it('refuses a trigger under a triggered event (the load-time gate) and writes nothing', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('add_event_block', { sheetName: 'Sheet1', parentSid: 100, conditions: [onStart] });
    expect(result.isError).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('warns, and does not refuse, an else block with no block before it in its list', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', groupPath: 'G', position: 'start', isElse: true, actions: [setVisible] }));
    expect(data.success).toBe(true);
    expect(String(data.warnings)).toContain('Else block:');
  });

  it('refuses a block among the sub-events of a custom action block', async () => {
    const { server, writer } = setup([...sheetEvents(), customActionBlock]);
    const text = errorText(await server.callTool('add_event_block', { sheetName: 'Sheet1', parentSid: 700, actions: [setVisible] }));
    expect(text).toMatch(/^A block is not placed among the sub-events of a custom action block: /);
    expect(text).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup();
    await expect(server.callTool('add_event_block', { sheetName: 'Sheet1', parentSID: 100 })).rejects.toThrow();
  });

  it('places no function block, so a function block child is refused before any placement', async () => {
    const { server, writer } = setup();
    await expect(server.callTool('add_event_block', {
      sheetName: 'Sheet1', parentSid: 100, children: [{ eventType: 'function-block', functionName: 'X' }],
    })).rejects.toThrow();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('add_event_to_sheet destinations', () => {
  it('adds a local variable with its flags and comment in the key order the editor saves', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_to_sheet', {
      sheetName: 'Sheet1', eventType: 'variable', parentSid: 100, variableName: 'count', variableType: 'number',
      variableIsStatic: true, variableIsConstant: false, variableComment: 'how many',
    }));
    expect(data.eventPath).toBe('events[0].children[1]');
    const variable = (written(writer)[0].children as Ev[])[1];
    expect(Object.keys(variable)).toEqual(['eventType', 'name', 'type', 'initialValue', 'comment', 'isStatic', 'isConstant', 'sid']);
    expect(variable).toMatchObject({ name: 'count', comment: 'how many', isStatic: true, isConstant: false });
  });

  it('writes isStatic on a global variable as the editor keeps it', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'variable', variableName: 'g2', variableIsStatic: true }));
    expect(data.eventPath).toBe('events[4]');
    expect(written(writer)[4]).toMatchObject({ name: 'g2', isStatic: true });
  });

  it('checks a local variable\'s name against its new scope', async () => {
    const { server, writer } = setup();
    const clash = await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'variable', groupPath: 'G', variableName: 'Inner' });
    // Upstream's own name refusal, with its text unchanged
    expect(errorText(clash)).toMatch(/inner/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const elsewhere = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'variable', parentSid: 100, variableName: 'inner' }));
    expect(elsewhere.success).toBe(true);
  });

  it('checks a new function\'s parameter names against the variables of the group it goes into', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'Sheet1', eventType: 'function', groupPath: 'G', functionName: 'H', functionParams: [{ name: 'inner', type: 'number' }],
    });
    expect(errorText(result)).toContain('"inner"');
    expect(errorText(result)).toContain('This tool also refuses a name the variables of the events enclosing the new function have');
  });

  it('keeps the editor\'s own scope rule for the parameter names of a function at the top level', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'Sheet1', eventType: 'function', functionName: 'H', functionParams: [{ name: 'score', type: 'number' }],
    });
    expect(errorText(result)).toContain('"score"');
    expect(errorText(result)).not.toContain('This tool also refuses');
  });

  it('adds a script event as the editor saves it', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'script', groupPath: 'G', script: 'let a = 1;\nlet b = 2;' }));
    expect(data.eventPath).toBe('events[1].children[1]');
    expect((written(writer)[1].children as Ev[])[1]).toEqual({ eventType: 'script', language: 'javascript', script: ['let a = 1;', 'let b = 2;'] });
  });

  it('refuses an include anywhere but the top level', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'include', groupPath: 'G', includeSheet: 'Sheet1' });
    expect(errorText(result)).toBe('An include is not placed in a group: remove_event_from_sheet and the include path of delete_event_from_sheet find includes at the top level only. It can go at the top level of a sheet. Nothing was changed.');
  });

  it('leaves a group saved without a children list as it was when a placement into it is refused', async () => {
    const bare: Ev = { eventType: 'group', disabled: false, title: 'E', description: '', isActiveOnStart: true, sid: 210 };
    const { server, reader, writer } = setup([...sheetEvents(), bare]);
    const result = await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'include', groupPath: 'E', includeSheet: 'Sheet1' });
    expect(errorText(result)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const stored = (await reader.readEventSheet('Sheet1')).events as unknown as Ev[];
    expect('children' in stored[4]).toBe(false);
  });

  it('warns when a block placed before an else block makes it continue the new block', async () => {
    const elseBlock = block(510, { conditions: [{ id: 'else', objectClass: 'System', sid: 511 }] });
    const { server } = setup([block(500), elseBlock]);
    const data = parse(await server.callTool('add_event_block', { sheetName: 'Sheet1', siblingSid: 510, position: 'before', actions: [setVisible] }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain(`The else block with SID 510 now follows the event with SID ${String(data.generatedSid)} instead of the event with SID 500, so it runs when that event's conditions are false.`);
  });

  it('warns when an event added with add_event_to_sheet before an else block makes it continue the new event', async () => {
    const elseBlock = block(510, { conditions: [{ id: 'else', objectClass: 'System', sid: 511 }] });
    const { server } = setup([block(500), elseBlock]);
    const data = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'group', title: 'H', siblingSid: 510, position: 'before' }));
    expect(data.success).toBe(true);
    expect(String(data.warnings)).toContain('The else block with SID 510 now follows the event with SID');
  });

  it('refuses a function block among the sub-events of a function block', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', parentSid: 300, functionName: 'Inner' });
    expect(errorText(result)).toMatch(/^A function block is not placed among the sub-events of a function block: /);
  });

  it('refuses an unknown argument that ends in Sid or EventPath instead of writing at the top level', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'comment', commentText: 'x', parentSID: 100 });
    expect(errorText(result)).toBe('add_event_to_sheet does not take "parentSID". The destination arguments are groupPath, parentSid, parentEventPath, siblingSid, siblingEventPath and position. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('keeps adding at the start and the end of the top level as before', async () => {
    const { server } = setup();
    const start = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'comment', commentText: 'top', position: 'start' }));
    expect(start.eventPath).toBe('events[0]');
    const end = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'group', title: 'H' }));
    expect(end.eventPath).toBe('events[5]');
  });
});

describe('a function block under an event with a trigger', () => {
  /** Block 600 (On start; sub-event 601), block 610 (no trigger; sub-event 611), a group holding block 630 (On start). */
  function triggerEvents(): Ev[] {
    return [
      block(600, { conditions: [{ ...onStart, sid: 901 }], children: [block(601)] }),
      block(610, { children: [block(611)] }),
      { eventType: 'group', disabled: false, title: 'T', description: '', isActiveOnStart: true, sid: 620,
        children: [block(630, { conditions: [{ ...onStart, sid: 902 }] })] },
    ];
  }
  const noTrigger = 'cannot add another trigger to event branch';

  it('is refused by add_event_to_sheet under a block with a trigger and under a block below one', async () => {
    for (const parentSid of [600, 601, 630]) {
      const { server, writer } = setup(triggerEvents());
      const text = errorText(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', functionName: 'Fn', parentSid }));
      expect(text, `parentSid ${parentSid}`).toContain(noTrigger);
      expect(text).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('is refused by add_event_to_sheet beside a sub-event of a block with a trigger', async () => {
    const { server, writer } = setup(triggerEvents());
    const text = errorText(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', functionName: 'Fn', siblingSid: 601, position: 'after' }));
    expect(text).toContain(noTrigger);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('is placed by add_event_to_sheet under blocks without a trigger, beside a triggered block and in a group', async () => {
    for (const where of [{ parentSid: 610 }, { parentSid: 611 }, { siblingSid: 600, position: 'after' }, { groupPath: 'T' }]) {
      const { server } = setup(triggerEvents());
      const data = parse(await server.callTool('add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', functionName: 'Fn', ...where }));
      expect(data.success, JSON.stringify(where)).toBe(true);
    }
  });
});

describe('refusals', () => {
  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['add_event_block', { sheetName: 'Sheet1', groupPath: 'G', parentSid: 100 }],
      ['add_event_block', { sheetName: 'Sheet1', parentSid: 999 }],
      ['add_event_block', { sheetName: 'Sheet1', parentSid: 400 }],
      ['add_event_block', { sheetName: 'Sheet1', position: 'after' }],
      ['add_event_block', { sheetName: 'Sheet1', siblingSid: 101, position: 'end' }],
      ['add_event_block', { sheetName: 'Sheet1', parentEventPath: 'events[0]' }],
      ['add_event_block', { sheetName: 'Sheet1', parentSid: 700 }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'comment', commentText: 'x', parentSid: 999 }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'script' }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'include', includeSheet: 'Sheet1', parentSid: 100 }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', functionName: 'X', parentSid: 300 }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', functionName: 'X', parentSid: 100 }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'function', functionName: 'X', siblingSid: 101, position: 'before' }],
      ['add_event_to_sheet', { sheetName: 'Sheet1', eventType: 'comment', commentText: 'x', siblingSID: 101 }],
    ];
    for (const [tool, args] of calls) {
      const { server, reader, writer } = setup([...sheetEvents(), customActionBlock]);
      const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
      const result = await server.callTool(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(errorText(result), `${tool} ${JSON.stringify(args)}`).toMatch(/Nothing was changed\.$/);
      expect(errorText(result)).not.toMatch(/Nothing was changed\..*Nothing was changed\./s);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    }
  });
});
