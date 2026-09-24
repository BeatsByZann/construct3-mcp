/**
 * The gated server on a folder project (roadmap E1 to E3): every call's
 * result names the files it changed, list_changes and revert_last_change
 * work from the backups the writes leave, and a file Construct saved in the
 * meantime is refused until reload_project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSession } from '../../src/construct3/project-session.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { clearJournal, clearStamps } from '../../src/construct3/change-journal.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerSessionTools } from '../../src/tools/session-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let tmpDir: string;
let server: MockServer;
let session: ProjectSession;

function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}
async function layout(): Promise<any> {
  return JSON.parse(await readFile(join(tmpDir, 'layouts', 'Layout 1.json'), 'utf-8'));
}

beforeEach(async () => {
  resetProjectIndex();
  clearJournal();
  clearStamps();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-session-changes-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });
  session = await ProjectSession.start(join(tmpDir, 'project.c3proj'));
  server = new MockServer();
  session.install(server as any);
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(session.reader, idGen);
  registerQueryTools(server as any, session.reader);
  registerLayoutTools({ server, reader: session.reader, writer, idGen } as any);
  registerSessionTools(server as any, session, idGen);
});

afterEach(async () => {
  clearJournal();
  clearStamps();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the files a call changed', () => {
  it('are named in the result, and a read-only call names none', async () => {
    const added = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    expect(parse(added).success).toBe(true);
    expect(added.content.map(c => c.text).at(-1)).toBe('Changed 1 file(s): layouts/Layout 1.json (1 with a .bak backup; revert_last_change undoes this call).');

    const listed = await server.callTool('list_layouts', {});
    expect(listed.content).toHaveLength(1);
  });
});

describe('list_changes and revert_last_change', () => {
  it('list a write with its backup, restore it, and refuse a second revert', async () => {
    await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    expect((await layout()).layers.map((l: any) => l.name)).toContain('HUD');

    const listed = parse(await server.callTool('list_changes', {}));
    expect(listed.calls).toHaveLength(1);
    expect(listed.calls[0]).toMatchObject({ tool: 'add_layer', reverted: false, changes: [{ kind: 'write', file: 'layouts/Layout 1.json', backup: 'layouts/Layout 1.json.bak' }] });

    const reverted = parse(await server.callTool('revert_last_change', {}));
    expect(reverted.success).toBe(true);
    expect(reverted.restored).toEqual([{ file: 'layouts/Layout 1.json', how: expect.stringContaining('restored from') }]);
    expect((await layout()).layers.map((l: any) => l.name)).not.toContain('HUD');
    expect(parse(await server.callTool('get_layout_details', { name: 'Layout 1' })).layers.map((l: any) => l.name)).not.toContain('HUD');
    expect(parse(await server.callTool('list_changes', {})).calls[0].reverted).toBe(true);

    const again = await server.callTool('revert_last_change', {});
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain('already reverted');
  });

  it('remove a created layout and its registration together, and refuse a superseded call', async () => {
    await server.callTool('create_layout', { name: 'Temp' });
    const created = join(tmpDir, 'layouts', 'Temp.json');
    expect(existsSync(created)).toBe(true);
    const listed = parse(await server.callTool('list_changes', {}));
    expect(listed.calls[0].changes.map((c: any) => [c.kind, c.file])).toEqual(expect.arrayContaining([['create', 'layouts/Temp.json'], ['write', 'project.c3proj']]));

    // A later call on the same file spoils the backup of the earlier one.
    await server.callTool('add_layer', { layoutName: 'Temp', layerName: 'HUD' });
    const reverted = parse(await server.callTool('revert_last_change', {}));
    expect(reverted.reverted.tool).toBe('add_layer');
    const refused = await server.callTool('revert_last_change', {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('touched the same file(s)');
    expect(existsSync(created)).toBe(true);
  });

  it('restore a deleted layout file from its backup', async () => {
    await server.callTool('create_layout', { name: 'Temp' });
    const file = join(tmpDir, 'layouts', 'Temp.json');
    const before = await readFile(file, 'utf-8');
    const deleted = await server.callTool('delete_layout', { name: 'Temp' });
    expect(parse(deleted).success).toBe(true);
    expect(existsSync(file)).toBe(false);
    const listed = parse(await server.callTool('list_changes', {}));
    expect(listed.calls[0].changes).toEqual(expect.arrayContaining([{ kind: 'delete', file: 'layouts/Temp.json', backup: 'layouts/Temp.json.bak' }]));

    const reverted = parse(await server.callTool('revert_last_change', {}));
    expect(reverted.success).toBe(true);
    expect(await readFile(file, 'utf-8')).toBe(before);
    expect(parse(await server.callTool('list_layouts', {})).layouts.map((l: any) => l.name ?? l)).toContain('Temp');
  });

  it('remove a created layout and restore project.c3proj when nothing came after', async () => {
    await server.callTool('create_layout', { name: 'Temp' });
    const reverted = parse(await server.callTool('revert_last_change', {}));
    expect(reverted.success).toBe(true);
    expect(existsSync(join(tmpDir, 'layouts', 'Temp.json'))).toBe(false);
    expect(parse(await server.callTool('list_layouts', {})).layouts.map((l: any) => l.name ?? l)).not.toContain('Temp');
  });
});

describe('a file changed outside the server', () => {
  async function changeOutside(): Promise<string> {
    const file = join(tmpDir, 'layouts', 'Layout 1.json');
    const data = JSON.parse(await readFile(file, 'utf-8'));
    data.layers.push({ name: 'FromConstruct', sid: 777000000000001, instances: [] });
    await writeFile(file, JSON.stringify(data, null, '\t'));
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    return file;
  }

  it('is listed by reload_project', async () => {
    await server.callTool('get_layout_details', { name: 'Layout 1' }); // reads and stamps the file
    await changeOutside();
    const reloaded = parse(await server.callTool('reload_project', {}));
    expect(reloaded.changedOnDisk).toEqual([{ file: 'layouts/Layout 1.json', state: 'changed' }]);
    expect(parse(await server.callTool('reload_project', {})).changedOnDisk).toEqual([]);
  });

  it('is reported by the next call that reads it, which works from the new content', async () => {
    await server.callTool('get_layout_details', { name: 'Layout 1' });
    await changeOutside();
    const added = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD' });
    expect(parse(added).success).toBe(true);
    const notes = added.content.map(c => c.text);
    expect(notes.some(n => n.startsWith('Note: 1 file(s) changed on disk since this server last read them') && n.includes('layouts/Layout 1.json'))).toBe(true);
    expect((await layout()).layers.map((l: any) => l.name)).toEqual(['Main', 'FromConstruct', 'HUD']);
    // Seen once: the next call does not repeat it.
    const next = await server.callTool('add_layer', { layoutName: 'Layout 1', layerName: 'HUD2' });
    expect(next.content.map(c => c.text).filter(n => n.startsWith('Note:'))).toEqual([]);
  });

  it('refuses a write made from a stale copy, until reload_project', async () => {
    // A bulk read caches the layouts; a write that starts from that cache
    // after an outside change must not overwrite the file.
    await session.reader.readAllLayouts();
    const file = await changeOutside();
    const writer = new Construct3ProjectWriter(session.reader, new IdGenerator());
    const stale = (await session.reader.readAllLayouts()).get('Layout 1')!;
    await expect(writer.writeEntityFile('layouts', 'Layout 1', stale)).rejects.toThrow('changed on disk after this server last read it');
    expect(JSON.parse(await readFile(file, 'utf-8')).layers.map((l: any) => l.name)).toEqual(['Main', 'FromConstruct']);

    await server.callTool('reload_project', {});
    const fresh = (await session.reader.readAllLayouts()).get('Layout 1')!;
    await writer.writeEntityFile('layouts', 'Layout 1', fresh);
    expect((await layout()).layers.map((l: any) => l.name)).toEqual(['Main', 'FromConstruct']);
  });
});
