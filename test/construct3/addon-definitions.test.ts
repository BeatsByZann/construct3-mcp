/**
 * Third-party addon definitions read from folders: what is read, what the
 * allowed roots keep out (other folders, `..`, network paths, links that lead
 * out, oversized files), and what a report may carry (base names only).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, open, realpath } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import {
  AddonDefinitions,
  MAX_DEFINITION_BYTES,
  addonDefinitionsOf,
  addonRootsFor,
  loadAddonDefinitionsFromEnv,
  parseAddonDefinition,
  type LoadReport,
} from '../../src/construct3/addon-definitions.js';
import { guardNetwork } from './ace-fetch-stub.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), realpath: vi.fn(actual.realpath) };
});

const FIXTURE = join(__dirname, '..', 'fixtures', 'addons', 'probe-timer');
const OUTSIDE = 'outside the project folder and the roots named in C3_ADDON_DEFINITIONS';

let tmp: string;
let project: string;
let other: string;
let restoreNetwork: () => void;

beforeEach(async () => {
  restoreNetwork = guardNetwork();
  tmp = await mkdtemp(join(tmpdir(), 'c3-addons-'));
  project = join(tmp, 'project');
  other = join(tmp, 'other');
  await mkdir(join(project, 'addons'), { recursive: true });
  await mkdir(other);
});
afterEach(async () => {
  restoreNetwork();
  vi.restoreAllMocks();
  vi.mocked(realpath).mockReset();
  vi.mocked(readFile).mockReset();
  await rm(tmp, { recursive: true, force: true });
});

/** Write a valid addon folder at `dir` from the fixture, with the given addon id. */
async function makeAddon(dir: string, id = 'ProbeTimer', bom = false): Promise<string> {
  await mkdir(dir, { recursive: true });
  const addon = (await readFile(join(FIXTURE, 'addon.json'), 'utf8')).replace('"ProbeTimer"', JSON.stringify(id));
  const aces = await readFile(join(FIXTURE, 'aces.json'), 'utf8');
  await writeFile(join(dir, 'addon.json'), addon);
  await writeFile(join(dir, 'aces.json'), (bom ? '﻿' : '') + aces);
  return dir;
}

/** A registry whose roots are `roots`. */
async function registryWith(...roots: string[]): Promise<AddonDefinitions> {
  const defs = new AddonDefinitions();
  await defs.setRoots(roots);
  return defs;
}

