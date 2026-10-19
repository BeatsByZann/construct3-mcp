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
  complete?: boolean; unscannedFiles?: Array<{ file: string; reason: string }>; warnings?: string[];
}

let tmpDir: string;
let reader: Construct3ProjectReader;
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
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTemplateTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
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
