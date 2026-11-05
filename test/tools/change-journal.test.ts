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
import { Construct3ProjectWriter, EntityWriteError } from '../../src/construct3/project-writer.js';
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

describe('list_changes', () => {
  it('lists a write with its backup, and a create with the project.c3proj update, newest first', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    await ok('create_layout', { name: 'Temp' });
    const { calls } = parse(await ok('list_changes'));
    expect(calls.map((c: any) => c.tool)).toEqual(['create_layout', 'add_layer']);
    expect(calls[1]).toMatchObject({
      reverted: false,
      changes: [{ kind: 'write', file: 'layouts/Layout 1.json', backup: 'layouts/Layout 1.json.bak' }],
    });
    expect(calls[0].changes.map((c: any) => [c.kind, c.file])).toEqual(expect.arrayContaining([
      ['create', 'layouts/Temp.json'], ['write', 'project.c3proj'],
    ]));
    expect(parse(await ok('list_changes', { limit: 1 })).calls).toHaveLength(1);
  });

  it('does not list a call whose failed entity write restoreFailedWrite put back', async () => {
    await ok('create_layout', { name: 'Temp' });
    const before = await layoutText();
    const internals = writer as unknown as { verifyWrittenFile: () => Promise<void> };
    vi.spyOn(internals, 'verifyWrittenFile').mockRejectedValueOnce(new Error('Post-write verification failed for "Layout 1"'));
    const synced = withProjectSync(server as never, reader) as unknown as MockServer;
    synced.tool('write_check_fails_restored', 'test only', {}, async () => {
      try {
        await writeLayer('HUD');
      } catch (error) {
        if (!(error instanceof EntityWriteError)) throw error;
        return toolError(`restored: ${(await writer.restoreFailedWrite(error)).restored}`);
      }
      return toolError('expected a failed check');
    });
    const failed = await server.callTool('write_check_fails_restored', {});
    expect(failed.content[0].text).toBe('restored: true');
    expect(await layoutText()).toBe(before);
    expect(parse(await ok('list_changes')).calls.map((c: { tool: string }) => c.tool)).toEqual(['create_layout']);
  });

  it('takes a limit from 1 to 50', async () => {
    await expect(server.callTool('list_changes', { limit: 0 })).rejects.toThrow();
    await expect(server.callTool('list_changes', { limit: 51 })).rejects.toThrow();
  });

  it('says "Error listing changes:" with a full stop when the listing fails', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    (journalEntries(reader)[0] as { changes: unknown }).changes = undefined;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await server.callTool('list_changes', {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe('Error listing changes: an unexpected error (details are in the server log).');
    expect(logged).toHaveBeenCalledWith('[list_changes] failed:', expect.any(TypeError));
  });

  it('writes nothing, so it is not listed itself and ends with no changed-files line', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    const listed = await ok('list_changes');
    expect(listed.content).toHaveLength(1);
    expect(parse(await ok('list_changes')).calls.map((c: any) => c.tool)).toEqual(['add_layer']);
  });
});

