import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { BEHAVIOR_INSTANCE_DEFAULTS } from '../../src/construct3/templates.js';

// The project index is a module singleton built from whichever reader first
// asked for it; MockWriter never invalidates it, so reset it per test.
beforeEach(() => resetProjectIndex());

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerObjectTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('create_object', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_object')).toBe(true);
  });

  it('creates a Sprite object', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('Hero');
    expect(data.category).toBe('object');
    expect(data.action).toBe('created');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
  });

  it('Sprite creation writes placeholder PNG and sets imageSpriteId', async () => {
    const { server, writer } = setup();
    await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });

    // Verify image file was written
    const imageCalls = writer.callsFor('writeImageFiles');
    expect(imageCalls).toHaveLength(1);
    const files = imageCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].objectName).toBe('Hero');
    expect(files[0].animationName).toBe('Animation 1');
    expect(files[0].frameIndex).toBe(0);
    // The placeholder must be written at the size the frame declares; r495.2
    // reads the real image and rewrites width/height when they disagree.
    expect(files[0].width).toBe(100);
    expect(files[0].height).toBe(100);

    // Verify the written object data has imageSpriteId
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    const frames = items[0].frames as Array<Record<string, unknown>>;
    expect(frames[0].imageSpriteId).toBeDefined();
    expect(typeof frames[0].imageSpriteId).toBe('number');
  });

  it('creates a Text object', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'Label', pluginId: 'Text' });
    expect(parseResult(result).success).toBe(true);
  });

  it('creates a TiledBg object', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'BG', pluginId: 'TiledBg' });
    expect(parseResult(result).success).toBe(true);
  });

  it('TiledBg creation writes placeholder PNG and sets imageSpriteId', async () => {
    const { server, writer } = setup();
    await server.callTool('create_object', { name: 'BG', pluginId: 'TiledBg' });

    // Verify image file was written
    const imageCalls = writer.callsFor('writeImageFiles');
    expect(imageCalls).toHaveLength(1);
    const files = imageCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].objectName).toBe('BG');
    expect(files[0].pluginId).toBe('TiledBg');
    expect(files[0].width).toBe(100);
    expect(files[0].height).toBe(100);

    // Verify the written object data has imageSpriteId on the image field
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const image = writtenData.image as Record<string, unknown>;
    expect(image.imageSpriteId).toBeDefined();
    expect(typeof image.imageSpriteId).toBe('number');
  });

  it('creates a global plugin object (Audio)', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'Audio', pluginId: 'Audio' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedUid).toBeDefined();
  });

  it('creates a generic object', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'Custom', pluginId: 'Particles' });
    expect(parseResult(result).success).toBe(true);
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const result = await server.callTool('create_object', { name: 'Hero', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('rejects a name that clashes with an object type or family, ignoring case', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }]]),
      families: new Map([['Enemies', { name: 'Enemies', 'plugin-id': 'Sprite', sid: 2, members: [] }]]),
    });
    const caseOnly = await server.callTool('create_object', { name: 'hero', pluginId: 'Sprite' });
    expect(caseOnly.isError).toBe(true);
    expect(caseOnly.content[0].text).toContain("object class name 'hero' already used");

    const family = await server.callTool('create_object', { name: 'Enemies', pluginId: 'Sprite' });
    expect(family.isError).toBe(true);
    expect(family.content[0].text).toContain('A family named "Enemies" already exists');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects the names of the built-in System and Functions objects, ignoring case', async () => {
    const { server, writer, reader } = setup();
    for (const name of ['functions', 'SYSTEM']) {
      const result = await server.callTool('create_object', { name, pluginId: 'Sprite' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`"${name}" is the name of the built-in`);
      expect(result.content[0].text).toContain(`object class name '${name}' already used`);
    }
    // The Functions object goes by the project's functionsName
    const base = (reader as any).getProject.bind(reader);
    (reader as any).getProject = () => ({ ...base(), functionsName: 'Fn' });
    expect((await server.callTool('create_object', { name: 'fn', pluginId: 'Sprite' })).isError).toBe(true);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(parseResult(await server.callTool('create_object', { name: 'Functions', pluginId: 'Sprite' })).success).toBe(true);
  });

  it('rejects invalid name', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: '123bad', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
  });

  it('rejects reserved name', async () => {
    const { server } = setup();
    const result = await server.callTool('create_object', { name: 'System', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reserved');
  });

  it('creates with subfolder', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_object', { name: 'Button', pluginId: 'Sprite', subfolder: 'UI/Buttons' });
    expect(parseResult(result).success).toBe(true);
    const writeCall = writer.callsFor('writeEntityFile')[0];
    expect(writeCall.args[3]).toBe('UI/Buttons');
  });
});

