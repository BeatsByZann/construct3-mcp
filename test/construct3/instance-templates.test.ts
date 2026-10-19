import { describe, it, expect } from 'vitest';
import {
  buildInstanceTemplate, buildTemplateComponents, findTemplateInstance, sameTemplateName, templateKey, readTemplate,
} from '../../src/construct3/instance-templates.js';
import type { InstanceTemplate, TemplateComponent } from '../../src/construct3/instance-templates.js';
import type { Instance, Layout } from '../../src/construct3/types.js';

/** A Text instance as the editor saved it, with its template block (a template named HeroT). */
const savedText = {
  type: 'Hero',
  properties: {
    text: '', 'enable-bbcode': true, font: 'Arial', size: 24, 'line-height': 0, bold: false, italic: false,
    color: [1, 1, 1, 1], 'horizontal-alignment': 'left', 'vertical-alignment': 'top', wrapping: 'word',
    'text-direction': 'ltr', 'icon-set': -1, 'initially-visible': true, origin: 'top-left', 'read-aloud': false,
  },
  uid: 1,
  sid: 948225328556487,
  tags: '',
  instanceVariables: { hp: 0 },
  behaviors: {
    Fade: { properties: { 'fade-in-time': 0, 'wait-time': 0, 'fade-out-time': 1, destroy: true, enabled: true, 'live-preview': false } },
  },
  template: {
    mode: 'template',
    templateName: 'HeroT',
    sourceTemplateName: '',
    replicaHierarchyInSyncWithTemplate: false,
    templatePropagateHierarchyChanges: true,
    replicaIgnoreTemplateHierarchyChanges: false,
    components: [
      {
        id: 'plugin',
        component: [{
          key: 'plugin',
          state: [['text', true], ['enable-bbcode', true], ['font', true], ['size', true], ['line-height', true], ['bold', true],
            ['italic', true], ['color', true], ['horizontal-alignment', true], ['vertical-alignment', true], ['wrapping', true],
            ['text-direction', true], ['icon-set', true], ['initially-visible', true], ['origin', true], ['read-aloud', true]],
        }],
      },
      { id: 'instance-variable', component: [{ key: 'instance-variable', state: [{ iv: 'hp', state: true }] }] },
      {
        id: 'behavior',
        component: [{ key: 'Fade', state: [['fade-in-time', true], ['wait-time', true], ['fade-out-time', true], ['destroy', true], ['enabled', true]] }],
      },
      { id: 'effect', component: [{ key: 'Tint', state: [['color', true], ['<<effect-template-enable>>', true]] }] },
      {
        id: 'world-instance',
        component: [{
          key: 'world-instance',
          state: [['x', false], ['y', false], ['z', true], ['w', true], ['h', true], ['d', true], ['a', true], ['o', true], ['c', true],
            ['sx', true], ['sy', true], ['sz', true], ['bm', true], ['sam', true], ['tgs', true], ['twpx', true], ['twpy', true],
            ['twpz', true], ['twpw', true], ['twph', true], ['twpd', true], ['twpa', true], ['dwp', true], ['ssm', true]],
        }],
      },
    ],
    replicasUIDs: null,
  },
  effects: { Tint: { isEnabled: true, parameters: { color: [1, 0, 0, 1] } } },
  materialSurfaceType: 'smooth',
  showing: true,
  locked: false,
  world: { x: 100, y: 100, width: 100, height: 100, originX: 0, originY: 0, color: [1, 1, 1, 1], z: 0, angle: 0 },
};

