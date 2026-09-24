/**
 * Third-party addon definitions (roadmap C1): read from an addon folder or a
 * .c3addon, registered for the ACE checks, and named by validate_project
 * while they are missing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addonDefinition,
  clearAddonDefinitions,
  loadAddonDefinitions,
  loadAddonDefinitionsFromEnv,
  loadedAddonDefinitions,
  parseAddonDefinition,
} from '../../src/construct3/addon-definitions.js';
import { checkAce, checkEventAces, hasAceDefinitions } from '../../src/construct3/ace-catalog.js';
import { validateProjectIntegrity } from '../../src/construct3/analyzers/integrity.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { writeZip } from '../../src/runtime/zip-writer.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'addons', 'probe-timer');
const OWNER = { kind: 'behavior', id: 'Probe_Timer' } as const;

let tmp: string;
beforeEach(async () => {
  clearAddonDefinitions();
  resetProjectIndex();
  tmp = await mkdtemp(join(tmpdir(), 'c3-addons-'));
});
afterEach(async () => {
  clearAddonDefinitions();
  await rm(tmp, { recursive: true, force: true });
});

async function packFixture(name = 'probe-timer.c3addon', prefix = ''): Promise<string> {
  const file = join(tmp, name);
  await writeZip([
    { path: prefix + 'addon.json', data: await readFile(join(FIXTURE, 'addon.json')) },
    { path: prefix + 'aces.json', data: await readFile(join(FIXTURE, 'aces.json')) },
  ], file, { compress: true });
  return file;
}

describe('loading definitions', () => {
  it('reads an unpacked addon folder, skipping $schema and a byte-order mark', async () => {
    const report = await loadAddonDefinitions(FIXTURE);
    expect(report.skipped).toEqual([]);
    expect(report.loaded).toEqual([expect.objectContaining({
      id: 'Probe_Timer', type: 'behavior', name: 'Probe Timer', version: '1.0.0.0',
      counts: { conditions: 2, actions: 2, expressions: 1 },
    })]);
    const definition = addonDefinition('behavior', 'Probe_Timer')!;
    expect(Object.keys(definition.aces.conditions)).toEqual(['on-timer', 'is-running']);
    expect(definition.aces.actions['start-timer'].map(p => p.id)).toEqual(['duration', 'tag', 'mode']);
    expect(definition.aces.actions['start-timer'][2].items).toEqual(['once', 'regular']);
    expect(definition.expressions.elapsed.map(p => p.id)).toEqual(['tag']);
  });

  it('reads a .c3addon, at its root or under one folder', async () => {
    const root = await loadAddonDefinitions(await packFixture('root.c3addon'));
    expect(root.loaded.map(d => d.id)).toEqual(['Probe_Timer']);
    clearAddonDefinitions();
    const nested = await loadAddonDefinitions(await packFixture('nested.c3addon', 'probe-timer/'));
    expect(nested.loaded.map(d => d.id)).toEqual(['Probe_Timer']);
    expect(nested.loaded[0].source).toContain('nested.c3addon');
  });

  it('reads every addon under a folder and reports the ones it cannot read', async () => {
    await packFixture('a.c3addon');
    await mkdir(join(tmp, 'folder-addon'));
    await writeFile(join(tmp, 'folder-addon', 'addon.json'), await readFile(join(FIXTURE, 'addon.json')));
    await writeFile(join(tmp, 'folder-addon', 'aces.json'), await readFile(join(FIXTURE, 'aces.json')));
    await mkdir(join(tmp, 'broken'));
    await writeFile(join(tmp, 'broken', 'addon.json'), '{"type":"effect","id":"x"}');
    await writeFile(join(tmp, 'broken', 'aces.json'), '{}');
    await writeFile(join(tmp, 'notes.txt'), 'ignored');
    const report = await loadAddonDefinitions(tmp);
    expect(report.loaded.map(d => d.source)).toEqual([join(tmp, 'a.c3addon'), join(tmp, 'folder-addon')]);
    expect(report.skipped).toEqual([{ path: join(tmp, 'broken'), reason: expect.stringContaining('only plugins and behaviors') }]);
    expect(loadedAddonDefinitions()).toHaveLength(1);
  });

  it('reports a missing path, a stray file and an empty folder', async () => {
    expect((await loadAddonDefinitions(join(tmp, 'nowhere'))).skipped[0].reason).toBe('not found');
    await writeFile(join(tmp, 'x.zip'), 'zip');
    expect((await loadAddonDefinitions(join(tmp, 'x.zip'))).skipped[0].reason).toContain('not a .c3addon');
    await mkdir(join(tmp, 'empty'));
    expect((await loadAddonDefinitions(join(tmp, 'empty'))).skipped[0].reason).toContain('no addon.json and no .c3addon');
  });

  it('loads every path in the environment variable', async () => {
    const archive = await packFixture();
    const report = await loadAddonDefinitionsFromEnv(`${FIXTURE};${archive};${join(tmp, 'nowhere')}`, ';');
    expect(report.loaded).toHaveLength(2);
    expect(report.skipped).toEqual([{ path: join(tmp, 'nowhere'), reason: 'not found' }]);
    expect(await loadAddonDefinitionsFromEnv(undefined, ';')).toEqual({ loaded: [], skipped: [] });
  });

  it('refuses malformed definition files by name', () => {
    expect(() => parseAddonDefinition('nope', '{}', 'x')).toThrow('addon.json is not valid JSON');
    expect(() => parseAddonDefinition('{"type":"behavior"}', '{}', 'x')).toThrow('addon.json has no id');
    expect(() => parseAddonDefinition('{"type":"behavior","id":"a"}', '[', 'x')).toThrow('aces.json is not valid JSON');
  });
});

describe('checking against loaded definitions', () => {
  it('skips a third-party ACE until its definitions are loaded, then checks it like a built-in', async () => {
    const wrong = { id: 'start-timer', parameters: { duration: '1', tag: '"a"', mode: 'forever' } };
    expect(hasAceDefinitions(OWNER)).toBe(false);
    expect(checkAce('actions', wrong, OWNER)).toEqual([]);

    await loadAddonDefinitions(FIXTURE);
    expect(hasAceDefinitions(OWNER)).toBe(true);
    expect(checkAce('actions', wrong, OWNER).map(p => p.code)).toEqual(['invalid-choice']);
    expect(checkAce('actions', { id: 'start-timer', parameters: { duration: '1', tag: '"a"', mode: 'once' } }, OWNER)).toEqual([]);
    expect(checkAce('conditions', { id: 'on-tick', parameters: {} }, OWNER)).toEqual([{
      code: 'unknown-ace',
      message: 'Construct r495.2 defines no condition "on-tick" for the Probe_Timer behavior.',
    }]);
    expect(checkAce('actions', { id: 'stop-timer', parameters: { tag: '"a"', extra: '1' } }, OWNER).map(p => p.code)).toEqual(['unknown-parameter']);
  });

  it('resolves the behavior through the project and reports by SID', async () => {
    await loadAddonDefinitions(FIXTURE);
    const context = {
      pluginOf: (name: string) => (name === 'Clock' ? 'Sprite' : undefined),
      behaviorOf: (name: string, behavior: string) => (name === 'Clock' && behavior === 'Timer' ? 'Probe_Timer' : undefined),
    };
    const events = [{
      eventType: 'block', sid: 1,
      conditions: [{ id: 'on-timer', objectClass: 'Clock', behaviorType: 'Timer', sid: 2, parameters: { tag: '"t"' } }],
      actions: [{ id: 'start-timer', objectClass: 'Clock', behaviorType: 'Timer', sid: 3, parameters: { duration: '1', tag: '"t"', mode: 'never' } }],
    }];
    const problems = checkEventAces(events, context);
    expect(problems.map(p => [p.sid, p.code])).toEqual([[3, 'invalid-choice']]);
  });
});

describe('validate_project names addons whose ACEs cannot be checked', () => {
  function reader() {
    return new MockReader({
      objects: new Map([['Sprite', { name: 'Sprite', 'plugin-id': 'Sprite', sid: 100 }]]),
      eventSheets: new Map([['MainSheet', { name: 'MainSheet', events: [], sid: 200 }]]),
      layouts: new Map([['Layout 1', { name: 'Layout 1', sid: 300, eventSheet: 'MainSheet', layers: [{ name: 'Main', sid: 301, instances: [] }] }]]),
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'Probe_Timer', name: 'Probe Timer', author: 'tests', bundled: false },
        { type: 'effect', id: 'skymen_BetterOutline', name: 'Better Outline', author: 'skymen', bundled: false },
      ],
    }) as any;
  }

  it('lists the unloaded plugin or behavior as info, and drops it once loaded', async () => {
    const before = await validateProjectIntegrity(reader());
    expect(before.summary.checksRun).toBe(17);
    const unavailable = before.info.filter(i => i.check === 'ace-definitions-unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].entity).toBe('usedAddons/Probe_Timer');
    expect(unavailable[0].message).toContain('behavior "Probe_Timer" (Probe Timer)');
    expect(unavailable[0].suggestion).toContain('C3_ADDON_DEFINITIONS');

    await loadAddonDefinitions(FIXTURE);
    const after = await validateProjectIntegrity(reader());
    expect(after.info.filter(i => i.check === 'ace-definitions-unavailable')).toEqual([]);
  });
});

describe('load_addon_definitions tool', () => {
  it('loads a path, reports what it skipped, and lists what is loaded', async () => {
    const server = new MockServer();
    registerProjectTools({ server, reader: {} as any, writer: {} as any, idGen: {} as any } as any);
    const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

    const empty = parse(await server.callTool('load_addon_definitions', {}));
    expect(empty).toEqual({ success: true, loaded: [] });

    const loaded = parse(await server.callTool('load_addon_definitions', { path: FIXTURE }));
    expect(loaded.success).toBe(true);
    expect(loaded.loaded[0]).toMatchObject({ id: 'Probe_Timer', type: 'behavior', counts: { conditions: 2, actions: 2, expressions: 1 } });
    expect(loaded.nowLoaded).toEqual(['behavior:Probe_Timer']);

    const missing = parse(await server.callTool('load_addon_definitions', { path: join(tmp, 'nowhere') }));
    expect(missing.success).toBe(false);
    expect(missing.warnings[0]).toContain('not found');

    const listed = parse(await server.callTool('load_addon_definitions', {}));
    expect(listed.loaded.map((d: { id: string }) => d.id)).toEqual(['Probe_Timer']);
  });
});
