/**
 * update_event_group changes a group event in place: title, description,
 * "Active on start", disabled and its colours, keeping its sub-events, SID and
 * key order. A rename is refused, changing nothing, while another group in the
 * same list has the title or (without force) while a "group-name" parameter or
 * an event sheet that cannot be parsed may name the old title. A failed write
 * is rolled back. Synthetic data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { withProjectSync } from '../../src/tools/project-sync.js';
import { Construct3ProjectReader, type ReadFailure } from '../../src/construct3/project-reader.js';
import { searchText, type RawTextTerm } from '../../src/construct3/raw-text-search.js';
import { MAX_SEARCH_NODES } from '../../src/tools/event-helpers.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

type Ev = Record<string, unknown>;
type Result = { content: Array<{ text: string }>; isError?: boolean };

const group = (sid: number, title: string, children: Ev[] = []): Ev => ({ eventType: 'group', disabled: false, title, description: '', isActiveOnStart: true, children, sid });
const block = (sid: number, extra: Ev = {}): Ev => ({ eventType: 'block', conditions: [], actions: [], sid, ...extra });
const groupAction = (sid: number, name: string, id = 'set-group-active'): Ev => ({ id, objectClass: 'System', sid, parameters: { 'group-name': name, state: 1 } });
const comment = (): Ev => ({ eventType: 'comment', text: 'c' });

/** Group "Movement" (100, holding group "Jump" 110), group "Combat" (200) and block 300 that activates "Combat". */
function sheetEvents(): Ev[] {
  return [
    group(100, 'Movement', [group(110, 'Jump')]),
    group(200, 'Combat'),
    block(300, { actions: [groupAction(301, '"Combat"')] }),
  ];
}

/** A reader that also registers event sheets it cannot parse (name to text), as the real reader reports them: absent from the bulk read, searchable as text. */
class UnparsableSheetsReader extends MockReader {
  constructor(data: ConstructorParameters<typeof MockReader>[0], private readonly unparsable: Record<string, string>) {
    super(data);
  }
  override async listEventSheets(): Promise<string[]> {
    return [...await super.listEventSheets(), ...Object.keys(this.unparsable)];
  }
  override getReadFailures(category: string): Map<string, ReadFailure> {
    if (category !== 'eventSheets') return super.getReadFailures(category);
    return new Map(Object.keys(this.unparsable).map(name => [name, { code: 'E_INVALID_JSON', message: 'not valid JSON' } as ReadFailure]));
  }
  override async searchEntityTextRaw(category: Parameters<MockReader['searchEntityTextRaw']>[0], name: string, terms: readonly RawTextTerm[]): Promise<Set<string>> {
    const text = this.unparsable[name];
    return category === 'eventSheets' && text !== undefined ? searchText(text, terms) : super.searchEntityTextRaw(category, name, terms);
  }
}

/** A writer whose write fails with an ordinary error. */
class FailingWriter extends MockWriter {
  override async writeEntityFile(): Promise<string> {
    throw new Error('disk full');
  }
}

function setup(other: Ev[] = [group(400, 'Jump')], unparsable: Record<string, string> = {}, writer: MockWriter = new MockWriter()) {
  const server = new MockServer();
  const reader = new UnparsableSheetsReader({
    eventSheets: new Map([['Sheet1', { name: 'Sheet1', sid: 1, events: sheetEvents() }], ['Other', { name: 'Other', sid: 2, events: other }]]),
  }, unparsable);
  registerEventTools({ server, reader, writer, idGen: new MockIdGenerator() } as unknown as MutationToolDeps);
  return { server, reader, writer };
}
const parse = (r: Result) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const errorText = (r: Result) => (r.isError ? r.content[0].text : '');
const written = (writer: MockWriter): Ev[] => (writer.callsFor('writeEntityFile').at(-1)!.args[2] as { events: Ev[] }).events;
const sheetOf = async (reader: MockReader) => (await reader.readEventSheet('Sheet1')).events as unknown as Ev[];

/** Sheet "Other" of a use of the group "Movement" after 100,000 comments, which a search of the sheets does not reach. */
function afterManyComments(): Ev[] {
  return [...Array.from({ length: MAX_SEARCH_NODES }, comment), block(900, { actions: [groupAction(901, '"Movement"')] })];
}