/** Make a directory link (a junction on Windows, which needs no privilege); false when the platform refuses. */
function linkDirectory(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('loading folders', () => {
  it('reads an addon folder with a byte-order mark and a $schema entry', async () => {
    await makeAddon(join(project, 'addons', 'probe'), 'ProbeTimer', true);
    const defs = await registryWith(project);
    const report = await defs.load(join(project, 'addons', 'probe'));
    expect(report.skipped).toEqual([]);
    expect(report.loaded).toEqual([{
      id: 'ProbeTimer', type: 'plugin', name: 'Probe Timer', version: '1.0.0.0', source: 'probe',
      counts: { conditions: 1, actions: 1, expressions: 1 },
    }]);
    expect(report.loaded[0]).not.toHaveProperty('aces');
    const definition = defs.get('plugin', 'ProbeTimer')!;
    expect(Object.keys(definition.aces.conditions)).toEqual(['is-running']);
    expect(definition.aces.actions['start-timer'].map(p => p.id)).toEqual(['duration', 'mode']);
    expect(definition.aces.actions['start-timer'][1].items).toEqual(['once', 'regular']);
    expect(definition.aces.expressions.elapsed).toEqual({ name: 'Elapsed', params: ['string'], returns: 'number' });
    expect(defs.get('behavior', 'ProbeTimer')).toBeUndefined();
    expect(defs.get('plugin', 'constructor')).toBeUndefined();
    expect(defs.list()).toHaveLength(1);
  });

  it('reads every addon under a folder and reports the one it cannot read', async () => {
    const folder = join(project, 'addons');
    await makeAddon(join(folder, 'a'), 'AlphaTimer');
    await makeAddon(join(folder, 'b'), 'BetaTimer');
    await mkdir(join(folder, 'broken'));
    await writeFile(join(folder, 'broken', 'addon.json'), '{"type":"effect","id":"x"}');
    await writeFile(join(folder, 'broken', 'aces.json'), '{}');
    await writeFile(join(folder, 'notes.txt'), 'ignored');
    const defs = await registryWith(project);
    const report = await defs.load(folder);
    expect(report.loaded.map(d => [d.id, d.source])).toEqual([['AlphaTimer', 'a'], ['BetaTimer', 'b']]);
    expect(report.skipped).toEqual([{ name: 'broken', reason: expect.stringContaining('only plugins and behaviors') }]);
    expect(defs.list()).toHaveLength(2);
  });

  it('reports a missing path, a stray file and an empty folder', async () => {
    const defs = await registryWith(project);
    expect((await defs.load(join(project, 'nowhere'))).skipped).toEqual([{ name: 'nowhere', reason: 'not found' }]);
    await writeFile(join(project, 'x.zip'), 'zip');
    expect((await defs.load(join(project, 'x.zip'))).skipped).toEqual([{ name: 'x.zip', reason: 'not an addon folder' }]);
    await mkdir(join(project, 'empty'));
    expect((await defs.load(join(project, 'empty'))).skipped).toEqual([{ name: 'empty', reason: 'no addon.json under empty' }]);
  });

  it('loads every path named in the variable, each inside a root', async () => {
    await makeAddon(join(project, 'addons', 'one'), 'OneTimer');
    await makeAddon(join(other, 'two'), 'TwoTimer');
    const defs = await registryWith(project, other);
    const value = [join(project, 'addons', 'one'), join(other, 'two'), join(other, 'nowhere')].join(delimiter);
    const report = await loadAddonDefinitionsFromEnv(defs, value, delimiter);
    expect(report.loaded.map(d => d.id)).toEqual(['OneTimer', 'TwoTimer']);
    expect(report.skipped).toEqual([{ name: 'nowhere', reason: 'not found' }]);
    expect(await loadAddonDefinitionsFromEnv(defs, undefined, delimiter)).toEqual({ loaded: [], skipped: [] });
  });

  it('refuses malformed definition files by name', () => {
    expect(() => parseAddonDefinition('nope', '{}', 'x')).toThrow('addon.json is not valid JSON');
    expect(() => parseAddonDefinition('{"type":"behavior"}', '{}', 'x')).toThrow('addon.json has no id');
    expect(() => parseAddonDefinition('[]', '{}', 'x')).toThrow('addon.json is not an object');
    expect(() => parseAddonDefinition('{"type":"behavior","id":"a"}', '[', 'x')).toThrow('aces.json is not valid JSON');
    expect(() => parseAddonDefinition('{"type":"behavior","id":"a"}', '[]', 'x')).toThrow('aces.json is not an object');
  });

  it('keeps an id such as __proto__ as an own entry and finds nothing under constructor', () => {
    const aces = '{"c":{"actions":[{"id":"__proto__","params":[{"id":"p","type":"string"}]}]}}';
    const definition = parseAddonDefinition('{"type":"plugin","id":"constructor"}', aces, 'x');
    expect(Object.keys(definition.aces.actions)).toEqual(['__proto__']);
    expect(definition.counts.actions).toBe(1);
  });

  it('gives each reader its own registry', () => {
    const a = {};
    const b = {};
    expect(addonDefinitionsOf(a)).toBe(addonDefinitionsOf(a));
    expect(addonDefinitionsOf(a)).not.toBe(addonDefinitionsOf(b));
  });

  it('names a root that does not exist once, by base name, and drops it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const defs = await registryWith(project, join(tmp, 'gone'));
    expect(defs.roots()).toEqual([await realpath(project)]);
    expect(errors.mock.calls.flat().join('\n')).toContain('gone');
    expect(errors.mock.calls.flat().join('\n')).not.toContain(tmp);
  });
});

