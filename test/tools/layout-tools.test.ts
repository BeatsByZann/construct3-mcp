import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerLayoutTools } from '../../src/tools/layout-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { DEFAULT_INSTANCE_PROPERTIES } from '../../src/construct3/templates.js';

// The project index is a module singleton built from whichever reader first
// asked for it; MockWriter never invalidates it, so reset it per test.
beforeEach(() => resetProjectIndex());

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerLayoutTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('create_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_layout')).toBe(true);
  });

  it('creates a layout with defaults', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_layout', { name: 'Level 1' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('Level 1');
    expect(data.category).toBe('layout');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
  });

  it('creates a layout with custom dimensions', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_layout', {
      name: 'SmallLevel',
      width: 800,
      height: 600,
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.width).toBe(800);
    expect(writtenData.height).toBe(600);
  });

  it('creates layout with event sheet binding', async () => {
    const { server, writer } = setup({
      eventSheets: new Map([['LevelSheet', { name: 'LevelSheet', events: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_layout', {
      name: 'Level 1',
      eventSheet: 'LevelSheet',
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.eventSheet).toBe('LevelSheet');
  });

  it('creates layout with custom layers', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_layout', {
      name: 'Level 1',
      layers: ['Background', 'Main', 'UI'],
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenData.layers as Array<Record<string, unknown>>;
    expect(layers).toHaveLength(3);
    expect(layers[0].name).toBe('Background');
    expect(layers[1].name).toBe('Main');
    expect(layers[2].name).toBe('UI');
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
    });
    const result = await server.callTool('create_layout', { name: 'Level 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects nonexistent event sheet', async () => {
    const { server } = setup();
    const result = await server.callTool('create_layout', {
      name: 'Level 1',
      eventSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });
});

describe('add_instance_to_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_instance_to_layout')).toBe(true);
  });

  it('places a Sprite instance on a layer', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 100, y: 200,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedUid).toBeDefined();
    expect(data.generatedSid).toBeDefined();
  });

  /**
   * The instance keeps the properties object it is given, so handing out the
   * shared DEFAULT_INSTANCE_PROPERTIES entry would let a later edit of one
   * instance reach the template and every other instance of that plugin.
   */
  it('gives each instance its own copy of the plugin defaults', async () => {
    const { server, writer } = setup({
      objects: new Map([['Canvas', {
        name: 'Canvas', 'plugin-id': 'DrawingCanvas', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    for (const x of [10, 200]) {
      expect(parseResult(await server.callTool('add_instance_to_layout', {
        layoutName: 'Level 1', layerName: 'Main', objectType: 'Canvas', x, y: 20,
      })).success).toBe(true);
    }

    const written = writer.callsFor('writeEntityFile');
    const layout = written[written.length - 1].args[2] as any;
    const placed = layout.layers[0].instances as any[];
    expect(placed).toHaveLength(2);
    for (const inst of placed) {
      expect(inst.properties).toEqual({
        'resolution-mode': 'auto',
        'initially-visible': true,
        origin: 'top-left',
        antialiasing: 'off',
      });
    }
    expect(placed[0].properties).not.toBe(placed[1].properties);
    expect(placed[0].properties).not.toBe(DEFAULT_INSTANCE_PROPERTIES.DrawingCanvas);
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'NonExistent',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not exist');
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup({
      objects: new Map([['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'NonExistent',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on nonexistent layer', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'BadLayer',
      objectType: 'Player',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('blocks singleglobal-inst objects', async () => {
    const { server } = setup({
      objects: new Map([['Audio', {
        name: 'Audio', 'plugin-id': 'Audio', sid: 1,
        'singleglobal-inst': { type: 'Audio', properties: {}, uid: 1, sid: 2 },
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Audio',
      x: 0, y: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('global plugin');
  });

  it('places nonworld-global object in nonworld-instances', async () => {
    const { server } = setup({
      objects: new Map([['GameData', {
        name: 'GameData', 'plugin-id': 'Json', sid: 1,
        isGlobal: true,
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'GameData',
      x: 0, y: 0,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('nonworld');
  });

  it('creates instance with angle, color, zElevation', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 100, y: 200,
      angle: 1.57,
      color: [1, 0, 0, 0.5],
      zElevation: 10,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    const world = instance.world as Record<string, unknown>;
    expect(world.angle).toBe(1.57);
    expect(world.color).toEqual([1, 0, 0, 0.5]);
    expect(world.z).toBe(10);
    expect(world.zElevation).toBeUndefined();
  });

  it('creates instance with instanceVariables and behaviors', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
        instanceVariables: [{ name: 'health', type: 'number', sid: 2 }],
        behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: 3 }],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      instanceVariables: { health: 100 },
      behaviors: { Platform: { maxSpeed: 300 } },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    expect(instance.instanceVariables).toEqual({ health: 100 });
    expect(instance.behaviors).toEqual({ Platform: { maxSpeed: 300 } });
  });

  it('creates instance with tags, showing=false, locked=true', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      tags: 'enemy, boss',
      showing: false,
      locked: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    expect(instance.tags).toBe('enemy, boss');
    expect(instance.showing).toBe(false);
    expect(instance.locked).toBe(true);
  });

  it('creates instance with originX and originY overrides', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false, instanceVariables: [], behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      originX: 0,
      originY: 1,
    });
    expect(parseResult(result).success).toBe(true);
    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const layers = writtenLayout.layers as Array<Record<string, unknown>>;
    const instance = (layers[0].instances as Array<Record<string, unknown>>)[0];
    const world = instance.world as Record<string, unknown>;
    expect(world.originX).toBe(0);
    expect(world.originY).toBe(1);
  });

  it('warns on unknown instanceVariable key', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
        instanceVariables: [{ name: 'health', type: 'number', sid: 2 }],
        behaviorTypes: [],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      instanceVariables: { unknownVar: 42 },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.some((w: string) => w.includes('unknownVar'))).toBe(true);
  });

  it('warns on unknown behavior key', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        isGlobal: false,
        instanceVariables: [],
        behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: 3 }],
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'Player',
      x: 0, y: 0,
      behaviors: { NonExistentBehavior: { speed: 10 } },
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.some((w: string) => w.includes('NonExistentBehavior'))).toBe(true);
  });

  it('preserves showing and locked on nonworld instances', async () => {
    const { server, writer } = setup({
      objects: new Map([['GameData', {
        name: 'GameData', 'plugin-id': 'Json', sid: 1,
        isGlobal: true,
      }]]),
      layouts: new Map([['Level 1', {
        name: 'Level 1', sid: 10,
        layers: [{ name: 'Main', sid: 20, instances: [] }],
        'nonworld-instances': [],
      }]]),
    });
    const result = await server.callTool('add_instance_to_layout', {
      layoutName: 'Level 1',
      layerName: 'Main',
      objectType: 'GameData',
      x: 0, y: 0,
      showing: false,
      locked: true,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    const writtenLayout = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const nonworld = writtenLayout['nonworld-instances'] as Array<Record<string, unknown>>;
    expect(nonworld[0].showing).toBe(false);
    expect(nonworld[0].locked).toBe(true);
  });
});

describe('delete_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_layout')).toBe(true);
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_layout', { name: 'NonExistent' });
    expect(result.isError).toBe(true);
  });

  it('blocks deletion of startup layout', async () => {
    const { server } = setup({
      layouts: new Map([['Layout 1', { name: 'Layout 1', layers: [], sid: 1 }]]),
      metadata: { firstLayout: 'Layout 1' },
    });
    const result = await server.callTool('delete_layout', { name: 'Layout 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('startup layout');
  });

  it('deregisters the layout from c3proj before deleting its file', async () => {
    const { server, writer } = setup({
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', layers: [], sid: 1 }],
        ['Level 2', { name: 'Level 2', layers: [], sid: 2 }],
      ]),
      metadata: { firstLayout: 'Layout 1' },
    });
    const result = await server.callTool('delete_layout', { name: 'Level 2' });
    expect(parseResult(result).success).toBe(true);

    // A failure between the two steps must leave an orphaned file, never a
    // registration that points at nothing.
    const order = writer.calls.map(c => c.method);
    expect(order).toContain('removeFromProject');
    expect(order).toContain('deleteEntityFile');
    expect(order.indexOf('removeFromProject')).toBeLessThan(order.indexOf('deleteEntityFile'));
  });

  it('names the orphaned file when the file delete fails after deregistration', async () => {
    const { server, writer } = setup({
      layouts: new Map([
        ['Layout 1', { name: 'Layout 1', layers: [], sid: 1 }],
        ['Level 2', { name: 'Level 2', layers: [], sid: 2 }],
      ]),
      metadata: { firstLayout: 'Layout 1' },
    });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('boom'));
    const result = await server.callTool('delete_layout', { name: 'Level 2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('layouts/Level 2.json');
    expect(result.content[0].text).toContain('boom');
    expect(writer.callsFor('removeFromProject')).toHaveLength(1);
  });
});

describe('update_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_layout')).toBe(true);
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
    });
    const result = await server.callTool('update_layout', { name: 'Level 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('updates dimensions', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1, width: 1920, height: 1080 }]]),
    });
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      width: 3840,
      height: 2160,
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.width).toBe(3840);
    expect(writtenData.height).toBe(2160);
  });

  it('updates event sheet binding', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
      eventSheets: new Map([['NewSheet', { name: 'NewSheet', events: [], sid: 2 }]]),
    });
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      eventSheet: 'NewSheet',
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.eventSheet).toBe('NewSheet');
  });

  it('rejects nonexistent event sheet', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', layers: [], sid: 1 }]]),
    });
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      eventSheet: 'NonExistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup();
    const result = await server.callTool('update_layout', {
      name: 'NonExistent',
      width: 800,
    });
    expect(result.isError).toBe(true);
  });
});

