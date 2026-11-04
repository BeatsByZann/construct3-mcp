/**
 * What the timeline tools share for writing and refusing: refusals that end
 * "Nothing was changed.", messages without absolute paths, JSON files in the
 * project's text style, and the rollback of a call that wrote several files.
 * Real reader, writer and ID generator on a temp copy of the minimal fixture,
 * which gets a second event sheet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter, ConcurrentWriteError, EntityWriteError, UnconfirmedWriteError } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { runInToolCall, StaleFileError } from '../../src/construct3/disk-state.js';
import {
  refuse,
  invalidName,
  invalidSubfolder,
  readFailure,
  relativeMessage,
  caseHint,
  readFileForWrite,
  readTextIfExists,
  writeJsonFile,
  rollBackToolCall,
  type ChangedFile,
} from '../../src/tools/timeline-writes.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

const projectPath = () => join(dir, 'project.c3proj');
const timeline = (name: string) => join(dir, 'timelines', `${name}.json`);

/** A sheet object read from `eventSheets/<name>.json`. */
async function readSheet(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'eventSheets', `${name}.json`), 'utf-8')) as Record<string, unknown>;
}

/** Load the project in `dir` with a fresh reader and writer. */
async function load(): Promise<void> {
  reader = new Construct3ProjectReader(projectPath());
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-timeline-writes-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const main = await readSheet('MainSheet');
  await writeFile(join(dir, 'eventSheets', 'Second.json'), JSON.stringify({ ...main, name: 'Second' }, null, '\t'));
  const project = JSON.parse(await readFile(projectPath(), 'utf-8')) as { eventSheets: { items: string[] } };
  project.eventSheets.items.push('Second');
  await writeFile(projectPath(), JSON.stringify(project, null, '\t'));
  await mkdir(join(dir, 'timelines'), { recursive: true });
  await load();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('refuse', () => {
  it('ends the message once with "Nothing was changed."', () => {
    for (const text of ['No timeline.', 'No timeline. Nothing was changed.']) {
      const result = refuse(text);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('No timeline. Nothing was changed.');
    }
    expect(refuse('No timeline').content[0].text).toBe('No timeline. Nothing was changed.');
  });
});

describe('invalidName and invalidSubfolder', () => {
  it('return the refusal text instead of throwing', () => {
    expect(invalidName('')).toBe('Name cannot be empty');
    expect(invalidName('Player')).toBeUndefined();
    expect(invalidSubfolder('../escape')).toContain('invalid characters');
    expect(invalidSubfolder('UI/Buttons')).toBeUndefined();
  });
});

describe('relativeMessage', () => {
  it('strips the project folder in both slash styles and leaves a sibling folder alone', () => {
    const forms: Array<[folder: string, separator: string]> = [[dir.replace(/\\/g, '/'), '/'], [dir.replace(/\//g, '\\'), '\\']];
    for (const [folder, separator] of forms) {
      const path = [folder, 'timelines', 'X.json'].join(separator);
      const message = relativeMessage(new Error(`ENOENT: no such file or directory, open '${path}'`), dir);
      expect(message).toBe("ENOENT: no such file or directory, open 'timelines/X.json'");
      expect(message).not.toContain(dir);
    }
    const sibling = `bad ${dir}-other\\f.json`;
    expect(relativeMessage(new Error(sibling), dir)).toBe(sibling);
    expect(relativeMessage(new Error(dir), dir)).toBe('.');
  });
});

describe('readFailure', () => {
  it('words a file system error by its code and a parse error by its text', () => {
    expect(readFailure(Object.assign(new Error('ENOENT: no such file or directory, open C:\\a\\b'), { code: 'ENOENT' }))).toBe('ENOENT');
    let parseError: unknown;
    try {
      JSON.parse('{');
    } catch (error) {
      parseError = error;
    }
    expect(readFailure(parseError)).toBe((parseError as SyntaxError).message);
    expect(readFailure('boom')).toBe('unreadable');
  });
});

describe('caseHint', () => {
  it('names the registered spelling', () => {
    const hint = caseHint('timeline 1', ['Timeline 1']);
    expect(hint).toContain('Did you mean "Timeline 1"?');
    expect(hint).toContain('letter case');
    expect(caseHint('Timeline 1', ['Timeline 1'])).toBeUndefined();
    expect(caseHint('Other', ['Timeline 1'])).toBeUndefined();
  });
});

describe('writeJsonFile', () => {
  it("gives a new file the project's text style and an existing file its own", async () => {
    const original = await readFile(projectPath(), 'utf-8');
    await writeFile(projectPath(), '\uFEFF' + original.replace(/\r?\n/g, '\r\n'));
    await load();

    const fresh = timeline('New');
    expect(await runInToolCall(() => writeJsonFile(writer, fresh, { a: 1 }, projectPath()))).toBeUndefined();
    const freshText = await readFile(fresh, 'utf-8');
    expect(freshText.startsWith('\uFEFF')).toBe(true);
    expect(freshText).toContain('\r\n');

    const lf = timeline('Lf');
    await writeFile(lf, '{\n\t"a": 1\n}\n');
    await runInToolCall(() => writeJsonFile(writer, lf, { a: 2 }, projectPath()));
    const lfText = await readFile(lf, 'utf-8');
    expect(lfText.startsWith('\uFEFF')).toBe(false);
    expect(lfText).not.toContain('\r');
    expect(JSON.parse(lfText)).toEqual({ a: 2 });

    // A second call backs the file up as the first call left it
    expect(await runInToolCall(() => writeJsonFile(writer, fresh, { a: 3 }, projectPath()))).toBe(fresh + '.bak');
    expect(await readFile(fresh + '.bak', 'utf-8')).toBe(freshText);
  });
});

describe('writeJsonFile into a project without a timelines folder', () => {
  it('creates the folders through the writer', async () => {
    await rm(join(dir, 'timelines'), { recursive: true, force: true });
    const nested = join(dir, 'timelines', 'Sub', 'Deep.json');
    expect(await runInToolCall(() => writeJsonFile(writer, nested, { a: 4 }, projectPath()))).toBeUndefined();
    expect(JSON.parse(await readFile(nested, 'utf-8'))).toEqual({ a: 4 });
  });
});

describe('readFileForWrite and readTextIfExists', () => {
  it('makes a later outside save a refusal', async () => {
    const file = timeline('A');
    await writeFile(file, '{"v":1}');
    await runInToolCall(async () => {
      const read = (await readFileForWrite(file))!;
      expect(read.text).toBe('{"v":1}');
      await writeFile(file, '{"outside":true}');
      await expect(writer.replaceFile(file, '{"v":2}', { expected: read.state })).rejects.toBeInstanceOf(StaleFileError);
    });
    expect(await readFile(file, 'utf-8')).toBe('{"outside":true}');
  });

  it('gives null for a missing file, and the raw text with its BOM for an existing one', async () => {
    const file = timeline('A');
    expect(await runInToolCall(() => readFileForWrite(file))).toBeNull();
    expect(await readTextIfExists(file)).toBeNull();
    await writeFile(file, '\uFEFF{"v":1}');
    expect(await readTextIfExists(file)).toBe('\uFEFF{"v":1}');
    expect((await runInToolCall(() => readFileForWrite(file)))?.text).toBe('\uFEFF{"v":1}');
  });
});

describe('rollBackToolCall', () => {
  /** Run `body` in one tool call and return the message it produces. */
  async function inCall(body: () => Promise<string>): Promise<string> {
    return runInToolCall(body);
  }

  /** Create `name` with `text` and read it for a write; the file is recorded as changed. */
  async function prepare(name: string, text: string, changed: ChangedFile[]) {
    const file = timeline(name);
    await writeFile(file, text);
    const read = (await readFileForWrite(file))!;
    changed.push({ path: file, before: read.text });
    return { file, read };
  }

  it('puts back what the call replaced', async () => {
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      await writer.replaceFile(file, '{"v":2}', { expected: read.state });
      return rollBackToolCall(writer, dir, new Error('boom'), changed);
    });
    expect(message).toBe('boom. The call was rolled back: timelines/A.json is as before the call.');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"v":1}');
  });

  it('says "Nothing was changed." when nothing was written', async () => {
    const message = await inCall(() => rollBackToolCall(writer, dir, new Error('boom'), []));
    expect(message).toBe('boom. Nothing was changed.');
  });

  it('leaves a file that changed after the call wrote it, and says so', async () => {
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      await writer.replaceFile(file, '{"v":2}', { expected: read.state });
      await writeFile(file, '{"outside":"text of another length"}');
      return rollBackToolCall(writer, dir, new Error('boom'), changed);
    });
    expect(message).toContain('rolled back only in part');
    expect(message).toContain('not put back: timelines/A.json');
    expect(message).toContain('changed on disk after this call wrote it');
    expect(message.split('timelines/A.json')).toHaveLength(2);
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"outside":"text of another length"}');
  });

  it('puts back a file the same call deleted', async () => {
    await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file } = await prepare('B', '{"b":1}', changed);
      await writer.deleteFile(file);
      expect(existsSync(file)).toBe(false);
      return rollBackToolCall(writer, dir, new Error('boom'), changed);
    });
    expect(await readFile(timeline('B'), 'utf-8')).toBe('{"b":1}');
  });

  it('removes a file the call created', async () => {
    const file = timeline('New');
    await inCall(async () => {
      expect(await readFileForWrite(file)).toBeNull();
      await writer.replaceFile(file, '{"n":1}', { expected: null });
      return rollBackToolCall(writer, dir, new Error('boom'), [{ path: file, before: null }]);
    });
    expect(existsSync(file)).toBe(false);
  });

  it('puts back a failed event sheet write and an earlier one', async () => {
    const mainBefore = await readFile(join(dir, 'eventSheets', 'MainSheet.json'), 'utf-8');
    const secondBefore = await readFile(join(dir, 'eventSheets', 'Second.json'), 'utf-8');
    const internals = writer as unknown as { verifyWrittenFile: (...args: unknown[]) => Promise<void> };
    const verify = internals.verifyWrittenFile.bind(writer);
    vi.spyOn(internals, 'verifyWrittenFile').mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).endsWith('MainSheet.json')) throw new Error('read-back failed');
      return verify(...args);
    });
    const message = await inCall(async () => {
      await writer.writeEntityFile('eventSheets', 'Second', { ...(await readSheet('Second')), note: 'changed' }, undefined);
      try {
        await writer.writeEntityFile('eventSheets', 'MainSheet', { ...(await readSheet('MainSheet')), note: 'changed' }, undefined);
      } catch (error) {
        expect(error).toBeInstanceOf(EntityWriteError);
        return rollBackToolCall(writer, dir, error, []);
      }
      throw new Error('the write did not fail');
    });
    expect(message).toContain('eventSheets/MainSheet.json');
    expect(await readFile(join(dir, 'eventSheets', 'MainSheet.json'), 'utf-8')).toBe(mainBefore);
    expect(await readFile(join(dir, 'eventSheets', 'Second.json'), 'utf-8')).toBe(secondBefore);
  });

  describe('an event sheet write that failed', () => {
    const sheetFile = () => join(dir, 'eventSheets', 'MainSheet.json');

    /** Roll back an EntityWriteError for MainSheet whose cause is `cause`. */
    async function rollBackSheetFailure(cause: Error): Promise<string> {
      return runInToolCall(() => rollBackToolCall(writer, dir, new EntityWriteError(cause, sheetFile() + '.bak'), []));
    }

    it('leaves a sheet that another write replaced, without trying to restore it', async () => {
      const before = await readFile(sheetFile(), 'utf-8');
      const restore = vi.spyOn(writer, 'restoreFailedWrite');
      const message = await rollBackSheetFailure(new ConcurrentWriteError('another write landed'));
      expect(message).toContain('not put back: eventSheets/MainSheet.json (another write replaced it during this one)');
      expect(message).toContain('rolled back only in part');
      expect(restore).not.toHaveBeenCalled();
      expect(await readFile(sheetFile(), 'utf-8')).toBe(before);
    });

    it('names a sheet the writer left as it is, with its reason and backup', async () => {
      vi.spyOn(writer, 'restoreFailedWrite').mockResolvedValue({ restored: false, label: 'eventSheets/MainSheet.json', reason: 'changed' });
      const message = await rollBackSheetFailure(new Error('read-back failed'));
      expect(message).toContain("not put back: eventSheets/MainSheet.json (another write changed it after this call's write failed; its state from before the call is in eventSheets/MainSheet.json.bak)");
      expect(message).not.toContain('is as before the call');
    });

    it('names a sheet whose restore threw, with its backup', async () => {
      vi.spyOn(writer, 'restoreFailedWrite').mockRejectedValue(new Error('EIO'));
      const message = await rollBackSheetFailure(new Error('read-back failed'));
      expect(message).toContain('not put back: eventSheets/MainSheet.json (it could not be put back; its state from before the call is in eventSheets/MainSheet.json.bak)');
      expect(message).not.toContain('is as before the call');
    });
  });

  it('puts back an error thrown after a confirmed write', async () => {
    const original = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new UnconfirmedWriteError('timelines/A.json was changed by another write right after this one');
    });
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      try {
        await writer.replaceFile(file, '{"v":2}', { expected: read.state });
      } catch (error) {
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write did not fail');
    });
    expect(message).toContain('rolled back');
    expect(message).not.toContain('Nothing was changed.');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"v":1}');
  });

  it('does not count a file that was recorded but never written', async () => {
    vi.spyOn(writer, 'replaceFile').mockRejectedValue(new Error('disk full'));
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      try {
        await writer.replaceFile(file, '{"v":2}', { expected: read.state });
      } catch (error) {
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write did not fail');
    });
    expect(message).toBe('disk full. Nothing was changed.');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"v":1}');
  });

  it('does not add "Nothing was changed." after a writer refusal that undid the call', async () => {
    const secondBefore = await readFile(join(dir, 'eventSheets', 'Second.json'), 'utf-8');
    const message = await inCall(async () => {
      await writer.writeEntityFile('eventSheets', 'Second', { ...(await readSheet('Second')), note: 'changed' }, undefined);
      await writeFile(projectPath(), (await readFile(projectPath(), 'utf-8')) + '\n\n');
      try {
        await writer.assertProjectFileCurrent();
      } catch (error) {
        expect(error).toBeInstanceOf(StaleFileError);
        expect((error as StaleFileError).undone).toBe(true);
        return rollBackToolCall(writer, dir, error, []);
      }
      throw new Error('the project file was not refused');
    });
    expect(message).toContain('eventSheets/Second.json');
    expect(message).not.toContain('Nothing was changed.');
    expect(message).not.toContain('rolled back');
    expect(await readFile(join(dir, 'eventSheets', 'Second.json'), 'utf-8')).toBe(secondBefore);
  });

  it("keeps the outside version when the writer's own confirmation sees an outside write", async () => {
    const internals = writer as unknown as { atomicWrite: (...args: unknown[]) => Promise<void> };
    const atomicWrite = internals.atomicWrite.bind(writer);
    vi.spyOn(internals, 'atomicWrite').mockImplementation(async (...args: unknown[]) => {
      await atomicWrite(...args);
      if (String(args[0]).endsWith('A.json')) await writeFile(String(args[0]), '{"outside":"text of another length"}');
    });
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      try {
        await writer.replaceFile(file, '{"v":2}', { expected: read.state });
      } catch (error) {
        expect(error).toBeInstanceOf(UnconfirmedWriteError);
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write did not fail');
    });
    expect(message).toContain('rolled back only in part');
    expect(message).toContain('not put back: timelines/A.json');
    expect(message).not.toContain('Nothing was changed.');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"outside":"text of another length"}');
  });

  it('reports a confirmation that fails before the new state is recorded as not put back', async () => {
    const internals = writer as unknown as { stateIfHolding: (...args: unknown[]) => Promise<unknown> };
    vi.spyOn(internals, 'stateIfHolding').mockRejectedValueOnce(new Error('EIO'));
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      try {
        await writer.replaceFile(file, '{"v":2}', { expected: read.state });
      } catch (error) {
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write did not fail');
    });
    expect(message).toContain('rolled back only in part');
    expect(message).toContain('not put back: timelines/A.json');
    expect(message).not.toContain('Nothing was changed.');
    expect(message).toContain('Check the project');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"v":2}');
    expect(await readFile(timeline('A') + '.bak', 'utf-8')).toBe('{"v":1}');
  });

  it('refuses a created file that another writer created first, and leaves it alone', async () => {
    const file = timeline('New');
    const original = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (...args: Parameters<typeof original>) => {
      await writeFile(file, '{"outside":true}');
      return original(...args);
    });
    const message = await inCall(async () => {
      expect(await readFileForWrite(file)).toBeNull();
      const changed: ChangedFile[] = [{ path: file, before: null }];
      try {
        await writeJsonFile(writer, file, { n: 1 }, projectPath(), null);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleFileError);
        expect((error as StaleFileError).file).toBe('timelines/New.json');
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write was not refused');
    });
    expect(message.endsWith('Nothing was changed.')).toBe(true);
    expect(message).not.toContain('rolled back only in part');
    expect(await readFile(file, 'utf-8')).toBe('{"outside":true}');
    expect(existsSync(file + '.bak')).toBe(false);
  });

  it("leaves the other writer's version after a stale refusal of a replaced file, and says nothing was changed", async () => {
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const { file, read } = await prepare('A', '{"v":1}', changed);
      await writeFile(file, '{"outside":"text of another length"}');
      try {
        await writeJsonFile(writer, file, { v: 2 }, projectPath(), read.state);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleFileError);
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write was not refused');
    });
    expect(message.endsWith('Nothing was changed.')).toBe(true);
    expect(message).not.toContain('not put back');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"outside":"text of another length"}');
  });

  it('puts back an earlier file when the next one is refused as stale, without naming the refused one as not put back', async () => {
    const message = await inCall(async () => {
      const changed: ChangedFile[] = [];
      const b = await prepare('B', '{"b":1}', changed);
      await writeJsonFile(writer, b.file, { b: 2 }, projectPath(), b.read.state);
      const a = await prepare('A', '{"v":1}', changed);
      await writeFile(a.file, '{"outside":"text of another length"}');
      try {
        await writeJsonFile(writer, a.file, { v: 2 }, projectPath(), a.read.state);
      } catch (error) {
        expect(error).toBeInstanceOf(StaleFileError);
        return rollBackToolCall(writer, dir, error, changed);
      }
      throw new Error('the write was not refused');
    });
    expect(message).toContain('timelines/B.json is as before the call');
    expect(message).not.toContain('not put back');
    expect(await readFile(timeline('B'), 'utf-8')).toBe('{"b":1}');
    expect(await readFile(timeline('A'), 'utf-8')).toBe('{"outside":"text of another length"}');
  });
});
