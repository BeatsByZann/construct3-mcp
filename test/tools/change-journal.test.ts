/**
 * The change journal through the tools (real reader, writer and ID
 * generator on a copy of the minimal fixture: event sheet MainSheet, layout
 * "Layout 1", object Sprite): the line each result ends with, list_changes
 * and revert_last_change.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { fileKey } from '../../src/construct3/disk-state.js';
import { journalEntries } from '../../src/construct3/change-journal.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { withProjectSync } from '../../src/tools/project-sync.js';
import { toolError, toolResult } from '../../src/tools/shared.js';
import { gate, letOthersRun, track } from '../helpers/barrier.js';
import { snapshotProject } from '../helpers/project-snapshot.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;
let runtime: { close(): Promise<void> };

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function ok(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await server.callTool(tool, args);
  expect(result.isError, `${tool}: ${result.content[0].text}`).toBeFalsy();
  return result;
}

function parse(result: Result): any {
  return JSON.parse(result.content[0].text);
}

async function layoutText(): Promise<string> {
  return readFile(join(dir, 'layouts', 'Layout 1.json'), 'utf-8');
}

/** A layer added to Layout 1 through the writer, as add_layer does it. */
async function writeLayer(name: string): Promise<void> {
  const layout = JSON.parse(await layoutText());
  layout.layers.push({ ...layout.layers[0], name, instances: [] });
  await writer.writeEntityFile('layouts', 'Layout 1', layout);
}

/** Every project file with its SHA-256, backups and temp files aside. */
const snapshot = () => snapshotProject(dir);

/** Hold the writer's next put-back of `path` inside its lock (revert_last_change) until `release` opens. */
function holdNextPutBackOf(path: string): { reached: ReturnType<typeof gate>; release: ReturnType<typeof gate> } {
  const reached = gate();
  const release = gate();
  const internals = writer as unknown as { putBack: (c: { path: string }, s: unknown) => Promise<false | { state: unknown }> };
  const original = internals.putBack.bind(writer);
  let held = false;
  vi.spyOn(internals, 'putBack').mockImplementation(async (change, state) => {
    if (!held && fileKey(change.path) === fileKey(path)) {
      held = true;
      reached.open();
      await release.opened;
    }
    return original(change, state);
  });
  return { reached, release };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-change-journal-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerQueryTools(server as never, reader);
  registerMutationTools(server as never, reader, writer, idGen);
  runtime = registerRuntimeTools({ server: server as never, reader, writer });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the files a call changed', () => {
  it('end the result, after the JSON', async () => {
    const added = await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    expect(parse(added).success).toBe(true);
    expect(added.content.at(-1)?.text)
      .toBe('Changed 1 file(s): layouts/Layout 1.json (1 with a .bak backup; revert_last_change undoes this call).');
  });

  it('name every file of a call that wrote several', async () => {
    const line = (await ok('create_layout', { name: 'Temp' })).content.at(-1)?.text ?? '';
    expect(line.startsWith('Changed 2 file(s): ')).toBe(true);
    expect(line).toContain('layouts/Temp.json');
    expect(line).toContain('project.c3proj');
  });

  it('are not named by a read-only call or an error result', async () => {
    expect((await ok('list_layouts')).content).toHaveLength(1);
    const failed = await server.callTool('add_layer', { layoutName: 'No Such Layout', layerName: 'HUD' });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
  });

  it('an error result after a write is recorded but carries no line', async () => {
    const synced = withProjectSync(server as never, reader) as unknown as MockServer;
    synced.tool('write_then_fail', 'test only', {}, async () => {
      await writeLayer('Half');
      return toolError('Failed after writing.');
    });
    expect((await server.callTool('write_then_fail', {})).content).toHaveLength(1);
    expect(journalEntries(reader).map(e => e.tool)).toEqual(['write_then_fail']);
  });

  it('a call made inside another tool call is recorded with that call, once', async () => {
    const synced = withProjectSync(server as never, reader) as unknown as MockServer;
    synced.tool('outer', 'test only', {}, async () => {
      const inner = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
      expect(inner.content).toHaveLength(1);
      return toolResult({ done: true });
    });
    const outer = await server.callTool('outer', {});
    expect(outer.content.at(-1)?.text).toContain('layouts/Layout 1.json');
    expect(journalEntries(reader).map(e => e.tool)).toEqual(['outer']);
  });
});