// ─── add_layer ────────────────────────────────────────────

function makeLayout(name = 'Level 1') {
  return {
    name,
    sid: 1,
    layers: [
      { name: 'Layer 0', sid: 2, instances: [], effectTypes: [] },
    ],
    'nonworld-instances': [],
    effectTypes: [],
    width: 1920,
    height: 1080,
  };
}

describe('add_layer', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_layer')).toBe(true);
  });

  it('adds a layer with defaults', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('add_layer', {
      layoutName: 'Level 1',
      layerName: 'UI',
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedSid).toBeDefined();
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers).toHaveLength(2);
    expect(written.layers[1].name).toBe('UI');
  });

  it('inserts at specified index', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    await server.callTool('add_layer', {
      layoutName: 'Level 1',
      layerName: 'Background',
      index: 0,
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers[0].name).toBe('Background');
    expect(written.layers[1].name).toBe('Layer 0');
  });

  it('rejects duplicate layer name', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('add_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('errors on nonexistent layout', async () => {
    const { server } = setup();
    const result = await server.callTool('add_layer', {
      layoutName: 'Ghost',
      layerName: 'UI',
    });
    expect(result.isError).toBe(true);
  });
});

// ─── delete_layer ─────────────────────────────────────────

describe('delete_layer', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_layer')).toBe(true);
  });

  it('deletes a layer', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [
          { name: 'Background', sid: 2, instances: [], effectTypes: [] },
          { name: 'UI', sid: 3, instances: [], effectTypes: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_layer', {
      layoutName: 'Level 1',
      layerName: 'UI',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers).toHaveLength(1);
    expect(written.layers[0].name).toBe('Background');
  });

  it('blocks deletion of last layer', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('delete_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('last layer');
  });

  it('blocks deletion of layer with instances without force', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [
          { name: 'Layer 0', sid: 2, instances: [{ uid: 1, type: 'Sprite' }], effectTypes: [] },
          { name: 'UI', sid: 3, instances: [], effectTypes: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.action).toBe('delete_blocked');
  });

  it('deletes layer with instances when force=true', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [
          { name: 'Layer 0', sid: 2, instances: [{ uid: 1, type: 'Sprite' }], effectTypes: [] },
          { name: 'UI', sid: 3, instances: [], effectTypes: [] },
        ],
      }]]),
    });
    const result = await server.callTool('delete_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
      force: true,
    });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
  });
});

