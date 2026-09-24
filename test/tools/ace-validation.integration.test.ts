/**
 * Real-writer tests for ACE validation in the event tools and validate_project.
 * Built-in conditions and actions are checked against Construct r495.2's own
 * definitions; a problem is a warning, and the event is still written.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerReplaceTools } from '../../src/tools/replace-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const SHEET = 'MainSheet';
const FIXTURE_BLOCK_SID = 400000000000003;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

/** The warnings of a result that come from ACE validation. */
function aceWarnings(result: { warnings?: string[] }): string[] {
  return (result.warnings ?? []).filter(w => w.includes('Construct r495.2') || / of the .* (plugin|behavior|object) /.test(w));
}

describe('ACE validation (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-ace-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerEventTools({ server, reader, writer, idGen } as any);
    registerObjectTools({ server, reader, writer, idGen } as any);
    registerReplaceTools({ server, reader, writer, idGen } as any);
    // Give the fixture Sprite a built-in behavior to check behavior ACEs against.
    const added = parseResult(await server.callTool('update_object_properties', {
      name: 'Sprite', addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    }));
    expect(added.success).toBe(true);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function sheetText(): Promise<string> {
    return readFile(join(tmpDir, 'eventSheets', `${SHEET}.json`), 'utf-8');
  }

  it('add_event_block writes a correct block with no ACE warning', async () => {
    const result = parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [
        { id: 'set-animation', objectClass: 'Sprite', parameters: { animation: '"Walk"', from: 'beginning' } },
        { id: 'simulate-control', objectClass: 'Sprite', behaviorType: 'Platform', parameters: { control: 'jump' } },
        { id: 'set-instvar-value', objectClass: 'Sprite', parameters: { 'instance-variable': 'hp', value: '1' } },
      ],
    }));
    expect(result.success).toBe(true);
    expect(aceWarnings(result)).toEqual([]);
  });

  it('add_event_block warns about each wrong ACE, sub-events included, and still writes the block', async () => {
    const result = parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'on-start-of-layuot', objectClass: 'System' }],
      actions: [{ id: 'simulate-control', objectClass: 'Sprite', behaviorType: 'Platform', parameters: { control: 'fly' } }],
      children: [{ conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [{ id: 'set-position', objectClass: 'Sprite', parameters: { x: '1', z: '2' } }] }],
    }));
    expect(result.success).toBe(true);
    const warnings = aceWarnings(result);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toMatch(/^Condition "on-start-of-layuot" on "System" \(SID \d+\): Construct r495\.2 defines no condition "on-start-of-layuot" for the System object\.$/);
    expect(warnings[1]).toMatch(/^Action "simulate-control" on "Sprite" \(SID \d+\): Parameter "control" of the action "simulate-control" is "fly"; the Platform behavior accepts "left", "right", "jump"\.$/);
    expect(warnings[2]).toContain('has no parameter(s) "z"');
    expect(warnings[3]).toContain('is missing parameter(s) "y"');
    expect(await sheetText()).toContain('on-start-of-layuot');
  });

  it('resolves a behavior a member object gets from its family, and a family ACE by the family\'s plugin', async () => {
    expect(parseResult(await server.callTool('create_family', { name: 'Movers', pluginId: 'Sprite', members: ['Sprite'] })).success).toBe(true);
    expect(parseResult(await server.callTool('update_family', { name: 'Movers', addBehaviors: [{ behaviorId: 'Sin', name: 'Wobble' }] })).success).toBe(true);

    const result = parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [
        { id: 'set-active', objectClass: 'Sprite', behaviorType: 'Wobble', parameters: { state: 'sideways' } },
        { id: 'fly-away', objectClass: 'Movers', parameters: {} },
      ],
    }));
    const warnings = aceWarnings(result);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('the Sin behavior accepts');
    expect(warnings[1]).toContain('defines no action "fly-away" for the Sprite plugin');
  });

  it('replace_object_in_events leaves an event alone when a same-named behavior is of another kind', async () => {
    expect(parseResult(await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' })).success).toBe(true);
    expect(parseResult(await server.callTool('create_object', { name: 'Rocket', pluginId: 'Sprite' })).success).toBe(true);
    expect(parseResult(await server.callTool('update_object_properties', { name: 'Hero', addBehaviors: [{ behaviorId: 'Platform', name: 'Move' }] })).success).toBe(true);
    expect(parseResult(await server.callTool('update_object_properties', { name: 'Rocket', addBehaviors: [{ behaviorId: 'Bullet', name: 'Move' }] })).success).toBe(true);
    expect(parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'simulate-control', objectClass: 'Hero', behaviorType: 'Move', parameters: { control: 'jump' } }],
    })).success).toBe(true);
    const before = await sheetText();

    const result = parseResult(await server.callTool('replace_object_in_events', { fromObject: 'Hero', toObject: 'Rocket' }));
    expect(result.success).toBe(true);
    expect(result.references.total).toBe(0);
    expect(result.skippedEvents).toHaveLength(1);
    expect(result.skippedEvents[0].reasons).toEqual(['"simulate-control" uses behavior "Move", which is a Platform behavior on Hero but a Bullet behavior on Rocket']);
    expect(await sheetText()).toBe(before);
  });

  it('replace_object_in_events checks the ACEs it swaps', async () => {
    expect(parseResult(await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' })).success).toBe(true);
    // A wrong choice already in a source sub-event is reported once the swap has touched it.
    expect(parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [{ id: 'set-animation', objectClass: 'Sprite', parameters: { animation: '"Walk"', from: 'start' } }] }],
    })).success).toBe(true);
    // An unrelated wrong ACE in a sub-event is not the swap's to report.
    expect(parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [{ id: 'teleport', objectClass: 'System', parameters: {} }] }],
    })).success).toBe(true);
    const result = parseResult(await server.callTool('replace_object_in_events', { fromObject: 'Sprite', toObject: 'Hero' }));
    expect(aceWarnings(result).some(w => w.includes('teleport'))).toBe(false);
    expect(result.success).toBe(true);
    expect(aceWarnings(result).some(w => w.startsWith('MainSheet: Action "set-animation" on "Hero"') && w.includes('"start"'))).toBe(true);
  });

  it('replace_in_expressions warns when a rewritten combo value stops being a choice', async () => {
    expect(parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'set-animation', objectClass: 'Sprite', parameters: { animation: '"Walk"', from: 'beginning' } }],
    })).success).toBe(true);

    // An unrelated wrong ACE elsewhere is not the rewrite's to report.
    expect(parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'teleport', objectClass: 'Sprite', parameters: {} }],
    })).success).toBe(true);
    const fine = parseResult(await server.callTool('replace_in_expressions', { find: 'Walk', replace: 'Run' }));
    expect(aceWarnings(fine)).toEqual([]);

    const broken = parseResult(await server.callTool('replace_in_expressions', { find: 'beginning', replace: 'start', parameterKeys: ['from'] }));
    expect(broken.success).toBe(true);
    const warnings = aceWarnings(broken);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^MainSheet: Action "set-animation" on "Sprite" \(SID \d+\): Parameter "from" of the action "set-animation" is "start"/);
  });

  it('update_event_block warns about the ACEs it adds or changes, not the ones it leaves alone', async () => {
    // Put a wrong action into the fixture block by hand, as an older tool could have.
    const path = join(tmpDir, 'eventSheets', `${SHEET}.json`);
    const sheet = JSON.parse(await sheetText());
    sheet.events[0].actions.push({ id: 'teleport', objectClass: 'Sprite', sid: 400000000000009, parameters: {} });
    await writeFile(path, JSON.stringify(sheet, null, '\t'));

    const good = parseResult(await server.callTool('update_event_block', {
      sheetName: SHEET, sid: FIXTURE_BLOCK_SID,
      addActions: [{ id: 'set-visible', objectClass: 'Sprite', parameters: { visibility: 'visible' } }],
    }));
    expect(good.success).toBe(true);
    expect(aceWarnings(good)).toEqual([]);

    const bad = parseResult(await server.callTool('update_event_block', {
      sheetName: SHEET, sid: FIXTURE_BLOCK_SID,
      updateActions: [{ index: 0, parameters: { x: '5', y: '6', z: '7' } }],
      addConditions: [{ id: 'is-overlaping-another-object', objectClass: 'Sprite', parameters: { object: 'Sprite' } }],
    }));
    expect(bad.success).toBe(true);
    const warnings = aceWarnings(bad);
    expect(warnings).toHaveLength(2);
    expect(warnings.some(w => w.startsWith('Condition "is-overlaping-another-object" on "Sprite"'))).toBe(true);
    expect(warnings.some(w => w.startsWith('Action "set-position" on "Sprite" (SID 400000000000002)') && w.includes('"z"'))).toBe(true);
    expect(warnings.some(w => w.includes('teleport'))).toBe(false);
  });

  it('update_event_block_action warns about parameters the action does not define', async () => {
    const result = parseResult(await server.callTool('update_event_block_action', {
      sheetName: SHEET, blockSid: FIXTURE_BLOCK_SID, actionIndex: 0, parameters: { x: '1', y: '2', speed: '9' },
    }));
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(['Action "set-position" on "Sprite" (SID 400000000000002): The action "set-position" of the Sprite plugin has no parameter(s) "speed". Its parameters are "x", "y".']);

    const clean = parseResult(await server.callTool('update_event_block_action', {
      sheetName: SHEET, blockSid: FIXTURE_BLOCK_SID, actionIndex: 0, parameters: { x: '3', y: '4' },
    }));
    expect(clean.warnings).toBeUndefined();
  });

  it('validate_project reports every wrong ACE in the project, located by sheet and SID', async () => {
    const clean = await validateProjectIntegrity(reader);
    expect(clean.summary.checksRun).toBe(18);
    expect(clean.warnings.filter(w => w.check.startsWith('ace-'))).toEqual([]);

    parseResult(await server.callTool('add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tik', objectClass: 'System' }],
      actions: [{ id: 'set-animation', objectClass: 'Sprite', parameters: { animation: '"Walk"', from: 'start' } }],
    }));
    resetProjectIndex();
    const result = await validateProjectIntegrity(reader);
    const ace = result.warnings.filter(w => w.check.startsWith('ace-'));
    expect(ace.map(w => w.check)).toEqual(['ace-unknown-ace', 'ace-invalid-choice']);
    expect(ace[0].entity).toMatch(/^eventSheets\/MainSheet\/sid:\d+$/);
    expect(ace[1].message).toContain('Parameter "from" of the action "set-animation" is "start"; the Sprite plugin accepts "current-frame", "beginning".');
  });
});
