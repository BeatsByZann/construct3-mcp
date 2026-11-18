/**
 * update_event_variable renames the uses of the variable it renames: which uses
 * it points at the new name, which it lists and refuses without force, what a
 * failed write puts back. Real reader, writer and ID generator on a temp copy of
 * the minimal fixture; the refusals are also run on the mocks. All data is
 * synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { AceCatalogProvider, setAceCatalogProvider } from '../../src/construct3/ace-catalog-provider.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

/** A synthetic event, condition or action, with the keys the tests read. */
interface Json {
  [key: string]: unknown;
  eventType?: string;
  name?: string;
  title?: string;
  id?: string;
  sid?: number;
  conditions?: Json[];
  actions?: Json[];
  children?: Json[];
  parameters?: Json | string[];
}

/** An event as read back from a sheet on disk, where the tests read blocks and their conditions and actions. */
interface Ev {
  eventType: string;
  name?: string;
  title?: string;
  id?: string;
  conditions: Ev[];
  actions: Ev[];
  children: Ev[];
  parameters: Record<string, unknown>;
}

/** One use or one left use, as the tool lists it. */
type Entry = Record<string, unknown>;

/** What update_event_variable returns, parsed; an error result has its text in `text`. */
interface Result {
  success?: boolean;
  action?: string;
  dryRun?: boolean;
  message: string;
  isError: boolean;
  text: string;
  uses?: Entry[];
  usesNotUpdated?: Entry[];
  captured?: Entry[];
  unscannedFiles?: Entry[];
  sheetsWritten?: string[];
  sheetsToWrite?: string[];
  warnings: string[];
  editorNote?: unknown;
}

// ─── Synthetic sheets ───

let nextSid = 1000;
const sid = () => ++nextSid;

const variable = (name: string, id: number): Json =>
  ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: id });
const setVar = (name: string, value = '1'): Json => ({ id: 'set-eventvar-value', objectClass: 'System', sid: sid(), parameters: { variable: name, value } });
const compareVar = (name: string): Json =>
  ({ id: 'compare-eventvar', objectClass: 'System', sid: sid(), parameters: { variable: name, comparison: 0, value: '0' } });
const callF = (...args: string[]): Json => ({ callFunction: 'F', sid: sid(), parameters: args });
const scriptAction = (lines: string[]): Json => ({ type: 'script', script: lines, sid: sid() });
const block = (conditions: Json[], actions: Json[], children?: Json[]): Json =>
  ({ eventType: 'block', conditions, actions, ...(children ? { children } : {}), sid: sid() });
const group = (title: string, children: Json[]): Json => ({ eventType: 'group', title, description: '', isActiveOnStart: true, children, sid: sid() });
const groupActive: () => Json = () =>
  ({ id: 'set-group-active', objectClass: 'System', sid: sid(), parameters: { 'group-name': 'Bonus', state: 'activated' } });

/** `inner` inside `depth` nested blocks. */
function nest(depth: number, inner: Json): Json {
  let event = inner;
  for (let i = 0; i < depth; i++) event = block([], [], [event]);
  return event;
}

function mainEvents(): Json[] {
  return [
    variable('Score', 1),
    variable('Lives', 5),
    variable('Bonus', 6),
    variable('Größe', 7),
    variable('activated', 8),
    variable('Unused', 9),
    {
      eventType: 'function-block', functionName: 'F', functionDescription: '', functionCategory: '', functionReturnType: 'none',
      functionCopyPicked: false, functionIsAsync: false, conditions: [], actions: [], sid: sid(),
      functionParameters: [{ name: 'n', type: 'number', initialValue: '0', comment: '', sid: sid() }],
    },
    block([compareVar('score')], [
      setVar('Score', '5'),
      callF('Score * 2'),
      callF('Größe'),
      { id: 'set-text', objectClass: 'Txt', sid: sid(), parameters: { text: '"L=" & Lives' } },
      groupActive(),
      scriptAction(['runtime.globalVars.Lives = 1;']),
    ]),
    group('A', [variable('Count', 2), block([], [setVar('Count', '1')], [block([], [callF('Count + 1')])])]),
    group('B', [variable('Count', 3), block([], [callF('count')])]),
    group('Shadow', [variable('Score', 4), block([], [setVar('Score', '2')])]),
  ];
}

const otherEvents = (): Json[] => [block([], [callF('Score'), setVar('Points', '1')])];