describe('the allowed roots', () => {
  it('refuses a folder outside the roots until its root is added, and everything when no roots were set', async () => {
    await makeAddon(join(other, 'probe'));
    const defs = await registryWith(project);
    const refused = await defs.load(join(other, 'probe'));
    expect(refused.loaded).toEqual([]);
    expect(refused.skipped).toEqual([{ name: 'probe', reason: `${OUTSIDE}. Nothing was loaded.` }]);
    expect(defs.list()).toEqual([]);

    await defs.setRoots([project, other]);
    expect((await defs.load(join(other, 'probe'))).loaded.map(d => d.id)).toEqual(['ProbeTimer']);

    await makeAddon(join(project, 'inside'), 'InsideTimer');
    const unset = new AddonDefinitions();
    const none = await unset.load(join(project, 'inside'));
    expect(none.loaded).toEqual([]);
    expect(none.skipped[0].reason).toContain('Nothing was loaded.');
    expect(addonDefinitionsOf({}).roots()).toEqual([]);
  });

  it('refuses a network path whatever the roots', async () => {
    const defs = await registryWith(project);
    // Roots that do not exist are dropped by setRoots, so put one in directly.
    (defs as unknown as { realRoots: string[] }).realRoots = ['\\\\server', '//server', project];
    for (const path of ['\\\\server\\share\\addon', '//server/share/addon']) {
      const report = await defs.load(path);
      expect(report.loaded).toEqual([]);
      expect(report.skipped).toEqual([{ name: 'addon', reason: 'a network path is not accepted. Nothing was loaded.' }]);
    }
  });

  it('carries no absolute path and no file text in a report', async () => {
    const secret = 'SECRET-FRAGMENT-4711';
    const folder = join(project, 'addons');
    await mkdir(join(folder, 'broken'));
    await writeFile(join(folder, 'broken', 'addon.json'), `{ ${secret} {{{`);
    await writeFile(join(folder, 'broken', 'aces.json'), '{}');
    await makeAddon(join(folder, 'good'));
    await mkdir(join(folder, 'half'));
    await writeFile(join(folder, 'half', 'addon.json'), '{"type":"plugin","id":"Half"}');
    const defs = await registryWith(project);
    const reports: LoadReport[] = [
      await defs.load(folder),
      await defs.load(join(other, 'nowhere')),
      await defs.load(join(project, 'nowhere')),
      await defs.load(tmp),
      await defs.load('\\\\server\\share\\addon'),
      await loadAddonDefinitionsFromEnv(defs, [folder, other].join(delimiter), delimiter),
    ];
    const text = JSON.stringify(reports);
    for (const forbidden of [tmp, await realpath(tmp), tmpdir(), secret]) expect(text).not.toContain(JSON.stringify(forbidden).slice(1, -1));
    expect(text).toContain('addon.json is not valid JSON');
    expect(reports[0].skipped.map(s => s.name)).toEqual(['broken', 'half']);
    expect(reports[0].skipped[1].reason).toBe('aces.json is missing');
  });

  it('refuses a definition file that is a folder', async () => {
    const folder = await makeAddon(join(project, 'addons', 'odd'));
    await rm(join(folder, 'aces.json'));
    await mkdir(join(folder, 'aces.json'));
    const defs = await registryWith(project);
    expect((await defs.load(folder)).skipped).toEqual([{ name: 'odd', reason: 'aces.json is not a file' }]);
  });

  it('refuses a ".." path that leaves the project', async () => {
    await makeAddon(join(other, 'probe'));
    const defs = await registryWith(project);
    const report = await defs.load(`${project}${sep}..${sep}other${sep}probe`);
    expect(report.loaded).toEqual([]);
    expect(report.skipped[0].reason).toContain(OUTSIDE);
  });

  it('refuses a junction inside the project that leads out, and loads it through a root that holds it', async ctx => {
    await makeAddon(join(other, 'target'));
    const link = join(project, 'addons', 'link');
    if (!linkDirectory(join(other, 'target'), link)) ctx.skip('this platform refused to create a directory link');
    const defs = await registryWith(project);
    const refused = await defs.load(link);
    expect(refused.loaded).toEqual([]);
    expect(refused.skipped[0].reason).toContain(OUTSIDE);
    await defs.setRoots([project, other]);
    expect((await defs.load(link)).loaded.map(d => d.id)).toEqual(['ProbeTimer']);
  });

  it('refuses a definition file over 10MB before reading it', async () => {
    const folder = join(project, 'addons', 'big');
    await makeAddon(folder);
    const handle = await open(join(folder, 'aces.json'), 'w');
    await handle.write(Buffer.from('x'), 0, 1, MAX_DEFINITION_BYTES + 1);
    await handle.close();
    const defs = await registryWith(project);
    vi.mocked(readFile).mockClear();
    const report = await defs.load(folder);
    expect(report.loaded).toEqual([]);
    expect(report.skipped).toEqual([{ name: 'big', reason: 'aces.json is larger than 10MB' }]);
    const read = vi.mocked(readFile).mock.calls.map(call => String(call[0]));
    expect(read.some(path => path.endsWith('aces.json'))).toBe(false);
  });

  it('roots a .c3p session at the folder that holds the archive, not the working folder', async () => {
    const work = join(tmp, 'work');
    const archiveFolder = join(tmp, 'games');
    await makeAddon(join(archiveFolder, 'probe'));
    await makeAddon(join(work, 'probe'), 'WorkTimer');
    expect(addonRootsFor(work, '/x/game.c3p', undefined, ':')).toEqual([dirname('/x/game.c3p')]);
    expect(addonRootsFor(work, undefined, `${other}${delimiter}${tmp}`, delimiter)).toEqual([work, other, tmp]);
    const roots = addonRootsFor(work, join(archiveFolder, 'game.c3p'), undefined, delimiter);
    const defs = await registryWith(...roots);
    expect((await defs.load(join(archiveFolder, 'probe'))).loaded.map(d => d.id)).toEqual(['ProbeTimer']);
    expect((await defs.load(join(work, 'probe'))).skipped[0].reason).toContain(OUTSIDE);
  });

  it('skips a child link that leads out of an allowed folder and still loads the others', async ctx => {
    const folder = join(project, 'addons');
    await makeAddon(join(folder, 'good'), 'GoodTimer');
    await makeAddon(join(other, 'target'), 'EvilTimer');
    if (!linkDirectory(join(other, 'target'), join(folder, 'evil'))) ctx.skip('this platform refused to create a directory link');
    const defs = await registryWith(project);
    const report = await defs.load(folder);
    expect(report.loaded.map(d => d.id)).toEqual(['GoodTimer']);
    expect(report.skipped).toEqual([{ name: 'evil', reason: OUTSIDE }]);
    expect(defs.get('plugin', 'EvilTimer')).toBeUndefined();
    expect(await defs.realContained(join(folder, 'evil'))).toBeUndefined();
    expect(await defs.realContained(join(folder, 'good'))).toBe(await realpath(join(folder, 'good')));
  });

  it('skips a definition file whose real path lies outside the roots, with the link simulated', async () => {
    const folder = join(project, 'addons', 'linked');
    await makeAddon(folder, 'LinkedTimer');
    await makeAddon(join(other, 'target'), 'LinkedTimer');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const outside = await actual.realpath(join(other, 'target', 'aces.json'));
    vi.mocked(realpath).mockImplementation((async (path: string) =>
      String(path).endsWith(`${sep}linked${sep}aces.json`) ? outside : actual.realpath(path)) as typeof realpath);
    const defs = await registryWith(project);
    const report = await defs.load(folder);
    expect(report.loaded).toEqual([]);
    expect(report.skipped).toEqual([{ name: 'linked', reason: `aces.json is ${OUTSIDE}` }]);
    expect(defs.list()).toEqual([]);
    await defs.setRoots([project, other]);
    expect((await defs.load(folder)).loaded.map(d => d.id)).toEqual(['LinkedTimer']);
  });

  it('skips a definition file that is a link leading out of an allowed addon folder', async ctx => {
    const folder = join(project, 'addons', 'linked');
    await makeAddon(folder, 'LinkedTimer');
    await makeAddon(join(other, 'target'), 'LinkedTimer');
    await rm(join(folder, 'aces.json'));
    try {
      symlinkSync(join(other, 'target', 'aces.json'), join(folder, 'aces.json'), 'file');
    } catch {
      ctx.skip('this platform refused to create a file link');
    }
    const defs = await registryWith(project);
    const report = await defs.load(folder);
    expect(report.loaded).toEqual([]);
    expect(report.skipped).toEqual([{ name: 'linked', reason: expect.stringContaining('outside the project folder') }]);
    expect(defs.list()).toEqual([]);
    await defs.setRoots([project, other]);
    expect((await defs.load(folder)).loaded.map(d => d.id)).toEqual(['LinkedTimer']);
  });
});
