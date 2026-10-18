/**
 * Custom action calls in add_event_block, update_event_block and
 * update_event_block_action, and custom action blocks as the target of the
 * two update tools. All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const tick = [{ id: 'every-tick', objectClass: 'System' }];
const setVisible = { id: 'set-visible', objectClass: 'Alpha', parameters: { visibility: 'visible' } };

/** A custom action block as the editor saves it. */
function customAction(owner: string, name: string, sid: number, parameters: Array<{ name: string; type: string; sid: number }> = [], extra: Ev = {}): Ev {
  return {
    aceType: 'action',
    aceName: name,
    objectClass: owner,
    functionDescription: '',
    functionCategory: '',
    functionReturnType: 'none',
    functionCopyPicked: false,
    functionIsAsync: false,
    functionParameters: parameters.map(p => ({ ...p, initialValue: '0', comment: '' })),
    eventType: 'custom-ace-block',
    conditions: [],
    actions: [],
    sid,
    ...extra,
  };
}

/**
 * Custom action Alpha.Hurt(amount) (500), Fam.Wave() (510), Alpha.Mix(n, flag)
 * (520), Alpha.Chain (530) whose body calls Hurt, Alpha.Guarded (540) with one
 * condition; block 600 calls Hurt, block 610 calls Mix; variable 700.
 */
function sheetEvents(): Ev[] {
  return [
    customAction('Alpha', 'Hurt', 500, [{ name: 'amount', type: 'number', sid: 501 }]),
    customAction('Fam', 'Wave', 510),
    customAction('Alpha', 'Mix', 520, [{ name: 'n', type: 'number', sid: 521 }, { name: 'flag', type: 'boolean', sid: 522 }]),
    customAction('Alpha', 'Chain', 530, [], {
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', sid: 531, parameters: ['1'] }],
    }),
    customAction('Alpha', 'Guarded', 540, [], {
      conditions: [{ id: 'is-visible', objectClass: 'Alpha', sid: 541 }],
    }),
    block(600, { actions: [{ customAction: 'Hurt', objectClass: 'Alpha', sid: 601, parameters: ['1'] }] }),
    block(610, { actions: [{ customAction: 'Mix', objectClass: 'Alpha', sid: 611, parameters: ['1', true] }] }),
    { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: 700 },
  ];
}

function setup(events: Ev[] = sheetEvents()) {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([
      ['Alpha', { name: 'Alpha', 'plugin-id': 'Sprite', sid: 1 }],
      ['Beta', { name: 'Beta', 'plugin-id': 'Sprite', sid: 2 }],
    ]),
    families: new Map([['Fam', { name: 'Fam', members: ['Alpha'], sid: 3 }]]),
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 10, events }]]),
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  return { server, reader, writer, events };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text) as Record<string, unknown>;
const errorText = (result: { content: Array<{ text: string }>; isError?: boolean }) => (result.isError ? result.content[0].text : '');
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const eventWith = (events: Ev[], sid: number): Ev => {
  const found = events.find(e => e.sid === sid);
  if (!found) throw new Error(`no event ${sid}`);
  return found;
};
const actionsOf = (event: Ev): Ev[] => event.actions as Ev[];

const missingDefinition = (label: string, name: string, owner: string): string =>
  `${label}, custom action call "${name}" on "${owner}": no custom action of that name is defined on "${owner}" or its families in the event sheets that could be read. Whether Construct 3 opens a project with such a call was not checked.`;

