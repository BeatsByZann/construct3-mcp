import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerEffectTools } from '../../src/tools/effect-tools.js';

const EFFECT_ADDON = { type: 'effect', id: 'hsladjust', name: 'Adjust HSL', author: 'Scirra', bundled: false };

function instance(uid: number, type: string, extra: Record<string, unknown> = {}) {
  return { uid, sid: 1000 + uid, type, properties: {}, instanceVariables: {}, behaviors: {}, world: { x: 0, y: 0, width: 10, height: 10 }, ...extra };
}

function layoutWithSubLayer() {
  return {
    name: 'Level 1',
    sid: 1,
    layers: [
      {
        name: 'Layer 0', sid: 2, effectTypes: [],
        instances: [instance(1, 'Player'), instance(2, 'Enemy')],
        subLayers: [
          { name: 'Inner', sid: 3, effectTypes: [], instances: [instance(3, 'Player')], subLayers: [] },
        ],
      },
    ],
    'nonworld-instances': [{ uid: 4, sid: 1004, type: 'Player', properties: {}, instanceVariables: {}, behaviors: {} }],
    effectTypes: [],
  };
}

function setup(overrides: { addons?: unknown[]; families?: Map<string, Record<string, unknown>>; layouts?: Map<string, Record<string, unknown>> } = {}) {
  const server = new MockServer();
  const reader = new MockReader({
    objects: new Map([
      ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 10, effectTypes: [] }],
      ['Enemy', { name: 'Enemy', 'plugin-id': 'Sprite', sid: 11, effectTypes: [{ effectId: 'hsladjust', name: 'Tint' }, { effectId: 'hsladjust', name: 'Glow' }] }],
    ]),
    families: overrides.families ?? new Map(),
    layouts: overrides.layouts ?? new Map([
      ['Level 1', layoutWithSubLayer()],
      ['Level 2', { name: 'Level 2', sid: 5, layers: [{ name: 'L', sid: 6, effectTypes: [], instances: [instance(9, 'Enemy')] }], effectTypes: [] }],
    ]),
    usedAddons: (overrides.addons ?? [
      { type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false },
      EFFECT_ADDON,
    ]) as any,
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerEffectTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer };
}

const parse = (r: any) => JSON.parse(r.content[0].text);
const written = (writer: MockWriter, category: string, name: string) =>
  writer.callsFor('writeEntityFile').filter(c => c.args[0] === category && c.args[1] === name).map(c => c.args[2] as any);