// ─── update_layer ─────────────────────────────────────────

describe('update_layer', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_layer')).toBe(true);
  });

  it('renames a layer', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
      newName: 'Background',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers[0].name).toBe('Background');
  });

  it('updates parallax and blend mode', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
      parallaxX: 0.5,
      parallaxY: 0.5,
      blendMode: 'additive',
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers[0].parallaxX).toBe(0.5);
    expect(written.layers[0].blendMode).toBe('additive');
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Layer 0',
    });
    expect(result.isError).toBe(true);
  });

  it('errors on nonexistent layer', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Ghost',
      isInitiallyVisible: false,
    });
    expect(result.isError).toBe(true);
  });
});

// ─── delete_instance_from_layout ─────────────────────────

describe('delete_instance_from_layout', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_instance_from_layout')).toBe(true);
  });

  it('removes an instance by UID', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [
          {
            name: 'Layer 0', sid: 2, instances: [
              { uid: 42, sid: 100, type: 'Player', world: { x: 0, y: 0 }, properties: {} },
            ], effectTypes: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('delete_instance_from_layout', {
      layoutName: 'Level 1',
      uid: 42,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers[0].instances).toHaveLength(0);
  });

  it('errors on UID not found', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('delete_instance_from_layout', {
      layoutName: 'Level 1',
      uid: 9999,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

// ─── update_instance ─────────────────────────────────────

describe('update_instance', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_instance')).toBe(true);
  });

  it('updates position and angle', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [
          {
            name: 'Layer 0', sid: 2, instances: [
              { uid: 42, sid: 100, type: 'Player', world: { x: 0, y: 0, width: 100, height: 100, angle: 0 }, properties: {} },
            ], effectTypes: [],
          },
        ],
      }]]),
    });
    const result = await server.callTool('update_instance', {
      layoutName: 'Level 1',
      uid: 42,
      x: 300,
      y: 200,
      angle: 1.57,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const inst = written.layers[0].instances[0];
    expect(inst.world.x).toBe(300);
    expect(inst.world.y).toBe(200);
    expect(inst.world.angle).toBe(1.57);
  });

  it('updates instance variables', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [
          {
            name: 'Layer 0', sid: 2, instances: [
              { uid: 42, sid: 100, type: 'Player', world: { x: 0, y: 0 }, instanceVariables: { health: 100 }, properties: {} },
            ], effectTypes: [],
          },
        ],
      }]]),
    });
    await server.callTool('update_instance', {
      layoutName: 'Level 1',
      uid: 42,
      instanceVariables: { health: 50, speed: 5 },
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.layers[0].instances[0].instanceVariables.health).toBe(50);
    expect(written.layers[0].instances[0].instanceVariables.speed).toBe(5);
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('update_instance', {
      layoutName: 'Level 1',
      uid: 42,
    });
    expect(result.isError).toBe(true);
  });

  it('errors on UID not found', async () => {
    const { server } = setup({
      layouts: new Map([['Level 1', makeLayout()]]),
    });
    const result = await server.callTool('update_instance', {
      layoutName: 'Level 1',
      uid: 9999,
      x: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('update_instance (properties, behaviors, effects)', () => {
  function richSetup() {
    return setup({
      objects: new Map([
        ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 10, behaviorTypes: [{ behaviorId: 'Platform', name: 'Platform', sid: 11 }], effectTypes: [{ effectId: 'hsladjust', name: 'Tint' }] }],
        ['Sign', { name: 'Sign', 'plugin-id': 'Text', sid: 12, behaviorTypes: [], effectTypes: [] }],
      ]),
      families: new Map([['Actors', { name: 'Actors', sid: 20, members: ['Player'], behaviorTypes: [{ behaviorId: 'Timer', name: 'FamTimer', sid: 21 }], effectTypes: [{ effectId: 'hsladjust', name: 'FamGlow' }] }]]),
      layouts: new Map([['Level 1', {
        ...makeLayout(),
        layers: [{
          name: 'Layer 0', sid: 2, effectTypes: [],
          instances: [
            { uid: 42, sid: 100, type: 'Player', world: { x: 0, y: 0 }, properties: { 'initial-frame': 0 }, behaviors: { Platform: { properties: { 'max-speed': 100, gravity: 1500 } } }, effects: { Tint: { isEnabled: true, parameters: { hue: 0, sat: 0 } } } },
          ],
          subLayers: [{ name: 'Inner', sid: 3, effectTypes: [], instances: [{ uid: 43, sid: 101, type: 'Sign', world: { x: 5, y: 5 }, properties: { text: 'old' } }] }],
        }],
        'nonworld-instances': [{ uid: 44, sid: 102, type: 'Sign', properties: {} }],
      }]]),
    });
  }

  it('merges plugin properties, behavior properties, and effect state', async () => {
    const { server, writer } = richSetup();
    const result = parseResult(await server.callTool('update_instance', {
      layoutName: 'Level 1', uid: 42,
      properties: { 'initial-animation': 'Run' },
      behaviors: { Platform: { properties: { 'max-speed': 330 } }, FamTimer: { properties: {} } },
      effects: { Tint: { isEnabled: false, parameters: { hue: 90 } }, FamGlow: { parameters: { amount: 2 } } },
    }));
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    const inst = (writer.callsFor('writeEntityFile')[0].args[2] as any).layers[0].instances[0];
    expect(inst.properties).toEqual({ 'initial-frame': 0, 'initial-animation': 'Run' });
    expect(inst.behaviors.Platform.properties).toEqual({ 'max-speed': 330, gravity: 1500 });
    expect(inst.behaviors.FamTimer).toEqual({ properties: {} });
    expect(inst.effects.Tint).toEqual({ isEnabled: false, parameters: { hue: 90, sat: 0 } });
    expect(inst.effects.FamGlow).toEqual({ isEnabled: true, parameters: { amount: 2 } });
  });

  it('rejects an effect that is not defined on the type or its families', async () => {
    const { server, writer } = richSetup();
    const result = await server.callTool('update_instance', { layoutName: 'Level 1', uid: 42, effects: { Nope: { isEnabled: false } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('add_effect');
    expect(writer.calls).toHaveLength(0);
  });

  it('warns on an undefined behavior but still writes', async () => {
    const { server, writer } = richSetup();
    const result = parseResult(await server.callTool('update_instance', { layoutName: 'Level 1', uid: 42, behaviors: { Ghost: { properties: { a: 1 } } } }));
    expect(result.success).toBe(true);
    expect(result.warnings[0]).toContain('Behavior "Ghost" is not defined');
    expect(writer.calls).toHaveLength(1);
  });

  it('finds instances in sub-layers and edits their properties', async () => {
    const { server, writer } = richSetup();
    const result = parseResult(await server.callTool('update_instance', { layoutName: 'Level 1', uid: 43, properties: { text: 'new' }, x: 50 }));
    expect(result.success).toBe(true);
    const inst = (writer.callsFor('writeEntityFile')[0].args[2] as any).layers[0].subLayers[0].instances[0];
    expect(inst.properties.text).toBe('new');
    expect(inst.world.x).toBe(50);
  });

  it('edits non-world instances and warns that spatial values were ignored', async () => {
    const { server, writer } = richSetup();
    const result = parseResult(await server.callTool('update_instance', { layoutName: 'Level 1', uid: 44, properties: { text: 'x' }, x: 10 }));
    expect(result.success).toBe(true);
    expect(result.warnings[0]).toContain('non-world');
    expect((writer.callsFor('writeEntityFile')[0].args[2] as any)['nonworld-instances'][0].properties.text).toBe('x');
  });
});

// ─── W84 tier 3: layer nesting, ordering, layout view and hierarchy ───

/** Minimal layer in the shape Construct writes, with optional overrides. */
function testLayer(name: string, extra: Record<string, unknown> = {}) {
  return { name, sid: 900000000000000, instances: [], subLayers: [], ...extra };
}

/** Minimal world instance; `world` is what marks it as placeable in a hierarchy. */
function worldInstance(uid: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'Sprite',
    uid,
    sid: 800000000000000 + uid,
    properties: {},
    world: { x: 0, y: 0, width: 32, height: 32 },
    ...extra,
  };
}

function nestedLayoutData() {
  return {
    name: 'Level 1',
    sid: 1,
    layers: [
      testLayer('Background'),
      testLayer('Main', {
        subLayers: [testLayer('Inner A'), testLayer('Inner B')],
      }),
      testLayer('UI'),
    ],
    width: 1920,
    height: 1080,
  };
}

function nestedSetup() {
  return setup({ layouts: new Map([['Level 1', nestedLayoutData()]]) });
}

function writtenLayout(writer: any) {
  return writer.callsFor('writeEntityFile')[0].args[2] as any;
}

describe('update_layer (extended properties)', () => {
  it('applies every render and appearance property', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Background',
      color: [1, 0, 0, 1],
      backgroundColor: [0, 0, 1, 1],
      global: true,
      isHTMLElementsLayer: true,
      sampling: 'nearest',
      renderingMode: '2d',
      forceOwnTexture: true,
      useRenderCells: true,
      drawOrder: 'y-position',
    });
    expect(parseResult(result).success).toBe(true);
    const layer = writtenLayout(writer).layers[0];
    expect(layer.color).toEqual([1, 0, 0, 1]);
    expect(layer.backgroundColor).toEqual([0, 0, 1, 1]);
    expect(layer.global).toBe(true);
    expect(layer.isHTMLElementsLayer).toBe(true);
    expect(layer.sampling).toBe('nearest');
    expect(layer.renderingMode).toBe('2d');
    expect(layer.forceOwnTexture).toBe(true);
    expect(layer.useRenderCells).toBe(true);
    expect(layer.drawOrder).toBe('y-position');
  });

  it('updates a nested sub-layer', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Inner B',
      parallaxX: 0.5,
      isInitiallyVisible: false,
    });
    expect(parseResult(result).success).toBe(true);
    const inner = writtenLayout(writer).layers[1].subLayers[1];
    expect(inner.name).toBe('Inner B');
    expect(inner.parallaxX).toBe(0.5);
    expect(inner.isInitiallyVisible).toBe(false);
  });

  it('rejects a rename that collides with a nested layer name', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'UI',
      newName: 'Inner A',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('lists nested layer names when the layer is not found', async () => {
    const { server } = nestedSetup();
    const result = await server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Nope',
      parallaxX: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Inner A');
  });

  it('rejects an unknown sampling value', async () => {
    const { server } = nestedSetup();
    await expect(server.callTool('update_layer', {
      layoutName: 'Level 1',
      layerName: 'Main',
      sampling: 'fuzzy',
    })).rejects.toThrow();
  });

  it('names the new parameters when nothing is supplied', async () => {
    const { server } = nestedSetup();
    const result = await server.callTool('update_layer', { layoutName: 'Level 1', layerName: 'Main' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('drawOrder');
  });
});

describe('add_layer (sub-layers)', () => {
  it('creates the layer inside the parent subLayers', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('add_layer', {
      layoutName: 'Level 1',
      layerName: 'Inner C',
      parentLayer: 'Main',
      index: 1,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writtenLayout(writer);
    expect(written.layers).toHaveLength(3);
    expect(written.layers[1].subLayers.map((l: any) => l.name)).toEqual(['Inner A', 'Inner C', 'Inner B']);
  });

  it('creates a subLayers array on a parent that has none', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Level 1', { name: 'Level 1', sid: 1, layers: [{ name: 'Main', sid: 2, instances: [] }] }]]),
    });
    const result = await server.callTool('add_layer', {
      layoutName: 'Level 1',
      layerName: 'Child',
      parentLayer: 'Main',
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenLayout(writer).layers[0].subLayers.map((l: any) => l.name)).toEqual(['Child']);
  });

  it('rejects an unknown parent layer', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('add_layer', {
      layoutName: 'Level 1',
      layerName: 'Inner C',
      parentLayer: 'Ghost',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Parent layer "Ghost" not found');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a name already used by a nested layer', async () => {
    const { server } = nestedSetup();
    const result = await server.callTool('add_layer', { layoutName: 'Level 1', layerName: 'Inner A' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });
});

describe('reorder_layers', () => {
  it('registers the tool', () => {
    const { server } = nestedSetup();
    expect(server.hasTool('reorder_layers')).toBe(true);
  });

  it('reorders the top-level layers', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('reorder_layers', {
      layoutName: 'Level 1',
      layerNames: ['UI', 'Background', 'Main'],
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenLayout(writer).layers.map((l: any) => l.name)).toEqual(['UI', 'Background', 'Main']);
  });

  it('reorders one layer\'s sub-layers', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('reorder_layers', {
      layoutName: 'Level 1',
      layerNames: ['Inner B', 'Inner A'],
      parentLayer: 'Main',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writtenLayout(writer);
    expect(written.layers.map((l: any) => l.name)).toEqual(['Background', 'Main', 'UI']);
    expect(written.layers[1].subLayers.map((l: any) => l.name)).toEqual(['Inner B', 'Inner A']);
  });

  it('rejects a partial list rather than dropping layers', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('reorder_layers', {
      layoutName: 'Level 1',
      layerNames: ['UI', 'Background'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing: Main');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a name that is not at that level', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('reorder_layers', {
      layoutName: 'Level 1',
      layerNames: ['UI', 'Background', 'Inner A'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not at this level: Inner A');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects duplicate names', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('reorder_layers', {
      layoutName: 'Level 1',
      layerNames: ['UI', 'UI', 'Background'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Duplicate layer name');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an unknown parent layer', async () => {
    const { server } = nestedSetup();
    const result = await server.callTool('reorder_layers', {
      layoutName: 'Level 1',
      layerNames: ['Inner A'],
      parentLayer: 'Ghost',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Parent layer "Ghost" not found');
  });

  it('errors on unknown layout', async () => {
    const { server } = nestedSetup();
    const result = await server.callTool('reorder_layers', { layoutName: 'Nope', layerNames: ['Main'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('move_layer', () => {
  it('registers the tool', () => {
    const { server } = nestedSetup();
    expect(server.hasTool('move_layer')).toBe(true);
  });

  it('moves a top-level layer into another layer\'s sub-layers', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('move_layer', {
      layoutName: 'Level 1',
      layerName: 'UI',
      parentLayer: 'Main',
      index: 0,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writtenLayout(writer);
    expect(written.layers.map((l: any) => l.name)).toEqual(['Background', 'Main']);
    expect(written.layers[0].subLayers).toEqual([]);
    expect(written.layers[1].subLayers.map((l: any) => l.name)).toEqual(['UI', 'Inner A', 'Inner B']);
  });

  it('moves a sub-layer back to the top level at an index', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('move_layer', {
      layoutName: 'Level 1',
      layerName: 'Inner A',
      index: 0,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writtenLayout(writer);
    expect(written.layers.map((l: any) => l.name)).toEqual(['Inner A', 'Background', 'Main', 'UI']);
    expect(written.layers[2].subLayers.map((l: any) => l.name)).toEqual(['Inner B']);
  });

  it('treats an explicit null parentLayer as the top level', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('move_layer', {
      layoutName: 'Level 1',
      layerName: 'Inner B',
      parentLayer: null,
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenLayout(writer).layers.map((l: any) => l.name)).toEqual(['Background', 'Main', 'UI', 'Inner B']);
  });

  it('refuses to move a layer into its own sub-layer', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('move_layer', {
      layoutName: 'Level 1',
      layerName: 'Main',
      parentLayer: 'Inner A',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('one of its own sub-layers');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses to move a layer into itself', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('move_layer', {
      layoutName: 'Level 1',
      layerName: 'Main',
      parentLayer: 'Main',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('into itself');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses to nest the only top-level layer', async () => {
    const { server, writer } = setup({
      layouts: new Map([['Solo', {
        name: 'Solo', sid: 1,
        layers: [testLayer('Main', { subLayers: [testLayer('Inner')] })],
      }]]),
    });
    const result = await server.callTool('move_layer', {
      layoutName: 'Solo',
      layerName: 'Main',
      parentLayer: 'Inner',
    });
    expect(result.isError).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('clamps an out-of-range index', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('move_layer', {
      layoutName: 'Level 1',
      layerName: 'Background',
      parentLayer: 'Main',
      index: 99,
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenLayout(writer).layers[0].subLayers.map((l: any) => l.name))
      .toEqual(['Inner A', 'Inner B', 'Background']);
  });

  it('errors on unknown layer and unknown parent', async () => {
    const { server } = nestedSetup();
    const missingLayer = await server.callTool('move_layer', { layoutName: 'Level 1', layerName: 'Ghost' });
    expect(missingLayer.isError).toBe(true);
    const missingParent = await server.callTool('move_layer', {
      layoutName: 'Level 1', layerName: 'UI', parentLayer: 'Ghost',
    });
    expect(missingParent.isError).toBe(true);
    expect(missingParent.content[0].text).toContain('Parent layer "Ghost" not found');
  });
});

describe('update_layout (view properties)', () => {
  it('applies scrolling, sampling, projection and viewport anchor', async () => {
    const { server, writer } = nestedSetup();
    const result = await server.callTool('update_layout', {
      name: 'Level 1',
      unboundedScrolling: true,
      sampling: 'trilinear',
      projection: 'orthographic',
      vpX: 0.25,
      vpY: 0.75,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writtenLayout(writer);
    expect(written.unboundedScrolling).toBe(true);
    expect(written.sampling).toBe('trilinear');
    expect(written.projection).toBe('orthographic');
    expect(written.vpX).toBe(0.25);
    expect(written.vpY).toBe(0.75);
  });

  it('rejects an unknown projection', async () => {
    const { server } = nestedSetup();
    await expect(server.callTool('update_layout', { name: 'Level 1', projection: 'isometric' }))
      .rejects.toThrow();
  });

  it('names the new parameters when nothing is supplied', async () => {
    const { server } = nestedSetup();
    const result = await server.callTool('update_layout', { name: 'Level 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unboundedScrolling');
  });
});

// ─── Hierarchy (sceneGraphData) ──────────────────────────────

const FRESH_CHILD_FLAGS = {
  x: true, y: true, z: true, w: true, h: true, d: true, a: true,
  o: false, v: false, sm: 'normal',
};

function hierarchySetup(instances: Array<Record<string, unknown>>, nonworld: Array<Record<string, unknown>> = []) {
  return setup({
    layouts: new Map([['Level 1', {
      name: 'Level 1',
      sid: 1,
      layers: [testLayer('Main', { instances })],
      'nonworld-instances': nonworld,
    }]]),
  });
}

function writtenInstances(writer: any) {
  const layout = writtenLayout(writer);
  return layout.layers[0].instances as any[];
}

describe('set_instance_parent', () => {
  it('registers the tool', () => {
    const { server } = hierarchySetup([worldInstance(1)]);
    expect(server.hasTool('set_instance_parent')).toBe(true);
  });

  it('links both sides and writes Construct\'s fresh-child flag defaults', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1), worldInstance(2)]);
    const result = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 2, parentUid: 1,
    });
    expect(parseResult(result).success).toBe(true);
    const [parent, child] = writtenInstances(writer);
    expect(child.sceneGraphData['parent-uid']).toBe(1);
    expect(child.sceneGraphData.uid).toBe(2);
    expect(child.sceneGraphData.flags).toEqual(FRESH_CHILD_FLAGS);
    expect(parent.sceneGraphData['parent-uid']).toBeNull();
    expect(parent.sceneGraphData.children).toEqual([{ uid: 2, flags: FRESH_CHILD_FLAGS }]);
    // Construct writes editor scratch state alongside every record
    expect(parent.sceneGraphData.preview.previewSceneGraph).toBe(false);
  });

  it('merges partial flags over the defaults on both sides', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1), worldInstance(2)]);
    await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 2, parentUid: 1, flags: { o: true, v: true, sm: 'wrap' },
    });
    const [parent, child] = writtenInstances(writer);
    const expected = { ...FRESH_CHILD_FLAGS, o: true, v: true, sm: 'wrap' };
    expect(child.sceneGraphData.flags).toEqual(expected);
    expect(parent.sceneGraphData.children[0].flags).toEqual(expected);
  });

  it('rejects an unknown flag key', async () => {
    const { server } = hierarchySetup([worldInstance(1), worldInstance(2)]);
    await expect(server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 2, parentUid: 1, flags: { bm: true },
    })).rejects.toThrow();
  });

  it('rejects an unknown transform mode', async () => {
    const { server } = hierarchySetup([worldInstance(1), worldInstance(2)]);
    await expect(server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 2, parentUid: 1, flags: { sm: 'sideways' },
    })).rejects.toThrow();
  });

  it('moves a child between parents and drops an emptied children array', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1), worldInstance(2), worldInstance(3)]);
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 3, parentUid: 1 });
    writer.reset();
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 3, parentUid: 2 });
    const [first, second, child] = writtenInstances(writer);
    expect(first.sceneGraphData.children).toBeUndefined();
    expect(second.sceneGraphData.children).toEqual([{ uid: 3, flags: FRESH_CHILD_FLAGS }]);
    expect(child.sceneGraphData['parent-uid']).toBe(2);
  });

  it('detaches with parentUid null', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1), worldInstance(2)]);
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 2, parentUid: 1 });
    writer.reset();
    const result = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 2, parentUid: null,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toContain('Detached instance 2 from parent 1');
    const [parent, child] = writtenInstances(writer);
    expect(parent.sceneGraphData.children).toBeUndefined();
    expect(child.sceneGraphData['parent-uid']).toBeNull();
  });

  it('reports unchanged when detaching an instance that has no hierarchy record', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1)]);
    const result = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 1, parentUid: null,
    });
    expect(parseResult(result).action).toBe('unchanged');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses self-parenting', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1)]);
    const result = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 1, parentUid: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('own hierarchy parent');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a cycle when the new parent already descends from the child', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1), worldInstance(2), worldInstance(3)]);
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 2, parentUid: 1 });
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 3, parentUid: 2 });
    writer.reset();
    const result = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 1, parentUid: 3,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('hierarchy cycle');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a non-world instance on either side', async () => {
    const { server } = hierarchySetup(
      [worldInstance(1)],
      [{ type: 'Audio', uid: 9, sid: 5, properties: {} }],
    );
    const asParent = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 1, parentUid: 9,
    });
    expect(asParent.isError).toBe(true);
    expect(asParent.content[0].text).toContain('world instance');
    const asChild = await server.callTool('set_instance_parent', {
      layoutName: 'Level 1', childUid: 9, parentUid: 1,
    });
    expect(asChild.isError).toBe(true);
  });

  it('errors on an unknown layout', async () => {
    const { server } = hierarchySetup([worldInstance(1)]);
    const result = await server.callTool('set_instance_parent', {
      layoutName: 'Nope', childUid: 1, parentUid: null,
    });
    expect(result.isError).toBe(true);
  });
});

