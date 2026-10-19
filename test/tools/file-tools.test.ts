import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm, readdir, symlink, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockServer } from '../mocks/mock-server.js';
import { MAX_PROJECT_FILE_BYTES, registerFileTools } from '../../src/tools/file-tools.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { StaleFileError } from '../../src/construct3/disk-state.js';
import { serializeJson } from '../../src/construct3/json-format.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { EDITOR_RELOAD_NOTE } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const BOM = String.fromCharCode(0xfeff);

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
    nothingChanged(vanished.text);
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
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('S16b refuses inside the update a subfolder variant saved during the call', async () => {
    let left: Buffer | undefined;
    beforeNextProjectUpdate(async () => {
      await saveInEditor(project => { project.rootFileFolders.script.subfolders = [sub('Embedded', [script('other.js', 777)])]; });
      left = await projectBytes();
    });
    const result = await callError('register_script_file', { name: 'host.js', subfolder: 'embedded' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('differs only in case from the existing project-bar folder path "Embedded"');
    nothingChanged(result.text);
    expect((await projectBytes()).equals(left as Buffer)).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('S18 refuses set_main_script while the runtime bridge is the main script', async () => {
    await seedScripts({ items: [script('c3-runtime-bridge.js', 1, 'main'), script('x.js', 2)], subfolders: [] });
    const before = await projectBytes();
    const spy = vi.spyOn(writer, 'updateProject');
    const result = await callError('set_main_script', { name: 'x.js' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('stop the bridge loading');
    expect(result.text).toContain('remove_runtime_bridge');
    nothingChanged(result.text);
    expect(spy).not.toHaveBeenCalled();
    expect((await projectBytes()).equals(before)).toBe(true);
    // The bridge itself may be made main again (it is the target)
    const same = await call('set_main_script', { name: 'c3-runtime-bridge.js' });
    expect(same.action).toBe('unchanged');
  });

  it('registers and deregisters one of two scripts of one name in different folders', async () => {
    await seedScripts({ items: [script('dup.js', 1)], subfolders: [sub('a', [script('dup.js', 2)])] });
    const before = await projectBytes();
    const registered = await call('register_script_file', { name: 'dup.js', subfolder: 'a' });
    expect(registered.generatedSid).toBe(2);
    expect((await projectBytes()).equals(before)).toBe(true);
    await call('deregister_script_file', { name: 'dup.js' });
    const root = (await projectJson()).rootFileFolders.script;
    expect(root.items).toEqual([]);
    expect(root.subfolders[0].items.map(item => item.sid)).toEqual([2]);
  });

  it('names (none) when set_main_script finds no registered scripts, and a case variant in the chosen folder', async () => {
    const none = await callError('set_main_script', { name: 'x.js' });
    expect(none.text).toContain('Registered scripts: (none)');
    await seedScripts({ items: [script('x.js', 1)], subfolders: [sub('a', [script('Y.js', 2)])] });
    const variant = await callError('set_main_script', { name: 'y.js', subfolder: 'a' });
    expect(variant.text).toContain('"a/Y.js" is');
    const elsewhere = await callError('set_main_script', { name: 'y.js', subfolder: 'b' });
    expect(elsewhere.text).toContain('is not registered in this project');
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
    expect(consoleError).not.toHaveBeenCalled();
  });
});

/** A Project File entry as the editor writes it. */
function fileEntry(name: string, sid: number, type = 'application/json'): Entry {
  return { name, type, sid, 'file-info': { purpose: 'none' } };
}

describe('Project File tools', () => {
  let dir: string;
  let sourceDir: string;
  let outside: string;
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
    sourceDir = await mkdtemp(join(tmpdir(), 'c3-file-sources-'));
    outside = join(sourceDir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'existing.json'), '{"outside":true}', 'utf-8');
    await writeFile(join(outside, 'marker.txt'), 'marker', 'utf-8');
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
    await rm(sourceDir, { recursive: true, force: true });
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
  const family = async (name: string): Promise<Folder> => (await projectJson()).rootFileFolders[name];
  const generalItems = async () => (await family('general')).items;
  const path = (...parts: string[]) => join(dir, ...parts);
  const nothingChanged = (text: string) => {
    expect(text.endsWith('Nothing was changed.')).toBe(true);
    expect(text.split('Nothing was changed.').length - 1).toBe(1);
  };

  /** A file under the project folder, with its folders. */
  async function put(relative: string, content: string): Promise<string> {
    const file = path(...relative.split('/'));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content, 'utf-8');
    return file;
  }

  /** A source file outside the project. */
  async function source(content = '{"fixture":true}', name = 'source.json'): Promise<string> {
    const file = join(sourceDir, name);
    await writeFile(file, content, 'utf-8');
    return file;
  }

  /** Replace one family of project.c3proj on disk (CRLF, tabs) and load it again. */
  async function seedFamily(name: string, root: Folder, style = { eol: '\r\n' as const, trailing: '\r\n', bom: false }): Promise<void> {
    const project = await projectJson();
    project.rootFileFolders[name] = root;
    await writeFile(projPath, serializeJson(project, style), 'utf-8');
    await reader.loadProject();
    resetProjectIndex();
  }

  /** Rewrite project.c3proj on disk the way a save in the editor would. */
  async function saveInEditor(change: (project: ProjectShape) => void): Promise<void> {
    const project = await projectJson();
    change(project);
    await writeFile(projPath, serializeJson(project, { eol: '\r\n', trailing: '\r\n', bom: false }), 'utf-8');
  }

  /** A save in the editor that adds a property, so the file's size differs from the one the writer recorded. */
  const editorAddsProperty = () => saveInEditor(project => { (project as unknown as Record<string, unknown>).savedInEditor = true; });

  /** Run `fn` once, just before the next writer.updateProject reads the file. */
  function beforeNextProjectUpdate(fn: () => Promise<void>): void {
    const original = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async change => {
      await fn();
      return original(change);
    });
  }

  /** Run `fn` once, right after the next writer.updateProject has written. */
  function afterNextProjectUpdate(fn: () => Promise<void>): void {
    const original = writer.updateProject.bind(writer);
    vi.spyOn(writer, 'updateProject').mockImplementationOnce(async change => {
      const result = await original(change);
      await fn();
      return result;
    });
  }

  it('P1 copies and registers a nested file, also through the filePath and source aliases', async () => {
    const sourcePath = await source();
    const result = await call('register_project_file', { sourcePath, folder: 'general', subfolder: 'editor/assets' });
    expect(result.action).toBe('registered');
    expect(result.path).toBe('files/editor/assets/source.json');
    expect(result.editorNote).toBe(EDITOR_RELOAD_NOTE);
    const general = await family('general');
    const folder = general.subfolders[0].subfolders[0];
    expect(Object.keys(general.subfolders[0])).toEqual(['items', 'subfolders', 'name']);
    expect(Object.keys(folder)).toEqual(['items', 'subfolders', 'name']);
    expect(folder.items).toEqual([{ name: 'source.json', type: 'application/json', sid: result.generatedSid, 'file-info': { purpose: 'none' } }]);
    expect(folder.items[0]['script-info']).toBeUndefined();
    expect((await readFile(path('files', 'editor', 'assets', 'source.json'))).equals(await readFile(sourcePath))).toBe(true);
    expect(existsSync(path('files', 'editor', 'assets', 'source.json.bak'))).toBe(false);

    const viaFilePath = await call('register_project_file', { filePath: sourcePath, subfolder: 'one' });
    const viaSource = await call('register_project_file', { source: sourcePath, subfolder: 'two' });
    for (const [aliased, subfolder] of [[viaFilePath, 'one'], [viaSource, 'two']] as const) {
      expect(aliased.action).toBe('registered');
      expect(aliased.path).toBe(`files/${subfolder}/source.json`);
      expect(aliased.editorNote).toBe(EDITOR_RELOAD_NOTE);
      expect((await readFile(path('files', subfolder, 'source.json'))).equals(await readFile(sourcePath))).toBe(true);
    }
  });

  it('P2 uses the directory of each family, keeps a sound type, and nests a sound', async () => {
    const sourcePath = await source('bytes', 'x.bin');
    const directories: Array<[string, string]> = [['general', 'files'], ['sound', 'sounds'], ['music', 'music'], ['video', 'videos'], ['font', 'fonts']];
    for (const [folder, directory] of directories) {
      const registered = await call('register_project_file', { name: 'x.bin', sourcePath, folder });
      expect(registered.path).toBe(`${directory}/x.bin`);
      expect(await readFile(path(directory, 'x.bin'), 'utf-8')).toBe('bytes');
      const deregistered = await call('deregister_project_file', { name: 'x.bin', folder });
      expect(deregistered.path).toBe(`${directory}/x.bin`);
      expect(existsSync(path(directory, 'x.bin'))).toBe(false);
    }
    const webm = await source('webm', 'a.webm');
    await call('register_project_file', { name: 'a.webm', sourcePath: webm, folder: 'sound', type: 'audio/webm; codecs=opus' });
    expect(existsSync(path('files', 'a.webm'))).toBe(false);
    expect(await readFile(path('sounds', 'a.webm'), 'utf-8')).toBe('webm');
    expect((await family('sound')).items[0].type).toBe('audio/webm; codecs=opus');
    const nested = await call('register_project_file', { name: 'a.webm', sourcePath: webm, folder: 'sound', subfolder: 'ambience/forest' });
    expect(nested.path).toBe('sounds/ambience/forest/a.webm');
    expect(await readFile(path('sounds', 'ambience', 'forest', 'a.webm'), 'utf-8')).toBe('webm');
  });

  it('P3 refuses folder and category that disagree before anything is copied, and accepts identical aliases', async () => {
    const sourcePath = await source();
    await seedFamily('sound', { items: [fileEntry('s.json', 11)], subfolders: [] });
    await put('sounds/s.json', 'sound');
    const before = await projectBytes();
    const spy = vi.spyOn(writer, 'updateProject');
    for (const args of [{ name: 'source.json', sourcePath, folder: 'sound', category: 'music' }, { name: 's.json', folder: 'sound', category: 'music' }]) {
      for (const tool of ['register_project_file', 'deregister_project_file']) {
        const result = await callError(tool, args);
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toContain('aliases disagree');
        nothingChanged(result.text);
      }
    }
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(path('sounds', 'source.json'))).toBe(false);
    expect(existsSync(path('music', 'source.json'))).toBe(false);
    expect(await readFile(path('sounds', 's.json'), 'utf-8')).toBe('sound');
    expect((await projectBytes()).equals(before)).toBe(true);
    spy.mockRestore();

    const same = await call('register_project_file', { sourcePath, folder: 'general', category: 'general' });
    expect(same.folder).toBe('general');
    expect(same.action).toBe('registered');
  });

  it('P4 answers an exact registration without a source, repairs it and warns about a missing or ignored file', async () => {
    await seedFamily('general', { items: [{ name: 'existing.json', type: 'application/json', sid: 555, 'script-info': { purpose: 'none' } }], subfolders: [] });
    const first = await call('register_project_file', { name: 'existing.json', folder: 'general' });
    expect(first.action).toBe('already_registered');
    expect(first.generatedSid).toBe(555);
    expect((first.repaired as string[]).join(' ')).toContain('file-info');
    const items = await generalItems();
    expect(items).toHaveLength(1);
    expect(items[0]['file-info']).toEqual({ purpose: 'none' });
    expect(items[0]['script-info']).toBeUndefined();
    const warning = (first.warnings as string[]).join(' ');
    expect(warning).toContain('files/existing.json is not on disk');
    expect(warning).toContain('deregister_project_file');

    await put('files/existing.json', 'present');
    const second = await call('register_project_file', { name: 'existing.json', folder: 'general' });
    expect(second.action).toBe('already_registered');
    expect(second.warnings).toBeUndefined();

    const replace = vi.spyOn(writer, 'replaceFile');
    const sourcePath = await source();
    const third = await call('register_project_file', { name: 'existing.json', sourcePath });
    expect(replace).toHaveBeenCalledTimes(0);
    expect((third.warnings as string[]).join(' ')).toContain('the source was not copied');
    expect(await readFile(path('files', 'existing.json'), 'utf-8')).toBe('present');
  });

  it('P5 refuses a file that is not registered without a source, and a call with no derivable name', async () => {
    const before = await projectBytes();
    const none = await callError('register_project_file', { name: 'new.json', folder: 'general' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('sourcePath (or filePath) is required');
    nothingChanged(none.text);
    const noName = await callError('register_project_file', { folder: 'general' });
    expect(noName.isError).toBe(true);
    expect(noName.text).toContain('A name or sourcePath/filePath is required');
    nothingChanged(noName.text);
    expect((await projectBytes()).equals(before)).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  describe('P6 the source', () => {
    /** Assert a refusal that came from readSourceFile: no log, no outer-catch prefix, nothing changed. */
    async function expectSourceRefusal(sourcePath: string, reason: string) {
      const before = await projectBytes();
      const result = await callError('register_project_file', { sourcePath });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(reason);
      expect(result.text).not.toContain(sourceDir);
      expect(result.text.startsWith('Error registering Project File')).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
      nothingChanged(result.text);
      expect((await projectBytes()).equals(before)).toBe(true);
      expect(existsSync(path('files', 'big.bin'))).toBe(false);
      expect(existsSync(path('files', 'missing.json'))).toBe(false);
      expect(existsSync(path('files', 'folder'))).toBe(false);
    }

    it('refuses a missing file', async () => {
      await expectSourceRefusal(join(sourceDir, 'missing.json'), 'The source file cannot be read (ENOENT)');
    });

    it('refuses a folder', async () => {
      await mkdir(join(sourceDir, 'folder'));
      await expectSourceRefusal(join(sourceDir, 'folder'), 'not a file');
    });

    it('refuses a file over the size limit, without reading it', async () => {
      const big = join(sourceDir, 'big.bin');
      await writeFile(big, '');
      await truncate(big, MAX_PROJECT_FILE_BYTES + 1);
      await expectSourceRefusal(big, `up to ${MAX_PROJECT_FILE_BYTES / 1048576} MB`);
    });
  });

  it('P7 refuses a letter-case variant and a file at the destination, and leaves a file that appears during the call', async () => {
    const sourcePath = await source();
    await seedFamily('general', { items: [fileEntry('Data.json', 21)], subfolders: [] });
    await put('files/Data.json', 'registered');
    const spy = vi.spyOn(writer, 'updateProject');
    const variant = await callError('register_project_file', { name: 'data.json', sourcePath });
    expect(variant.isError).toBe(true);
    expect(variant.text).toContain('differs only in case');
    nothingChanged(variant.text);
    expect(spy).not.toHaveBeenCalled();
    expect(await readFile(path('files', 'Data.json'), 'utf-8')).toBe('registered');
    spy.mockRestore();

    await seedFamily('general', { items: [], subfolders: [] });
    const before = await projectBytes();
    await put('files/data.json', 'unregistered');
    const exact = await callError('register_project_file', { name: 'data.json', sourcePath });
    expect(exact.isError).toBe(true);
    expect(exact.text).toContain('already exists');
    nothingChanged(exact.text);
    expect(await readFile(path('files', 'data.json'), 'utf-8')).toBe('unregistered');
    expect(existsSync(path('files', 'data.json.bak'))).toBe(false);
    await rm(path('files', 'data.json'));

    await put('files/DATA.JSON', 'variant');
    const caseVariant = await callError('register_project_file', { name: 'data.json', sourcePath });
    expect(caseVariant.isError).toBe(true);
    expect(caseVariant.text).toContain('already exists');
    nothingChanged(caseVariant.text);
    expect((await readdir(path('files'))).includes('data.json')).toBe(false);
    expect((await projectBytes()).equals(before)).toBe(true);
  });

  for (const tool of ['register_project_file', 'create_data_file'] as const) {
    it(`P7 ${tool} leaves a file another program creates during the call`, async () => {
      const args = tool === 'register_project_file' ? { sourcePath: await source() } : { name: 'source.json', kind: 'json' };
      const replace = vi.spyOn(writer, 'replaceFile');
      afterNextProjectUpdate(async () => { await put('files/source.json', 'other bytes'); });
      const result = await callError(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('appeared on disk while this call ran');
      expect(result.text).toContain('The registration in project.c3proj was put back');
      expect(result.text).not.toContain('Nothing was changed');
      expect(await generalItems()).toEqual([]);
      expect(await readFile(path('files', 'source.json'), 'utf-8')).toBe('other bytes');
      expect(existsSync(path('files', 'source.json.bak'))).toBe(false);
      expect(replace).toHaveBeenCalledTimes(0);
    });
  }

  it('P8 puts the registration back when the copy fails, naming the code and not the path', async () => {
    const sourcePath = await source();
    const before = await projectBytes();
    const destination = path('files', 'source.json');
    vi.spyOn(writer, 'replaceFile').mockRejectedValueOnce(fsError('EIO', destination));
    const result = await callError('register_project_file', { sourcePath });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('EIO');
    expect(result.text).toContain('The registration in project.c3proj was put back');
    expect(result.text).not.toContain(dir);
    expect((await projectBytes()).equals(before)).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it('P9 names the registration that cannot be put back after an editor save', async () => {
    const sourcePath = await source();
    let left: Buffer | undefined;
    vi.spyOn(writer, 'replaceFile').mockImplementationOnce(async () => {
      await editorAddsProperty();
      left = await projectBytes();
      throw fsError('EIO', path('files', 'source.json'));
    });
    const result = await callError('register_project_file', { sourcePath });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('could not be put back');
    expect(result.text).toContain('left as they are');
    expect(result.text).toContain('project.c3proj');
    expect(result.text).not.toContain(dir);
    expect((await projectBytes()).equals(left as Buffer)).toBe(true);
  });

  it('P10 names a file left on disk after its registration was put back', async () => {
    const sourcePath = await source();
    const original = writer.replaceFile.bind(writer);
    vi.spyOn(writer, 'replaceFile').mockImplementationOnce(async (file, content, options) => {
      await original(file, content, options);
      throw fsError('EIO', file);
    });
    const result = await callError('register_project_file', { sourcePath });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('is on disk and not registered');
    expect(result.text).not.toContain('Nothing was changed');
    expect(await generalItems()).toEqual([]);
  });

  for (const tool of ['register_project_file', 'create_data_file'] as const) {
    it(`P21 ${tool} does not call a file unregistered when its registration could not be put back`, async () => {
      const args = tool === 'register_project_file' ? { sourcePath: await source() } : { name: 'source.json', kind: 'json' };
      const original = writer.replaceFile.bind(writer);
      let left: Buffer | undefined;
      vi.spyOn(writer, 'replaceFile').mockImplementationOnce(async (file, content, options) => {
        await original(file, content, options);
        await editorAddsProperty();
        left = await projectBytes();
        throw fsError('EIO', file);
      });
      const result = await callError(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('could not be put back');
      expect(result.text).toContain('is on disk, and its registration in project.c3proj may still be there');
      expect(result.text).not.toContain('is on disk and not registered');
      expect(result.text).not.toContain('was put back');
      expect((await projectBytes()).equals(left as Buffer)).toBe(true);
      expect((await generalItems()).map(item => item.name)).toEqual(['source.json']);
    });
  }

  it('P11 does not copy over a registration another writer made during the call, and create_data_file refuses', async () => {
    const hookEntry = () => saveInEditor(project => { project.rootFileFolders.general = { items: [fileEntry('source.json', 777)], subfolders: [] }; });
    const replace = vi.spyOn(writer, 'replaceFile');
    const sourcePath = await source();
    beforeNextProjectUpdate(hookEntry);
    const registered = await call('register_project_file', { sourcePath });
    expect(registered.action).toBe('already_registered');
    expect(registered.generatedSid).toBe(777);
    const warning = (registered.warnings as string[]).join(' ');
    expect(warning).toContain('registered by another writer while this call ran');
    expect(warning).toContain('the source was not copied');
    expect(replace).toHaveBeenCalledTimes(0);
    expect(existsSync(path('files', 'source.json'))).toBe(false);
    expect((await generalItems()).map(item => item.sid)).toEqual([777]);

    await seedFamily('general', { items: [], subfolders: [] });
    beforeNextProjectUpdate(hookEntry);
    const created = await callError('create_data_file', { name: 'source.json', kind: 'json' });
    expect(created.isError).toBe(true);
    expect(created.text).toContain('was registered by another writer while this call ran');
    nothingChanged(created.text);
    expect(replace).toHaveBeenCalledTimes(0);
    expect(existsSync(path('files', 'source.json'))).toBe(false);
    expect((await generalItems()).map(item => item.sid)).toEqual([777]);
  });

  describe('P12 deregister_project_file', () => {
    it('removes the registration, keeps a .bak copy and deletes the file', async () => {
      await call('register_project_file', { sourcePath: await source('content') });
      const result = await call('deregister_project_file', { name: 'source.json' });
      expect(result.action).toBe('deregistered');
      expect(result.fileRemoved).toBe(true);
      expect(result.backup).toBe('files/source.json.bak');
      expect(await readFile(path('files', 'source.json.bak'), 'utf-8')).toBe('content');
      expect(existsSync(path('files', 'source.json'))).toBe(false);
      expect(await generalItems()).toEqual([]);
    });

    it('reports a file that was already absent', async () => {
      await call('register_project_file', { sourcePath: await source() });
      await rm(path('files', 'source.json'));
      const result = await call('deregister_project_file', { name: 'source.json' });
      expect(result.fileRemoved).toBe(false);
      expect(result.backup).toBeUndefined();
      expect(await generalItems()).toEqual([]);
    });

    it('refuses an unregistered name, a case variant and a registration that vanished meanwhile', async () => {
      const missing = await callError('deregister_project_file', { name: 'nope.json' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('is not registered');
      nothingChanged(missing.text);

      await seedFamily('general', { items: [fileEntry('Data.json', 31)], subfolders: [] });
      await put('files/Data.json', 'kept');
      const variant = await callError('deregister_project_file', { name: 'data.json' });
      expect(variant.isError).toBe(true);
      expect(variant.text).toContain('"Data.json"');
      nothingChanged(variant.text);

      beforeNextProjectUpdate(() => saveInEditor(project => { project.rootFileFolders.general.items = []; }));
      const vanished = await callError('deregister_project_file', { name: 'Data.json' });
      expect(vanished.isError).toBe(true);
      expect(vanished.text).toContain('is no longer registered');
      nothingChanged(vanished.text);
      expect(await readFile(path('files', 'Data.json'), 'utf-8')).toBe('kept');
    });

    it('names a file it could not delete, by code, once the registration is gone', async () => {
      await call('register_project_file', { sourcePath: await source() });
      const file = path('files', 'source.json');
      vi.spyOn(writer, 'deleteFile').mockRejectedValueOnce(fsError('EBUSY', file));
      const result = await callError('deregister_project_file', { name: 'source.json' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Deregistered');
      expect(result.text).toContain('orphaned');
      expect(result.text).toContain('EBUSY');
      expect(result.text).not.toContain(dir);
      expect(await generalItems()).toEqual([]);
    });
  });

  describe('P20 deregister_project_file deletes only what it selected', () => {
    it('(a) leaves the file of a registration replaced during the call', async () => {
      await call('register_project_file', { sourcePath: await source('original') });
      beforeNextProjectUpdate(() => saveInEditor(project => { project.rootFileFolders.general.items = [fileEntry('source.json', 999)]; }));
      const result = await callError('deregister_project_file', { name: 'source.json' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('was registered again while this call ran');
      nothingChanged(result.text);
      expect(await readFile(path('files', 'source.json'), 'utf-8')).toBe('original');
      expect(existsSync(path('files', 'source.json.bak'))).toBe(false);
      expect((await generalItems()).map(item => item.sid)).toEqual([999]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('(b) leaves a file replaced after the registration was removed', async () => {
      await call('register_project_file', { sourcePath: await source('original') });
      afterNextProjectUpdate(async () => { await put('files/source.json', 'bytes of another length'); });
      const result = await callError('deregister_project_file', { name: 'source.json' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Deregistered');
      expect(result.text).toContain('files/source.json was changed since this call selected it, so it was left');
      expect(await readFile(path('files', 'source.json'), 'utf-8')).toBe('bytes of another length');
      expect(existsSync(path('files', 'source.json.bak'))).toBe(false);
      expect(await generalItems()).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('(c) leaves a file that appears after it was absent when selected', async () => {
      await call('register_project_file', { sourcePath: await source('original') });
      await rm(path('files', 'source.json'));
      afterNextProjectUpdate(async () => { await put('files/source.json', 'appeared'); });
      const result = await callError('deregister_project_file', { name: 'source.json' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Deregistered');
      expect(result.text).toContain('files/source.json was changed since this call selected it, so it was left');
      expect(await readFile(path('files', 'source.json'), 'utf-8')).toBe('appeared');
      expect(existsSync(path('files', 'source.json.bak'))).toBe(false);
      expect(await generalItems()).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe('P13 create_data_file', () => {
    it('writes an array with the default size, supplied data, and refuses a mismatch', async () => {
      const result = await call('create_data_file', { name: 'grid.json', kind: 'array', arraySize: [2, 2, 1] });
      expect(result.action).toBe('created');
      expect(result.kind).toBe('array');
      expect(result.path).toBe('files/grid.json');
      expect(result.generatedSid).toBe((await generalItems())[0].sid);
      expect(JSON.parse(await readFile(path('files', 'grid.json'), 'utf-8'))).toEqual({ c2array: true, size: [2, 2, 1], data: [[[0], [0]], [[0], [0]]] });

      await call('create_data_file', { name: 'given.json', kind: 'array', arraySize: [2, 1, 1], content: '[[[5]],[[6]]]' });
      expect(JSON.parse(await readFile(path('files', 'given.json'), 'utf-8'))).toEqual({ c2array: true, size: [2, 1, 1], data: [[[5]], [[6]]] });

      const before = await projectBytes();
      const mismatch = await callError('create_data_file', { name: 'bad.json', kind: 'array', arraySize: [3, 1, 1], content: '[[[5]],[[6]]]' });
      expect(mismatch.isError).toBe(true);
      expect(mismatch.text).toContain('3 column(s)');
      expect(existsSync(path('files', 'bad.json'))).toBe(false);
      expect((await projectBytes()).equals(before)).toBe(true);
    });

    it('writes a dictionary, json as given, text as given, with the MIME types', async () => {
      await call('create_data_file', { name: 'dict.json', kind: 'dictionary' });
      expect(JSON.parse(await readFile(path('files', 'dict.json'), 'utf-8'))).toEqual({ c2dictionary: true, data: {} });
      await call('create_data_file', { name: 'dict2.json', kind: 'dictionary', content: '{"a":1}' });
      expect(JSON.parse(await readFile(path('files', 'dict2.json'), 'utf-8'))).toEqual({ c2dictionary: true, data: { a: 1 } });
      await call('create_data_file', { name: 'levels.json', kind: 'json', content: '{"levels":3}' });
      expect(await readFile(path('files', 'levels.json'), 'utf-8')).toBe('{"levels":3}');
      await call('create_data_file', { name: 'notes.txt', kind: 'text', content: 'line one\nline two' });
      expect(await readFile(path('files', 'notes.txt'), 'utf-8')).toBe('line one\nline two');
      const items = await generalItems();
      expect(items.find(item => item.name === 'levels.json')?.type).toBe('application/json');
      expect(items.find(item => item.name === 'notes.txt')?.type).toBe('text/plain');
      const nested = await call('create_data_file', { name: 'deep.json', kind: 'json', subfolder: 'data' });
      expect(nested.path).toBe('files/data/deep.json');
      expect(await readFile(path('files', 'data', 'deep.json'), 'utf-8')).toBe('{}');
      expect((await family('general')).subfolders[0].items.map(item => item.name)).toEqual(['deep.json']);
    });
  });

  describe('P14 create_data_file refusals', () => {
    /** Assert a refusal that leaves the project as it was. */
    async function expectRefusal(args: Record<string, unknown>, reason: string) {
      const before = await projectBytes();
      const result = await callError('create_data_file', args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(reason);
      expect(result.text.startsWith('Error creating data file')).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
      nothingChanged(result.text);
      expect((await projectBytes()).equals(before)).toBe(true);
      return result;
    }

    it('refuses a name that is registered, a file at the path, and case variants', async () => {
      await call('create_data_file', { name: 'taken.json', kind: 'json' });
      await expectRefusal({ name: 'taken.json', kind: 'json' }, 'already registered');
      await put('files/loose.json', 'loose');
      await expectRefusal({ name: 'loose.json', kind: 'json' }, 'A file already exists at');
      expect(await readFile(path('files', 'loose.json'), 'utf-8')).toBe('loose');
      await put('files/Levels.json', 'levels');
      await expectRefusal({ name: 'levels.json', kind: 'json' }, 'It was left unchanged');
      expect(await readFile(path('files', 'Levels.json'), 'utf-8')).toBe('levels');
      await expectRefusal({ name: 'TAKEN.json', kind: 'json' }, 'differs only in case');
    });

    it('refuses a name with a colon', async () => {
      await expectRefusal({ name: 'levels.json:x', kind: 'json' }, 'must not contain');
    });

    it('refuses content that is not valid JSON, from the body builder and not the outer catch', async () => {
      await expectRefusal({ name: 'bad.json', kind: 'json', content: '{nope' }, 'not valid JSON');
      expect(existsSync(path('files', 'bad.json'))).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
      const result = await callError('create_data_file', { name: 'bad.json', kind: 'json', content: '{nope' });
      expect(result.text.startsWith('Error creating data file')).toBe(false);
    });

    it('refuses arraySize for another kind and arrays over the cell limit', async () => {
      await expectRefusal({ name: 'x.json', kind: 'json', arraySize: [1, 1, 1] }, 'arraySize applies');
      await expectRefusal({ name: 'x.json', kind: 'array', arraySize: [1001, 1000, 1] }, 'holds 1001000 cells');
      const original = Array.from.bind(Array) as (...args: unknown[]) => unknown[];
      let built = 0;
      vi.spyOn(Array, 'from').mockImplementation(((...args: unknown[]) => {
        const first = args[0] as { length?: number } | null;
        if (first !== null && typeof first === 'object' && !Array.isArray(first) && typeof first.length === 'number' && first.length >= 1000) {
          built += 1;
          if (built > 100) throw new Error('test error: the array body was built');
        }
        return original(...args);
      }) as unknown as typeof Array.from);
      await expectRefusal({ name: 'x.json', kind: 'array', arraySize: [10000, 10000, 0] }, 'holds 100000000 cells');
      expect(built).toBe(0);
      expect(existsSync(path('files', 'x.json'))).toBe(false);
    });
  });

  it('P15 puts the registration back when the data file cannot be written', async () => {
    const before = await projectBytes();
    vi.spyOn(writer, 'replaceFile').mockRejectedValueOnce(fsError('ENOSPC', path('files', 'grid.json')));
    const result = await callError('create_data_file', { name: 'grid.json', kind: 'array' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ENOSPC');
    expect(result.text).toContain('The registration in project.c3proj was put back');
    expect(result.text).not.toContain(dir);
    expect(existsSync(path('files', 'grid.json'))).toBe(false);
    expect((await projectBytes()).equals(before)).toBe(true);
  });

  it('P16 keeps the BOM, CRLF line ends and trailing line end of project.c3proj', async () => {
    await seedFamily('general', { items: [], subfolders: [] }, { eol: '\r\n', trailing: '\r\n', bom: true });
    const check = async () => {
      const text = (await projectBytes()).toString('utf-8');
      expect(text.startsWith(BOM)).toBe(true);
      expect(/(?<!\r)\n/.test(text)).toBe(false);
      expect(text.endsWith('\r\n')).toBe(true);
    };
    await call('register_project_file', { sourcePath: await source() });
    await check();
    expect((await generalItems()).map(item => item.name)).toEqual(['source.json']);
    await call('deregister_project_file', { name: 'source.json' });
    await check();
    expect(await generalItems()).toEqual([]);
  });

  describe('P17 the writer temporary file name', () => {
    /** create_data_file and register_project_file of data.json are both refused with `reason`, and nothing changes. */
    async function expectBlocked(reason: string, tmpBytes: string) {
      const before = await projectBytes();
      const sourcePath = await source();
      for (const [tool, args] of [['create_data_file', { name: 'data.json', kind: 'json' }], ['register_project_file', { name: 'data.json', sourcePath }]] as const) {
        const result = await callError(tool, args);
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toContain(reason);
        nothingChanged(result.text);
      }
      expect(await readFile(path('files', 'data.json.tmp'), 'utf-8')).toBe(tmpBytes);
      expect(existsSync(path('files', 'data.json'))).toBe(false);
      expect((await projectBytes()).equals(before)).toBe(true);
    }

    it('refuses a name whose .tmp is registered', async () => {
      await seedFamily('general', { items: [fileEntry('data.json.tmp', 41)], subfolders: [] });
      await put('files/data.json.tmp', 'tmp bytes');
      await expectBlocked('"data.json.tmp" is a registered file', 'tmp bytes');
      expect((await generalItems()).map(item => item.name)).toEqual(['data.json.tmp']);
    });

    it('names the registered spelling of a case variant', async () => {
      await seedFamily('general', { items: [fileEntry('DATA.JSON.tmp', 42)], subfolders: [] });
      await put('files/DATA.JSON.tmp', 'tmp bytes');
      const before = await projectBytes();
      const result = await callError('create_data_file', { name: 'data.json', kind: 'json' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"DATA.JSON.tmp" is a registered file');
      nothingChanged(result.text);
      expect(await readFile(path('files', 'DATA.JSON.tmp'), 'utf-8')).toBe('tmp bytes');
      expect((await projectBytes()).equals(before)).toBe(true);
    });

    it('refuses a name whose .tmp is an unregistered file on disk', async () => {
      await put('files/data.json.tmp', 'tmp bytes');
      await expectBlocked('"data.json.tmp" is a file in the same folder', 'tmp bytes');
      expect(await generalItems()).toEqual([]);
    });

    it('still creates and registers data.json.tmp itself while data.json is not there', async () => {
      const created = await call('create_data_file', { name: 'data.json.tmp', kind: 'text', content: 'a' });
      expect(created.action).toBe('created');
      const registered = await call('register_project_file', { name: 'data.json.tmp', sourcePath: await source('b'), subfolder: 'more' });
      expect(registered.action).toBe('registered');
      expect(await readFile(path('files', 'data.json.tmp'), 'utf-8')).toBe('a');
      expect(await readFile(path('files', 'more', 'data.json.tmp'), 'utf-8')).toBe('b');
    });
  });

  describe('P18 the writer backup name', () => {
    it('refuses a deregister whose .bak is registered', async () => {
      await seedFamily('general', { items: [fileEntry('data.json', 51), fileEntry('data.json.bak', 52)], subfolders: [] });
      await put('files/data.json', 'main bytes');
      await put('files/data.json.bak', 'bak bytes');
      const before = await projectBytes();
      const result = await callError('deregister_project_file', { name: 'data.json' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"data.json.bak" is a registered file');
      nothingChanged(result.text);
      expect(await readFile(path('files', 'data.json'), 'utf-8')).toBe('main bytes');
      expect(await readFile(path('files', 'data.json.bak'), 'utf-8')).toBe('bak bytes');
      expect((await generalItems()).map(item => item.name)).toEqual(['data.json', 'data.json.bak']);
      expect((await projectBytes()).equals(before)).toBe(true);
    });

    it('replaces an unregistered .bak with the backup of the deleted file', async () => {
      await seedFamily('general', { items: [fileEntry('data.json', 51)], subfolders: [] });
      await put('files/data.json', 'main bytes');
      await put('files/data.json.bak', 'old bak');
      const result = await call('deregister_project_file', { name: 'data.json' });
      expect(result.fileRemoved).toBe(true);
      expect(await readFile(path('files', 'data.json.bak'), 'utf-8')).toBe('main bytes');
      expect(existsSync(path('files', 'data.json'))).toBe(false);
    });
  });

  describe('P19 a link or junction leaving the project', () => {
    const OUTSIDE_FILES = ['existing.json', 'marker.txt'];

    it('(a) refuses a subfolder that links outside', async () => {
      await mkdir(path('files'));
      await symlink(outside, path('files', 'linked'), 'junction');
      const before = await projectBytes();
      const sourcePath = await source();
      for (const [tool, args] of [
        ['register_project_file', { name: 'a.json', subfolder: 'linked', sourcePath }],
        ['create_data_file', { name: 'a.json', kind: 'json', subfolder: 'linked' }],
      ] as const) {
        const result = await callError(tool, args);
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toContain('leads outside the project folder');
        nothingChanged(result.text);
      }
      expect((await readdir(outside)).sort()).toEqual(OUTSIDE_FILES);
      expect((await projectBytes()).equals(before)).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('(b) refuses to delete a registered file reached through a link', async () => {
      await seedFamily('general', { items: [], subfolders: [sub('linked', [fileEntry('existing.json', 61)])] });
      await mkdir(path('files'));
      await symlink(outside, path('files', 'linked'), 'junction');
      const before = await projectBytes();
      const result = await callError('deregister_project_file', { name: 'existing.json', subfolder: 'linked' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('leads outside the project folder');
      nothingChanged(result.text);
      expect(await readFile(join(outside, 'existing.json'), 'utf-8')).toBe('{"outside":true}');
      expect((await readdir(outside)).sort()).toEqual(OUTSIDE_FILES);
      expect((await projectBytes()).equals(before)).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('(c) refuses a family directory that is a link', async () => {
      await symlink(outside, path('files'), 'junction');
      const sourcePath = await source();
      const before = await projectBytes();
      for (const [tool, args] of [
        ['register_project_file', { name: 'a.json', sourcePath }],
        ['create_data_file', { name: 'a.json', kind: 'json' }],
      ] as const) {
        const result = await callError(tool, args);
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toContain('leads outside the project folder');
        nothingChanged(result.text);
      }
      await seedFamily('general', { items: [fileEntry('existing.json', 62)], subfolders: [] });
      const deregistered = await callError('deregister_project_file', { name: 'existing.json' });
      expect(deregistered.isError).toBe(true);
      expect(deregistered.text).toContain('leads outside the project folder');
      nothingChanged(deregistered.text);
      expect((await readdir(outside)).sort()).toEqual(OUTSIDE_FILES);
      expect(await readFile(join(outside, 'existing.json'), 'utf-8')).toBe('{"outside":true}');
      expect(before.length).toBeGreaterThan(0);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('(d) accepts a link to a folder inside the project', async () => {
      await mkdir(path('files', 'real'), { recursive: true });
      await symlink(path('files', 'real'), path('files', 'alias'), 'junction');
      const result = await call('register_project_file', { sourcePath: await source(), subfolder: 'alias' });
      expect(result.action).toBe('registered');
      expect(await readFile(path('files', 'real', 'source.json'), 'utf-8')).toBe('{"fixture":true}');
    });

    it('(e) refuses a link that cannot be resolved', async () => {
      const target = join(sourceDir, 'gone');
      await mkdir(target);
      await mkdir(path('files'));
      await symlink(target, path('files', 'dangling'), 'junction');
      await rm(target, { recursive: true });
      const before = await projectBytes();
      const result = await callError('register_project_file', { sourcePath: await source(), subfolder: 'dangling' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('leads outside the project folder');
      nothingChanged(result.text);
      expect((await projectBytes()).equals(before)).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe('P22 the checks made again after the registration', () => {
    for (const [tool, nothing] of [['create_data_file', 'Nothing was written:'], ['register_project_file', 'Nothing was copied:']] as const) {
      it(`(a) ${tool} stops for a .tmp file created during the call`, async () => {
        const args = tool === 'register_project_file' ? { sourcePath: await source() } : { name: 'data.json', kind: 'json' };
        const finalArgs = tool === 'register_project_file' ? { ...args, name: 'data.json' } : args;
        const replace = vi.spyOn(writer, 'replaceFile');
        afterNextProjectUpdate(async () => { await put('files/data.json.tmp', 'tmp bytes'); });
        const result = await callError(tool, finalArgs);
        expect(result.isError).toBe(true);
        expect(result.text).toContain(nothing);
        expect(result.text).toContain('"data.json.tmp" is a file in the same folder');
        expect(result.text).toContain('The registration in project.c3proj was put back');
        expect(replace).toHaveBeenCalledTimes(0);
        expect(await readFile(path('files', 'data.json.tmp'), 'utf-8')).toBe('tmp bytes');
        expect(existsSync(path('files', 'data.json'))).toBe(false);
        expect(await generalItems()).toEqual([]);
      });

      it(`(b) ${tool} stops for a folder replaced by a link during the call`, async () => {
        await mkdir(path('files', 'linked'), { recursive: true });
        const args = tool === 'register_project_file'
          ? { sourcePath: await source(), name: 'a.json', subfolder: 'linked' }
          : { name: 'a.json', kind: 'json', subfolder: 'linked' };
        const replace = vi.spyOn(writer, 'replaceFile');
        afterNextProjectUpdate(async () => {
          await rm(path('files', 'linked'), { recursive: true });
          await symlink(outside, path('files', 'linked'), 'junction');
        });
        const result = await callError(tool, args);
        expect(result.isError).toBe(true);
        expect(result.text).toContain(nothing);
        expect(result.text).toContain('leads outside the project folder');
        expect(result.text).toContain('The registration in project.c3proj was put back');
        expect(replace).toHaveBeenCalledTimes(0);
        expect((await readdir(outside)).sort()).toEqual(['existing.json', 'marker.txt']);
      });
    }

    it('(b) deregister_project_file leaves a file whose folder became a link during the call', async () => {
      await seedFamily('general', { items: [], subfolders: [sub('linked', [fileEntry('existing.json', 71)])] });
      await put('files/linked/existing.json', '{"inside":true}');
      const remove = vi.spyOn(writer, 'deleteFile');
      afterNextProjectUpdate(async () => {
        await rm(path('files', 'linked'), { recursive: true });
        await symlink(outside, path('files', 'linked'), 'junction');
      });
      const result = await callError('deregister_project_file', { name: 'existing.json', subfolder: 'linked' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Deregistered');
      expect(result.text).toContain('leads outside the project folder');
      expect(result.text).toContain('was left in place');
      expect(remove).not.toHaveBeenCalled();
      expect(await readFile(join(outside, 'existing.json'), 'utf-8')).toBe('{"outside":true}');
      expect((await readdir(outside)).sort()).toEqual(['existing.json', 'marker.txt']);
    });
  });
});