describe('revert_last_change', () => {
  it('restores a write, shows the call as reverted, and says when nothing is left', async () => {
    const before = await layoutText();
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });

    const reverted = parse(await ok('revert_last_change'));
    expect(reverted.success).toBe(true);
    expect(reverted.restored).toEqual([{ file: 'layouts/Layout 1.json', how: 'restored from layouts/Layout 1.json.bak' }]);
    expect(reverted.reverted).toMatchObject({ tool: 'add_layer', reverted: true });
    expect(await layoutText()).toBe(before);
    expect(parse(await ok('get_layout_details', { name: 'Layout 1' })).layers.map((l: any) => l.name)).not.toContain('HUD');

    const again = await server.callTool('revert_last_change', {});
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toBe('No tool call of this server has changed a file yet, or every such call was already reverted.');
  });

  it('is not a journal entry itself: no changed-files line, not listed, and the next revert goes on to the call before', async () => {
    const before = await snapshot();
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    await ok('create_layout', { name: 'Temp' });

    const first = await ok('revert_last_change');
    expect(first.content).toHaveLength(1);
    expect(journalEntries(reader).map(e => e.tool)).toEqual(['create_layout', 'add_layer']);
    expect(parse(await ok('list_changes')).calls.map((c: any) => [c.tool, c.reverted])).toEqual([['create_layout', true], ['add_layer', false]]);

    const second = parse(await ok('revert_last_change'));
    expect(second.reverted).toMatchObject({ id: 1, tool: 'add_layer' });
    expect(await snapshot()).toEqual(before);
    expect(journalEntries(reader).map(e => e.tool)).toEqual(['create_layout', 'add_layer']);
  });

  it('returns every file of a call that touched several to its state before the call', async () => {
    const before = await snapshot();
    await ok('create_object', { name: 'Keys', pluginId: 'Keyboard' });
    expect(await snapshot()).not.toEqual(before);
    const reverted = parse(await ok('revert_last_change'));
    expect(reverted.reverted.tool).toBe('create_object');
    expect(reverted.notRestored).toBeUndefined();
    expect(reverted.restored.map((r: any) => r.file)).toEqual(expect.arrayContaining(['objectTypes/Keys.json', 'project.c3proj']));
    expect(await snapshot()).toEqual(before);
  });

  it('restores a deleted layout file and its registration', async () => {
    await ok('create_layout', { name: 'Temp' });
    const file = join(dir, 'layouts', 'Temp.json');
    const content = await readFile(file, 'utf-8');
    await ok('delete_layout', { name: 'Temp' });
    expect(parse(await ok('revert_last_change')).success).toBe(true);
    expect(await readFile(file, 'utf-8')).toBe(content);
    expect(parse(await ok('list_layouts')).layouts.map((l: any) => l.name ?? l)).toContain('Temp');
  });

  it('reverts an entity write whose post-write check failed and that the tool did not restore', async () => {
    const before = await layoutText();
    const internals = writer as unknown as { verifyWrittenFile: () => Promise<void> };
    vi.spyOn(internals, 'verifyWrittenFile').mockRejectedValueOnce(new Error('Post-write verification failed for "Layout 1"'));
    const synced = withProjectSync(server as never, reader) as unknown as MockServer;
    synced.tool('write_check_fails', 'test only', {}, async () => {
      try {
        await writeLayer('HUD');
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
      return toolError('expected a failed check');
    });
    await server.callTool('write_check_fails', {});
    expect(parse(await ok('list_changes')).calls[0].tool).toBe('write_check_fails');
    expect(parse(await ok('revert_last_change')).success).toBe(true);
    expect(await layoutText()).toBe(before);
  });

  it('refuses an earlier call whose backup the reverted call replaced, with the backup text', async () => {
    await ok('create_layout', { name: 'Temp' });
    await ok('create_layout', { name: 'Temp2' });
    expect(parse(await ok('revert_last_change')).reverted.tool).toBe('create_layout');
    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe('The last change (call 1, create_layout) cannot be reverted: its backup(s) project.c3proj.bak no longer '
      + 'hold the state from before that call (a later call backed the same file(s) up again, since one backup per file is kept, or the '
      + 'backup was changed by hand). Nothing was restored. Only the most recent call that changed a file can be reverted.');
  });

  it('refuses after the editor saved a file the call wrote, and keeps that save', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    const layout = JSON.parse(await layoutText());
    layout.layers.push({ ...layout.layers[0], name: 'FromEditor', sid: 777000000000001, instances: [] });
    const saved = JSON.stringify(layout, null, '\t');
    await writeFile(join(dir, 'layouts', 'Layout 1.json'), saved, 'utf-8');
    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe('The last change (call 1, add_layer) cannot be reverted: layouts/Layout 1.json changed after that call by '
      + 'something the change journal does not record (Construct, another program, or a tool write outside the journal), so restoring the '
      + 'backups would not return the project to its state before the call. Nothing was restored. Restore the .bak files by hand if that is '
      + 'still what you want.');
    expect(await layoutText()).toBe(saved);
  });

  it('refuses when only the modification time of the file moved', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    const written = await layoutText();
    await utimes(join(dir, 'layouts', 'Layout 1.json'), new Date(), new Date(Date.now() + 5000));
    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('layouts/Layout 1.json changed after that call');
    expect(await layoutText()).toBe(written);
  });

  it('refuses when the backup was replaced', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    await writeFile(join(dir, 'layouts', 'Layout 1.json.bak'), await layoutText(), 'utf-8');
    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('its backup(s) layouts/Layout 1.json.bak no longer hold the state from before that call');
  });

  it('says "Could not revert:" with the error code when the revert itself fails', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    vi.spyOn(writer, 'afterRevert').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await server.callTool('revert_last_change', {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe('Could not revert: EACCES');
    expect(logged).toHaveBeenCalledWith('[revert_last_change] failed:', expect.objectContaining({ code: 'EACCES' }));
  });

  it('finishes a revert that stopped part way on the next call', async () => {
    const before = await snapshot();
    await ok('create_layout', { name: 'Temp' });
    const original = writer.putBackChange.bind(writer);
    let failed = false;
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => {
      if (!failed && change.label === 'layouts/Temp.json') {
        failed = true;
        return { done: false };
      }
      return original(change, asLeft);
    });
    const first = parse(await ok('revert_last_change'));
    expect(first.success).toBe(false);
    expect(first.restored.map((r: any) => r.file)).toEqual(['project.c3proj']);
    expect(first.notRestored).toEqual([{ file: 'layouts/Temp.json', reason: 'it, or its backup, changed on disk while the revert ran' }]);
    expect(parse(await ok('list_changes')).calls[0].reverted).toBe(false);

    const second = parse(await ok('revert_last_change'));
    expect(second.success).toBe(true);
    expect(second.restored.map((r: any) => r.file)).toEqual(['layouts/Temp.json']);
    expect(await snapshot()).toEqual(before);
  });
});

