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
import { guardNetwork } from '../construct3/ace-fetch-stub.js';

const MINIMAL = join(__dirname, '..', 'fixtures', 'minimal-project');
const PROBE = join(__dirname, '..', 'fixtures', 'addons', 'probe-timer');
const OUTSIDE = 'outside the project folder and the roots named in C3_ADDON_DEFINITIONS';

interface Session { dir: string; reader: Construct3ProjectReader; server: MockServer }

const dirs: string[] = [];
let restoreNetwork: () => void;
let savedEnv: string | undefined;

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

async function call(server: MockServer, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: Record<string, any> }> {
  const result = await server.callTool('load_addon_definitions', args) as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0].text;
  return { isError: result.isError === true, text, data: result.isError ? {} : JSON.parse(text) };
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
    expect(result.text).toBe('Error loading addon definitions: nowhere: not found Nothing was loaded.');
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
    expect(result.data.loaded.map((d: { id: string }) => d.id)).toEqual(['GoodTimer']);
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
