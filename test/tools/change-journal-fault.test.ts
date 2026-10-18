/** A fault in the change journal's bookkeeping is logged and never changes a tool's result. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockServer } from '../mocks/mock-server.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerMutationTools } from '../../src/tools/mutations.js';

vi.mock('../../src/construct3/change-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/construct3/change-journal.js')>();
  return { ...actual, recordToolCall: () => { throw new Error('journal fault'); } };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
let dir: string;
let server: MockServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-journal-fault-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  server = new MockServer();
  registerMutationTools(server as never, reader, new Construct3ProjectWriter(reader, idGen), idGen);
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
  });
});
