import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerObjectTools } from '../../src/tools/object-tools.js';
import { resetProjectIndex } from '../../src/construct3/analyzers/index-builder.js';

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

    // The layout data should have behaviors and instanceVariables on the instance
    const layoutData = entityWrites[1].args[2] as Record<string, unknown>;
    const layers = (layoutData as any).layers as Array<{ instances: Array<Record<string, unknown>> }>;
    expect(layers[0].instances[0].behaviors).toEqual({});
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

  it('adding behavior does not overwrite existing instance behaviors', async () => {
    const { server, writer, reader } = setup({
      objects: new Map([['Player', {
        name: 'Player', 'plugin-id': 'Sprite', sid: 1,
        instanceVariables: [], behaviorTypes: [],
      }]]),
    });
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
          behaviors: { Tween: { enabled: true } },
          instanceVariables: { health: 100 },
          world: { x: 0, y: 0, width: 64, height: 64 },
        }],
      }],
      sid: 300,
    });

    await server.callTool('update_object_properties', {
      name: 'Player',
      addBehaviors: [{ behaviorId: 'Platform', name: 'Platform' }],
    });

    // Layout should NOT be rewritten since it already has behaviors/instanceVariables
    const entityWrites = writer.callsFor('writeEntityFile');
    expect(entityWrites).toHaveLength(1);
    expect(entityWrites[0].args[0]).toBe('objectTypes');
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
        ['btn_spin', { name: 'btn_spin', 'plugin-id': 'Sprite', sid: 1 }],
        ['btn_menu', { name: 'btn_menu', 'plugin-id': 'Sprite', sid: 2 }],
      ]),
    });
    const result = await server.callTool('create_family', {
      name: 'btn_fam',
      pluginId: 'Sprite',
      members: ['btn_spin', 'btn_menu'],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.entity).toBe('btn_fam');
    expect(data.category).toBe('family');
    expect(data.generatedSid).toBeDefined();
    expect(writer.callsFor('writeEntityFile')).toHaveLength(1);
    expect(writer.callsFor('addToProject')).toHaveLength(1);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual(['btn_spin', 'btn_menu']);
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
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: [] }]]),
    });
    const result = await server.callTool('create_family', {
      name: 'btn_fam',
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
});

// ─── update_family ────────────────────────────────────────

describe('update_family', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_family')).toBe(true);
  });

  it('adds members to a family', async () => {
    const { server, writer } = setup({
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: ['btn_spin'], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    const result = await server.callTool('update_family', {
      name: 'btn_fam',
      addMembers: ['btn_menu'],
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual(['btn_spin', 'btn_menu']);
  });

  it('removes members from a family', async () => {
    const { server, writer } = setup({
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: ['btn_spin', 'btn_menu'], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    await server.callTool('update_family', {
      name: 'btn_fam',
      removeMembers: ['btn_spin'],
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.members).toEqual(['btn_menu']);
  });

  it('adds instance variables', async () => {
    const { server, writer } = setup({
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: [], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    await server.callTool('update_family', {
      name: 'btn_fam',
      addVariables: [{ name: 'score', type: 'number' }],
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.instanceVariables).toHaveLength(1);
    expect(written.instanceVariables[0].name).toBe('score');
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: [], instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    const result = await server.callTool('update_family', { name: 'btn_fam' });
    expect(result.isError).toBe(true);
  });

  it('errors on nonexistent family', async () => {
    const { server } = setup();
    const result = await server.callTool('update_family', {
      name: 'Ghost',
      addMembers: ['btn_spin'],
    });
    expect(result.isError).toBe(true);
  });
});

// ─── delete_family ────────────────────────────────────────

describe('delete_family', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_family')).toBe(true);
  });

  it('deletes an existing family', async () => {
    const { server, writer } = setup({
      families: new Map([['btn_fam', { name: 'btn_fam', 'plugin-id': 'Sprite', sid: 1, members: [] }]]),
    });
    const result = await server.callTool('delete_family', { name: 'btn_fam' });
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

  it('errors on nonexistent family', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_family', { name: 'Ghost' });
    expect(result.isError).toBe(true);
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
