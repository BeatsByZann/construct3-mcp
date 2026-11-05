/**
 * The ACE checks of the tools that write conditions and actions, on temp
 * copies of the minimal fixture with the real reader and writer and the
 * hand-written catalogue folder: an unknown ACE id is a warning and the event
 * is still written, a new load-time error is refused with nothing written, and
 * the catalogue is obtained before the first read of a sheet, so that a slow
 * first load does not stand between the read and the write. No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { AceCatalogProvider, setAceCatalogProvider, type CatalogLookup } from '../../src/construct3/ace-catalog-provider.js';
import { checkEventChange } from '../../src/construct3/event-change-check.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { registerReplaceTools } from '../../src/tools/replace-tools.js';
import { guardNetwork } from '../construct3/ace-fetch-stub.js';

const MINIMAL = join(__dirname, '..', 'fixtures', 'minimal-project');
const SOURCE = join(__dirname, '..', 'fixtures', 'ace-source');
const SHEET = 'MainSheet';
/** The fixture's block: On start of layout, then Sprite Set position (action SID 400000000000002). */
const BLOCK_SID = 400000000000003;
const FIXED_FAILURE = 'The ACE and expression checks could not run for this change; run validate_project to check the sheet.';

type Json = Record<string, unknown>;

/** The warning an unknown action id gets (ace-unknown-ace), for "fly-away" on an object of the Sprite plugin. */
const unknownAction = (objectClass: string): RegExp =>
  new RegExp(`Action "fly-away" on "${objectClass}" \\(SID \\d+\\): Construct r495\\.2 defines no action "fly-away" for the Sprite plugin\\.$`);

const dirs: string[] = [];
let restoreNetwork: () => void;

beforeEach(() => {
  restoreNetwork = guardNetwork();
  resetProjectIndex();
});

afterEach(async () => {
  restoreNetwork();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A new temp folder, removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-ace-int-'));
  dirs.push(dir);
  return dir;
}

/** A catalogue provider on the fixture folder that logs when a lookup starts and ends, the end held back a short time. */
class RecordingProvider extends AceCatalogProvider {
  /** What happened, in order: shared with the sheet read spy. */
  readonly log: string[] = [];

  /** Logs catalog-start, waits 50 ms, logs catalog-done, then answers from the fixture folder. */
  override async catalogFor(savedWithRelease: unknown): Promise<CatalogLookup> {
    this.log.push('catalog-start');
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    this.log.push('catalog-done');
    return super.catalogFor(savedWithRelease);
  }
}

interface Session {
  dir: string;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
  server: MockServer;
}

/**
 * A temp copy of the minimal project saved with r495.2 (the release of the
 * catalogue folder, so no substitute line is added), with `main` appended to
 * MainSheet's events and `others` registered as further event sheets, a real
 * reader and writer, a catalogue provider on the fixture folder (or `provider`),
 * and the event, object and replace tools on a mock server.
 */
async function open(options: { main?: Json[]; others?: Record<string, Json[]>; provider?: AceCatalogProvider } = {}): Promise<Session> {
  const dir = await tempDir();
  await cp(MINIMAL, dir, { recursive: true });
  const projectFile = join(dir, 'project.c3proj');
  const project = JSON.parse((await readFile(projectFile, 'utf8')).replace(/"savedWithRelease":\s*\d+/, '"savedWithRelease": 49502')) as { eventSheets: { items: string[] } };
  const mainFile = join(dir, 'eventSheets', `${SHEET}.json`);
  const main = JSON.parse(await readFile(mainFile, 'utf8')) as { events: Json[] };
  main.events.push(...(options.main ?? []));
  await writeFile(mainFile, JSON.stringify(main, null, '\t'));
  let sid = 410000000000000;
  for (const [name, events] of Object.entries(options.others ?? {})) {
    project.eventSheets.items.push(name);
    await writeFile(join(dir, 'eventSheets', `${name}.json`), JSON.stringify({ name, events, sid: ++sid }, null, '\t'));
  }
  await writeFile(projectFile, JSON.stringify(project, null, '\t'));
  const reader = new Construct3ProjectReader(projectFile);
  await reader.loadProject();
  setAceCatalogProvider(reader, options.provider ?? new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir: SOURCE }));
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  const server = new MockServer();
  const deps = { server: server as never, reader, writer, idGen };
  registerEventTools(deps);
  registerObjectTools(deps);
  registerReplaceTools(deps);
  return { dir, reader, writer, server };
}

