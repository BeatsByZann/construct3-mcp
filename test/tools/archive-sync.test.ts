/**
 * The server wrapper for a single-file project: each call starts from the
 * archive as it is on disk and, once the last running call is done, the
 * archive is written back. Real archive, reader, writer and tool handlers
 * on a copy of the minimal fixture; test tools stand in where a test needs a
 * call held at a chosen point.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { gate, letOthersRun, track } from '../helpers/barrier.js';
import { C3pArchive, type ArchiveSyncResult, type C3pArchiveOptions } from '../../src/construct3/c3p-archive.js';
import { describeArchiveClose, withArchiveSync } from '../../src/tools/archive-sync.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerEventTools } from '../../src/tools/event-tools.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerProjectResources } from '../../src/resources/project.js';
import { readZip } from '../../src/runtime/zip-reader.js';
import { zipBuffer, type ZipEntry } from '../../src/runtime/zip-writer.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let root: string;
let work: string;
let archivePath: string;
let archive: C3pArchive;
let server: MockServer;
let served: MockServer;
let close: () => Promise<{ kept?: string; sync: ArchiveSyncResult }>;

/** Every file of the fixture project as archive entries. */
async function fixtureEntries(sub = ''): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const entry of await nodeFs.readdir(sub ? join(FIXTURE_DIR, sub) : FIXTURE_DIR, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await fixtureEntries(rel));
    else out.push({ path: rel, data: await nodeFs.readFile(join(FIXTURE_DIR, ...rel.split('/'))) });
  }
  return out;
}

const writeArchive = (entries: ZipEntry[]) => nodeFs.writeFile(archivePath, zipBuffer(entries));
const bytes = () => nodeFs.readFile(archivePath);
const archiveFiles = async () => new Map(readZip(await bytes()).map(entry => [entry.path, entry.data.toString()]));
/** The fixture's entries with one replaced or added. */
async function withEntry(path: string, text: string): Promise<ZipEntry[]> {
  const entries = (await fixtureEntries()).filter(entry => entry.path !== path);
  return [...entries, { path, data: Buffer.from(text) }];
}
/** Write a file into the working folder, as a tool that changed the project would. */
const touch = (name: string, text = name) => nodeFs.mkdir(join(archive.workDir, 'files'), { recursive: true })
  .then(() => nodeFs.writeFile(join(archive.workDir, 'files', name), text));

interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
const texts = (result: ToolText) => result.content.map(item => item.text);
const notesOf = (result: ToolText) => texts(result).slice(1);

/** Open the archive and serve the real tools through the gate. */
async function start(options: C3pArchiveOptions = {}, wrapOptions: { startupNote?: string } = {}) {
  archive = await C3pArchive.open(archivePath, { workRoot: work, ...options });
  const reader = new Construct3ProjectReader(archive.projectFile);
  await reader.loadProject();
  const writer = new Construct3ProjectWriter(reader, new IdGenerator());
  const idGen = new IdGenerator();
  server = new MockServer();
  const wrapped = withArchiveSync(server, archive, wrapOptions);
  close = wrapped.close;
  registerEventTools({ server: wrapped.server, reader, writer, idGen } as never);
  registerQueryTools(wrapped.server as never, reader);
  registerProjectResources(wrapped.server as never, reader);
  served = wrapped.server;
  return wrapped.server;
}

const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const addComment = (text: string) => server.callTool('add_event_to_sheet', { sheetName: 'MainSheet', eventType: 'comment', commentText: text });

beforeEach(async () => {
  root = await nodeFs.mkdtemp(join(tmpdir(), 'c3p-sync-'));
  work = join(root, 'work');
  await nodeFs.mkdir(work);
  archivePath = join(root, 'game.c3p');
  await writeArchive(await fixtureEntries());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await nodeFs.rm(root, { recursive: true, force: true });
});

