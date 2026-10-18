/**
 * The writer's wrappers of fs errors (#ISSUE): a read-back that fails with an
 * fs error names the file by its path in the project and keeps the fs error
 * as its cause. Synthetic data on a temp copy of the minimal fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter, EntityWriteError } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';

/** The next readFile of this path fails with EACCES (set by the test). */
const failNextRead = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFileOrFail = async (...args: Parameters<typeof actual.readFile>) => {
    if (failNextRead.path !== undefined && String(args[0]) === failNextRead.path) {
      const path = failNextRead.path;
      failNextRead.path = undefined;
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', path });
    }
    return actual.readFile(...args);
  };
  return { ...actual, readFile: readFileOrFail as typeof actual.readFile };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
let tmpDir: string;
let writer: Construct3ProjectWriter;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-writer-fs-errors-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  failNextRead.path = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

describe('the writer\'s read-back of an entity file', () => {
  it('names an fs error by its code and the path in the project, and keeps it as the cause', async () => {
    const path = join(tmpDir, 'objectTypes', 'Sprite.json');
    const obj = JSON.parse(await readFile(path, 'utf8'));
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    // The read-back right after the write fails
    internals.atomicWrite = async (p, content) => {
      await atomicWrite(p, content);
      failNextRead.path = p;
    };
    const error = await writer.writeEntityFile('objectTypes', 'Sprite', { ...obj, isGlobal: !obj.isGlobal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntityWriteError);
    const message = (error as Error).message;
    expect(message).toContain('Post-write verification failed for "Sprite"');
    expect(message).toContain('EACCES on objectTypes/Sprite.json');
    expect(message).not.toContain(tmpDir);
    const wrapper = (error as Error).cause as Error;
    expect((wrapper.cause as { code?: unknown }).code).toBe('EACCES');
  });
});