/** A Sprite instance as the editor saved it, with its template block (a template named ShipT). */
const savedSprite = {
  type: 'Ship',
  properties: { 'initially-visible': true, 'initial-animation': 'Animation 1', 'initial-frame': 0, 'enable-collisions': true, 'live-preview': false },
  uid: 4,
  sid: 650481436617405,
  tags: '',
  instanceVariables: {},
  behaviors: {},
  template: {
    mode: 'template',
    templateName: 'ShipT',
    sourceTemplateName: '',
    replicaHierarchyInSyncWithTemplate: false,
    templatePropagateHierarchyChanges: true,
    replicaIgnoreTemplateHierarchyChanges: false,
    components: [
      {
        id: 'plugin',
        component: [{
          key: 'plugin',
          state: [['initially-visible', true], ['initial-animation', true], ['initial-frame', true], ['enable-collisions', true]],
        }],
      },
      { id: 'instance-variable', component: [{ key: 'instance-variable', state: [] }] },
      { id: 'behavior', component: [] },
      { id: 'effect', component: [] },
      {
        id: 'world-instance',
        component: [{
          key: 'world-instance',
          state: [['x', false], ['y', false], ['z', true], ['w', true], ['h', true], ['d', true], ['a', true], ['o', true], ['c', true],
            ['sx', true], ['sy', true], ['sz', true], ['bm', true], ['sam', true], ['tgs', true], ['twpx', true], ['twpy', true],
            ['twpz', true], ['twpw', true], ['twph', true], ['twpd', true], ['twpa', true], ['dwp', true], ['ssm', true]],
        }],
      },
    ],
    replicasUIDs: null,
  },
  materialSurfaceType: 'smooth',
  showing: true,
  locked: false,
  world: { x: 400, y: 100, width: 100, height: 100, originX: 0.5, originY: 0.5, color: [1, 1, 1, 1], z: 0, angle: 0 },
};

/** The instance without its block, so the builder cannot read the expected value from it. */
function withoutTemplate(saved: typeof savedText | typeof savedSprite): Instance {
  const { template: _template, ...rest } = saved;
  void _template;
  return rest as unknown as Instance;
}

function bareInstance(extra: Record<string, unknown> = {}): Instance {
  return { type: 'Hero', properties: {}, uid: 1, sid: 1, ...extra } as unknown as Instance;
}

function layoutOf(instances: Array<Record<string, unknown>>, nonWorld: Array<Record<string, unknown>> = []): Layout {
  return {
    name: 'L', layers: [{ name: 'Layer 0', sid: 1, instances, subLayers: [] }], 'nonworld-instances': nonWorld,
  } as unknown as Layout;
}

function templateInstance(type: string, uid: number, name: string, mode: 'template' | 'replica' = 'template'): Record<string, unknown> {
  return {
    type, properties: {}, uid, sid: uid,
    template: mode === 'template'
      ? { mode, templateName: name, sourceTemplateName: '', components: [], replicasUIDs: null }
      : { mode, templateName: '', sourceTemplateName: name, components: [], replicasUIDs: null },
  };
}

describe('buildInstanceTemplate', () => {
  it('builds the block the editor saved for a Text instance', () => {
    const built = buildInstanceTemplate(withoutTemplate(savedText), 'template', 'HeroT', '');
    expect(built).toEqual(savedText.template);
    expect(JSON.stringify(built)).toBe(JSON.stringify(savedText.template));
  });

  it('builds the block the editor saved for a Sprite instance', () => {
    const built = buildInstanceTemplate(withoutTemplate(savedSprite), 'template', 'ShipT', '');
    expect(built).toEqual(savedSprite.template);
    expect(JSON.stringify(built)).toBe(JSON.stringify(savedSprite.template));
  });

  it('writes empty components for an instance with nothing to sync', () => {
    const components = buildTemplateComponents(bareInstance());
    expect(components.find(c => c.id === 'plugin')?.component).toEqual([]);
    expect(components.find(c => c.id === 'instance-variable')?.component).toEqual([{ key: 'instance-variable', state: [] }]);
    expect(components.find(c => c.id === 'behavior')?.component).toEqual([]);
    expect(components.find(c => c.id === 'effect')?.component).toEqual([]);
    expect(components.find(c => c.id === 'world-instance')?.component).toEqual([]);
  });

  it('keeps the five component ids in order', () => {
    const ids = buildTemplateComponents(withoutTemplate(savedText)).map((c: TemplateComponent) => c.id);
    expect(ids).toEqual(['plugin', 'instance-variable', 'behavior', 'effect', 'world-instance']);
  });

  it('drops live-preview and nothing else from the plugin state', () => {
    const instance = bareInstance({ properties: { text: 'x', 'live-preview': true, other: 1 } });
    const plugin = buildTemplateComponents(instance).find(c => c.id === 'plugin');
    expect(plugin?.component[0].state).toEqual([['text', true], ['other', true]]);
  });

  it('drops live-preview and nothing else from a behavior state', () => {
    const instance = bareInstance({ behaviors: { Fade: { properties: { 'fade-in-time': 0, 'live-preview': false, enabled: true } } } });
    const behavior = buildTemplateComponents(instance).find(c => c.id === 'behavior');
    expect(behavior?.component).toEqual([{ key: 'Fade', state: [['fade-in-time', true], ['enabled', true]] }]);
  });

  it('replicasUIDs is null for both modes', () => {
    const instance = withoutTemplate(savedText);
    expect(buildInstanceTemplate(instance, 'template', 'HeroT', '').replicasUIDs).toBeNull();
    expect(buildInstanceTemplate(instance, 'replica', '', 'HeroT').replicasUIDs).toBeNull();
  });

  it('a non-world instance has no world-instance state', () => {
    const instance = bareInstance({ properties: { width: 10 } });
    expect(buildTemplateComponents(instance).find(c => c.id === 'world-instance')?.component).toEqual([]);
  });

  it('puts the template name and the source name in the block as given', () => {
    const replica: InstanceTemplate = buildInstanceTemplate(bareInstance(), 'replica', '', 'HeroT');
    expect(replica.mode).toBe('replica');
    expect(replica.templateName).toBe('');
    expect(replica.sourceTemplateName).toBe('HeroT');
  });
});