const sheetOf = (name: string, events: Json[]): Json => ({ name, events, sid: sid() });

// ─── Files ───

const sheetFile = (name: string) => join(tmpDir, 'eventSheets', `${name}.json`);
const readSheet = async (name: string): Promise<{ events: Ev[] }> => JSON.parse(await readFile(sheetFile(name), 'utf-8'));
const writeSheet = (name: string, events: Json[]) => writeFile(sheetFile(name), JSON.stringify(sheetOf(name, events), null, '\t'));

async function register(name: string): Promise<void> {
  const path = join(tmpDir, 'project.c3proj');
  const project = JSON.parse(await readFile(path, 'utf-8'));
  project.eventSheets.items.push(name);
  await writeFile(path, JSON.stringify(project, null, '\t'));
}

/** Another registered event sheet, and the server started again on the project as it is on disk. */
async function addSheet(name: string, events: Json[]): Promise<void> {
  await register(name);
  await writeSheet(name, events);
  await start();
}

async function files(dir = tmpDir): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of await files(path)) found.set(k, v);
    } else if (!entry.name.endsWith('.bak')) {
      found.set(relative(tmpDir, path).replace(/\\/g, '/'), (await readFile(path)).toString('base64'));
    }
  }
  return found;
}

/** The editor saves the file: other bytes, another length, modification time moved two seconds forward. */
async function editorSave(path: string, text: string): Promise<void> {
  await writeFile(path, text);
  const later = new Date((await stat(path)).mtimeMs + 2000);
  await utimes(path, later, later);
}

async function start(): Promise<void> {
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerEventTools({ server, reader, writer, idGen } as never);
}

/** The result of update_event_variable, parsed (an error result has its text in `text`). */
async function update(args: Record<string, unknown>): Promise<Result> {
  const result = await server.callTool('update_event_variable', { sheetName: 'MainSheet', ...args });
  let json: Partial<Result> = {};
  try {
    json = JSON.parse(result.content[0].text);
  } catch {
    // an error result is plain text
  }
  return { message: '', warnings: [], ...json, isError: result.isError === true, text: result.content[0].text };
}

const eventsOf = (sheet: { events: Ev[] }): Ev[] => sheet.events;
const named = (events: Ev[], name: string): Ev => events.find(e => e.eventType === 'variable' && e.name === name)!;
const groupOf = (events: Ev[], title: string): Ev => events.find(e => e.eventType === 'group' && e.title === title)!;

/** Add `event` to the children of the group `title` of freshly built events. */
function pushIntoGroup(events: Json[], title: string, event: Json): void {
  const found = events.find(e => e.eventType === 'group' && e.title === title);
  if (!found?.children) throw new Error(`No group ${title}`);
  found.children.push(event);
}

/** The sheets a MockReader stores, as it hands them out. */
const storedSheets = (mock: MockReader): Map<string, unknown> => (mock as unknown as { eventSheets: Map<string, unknown> }).eventSheets;

