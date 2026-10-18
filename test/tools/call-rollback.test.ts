/**
 * rollBackFailedCall: after a failed write in a tool call, the
 * file whose write failed and the files the call wrote before are put back,
 * a file another write changed since is left as it is and named with its
 * .bak, and the message says what is on disk. Synthetic data on a temp copy
 * of the minimal fixture ("Layout 1", event sheet "MainSheet"), with the
 * real reader and writer, inside a tool call scope as the tools run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { runInToolCall, StaleFileError } from '../../src/construct3/disk-state.js';
import { rollBackFailedCall, writeEntityOrRollBack } from '../../src/tools/call-rollback.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let reader: Construct3ProjectReader;
let writer: Construct3ProjectWriter;

const layoutPath = () => join(tmpDir, 'layouts', 'Layout 1.json');
const sheetPath = () => join(tmpDir, 'eventSheets', 'MainSheet.json');
// failReadBackOf throws the text verifyWrittenFile itself throws (project-writer.ts:752) for a read that fails

/** The writer's read-back of `fileName` fails once with an ordinary error; `before` runs first (an editor save, say). */
function failReadBackOf(fileName: string, before: () => Promise<void> = async () => {}): void {
  const internals = writer as unknown as { verifyWrittenFile: (path: string, name: string, text: string) => Promise<unknown> };
  const verify = internals.verifyWrittenFile.bind(writer);
  let failed = false;
  internals.verifyWrittenFile = async (path, name, text) => {
    if (!failed && path.endsWith(fileName)) {
      failed = true;
      await before();
      throw new Error(`Post-write verification failed for "${name}": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read`);
    }
    return verify(path, name, text);
  };
}

/**
 * One tool call that writes the layout (its layer renamed), then the event
 * sheet (one more key), as a two-file tool does; the rollback's message for
 * the first error, or undefined when both writes went through.
 */
