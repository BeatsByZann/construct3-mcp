/**
 * The side writes of a rename (rename-files.ts): files read for a replace or
 * a move, the rollback of failed side writes, the editor's view-state files,
 * the files a stopped rename leaves, and the messages that join a rollback's
 * parts. Synthetic data on a temp copy of the minimal fixture, with the real
 * reader and writer, every call inside a tool call scope as the tools run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { currentToolCall, fileKey, runInToolCall, StaleFileError, statFileState } from '../../src/construct3/disk-state.js';
import {
  assertUnchangedSinceRead,
  createFileForCall,
  entityFileSegments,
  joinRollbackMessages,
  jsQuotedNamePattern,
  moveFileForRename,
  moveViewStateFiles,
  newFileState,
  newSideWrites,
  putBackSideWrites,
  readForRename,
  reasonOf,
  replaceForRename,
  rollBackRename,
  scriptFileUses,
  stoppedRename,
  type ReadForRename,
  type RenameSideWrites,
} from '../../src/tools/rename-files.js';

const hooks = vi.hoisted(() => ({ beforeFind: undefined as undefined | (() => Promise<void>) }));

// Lets a test run a step (an editor save, say) right before the next case-insensitive file lookup
vi.mock('../../src/construct3/atomic-write.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/construct3/atomic-write.js')>();
  return {
    ...original,
    findFileIgnoringCase: async (path: string) => {
      const step = hooks.beforeFind;
      hooks.beforeFind = undefined;
      await step?.();
      return original.findFileIgnoringCase(path);
    },
  };
});

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

const at = (...segments: string[]) => join(dir, ...segments);
const sheetPath = () => at('eventSheets', 'MainSheet.json');
const text = (path: string) => readFile(path, 'utf-8');

/** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
async function editorSave(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  const { mtime } = await stat(path);
  const later = new Date(mtime.getTime() + 2000);
  await utimes(path, later, later);
}

async function load(): Promise<void> {
  reader = new Construct3ProjectReader(at('project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
}

/** The call writes the event sheet (as a rename writes the entity files first). */
async function writeMainSheet(): Promise<void> {
  const sheet = await reader.readEventSheet('MainSheet');
  await writer.writeEntityFile('eventSheets', 'MainSheet', { ...sheet, touched: true });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-rename-files-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  await load();
});

