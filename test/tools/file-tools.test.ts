import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { registerFileTools } from '../../src/tools/file-tools.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { StaleFileError } from '../../src/construct3/disk-state.js';
import { serializeJson } from '../../src/construct3/json-format.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { EDITOR_RELOAD_NOTE } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const BOM = '﻿';

interface Entry {
  name: string;
  type: string;
  sid: number;
  'script-info'?: { purpose: string };
  'file-info'?: { purpose: string };
}
interface Folder {
  items: Entry[];
  subfolders: Array<Folder & { name: string }>;
}
interface ProjectShape {
  rootFileFolders: { script: Folder; [family: string]: Folder };
}

/** A script entry as the editor writes it. */
function script(name: string, sid: number, purpose = 'none'): Entry {
  return { name, type: 'application/javascript', sid, 'script-info': { purpose } };
}

/** A legacy entry that holds its purpose under file-info. */
function legacy(name: string, sid: number, purpose = 'none'): Entry {
  return { name, type: 'application/javascript', sid, 'file-info': { purpose } };
}

/** A subfolder in the editor's key order. */
function sub(name: string, items: Entry[] = [], subfolders: Array<Folder & { name: string }> = []): Folder & { name: string } {
  return { items, subfolders, name };
}

/** An error shaped as a Node fs error: its message carries the absolute path. */
function fsError(code: string, file: string): Error {
  return Object.assign(new Error(`${code}: failure, open '${file}'`), { code, syscall: 'open', path: file });
}