/** Sheet "Other" of a use of the group "Movement" 52 lists deep, below where a search of the sheets looks. */
function deepUse(): Ev[] {
  let inner: Ev = block(900, { actions: [groupAction(901, '"Movement"')] });
  for (let depth = 0; depth < 52; depth++) inner = block(910 + depth, { children: [inner] });
  return [inner];
}

describe('update_event_group', () => {
  it('updates description, isActiveOnStart and disabled on the keys the group has, without moving them', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, description: 'Walking', isActiveOnStart: false, disabled: true }));
    expect(data).toMatchObject({ success: true, action: 'updated', updatedSid: 100, eventPath: 'events[0]', title: 'Movement' });
    const updated = written(writer)[0];
    expect(Object.keys(updated)).toEqual(['eventType', 'disabled', 'title', 'description', 'isActiveOnStart', 'children', 'sid']);
    expect(updated).toMatchObject({ disabled: true, title: 'Movement', description: 'Walking', isActiveOnStart: false, sid: 100 });
    expect((updated.children as Ev[]).map(e => e.sid)).toEqual([110]);
  });

  it('renames a group nothing names', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' }));
    expect(data).toMatchObject({ success: true, action: 'updated', title: 'Walk' });
    expect(data.warnings).toBeUndefined();
    expect(data.references).toBeUndefined();
    expect(written(writer)[0].title).toBe('Walk');
  });

  it('reports an update to the values the group has as unchanged and writes nothing', async () => {
    const { server, writer } = setup();
    const data = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Movement', description: '', isActiveOnStart: true, disabled: false }));
    expect(data).toMatchObject({ success: true, action: 'unchanged', updatedSid: 100, eventPath: 'events[0]', title: 'Movement' });
    expect(data).not.toHaveProperty('editorNote');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses an empty title', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: '  ' });
    expect(errorText(result)).toBe('title is empty. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a title another group in the same list has, also once outer whitespace is ignored', async () => {
    for (const title of ['Combat', 'Combat ']) {
      const { server, writer } = setup();
      const result = await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title });
      expect(errorText(result), title).toBe('Group "Combat" (SID 200) has that title in the same list, so a group path could not tell them apart. Nothing was changed.');
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('allows a title a group in another list has, with a warning naming the other group', async () => {
    const first = setup();
    const data = parse(await first.server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 110, title: 'Combat' }));
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual(['Another group of the project has the title "Combat" (sheet "Sheet1", SID 200); "set-group-active" and "is-group-active" name a group by its title.']);
    // Another sheet's group, letter case ignored
    const second = setup([group(400, 'Jump'), group(410, 'Hud')]);
    const other = parse(await second.server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'hud' }));
    expect(other.warnings).toEqual(['Another group of the project has the title "Hud" (sheet "Other", SID 410); "set-group-active" and "is-group-active" name a group by its title.']);
  });

  it('refuses a rename while a set-group-active or is-group-active parameter names the group, lists them, and renames with force', async () => {
    const { server, writer } = setup();
    const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 200, title: 'Fight' }));
    expect(blocked).toMatchObject({ success: false, action: 'rename_blocked' });
    expect(blocked.references).toEqual([{ sheet: 'Sheet1', path: 'events[2] > action:0', sid: 300, value: '"Combat"', definite: true }]);
    expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);

    const forced = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 200, title: 'Fight', force: true }));
    expect(forced).toMatchObject({ success: true, action: 'updated', title: 'Fight' });
    expect(forced.warnings).toEqual(['Renamed with force=true: 1 "group-name" parameter(s) still name "Combat" and were left as they are; set them to "Fight".']);
    expect(forced.references).toEqual(blocked.references);
    const events = written(writer);
    expect(events[1].title).toBe('Fight');
    expect(((events[2].actions as Ev[])[0].parameters as Ev)['group-name']).toBe('"Combat"');
  });

  it('lists the group-name parameter of a condition too', async () => {
    const { server, reader } = setup();
    (await sheetOf(reader))[2].conditions = [groupAction(302, '"Combat"', 'is-group-active')];
    const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 200, title: 'Fight' }));
    expect(blocked.references).toEqual([
      { sheet: 'Sheet1', path: 'events[2] > condition:0', sid: 300, value: '"Combat"', definite: true },
      { sheet: 'Sheet1', path: 'events[2] > action:0', sid: 300, value: '"Combat"', definite: true },
    ]);
  });

  it('counts a group-name parameter that is not a plain quoted title as a possible use', async () => {
    for (const value of ['"Com" & "bat"', '"combat"']) {
      const { server, reader, writer } = setup();
      (await sheetOf(reader))[2].actions = [groupAction(301, value)];
      const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 200, title: 'Fight' }));
      expect(blocked.action, value).toBe('rename_blocked');
      expect(blocked.references, value).toEqual([{ sheet: 'Sheet1', path: 'events[2] > action:0', sid: 300, value, definite: false }]);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    }
  });

  it('refuses a rename while an event sheet it could not parse may name the old title, and renames with force', async () => {
    const { server, writer } = setup([group(400, 'Jump')], { Bad: '{"events":[{"title":"Movement"' });
    const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' }));
    expect(blocked.action).toBe('rename_blocked');
    expect(String(blocked.message)).toContain('There are possible uses in files that could not be parsed: eventSheets/Bad');
    expect(String(blocked.message)).toMatch(/Change them first, or use force=true to rename anyway\. Nothing was changed\.$/);
    expect(blocked.unscannedFiles).toMatchObject([{ file: 'eventSheets/Bad', textSearch: 'possible-use' }]);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk', force: true }));
    expect(forced.success).toBe(true);
    expect(String(forced.warnings)).toContain('Renamed with force=true: There are possible uses in files that could not be parsed: eventSheets/Bad');
    expect(forced.unscannedFiles).toMatchObject([{ file: 'eventSheets/Bad', textSearch: 'possible-use' }]);
  });

  /** A rename of "Movement" while the search stops at a limit is refused with `sentence`, and goes through with force. */
  async function expectRenameStoppedBy(other: Ev[], sentence: string): Promise<void> {
    const { server, writer } = setup(other);
    const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' }));
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.references).toEqual([]);
    expect(String(blocked.message)).toBe(`${sentence} Change them first, or use force=true to rename anyway. Nothing was changed.`);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    const forced = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk', force: true }));
    expect(forced.success).toBe(true);
    expect(forced.warnings).toEqual([`Renamed with force=true: ${sentence}`]);
    expect(written(writer)[0].title).toBe('Walk');
  }

  it('refuses a rename while the search for group-name parameters stopped at its event limit, and renames with force', async () => {
    await expectRenameStoppedBy(afterManyComments(),
      'The check for "group-name" parameters that name "Movement" stopped at its traversal limit (100,000 events across all event sheets), so uses further on are unknown.');
  });

  it('refuses a rename while the search for group-name parameters stopped at its depth limit, and renames with force', async () => {
    await expectRenameStoppedBy(deepUse(),
      'The check for "group-name" parameters that name "Movement" stopped at its nesting-depth limit (events nested more than 50 deep), so uses further on are unknown.');
  });

  it('lists ten uses and counts the rest', async () => {
    const uses = Array.from({ length: 12 }, (_, i) => block(900 + i, { actions: [groupAction(950 + i, '"Movement"')] }));
    const { server } = setup(uses);
    const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' }));
    expect(blocked.references).toHaveLength(12);
    const message = String(blocked.message);
    expect(message).toContain('12 "group-name" parameter(s) name the group "Movement" or may name it: ');
    expect(message).toContain('Other events[9] > action:0 (SID 909): "Movement"; and 2 more. They are not rewritten.');
    expect(message).not.toContain('events[10]');
  });

  it('does not count the group itself as a clash, or as another group with its title', async () => {
    for (const title of ['Movement ', 'movement']) {
      const { server, writer } = setup();
      const data = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title }));
      expect(data, title).toMatchObject({ success: true, action: 'updated', title });
      expect(data.warnings, title).toBeUndefined();
      expect(written(writer)[0].title).toBe(title);
    }
  });

  it('allows a title that an event of another type in the same list carries', async () => {
    const { server, reader } = setup();
    (await sheetOf(reader))[2].title = 'Walk';
    const data = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' }));
    expect(data).toMatchObject({ success: true, title: 'Walk' });
  });

  it('searches past a list entry that is not an event', async () => {
    const { server } = setup([null, 'text', group(400, 'Jump'), block(900, { actions: [groupAction(901, '"Movement"')] })] as unknown as Ev[]);
    const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' }));
    expect(blocked.action).toBe('rename_blocked');
    expect(blocked.references).toEqual([{ sheet: 'Other', path: 'events[3] > action:0', sid: 900, value: '"Movement"', definite: true }]);
  });

  it('writes and removes the group colours where the editor saves them', async () => {
    const { server, writer } = setup();
    await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, backgroundColor: [1, 0, 0, 1] });
    expect(Object.keys(written(writer)[0])).toEqual(['eventType', 'disabled', 'title', 'description', 'isActiveOnStart', 'children', 'sid', 'background-color']);
    await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, textColor: [0, 0, 1, 1] });
    const both = written(writer)[0];
    expect(Object.keys(both)).toEqual(['eventType', 'disabled', 'title', 'description', 'isActiveOnStart', 'children', 'sid', 'text-color', 'background-color']);
    expect(both).toMatchObject({ 'text-color': [0, 0, 1, 1], 'background-color': [1, 0, 0, 1] });
    await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, backgroundColor: null });
    expect(Object.keys(written(writer)[0])).toEqual(['eventType', 'disabled', 'title', 'description', 'isActiveOnStart', 'children', 'sid', 'text-color']);
  });

  it('refuses a SID that is not a group', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 300, description: 'x' });
    expect(errorText(result)).toBe('The event with SID 300 is a "block", not a group. Nothing was changed.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('every refusal ends with Nothing was changed. and leaves the sheet as it was', async () => {
    // Each also asks for changes that would be made if the call went through
    const calls: Array<Record<string, unknown>> = [
      { sid: 100 },
      { sid: 100, description: 'x', disabled: true, title: ' ' },
      { sid: 100, description: 'x', disabled: true, title: 'Combat' },
      { sid: 100, description: 'x', disabled: true, title: 'Combat ' },
      { sid: 300, description: 'x', disabled: true },
      { sid: 999, description: 'x', disabled: true },
      { sid: 100, eventPath: 'events[1]', description: 'x', disabled: true },
      { sid: 100, eventPath: 'bogus', description: 'x', disabled: true },
    ];
    for (const args of calls) {
      const { server, reader, writer } = setup();
      const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
      const result = await server.callTool('update_event_group', { sheetName: 'Sheet1', ...args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(errorText(result), JSON.stringify(args)).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    }
  });

  it('every rename refused for a use, a limit or an unparsed sheet says Nothing was changed. and leaves the sheet as it was', async () => {
    const calls: Array<{ args: Record<string, unknown>; other?: Ev[]; unparsable?: Record<string, string> }> = [
      { args: { sid: 200, title: 'Fight' } },
      { args: { sid: 100, title: 'Walk' }, other: afterManyComments() },
      { args: { sid: 100, title: 'Walk' }, other: deepUse() },
      { args: { sid: 100, title: 'Walk' }, unparsable: { Bad: '{"events":[{"title":"Movement"' } },
    ];
    for (const { args, other, unparsable } of calls) {
      const { server, reader, writer } = setup(other, unparsable);
      const before = JSON.stringify(await reader.readEventSheet('Sheet1'));
      const blocked = parse(await server.callTool('update_event_group', { sheetName: 'Sheet1', description: 'x', disabled: true, ...args }));
      expect(blocked.action, JSON.stringify(args)).toBe('rename_blocked');
      expect(String(blocked.message)).toMatch(/Nothing was changed\.$/);
      expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
      expect(JSON.stringify(await reader.readEventSheet('Sheet1'))).toBe(before);
    }
  });

  it('refuses an argument it does not take', async () => {
    const { server } = setup();
    await expect(server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, description: 'x', bogus: 1 })).rejects.toThrow();
  });

  it('puts the sheet in memory back when a change stops partway, and says nothing was changed', async () => {
    const { server, reader, writer } = setup();
    const movement = (await sheetOf(reader))[0];
    const description = movement.description;
    Object.defineProperty(movement, 'description', {
      enumerable: true,
      configurable: true,
      get: () => description,
      set: () => { throw new Error('the description cannot be set'); },
    });
    const result = await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk', description: 'x' });
    expect(errorText(result)).toBe('The update stopped before anything was written (the description cannot be set). Nothing was changed.');
    expect((await sheetOf(reader))[0].title).toBe('Movement');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('puts the sheet in memory back when its write fails', async () => {
    const { server, reader } = setup(undefined, undefined, new FailingWriter());
    const result = await server.callTool('update_event_group', { sheetName: 'Sheet1', sid: 100, title: 'Walk' });
    expect(errorText(result)).toContain('disk full');
    expect((await sheetOf(reader))[0].title).toBe('Movement');
  });
});

