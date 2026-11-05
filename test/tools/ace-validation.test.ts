/**
 * ACE and addon validation through the tools. First group: load_addon_definitions
 * and the roots the startup sets, on temp copies of the minimal fixture with
 * the real reader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import {
  AddonDefinitions,
  addonDefinitionsOf,
  addonRootsFor,
  loadAddonDefinitionsFromEnv,
} from '../../src/construct3/addon-definitions.js';
import { AceCatalogProvider, setAceCatalogProvider } from '../../src/construct3/ace-catalog-provider.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { TEST_CATALOG } from '../fixtures/ace-catalog.js';
import { guardNetwork, offlineStub } from '../construct3/ace-fetch-stub.js';

const MINIMAL = join(__dirname, '..', 'fixtures', 'minimal-project');
const PROBE = join(__dirname, '..', 'fixtures', 'addons', 'probe-timer');
const OUTSIDE = 'outside the project folder and the roots named in C3_ADDON_DEFINITIONS';

interface Session { dir: string; reader: Construct3ProjectReader; server: MockServer }

const dirs: string[] = [];
let restoreNetwork: () => void;
let savedEnv: string | undefined;

/** A new temp folder, removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-ace-tools-'));
  dirs.push(dir);
  return dir;
}

/** A temp copy of the minimal project, a real reader, and the tools registered on a mock server; the registry's roots are the project folder, as the startup sets them. */
async function openProject(): Promise<Session> {
  const dir = await tempDir();
  await cp(MINIMAL, dir, { recursive: true });
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  await addonDefinitionsOf(reader).setRoots(addonRootsFor(reader.getProjectDir(), undefined, undefined, delimiter));
  const server = new MockServer();
  const idGen = new IdGenerator();
  registerProjectTools({ server: server as never, reader, writer: new Construct3ProjectWriter(reader, idGen), idGen });
  return { dir, reader, server };
}

/** Put the probe addon in `parent/name`, with the given addon id. */
async function putAddon(parent: string, name: string, id = 'ProbeTimer'): Promise<string> {
  const target = join(parent, name);
  await cp(PROBE, target, { recursive: true });
  if (id !== 'ProbeTimer') {
    const file = join(target, 'addon.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"ProbeTimer"', JSON.stringify(id)));
  }
  return target;
}

/** The shape load_addon_definitions returns on success. */
interface ToolPayload {
  loaded: Array<{ id: string; source: string }>;
  skipped: Array<{ name: string; reason: string }>;
  nowLoaded: string[];
}

/** Call the tool; `data` is the parsed payload, empty after an error. */
async function call(server: MockServer, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: ToolPayload }> {
  const result = await server.callTool('load_addon_definitions', args) as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0].text;
  return { isError: result.isError === true, text, data: result.isError ? { loaded: [], skipped: [], nowLoaded: [] } : JSON.parse(text) as ToolPayload };
}