describe('findTemplateInstance', () => {
  it('finds a template of the object type, skips the given instance, ignores replicas and other object types, and returns the name as the layout spells it', () => {
    const layouts = new Map<string, Layout>([
      ['A', layoutOf([
        templateInstance('Other', 1, 'HeroT'),
        templateInstance('Hero', 2, 'HeroT', 'replica'),
        templateInstance('Hero', 3, 'HeroT'),
      ])],
      ['B', layoutOf([templateInstance('Hero', 4, 'HeroT')])],
    ]);
    expect(findTemplateInstance(layouts, 'Hero', 'HeroT')).toEqual({ layout: 'A', uid: 3, templateName: 'HeroT' });
    expect(findTemplateInstance(layouts, 'Hero', 'HeroT', { layout: 'A', uid: 3 })).toEqual({ layout: 'B', uid: 4, templateName: 'HeroT' });
    expect(findTemplateInstance(layouts, 'Hero', 'HeroT', { layout: 'B', uid: 4 })).toEqual({ layout: 'A', uid: 3, templateName: 'HeroT' });
    expect(findTemplateInstance(layouts, 'Other', 'HeroT')).toEqual({ layout: 'A', uid: 1, templateName: 'HeroT' });
    expect(findTemplateInstance(layouts, 'Hero', 'Nope')).toBeUndefined();
    // Another letter case is another template name
    expect(findTemplateInstance(layouts, 'Hero', 'herot')).toBeUndefined();
  });

  it('finds a template on a sub-layer', () => {
    const layout = layoutOf([]);
    (layout.layers[0] as unknown as { subLayers: unknown[] }).subLayers = [
      { name: 'Sub', sid: 2, instances: [templateInstance('Hero', 9, 'HeroT')], subLayers: [] },
    ];
    expect(findTemplateInstance(new Map([['A', layout]]), 'Hero', 'HeroT')).toEqual({ layout: 'A', uid: 9, templateName: 'HeroT' });
  });

  it('reads non-world instances too', () => {
    const layouts = new Map<string, Layout>([['A', layoutOf([], [templateInstance('Hero', 7, 'HeroT')])]]);
    expect(findTemplateInstance(layouts, 'Hero', 'HeroT')).toEqual({ layout: 'A', uid: 7, templateName: 'HeroT' });
  });
});

describe('sameTemplateName and templateKey', () => {
  const composed = 'é';
  const decomposed = 'é';

  it('sameTemplateName compares names exactly', () => {
    expect(sameTemplateName('HeroT', 'HeroT')).toBe(true);
    expect(sameTemplateName('A', 'a')).toBe(false);
    expect(sameTemplateName(composed, decomposed)).toBe(false);
  });

  it('templateKey agrees with sameTemplateName', () => {
    for (const [a, b] of [['A', 'a'], ['A', 'A'], [composed, decomposed], [composed, composed]] as const) {
      expect(templateKey('Hero', a) === templateKey('Hero', b)).toBe(sameTemplateName(a, b));
    }
    expect(templateKey('Hero', 'T')).not.toBe(templateKey('Ship', 'T'));
  });

  it('readTemplate gives the block, or undefined when there is none', () => {
    expect(readTemplate(bareInstance())).toBeUndefined();
    expect(readTemplate(bareInstance({ template: 'x' }))).toBeUndefined();
    expect(readTemplate(withoutTemplate(savedText))).toBeUndefined();
    expect(readTemplate(savedText as unknown as Instance)?.templateName).toBe('HeroT');
  });
});
