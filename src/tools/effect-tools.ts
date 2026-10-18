/**
 * Effect tools (#ISSUE): list_effects, add_effect, update_effect,
 * remove_effect and reorder_effects. An effect lives in the effectTypes of
 * its holder: an object type, a family, a layout or a layer. The entry of an
 * object type's or family's effect is { effectId, name }, and every placed
 * instance of the object type (or of each member of the family) holds its
 * state in its `effects`, keyed by the effect's name. A layout's or layer's
 * entry is { effectId, name, instance: { isEnabled, parameters } }. Shapes
 * checked on an r495.2 editor-saved project (object type, family and layer
 * entries) and in Construct 3 r506-2 (a layout entry).
 *
 * The layouts that the instance entries change are written first (through
 * syncLayoutInstances) and the holder's file last, so a call stopped between
 * them leaves the holder as it was and running it again finishes the work; a
 * failed write is rolled back (rollBackFailedCall). A layer or layout is the
 * holder and its layout the only write.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Layout } from '../construct3/types.js';
import type { UnscannedFileReport } from '../construct3/analyzers/unscanned-uses.js';
import { validateName, toolResult, toolError, notFoundError, boundedRecord } from './shared.js';
import { nameKey } from '../construct3/names.js';
import { findInstanceByUid, layerPathLabel } from '../construct3/layers.js';
import {
  blocksWithoutForce,
  checkUnscannedFiles,
  mergeUnscannedReports,
  unscannedFields,
  unscannedFilesOf,
  unscannedRefusal,
  unscannedWarnings,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import { expectedInstanceBehaviors, readFamiliesForInstances } from '../construct3/instance-behaviors.js';
import { effectNamesOf, expectedInstanceEffects } from '../construct3/instance-variables.js';
import {
  effectUseLocation,
  effectUsesNaming,
  familyEffectUsesThroughMembers,
  findEffectUses,
  type EffectUse,
} from '../construct3/analyzers/effect-uses.js';
import { resolveLayer } from './layout-tools.js';
import { rollBackFailedCall, writeEntityOrRollBack } from './call-rollback.js';
import { syncLayoutInstances, type InstanceSyncPlan } from './instance-sync.js';
import { withProjectSync } from './project-sync.js';

/** The sentences every write tool's description ends with. */
const WRITE_NOTE = 'The layouts the instance entries change are written first and the holder\'s file last, and a failed write is rolled back; '
  + 'a process stopped in the middle of a call rolls nothing back, and running the call again finishes it.';

/** The sentence update_effect's description ends with: it writes one layout and never the holder's file of an object type or family. */
const ONE_FILE_NOTE = 'The change is written to one layout file (the layout of the instance, or the layout that holds the layer or layout), '
  + 'and a failed write is rolled back.';

/** What the check of remove_effect covers. */
const CHECK_NOTE = 'The check covers event sheets only, not scripts, timelines or flowcharts.';

/** At most this many uses are listed in a refusal. */
const MAX_LISTED_USES = 50;

type Parameters = Record<string, unknown>;
type EffectKind = 'object' | 'family' | 'layout' | 'layer';

/** The stack an effect belongs to: an object type, a family, a layout or one of its layers. */
interface Target {
  kind: EffectKind;
  /** The object type, family or layout name */
  entity: string;
  /** With kind "layer": the layer's path, as messages list it */
  layer?: string;
  /** The object that holds `effectTypes`: the object type's or family's file, the layout, or the layer */
  holder: Record<string, unknown>;
  /** With kind "layout" or "layer": the layout, the file written */
  layout?: Layout;
  /** For messages: 'object type "Sprite"', 'family "Enemies"', 'layout "Layout 1"' or 'layer "Main" of layout "Layout 1"' */
  label: string;
}

const targetShape = {
  objectName: z.string().max(200).optional().describe('Object type that holds the effect, as registered, letter case included (give exactly one of objectName, familyName and layoutName)'),
  familyName: z.string().max(200).optional().describe('Family that holds the effect, as registered, letter case included'),
  layoutName: z.string().max(200).optional().describe('Layout that holds the effect, or whose layer does (with layerName)'),
  layerName: z.string().max(200).optional()
    .describe('With layoutName: the layer that holds the effect, by its name or, for a sub-layer, its path ("Main > HUD")'),
};