describe('script file tools', () => {
  let dir: string;
  let projPath: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let server: MockServer;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetProjectIndex();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), 'c3-file-tools-'));
    await cp(FIXTURE_DIR, dir, { recursive: true });
    projPath = join(dir, 'project.c3proj');
    reader = new Construct3ProjectReader(projPath);
    await reader.loadProject();
    const idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerFileTools({ server, reader, writer, idGen } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** The parsed JSON of a successful call; throws with the text of an error. */
  async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await server.callTool(tool, args);
    const text = result.content[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** The result of a call without throwing. */
  async function callError(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const result = await server.callTool(tool, args);
    return { isError: result.isError === true, text: result.content[0].text };
  }

  const projectBytes = () => readFile(projPath);
  const projectJson = async (): Promise<ProjectShape> => JSON.parse((await readFile(projPath, 'utf-8')).replace(BOM, '')) as ProjectShape;
  const scriptItems = async () => (await projectJson()).rootFileFolders.script.items;

  /** Replace the script family of project.c3proj on disk (CRLF, tabs) and load it again. */
  async function seedScripts(root: Folder, style = { eol: '\r\n' as const, trailing: '\r\n', bom: false }): Promise<void> {
    const project = await projectJson();
    project.rootFileFolders.script = root;
    await writeFile(projPath, serializeJson(project, style), 'utf-8');
    await reader.loadProject();
    resetProjectIndex();
  }

  /** Run `fn` once, just before the next writer.updateProject reads the file: a save in the editor. */
  function beforeNextProjectUpdate(fn: () => Promise<void>): void {
    const original = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async change => {
      await fn();
      return original(change);
    });
  }

  /** Rewrite project.c3proj on disk the way a save in the editor would. */
  async function saveInEditor(change: (project: ProjectShape) => void): Promise<void> {
    const project = await projectJson();
    change(project);
    await writeFile(projPath, serializeJson(project, { eol: '\r\n', trailing: '\r\n', bom: false }), 'utf-8');
  }

  const nothingChanged = (text: string) => {
    expect(text.endsWith('Nothing was changed.')).toBe(true);
    expect(text.split('Nothing was changed.').length - 1).toBe(1);
  };

  it('S1 registers a nested script with a fresh SID, and a second call writes nothing', async () => {
    const first = await call('register_script_file', { name: 'host.js', subfolder: 'embedded/runtime' });
    expect(first.action).toBe('registered');
    expect(first.editorNote).toBe(EDITOR_RELOAD_NOTE);
    const sid = first.generatedSid as number;
    expect(sid).not.toBe(100000000000001);
    const root = (await projectJson()).rootFileFolders.script;
    const entry = root.subfolders[0].subfolders[0].items[0];
    expect(Object.keys(entry)).toEqual(['name', 'type', 'sid', 'script-info']);
    expect(entry.type).toBe('application/javascript');
    expect(entry.sid).toBe(sid);

    const before = await projectBytes();
    const second = await call('register_script_file', { name: 'host.js', subfolder: 'embedded/runtime' });
    expect(second.action).toBe('already_registered');
    expect(second.generatedSid).toBe(sid);
    expect(second.editorNote).toBeUndefined();
    expect((await projectBytes()).equals(before)).toBe(true);
    expect((await projectJson()).rootFileFolders.script.subfolders[0].subfolders[0].items).toHaveLength(1);
  });

  it('S2 deregisters the entry only, and refuses an unregistered name or one that vanished', async () => {
    await call('register_script_file', { name: 'host.js' });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'host.js'), 'console.log(1);', 'utf-8');
    const result = await call('deregister_script_file', { name: 'host.js' });
    expect(result.action).toBe('deregistered');
    expect(await scriptItems()).toEqual([]);
    expect(await readFile(join(dir, 'scripts', 'host.js'), 'utf-8')).toBe('console.log(1);');

    const before = await projectBytes();
    const missing = await callError('deregister_script_file', { name: 'host.js' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('is not registered');
    nothingChanged(missing.text);
    expect((await projectBytes()).equals(before)).toBe(true);

    await call('register_script_file', { name: 'gone.js' });
    beforeNextProjectUpdate(() => saveInEditor(project => { project.rootFileFolders.script.items = []; }));
    const vanished = await callError('deregister_script_file', { name: 'gone.js' });
    expect(vanished.isError).toBe(true);
    expect(vanished.text).toContain('is no longer registered');
  });

  it('S3 repairs an older registration: key and duplicates', async () => {
    await seedScripts({ items: [legacy('legacy.js', 987654321012345), legacy('legacy.js', 987654321012346)], subfolders: [] });
    const result = await call('register_script_file', { name: 'legacy.js' });
    expect(result.action).toBe('already_registered');
    expect(result.generatedSid).toBe(987654321012345);
    const repaired = (result.repaired as string[]).join(' ');
    expect(repaired).toContain('file-info');
    expect(repaired).toContain('duplicate');
    expect(result.editorNote).toBe(EDITOR_RELOAD_NOTE);
    const items = await scriptItems();
    expect(items).toHaveLength(1);
    expect(items[0].sid).toBe(987654321012345);
    expect(items[0]['script-info']).toEqual({ purpose: 'none' });
    expect(items[0]['file-info']).toBeUndefined();
  });

  it('S4 keeps an existing purpose, and refuses a second main script before the update', async () => {
    await call('register_script_file', { name: 'main.js', purpose: 'main' });
    const before = await projectBytes();
    const kept = await call('register_script_file', { name: 'main.js' });
    expect(kept.action).toBe('already_registered');
    expect(kept.repaired).toBeUndefined();
    expect((await projectBytes()).equals(before)).toBe(true);
    expect((await scriptItems())[0]['script-info']).toEqual({ purpose: 'main' });

    const again = await call('register_script_file', { name: 'main.js', purpose: 'main' });
    expect(again.action).toBe('already_registered');

    const spy = vi.spyOn(writer, 'updateProject');
    const second = await callError('register_script_file', { name: 'other.js', purpose: 'main' });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('main.js');
    expect(second.text).toContain('set_main_script');
    nothingChanged(second.text);
    expect(spy).not.toHaveBeenCalled();
    expect((await projectBytes()).equals(before)).toBe(true);
    spy.mockRestore();

    const changed = await call('register_script_file', { name: 'main.js', purpose: 'none' });
    expect(changed.action).toBe('already_registered');
    expect((changed.repaired as string[]).join(' ')).toContain('from "main" to "none"');
    expect((await scriptItems())[0]['script-info']).toEqual({ purpose: 'none' });
  });

  it('S5 refuses a name in another letter case, before the update', async () => {
    await call('register_script_file', { name: 'host.js' });
    const before = await projectBytes();
    const spy = vi.spyOn(writer, 'updateProject');
    const clash = 'differs only in case from the registered script file "host.js"';

    const registered = await callError('register_script_file', { name: 'Host.js' });
    expect(registered.isError).toBe(true);
    expect(registered.text).toContain(clash);
    nothingChanged(registered.text);

    const deregistered = await callError('deregister_script_file', { name: 'HOST.js' });
    expect(deregistered.isError).toBe(true);
    expect(deregistered.text).toContain(clash);
    nothingChanged(deregistered.text);
    expect(spy).not.toHaveBeenCalled();

    const main = await callError('set_main_script', { name: 'Host.js' });
    expect(main.isError).toBe(true);
    expect(main.text).toContain('"host.js"');
    nothingChanged(main.text);

    expect((await projectBytes()).equals(before)).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('S6 refuses a subfolder in another letter case, and accepts a new name', async () => {
    await call('register_script_file', { name: 'host.js', subfolder: 'embedded/runtime' });
    const before = await projectBytes();
    const refused = await callError('register_script_file', { name: 'x.js', subfolder: 'Embedded/runtime' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('differs only in case from the existing project-bar folder path "embedded/runtime"');
    nothingChanged(refused.text);
    expect((await projectBytes()).equals(before)).toBe(true);

    const accepted = await call('register_script_file', { name: 'x.js', subfolder: 'embedded/other' });
    expect(accepted.action).toBe('registered');
  });

  it('S7 refuses invalid names and subfolders before any change', async () => {
    const before = await projectBytes();
    const spy = vi.spyOn(writer, 'updateProject');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: 'a/b' }, 'must be a single path segment'],
      [{ name: '..' }, 'must be a single path segment'],
      [{ name: 'data.js:x' }, 'must not contain'],
      [{ name: 'aux.js' }, 'reserved for a device'],
      [{ name: 'x.js', subfolder: 'x/../y' }, 'Subfolder path contains invalid characters'],
      [{ name: 'x.js', subfolder: '/abs' }, 'Subfolder path contains invalid characters'],
      [{ name: 'x.js', subfolder: 'lib/a:b' }, 'Subfolder part must not contain'],
      [{ name: 'x.js', subfolder: 'lib/con' }, 'Subfolder part "con" is reserved for a device'],
    ];
    for (const [args, reason] of cases) {
      for (const tool of ['register_script_file', 'deregister_script_file', 'set_main_script']) {
        const result = await callError(tool, args);
        expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
        expect(result.text, `${tool} ${JSON.stringify(args)}`).toContain(reason);
        nothingChanged(result.text);
      }
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await projectBytes()).equals(before)).toBe(true);
    await expect(server.callTool('register_script_file', { name: 'x.js', subfolder: '' })).rejects.toThrow();
  });

  describe('S8 set_main_script', () => {
    it('moves main to a script in a subfolder in one update and leaves other purposes', async () => {
      await seedScripts({
        items: [script('main.js', 1, 'main'), script('imports.js', 2, 'imports-for-events')],
        subfolders: [sub('sub', [script('lib.js', 3)])],
      });
      const spy = vi.spyOn(writer, 'updateProject');
      const result = await call('set_main_script', { name: 'lib.js', subfolder: 'sub' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.action).toBe('updated');
      expect((result.warnings as string[]).join(' ')).toContain('main.js -> none');
      expect((result.warnings as string[]).join(' ')).toContain('sub/lib.js -> main');
      const root = (await projectJson()).rootFileFolders.script;
      expect(root.items.map(item => item['script-info']?.purpose)).toEqual(['none', 'imports-for-events']);
      expect(root.subfolders[0].items[0]['script-info']).toEqual({ purpose: 'main' });
      spy.mockRestore();

      const before = await projectBytes();
      const same = await call('set_main_script', { name: 'lib.js', subfolder: 'sub' });
      expect(same.action).toBe('unchanged');
      expect(same.editorNote).toBeUndefined();
      expect((await projectBytes()).equals(before)).toBe(true);
    });

    it('lists the registered scripts for an unregistered name', async () => {
      await seedScripts({ items: [script('main.js', 1, 'main')], subfolders: [sub('sub', [script('lib.js', 3)])] });
      const result = await callError('set_main_script', { name: 'nope.js' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Registered scripts:');
      expect(result.text).toContain('sub/lib.js');
      nothingChanged(result.text);
    });

    it('asks for a subfolder when the name is in two subfolders and none is at the root', async () => {
      await seedScripts({ items: [], subfolders: [sub('a', [script('dup.js', 1)]), sub('b', [script('dup.js', 2)])] });
      const before = await projectBytes();
      const result = await callError('set_main_script', { name: 'dup.js' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Pass subfolder');
      expect((await projectBytes()).equals(before)).toBe(true);
      const chosen = await call('set_main_script', { name: 'dup.js', subfolder: 'b' });
      expect(chosen.subfolder).toBe('b');
    });

    it('prefers the root script of the name, and the subfolder when one is given', async () => {
      await seedScripts({ items: [script('dup.js', 1)], subfolders: [sub('a', [script('dup.js', 2)])] });
      await call('set_main_script', { name: 'dup.js' });
      let root = (await projectJson()).rootFileFolders.script;
      expect(root.items[0]['script-info']).toEqual({ purpose: 'main' });
      expect(root.subfolders[0].items[0]['script-info']).toEqual({ purpose: 'none' });
      await call('set_main_script', { name: 'dup.js', subfolder: 'a' });
      root = (await projectJson()).rootFileFolders.script;
      expect(root.items[0]['script-info']).toEqual({ purpose: 'none' });
      expect(root.subfolders[0].items[0]['script-info']).toEqual({ purpose: 'main' });
    });

    it('is not ambiguous when the name is registered twice in one folder', async () => {
      await seedScripts({ items: [script('dup.js', 1), script('dup.js', 2)], subfolders: [] });
      const result = await call('set_main_script', { name: 'dup.js' });
      expect(result.action).toBe('updated');
    });

    it('counts a purpose held only in file-info and clears it', async () => {
      await seedScripts({ items: [legacy('old.js', 1, 'main'), script('other.js', 2)], subfolders: [] });
      await call('set_main_script', { name: 'other.js' });
      const items = await scriptItems();
      expect(items[0]['script-info']).toEqual({ purpose: 'none' });
      expect(items[0]['file-info']).toBeUndefined();
      expect(items[1]['script-info']).toEqual({ purpose: 'main' });
    });
  });

  it('S9 keeps the BOM, CRLF line ends and trailing line end of project.c3proj', async () => {
    await seedScripts({ items: [], subfolders: [] }, { eol: '\r\n', trailing: '\r\n', bom: true });
    await call('register_script_file', { name: 'host.js' });
    const text = (await projectBytes()).toString('utf-8');
    expect(text.startsWith(BOM)).toBe(true);
    expect(/(?<!\r)\n/.test(text)).toBe(false);
    expect(text.endsWith('\r\n')).toBe(true);
    expect((await scriptItems()).map(item => item.name)).toEqual(['host.js']);
  });

  it('S10 stops when the entry vanished meanwhile', async () => {
    await call('register_script_file', { name: 'host.js' });
    let left: Buffer | undefined;
    beforeNextProjectUpdate(async () => {
      await saveInEditor(project => { project.rootFileFolders.script.items = []; });
      left = await projectBytes();
    });
    const result = await callError('register_script_file', { name: 'host.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('is no longer registered');
    nothingChanged(result.text);
    expect((await projectBytes()).equals(left as Buffer)).toBe(true);
  });

  it('S11 stops set_main_script when the target vanished', async () => {
    await seedScripts({ items: [script('main.js', 1, 'main'), script('host.js', 2)], subfolders: [] });
    let left: Buffer | undefined;
    beforeNextProjectUpdate(async () => {
      await saveInEditor(project => { project.rootFileFolders.script.items = project.rootFileFolders.script.items.filter(item => item.name !== 'host.js'); });
      left = await projectBytes();
    });
    const spy = writer.updateProject as unknown as { mock: { calls: unknown[] } };
    const result = await callError('set_main_script', { name: 'host.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"host.js"');
    expect(result.text).toContain('no longer registered');
    nothingChanged(result.text);
    expect(spy.mock.calls).toHaveLength(1);
    expect((await projectBytes()).equals(left as Buffer)).toBe(true);
  });

  it('S12 reports an fs failure by its code, without the absolute path', async () => {
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(fsError('EACCES', join(dir, 'project.c3proj.tmp')));
    const result = await callError('register_script_file', { name: 'host.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('EACCES');
    expect(result.text).not.toContain(dir);
    expect(result.text.startsWith('Error registering script file:')).toBe(true);
  });

  it('S13 does not write twice for a repeated call', async () => {
    const results = await Promise.all([
      call('register_script_file', { name: 'host.js' }),
      call('register_script_file', { name: 'host.js' }),
    ]);
    expect(results.filter(result => result.action === 'registered')).toHaveLength(1);
    expect(await scriptItems()).toHaveLength(1);
  });

  it('S14 keeps the message of the server own errors', async () => {
    const message = 'project.c3proj was changed on disk (saved in the Construct 3 editor?) while this call ran.';
    vi.spyOn(writer, 'updateProject').mockRejectedValueOnce(new StaleFileError(message, 'project.c3proj'));
    const result = await callError('register_script_file', { name: 'host.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(result.text).not.toBe('E_STALE_FILE');
    expect(result.text.endsWith('Nothing was changed.')).toBe(true);
  });

  it('S15 puts the registration back after an error that follows the write', async () => {
    const before = await projectBytes();
    const original = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async change => {
      await original(change);
      throw new Error('reload failed');
    });
    const result = await callError('register_script_file', { name: 'host.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('reload failed');
    expect(result.text).toContain('put back');
    expect(result.text).toContain('project.c3proj');
    expect(result.text).not.toContain('Nothing was changed');
    expect((await projectBytes()).equals(before)).toBe(true);
    expect(await scriptItems()).toEqual([]);
  });

  it('S16 refuses inside the update a case variant saved during the call', async () => {
    let left: Buffer | undefined;
    beforeNextProjectUpdate(async () => {
      await saveInEditor(project => { project.rootFileFolders.script.items = [script('Host.js', 777)]; });
      left = await projectBytes();
    });
    const result = await callError('register_script_file', { name: 'host.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('differs only in case from the registered script file "Host.js"');
    nothingChanged(result.text);
    expect((await projectBytes()).equals(left as Buffer)).toBe(true);
    expect(await scriptItems()).toHaveLength(1);
  });

  it('S17 refuses inside the update a second main script made during the call', async () => {
    await call('register_script_file', { name: 'other.js' });
    let left: Buffer | undefined;
    beforeNextProjectUpdate(async () => {
      await saveInEditor(project => { project.rootFileFolders.script.items.push(script('main.js', 888, 'main')); });
      left = await projectBytes();
    });
    const result = await callError('register_script_file', { name: 'other.js', purpose: 'main' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('main.js');
    expect(result.text).toContain('set_main_script');
    nothingChanged(result.text);
    expect((await projectBytes()).equals(left as Buffer)).toBe(true);
    const items = await scriptItems();
    expect(items.map(item => [item.name, item['script-info']?.purpose])).toEqual([['other.js', 'none'], ['main.js', 'main']]);
  });
});