describe('remove_instance_children', () => {
  it('registers the tool', () => {
    const { server } = hierarchySetup([worldInstance(1)]);
    expect(server.hasTool('remove_instance_children')).toBe(true);
  });

  it('detaches every child and clears the children array', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1), worldInstance(2), worldInstance(3)]);
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 2, parentUid: 1 });
    await server.callTool('set_instance_parent', { layoutName: 'Level 1', childUid: 3, parentUid: 1 });
    writer.reset();
    const result = await server.callTool('remove_instance_children', { layoutName: 'Level 1', parentUid: 1 });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toContain('Detached 2 child instance(s)');
    const [parent, a, b] = writtenInstances(writer);
    expect(parent.sceneGraphData.children).toBeUndefined();
    expect(a.sceneGraphData['parent-uid']).toBeNull();
    expect(b.sceneGraphData['parent-uid']).toBeNull();
  });

  it('reports unchanged when there are no children', async () => {
    const { server, writer } = hierarchySetup([worldInstance(1)]);
    const result = await server.callTool('remove_instance_children', { layoutName: 'Level 1', parentUid: 1 });
    const data = parseResult(result);
    expect(data.action).toBe('unchanged');
    expect(data.detached).toBe(0);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('warns about a child UID with no matching instance', async () => {
    const { server, writer } = hierarchySetup([
      worldInstance(1, {
        sceneGraphData: {
          'parent-uid': null,
          uid: 1,
          children: [{ uid: 404, flags: { ...FRESH_CHILD_FLAGS } }],
          flags: { ...FRESH_CHILD_FLAGS },
        },
      }),
    ]);
    const result = await server.callTool('remove_instance_children', { layoutName: 'Level 1', parentUid: 1 });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toContain('404');
    expect(writtenInstances(writer)[0].sceneGraphData.children).toBeUndefined();
  });

  it('errors when the parent UID is not a world instance', async () => {
    const { server } = hierarchySetup([worldInstance(1)]);
    const result = await server.callTool('remove_instance_children', { layoutName: 'Level 1', parentUid: 77 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});
