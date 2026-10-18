/** A fault in the change journal's bookkeeping is logged and never changes a tool's result. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { withProjectSync } from '../../src/tools/project-sync.js';

vi.mock('../../src/construct3/change-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/construct3/change-journal.js')>();
  return { ...actual, recordToolCall: () => { throw new Error('journal fault'); } };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
let dir: string;
let server: MockServer;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

/** A layer added to Layout 1 through the writer, as add_layer does it. */
async function writeLayer(name: string): Promise<void> {
  const layout = JSON.parse(await readFile(join(dir, 'layouts', 'Layout 1.json'), 'utf-8'));
  layout.layers.push({ ...layout.layers[0], name, instances: [] });
  await writer.writeEntityFile('layouts', 'Layout 1', layout);
}

/** Whether console.error was called with a message that names the fault. */
function loggedFault(): boolean {
  return vi.mocked(console.error).mock.calls.some(args => args.map(String).join(' ').includes('journal fault'));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-journal-fault-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerMutationTools(server as never, reader, writer, idGen);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a fault in the change journal', () => {
  it('does not turn a write into an error', async () => {
    const added = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    expect(added.isError).toBeFalsy();
    expect(JSON.parse(added.content[0].text).success).toBe(true);
    expect(added.content).toHaveLength(1);
    expect(loggedFault()).toBe(true);
  });

  it('a handler that throws after its write rejects with its own error, not the fault', async () => {
    const synced = withProjectSync(server as never, reader) as unknown as MockServer;
    synced.tool('write_then_throw', 'test only', {}, async () => {
      await writeLayer('Half');
      throw new Error('boom');
    });
    await expect(server.callTool('write_then_throw', {})).rejects.toThrow('boom');
    expect(loggedFault()).toBe(true);
  });
});