afterEach(async () => {
  vi.restoreAllMocks();
  hooks.beforeFind = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('entityFileSegments and reasonOf', () => {
  it('spells an entity file in its folders', () => {
    expect(entityFileSegments('layouts', undefined, 'Stage')).toEqual(['layouts', 'Stage.json']);
    expect(entityFileSegments('objectTypes', 'Enemies/Bosses', 'Hero')).toEqual(['objectTypes', 'Enemies', 'Bosses', 'Hero.json']);
  });

  it('words an fs error by its code and the project-relative path, and any other error by its message', () => {
    const relative = (path: string) => `rel:${path}`;
    expect(reasonOf(Object.assign(new Error('EACCES: permission denied, open C:\\secret\\x'), { code: 'EACCES', path: 'C:\\secret\\x' }), relative))
      .toBe('EACCES on rel:C:\\secret\\x');
    expect(reasonOf(new Error('It broke.'), relative)).toBe('It broke');
    expect(reasonOf('plain', relative)).toBe('plain');
  });
});

describe('readForRename', () => {
  it('gives a missing file no state and no bytes, and an existing one its bytes and state', async () => {
    await runInToolCall(async () => {
      const missing = await readForRename(at('nothing.txt'));
      expect(missing).toEqual({ path: at('nothing.txt'), state: null, bytes: null });
      await writeFile(at('some.txt'), 'some bytes');
      const read = await readForRename(at('some.txt'));
      expect(read.bytes).toEqual(Buffer.from('some bytes'));
      expect(read.state).toEqual(await statFileState(at('some.txt')));
      // The running call holds that state, which the writer's own checks under the file's lock compare the file with
      expect(currentToolCall()?.reads.get(fileKey(at('some.txt')))).toEqual(read.state);
      expect(currentToolCall()?.reads.get(fileKey(at('nothing.txt')))).toBeNull();
    });
  });
});

describe('replaceForRename', () => {
  it('writes the content and records the bytes from before', async () => {
    await writeFile(at('side.txt'), 'one');
    await runInToolCall(async () => {
      const side = newSideWrites();
      const read = await readForRename(at('side.txt'));
      await replaceForRename(writer, side, read, 'two');
      expect(await text(at('side.txt'))).toBe('two');
      expect(side.files).toEqual([{ path: at('side.txt'), before: Buffer.from('one') }]);
    });
  });

  it('refuses a file an editor saved after it was read, keeps the save and records nothing', async () => {
    await writeFile(at('side.txt'), 'one');
    await runInToolCall(async () => {
      const side = newSideWrites();
      const read = await readForRename(at('side.txt'));
      await editorSave(at('side.txt'), 'saved by the editor');
      await expect(replaceForRename(writer, side, read, 'two')).rejects.toThrow(StaleFileError);
      expect(await text(at('side.txt'))).toBe('saved by the editor');
      expect(side.files).toEqual([]);
      expect(side.unresolved).toEqual([]);
    });
  });
});

describe('moveFileForRename', () => {
  it('writes the new path, deletes the old one with a .bak, and records both steps', async () => {
    await writeFile(at('a.txt'), 'AAA');
    await runInToolCall(async () => {
      const side = newSideWrites();
      const from = await readForRename(at('a.txt'));
      await moveFileForRename(writer, side, from, at('b.txt'));
      expect(await text(at('b.txt'))).toBe('AAA');
      expect(existsSync(at('a.txt'))).toBe(false);
      expect(await text(at('a.txt.bak'))).toBe('AAA');
      expect(side.files).toEqual([{ path: at('b.txt'), before: null }, { path: at('a.txt'), before: Buffer.from('AAA') }]);
    });
  });

  it('refuses when a file appeared at the new path, leaving the old file and recording nothing', async () => {
    await writeFile(at('a.txt'), 'AAA');
    await runInToolCall(async () => {
      const side = newSideWrites();
      const from = await readForRename(at('a.txt'));
      await writeFile(at('b.txt'), 'someone else');
      await expect(moveFileForRename(writer, side, from, at('b.txt'))).rejects.toThrow(StaleFileError);
      expect(await text(at('a.txt'))).toBe('AAA');
      expect(await text(at('b.txt'))).toBe('someone else');
      expect(side.files).toEqual([]);
    });
  });

  it('refuses the delete of an old file an editor saved after it was read, naming it, after the new file was recorded', async () => {
    await writeFile(at('a.txt'), 'AAA');
    await runInToolCall(async () => {
      const side = newSideWrites();
      const from = await readForRename(at('a.txt'));
      await editorSave(at('a.txt'), 'saved by the editor');
      const refusal = await moveFileForRename(writer, side, from, at('b.txt')).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(StaleFileError);
      expect((refusal as StaleFileError).message).toContain('a.txt was changed on disk after this call read it.');
      expect(await text(at('a.txt'))).toBe('saved by the editor');
      expect(side.files).toEqual([{ path: at('b.txt'), before: null }]);
    });
  });

  it('refuses the delete of an old file saved right before the writer takes the file lock, and keeps the save', async () => {
    await writeFile(at('a.txt'), 'AAA');
    const deleteFile = writer.deleteFile.bind(writer);
    vi.spyOn(writer, 'deleteFile').mockImplementation(async (path, options) => {
      await editorSave(path, 'saved between the check and the lock');
      return deleteFile(path, options);
    });
    await runInToolCall(async () => {
      const side = newSideWrites();
      const from = await readForRename(at('a.txt'));
      await expect(moveFileForRename(writer, side, from, at('b.txt'))).rejects.toThrow(StaleFileError);
      expect(await text(at('a.txt'))).toBe('saved between the check and the lock');
    });
  });

  it('throws for a file that does not exist', async () => {
    await runInToolCall(async () => {
      const from = await readForRename(at('missing.txt'));
      await expect(moveFileForRename(writer, newSideWrites(), from, at('b.txt'))).rejects.toThrow('missing.txt does not exist, so it cannot be moved.');
    });
  });
});

describe('createFileForCall', () => {
  it('creates a file and records it for the rollback', async () => {
    await runInToolCall(async () => {
      const side = newSideWrites();
      await createFileForCall(writer, side, at('new.txt'), 'NEW');
      expect(await text(at('new.txt'))).toBe('NEW');
      expect(side.files).toEqual([{ path: at('new.txt'), before: null }]);
      expect(side.unresolved).toEqual([]);
    });
  });

  it('refuses a file that is there and records nothing', async () => {
    await writeFile(at('there.txt'), 'THERE');
    await runInToolCall(async () => {
      const side = newSideWrites();
      await expect(createFileForCall(writer, side, at('there.txt'), 'NEW')).rejects.toThrow(StaleFileError);
      expect(side.files).toEqual([]);
      expect(side.unresolved).toEqual([]);
      expect(await text(at('there.txt'))).toBe('THERE');
    });
  });

  it('records a create whose write failed after it wrote the file, so the rollback removes it', async () => {
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await replaceFile(path, content, options);
      throw new Error('A check after the write failed.');
    });
    await runInToolCall(async () => {
      const side = newSideWrites();
      await expect(createFileForCall(writer, side, at('new.txt'), 'NEW')).rejects.toThrow('A check after the write failed.');
      expect(side.files).toEqual([{ path: at('new.txt'), before: null }]);
      const result = await putBackSideWrites(writer, side);
      expect(existsSync(at('new.txt'))).toBe(false);
      expect(result.left).toEqual([]);
      expect(result.putBack).toEqual(['new.txt (removed: the call had created it)']);
    });
  });
});

