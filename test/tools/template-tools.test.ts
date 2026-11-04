/**
 * list_templates: the template instances of a project with the number of
 * replicas that name each, the replicas whose template is missing, an object
 * type filter, and the layouts it could not read. The tool reads only. Real
 * reader and writer on a temp copy of the rename fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerTemplateTools } from '../../src/tools/template-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { buildInstanceTemplate } from '../../src/construct3/instance-templates.js';
import type { Instance } from '../../src/construct3/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

interface LayerJson { instances: Instance[]; subLayers?: LayerJson[]; [key: string]: unknown }
interface LayoutFile { layers: LayerJson[]; 'nonworld-instances'?: Instance[]; [key: string]: unknown }
interface Row { templateName: string; objectType: string; layout: string; uid: number; replicaCount: number }
interface Orphan { objectType: string; layout: string; uid: number; sourceTemplateName: string }
interface ToolData {
  isError?: boolean; text?: string; templates?: Row[]; count?: number;
  orphanedReplicas?: Orphan[]; orphanedReplicaCount?: number;
  orphanedReplicasTruncated?: boolean; complete?: boolean; unscannedFiles?: Array<{ file: string; reason: string }>; warnings?: string[];
  success?: boolean; action?: string; entity?: string; backupFile?: string;
}

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const level1Path = () => join(tmpDir, 'layouts', 'Level 1.json');
const readLevel1 = async (): Promise<LayoutFile> => JSON.parse(await readFile(level1Path(), 'utf8')) as LayoutFile;
const writeLevel1 = (layout: LayoutFile) => writeFile(level1Path(), JSON.stringify(layout, null, '\t'));

/** Level 1's instances of the first layer: UID 1 (Player) and UID 2 (Enemy). */
const gameLayer = (layout: LayoutFile): LayerJson => layout.layers[0];
const instanceWithUid = (layout: LayoutFile, uid: number): Instance => {
  const all = [...gameLayer(layout).instances, ...(gameLayer(layout).subLayers ?? []).flatMap(l => l.instances)];
  const found = all.find(i => i.uid === uid);
  if (!found) throw new Error(`no instance ${uid}`);
  return found;
};

/** Mark an instance of the layout as a template or a replica. */
function mark(layout: LayoutFile, uid: number, mode: 'template' | 'replica', templateName: string, sourceTemplateName: string): void {
  const instance = instanceWithUid(layout, uid);
  instance.template = buildInstanceTemplate(instance, mode, templateName, sourceTemplateName) as unknown as Record<string, unknown>;
}

/** A world instance of a type, added to the first layer, as a replica of the named template. */
function addReplica(layout: LayoutFile, type: string, uid: number, source: string): void {
  const instance = { type, uid, sid: 640000000000000 + uid, tags: '', properties: {}, instanceVariables: {}, behaviors: {}, world: { x: 0, y: 0, width: 8, height: 8 } } as unknown as Instance;
  instance.template = buildInstanceTemplate(instance, 'replica', '', source) as unknown as Record<string, unknown>;
  gameLayer(layout).instances.push(instance);
}

/** Player template "PlayerT" (UID 1) with three replicas (UIDs 3, 10, 11) and Enemy template "EnemyT" (UID 2). */
async function setupTemplates(): Promise<void> {
  const layout = await readLevel1();
  mark(layout, 1, 'template', 'PlayerT', '');
  mark(layout, 2, 'template', 'EnemyT', '');
  mark(layout, 3, 'replica', '', 'PlayerT');
  addReplica(layout, 'Player', 10, 'PlayerT');
  addReplica(layout, 'Player', 11, 'PlayerT');
  await writeLevel1(layout);
  await reader.loadProject();
  resetProjectIndex();
}

