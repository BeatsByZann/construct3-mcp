import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

// The project index is a module singleton built from whichever reader first
// asked for it; MockWriter never invalidates it, so reset it per test.
beforeEach(() => resetProjectIndex());

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEventTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('create_event_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_event_sheet')).toBe(true);
  });

  it('creates a new event sheet', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_event_sheet', { name: 'MainSheet' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('MainSheet');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
  });

  it('creates with include sheets', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['SharedEvents', { name: 'SharedEvents', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_event_sheet', {
      name: 'Level1Sheet',
      includeSheets: ['SharedEvents'],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Check include events were added to the written data
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('include');
    expect(events[0].includeSheet).toBe('SharedEvents');
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_event_sheet', { name: 'MainSheet' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects missing include sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('create_event_sheet', {
      name: 'MySheet',
      includeSheets: ['NonExistent'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });
});

describe('add_event_to_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_event_to_sheet')).toBe(true);
  });

  it('adds a group event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'group',
      title: 'Movement',
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('group');
    expect(events[0].title).toBe('Movement');
  });

  it('adds a variable event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'variable',
      variableName: 'score',
      variableType: 'number',
      initialValue: '100',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('adds a function event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'function',
      functionName: 'DoStuff',
      functionParams: [{ name: 'amount', type: 'number' }],
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('adds a comment event', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'comment',
      commentText: 'TODO: optimize this',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('adds an include event', async () => {
    const { server } = setup({
      eventSheets: new Map([
        ['MainSheet', { name: 'MainSheet', events: [], sid: 1 }],
        ['SharedSheet', { name: 'SharedSheet', events: [], sid: 2 }],
      ]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'include',
      includeSheet: 'SharedSheet',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('errors on missing sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'NonExistent',
      eventType: 'group',
      title: 'Test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('requires title for group events', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'group',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('title is required');
  });

  it('inserts at start when position=start', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [{ eventType: 'comment', text: 'existing' }],
        sid: 1,
      }]]),
    });
    await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet',
      eventType: 'comment',
      commentText: 'new first',
      position: 'start',
    });
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events[0].text).toBe('new first');
  });
});

describe('add_event_block', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_event_block')).toBe(true);
  });

  it('adds a simple block event', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'set-instvar-value', objectClass: 'Player' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedSid).toBeDefined();
  });

  it('rejects block without conditions', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [],
      actions: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one condition');
  });

  it('allows else block without conditions', async () => {
    // An else needs an event block before it in the same container.
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 10,
        events: [{ eventType: 'block', sid: 11, conditions: [{ id: 'every-tick', objectClass: 'System', sid: 12 }], actions: [] }],
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [],
      actions: [{ id: 'log', objectClass: 'System' }],
      isElse: true,
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('errors on missing event sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('add_event_block', {
      sheetName: 'NonExistent',
      conditions: [{ id: 'x', objectClass: 'System' }],
    });
    expect(result.isError).toBe(true);
  });

  it('errors on unknown objectClass', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'x', objectClass: 'NonExistentObject' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown objectClass');
  });

  it('inserts into a group via groupPath', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [{ eventType: 'group', title: 'Movement', children: [], sid: 50 }],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [],
      groupPath: 'Movement',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('inserts a sub-event under a parent SID and mints child SIDs', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [{ eventType: 'block', sid: 50, conditions: [], actions: [], children: [] }],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      parentSid: 50,
      position: 'end',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const child = written.events[0].children[0];
    expect(child.eventType).toBe('block');
    expect(child.sid).toBe(100_000_000_000_001);
    expect(child.conditions[0].sid).toBe(100_000_000_000_002);
  });

  it('inserts beside a nested sibling SID and rejects conflicting locators', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [{ eventType: 'group', sid: 50, title: 'G', children: [
          { eventType: 'block', sid: 60, conditions: [], actions: [] },
        ] }],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      siblingSid: 60,
      position: 'before',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].children.map((event: any) => event.sid)).toEqual([
      100_000_000_000_001,
      60,
    ]);

    const conflict = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      parentSid: 50,
      siblingSid: 60,
      position: 'before',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0].text).toContain('at most one');
  });

  it('does not create a missing parent children array when validation fails', async () => {
    const parent = { eventType: 'block', sid: 50, conditions: [], actions: [] };
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [parent], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      parentSid: 50,
      conditions: [{ id: 'bad', objectClass: 'MissingObject' }],
    });
    expect(result.isError).toBe(true);
    expect(parent).not.toHaveProperty('children');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('does not create a missing group children array when validation fails', async () => {
    const group = { eventType: 'group', sid: 50, title: 'Movement' };
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [group], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      groupPath: 'Movement',
      conditions: [{ id: 'bad', objectClass: 'MissingObject' }],
    });
    expect(result.isError).toBe(true);
    expect(group).not.toHaveProperty('children');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('emits behaviorType on new behavior ACEs in added block events', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 10 }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-collision-with-another-object', objectClass: 'Player', behaviorType: 'Platform' }],
      actions: [{ id: 'destroy', objectClass: 'Player', behaviorType: 'Platform' }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const block = events[events.length - 1] as Record<string, unknown>;
    const blockConditions = block.conditions as Array<Record<string, unknown>>;
    const blockActions = block.actions as Array<Record<string, unknown>>;
    expect(blockConditions[0].behaviorType).toBe('Platform');
    expect(blockActions[0].behaviorType).toBe('Platform');
    expect(blockConditions[0]).not.toHaveProperty('behavior-type');
    expect(blockActions[0]).not.toHaveProperty('behavior-type');
  });

  it('errors on missing groupPath', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet',
        events: [],
        sid: 10,
      }]]),
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'x', objectClass: 'System' }],
      groupPath: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('delete_event_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_event_sheet')).toBe(true);
  });

  it('errors on nonexistent sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_event_sheet', { name: 'NonExistent' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('deregisters the sheet from c3proj before deleting its file', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Extra', { name: 'Extra', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('delete_event_sheet', { name: 'Extra' });
    expect(parseResult(result).success).toBe(true);

    const order = writer.calls.map(c => c.method);
    expect(order.indexOf('removeFromProject')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('removeFromProject')).toBeLessThan(order.indexOf('deleteEntityFile'));
  });

  it('names the orphaned file when the file delete fails after deregistration', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Extra', { name: 'Extra', events: [], sid: 1 }]]),
    });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('boom'));
    const result = await server.callTool('delete_event_sheet', { name: 'Extra' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('eventSheets/Extra.json');
    expect(result.content[0].text).toContain('boom');
    expect(writer.callsFor('removeFromProject')).toHaveLength(1);
  });
});