describe('update_event_group on disk', () => {
  const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
  const GROUP_SID = 410000000000001;
  let tmpDir: string;
  let server: MockServer;
  let writer: Construct3ProjectWriter;
  const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');

  /** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
  async function editorSave(path: string, text: string): Promise<void> {
    await writeFile(path, text);
    const { mtime } = await stat(path);
    const later = new Date(mtime.getTime() + 2000);
    await utimes(path, later, later);
  }

  /** The writer's read-back of the sheet fails once with an ordinary error; `before` runs first. */
  function failReadBack(before: () => Promise<void> = async () => {}): void {
    const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
    const verify = internals.verifyWrittenFile.bind(writer);
    let failed = false;
    internals.verifyWrittenFile = async (path, name, text) => {
      if (!failed && path.endsWith('MainSheet.json')) {
        failed = true;
        await before();
        throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
      }
      return verify(path, name, text);
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-update-event-group-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    sheet.events.push(group(GROUP_SID, 'Movement'));
    await writeFile(sheetPath(), JSON.stringify(sheet, null, '\t'));
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    writer = new Construct3ProjectWriter(reader, new IdGenerator());
    server = new MockServer();
    // Through withProjectSync, so each call runs in a tool call scope and the writer records its backups
    registerEventTools({ server: withProjectSync(server, reader), reader, writer, idGen: new IdGenerator() } as unknown as MutationToolDeps);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('renames the group on disk, keeping its key order', async () => {
    const data = parse(await server.callTool('update_event_group', { sheetName: 'MainSheet', sid: GROUP_SID, title: 'Walk', textColor: [0, 0, 1, 1] }));
    expect(data).toMatchObject({ success: true, action: 'updated', title: 'Walk', eventPath: 'events[1]' });
    const sheet = JSON.parse(await readFile(sheetPath(), 'utf8')) as { events: Ev[] };
    expect(sheet.events[1].title).toBe('Walk');
    expect(Object.keys(sheet.events[1])).toEqual(['eventType', 'disabled', 'title', 'description', 'isActiveOnStart', 'children', 'sid', 'text-color']);
  });

  it('puts the sheet back when its write fails its read-back', async () => {
    const before = await readFile(sheetPath(), 'utf8');
    failReadBack();
    const result = await server.callTool('update_event_group', { sheetName: 'MainSheet', sid: GROUP_SID, description: 'x' });
    expect(errorText(result)).toContain('The call was rolled back: eventSheets/MainSheet.json is as before the call.');
    expect(await readFile(sheetPath(), 'utf8')).toBe(before);
  });

  it('leaves a sheet the editor saved after the failed write as it is and names its .bak', async () => {
    const saved = `${await readFile(sheetPath(), 'utf8')}\n\n`;
    failReadBack(() => editorSave(sheetPath(), saved));
    const result = await server.callTool('update_event_group', { sheetName: 'MainSheet', sid: GROUP_SID, description: 'x' });
    expect(errorText(result)).toContain('left as it is: eventSheets/MainSheet.json');
    expect(errorText(result)).toContain('eventSheets/MainSheet.json.bak');
    expect(errorText(result)).not.toContain('Nothing was changed');
    // The left-as-it-is reason is the editor's save, not a missing tool call scope
    expect(errorText(result)).not.toContain('is no longer the copy this call made');
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
  });
});