describe('add_event_block with a custom action call', () => {
  it('writes a custom action call in the key order the editor saves', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', parameters: ['5'] }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const call = actionsOf(eventWith(written(writer), data.generatedSid as number))[0];
    expect(Object.keys(call)).toEqual(['customAction', 'objectClass', 'sid', 'parameters']);
    expect(call).toMatchObject({ customAction: 'Hurt', objectClass: 'Alpha', parameters: ['5'] });
  });

  it('writes customActionObjectClass after objectClass, and no parameters key when none are given', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha', customActionObjectClass: 'Fam' }],
    }));
    const call = actionsOf(eventWith(written(writer), data.generatedSid as number))[0];
    expect(Object.keys(call)).toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid']);
  });

  it('refuses a custom action call on System', async () => {
    const { server, writer } = setup();
    const text = errorText(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'System' }],
    }));
    expect(text).toBe('Unknown objectClass "System". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a custom action call on the Functions object', async () => {
    const { server, writer } = setup();
    const text = errorText(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Functions' }],
    }));
    expect(text).toBe('Unknown objectClass "Functions". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a custom action call on a name that is no object type or family', async () => {
    const { server, writer } = setup();
    const text = errorText(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Nope' }],
    }));
    expect(text).toContain('Object class validation failed:');
    expect(text).toContain('Unknown objectClass "Nope"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses customActionObjectClass that is not a family the object belongs to', async () => {
    const { server, writer } = setup();
    const text = errorText(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Beta', customActionObjectClass: 'Fam' }],
    }));
    expect(text).toBe('A custom action call names customActionObjectClass "Fam", but "Beta" is not a member of that family. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('keeps a boolean argument of a custom action call as the editor saves it', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Mix', objectClass: 'Alpha', parameters: ['1', true] }],
    }));
    expect(data.warnings).toBeUndefined();
    expect(actionsOf(eventWith(written(writer), data.generatedSid as number))[0].parameters).toEqual(['1', true]);
  });

  it('warns when no custom action of that name is defined on the object or its families', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Missing', objectClass: 'Alpha' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual([missingDefinition('Block', 'Missing', 'Alpha')]);
  });

  it('writes a call named in another letter case with the definition\'s spelling and warns', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'hurt', objectClass: 'Alpha', parameters: ['1'] }],
    }));
    const call = actionsOf(eventWith(written(writer), data.generatedSid as number))[0];
    expect(call.customAction).toBe('Hurt');
    expect(data.warnings).toEqual([
      'Block, custom action call "hurt" on "Alpha": the name differs only in letter case from the custom action "Hurt" on "Alpha". Construct 3 r506.2 ran such a call and saved it with the definition\'s spelling, "Hurt".',
    ]);
  });

  it('warns when a call passes another number of arguments than the definition has parameters', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', parameters: ['1', '2'] }],
    }));
    expect(data.warnings).toEqual(['Block, custom action call "Hurt" on "Alpha": 2 argument(s) for 1 parameter(s) (amount).']);
  });

  it('adds customActionObjectClass to a member\'s call of a family custom action, as the editor saves it', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha' }],
    }));
    expect(data.warnings).toBeUndefined();
    const call = actionsOf(eventWith(written(writer), data.generatedSid as number))[0];
    expect(Object.keys(call)).toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid']);
    expect(call.customActionObjectClass).toBe('Fam');
  });

  it('leaves a call without customActionObjectClass alone when the object has its own definition, or the call is on the family', async () => {
    const events = [...sheetEvents(), customAction('Alpha', 'Wave', 550)];
    const { server, writer } = setup(events);
    const own = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha' }],
    }));
    expect(Object.keys(actionsOf(eventWith(written(writer), own.generatedSid as number))[0])).toEqual(['customAction', 'objectClass', 'sid']);
    const onFamily = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Fam' }],
    }));
    expect(Object.keys(actionsOf(eventWith(written(writer), onFamily.generatedSid as number))[0])).toEqual(['customAction', 'objectClass', 'sid']);
  });

  it('refuses an unknown key in a custom action call', async () => {
    const { server, writer } = setup();
    await expect(server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', params: ['1'] }],
    })).rejects.toThrow();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('update_event_block_action and custom actions', () => {
  it('updates a call inside a custom action block', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 530, actionIndex: 0, parameters: ['3'],
    }));
    expect(data.success).toBe(true);
    expect(actionsOf(eventWith(written(writer), 530))[0].parameters).toEqual(['3']);
  });

  it('replaces a custom action call\'s arguments, removes them when none are given, and refuses key-value parameters', async () => {
    const { server, writer, events } = setup();
    const replaced = parse(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: ['7'],
    }));
    expect(replaced.customAction).toBe('Hurt');
    expect(actionsOf(eventWith(written(writer), 600))[0].parameters).toEqual(['7']);
    await server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: [] });
    expect(actionsOf(eventWith(written(writer), 600))[0]).not.toHaveProperty('parameters');
    const before = JSON.stringify(events);
    const writes = writer.callsFor('writeEntityFile').length;
    const text = errorText(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: { amount: '7' },
    }));
    expect(text).toBe('Action 0 is a custom action call: pass its arguments as an array in parameter order. Nothing was changed.');
    expect(JSON.stringify(events)).toBe(before);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(writes);
  });

  it('keeps a boolean argument of a custom action call as the editor saves it', async () => {
    const { server, writer } = setup();
    await server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 610, actionIndex: 0, parameters: ['2', false] });
    expect(actionsOf(eventWith(written(writer), 610))[0].parameters).toEqual(['2', false]);
  });

  it('warns when a call is given another number of arguments than the definition has parameters', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: ['1', '2'],
    }));
    expect(data.warnings).toEqual(['Action 0, custom action call "Hurt" on "Alpha": 2 argument(s) for 1 parameter(s) (amount).']);
  });

  it('refuses an event that is no block, function block or custom action block', async () => {
    const { server } = setup();
    const text = errorText(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 700, actionIndex: 0, parameters: ['1'],
    }));
    expect(text).toBe('Event with SID 700 is a "variable", not a block, function-block or custom action block. Only those have actions.');
  });
});

