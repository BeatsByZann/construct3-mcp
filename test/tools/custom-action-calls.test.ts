/**
 * Custom action calls in add_event_block, update_event_block and
 * update_event_block_action, and custom action blocks as the target of the
 * two update tools. All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
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

function setup(events: Ev[] = sheetEvents(), moreFamilies: Array<[string, Ev]> = []) {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([
      ['Alpha', { name: 'Alpha', 'plugin-id': 'Sprite', sid: 1 }],
      ['Beta', { name: 'Beta', 'plugin-id': 'Sprite', sid: 2 }],
    ]),
    families: new Map<string, Ev>([['Fam', { name: 'Fam', members: ['Alpha'], sid: 3 }], ...moreFamilies]),
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
    expect(text).toBe('Unknown objectClass "Nope". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('words the refusal of an unknown or case-variant owner alike in add_event_block and update_event_block', async () => {
    const wording = 'Unknown objectClass "Nope". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.';
    const { server } = setup();
    expect(errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'Nope' }],
    }))).toBe(wording);
    const hint = 'Unknown objectClass "alpha": object type and family names are matched with their letter case. Did you mean "Alpha"? Nothing was changed.';
    expect(errorText(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'alpha' }],
    }))).toBe(hint);
    expect(errorText(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick, actions: [{ customAction: 'Hurt', objectClass: 'alpha' }],
    }))).toBe(hint);
  });

  it('accepts a call on a family that names that family', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Fam', customActionObjectClass: 'Fam' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    expect(Object.keys(actionsOf(eventWith(written(writer), data.generatedSid as number))[0]))
      .toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid']);
  });

  it('resolves on the object type alone when the family files cannot be read', async () => {
    const ACE_CHECK_NOT_RUN = 'The ACE and expression checks could not run for this change; run validate_project to check the sheet.';
    const { server, reader } = setup();
    reader.readAllFamilies = async () => { throw new Error('unreadable'); };
    const own = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', parameters: ['1'] }],
    }));
    expect(own.success).toBe(true);
    // The catalogue check reads the families too, so it reports that it could not run
    expect(own.warnings).toEqual([ACE_CHECK_NOT_RUN]);
    const family = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha' }],
    }));
    expect(family.warnings).toEqual([missingDefinition('Block', 'Wave', 'Alpha'), ACE_CHECK_NOT_RUN]);
  });

  it('checks and writes a custom action call in a sub-event as it does in a block', async () => {
    const { server, writer } = setup();
    const refused = errorText(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      children: [{ actions: [{ customAction: 'Hurt', objectClass: 'System' }] }],
    }));
    expect(refused).toBe('Unknown objectClass "System". A custom action belongs to an object type or family (not System or the Functions object). Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      children: [{ conditions: tick, actions: [{ customAction: 'Wave', objectClass: 'Alpha' }, { customAction: 'Missing', objectClass: 'Alpha' }] }],
    }));
    const child = (eventWith(written(writer), data.generatedSid as number).children as Ev[])[0];
    expect(Object.keys(actionsOf(child)[0])).toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid']);
    expect(data.warnings).toEqual([missingDefinition('Sub-event at depth 2', 'Missing', 'Alpha')]);
  });

  it('warns when an object belongs to two families that both define the custom action, and uses the first', async () => {
    const events = [...sheetEvents(), customAction('Fam2', 'Wave', 560)];
    const { server, writer } = setup(events, [['Fam2', { name: 'Fam2', members: ['Alpha'], sid: 4 }]]);
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha' }],
    }));
    expect(data.warnings).toEqual([
      'Block, custom action call "Wave" on "Alpha": "Alpha" belongs to the families "Fam" and "Fam2", which both define a custom action of that name. The call uses the one on "Fam"; which one Construct 3 runs was not checked in the editor.',
    ]);
    expect(actionsOf(eventWith(written(writer), data.generatedSid as number))[0].customActionObjectClass).toBe('Fam');
    // Naming the family settles it
    const named = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha', customActionObjectClass: 'Fam2' }],
    }));
    expect(named.warnings).toBeUndefined();
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

  it('accepts customActionObjectClass equal to objectClass, on an object type and on a family', async () => {
    const { server, writer } = setup();
    const own = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', customActionObjectClass: 'Alpha', parameters: ['1'] }],
    }));
    expect(own.warnings).toBeUndefined();
    expect(Object.keys(actionsOf(eventWith(written(writer), own.generatedSid as number))[0])).toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid', 'parameters']);
    const onFamily = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Fam', customActionObjectClass: 'Fam' }],
    }));
    expect(onFamily.success).toBe(true);
    expect(onFamily.warnings).toBeUndefined();
  });

  it('names the exact spelling of another family when the first family defines the name in other letter case', async () => {
    const events = [customAction('Fam', 'wave', 560), customAction('Fam2', 'Wave', 561)];
    const { server, writer } = setup(events, [['Fam2', { name: 'Fam2', members: ['Alpha'], sid: 4 }]]);
    const data = parse(await server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Wave', objectClass: 'Alpha' }],
    }));
    expect(data.warnings).toEqual([
      'Block, custom action call "Wave" on "Alpha": the name differs only in letter case from the custom action "wave" on "Fam". Construct 3 r506-2 (Free edition) ran such a call and saved it with the definition\'s spelling, "wave". The call is written with that spelling.',
      'Block, custom action call "Wave" on "Alpha": "Alpha" belongs to the families "Fam" and "Fam2", which both define a custom action of that name. The call uses the one on "Fam"; which one Construct 3 runs was not checked in the editor. "Fam2" defines the name in the call\'s exact spelling; the first family is used whatever the spelling.',
    ]);
    expect(actionsOf(eventWith(written(writer), data.generatedSid as number))[0]).toMatchObject({ customAction: 'wave', customActionObjectClass: 'Fam' });
  });

  it('refuses a number argument in a custom action call', async () => {
    const { server, writer } = setup();
    await expect(server.callTool('add_event_block', {
      sheetName: 'Sheet1', conditions: tick,
      actions: [{ customAction: 'Hurt', objectClass: 'Alpha', parameters: [5] }],
    })).rejects.toThrow();
    await expect(server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'Alpha', parameters: [5] }],
    })).rejects.toThrow();
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
      'Block, custom action call "hurt" on "Alpha": the name differs only in letter case from the custom action "Hurt" on "Alpha". Construct 3 r506-2 (Free edition) ran such a call and saved it with the definition\'s spelling, "Hurt". The call is written with that spelling.',
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

  it('writes a number argument of a custom action call as a string', async () => {
    const { server, writer } = setup();
    await server.callTool('update_event_block_action', { sheetName: 'Sheet1', blockSid: 610, actionIndex: 0, parameters: [3, true] });
    expect(actionsOf(eventWith(written(writer), 610))[0].parameters).toEqual(['3', true]);
  });

  it('warns when a call is given another number of arguments than the definition has parameters', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: ['1', '2'],
    }));
    expect(data.warnings).toEqual(['Action 0, custom action call "Hurt" on "Alpha": 2 argument(s) for 1 parameter(s) (amount).']);
  });

  it('keeps the stored name of a call that differs from its definition only in letter case, and says so', async () => {
    const events = [...sheetEvents(), block(620, { actions: [{ customAction: 'hurt', objectClass: 'Alpha', sid: 621, parameters: ['1'] }] })];
    const { server, writer } = setup(events);
    const data = parse(await server.callTool('update_event_block_action', {
      sheetName: 'Sheet1', blockSid: 620, actionIndex: 0, parameters: ['2'],
    }));
    expect(actionsOf(eventWith(written(writer), 620))[0].customAction).toBe('hurt');
    expect(data.warnings).toEqual([
      'Action 0, custom action call "hurt" on "Alpha": the name differs only in letter case from the custom action "Hurt" on "Alpha". Construct 3 r506-2 (Free edition) ran such a call and saved it with the definition\'s spelling, "Hurt". The stored name was kept.',
    ]);
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

  it('writes a number argument given in updateActions as a string', async () => {
    const { server, writer } = setup();
    await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 610, updateActions: [{ index: 0, parameters: [4, false] }] });
    expect(actionsOf(eventWith(written(writer), 610))[0].parameters).toEqual(['4', false]);
  });

  it('writes a call added with addActions in the definition\'s spelling, with a warning', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'hurt', objectClass: 'Alpha', parameters: ['1'] }],
    }));
    expect(actionsOf(eventWith(written(writer), 600))[1].customAction).toBe('Hurt');
    expect(data.warnings).toEqual([
      'Block (SID 600), custom action call "hurt" on "Alpha": the name differs only in letter case from the custom action "Hurt" on "Alpha". Construct 3 r506-2 (Free edition) ran such a call and saved it with the definition\'s spelling, "Hurt". The call is written with that spelling.',
    ]);
  });

  it('keeps the stored name of a call that differs from its definition only in letter case when updateActions changes its arguments', async () => {
    const events = [...sheetEvents(), block(620, { actions: [{ customAction: 'hurt', objectClass: 'Alpha', sid: 621, parameters: ['1'] }] })];
    const { server, writer } = setup(events);
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 620, updateActions: [{ index: 0, parameters: ['2'] }],
    }));
    expect(actionsOf(eventWith(written(writer), 620))[0]).toMatchObject({ customAction: 'hurt', parameters: ['2'] });
    expect(data.warnings).toEqual([
      'Block (SID 620), action 0, custom action call "hurt" on "Alpha": the name differs only in letter case from the custom action "Hurt" on "Alpha". Construct 3 r506-2 (Free edition) ran such a call and saved it with the definition\'s spelling, "Hurt". The stored name was kept.',
    ]);
  });

  it('warns when updateActions gives a call another number of arguments than the definition has parameters', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block', {
      sheetName: 'Sheet1', sid: 600, updateActions: [{ index: 0, parameters: ['1', '2'] }],
    }));
    expect(data.warnings).toEqual(['Block (SID 600), action 0, custom action call "Hurt" on "Alpha": 2 argument(s) for 1 parameter(s) (amount).']);
  });

  it('adds the family key to a member\'s call of its family\'s custom action added with update_event_block', async () => {
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

  it('refuses isElse on a custom action block, and an event that is no block, function block or custom action block, in the wording of the refusals update_event_block already had', async () => {
    const { server, writer, events } = setup();
    const before = JSON.stringify(events);
    expect(errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 500, isElse: true })))
      .toBe('isElse applies to block events only; a function block or custom action block cannot be an else block.');
    expect(errorText(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 700, disabled: true })))
      .toBe('Event with SID 700 is a "variable", not a block, function-block or custom action block. Only those can be updated with this tool.');
    expect(JSON.stringify(events)).toBe(before);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('says a custom action body runs on every call when its last condition is removed', async () => {
    const { server } = setup();
    const data = parse(await server.callTool('update_event_block', { sheetName: 'Sheet1', sid: 540, removeConditionIndices: [0] }));
    expect(data.warnings).toContain('All conditions were removed: the custom action body now runs on every call.');
  });
});

describe('tool descriptions about custom action calls', () => {
  it('say a custom action call takes an array in parameter order, and that an object is refused', () => {
    const { server } = setup();
    const optional = server.getTool('update_event_block')!.schema.updateActions as z.ZodOptional<z.ZodArray<z.ZodObject<Record<string, z.ZodTypeAny>>>>;
    const updateActionsText = optional.unwrap().element.shape.parameters.description ?? '';
    const actionText = server.getTool('update_event_block_action')!.schema.parameters.description ?? '';
    expect(actionText).toContain('for a function call, the arguments in parameter order as an array (an object keyed "0", "1", … or by parameter name is converted); for a custom action call, an array in parameter order (an object is refused)');
    expect(updateActionsText).toContain('For a function call: an array replaces the arguments; an object keyed by position ("0", "1", …) or parameter name replaces single arguments. For a custom action call: an array in parameter order replaces them, and an object is refused');
  });

  it('name the release of move_events_between_sheets as Construct 3 r506-2 (Free edition)', () => {
    const { server } = setup();
    const text = server.getTool('move_events_between_sheets')!.description;
    expect(text).toContain('(Construct 3 r506-2 (Free edition) renamed the second of two such definitions on save)');
  });
});

describe('refusals of custom action edits', () => {
  it('every refusal this branch adds ends with Nothing was changed. and leaves the sheet as it was', async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', actions: [{ customAction: 'Hurt', objectClass: 'System' }] } },
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', actions: [{ customAction: 'Hurt', objectClass: 'Functions' }] } },
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', actions: [{ customAction: 'Wave', objectClass: 'Beta', customActionObjectClass: 'Fam' }] } },
      { tool: 'add_event_block', args: { sheetName: 'Sheet1', conditions: tick, actions: [{ customAction: 'Hurt', objectClass: 'Nope' }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'Nope' }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Hurt', objectClass: 'System' }] } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, addActions: [{ customAction: 'Wave', objectClass: 'Beta', customActionObjectClass: 'Fam' }] } },
      { tool: 'update_event_block_action', args: { sheetName: 'Sheet1', blockSid: 600, actionIndex: 0, parameters: { amount: '7' } } },
      { tool: 'update_event_block', args: { sheetName: 'Sheet1', sid: 600, updateActions: [{ index: 0, parameters: { amount: '9' } }] } },
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
