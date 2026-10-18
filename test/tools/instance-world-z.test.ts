/**
 * A placed instance's Z elevation is written as world.z (#ISSUE), the key
 * Construct 3 r495.2 saves for instances (one editor-saved project, 47 of 47
 * instances) and keeps when it saves a project (release r506-2), between
 * color and angle; layers keep zElevation. An instance holding
 * world.zElevation (written by version 1.10.0 or older) ends with one Z key,
 * with a warning. Synthetic data on a temp copy of the minimal fixture, with
 * the real reader and writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

interface InstanceJson { uid: number; world: Record<string, number>; [key: string]: unknown }
interface LayoutFile { layers: Array<{ name: string; zElevation?: number; instances: InstanceJson[]; [key: string]: unknown }>; [key: string]: unknown }

let tmpDir: string;
let reader: Construct3ProjectReader;
let server: MockServer;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const readLayout = async (): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(), 'utf8')) as LayoutFile;
const worldOf = async (uid: number) => (await readLayout()).layers[0].instances.find(i => i.uid === uid)!.world;
const call = async (tool: string, args: Record<string, unknown>) => {
  const result = await server.callTool(tool, args);
  return JSON.parse(result.content[0].text) as { success?: boolean; generatedUid?: number; warnings?: string[] };
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-world-z-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerLayoutTools({ server, reader, writer: new Construct3ProjectWriter(reader, idGen), idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('the Z elevation of a placed instance', () => {
  it('add_instance_to_layout writes it as world.z, between color and angle', async () => {
    const data = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 1, y: 2, zElevation: 12 });
    const world = await worldOf(data.generatedUid!);
    expect(world.z).toBe(12);
    expect(world).not.toHaveProperty('zElevation');
    expect(Object.keys(world)).toEqual(['x', 'y', 'width', 'height', 'originX', 'originY', 'color', 'z', 'angle']);
  });

  it('add_instance_to_layout writes world.z 0 when no Z elevation is given', async () => {
    const data = await call('add_instance_to_layout', { layoutName: 'Layout 1', layerName: 'Main', objectType: 'Sprite', x: 1, y: 2 });
    const world = await worldOf(data.generatedUid!);
    expect(world.z).toBe(0);
    expect(world).not.toHaveProperty('zElevation');
  });

  it('update_instance writes it as world.z', async () => {
    await call('update_instance', { layoutName: 'Layout 1', uid: 0, zElevation: 7 });
    const world = await worldOf(0);
    expect(world.z).toBe(7);
    expect(world).not.toHaveProperty('zElevation');
  });

  /** UID 0 as version 1.10.0 or older wrote it: world.zElevation, no z; with `both`, z too. */
  async function oldZ(both = false): Promise<void> {
    const layout = await readLayout();
    const world = layout.layers[0].instances[0].world;
    world.zElevation = 5;
    world.angle = 0;
    if (both) world.z = 3;
    await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
    await reader.loadProject();
  }

  it('update_instance moves an old world.zElevation to world.z in its place, and says so', async () => {
    await oldZ();
    const data = await call('update_instance', { layoutName: 'Layout 1', uid: 0, zElevation: 7 });
    const world = await worldOf(0);
    expect(world.z).toBe(7);
    expect(world).not.toHaveProperty('zElevation');
    expect(Object.keys(world)).toEqual(['x', 'y', 'width', 'height', 'z', 'angle']);
    expect((data.warnings ?? []).join(' ')).toContain('Instance 0 held its Z elevation as world.zElevation (5)');
  });

  it('update_instance leaves one Z key on an instance that had both', async () => {
    await oldZ(true);
    const data = await call('update_instance', { layoutName: 'Layout 1', uid: 0, zElevation: 7 });
    const world = await worldOf(0);
    expect(world.z).toBe(7);
    expect(world).not.toHaveProperty('zElevation');
    expect((data.warnings ?? []).join(' ')).toContain('world.zElevation (5) was removed');
  });

  it('update_layer still writes a layer\'s Z elevation as zElevation', async () => {
    await call('update_layer', { layoutName: 'Layout 1', layerName: 'Main', zElevation: 3 });
    const layer = (await readLayout()).layers[0];
    expect(layer.zElevation).toBe(3);
    expect(layer).not.toHaveProperty('z');
  });
});
