/**
 * Real-reader/writer tests for the template tools.
 *
 * The assertions pin the exact `template` block shape observed in C3-ACE
 * (`layouts/Legend/repoLegendObjects.json`): the five component ids in order,
 * `live-preview` dropped from the plugin state, one entry per behavior and
 * effect, the fixed 24-key world-instance list with `x`/`y` false, and
 * `replicasUIDs: null`.
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
import { registerTemplateTools, WORLD_INSTANCE_KEYS } from '../../src/tools/template-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'rename-project');

let tmpDir: string;
let server: MockServer;

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

async function readJson(...segments: string[]): Promise<any> {
  return JSON.parse(await readFile(join(tmpDir, ...segments), 'utf-8'));
}

async function templateOf(uid: number): Promise<any> {
  const layout = await readJson('layouts', 'Level 1.json');
  const all = [
    ...layout.layers[0].instances,
    ...layout.layers[0].subLayers[0].instances,
    ...layout['nonworld-instances'],
  ];
  return all.find((instance: { uid: number }) => instance.uid === uid)?.template;
}

beforeEach(async () => {
  resetProjectIndex();
  tmpDir = await mkdtemp(join(tmpdir(), 'c3-template-'));
  await cp(FIXTURE_DIR, tmpDir, { recursive: true });

  const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  server = new MockServer();
  registerTemplateTools({ server, reader, writer, idGen } as any);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('set_instance_template', () => {
  it('builds the full template block from the instance\'s own state', async () => {
    const result = parseResult(await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'template', templateName: 'Default',
    }));
    expect(result.success).toBe(true);
    expect(result.action).toBe('template created');

    const template = await templateOf(1);
    expect(template.mode).toBe('template');
    expect(template.templateName).toBe('Default');
    expect(template.sourceTemplateName).toBe('');
    expect(template.replicaHierarchyInSyncWithTemplate).toBe(false);
    expect(template.templatePropagateHierarchyChanges).toBe(true);
    expect(template.replicaIgnoreTemplateHierarchyChanges).toBe(false);
    expect(template.replicasUIDs).toBeNull();

    expect(template.components.map((component: { id: string }) => component.id))
      .toEqual(['plugin', 'instance-variable', 'behavior', 'effect', 'world-instance']);

    const byId = Object.fromEntries(
      template.components.map((component: { id: string; component: unknown }) => [component.id, component.component]),
    );

    // live-preview is the one plugin property Construct leaves out.
    expect(byId.plugin).toEqual([{
      key: 'plugin',
      state: [
        ['initially-visible', true],
        ['initial-animation', true],
        ['initial-frame', true],
        ['enable-collisions', true],
      ],
    }]);

    expect(byId['instance-variable']).toEqual([{
      key: 'instance-variable',
      state: [{ iv: 'health', state: true }, { iv: 'name', state: true }],
    }]);

    // One entry per behavior; a behavior with no properties gets an empty list.
    expect(byId.behavior).toEqual([
      { key: 'Platform', state: [['max-speed', true], ['enabled', true]] },
      { key: 'Fade', state: [] },
    ]);

    // An effect's state covers its parameters plus the enable marker.
    expect(byId.effect).toEqual([
      { key: 'Glow', state: [['intensity', true], ['<<effect-template-enable>>', true]] },
    ]);

    const world = byId['world-instance'][0];
    expect(world.key).toBe('world-instance');
    expect(world.state.map(([key]: [string, boolean]) => key)).toEqual([...WORLD_INSTANCE_KEYS]);
    expect(world.state.filter(([, value]: [string, boolean]) => value === false).map(([key]: [string, boolean]) => key))
      .toEqual(['x', 'y']);
  });

  it('writes empty components for an instance with nothing to sync', async () => {
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 2, mode: 'template', templateName: 'Bare',
    });
    const template = await templateOf(2);
    const byId = Object.fromEntries(
      template.components.map((component: { id: string; component: unknown }) => [component.id, component.component]),
    );
    expect(byId.plugin).toEqual([]);
    expect(byId.behavior).toEqual([]);
    expect(byId.effect).toEqual([]);
    expect(byId['instance-variable']).toEqual([{ key: 'instance-variable', state: [] }]);
    expect(byId['world-instance']).toHaveLength(1);
  });

  it('links a replica and warns when no such template exists yet', async () => {
    const orphan = parseResult(await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 2, mode: 'replica', sourceTemplateName: 'Default',
    }));
    expect(orphan.action).toBe('replica linked');
    expect(orphan.warnings.join(' ')).toContain('nothing to sync it with');
    expect(await templateOf(2)).toMatchObject({
      mode: 'replica', templateName: '', sourceTemplateName: 'Default', replicasUIDs: null,
    });

    // With the template in place the warning goes away.
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'template', templateName: 'Default',
    });
    const linked = parseResult(await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 3, mode: 'replica', sourceTemplateName: 'Default',
    }));
    expect(linked.warnings).toBeUndefined();
  });

  it('removes the template block for mode none and refuses when there is none', async () => {
    const nothing = await server.callTool('set_instance_template', { layoutName: 'Level 1', uid: 1, mode: 'none' });
    expect(nothing.isError).toBe(true);
    expect(nothing.content[0].text).toContain('no template block');

    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'template', templateName: 'Default',
    });
    const removed = parseResult(await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'none',
    }));
    expect(removed.action).toBe('template removed');
    expect(await templateOf(1)).toBeUndefined();
  });

  it('refuses a duplicate template name for the same object type', async () => {
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'template', templateName: 'Default',
    });
    const clash = await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 3, mode: 'template', templateName: 'Default',
    });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('unique per object type');

    // Re-setting the same instance to the same name is not a clash.
    const same = await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'template', templateName: 'Default',
    });
    expect(same.isError).toBeUndefined();
  });

  it('requires the name that matches the mode, and reports missing targets', async () => {
    const noName = await server.callTool('set_instance_template', { layoutName: 'Level 1', uid: 1, mode: 'template' });
    expect(noName.isError).toBe(true);
    expect(noName.content[0].text).toContain('requires templateName');

    const noSource = await server.callTool('set_instance_template', { layoutName: 'Level 1', uid: 1, mode: 'replica' });
    expect(noSource.isError).toBe(true);
    expect(noSource.content[0].text).toContain('requires sourceTemplateName');

    const noUid = await server.callTool('set_instance_template', { layoutName: 'Level 1', uid: 999, mode: 'none' });
    expect(noUid.isError).toBe(true);
    expect(noUid.content[0].text).toContain('No instance with UID 999');

    const noLayout = await server.callTool('set_instance_template', { layoutName: 'Nope', uid: 1, mode: 'none' });
    expect(noLayout.isError).toBe(true);
  });

  it('warns when the instance is a non-world instance', async () => {
    const result = parseResult(await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 4, mode: 'template', templateName: 'Keys',
    }));
    expect(result.warnings.join(' ')).toContain('non-world instance');
    const template = await templateOf(4);
    expect(template.components.find((component: { id: string }) => component.id === 'world-instance').component)
      .toEqual([]);
  });
});

describe('list_templates', () => {
  it('lists templates with their replica counts', async () => {
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 1, mode: 'template', templateName: 'Default',
    });
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 3, mode: 'replica', sourceTemplateName: 'Default',
    });
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 2, mode: 'template', templateName: 'Grunt',
    });

    const all = parseResult(await server.callTool('list_templates', {}));
    expect(all.count).toBe(2);
    expect(all.templates).toEqual(expect.arrayContaining([
      { templateName: 'Default', objectType: 'Player', layout: 'Level 1', uid: 1, replicaCount: 1 },
      { templateName: 'Grunt', objectType: 'Enemy', layout: 'Level 1', uid: 2, replicaCount: 0 },
    ]));
    expect(all.orphanedReplicas).toBeUndefined();

    const filtered = parseResult(await server.callTool('list_templates', { objectType: 'Enemy' }));
    expect(filtered.templates).toEqual([
      { templateName: 'Grunt', objectType: 'Enemy', layout: 'Level 1', uid: 2, replicaCount: 0 },
    ]);
  });

  it('reports a replica whose template is missing', async () => {
    await server.callTool('set_instance_template', {
      layoutName: 'Level 1', uid: 3, mode: 'replica', sourceTemplateName: 'Ghost',
    });
    const result = parseResult(await server.callTool('list_templates', {}));
    expect(result.count).toBe(0);
    expect(result.orphanedReplicaCount).toBe(1);
    expect(result.orphanedReplicas[0]).toMatchObject({ objectType: 'Player', uid: 3, sourceTemplateName: 'Ghost' });
  });

  it('rejects an unknown object type filter', async () => {
    const result = await server.callTool('list_templates', { objectType: 'Nope' });
    expect(result.isError).toBe(true);
  });
});

describe('set_default_template', () => {
  it('sets both editor fields and warns when the template does not exist', async () => {
    const result = parseResult(await server.callTool('set_default_template', {
      objectName: 'Player', templateName: 'Default',
    }));
    expect(result.action).toBe('default template set');
    expect(result.warnings.join(' ')).toContain('Create one with set_instance_template');

    const objectType = await readJson('objectTypes', 'Actors', 'Player.json');
    expect(objectType.editorNewInstanceIsReplica).toBe(true);
    expect(objectType.editorNewInstanceTemplateName).toBe('Default');
  });

  it('clears the name and the flag when given null', async () => {
    await server.callTool('set_default_template', { objectName: 'Player', templateName: 'Default' });
    const result = parseResult(await server.callTool('set_default_template', {
      objectName: 'Player', templateName: null,
    }));
    expect(result.action).toBe('default template cleared');

    const objectType = await readJson('objectTypes', 'Actors', 'Player.json');
    expect(objectType.editorNewInstanceIsReplica).toBe(false);
    expect('editorNewInstanceTemplateName' in objectType).toBe(false);
  });

  it('rejects an unknown object type', async () => {
    const result = await server.callTool('set_default_template', { objectName: 'Nope', templateName: null });
    expect(result.isError).toBe(true);
  });
});
