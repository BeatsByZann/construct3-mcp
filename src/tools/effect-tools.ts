/**
 * Effect tools: list_effects, add_effect, update_effect, remove_effect, reorder_effects.
 *
 * Effects attach to four kinds of target. Object types and families carry
 * `effectTypes: [{ effectId, name }]`, and every placed instance of the type
 * carries the per-instance state in `effects: { <name>: { isEnabled, parameters } }`.
 * Layers and layouts carry both in one entry:
 * `effectTypes: [{ effectId, name, instance: { isEnabled, parameters } }]`.
 *
 * Effects are never auto-registered: the effect addon must already be in
 * usedAddons (register_addon), because its files must exist in the project.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, Layout, ObjectType } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { validateName, toolResult, toolError, notFoundError, boundedRecord } from './shared.js';
import { collectInstances, findLayer } from '../construct3/layout-walk.js';

export interface EffectTypeEntry {
  effectId: string;
  name: string;
  instance?: EffectInstanceState;
  [key: string]: unknown;
}

export interface EffectInstanceState {
  isEnabled: boolean;
  parameters: Record<string, unknown>;
}

type TargetType = 'objectType' | 'family' | 'layer' | 'layout';

const targetShape = {
  targetType: z.enum(['objectType', 'family', 'layer', 'layout']).describe('What the effect is attached to'),
  targetName: z.string().max(200).describe('Object type, family, layout, or layer name'),
  layoutName: z.string().max(200).optional().describe('For targetType "layer": the layout that contains the layer'),
};

/** A loaded target: the JSON to mutate, its effectTypes array, and how to save it. */
interface LoadedTarget {
  effectTypes: EffectTypeEntry[];
  /** Object type names whose placed instances carry per-instance effect state. */
  instanceOwners: string[];
  save: () => Promise<string>;
  describe: string;
}

async function loadTarget(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  targetType: TargetType,
  targetName: string,
  layoutName: string | undefined,
): Promise<LoadedTarget | ReturnType<typeof toolError>> {
  const ensureArray = (holder: Record<string, unknown>): EffectTypeEntry[] => {
    if (!Array.isArray(holder.effectTypes)) holder.effectTypes = [];
    return holder.effectTypes as EffectTypeEntry[];
  };

  switch (targetType) {
    case 'objectType': {
      let obj: ObjectType;
      try {
        obj = await reader.readObjectType(targetName);
      } catch {
        return notFoundError('Object', targetName, reader.findNearestName(targetName, 'objects'), 'list_objects');
      }
      return {
        effectTypes: ensureArray(obj as Record<string, unknown>),
        instanceOwners: [targetName],
        save: () => writer.writeEntityFile('objectTypes', targetName, obj, writer.getSubfolderForEntity('objectTypes', targetName)),
        describe: `object type "${targetName}"`,
      };
    }
    case 'family': {
      let family: Record<string, unknown>;
      try {
        family = await reader.readFamily(targetName);
      } catch {
        return toolError(`Family "${targetName}" not found. Use list_families to see available families.`);
      }
      const members = Array.isArray(family.members) ? (family.members as string[]) : [];
      return {
        effectTypes: ensureArray(family),
        instanceOwners: members,
        save: () => writer.writeEntityFile('families', targetName, family, writer.getSubfolderForEntity('families', targetName)),
        describe: `family "${targetName}"`,
      };
    }
    case 'layout':
    case 'layer': {
      const owningLayout = targetType === 'layout' ? targetName : layoutName;
      if (!owningLayout) {
        return toolError('layoutName is required when targetType is "layer".');
      }
      let layout: Layout;
      try {
        layout = await reader.readLayout(owningLayout);
      } catch {
        return notFoundError('Layout', owningLayout, reader.findNearestName(owningLayout, 'layouts'), 'list_layouts');
      }
      const save = () => writer.writeEntityFile('layouts', owningLayout, layout, writer.getSubfolderForEntity('layouts', owningLayout));
      if (targetType === 'layout') {
        return { effectTypes: ensureArray(layout as Record<string, unknown>), instanceOwners: [], save, describe: `layout "${targetName}"` };
      }
      const layer = findLayer(layout, targetName);
      if (!layer) {
        return toolError(`Layer "${targetName}" not found in layout "${owningLayout}". Use get_layout_details to see its layers.`);
      }
      return { effectTypes: ensureArray(layer as Record<string, unknown>), instanceOwners: [], save, describe: `layer "${targetName}" of layout "${owningLayout}"` };
    }
  }
}

