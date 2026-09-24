/**
 * Real-writer tests for the W89 event-sheet commands on a temp copy of
 * test/fixtures/rename-project (family Hostiles = Enemy + Player; sheets Main
 * and Shared/Helpers). Shapes are checked against the r495 forms sampled from
 * C3-ACE and Construct's examples:
 *   comment action  { type: "comment", text, text-color?, background-color? }
 *   custom call     { customAction, objectClass, customActionObjectClass?, sid, parameters?: [..] }
 *   function call   { callFunction, sid, parameters?: [..] }
 *   OR block        block-level isOrBlock; else block: leading System "else" condition
 *   script event    { eventType: "script", language: "javascript", script: [lines] } (no SID)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerEventTools } from '../../src/tools/event-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let server: MockServer;

function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function sheet(name = 'Main'): Promise<any> {
  const path = name === 'Helpers' ? join(tmpDir, 'eventSheets', 'Shared', 'Helpers.json') : join(tmpDir, 'eventSheets', `${name}.json`);
  return JSON.parse(await readFile(path, 'utf-8'));
}

function findBySid(events: any[], sid: number): any {
  for (const e of events) {
    if (e.sid === sid) return e;
    const hit = Array.isArray(e.children) ? findBySid(e.children, sid) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-event-parity-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerEventTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('add_event_block with every action kind', () => {
  it('writes comment rows, calls, disabled conditions and OR blocks in C3 form', async () => {
    const result = await server.callTool('add_event_block', {
      sheetName: 'Main',
      isOrBlock: true,
      conditions: [
        { id: 'every-tick', objectClass: 'System' },
        { id: 'on-start-of-layout', objectClass: 'System', disabled: true },
      ],
      actions: [
        { type: 'comment', text: 'Explain the next call', textColor: [1, 0, 0, 1], backgroundColor: [0, 0, 0, 1] },
        { callFunction: 'Hit', parameters: ['1', '"x"'] },
        { customAction: 'Retreat', objectClass: 'Enemy', customActionObjectClass: 'Hostiles', parameters: ['2'], disabled: true },
        { customAction: 'Retreat', objectClass: 'Hostiles' },
      ],
    });
    expect(result.isError).not.toBe(true);
    const sid = parse(result).generatedSid;
    const block = findBySid((await sheet()).events, sid);
    expect(block.isOrBlock).toBe(true);
    expect(block).not.toHaveProperty('isElse');
    expect(block.conditions[1]).toMatchObject({ id: 'on-start-of-layout', disabled: true });
    expect(block.conditions.some((c: any) => 'isOr' in c)).toBe(false);

    const [comment, fn, qualified, plain] = block.actions;
    expect(comment).toEqual({ type: 'comment', text: 'Explain the next call', 'text-color': [1, 0, 0, 1], 'background-color': [0, 0, 0, 1] });
    expect(Object.keys(fn)).toEqual(['callFunction', 'sid', 'parameters']);
    expect(fn.parameters).toEqual(['1', '"x"']);
    expect(Object.keys(qualified)).toEqual(['customAction', 'objectClass', 'customActionObjectClass', 'sid', 'parameters', 'disabled']);
    expect(Object.keys(plain)).toEqual(['customAction', 'objectClass', 'sid']);
  });

  it('writes an else-if block with the else condition first', async () => {
    // An else must follow an event block, so give it one.
    await server.callTool('add_event_block', {
      sheetName: 'Main',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [],
    });
    const result = await server.callTool('add_event_block', {
      sheetName: 'Main', isElse: true,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [],
    });
    const block = findBySid((await sheet()).events, parse(result).generatedSid);
    expect(block.conditions.map((c: any) => [c.id, c.objectClass])).toEqual([['else', 'System'], ['every-tick', 'System']]);
  });

  it('refuses a custom action call on an unknown family', async () => {
    const result = await server.callTool('add_event_block', {
      sheetName: 'Main',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ customAction: 'Retreat', objectClass: 'Enemy', customActionObjectClass: 'Nobody' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown objectClass "Nobody"');
  });
});

describe('update_event_block on comment rows, calls and conditions', () => {
  async function seed() {
    const result = await server.callTool('add_event_block', {
      sheetName: 'Main',
      conditions: [{ id: 'every-tick', objectClass: 'System' }, { id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [
        { type: 'comment', text: 'old' },
        { callFunction: 'Hit', parameters: ['1'] },
        { id: 'destroy', objectClass: 'Enemy' },
      ],
    });
    return parse(result).generatedSid as number;
  }

  it('edits comment text and colors, call arguments, condition disabled and OR mode', async () => {
    const sid = await seed();
    const result = await server.callTool('update_event_block', {
      sheetName: 'Main', sid, isOrBlock: true,
      updateActions: [
        { index: 0, text: 'new', textColor: [0, 1, 0, 1] },
        { index: 1, arguments: ['2', '3'] },
      ],
      updateConditions: [{ index: 1, disabled: true }],
    });
    expect(result.isError).not.toBe(true);
    let block = findBySid((await sheet()).events, sid);
    expect(block.actions[0]).toEqual({ type: 'comment', text: 'new', 'text-color': [0, 1, 0, 1] });
    expect(block.actions[1].parameters).toEqual(['2', '3']);
    expect(block.conditions[1].disabled).toBe(true);
    expect(block.isOrBlock).toBe(true);

    await server.callTool('update_event_block', {
      sheetName: 'Main', sid, isOrBlock: false,
      updateConditions: [{ index: 1, disabled: false }],
    });
    block = findBySid((await sheet()).events, sid);
    expect(block).not.toHaveProperty('isOrBlock');
    expect(block.conditions[1]).not.toHaveProperty('disabled');
  });

  it('refuses text on a non-comment action and keyed parameters on a call', async () => {
    const sid = await seed();
    const before = JSON.stringify(await sheet());
    const text = await server.callTool('update_event_block', { sheetName: 'Main', sid, updateActions: [{ index: 2, text: 'x' }] });
    expect(text.isError).toBe(true);
    expect(text.content[0].text).toContain('not an action comment');
    const keyed = await server.callTool('update_event_block', { sheetName: 'Main', sid, updateActions: [{ index: 1, parameters: { a: '1' } }] });
    expect(keyed.isError).toBe(true);
    expect(keyed.content[0].text).toContain('does not take keyed parameters');
    const args = await server.callTool('update_event_block', { sheetName: 'Main', sid, updateActions: [{ index: 2, arguments: ['1'] }] });
    expect(args.isError).toBe(true);
    expect(JSON.stringify(await sheet())).toBe(before);
  });

  it('edits the body of a custom action definition', async () => {
    const added = parse(await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Hostiles', aceName: 'Retreat' }));
    const result = await server.callTool('update_event_block', {
      sheetName: 'Main', sid: added.generatedSid,
      addActions: [{ type: 'comment', text: 'body' }],
    });
    expect(result.isError).not.toBe(true);
    const def = findBySid((await sheet()).events, added.generatedSid);
    expect(def.actions).toEqual([{ type: 'comment', text: 'body' }]);
    // Like the editor, a definition without sub-events has no children key.
    expect(def).not.toHaveProperty('children');
  });
});

describe('script blocks and variable comments', () => {
  it('adds, edits and removes a standalone script block', async () => {
    const add = await server.callTool('add_event_to_sheet', {
      sheetName: 'Main', eventType: 'script', script: 'const a = 1;\nconsole.log(a);', position: 'start',
    });
    expect(add.isError).not.toBe(true);
    let events = (await sheet()).events;
    expect(events[0]).toEqual({ eventType: 'script', language: 'javascript', script: ['const a = 1;', 'console.log(a);'] });

    const wrong = await server.callTool('update_script_event', { sheetName: 'Main', index: 1, script: 'x' });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toContain('not a script block');

    await server.callTool('update_script_event', { sheetName: 'Main', index: 0, script: ['let b = 2;'] });
    events = (await sheet()).events;
    expect(events[0].script).toEqual(['let b = 2;']);

    const count = events.length;
    await server.callTool('update_script_event', { sheetName: 'Main', index: 0, remove: true });
    events = (await sheet()).events;
    expect(events).toHaveLength(count - 1);
    expect(events[0].eventType).not.toBe('script');
  });

  it('writes and edits variable comments', async () => {
    await server.callTool('add_event_to_sheet', {
      sheetName: 'Main', eventType: 'variable', variableName: 'lives', variableType: 'number',
      initialValue: '3', variableComment: 'Lives left', variableIsConstant: true,
    });
    const events = (await sheet()).events;
    const variable = events.find((e: any) => e.eventType === 'variable' && e.name === 'lives');
    expect(variable).toMatchObject({ comment: 'Lives left', isStatic: false, isConstant: true });
    expect(Object.keys(variable)).toEqual(['eventType', 'name', 'type', 'initialValue', 'comment', 'isStatic', 'isConstant', 'sid']);

    await server.callTool('update_event_variable', { sheetName: 'Main', sid: variable.sid, comment: 'Changed' });
    const after = (await sheet()).events.find((e: any) => e.sid === variable.sid);
    expect(after.comment).toBe('Changed');
  });
});

describe('update_function on custom action definitions', () => {
  async function seedCustomActions() {
    const family = parse(await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Hostiles', aceName: 'Retreat', parameters: [{ name: 'speed', type: 'number' }] }));
    // Player overrides the family action; its calls must not be renamed.
    const override = parse(await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Player', aceName: 'Retreat' }));
    const calls = parse(await server.callTool('add_event_block', {
      sheetName: 'Helpers',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [
        { customAction: 'Retreat', objectClass: 'Hostiles', parameters: ['1'] },
        { customAction: 'Retreat', objectClass: 'Enemy', parameters: ['2'] },
        { customAction: 'Retreat', objectClass: 'Player', customActionObjectClass: 'Hostiles', parameters: ['3'] },
        { customAction: 'Retreat', objectClass: 'Player' },
      ],
    }));
    return { familySid: family.generatedSid, overrideSid: override.generatedSid, blockSid: calls.generatedSid };
  }

  it('reports call sites in a dry run without writing', async () => {
    const { familySid } = await seedCustomActions();
    const before = JSON.stringify(await sheet('Helpers'));
    const report = parse(await server.callTool('update_function', { sheetName: 'Main', sid: familySid, dryRun: true }));
    expect(report).toMatchObject({ dryRun: true, kind: 'custom-action', name: 'Retreat', objectClass: 'Hostiles', callCount: 3, parameters: ['speed'] });
    expect(report.callSites.map((s: any) => s.arguments)).toEqual([['1'], ['2'], ['3']]);
    expect(JSON.stringify(await sheet('Helpers'))).toBe(before);
  });

  it('refuses a rename with callers unless renameCallers is set, then rewrites the resolved calls only', async () => {
    const { familySid, overrideSid, blockSid } = await seedCustomActions();
    const refused = await server.callTool('update_function', { sheetName: 'Main', sid: familySid, functionName: 'Flee' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Custom action "Retreat" is called by 3 action(s)');

    const result = parse(await server.callTool('update_function', {
      sheetName: 'Main', sid: familySid, functionName: 'Flee', renameCallers: true, description: 'Run away',
    }));
    expect(result).toMatchObject({ success: true, kind: 'custom-action', functionName: 'Flee', renamedCallers: 3 });
    expect(result.warnings.join(' ')).toContain('Player');

    const main = (await sheet()).events;
    expect(findBySid(main, familySid)).toMatchObject({ aceName: 'Flee', functionDescription: 'Run away' });
    expect(findBySid(main, familySid)).not.toHaveProperty('functionName');
    expect(findBySid(main, overrideSid).aceName).toBe('Retreat');
    const actions = findBySid((await sheet('Helpers')).events, blockSid).actions;
    expect(actions.map((a: any) => a.customAction)).toEqual(['Flee', 'Flee', 'Flee', 'Retreat']);
  });

  it('refuses a rename that would redirect plain member calls to a member\'s own action', async () => {
    const { familySid } = await seedCustomActions();
    // Enemy defines its own Charge; renaming Hostiles.Retreat to Charge would send
    // the plain call { customAction: Retreat, objectClass: Enemy } to Enemy.Charge.
    await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Enemy', aceName: 'Charge' });
    const before = JSON.stringify(await sheet('Helpers'));
    const result = await server.callTool('update_function', { sheetName: 'Main', sid: familySid, functionName: 'Charge', renameCallers: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Enemy already define a custom action named "Charge"');
    expect(JSON.stringify(await sheet('Helpers'))).toBe(before);
  });

  it('refuses renaming a member action onto a family action name its plain calls reach', async () => {
    await seedCustomActions();
    const enemyOwn = parse(await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Enemy', aceName: 'Dodge' }));
    // Enemy's plain Retreat call currently reaches Hostiles.Retreat.
    const result = await server.callTool('update_function', { sheetName: 'Main', sid: enemyOwn.generatedSid, functionName: 'Retreat', renameCallers: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reach the family definition in Hostiles');
  });

  it('refuses a duplicate custom action name on the same owner', async () => {
    const { familySid } = await seedCustomActions();
    await server.callTool('add_custom_action', { sheetName: 'Main', objectClass: 'Hostiles', aceName: 'Charge' });
    const result = await server.callTool('update_function', { sheetName: 'Main', sid: familySid, functionName: 'Charge', renameCallers: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already defines a custom action named "Charge"');
  });
});
