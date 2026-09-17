/**
 * Template tools: list_templates, set_instance_template, set_default_template.
 *
 * A Construct 3 "template" is a layout instance the editor treats as the
 * master copy for other instances ("replicas"). The state lives entirely in
 * the instance's `template` block inside `layouts/<name>.json`; there is no
 * separate template registry.
 *
 * Shape confirmed against C3-ACE (`layouts/Legend/repoLegendObjects.json`,
 * Construct 3 r495), where 29157 instances carry a `template` block:
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

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Layout, Instance, ObjectType } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { collectLayers, collectInstances } from '../construct3/layout-walk.js';
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';

// ─── Template block shape ──────────────────────────────────

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

export interface TemplateComponent {
  id: 'plugin' | 'instance-variable' | 'behavior' | 'effect' | 'world-instance';
  component: TemplateComponentEntry[];
}

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
 * The world-instance property keys, in the exact order Construct writes them.
 * Identical on all 29157 template blocks in C3-ACE, so the list is fixed
 * rather than derived from the instance.
 */
export const WORLD_INSTANCE_KEYS = [
  'x', 'y', 'z', 'w', 'h', 'a', 'o', 'c', 'sx', 'sy', 'bm',
  'twpx', 'twpy', 'twpz', 'twpw', 'twph', 'twpa', 'dwp',
  'ssm', 'sam', 'tgs', 'twpd', 'd', 'sz',
] as const;

/**
 * `x` and `y` are `false` on every one of the 29157 blocks observed, which is
 * what makes replicas independently placeable; every other key defaults to
 * `true` on a fresh template.
 */
const WORLD_INSTANCE_DEFAULT_FALSE = new Set(['x', 'y']);

/**
 * Plugin properties Construct leaves out of the `plugin` component. Only
 * `live-preview` was observed being dropped (29034 of 29157 blocks omit it and
 * nothing else). Whether other editor-only properties are dropped too cannot
 * be derived from the sample, so every other property the instance carries is
 * included.
 */
const PLUGIN_PROPERTIES_NOT_IN_TEMPLATE = new Set(['live-preview']);

/**
 * Marker key Construct appends to an effect's state list to cover the effect's
 * enabled flag. Observed verbatim on every effect component in C3-ACE.
 */
const EFFECT_ENABLE_KEY = '<<effect-template-enable>>';

// ─── Component derivation ──────────────────────────────────

function pairs(keys: string[]): Array<[string, boolean]> {
  return keys.map(key => [key, true] as [string, boolean]);
}

/** Build the five components from the instance's own plugin/behavior/effect state. */
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
        state: pairs(Object.keys(behaviors[key]?.properties ?? {})),
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
    // Always null on disk, on templates with replicas as well as without:
    // Construct recomputes the list when it loads the project.
    replicasUIDs: null,
  };
}

// ─── Lookup helpers ────────────────────────────────────────

interface FoundInstance {
  instance: Instance;
  /** Layer name, or null for a non-world instance. */
  layer: string | null;
}

function findInstanceByUid(layout: Layout, uid: number): FoundInstance | null {
  for (const layer of collectLayers(layout)) {
    if (!Array.isArray(layer.instances)) continue;
    for (const instance of layer.instances) {
      if (instance.uid === uid) return { instance, layer: layer.name };
    }
  }
  const nonworld = layout['nonworld-instances'];
  if (Array.isArray(nonworld)) {
    for (const raw of nonworld) {
      const instance = raw as unknown as Instance;
      if (instance.uid === uid) return { instance, layer: null };
    }
  }
  return null;
}

function readTemplate(instance: Instance): InstanceTemplate | undefined {
  const block = instance.template;
  if (!block || typeof block !== 'object') return undefined;
  return block as unknown as InstanceTemplate;
}

// ─── Registration ──────────────────────────────────────────