describe('add_effect', () => {
  it('registers all effect tools', () => {
    const { server } = setup();
    for (const t of ['list_effects', 'add_effect', 'update_effect', 'remove_effect', 'reorder_effects']) {
      expect(server.hasTool(t)).toBe(true);
    }
  });

  it('refuses an effect that is not in usedAddons', async () => {
    const { server, writer } = setup({ addons: [{ type: 'plugin', id: 'Sprite', name: 'Sprite', author: 'Scirra', bundled: false }] });
    const r = await server.callTool('add_effect', { targetType: 'objectType', targetName: 'Player', effectId: 'hsladjust' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('register_addon');
    expect(writer.calls).toHaveLength(0);
  });

  it('adds an object-type effect and per-instance state on every instance, including sub-layers and non-world instances', async () => {
    const { server, writer } = setup();
    const r = parse(await server.callTool('add_effect', {
      targetType: 'objectType', targetName: 'Player', effectId: 'hsladjust', name: 'Tint', parameters: { hue: 10 }, isEnabled: false,
    }));
    expect(r.success).toBe(true);
    const obj = written(writer, 'objectTypes', 'Player')[0];
    expect(obj.effectTypes).toEqual([{ effectId: 'hsladjust', name: 'Tint' }]);
    expect(obj.effectTypes[0].instance).toBeUndefined();

    const level1 = written(writer, 'layouts', 'Level 1')[0];
    const state = { isEnabled: false, parameters: { hue: 10 } };
    expect(level1.layers[0].instances[0].effects).toEqual({ Tint: state });
    expect(level1.layers[0].instances[1].effects).toBeUndefined(); // Enemy untouched
    expect(level1.layers[0].subLayers[0].instances[0].effects).toEqual({ Tint: state });
    expect(level1['nonworld-instances'][0].effects).toEqual({ Tint: state });
    expect(written(writer, 'layouts', 'Level 2')).toHaveLength(0); // no Player there
    expect(r.warnings.join(' ')).toContain('Level 1');
  });

  it('writes an empty parameter set with a warning when parameters are omitted', async () => {
    const { server, writer } = setup();
    const r = parse(await server.callTool('add_effect', { targetType: 'objectType', targetName: 'Player', effectId: 'hsladjust' }));
    expect(r.warnings.some((w: string) => w.includes('empty parameter set'))).toBe(true);
    expect(written(writer, 'layouts', 'Level 1')[0].layers[0].instances[0].effects).toEqual({ hsladjust: { isEnabled: true, parameters: {} } });
  });

  it('rejects a duplicate effect name on the target', async () => {
    const { server, writer } = setup();
    const r = await server.callTool('add_effect', { targetType: 'objectType', targetName: 'Enemy', effectId: 'hsladjust', name: 'Tint' });
    expect(r.isError).toBe(true);
    expect(writer.calls).toHaveLength(0);
  });

  it('honours index within the effect stack', async () => {
    const { server, writer } = setup();
    parse(await server.callTool('add_effect', { targetType: 'objectType', targetName: 'Enemy', effectId: 'hsladjust', name: 'First', index: 0 }));
    expect(written(writer, 'objectTypes', 'Enemy')[0].effectTypes.map((e: any) => e.name)).toEqual(['First', 'Tint', 'Glow']);
    const bad = await server.callTool('add_effect', { targetType: 'objectType', targetName: 'Enemy', effectId: 'hsladjust', name: 'Late', index: 9 });
    expect(bad.isError).toBe(true);
  });

  it('adds a family effect to every member instance', async () => {
    const families = new Map([['Actors', { name: 'Actors', sid: 20, members: ['Player', 'Enemy'], effectTypes: [] }]]);
    const { server, writer } = setup({ families });
    parse(await server.callTool('add_effect', { targetType: 'family', targetName: 'Actors', effectId: 'hsladjust', name: 'Fam', parameters: { a: 1 } }));
    expect(written(writer, 'families', 'Actors')[0].effectTypes).toEqual([{ effectId: 'hsladjust', name: 'Fam' }]);
    const level1 = written(writer, 'layouts', 'Level 1')[0];
    expect(level1.layers[0].instances[1].effects.Fam).toEqual({ isEnabled: true, parameters: { a: 1 } });
    expect(written(writer, 'layouts', 'Level 2')[0].layers[0].instances[0].effects.Fam).toBeDefined();
  });

  it('stores layer and layout effects with an inline instance block and touches no instances', async () => {
    const { server, writer } = setup();
    parse(await server.callTool('add_effect', { targetType: 'layer', targetName: 'Inner', layoutName: 'Level 1', effectId: 'hsladjust', parameters: { hue: 5 } }));
    const layout = written(writer, 'layouts', 'Level 1')[0];
    expect(layout.layers[0].subLayers[0].effectTypes).toEqual([{ effectId: 'hsladjust', name: 'hsladjust', instance: { isEnabled: true, parameters: { hue: 5 } } }]);
    expect(layout.layers[0].instances[0].effects).toBeUndefined();

    parse(await server.callTool('add_effect', { targetType: 'layout', targetName: 'Level 2', effectId: 'hsladjust', name: 'Whole' }));
    expect(written(writer, 'layouts', 'Level 2')[0].effectTypes[0]).toEqual({ effectId: 'hsladjust', name: 'Whole', instance: { isEnabled: true, parameters: {} } });
  });

  it('requires layoutName for a layer target and reports a missing layer', async () => {
    const { server } = setup();
    expect((await server.callTool('add_effect', { targetType: 'layer', targetName: 'Inner', effectId: 'hsladjust' })).isError).toBe(true);
    const r = await server.callTool('add_effect', { targetType: 'layer', targetName: 'Nope', layoutName: 'Level 1', effectId: 'hsladjust' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Layer "Nope" not found');
  });
});

describe('update_effect', () => {
  it('merges parameters and toggles a layer effect', async () => {
    const layouts = new Map([['Level 1', {
      ...layoutWithSubLayer(),
      layers: [{ name: 'Layer 0', sid: 2, instances: [], effectTypes: [{ effectId: 'hsladjust', name: 'Tint', instance: { isEnabled: true, parameters: { hue: 1, sat: 2 } } }] }],
    }]]);
    const { server, writer } = setup({ layouts });
    parse(await server.callTool('update_effect', { targetType: 'layer', targetName: 'Layer 0', layoutName: 'Level 1', name: 'Tint', isEnabled: false, parameters: { sat: 9 } }));
    expect(written(writer, 'layouts', 'Level 1')[0].layers[0].effectTypes[0].instance).toEqual({ isEnabled: false, parameters: { hue: 1, sat: 9 } });
  });

  it('refuses object-type targets and unknown names', async () => {
    const { server } = setup();
    const r = await server.callTool('update_effect', { targetType: 'objectType', targetName: 'Enemy', name: 'Tint', isEnabled: false });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('update_instance');
    expect((await server.callTool('update_effect', { targetType: 'layout', targetName: 'Level 1', name: 'Missing', isEnabled: false })).isError).toBe(true);
    expect((await server.callTool('update_effect', { targetType: 'layout', targetName: 'Level 1', name: 'Missing' })).isError).toBe(true);
  });
});

describe('remove_effect', () => {
  it('removes the type entry and the per-instance state everywhere', async () => {
    const layouts = new Map([
      ['Level 1', { ...layoutWithSubLayer(), layers: [{ name: 'L', sid: 2, effectTypes: [], instances: [instance(1, 'Enemy', { effects: { Tint: { isEnabled: true, parameters: {} }, Glow: { isEnabled: true, parameters: {} } } })] }] }],
      ['Level 2', { name: 'Level 2', sid: 5, layers: [{ name: 'L', sid: 6, effectTypes: [], instances: [instance(9, 'Player')] }], effectTypes: [] }],
    ]);
    const { server, writer } = setup({ layouts });
    const r = parse(await server.callTool('remove_effect', { targetType: 'objectType', targetName: 'Enemy', name: 'Tint' }));
    expect(r.success).toBe(true);
    expect(written(writer, 'objectTypes', 'Enemy')[0].effectTypes).toEqual([{ effectId: 'hsladjust', name: 'Glow' }]);
    expect(written(writer, 'layouts', 'Level 1')[0].layers[0].instances[0].effects).toEqual({ Glow: { isEnabled: true, parameters: {} } });
    expect(written(writer, 'layouts', 'Level 2')).toHaveLength(0);
  });

  it('reports an unknown effect name', async () => {
    const { server, writer } = setup();
    expect((await server.callTool('remove_effect', { targetType: 'objectType', targetName: 'Enemy', name: 'Nope' })).isError).toBe(true);
    expect(writer.calls).toHaveLength(0);
  });
});

describe('reorder_effects', () => {
  it('reorders the stack when given a full permutation', async () => {
    const { server, writer } = setup();
    parse(await server.callTool('reorder_effects', { targetType: 'objectType', targetName: 'Enemy', names: ['Glow', 'Tint'] }));
    expect(written(writer, 'objectTypes', 'Enemy')[0].effectTypes.map((e: any) => e.name)).toEqual(['Glow', 'Tint']);
  });

  it('rejects a partial, duplicated, or unknown list', async () => {
    const { server, writer } = setup();
    for (const names of [['Glow'], ['Glow', 'Glow'], ['Glow', 'Tint', 'Extra'], ['Glow', 'Nope']]) {
      expect((await server.callTool('reorder_effects', { targetType: 'objectType', targetName: 'Enemy', names })).isError).toBe(true);
    }
    expect(writer.calls).toHaveLength(0);
  });
});

describe('list_effects', () => {
  it('lists target effects and registered effect addons', async () => {
    const { server } = setup();
    const r = parse(await server.callTool('list_effects', { targetType: 'objectType', targetName: 'Enemy' }));
    expect(r.effects.map((e: any) => e.name)).toEqual(['Tint', 'Glow']);
    expect(r.registeredEffectAddons).toEqual(['hsladjust']);
  });
});
