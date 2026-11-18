/**
 * checkEventChange and the event tools' use of it, on temp copies of the
 * minimal fixture with the real reader and the hand-written catalogue folder.
 * No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { AceCatalogProvider, setAceCatalogProvider } from '../../src/construct3/ace-catalog-provider.js';
import { checkEventChange } from '../../src/construct3/event-change-check.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { fetchStub, fixtureRoutes, guardNetwork } from './ace-fetch-stub.js';

const MINIMAL = join(__dirname, '..', 'fixtures', 'minimal-project');
const SOURCE = join(__dirname, '..', 'fixtures', 'ace-source');
const FIXED_FAILURE = 'The ACE and expression checks could not run for this change; run validate_project to check the sheet.';

type Json = Record<string, unknown>;

const dirs: string[] = [];
let restoreNetwork: () => void;

beforeEach(() => {
  restoreNetwork = guardNetwork();
});

afterEach(async () => {
  restoreNetwork();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A new temp folder, removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-event-change-'));
  dirs.push(dir);
  return dir;
}

interface Open {
  dir: string;
  reader: Construct3ProjectReader;
  provider: AceCatalogProvider;
}

/** A temp copy of the minimal project saved with `release`, a real reader, and a provider reading the catalogue folder `sourceDir`. */
async function open(release = 49502, sourceDir = SOURCE): Promise<Open> {
  const dir = await tempDir();
  await cp(MINIMAL, dir, { recursive: true });
  const file = join(dir, 'project.c3proj');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/"savedWithRelease":\s*\d+/, `"savedWithRelease": ${release}`));
  const reader = new Construct3ProjectReader(file);
  await reader.loadProject();
  const provider = new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir });
  setAceCatalogProvider(reader, provider);
  return { dir, reader, provider };
}

let sidCounter = 700000000000000;
const nextSid = (): number => ++sidCounter;

const ace = (id: string, objectClass: string, parameters?: Json, extra: Json = {}): Json =>
  ({ id, objectClass, sid: nextSid(), ...(parameters ? { parameters } : {}), ...extra });
const block = (conditions: Json[], actions: Json[], children?: Json[]): Json =>
  ({ eventType: 'block', conditions, actions, sid: nextSid(), ...(children ? { children } : {}) });
const setPosition = (): Json => ace('set-position', 'Sprite', { x: '1', y: '2' });
const flyAway = (): Json => ace('fly-away', 'Sprite');
const setX = (x: string): Json => ace('set-x', 'Sprite', { x });
const onStart = (): Json => ace('on-start-of-layout', 'System');

