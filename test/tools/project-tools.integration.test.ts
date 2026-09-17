/**
 * Real-writer tests for the project-property allowlist.
 *
 * `updateProjectProperties` decides from its allowlist whether a key belongs at
 * the top level of the .c3proj or inside `properties`. The mock writer only
 * records the call, so the routing of the newly allowed top-level keys
 * (`firstLayout`, `viewportWidth`, `viewportHeight`, `useWorker`,
 * `functionsName`) is only proven against a real file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('update_project_properties (real project on disk)', () => {
  let tmpDir: string;
  let reader: Construct3ProjectReader;
  let writer: Construct3ProjectWriter;
  let idGen: IdGenerator;
  let server: MockServer;

  beforeEach(async () => {
    resetProjectIndex();
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-project-int-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });

    reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    idGen = new IdGenerator();
    writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerProjectTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function projectOnDisk(): Promise<any> {
    return JSON.parse(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8'));
  }

  it('writes the new keys at the top level, not into properties', async () => {
    const result = parseResult(await server.callTool('update_project_properties', {
      firstLayout: 'Layout 1',
      viewportWidth: 960,
      viewportHeight: 540,
      useWorker: 'auto',
      functionsName: 'Fn',
    }));
    expect(result.success).toBe(true);

    const project = await projectOnDisk();
    expect(project.firstLayout).toBe('Layout 1');
    expect(project.viewportWidth).toBe(960);
    expect(project.viewportHeight).toBe(540);
    expect(project.useWorker).toBe('auto');
    expect(project.functionsName).toBe('Fn');
    for (const key of ['firstLayout', 'viewportWidth', 'viewportHeight', 'useWorker', 'functionsName']) {
      expect(project.properties[key]).toBeUndefined();
    }
    // The reloaded project agrees with the file
    expect(reader.getMetadata().viewportWidth).toBe(960);
  });

  it('writes properties keys into properties and leaves the rest alone', async () => {
    const before = await projectOnDisk();
    const result = parseResult(await server.callTool('update_project_properties', {
      properties: { fullscreenMode: 'scale-inner', zFar: 5000, fixedFramerate: 30 },
    }));
    expect(result.success).toBe(true);

    const project = await projectOnDisk();
    expect(project.properties.fullscreenMode).toBe('scale-inner');
    expect(project.properties.zFar).toBe(5000);
    expect(project.properties.fixedFramerate).toBe(30);
    expect(project.properties.author).toBe(before.properties.author);
    expect(project.firstLayout).toBe(before.firstLayout);
  });

  it('rejects an unknown key before touching the file', async () => {
    const before = await readFile(join(tmpDir, 'project.c3proj'), 'utf-8');
    const result = await server.callTool('update_project_properties', {
      properties: { madeUpKey: true },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('madeUpKey');
    expect(await readFile(join(tmpDir, 'project.c3proj'), 'utf-8')).toBe(before);
  });

  it('the writer itself still refuses a key outside both allowlists', async () => {
    await expect(writer.updateProjectProperties({ bogusKey: 1 })).rejects.toThrow(/Unknown project property key/);
  });
});