describe('delete_event_from_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_event_from_sheet')).toBe(true);
  });

  it('errors when neither sid nor includeSheet provided', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly one');
  });

  it('deletes a block by SID', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
          { eventType: 'block', sid: 200, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 100,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.deletedType).toBe('block');
    expect(data.deletedSid).toBe(100);

    // Verify the written sheet has only one event left
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].sid).toBe(200);
  });

  it('deletes a nested block inside a group', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'group', sid: 50, title: 'Movement', children: [
              { eventType: 'block', sid: 100, conditions: [], actions: [] },
              { eventType: 'block', sid: 200, conditions: [], actions: [] },
            ],
          },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 100,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const group = events[0];
    expect((group.children as unknown[]).length).toBe(1);
  });

  it('removes include by sheet name', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'SharedSheet',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.deletedType).toBe('include');
    expect(data.deletedTarget).toBe('SharedSheet');

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('block');
  });

  it('errors on nonexistent SID with summary', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [1], actions: [1, 2] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 999,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 999');
    expect(result.content[0].text).toContain('SID 100');
  });

  it('errors on nonexistent include with list', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SharedSheet');
  });

  it('dryRun returns preview without deleting', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 100,
      dryRun: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.action).toBe('would_delete');
    // No writes should have occurred
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('reports children count for group deletion', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'group', sid: 50, title: 'Movement', children: [
              { eventType: 'block', sid: 100, conditions: [], actions: [] },
              { eventType: 'block', sid: 200, conditions: [], actions: [] },
            ],
          },
        ],
      }]]),
    });
    const result = await server.callTool('delete_event_from_sheet', {
      sheetName: 'MainSheet',
      sid: 50,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.childrenRemoved).toBe(2);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('2 child');
  });
});

