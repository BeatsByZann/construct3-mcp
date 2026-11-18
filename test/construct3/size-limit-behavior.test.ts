/**
 * What the default size limit allows and refuses (#ISSUE), stated with
 * constants of its own so the same file also runs against the code before the
 * size limit existed: a layout of 7MB is written, a layout over 10MB is
 * refused and nothing is backed up or changed. All data is synthetic: layouts
 * copied from the minimal fixture into a temp directory, padded with spaces,
 * driven through the real reader, writer and layout tools.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const MB = 1024 * 1024;
const SLOW = 60_000;

interface InstanceJson { tags?: string; [key: string]: unknown }
interface LayoutFile { name: string; layers: Array<{ name: string; instances: InstanceJson[] }>; [key: string]: unknown }
interface ToolData { isError?: boolean; text?: string; success?: boolean; [key: string]: unknown }

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let server: MockServer;

const layoutPath = (name = 'Layout 1') => join(tmpDir, 'layouts', `${name}.json`);
const readLayoutFile = async (): Promise<LayoutFile> => JSON.parse(await readFile(layoutPath(), 'utf8')) as LayoutFile;
const call = async (tool: string, args: Record<string, unknown>): Promise<ToolData> => {
  const result = await server.callTool(tool, args);
  return result.isError ? { isError: true, text: result.content[0].text } : JSON.parse(result.content[0].text) as ToolData;
};
const rename = (newName: string) => call('update_layer', { layoutName: 'Layout 1', layerName: 'Main', newName });

/** A copy of "Layout 1" named `name` whose first instance's tags are padded with spaces so its tab-indented JSON is `size` characters. */
async function layoutOfSize(name: string, size: number): Promise<LayoutFile> {
  const layout = await readLayoutFile();
  layout.name = name;
  layout.layers[0].instances[0].tags = '';
  const base = JSON.stringify(layout, null, '\t').length;
  layout.layers[0].instances[0].tags = ' '.repeat(size - base);
  expect(JSON.stringify(layout, null, '\t').length).toBe(size);
  return layout;
}

/** Puts a layout of `size` characters in place of "Layout 1" on disk and returns its bytes. */
async function placeLayoutOfSize(size: number): Promise<Buffer> {
  const layout = await layoutOfSize('Layout 1', size);
  await writeFile(layoutPath(), JSON.stringify(layout, null, '\t'));
  reader.invalidateCaches();
  return readFile(layoutPath());
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-size-behavior-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerLayoutTools({ server, reader, writer, idGen } as never);
  resetProjectIndex();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('the default size limit on writes', () => {
  it('changes an existing layout of 7MB', async () => {
    await placeLayoutOfSize(7 * MB);
    const data = await rename('Game');
    expect(data.text).toBeUndefined();
    expect(data.success).toBe(true);
    expect((await readLayoutFile()).layers[0].name).toBe('Game');
  }, SLOW);

  it('writes a new layout of 7MB', async () => {
    const layout = await layoutOfSize('Big', 7 * MB);
    await writer.writeEntityFile('layouts', 'Big', layout);
    expect(existsSync(layoutPath('Big'))).toBe(true);
    expect((await readFile(layoutPath('Big'))).length).toBeGreaterThanOrEqual(7 * MB);
  }, SLOW);

  it('refuses a new layout over 10MB and writes nothing', async () => {
    const layout = await layoutOfSize('Huge', 12 * MB);
    await expect(writer.writeEntityFile('layouts', 'Huge', layout)).rejects.toThrow(/too large/);
    expect(existsSync(layoutPath('Huge'))).toBe(false);
    expect(existsSync(`${layoutPath('Huge')}.bak`)).toBe(false);
  }, SLOW);

  it('refuses to replace a layout with one over 10MB, backing nothing up and leaving the layout as it was', async () => {
    const before = await readFile(layoutPath());
    const layout = await layoutOfSize('Layout 1', 12 * MB);
    await expect(writer.writeEntityFile('layouts', 'Layout 1', layout)).rejects.toThrow(/too large/);
    expect(Buffer.compare(await readFile(layoutPath()), before)).toBe(0);
    expect(existsSync(`${layoutPath()}.bak`)).toBe(false);
  }, SLOW);

  it('refuses to change a layout over 10MB through a tool and leaves it with no backup', async () => {
    const before = await placeLayoutOfSize(12 * MB);
    const data = await rename('Game');
    expect(data.isError).toBe(true);
    expect(Buffer.compare(await readFile(layoutPath()), before)).toBe(0);
    expect(existsSync(`${layoutPath()}.bak`)).toBe(false);
  }, SLOW);

  it('refuses to read a layout over 10MB, naming the limit', async () => {
    await placeLayoutOfSize(12 * MB);
    // The outcome as text: a layout that was read must not reach the assertion's failure message, where printing 12MB hangs the reporter
    const outcome = await reader.readLayout('Layout 1').then(() => 'was read', (error: Error) => error.message);
    expect(outcome).toContain('exceeds 10MB');
  }, SLOW);
});
