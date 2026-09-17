/**
 * Custom eases named by event-sheet ACE parameters (Tween actions).
 *
 * The W90 live round trip showed r495.2 saving `ease: "Bouncy"` as
 * `{ name, json: [{ folders: [], json: <ease file> }] }`; its shape is
 * `easeParameterRoundtrip` in test/fixtures/timeline-kinds/shapes-r495.json.
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
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerUsageTools } from '../../src/tools/usage-tools.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { registerRenameTools } from '../../src/tools/rename-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const SHAPES = join(__dirname, '..', 'fixtures', 'timeline-kinds', 'shapes-r495.json');

type Json = any;

const POINTS = [
  { x: 0, y: 0, startHandle: { x: 0.2, y: 0.6 } },
  { x: 0.5, y: 0.9, startHandle: { x: 0.1, y: 0 }, endHandle: { x: -0.1, y: 0 } },
  { x: 1, y: 1, endHandle: { x: -0.2, y: 0 } },
];

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = shapeOf(entry);
    return out;
  }
  return typeof value;
}

function tween(ease: string) {
  return {
    id: 'tween-one-property', objectClass: 'Sprite', behaviorType: 'Tween',
    parameters: { tags: '"Custom"', property: 'offsetX', 'end-value': 'Self.X + 50', time: '1', ease, 'destroy-on-complete': 'no' },
  };
}

describe('custom eases in event parameters (real project on disk)', () => {
  let tmpDir: string;
  let server: MockServer;
  let shapes: Json;

  beforeEach(async () => {
    resetProjectIndex();
    shapes = JSON.parse(await readFile(SHAPES, 'utf-8'));
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-ease-params-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    const deps = { server, reader, writer, idGen } as any;
    registerTimelineTools(deps);
    registerEventTools(deps);
    registerRenameTools(deps);
    registerUsageTools(server as any, reader);
    registerQueryTools(server as any, reader);
    registerAnalysisTools(server as any, reader);
    await ok('create_ease', { name: 'Bouncy', points: POINTS });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function ok(name: string, args: Record<string, unknown>) {
    const result = await server.callTool(name, args);
    if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  }

  async function sheet(): Promise<Json> {
    return JSON.parse(await readFile(join(tmpDir, 'eventSheets', 'MainSheet.json'), 'utf-8'));
  }

  async function easeFile(): Promise<Json> {
    return JSON.parse(await readFile(join(tmpDir, 'timelines', 'transitions', 'Bouncy.json'), 'utf-8'));
  }

  async function addTween(ease: string) {
    const result = await ok('add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [tween(ease)],
    });
    const data = await sheet();
    const block = data.events.find((e: Json) => e.sid === result.generatedSid) ?? data.events[data.events.length - 1];
    return { sid: block.sid as number, action: block.actions[0] };
  }

  it('embeds a custom ease the way the editor saves it, keeping the parameter order', async () => {
    const { action } = await addTween('Bouncy');
    expect(Object.keys(action.parameters)).toEqual(['tags', 'property', 'end-value', 'time', 'ease', 'destroy-on-complete']);
    expect(JSON.stringify(shapeOf(action.parameters.ease))).toBe(JSON.stringify(shapes.easeParameterRoundtrip));
    expect(action.parameters.ease).toEqual({ name: 'Bouncy', json: [{ folders: [], json: await easeFile() }] });
  });

  it('leaves built-in and unknown ease names as strings', async () => {
    expect((await addTween('easeinoutsine')).action.parameters.ease).toBe('easeinoutsine');
    expect((await addTween('NotAnEase')).action.parameters.ease).toBe('NotAnEase');
  });

  it('embeds a custom ease set through the block and action update tools', async () => {
    const { sid } = await addTween('easeoutsine');
    await ok('update_event_block', { sheetName: 'MainSheet', sid, updateActions: [{ index: 0, parameters: { ease: 'Bouncy' } }] });
    let action = (await sheet()).events.find((e: Json) => e.sid === sid).actions[0];
    expect(action.parameters.ease.name).toBe('Bouncy');
    expect(Object.keys(action.parameters)[4]).toBe('ease');

    await ok('update_event_block', { sheetName: 'MainSheet', sid, updateActions: [{ index: 0, parameters: { ease: 'easeinsine' } }] });
    action = (await sheet()).events.find((e: Json) => e.sid === sid).actions[0];
    expect(action.parameters.ease).toBe('easeinsine');

    await ok('update_event_block_action', { sheetName: 'MainSheet', blockSid: sid, actionIndex: 0, parameters: tween('Bouncy').parameters });
    action = (await sheet()).events.find((e: Json) => e.sid === sid).actions[0];
    expect(action.parameters.ease).toEqual({ name: 'Bouncy', json: [{ folders: [], json: await easeFile() }] });
  });

  it('refreshes embedded copies when the ease changes, and lists the sheets that use it', async () => {
    await addTween('Bouncy');
    const listed = await ok('list_eases', {});
    expect(listed.eases[0].usedByEventSheets).toEqual(['MainSheet']);

    const result = await ok('update_ease', { name: 'Bouncy', linear: true });
    expect(result.eventSheetsRefreshed).toEqual(['MainSheet']);
    const events = (await sheet()).events;
    const action = events[events.length - 1].actions[0];
    expect(action.parameters.ease.json[0].json.linear).toBe(true);
    expect(action.parameters.ease.json[0].json).toEqual(await easeFile());
  });

  it('refuses to delete an ease embedded in an event parameter, and warns about the copy when forced', async () => {
    await addTween('Bouncy');
    const refused = await server.callTool('delete_ease', { name: 'Bouncy' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('event sheet "MainSheet"');

    const forced = await ok('delete_ease', { name: 'Bouncy', force: true });
    expect(forced.warnings.join(' ')).toContain('embedded copy');
  });

  it('keeps the read and rename tools working on an embedded ease parameter', async () => {
    await addTween('Bouncy');
    const hits = await ok('search_project', { query: 'Bouncy' });
    expect(JSON.stringify(hits)).toContain('MainSheet');
    for (const [name, args] of [
      ['get_eventsheet_details', { name: 'MainSheet' }],
      ['get_eventsheet_flow', { format: 'json' }],
      ['get_function_map', {}],
      ['get_object_dependencies', { object: 'Sprite' }],
      ['find_orphaned_objects', {}],
      ['analyze_performance', {}],
      ['validate_project', {}],
      ['find_behavior_usage', { behaviorId: 'Tween' }],
      ['rename_layout', { name: 'Layout 1', newName: 'Level', dryRun: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await server.callTool(name, args);
      expect(result.isError, `${name}: ${result.content[0].text.slice(0, 200)}`).toBeFalsy();
    }
    const events = (await sheet()).events;
    expect(events[events.length - 1].actions[0].parameters.ease.name).toBe('Bouncy');
  });
});