beforeEach(() => {
  restoreNetwork = guardNetwork();
  resetProjectIndex();
  savedEnv = process.env.C3_ADDON_DEFINITIONS;
});
afterEach(async () => {
  restoreNetwork();
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env.C3_ADDON_DEFINITIONS;
  else process.env.C3_ADDON_DEFINITIONS = savedEnv;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('load_addon_definitions', () => {
  it('lists what is loaded when called without a path, with no success key and no path', async () => {
    const { dir, server } = await openProject();
    const empty = await call(server, {});
    expect(empty.isError).toBe(false);
    expect(empty.data).toEqual({ loaded: [], skipped: [], nowLoaded: [] });
    expect(empty.data).not.toHaveProperty('success');

    await putAddon(dir, 'probe-timer');
    await call(server, { path: join(dir, 'probe-timer') });
    const listed = await call(server, {});
    expect(listed.data.nowLoaded).toEqual(['plugin:ProbeTimer']);
    expect(listed.data.loaded).toEqual([expect.objectContaining({ id: 'ProbeTimer', source: 'probe-timer' })]);
    expect(listed.data.loaded[0]).not.toHaveProperty('aces');
    expect(listed.text).not.toContain(dir);
  });

  it('loads a folder inside the project and returns no success key, no editor note and no path', async () => {
    const { dir, reader, server } = await openProject();
    await putAddon(dir, 'probe-timer');
    const result = await call(server, { path: join(dir, 'probe-timer') });
    expect(result.isError).toBe(false);
    expect(result.data.loaded).toEqual([{
      id: 'ProbeTimer', type: 'plugin', name: 'Probe Timer', version: '1.0.0.0', source: 'probe-timer',
      counts: { conditions: 1, actions: 1, expressions: 1 },
    }]);
    expect(result.data.skipped).toEqual([]);
    expect(result.data.nowLoaded).toEqual(['plugin:ProbeTimer']);
    expect(result.data).not.toHaveProperty('success');
    expect(result.data).not.toHaveProperty('editorNote');
    expect(result.text).not.toContain(dir);
    expect(addonDefinitionsOf(reader).get('plugin', 'ProbeTimer')).toBeDefined();
  });

  it('refuses a path outside the project and the named roots, loading nothing', async () => {
    const { reader, server } = await openProject();
    const away = await tempDir();
    await putAddon(away, 'probe-timer');
    const result = await call(server, { path: join(away, 'probe-timer') });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(OUTSIDE);
    expect(result.text.endsWith('Nothing was loaded.')).toBe(true);
    expect(result.text).not.toContain(away);
    expect(addonDefinitionsOf(reader).list()).toEqual([]);
  });

  it('reports a missing path as an error ending "Nothing was loaded."', async () => {
    const { dir, server } = await openProject();
    const result = await call(server, { path: join(dir, 'nowhere') });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Error loading addon definitions: nowhere: not found. Nothing was loaded.');
  });

  it('lists the entries it skipped by base name', async () => {
    const { dir, server } = await openProject();
    const folder = join(dir, 'addons');
    await mkdir(folder);
    await putAddon(folder, 'good', 'GoodTimer');
    await mkdir(join(folder, 'broken'));
    await writeFile(join(folder, 'broken', 'addon.json'), '{"type":"effect","id":"x"}');
    await writeFile(join(folder, 'broken', 'aces.json'), '{}');
    const result = await call(server, { path: folder });
    expect(result.data.loaded.map(d => d.id)).toEqual(['GoodTimer']);
    expect(result.data.skipped).toEqual([{ name: 'broken', reason: expect.stringContaining('only plugins and behaviors') }]);
    expect(result.text).not.toContain(dir);
  });

  it('does not share definitions between readers', async () => {
    const a = await openProject();
    const b = await openProject();
    await putAddon(a.dir, 'probe-timer');
    await call(a.server, { path: join(a.dir, 'probe-timer') });
    expect((await call(a.server, {})).data.nowLoaded).toEqual(['plugin:ProbeTimer']);
    expect((await call(b.server, {})).data.nowLoaded).toEqual([]);
  });

  it('accepts a root named only in the variable at startup on a later call, without reading the variable', async () => {
    const { dir, reader, server } = await openProject();
    const named = await tempDir();
    await putAddon(named, 'probe-timer');
    // What the startup does with the variable's value, then the variable disappears
    await addonDefinitionsOf(reader).setRoots(addonRootsFor(dir, undefined, named, delimiter));
    delete process.env.C3_ADDON_DEFINITIONS;
    const result = await call(server, { path: join(named, 'probe-timer') });
    expect(result.data.nowLoaded).toEqual(['plugin:ProbeTimer']);
  });

  it('does not take a root from the variable when the registry was not given it', async () => {
    const { reader, server } = await openProject();
    const away = await tempDir();
    await putAddon(away, 'probe-timer');
    process.env.C3_ADDON_DEFINITIONS = away;
    const result = await call(server, { path: join(away, 'probe-timer') });
    expect(result.isError).toBe(true);
    expect(addonDefinitionsOf(reader).list()).toEqual([]);
  });

  it('reports an unexpected failure without a path or error text', async () => {
    const { server } = await openProject();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(AddonDefinitions.prototype, 'load').mockRejectedValue(new Error('EACCES: C:\\secret\\place'));
    const result = await call(server, { path: 'anything' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Error loading addon definitions. Nothing was loaded.');
    expect(errors).toHaveBeenCalled();
  });

  it('validates its argument', async () => {
    const { server } = await openProject();
    const registered = server.getTool('load_addon_definitions')!;
    expect(registered.schema.path.safeParse('').success).toBe(false);
    expect(registered.schema.path.safeParse('x'.repeat(4097)).success).toBe(false);
    expect(registered.schema.path.safeParse(undefined).success).toBe(true);
  });
});

describe('the startup variable', () => {
  it('loads each path of a value joined with the path delimiter', async () => {
    const { dir, reader } = await openProject();
    const named = await tempDir();
    await putAddon(dir, 'one', 'OneTimer');
    await putAddon(named, 'two', 'TwoTimer');
    const value = [join(dir, 'one'), join(named, 'two')].join(delimiter);
    const defs = addonDefinitionsOf(reader);
    await defs.setRoots(addonRootsFor(dir, undefined, value, delimiter));
    const report = await loadAddonDefinitionsFromEnv(defs, value, delimiter);
    expect(report.loaded.map(d => d.id)).toEqual(['OneTimer', 'TwoTimer']);
    expect(report.skipped).toEqual([]);
  });
});

// --- validate_project: ACE, expression and addon-definition checks ---------

const LOADABLE = join(__dirname, '..', 'fixtures', 'c3-loadable-minimal');
const TRAPS = join(__dirname, '..', 'fixtures', 'runtime-traps-real');
const SOURCE = join(__dirname, '..', 'fixtures', 'ace-source');

interface Issue { check: string; entity: string; message: string }
interface Report {
  valid: boolean;
  complete: boolean;
  summary: { errors: number; warnings: number; info: number; checksRun: number };
  errors: Issue[];
  warnings: Issue[];
  info: Issue[];
}
type Json = Record<string, unknown>;

/** The codes the three checks report, besides the ace- codes: the load-time expression-syntax rule is another check's. */
const EXPRESSION_CODES = new Set([
  'expression-grammar', 'expression-unknown-object', 'expression-unknown-member', 'expression-unknown-function',
  'expression-unknown-name', 'expression-argument-count', 'expression-names-unchecked',
]);

const everyIssue = (r: Report): Issue[] => [...r.errors, ...r.warnings, ...r.info];
const isCatalogCheck = (i: Issue): boolean => i.check.startsWith('ace-') || EXPRESSION_CODES.has(i.check);
/** The issues of the three checks. */
const catalogIssues = (r: Report): Issue[] => everyIssue(r).filter(isCatalogCheck);
/** The issues of every other check, as comparable lines. */
const otherIssues = (r: Report): string[] =>
  everyIssue(r).filter(i => !isCatalogCheck(i)).map(i => `${i.check}|${i.entity}|${i.message}`).sort();
const withCode = (r: Report, code: string): Issue[] => everyIssue(r).filter(i => i.check === code);

/** A provider that reads the hand-written catalogue folder: no network, no cache. */
async function fixtureProvider(sourceDir = SOURCE): Promise<AceCatalogProvider> {
  return new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir });
}

interface Validation {
  dir: string;
  reader: Construct3ProjectReader;
  validate(): Promise<Report>;
}

/** A temp copy of a fixture project with its own provider (the fixture folder's by default), the analysis tools on a mock server and `validate()` calling validate_project. */
async function openForValidation(
  fixture: string,
  options: { release?: number; provider?: AceCatalogProvider } = {},
): Promise<Validation> {
  const dir = await tempDir();
  await cp(fixture, dir, { recursive: true });
  if (options.release !== undefined) {
    const file = join(dir, 'project.c3proj');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/"savedWithRelease":\s*\d+/, `"savedWithRelease": ${options.release}`));
  }
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  setAceCatalogProvider(reader, options.provider ?? await fixtureProvider());
  const server = new MockServer();
  registerAnalysisTools(server as never, reader);
  return {
    dir,
    reader,
    async validate() {
      resetProjectIndex();
      const result = await server.callTool('validate_project', {}) as { isError?: boolean; content: Array<{ text: string }> };
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text) as Report;
    },
  };
}