describe('update_event_block', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_block')).toBe(true);
  });

  it('updates block disabled state', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      disabled: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events[0].disabled).toBe(true);
  });

  it('updates action parameters by index (merge semantics)', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{
              id: 'go-to-layout', objectClass: 'System', sid: 20,
              parameters: { layout: '"Level 1"', transition: '"none"' },
            }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 0, parameters: { layout: '"Level 2"' } }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const action = (events[0].actions as Record<string, unknown>[])[0];
    const params = action.parameters as Record<string, unknown>;
    // New value applied
    expect(params.layout).toBe('"Level 2"');
    // Existing value preserved (merge semantics)
    expect(params.transition).toBe('"none"');
  });

  it('updates condition inversion by index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'compare', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateConditions: [{ index: 0, isInverted: true }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const cond = (events[0].conditions as Record<string, unknown>[])[0];
    expect(cond.isInverted).toBe(true);
  });

  it('adds new actions with generated SIDs', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addActions: [{ id: 'destroy', objectClass: 'Player', behaviorType: 'Platform' }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('destroy');
    expect(actions[0].behaviorType).toBe('Platform');
    expect(actions[0]).not.toHaveProperty('behavior-type');
    expect(actions[0].sid).toBeDefined();
  });

  it('removes actions by index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [
              { id: 'a', objectClass: 'System', sid: 20 },
              { id: 'b', objectClass: 'System', sid: 21 },
              { id: 'c', objectClass: 'System', sid: 22 },
            ],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeActionIndices: [0, 2],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('b');
  });

  it('errors on nonexistent SID', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 999,
      disabled: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 999');
  });

  it('errors on out-of-range action index', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 5, parameters: { x: 1 } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('errors when no updates provided', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors when targeting a non-block event', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'group', sid: 100, title: 'Test', children: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      disabled: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('group');
    expect(result.content[0].text).toContain('not a block');
  });

  it('adds new conditions with generated SIDs', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addConditions: [{ id: 'every-tick', objectClass: 'System', behaviorType: 'Platform' }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const conditions = events[0].conditions as Record<string, unknown>[];
    expect(conditions).toHaveLength(2);
    expect(conditions[1].id).toBe('every-tick');
    expect(conditions[1].behaviorType).toBe('Platform');
    expect(conditions[1]).not.toHaveProperty('behavior-type');
    expect(conditions[1].sid).toBeDefined();
  });

  it('preserves behaviorType on existing behavior ACEs during update', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'on-collision-with-another-object', objectClass: 'Player', behaviorType: 'Platform', sid: 10 }],
            actions: [{ id: 'destroy', objectClass: 'Player', behaviorType: 'Platform', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateConditions: [{ index: 0, isInverted: true }],
      updateActions: [{ index: 0, disabled: false }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const block = events[0];
    const conditions = block.conditions as Array<Record<string, unknown>>;
    const actions = block.actions as Array<Record<string, unknown>>;
    expect(conditions[0].behaviorType).toBe('Platform');
    expect(actions[0].behaviorType).toBe('Platform');
    expect(conditions[0]).not.toHaveProperty('behavior-type');
    expect(actions[0]).not.toHaveProperty('behavior-type');
    expect(conditions[0].isInverted).toBe(true);
    expect(actions[0].disabled).toBeUndefined();
  });

  it('removes conditions by index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [
              { id: 'a', objectClass: 'System', sid: 10 },
              { id: 'b', objectClass: 'System', sid: 11 },
            ],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const conditions = events[0].conditions as Record<string, unknown>[];
    expect(conditions).toHaveLength(1);
    expect(conditions[0].id).toBe('b');
  });

  it('update + remove in same call uses original indices', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [
              { id: 'a', objectClass: 'System', sid: 20, parameters: { val: 1 } },
              { id: 'b', objectClass: 'System', sid: 21, parameters: { val: 2 } },
              { id: 'c', objectClass: 'System', sid: 22, parameters: { val: 3 } },
            ],
          },
        ],
      }]]),
    });
    // Remove index 0 (action 'a') and update index 2 (action 'c') in the same call.
    // Both indices refer to the ORIGINAL array, so this must not error.
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeActionIndices: [0],
      updateActions: [{ index: 2, parameters: { val: 99 } }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    // After: action 'a' removed, action 'c' updated. Result: [b, c(updated)]
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe('b');
    expect(actions[1].id).toBe('c');
    expect((actions[1].parameters as Record<string, unknown>).val).toBe(99);
  });

  it('can disable individual actions', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      updateActions: [{ index: 0, disabled: true }],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const action = (events[0].actions as Record<string, unknown>[])[0];
    expect(action.disabled).toBe(true);
  });

  it('deduplicates removal indices (does not double-splice)', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [
              { id: 'a', objectClass: 'System', sid: 20 },
              { id: 'b', objectClass: 'System', sid: 21 },
              { id: 'c', objectClass: 'System', sid: 22 },
            ],
          },
        ],
      }]]),
    });
    // Pass duplicate index — should only remove ONE action, not two
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeActionIndices: [1, 1],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const actions = events[0].actions as Record<string, unknown>[];
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe('a');
    expect(actions[1].id).toBe('c');
  });

  it('deduplicates condition removal indices', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [
              { id: 'a', objectClass: 'System', sid: 10 },
              { id: 'b', objectClass: 'System', sid: 11 },
              { id: 'c', objectClass: 'System', sid: 12 },
            ],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0, 0],
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const conditions = events[0].conditions as Record<string, unknown>[];
    expect(conditions).toHaveLength(2);
    expect(conditions[0].id).toBe('b');
    expect(conditions[1].id).toBe('c');
  });

  it('warns when all conditions are removed', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'a', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'b', objectClass: 'System', sid: 20 }],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.some((w: string) => w.includes('unconditionally'))).toBe(true);
  });

  it('does not falsely warn when removing all conditions but adding new ones', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'a', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      removeConditionIndices: [0],
      addConditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Should NOT warn about unconditional — we added a replacement condition
    const hasUnconditionalWarning = data.warnings?.some((w: string) => w.includes('unconditionally')) ?? false;
    expect(hasUnconditionalWarning).toBe(false);
  });

  it('inserts actions and conditions at indexes with fresh SIDs', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'first', objectClass: 'System', sid: 10 }],
          actions: [{ id: 'first-action', objectClass: 'Player', sid: 20 }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      insertConditions: [{ index: 0, condition: { id: 'inserted', objectClass: 'System' } }],
      insertActions: [{ index: 0, action: { id: 'inserted-action', objectClass: 'Player' } }],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].conditions.map((item: any) => item.id)).toEqual(['inserted', 'first']);
    expect(written.events[0].actions.map((item: any) => item.id)).toEqual(['inserted-action', 'first-action']);
    expect(written.events[0].conditions[0].sid).toBe(100_000_000_000_001);
    expect(written.events[0].actions[0].sid).toBe(100_000_000_000_000 + 2);
  });

  it('replaces a condition in place with a fresh SID', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [
            { id: 'old', objectClass: 'System', sid: 10 },
            { id: 'keep', objectClass: 'System', sid: 11 },
          ],
          actions: [],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      replaceConditions: [{ index: 0, condition: { id: 'new-ace', objectClass: 'System' } }],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].conditions[0].id).toBe('new-ace');
    expect(written.events[0].conditions[0].sid).toBe(100_000_000_000_001);
    expect(written.events[0].conditions[1]).toEqual({ id: 'keep', objectClass: 'System', sid: 11 });
  });

  it('rejects duplicate insertion indexes before writing', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [{ id: 'x', objectClass: 'System', sid: 10 }], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      insertConditions: [
        { index: 0, condition: { id: 'a', objectClass: 'System' } },
        { index: 0, condition: { id: 'b', objectClass: 'System' } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unique');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  function elseSheet() {
    return {
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [{ id: 'else', objectClass: 'System', sid: 10 }], actions: [] }],
      }]]),
    };
  }

  it('keeps the else condition first: refuses an insertion at index 0 of an else block', async () => {
    const { server, writer } = setup(elseSheet());
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet', sid: 100, insertConditions: [{ index: 0, condition: { id: 'insert', objectClass: 'System' } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('else condition must stay first');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('upgrades a legacy isElse block before applying condition indexes', async () => {
    const legacy = () => setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100, isElse: true,
          conditions: [{ id: 'a', objectClass: 'System', sid: 10 }, { id: 'b', objectClass: 'System', sid: 11 }],
          actions: [],
        }],
      }]]),
    });
    // Index 0 is now the else condition: inserting before it is refused.
    const refused = legacy();
    const insert = await refused.server.callTool('update_event_block', {
      sheetName: 'MainSheet', sid: 100, insertConditions: [{ index: 0, condition: { id: 'x', objectClass: 'System' } }],
    });
    expect(insert.isError).toBe(true);
    expect(refused.writer.callsFor('writeEntityFile')).toHaveLength(0);

    // Index 1 is condition "a" after the upgrade, and index 2 is "b".
    const { server, writer } = legacy();
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet', sid: 100, removeConditionIndices: [1], updateConditions: [{ index: 2, disabled: true }],
    });
    expect(result.isError).not.toBe(true);
    const block = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0];
    expect(block.conditions.map((c: any) => c.id)).toEqual(['else', 'b']);
    expect(block.conditions[1].disabled).toBe(true);
  });

  it('refuses to move an else condition out of first place', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [{ id: 'else', objectClass: 'System', sid: 10 }, { id: 'a', objectClass: 'System', sid: 11 }], actions: [] },
          { eventType: 'block', sid: 200, conditions: [{ id: 'b', objectClass: 'System', sid: 20 }], actions: [] },
        ],
      }]]),
    });
    for (const move of [
      { sourceBlockSid: 100, targetBlockSid: 100, indices: [0], targetIndex: 1 },
      { sourceBlockSid: 100, targetBlockSid: 200, indices: [0], targetIndex: 1 },
    ]) {
      const result = await server.callTool('move_event_block_items', { sheetName: 'MainSheet', itemType: 'conditions', ...move });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('else condition cannot be moved');
    }
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('update_event_block_action refuses keyed parameters on calls and comment rows', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'custom-ace-block', aceType: 'action', aceName: 'Go', objectClass: 'Hero', sid: 100,
          conditions: [],
          actions: [
            { callFunction: 'f', sid: 101, parameters: ['1'] },
            { type: 'comment', text: 'note' },
            { id: 'destroy', objectClass: 'Hero', sid: 102 },
          ],
        }],
      }]]),
    });
    const call = await server.callTool('update_event_block_action', { sheetName: 'MainSheet', blockSid: 100, actionIndex: 0, parameters: { a: '1' } });
    expect(call.isError).toBe(true);
    expect(call.content[0].text).toContain('positional');
    const comment = await server.callTool('update_event_block_action', { sheetName: 'MainSheet', blockSid: 100, actionIndex: 1, parameters: { a: '1' } });
    expect(comment.isError).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    // A standard action inside a custom action body is still editable.
    const ok = await server.callTool('update_event_block_action', { sheetName: 'MainSheet', blockSid: 100, actionIndex: 2, parameters: { a: '1' } });
    expect(ok.isError).not.toBe(true);
  });

  it('adds conditions after the else condition (an else-if block)', async () => {
    const { server, writer } = setup(elseSheet());
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet', sid: 100, addConditions: [{ id: 'add', objectClass: 'System' }],
    });
    expect(result.isError).not.toBe(true);
    const block = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0];
    expect(block.conditions.map((c: any) => c.id)).toEqual(['else', 'add']);
  });

  it('rewrites a legacy isElse / isOr block into the else condition and isOrBlock', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100, isElse: true,
          conditions: [{ id: 'a', objectClass: 'System', sid: 10 }, { id: 'b', objectClass: 'System', sid: 11, isOr: true }],
          actions: [],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block', { sheetName: 'MainSheet', sid: 100, disabled: false });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).warnings.join(' ')).toContain('older builds');
    const block = (writer.callsFor('writeEntityFile')[0].args[2] as any).events[0];
    expect(block).not.toHaveProperty('isElse');
    expect(block.isOrBlock).toBe(true);
    expect(block.conditions.map((c: any) => c.id)).toEqual(['else', 'a', 'b']);
    expect(block.conditions.some((c: any) => 'isOr' in c)).toBe(false);
  });

  // ─── Script actions ──────────────────────────────────────

  function sheetWithEmptyBlock() {
    return {
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [],
          },
        ],
      }]]),
    };
  }

  it('appends a script action in the canonical C3 shape (language tag + line array, no SID)', async () => {
    const { server, writer } = setup(sheetWithEmptyBlock());
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addActions: [{ type: 'script', script: 'const a = 1;\r\nrun(a);' }],
    });
    expect(parseResult(result).success).toBe(true);

    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const action = written.events[0].actions[0];
    expect(action).toEqual({ type: 'script', language: 'javascript', script: ['const a = 1;', 'run(a);'] });
    expect('sid' in action).toBe(false);
  });

  it('passes a script given as an array of lines through unchanged and honours disabled', async () => {
    const { server, writer } = setup(sheetWithEmptyBlock());
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addActions: [{ type: 'script', script: ['if (x) {', '  y();', '', '}'], disabled: true }],
    });
    expect(parseResult(result).success).toBe(true);

    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].actions[0]).toEqual({
      type: 'script', language: 'javascript', script: ['if (x) {', '  y();', '', '}'], disabled: true,
    });
  });

  it('skips objectClass validation for script actions but still validates standard ones', async () => {
    const { server } = setup(sheetWithEmptyBlock());

    const scriptOnly = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addActions: [{ type: 'script', script: 'x();' }],
    });
    expect(parseResult(scriptOnly).success).toBe(true);

    const withGhost = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: 100,
      addActions: [{ type: 'script', script: 'x();' }, { id: 'set-position', objectClass: 'Ghost' }],
    });
    expect(withGhost.isError).toBe(true);
    expect(withGhost.content[0].text).toContain('Object class validation failed');
  });
});