function isToolError(value: unknown): value is ReturnType<typeof toolError> {
  return typeof value === 'object' && value !== null && (value as { isError?: boolean }).isError === true;
}

/**
 * Apply `mutate` to the per-instance effect state of every placed instance
 * whose type is in `owners`, across all layouts. Returns the layouts written.
 */
async function updateInstanceEffects(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  owners: string[],
  mutate: (effects: Record<string, EffectInstanceState>) => boolean,
): Promise<string[]> {
  if (owners.length === 0) return [];
  const ownerSet = new Set(owners);
  const written: string[] = [];
  for (const [layoutName, layout] of await reader.readAllLayouts()) {
    let modified = false;
    for (const instance of collectInstances(layout)) {
      if (!ownerSet.has(instance.type)) continue;
      const inst = instance as Record<string, unknown>;
      if (!inst.effects || typeof inst.effects !== 'object') inst.effects = {};
      modified = mutate(inst.effects as Record<string, EffectInstanceState>) || modified;
    }
    if (modified) {
      await writer.writeEntityFile('layouts', layoutName, layout, writer.getSubfolderForEntity('layouts', layoutName));
      written.push(layoutName);
    }
  }
  return written;
}

export function registerEffectTools({ server, reader, writer }: MutationToolDeps) {
  // ─── list_effects ─────────────────────────────────────────

  server.tool(
    'list_effects',
    'List the effects attached to an object type, family, layer, or layout, plus the effect addons registered in the project',
    targetShape,
    async (args) => {
      try {
        const target = await loadTarget(reader, writer, args.targetType, args.targetName, args.layoutName);
        if (isToolError(target)) return target;
        const registered = reader.getUsedAddons().filter(a => a.type === 'effect').map(a => a.id);
        return toolResult({ target: target.describe, effects: target.effectTypes, registeredEffectAddons: registered });
      } catch (error) {
        console.error('[list_effects] failed:', error);
        return toolError(`Error listing effects: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_effect ───────────────────────────────────────────

  server.tool(
    'add_effect',
    'Attach a registered effect addon to an object type, family, layer, or layout. Object-type and family effects also add per-instance state to every placed instance. The effect must already be in usedAddons (see register_addon).',
    {
      ...targetShape,
      effectId: z.string().max(200).describe('Effect addon ID as listed in usedAddons (e.g. "hsladjust")'),
      name: z.string().max(200).optional().describe('Effect name shown in the editor (default: the effect ID)'),
      parameters: boundedRecord(50, 3).optional().describe('Initial parameter values. Omitted parameters are left for Construct to default.'),
      isEnabled: z.boolean().optional().default(true).describe('Initially enabled (default: true)'),
      index: z.number().int().min(0).optional().describe('Position in the effect stack (default: append)'),
    },
    async (args) => {
      try {
        const name = args.name ?? args.effectId;
        validateName(name);

        const registered = reader.getUsedAddons().some(a => a.type === 'effect' && a.id === args.effectId);
        if (!registered) {
          return toolError(
            `Effect "${args.effectId}" is not registered in the project's usedAddons. ` +
            `Add it in the Construct 3 editor (so its files are part of the project) or call register_addon with type "effect" first.`
          );
        }

        const target = await loadTarget(reader, writer, args.targetType, args.targetName, args.layoutName);
        if (isToolError(target)) return target;

        if (target.effectTypes.some(e => e.name === name)) {
          return toolError(`An effect named "${name}" already exists on ${target.describe}.`);
        }
        if (args.index !== undefined && args.index > target.effectTypes.length) {
          return toolError(`index ${args.index} is out of range; ${target.describe} has ${target.effectTypes.length} effect(s).`);
        }

        const warnings: string[] = [];
        const state: EffectInstanceState = { isEnabled: args.isEnabled, parameters: args.parameters ?? {} };
        if (!args.parameters) {
          warnings.push('No parameters supplied; the effect is written with an empty parameter set for Construct to default on load.');
        }

        const entry: EffectTypeEntry = { effectId: args.effectId, name };
        if (args.targetType === 'layer' || args.targetType === 'layout') {
          entry.instance = state;
        }
        target.effectTypes.splice(args.index ?? target.effectTypes.length, 0, entry);
        const backupPath = await target.save();

        const written = await updateInstanceEffects(reader, writer, target.instanceOwners, effects => {
          if (effects[name]) return false;
          effects[name] = { isEnabled: state.isEnabled, parameters: { ...state.parameters } };
          return true;
        });
        if (written.length > 0) warnings.push(`Added per-instance effect state in layout(s): ${written.join(', ')}`);

        const result: WriteResult = {
          success: true,
          entity: args.targetName,
          category: args.targetType,
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_effect] failed:', error);
        return toolError(`Error adding effect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_effect ────────────────────────────────────────

  server.tool(
    'update_effect',
    'Change an effect\'s enabled flag or parameters on a layer or layout. For object-type and family effects, per-instance state is edited with update_instance.',
    {
      ...targetShape,
      name: z.string().max(200).describe('Effect name on the target'),
      isEnabled: z.boolean().optional().describe('Enable or disable the effect'),
      parameters: boundedRecord(50, 3).optional().describe('Parameter values to merge into the existing ones'),
    },
    async (args) => {
      try {
        if (args.isEnabled === undefined && args.parameters === undefined) {
          return toolError('No updates provided. Specify isEnabled and/or parameters.');
        }
        if (args.targetType !== 'layer' && args.targetType !== 'layout') {
          return toolError('update_effect edits layer and layout effects only. Per-instance state of object-type and family effects is edited with update_instance (effects).');
        }
        const target = await loadTarget(reader, writer, args.targetType, args.targetName, args.layoutName);
        if (isToolError(target)) return target;
        const entry = target.effectTypes.find(e => e.name === args.name);
        if (!entry) {
          return toolError(`Effect "${args.name}" not found on ${target.describe}. Use list_effects to see its effects.`);
        }
        if (!entry.instance || typeof entry.instance !== 'object') entry.instance = { isEnabled: true, parameters: {} };
        if (args.isEnabled !== undefined) entry.instance.isEnabled = args.isEnabled;
        if (args.parameters !== undefined) entry.instance.parameters = { ...(entry.instance.parameters ?? {}), ...args.parameters };
        const backupPath = await target.save();
        const result: WriteResult = { success: true, entity: args.targetName, category: args.targetType, action: 'updated', backupFile: backupPath };
        return toolResult(result);
      } catch (error) {
        console.error('[update_effect] failed:', error);
        return toolError(`Error updating effect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_effect ────────────────────────────────────────

  server.tool(
    'remove_effect',
    'Detach an effect from an object type, family, layer, or layout, removing its per-instance state from placed instances',
    {
      ...targetShape,
      name: z.string().max(200).describe('Effect name on the target'),
    },
    async (args) => {
      try {
        const target = await loadTarget(reader, writer, args.targetType, args.targetName, args.layoutName);
        if (isToolError(target)) return target;
        const idx = target.effectTypes.findIndex(e => e.name === args.name);
        if (idx === -1) {
          return toolError(`Effect "${args.name}" not found on ${target.describe}. Use list_effects to see its effects.`);
        }
        target.effectTypes.splice(idx, 1);
        const backupPath = await target.save();

        const written = await updateInstanceEffects(reader, writer, target.instanceOwners, effects => {
          if (!(args.name in effects)) return false;
          delete effects[args.name];
          return true;
        });

        const result: WriteResult = {
          success: true,
          entity: args.targetName,
          category: args.targetType,
          action: 'updated',
          backupFile: backupPath,
          warnings: written.length > 0 ? [`Removed per-instance effect state in layout(s): ${written.join(', ')}`] : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[remove_effect] failed:', error);
        return toolError(`Error removing effect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── reorder_effects ──────────────────────────────────────

  server.tool(
    'reorder_effects',
    'Set the order of the effect stack on an object type, family, layer, or layout. Effects render in array order.',
    {
      ...targetShape,
      names: z.array(z.string().max(200)).min(1).max(100).describe('Every effect name on the target, in the new order'),
    },
    async (args) => {
      try {
        const target = await loadTarget(reader, writer, args.targetType, args.targetName, args.layoutName);
        if (isToolError(target)) return target;
        const current = target.effectTypes.map(e => e.name);
        const same = current.length === args.names.length
          && new Set(args.names).size === args.names.length
          && args.names.every(n => current.includes(n));
        if (!same) {
          return toolError(`names must list every effect on ${target.describe} exactly once. Current order: ${current.join(', ') || '(none)'}.`);
        }
        const byName = new Map(target.effectTypes.map(e => [e.name, e]));
        target.effectTypes.splice(0, target.effectTypes.length, ...args.names.map(n => byName.get(n)!));
        const backupPath = await target.save();
        const result: WriteResult = { success: true, entity: args.targetName, category: args.targetType, action: 'updated', backupFile: backupPath };
        return toolResult(result);
      } catch (error) {
        console.error('[reorder_effects] failed:', error);
        return toolError(`Error reordering effects: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