/** Rewrite project.c3proj through `change`. */
async function editProject(dir: string, change: (project: Json) => void): Promise<void> {
  const file = join(dir, 'project.c3proj');
  const project = JSON.parse(await readFile(file, 'utf8')) as Json;
  change(project);
  await writeFile(file, JSON.stringify(project, null, '\t'));
}

/** Write an event sheet file and register it. */
async function addSheet(dir: string, name: string, events: unknown[]): Promise<void> {
  await writeFile(join(dir, 'eventSheets', `${name}.json`), JSON.stringify({ name, events, sid: nextSid() }, null, '\t'));
  await editProject(dir, project => {
    ((project.eventSheets as { items: string[] }).items).push(name);
  });
}

/** Replace the events of the fixture's MainSheet. */
async function setMainEvents(dir: string, events: unknown[]): Promise<void> {
  await writeFile(join(dir, 'eventSheets', 'MainSheet.json'), JSON.stringify({ name: 'MainSheet', events, sid: nextSid() }, null, '\t'));
}

let sidCounter = 600000000000000;
const nextSid = (): number => ++sidCounter;

const ace = (id: string, objectClass: string, parameters?: Json, extra: Json = {}): Json =>
  ({ id, objectClass, sid: nextSid(), ...(parameters ? { parameters } : {}), ...extra });