type TargetArgs = { objectName?: string; familyName?: string; layoutName?: string; layerName?: string };

/** `message` as a refusal, ending with "Nothing was changed." */
function refusal(message: string): ReturnType<typeof toolError> {
  return toolError(`${message}${message.endsWith('.') ? '' : '.'} Nothing was changed.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const quoted = (names: readonly string[]) => names.map(n => `"${n}"`).join(', ');

/** The first few items and how many more there are. */
function listSome(items: string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * The layer as update_layer finds it (resolveLayer): by its name, or a
 * sub-layer by its path.
 */
function findLayer(layout: Layout, layerName: string, layoutName: string) {
  return resolveLayer(layout, layerName, layoutName);
}

/** The entries of a holder's effectTypes (records only). */
function effectEntries(holder: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(holder.effectTypes) ? holder.effectTypes.filter(isRecord) : [];
}

/**
 * The refusal for a holder whose effectTypes this server cannot edit without
 * dropping an entry or writing the wrong ones: effectTypes that is not a list,
 * or an entry that is not a record with a string name. A hand edit, since the
 * editor does not save such a file. Undefined when the stack is sound.
 */
function unsoundStack(target: Target): ReturnType<typeof toolError> | undefined {
  const stack = target.holder.effectTypes;
  if (stack === undefined) return undefined;
  if (!Array.isArray(stack)) {
    return refusal(`The effectTypes of the ${target.label} is not a list, so this tool does not edit its effects: fix or remove it in the Construct 3 editor first`);
  }
  const at = stack.findIndex(e => !isRecord(e) || typeof e.name !== 'string');
  if (at === -1) return undefined;
  return refusal(`Entry ${at} of the effects of the ${target.label} is not a record with a name, so this tool does not edit its effects `
    + '(it would drop an entry or write the wrong ones): rename or remove it in the Construct 3 editor first');
}

/** A holder's effect names, in order. */
function effectNames(holder: Record<string, unknown>): string[] {
  return effectNamesOf(holder);
}

/** A state after a change: the entry's current state with `isEnabled` set and `parameters` merged key by key. */
function mergedState(
  current: unknown, change: { isEnabled?: boolean; parameters?: Parameters },
): { next: Record<string, unknown>; changed: boolean } {
  const base = isRecord(current) ? current : {};
  const next = {
    ...base,
    isEnabled: change.isEnabled ?? (typeof base.isEnabled === 'boolean' ? base.isEnabled : true),
    parameters: { ...(isRecord(base.parameters) ? base.parameters : {}), ...(change.parameters ?? {}) },
  };
  return { next, changed: !isRecord(current) || JSON.stringify(next) !== JSON.stringify(current) };
}

/** Where uses are, for messages: '"Sheet1" events[3] action 0 on "Sprite"'. */
function describeUses(uses: readonly EffectUse[]): string {
  return listSome([...new Set(uses.map(use => `${effectUseLocation(use)} on "${use.objectClass}"`))]);
}

/** Effect uses as listed in a refusal. */
function useList(uses: readonly EffectUse[]): Array<Record<string, unknown>> {
  return uses.slice(0, MAX_LISTED_USES).map(use => ({
    eventSheet: use.eventSheet, eventPath: use.eventPath, ace: use.ace, ...(use.sid !== undefined ? { sid: use.sid } : {}),
    objectClass: use.objectClass, effect: use.name,
  }));
}

/** Not found, with the hint for a name that differs only in letter case (names must be the registered ones). */
function notFound(kind: 'Object' | 'Family', name: string, registered: string[], suggestions: string[], listTool: string) {
  const sameIgnoringCase = registered.find(n => n.toLowerCase() === name.toLowerCase());
  if (sameIgnoringCase !== undefined) {
    return toolError(`${kind} "${name}" not found: names are matched with their letter case. Did you mean "${sameIgnoringCase}"?`);
  }
  return notFoundError(kind, name, suggestions, listTool);
}

/** Register list_effects, add_effect, update_effect, remove_effect and reorder_effects. */
export function registerEffectTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  /** The target the arguments name, or the refusal. */
  async function resolveTarget(args: TargetArgs): Promise<{ target: Target } | { refusal: ReturnType<typeof toolError> }> {
    const given = [args.objectName, args.familyName, args.layoutName].filter(v => v !== undefined).length;
    if (given !== 1) return { refusal: refusal('Give exactly one of objectName, familyName and layoutName.') };
    if (args.layerName !== undefined && args.layoutName === undefined) {
      return { refusal: refusal('layerName needs layoutName: it names a layer of that layout.') };
    }
    if (args.layoutName !== undefined) {
      if (!(await reader.listLayouts()).includes(args.layoutName)) {
        return { refusal: notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts') };
      }
      let layout: Layout;
      try {
        layout = await reader.readLayout(args.layoutName);
      } catch (error) {
        return { refusal: refusal(`Layout "${args.layoutName}" could not be read: ${error instanceof Error ? error.message : String(error)}`) };
      }
      if (args.layerName === undefined) {
        return { target: { kind: 'layout', entity: args.layoutName, holder: layout, layout, label: `layout "${args.layoutName}"` } };
      }
      const resolved = findLayer(layout, args.layerName, args.layoutName);
      if ('error' in resolved) return { refusal: refusal(resolved.error) };
      const path = layerPathLabel(resolved.entry);
      return {
        target: {
          kind: 'layer', entity: args.layoutName, layer: path, holder: resolved.entry.layer as unknown as Record<string, unknown>,
          layout, label: `layer "${path}" of layout "${args.layoutName}"`,
        },
      };
    }
    const isFamily = args.familyName !== undefined;
    const name = (isFamily ? args.familyName : args.objectName)!;
    const registered = isFamily ? await reader.listFamilies() : await reader.listObjectTypes();
    if (!registered.includes(name)) {
      return {
        refusal: isFamily
          ? notFound('Family', name, registered, [], 'list_families')
          : notFound('Object', name, registered, reader.findNearestName(name, 'objects'), 'list_objects'),
      };
    }
    try {
      const holder = isFamily ? await reader.readFamily(name) : await reader.readObjectType(name) as unknown as Record<string, unknown>;
      return { target: { kind: isFamily ? 'family' : 'object', entity: name, holder, label: `${isFamily ? 'family' : 'object type'} "${name}"` } };
    } catch (error) {
      return { refusal: refusal(`${isFamily ? 'Family' : 'Object type'} "${name}" could not be read: ${error instanceof Error ? error.message : String(error)}`) };
    }
  }

  /** Whether the target's effects have instance entries: an object type's or a family's. */
  const hasInstances = (target: Target) => target.kind === 'object' || target.kind === 'family';

  /** The object types whose placed instances hold entries for the target's effects. */
  async function instanceHolders(target: Target): Promise<string[]> {
    if (target.kind === 'object') return [target.entity];
    if (target.kind !== 'family') return [];
    const objectTypes = await reader.listObjectTypes();
    const members = Array.isArray(target.holder.members) ? target.holder.members : [];
    return [...new Set(members.filter((m): m is string => typeof m === 'string' && objectTypes.includes(m)))];
  }

  /** An object type's file, or undefined when it cannot be read. */
  async function readObject(name: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await reader.readObjectType(name) as unknown as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /** Families as they are after the change: the target family (already changed) in place of its file. */
  async function familiesAfter(target: Target): Promise<ReadonlyMap<string, unknown>> {
    const families = new Map(await readFamiliesForInstances(reader));
    if (target.kind === 'family') families.set(target.entity, target.holder);
    return families;
  }

  /**
   * Write the change: the layouts the instances change first, the holder's
   * file last; a failure rolls back what the call wrote. `extra` gives each
   * object type's plan its effect-specific fields from the effects its
   * instances hold entries for after the change.
   */
  async function writeChange(
    target: Target, extra: (effects: string[]) => Partial<InstanceSyncPlan>,
  ): Promise<{ backupFile: string; warnings: string[]; unscanned: UnscannedFileReport[] }> {
    const warnings: string[] = [];
    let unscanned: UnscannedFileReport[] = [];
    try {
      const holders = await instanceHolders(target);
      if (holders.length > 0) {
        const families = await familiesAfter(target);
        const plans = new Map<string, InstanceSyncPlan>();
        for (const holder of holders) {
          const object = target.kind === 'object' ? target.holder : await readObject(holder);
          if (object === undefined) {
            warnings.push(`Instances of "${holder}" were NOT updated: its object type file could not be read, so their effect entries were left as they were.`);
            continue;
          }
          const effects = expectedInstanceEffects(holder, object, families);
          plans.set(holder, { expected: expectedInstanceBehaviors(holder, object, families), effects, ...extra(effects) });
        }
        const sync = await syncLayoutInstances(reader, writer, plans);
        warnings.push(...sync.warnings);
        unscanned = sync.unscanned;
      }
      let backupFile: string;
      if (target.layout !== undefined) {
        backupFile = await writer.writeEntityFile('layouts', target.entity, target.layout, writer.getSubfolderForEntity('layouts', target.entity));
      } else {
        const category = target.kind === 'object' ? 'objectTypes' : 'families';
        backupFile = await writer.writeEntityFile(category, target.entity, target.holder, writer.getSubfolderForEntity(category, target.entity));
      }
      return { backupFile, warnings, unscanned };
    } catch (error) {
      throw new Error(await rollBackFailedCall(writer, error));
    }
  }

  /** The fields every result carries. */
  const common = (target: Target) => ({
    success: true as const, entity: target.entity, category: target.kind,
    ...(target.layer !== undefined ? { layer: target.layer } : {}),
  });

  /** An effect of the holder by its exact name, or the refusal. */
  function findEntry(target: Target, name: string): { entry: Record<string, unknown> } | { refusal: ReturnType<typeof toolError> } {
    const entries = effectEntries(target.holder);
    const entry = entries.find(e => e.name === name);
    if (entry) return { entry };
    const names = effectNames(target.holder);
    const other = names.find(n => nameKey(n) === nameKey(name));
    return {
      refusal: refusal(`The ${target.label} has no effect "${name}" (names are matched with their letter case${other ? `; did you mean "${other}"?` : ''}). `
        + `Its effects: ${quoted(names) || '(none)'}`),
    };
  }

  // ─── list_effects ─────────────────────────────────────────

  server.tool(
    'list_effects',
    'List the effects of an object type, a family, a layout or one of its layers, in order, as saved (an object type\'s or family\'s '
      + 'effect: effectId and name; a layout\'s or layer\'s: also its instance state, isEnabled and parameters), and the effect addons '
      + 'registered in the project (the effect ids add_effect accepts).',
    targetShape,
    async (args) => {
      try {
        const resolved = await resolveTarget(args);
        if ('refusal' in resolved) return resolved.refusal;
        const { target } = resolved;
        return toolResult({
          target: target.kind === 'layer'
            ? { kind: 'layer', layout: target.entity, layer: target.layer }
            : { kind: target.kind, name: target.entity },
          effects: effectEntries(target.holder),
          registeredEffectAddons: reader.getUsedAddons().filter(a => a.type === 'effect'),
        });
      } catch (error) {
        console.error('[list_effects] failed:', error);
        return toolError(`Error listing effects: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_effect ───────────────────────────────────────────

  server.tool(
    'add_effect',
    'Add an effect to an object type, a family, a layout or one of its layers. effectId must be an effect addon registered in the project '
      + '(list_effects shows them; register_addon registers one, since this tool never does: the addon\'s files must be in the project). '
      + 'name defaults to the effect id with its first letter in upper case, and must not match, ignoring case, another effect of the '
      + 'holder, of the object type\'s families, or, for a family, of any member. An object type\'s or family\'s effect gets an entry '
      + '({ isEnabled, parameters }) on every placed instance of the object type or of each member; instances placed afterwards '
      + 'get none, because add_instance_to_layout does not write effect entries. parameters is optional ({} when left out). '
      + WRITE_NOTE,
    {
      ...targetShape,
      effectId: z.string().max(200).describe('Effect addon id, as registered in usedAddons (e.g. "glowhorizontal")'),
      name: z.string().max(200).optional().describe('Effect name: letters, digits, underscores and spaces (default: the effect id with its first letter in upper case)'),
      parameters: boundedRecord().refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)').optional()
        .describe('Parameter values, as the editor saves them for this effect (default: {})'),
      isEnabled: z.boolean().optional().default(true).describe('Whether the effect starts enabled (default: true)'),
      index: z.number().int().min(0).optional().describe('Position in the stack, 0 first (default: after the last effect)'),
    },
    async (args) => {
      try {
        const resolved = await resolveTarget(args);
        if ('refusal' in resolved) return resolved.refusal;
        const { target } = resolved;
        const unsound = unsoundStack(target);
        if (unsound) return unsound;

        if (!reader.getUsedAddons().some(a => a.type === 'effect' && a.id === args.effectId)) {
          return refusal(`Effect "${args.effectId}" is not a usedAddons entry of type effect. Register the addon with register_addon (type "effect") first; `
            + 'this tool does not register addons, since the addon\'s files must be in the project');
        }
        const name = args.name ?? `${args.effectId.charAt(0).toUpperCase()}${args.effectId.slice(1)}`;
        try {
          validateName(name);
        } catch (error) {
          return refusal(`Invalid effect name: ${error instanceof Error ? error.message : String(error)}`);
        }

        // The name must not match another effect the instances key an entry by, ignoring case
        const families = await familiesAfter(target);
        const holders = await instanceHolders(target);
        // Who has it: an object type of the holders (its own, or a family's), else the holder itself
        const existing: Array<{ who: string; name: string }> = [];
        for (const holder of holders) {
          const object = target.kind === 'object' ? target.holder : await readObject(holder);
          if (object !== undefined) existing.push(...expectedInstanceEffects(holder, object, families).map(n => ({ who: `"${holder}"`, name: n })));
        }
        existing.push(...effectNames(target.holder).map(n => ({ who: `The ${target.label}`, name: n })));
        const clash = existing.find(e => nameKey(e.name) === nameKey(name));
        if (clash) {
          return refusal(`${clash.who} already has an effect "${clash.name}"${hasInstances(target) ? ' (its own or a family\'s)' : ''}, `
            + 'and this tool does not accept a name that differs only in letter case. Choose another name');
        }

        const entries = effectEntries(target.holder);
        if (args.index !== undefined && args.index > entries.length) {
          return refusal(`The index ${args.index} is past the end: the ${target.label} has ${entries.length} effect(s), so 0 to ${entries.length} are valid`);
        }

        const parameters = (args.parameters ?? {}) as Parameters;
        const entry: Record<string, unknown> = hasInstances(target)
          ? { effectId: args.effectId, name }
          : { effectId: args.effectId, name, instance: { isEnabled: args.isEnabled, parameters } };
        const stack = Array.isArray(target.holder.effectTypes) ? target.holder.effectTypes as unknown[] : [];
        stack.splice(args.index ?? stack.length, 0, entry);
        target.holder.effectTypes = stack;

        const { backupFile, warnings, unscanned } = await writeChange(target, () => ({
          addEffects: [{ name, entry: { isEnabled: args.isEnabled, parameters } }],
        }));
        return toolResult({
          ...common(target), action: 'updated', effect: name, effects: effectNames(target.holder),
          backupFile, warnings: warnings.length > 0 ? warnings : undefined, ...unscannedFields(unscanned),
        });
      } catch (error) {
        console.error('[add_effect] failed:', error);
        return toolError(`Error adding effect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_effect ────────────────────────────────────────

  server.tool(
    'update_effect',
    'Change the state of an effect: isEnabled and parameters (merged key by key into the existing ones). A layout\'s or layer\'s effect '
      + 'keeps its state in its entry. An object type\'s or family\'s effect keeps it on each placed instance, so instanceLayoutName and '
      + 'instanceUid name the instance to change (an instance of the object type or of a member that holds an entry for the effect). '
      + 'A call that changes nothing is reported as unchanged and writes nothing. ' + ONE_FILE_NOTE,
    {
      ...targetShape,
      name: z.string().max(200).describe('The effect\'s name, letter case included'),
      isEnabled: z.boolean().optional().describe('Enable or disable the effect'),
      parameters: boundedRecord().refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)').optional()
        .describe('Parameter values to set, merged key by key into the existing ones'),
      instanceLayoutName: z.string().max(200).optional().describe('Object type or family effects: the layout of the instance to change'),
      instanceUid: z.number().int().optional().describe('Object type or family effects: the UID of the instance to change'),
    },
    async (args) => {
      try {
        const resolved = await resolveTarget(args);
        if ('refusal' in resolved) return resolved.refusal;
        const { target } = resolved;
        const found = findEntry(target, args.name);
        if ('refusal' in found) return found.refusal;
        if (args.isEnabled === undefined && args.parameters === undefined) {
          return refusal('Nothing to update: give isEnabled or parameters');
        }
        const change = { isEnabled: args.isEnabled, parameters: args.parameters as Parameters | undefined };
        const names = effectNames(target.holder);

        if (!hasInstances(target)) {
          const { next, changed } = mergedState(found.entry.instance, change);
          if (!changed) return toolResult({ ...common(target), action: 'unchanged', effect: args.name, effects: names }, { projectWritten: false });
          found.entry.instance = next;
          const { backupFile } = await writeChange(target, () => ({}));
          return toolResult({ ...common(target), action: 'updated', effect: args.name, effects: names, backupFile });
        }

        if (args.instanceLayoutName === undefined || args.instanceUid === undefined) {
          return refusal(`The settings of an effect of the ${target.label} live on each placed instance: give instanceLayoutName and instanceUid for the one to change`);
        }
        if (!(await reader.listLayouts()).includes(args.instanceLayoutName)) {
          return notFoundError('Layout', args.instanceLayoutName, reader.findNearestName(args.instanceLayoutName, 'layouts'), 'list_layouts');
        }
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.instanceLayoutName);
        } catch (error) {
          return refusal(`Layout "${args.instanceLayoutName}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
        const location = findInstanceByUid(layout, args.instanceUid);
        if (!location) return refusal(`Layout "${args.instanceLayoutName}" has no instance with UID ${args.instanceUid}`);
        const instance = location.instance as unknown as Record<string, unknown>;
        const holders = await instanceHolders(target);
        if (typeof instance.type !== 'string' || !holders.includes(instance.type)) {
          return refusal(`Instance UID ${args.instanceUid} of layout "${args.instanceLayoutName}" is a "${String(instance.type)}", `
            + `not an instance of ${target.kind === 'family' ? `a member of family "${target.entity}"` : `"${target.entity}"`}`);
        }
        const state = isRecord(instance.effects) ? instance.effects[args.name] : undefined;
        if (state === undefined) {
          return refusal(`Instance UID ${args.instanceUid} of "${instance.type}" in layout "${args.instanceLayoutName}" has no entry for the effect "${args.name}". `
            + 'Instances placed after the effect was added get none, because add_instance_to_layout does not write effect entries');
        }
        const { next, changed } = mergedState(state, change);
        if (!changed) return toolResult({ ...common(target), action: 'unchanged', effect: args.name, effects: names }, { projectWritten: false });
        (instance.effects as Record<string, unknown>)[args.name] = next;
        const backupFile = await writeEntityOrRollBack(writer, 'layouts', args.instanceLayoutName, layout);
        return toolResult({
          ...common(target), action: 'updated', effect: args.name, effects: names,
          instance: { layout: args.instanceLayoutName, uid: args.instanceUid }, backupFile,
        });
      } catch (error) {
        console.error('[update_effect] failed:', error);
        return toolError(`Error updating effect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_effect ────────────────────────────────────────

  server.tool(
    'remove_effect',
    'Remove an effect from an object type, a family, a layout or one of its layers. Refused without force while events name the effect: '
      + 'actions and conditions on the object type, or on the family and its members that keep no effect of that name, and, for a layer '
      + 'or layout, System actions and conditions that name an effect of that name (which layer or layout they mean is not checked, so '
      + 'they count as possible uses). Event sheets that could not be parsed are searched as text and refuse the same way; unscannedFiles '
      + 'lists them. Uses are never changed. An object type\'s effect that one of its families also has is not checked (actions on the '
      + 'object type still reach the family\'s effect, and the instance entries are kept). An object type\'s or family\'s effect loses its entries on the placed instances, except '
      + 'where an object type or family still has an effect of that name; the removed entries are listed, and only the layouts\' .bak '
      + 'files hold them afterwards. ' + CHECK_NOTE + ' ' + WRITE_NOTE,
    {
      ...targetShape,
      name: z.string().max(200).describe('The effect\'s name, letter case included'),
      force: z.boolean().optional().default(false).describe('Remove even if events use the effect (the uses are NOT changed)'),
    },
    async (args) => {
      try {
        const resolved = await resolveTarget(args);
        if ('refusal' in resolved) return resolved.refusal;
        const { target } = resolved;
        const unsound = unsoundStack(target);
        if (unsound) return unsound;
        const found = findEntry(target, args.name);
        if ('refusal' in found) return found.refusal;

        const system = !hasInstances(target);
        const sheets = await reader.readAllEventSheets();
        const skipped = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, reader.getReadFailures('eventSheets'));
        const uses = findEffectUses(sheets, { system });

        // Uses that would be left without their effect, uses that cannot be told, and the names an unparsed sheet can use it through
        let named: EffectUse[] = [];
        let unknown: EffectUse[] = [];
        let alsoNames: string[] = [];
        const families = await familiesAfter(target);
        if (target.kind === 'object') {
          const kept = [...families.values()].some(f => isRecord(f) && Array.isArray(f.members) && f.members.includes(target.entity)
            && effectNames(f).some(n => nameKey(n) === nameKey(args.name)));
          if (!kept) {
            ({ named, unknown } = effectUsesNaming(uses, args.name, [target.entity]));
            alsoNames = [target.entity];
          }
        } else if (target.kind === 'family') {
          const own = effectUsesNaming(uses, args.name, [target.entity]);
          const after = { ...target.holder, effectTypes: effectEntries(target.holder).filter(e => e !== found.entry) };
          const afterFamilies = new Map(families);
          afterFamilies.set(target.entity, after);
          const members = await instanceHolders(target);
          const kept = new Map<string, string[]>();
          for (const member of members) kept.set(member, expectedInstanceEffects(member, await readObject(member), afterFamilies));
          const through = familyEffectUsesThroughMembers(uses, [args.name], members, kept);
          named = [...own.named, ...through.broken];
          unknown = [...own.unknown, ...through.unknown];
          alsoNames = [target.entity, ...members.filter(m => !(kept.get(m) ?? []).some(n => nameKey(n) === nameKey(args.name)))];
        } else {
          ({ named, unknown } = effectUsesNaming(uses, args.name, ['System']));
        }

        // Event sheets that could not be parsed: the effect's name together with a name an action on it can be written through
        const rule = {
          categories: ['eventSheets' as const],
          allOf: [[nameTerm(args.name)], ...(alsoNames.length > 0 ? [alsoNames.map(n => nameTerm(n))] : [])],
        };
        const unscanned = skipped.length > 0 && (system || alsoNames.length > 0) ? await checkUnscannedFiles(reader, skipped, [rule]) : [];

        const holderWord = `the ${target.label}`;
        const possibly = system ? ' (which layer or layout a System action means is not checked, so these are possible uses)' : '';
        if ((named.length > 0 || blocksWithoutForce(unscanned)) && !args.force) {
          const reasons = [
            ...(named.length > 0
              ? [`Events still use the effect "${args.name}" of ${holderWord}${possibly}: ${describeUses(named)}.`]
              : []),
            ...(blocksWithoutForce(unscanned) ? [unscannedRefusal(unscanned)] : []),
          ];
          return toolResult({
            success: false, entity: target.entity, category: target.kind, ...(target.layer !== undefined ? { layer: target.layer } : {}),
            action: 'remove_blocked',
            message: `${reasons.join(' ')} Nothing was changed. Use force=true to remove the effect anyway (the uses will NOT be changed).`,
            references: { eventSheets: [...new Set(named.map(u => u.eventSheet))], effectUses: useList(named) },
            ...unscannedFields(unscanned),
          });
        }

        const warnings: string[] = [];
        if (named.length > 0) {
          warnings.push(`Removed although events still use the effect "${args.name}" of ${holderWord}${possibly}: ${describeUses(named)}. `
            + 'The uses were NOT changed, and validate_project does not check effect names: fix them now.');
        }
        if (unknown.length > 0) {
          warnings.push(`Conditions or actions name an effect with an expression that is not a quoted name, so whether they use "${args.name}" `
            + `could not be checked: ${listSome([...new Set(unknown.map(u => `${effectUseLocation(u)} (${u.expression}) on "${u.objectClass}"`))])}. Review them.`);
        }
        warnings.push(...unscannedWarnings(unscanned, 'Removed'));

        target.holder.effectTypes = effectEntries(target.holder).filter(e => e !== found.entry);
        const written = await writeChange(target, () => ({ dropEffects: [args.name] }));
        warnings.push(...written.warnings);
        return toolResult({
          ...common(target), action: 'updated', effect: args.name, effects: effectNames(target.holder),
          backupFile: written.backupFile, warnings: warnings.length > 0 ? warnings : undefined,
          ...unscannedFields(mergeUnscannedReports(unscanned, written.unscanned)),
        });
      } catch (error) {
        console.error('[remove_effect] failed:', error);
        return toolError(`Error removing effect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── reorder_effects ──────────────────────────────────────

  server.tool(
    'reorder_effects',
    'Put the effects of an object type, a family, a layout or one of its layers in a new order: names lists every effect once, with its '
      + 'exact name. On the placed instances of an object type or family, the entries of these effects are put in the new order among '
      + 'the places they hold; the entries of other families and for other names stay where they are. An order the effects have already '
      + 'is reported as unchanged and writes nothing. ' + WRITE_NOTE,
    {
      ...targetShape,
      names: z.array(z.string().max(200)).min(1).max(100).describe('Every effect once, letter case included, in the new order'),
    },
    async (args) => {
      try {
        const resolved = await resolveTarget(args);
        if ('refusal' in resolved) return resolved.refusal;
        const { target } = resolved;
        const unsound = unsoundStack(target);
        if (unsound) return unsound;
        const entries = effectEntries(target.holder);
        const current = entries.map(e => String(e.name));
        const repeated = [...new Set(current.filter((n, i) => current.indexOf(n) !== i))];
        if (repeated.length > 0) {
          return refusal(`Effects of the ${target.label} share a name (${quoted(repeated)}): rename one in the Construct 3 editor first`);
        }
        const valid = args.names.length === current.length
          && new Set(args.names).size === args.names.length && args.names.every(n => current.includes(n));
        if (!valid) {
          return refusal(`names must list every effect of the ${target.label} exactly once, with its exact name. `
            + `Current order: ${quoted(current) || '(no effects)'}`);
        }
        if (args.names.every((n, i) => n === current[i])) {
          return toolResult({ ...common(target), action: 'unchanged', effects: current }, { projectWritten: false });
        }
        target.holder.effectTypes = args.names.map(n => entries[current.indexOf(n)]);
        const { backupFile, warnings, unscanned } = await writeChange(target, () => ({ orderEffects: args.names }));
        return toolResult({
          ...common(target), action: 'updated', effects: args.names,
          backupFile, warnings: warnings.length > 0 ? warnings : undefined, ...unscannedFields(unscanned),
        });
      } catch (error) {
        console.error('[reorder_effects] failed:', error);
        return toolError(`Error reordering effects: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