export function registerTemplateTools({ server, reader, writer }: MutationToolDeps) {
  // ─── list_templates ───────────────────────────────────────

  server.tool(
    'list_templates',
    'List every instance template in the project: the layout, UID and object type of each template instance, and how many replicas point at it.',
    {
      objectType: z.string().max(200).optional().describe('Only list templates for this object type'),
    },
    async (args) => {
      try {
        if (args.objectType) {
          const objectTypes = await reader.listObjectTypes();
          if (!objectTypes.includes(args.objectType)) {
            return notFoundError('Object', args.objectType, reader.findNearestName(args.objectType, 'objects'), 'list_objects');
          }
        }

        interface TemplateRow {
          templateName: string;
          objectType: string;
          layout: string;
          uid: number;
          replicaCount: number;
        }
        const templates: TemplateRow[] = [];
        // Replicas name their source, not their source's UID, so they are
        // counted per (objectType, sourceTemplateName) pair.
        const replicaCounts = new Map<string, number>();
        const orphanedReplicas: Array<{ objectType: string; layout: string; uid: number; sourceTemplateName: string }> = [];
        const warnings: string[] = [];

        const layouts = await reader.listLayouts();
        const pending: Array<{ objectType: string; layout: string; uid: number; sourceTemplateName: string }> = [];

        for (const layoutName of layouts) {
          let layout: Layout;
          try {
            layout = await reader.readLayout(layoutName);
          } catch (e) {
            warnings.push(`Layout "${layoutName}" could not be read: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          for (const instance of collectInstances(layout)) {
            const block = readTemplate(instance);
            if (!block) continue;
            if (args.objectType && instance.type !== args.objectType) continue;
            if (block.mode === 'template' && block.templateName) {
              templates.push({
                templateName: block.templateName,
                objectType: instance.type,
                layout: layoutName,
                uid: instance.uid,
                replicaCount: 0,
              });
            } else if (block.mode === 'replica' && block.sourceTemplateName) {
              const key = `${instance.type} ${block.sourceTemplateName}`;
              replicaCounts.set(key, (replicaCounts.get(key) ?? 0) + 1);
              pending.push({
                objectType: instance.type,
                layout: layoutName,
                uid: instance.uid,
                sourceTemplateName: block.sourceTemplateName,
              });
            }
          }
        }

        for (const row of templates) {
          row.replicaCount = replicaCounts.get(`${row.objectType} ${row.templateName}`) ?? 0;
        }
        const known = new Set(templates.map(row => `${row.objectType} ${row.templateName}`));
        for (const replica of pending) {
          if (!known.has(`${replica.objectType} ${replica.sourceTemplateName}`)) {
            orphanedReplicas.push(replica);
          }
        }

        return toolResult({
          templates,
          count: templates.length,
          // A replica whose template instance is not in this project (or was
          // filtered out by objectType) — reported rather than hidden.
          orphanedReplicas: orphanedReplicas.length > 0 ? orphanedReplicas.slice(0, 50) : undefined,
          orphanedReplicaCount: orphanedReplicas.length > 0 ? orphanedReplicas.length : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[list_templates] failed:', error);
        return toolError(`Error listing templates: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_instance_template ────────────────────────────────

  server.tool(
    'set_instance_template',
    'Make a layout instance a template, a replica of a named template, or neither. The template block is built from the instance\'s own plugin properties, instance variables, behaviors and effects.',
    {
      layoutName: z.string().max(200).describe('Layout holding the instance'),
      uid: z.number().int().describe('Instance UID'),
      mode: z.enum(['none', 'template', 'replica']).describe('none removes the template block; template makes this the master; replica links it to a template'),
      templateName: z.string().max(200).optional().describe('Template name — required for mode "template"'),
      sourceTemplateName: z.string().max(200).optional().describe('Name of the template to follow — required for mode "replica"'),
    },
    async (args) => {
      try {
        const { layoutName, uid, mode } = args;

        const layouts = await reader.listLayouts();
        if (!layouts.includes(layoutName)) {
          return notFoundError('Layout', layoutName, reader.findNearestName(layoutName, 'layouts'), 'list_layouts');
        }
        const layout = await reader.readLayout(layoutName);
        const found = findInstanceByUid(layout, uid);
        if (!found) {
          return toolError(`No instance with UID ${uid} in layout "${layoutName}". Use get_layout_details to see the instances.`);
        }

        if (mode === 'template' && !args.templateName) {
          return toolError('mode "template" requires templateName.');
        }
        if (mode === 'replica' && !args.sourceTemplateName) {
          return toolError('mode "replica" requires sourceTemplateName.');
        }

        const warnings: string[] = [];
        let action: string;

        if (mode === 'none') {
          if (!readTemplate(found.instance)) {
            return toolError(`Instance UID ${uid} in layout "${layoutName}" has no template block; nothing to remove.`);
          }
          delete (found.instance as Record<string, unknown>).template;
          action = 'template removed';
        } else if (mode === 'template') {
          const templateName = args.templateName!;
          // Two templates of one object type sharing a name would make every
          // replica of that name ambiguous.
          const clash = await findTemplateLocation(reader, found.instance.type, templateName, { layout: layoutName, uid });
          if (clash) {
            return toolError(
              `Instance UID ${clash.uid} in layout "${clash.layout}" is already a template named "${templateName}" ` +
              `for object type "${found.instance.type}". Template names must be unique per object type.`
            );
          }
          (found.instance as Record<string, unknown>).template =
            buildInstanceTemplate(found.instance, 'template', templateName, '');
          action = 'template created';
        } else {
          const sourceTemplateName = args.sourceTemplateName!;
          const exists = await findTemplateLocation(reader, found.instance.type, sourceTemplateName);
          if (!exists) {
            warnings.push(
              `No instance of "${found.instance.type}" is a template named "${sourceTemplateName}". ` +
              'The replica is written anyway, but Construct will have nothing to sync it with until that template exists.'
            );
          }
          (found.instance as Record<string, unknown>).template =
            buildInstanceTemplate(found.instance, 'replica', '', sourceTemplateName);
          action = 'replica linked';
        }

        if (mode !== 'none' && found.layer === null) {
          warnings.push(
            `UID ${uid} is a non-world instance; no template block was observed on a non-world instance in the reference project, ` +
            'so Construct may ignore it.'
          );
        }

        const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
        const backupPath = await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: `${layoutName}#${uid}`,
          category: 'template',
          action,
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_instance_template] failed:', error);
        return toolError(`Error setting instance template: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_default_template ─────────────────────────────────

  server.tool(
    'set_default_template',
    'Set or clear the template a new instance of an object type is created from in the editor (editorNewInstanceIsReplica / editorNewInstanceTemplateName on the object type).',
    {
      objectName: z.string().max(200).describe('Object type name'),
      templateName: z.string().max(200).nullable().describe('Template to create new instances from, or null to clear it'),
    },
    async (args) => {
      try {
        const objectTypes = await reader.listObjectTypes();
        if (!objectTypes.includes(args.objectName)) {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }
        const objectType = await reader.readObjectType(args.objectName);
        const warnings: string[] = [];

        if (args.templateName === null) {
          delete (objectType as Record<string, unknown>).editorNewInstanceTemplateName;
          (objectType as ObjectType).editorNewInstanceIsReplica = false;
        } else {
          const exists = await findTemplateLocation(reader, args.objectName, args.templateName);
          if (!exists) {
            warnings.push(
              `No instance of "${args.objectName}" is a template named "${args.templateName}". ` +
              'Create one with set_instance_template first, or the editor will have nothing to copy.'
            );
          }
          (objectType as ObjectType).editorNewInstanceIsReplica = true;
          (objectType as Record<string, unknown>).editorNewInstanceTemplateName = args.templateName;
        }

        // 109 object types in the reference project carry
        // editorNewInstanceIsReplica and only 53 also carry
        // editorNewInstanceTemplateName, so the flag can stand alone; what the
        // editor does in that case is not derivable from the sample.
        warnings.push(
          'editorNewInstanceIsReplica is set alongside the name. Some object types in the reference project carry the flag ' +
          'without a template name; that combination was not reproduced here.'
        );

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, objectType, subfolder);
        resetProjectIndex();

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'objecttype',
          action: args.templateName === null ? 'default template cleared' : 'default template set',
          warnings,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_default_template] failed:', error);
        return toolError(`Error setting default template: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

/**
 * Locate the instance of `objectType` that is a template named
 * `templateName`, skipping one instance by layout and UID when given.
 */
async function findTemplateLocation(
  reader: MutationToolDeps['reader'],
  objectType: string,
  templateName: string,
  skip?: { layout: string; uid: number },
): Promise<{ layout: string; uid: number } | null> {
  for (const layoutName of await reader.listLayouts()) {
    let layout: Layout;
    try {
      layout = await reader.readLayout(layoutName);
    } catch {
      continue;
    }
    for (const instance of collectInstances(layout)) {
      if (instance.type !== objectType) continue;
      const block = readTemplate(instance);
      if (!block || block.mode !== 'template' || block.templateName !== templateName) continue;
      if (skip && skip.layout === layoutName && skip.uid === instance.uid) continue;
      return { layout: layoutName, uid: instance.uid };
    }
  }
  return null;
}