const block = (conditions: Json[], actions: Json[], children?: Json[]): Json =>
  ({ eventType: 'block', conditions, actions, sid: nextSid(), ...(children ? { children } : {}) });
const action = (id: string, objectClass: string, parameters?: Json): Json => ace(id, objectClass, parameters);
const onStart = (): Json => ace('on-start-of-layout', 'System');

/** Parameters for an ACE of the test catalogue; throws when a name is not one of the catalogue's, so the values never drift from it. */
function catalogParams(owner: 'system' | 'Sprite', kind: 'conditions' | 'actions', id: string, values: Json): Json {
  const defined = TEST_CATALOG.plugins[owner][kind][id];
  if (!defined) throw new Error(`the test catalogue has no ${kind} "${id}" on ${owner}`);
  for (const key of Object.keys(values)) {
    if (!defined.some(p => p.id === key)) throw new Error(`the test catalogue's "${id}" has no parameter "${key}"`);
  }
  return values;
}

/** The three faults of the first test: a wrong ACE id, a missing parameter, an invalid combo value. */
function aceFaults(): { events: Json[]; sids: { unknownAce: number; missing: number; choice: number } } {
  const unknownAce = action('fly-away', 'Sprite');
  const missing = action('set-position', 'Sprite', { x: '1' });
  const choice = action('set-animation', 'Sprite', { animation: '"Run"', from: 'sideways' });
  return {
    events: [block([onStart()], [unknownAce, missing, choice])],
    sids: { unknownAce: unknownAce.sid as number, missing: missing.sid as number, choice: choice.sid as number },
  };
}

/** A variable event for a global. */
const globalVariable = (name: string): Json =>
  ({ eventType: 'variable', name, type: 'number', initialValue: '0', comment: '', isStatic: false, isConstant: false, sid: nextSid() });

