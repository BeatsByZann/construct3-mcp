import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerFileTools } from '../../src/tools/file-tools.js';
import { MockServer } from '../mocks/mock-server.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'minimal-project');

function resultOf(value: { content: Array<{ text: string }>; isError?: boolean }): Record<string, unknown> {
  if (value.isError) throw new Error(value.content[0]?.text);
  return JSON.parse(value.content[0].text) as Record<string, unknown>;
}

describe('script and Project File registration tools', () => {
  let projectDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'c3-file-tools-'));
    await cp(FIXTURE_DIR, projectDir, { recursive: true });
    reader = new Construct3ProjectReader(join(projectDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerFileTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('registers and deregisters nested scripts with script-info and a generated SID', async () => {
    const registered = resultOf(await server.callTool('register_script_file', {
      name: 'host.js', subfolder: 'embedded/runtime', purpose: 'none',
    }));
    expect(registered.action).toBe('registered');
    expect(typeof registered.generatedSid).toBe('number');

    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    const item = project.rootFileFolders.script.subfolders[0].subfolders[0].items[0];
    expect(item).toMatchObject({ name: 'host.js', type: 'application/javascript', 'script-info': { purpose: 'none' } });
    expect(item['file-info']).toBeUndefined();
    expect(item.sid).not.toBe(project.rootFileFolders.icon.items[0].sid);

    const duplicateCall = resultOf(await server.callTool('register_script_file', {
      name: 'host.js', subfolder: 'embedded/runtime', purpose: 'none',
    }));
    expect(duplicateCall.action).toBe('already_registered');
    expect(duplicateCall.generatedSid).toBe(item.sid);
    const afterDuplicate = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(afterDuplicate.rootFileFolders.script.subfolders[0].subfolders[0].items).toHaveLength(1);

    const removed = resultOf(await server.callTool('deregister_script_file', {
      name: 'host.js', subfolder: 'embedded/runtime',
    }));
    expect(removed.action).toBe('deregistered');
    const after = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(after.rootFileFolders.script.subfolders[0].subfolders[0].items).toHaveLength(0);
  });

  it('repairs legacy script metadata and duplicate registrations without changing the SID', async () => {
    const projectPath = join(projectDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as any;
    project.rootFileFolders.script.items.push(
      { name: 'legacy.js', type: 'application/javascript', sid: 987654321012345, 'file-info': { purpose: 'none' } },
      { name: 'legacy.js', type: 'application/javascript', sid: 987654321012346, 'file-info': { purpose: 'none' } },
    );
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf8');
    await reader.loadProject();

    const result = resultOf(await server.callTool('register_script_file', { name: 'legacy.js' }));
    expect(result.action).toBe('already_registered');
    expect(result.generatedSid).toBe(987654321012345);
    const repaired = JSON.parse(await readFile(projectPath, 'utf8')) as any;
    const entries = repaired.rootFileFolders.script.items.filter((item: any) => item.name === 'legacy.js');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sid: 987654321012345, 'script-info': { purpose: 'none' } });
    expect(entries[0]['file-info']).toBeUndefined();
  });

  it('rejects conflicting folder/category aliases before copying or writing', async () => {
    const sourcePath = join(projectDir, 'alias.json');
    await writeFile(sourcePath, '{}', 'utf8');
    const result = await server.callTool('register_project_file', {
      sourcePath,
      folder: 'general',
      category: 'sound',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aliases disagree');
    await expect(readFile(join(projectDir, 'files', 'alias.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(project.rootFileFolders.general.items).toHaveLength(0);
    expect(project.rootFileFolders.sound.items).toHaveLength(0);
  });

  it('copies, registers, and removes a nested Project File using file-info', async () => {
    const sourcePath = join(projectDir, 'source.json');
    await writeFile(sourcePath, '{"fixture":true}', 'utf8');
    const registered = resultOf(await server.callTool('register_project_file', {
      sourcePath, folder: 'general', subfolder: 'editor/assets',
    }));
    expect(registered.action).toBe('registered');

    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    const item = project.rootFileFolders.general.subfolders[0].subfolders[0].items[0];
    expect(item).toMatchObject({ name: 'source.json', type: 'application/json', 'file-info': { purpose: 'none' } });
    expect(item['script-info']).toBeUndefined();
    expect(await readFile(join(projectDir, 'files', 'editor', 'assets', 'source.json'), 'utf8')).toBe('{"fixture":true}');

    const removed = resultOf(await server.callTool('deregister_project_file', {
      name: 'source.json', folder: 'general', subfolder: 'editor/assets',
    }));
    expect(removed.action).toBe('deregistered');
    await expect(readFile(join(projectDir, 'files', 'editor', 'assets', 'source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('short-circuits an existing Project File without requiring a source and repairs legacy metadata', async () => {
    const projectPath = join(projectDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as any;
    project.rootFileFolders.general.items.push({
      name: 'existing.json',
      type: 'application/json',
      sid: 876543210123456,
      'script-info': { purpose: 'none' },
    });
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf8');
    await reader.loadProject();

    const result = resultOf(await server.callTool('register_project_file', {
      name: 'existing.json',
      folder: 'general',
    }));
    expect(result.action).toBe('already_registered');
    expect(result.generatedSid).toBe(876543210123456);
    const repaired = JSON.parse(await readFile(projectPath, 'utf8')) as any;
    expect(repaired.rootFileFolders.general.items).toHaveLength(1);
    expect(repaired.rootFileFolders.general.items[0]).toMatchObject({ sid: 876543210123456, 'file-info': { purpose: 'none' } });
    expect(repaired.rootFileFolders.general.items[0]['script-info']).toBeUndefined();
  });

  it('accepts identical folder/category aliases', async () => {
    const sourcePath = join(projectDir, 'same.json');
    await writeFile(sourcePath, '{}', 'utf8');
    const result = resultOf(await server.callTool('register_project_file', {
      sourcePath,
      folder: 'general',
      category: 'general',
    }));
    expect(result.action).toBe('registered');
    expect(result.folder).toBe('general');
  });

  it('rejects conflicting folder/category aliases when deregistering too', async () => {
    const projectPath = join(projectDir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as any;
    project.rootFileFolders.general.items.push({
      name: 'keep.json', type: 'application/json', sid: 765432101234567, 'file-info': { purpose: 'none' },
    });
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf8');
    await reader.loadProject();

    const result = await server.callTool('deregister_project_file', {
      name: 'keep.json', folder: 'general', category: 'sound',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aliases disagree');
    const unchanged = JSON.parse(await readFile(projectPath, 'utf8')) as any;
    expect(unchanged.rootFileFolders.general.items).toHaveLength(1);
  });

  // ─── per-family destination directories ────────────────

  const familyDirectories: Array<[string, string]> = [
    ['general', 'files'],
    ['sound', 'sounds'],
    ['music', 'music'],
    ['video', 'videos'],
    ['font', 'fonts'],
  ];

  for (const [folder, directory] of familyDirectories) {
    it(`copies a ${folder} Project File into ${directory}/`, async () => {
      const sourcePath = join(projectDir, `asset-${folder}.bin`);
      await writeFile(sourcePath, `payload-${folder}`, 'utf8');

      const registered = resultOf(await server.callTool('register_project_file', { sourcePath, folder }));
      expect(registered.action).toBe('registered');
      expect(registered.path).toBe(`${directory}/asset-${folder}.bin`);
      expect(await readFile(join(projectDir, directory, `asset-${folder}.bin`), 'utf8')).toBe(`payload-${folder}`);

      const removed = resultOf(await server.callTool('deregister_project_file', {
        name: `asset-${folder}.bin`, folder,
      }));
      expect(removed.path).toBe(`${directory}/asset-${folder}.bin`);
      await expect(readFile(join(projectDir, directory, `asset-${folder}.bin`)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  it('keeps a sound Project File out of files/', async () => {
    const sourcePath = join(projectDir, 'clip.webm');
    await writeFile(sourcePath, 'opus', 'utf8');
    resultOf(await server.callTool('register_project_file', {
      sourcePath, folder: 'sound', type: 'audio/webm; codecs=opus',
    }));

    expect(await readFile(join(projectDir, 'sounds', 'clip.webm'), 'utf8')).toBe('opus');
    await expect(readFile(join(projectDir, 'files', 'clip.webm'))).rejects.toMatchObject({ code: 'ENOENT' });
    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(project.rootFileFolders.sound.items[0]).toMatchObject({
      name: 'clip.webm', type: 'audio/webm; codecs=opus', 'file-info': { purpose: 'none' },
    });
  });

  it('copies a nested sound Project File into sounds/<subfolder>/', async () => {
    const sourcePath = join(projectDir, 'nested.webm');
    await writeFile(sourcePath, 'nested-opus', 'utf8');
    const registered = resultOf(await server.callTool('register_project_file', {
      sourcePath, folder: 'sound', subfolder: 'ambience/forest',
    }));
    expect(registered.path).toBe('sounds/ambience/forest/nested.webm');
    expect(await readFile(join(projectDir, 'sounds', 'ambience', 'forest', 'nested.webm'), 'utf8')).toBe('nested-opus');
  });

  // ─── create_data_file ──────────────────────────────────

  it('writes a zero-filled c2array body and registers it under general', async () => {
    const created = resultOf(await server.callTool('create_data_file', {
      name: 'grid.json', kind: 'array', arraySize: [2, 2, 1],
    }));
    expect(created.action).toBe('created');
    expect(created.path).toBe('files/grid.json');
    expect(typeof created.generatedSid).toBe('number');

    const body = JSON.parse(await readFile(join(projectDir, 'files', 'grid.json'), 'utf8')) as any;
    expect(body).toEqual({ c2array: true, size: [2, 2, 1], data: [[[0], [0]], [[0], [0]]] });

    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(project.rootFileFolders.general.items[0]).toMatchObject({
      name: 'grid.json', type: 'application/json', 'file-info': { purpose: 'none' },
    });
  });

  it('writes supplied array data and rejects data that does not match arraySize', async () => {
    const created = resultOf(await server.callTool('create_data_file', {
      name: 'filled.json', kind: 'array', arraySize: [2, 1, 1], content: '[[[7]],[[9]]]',
    }));
    expect(created.action).toBe('created');
    const body = JSON.parse(await readFile(join(projectDir, 'files', 'filled.json'), 'utf8')) as any;
    expect(body.data).toEqual([[[7]], [[9]]]);

    const mismatch = await server.callTool('create_data_file', {
      name: 'mismatch.json', kind: 'array', arraySize: [3, 1, 1], content: '[[[7]]]',
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0].text).toContain('3 column(s)');
    await expect(readFile(join(projectDir, 'files', 'mismatch.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes a c2dictionary body', async () => {
    resultOf(await server.callTool('create_data_file', {
      name: 'names.json', kind: 'dictionary', content: '{"hero":"Ada"}',
    }));
    const body = JSON.parse(await readFile(join(projectDir, 'files', 'names.json'), 'utf8')) as any;
    expect(body).toEqual({ c2dictionary: true, data: { hero: 'Ada' } });
  });

  it('writes an empty c2dictionary body when no content is supplied', async () => {
    resultOf(await server.callTool('create_data_file', { name: 'empty.json', kind: 'dictionary' }));
    const body = JSON.parse(await readFile(join(projectDir, 'files', 'empty.json'), 'utf8')) as any;
    expect(body).toEqual({ c2dictionary: true, data: {} });
  });

  it('writes plain JSON and text bodies with the matching MIME type', async () => {
    resultOf(await server.callTool('create_data_file', {
      name: 'config.json', kind: 'json', content: '{"levels":3}', subfolder: 'data',
    }));
    const config = JSON.parse(await readFile(join(projectDir, 'files', 'data', 'config.json'), 'utf8')) as any;
    expect(config).toEqual({ levels: 3 });

    resultOf(await server.callTool('create_data_file', {
      name: 'notes.txt', kind: 'text', content: 'line one',
    }));
    expect(await readFile(join(projectDir, 'files', 'notes.txt'), 'utf8')).toBe('line one');

    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(project.rootFileFolders.general.items.find((item: any) => item.name === 'notes.txt').type).toBe('text/plain');
    expect(project.rootFileFolders.general.subfolders[0].items[0].type).toBe('application/json');
  });

  it('refuses to overwrite an existing file or an existing registration', async () => {
    resultOf(await server.callTool('create_data_file', { name: 'once.json', kind: 'dictionary' }));

    const registered = await server.callTool('create_data_file', { name: 'once.json', kind: 'dictionary' });
    expect(registered.isError).toBe(true);
    expect(registered.content[0].text).toContain('already registered');

    await writeFile(join(projectDir, 'files', 'stray.json'), 'existing', 'utf8');
    const onDisk = await server.callTool('create_data_file', { name: 'stray.json', kind: 'dictionary' });
    expect(onDisk.isError).toBe(true);
    expect(onDisk.content[0].text).toContain('never overwrites');
    expect(await readFile(join(projectDir, 'files', 'stray.json'), 'utf8')).toBe('existing');
  });

  it('rejects malformed JSON content and a misapplied arraySize', async () => {
    const badJson = await server.callTool('create_data_file', {
      name: 'broken.json', kind: 'dictionary', content: '{not json',
    });
    expect(badJson.isError).toBe(true);
    expect(badJson.content[0].text).toContain('not valid JSON');
    await expect(readFile(join(projectDir, 'files', 'broken.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const misapplied = await server.callTool('create_data_file', {
      name: 'sized.txt', kind: 'text', arraySize: [1, 1, 1],
    });
    expect(misapplied.isError).toBe(true);
    expect(misapplied.content[0].text).toContain('arraySize applies to kind "array" only');
  });

  // ─── set_main_script ───────────────────────────────────

  it('moves the main purpose from one script to another', async () => {
    resultOf(await server.callTool('register_script_file', { name: 'main.js', purpose: 'main' }));
    resultOf(await server.callTool('register_script_file', { name: 'helpers.js' }));
    resultOf(await server.callTool('register_script_file', { name: 'boot.js', subfolder: 'runtime' }));

    const result = resultOf(await server.callTool('set_main_script', { name: 'boot.js' }));
    expect(result.action).toBe('updated');

    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    const root = project.rootFileFolders.script.items;
    expect(root.find((item: any) => item.name === 'main.js')['script-info'].purpose).toBe('none');
    expect(root.find((item: any) => item.name === 'helpers.js')['script-info'].purpose).toBe('none');
    expect(project.rootFileFolders.script.subfolders[0].items[0]['script-info'].purpose).toBe('main');

    const mains = [...root, ...project.rootFileFolders.script.subfolders[0].items]
      .filter((item: any) => item['script-info'].purpose === 'main');
    expect(mains).toHaveLength(1);
  });

  it('reports an unchanged result when the script is already main', async () => {
    resultOf(await server.callTool('register_script_file', { name: 'main.js', purpose: 'main' }));
    const result = resultOf(await server.callTool('set_main_script', { name: 'main.js' }));
    expect(result.action).toBe('unchanged');
    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(project.rootFileFolders.script.items[0]['script-info'].purpose).toBe('main');
  });

  it('rejects an unregistered script name', async () => {
    resultOf(await server.callTool('register_script_file', { name: 'main.js' }));
    const result = await server.callTool('set_main_script', { name: 'ghost.js' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Registered scripts: main.js');
  });

  it('asks for a subfolder when the same script name is registered twice', async () => {
    resultOf(await server.callTool('register_script_file', { name: 'boot.js' }));
    resultOf(await server.callTool('register_script_file', { name: 'boot.js', subfolder: 'runtime' }));

    const ambiguous = await server.callTool('set_main_script', { name: 'boot.js' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain('Pass subfolder');

    const chosen = resultOf(await server.callTool('set_main_script', { name: 'boot.js', subfolder: 'runtime' }));
    expect(chosen.action).toBe('updated');
    const project = JSON.parse(await readFile(join(projectDir, 'project.c3proj'), 'utf8')) as any;
    expect(project.rootFileFolders.script.items[0]['script-info'].purpose).toBe('none');
    expect(project.rootFileFolders.script.subfolders[0].items[0]['script-info'].purpose).toBe('main');
  });
});
