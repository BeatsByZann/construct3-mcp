/**
 * add_event_to_sheet refuses top-level arguments it does not take (#ISSUE)
 * instead of dropping them; functionParams entries and the defaults stay as
 * they were. Real reader and writer on a copy of the minimal fixture; all
 * data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerMutationTools } from '../../src/tools/mutations.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let server: MockServer;

beforeEach(async () => {
  resetProjectIndex();
  dir = await mkdtemp(join(tmpdir(), 'c3-strict-event-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

const sheetPath = () => join(dir, 'eventSheets', 'MainSheet.json');

async function lastEvent(): Promise<Record<string, unknown>> {
  const events = (JSON.parse(await readFile(sheetPath(), 'utf-8')) as { events: Array<Record<string, unknown>> }).events;
  return events[events.length - 1];
}

describe('add_event_to_sheet refuses arguments it does not take (#ISSUE)', () => {
  it.each([
    [{ eventType: 'variable', variableName: 'Score', varType: 'string' }, 'varType'],
    [{ eventType: 'group', title: 'Movement', disabled: true }, 'disabled'],
    [{ eventType: 'function', functionName: 'GetScore', returnType: 'number' }, 'returnType'],
    [{ eventType: 'comment', commentText: 'Note', textColor: [1, 0, 0, 1] }, 'textColor'],
    [{ eventType: 'group', titel: 'Movement' }, 'titel'],
  ])('refuses %j and writes nothing', async (args, key) => {
    const before = await readFile(sheetPath());
    await expect(server.callTool('add_event_to_sheet', { sheetName: 'MainSheet', ...args }))
      .rejects.toThrow(new RegExp(`Unknown key\\(s\\) \\\\"${key}\\\\" in the arguments of add_event_to_sheet: they would not be written`));
    expect(Buffer.compare(await readFile(sheetPath()), before)).toBe(0);
  });
});

describe('add_event_to_sheet keeps what it took before (#ISSUE)', () => {
  it('accepts a functionParams entry copied from a sheet, with its sid', async () => {
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'function', functionName: 'Heal',
      functionParams: [{ name: 'amount', type: 'number', sid: 123456789012345 }],
    });
    expect(result.isError, result.content[0].text).toBeUndefined();
    expect((await lastEvent()).functionName).toBe('Heal');
  });

  it('gives a variable without initialValue the default of its type', async () => {
    const result = await server.callTool('add_event_to_sheet', {
      sheetName: 'MainSheet', eventType: 'variable', variableName: 'Lives', variableType: 'number',
    });
    expect(result.isError, result.content[0].text).toBeUndefined();
    expect((await lastEvent()).initialValue).toBe('0');
  });
});

describe('add_event_block and update_event_block take the keys added to them since they became strict', () => {
  const setPosition = { id: 'set-position', objectClass: 'Sprite', parameters: { x: '1', y: '2' } };

  async function sheetEvents(): Promise<Array<Record<string, unknown>>> {
    return (JSON.parse(await readFile(sheetPath(), 'utf-8')) as { events: Array<Record<string, unknown>> }).events;
  }

  it('add_event_block places a block among the sub-events of a group by parentSid, and names parentSid among its arguments', async () => {
    const added = await server.callTool('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'group', title: 'Movement' });
    const groupSid = (JSON.parse(added.content[0].text) as { generatedSid: number }).generatedSid;
    const result = await server.callTool('add_event_block', { sheetName: 'MainSheet', parentSid: groupSid, actions: [setPosition] });
    expect(result.isError, result.content[0].text).toBeUndefined();
    const group = (await lastEvent()) as { children: Array<Record<string, unknown>> };
    expect(group.children).toHaveLength(1);
    expect(group.children[0].eventType).toBe('block');
    // The refusal of an unknown key lists the arguments the tool takes; the text is the ZodError's JSON, in which quotes are escaped
    await expect(server.callTool('add_event_block', { sheetName: 'MainSheet', notAnArgument: true }))
      .rejects.toThrow(/add_event_block takes [^"\\]*\bparentSid\b/);
  });

  it('update_event_block inserts an action at an index with insertActions, and names insertActions among its arguments', async () => {
    const result = await server.callTool('update_event_block', {
      sheetName: 'MainSheet', sid: 400000000000003, insertActions: [{ index: 1, action: setPosition }],
    });
    expect(result.isError, result.content[0].text).toBeUndefined();
    const block = (await sheetEvents())[0] as { actions: Array<Record<string, unknown>> };
    expect(block.actions).toHaveLength(2);
    expect(block.actions[1].id).toBe('set-position');
    await expect(server.callTool('update_event_block', { sheetName: 'MainSheet', sid: 400000000000003, notAnArgument: true }))
      .rejects.toThrow(/update_event_block takes [^"\\]*\binsertActions\b/);
  });
});