describe('withArchiveSync', () => {
  it('writes the archive back after a tool call that changed the project, and notes it once', async () => {
    await start();
    const result = await addComment('written through the tool');
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    const files = await archiveFiles();
    expect(files.get('eventSheets/MainSheet.json')).toContain('written through the tool');
    expect(notesOf(result)).toEqual([`Saved the project to "${archivePath}" (${files.size} files).`]);
  });

  it('writes nothing after a call that changed nothing, and adds no note', async () => {
    await start();
    const before = await bytes();
    const result = await server.callTool('list_eventsheets');
    expect(await bytes()).toEqual(before);
    expect(notesOf(result)).toEqual([]);
  });

  it('a tool call after an editor save reads the new content', async () => {
    await start();
    const sheet = JSON.parse((await nodeFs.readFile(join(FIXTURE_DIR, 'eventSheets', 'MainSheet.json'), 'utf-8')));
    sheet.events.push({ eventType: 'comment', text: 'added in the editor' });
    await writeArchive(await withEntry('eventSheets/MainSheet.json', JSON.stringify(sheet, null, '\t')));
    const put = await bytes();
    const result = await server.callTool('get_eventsheet_details', { name: 'MainSheet' });
    expect(result.content[0].text).toContain('added in the editor');
    expect(notesOf(result)).toHaveLength(1);
    expect(notesOf(result)[0]).toContain('changed on disk');
    expect(await bytes()).toEqual(put);
  });

  /** A test tool that changes the project, then replaces the archive on disk. */
  function registerClash() {
    served.tool('clash', 'writes a file, then another program saves the archive', {}, async () => {
      await touch('clash.txt');
      await writeArchive(await withEntry('other.txt', 'saved elsewhere'));
      return okResult('clashed');
    });
  }

  it('reports the conflict on every later tool result', async () => {
    await start();
    registerClash();
    const first = await server.callTool('clash');
    expect(notesOf(first)).toHaveLength(1);
    expect(notesOf(first)[0]).toContain('NOT saved');
    expect(notesOf(first)[0]).toContain(archive.workDir);
    const put = await bytes();
    for (let i = 0; i < 2; i++) {
      const later = await server.callTool('list_eventsheets');
      expect(notesOf(later)).toHaveLength(1);
      expect(notesOf(later)[0]).toContain('NOT saved');
    }
    expect(await bytes()).toEqual(put);
  });

  it('writes once after overlapping calls, and holds a new call until the write is done', async () => {
    await start();
    const log: string[] = [];
    const barrier1 = gate();
    const barrier2 = gate();
    const originalSync = archive.sync.bind(archive);
    const syncSpy = vi.spyOn(archive, 'sync').mockImplementation(async () => {
      log.push('sync-start');
      await barrier2.opened;
      const result = await originalSync();
      log.push(`sync-end:${result.status}`);
      return result;
    });
    const originalRefresh = archive.refresh.bind(archive);
    const refreshSpy = vi.spyOn(archive, 'refresh').mockImplementation(async () => {
      log.push('refresh');
      return originalRefresh();
    });
    served.tool('tool_a', 'a', {}, async () => {
      log.push('A-start');
      await touch('a.txt');
      await barrier1.opened;
      return okResult('a');
    });
    served.tool('tool_b', 'b', {}, async () => {
      log.push('B');
      await touch('b.txt');
      return okResult('b');
    });
    const cHandler = vi.fn(async () => {
      log.push('C');
      return okResult('c');
    });
    served.tool('tool_c', 'c', {}, cHandler);

    const a = server.callTool('tool_a');
    await letOthersRun();
    await server.callTool('tool_b');
    expect(syncSpy).not.toHaveBeenCalled();
    barrier1.open();
    await letOthersRun();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const c = server.callTool('tool_c');
    await letOthersRun();
    expect(cHandler).not.toHaveBeenCalled();
    barrier2.open();
    await Promise.all([a, c]);
    expect(log).toEqual(['refresh', 'A-start', 'B', 'sync-start', 'sync-end:saved', 'refresh', 'C', 'sync-start', 'sync-end:unchanged']);
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenCalledTimes(2);
    const files = await archiveFiles();
    expect(files.has('files/a.txt') && files.has('files/b.txt')).toBe(true);
  });

  it('writes back when a resource read finishes after the tool call', async () => {
    await start();
    const held = gate();
    served.resource('held', 'test://held', async () => {
      await held.opened;
      return { contents: [{ uri: 'test://held', text: 'held' }] };
    });
    served.tool('write_t', 't', {}, async () => {
      await touch('t.txt');
      return okResult('t');
    });
    const syncSpy = vi.spyOn(archive, 'sync');
    const before = await bytes();
    const read = server.readResource('test://held');
    await letOthersRun();
    const tool = await server.callTool('write_t');
    expect(notesOf(tool)).toEqual([]);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(await bytes()).toEqual(before);
    held.open();
    const result = await read;
    expect(result).toEqual({ contents: [{ uri: 'test://held', text: 'held' }] });
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect((await archiveFiles()).has('files/t.txt')).toBe(true);
  });

  it('a resource read refreshes too', async () => {
    await start();
    const project = (await nodeFs.readFile(join(FIXTURE_DIR, 'project.c3proj'), 'utf-8')).replace('"name": "TestProject"', '"name": "Renamed"');
    await writeArchive(await withEntry('project.c3proj', project));
    const info = await server.readResource('construct3://project/info');
    expect(info.contents[0].text).toContain('Renamed');
  });

  it('a handler that throws still lets the archive be written for what the call changed, and the error comes through', async () => {
    await start();
    served.tool('throws', 'writes, then fails', {}, async () => {
      await touch('before-throw.txt');
      throw new Error('boom');
    });
    await expect(server.callTool('throws')).rejects.toThrow('boom');
    expect((await archiveFiles()).has('files/before-throw.txt')).toBe(true);
  });

  it('refuses a call while the archive cannot be read again, without running it', async () => {
    await start();
    const whole = zipBuffer(await withEntry('other.txt', 'a whole archive'));
    await nodeFs.writeFile(archivePath, whole.subarray(0, Math.floor(whole.length / 2)));
    const probe = vi.fn(async () => okResult('ran'));
    served.tool('probe', 'p', {}, probe);
    served.resource('probe-resource', 'test://probe', async () => ({ contents: [{ uri: 'test://probe', text: 'ran' }] }));
    const refused = await server.callTool('probe');
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('could not be read again');
    expect(refused.content[0].text).toContain('Nothing was run.');
    expect(probe).not.toHaveBeenCalled();
    await expect(server.readResource('test://probe')).rejects.toThrow('could not be read again');
    await nodeFs.writeFile(archivePath, whole);
    const ran = await server.callTool('probe');
    expect(ran.isError).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('closes through the gate, once', async () => {
    await start();
    const held = gate();
    served.tool('held_tool', 'h', {}, async () => {
      await touch('held.txt');
      await held.opened;
      return okResult('held');
    });
    const late = vi.fn(async () => okResult('late'));
    served.tool('late_tool', 'l', {}, late);
    const closeSpy = vi.spyOn(archive, 'close');
    const running = server.callTool('held_tool');
    await letOthersRun();
    const first = close();
    const second = close();
    expect(first).toBe(second);
    await letOthersRun();
    expect(closeSpy).not.toHaveBeenCalled();
    const refused = await server.callTool('late_tool');
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe('The server is stopping; nothing was run.');
    expect(late).not.toHaveBeenCalled();
    held.open();
    await running;
    const closed = await first;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closed.sync.status).toBe('saved');
    expect((await archiveFiles()).has('files/held.txt')).toBe(true);
  });

  it('closes after a write-back that is already running, not beside it', async () => {
    await start();
    const syncGate = gate();
    const log: string[] = [];
    const originalSync = archive.sync.bind(archive);
    let calls = 0;
    const syncSpy = vi.spyOn(archive, 'sync').mockImplementation(async () => {
      const n = ++calls;
      log.push(`sync-${n}-start`);
      if (n === 1) await syncGate.opened;
      const result = await originalSync();
      log.push(`sync-${n}-end`);
      return result;
    });
    const originalClose = archive.close.bind(archive);
    const closeSpy = vi.spyOn(archive, 'close').mockImplementation(async () => {
      log.push('close');
      return originalClose();
    });
    served.tool('write_x', 'x', {}, async () => {
      await touch('x.txt');
      return okResult('x');
    });
    const tool = server.callTool('write_x');
    await vi.waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const closing = close();
    await letOthersRun();
    expect(closeSpy).not.toHaveBeenCalled();
    syncGate.open();
    const result = await tool;
    expect(notesOf(result)[0]).toContain('Saved the project');
    const closed = await closing;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closed.sync.status).toBe('unchanged');
    expect(log).toEqual(['sync-1-start', 'sync-1-end', 'close', 'sync-2-start', 'sync-2-end']);
    expect((await archiveFiles()).has('files/x.txt')).toBe(true);
  });

  it('keeps the call count right when refresh() rejects', async () => {
    await start();
    const refreshSpy = vi.spyOn(archive, 'refresh').mockRejectedValueOnce(new Error('disk gone'));
    const refused = await server.callTool('list_eventsheets');
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('disk gone');
    expect(refused.content[0].text).toContain('Nothing was run.');
    const next = await server.callTool('list_eventsheets');
    expect(next.isError).toBeUndefined();
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    await close();
  });

  it('keeps the call count right, and releases close(), when sync() rejects', async () => {
    await start();
    served.tool('write_y', 'y', {}, async () => {
      await touch('y.txt');
      return okResult('y');
    });
    const syncGate = gate();
    const syncSpy = vi.spyOn(archive, 'sync').mockImplementationOnce(async () => {
      await syncGate.opened;
      throw new Error('sync broke');
    });
    const refreshSpy = vi.spyOn(archive, 'refresh');
    const tool = server.callTool('write_y');
    await vi.waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
    const closing = close();
    syncGate.open();
    const result = await tool;
    expect(notesOf(result)).toHaveLength(1);
    expect(notesOf(result)[0]).toContain('NOT saved');
    expect(notesOf(result)[0]).toContain('sync broke');
    const closed = await closing;
    expect(closed.sync.status).toBe('saved');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect((await archiveFiles()).has('files/y.txt')).toBe(true);
  });

  it('refreshes at the next call after a sync() that rejected', async () => {
    await start();
    served.tool('write_z', 'z', {}, async () => {
      await touch('z.txt');
      return okResult('z');
    });
    vi.spyOn(archive, 'sync').mockRejectedValueOnce(new Error('sync broke'));
    const refreshSpy = vi.spyOn(archive, 'refresh');
    await server.callTool('write_z');
    const next = await server.callTool('write_z');
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect(notesOf(next)).toHaveLength(1);
    expect(notesOf(next)[0]).toContain('Saved the project');
  });

  it('names working folders a killed session left, once', async () => {
    await start({}, { startupNote: 'Working folder(s) left by a session that stopped without closing: x.' });
    const first = await server.callTool('list_eventsheets');
    expect(notesOf(first)).toEqual(['Working folder(s) left by a session that stopped without closing: x.']);
    const second = await server.callTool('list_eventsheets');
    expect(notesOf(second)).toEqual([]);
  });

  it('wrapping twice runs one gate', async () => {
    await start();
    const once = withArchiveSync(new MockServer(), archive);
    const twice = withArchiveSync(once.server, archive);
    expect(twice.server).toBe(once.server);
    const syncSpy = vi.spyOn(archive, 'sync');
    twice.server.tool('write_once', 'w', {}, async () => {
      await touch('once.txt');
      return okResult('once');
    });
    await once.server.callTool('write_once');
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  describe('notes on overlapping calls', () => {
    it('reports a standing conflict on a call that overlapped another', async () => {
      await start();
      registerClash();
      await server.callTool('clash');
      const held = gate();
      served.tool('held_a', 'a', {}, async () => {
        await held.opened;
        return okResult('a');
      });
      served.tool('quick_b', 'b', {}, async () => okResult('b'));
      const syncSpy = vi.spyOn(archive, 'sync');
      const refreshSpy = vi.spyOn(archive, 'refresh');
      const a = track(server.callTool('held_a'));
      await letOthersRun();
      const refreshesBefore = refreshSpy.mock.calls.length;
      const b = await server.callTool('quick_b');
      expect(notesOf(b)).toHaveLength(1);
      expect(notesOf(b)[0]).toContain('NOT saved');
      expect(refreshSpy.mock.calls.length).toBe(refreshesBefore);
      expect(syncSpy).not.toHaveBeenCalled();
      held.open();
      const result = await a.promise;
      expect(notesOf(result)).toHaveLength(1);
      expect(notesOf(result)[0]).toContain('NOT saved');
    });

    it('does not repeat a conflict note that was deferred and still stands', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await start();
      const held = gate();
      served.resource('held', 'test://held', async () => {
        await held.opened;
        return { contents: [{ uri: 'test://held', text: 'held' }] };
      });
      registerClash();
      const read = server.readResource('test://held');
      await letOthersRun();
      await server.callTool('clash');
      held.open();
      await read;
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain('NOT saved');
      const next = await server.callTool('list_eventsheets');
      expect(notesOf(next)).toHaveLength(1);
      expect(notesOf(next)[0]).toContain('NOT saved');
    });

    it('carries a failure that ended after a resource read to the next tool result, with that call\'s own note', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await start();
      const held = gate();
      served.resource('held', 'test://held', async () => {
        await held.opened;
        return { contents: [{ uri: 'test://held', text: 'held' }] };
      });
      served.tool('write_t', 't', {}, async () => {
        await touch('t.txt');
        return okResult('t');
      });
      served.tool('write_next', 'n', {}, async () => {
        await touch('next.txt');
        return okResult('next');
      });
      const originalSync = archive.sync.bind(archive);
      vi.spyOn(archive, 'sync').mockResolvedValueOnce({ status: 'failed', reason: 'EBUSY' });
      const read = server.readResource('test://held');
      await letOthersRun();
      await server.callTool('write_t');
      held.open();
      const resource = await read;
      expect(resource).toEqual({ contents: [{ uri: 'test://held', text: 'held' }] });
      vi.spyOn(archive, 'sync').mockImplementation(originalSync);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain('EBUSY');
      const next = await server.callTool('write_next');
      const notes = notesOf(next);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain('NOT saved');
      expect(notes[0]).toContain('EBUSY');
      expect(notes[0]).toContain('The next tool call writes it back again.');
      expect(notes[1]).toContain('Saved the project');
      const again = await server.callTool('list_eventsheets');
      expect(notesOf(again)).toEqual([]);
      expect((await archiveFiles()).has('files/next.txt')).toBe(true);
    });
  });

  it('refuses every call once the archive stopped', async () => {
    await start();
    const probe = vi.fn(async () => okResult('ran'));
    served.tool('probe', 'p', {}, probe);
    vi.spyOn(archive, 'refresh').mockResolvedValue({
      status: 'failed',
      reason: 'the working folder could not be put back after a failed refresh (EBUSY)',
      stopped: true,
    });
    const refused = await server.callTool('probe');
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Restart the server');
    expect(probe).not.toHaveBeenCalled();
    const again = await server.callTool('probe');
    expect(again.isError).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('describeArchiveClose', () => {
  it('says the changes are unsaved when the folder was kept for a conflict or a failed write', async () => {
    await start();
    const conflict = describeArchiveClose(archive, { kept: archive.workDir, sync: { status: 'conflict', reason: 'it was changed on disk' } });
    expect(conflict).toContain('NOT saved');
    expect(conflict).toContain('it was changed on disk');
    expect(conflict).toContain(archive.workDir);
    const failed = describeArchiveClose(archive, { kept: archive.workDir, sync: { status: 'failed', reason: 'EBUSY' } });
    expect(failed).toContain('NOT saved');
    expect(failed).toContain('EBUSY');
  });

  it('keeps the notes of a conflict or failure, and of a folder that could not be removed when nothing needed writing', async () => {
    await start();
    const conflict = describeArchiveClose(archive, {
      kept: archive.workDir,
      sync: { status: 'conflict', reason: 'it was changed on disk', notes: ['a backup note'] },
    });
    expect(conflict).toContain('NOT saved');
    expect(conflict).toContain('Also: a backup note.');
    const unchanged = describeArchiveClose(archive, {
      kept: archive.workDir,
      sync: { status: 'unchanged', notes: [`the working folder "${archive.sessionDir}" could not be removed`] },
    });
    expect(unchanged).toContain(archive.sessionDir);
    expect(unchanged).not.toContain('NOT saved');
  });

  it('says saved, with the folder to delete, when the write went through and only the folder could not be removed', async () => {
    let sessionDir = '';
    await start({
      fs: {
        rm: async path => {
          if (path === sessionDir) throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
          await nodeFs.rm(path, { recursive: true, force: true });
        },
      },
    });
    sessionDir = archive.sessionDir;
    await addComment('saved before closing');
    await touch('late.txt');
    const result = await close();
    expect(result.sync.status).toBe('saved');
    expect(result.kept).toBe(archive.workDir);
    const text = describeArchiveClose(archive, result);
    expect(text).toContain('Saved the project');
    expect(text).toContain(`the working folder "${archive.sessionDir}" could not be removed`);
    expect(text).not.toContain(`"${archive.workDir}"`);
    expect(text).not.toContain('NOT saved');
    expect(text).not.toContain('changes are in');
    expect((await archiveFiles()).has('files/late.txt')).toBe(true);
  });

  it('says nothing after a clean close', async () => {
    await start();
    const result = await close();
    expect(describeArchiveClose(archive, result)).toBeUndefined();
    const saved = describeArchiveClose(archive, { sync: { status: 'saved', fileCount: 2 } });
    expect(saved).toBeUndefined();
  });
});
