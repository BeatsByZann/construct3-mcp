/**
 * A file system error whose message spells out absolute paths (the file in
 * the project, and one outside it) is reported without either: the path in
 * the project is named relative to it, the other by a placeholder. Covered
 * here: a failed write in each family of tools that writes (renames,
 * timelines, flowcharts, project files, tilemap brushes, the runtime
 * bridge), and a failed read reported by a rename and by a read tool. The
 * deletes are covered in delete-registration-order.test.ts. Real reader,
 * writer and ID generator on a copy of a fixture; all data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { registerTilemapBrushTools } from '../../src/tools/tilemap-brush-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';
import { makeTilemapProject } from '../helpers/tilemap-project.js';

// writeFile passes through unless a test faults it (the runtime bridge writes its files with it)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const OUTSIDE = 'D:\\Elsewhere\\held.json';
const AUTO16 = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, null]];

let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let runtime: { close(): Promise<void> } | undefined;

/** An fs-style error with a code, whose message names `path` and a path outside the project. */
function fsError(path: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, copyfile '${OUTSIDE}' -> '${path}'`), { code: 'EPERM' });
}

/** Every write of the writer fails with fsError for the file it writes. */
function writesFail(): void {
  const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
  vi.spyOn(internals, 'atomicWrite').mockImplementation(async (path) => { throw fsError(path); });
}

/** Every read of a project file whose path ends with `suffix` fails with fsError for that file. */
function readsFail(suffix: string): void {
  const internals = reader as unknown as { readProjectFileWithState: (path: string) => Promise<{ text: string; state: unknown }> };
  const read = internals.readProjectFileWithState.bind(reader);
  vi.spyOn(internals, 'readProjectFileWithState').mockImplementation(async (path) => {
    if (path.replace(/\\/g, '/').endsWith(suffix)) throw fsError(path);
    return read(path);
  });
}

async function open(prepare: (folder: string) => Promise<void>): Promise<void> {
  resetProjectIndex();
  dir = await mkdtemp(join(tmpdir(), 'c3-error-paths-'));
  await prepare(dir);
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerQueryTools(server as never, reader);
  registerMutationTools(server as never, reader, writer, idGen);
  registerTilemapBrushTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  runtime = registerRuntimeTools({ server: server as never, reader, writer });
}

async function call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await server.callTool(tool, args);
  return { isError: result.isError === true, text: result.content.map(c => c.text).join('\n') };
}

/** The result is an error that names the fs code and no absolute path. */
function expectNoAbsolutePath(result: { isError: boolean; text: string }): void {
  expect(result.isError, result.text).toBe(true);
  expect(result.text).toContain('EPERM');
  expect(result.text).not.toContain(dir);
  expect(result.text).not.toContain(dir.replace(/\\/g, '/'));
  expect(result.text).not.toContain('Elsewhere');
  expect(result.text).not.toMatch(/[A-Za-z]:[\\/]|\\\\/);
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Back to the real writeFile after a test that faulted it
  vi.mocked(writeFile).mockReset();
  await runtime?.close();
  runtime = undefined;
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('a failed write names no absolute path', () => {
  beforeEach(() => open(folder => cp(FIXTURE_DIR, folder, { recursive: true })));

  it('rename_layout', async () => {
    writesFail();
    expectNoAbsolutePath(await call('rename_layout', { name: 'Layout 1', newName: 'Title' }));
  });

  it('create_timeline', async () => {
    writesFail();
    expectNoAbsolutePath(await call('create_timeline', { name: 'Intro' }));
  });

  it('create_flowchart', async () => {
    writesFail();
    expectNoAbsolutePath(await call('create_flowchart', { name: 'Graph' }));
  });

  it('create_data_file', async () => {
    writesFail();
    expectNoAbsolutePath(await call('create_data_file', { name: 'grid.json', kind: 'array', arraySize: [2, 2, 1] }));
  });

  it('inject_runtime_bridge', async () => {
    vi.mocked(writeFile).mockImplementation(async (path) => { throw fsError(String(path)); });
    writesFail();
    expectNoAbsolutePath(await call('inject_runtime_bridge', {}));
  });
});

describe('a failed read names no absolute path', () => {
  beforeEach(() => open(folder => cp(FIXTURE_DIR, folder, { recursive: true })));

  it('rename_layer', async () => {
    readsFail('layouts/Layout 1.json');
    const result = await call('rename_layer', { layoutNames: ['Layout 1'], layerName: 'Main', newName: 'Game' });
    expectNoAbsolutePath(result);
    expect(result.text).toContain('\'<a path outside the project>\' -> \'layouts/Layout 1.json\'');
  });

  it('get_layout_details', async () => {
    readsFail('layouts/Layout 1.json');
    const result = await call('get_layout_details', { name: 'Layout 1' });
    expectNoAbsolutePath(result);
    expect(result.text).toContain('\'<a path outside the project>\' -> \'layouts/Layout 1.json\'');
  });
});

describe('a failed brush write names no absolute path', () => {
  beforeEach(() => open(makeTilemapProject));

  it('add_tilemap_brush', async () => {
    writesFail();
    expectNoAbsolutePath(await call('add_tilemap_brush', { objectName: 'Tiles', name: 'New', type: 'auto16', data: AUTO16 }));
  });
});
