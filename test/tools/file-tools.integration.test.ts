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
});
