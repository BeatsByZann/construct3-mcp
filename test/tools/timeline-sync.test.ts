/**
 * Each of the four timeline tool modules sees a change made on disk between
 * two calls: a registration added to project.c3proj, a layout or an ease
 * written and registered. The tools are registered the way the server
 * registers them, so a module that does not sync the project by itself shows
 * as a second call that still answers from the project it loaded first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { createCustomEase } from '../../src/construct3/timeline-model.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';
import type { MutationToolDeps } from '../../src/tools/shared.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

/** The parts of project.c3proj these tests change. */
interface ProjectJson {
  layouts: { items: string[] };
  timelines: { items: string[]; subfolders: Array<{ name?: string; items: string[]; subfolders: unknown[] }> };
}

/** The parts of a layout file these tests change. */
interface LayoutJson {
  name: string;
  sid: number;
  layers: Array<{ sid: number; instances: Array<{ uid: number; sid: number }> }>;
}

/** What a scenario can do to the project and ask of the tools. */
interface Env {
  ok(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  editProject(change: (project: ProjectJson) => void): Promise<void>;
  file(rel: string): string;
}

describe.each([
  {
    module: 'timeline-tools',
    run: async ({ ok, editProject }: Env) => {
      expect((await ok('list_timelines', {})).timelines).toEqual([]);
      await editProject(project => { project.timelines.items.push('Late'); });
      expect((await ok('list_timelines', {})).timelines).toEqual(['Late']);
    },
  },
  {
    module: 'timeline-instance-tools',
    run: async ({ ok, editProject, file }: Env) => {
      await ok('create_timeline', { name: 'Move' });
      await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 1', instanceUid: 0 });

      // A second layout with its own instance, written and registered after the first call
      const layout = JSON.parse(await readFile(file('layouts/Layout 1.json'), 'utf-8')) as LayoutJson;
      layout.name = 'Layout 2';
      layout.sid += 10;
      layout.layers[0].sid += 10;
      layout.layers[0].instances[0].uid = 7;
      layout.layers[0].instances[0].sid += 10;
      await writeFile(file('layouts/Layout 2.json'), JSON.stringify(layout, null, '\t'), 'utf-8');
      await editProject(project => { project.layouts.items.push('Layout 2'); });

      const added = await ok('add_timeline_track', { timelineName: 'Move', layoutName: 'Layout 2', instanceUid: 7 });
      expect(added.success).toBe(true);
    },
  },
  {
    module: 'timeline-track-tools',
    run: async ({ ok, editProject, file }: Env) => {
      await ok('create_timeline', { name: 'Move' });
      expect((await ok('list_timeline_tracks', { timelineName: 'Move' })).count).toBe(0);

      // A second timeline, written and registered after the first call
      const timeline = JSON.parse(await readFile(file('timelines/Move.json'), 'utf-8')) as { name: string };
      timeline.name = 'Late';
      await writeFile(file('timelines/Late.json'), JSON.stringify(timeline, null, '\t'), 'utf-8');
      await editProject(project => { project.timelines.items.push('Late'); });

      const listed = await ok('list_timeline_tracks', { timelineName: 'Late' });
      expect(listed).toMatchObject({ timeline: 'Late', count: 0 });
    },
  },
  {
    module: 'timeline-ease-tools',
    run: async ({ ok, editProject, file }: Env) => {
      expect((await ok('list_eases', {})).count).toBe(0);

      // An ease written and registered in the Transitions folder after the first call
      const ease = createCustomEase('Late', [{ x: 0, y: 0 }, { x: 1, y: 1 }], false, 'any');
      await mkdir(file('timelines/transitions'), { recursive: true });
      await writeFile(file('timelines/transitions/Late.json'), JSON.stringify(ease, null, '\t'), 'utf-8');
      await editProject(project => { project.timelines.subfolders.push({ items: ['Late'], subfolders: [] }); });

      const listed = await ok('list_eases', {});
      expect(listed.count).toBe(1);
      expect((listed.eases as Array<{ name: string }>)[0].name).toBe('Late');
    },
  },
])('$module', ({ run }) => {
  let tmpDir: string;
  let server: MockServer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-timeline-sync-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerTimelineTools({ server, reader, writer, idGen } as unknown as MutationToolDeps);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  const env = (): Env => ({
    file: rel => join(tmpDir, ...rel.split('/')),
    async ok(tool, args) {
      const result = await server.callTool(tool, args);
      if (result.isError) throw new Error(`${tool} failed: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
    async editProject(change) {
      const path = join(tmpDir, 'project.c3proj');
      const project = JSON.parse(await readFile(path, 'utf-8')) as ProjectJson;
      change(project);
      await writeFile(path, JSON.stringify(project, null, '\t'), 'utf-8');
    },
  });

  it('sees a change made on disk between two calls', async () => {
    await run(env());
  });
});