interface Outcome { isError: boolean; text: string; data: Json & { success?: boolean; warnings?: string[] } }

/** Call a tool; `data` is the parsed result, empty after an error. */
async function call(server: MockServer, tool: string, args: Json): Promise<Outcome> {
  const result = await server.callTool(tool, args);
  const text = result.content[0].text;
  return { isError: result.isError === true, text, data: result.isError ? {} : JSON.parse(text) as Outcome['data'] };
}

/** An event sheet file's text. */
const sheetText = (dir: string, name = SHEET): Promise<string> => readFile(join(dir, 'eventSheets', `${name}.json`), 'utf8');

/** The warnings of a result that come from the ACE check. */
const aceWarnings = (data: Outcome['data']): string[] =>
  (data.warnings ?? []).filter(w => w.includes('Construct r495.2') || / of the .* (plugin|behavior|object) /.test(w));

const flyAway = (sid?: number, parameters?: Json): Json =>
  ({ id: 'fly-away', objectClass: 'Sprite', ...(sid !== undefined ? { sid } : {}), ...(parameters ? { parameters } : {}) });
const onStart = (): Json => ({ id: 'on-start-of-layout', objectClass: 'System' });
/** Block 900: Every tick, then the unknown action "fly-away" on Sprite (SID 901) with a "speed" parameter. */
const unknownBlock = (): Json => ({
  eventType: 'block', conditions: [{ id: 'every-tick', objectClass: 'System', sid: 902 }], actions: [flyAway(901, { speed: 'Speed' })], sid: 900,
});

/** One tool call that writes an unknown ACE: its seed, an optional step before it, and the arguments. */
interface UnknownAceCase {
  tool: string;
  main?: Json[];
  others?: Record<string, Json[]>;
  prepare?: (server: MockServer) => Promise<void>;
  args: Json;
  /** The sheet that is written and the warning's prefix (sheet name) and object. */
  sheet: string;
  prefix: string;
  objectClass: string;
}

/** Hero, a second Sprite object type, for the replace tools. */
const createHero = async (server: MockServer): Promise<void> => {
  expect((await call(server, 'create_object', { name: 'Hero', pluginId: 'Sprite' })).data.success).toBe(true);
};

const UNKNOWN_ACE_CASES: UnknownAceCase[] = [
  { tool: 'add_event_block', args: { sheetName: SHEET, conditions: [], actions: [flyAway()] }, sheet: SHEET, prefix: '', objectClass: 'Sprite' },
  {
    tool: 'update_event_block',
    args: { sheetName: SHEET, sid: BLOCK_SID, insertActions: [{ index: 0, action: flyAway() }] },
    sheet: SHEET, prefix: '', objectClass: 'Sprite',
  },
  {
    tool: 'update_event_block_action', main: [unknownBlock()],
    args: { sheetName: SHEET, blockSid: 900, actionIndex: 0, parameters: { speed: '2' } },
    sheet: SHEET, prefix: '', objectClass: 'Sprite',
  },
  {
    tool: 'move_event_block_items', main: [unknownBlock()],
    args: { sheetName: SHEET, sourceBlockSid: 900, targetBlockSid: BLOCK_SID, itemType: 'actions', indices: [0], targetIndex: 1, copy: true },
    sheet: SHEET, prefix: '', objectClass: 'Sprite',
  },
  {
    tool: 'move_events_between_sheets', main: [unknownBlock()], others: { Other: [] },
    args: { sourceSheet: SHEET, targetSheet: 'Other', sids: [900] },
    sheet: 'Other', prefix: '', objectClass: 'Sprite',
  },
  {
    tool: 'replace_object_in_events', main: [unknownBlock()], prepare: createHero,
    args: { fromObject: 'Sprite', toObject: 'Hero' },
    sheet: SHEET, prefix: `${SHEET}: `, objectClass: 'Hero',
  },
  {
    tool: 'replace_in_expressions', main: [unknownBlock()],
    args: { find: 'Speed', replace: 'Pace' },
    sheet: SHEET, prefix: `${SHEET}: `, objectClass: 'Sprite',
  },
];