describe('remove_event_from_sheet', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('remove_event_from_sheet')).toBe(true);
  });

  it('removes an include by sheet name', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'SharedSheet',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.removedCount).toBe(1);
    expect(data.removedInclude).toBe('SharedSheet');

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('block');
  });

  it('errors when include not present and lists current includes', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'OtherSheet' },
        ],
      }]]),
    });
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('OtherSheet');
  });

  it('errors on nonexistent sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'NoSuchSheet',
      includeSheet: 'Anything',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('removes multiple includes of the same sheet', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'include', includeSheet: 'SharedSheet' },
          { eventType: 'block', sid: 100, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('remove_event_from_sheet', {
      sheetName: 'MainSheet',
      includeSheet: 'SharedSheet',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.removedCount).toBe(2);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
  });
});

describe('update_event_block_action', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_block_action')).toBe(true);
  });

  it('replaces action parameters by block SID and action index', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'on-start', objectClass: 'System', sid: 10 }],
          actions: [{
            id: 'go-to-layout', objectClass: 'System', sid: 20,
            parameters: { layout: '"Level 1"', transition: '"none"' },
          }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: { layout: '"Level 2"' },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.updatedBlockSid).toBe(100);
    expect(data.updatedActionIndex).toBe(0);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const action = (events[0].actions as Record<string, unknown>[])[0];
    const params = action.parameters as Record<string, unknown>;
    // New value applied — replaces (not merges)
    expect(params.layout).toBe('"Level 2"');
    // Old key not in new params — gone (replace semantics)
    expect(params.transition).toBeUndefined();
  });

  it('errors on nonexistent block SID', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 999,
      actionIndex: 0,
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 999');
  });

  it('errors on out-of-range action index', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
          actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 5,
      parameters: { x: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('errors when targeting a non-block event', async () => {
    const { server } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{ eventType: 'group', sid: 100, title: 'Test', children: [] }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('group');
  });

  it('works on a nested block inside a group', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'group', sid: 50, title: 'Movement', children: [{
            eventType: 'block', sid: 100,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'set-speed', objectClass: 'Player', sid: 20, parameters: { speed: '100' } }],
          }],
        }],
      }]]),
    });
    const result = await server.callTool('update_event_block_action', {
      sheetName: 'MainSheet',
      blockSid: 100,
      actionIndex: 0,
      parameters: { speed: '200' },
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const events = writtenData.events as Array<Record<string, unknown>>;
    const group = events[0];
    const block = (group.children as Record<string, unknown>[])[0];
    const action = (block.actions as Record<string, unknown>[])[0];
    expect((action.parameters as Record<string, unknown>).speed).toBe('200');
  });
});

describe('move_events_between_sheets', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('move_events_between_sheets')).toBe(true);
  });

  it('copies events to target sheet (copy semantics, deleteSource=false)', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [
            { eventType: 'block', sid: 100, conditions: [], actions: [] },
            { eventType: 'block', sid: 200, conditions: [], actions: [] },
          ],
        }],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [],
        }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [100],
      deleteSource: false,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.movedCount).toBe(1);
    expect(data.movedSids).toEqual([100]);

    // Only target sheet is written when deleteSource=false
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    const writtenTarget = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const targetEvents = writtenTarget.events as Array<Record<string, unknown>>;
    expect(targetEvents).toHaveLength(1);
    // A copy must not duplicate the source's SIDs.
    expect(targetEvents[0].sid).not.toBe(100);
    expect(typeof targetEvents[0].sid).toBe('number');
    expect(data.copiedTopLevelSids).toEqual([targetEvents[0].sid]);
  });

  it('gives every nested SID of a copy a fresh value and keeps SIDs on a move', async () => {
    const source = {
      eventType: 'block', sid: 100,
      conditions: [{ id: 'c', objectClass: 'System', sid: 101 }],
      actions: [{ id: 'a', objectClass: 'System', sid: 102 }],
      children: [{ eventType: 'block', sid: 103, conditions: [{ id: 'd', objectClass: 'System', sid: 104 }], actions: [] }],
    };
    const make = () => setup({
      eventSheets: new Map([
        ['SourceSheet', { name: 'SourceSheet', sid: 1, events: [structuredClone(source)] }],
        ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
      ]),
    });
    const collect = (value: unknown, out: number[] = []): number[] => {
      if (Array.isArray(value)) value.forEach(v => collect(v, out));
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (k === 'sid' && typeof v === 'number') out.push(v);
          else collect(v, out);
        }
      }
      return out;
    };

    const copy = make();
    const copied = parseResult(await copy.server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [100],
    }));
    expect(copied.reassignedSids).toBe(5);
    const copyEvents = (copy.writer.callsFor('writeEntityFile')[0].args[2] as any).events;
    const copySids = collect(copyEvents);
    expect(copySids).toHaveLength(5);
    expect(copySids.filter(s => [100, 101, 102, 103, 104].includes(s))).toEqual([]);
    expect(new Set(copySids).size).toBe(5);

    const move = make();
    await move.server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet', targetSheet: 'TargetSheet', sids: [100], deleteSource: true,
    });
    const moved = (move.writer.callsFor('writeEntityFile')[0].args[2] as any).events;
    expect(collect(moved)).toEqual([100, 101, 102, 103, 104]);
  });

  it('moves events (deleteSource=true) removes from source', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [
            { eventType: 'block', sid: 100, conditions: [], actions: [] },
            { eventType: 'block', sid: 200, conditions: [], actions: [] },
          ],
        }],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [],
        }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [100],
      deleteSource: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.deleteSource).toBe(true);

    // Both sheets are written
    expect(writer.callsFor('writeEntityFile')).toHaveLength(2);

    // Check source now has only sid=200
    const writeCalls = writer.callsFor('writeEntityFile');
    const sourceWrite = writeCalls.find((c: any) => c.args[1] === 'SourceSheet');
    const sourceEvents = (sourceWrite.args[2] as Record<string, unknown>).events as Array<Record<string, unknown>>;
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0].sid).toBe(200);
  });

  it('errors when source and target are the same sheet', async () => {
    const { server } = setup({
      eventSheets: new Map([['Sheet', { name: 'Sheet', sid: 1, events: [] }]]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'Sheet',
      targetSheet: 'Sheet',
      sids: [100],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be different');
  });

  it('errors when a SID is not found in source', async () => {
    const { server } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
        }],
        ['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }],
      ]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [999],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('999');
  });

  it('errors on nonexistent source sheet', async () => {
    const { server } = setup({
      eventSheets: new Map([['TargetSheet', { name: 'TargetSheet', sid: 2, events: [] }]]),
    });
    const result = await server.callTool('move_events_between_sheets', {
      sourceSheet: 'NoSuch',
      targetSheet: 'TargetSheet',
      sids: [100],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('inserts at start when position=start', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([
        ['SourceSheet', {
          name: 'SourceSheet', sid: 1,
          events: [{ eventType: 'block', sid: 100, conditions: [], actions: [] }],
        }],
        ['TargetSheet', {
          name: 'TargetSheet', sid: 2,
          events: [{ eventType: 'block', sid: 999, conditions: [], actions: [] }],
        }],
      ]),
    });
    await server.callTool('move_events_between_sheets', {
      sourceSheet: 'SourceSheet',
      targetSheet: 'TargetSheet',
      sids: [100],
      position: 'start',
      deleteSource: true,
    });
    const writtenTarget = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const targetEvents = writtenTarget.events as Array<Record<string, unknown>>;
    expect(targetEvents[0].sid).toBe(100);
    expect(targetEvents[1].sid).toBe(999);
  });
});