describe('failed side writes, rolled back', () => {
  /** The call writes the event sheet, runs `step` (a failing side write) and rolls back; returns the message. */
  function failingCall(step: (side: RenameSideWrites) => Promise<void>): Promise<string> {
    return runInToolCall(async () => {
      const side = newSideWrites();
      await writeMainSheet();
      try {
        await step(side);
      } catch (error) {
        return rollBackRename(writer, error, side);
      }
      throw new Error('the step was expected to fail');
    });
  }

  it('writes a file back that the writer removed before its replacement failed', async () => {
    await writeFile(at('side.txt'), 'before');
    const sheetBefore = await text(sheetPath());
    vi.spyOn(writer, 'replaceFile').mockImplementation(async path => {
      await unlink(path);
      throw new Error('Replacing failed.');
    });
    const message = await failingCall(async side => replaceForRename(writer, side, await readForRename(at('side.txt')), 'after'));
    expect(await text(at('side.txt'))).toBe('before');
    expect(await text(sheetPath())).toBe(sheetBefore);
    expect(message).toBe('Replacing failed. The call was rolled back: eventSheets/MainSheet.json is as before the call. Also as before the call: side.txt.');
  });

  it('puts back a file the writer changed before a later check failed', async () => {
    await writeFile(at('side.txt'), 'before');
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await replaceFile(path, content, options);
      throw new Error('A check after the write failed.');
    });
    const message = await failingCall(async side => replaceForRename(writer, side, await readForRename(at('side.txt')), 'after'));
    expect(await text(at('side.txt'))).toBe('before');
    expect(message).toContain('Also as before the call: side.txt.');
  });

  it('leaves the bytes another write put there, and names the file with its backup', async () => {
    await writeFile(at('side.txt'), 'before');
    const replaceFile = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await replaceFile(path, content, options);
      await writeFile(path, 'bytes of another write');
      throw new Error('Replacing failed.');
    });
    const sheetBefore = await text(sheetPath());
    const message = await failingCall(async side => replaceForRename(writer, side, await readForRename(at('side.txt')), 'after'));
    expect(await text(at('side.txt'))).toBe('bytes of another write');
    expect(await text(sheetPath())).toBe(sheetBefore);
    expect(message).toContain("left as it is: side.txt (its write or delete failed, and it now holds bytes that are neither this call's nor those from before it; "
      + 'its state from before the call is in side.txt.bak)');
    expect(message).not.toContain('Nothing was changed.');
  });

  it('removes the new file and keeps the old one when the delete of a move fails', async () => {
    await writeFile(at('a.txt'), 'AAA');
    vi.spyOn(writer, 'deleteFile').mockRejectedValue(new Error('Deleting failed.'));
    const sheetBefore = await text(sheetPath());
    const message = await failingCall(async side => moveFileForRename(writer, side, await readForRename(at('a.txt')), at('b.txt')));
    expect(existsSync(at('b.txt'))).toBe(false);
    expect(await text(at('a.txt'))).toBe('AAA');
    expect(await text(sheetPath())).toBe(sheetBefore);
    expect(message).toContain('b.txt (removed: the call had created it)');
  });

  it('writes the old file back when its delete removed it and then failed', async () => {
    await writeFile(at('a.txt'), 'AAA');
    vi.spyOn(writer, 'deleteFile').mockImplementation(async path => {
      await unlink(path);
      throw new Error('Deleting failed.');
    });
    const sheetBefore = await text(sheetPath());
    const message = await failingCall(async side => moveFileForRename(writer, side, await readForRename(at('a.txt')), at('b.txt')));
    expect(existsSync(at('b.txt'))).toBe(false);
    expect(await text(at('a.txt'))).toBe('AAA');
    expect(await text(sheetPath())).toBe(sheetBefore);
    expect(message).toContain('The call was rolled back');
    expect(message).toContain('a.txt');
    expect(message).toContain('b.txt (removed: the call had created it)');
    expect(message).not.toContain('left as it is');
  });
});