describe('an unknown ACE id is a warning, and the event is written', () => {
  for (const c of UNKNOWN_ACE_CASES) {
    it(`${c.tool} warns with the unknown-ACE text and writes the sheet`, async () => {
      const { dir, server } = await open({ main: c.main, others: c.others });
      await c.prepare?.(server);
      const result = await call(server, c.tool, c.args);
      expect(result.isError, result.text).toBe(false);
      expect(result.data.success).toBe(true);
      const found = aceWarnings(result.data).filter(w => unknownAction(c.objectClass).test(w));
      expect(found, JSON.stringify(result.data.warnings)).toHaveLength(1);
      expect(found[0].startsWith(`${c.prefix}Action "fly-away"`)).toBe(true);
      expect(await sheetText(dir, c.sheet)).toContain('fly-away');
    });
  }
});

/** One tool call that a new load-time error refuses. */
interface LoadErrorCase {
  tool: string;
  main?: Json[];
  others?: Record<string, Json[]>;
  prepare?: (server: MockServer) => Promise<void>;
  args: Json;
}

const LOAD_ERROR_CASES: LoadErrorCase[] = [
  { tool: 'add_event_block', args: { sheetName: SHEET, conditions: [onStart(), onStart()], actions: [] } },
  { tool: 'update_event_block', args: { sheetName: SHEET, sid: BLOCK_SID, insertConditions: [{ index: 1, condition: onStart() }] } },
  { tool: 'update_event_block_action', args: { sheetName: SHEET, blockSid: BLOCK_SID, actionIndex: 0, parameters: { x: '', y: '2' } } },
  {
    tool: 'move_event_block_items',
    args: { sheetName: SHEET, sourceBlockSid: BLOCK_SID, targetBlockSid: BLOCK_SID, itemType: 'conditions', indices: [0], targetIndex: 1, copy: true },
  },
  {
    tool: 'move_events_between_sheets',
    main: [{ eventType: 'block', conditions: [], actions: [{ id: 'set-position', objectClass: 'Sprite', sid: 921, parameters: { x: '', y: '1' } }], sid: 920 }],
    others: { Other: [] },
    args: { sourceSheet: SHEET, targetSheet: 'Other', sids: [920] },
  },
  { tool: 'replace_in_expressions', args: { find: '100', replace: '"' } },
];

describe('a new load-time error is refused, and nothing is written', () => {
  for (const c of LOAD_ERROR_CASES) {
    it(`${c.tool} refuses the write and leaves every sheet as it was`, async () => {
      const { dir, writer, server } = await open({ main: c.main, others: c.others });
      await c.prepare?.(server);
      const names = [SHEET, ...Object.keys(c.others ?? {})];
      const before = await Promise.all(names.map(name => sheetText(dir, name)));
      const writes = vi.spyOn(writer, 'writeEntityFile');
      const result = await call(server, c.tool, c.args);
      expect(result.isError, result.text).toBe(true);
      expect(result.text).toContain('Construct 3 load-time check failed; nothing was written.');
      expect(writes).not.toHaveBeenCalled();
      expect(await Promise.all(names.map(name => sheetText(dir, name)))).toEqual(before);
    });
  }
});

/** A block whose set-position action holds an expression with an unterminated string (sid 931), broken before any call. */
const brokenExpressionBlock = (x: string): Json => ({
  eventType: 'block', conditions: [], actions: [{ id: 'set-position', objectClass: 'System', sid: 931, parameters: { x, y: '1' } }], sid: 930,
});