const call = async (args: Record<string, unknown> = {}): Promise<ToolData> => {
  const result = await server.callTool('list_templates', args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};

/** Every file of the project (not *.bak) with its bytes. */
async function snapshotProject(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else if (!name.endsWith('.bak')) snapshot.set(relative(dir, path), (await readFile(path)).toString('base64'));
    }
  };
  await walk(dir);
  return snapshot;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-template-tools-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTemplateTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('list_templates', () => {
  it('lists templates with their replica counts', async () => {
    await setupTemplates();
    const data = await call();
    expect(data.count).toBe(2);
    expect(data.templates).toEqual([
      { templateName: 'PlayerT', objectType: 'Player', layout: 'Level 1', uid: 1, replicaCount: 3 },
      { templateName: 'EnemyT', objectType: 'Enemy', layout: 'Level 1', uid: 2, replicaCount: 0 },
    ]);
    expect(data.orphanedReplicas).toBeUndefined();
    expect(data.orphanedReplicaCount).toBeUndefined();
    expect(data.complete).toBeUndefined();
  });

  it('filters by object type', async () => {
    await setupTemplates();
    const data = await call({ objectType: 'Enemy' });
    expect(data.count).toBe(1);
    expect(data.templates).toEqual([{ templateName: 'EnemyT', objectType: 'Enemy', layout: 'Level 1', uid: 2, replicaCount: 0 }]);
  });

  it('reports a replica whose template is missing, and not for a filtered-out type', async () => {
    await setupTemplates();
    const layout = await readLevel1();
    addReplica(layout, 'Player', 12, 'Gone');
    await writeLevel1(layout);
    await reader.loadProject();
    resetProjectIndex();

    const all = await call();
    expect(all.orphanedReplicaCount).toBe(1);
    expect(all.orphanedReplicas).toEqual([{ objectType: 'Player', layout: 'Level 1', uid: 12, sourceTemplateName: 'Gone' }]);
    expect(all.templates?.find(t => t.templateName === 'PlayerT')?.replicaCount).toBe(3);

    const enemies = await call({ objectType: 'Enemy' });
    expect(enemies.orphanedReplicas).toBeUndefined();
    expect(enemies.orphanedReplicaCount).toBeUndefined();

    const players = await call({ objectType: 'Player' });
    expect(players.orphanedReplicaCount).toBe(1);
  });

  it('caps the orphan list at 50 and counts all', async () => {
    await setupTemplates();
    const layout = await readLevel1();
    for (let i = 0; i < 52; i++) addReplica(layout, 'Enemy', 100 + i, 'Gone');
    await writeLevel1(layout);
    await reader.loadProject();
    resetProjectIndex();

    const data = await call();
    expect(data.orphanedReplicas).toHaveLength(50);
    expect(data.orphanedReplicaCount).toBe(52);
    expect(data.orphanedReplicasTruncated).toBe(true);
    expect(data.warnings).toEqual(['Only the first 50 of 52 orphaned replicas are listed.']);
  });

  it('does not flag a list of exactly 50 orphans as cut', async () => {
    await setupTemplates();
    const layout = await readLevel1();
    for (let i = 0; i < 50; i++) addReplica(layout, 'Enemy', 100 + i, 'Gone');
    await writeLevel1(layout);
    await reader.loadProject();
    resetProjectIndex();

    const data = await call();
    expect(data.orphanedReplicas).toHaveLength(50);
    expect(data.orphanedReplicasTruncated).toBeUndefined();
    expect(data.warnings).toBeUndefined();
  });

  it('refuses an unknown object type filter with the plain not-found text, and a case variant with the letter-case hint', async () => {
    await setupTemplates();
    const unknown = await call({ objectType: 'Nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Object "Nope" not found.');
    expect(unknown.text).not.toContain('Nothing was changed');

    const variant = await call({ objectType: 'enemy' });
    expect(variant.isError).toBe(true);
    expect(variant.text).toBe('Object "enemy" not found: names are matched with their letter case. Did you mean "Enemy"?');
  });

  it('lists a layout it cannot parse and does not hide the templates it cannot see', async () => {
    await setupTemplates();
    await writeFile(join(tmpDir, 'layouts', 'Extra', 'Level 2.json'), '{ broken');
    await reader.loadProject();
    resetProjectIndex();

    const result = await server.callTool('list_templates', {});
    const text = result.content[0].text as string;
    const data = JSON.parse(text) as ToolData;
    expect(data.complete).toBe(false);
    expect(data.unscannedFiles).toEqual([{ file: 'layouts/Level 2', reason: 'not valid JSON' }]);
    expect(data.warnings?.join(' ')).toContain('layouts/Level 2 (not valid JSON)');
    expect(data.warnings?.join(' ')).toContain('counts and orphans may be wrong');
    expect(data.templates?.map(t => t.templateName)).toEqual(['PlayerT', 'EnemyT']);
    expect(text).not.toContain(tmpDir);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('makes no change', async () => {
    await setupTemplates();
    const before = await snapshotProject(tmpDir);
    await call();
    await call({ objectType: 'Enemy' });
    await call({ objectType: 'Nope' });
    await call({ objectType: 'enemy' });
    expect(await snapshotProject(tmpDir)).toEqual(before);

    await writeFile(join(tmpDir, 'layouts', 'Extra', 'Level 2.json'), '{ broken');
    await reader.loadProject();
    resetProjectIndex();
    const withBroken = await snapshotProject(tmpDir);
    expect((await call()).complete).toBe(false);
    expect(await snapshotProject(tmpDir)).toEqual(withBroken);
  });

  it('pairs a replica with its template by exact name', async () => {
    const layout = await readLevel1();
    mark(layout, 1, 'template', 'HeroT', '');
    addReplica(layout, 'Player', 10, 'herot');
    await writeLevel1(layout);
    await reader.loadProject();
    resetProjectIndex();

    const data = await call();
    expect(data.templates).toEqual([{ templateName: 'HeroT', objectType: 'Player', layout: 'Level 1', uid: 1, replicaCount: 0 }]);
    expect(data.orphanedReplicaCount).toBe(1);
    expect(data.orphanedReplicas?.[0].sourceTemplateName).toBe('herot');
  });

  it('returns an error result when reading the layouts throws', async () => {
    await setupTemplates();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(reader, 'readAllLayouts').mockRejectedValue(new Error('read failed'));
    const data = await call();
    expect(data.isError).toBe(true);
    expect(data.text).toBe('Error listing templates: read failed');
    expect(log).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('removes an absolute path from the message of an error', async () => {
    await setupTemplates();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(reader, 'readAllLayouts').mockRejectedValue(new Error("EACCES: permission denied, open 'C:\\Users\\Someone Else\\proj\\layouts\\Level 1.json'"));
    const windows = await call();
    expect(windows.text).toBe('Error listing templates: EACCES: permission denied, open \'(path removed)\'');
    vi.spyOn(reader, 'readAllLayouts').mockRejectedValue(new Error('ENOENT: no such file /home/someone/proj/layouts/Level 1.json'));
    const posix = await call();
    expect(posix.text).toBe('Error listing templates: ENOENT: no such file (path removed)');
    vi.restoreAllMocks();
  });

  it('counts a replica for the template of its own object type only', async () => {
    const layout = await readLevel1();
    mark(layout, 1, 'template', 'Shared', '');
    addReplica(layout, 'Enemy', 10, 'Shared');
    await writeLevel1(layout);
    await reader.loadProject();
    resetProjectIndex();

    const data = await call();
    expect(data.templates?.[0].replicaCount).toBe(0);
    expect(data.orphanedReplicaCount).toBe(1);
  });
});

// ─── set_instance_template ────────────────────────────────

const level2Path = () => join(tmpDir, 'layouts', 'Extra', 'Level 2.json');
const readLevel2 = async (): Promise<LayoutFile> => JSON.parse(await readFile(level2Path(), 'utf8')) as LayoutFile;
const playerPath = () => join(tmpDir, 'objectTypes', 'Actors', 'Player.json');
const NOT_WRITTEN = 'Nothing was changed.';

const setCall = async (args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool('set_instance_template', args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const set = (uid: number, mode: string, extra: Record<string, unknown> = {}, layoutName = 'Level 1') =>
  setCall({ layoutName, uid, mode, ...extra });

/** The saved template block of an instance of Level 1, or undefined. */
const blockOf = async (uid: number): Promise<Record<string, unknown> | undefined> => {
  const layout = await readLevel1();
  const all = [...gameLayer(layout).instances, ...(gameLayer(layout).subLayers ?? []).flatMap(l => l.instances), ...(layout['nonworld-instances'] ?? [])];
  return all.find(i => i.uid === uid)?.template as Record<string, unknown> | undefined;
};

const reload = async (): Promise<void> => {
  await reader.loadProject();
  resetProjectIndex();
};

/** Player.json names a default template for new instances. */
async function setDefaultTemplate(name: string): Promise<void> {
  const type = JSON.parse(await readFile(playerPath(), 'utf8')) as Record<string, unknown>;
  type.editorNewInstanceTemplateName = name;
  await writeFile(playerPath(), JSON.stringify(type, null, '\t'));
}

/** The writer's read-back of the named file (such as Level 1.json) fails once, with the text verifyWrittenFile itself throws for a failed read. */
function failReadBackOf(fileName: string): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith(fileName)) {
      failed = true;
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  };
}

const WORLD_STATE = [['x', false], ['y', false], ['z', true], ['w', true], ['h', true], ['d', true], ['a', true], ['o', true], ['c', true],
  ['sx', true], ['sy', true], ['sz', true], ['bm', true], ['sam', true], ['tgs', true], ['twpx', true], ['twpy', true],
  ['twpz', true], ['twpw', true], ['twph', true], ['twpd', true], ['twpa', true], ['dwp', true], ['ssm', true]];

describe('set_instance_template', () => {
  it('builds the full block from the instance\'s own state', async () => {
    const data = await set(1, 'template', { templateName: 'PlayerT' });
    expect(data.success).toBe(true);
    expect(data.action).toBe('template created');
    expect(await blockOf(1)).toEqual({
      mode: 'template',
      templateName: 'PlayerT',
      sourceTemplateName: '',
      replicaHierarchyInSyncWithTemplate: false,
      templatePropagateHierarchyChanges: true,
      replicaIgnoreTemplateHierarchyChanges: false,
      components: [
        {
          id: 'plugin',
          component: [{ key: 'plugin', state: [['initially-visible', true], ['initial-animation', true], ['initial-frame', true], ['enable-collisions', true]] }],
        },
        { id: 'instance-variable', component: [{ key: 'instance-variable', state: [{ iv: 'health', state: true }, { iv: 'name', state: true }] }] },
        {
          id: 'behavior',
          component: [
            { key: 'Platform', state: [['max-speed', true], ['enabled', true]] },
            { key: 'Fade', state: [] },
          ],
        },
        { id: 'effect', component: [{ key: 'Glow', state: [['intensity', true], ['<<effect-template-enable>>', true]] }] },
        { id: 'world-instance', component: [{ key: 'world-instance', state: WORLD_STATE }] },
      ],
      replicasUIDs: null,
    });
  });

  it('makes an instance a template, then a replica of it in another layout', async () => {
    expect((await set(2, 'template', { templateName: 'Boss' })).success).toBe(true);
    const replica = await set(10, 'replica', { sourceTemplateName: 'Boss' }, 'Level 2');
    expect(replica.success).toBe(true);
    expect(replica.action).toBe('replica linked');
    expect(replica.warnings).toBeUndefined();
    expect((await readLevel2()).layers[0].instances[0].template).toMatchObject({ mode: 'replica', templateName: '', sourceTemplateName: 'Boss' });

    await reload();
    const listed = JSON.parse((await server.callTool('list_templates', {})).content[0].text) as ToolData;
    expect(listed.templates).toEqual([{ templateName: 'Boss', objectType: 'Enemy', layout: 'Level 1', uid: 2, replicaCount: 1 }]);
    expect(listed.orphanedReplicas).toBeUndefined();
  });

  it('removes the block with mode none and refuses when there is none', async () => {
    await set(1, 'template', { templateName: 'PlayerT' });
    const removed = await set(1, 'none');
    expect(removed.success).toBe(true);
    expect(removed.action).toBe('template removed');
    expect(await blockOf(1)).toBeUndefined();

    const before = await snapshotProject(tmpDir);
    const refused = await set(1, 'none');
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(`Instance UID 1 in layout "Level 1" has no template block; nothing to remove. ${NOT_WRITTEN}`);
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('refuses a missing templateName or sourceTemplateName before reading anything', async () => {
    const listLayouts = vi.spyOn(reader, 'listLayouts');
    const before = await snapshotProject(tmpDir);
    const noName = await set(1, 'template');
    expect(noName.isError).toBe(true);
    expect(noName.text).toBe(`mode "template" requires templateName. ${NOT_WRITTEN}`);
    const noSource = await set(1, 'replica', { sourceTemplateName: '' });
    expect(noSource.text).toBe(`mode "replica" requires sourceTemplateName. ${NOT_WRITTEN}`);
    expect(listLayouts).not.toHaveBeenCalled();
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('refuses a template name another instance of the object type already has, and allows it for another type', async () => {
    await set(1, 'template', { templateName: 'T' });
    await set(2, 'template', { templateName: 'E' });
    await reload();
    const before = await snapshotProject(tmpDir);

    const sameLayout = await set(3, 'template', { templateName: 'T' });
    expect(sameLayout.isError).toBe(true);
    expect(sameLayout.text).toBe(`Instance UID 1 in layout "Level 1" is already a template named "T" for object type "Player". Template names must be unique per object type. ${NOT_WRITTEN}`);

    const otherLayout = await set(10, 'template', { templateName: 'E' }, 'Level 2');
    expect(otherLayout.isError).toBe(true);
    expect(otherLayout.text).toBe(`Instance UID 2 in layout "Level 1" is already a template named "E" for object type "Enemy". Template names must be unique per object type. ${NOT_WRITTEN}`);
    expect(await snapshotProject(tmpDir)).toEqual(before);

    const otherType = await set(10, 'template', { templateName: 'T' }, 'Level 2');
    expect(otherType.success).toBe(true);

    // Names are compared exactly: a name in another letter case is another name
    const otherCase = await set(3, 'template', { templateName: 't' });
    expect(otherCase.success).toBe(true);
  });

  it('refuses a template or replica block on a non-world instance, naming what the editor did', async () => {
    const before = await snapshotProject(tmpDir);
    const refusal = `Instance UID 4 in layout "Level 1" is a non-world instance. A template or replica block on a non-world instance `
      + 'made Construct 3 r506-2 (Free edition, guest) refuse to open the project ("Failed to open project", '
      + `2 of 2 attempts, checked with the Array object type only), so no block is written. ${NOT_WRITTEN}`;
    const asTemplate = await set(4, 'template', { templateName: 'K' });
    expect(asTemplate.isError).toBe(true);
    expect(asTemplate.text).toBe(refusal);
    const asReplica = await set(4, 'replica', { sourceTemplateName: 'K' });
    expect(asReplica.isError).toBe(true);
    expect(asReplica.text).toBe(refusal);
    expect(await blockOf(4)).toBeUndefined();
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('removes a template block from a non-world instance with mode none', async () => {
    const layout = await readLevel1();
    const nonWorld = layout['nonworld-instances']!.find(i => i.uid === 4)!;
    nonWorld.template = buildInstanceTemplate(nonWorld, 'template', 'K', '') as unknown as Record<string, unknown>;
    await writeLevel1(layout);
    await reload();
    expect(await blockOf(4)).toBeDefined();

    const removed = await set(4, 'none');
    expect(removed.success).toBe(true);
    expect(removed.action).toBe('template removed');
    expect(await blockOf(4)).toBeUndefined();
  });

  it('warns when no template of that name exists for a replica', async () => {
    const orphan = await set(3, 'replica', { sourceTemplateName: 'Nope' });
    expect(orphan.success).toBe(true);
    expect(orphan.warnings).toEqual([
      'No instance of "Player" is a template named "Nope". The replica is written anyway; it has no template to follow until one of that name exists.',
    ]);
    expect(await blockOf(3)).toMatchObject({ mode: 'replica', sourceTemplateName: 'Nope' });

    await set(1, 'template', { templateName: 'PlayerT' });
    await reload();
    const linked = await set(3, 'replica', { sourceTemplateName: 'PlayerT' });
    expect(linked.success).toBe(true);
    expect(linked.warnings).toEqual([expect.stringContaining('existing replica block was rebuilt')]);
  });

  it('says a missing template may be in a layout that could not be parsed', async () => {
    await writeFile(level2Path(), '{ broken');
    await reload();
    const data = await set(3, 'replica', { sourceTemplateName: 'Nope' });
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual([
      expect.stringContaining('No instance of "Player" is a template named "Nope"'),
      'The template may be in a layout that could not be checked. Layouts that could not be parsed: layouts/Level 2 (not valid JSON).',
    ]);
  });

  it('refuses a layout name in another letter case, an unknown layout and an unknown UID', async () => {
    const before = await snapshotProject(tmpDir);
    const variant = await set(1, 'none', {}, 'level 1');
    expect(variant.isError).toBe(true);
    expect(variant.text).toContain('Did you mean "Level 1"?');
    expect(variant.text?.endsWith(NOT_WRITTEN)).toBe(true);

    const unknown = await set(1, 'none', {}, 'Nope');
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Layout "Nope" not found.');
    expect(unknown.text?.endsWith(NOT_WRITTEN)).toBe(true);

    const noUid = await set(999, 'none');
    expect(noUid.isError).toBe(true);
    expect(noUid.text).toBe(`No instance with UID 999 in layout "Level 1". Use get_layout_details to see the instances. ${NOT_WRITTEN}`);
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('refuses a layout it cannot parse', async () => {
    await writeFile(level1Path(), '{ broken');
    await reload();
    const before = await snapshotProject(tmpDir);
    const data = await set(1, 'template', { templateName: 'T' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Cannot read layout "Level 1" (not valid JSON). ${NOT_WRITTEN}`);
    expect(data.text).not.toContain(tmpDir);
    expect(data.text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('warns that layouts it could not parse were not checked for the name', async () => {
    await writeFile(level2Path(), '{ broken');
    await reload();
    const data = await set(1, 'template', { templateName: 'T' });
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual([
      'Whether another instance of "Player" is already a template named "T" could not be checked in every layout. Layouts that could not be parsed: layouts/Level 2 (not valid JSON).',
    ]);
  });

  it('puts the layout back when its read-back fails', async () => {
    const before = await snapshotProject(tmpDir);
    failReadBackOf('Level 1.json');
    const data = await set(1, 'template', { templateName: 'T' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('Post-write verification failed');
    expect(data.text).toContain('The call was rolled back');
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('writes the layout once and backs it up', async () => {
    const write = vi.spyOn(writer, 'writeEntityFile');
    const data = await set(1, 'template', { templateName: 'T' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('layouts');
    expect(write.mock.calls[0][1]).toBe('Level 1');
    expect(data.backupFile).toBeTruthy();
    expect(data.entity).toBe('Level 1#1');
  });

  it('leaves the cached layouts as they were after a refusal', async () => {
    await set(1, 'template', { templateName: 'T' });
    await reload();
    const cachedBefore = await reader.readAllLayouts();
    const copy = structuredClone([...cachedBefore]);
    expect((await set(3, 'template', { templateName: 'T' })).isError).toBe(true);
    expect([...await reader.readAllLayouts()]).toEqual(copy);
  });

  it('refuses a replica of the instance\'s own template', async () => {
    await set(1, 'template', { templateName: 'T' });
    const before = await snapshotProject(tmpDir);
    const data = await set(1, 'replica', { sourceTemplateName: 'T' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Instance UID 1 in layout "Level 1" is the template "T" itself; it cannot be a replica of its own template. ${NOT_WRITTEN}`);
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  describe('what still names a template the call ends', () => {
    const REPLICAS = '2 replica(s) of "Player" follow the template "T", which no instance is any more; list_templates lists them as orphanedReplicas.';
    const DEFAULT = 'Object type "Player" creates new instances from the template "T"; clear or change it with set_default_template.';

    /** Player UID 1 is the template "T"; Player UID 3 (Level 1) and a Player added to Level 2 (UID 20) are its replicas; Player names "T" as its default. */
    async function setupEnded(options: { replicas?: boolean; defaultName?: boolean } = {}): Promise<void> {
      const { replicas = true, defaultName = true } = options;
      await rm(tmpDir, { recursive: true, force: true });
      await cp(FIXTURE_DIR, tmpDir, { recursive: true });
      await reload();
      await set(1, 'template', { templateName: 'T' });
      if (replicas) {
        await set(3, 'replica', { sourceTemplateName: 'T' });
        const level2 = await readLevel2();
        const added = { type: 'Player', uid: 20, sid: 640000000000020, tags: '', properties: {}, instanceVariables: {}, behaviors: {}, world: { x: 0, y: 0, width: 8, height: 8 } } as unknown as Instance;
        added.template = buildInstanceTemplate(added, 'replica', '', 'T') as unknown as Record<string, unknown>;
        level2.layers[0].instances.push(added);
        await writeFile(level2Path(), JSON.stringify(level2, null, '\t'));
      }
      if (defaultName) await setDefaultTemplate('T');
      await reload();
    }

    it('warns for mode none, a new name and a replica of another template', async () => {
      await setupEnded();
      const removed = await set(1, 'none');
      expect(removed.warnings).toEqual([REPLICAS, DEFAULT]);

      await setupEnded();
      const renamed = await set(1, 'template', { templateName: 'U' });
      expect(renamed.warnings).toEqual([expect.stringContaining('existing template block was rebuilt'), REPLICAS, DEFAULT]);

      await setupEnded();
      const replica = await set(1, 'replica', { sourceTemplateName: 'Z' });
      expect(replica.warnings).toEqual([expect.stringContaining('No instance of "Player" is a template named "Z"'), REPLICAS, DEFAULT]);
    });

    it('does not warn for the same name again, or for a template with no replicas and no default', async () => {
      await setupEnded();
      const again = await set(1, 'template', { templateName: 'T' });
      expect(again.warnings).toHaveLength(1);
      expect(again.warnings?.[0]).toContain('existing template block was rebuilt');

      await setupEnded({ replicas: false, defaultName: false });
      const bare = await set(1, 'none');
      expect(bare.success).toBe(true);
      expect(bare.warnings).toBeUndefined();
    });

    it('says the default could not be checked when the object type cannot be read, without a path', async () => {
      await setupEnded({ defaultName: false });
      await writeFile(playerPath(), '{ broken');
      const data = await set(1, 'none');
      expect(data.success).toBe(true);
      expect(data.warnings).toEqual([REPLICAS, 'Whether object type "Player" creates new instances from "T" could not be checked (not valid JSON).']);
      expect(JSON.stringify(data)).not.toContain(tmpDir);
    });

    it('says replicas in a layout it could not parse were not counted', async () => {
      await setupEnded({ replicas: false, defaultName: false });
      await writeFile(level2Path(), '{ broken');
      await reload();
      const data = await set(1, 'none');
      expect(data.warnings).toEqual(['Replicas of "T" in these layouts were not counted. Layouts that could not be parsed: layouts/Level 2 (not valid JSON).']);
    });
  });

  it('warns that an existing block was rebuilt, and not when there was none', async () => {
    const fresh = await set(1, 'template', { templateName: 'T' });
    expect(fresh.warnings).toBeUndefined();
    const again = await set(1, 'template', { templateName: 'T' });
    expect(again.success).toBe(true);
    expect(again.warnings).toEqual([
      'The instance\'s existing template block was rebuilt from its current properties, instance variables, behaviors and effects; sync settings changed in the editor were reset.',
    ]);
  });

  it('refuses with no path in the text when an unexpected error is thrown, before any write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(reader, 'listLayouts').mockRejectedValue(new Error("EACCES: permission denied, scandir 'C:\\Users\\Someone Else\\proj\\layouts'"));
    const write = vi.spyOn(writer, 'writeEntityFile');
    const data = await set(1, 'none');
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Error setting instance template: EACCES: permission denied, scandir '(path removed)'. ${NOT_WRITTEN}`);
    expect(write).not.toHaveBeenCalled();
  });
});

// ─── set_default_template ─────────────────────────────────

const readPlayer = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(playerPath(), 'utf8')) as Record<string, unknown>;
const defCall = async (args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool('set_default_template', args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const NO_PLAYER_T = 'No instance of "Player" is a template named "PlayerT". Create one with set_instance_template first.';

describe('set_default_template', () => {
  it('sets both editor fields, warns while the template does not exist, and not once it does', async () => {
    const data = await defCall({ objectName: 'Player', templateName: 'PlayerT' });
    expect(data.success).toBe(true);
    expect(data.action).toBe('default template set');
    expect(data.entity).toBe('Player');
    expect(data.warnings).toEqual([NO_PLAYER_T]);
    const saved = await readPlayer();
    expect(saved.editorNewInstanceIsReplica).toBe(true);
    expect(saved.editorNewInstanceTemplateName).toBe('PlayerT');

    await set(1, 'template', { templateName: 'PlayerT' });
    await reload();
    const again = await defCall({ objectName: 'Player', templateName: 'PlayerT' });
    expect(again.success).toBe(true);
    expect(again.warnings).toBeUndefined();
  });

  it('clears the default template as the editor saves it', async () => {
    await defCall({ objectName: 'Player', templateName: 'PlayerT' });
    const data = await defCall({ objectName: 'Player', templateName: null });
    expect(data.success).toBe(true);
    expect(data.action).toBe('default template cleared');
    expect(data.warnings).toBeUndefined();
    const saved = await readPlayer();
    expect(saved).not.toHaveProperty('editorNewInstanceTemplateName');
    expect(saved.editorNewInstanceIsReplica).toBe(true);
  });

  it('refuses an unknown object type and a case variant', async () => {
    const before = await snapshotProject(tmpDir);
    const unknown = await defCall({ objectName: 'Nope', templateName: 'T' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Object "Nope" not found.');
    expect(unknown.text?.endsWith(NOT_WRITTEN)).toBe(true);

    const variant = await defCall({ objectName: 'player', templateName: null });
    expect(variant.isError).toBe(true);
    expect(variant.text).toContain('Did you mean "Player"?');
    expect(variant.text?.endsWith(NOT_WRITTEN)).toBe(true);
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('refuses an object type file it cannot parse, with no path in the text', async () => {
    await writeFile(playerPath(), '{ broken');
    await reload();
    const before = await snapshotProject(tmpDir);
    const data = await defCall({ objectName: 'Player', templateName: 'T' });
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Cannot read object type "Player" (not valid JSON). ${NOT_WRITTEN}`);
    expect(data.text).not.toContain(tmpDir);
    expect(data.text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('warns that layouts it could not parse were not checked for the template', async () => {
    await writeFile(level2Path(), '{ broken');
    await reload();
    const data = await defCall({ objectName: 'Player', templateName: 'PlayerT' });
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual([
      NO_PLAYER_T,
      'The template may be in a layout that could not be checked. Layouts that could not be parsed: layouts/Level 2 (not valid JSON).',
    ]);
  });

  it('puts the object type back when its read-back fails', async () => {
    const before = await snapshotProject(tmpDir);
    failReadBackOf('Player.json');
    const data = await defCall({ objectName: 'Player', templateName: 'T' });
    expect(data.isError).toBe(true);
    expect(data.text).toContain('Post-write verification failed');
    expect(data.text).toContain('The call was rolled back');
    expect(await snapshotProject(tmpDir)).toEqual(before);
  });

  it('writes one file, the object type', async () => {
    const write = vi.spyOn(writer, 'writeEntityFile');
    const data = await defCall({ objectName: 'Player', templateName: 'T' });
    expect(data.success).toBe(true);
    expect(data.backupFile).toBeTruthy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('objectTypes');
    expect(write.mock.calls[0][1]).toBe('Player');
  });

  it('rejects an empty template name before reading anything', async () => {
    const listObjectTypes = vi.spyOn(reader, 'listObjectTypes');
    const readObjectType = vi.spyOn(reader, 'readObjectType');
    const write = vi.spyOn(writer, 'writeEntityFile');
    await expect(server.callTool('set_default_template', { objectName: 'Player', templateName: '' })).rejects.toThrow(/templateName/);
    expect(listObjectTypes).not.toHaveBeenCalled();
    expect(readObjectType).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses with no path in the text when an unexpected error is thrown, before any write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(reader, 'listObjectTypes').mockRejectedValue(new Error("EACCES: permission denied, scandir 'C:\\Users\\Someone Else\\proj\\objectTypes'"));
    const write = vi.spyOn(writer, 'writeEntityFile');
    const data = await defCall({ objectName: 'Player', templateName: null });
    expect(data.isError).toBe(true);
    expect(data.text).toBe(`Error setting default template: EACCES: permission denied, scandir '(path removed)'. ${NOT_WRITTEN}`);
    expect(write).not.toHaveBeenCalled();
  });

  it('matches the template name exactly: a name in another letter case is not the template', async () => {
    await set(1, 'template', { templateName: 'PlayerT' });
    await reload();
    const data = await defCall({ objectName: 'Player', templateName: 'playert' });
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual(['No instance of "Player" is a template named "playert". Create one with set_instance_template first.']);
    expect((await readPlayer()).editorNewInstanceTemplateName).toBe('playert');
  });

  describe('the replica count of a template set_instance_template ends', () => {
    it('counts the replicas in the layout as the file is now, not as a cached copy was', async () => {
      await set(1, 'template', { templateName: 'T' });
      await set(3, 'replica', { sourceTemplateName: 'T' });
      await reload();
      // The cached layouts as they were, then the file changed with no reload. A change that keeps
      // the file's size, modification time and file id is not seen by the reader, so its cache
      // keeps the old layout; the stand-in below serves that cache.
      const cached = new Map(structuredClone([...await reader.readAllLayouts()]));
      expect(instanceWithUid(cached.get('Level 1') as unknown as LayoutFile, 3).template).toBeDefined();
      const layout = await readLevel1();
      delete instanceWithUid(layout, 3).template;
      await writeLevel1(layout);
      vi.spyOn(reader, 'readAllLayouts').mockResolvedValue(cached);

      const data = await set(1, 'none');
      expect(data.success).toBe(true);
      expect(data.warnings).toBeUndefined();
    });
  });
});