beforeEach(async () => {
  nextSid = 1000;
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-variable-rename-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  await writeSheet('MainSheet', mainEvents());
  await register('Other');
  await writeSheet('Other', otherEvents());
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── The rename ───

describe('update_event_variable renames the uses', () => {
  it('renames the uses of a global in every sheet, the other sheets first', async () => {
    const result = await update({ sid: 1, newName: 'Points' });
    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
    const main = eventsOf(await readSheet('MainSheet'));
    const other = eventsOf(await readSheet('Other'));
    expect(named(main, 'Points')).toBeDefined();
    const first = main.find(e => e.eventType === 'block')!;
    expect(first.conditions[0].parameters.variable).toBe('Points');
    expect(first.actions[0].parameters.variable).toBe('Points');
    expect(first.actions[1].parameters).toEqual(['Points * 2']);
    expect(other[0].actions[0].parameters).toEqual(['Points']);
    expect(result.sheetsWritten).toEqual(['eventSheets/Other.json', 'eventSheets/MainSheet.json']);
    expect(result.uses!.map(u => `${u.sheet}|${u.kind}|${u.parameter}|${u.value}`).sort()).toEqual([
      'MainSheet|event-variable|variable|Score',
      'MainSheet|event-variable|variable|score',
      'MainSheet|variable-expression|0|Score * 2',
      'Other|variable-expression|0|Score',
    ]);
    for (const use of result.uses!) {
      expect(typeof use.path).toBe('string');
      expect(typeof use.sid).toBe('number');
    }
    expect(result.captured).toEqual([expect.objectContaining({ sheet: 'Other', kind: 'event-variable' })]);
    expect(result.warnings.some((w: string) => w.includes('Pointed 4 use(s) of "Score" at "Points"'))).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('found no event variable or function parameter before'))).toBe(true);
  });

  it('renames a global and leaves a local that shadows it', async () => {
    await update({ sid: 1, newName: 'Points' });
    const main = eventsOf(await readSheet('MainSheet'));
    const shadow = groupOf(main, 'Shadow').children;
    expect(shadow[0].name).toBe('Score');
    expect(shadow[1].actions[0].parameters.variable).toBe('Score');
    expect(main.find(e => e.eventType === 'block')!.actions[0].parameters.variable).toBe('Points');
    expect(eventsOf(await readSheet('Other'))[0].actions[0].parameters).toEqual(['Points']);
  });

  it('renames one of two sibling locals and leaves the other\'s uses', async () => {
    const result = await update({ sid: 2, newName: 'Tally' });
    expect(result.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    const a = groupOf(main, 'A').children;
    expect(a[0].name).toBe('Tally');
    expect(a[1].actions[0].parameters.variable).toBe('Tally');
    expect(a[1].children[0].actions[0].parameters).toEqual(['Tally + 1']);
    const b = groupOf(main, 'B').children;
    expect(b[0].name).toBe('Count');
    expect(b[1].actions[0].parameters).toEqual(['count']);
    expect(result.sheetsWritten).toEqual(['eventSheets/MainSheet.json']);
  });

  it('renames to another letter case, rewriting every use to the new spelling', async () => {
    const result = await update({ sid: 1, newName: 'SCORE' });
    expect(result.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    const first = main.find(e => e.eventType === 'block')!;
    expect(named(main, 'SCORE')).toBeDefined();
    expect(first.conditions[0].parameters.variable).toBe('SCORE');
    expect(first.actions[0].parameters.variable).toBe('SCORE');
    expect(first.actions[1].parameters).toEqual(['SCORE * 2']);
  });

  it('with dryRun reports the uses and the sheets it would write and writes nothing', async () => {
    const before = await files();
    const result = await update({ sid: 1, newName: 'Points', dryRun: true });
    expect(result.action).toBe('would_update');
    expect(result.dryRun).toBe(true);
    expect(result.uses!.length).toBe(4);
    expect(result.sheetsToWrite).toEqual(['eventSheets/Other.json', 'eventSheets/MainSheet.json']);
    expect(result.editorNote).toBeUndefined();
    expect(await files()).toEqual(before);
  });

  it('refuses without force when a parameter it cannot update names the variable; never changes it with force', async () => {
    const before = await files();
    const refused = await update({ sid: 5, newName: 'Hearts' });
    expect(refused.success).toBe(false);
    expect(refused.action).toBe('rename_blocked');
    expect(refused.usesNotUpdated!.map(u => `${u.parameter ?? '-'}|${u.reason}`).sort()).toEqual(['-|script', 'text|parameter-type-unknown']);
    expect(refused.message.endsWith('Nothing was changed.')).toBe(true);
    expect(await files()).toEqual(before);

    const textBefore = JSON.stringify(eventsOf(await readSheet('MainSheet')).find(e => e.eventType === 'block')!.actions.slice(3, 6));
    const forced = await update({ sid: 5, newName: 'Hearts', force: true });
    expect(forced.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    expect(named(main, 'Hearts')).toBeDefined();
    expect(JSON.stringify(main.find(e => e.eventType === 'block')!.actions.slice(3, 6))).toBe(textBefore);
    expect(forced.warnings.some((w: string) => w.includes('They still name "Lives"') && w.includes('"Invalid expressions" dialog'))).toBe(true);
  });

  it('never writes a group name or a combo choice spelled like a variable', async () => {
    const refused = await update({ sid: 6, newName: 'Prize' });
    expect(refused.action).toBe('rename_blocked');
    expect(refused.usesNotUpdated!.map(u => `${u.parameter}|${u.reason}`)).toEqual(['group-name|parameter-type-unknown']);
    const forced = await update({ sid: 6, newName: 'Prize', force: true });
    expect(forced.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    expect(named(main, 'Prize')).toBeDefined();
    const active = main.find(e => e.eventType === 'block')!.actions.find(a => a.id === 'set-group-active');
    expect(active?.parameters).toEqual({ 'group-name': 'Bonus', state: 'activated' });
  });

  it('renames a variable with a non-ASCII name', async () => {
    const result = await update({ sid: 7, newName: 'Weite' });
    expect(result.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    expect(named(main, 'Weite')).toBeDefined();
    expect(main.find(e => e.eventType === 'block')!.actions[2].parameters).toEqual(['Weite']);
  });

  it('lists an argument it cannot read', async () => {
    const other = otherEvents();
    other.push(block([], [callF('`T=${Score}`')]));
    await writeSheet('Other', other);
    const before = await files();
    const refused = await update({ sid: 1, newName: 'Points' });
    expect(refused.action).toBe('rename_blocked');
    expect(refused.usesNotUpdated!.map(u => `${u.sheet}|${u.reason}|${u.value}`)).toEqual(['Other|template-text|`T=${Score}`']);
    expect(await files()).toEqual(before);
    const forced = await update({ sid: 1, newName: 'Points', force: true });
    expect(forced.success).toBe(true);
    expect(eventsOf(await readSheet('Other'))[1].actions[0].parameters).toEqual(['`T=${Score}`']);
  });

  it('refuses without force when an event sheet that could not be parsed names a global it renames; with force renames and warns', async () => {
    await register('Broken');
    await writeFile(sheetFile('Broken'), '{"name":"Broken","events":[{"x":"Score Count"} broken');
    await start();
    const before = await files();
    const refused = await update({ sid: 1, newName: 'Points' });
    expect(refused.action).toBe('rename_blocked');
    expect(refused.unscannedFiles!.map(u => `${u.file}|${u.textSearch}`)).toEqual(['eventSheets/Broken|possible-use']);
    expect(refused.message.endsWith('Nothing was changed.')).toBe(true);
    expect(await files()).toEqual(before);

    const local = await update({ sid: 2, newName: 'Tally' });
    expect(local.success).toBe(true);
    expect(local.unscannedFiles ?? []).not.toContainEqual(expect.objectContaining({ textSearch: 'possible-use' }));

    const forced = await update({ sid: 1, newName: 'Points', force: true });
    expect(forced.success).toBe(true);
    expect(forced.warnings.some((w: string) => w.includes('Renamed with force=true'))).toBe(true);
    expect((await files()).get('eventSheets/Broken.json')).toBe(before.get('eventSheets/Broken.json'));
  });

  it('a registered sheet without a file holds no uses', async () => {
    await register('Ghost');
    await start();
    const result = await update({ sid: 1, newName: 'Points' });
    expect(result.success).toBe(true);
    expect(result.sheetsWritten).toEqual(['eventSheets/Other.json', 'eventSheets/MainSheet.json']);
    expect(result.unscannedFiles).toBeUndefined();
  });

  it('refuses without force when the search for the uses stops at its limit, for a global and a local', async () => {
    const deep = nest(60, block([], [setVar('Score')]));
    await addSheet('Deep', [deep]);
    const before = await files();
    const global = await update({ sid: 1, newName: 'Points' });
    expect(global.action).toBe('rename_blocked');
    expect(global.message).toContain('nesting-depth limit');
    expect(global.message.endsWith('Nothing was changed.')).toBe(true);
    expect(await files()).toEqual(before);

    const main = mainEvents();
    pushIntoGroup(main, 'A', nest(60, block([], [setVar('Count')])));
    await writeSheet('MainSheet', main);
    const local = await update({ sid: 2, newName: 'Tally' });
    expect(local.action).toBe('rename_blocked');
    expect(local.message).toContain('nesting-depth limit');
    expect(local.message.endsWith('Nothing was changed.')).toBe(true);

    const forcedLocal = await update({ sid: 2, newName: 'Tally', force: true });
    expect(forcedLocal.success).toBe(true);
    expect(forcedLocal.warnings.some((w: string) => w.includes('NOT updated'))).toBe(true);
    const forcedGlobal = await update({ sid: 1, newName: 'Points', force: true });
    expect(forcedGlobal.success).toBe(true);
    expect(forcedGlobal.warnings.some((w: string) => w.includes('NOT updated'))).toBe(true);
  });
});

// ─── Failed writes ───

/** The writer's read-back of `fileName` fails once with an ordinary error; `before` runs first. */
function failReadBackOf(fileName: string, before: () => Promise<void> = async () => {}): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith(fileName)) {
      failed = true;
      await before();
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  };
}

describe('update_event_variable rolls a failed rename back', () => {
  it('puts the other sheet back when the declaring sheet\'s write fails', async () => {
    const before = await files();
    failReadBackOf('MainSheet.json');
    const result = await update({ sid: 1, newName: 'Points' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('The call was rolled back:');
    expect(result.text).toContain('eventSheets/Other.json');
    expect(await files()).toEqual(before);
  });

  it('puts the first other sheet back when the second one\'s write fails', async () => {
    await addSheet('Other2', [block([], [callF('Score')])]);
    const before = await files();
    failReadBackOf('Other2.json');
    const result = await update({ sid: 1, newName: 'Points' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('The call was rolled back:');
    expect(result.text).toContain('eventSheets/Other.json');
    expect(await files()).toEqual(before);
  });

  it('keeps a sheet the editor saved during the call and puts back what the call wrote before', async () => {
    const before = await files();
    const saved = JSON.stringify(sheetOf('MainSheet', [variable('Score', 1), variable('Extra', 12)]));
    const original = writer.writeEntityFile.bind(writer);
    vi.spyOn(writer, 'writeEntityFile').mockImplementation(async (category, name, data, subfolder) => {
      if (name === 'MainSheet') await editorSave(sheetFile('MainSheet'), saved);
      return original(category, name, data, subfolder);
    });
    const result = await update({ sid: 1, newName: 'Points' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('changed on disk');
    expect(await readFile(sheetFile('MainSheet'), 'utf-8')).toBe(saved);
    expect((await files()).get('eventSheets/Other.json')).toBe(before.get('eventSheets/Other.json'));
  });
});

// ─── Refusals change nothing ───

/** The same sheets on the mocks, to check the objects a refusal must not touch. */
function mockSetup(extra: (reader: MockReader) => void = () => {}) {
  const reader = new MockReader({
    eventSheets: new Map<string, Record<string, unknown>>([
      ['MainSheet', sheetOf('MainSheet', mainEvents())],
      ['Other', sheetOf('Other', otherEvents())],
    ]),
  });
  extra(reader);
  const mockServer = new MockServer();
  registerEventTools({ server: mockServer, reader, writer: new MockWriter(), idGen: new MockIdGenerator() } as never);
  return { reader, mockServer };
}

describe('every refusal says Nothing was changed. and leaves every sheet as it was', () => {
  it('on disk, combined with a type change', async () => {
    await register('Broken');
    await writeFile(sheetFile('Broken'), '{"name":"Broken","events":[{"x":"Score Count"} broken');
    const main = mainEvents();
    pushIntoGroup(main, 'A', nest(60, block([], [setVar('Count')])));
    await writeSheet('MainSheet', main);
    await addSheet('Deep', [nest(60, block([], [setVar('Score')]))]);
    const before = await files();
    for (const args of [
      { sid: 5, newName: 'Hearts', newType: 'string' },
      { sid: 1, newName: 'Points', newType: 'string' },
      { sid: 2, newName: 'Tally', newType: 'string' },
    ]) {
      const refused = await update(args);
      expect(refused.action).toBe('rename_blocked');
      expect(refused.message.endsWith('Nothing was changed.')).toBe(true);
      expect(await files()).toEqual(before);
    }
  });

  it('stopped before the write', async () => {
    const before = await files();
    const original = reader.listEventSheets.bind(reader);
    let calls = 0;
    vi.spyOn(reader, 'listEventSheets').mockImplementation(async () => {
      if (++calls === 1) return original();
      throw new Error('The project could not be listed');
    });
    const result = await update({ sid: 1, newName: 'Points', newType: 'string' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('The change was stopped before anything was written');
    expect(result.text.endsWith('Nothing was changed.')).toBe(true);
    expect(await files()).toEqual(before);
  });

  it('on the mocks, the stored sheets keep the old name and type', async () => {
    const deep = sheetOf('Deep', [nest(60, block([], [setVar('Score')]))]);
    const cases: Array<[string, (reader: MockReader) => void, Record<string, unknown>]> = [
      ['not updated', () => {}, { sid: 5, newName: 'Hearts', newType: 'string' }],
      ['unparsed sheet', r => r.registerUnreadableEntity('eventSheets', 'Broken', { code: 'E_INVALID_JSON', message: 'Unexpected token' }, '{"x":"Score"'),
        { sid: 1, newName: 'Points', newType: 'string' }],
      ['limit', r => storedSheets(r).set('Deep', deep), { sid: 1, newName: 'Points', newType: 'string' }],
    ];
    for (const [label, extra, args] of cases) {
      const { reader: mock, mockServer } = mockSetup(extra);
      const stored = storedSheets(mock);
      const snapshot = JSON.stringify([...stored]);
      const result = await mockServer.callTool('update_event_variable', { sheetName: 'MainSheet', ...args });
      const parsed: Result = JSON.parse(result.content[0].text);
      expect(parsed.action, label).toBe('rename_blocked');
      expect(parsed.message.endsWith('Nothing was changed.'), label).toBe(true);
      expect(JSON.stringify([...stored]), label).toBe(snapshot);
    }
  });
});

describe('a dry run answers as the rename would', () => {
  it('refuses with the same message and writes nothing when the rename would be refused', async () => {
    const before = await files();
    const real = await update({ sid: 5, newName: 'Hearts' });
    const dry = await update({ sid: 5, newName: 'Hearts', dryRun: true });
    expect(dry.success).toBe(false);
    expect(dry.action).toBe('rename_blocked');
    expect(dry.message).toBe(real.message);
    expect(dry.message.endsWith('Nothing was changed.')).toBe(true);
    expect(await files()).toEqual(before);

    const forced = await update({ sid: 5, newName: 'Hearts', dryRun: true, force: true });
    expect(forced.action).toBe('would_update');
    expect(forced.warnings.some(w => w.includes('They still name "Lives"'))).toBe(true);
    expect(await files()).toEqual(before);
  });
});

describe('update_event_variable reads each sheet once per call', () => {
  it('uses one read of every registered sheet for the name check, the uses and the writes', async () => {
    const original = reader.readEventSheet.bind(reader);
    const reads: string[] = [];
    vi.spyOn(reader, 'readEventSheet').mockImplementation(async (name: string) => {
      reads.push(name);
      return original(name);
    });
    const result = await update({ sid: 1, newName: 'Points' });
    expect(result.success).toBe(true);
    expect([...reads].sort()).toEqual(['MainSheet', 'Other']);
  });
});

// ─── Parameter types from the ACE catalogue ───

/** The sheet of the catalogue tests: global Score (SID 1) and one Sprite action per parameter type group. */
function typedEvents(): Json[] {
  const sprite = (id: string, parameters: Json): Json => ({ id, objectClass: 'Sprite', sid: sid(), parameters });
  return [
    variable('Score', 1),
    block([], [
      sprite('set-x', { x: 'Score * 2 + 1' }),
      sprite('set-animation', { animation: '"S=" & score', from: 'beginning' }),
      setVar('Other', 'Score + 1'),
      sprite('track-variable', { variable: 'score' }),
      sprite('flip-variable', { variable: 'Score' }),
      sprite('watch-variable', { variable: 'SCORE' }),
    ]),
    block([], [
      sprite('join-named-group', { group: 'Score' }),
      sprite('start-named-timeline', { timeline: 'Score' }),
      sprite('follow-object', { target: 'Score' }),
      sprite('set-animation', { animation: '"a"', from: 'Score' }),
    ]),
    block([], [
      { id: 'set-x', objectClass: 'Ghost', sid: sid(), parameters: { x: 'Score' } },
      { id: 'unlisted-action', objectClass: 'Sprite', sid: sid(), parameters: { x: 'Score' } },
    ]),
    variable('Other', 2),
  ];
}

/** Write the catalogue tests' sheet, start the server on it, and give the reader `provider` when one is given. */
async function startTyped(provider?: AceCatalogProvider): Promise<void> {
  await writeSheet('MainSheet', typedEvents());
  await start();
  if (provider) setAceCatalogProvider(reader, provider);
}

/** The parameters of the actions of the `index`th block of MainSheet on disk. */
const parametersAt = async (index: number): Promise<Record<string, unknown>[]> =>
  eventsOf(await readSheet('MainSheet')).filter(e => e.eventType === 'block')[index].actions.map(a => a.parameters);

describe('update_event_variable and the parameter types of the ACE catalogue', () => {
  it('rewrites the number, string and any parameters of ACEs the catalogue defines, leaving text inside strings', async () => {
    await startTyped();
    const forced = await update({ sid: 1, newName: 'Points', force: true });
    expect(forced.success).toBe(true);
    const first = await parametersAt(0);
    expect(first[0]).toEqual({ x: 'Points * 2 + 1' });
    expect(first[1]).toEqual({ animation: '"S=" & Points', from: 'beginning' });
    expect(first[2]).toEqual({ variable: 'Other', value: 'Points + 1' });
    expect(forced.uses!.filter(u => u.sheet === 'MainSheet' && u.kind === 'variable-expression').map(u => u.parameter)).toEqual(['x', 'animation', 'value']);
  });

  it('points the eventvar, eventvarbool and eventvarany parameters of ACEs the catalogue defines at the new name', async () => {
    await startTyped();
    const forced = await update({ sid: 1, newName: 'Points', force: true });
    expect(forced.success).toBe(true);
    const first = await parametersAt(0);
    expect(first.slice(3)).toEqual([{ variable: 'Points' }, { variable: 'Points' }, { variable: 'Points' }]);
    expect(forced.uses!.filter(u => u.sheet === 'MainSheet' && u.kind === 'event-variable').map(u => u.parameter)).toEqual(['variable', 'variable', 'variable']);
  });

  it('lists the combo, groupname, timeline and object parameters that name the variable and never writes them', async () => {
    await startTyped();
    const refused = await update({ sid: 1, newName: 'Points' });
    expect(refused.action).toBe('rename_blocked');
    const names = refused.usesNotUpdated!.filter(u => u.reason === 'name-parameter').map(u => String(u.parameter)).sort();
    expect(names).toEqual(['from', 'group', 'target', 'timeline']);
    const before = await parametersAt(1);
    const forced = await update({ sid: 1, newName: 'Points', force: true });
    expect(forced.success).toBe(true);
    expect(await parametersAt(1)).toEqual(before);
    expect(before[3]).toEqual({ animation: '"a"', from: 'Score' });
  });

  it('keeps a parameter of an ACE the catalogue does not define, or of an object the project does not declare, listed and unchanged', async () => {
    await startTyped();
    const refused = await update({ sid: 1, newName: 'Points' });
    const unknown = refused.usesNotUpdated!.filter(u => u.reason === 'parameter-type-unknown');
    expect(unknown.map(u => `${u.path}|${u.parameter}`)).toEqual(['block > action:0|x', 'block > action:1|x']);
    const before = await parametersAt(2);
    await update({ sid: 1, newName: 'Points', force: true });
    expect(await parametersAt(2)).toEqual(before);
  });

  it('obtains the catalogue before the first sheet read of a rename, and not at all for an update that renames nothing', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'c3-catalog-order-'));
    try {
      const provider = new AceCatalogProvider({ cacheDir: cache, sourceDir: join(__dirname, '..', 'fixtures', 'ace-source') });
      await startTyped(provider);
      const order: string[] = [];
      const catalogFor = provider.catalogFor.bind(provider);
      vi.spyOn(provider, 'catalogFor').mockImplementation(async release => {
        order.push('catalogue');
        return catalogFor(release);
      });
      const readSheet = reader.readEventSheet.bind(reader);
      vi.spyOn(reader, 'readEventSheet').mockImplementation(async name => {
        order.push('sheet');
        return readSheet(name);
      });
      expect((await update({ sid: 1, newType: 'string' })).success).toBe(true);
      expect(order).not.toContain('catalogue');
      order.length = 0;
      expect((await update({ sid: 1, newName: 'Points', force: true })).success).toBe(true);
      expect(order[0]).toBe('catalogue');
      expect(order).toContain('sheet');
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it('lists the parameters it cannot classify and writes none of them when the catalogue is not available', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'c3-no-catalog-'));
    const cache = await mkdtemp(join(tmpdir(), 'c3-no-catalog-cache-'));
    try {
      await startTyped(new AceCatalogProvider({ cacheDir: cache, sourceDir: empty }));
      const refused = await update({ sid: 1, newName: 'Points' });
      expect(refused.action).toBe('rename_blocked');
      expect(refused.usesNotUpdated!.every(u => u.reason === 'parameter-type-unknown')).toBe(true);
      expect(refused.usesNotUpdated!.map(u => String(u.parameter)).sort()).toEqual(
        ['animation', 'from', 'group', 'target', 'timeline', 'value', 'variable', 'variable', 'variable', 'x', 'x', 'x'].sort(),
      );
      const before = await parametersAt(0);
      const forced = await update({ sid: 1, newName: 'Points', force: true });
      expect(forced.success).toBe(true);
      expect(await parametersAt(0)).toEqual(before);
      expect(forced.uses!.filter(u => u.sheet === 'MainSheet')).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  });
});

// ─── Unchanged behavior and the rest ───

describe('update_event_variable keeps what it did', () => {
  it('keeps the existing name checks and their messages', async () => {
    const result = await update({ sid: 1, newName: 'Unused' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('A variable named "Unused" already exists');
  });

  it('an update without a rename writes only the declaring sheet', async () => {
    const result = await update({ sid: 1, newType: 'string' });
    expect(result.success).toBe(true);
    expect(result.sheetsWritten).toEqual(['eventSheets/MainSheet.json']);
    expect(result.uses).toBeUndefined();
  });
});

describe('update_event_variable and a sheet it cannot read', () => {
  async function addBigSheet(): Promise<void> {
    await register('Big');
    const events = [variable('Points', 40), { eventType: 'comment', text: 'x'.repeat(10.5 * 1024 * 1024), sid: 41 }];
    await writeFile(sheetFile('Big'), JSON.stringify({ name: 'Big', events, sid: 42 }));
    await start();
  }

  it('refuses without force when an event sheet the reader refuses may declare the new name, for a global and a local', async () => {
    await addBigSheet();
    const before = await files();
    const global = await update({ sid: 1, newName: 'Points' });
    expect(global.action).toBe('rename_blocked');
    expect(global.unscannedFiles!.map(u => `${u.file}|${u.textSearch}`)).toEqual(['eventSheets/Big|possible-use']);
    expect(global.message).toContain('declare a variable named "Points"');
    expect(global.message.endsWith('Nothing was changed.')).toBe(true);
    expect(await files()).toEqual(before);
    const local = await update({ sid: 2, newName: 'Points' });
    expect(local.action).toBe('rename_blocked');
    expect(local.message).toContain('declare a variable named "Points"');
    expect(await files()).toEqual(before);
    const other = await update({ sid: 1, newName: 'Hearts' });
    expect(other.success).toBe(true);
  });
});

describe('update_event_variable and names the expression reader would take for numbers', () => {
  it('does not rewrite call arguments to a new name that starts with a digit', async () => {
    const refused = await update({ sid: 1, newName: '2x' });
    expect(refused.action).toBe('rename_blocked');
    expect(refused.usesNotUpdated!.map(u => `${u.sheet}|${u.value}|${u.reason}`).sort()).toEqual([
      'MainSheet|Score * 2|number-like-new-name',
      'Other|Score|number-like-new-name',
    ]);
    const forced = await update({ sid: 1, newName: '2x', force: true });
    expect(forced.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    const first = main.find(e => e.eventType === 'block')!;
    expect(named(main, '2x')).toBeDefined();
    expect(first.actions[0].parameters.variable).toBe('2x');
    expect(first.actions[1].parameters).toEqual(['Score * 2']);
    expect(eventsOf(await readSheet('Other'))[0].actions[0].parameters).toEqual(['Score']);
    expect(forced.warnings.some((w: string) => w.includes('start') && w.includes('digit'))).toBe(true);
  });

  it('never writes a combo choice spelled like the variable it renames', async () => {
    const refused = await update({ sid: 8, newName: 'on1' });
    expect(refused.action).toBe('rename_blocked');
    expect(refused.usesNotUpdated!.map(u => `${u.parameter}|${u.reason}`)).toEqual(['state|parameter-type-unknown']);
    const forced = await update({ sid: 8, newName: 'on1', force: true });
    expect(forced.success).toBe(true);
    const main = eventsOf(await readSheet('MainSheet'));
    expect(named(main, 'on1')).toBeDefined();
    const active = main.find(e => e.eventType === 'block')!.actions.find(a => a.id === 'set-group-active');
    expect(active?.parameters).toEqual({ 'group-name': 'Bonus', state: 'activated' });
  });
});

describe('update_event_variable and the name check on the sheets it reads', () => {
  it('cannot move a use onto another variable: a name another variable in scope has is refused', async () => {
    // Shadow holds a local Score; the global Score's rename to a name a local of another
    // scope holds is refused by the name check on the same read, so no use changes owner
    const before = await files();
    const toLocal = await update({ sid: 1, newName: 'Count' });
    expect(toLocal.isError).toBe(true);
    expect(toLocal.text).toContain('already exists');
    const toParameter = await update({ sid: 1, newName: 'n' });
    expect(toParameter.isError).toBe(true);
    expect(await files()).toEqual(before);
  });
});