describe('a rewrite of an expression that was already broken is not refused', () => {
  const cases: Array<{ tool: string; x: string; rewritten: string; prepare?: (server: MockServer) => Promise<void>; args: Json }> = [
    { tool: 'replace_object_in_events', x: 'Sprite.X & "', rewritten: 'Hero.X & "', prepare: createHero, args: { fromObject: 'Sprite', toObject: 'Hero' } },
    { tool: 'replace_in_expressions', x: 'Speed & "', rewritten: 'Pace & "', args: { find: 'Speed', replace: 'Pace' } },
  ];
  for (const c of cases) {
    it(`${c.tool} rewrites it and writes the sheet`, async () => {
      const { dir, writer, server } = await open({ main: [brokenExpressionBlock(c.x)] });
      await c.prepare?.(server);
      const before = await sheetText(dir);
      const writes = vi.spyOn(writer, 'writeEntityFile');
      const result = await call(server, c.tool, c.args);
      expect(result.isError, result.text).toBe(false);
      expect(result.data.success).toBe(true);
      expect(writes).toHaveBeenCalled();
      const after = await sheetText(dir);
      expect(after).not.toEqual(before);
      expect(after).toContain(JSON.stringify(c.rewritten).slice(1, -1));
    });
  }
});

describe('the catalogue is obtained before the first sheet read', () => {
  for (const c of UNKNOWN_ACE_CASES) {
    it(`${c.tool} has the catalogue before it reads a sheet`, async () => {
      const provider = new RecordingProvider({ cacheDir: await tempDir(), sourceDir: SOURCE });
      const { reader, server } = await open({ main: c.main, others: c.others, provider });
      await c.prepare?.(server);
      // The replace tools read every sheet at once first, and that read does not go through readEventSheet
      const read = reader.readEventSheet.bind(reader);
      vi.spyOn(reader, 'readEventSheet').mockImplementation(async (name: string) => {
        provider.log.push('read');
        return read(name);
      });
      const readAll = reader.readAllEventSheets.bind(reader);
      vi.spyOn(reader, 'readAllEventSheets').mockImplementation(async () => {
        provider.log.push('read');
        return readAll();
      });
      const result = await call(server, c.tool, c.args);
      expect(result.isError, result.text).toBe(false);
      const firstRead = provider.log.indexOf('read');
      expect(firstRead).toBeGreaterThanOrEqual(0);
      const firstDone = provider.log.indexOf('catalog-done');
      expect(firstDone, provider.log.join(', ')).toBeGreaterThanOrEqual(0);
      expect(firstDone, provider.log.join(', ')).toBeLessThan(firstRead);
    }, 5000);
  }
});