describe('move_event_block_items', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('move_event_block_items')).toBe(true);
  });

  it('reorders actions within one block using post-removal targetIndex', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [{
          eventType: 'block', sid: 100,
          conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
          actions: [
            { id: 'a', objectClass: 'System', sid: 20 },
            { id: 'b', objectClass: 'System', sid: 21 },
            { id: 'c', objectClass: 'System', sid: 22 },
          ],
        }],
      }]]),
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'MainSheet', sourceBlockSid: 100, targetBlockSid: 100,
      itemType: 'actions', indices: [0], targetIndex: 2,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].actions.map((item: any) => item.id)).toEqual(['b', 'c', 'a']);
    expect(written.events[0].actions.map((item: any) => item.sid)).toEqual([21, 22, 20]);
  });

  it('moves conditions between blocks and preserves SIDs', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [{ id: 'move', objectClass: 'System', sid: 10 }], actions: [] },
          { eventType: 'block', sid: 200, conditions: [{ id: 'keep', objectClass: 'System', sid: 11 }], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'MainSheet', sourceBlockSid: 100, targetBlockSid: 200,
      itemType: 'conditions', indices: [0], targetIndex: 0,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].conditions).toHaveLength(0);
    expect(written.events[1].conditions.map((item: any) => item.sid)).toEqual([10, 11]);
  });

  it('rejects moving conditions into an else block', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [{ id: 'move', objectClass: 'System', sid: 10 }], actions: [] },
          { eventType: 'block', sid: 200, isElse: true, conditions: [], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'MainSheet', sourceBlockSid: 100, targetBlockSid: 200,
      itemType: 'conditions', indices: [0], targetIndex: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('else block');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('preflights the destination item limit before a cross-block move', async () => {
    const targetActions = Array.from({ length: 100 }, (_, index) => ({ id: `action-${index}`, objectClass: 'System', sid: index + 1000 }));
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [{ id: 'source', objectClass: 'System', sid: 10 }], actions: [{ id: 'move', objectClass: 'System', sid: 20 }] },
          { eventType: 'block', sid: 200, conditions: [{ id: 'target', objectClass: 'System', sid: 11 }], actions: targetActions },
        ],
      }]]),
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'MainSheet', sourceBlockSid: 100, targetBlockSid: 200,
      itemType: 'actions', indices: [0], targetIndex: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('maximum');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('warns when the last condition is moved out of a non-else source block', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'block', sid: 100, conditions: [{ id: 'move', objectClass: 'System', sid: 10 }], actions: [] },
          { eventType: 'block', sid: 200, conditions: [{ id: 'target', objectClass: 'System', sid: 11 }], actions: [] },
        ],
      }]]),
    });
    const result = await server.callTool('move_event_block_items', {
      sheetName: 'MainSheet', sourceBlockSid: 100, targetBlockSid: 200,
      itemType: 'conditions', indices: [0], targetIndex: 0,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('All conditions were removed — block will match unconditionally (always true).');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });
});

// ─── update_event_variable ────────────────────────────────

describe('update_event_variable', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_variable')).toBe(true);
  });

  it('renames a variable event', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: 55 },
        ],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 55,
      newName: 'totalScore',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].name).toBe('totalScore');
  });

  it('changes variable type and initial value', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'flag', type: 'number', initialValue: '0', sid: 66 },
        ],
        sid: 1,
      }]]),
    });
    await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 66,
      newType: 'boolean',
      newInitialValue: 'false',
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].type).toBe('boolean');
    expect(written.events[0].initialValue).toBe('false');
  });

  it('sets static and constant flags', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'max', type: 'number', initialValue: '100', sid: 77 },
        ],
        sid: 1,
      }]]),
    });
    await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 77,
      isConstant: true,
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].isConstant).toBe(true);
  });

  it('errors if SID not found', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', { name: 'Game', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 9999,
      newName: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SID 9999');
  });

  it('errors if SID points to non-variable event', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'block', conditions: [], actions: [], sid: 88 },
        ],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 88,
      newName: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a variable event');
  });

  it('errors if new name already used', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [
          { eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: 55 },
          { eventType: 'variable', name: 'lives', type: 'number', initialValue: '3', sid: 56 },
        ],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 55,
      newName: 'lives',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      eventSheets: new Map([['Game', {
        name: 'Game',
        events: [{ eventType: 'variable', name: 'score', type: 'number', initialValue: '0', sid: 55 }],
        sid: 1,
      }]]),
    });
    const result = await server.callTool('update_event_variable', {
      sheetName: 'Game',
      sid: 55,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });
});

