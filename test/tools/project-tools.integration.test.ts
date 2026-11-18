/**
 * update_project_properties on a real project on disk.
 *
 * The mock writer only records a call, so what the tool leaves in
 * project.c3proj (top-level keys at the top level, `properties` keys inside
 * `properties`, the reader agreeing with the file, nothing touched on a
 * refusal) is shown here against a real reader and writer over a temp copy of
 * test/fixtures/minimal-project. All data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFile, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { registerProjectTools } from '../../src/tools/project-tools.js';
import {
  makeProject,
  parseResult,
  removeFlowchartProject,
  type FlowchartProject,
} from '../helpers/flowchart-project.js';

let project: FlowchartProject;

const projectFile = (): string => join(project.dir, 'project.c3proj');

/** project.c3proj as it is on disk, parsed. */
async function projectOnDisk(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(projectFile(), 'utf-8'));
}

/** Every file name under the project folder, relative, with `/` separators. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found;
}

/** The top-level keys the tool writes at the top level of project.c3proj. */
const TOP_LEVEL_KEYS = ['firstLayout', 'viewportWidth', 'viewportHeight', 'useWorker', 'functionsName'];

beforeEach(async () => {
  project = await makeProject({ plugin: false });
  // A second layout, so that setting firstLayout changes the value the fixture has
  await copyFile(join(project.dir, 'layouts', 'Layout 1.json'), join(project.dir, 'layouts', 'Layout 2.json'));
  const parsed = await projectOnDisk();
  parsed.layouts.items.push('Layout 2');
  await writeFile(projectFile(), JSON.stringify(parsed, null, '\t'), 'utf-8');
  await project.reader.loadProject();
  registerProjectTools({ server: project.server as never, reader: project.reader, writer: project.writer, idGen: project.idGen } as never);
});

afterEach(async () => {
  await removeFlowchartProject(project);
});

describe('update_project_properties (real project on disk)', () => {
  it('writes the top-level keys at the top level, not into properties, and the reader agrees', async () => {
    const before = await projectOnDisk();
    expect(before.firstLayout).toBe('Layout 1');

    const result = await project.server.callTool('update_project_properties', {
      firstLayout: 'Layout 2',
      viewportWidth: 960,
      viewportHeight: 540,
      useWorker: 'auto',
      functionsName: 'Fn',
    });
    expect(result.isError).not.toBe(true);
    expect(parseResult(result).success).toBe(true);

    const written = await projectOnDisk();
    expect(written.firstLayout).toBe('Layout 2');
    expect(written.viewportWidth).toBe(960);
    expect(written.viewportHeight).toBe(540);
    expect(written.useWorker).toBe('auto');
    expect(written.functionsName).toBe('Fn');
    for (const key of TOP_LEVEL_KEYS) expect(written.properties[key]).toBeUndefined();

    // The reader was reloaded: it shows the new values, not the old ones
    const loaded = project.reader.getProject();
    expect(loaded.firstLayout).toBe('Layout 2');
    expect(loaded.viewportWidth).toBe(960);
    expect(loaded.viewportHeight).toBe(540);
    expect(loaded.useWorker).toBe('auto');
    expect(loaded.functionsName).toBe('Fn');
  });

  it('writes properties keys into properties, fixedFramerate among them, and leaves the rest alone', async () => {
    const before = await projectOnDisk();
    const result = await project.server.callTool('update_project_properties', {
      properties: { fullscreenMode: 'scale-inner', zFar: 5000, fixedFramerate: 30 },
    });
    expect(result.isError).not.toBe(true);
    expect(parseResult(result).success).toBe(true);

    const written = await projectOnDisk();
    expect(written.properties.fullscreenMode).toBe('scale-inner');
    expect(written.properties.zFar).toBe(5000);
    expect(written.properties.fixedFramerate).toBe(30);
    expect(written.properties.author).toBe(before.properties.author);
    for (const key of ['fullscreenMode', 'zFar', 'fixedFramerate']) expect(written[key]).toBeUndefined();
    expect(written.firstLayout).toBe(before.firstLayout);
    expect(project.reader.getProject().properties.fixedFramerate).toBe(30);
  });

  it('writes firstLayout in the registered spelling when it is given in another letter case', async () => {
    const result = await project.server.callTool('update_project_properties', { firstLayout: 'lAYOUT 2' });
    expect(result.isError).not.toBe(true);
    expect((await projectOnDisk()).firstLayout).toBe('Layout 2');
    expect(project.reader.getProject().firstLayout).toBe('Layout 2');
  });

  it('refuses a firstLayout that names no registered layout and leaves project.c3proj and the folder as they were', async () => {
    const bytesBefore = await readFile(projectFile());
    const filesBefore = await filesUnder(project.dir);

    const result = await project.server.callTool('update_project_properties', {
      firstLayout: 'Nowhere',
      viewportWidth: 960,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text.endsWith('Nothing was changed.')).toBe(true);
    expect(result.content[0].text).toContain('Layout 1');

    expect((await readFile(projectFile())).equals(bytesBefore)).toBe(true);
    const filesAfter = await filesUnder(project.dir);
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter.filter(name => name.endsWith('.bak'))).toEqual([]);
  });

  it('refuses an argument the tool does not take, by name, and leaves project.c3proj and the folder as they were', async () => {
    const bytesBefore = await readFile(projectFile());
    const filesBefore = await filesUnder(project.dir);

    // fullscreenMode belongs inside `properties`; at the top level it is unknown
    await expect(project.server.callTool('update_project_properties', { firstLayout: 'Layout 2', fullscreenMode: 'off' }))
      .rejects.toThrow(/"fullscreenMode"/);

    expect((await readFile(projectFile())).equals(bytesBefore)).toBe(true);
    const filesAfter = await filesUnder(project.dir);
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter.filter(name => name.endsWith('.bak'))).toEqual([]);
  });

  it('refuses an unknown properties key by name and leaves project.c3proj as it was', async () => {
    const bytesBefore = await readFile(projectFile());
    const result = await project.server.callTool('update_project_properties', { properties: { madeUpKey: true } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('madeUpKey');
    expect((await readFile(projectFile())).equals(bytesBefore)).toBe(true);
  });
});