describe('update_event_block before its snapshot', () => {
  it('ends an error thrown before the snapshot with "Nothing was changed."', async () => {
    const { reader, writer, server } = await open();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(reader, 'findNearestName').mockImplementation(() => {
      throw new Error('lookup failed');
    });
    const writes = vi.spyOn(writer, 'writeEntityFile');
    const result = await call(server, 'update_event_block', { sheetName: 'Missing', sid: BLOCK_SID, addActions: [flyAway()] });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('The change was stopped before anything was written: lookup failed. Nothing was changed.');
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('the change check when the families cannot be read', () => {
  it('checks the object types\' ACEs and names the families it could not read, instead of failing the whole check', async () => {
    const { reader } = await open();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(reader, 'listFamilies').mockResolvedValue(['Movers']);
    vi.spyOn(reader, 'readAllFamilies').mockRejectedValue(new Error('families folder unreadable'));
    const after = [{ eventType: 'block', conditions: [], actions: [flyAway(950)], sid: 951 }];
    const warnings = await checkEventChange(reader, SHEET, [], after);
    expect(warnings).not.toContain(FIXED_FAILURE);
    expect(warnings.filter(w => unknownAction('Sprite').test(w))).toHaveLength(1);
    expect(warnings).toContain('Conditions and actions that depend on these files were not checked, because they could not be read: families/Movers.');
  });
});

describe('replace tools: swaps and rewrites checked against the catalogue', () => {
  it('replace_object_in_events leaves an event alone when a same-named behavior is of another kind', async () => {
    const { dir, server } = await open();
    expect((await call(server, 'create_object', { name: 'Hero', pluginId: 'Sprite' })).data.success).toBe(true);
    expect((await call(server, 'create_object', { name: 'Rocket', pluginId: 'Sprite' })).data.success).toBe(true);
    expect((await call(server, 'update_object_properties', { name: 'Hero', addBehaviors: [{ behaviorId: 'Platform', name: 'Move' }] })).data.success).toBe(true);
    expect((await call(server, 'update_object_properties', { name: 'Rocket', addBehaviors: [{ behaviorId: 'Bullet', name: 'Move' }] })).data.success).toBe(true);
    expect((await call(server, 'add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'simulate-control', objectClass: 'Hero', behaviorType: 'Move', parameters: { control: 'jump' } }],
    })).data.success).toBe(true);
    const before = await sheetText(dir);

    const result = await call(server, 'replace_object_in_events', { fromObject: 'Hero', toObject: 'Rocket' });
    expect(result.data.success).toBe(true);
    expect((result.data.references as { total: number }).total).toBe(0);
    const skipped = result.data.skippedEvents as Array<{ reasons: string[] }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reasons).toEqual(['"simulate-control" uses behavior "Move": it is a Platform behavior on Hero but a Bullet behavior on Rocket']);
    expect(await sheetText(dir)).toBe(before);
  });

  it('replace_object_in_events checks the ACEs it swaps and not the others', async () => {
    const { server } = await open();
    await createHero(server);
    // A wrong choice already in a source sub-event is reported once the swap has touched it
    expect((await call(server, 'add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [{ id: 'set-animation', objectClass: 'Sprite', parameters: { animation: '"Walk"', from: 'start' } }] }],
    })).data.success).toBe(true);
    // An unrelated wrong ACE in a sub-event is not the swap's to report
    expect((await call(server, 'add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      children: [{ conditions: [{ id: 'every-tick', objectClass: 'System' }], actions: [{ id: 'teleport', objectClass: 'System', parameters: {} }] }],
    })).data.success).toBe(true);

    const result = await call(server, 'replace_object_in_events', { fromObject: 'Sprite', toObject: 'Hero' });
    expect(result.data.success).toBe(true);
    const warnings = aceWarnings(result.data);
    expect(warnings.some(w => w.includes('teleport'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^MainSheet: Action "set-animation" on "Hero" \(SID \d+\): Parameter "from" of the action "set-animation" is "start"; the Sprite plugin accepts "current-frame", "beginning"\.$/);
  });

  it('replace_in_expressions warns when a rewritten combo value stops being a choice, and not about ACEs it did not change', async () => {
    const { server } = await open();
    expect((await call(server, 'add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'set-animation', objectClass: 'Sprite', parameters: { animation: '"Walk"', from: 'beginning' } }],
    })).data.success).toBe(true);
    // An unrelated wrong ACE elsewhere is not the rewrite's to report
    expect((await call(server, 'add_event_block', {
      sheetName: SHEET,
      conditions: [{ id: 'every-tick', objectClass: 'System' }],
      actions: [{ id: 'teleport', objectClass: 'Sprite', parameters: {} }],
    })).data.success).toBe(true);

    const fine = await call(server, 'replace_in_expressions', { find: 'Walk', replace: 'Run' });
    expect(fine.data.success).toBe(true);
    expect(aceWarnings(fine.data)).toEqual([]);

    const broken = await call(server, 'replace_in_expressions', { find: 'beginning', replace: 'start', parameterKeys: ['from'] });
    expect(broken.data.success).toBe(true);
    const warnings = aceWarnings(broken.data);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^MainSheet: Action "set-animation" on "Sprite" \(SID \d+\): Parameter "from" of the action "set-animation" is "start"; the Sprite plugin accepts "current-frame", "beginning"\.$/);
  });
});