describe('moveViewStateFiles', () => {
  const from = ['layouts', 'Layout 1.uistate.json'];
  const to = ['layouts', 'Stage.uistate.json'];

  beforeEach(async () => {
    await writeFile(at(...from), '{"scroll":1}');
  });

  it('moves a file and returns the labels of the move', async () => {
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to }]));
    expect(result).toEqual({ moved: [{ from: 'layouts/Layout 1.uistate.json', to: 'layouts/Stage.uistate.json' }], warnings: [] });
    expect(await text(at(...to))).toBe('{"scroll":1}');
    expect(existsSync(at(...from))).toBe(false);
  });

  it('skips a missing file without a warning', async () => {
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from: ['layouts', 'Nothing.uistate.json'], to }]));
    expect(result).toEqual({ moved: [], warnings: [] });
    expect(existsSync(at(...to))).toBe(false);
  });

  it('leaves a file whose new name holds other bytes, with a warning naming the taken file', async () => {
    await writeFile(at(...to), '{"scroll":2}');
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to }]));
    expect(result.moved).toEqual([]);
    expect(result.warnings).toEqual(["The editor's view state layouts/Layout 1.uistate.json was left as it is: layouts/Stage.uistate.json already exists."]);
    expect(await text(at(...from))).toBe('{"scroll":1}');
    expect(await text(at(...to))).toBe('{"scroll":2}');
  });

  it('deletes only the old name when the new name holds the same bytes', async () => {
    await writeFile(at(...to), '{"scroll":1}');
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to }]));
    expect(result.moved).toEqual([{ from: 'layouts/Layout 1.uistate.json', to: 'layouts/Stage.uistate.json' }]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(at(...from))).toBe(false);
    expect(await text(at(...to))).toBe('{"scroll":1}');
  });

  it('keeps an old name an editor saved after it was read, with a warning that names it', async () => {
    await writeFile(at(...to), '{"scroll":1}');
    hooks.beforeFind = () => editorSave(at(...from), '{"scroll":99,"saved":true}');
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to }]));
    expect(result.moved).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('layouts/Layout 1.uistate.json could not be moved to layouts/Stage.uistate.json');
    expect(result.warnings[0]).toContain('layouts/Layout 1.uistate.json was changed on disk after this call read it');
    expect(await text(at(...from))).toBe('{"scroll":99,"saved":true}');
  });

  it('keeps an old name an editor saved between the early check and the writer\'s delete, with a warning that names it', async () => {
    await writeFile(at(...to), '{"scroll":1}');
    const deleteFile = writer.deleteFile.bind(writer);
    vi.spyOn(writer, 'deleteFile').mockImplementation(async (path, options) => {
      await editorSave(path, '{"scroll":99,"saved":true}');
      return deleteFile(path, options);
    });
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to }]));
    expect(result.moved).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('layouts/Layout 1.uistate.json could not be moved to layouts/Stage.uistate.json');
    expect(result.warnings[0]).toContain('layouts/Layout 1.uistate.json');
    expect(await text(at(...from))).toBe('{"scroll":99,"saved":true}');
    expect(await text(at(...to))).toBe('{"scroll":1}');
  });

  it('applies the rewrite to the text of the moved file', async () => {
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to, rewrite: content => content.replace('scroll', 'pan') }]));
    expect(result.moved).toHaveLength(1);
    expect(await text(at(...to))).toBe('{"pan":1}');
  });

  it('rewrites a file in place when the new name is its own, and moves nothing when the rewrite changes nothing', async () => {
    const changed = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to: from, rewrite: content => content.replace('scroll', 'pan') }]));
    expect(changed.moved).toEqual([{ from: 'layouts/Layout 1.uistate.json', to: 'layouts/Layout 1.uistate.json' }]);
    expect(await text(at(...from))).toBe('{"pan":1}');
    const unchanged = await runInToolCall(() => moveViewStateFiles(writer, dir, [{ from, to: from, rewrite: content => content }]));
    expect(unchanged).toEqual({ moved: [], warnings: [] });
  });

  it('warns with the error code and the project-relative path, never the absolute path, and moves the next file', async () => {
    await writeFile(at('layouts', 'Second.uistate.json'), '{"scroll":3}');
    vi.spyOn(writer, 'replaceFile').mockRejectedValueOnce(Object.assign(new Error(`EACCES: permission denied, open '${at(...to)}'`), { code: 'EACCES', path: at(...to) }));
    const result = await runInToolCall(() => moveViewStateFiles(writer, dir, [
      { from, to },
      { from: ['layouts', 'Second.uistate.json'], to: ['layouts', 'Renamed.uistate.json'] },
    ]));
    expect(result.warnings).toEqual([
      "The editor's view state layouts/Layout 1.uistate.json could not be moved to layouts/Stage.uistate.json "
      + '(EACCES on layouts/Stage.uistate.json); Construct 3 starts a new one where it is missing.',
    ]);
    expect(result.warnings[0]).not.toContain(dir);
    expect(result.moved).toEqual([{ from: 'layouts/Second.uistate.json', to: 'layouts/Renamed.uistate.json' }]);
    expect(await text(at('layouts', 'Renamed.uistate.json'))).toBe('{"scroll":3}');
  });
});