describe('add_event_to_sheet nested locators', () => {
  function nestedSheet() {
    return {
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'group', title: 'Movement', sid: 50, children: [] },
          { eventType: 'block', sid: 60, conditions: [{ id: 'x', objectClass: 'System', sid: 10 }], actions: [], children: [] },
          { eventType: 'group', title: 'NoChildrenArray', sid: 70 },
        ],
      }]]),
    };
  }

  it('adds a local variable inside a group by groupPath', async () => {
    const { server, writer } = setup(nestedSheet());
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'variable', variableName: 'localCount',
      variableType: 'number', groupPath: 'Movement',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events).toHaveLength(3);
    expect(written.events[0].children).toHaveLength(1);
    expect(written.events[0].children[0]).toMatchObject({ eventType: 'variable', name: 'localCount', type: 'number' });
  });

  it('adds a comment inside a block by parentSid at the start', async () => {
    const { server, writer } = setup(nestedSheet());
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'comment', commentText: 'note', parentSid: 60, position: 'start',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[1].children[0]).toEqual({ eventType: 'comment', text: 'note' });
  });

  it('creates the children array on a group that has none', async () => {
    const { server, writer } = setup(nestedSheet());
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'group', title: 'Inner', parentSid: 70,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[2].children).toHaveLength(1);
    expect(written.events[2].children[0].title).toBe('Inner');
  });

  it('keeps root behavior when no locator is given', async () => {
    const { server, writer } = setup(nestedSheet());
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'comment', commentText: 'root note',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events).toHaveLength(4);
    expect(written.events[3]).toEqual({ eventType: 'comment', text: 'root note' });
  });

  it('rejects both groupPath and parentSid', async () => {
    const { server, writer } = setup(nestedSheet());
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'comment', commentText: 'x', groupPath: 'Movement', parentSid: 60,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at most one of');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a nested include because C3 only serializes includes at the sheet root', async () => {
    const data = nestedSheet();
    data.eventSheets.set('Shared', { name: 'Shared', sid: 2, events: [] } as any);
    const { server, writer } = setup(data);
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'include', includeSheet: 'Shared', groupPath: 'Movement',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('root');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an unknown groupPath without writing', async () => {
    const { server, writer } = setup(nestedSheet());
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'comment', commentText: 'x', groupPath: 'Nope',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('move_event_block', () => {
  function movableSheet() {
    return {
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'group', title: 'Outer', sid: 50, children: [
              { eventType: 'group', title: 'Inner', sid: 51, children: [] },
            ],
          },
          {
            eventType: 'block', sid: 60,
            conditions: [{ id: 'x', objectClass: 'System', sid: 10 }],
            actions: [{ id: 'a', objectClass: 'System', sid: 20 }],
            children: [
              { eventType: 'block', sid: 61, conditions: [], actions: [], children: [
                { eventType: 'block', sid: 62, conditions: [], actions: [], children: [] },
              ] },
            ],
          },
          { eventType: 'block', sid: 70, conditions: [], actions: [], children: [] },
          { eventType: 'group', title: 'Empty', sid: 80 },
        ],
      }]]),
    };
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('move_event_block')).toBe(true);
  });

  it('moves a block into a group by groupPath, keeping its SID and children', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 60, groupPath: 'Outer > Inner',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.movedSid).toBe(60);
    expect(data.childrenMoved).toBe(2);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events.map((e: any) => e.sid)).toEqual([50, 70, 80]);
    const moved = written.events[0].children[0].children[0];
    expect(moved.sid).toBe(60);
    expect(moved.conditions[0].sid).toBe(10);
    expect(moved.actions[0].sid).toBe(20);
    expect(moved.children[0].sid).toBe(61);
    expect(moved.children[0].children[0].sid).toBe(62);
  });

  it('moves an event beside a sibling with position before', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 70, siblingSid: 50, position: 'before',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events.map((e: any) => e.sid)).toEqual([70, 50, 60, 80]);
  });

  it('reorders within one array using the post-removal sibling position', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 50, siblingSid: 70, position: 'after',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events.map((e: any) => e.sid)).toEqual([60, 70, 50, 80]);
  });

  it('moves a nested event out to the sheet root', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 61, position: 'start',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events.map((e: any) => e.sid)).toEqual([61, 50, 60, 70, 80]);
    expect(written.events[0].children[0].sid).toBe(62);
    expect(written.events[2].children).toHaveLength(0);
  });

  it('creates the children array on a container that has none', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 70, parentSid: 80,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const empty = written.events.find((e: any) => e.sid === 80);
    expect(empty.children.map((e: any) => e.sid)).toEqual([70]);
  });

  it('refuses to move an event into its own descendant', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 60, parentSid: 62,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('its own descendants');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses to move a group into a path that runs through itself', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 50, groupPath: 'Outer > Inner',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('its own descendants');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a siblingSid inside the moved subtree', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 60, siblingSid: 62, position: 'after',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('its own descendants');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses siblingSid equal to sid', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 60, siblingSid: 60, position: 'after',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('beside itself');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses parentSid equal to sid', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 50, parentSid: 50,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('inside itself');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects more than one locator', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 70, groupPath: 'Outer', parentSid: 50,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at most one of');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects before/after without siblingSid', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 70, position: 'before',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires siblingSid');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a target that cannot contain sub-events', async () => {
    const data = movableSheet();
    (data.eventSheets.get('MainSheet') as any).events.push({ eventType: 'variable', name: 'v', type: 'number', initialValue: '0', sid: 90 });
    const { server, writer } = setup(data);
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 70, parentSid: 90,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot contain sub-events');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('reports a missing SID with a navigable summary', async () => {
    const { server, writer } = setup(movableSheet());
    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 999, groupPath: 'Outer',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(result.content[0].text).toContain('carry no SID');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

