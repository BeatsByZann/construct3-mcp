import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerProjectTools } from '../../src/tools/project-tools.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerProjectTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('update_project_metadata', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_project_metadata')).toBe(true);
  });

  it('updates project name', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_metadata', {
      name: 'My Game',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('project');
    expect(data.category).toBe('project');
    expect(writer.callsFor('updateProjectProperties')).toHaveLength(1);
    const updates = writer.callsFor('updateProjectProperties')[0].args[0] as Record<string, unknown>;
    expect(updates.name).toBe('My Game');
  });

  it('updates multiple properties', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_metadata', {
      name: 'Cool Game',
      version: '2.0.0',
      author: 'Dev',
      description: 'A cool game',
    });
    expect(parseResult(result).success).toBe(true);
    const updates = writer.callsFor('updateProjectProperties')[0].args[0] as Record<string, unknown>;
    expect(updates.name).toBe('Cool Game');
    expect(updates.version).toBe('2.0.0');
    expect(updates.author).toBe('Dev');
    expect(updates.description).toBe('A cool game');
  });

  it('errors with no updates', async () => {
    const { server } = setup();
    const result = await server.callTool('update_project_metadata', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('only sends provided fields', async () => {
    const { server, writer } = setup();
    await server.callTool('update_project_metadata', { version: '1.2.3' });
    const updates = writer.callsFor('updateProjectProperties')[0].args[0] as Record<string, unknown>;
    expect(updates).toEqual({ version: '1.2.3' });
    expect(updates.name).toBeUndefined();
  });
});

// ─── update_project_properties ────────────────────────────

describe('update_project_properties', () => {
  function withLayout() {
    return setup({ layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]) });
  }

  /** The project file as the writer hands it to the change callback. */
  function projectFile(): Record<string, any> {
    return {
      name: 'Game',
      firstLayout: 'Layout 1',
      viewportWidth: 1280,
      viewportHeight: 720,
      properties: { author: 'Dev', fullscreenMode: 'off', zFar: 10000 },
    };
  }

  /** Run the change the tool passed to updateProject on a project file. */
  function applyWrittenChange(writer: ReturnType<typeof setup>['writer'], project = projectFile()) {
    const calls = writer.callsFor('updateProject');
    expect(calls).toHaveLength(1);
    const change = calls[0].args[0] as (project: any) => boolean | void;
    expect(change(project)).not.toBe(false);
    return project;
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_project_properties')).toBe(true);
  });

  it('merges properties keys into project.properties in one update of the project file', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_properties', {
      properties: { fullscreenMode: 'letterbox-scale', sampling: 'nearest', zFar: 5000 },
    });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('updateProjectProperties')).toHaveLength(0);
    const project = applyWrittenChange(writer);
    expect(project.properties).toEqual({ author: 'Dev', fullscreenMode: 'letterbox-scale', sampling: 'nearest', zFar: 5000 });
    expect(project.name).toBe('Game');
    expect(project.firstLayout).toBe('Layout 1');
  });

  it('writes the top-level settings at the top level, not into properties, in the same single update', async () => {
    const { server, writer } = withLayout();
    const result = await server.callTool('update_project_properties', {
      properties: { sampling: 'nearest' },
      firstLayout: 'Level 1',
      viewportWidth: 960,
      viewportHeight: 540,
      useWorker: 'dom',
      functionsName: 'Fn',
    });
    expect(parseResult(result).success).toBe(true);
    const project = applyWrittenChange(writer);
    expect(project).toMatchObject({
      firstLayout: 'Level 1',
      viewportWidth: 960,
      viewportHeight: 540,
      useWorker: 'dom',
      functionsName: 'Fn',
    });
    expect(project.properties).toEqual({ author: 'Dev', fullscreenMode: 'off', zFar: 10000, sampling: 'nearest' });
  });

  it('accepts fixedFramerate, which real r495 projects carry', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_properties', {
      properties: { framerateMode: 'fixed', fixedFramerate: 30 },
    });
    expect(parseResult(result).success).toBe(true);
    expect(applyWrittenChange(writer).properties.fixedFramerate).toBe(30);
  });

  it('rejects an unknown properties key, lists the valid ones and writes nothing', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_properties', { properties: { notAProperty: 1 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('notAProperty');
    expect(result.content[0].text).toContain('fullscreenMode');
    expect(result.content[0].text).toContain('uidAllocationMode');
    expect(writer.callsFor('updateProject')).toHaveLength(0);
  });

  it('rejects a top-level key given in properties and points to the right parameter', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_properties', {
      properties: { name: 'Renamed', firstLayout: 'Level 1' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('update_project_metadata');
    expect(writer.callsFor('updateProject')).toHaveLength(0);
  });

  it('refuses an argument the tool does not take, by name, instead of dropping it', async () => {
    const { server, writer } = withLayout();
    // Without a strict schema the unknown key is stripped and the rest is written
    await expect(server.callTool('update_project_properties', { firstLayout: 'Level 1', fullscreenMode: 'off' }))
      .rejects.toThrow(/"fullscreenMode"/);
    expect(writer.callsFor('updateProject')).toHaveLength(0);
  });

  it('sets firstLayout to the registered spelling of a layout named in another letter case', async () => {
    const { server, writer } = withLayout();
    const result = await server.callTool('update_project_properties', { firstLayout: 'level 1' });
    expect(parseResult(result).success).toBe(true);
    expect(applyWrittenChange(writer).firstLayout).toBe('Level 1');
  });

  it('refuses a firstLayout that names no registered layout and says nothing was changed', async () => {
    const { server, writer } = withLayout();
    const result = await server.callTool('update_project_properties', {
      properties: { sampling: 'nearest' },
      firstLayout: 'Ghost',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost"');
    expect(result.content[0].text).toContain('Level 1');
    expect(result.content[0].text.endsWith('Nothing was changed.')).toBe(true);
    expect(writer.callsFor('updateProject')).toHaveLength(0);
  });

  it('rejects a functionsName that is not an identifier', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_properties', { functionsName: 'my funcs!' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('identifier');
    expect(writer.callsFor('updateProject')).toHaveLength(0);
  });

  it('rejects a non-positive viewport size', async () => {
    const { server } = setup();
    await expect(server.callTool('update_project_properties', { viewportWidth: 0 })).rejects.toThrow();
  });

  it('errors with no updates', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('update_project_properties', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
    expect(writer.callsFor('updateProject')).toHaveLength(0);
  });

  it('errors on an empty properties object', async () => {
    const { server } = setup();
    const result = await server.callTool('update_project_properties', { properties: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });
});

// ─── list_addons ──────────────────────────────────────────

describe('list_addons', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('list_addons')).toBe(true);
  });

  it('lists all addons', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'Tween', name: 'Tween', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('list_addons', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2);
    expect(data.addons).toHaveLength(2);
  });

  it('filters by type', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'Tween', name: 'Tween', author: 'Scirra', bundled: false },
        { type: 'effect', id: 'hsladjust', name: 'Adjust HSL', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('list_addons', { type: 'behavior' });
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.addons[0].id).toBe('Tween');
  });
});

// ─── register_addon ───────────────────────────────────────

describe('register_addon', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('register_addon')).toBe(true);
  });

  it('reports already_registered when addon exists', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('register_addon', {
      type: 'plugin',
      id: 'Sprite',
      name: 'Sprite',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.action).toBe('already_registered');
  });
});

// ─── unregister_addon ─────────────────────────────────────

describe('unregister_addon', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('unregister_addon')).toBe(true);
  });

  it('errors on addon not found', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('unregister_addon', {
      type: 'behavior',
      id: 'Ghost',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not registered');
  });

  it('blocks removal of known built-in without force', async () => {
    const { server } = setup({
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      ],
    });
    const result = await server.callTool('unregister_addon', {
      type: 'plugin',
      id: 'Sprite',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('force=true');
  });
});