describe('revert_last_change and other calls at once', () => {
  it('a layer add waits while the revert restores the layout, then is refused as stale', async () => {
    const before = await layoutText();
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    const { reached, release } = holdNextPutBackOf(join(dir, 'layouts', 'Layout 1.json'));
    const revert = track(server.callTool('revert_last_change', {}));
    await reached.opened;
    const add = track(server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD2' }));
    await letOthersRun();
    expect(add.settled()).toBe(false);
    release.open();
    expect(parse(await revert.promise).success).toBe(true);
    const added = await add.promise;
    expect(added.isError).toBe(true);
    expect(added.content[0].text).toContain('was changed on disk after this server read it');
    expect(await layoutText()).toBe(before);
  });

  it('a backup replaced while the revert runs stops it, and the call\'s output is kept', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    const written = await layoutText();
    const original = writer.putBackChange.bind(writer);
    vi.spyOn(writer, 'putBackChange').mockImplementation(async (change, asLeft) => {
      await writeFile(change.backup.path, 'replaced', 'utf-8');
      return original(change, asLeft);
    });
    const result = parse(await ok('revert_last_change'));
    expect(result.success).toBe(false);
    expect(result.notRestored.map((r: any) => r.file)).toEqual(['layouts/Layout 1.json']);
    expect(await layoutText()).toBe(written);
  });

  it('the bridge waits while a revert restores project.c3proj, then refuses to write over it', async () => {
    const projectBefore = await readFile(join(dir, 'project.c3proj'), 'utf-8');
    const before = await snapshot();
    await ok('update_project_metadata', { author: 'To revert' });
    const { reached, release } = holdNextPutBackOf(join(dir, 'project.c3proj'));
    // The bridge has read project.c3proj (as it is before the revert) once it asks the writer to replace it; it then waits for the revert's lock
    const atProject = gate();
    const replace = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementation((...args) => {
      if (fileKey(args[0]) === fileKey(join(dir, 'project.c3proj'))) atProject.open();
      return replace(...args);
    });
    const revert = track(server.callTool('revert_last_change', {}));
    await reached.opened;
    const inject = track(server.callTool('inject_runtime_bridge', {}));
    await atProject.opened;
    await letOthersRun();
    expect(inject.settled()).toBe(false);
    release.open();
    expect(parse(await revert.promise).success).toBe(true);
    const injected = await inject.promise;
    expect(injected.isError).toBe(true);
    expect(injected.content[0].text).toContain('project.c3proj was changed on disk after this server read it');
    expect(await readFile(join(dir, 'project.c3proj'), 'utf-8')).toBe(projectBefore);
    // No bridge script or other file is left behind by the refused call
    expect(await snapshot()).toEqual(before);
    expect(journalEntries(reader).map(e => e.tool)).toEqual(['update_project_metadata']);
  });

  it('a second revert waits for the first and reverts the call before it', async () => {
    const before = await snapshot();
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    await ok('create_layout', { name: 'Temp' });
    const { reached, release } = holdNextPutBackOf(join(dir, 'project.c3proj'));
    const first = track(server.callTool('revert_last_change', {}));
    await reached.opened;
    const second = track(server.callTool('revert_last_change', {}));
    await letOthersRun();
    expect(second.settled()).toBe(false);
    release.open();
    const ids = [parse(await first.promise).reverted.id, parse(await second.promise).reverted.id];
    expect(ids).toEqual([2, 1]);
    expect(await snapshot()).toEqual(before);
  });

  it('reads what the call left a file as inside the file\'s lock, after waiting for it', async () => {
    await ok('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    const written = await layoutText();
    const layoutPath = join(dir, 'layouts', 'Layout 1.json');
    const holding = gate();
    const unlock = gate();
    const internals = writer as unknown as { withFileLock: <T>(path: string, fn: () => Promise<T>) => Promise<T> };
    const lockHeld = internals.withFileLock(layoutPath, async () => {
      holding.open();
      await unlock.opened;
    });
    await holding.opened;
    const original = writer.putBackChange.bind(writer);
    const handedOn = gate();
    vi.spyOn(writer, 'putBackChange').mockImplementation((change, asLeft) => {
      handedOn.open();
      return original(change, asLeft);
    });

    const revert = track(server.callTool('revert_last_change', {}));
    await handedOn.opened;
    await letOthersRun();
    expect(revert.settled()).toBe(false);
    // While the revert waits for the lock, the state the journal expects the file in becomes unknown
    journalEntries(reader)[0].expected.set(fileKey(layoutPath), undefined);
    unlock.open();
    await lockHeld;

    const result = parse(await revert.promise);
    expect(result.success).toBe(false);
    expect(result.notRestored).toEqual([{ file: 'layouts/Layout 1.json', reason: 'it, or its backup, changed on disk while the revert ran' }]);
    expect(await layoutText()).toBe(written);
  });
});