describe('update_event_block and custom actions', () => {
  it('updates a custom action call\'s arguments and keeps a boolean argument', async () => {
    const { server, writer } = setup();
    await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 600, updateActions: [{ index: 0, parameters: ['9'] }] });
    expect(actionsOf(eventWith(written(writer), 600))[0].parameters).toEqual(['9']);
    await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 610, updateActions: [{ index: 0, parameters: ['2', false] }] });
    expect(actionsOf(eventWith(written(writer), 610))[0].parameters).toEqual(['2', false]);
  });

  it('warns when updateActions gives a call another number of arguments than the definition has parameters', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, updateActions: [{ index: 0, parameters: ['1', '2'] }],
    }));
    expect(data.warnings).toEqual(['Block (SID 600), action 0, custom action call "Hurt" on "Alpha": 2 argument(s) for 1 parameter(s) (amount).']);
  });

  it('adds a custom action call to a block, with the same checks as add_event_block', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Wave', objectClass: 'Alpha' }],
    }));
    expect(data.success).toBe(true);
    const call = actionsOf(eventWith(written(writer), 600))[1];
    expect(Object.keys(call)).toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid']);
  });

  it('reports an action index past the end as for any block, with the arguments given as key-value pairs', async () => {
    const { server, writer } = setup();
    const text = errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, updateActions: [{ index: 9, parameters: { amount: '1' } }],
    }));
    expect(text).toBe('Action index 9 is out of range (block has 1 action(s), indices 0-0).');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('edits the body of a custom action block', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 500, addActions: [setVisible],
    }));
    expect(data.success).toBe(true);
    expect(actionsOf(eventWith(written(writer), 500))).toHaveLength(1);
    expect(actionsOf(eventWith(written(writer), 500))[0]).toMatchObject({ id: 'set-visible', objectClass: 'Alpha' });
  });

  it('refuses isElse on a custom action block, and an event that is no block, function block or custom action block', async () => {
    const { server } = setup();
    expect(errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 500, isElse: true })))
      .toBe('isElse applies to block events only; a function block or custom action block cannot be an else block. Nothing was changed.');
    expect(errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 700, disabled: true })))
      .toBe('Event with SID 700 is a "variable", not a block, function-block or custom action block. Only those can be updated with this tool. Nothing was changed.');
  });

  it('says a custom action body runs on every call when its last condition is removed', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 540, removeConditionIndices: [0] }));
    expect(data.warnings).toContain('All conditions were removed: the custom action body now runs on every call.');
  });
});

describe('refusals of custom action edits', () => {
  it('every refusal this branch adds ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', actions: [{ customAction: 'Hurt', objectClass: 'System' }] } },
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', actions: [{ customAction: 'Hurt', objectClass: 'Functions' }] } },
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', actions: [{ customAction: 'Wave', objectClass: 'Beta', customActionObjectClass: 'Fam' }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'System' }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Wave', objectClass: 'Beta', customActionObjectClass: 'Fam' }] } },
      { tool: 'update_event_block_action', args: { sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: { amount: '7' } } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, updateActions: [{ index: 0, parameters: { amount: '9' } }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 500, isElse: true } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 700, disabled: true } },
      // An earlier change (the block's own toggle) combined with the refused operation
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, disabled: true, updateActions: [{ index: 0, parameters: { amount: '9' } }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, disabled: true, addActions: [{ customAction: 'Hurt', objectClass: 'System' }] } },
    ];
    for (const { tool, args } of cases) {
      const { server, writer, events } = setup();
      const before = JSON.stringify(events);
      const result = await server.callTool(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(result.content[0].text.match(/Nothing was changed\./g), `${tool} ${JSON.stringify(args)}`).toHaveLength(1);
      expect(result.content[0].text.endsWith('Nothing was changed.'), `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.stringify(events), `${tool} ${JSON.stringify(args)}`).toBe(before);
      expect(eventWith(events, 600)).not.toHaveProperty('disabled');
      expect(writer.callsFor('writeEntityFile'), `${tool} ${JSON.stringify(args)}`).toHaveLength(0);
    }
  });
});
