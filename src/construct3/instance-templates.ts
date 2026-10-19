/**
 * The `template` block of a layout instance, and the search for a template
 * instance by name.
 *
 * A Construct 3 "template" is a layout instance the editor treats as the
 * master copy for other instances ("replicas"). The state of an instance is
 * its `template` block inside `layouts/<name>.json`; an object type also keeps
 * the name of a default template. Shape as saved by Construct 3 r506-2 (Free
 * edition):
 *
 *   "template": {
 *     "mode": "template",                            // or "replica"
 *     "templateName": "Default",                     // "" on a replica
 *     "sourceTemplateName": "",                      // the template on a replica
 *     "replicaHierarchyInSyncWithTemplate": false,
 *     "templatePropagateHierarchyChanges": true,
 *     "replicaIgnoreTemplateHierarchyChanges": false,
 *     "components": [ { "id": "plugin", "component": [...] }, ... ],
 *     "replicasUIDs": null
 *   }
 *
 * `components` always carries the five ids `plugin`, `instance-variable`,
 * `behavior`, `effect` and `world-instance`, in that order. Each entry is a
 * list of `{ key, state }` pairs saying which properties this instance keeps
 * in sync with its template.
 */

import type { Instance, Layout } from './types.js';
import { forEachLayoutInstance } from './layers.js';

/** One `{ key, state }` pair inside a template component. */
export interface TemplateComponentEntry {
  key: string;
  /**
   * Either a list of `[propertyName, inSync]` pairs (plugin, behavior, effect
   * and world-instance components) or a list of `{ iv, state }` records
   * (the instance-variable component).
   */
  state: Array<[string, boolean]> | Array<{ iv: string; state: boolean }>;
}

/** One of the five components of a template block. */
export interface TemplateComponent {
  id: 'plugin' | 'instance-variable' | 'behavior' | 'effect' | 'world-instance';
  component: TemplateComponentEntry[];
}

/** The `template` block of an instance. */
export interface InstanceTemplate {
  mode: 'template' | 'replica';
  templateName: string;
  sourceTemplateName: string;
  replicaHierarchyInSyncWithTemplate: boolean;
  templatePropagateHierarchyChanges: boolean;
  replicaIgnoreTemplateHierarchyChanges: boolean;
  components: TemplateComponent[];
  replicasUIDs: number[] | null;
}

/**
 * The world-instance property keys, in the order the editor saves them. The
 * list is fixed rather than derived from the instance.
 */
export const WORLD_INSTANCE_KEYS = [
  'x', 'y', 'z', 'w', 'h', 'd', 'a', 'o', 'c', 'sx', 'sy', 'sz', 'bm',
  'sam', 'tgs', 'twpx', 'twpy', 'twpz', 'twpw', 'twph', 'twpd', 'twpa',
  'dwp', 'ssm',
] as const;

/**
 * `x` and `y` are `false` in a saved block; every other key is `true`.
 */
const WORLD_INSTANCE_DEFAULT_FALSE = new Set(['x', 'y']);

/**
 * Properties the editor leaves out of the `plugin` component of a saved block:
 * `live-preview`. Every other property the instance carries is included.
 */
const PLUGIN_PROPERTIES_NOT_IN_TEMPLATE = new Set(['live-preview']);

/**
 * Properties the editor leaves out of a behavior's list of a saved block:
 * `live-preview`. Every other property of the behavior is included.
 */
const BEHAVIOR_PROPERTIES_NOT_IN_TEMPLATE = new Set(['live-preview']);

/**
 * Marker key the editor appends to an effect's state list to cover the
 * effect's enabled flag.
 */
const EFFECT_ENABLE_KEY = '<<effect-template-enable>>';

function pairs(keys: string[]): Array<[string, boolean]> {
  return keys.map(key => [key, true] as [string, boolean]);
}

/**
 * Build the five components from the instance's own plugin, variable,
 * behavior and effect state. An instance with no plugin properties gets an
 * empty `plugin` list and one with no world block an empty `world-instance`
 * list: that is this tool's choice, the editor was not seen saving either.
 */
