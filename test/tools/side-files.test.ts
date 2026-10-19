/**
 * rollBackStructureCall: the rollback of a Project Bar move or copy. The
 * call's writes through the writer and its created files are put back, the
 * created files only once project.c3proj no longer registers what the call
 * added. Synthetic data on a temp copy of the minimal fixture, with the real
 * reader and writer, every call inside a tool call scope as the tools run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { runInToolCall, StaleFileError } from '../../src/construct3/disk-state.js';
import { createFileForCall, newSideWrites } from '../../src/tools/rename-files.js';
import { rollBackStructureCall } from '../../src/tools/side-files.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

const at = (...segments: string[]) => join(dir, ...segments);
const text = (path: string) => readFile(path, 'utf-8');
const back = async () => true;
const notBack = async () => false;

/** The call renames the project through updateProject, as a registration does. */
async function registerInProject(): Promise<void> {
  await writer.updateProject(project => {
    (project as Record<string, unknown>).name = 'Changed by the call';
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-side-files-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  reader = new Construct3ProjectReader(at('project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('rollBackStructureCall', () => {
  it('says Nothing was changed. when nothing was written', async () => {
    await runInToolCall(async () => {
      const message = await rollBackStructureCall(writer, new Error('boom'), newSideWrites(), { projectIsBack: back });
      expect(message).toBe('boom. Nothing was changed.');
    });
  });

  it('removes a created file once project.c3proj is back', async () => {
    await runInToolCall(async () => {
      const side = newSideWrites();
      await createFileForCall(writer, side, at('a.txt'), 'AAA');
      const message = await rollBackStructureCall(writer, new Error('boom'), side, { projectIsBack: back });
      expect(message).toBe('boom. The call was rolled back: a.txt (removed: the call had created it) is as before the call.');
      expect(existsSync(at('a.txt'))).toBe(false);
    });
  });

  it('puts project.c3proj back before it removes a created file', async () => {
    const projectBefore = await text(at('project.c3proj'));
    const events: string[] = [];
    const undoToolCall = writer.undoToolCall.bind(writer);
    vi.spyOn(writer, 'undoToolCall').mockImplementation(async () => {
      events.push('undo began');
      const report = await undoToolCall();
      events.push('undo ended');
      return report;
    });
    const restoreForCall = writer.restoreForCall.bind(writer);
    vi.spyOn(writer, 'restoreForCall').mockImplementation(async (path, content) => {
      events.push('restore began');
      return restoreForCall(path, content);
    });
    await runInToolCall(async () => {
      const side = newSideWrites();
      await registerInProject();
      await createFileForCall(writer, side, at('a.txt'), 'AAA');
      const message = await rollBackStructureCall(writer, new Error('boom'), side, { projectIsBack: back, writing: at('project.c3proj') });
      expect(message).toContain('project.c3proj');
      expect(message).toContain('a.txt (removed: the call had created it)');
      expect(message).not.toContain('rolled back only in part');
      expect(events.indexOf('undo ended')).toBeGreaterThan(-1);
      expect(events.indexOf('undo ended')).toBeLessThan(events.indexOf('restore began'));
      expect(existsSync(at('a.txt'))).toBe(false);
    });
    expect(await text(at('project.c3proj'))).toBe(projectBefore);
  });

  it('keeps a created file while project.c3proj still registers what the call added', async () => {
    await runInToolCall(async () => {
      const side = newSideWrites();
      await createFileForCall(writer, side, at('a.txt'), 'AAA');
      const message = await rollBackStructureCall(writer, new Error('boom'), side, { projectIsBack: notBack });
      expect(await text(at('a.txt'))).toBe('AAA');
      expect(message).toBe('boom. The entity files and project.c3proj are as before the call. Of the other files the call changed: '
        + 'left as it is: a.txt (kept: project.c3proj still registers what this call added, so the file stays). '
        + 'Check the project (validate_project, git diff) before you run the tool again.');
    });
  });

  it('rolls back a stale refusal of the tool\'s own as an ordinary error', async () => {
    const sheetBefore = await text(at('eventSheets', 'MainSheet.json'));
    await runInToolCall(async () => {
      const sheet = await reader.readEventSheet('MainSheet');
      await writer.writeEntityFile('eventSheets', 'MainSheet', { ...sheet, touched: true });
      expect(await text(at('eventSheets', 'MainSheet.json'))).not.toBe(sheetBefore);
      const stale = new StaleFileError('eventSheets/MainSheet.json was changed on disk after this call read it.', 'eventSheets/MainSheet.json');
      const message = await rollBackStructureCall(writer, stale, newSideWrites(), { projectIsBack: back });
      expect(message).toBe('eventSheets/MainSheet.json was changed on disk after this call read it. The call was rolled back: eventSheets/MainSheet.json is as before the call.');
    });
    expect(await text(at('eventSheets', 'MainSheet.json'))).toBe(sheetBefore);
  });

  it('counts a projectIsBack that throws as not back, keeping the file', async () => {
    await runInToolCall(async () => {
      const side = newSideWrites();
      await createFileForCall(writer, side, at('a.txt'), 'AAA');
      const message = await rollBackStructureCall(writer, new Error('boom'), side, {
        projectIsBack: async () => {
          throw new Error('project.c3proj could not be read');
        },
      });
      expect(await text(at('a.txt'))).toBe('AAA');
      expect(message).toContain('a.txt (kept: project.c3proj still registers what this call added, so the file stays)');
    });
  });
});
