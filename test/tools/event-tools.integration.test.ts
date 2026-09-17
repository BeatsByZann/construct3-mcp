/**
 * Real-writer test for update_event_block script actions.
 *
 * The mock tests assert the shape the handler builds; this one proves what
 * lands on disk through the real writer: the canonical C3 form
 * { type, language: "javascript", script: [lines] }, no SID on the script
 * action, and existing action SIDs preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
// From test/fixtures/minimal-project/eventSheets/MainSheet.json
const BLOCK_SID = 400000000000003;
const EXISTING_ACTION_SID = 400000000000002;

describe('update_event_block script actions (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-event-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerEventTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('appends a script action in canonical C3 form and leaves existing actions untouched', async () => {
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: BLOCK_SID,
      addActions: [{ type: 'script', script: 'const a = 1;\nconsole.log(a);' }],
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).success).toBe(true);

    const onDisk = JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8'));
    const actions = onDisk.events[0].actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].sid).toBe(EXISTING_ACTION_SID);
    expect(actions[1]).toEqual({ type: 'script', language: 'javascript', script: ['const a = 1;', 'console.log(a);'] });
    expect('sid' in actions[1]).toBe(false);
    await expect(stat(join(tmpDir, 'eventSheets', 'MainSheet.json.bak'))).resolves.toBeDefined();

    // The reader sees the same thing once the writer has invalidated its caches
    const reread = await reader.readEventSheet('MainSheet');
    expect((reread.events[0] as any).actions[1].script).toEqual(['const a = 1;', 'console.log(a);']);
  });

  it('writes a replaced condition in place with a fresh SID', async () => {
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet',
      sid: BLOCK_SID,
      replaceConditions: [{ index: 0, condition: { id: 'every-tick', objectClass: 'System' } }],
    });
    expect(result.isError).toBeFalsy();

    const onDisk = JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8'));
    const condition = onDisk.events[0].conditions[0];
    expect(condition.id).toBe('every-tick');
    expect(condition.sid).toEqual(expect.any(Number));
    expect(condition.sid).not.toBe(400000000000001);
    await expect(stat(join(tmpDir, 'eventSheets', 'MainSheet.json.bak'))).resolves.toBeDefined();
  });

  it('writes a nested block under a parent SID and rereads its generated SIDs', async () => {
    const result = await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      parentSid: BLOCK_SID,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    expect(result.isError).toBeFalsy();

    const onDisk = JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8'));
    const child = onDisk.events[0].children[0];
    expect(child.eventType).toBe('block');
    expect(child.sid).toEqual(expect.any(Number));
    expect(child.conditions[0].sid).toEqual(expect.any(Number));
    expect(child.sid).not.toBe(BLOCK_SID);
    await expect(stat(join(tmpDir, 'eventSheets', 'MainSheet.json.bak'))).resolves.toBeDefined();

    const reread = await reader.readEventSheet('MainSheet');
    expect((reread.events[0] as any).children[0].conditions[0].id).toBe('every-tick');
  });
});

describe('event structure tools (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');
  const readSheet = async (name = 'MainSheet') =>
    JSON.parse(await readFile(join(tmpDir, 'eventSheets', `${name}.json`), 'utf-8'));

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-event-struct-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerEventTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('moves a block into a group on disk, preserving its SID, items and children', async () => {
    // A sub-event first, so the moved block actually carries children.
    const child = await server.callTool('add_event_block', {
      sheetName: 'MainSheet', parentSid: BLOCK_SID,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    const childSid = JSON.parse(child.content[0].text).generatedSid as number;

    await server.callTool('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'group', title: 'Startup' });

    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: BLOCK_SID, groupPath: 'Startup',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.movedSid).toBe(BLOCK_SID);
    expect(data.childrenMoved).toBe(1);

    const onDisk = await readSheet();
    expect(onDisk.events).toHaveLength(1);
    expect(onDisk.events[0].eventType).toBe('group');
    const moved = onDisk.events[0].children[0];
    expect(moved.sid).toBe(BLOCK_SID);
    expect(moved.conditions[0].sid).toBe(400000000000001);
    expect(moved.actions[0].sid).toBe(EXISTING_ACTION_SID);
    expect(moved.children[0].sid).toBe(childSid);
  });

  it('refuses a move into the event\'s own descendant and leaves the file byte-identical', async () => {
    const child = await server.callTool('add_event_block', {
      sheetName: 'MainSheet', parentSid: BLOCK_SID,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
    });
    const childSid = JSON.parse(child.content[0].text).generatedSid as number;
    const before = await readFile(sheetPath(), 'utf-8');

    const result = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: BLOCK_SID, parentSid: childSid,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('its own descendants');
    expect(await readFile(sheetPath(), 'utf-8')).toBe(before);
  });

  it('adds a local variable inside a group and updates the group in place', async () => {
    await server.callTool('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'group', title: 'Startup' });
    const sheet = await readSheet();
    const groupSid = sheet.events.find((e: any) => e.eventType === 'group').sid as number;

    await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'variable', variableName: 'localTick',
      variableType: 'number', groupPath: 'Startup',
    });
    const groupResult = await server.callTool('update_event_group', {
      sheetName: 'MainSheet', sid: groupSid, title: 'Boot', description: 'startup work',
      isActiveOnStart: false, backgroundColor: [0.36, 0.2, 0.2, 1], textColor: [0.82, 0.82, 0.82, 1],
    });
    expect(groupResult.isError).toBeFalsy();

    const onDisk = await readSheet();
    const group = onDisk.events.find((e: any) => e.sid === groupSid);
    expect(group.title).toBe('Boot');
    expect(group.description).toBe('startup work');
    expect(group.isActiveOnStart).toBe(false);
    expect(group['background-color']).toEqual([0.36, 0.2, 0.2, 1]);
    expect(group['text-color']).toEqual([0.82, 0.82, 0.82, 1]);
    expect(group.children[0]).toMatchObject({ eventType: 'variable', name: 'localTick' });
  });

  it('rewrites a comment addressed by container index', async () => {
    await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'comment', commentText: 'first draft',
    });
    const result = await server.callTool('update_comment', {
      sheetName: 'MainSheet', index: 1, text: 'final text', textColor: [0, 0, 0, 0],
    });
    expect(result.isError).toBeFalsy();

    const onDisk = await readSheet();
    expect(onDisk.events[1]).toEqual({ eventType: 'comment', text: 'final text', 'text-color': [0, 0, 0, 0] });
    expect('sid' in onDisk.events[1]).toBe(false);
  });

  it('renames a function and rewrites its callers in another sheet on disk', async () => {
    await server.callTool('create_event_sheet', { name: 'Funcs' });
    await server.callTool('add_event_to_sheet', {
      sheetName: 'Funcs', eventType: 'function', functionName: 'doThing',
      functionParams: [{ name: 'first', type: 'string' }],
    });
    const funcSheet = await readSheet('Funcs');
    const funcSid = funcSheet.events[0].sid as number;

    await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'call-function', objectClass: 'System', callFunction: 'doThing', parameters: { p0: '"x"' } }],
    });

    const refused = await server.callTool('update_function', {
      sheetName: 'Funcs', sid: funcSid, functionName: 'doThingBetter',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('renameCallers=true');

    const result = await server.callTool('update_function', {
      sheetName: 'Funcs', sid: funcSid, functionName: 'doThingBetter', renameCallers: true,
      description: 'renamed', addParameters: [{ name: 'second', type: 'number' }],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.renamedCallers).toBe(1);
    expect(data.updatedSheets.sort()).toEqual(['Funcs', 'MainSheet']);

    const funcsOnDisk = await readSheet('Funcs');
    expect(funcsOnDisk.events[0].functionName).toBe('doThingBetter');
    expect(funcsOnDisk.events[0].functionDescription).toBe('renamed');
    expect(funcsOnDisk.events[0].functionParameters.map((p: any) => p.name)).toEqual(['first', 'second']);

    const mainOnDisk = await readSheet();
    const callAction = mainOnDisk.events[1].actions[0];
    expect(callAction.callFunction).toBe('doThingBetter');
    // Written in C3's call shape: positional arguments, no id/objectClass.
    expect(callAction.parameters).toEqual(['"x"']);
    expect(callAction).not.toHaveProperty('id');
    expect(callAction).not.toHaveProperty('objectClass');
  });

  it('writes a custom action definition on disk that move_event_block can relocate', async () => {
    await server.callTool('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'group', title: 'Behaviors' });
    const added = await server.callTool('add_custom_action', {
      sheetName: 'MainSheet', objectClass: 'Sprite', aceName: 'Validate Behavior: Blink',
      category: '_Validate Behavior', parameters: [{ name: 'leafNodeId', type: 'string' }],
    });
    const aceSid = JSON.parse(added.content[0].text).generatedSid as number;

    let onDisk = await readSheet();
    const def = onDisk.events.find((e: any) => e.sid === aceSid);
    expect(def).toMatchObject({
      eventType: 'custom-ace-block', aceType: 'action', objectClass: 'Sprite',
      aceName: 'Validate Behavior: Blink', functionCategory: '_Validate Behavior',
      functionReturnType: 'none', functionCopyPicked: false, functionIsAsync: false,
    });
    expect(def.functionParameters[0]).toMatchObject({ name: 'leafNodeId', type: 'string', initialValue: '', comment: '' });
    expect(def.functionParameters[0].sid).toEqual(expect.any(Number));

    const moved = await server.callTool('move_event_block', {
      sheetName: 'MainSheet', sid: aceSid, groupPath: 'Behaviors',
    });
    expect(JSON.parse(moved.content[0].text).movedType).toBe('custom-ace-block');

    onDisk = await readSheet();
    const group = onDisk.events.find((e: any) => e.eventType === 'group');
    expect(group.children[0].sid).toBe(aceSid);
    expect(onDisk.events.some((e: any) => e.sid === aceSid)).toBe(false);
  });

  it('refuses to drop a parameter while a caller exists and writes nothing', async () => {
    await server.callTool('create_event_sheet', { name: 'Funcs' });
    await server.callTool('add_event_to_sheet', {
      sheetName: 'Funcs', eventType: 'function', functionName: 'doThing',
      functionParams: [{ name: 'first', type: 'string' }],
    });
    const funcSid = (await readSheet('Funcs')).events[0].sid as number;
    await server.callTool('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'call-function', objectClass: 'System', callFunction: 'doThing' }],
    });
    const before = await readFile(join(tmpDir, 'eventSheets', 'Funcs.json'), 'utf-8');

    const result = await server.callTool('update_function', {
      sheetName: 'Funcs', sid: funcSid, removeParameters: ['first'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('positionally');
    expect(await readFile(join(tmpDir, 'eventSheets', 'Funcs.json'), 'utf-8')).toBe(before);
  });
});