describe('update_event_group', () => {
  function groupSheet() {
    return {
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          {
            eventType: 'group', disabled: false, title: 'Movement', description: 'old',
            isActiveOnStart: true, sid: 50, children: [
              { eventType: 'group', disabled: false, title: 'Collision', description: '', isActiveOnStart: true, sid: 51, children: [] },
            ],
          },
          { eventType: 'group', disabled: false, title: 'Combat', description: '', isActiveOnStart: true, sid: 52, children: [] },
          { eventType: 'block', sid: 60, conditions: [], actions: [], children: [] },
        ],
      }]]),
    };
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_event_group')).toBe(true);
  });

  it('updates title, description, flags and the observed color keys', async () => {
    const { server, writer } = setup(groupSheet());
    const result = await server.callTool('update_event_group', {
      sheetName: 'MainSheet', sid: 50, title: 'Locomotion', description: 'new',
      isActiveOnStart: false, disabled: true,
      backgroundColor: [0.36, 0.2, 0.2, 1], textColor: [0.82, 0.82, 0.82, 1],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0]).toMatchObject({
      title: 'Locomotion', description: 'new', isActiveOnStart: false, disabled: true,
      'background-color': [0.36, 0.2, 0.2, 1], 'text-color': [0.82, 0.82, 0.82, 1],
    });
    // children untouched
    expect(written.events[0].children[0].sid).toBe(51);
  });

  it('rejects a title that collides with a sibling group', async () => {
    const { server, writer } = setup(groupSheet());
    const result = await server.callTool('update_event_group', {
      sheetName: 'MainSheet', sid: 50, title: 'Combat',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('warns when the new title duplicates a group in another container', async () => {
    const { server } = setup(groupSheet());
    const result = await server.callTool('update_event_group', {
      sheetName: 'MainSheet', sid: 52, title: 'Collision',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.join(' ')).toContain('Collision');
  });

  it('rejects a non-group SID', async () => {
    const { server, writer } = setup(groupSheet());
    const result = await server.callTool('update_event_group', { sheetName: 'MainSheet', sid: 60, title: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a group');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an empty update', async () => {
    const { server } = setup(groupSheet());
    const result = await server.callTool('update_event_group', { sheetName: 'MainSheet', sid: 50 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });

  it('rejects an out-of-range color channel', async () => {
    const { server } = setup(groupSheet());
    await expect(server.callTool('update_event_group', {
      sheetName: 'MainSheet', sid: 50, backgroundColor: [2, 0, 0, 1],
    })).rejects.toThrow();
  });
});

describe('update_comment', () => {
  function commentSheet() {
    return {
      eventSheets: new Map([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'comment', text: 'root comment' },
          {
            eventType: 'group', title: 'Movement', sid: 50, children: [
              { eventType: 'block', sid: 60, conditions: [], actions: [], children: [] },
              { eventType: 'comment', text: 'group comment' },
            ],
          },
          { eventType: 'comment', text: 'sid comment', sid: 70 },
        ],
      }]]),
    };
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_comment')).toBe(true);
  });

  it('updates a root comment by index', async () => {
    const { server, writer } = setup(commentSheet());
    const result = await server.callTool('update_comment', { sheetName: 'MainSheet', index: 0, text: 'rewritten' });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].text).toBe('rewritten');
  });

  it('updates a nested comment by groupPath and index', async () => {
    const { server, writer } = setup(commentSheet());
    const result = await server.callTool('update_comment', {
      sheetName: 'MainSheet', groupPath: 'Movement', index: 1, text: 'nested rewrite',
      backgroundColor: [0.58, 0.15, 0.15, 1], textColor: [0, 0, 0, 0],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[1].children[1]).toEqual({
      eventType: 'comment', text: 'nested rewrite',
      'background-color': [0.58, 0.15, 0.15, 1], 'text-color': [0, 0, 0, 0],
    });
  });

  it('updates a comment by sid when one is present', async () => {
    const { server, writer } = setup(commentSheet());
    const result = await server.callTool('update_comment', { sheetName: 'MainSheet', sid: 70, text: 'by sid' });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[2]).toEqual({ eventType: 'comment', text: 'by sid', sid: 70 });
  });

  it('rejects an index that addresses a non-comment event', async () => {
    const { server, writer } = setup(commentSheet());
    const result = await server.callTool('update_comment', {
      sheetName: 'MainSheet', groupPath: 'Movement', index: 0, text: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a comment');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an out-of-range index', async () => {
    const { server, writer } = setup(commentSheet());
    const result = await server.callTool('update_comment', { sheetName: 'MainSheet', index: 9, text: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects both sid and index', async () => {
    const { server } = setup(commentSheet());
    const result = await server.callTool('update_comment', { sheetName: 'MainSheet', sid: 70, index: 0, text: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly one of');
  });

  it('rejects neither sid nor index', async () => {
    const { server } = setup(commentSheet());
    const result = await server.callTool('update_comment', { sheetName: 'MainSheet', text: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly one of');
  });

  it('rejects a container locator combined with sid', async () => {
    const { server } = setup(commentSheet());
    const result = await server.callTool('update_comment', {
      sheetName: 'MainSheet', sid: 70, groupPath: 'Movement', text: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('index addressing only');
  });

  it('rejects an empty update', async () => {
    const { server } = setup(commentSheet());
    const result = await server.callTool('update_comment', { sheetName: 'MainSheet', index: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });
});

describe('update_function', () => {
  function functionProject() {
    return {
      eventSheets: new Map<string, any>([
        ['Functions', {
          name: 'Functions', sid: 1,
          events: [
            {
              eventType: 'function-block', functionName: 'doThing', functionDescription: '',
              functionCategory: '', functionReturnType: 'none', functionCopyPicked: false,
              functionIsAsync: false,
              functionParameters: [
                { name: 'first', type: 'string', initialValue: '', comment: '', sid: 11 },
                { name: 'second', type: 'number', initialValue: '0', comment: '', sid: 12 },
              ],
              conditions: [], actions: [], children: [], sid: 100,
            },
            {
              eventType: 'function-block', functionName: 'otherThing', functionDescription: '',
              functionCategory: '', functionReturnType: 'none', functionCopyPicked: false,
              functionIsAsync: false, functionParameters: [],
              conditions: [], actions: [], children: [], sid: 101,
            },
          ],
        }],
        ['Callers', {
          name: 'Callers', sid: 2,
          events: [
            {
              eventType: 'group', title: 'Calls', sid: 200, children: [
                {
                  eventType: 'block', sid: 201, conditions: [], actions: [
                    { callFunction: 'doThing', sid: 210, parameters: ['"a"', '1'] },
                    { callFunction: 'otherThing', sid: 211 },
                    { type: 'script', language: 'javascript', script: ['// doThing'] },
                  ], children: [],
                },
              ],
            },
          ],
        }],
      ]),
    };
  }

  function callerFreeProject() {
    const data = functionProject();
    (data.eventSheets.get('Callers') as any).events[0].children[0].actions =
      [{ callFunction: 'otherThing', sid: 211 }];
    return data;
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_function')).toBe(true);
  });

  it('updates metadata without touching callers', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, description: 'does a thing',
      category: 'Gameplay', returnType: 'number', isAsync: true, copyPicked: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.renamedCallers).toBe(0);
    expect(data.updatedSheets).toEqual(['Functions']);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0]).toMatchObject({
      functionDescription: 'does a thing', functionCategory: 'Gameplay',
      functionReturnType: 'number', functionIsAsync: true, functionCopyPicked: true,
    });
  });

  it('refuses a rename while callers exist and renameCallers is false', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, functionName: 'doThingBetter',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('renameCallers=true');
    expect(result.content[0].text).toContain('Callers');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rewrites every callFunction action when renameCallers is true', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, functionName: 'doThingBetter', renameCallers: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.renamedCallers).toBe(1);
    expect(data.updatedSheets.sort()).toEqual(['Callers', 'Functions']);

    const writes = writer.callsFor('writeEntityFile');
    const callers = writes.find(c => c.args[1] === 'Callers')!.args[2] as any;
    const actions = callers.events[0].children[0].actions;
    expect(actions[0].callFunction).toBe('doThingBetter');
    expect(actions[0].sid).toBe(210);
    expect(actions[0].parameters).toEqual(['"a"', '1']);
    // unrelated call and the script action are untouched
    expect(actions[1].callFunction).toBe('otherThing');
    expect(actions[2].script).toEqual(['// doThing']);

    const funcs = writes.find(c => c.args[1] === 'Functions')!.args[2] as any;
    expect(funcs.events[0].functionName).toBe('doThingBetter');
  });

  it('renames without renameCallers when nothing calls the function', async () => {
    const { server, writer } = setup(callerFreeProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, functionName: 'doThingBetter',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.renamedCallers).toBe(0);
    expect(writer.callsFor('writeEntityFile').map(c => c.args[1])).toEqual(['Functions']);
  });

  it('refuses a rename onto an existing function name', async () => {
    const { server, writer } = setup(callerFreeProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, functionName: 'otherThing',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('appends parameters with fresh SIDs and warns about existing callers', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100,
      addParameters: [{ name: 'third', type: 'boolean' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.parameters).toEqual(['first', 'second', 'third']);
    expect(data.warnings.join(' ')).toContain('initial values');
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const params = written.events[0].functionParameters;
    expect(params[2]).toMatchObject({ name: 'third', type: 'boolean', initialValue: 'false', comment: '' });
    expect(params[2].sid).toEqual(expect.any(Number));
    expect(params[0].sid).toBe(11);
  });

  it('refuses parameter removal while callers exist because callers pass arguments positionally', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, removeParameters: ['first'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('positionally');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('removes a parameter when nothing calls the function', async () => {
    const { server, writer } = setup(callerFreeProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, removeParameters: ['first'],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].functionParameters.map((p: any) => p.name)).toEqual(['second']);
  });

  it('renames a parameter in place and keeps its SID and position', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, renameParameters: [{ from: 'first', to: 'primary' }],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0].functionParameters[0]).toMatchObject({ name: 'primary', sid: 11 });
  });

  it('warns about parameter references left inside the function body', async () => {
    const data = functionProject();
    (data.eventSheets.get('Functions') as any).events[0].actions =
      [{ id: 'set-value', objectClass: 'System', sid: 20, parameters: { value: 'first + 1' } }];
    const { server } = setup(data);
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, renameParameters: [{ from: 'first', to: 'primary' }],
    });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.warnings.join(' ')).toContain('parameter "first"');
  });

  it('rejects an unknown parameter name', async () => {
    const { server, writer } = setup(callerFreeProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, removeParameters: ['missing'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no parameter named');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a duplicate parameter name', async () => {
    const { server, writer } = setup(callerFreeProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Functions', sid: 100, addParameters: [{ name: 'second', type: 'number' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already has a parameter');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a non-function SID', async () => {
    const { server, writer } = setup(functionProject());
    const result = await server.callTool('update_function', {
      sheetName: 'Callers', sid: 201, description: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a function-block');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an empty update', async () => {
    const { server } = setup(functionProject());
    const result = await server.callTool('update_function', { sheetName: 'Functions', sid: 100 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });
});

describe('add_custom_action', () => {
  function customActionProject(extraEvents: any[] = []) {
    return {
      objects: new Map([['Sprite', { name: 'Sprite', sid: 5 }]]),
      families: new Map([['fAgents', { name: 'fAgents', sid: 6 }]]),
      eventSheets: new Map<string, any>([['MainSheet', {
        name: 'MainSheet', sid: 1,
        events: [
          { eventType: 'group', title: 'Behaviors', sid: 50, children: [] },
          ...extraEvents,
        ],
      }]]),
    };
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_custom_action')).toBe(true);
  });

  it('writes the observed custom-ace-block shape with parameter SIDs', async () => {
    const { server, writer } = setup(customActionProject());
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'fAgents', aceName: 'Validate Behavior: MoveToTargetUID',
      description: 'Validate the preconditions for the action.', category: '_Validate Behavior',
      parameters: [
        { name: 'leafNodeId', type: 'string' },
        { name: 'targetUid', type: 'number' },
      ],
      groupPath: 'Behaviors',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedSid).toEqual(expect.any(Number));

    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const def = written.events[0].children[0];
    expect(def.eventType).toBe('custom-ace-block');
    expect(def.aceType).toBe('action');
    expect(def.aceName).toBe('Validate Behavior: MoveToTargetUID');
    expect(def.objectClass).toBe('fAgents');
    expect(def.functionDescription).toBe('Validate the preconditions for the action.');
    expect(def.functionCategory).toBe('_Validate Behavior');
    expect(def.functionReturnType).toBe('none');
    expect(def.functionCopyPicked).toBe(false);
    expect(def.functionIsAsync).toBe(false);
    expect(def.conditions).toEqual([]);
    expect(def.actions).toEqual([]);
    // r495 writes no children key on a custom action without sub-events.
    expect(def).not.toHaveProperty('children');
    expect(def.functionParameters).toHaveLength(2);
    expect(def.functionParameters[0]).toMatchObject({ name: 'leafNodeId', type: 'string', initialValue: '', comment: '' });
    expect(def.functionParameters[1]).toMatchObject({ name: 'targetUid', type: 'number', initialValue: '0', comment: '' });
    expect(def.functionParameters[0].sid).toEqual(expect.any(Number));
    expect(def.functionParameters[1].sid).not.toBe(def.functionParameters[0].sid);
  });

  it('accepts an object type and honours the flags', async () => {
    const { server, writer } = setup(customActionProject());
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'blink',
      returnType: 'number', isAsync: true, copyPicked: true, position: 'start',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events[0]).toMatchObject({
      eventType: 'custom-ace-block', objectClass: 'Sprite', aceName: 'blink',
      functionReturnType: 'number', functionIsAsync: true, functionCopyPicked: true,
    });
  });

  it('rejects System as the owning object class', async () => {
    const { server, writer } = setup(customActionProject());
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'System', aceName: 'doThing',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not System');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a duplicate name on the same object class', async () => {
    const { server, writer } = setup(customActionProject([{
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'blink', objectClass: 'Sprite',
      functionParameters: [], conditions: [], actions: [], children: [], sid: 60,
    }]));
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'blink',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already defines a custom action');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('allows the same name on a different object class', async () => {
    const { server } = setup(customActionProject([{
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'blink', objectClass: 'Sprite',
      functionParameters: [], conditions: [], actions: [], children: [], sid: 60,
    }]));
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'fAgents', aceName: 'blink',
    });
    expect(parseResult(result).success).toBe(true);
  });

  it('rejects duplicate parameter names', async () => {
    const { server, writer } = setup(customActionProject());
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'blink',
      parameters: [{ name: 'a', type: 'number' }, { name: 'a', type: 'string' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unique');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an unknown groupPath without writing', async () => {
    const { server, writer } = setup(customActionProject());
    const result = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'blink', groupPath: 'Nope',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('can be moved and updated like any other event', async () => {
    const { server, writer } = setup(customActionProject([{
      eventType: 'custom-ace-block', aceType: 'action', aceName: 'blink', objectClass: 'Sprite',
      functionParameters: [], conditions: [], actions: [],
      children: [{ eventType: 'block', sid: 61, conditions: [], actions: [], children: [] }],
      sid: 60,
    }]));
    const moved = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: 60, parentSid: 50,
    });
    const data = parseResult(moved);
    expect(data.success).toBe(true);
    expect(data.movedType).toBe('custom-ace-block');
    expect(data.childrenMoved).toBe(1);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.events).toHaveLength(1);
    expect(written.events[0].children[0].sid).toBe(60);
    expect(written.events[0].children[0].children[0].sid).toBe(61);
  });
});