describe('rollBackRename', () => {
  it('puts back a replaced side file and the entity file, and says so in one sentence each', async () => {
    await mkdir(at('timelines'));
    await writeFile(at('timelines', 'Intro.json'), 'timeline from before');
    const sheetBefore = await text(sheetPath());
    const message = await runInToolCall(async () => {
      const side = newSideWrites();
      await writeMainSheet();
      await replaceForRename(writer, side, await readForRename(at('timelines', 'Intro.json')), 'timeline renamed');
      return rollBackRename(writer, new Error('disk full'), side);
    });
    expect(await text(at('timelines', 'Intro.json'))).toBe('timeline from before');
    expect(await text(sheetPath())).toBe(sheetBefore);
    expect(message).toBe('disk full. The call was rolled back: eventSheets/MainSheet.json is as before the call. Also as before the call: timelines/Intro.json.');
  });

  it('says the side file is as before the call, without "Nothing was changed.", when no entity file was written', async () => {
    await writeFile(at('side.txt'), 'before');
    const message = await runInToolCall(async () => {
      const side = newSideWrites();
      await replaceForRename(writer, side, await readForRename(at('side.txt')), 'after');
      return rollBackRename(writer, new Error('disk full'), side);
    });
    expect(await text(at('side.txt'))).toBe('before');
    expect(message).toBe('disk full. The call was rolled back: side.txt is as before the call.');
    expect(message).not.toContain('Nothing was changed.');
  });

  it('keeps a side file an editor saved after the call wrote it, names it with its backup, and ends with the check sentence', async () => {
    await writeFile(at('side.txt'), 'before');
    const message = await runInToolCall(async () => {
      const side = newSideWrites();
      await replaceForRename(writer, side, await readForRename(at('side.txt')), 'after');
      await editorSave(at('side.txt'), 'saved by the editor');
      return rollBackRename(writer, new Error('disk full'), side);
    });
    expect(await text(at('side.txt'))).toBe('saved by the editor');
    expect(message).toContain('left as it is: side.txt (');
    expect(message).toContain('its state from before the call is in side.txt.bak');
    expect(message.endsWith(' Check the project (validate_project, git diff) before you run the tool again.')).toBe(true);
    expect(message).not.toContain('Nothing was changed.');
  });

  it('names a side file left after its backup was replaced by another write', async () => {
    await writeFile(at('side.txt'), 'before');
    const message = await runInToolCall(async () => {
      const side = newSideWrites();
      await replaceForRename(writer, side, await readForRename(at('side.txt')), 'after');
      await editorSave(at('side.txt'), 'saved by the editor');
      await editorSave(at('side.txt.bak'), 'a backup of another write, of another length');
      return rollBackRename(writer, new Error('disk full'), side);
    });
    expect(message).toContain('side.txt.bak is no longer the copy this call made');
  });

  it('puts the entity file back when the writer refused a side file as stale after the entity write', async () => {
    await writeFile(at('side.txt'), 'before');
    const sheetBefore = await text(sheetPath());
    const message = await runInToolCall(async () => {
      const side = newSideWrites();
      await writeMainSheet();
      const read = await readForRename(at('side.txt'));
      await editorSave(at('side.txt'), 'saved by the editor');
      try {
        await replaceForRename(writer, side, read, 'after');
      } catch (error) {
        return rollBackRename(writer, error, side);
      }
      throw new Error('the replace was expected to be refused');
    });
    expect(await text(sheetPath())).toBe(sheetBefore);
    expect(await text(at('side.txt'))).toBe('saved by the editor');
    expect(message).toContain('eventSheets/MainSheet.json is as before the call');
  });

  it('renames the image files back, last first with from and to swapped, and names the by-hand renames when that fails', async () => {
    const renames = [{ from: 'a.png', to: 'b.png' }, { from: 'c.png', to: 'd.png' }];
    const back = [{ from: 'd.png', to: 'c.png' }, { from: 'b.png', to: 'a.png' }];
    const renameImageFiles = vi.spyOn(writer, 'renameImageFiles').mockResolvedValue(undefined);
    const putBack = await runInToolCall(async () => {
      const side = newSideWrites();
      side.imageRenames.push(...renames);
      return rollBackRename(writer, new Error('disk full'), side);
    });
    expect(renameImageFiles).toHaveBeenCalledWith(back);
    expect(putBack).toBe('disk full. The call was rolled back: images/ (2 file(s) the call renamed, renamed back) is as before the call.');

    renameImageFiles.mockRejectedValue(new Error('Renaming failed.'));
    const left = await runInToolCall(async () => {
      const side = newSideWrites();
      side.imageRenames.push(...renames);
      return rollBackRename(writer, new Error('disk full'), side);
    });
    expect(left).toContain('rename them back by hand: images/d.png to images/c.png, images/b.png to images/a.png');
  });
});