/** The snapshot an event tool takes before a change, and the clone it then edits. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('checkEventChange', () => {
  it('says why and checks nothing else when there is no catalogue, and asks the provider only for a changed ACE', async () => {
    const empty = await tempDir();
    const { reader, provider } = await open(49502, empty);
    const lookup = await provider.catalogFor(49502);
    expect(lookup.ok).toBe(false);
    const spy = vi.spyOn(provider, 'catalogFor');
    const before: Json[] = [];
    const after = [block([onStart()], [flyAway()])];

    const warnings = await checkEventChange(reader, 'MainSheet', before, after);
    expect(warnings).toEqual([lookup.ok ? '' : lookup.message]);
    expect(warnings[0]).not.toContain('defines no');
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const same = await checkEventChange(reader, 'MainSheet', clone(after), after);
    expect(same).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks a new ACE, an edited parameter and nothing that did not change', async () => {
    const { reader } = await open();
    const old = flyAway();
    const stays = setPosition();
    const edited = setPosition();
    const before = [block([onStart()], [old, stays, edited])];

    const unchanged = clone(before);
    expect(await checkEventChange(reader, 'MainSheet', before, unchanged)).toEqual([]);

    const grown = clone(before);
    (grown[0].actions as Json[]).push(flyAway());
    const added = (grown[0].actions as Json[])[3];
    const newWarnings = await checkEventChange(reader, 'MainSheet', before, grown);
    expect(newWarnings).toHaveLength(1);
    expect(newWarnings[0]).toContain('"fly-away"');
    expect(newWarnings[0]).toContain(`SID ${added.sid as number}`);

    const changed = clone(before);
    ((changed[0].actions as Json[])[2].parameters as Json) = { x: '1' };
    const editWarnings = await checkEventChange(reader, 'MainSheet', before, changed);
    expect(editWarnings).toHaveLength(1);
    expect(editWarnings[0]).toContain(`SID ${edited.sid as number}`);
    expect(editWarnings[0]).toContain('"y"');
  });

  it('does not check an ACE that has no SID, whatever else the event holds', async () => {
    const { reader } = await open();
    const unnumbered = { id: 'fly-away', objectClass: 'Sprite' };
    const after = [block([onStart()], [unnumbered, setPosition()])];
    expect(await checkEventChange(reader, 'MainSheet', [], after)).toEqual([]);
  });

  it('gives one fixed warning, without the error text or a path, when the check itself fails', async () => {
    const { dir, reader } = await open();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(reader, 'getProject').mockImplementation(() => {
      throw new Error(`cannot read ${dir}`);
    });
    const warnings = await checkEventChange(reader, 'MainSheet', [], [block([onStart()], [flyAway()])]);
    expect(warnings).toEqual([FIXED_FAILURE]);
    expect(warnings[0]).not.toContain(dir);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][1])).toContain(dir);
  });

  it('counts a variable added in the same call, which the cached sheet does not hold', async () => {
    const { reader } = await open();
    const declare = { eventType: 'variable', name: 'Score', type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: nextSid() };
    const user = block([], [setX('Score')]);
    const local = [block([onStart()], [setPosition()], [declare, user])];
    expect(await checkEventChange(reader, 'MainSheet', [], local)).toEqual([]);

    // A global is known to the checks through the sheets, where the cached copy of this one does not hold it yet
    const global = [{ ...declare, sid: nextSid() }, block([onStart()], [setX('Score')])];
    expect(await checkEventChange(reader, 'MainSheet', [], global)).toEqual([]);

    const unknown = [block([onStart()], [setPosition()], [block([], [setX('Missing')])])];
    const warnings = await checkEventChange(reader, 'MainSheet', [], unknown);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Missing"');
  });

  it('adds the sentence naming an unreadable sheet when names could not be fully checked', async () => {
    const { dir } = await open();
    await writeFile(join(dir, 'eventSheets', 'Broken.json'), '{ broken');
    const file = join(dir, 'project.c3proj');
    const project = JSON.parse(await readFile(file, 'utf8')) as { eventSheets: { items: string[] } };
    project.eventSheets.items.push('Broken');
    await writeFile(file, JSON.stringify(project, null, '\t'));
    const reloaded = new Construct3ProjectReader(file);
    await reloaded.loadProject();
    setAceCatalogProvider(reloaded, new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir: SOURCE }));

    const after = [block([onStart()], [setX('Sprite.X')])];
    const warnings = await checkEventChange(reloaded, 'MainSheet', [], after);
    expect(warnings.at(-1)).toBe('Names in the expressions written were not checked, because these files could not be read: eventSheets/Broken.');
  });

  it('reads no event sheet when the changed ACEs hold no expression-typed parameter', async () => {
    const { reader } = await open();
    const spy = vi.spyOn(reader, 'readAllEventSheets');
    const after = [block([onStart()], [])];
    expect(await checkEventChange(reader, 'MainSheet', [], after)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    await checkEventChange(reader, 'MainSheet', [], [block([onStart()], [setX('Sprite.X')])]);
    expect(spy).toHaveBeenCalled();
  });

  it('names the substitute release in one warning for a clean write, and only when one was used', async () => {
    const newer = await open(50602);
    const after = [block([onStart()], [setPosition()])];
    const warnings = await checkEventChange(newer.reader, 'MainSheet', [], after);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('r495.2');
    expect(warnings[0]).toContain('r506.2');

    const same = await open(49502);
    expect(await checkEventChange(same.reader, 'MainSheet', [], after)).toEqual([]);

    expect(await checkEventChange(newer.reader, 'MainSheet', clone(after), after)).toEqual([]);
  });

  it('hedges a finding that rests on the catalogue when the project is newer', async () => {
    const { reader } = await open(50602);
    const after = [block([onStart()], [setX('newfunc(1)')])];
    const warnings = await checkEventChange(reader, 'MainSheet', [], after);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('r506.2');
    expect(warnings[1]).toContain('newfunc');
    expect(warnings[1].endsWith('may define this.')).toBe(true);
  });
});

describe('event tools with the ACE and expression checks', () => {
  interface Session { dir: string; server: MockServer }

  async function session(): Promise<Session> {
    const { dir, reader } = await open();
    const server = new MockServer();
    registerEventTools({ server: server as never, reader, writer: new Construct3ProjectWriter(reader, new IdGenerator()), idGen: new IdGenerator() });
    return { dir, server };
  }

  interface Outcome { isError: boolean; text: string; data: { success?: boolean; warnings?: string[] } }

  async function call(server: MockServer, tool: string, args: Json): Promise<Outcome> {
    const result = await server.callTool(tool, args) as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content[0].text;
    return { isError: result.isError === true, text, data: result.isError ? {} : JSON.parse(text) as Outcome['data'] };
  }

  const sheetText = (dir: string): Promise<string> => readFile(join(dir, 'eventSheets', 'MainSheet.json'), 'utf8');

  it('add_event_block writes the block and warns about a wrong ACE, in its sub-events too', async () => {
    const { dir, server } = await session();
    const { data } = await call(server, 'add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'fly-away', objectClass: 'Sprite' }],
      children: [{ conditions: [], actions: [{ id: 'fly-again', objectClass: 'Sprite' }] }],
    });
    expect(data.success).toBe(true);
    expect(data.warnings!.filter(w => w.includes('"fly-away"'))).toHaveLength(1);
    expect(data.warnings!.filter(w => w.includes('"fly-again"'))).toHaveLength(1);
    const text = await sheetText(dir);
    expect(text).toContain('fly-away');
    expect(text).toContain('fly-again');
  });

  it('update_event_block warns for an added action and not for one it left alone', async () => {
    const { dir, server } = await session();
    const untouched = await call(server, 'update_event_block', { sheetName: 'MainSheet', sid: 400000000000003, disabled: true });
    expect(untouched.data.success).toBe(true);
    expect(untouched.data.warnings ?? []).toEqual([]);

    const added = await call(server, 'update_event_block', {
      sheetName: 'MainSheet', sid: 400000000000003, addActions: [{ id: 'fly-away', objectClass: 'Sprite' }],
    });
    expect(added.data.success).toBe(true);
    expect(added.data.warnings).toHaveLength(1);
    expect(added.data.warnings![0]).toContain('"fly-away"');
    expect(await sheetText(dir)).toContain('fly-away');
  });

  it('update_event_block_action warns for a parameter the action does not define', async () => {
    const { dir, server } = await session();
    const { data } = await call(server, 'update_event_block_action', {
      sheetName: 'MainSheet', blockSid: 400000000000003, actionIndex: 0, parameters: { x: '1', y: '2', z: '3' },
    });
    expect(data.success).toBe(true);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings![0]).toContain('"z"');
    expect(await sheetText(dir)).toContain('"z"');
  });

  it('still refuses what the load-time check refuses, without the new warnings and without writing', async () => {
    const { dir, server } = await session();
    const before = await sheetText(dir);
    const result = await call(server, 'add_event_block', {
      sheetName: 'MainSheet',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System' }, { id: 'on-start-of-layout', objectClass: 'System' }],
      actions: [{ id: 'fly-away', objectClass: 'Sprite' }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('fly-away');
    expect(await sheetText(dir)).toBe(before);
  });

  describe('when the first fetch of a release is slow and the sheet is saved meanwhile', () => {
    const MARK = 'saved in the editor during the fetch';

    /** A session whose provider fetches from the fixtures, and whose first request changes the sheet on disk, as an editor save would. */
    async function slowFetchSession(): Promise<Session & { fetched: () => number }> {
      const { dir, reader } = await open();
      const sheetFile = join(dir, 'eventSheets', 'MainSheet.json');
      const routes = fixtureRoutes();
      let changed = false;
      for (const url of Object.keys(routes)) {
        const answer = routes[url];
        routes[url] = () => {
          if (!changed) {
            changed = true;
            const sheet = JSON.parse(readFileSync(sheetFile, 'utf8')) as { events: Json[] };
            sheet.events.push({ eventType: 'comment', text: MARK, sid: nextSid() });
            writeFileSync(sheetFile, JSON.stringify(sheet, null, '\t'));
          }
          return answer();
        };
      }
      const stub = fetchStub(routes);
      setAceCatalogProvider(reader, new AceCatalogProvider({ cacheDir: await tempDir(), fetch: stub }));
      const server = new MockServer();
      registerEventTools({ server: server as never, reader, writer: new Construct3ProjectWriter(reader, new IdGenerator()), idGen: new IdGenerator() });
      return { dir, server, fetched: () => stub.calls.length };
    }

    const cases: Array<[string, Json]> = [
      ['add_event_block', { sheetName: 'MainSheet', conditions: [], actions: [{ id: 'fly-away', objectClass: 'Sprite' }] }],
      ['update_event_block', { sheetName: 'MainSheet', sid: 400000000000003, addActions: [{ id: 'fly-away', objectClass: 'Sprite' }] }],
      ['update_event_block_action', { sheetName: 'MainSheet', blockSid: 400000000000003, actionIndex: 0, parameters: { x: '1', y: '2', z: '3' } }],
    ];

    for (const [tool, args] of cases) {
      it(`${tool} writes as it would without the check, keeps the saved change and still warns`, async () => {
        const { dir, server, fetched } = await slowFetchSession();
        const result = await call(server, tool, args);
        expect(result.text).not.toContain('changed on disk');
        expect(result.data.success).toBe(true);
        expect(result.data.warnings!.length).toBeGreaterThan(0);
        expect(fetched()).toBeGreaterThan(0);
        expect(await sheetText(dir)).toContain(MARK);
      });
    }
  });
});