export function buildTemplateComponents(instance: Instance): TemplateComponent[] {
  const properties = (instance.properties ?? {}) as Record<string, unknown>;
  const pluginKeys = Object.keys(properties).filter(key => !PLUGIN_PROPERTIES_NOT_IN_TEMPLATE.has(key));

  const instanceVariables = (instance.instanceVariables ?? {}) as Record<string, unknown>;
  const behaviors = (instance.behaviors ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
  const effects = (instance.effects ?? {}) as Record<string, { parameters?: Record<string, unknown> }>;

  const isWorld = instance.world !== undefined && instance.world !== null;

  return [
    {
      id: 'plugin',
      component: pluginKeys.length > 0 ? [{ key: 'plugin', state: pairs(pluginKeys) }] : [],
    },
    {
      id: 'instance-variable',
      component: [{
        key: 'instance-variable',
        state: Object.keys(instanceVariables).map(iv => ({ iv, state: true })),
      }],
    },
    {
      id: 'behavior',
      component: Object.keys(behaviors).map(key => ({
        key,
        state: pairs(Object.keys(behaviors[key]?.properties ?? {}).filter(name => !BEHAVIOR_PROPERTIES_NOT_IN_TEMPLATE.has(name))),
      })),
    },
    {
      id: 'effect',
      component: Object.keys(effects).map(key => ({
        key,
        state: pairs([...Object.keys(effects[key]?.parameters ?? {}), EFFECT_ENABLE_KEY]),
      })),
    },
    {
      id: 'world-instance',
      component: isWorld
        ? [{
          key: 'world-instance',
          state: WORLD_INSTANCE_KEYS.map(key => [key, !WORLD_INSTANCE_DEFAULT_FALSE.has(key)] as [string, boolean]),
        }]
        : [],
    },
  ];
}

/** Build a complete `template` block for an instance. */
export function buildInstanceTemplate(
  instance: Instance,
  mode: 'template' | 'replica',
  templateName: string,
  sourceTemplateName: string,
): InstanceTemplate {
  return {
    mode,
    templateName,
    sourceTemplateName,
    replicaHierarchyInSyncWithTemplate: false,
    templatePropagateHierarchyChanges: true,
    replicaIgnoreTemplateHierarchyChanges: false,
    components: buildTemplateComponents(instance),
    // Saved as null by the editor, on a template that has a replica as well.
    replicasUIDs: null,
  };
}

/** The template block of an instance, or undefined when it has none. */
export function readTemplate(instance: Instance): InstanceTemplate | undefined {
  const block = instance.template;
  if (!block || typeof block !== 'object') return undefined;
  return block as unknown as InstanceTemplate;
}

/**
 * Whether two template names are the same template name of one object
 * type. Construct 3 r506-2 keeps two templates whose names differ only in
 * letter case apart, and accepted a name and its Unicode-normalisation twin as
 * two templates, so names are compared exactly.
 */
export function sameTemplateName(a: string, b: string): boolean {
  return a === b;
}

/** The key of a template name of an object type, equal for two names exactly when sameTemplateName is true. */
export function templateKey(objectType: string, templateName: string): string {
  return `${objectType}\0${templateName}`;
}

/** Where a template instance is: its layout and UID. */
export interface TemplateLocation {
  layout: string;
  uid: number;
}

/**
 * The first instance of `objectType` that is a template named `templateName`
 * in the given layouts (every layer, sub-layer and non-world instance),
 * leaving out the instance `skip` names.
 */
export function findTemplateInstance(
  layouts: ReadonlyMap<string, Layout>, objectType: string, templateName: string, skip?: TemplateLocation,
): TemplateLocation | undefined {
  for (const [layoutName, layout] of layouts) {
    let found: TemplateLocation | undefined;
    forEachLayoutInstance(layout, instance => {
      if (found !== undefined || instance.type !== objectType) return;
      const block = readTemplate(instance);
      if (!block || block.mode !== 'template' || !sameTemplateName(block.templateName, templateName)) return;
      if (skip && skip.layout === layoutName && skip.uid === instance.uid) return;
      found = { layout: layoutName, uid: instance.uid };
    });
    if (found !== undefined) return found;
  }
  return undefined;
}