describe('newFileState', () => {
  const entityDir = () => at('eventSheets');

  it('is free without a file', async () => {
    expect(await newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', 1)).toEqual({ state: 'free' });
  });

  it('recognizes the file a stopped run wrote: the new name spelled exactly, with the entity SID, read for the write over it', async () => {
    await writeFile(join(entityDir(), 'Fresh.json'), JSON.stringify({ name: 'Fresh', events: [], sid: 77 }));
    const result = await runInToolCall(() => newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', 77));
    expect(result.state).toBe('stopped-run');
    const { read } = result as { read: ReadForRename };
    expect(read.path).toBe(join(entityDir(), 'Fresh.json'));
    expect(read.state).toEqual(await statFileState(read.path));
    expect(JSON.parse((read.bytes as Buffer).toString('utf-8')).sid).toBe(77);
  });

  it('is another file when the SID differs, is missing, the file does not parse, or the name is spelled in another case', async () => {
    const refusal = (result: { state: string }) => (result as { refusal?: string }).refusal;
    await writeFile(join(entityDir(), 'Fresh.json'), JSON.stringify({ name: 'Fresh', events: [], sid: 78 }));
    const otherSid = await runInToolCall(() => newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', 77));
    expect(otherSid.state).toBe('other');
    expect(refusal(otherSid)).toBe(await writer.entityFileRefusal('eventSheets', 'Fresh'));

    expect((await runInToolCall(() => newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', undefined))).state).toBe('other');

    await writeFile(join(entityDir(), 'Fresh.json'), JSON.stringify({ name: 'Fresh', events: [] }));
    expect((await runInToolCall(() => newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', 77))).state).toBe('other');

    await writeFile(join(entityDir(), 'Fresh.json'), '{ not json');
    expect((await runInToolCall(() => newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', 77))).state).toBe('other');

    await rm(join(entityDir(), 'Fresh.json'));
    // Same name inside and the same SID: only the spelling of the file name tells it from the file a stopped run wrote
    await writeFile(join(entityDir(), 'FRESH.json'), JSON.stringify({ name: 'Fresh', events: [], sid: 77 }));
    const otherCase = await runInToolCall(() => newFileState(reader, writer, 'eventSheets', undefined, 'Fresh', 77));
    expect(otherCase.state).toBe('other');
  });
});

describe('stoppedRename', () => {
  const entityDir = () => at('eventSheets');
  const write = (name: string, data: unknown) => writeFile(join(entityDir(), `${name}.json`), typeof data === 'string' ? data : JSON.stringify(data));

  it('finds the entity under its new name and the old file beside it with the same SID', async () => {
    await write('Renamed', { name: 'Renamed', events: [], sid: 5 });
    await write('Old', { name: 'Old', events: [], sid: 5 });
    const result = await runInToolCall(() => stoppedRename(reader, writer, 'eventSheets', 'Old', 'Renamed'));
    expect(result?.current.sid).toBe(5);
    expect(result?.oldRead.path).toBe(join(entityDir(), 'Old.json'));
    expect(result?.oldRead.bytes).toEqual(await readFile(join(entityDir(), 'Old.json')));
  });

  it('finds nothing when only the .bak holds the old entity, which is what a finished rename leaves', async () => {
    await write('Renamed', { name: 'Renamed', events: [], sid: 5 });
    await writeFile(join(entityDir(), 'Old.json.bak'), JSON.stringify({ name: 'Old', events: [], sid: 5 }));
    expect(await runInToolCall(() => stoppedRename(reader, writer, 'eventSheets', 'Old', 'Renamed'))).toBeUndefined();
  });

  it('finds nothing when the old file holds another SID, the new name cannot be read, or it has no numeric SID', async () => {
    await write('Renamed', { name: 'Renamed', events: [], sid: 5 });
    await write('Old', { name: 'Old', events: [], sid: 6 });
    expect(await runInToolCall(() => stoppedRename(reader, writer, 'eventSheets', 'Old', 'Renamed'))).toBeUndefined();

    expect(await runInToolCall(() => stoppedRename(reader, writer, 'eventSheets', 'Old', 'Unwritten'))).toBeUndefined();

    await write('Renamed', { name: 'Renamed', events: [] });
    await write('Old', { name: 'Old', events: [] });
    expect(await runInToolCall(() => stoppedRename(reader, writer, 'eventSheets', 'Old', 'Renamed'))).toBeUndefined();
  });
});

describe('assertUnchangedSinceRead', () => {
  it('passes for a file as read, and refuses one saved or deleted since, naming it', async () => {
    await writeFile(at('side.txt'), 'before');
    await runInToolCall(async () => {
      const read = await readForRename(at('side.txt'));
      await expect(assertUnchangedSinceRead(writer, read)).resolves.toBeUndefined();
      await editorSave(at('side.txt'), 'saved by the editor');
      const saved = await assertUnchangedSinceRead(writer, read).catch((error: unknown) => error);
      expect(saved).toBeInstanceOf(StaleFileError);
      expect((saved as StaleFileError).message).toBe('side.txt was changed on disk after this call read it. It was left as it is.');
      await unlink(at('side.txt'));
      await expect(assertUnchangedSinceRead(writer, read)).rejects.toThrow(StaleFileError);
    });
  });
});

describe('joinRollbackMessages', () => {
  const check = 'Check the project (validate_project, git diff) before you run the tool again.';
  const cores = {
    nothing: 'X. Nothing was changed.',
    rolledBack: 'X. The call was rolled back: a is as before the call.',
    partial: `X. The call was rolled back only in part: put back as they were before the call: a; left as it is: b (c). ${check}`,
  };
  const none = { putBack: [], left: [] };
  const allPutBack = { putBack: ['f.txt'], left: [] };
  const oneLeft = { putBack: ['f.txt'], left: ['g.txt (EACCES on g.txt; its state from before the call is in g.txt.bak)'] };
  const leftTail = 'Of the other files the call changed: as before the call: f.txt; '
    + `left as it is: g.txt (EACCES on g.txt; its state from before the call is in g.txt.bak). ${check}`;

  it.each([
    ['nothing changed', cores.nothing, none, 'X. Nothing was changed.'],
    ['nothing changed', cores.nothing, allPutBack, 'X. The call was rolled back: f.txt is as before the call.'],
    ['nothing changed', cores.nothing, oneLeft, `X. The entity files and project.c3proj are as before the call. ${leftTail}`],
    ['rolled back', cores.rolledBack, none, 'X. The call was rolled back: a is as before the call.'],
    ['rolled back', cores.rolledBack, allPutBack, 'X. The call was rolled back: a is as before the call. Also as before the call: f.txt.'],
    ['rolled back', cores.rolledBack, oneLeft, `X. The call was rolled back: a is as before the call. ${leftTail}`],
    ['partial', cores.partial, none, cores.partial],
    ['partial', cores.partial, allPutBack, `${cores.partial} Also as before the call: f.txt.`],
    ['partial', cores.partial, oneLeft, `X. The call was rolled back only in part: put back as they were before the call: a; left as it is: b (c). ${leftTail}`],
  ])('joins a core that says %s with its extras', (_name, core, extras, expected) => {
    const joined = joinRollbackMessages(core, extras);
    expect(joined).toBe(expected);
    if (extras.left.length > 0) expect(joined).not.toContain('Nothing was changed.');
    expect(joined.split(check).length - 1).toBeLessThanOrEqual(1);
  });

  it('drops the stale-file advice to run the tool again when a side file is left, closing with the check sentence once', async () => {
    await writeFile(at('side.txt'), 'before');
    const stale = await runInToolCall(async () => {
      const read = await readForRename(at('side.txt'));
      await editorSave(at('side.txt'), 'saved by the editor');
      return replaceForRename(writer, newSideWrites(), read, 'after').then(() => 'not refused', (error: unknown) => (error as Error).message);
    });
    expect(stale).toContain('Run the tool again: it reads the file as it is now.');
    const joined = joinRollbackMessages(stale, oneLeft);
    expect(joined).not.toContain('Run the tool again');
    expect(joined.endsWith(check)).toBe(true);
    expect(joined.split(check).length - 1).toBe(1);
  });
});

describe('jsQuotedNamePattern and scriptFileUses', () => {
  it('finds the name in a JavaScript string literal of any quote, ignoring case, and not a longer name', () => {
    const pattern = jsQuotedNamePattern('Level 2');
    expect(pattern.test('goToLayout("level 2")')).toBe(true);
    expect(pattern.test("'Level 2'")).toBe(true);
    expect(pattern.test('`Level 2`')).toBe(true);
    expect(pattern.test('"Level 22"')).toBe(false);
  });

  it('lists the matching lines of the registered script files, and names a registered file that cannot be read', async () => {
    const project = JSON.parse(await text(at('project.c3proj'))) as Record<string, any>;
    project.rootFileFolders.script = {
      items: [{ name: 'main.js', type: 'text/javascript', sid: 1 }, { name: 'gone.js', type: 'text/javascript', sid: 2 }],
      subfolders: [{ items: [{ name: 'util.js', type: 'text/javascript', sid: 3 }], subfolders: [], name: 'lib' }],
    };
    await writeFile(at('project.c3proj'), JSON.stringify(project, null, '\t'));
    await mkdir(at('scripts', 'lib'), { recursive: true });
    await writeFile(at('scripts', 'main.js'), 'start();\r\n  goToLayout("level 2");\r\n');
    await writeFile(at('scripts', 'lib', 'util.js'), "const name = 'Level 2';\nconst other = \"Level 22\";\n");
    await load();
    const pattern = jsQuotedNamePattern('Level 2');
    const result = await scriptFileUses(reader, line => pattern.test(line));
    expect(result.lines).toEqual([
      { path: 'scripts/main.js', line: 'goToLayout("level 2");' },
      { path: 'scripts/lib/util.js', line: "const name = 'Level 2';" },
    ]);
    expect(result.unreadable).toEqual(['scripts/gone.js']);
  });
});