describe('update_object_properties', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_object_properties')).toBe(true);
  });

  it('adds a variable', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addVariables: [{ name: 'health', type: 'number' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Check the written data contains the variable
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const vars = writtenData.instanceVariables as Array<Record<string, unknown>>;
    expect(vars).toHaveLength(1);
    expect(vars[0].name).toBe('health');
  });

  it('adds a behavior', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const behaviors = writtenData.behaviorTypes as Array<Record<string, unknown>>;
    expect(behaviors).toHaveLength(1);
    expect(behaviors[0].behaviorId).toBe('Platform');
  });

  it('warns on duplicate variable', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [{ name: 'health', type: 'number', sid: 10 }],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addVariables: [{ name: 'health', type: 'number' }],
    });
    const data = parseResult(result);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('already exists');
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    const result = await server.callTool('update_object_properties', { name: 'Player' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('update_object_properties', {
      name: 'Ghost',
      addVariables: [{ name: 'x', type: 'number' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('removes a variable', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [{ name: 'health', type: 'number', sid: 10 }],
      }]]),
    });
    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      removeVariables: ['health'],
    });
    expect(parseResult(result).success).toBe(true);
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    expect(writtenData.instanceVariables).toEqual([]);
  });

  it('adding behavior syncs layout instances', async () => {
    const { server, reader, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    // Add a layout with a Player instance that lacks behaviors/instanceVariables
    reader.addLayout('Level1', {
      name: 'Level1',
      layers: [{
        name: 'Main',
        sid: 100,
        instances: [{
          type: 'Player',
          uid: 0,
          sid: 200,
          properties: {},
          world: { x: 0, y: 0, width: 64, height: 64 },
        }],
      }],
      sid: 300,
    });

    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);

    // Should have written the objectType AND the layout
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(2);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
    expect(entityWrites[1].args[0]).toBe('layouts');
    expect(entityWrites[1].args[1]).toBe('Level1');

    // The instance gets the dicts C3 expects and a default entry for the new behavior
    const layoutData = entityWrites[1].args[2] as Record<string, unknown>;
    const layers = (layoutData as any).layers as Array<{ instances: Array<Record<string, unknown>> }>;
    expect(layers[0].instances[0].behaviors).toEqual({
      Platform: { properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Platform } },
    });
    expect(layers[0].instances[0].instanceVariables).toEqual({});
  });

  it('adding behavior skips layout sync when no instances exist', async () => {
    const { server, writer } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });

    const result = await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Tween', name: 'Tween' }],
    });
    expect(parseResult(result).success).toBe(true);

    // Only the objectType file should be written (no layouts)
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(1);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
  });

  it('adding behavior keeps existing instance entries and adds the new one', async () => {
    const { server, writer, reader } = setup({
      objects: new Map([['Sprite1', {
        name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 2 }],
      }]]),
    });
    reader.addLayout('Level1', {
      name: 'Level1',
      layers: [{
        name: 'Main',
        sid: 100,
        instances: [{
          type: 'Sprite1',
          uid: 0,
          sid: 200,
          properties: {},
          behaviors: { Tween: { properties: { enabled: false } } },
          instanceVariables: { health: 100 },
          world: { x: 0, y: 0, width: 64, height: 64 },
        }],
      }],
      sid: 300,
    });

    const data = parseResult(await server.callTool('update_object_properties', {
      name: 'Sprite1',
      addBehaviors: [{ behaviorId: 'Pin', name: 'Pin' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('Updated instances in layout(s): Level1');

    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites.map(w => w.args[0])).toEqual(['objectTypes', 'layouts']);
    const instance = (entityWrites[1].args[2] as any).layers[0].instances[0];
    expect(instance.behaviors).toEqual({
      Tween: { properties: { enabled: false } },
      Pin: { properties: { destroy: false } },
    });
    expect(Object.keys(instance.behaviors)).toEqual(['Tween', 'Pin']);
    expect(instance.instanceVariables).toEqual({ health: 100 });
  });

  it('adding a behavior leaves instances alone that already carry its entry', async () => {
    const { server, writer, reader } = setup({
      objects: new Map([['Sprite1', {
        name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
    reader.addLayout('Level1', {
      name: 'Level1', sid: 300,
      layers: [{
        name: 'Main', sid: 100,
        instances: [{
          type: 'Sprite1', uid: 0, sid: 200, properties: {},
          behaviors: { Pin: { properties: { destroy: true } } },
          instanceVariables: {},
        }],
      }],
    });

    await server.callTool('update_object_properties', {
      name: 'Sprite1',
      addBehaviors: [{ behaviorId: 'Pin', name: 'Pin' }],
    });

    // Nothing to change on the instance: only the object type is written
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(1);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
  });

  it('removing a behavior drops its entry from all instances, on sub-layers too', async () => {
    const { server, writer, reader } = setup({
      objects: new Map([['Sprite1', {
        name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1, instanceVariables: [],
        behaviorTypes: [
          { behaviorId: 'Tween', name: 'Tween', sid: 2 },
          { behaviorId: 'Pin', name: 'Pin', sid: 3 },
        ],
      }]]),
    });
    const entries = () => ({
      Tween: { properties: { enabled: true } },
      Pin: { properties: { destroy: false } },
    });
    reader.addLayout('Level1', {
      name: 'Level1', sid: 300,
      layers: [{
        name: 'Main', sid: 100,
        instances: [{ type: 'Sprite1', uid: 0, sid: 200, properties: {}, behaviors: entries(), instanceVariables: {} }],
        subLayers: [{
          name: 'Inner', sid: 101,
          instances: [{ type: 'Sprite1', uid: 1, sid: 201, properties: {}, behaviors: entries(), instanceVariables: {} }],
          subLayers: [],
        }],
      }],
    });

    const data = parseResult(await server.callTool('update_object_properties', {
      name: 'Sprite1',
      removeBehaviors: ['Pin'],
    }));
    expect(data.success).toBe(true);

    const layout = writer.callsFor('writeEntityFile')[1].args[2] as any;
    expect(layout.layers[0].instances[0].behaviors).toEqual({ Tween: { properties: { enabled: true } } });
    expect(layout.layers[0].subLayers[0].instances[0].behaviors).toEqual({ Tween: { properties: { enabled: true } } });
  });

  it('adding a behavior without known defaults writes { properties: {} } and warns', async () => {
    const { server, writer, reader } = setup({
      objects: new Map([['Sprite1', {
        name: 'Sprite1', 'plugin-id': 'Sprite', sid: 1, instanceVariables: [], behaviorTypes: [],
      }]]),
      // A third-party behavior must be in usedAddons before an object can use it
      usedAddons: [
        { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
        { type: 'behavior', id: 'Custom1', name: 'Custom1', author: 'Someone', bundled: false },
      ],
    });
    reader.addLayout('Level1', {
      name: 'Level1', sid: 300,
      layers: [{
        name: 'Main', sid: 100,
        instances: [{ type: 'Sprite1', uid: 0, sid: 200, properties: {}, behaviors: {}, instanceVariables: {} }],
      }],
    });

    const data = parseResult(await server.callTool('update_object_properties', {
      name: 'Sprite1',
      addBehaviors: [{ behaviorId: 'Custom1', name: 'MyCustom' }],
    }));
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('"MyCustom" (Custom1)'))).toBe(true);
    const layout = writer.callsFor('writeEntityFile')[1].args[2] as any;
    expect(layout.layers[0].instances[0].behaviors).toEqual({ MyCustom: { properties: {} } });
  });
});

describe('delete_object', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_object')).toBe(true);
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_object', { name: 'Ghost' });
    expect(result.isError).toBe(true);
  });

  it('deregisters the object from c3proj before deleting its file', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const result = await server.callTool('delete_object', { name: 'Hero' });
    expect(parseResult(result).success).toBe(true);

    const order = writer.calls.map(c => c.method);
    expect(order.indexOf('removeFromProject')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('removeFromProject')).toBeLessThan(order.indexOf('deleteEntityFile'));
  });

  it('names the orphaned file when the file delete fails after deregistration', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('boom'));
    const result = await server.callTool('delete_object', { name: 'Hero' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('objectTypes/Hero.json');
    expect(result.content[0].text).toContain('boom');
    expect(result.content[0].text).toContain('validate_project');
    expect(writer.callsFor('removeFromProject')).toHaveLength(1);
  });

  it('refuses objects used only as an object parameter, a non-world instance or from a script action', async () => {
    resetProjectIndex();
    const sprite = (name: string, sid: number) => [name, { name, 'plugin-id': 'Sprite', sid }] as [string, Record<string, unknown>];
    const { server, writer } = setup({
      objects: new Map([
        sprite('Sprite1', 101), sprite('Sprite2', 102), sprite('Sprite3', 103), sprite('Sprite4', 104),
        ['Array1', { name: 'Array1', 'plugin-id': 'Arr', sid: 110 }],
      ]),
      eventSheets: new Map([['Sheet1', {
        name: 'Sheet1', sid: 200,
        events: [{
          eventType: 'block', sid: 201, conditions: [],
          actions: [
            { id: 'spawn-another-object', objectClass: 'Sprite1', sid: 202, parameters: { object: 'Sprite2', layer: '0', 'image-point': '0' } },
            { type: 'script', language: 'javascript', script: ['runtime.objects.Sprite3.createInstance(0, 0, 0);'] },
          ],
        }],
      }]]),
      layouts: new Map([['Layout1', {
        name: 'Layout1', sid: 300, layers: [],
        'nonworld-instances': [{ type: 'Array1', uid: 1, sid: 301, properties: {} }],
      }]]),
    });

    for (const [name, where] of [['Sprite2', 'eventSheets'], ['Sprite3', 'eventSheets'], ['Array1', 'layouts']] as const) {
      const data = parseResult(await server.callTool('delete_object', { name }));
      expect(data.action, name).toBe('delete_blocked');
      expect(data.references[where], name).toEqual([where === 'layouts' ? 'Layout1' : 'Sheet1']);
    }
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(0);

    // Control: an object nothing refers to is deleted
    const data = parseResult(await server.callTool('delete_object', { name: 'Sprite4' }));
    expect(data.action).toBe('deleted');
    resetProjectIndex();
  });
});

// ─── create_family ────────────────────────────────────────

describe('create_family', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_family')).toBe(true);
  });

  it('creates a family with members', async () => {
    const { server, writer } = setup({
      objects: new Map([
        ['MemberA', { name: 'MemberA', 'plugin-id': 'Sprite', sid: 1 }],
        ['MemberB', { name: 'MemberB', 'plugin-id': 'Sprite', sid: 2 }],
      ]),
    });
    const result = await server.callTool('create_family', {
      name: 'TestFamily',
      pluginId: 'Sprite',
      members: ['MemberA', 'MemberB'],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('TestFamily');
    expect(data.category).toBe('family');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual(['MemberA', 'MemberB']);
    expect(written['plugin-id']).toBe('Sprite');
  });

  it('creates a family with no members', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_family', {
      name: 'EmptyFam',
      pluginId: 'Text',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual([]);
  });

  it('rejects duplicate family name', async () => {
    const { server } = setup({
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: [] }]]),
    });
    const result = await server.callTool('create_family', {
      name: 'TestFamily',
      pluginId: 'Sprite',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('warns on nonexistent member', async () => {
    const { server } = setup();
    const result = await server.callTool('create_family', {
      name: 'TestFam',
      pluginId: 'Sprite',
      members: ['NonExistentObject'],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain('does not exist');
  });

  it('rejects a name that clashes with an object type, ignoring case', async () => {
    const { server, writer } = setup({
      objects: new Map([['Enemy', { name: 'Enemy', 'plugin-id': 'Sprite', sid: 1 }]]),
    });
    const result = await server.callTool('create_family', { name: 'ENEMY', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('object type "Enemy"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects the name of the built-in Functions object', async () => {
    const { server, writer } = setup();
    const result = await server.callTool('create_family', { name: 'Functions', pluginId: 'Sprite' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('the built-in Functions object ("Functions", functionsName in project.c3proj)');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects members of another plugin (wrong plugin at load)', async () => {
    const { server, writer } = setup({
      objects: new Map([
        ['Hero', { name: 'Hero', 'plugin-id': 'Sprite', sid: 1 }],
        ['Label', { name: 'Label', 'plugin-id': 'Text', sid: 2 }],
      ]),
    });
    const result = await server.callTool('create_family', {
      name: 'Actors',
      pluginId: 'Sprite',
      members: ['Hero', 'Label'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('member "Label"');
    expect(result.content[0].text).toContain('"wrong plugin"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('warns when all members use a different plugin than the family', async () => {
    const { server } = setup({
      objects: new Map([['Label', { name: 'Label', 'plugin-id': 'Text', sid: 2 }]]),
    });
    const result = await server.callTool('create_family', { name: 'Labels', pluginId: 'Sprite', members: ['Label'] });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('all its members are "Text" objects'))).toBe(true);
  });
});

// ─── update_family ────────────────────────────────────────

describe('update_family', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_family')).toBe(true);
  });

  it('adds members to a family', async () => {
    const { server, writer } = setup({
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: ['MemberA'], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    const result = await server.callTool('update_family', {
      name: 'TestFamily',
      addMembers: ['MemberB'],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual(['MemberA', 'MemberB']);
  });

  it('removes members from a family', async () => {
    const { server, writer } = setup({
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: ['MemberA', 'MemberB'], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    await server.callTool('update_family', {
      name: 'TestFamily',
      removeMembers: ['MemberA'],
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual(['MemberB']);
  });

  it('adds instance variables', async () => {
    const { server, writer } = setup({
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: [], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    await server.callTool('update_family', {
      name: 'TestFamily',
      addVariables: [{ name: 'score', type: 'number' }],
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.instanceVariables).toHaveLength(1);
    expect(written.instanceVariables[0].name).toBe('score');
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: [], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    const result = await server.callTool('update_family', { name: 'TestFamily' });
    expect(result.isError).toBe(true);
  });

  it('errors on nonexistent family', async () => {
    const { server } = setup();
    const result = await server.callTool('update_family', {
      name: 'Ghost',
      addMembers: ['MemberA'],
    });
    expect(result.isError).toBe(true);
  });

  const mixedObjects = () => new Map<string, Record<string, unknown>>([
    ['MemberA', { name: 'MemberA', 'plugin-id': 'Sprite', sid: 2 }],
    ['MemberB', { name: 'MemberB', 'plugin-id': 'Sprite', sid: 3 }],
    ['TextMember', { name: 'TextMember', 'plugin-id': 'Text', sid: 4 }],
  ]);

  it('rejects adding a member of another plugin and leaves the family unchanged', async () => {
    const { server, writer, reader } = setup({
      objects: mixedObjects(),
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: ['MemberA'], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    const result = await server.callTool('update_family', { name: 'TestFamily', addMembers: ['MemberB', 'TextMember'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('member "TextMember"');
    expect(result.content[0].text).toContain('"wrong plugin"');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect((await reader.readFamily('TestFamily')).members).toEqual(['MemberA']);
  });

  it('allows removing a mismatching member, and other updates, on an already mixed family', async () => {
    const family = () => new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: ['MemberA', 'TextMember'], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]);
    const fix = setup({ objects: mixedObjects(), families: family() });
    expect(parseResult(await fix.server.callTool('update_family', { name: 'TestFamily', removeMembers: ['TextMember'] })).success).toBe(true);

    const other = setup({ objects: mixedObjects(), families: family() });
    expect(parseResult(await other.server.callTool('update_family', { name: 'TestFamily', addMembers: ['MemberB'] })).success).toBe(true);
  });

  // Synthetic project: Family1 has a Sine behavior; Sprite1/Sprite2 are Sprites with a Tween
  const familyProject = (members: string[]) => ({
    objects: new Map<string, Record<string, unknown>>([
      ['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 2, behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 20 }] }],
      ['Sprite2', { name: 'Sprite2', 'plugin-id': 'Sprite', sid: 3, behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 21 }] }],
    ]),
    families: new Map([['Family1', {
      name: 'Family1', 'plugin-id': 'Sprite', sid: 1, members, instanceVariables: [],
      behaviorTypes: [{ behaviorId: 'Sin', name: 'Sine', sid: 10 }], effectTypes: [],
    }]]),
    layouts: new Map([['Level1', {
      name: 'Level1', sid: 300,
      layers: [{
        name: 'Main', sid: 100,
        instances: [
          { type: 'Sprite1', uid: 0, sid: 200, properties: {}, instanceVariables: {}, behaviors: members.includes('Sprite1')
            ? { Sine: { properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Sin, magnitude: 8 } }, Tween: { properties: { enabled: true } } }
            : { Tween: { properties: { enabled: true } } } },
          { type: 'Sprite2', uid: 1, sid: 201, properties: {}, instanceVariables: {}, behaviors: { Tween: { properties: { enabled: true } } } },
        ],
      }],
    }]]),
  });

  it('adding a member gives its instances the family behavior entries, family entries first', async () => {
    const { server, writer } = setup(familyProject([]));
    const data = parseResult(await server.callTool('update_family', { name: 'Family1', addMembers: ['Sprite1'] }));
    expect(data.success).toBe(true);

    const writes = writer.callsFor('writeEntityFile');
    expect(writes.map(w => w.args[0])).toEqual(['families', 'layouts']);
    const [inst1, inst2] = (writes[1].args[2] as any).layers[0].instances;
    expect(Object.keys(inst1.behaviors)).toEqual(['Sine', 'Tween']);
    expect(inst1.behaviors.Sine).toEqual({ properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Sin } });
    expect(inst2.behaviors).toEqual({ Tween: { properties: { enabled: true } } });
  });

  it('removing a member drops the family behavior entries from its instances', async () => {
    const { server, writer } = setup(familyProject(['Sprite1']));
    await server.callTool('update_family', { name: 'Family1', removeMembers: ['Sprite1'] });
    const layout = writer.callsFor('writeEntityFile')[1].args[2] as any;
    expect(layout.layers[0].instances[0].behaviors).toEqual({ Tween: { properties: { enabled: true } } });
  });

  it('member changes on a family without behaviors do not touch layouts', async () => {
    const project = familyProject([]);
    (project.families.get('Family1') as any).behaviorTypes = [];
    const { server, writer } = setup(project);
    await server.callTool('update_family', { name: 'Family1', addMembers: ['Sprite1'] });
    expect(writer.callsFor('writeEntityFile').map(w => w.args[0])).toEqual(['families']);
  });
});

// ─── delete_family ────────────────────────────────────────

describe('delete_family', () => {
  beforeEach(() => resetProjectIndex());

  type Json = Record<string, any>;
  const spriteObject = (name: string, sid: number, extra: Json = {}): [string, Json] =>
    [name, { name, 'plugin-id': 'Sprite', sid, instanceVariables: [], behaviorTypes: [], ...extra }];
  const family1 = (extra: Json = {}): [string, Json] =>
    ['Family1', { name: 'Family1', 'plugin-id': 'Sprite', sid: 120, instanceVariables: [], behaviorTypes: [], members: ['Sprite1'], ...extra }];
  const sheet = (actionsAndConditions: { conditions?: Json[]; actions?: Json[] }): Map<string, Json> =>
    new Map([['Sheet1', {
      name: 'Sheet1', sid: 200,
      events: [{ eventType: 'block', sid: 201, conditions: [], actions: [], ...actionsAndConditions }],
    }]]);

  /** Family1 named by a condition, an object parameter, an expression, a script action and a Particles object property */
  function namedFamilyProject(): Json {
    return {
      objects: new Map([
        spriteObject('Sprite1', 101), spriteObject('Sprite2', 102),
        ['Emitter', { name: 'Emitter', 'plugin-id': 'Particles', sid: 110 }],
      ]),
      families: new Map([family1()]),
      eventSheets: sheet({
        conditions: [{ id: 'compare-x', objectClass: 'Family1', sid: 202, parameters: { comparison: 0, 'x-co-ordinate': '0' } }],
        actions: [
          { id: 'move-to-object', objectClass: 'Sprite2', sid: 203, parameters: { where: 'behind', object: 'Family1' } },
          { id: 'set-x', objectClass: 'Sprite2', sid: 204, parameters: { x: 'Family1.X + 1' } },
          { type: 'script', script: ['runtime.objects.Family1.getFirstInstance();'] },
        ],
      }),
      layouts: new Map([['Layout1', {
        name: 'Layout1', sid: 300,
        layers: [{ name: 'Main', sid: 301, instances: [
          { type: 'Emitter', uid: 1, sid: 311, properties: { object: 120 }, instanceVariables: {}, behaviors: {}, world: {} },
        ] }],
      }]]),
    };
  }

  /** Family1's variable "hp" and behavior "Fade" used through its member Sprite1 only */
  function memberUseProject(sprite1: Json = {}): Json {
    return {
      objects: new Map([spriteObject('Sprite1', 101, sprite1)]),
      families: new Map([family1({
        instanceVariables: [{ name: 'hp', type: 'number', initialValue: 0, desc: '', sid: 121 }],
        behaviorTypes: [{ behaviorId: 'Fade', name: 'Fade', sid: 122 }],
      })]),
      eventSheets: sheet({
        conditions: [{ id: 'compare-instance-variable', objectClass: 'Sprite1', sid: 202, parameters: { 'instance-variable': 'hp', comparison: 0, value: '0' } }],
        actions: [
          { id: 'start-fade', objectClass: 'Sprite1', behaviorType: 'Fade', sid: 203 },
          { id: 'set-x', objectClass: 'Sprite1', sid: 204, parameters: { x: 'Sprite1.hp + 1' } },
        ],
      }),
    };
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_family')).toBe(true);
  });

  it('deletes an existing family', async () => {
    const { server, writer } = setup({
      families: new Map([['TestFamily', { name: 'TestFamily', 'plugin-id': 'Sprite', sid: 1, members: [] }]]),
    });
    const result = await server.callTool('delete_family', { name: 'TestFamily' });
    expect(parseResult(result).success).toBe(true);
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(1);
    expect(writer.callsFor('removeFromProject')).toHaveLength(1);
    // Deregister first, then delete the file
    const order = writer.calls.map(c => c.method);
    expect(order.indexOf('removeFromProject')).toBeLessThan(order.indexOf('deleteEntityFile'));
  });

  it('names the orphaned file when the file delete fails, with the validate_project recovery hint', async () => {
    const { server, writer } = setup({
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: [] }]]),
    });
    vi.spyOn(writer, 'deleteEntityFile').mockRejectedValueOnce(new Error('boom'));
    const result = await server.callTool('delete_family', { name: 'btn_fam' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('families/btn_fam.json');
    // Families now participate in the recursive orphan-file scan.
    expect(result.content[0].text).toContain('validate_project');
  });

  it('deletes an unused family with members; uses of the members themselves do not count', async () => {
    const { server, writer } = setup({
      objects: new Map([spriteObject('Sprite1', 101, { instanceVariables: [{ name: 'speed', type: 'number', sid: 105 }] })]),
      families: new Map([family1({ instanceVariables: [{ name: 'hp', type: 'number', sid: 121 }] })]),
      eventSheets: sheet({
        conditions: [{ id: 'compare-instance-variable', objectClass: 'Sprite1', sid: 202, parameters: { 'instance-variable': 'speed', comparison: 0, value: '0' } }],
        actions: [{ id: 'set-x', objectClass: 'Sprite1', sid: 203, parameters: { x: 'Sprite1.X + Sprite1.speed + "Sprite1.hp"' } }],
      }),
    });
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.action).toBe('deleted');
    expect(data.warnings).toBeUndefined();
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(1);
    expect(writer.callsFor('removeFromProject')).toHaveLength(1);
  });

  it('refuses a family named in events and object properties', async () => {
    const { server, writer } = setup(namedFamilyProject());
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.success).toBe(false);
    expect(data.action).toBe('delete_blocked');
    expect(data.references.events.map((e: Json) => e.context)).toEqual(['condition', 'parameter', 'expression', 'script']);
    expect(data.references.instanceProperties).toEqual([
      { layout: 'Layout1', layer: 'Main', objectType: 'Emitter', uid: 1, property: 'object' },
    ]);
    expect(data.references.eventSheets).toEqual(['Sheet1']);
    expect(data.references.layouts).toEqual(['Layout1']);
    expect(data.references.memberUses).toEqual([]);
    expect(data.message).toContain('Family is still referenced: used 4 time(s) in events of "Sheet1"');
    expect(data.message).toContain('named by the object property "object" of "Emitter" UID 1 in layout "Layout1"');
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(0);
    expect(writer.callsFor('removeFromProject')).toHaveLength(0);
  });

  it('refuses a family whose variable or behavior a member uses', async () => {
    const { server, writer } = setup(memberUseProject());
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.events).toEqual([]);
    expect(data.references.eventSheets).toEqual(['Sheet1']);
    expect(data.references.memberUses).toEqual([
      { eventSheet: 'Sheet1', path: 'block > condition:0', eventPath: 'events[0]', sid: 202, member: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'condition' },
      { eventSheet: 'Sheet1', path: 'block > action:0', eventPath: 'events[0]', sid: 203, member: 'Sprite1', kind: 'behavior', name: 'Fade', context: 'action' },
      { eventSheet: 'Sheet1', path: 'block > action:1', eventPath: 'events[0]', sid: 204, member: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'expression' },
    ]);
    expect(data.message).toContain('its instance variables or behaviors used 3 time(s) through members in events of "Sheet1" ' +
      '(instance variable "hp" of "Sprite1", behavior "Fade" of "Sprite1")');
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(0);
  });

  it('refuses a family whose variable or behavior a member uses through Self', async () => {
    const project = memberUseProject();
    project.eventSheets = sheet({
      conditions: [{ id: 'compare-x', objectClass: 'Sprite1', sid: 202, parameters: { comparison: 0, 'x-co-ordinate': 'Self.hp' } }],
      actions: [{ id: 'set-x', objectClass: 'Sprite1', sid: 203, parameters: { x: 'Self.Fade.FadeInTime' } }],
    });
    const { server, writer } = setup(project);
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.memberUses).toEqual([
      { eventSheet: 'Sheet1', path: 'block > condition:0', eventPath: 'events[0]', sid: 202, member: 'Sprite1', kind: 'instance variable', name: 'hp', context: 'expression' },
      { eventSheet: 'Sheet1', path: 'block > action:0', eventPath: 'events[0]', sid: 203, member: 'Sprite1', kind: 'behavior', name: 'Fade', context: 'expression' },
    ]);
    expect(data.message).toContain('(instance variable "hp" of "Sprite1", behavior "Fade" of "Sprite1")');
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(0);
  });

  it('does not count Self in a condition or action on an object that is not a member', async () => {
    const project = memberUseProject();
    project.objects.set(...spriteObject('Sprite2', 102, { instanceVariables: [{ name: 'hp', type: 'number', sid: 106 }] }));
    project.eventSheets = sheet({
      actions: [{ id: 'set-x', objectClass: 'Sprite2', sid: 203, parameters: { x: 'Self.hp' } }],
    });
    const { server, writer } = setup(project);
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.action).toBe('deleted');
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(1);
  });

  it('does not count a variable the member declares itself', async () => {
    const { server } = setup(memberUseProject({ instanceVariables: [{ name: 'hp', type: 'number', sid: 105 }] }));
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.action).toBe('delete_blocked');
    expect(data.references.memberUses.map((u: Json) => `${u.kind} ${u.name}`)).toEqual(['behavior Fade']);
  });

  it('with force deletes the family and names the uses validate_project will not report', async () => {
    const project = namedFamilyProject();
    const member = memberUseProject();
    project.families = member.families;
    project.eventSheets.get('Sheet1').events.push(...member.eventSheets.get('Sheet1').events);
    const { server, writer } = setup(project);

    const data = parseResult(await server.callTool('delete_family', { name: 'Family1', force: true }));
    expect(data.action).toBe('deleted');
    expect(data.warnings).toHaveLength(2);
    expect(data.warnings[0]).toContain('Family deleted but still referenced: used 4 time(s) in events of "Sheet1"');
    expect(data.warnings[0]).toContain('its instance variables or behaviors used 3 time(s) through members');
    // validate_project reports the member uses in the "instance-variable" parameter and
    // behaviorType as missing-behavior-or-variable; "Sprite1.hp" reads like a Sprite expression
    expect(data.warnings[1]).toContain('validate_project will not report its 2 use(s) in expressions and scripts ' +
      'and 1 use(s) of its instance variables and behaviors through members written as "Member.name" in expressions');
    expect(data.warnings[1]).toContain('"Sheet1" block > action:1');
    expect(data.warnings[1]).toContain('"Sheet1" block > action:2');
    expect(data.warnings[1]).not.toContain('condition:0');
    expect(writer.callsFor('deleteEntityFile')).toHaveLength(1);
    expect(writer.callsFor('removeFromProject')).toHaveLength(1);
  });

  it('errors on nonexistent family', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_family', { name: 'Ghost' });
    expect(result.isError).toBe(true);
  });

  it('drops the family behavior entries from the former members\' instances', async () => {
    const { server, writer } = setup({
      objects: new Map([['Sprite1', { name: 'Sprite1', 'plugin-id': 'Sprite', sid: 2, behaviorTypes: [{ behaviorId: 'Tween', name: 'Tween', sid: 20 }] }]]),
      families: new Map([['Family1', {
        name: 'Family1', 'plugin-id': 'Sprite', sid: 1, members: ['Sprite1'],
        behaviorTypes: [{ behaviorId: 'Sin', name: 'Sine', sid: 10 }],
      }]]),
      layouts: new Map([['Level1', {
        name: 'Level1', sid: 300,
        layers: [{
          name: 'Main', sid: 100,
          instances: [{
            type: 'Sprite1', uid: 0, sid: 200, properties: {}, instanceVariables: {},
            behaviors: { Sine: { properties: { ...BEHAVIOR_INSTANCE_DEFAULTS.Sin } }, Tween: { properties: { enabled: true } } },
          }],
        }],
      }]]),
    });
    const data = parseResult(await server.callTool('delete_family', { name: 'Family1' }));
    expect(data.success).toBe(true);
    expect(data.warnings).toContain('Updated instances in layout(s): Level1');
    const layout = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(layout.layers[0].instances[0].behaviors).toEqual({ Tween: { properties: { enabled: true } } });
  });
});

// ─── Instance variable definition editing ──────────────────

function heroObject(vars: Array<Record<string, unknown>> = []) {
  return { name: 'Hero', 'plugin-id': 'Sprite', sid: 1, instanceVariables: vars, behaviorTypes: [] };
}

function layoutWith(instances: Array<Record<string, unknown>>, nonworld: Array<Record<string, unknown>> = []) {
  return {
    name: 'Layout 1',
    sid: 9,
    layers: [{ name: 'Layer 0', sid: 10, instances }],
    'nonworld-instances': nonworld,
  };
}

function writtenData(writer: any, category: string, name: string): any {
  const call = writer.callsFor('writeEntityFile').find(
    (c: any) => c.args[0] === category && c.args[1] === name,
  );
  return call?.args[2];
}

describe('update_object_properties variable metadata', () => {
  it('stores description and showInPropertiesBar as C3 desc/show', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', heroObject()]]) });
    await server.callTool('update_object_properties', {
      name: 'Hero',
      addVariables: [{ name: 'hp', type: 'number', description: 'Hit points', showInPropertiesBar: false }],
    });
    const written = writtenData(writer, 'objectTypes', 'Hero');
    expect(written.instanceVariables[0]).toMatchObject({ name: 'hp', type: 'number', desc: 'Hit points', show: false });
  });

  it('defaults desc to empty and show to true when not supplied', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', heroObject()]]) });
    await server.callTool('update_object_properties', {
      name: 'Hero',
      addVariables: [{ name: 'hp', type: 'number' }],
    });
    const written = writtenData(writer, 'objectTypes', 'Hero');
    expect(written.instanceVariables[0]).toMatchObject({ desc: '', show: true });
  });
});

describe('update_family variable metadata', () => {
  it('stores description and showInPropertiesBar on family variables', async () => {
    const families = new Map([['fAgents', { name: 'fAgents', members: ['Hero'], instanceVariables: [] }]]);
    const { server, writer } = setup({ families });
    await server.callTool('update_family', {
      name: 'fAgents',
      addVariables: [{ name: 'state', type: 'string', description: 'FSM state', showInPropertiesBar: false }],
    });
    const written = writtenData(writer, 'families', 'fAgents');
    expect(written.instanceVariables[0]).toMatchObject({ name: 'state', type: 'string', desc: 'FSM state', show: false });
  });
});

describe('update_instance_variable', () => {
  function objectSetup(opts: {
    vars?: Array<Record<string, unknown>>;
    instances?: Array<Record<string, unknown>>;
    nonworld?: Array<Record<string, unknown>>;
    sheets?: Map<string, Record<string, unknown>>;
  } = {}) {
    const vars = opts.vars ?? [{ name: 'hp', type: 'number', desc: '', show: true, sid: 111 }];
    const instances = opts.instances ?? [
      { type: 'Hero', uid: 1, sid: 2, properties: {}, instanceVariables: { hp: 7 }, behaviors: {} },
    ];
    return setup({
      objects: new Map([['Hero', heroObject(vars)]]),
      layouts: new Map([['Layout 1', layoutWith(instances, opts.nonworld ?? [])]]),
      eventSheets: opts.sheets ?? new Map(),
    });
  }

  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_instance_variable')).toBe(true);
  });

  it('requires exactly one of objectName or familyName', async () => {
    const { server } = objectSetup();
    const both = await server.callTool('update_instance_variable', {
      objectName: 'Hero', familyName: 'fAgents', variableName: 'hp', newName: 'health',
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain('exactly one');

    const neither = await server.callTool('update_instance_variable', { variableName: 'hp', newName: 'health' });
    expect(neither.isError).toBe(true);
  });

  it('requires at least one update', async () => {
    const { server } = objectSetup();
    const result = await server.callTool('update_instance_variable', { objectName: 'Hero', variableName: 'hp' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates provided');
  });

  it('errors when the object does not exist', async () => {
    const { server } = objectSetup();
    const result = await server.callTool('update_instance_variable', {
      objectName: 'Ghost', variableName: 'hp', newName: 'health',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Ghost');
  });

  it('errors when the variable does not exist and lists the available ones', async () => {
    const { server } = objectSetup();
    const result = await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'mana', newName: 'mp',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('mana');
    expect(result.content[0].text).toContain('hp');
  });

  it('refuses a rename that collides with an existing variable', async () => {
    const { server } = objectSetup({
      vars: [
        { name: 'hp', type: 'number', desc: '', show: true, sid: 111 },
        { name: 'health', type: 'number', desc: '', show: true, sid: 112 },
      ],
    });
    const result = await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newName: 'health',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already has an instance variable');
  });

  it('renames the definition and the stored key on every placed instance', async () => {
    const { server, writer } = objectSetup({
      instances: [
        { type: 'Hero', uid: 1, sid: 2, properties: {}, instanceVariables: { hp: 7, mana: 3 }, behaviors: {} },
        { type: 'Villain', uid: 2, sid: 3, properties: {}, instanceVariables: { hp: 1 }, behaviors: {} },
      ],
      nonworld: [
        { type: 'Hero', uid: 3, sid: 4, properties: {}, instanceVariables: { hp: 99 } },
      ],
    });
    const result = parseResult(await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newName: 'health',
    }));
    expect(result.success).toBe(true);
    expect(result.entity).toBe('Hero.health');

    const obj = writtenData(writer, 'objectTypes', 'Hero');
    expect(obj.instanceVariables[0].name).toBe('health');

    const layout = writtenData(writer, 'layouts', 'Layout 1');
    const placed = layout.layers[0].instances;
    // Renamed on the Hero instance, key order preserved, Villain untouched
    expect(Object.keys(placed[0].instanceVariables)).toEqual(['health', 'mana']);
    expect(placed[0].instanceVariables.health).toBe(7);
    expect(placed[1].instanceVariables).toEqual({ hp: 1 });
    // Non-world instances are covered too
    expect(layout['nonworld-instances'][0].instanceVariables).toEqual({ health: 99 });
  });

  it('renames the stored key on instances in nested sub-layers', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', heroObject([{ name: 'hp', type: 'number', desc: '', show: true, sid: 111 }])]]),
      layouts: new Map([['Layout 1', {
        name: 'Layout 1',
        sid: 9,
        layers: [{
          name: 'Layer 0',
          sid: 10,
          instances: [],
          subLayers: [{
            name: 'Sub',
            sid: 11,
            instances: [{ type: 'Hero', uid: 5, sid: 6, properties: {}, instanceVariables: { hp: 4 }, behaviors: {} }],
          }],
        }],
      }]]),
    });
    await server.callTool('update_instance_variable', { objectName: 'Hero', variableName: 'hp', newName: 'health' });
    const layout = writtenData(writer, 'layouts', 'Layout 1');
    expect(layout.layers[0].subLayers[0].instances[0].instanceVariables).toEqual({ health: 4 });
  });

  it('coerces stored values when the type changes', async () => {
    const { server, writer } = objectSetup({
      vars: [{ name: 'label', type: 'string', desc: '', show: true, sid: 111 }],
      instances: [
        { type: 'Hero', uid: 1, sid: 2, properties: {}, instanceVariables: { label: '42' }, behaviors: {} },
        { type: 'Hero', uid: 2, sid: 3, properties: {}, instanceVariables: { label: 'abc' }, behaviors: {} },
      ],
    });
    const result = parseResult(await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'label', newType: 'number',
    }));
    expect(result.success).toBe(true);
    expect(writtenData(writer, 'objectTypes', 'Hero').instanceVariables[0].type).toBe('number');
    const placed = writtenData(writer, 'layouts', 'Layout 1').layers[0].instances;
    expect(placed[0].instanceVariables.label).toBe(42);
    expect(placed[1].instanceVariables.label).toBe(0);
  });

  it('coerces numbers to strings and anything to boolean truthiness', async () => {
    const toString = objectSetup({
      instances: [{ type: 'Hero', uid: 1, sid: 2, properties: {}, instanceVariables: { hp: 7 }, behaviors: {} }],
    });
    await toString.server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newType: 'string',
    });
    expect(writtenData(toString.writer, 'layouts', 'Layout 1').layers[0].instances[0].instanceVariables.hp).toBe('7');

    const toBool = objectSetup({
      instances: [
        { type: 'Hero', uid: 1, sid: 2, properties: {}, instanceVariables: { hp: 0 }, behaviors: {} },
        { type: 'Hero', uid: 2, sid: 3, properties: {}, instanceVariables: { hp: 3 }, behaviors: {} },
      ],
    });
    await toBool.server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newType: 'boolean',
    });
    const placed = writtenData(toBool.writer, 'layouts', 'Layout 1').layers[0].instances;
    expect(placed[0].instanceVariables.hp).toBe(false);
    expect(placed[1].instanceVariables.hp).toBe(true);
  });

  it('updates description and properties-bar visibility without touching layouts', async () => {
    const { server, writer } = objectSetup();
    const result = parseResult(await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', description: 'Hit points', showInPropertiesBar: false,
    }));
    expect(result.success).toBe(true);
    expect(writtenData(writer, 'objectTypes', 'Hero').instanceVariables[0]).toMatchObject({
      desc: 'Hit points', show: false, type: 'number', name: 'hp',
    });
    expect(writtenData(writer, 'layouts', 'Layout 1')).toBeUndefined();
  });

  function sheetWithReferences() {
    return new Map([['MainSheet', {
      name: 'MainSheet',
      events: [{
        eventType: 'block',
        conditions: [
          { id: 'compare-instvar', objectClass: 'Hero', parameters: { 'instance-variable': 'hp', comparison: 0, value: '0' } },
        ],
        actions: [
          { id: 'set-instvar-value', objectClass: 'Hero', parameters: { 'instance-variable': 'hp', value: 'Hero.hp + 1' } },
          { id: 'set-instvar-value', objectClass: 'Villain', parameters: { 'instance-variable': 'hp', value: '5' } },
        ],
      }],
    }]]);
  }

  it('refuses a rename while event-sheet references exist', async () => {
    const { server, writer } = objectSetup({ sheets: sheetWithReferences() });
    const result = await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newName: 'health',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('MainSheet (3)');
    expect(result.content[0].text).toContain('renameReferences');
    // Nothing was written: the refusal happens before any file is touched
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rewrites parameter and expression references when renameReferences is true', async () => {
    const { server, writer } = objectSetup({ sheets: sheetWithReferences() });
    const result = parseResult(await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newName: 'health', renameReferences: true,
    }));
    expect(result.success).toBe(true);

    const sheet = writtenData(writer, 'eventSheets', 'MainSheet');
    const block = sheet.events[0];
    expect(block.conditions[0].parameters['instance-variable']).toBe('health');
    expect(block.actions[0].parameters['instance-variable']).toBe('health');
    expect(block.actions[0].parameters.value).toBe('Hero.health + 1');
    // A different object's identically named variable is left alone
    expect(block.actions[1].parameters['instance-variable']).toBe('hp');
  });

  it('counts and rewrites expressions inside function and custom action call arguments', async () => {
    const sheets = new Map([['MainSheet', {
      name: 'MainSheet',
      events: [{
        eventType: 'block',
        conditions: [{ id: 'every-tick', objectClass: 'System' }],
        actions: [
          { callFunction: 'Heal', sid: 50, parameters: ['Hero.hp', '"x"'] },
          { customAction: 'Boost', objectClass: 'Hero', sid: 51, parameters: ['Hero.hp * 2'] },
        ],
      }],
    }]]);
    const refused = await objectSetup({ sheets }).server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newName: 'health',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('MainSheet (2)');

    const { server, writer } = objectSetup({ sheets });
    await server.callTool('update_instance_variable', {
      objectName: 'Hero', variableName: 'hp', newName: 'health', renameReferences: true,
    });
    const actions = writtenData(writer, 'eventSheets', 'MainSheet').events[0].actions;
    expect(actions[0].parameters).toEqual(['Hero.health', '"x"']);
    expect(actions[1].parameters).toEqual(['Hero.health * 2']);
  });

  it('renames a family variable on the family and on every member instance', async () => {
    const families = new Map([['fAgents', {
      name: 'fAgents',
      members: ['Hero', 'Sidekick'],
      instanceVariables: [{ name: 'state', type: 'string', desc: '', show: true, sid: 200 }],
    }]]);
    const objects = new Map<string, Record<string, unknown>>([
      ['Hero', heroObject()],
      ['Sidekick', { name: 'Sidekick', 'plugin-id': 'Sprite', sid: 2, instanceVariables: [] }],
    ]);
    const layouts = new Map([['Layout 1', layoutWith([
      { type: 'Hero', uid: 1, sid: 2, properties: {}, instanceVariables: { state: 'idle' }, behaviors: {} },
      { type: 'Sidekick', uid: 2, sid: 3, properties: {}, instanceVariables: { state: 'follow' }, behaviors: {} },
    ])]]);
    const eventSheets = new Map([['MainSheet', {
      name: 'MainSheet',
      events: [{
        eventType: 'block',
        conditions: [],
        actions: [
          { id: 'set-instvar-value', objectClass: 'fAgents', parameters: { 'instance-variable': 'state', value: '"run"' } },
          { id: 'set-text', objectClass: 'Text', parameters: { text: 'Hero.state' } },
        ],
      }],
    }]]);

    const { server, writer } = setup({ objects, families, layouts, eventSheets });
    const result = parseResult(await server.callTool('update_instance_variable', {
      familyName: 'fAgents', variableName: 'state', newName: 'agentState', renameReferences: true,
    }));
    expect(result.success).toBe(true);
    expect(result.category).toBe('family');

    expect(writtenData(writer, 'families', 'fAgents').instanceVariables[0].name).toBe('agentState');
    const placed = writtenData(writer, 'layouts', 'Layout 1').layers[0].instances;
    expect(placed[0].instanceVariables).toEqual({ agentState: 'idle' });
    expect(placed[1].instanceVariables).toEqual({ agentState: 'follow' });

    const actions = writtenData(writer, 'eventSheets', 'MainSheet').events[0].actions;
    expect(actions[0].parameters['instance-variable']).toBe('agentState');
    // A member name also reaches a family variable in expression text
    expect(actions[1].parameters.text).toBe('Hero.agentState');
  });

  it('refuses a family rename that collides with a member variable', async () => {
    const families = new Map([['fAgents', {
      name: 'fAgents',
      members: ['Hero'],
      instanceVariables: [{ name: 'state', type: 'string', desc: '', show: true, sid: 200 }],
    }]]);
    const objects = new Map<string, Record<string, unknown>>([
      ['Hero', heroObject([{ name: 'mood', type: 'string', desc: '', show: true, sid: 201 }])],
    ]);
    const { server } = setup({ objects, families, layouts: new Map() });
    const result = await server.callTool('update_instance_variable', {
      familyName: 'fAgents', variableName: 'state', newName: 'mood',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Family member "Hero"');
  });
});