function writeLayoutThenSheet(): Promise<string | undefined> {
  return runInToolCall(async () => {
    try {
      const layout = await reader.readLayout('Layout 1');
      layout.layers[0].name = 'Game';
      await writer.writeEntityFile('layouts', 'Layout 1', layout);
      const sheet = await reader.readEventSheet('MainSheet');
      await writer.writeEntityFile('eventSheets', 'MainSheet', { ...sheet, touched: true });
      return undefined;
    } catch (error) {
      return rollBackFailedCall(writer, error);
    }
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-call-rollback-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  writer = new Construct3ProjectWriter(reader, new IdGenerator());
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('rollBackFailedCall', () => {
  it('puts back the one file whose write failed its read-back', async () => {
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    failReadBackOf('Layout 1.json');
    const message = await writeLayoutThenSheet();
    // The writer's own read-back text (project-writer.ts:752), then what the rollback did
    expect(message).toBe('Post-write verification failed for "Layout 1": file may be corrupted. A .bak backup exists. Error: EIO: i/o error, read. '
      + 'The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
  });

  it('puts back the file whose write failed and the files written before it', async () => {
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    const sheetBefore = await readFile(sheetPath(), 'utf8');
    failReadBackOf('MainSheet.json');
    const message = await writeLayoutThenSheet();
    expect(message).toContain('The call was rolled back: eventSheets/MainSheet.json, layouts/Layout 1.json are as before the call.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
    expect(await readFile(sheetPath(), 'utf8')).toBe(sheetBefore);
  });

  it('leaves a file an editor saved after its failed write as it is, names it with its .bak, and puts back the rest', async () => {
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    const saved = JSON.stringify({ ...(JSON.parse(await readFile(sheetPath(), 'utf8')) as Record<string, unknown>), savedInEditor: true }, null, '\t');
    failReadBackOf('MainSheet.json', () => writeFile(sheetPath(), saved));
    const message = await writeLayoutThenSheet();
    expect(message).toContain('The call was rolled back only in part: put back as they were before the call: layouts/Layout 1.json; '
      + 'left as it is: eventSheets/MainSheet.json (another write changed it after this call\'s write failed; '
      + 'its state from before the call is in eventSheets/MainSheet.json.bak).');
    expect(await readFile(sheetPath(), 'utf8')).toBe(saved);
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
  });

  it('leaves a file the call wrote earlier and the editor saved since as it is, names it, and puts back the failed one', async () => {
    const sheetBefore = await readFile(sheetPath(), 'utf8');
    // A save of another size: undoToolCall tells a changed file by its stamp (mtime, size, inode)
    const savedLayout = JSON.stringify({ ...(JSON.parse(await readFile(layoutPath(), 'utf8')) as Record<string, unknown>), savedInEditor: true }, null, '\t');
    failReadBackOf('MainSheet.json', () => writeFile(layoutPath(), savedLayout));
    const message = await writeLayoutThenSheet();
    expect(message).toContain('The call was rolled back only in part: put back as they were before the call: eventSheets/MainSheet.json; '
      + 'left as they are (changed on disk again after this call wrote them, or their backup was replaced): '
      + 'layouts/Layout 1.json (its state from before the call is in layouts/Layout 1.json.bak).');
    expect(await readFile(layoutPath(), 'utf8')).toBe(savedLayout);
    expect(await readFile(sheetPath(), 'utf8')).toBe(sheetBefore);
  });

  it('names a file whose restore threw, with its .bak, and puts back the rest', async () => {
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    failReadBackOf('MainSheet.json');
    writer.restoreFailedWrite = async () => { throw new Error('EACCES: permission denied'); };
    const message = await writeLayoutThenSheet();
    expect(message).toContain('put back as they were before the call: layouts/Layout 1.json; left as it is: eventSheets/MainSheet.json '
      + '(it could not be put back; its state from before the call is in eventSheets/MainSheet.json.bak).');
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
  });

  it('names no .bak for a file the call created', async () => {
    failReadBackOf('Layout 9.json');
    const message = await runInToolCall(async () => {
      try {
        await writer.writeEntityFile('layouts', 'Layout 9', { name: 'Layout 9', layers: [] }, undefined, { createOnly: true });
        return undefined;
      } catch (error) {
        return rollBackFailedCall(writer, error);
      }
    });
    expect(message).toContain('left as it is: layouts/Layout 9.json (it did not exist before the call; it now holds what this call\'s failed write left there).');
    expect(message).not.toContain('Layout 9.json.bak');
  });

  // The .bak must be the one this call made
  it('never restores a new file from a .bak an earlier call left beside it', async () => {
    const stale = JSON.stringify({ name: 'Layout 9', layers: [], stale: true }, null, '\t');
    await writeFile(join(tmpDir, 'layouts', 'Layout 9.json.bak'), stale);
    failReadBackOf('Layout 9.json');
    const message = await runInToolCall(async () => {
      try {
        await writer.writeEntityFile('layouts', 'Layout 9', { name: 'Layout 9', layers: [] }, undefined, { createOnly: true });
        return undefined;
      } catch (error) {
        return rollBackFailedCall(writer, error);
      }
    });
    expect(message).toContain('left as it is: layouts/Layout 9.json (it did not exist before the call; it now holds what this call\'s failed write left there).');
    expect(await readFile(join(tmpDir, 'layouts', 'Layout 9.json'), 'utf8')).not.toBe(stale);
  });

  it('leaves a file whose .bak another write replaced after this call made it, and names both', async () => {
    failReadBackOf('MainSheet.json', () => writeFile(sheetPath() + '.bak', '{"replacedByAnotherCall":true}'));
    const restore = writer.restoreFailedWrite.bind(writer);
    let restoreCalled = false;
    writer.restoreFailedWrite = async (error) => { restoreCalled = true; return restore(error); };
    const message = await writeLayoutThenSheet();
    expect(message).toContain('left as it is: eventSheets/MainSheet.json (eventSheets/MainSheet.json.bak is no longer the copy this call made '
      + 'before its write, so it is not known to hold the state from before the call)');
    expect(message).not.toContain('MainSheet.json is as before');
    expect(restoreCalled).toBe(false);
  });

  /** The writer's replacement of project.c3proj fails once, as atomicReplace's EEXIST fallback does when its retry fails; `removeFirst`: the old file was deleted first (atomic-write.ts:89-91); `then` runs after that and before the throw (an editor save, say). */
  function failProjectReplace(removeFirst: boolean, then: () => Promise<void> = async () => {}): void {
    const internals = writer as unknown as { atomicWrite: (path: string, content: string | Buffer) => Promise<void> };
    const write = internals.atomicWrite.bind(writer);
    let failed = false;
    internals.atomicWrite = async (path, content) => {
      if (!failed && path.endsWith('project.c3proj')) {
        failed = true;
        if (removeFirst) await rm(path);
        await then();
        throw new Error('EACCES: permission denied, rename');
      }
      return write(path, content);
    };
  }

  /** One tool call that updates project.c3proj and rolls back with `writing`, as the container tools do. */
  function updateProjectOnce(): Promise<string | undefined> {
    return runInToolCall(async () => {
      try {
        await writer.updateProject((project: Record<string, unknown>) => { project.touched = true; });
        return undefined;
      } catch (error) {
        return rollBackFailedCall(writer, error, { writing: reader.getProjectPath() });
      }
    });
  }

  it('says project.c3proj is missing, with its .bak, when its replacement failed after the old file was removed', async () => {
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf8');
    failProjectReplace(true);
    const message = await updateProjectOnce();
    expect(message).toContain('left as it is: project.c3proj (it is missing: its replacement failed after the old file was removed, '
      + 'and the server could not put it back; its state from before the call is in project.c3proj.bak)');
    expect(message).not.toContain('Nothing was changed');
    expect(await readFile(join(tmpDir, 'project.c3proj.bak'), 'utf8')).toBe(before);
  });

  it('says nothing was changed when a project.c3proj replacement failed and the file still holds its state from before the call', async () => {
    failProjectReplace(false);
    expect(await updateProjectOnce()).toBe('EACCES: permission denied, rename. Nothing was changed.');
  });

  it('names project.c3proj with its .bak when its replacement failed and the file holds another write\'s bytes', async () => {
    const projectPath = join(tmpDir, 'project.c3proj');
    const before = await readFile(projectPath, 'utf8');
    const saved = JSON.stringify({ ...(JSON.parse(before) as Record<string, unknown>), savedInEditor: true }, null, '\t');
    failProjectReplace(false, () => writeFile(projectPath, saved));
    const message = await updateProjectOnce();
    expect(message).toContain('left as it is: project.c3proj (its update failed before the server recorded it, '
      + 'so whether it holds this call\'s change is not known; its state from before the call is in project.c3proj.bak)');
    expect(message).not.toContain('Nothing was changed');
    expect(await readFile(projectPath, 'utf8')).toBe(saved);
    expect(await readFile(join(tmpDir, 'project.c3proj.bak'), 'utf8')).toBe(before);
  });

  it('does not call a file put back when its .bak was replaced while the restore ran', async () => {
    const sheetBefore = await readFile(sheetPath(), 'utf8');
    failReadBackOf('MainSheet.json');
    const restore = writer.restoreFailedWrite.bind(writer);
    writer.restoreFailedWrite = async (error) => {
      // Another call backs up the file as this call's failed write left it
      await writeFile(sheetPath() + '.bak', await readFile(sheetPath()));
      return restore(error);
    };
    const message = await writeLayoutThenSheet();
    expect(message).toContain('left as it is: eventSheets/MainSheet.json (it was put back from eventSheets/MainSheet.json.bak, '
      + 'but eventSheets/MainSheet.json.bak was replaced meanwhile, so what it holds is not known)');
    expect(message).not.toContain('MainSheet.json is as before');
    expect(await readFile(sheetPath(), 'utf8')).not.toBe(sheetBefore);
  });

  it('says nothing was changed when the call failed before its first write', async () => {
    // A refusal writeEntityFile throws before it replaces the file (validateJsonData, project-writer.ts:723-725)
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category, ...rest) => {
      if (category === 'layouts') throw new Error('Generated JSON for "Layout 1" is too large (12.0MB > 5MB limit)');
      return write(category, ...rest);
    };
    expect(await writeLayoutThenSheet()).toBe('Generated JSON for "Layout 1" is too large (12.0MB > 5MB limit). Nothing was changed.');
  });

  it('writeEntityOrRollBack writes once, and on a failure throws the rollback\'s message', async () => {
    const layoutBefore = await readFile(layoutPath(), 'utf8');
    failReadBackOf('Layout 1.json');
    const thrown = await runInToolCall(async () => {
      const layout = await reader.readLayout('Layout 1');
      layout.layers[0].name = 'Game';
      return writeEntityOrRollBack(writer, 'layouts', 'Layout 1', layout).then(() => undefined, (error: unknown) => String(error));
    });
    expect(thrown).toContain('The call was rolled back: layouts/Layout 1.json is as before the call.');
    expect(await readFile(layoutPath(), 'utf8')).toBe(layoutBefore);
  });

  it('returns a write refused as stale as the writer worded it', async () => {
    const refusal = new StaleFileError('layouts/Layout 1.json was changed on disk after this server read it. '
      + 'Run the tool again: it reads the file as it is now.', 'layouts/Layout 1.json');
    expect(await runInToolCall(() => rollBackFailedCall(writer, refusal))).toBe(refusal.message);
  });
});