describe('validate_project: ACE, expression and addon-definition checks', () => {
  it('reports a wrong ACE id, a missing parameter and an invalid combo value, one warning each, located by sheet and SID, with no substitute issue', async () => {
    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502 });
    const { events, sids } = aceFaults();
    await setMainEvents(dir, events);
    const report = await validate();
    const aceWarnings = report.warnings.filter(w => w.check.startsWith('ace-'));
    expect(aceWarnings.map(w => [w.check, w.entity]).sort()).toEqual([
      ['ace-invalid-choice', `eventSheets/MainSheet/sid:${sids.choice}`],
      ['ace-missing-parameter', `eventSheets/MainSheet/sid:${sids.missing}`],
      ['ace-unknown-ace', `eventSheets/MainSheet/sid:${sids.unknownAce}`],
    ]);
    expect(aceWarnings.find(w => w.check === 'ace-unknown-ace')!.message).toContain('"fly-away"');
    expect(withCode(report, 'ace-catalog-other-release')).toEqual([]);
    expect(withCode(report, 'ace-catalog-unavailable')).toEqual([]);
  });

  it('words the findings as possibly new only when the project was saved with a newer release than the catalogue used', async () => {
    const run = async (release: number) => {
      const { dir, validate } = await openForValidation(MINIMAL, { release });
      const { events } = aceFaults();
      (events[0].actions as Json[]).push(action('set-x', 'Sprite', { x: 'newfunc(1)' }));
      await setMainEvents(dir, events);
      return validate();
    };
    const hedged = (i: Issue) => i.message.includes('may define this');

    const newer = await run(50602);
    const substitute = withCode(newer, 'ace-catalog-other-release');
    expect(substitute).toHaveLength(1);
    expect(substitute[0].entity).toBe('project');
    expect(substitute[0].message).toContain('r506.2');
    expect(substitute[0].message).toContain('r495.2');
    const aceWarnings = newer.warnings.filter(w => w.check.startsWith('ace-'));
    expect(aceWarnings).toHaveLength(3);
    expect(aceWarnings.every(hedged)).toBe(true);
    const unknownFunction = withCode(newer, 'expression-unknown-function');
    expect(unknownFunction).toHaveLength(1);
    expect(hedged(unknownFunction[0])).toBe(true);

    const older = await run(44000);
    expect(withCode(older, 'ace-catalog-other-release')).toHaveLength(1);
    expect(older.warnings.filter(w => w.check.startsWith('ace-') || EXPRESSION_CODES.has(w.check))).toHaveLength(4);
    expect(everyIssue(older).some(hedged)).toBe(false);
    const olderWords = (i: Issue) => i.message.includes('older than r495.2 whose definitions were used');
    expect(older.warnings.filter(w => w.check.startsWith('ace-')).every(olderWords)).toBe(true);
    expect(olderWords(withCode(older, 'expression-unknown-function')[0])).toBe(true);

    const same = await run(49502);
    expect(withCode(same, 'ace-catalog-other-release')).toEqual([]);
    expect(same.warnings.filter(w => w.check.startsWith('ace-') || EXPRESSION_CODES.has(w.check))).toHaveLength(4);
    expect(everyIssue(same).some(hedged)).toBe(false);
  });

  it('reports one issue per fault: the load-time syntax rule and the base missing-behavior check keep their faults to themselves', async () => {
    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502 });
    await setMainEvents(dir, [block([onStart()], [
      action('set-animation', 'Sprite', { animation: '"abc', from: 'beginning' }),
      action('set-x', 'Sprite', { x: 'Sprite.NoSuchBehavior.Speed' }),
    ])]);
    const report = await validate();
    expect(withCode(report, 'expression-syntax')).toHaveLength(1);
    expect(withCode(report, 'expression-grammar')).toEqual([]);
    expect(withCode(report, 'missing-behavior-or-variable')).toHaveLength(1);
    expect(withCode(report, 'expression-unknown-member')).toEqual([]);
  });

  it('reports a used third-party plugin once, and checks its ACEs after its definitions are loaded', async () => {
    const { dir, reader, validate } = await openForValidation(MINIMAL, { release: 49502 });
    await cp(PROBE, join(dir, 'probe-timer'), { recursive: true });
    await writeFile(join(dir, 'objectTypes', 'Timer.json'), JSON.stringify({
      name: 'Timer', 'plugin-id': 'ProbeTimer', sid: nextSid(), isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [],
    }));
    await editProject(dir, project => {
      const used = project.usedAddons as unknown[];
      // Listed twice, and beside an effect, which has no ACEs: still one issue, for the plugin
      used.push({ type: 'plugin', id: 'ProbeTimer', name: 'Probe Timer', author: 'test fixture', bundled: false });
      used.push({ type: 'plugin', id: 'ProbeTimer', name: 'Probe Timer', author: 'test fixture', bundled: false });
      used.push({ type: 'effect', id: 'ProbeGlow', name: 'Probe Glow', author: 'test fixture', bundled: false });
      (project.objectTypes as { items: string[] }).items.push('Timer');
    });
    await setMainEvents(dir, [block([onStart()], [action('start-timer', 'Timer', { duration: '5', mode: 'forever' })])]);

    const before = await validate();
    const unavailable = withCode(before, 'ace-definitions-unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].entity).toContain('ProbeTimer');
    expect(unavailable[0].message).toContain('r495.2');
    expect(before.warnings.filter(w => w.check.startsWith('ace-'))).toEqual([]);

    const defs = addonDefinitionsOf(reader);
    await defs.setRoots(addonRootsFor(dir, undefined, undefined, delimiter));
    await defs.load(join(dir, 'probe-timer'));
    const after = await validate();
    expect(withCode(after, 'ace-definitions-unavailable')).toEqual([]);
    expect(after.warnings.filter(w => w.check.startsWith('ace-')).map(w => w.check)).toEqual(['ace-invalid-choice']);
  });

  it('names an unparsable event sheet in one info issue and reports no unknown name', async () => {
    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502 });
    await setMainEvents(dir, [block([onStart()], [action('set-x', 'Sprite', { x: 'NotDeclaredAnywhere' })])]);
    await writeFile(join(dir, 'eventSheets', 'Broken.json'), '{ not json');
    await editProject(dir, project => {
      (project.eventSheets as { items: string[] }).items.push('Broken');
    });
    const report = await validate();
    const unchecked = withCode(report, 'expression-names-unchecked');
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0].message).toContain('eventSheets/Broken');
    expect(withCode(report, 'expression-unknown-name')).toEqual([]);
  });

  it('runs 33 checks', async () => {
    const { validate } = await openForValidation(MINIMAL);
    expect((await validate()).summary.checksRun).toBe(33);
  });

  it('reports a very deeply nested value as one finding and still runs every other check', async () => {
    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502 });
    const { events, sids } = aceFaults();
    await setMainEvents(dir, events);
    const deep = `${'('.repeat(5000)}1${')'.repeat(5000)}`;
    await addSheet(dir, 'Deep', [block([onStart()], [action('set-x', 'Sprite', { x: deep })])]);
    const report = await validate();
    const grammar = withCode(report, 'expression-grammar');
    expect(grammar).toHaveLength(1);
    expect(grammar[0].message).toContain('nested more than 200 levels deep');
    expect(report.warnings.filter(w => w.check === 'ace-unknown-ace').map(w => w.entity)).toEqual([`eventSheets/MainSheet/sid:${sids.unknownAce}`]);
    expect(report.summary.checksRun).toBe(33);
  });

  it('turns a fault inside the ACE and expression step into one info issue and keeps every other check', async () => {
    const reference = await openForValidation(MINIMAL, { release: 49502 });
    await setMainEvents(reference.dir, aceFaults().events);
    const expected = await reference.validate();

    const provider = await fixtureProvider();
    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502, provider });
    await setMainEvents(dir, aceFaults().events);
    vi.spyOn(provider, 'catalogFor').mockRejectedValue(new Error('unexpected fault in /private/place'));
    const report = await validate();
    const failed = withCode(report, 'ace-check-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].entity).toBe('project');
    expect(failed[0].message).not.toContain('private');
    expect(catalogIssues(report).map(i => i.check)).toEqual(['ace-check-failed']);
    expect(otherIssues(report)).toEqual(otherIssues(expected));
    expect(report.summary.checksRun).toBe(33);
  });

  describe('valid projects', () => {
    /** The only issues of the three checks a valid project may have. */
    const allowed = (i: Issue) => i.check === 'ace-catalog-other-release' || i.check === 'ace-definitions-unavailable';

    it('reports nothing of the three checks on the minimal fixture, apart from the substitute issue', async () => {
      const { validate } = await openForValidation(MINIMAL);
      const issues = catalogIssues(await validate());
      expect(issues.map(i => i.check)).toEqual(['ace-catalog-other-release']);
    });

    it('reports nothing of the three checks on the loadable fixture, apart from the substitute issue and addons the catalogue lacks', async () => {
      const { validate } = await openForValidation(LOADABLE);
      const issues = catalogIssues(await validate());
      expect(issues.filter(i => !allowed(i))).toEqual([]);
      expect(issues.filter(i => i.check === 'ace-catalog-other-release')).toHaveLength(1);
    });

    it('reports nothing of the three checks on valid uses of built-in ACEs and expressions', async () => {
      const { dir, validate } = await openForValidation(MINIMAL);
      await addSheet(dir, 'Valid', [
        globalVariable('Counter'),
        block(
          [ace('compare-two-values', 'System', catalogParams('system', 'conditions', 'compare-two-values', { 'first-value': 'Counter', comparison: 0, 'second-value': '5' }))],
          [
            action('set-eventvar-value', 'System', catalogParams('system', 'actions', 'set-eventvar-value', { variable: 'Counter', value: 'Counter + Sprite.ImagePointX("Origin")' })),
            action('set-animation', 'Sprite', catalogParams('Sprite', 'actions', 'set-animation', { animation: '"Walk"', from: 'beginning' })),
          ],
        ),
      ]);
      const issues = catalogIssues(await validate());
      expect(issues.map(i => i.check)).toEqual(['ace-catalog-other-release']);
    });
  });

  it('reports on runtime-traps-real only the substitute issue and unknown objects among the names its sheets use without registering', async () => {
    const { dir, validate } = await openForValidation(TRAPS);
    const report = await validate();
    const issues = catalogIssues(report);
    expect(issues.filter(i => i.check === 'ace-catalog-other-release')).toHaveLength(1);

    // The sheets use these objects without the project registering them
    const unknownObjects = issues.filter(i => i.check === 'expression-unknown-object');
    const namedIn = (list: Issue[]): string[] => list.map(i => /"([^"]+)" is not/.exec(i.message)![1]).sort();
    expect(namedIn(unknownObjects)).toEqual(['shots_max_txt', 'slider_phi', 'slider_theta', 'slider_theta']);
    // Names that no sheet of this trimmed fixture declares (the original project declares them elsewhere)
    expect(namedIn(withCode(report, 'expression-unknown-name'))).toEqual(['dialog_type', 'dialog_type', 'dialog_type', 'dialog_type', 'dialog_type', 'level']);
  });

  it('applies the scope of a function parameter through the whole tool, and resolves behaviors and argument counts', async () => {
    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502 });
    await writeFile(join(dir, 'objectTypes', 'Sprite.json'), JSON.stringify({
      ...JSON.parse(await readFile(join(dir, 'objectTypes', 'Sprite.json'), 'utf8')) as Json,
      behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: nextSid() }],
    }));
    await editProject(dir, project => {
      (project.usedAddons as unknown[]).push({ type: 'behavior', id: 'Platform', name: 'Platform', author: 'Scirra', bundled: false });
    });
    const secondUse = action('set-x', 'Sprite', { x: 'Secret' });
    await setMainEvents(dir, [
      {
        eventType: 'function-block',
        functionName: 'Calc',
        functionDescription: '',
        functionCategory: '',
        functionReturnType: 'none',
        functionCopyPicked: false,
        functionIsAsync: false,
        functionParameters: [{ name: 'Secret', type: 'number', initialValue: '0', comment: '', sid: nextSid() }],
        conditions: [],
        actions: [action('set-x', 'Sprite', { x: 'Secret' })],
        sid: nextSid(),
      },
    ]);
    await addSheet(dir, 'Other', [block([onStart()], [
      secondUse,
      action('set-x', 'Sprite', { x: 'Sprite.platform.VectorX' }),
      action('set-x', 'Sprite', { x: 'choose' }),
    ])]);
    const report = await validate();
    const unknownNames = withCode(report, 'expression-unknown-name');
    expect(unknownNames).toHaveLength(1);
    expect(unknownNames[0].entity).toBe(`eventSheets/Other/sid:${secondUse.sid as number}`);
    expect(withCode(report, 'expression-unknown-member')).toEqual([]);
    expect(withCode(report, 'expression-argument-count')).toHaveLength(1);
  });

  it('returns a result with one ace-catalog-unavailable issue when the local copy holds no System object', async () => {
    const empty = await tempDir();
    await cp(SOURCE, empty, { recursive: true });
    await writeFile(join(empty, 'r495-2', 'plugins', 'allAces.json'), '{}');
    const fixture = await openForValidation(MINIMAL, { release: 49502 });
    await setMainEvents(fixture.dir, aceFaults().events);
    const reference = await fixture.validate();

    const { dir, validate } = await openForValidation(MINIMAL, { release: 49502, provider: await fixtureProvider(empty) });
    await setMainEvents(dir, aceFaults().events);
    const report = await validate();
    expect(withCode(report, 'ace-catalog-unavailable')).toHaveLength(1);
    expect(catalogIssues(report).map(i => i.check)).toEqual(['ace-catalog-unavailable']);
    // Everything else is as with the fixture provider
    expect(otherIssues(report)).toEqual(otherIssues(reference));
  });

  describe('without a catalogue', () => {
    /** The project of the first test plus a sheet that cannot be parsed. */
    async function faultyProject(provider?: AceCatalogProvider): Promise<Validation> {
      const open = await openForValidation(MINIMAL, { release: 49502, provider });
      await setMainEvents(open.dir, aceFaults().events);
      await writeFile(join(open.dir, 'eventSheets', 'Broken.json'), '{ not json');
      await editProject(open.dir, project => {
        (project.eventSheets as { items: string[] }).items.push('Broken');
      });
      return open;
    }

    it('reports why in one info issue, no ace or expression issue, 33 checks, and every other check as with a catalogue', async () => {
      const reference = await (await faultyProject()).validate();
      expect(catalogIssues(reference).some(i => i.check.startsWith('ace-') && i.check !== 'ace-catalog-unavailable')).toBe(true);

      const emptyFolder = await tempDir();
      const noLocalCopy = await (await faultyProject(new AceCatalogProvider({ cacheDir: await tempDir(), sourceDir: emptyFolder }))).validate();
      const offline = offlineStub();
      const unreachable = await (await faultyProject(new AceCatalogProvider({ cacheDir: await tempDir(), fetch: offline }))).validate();

      for (const [report, wording] of [[noLocalCopy, 'C3_ACE_SOURCE_DIR'], [unreachable, 'could not be reached']] as const) {
        const issues = catalogIssues(report);
        expect(issues.map(i => i.check)).toEqual(['ace-catalog-unavailable']);
        expect(issues[0].entity).toBe('project');
        expect(issues[0].message).toContain(wording);
        expect(report.summary.checksRun).toBe(33);
        expect(otherIssues(report)).toEqual(otherIssues(reference));
      }
      expect(reference.summary.checksRun).toBe(33);
      expect(offline.calls).toHaveLength(1);
    });

    it('makes one attempt for the process through the tool', async () => {
      const offline = offlineStub();
      const open = await faultyProject(new AceCatalogProvider({ cacheDir: await tempDir(), fetch: offline }));
      const first = await open.validate();
      // A failed attempt stops at its first request
      expect(offline.calls).toHaveLength(1);
      const second = await open.validate();
      expect(offline.calls).toHaveLength(1);
      expect(withCode(first, 'ace-catalog-unavailable')).toHaveLength(1);
      expect(withCode(second, 'ace-catalog-unavailable')).toHaveLength(1);
    });
  });
});
