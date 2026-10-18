/**
 * The sync of layout instances with the behaviors, instance variables and effects of their
 * object types and families, shared by the object and family tools; moved from
 * object-tools.ts.
 */

import type { Instance } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Construct3ProjectWriter } from '../construct3/project-writer.js';
import { forEachLayoutInstance } from '../construct3/layers.js';
import {
  checkUnscannedFiles,
  describeUnscannedFile,
  unscannedFilesOf,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import {
  orderInstanceBehaviors,
  syncInstanceBehaviors,
  unknownDefaultsWarning,
} from '../construct3/instance-behaviors.js';
import type { InstanceBehavior } from '../construct3/instance-behaviors.js';
import {
  addInstanceEffects,
  dropInstanceEffects,
  isDefaultInstanceVariableValue,
  orderInstanceEffects,
  renameInstanceVariableValue,
  retypeInstanceVariableValue,
  syncInstanceVariables,
  type InstanceVariableDef,
} from '../construct3/instance-variables.js';

/** A short list for messages: the first few items and how many more there are. */
function listSome(items: string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** How the layout instances of one object type change (see syncInstanceBehaviors). */
export interface InstanceSyncPlan {
  /** Behaviors the object's instances carry entries for, after the change */
  expected: InstanceBehavior[];
  /**
   * Behavior names the change added. Every expected entry an instance lacks
   * gets added; only those for other names are reported as missing before
   * the change.
   */
  add?: string[];
  /** Behavior names whose entries are removed unless still expected */
  drop?: string[];
  /**
   * Instance variables the object's instances hold values for, after the
   * change; when given, every instance gets the default value of each one it
   * lacks (see syncInstanceVariables)
   */
  variables?: InstanceVariableDef[];
  /** Instance variable names the change added; values the instance lacked for other names are reported as missing before */
  addVariables?: string[];
  /** Instance variable names whose values are removed unless still expected */
  dropVariables?: string[];
  /** Effect names whose instance entries are removed unless the object type or its families still have the effect */
  dropEffects?: string[];
  /** The effects the object's instances carry entries for, after the change (with dropEffects and addEffects) */
  effects?: string[];
  /** Effects whose entry every instance gets when it has none, in the place `effects` ranks it (add_effect) */
  addEffects?: ReadonlyArray<{ name: string; entry: { isEnabled: boolean; parameters: Record<string, unknown> } }>;
  /** The reordered owner's effect names in their new order; the instance's entries for them are put in it (reorder_effects) */
  orderEffects?: readonly string[];
  /** Instance variable values moved to a new name before the other changes, each in its place (update_instance_variable) */
  renameVariables?: ReadonlyArray<{ from: string; to: string }>;
  /** Instance variables whose type changed: a value that does not fit gets the type's default (update_instance_variable) */
  retypeVariables?: ReadonlyArray<{ name: string; type: string }>;
  /** The reordered owner's behavior names in their new order; the instance's entries for them are put in it (reorder_behaviors) */
  orderBehaviors?: readonly string[];
}

/**
 * Update all layout instances (on every layer and sub-layer, and in
 * nonworld-instances) of the object types in `plans`: make sure they have
 * the `behaviors` and `instanceVariables` dicts C3 expects, give them a
 * default entry for every expected behavior they lack, and drop the entries
 * named in the plan's `drop` that are no longer expected. The editor stores
 * an entry for every behavior of the object and its families on each
 * instance, so besides the entries for behaviors the change added (`add`),
 * entries missing before the change are added too: older versions of these
 * tools wrote instances without them, and a hand edit can leave one out.
 * Existing entries keep their values and their saved order.
 * A plan can also move values to a new name (`renameVariables`) and give
 * values that do not fit a new type the default (`retypeVariables`); values
 * other than the default that these replace are listed in the warnings (a
 * value a rename drops with the removed ones, a retyped one as replaced).
 *
 * Returns warnings naming the modified layouts, the entries that were missing
 * before the change, and any behavior that got an empty entry because its
 * defaults are not known. Layouts that could not be parsed (over the read
 * cap, not valid JSON) are not updated (issue #55): when a plan adds or drops
 * entries, their text is searched for the object types' names, and
 * `unscanned` reports them; a warning names those that possibly hold their
 * instances or could not be searched.
 */
export async function syncLayoutInstances(
  reader: Construct3ProjectReader,
  writer: Construct3ProjectWriter,
  plans: ReadonlyMap<string, InstanceSyncPlan>,
): Promise<{ warnings: string[]; unscanned: UnscannedFileReport[] }> {
  const layouts = await reader.readAllLayouts();
  const layoutFailures = reader.getReadFailures('layouts');
  const modifiedLayouts: string[] = [];
  const unknownDefaults: InstanceBehavior[] = [];
  /** Per object type: instances that lacked entries the change did not add, and those behavior names */
  const backfilled = new Map<string, { instances: number; names: Set<string> }>();
  /** The same for instance variable values */
  const backfilledValues = new Map<string, { instances: number; names: Set<string> }>();
  const noteBackfill = (map: typeof backfilled, type: string, names: string[]) => {
    if (names.length === 0) return;
    const entry = map.get(type) ?? { instances: 0, names: new Set<string>() };
    entry.instances++;
    for (const name of names) entry.names.add(name);
    map.set(type, entry);
  };
  /**
   * Instance variable values other than the default and effect entries removed
   * from instances: only the layout's .bak holds them, until the layout is written again
   */
  const removedData: string[] = [];
  /** Instance variable values other than the default that a type change replaced with the default */
  const replacedData: string[] = [];
  let removedValues = 0;
  let removedEffects = 0;

  for (const [layoutName, layout] of layouts) {
    let modified = false;
    const visit = (instance: Instance) => {
      const plan = plans.get(instance.type);
      if (!plan) return;
      modified = ensureInstanceFields(instance) || modified;
      const synced = syncInstanceBehaviors(instance, plan.expected, {
        add: plan.expected.map(b => b.name),
        drop: plan.drop,
      });
      modified = synced.modified || modified;
      unknownDefaults.push(...synced.unknownDefaults);
      noteBackfill(backfilled, instance.type, synced.added.filter(name => !(plan.add ?? []).includes(name)));
      const where = `"${layoutName}" UID ${String(instance.uid)}`;
      if (plan.orderBehaviors) modified = orderInstanceBehaviors(instance, plan.orderBehaviors) || modified;
      for (const { from, to } of plan.renameVariables ?? []) {
        const renamed = renameInstanceVariableValue(instance, from, to);
        modified = renamed.modified || modified;
        if (renamed.dropped !== undefined && !isDefaultInstanceVariableValue(renamed.dropped)) {
          removedData.push(`${where} instance variable "${to}" = ${shortJson(renamed.dropped)}`);
          removedValues++;
        }
      }
      for (const { name, type } of plan.retypeVariables ?? []) {
        const retyped = retypeInstanceVariableValue(instance, name, type);
        if (!retyped) continue;
        modified = true;
        if (!isDefaultInstanceVariableValue(retyped.replaced)) replacedData.push(`${where} instance variable "${name}" = ${shortJson(retyped.replaced)}`);
      }
      if (plan.variables) {
        const values = syncInstanceVariables(instance, plan.variables, { drop: plan.dropVariables });
        modified = values.modified || modified;
        noteBackfill(backfilledValues, instance.type, values.added.filter(name => !(plan.addVariables ?? []).includes(name)));
        for (const { name, value } of values.dropped) {
          if (isDefaultInstanceVariableValue(value)) continue;
          removedData.push(`${where} instance variable "${name}" = ${shortJson(value)}`);
          removedValues++;
        }
      }
      if (plan.dropEffects?.length) {
        const effects = dropInstanceEffects(instance, plan.dropEffects, plan.effects ?? []);
        modified = effects.length > 0 || modified;
        for (const { name, entry } of effects) removedData.push(`${where} effect "${name}" ${shortJson(entry)}`);
        removedEffects += effects.length;
      }
      if (plan.addEffects?.length) {
        modified = addInstanceEffects(instance, plan.addEffects, plan.effects ?? []).length > 0 || modified;
      }
      if (plan.orderEffects) modified = orderInstanceEffects(instance, plan.orderEffects) || modified;
    };

    forEachLayoutInstance(layout, visit);

    if (modified) {
      const subfolder = writer.getSubfolderForEntity('layouts', layoutName);
      await writer.writeEntityFile('layouts', layoutName, layout, subfolder);
      modifiedLayouts.push(layoutName);
    }
  }

  const warnings: string[] = [];
  if (modifiedLayouts.length > 0) {
    warnings.push(`Updated instances in layout(s): ${modifiedLayouts.join(', ')}`);
  }
  for (const [objectType, entry] of backfilled) {
    const expected = plans.get(objectType)?.expected ?? [];
    const names = expected.map(b => b.name).filter(name => entry.names.has(name));
    warnings.push(`Also added default entries for behavior(s) ${names.map(n => `"${n}"`).join(', ')} to ${entry.instances} instance(s) of "${objectType}" `
      + 'that had none (written by an older version of construct3-mcp or edited by hand). Construct 3 stores an entry for every behavior of the object and its families on each instance.');
  }
  for (const [objectType, entry] of backfilledValues) {
    const expected = plans.get(objectType)?.variables ?? [];
    const names = expected.map(v => v.name).filter(name => entry.names.has(name));
    warnings.push(`Also added default values for instance variable(s) ${names.map(n => `"${n}"`).join(', ')} to ${entry.instances} instance(s) of "${objectType}" `
      + 'that had none (written by an older version of construct3-mcp or edited by hand). Construct 3 stores a value for every instance variable of the object and its families on each instance.');
  }
  if (unknownDefaults.length > 0) warnings.push(unknownDefaultsWarning(unknownDefaults));
  if (removedData.length > 0) {
    const what = [
      ...(removedValues > 0 ? [`${removedValues} instance variable value(s) other than the default`] : []),
      ...(removedEffects > 0 ? [`${removedEffects} effect entr${removedEffects === 1 ? 'y' : 'ies'}`] : []),
    ];
    warnings.push(`Removed ${what.join(' and ')} from instances: ` +
      `${listSome(removedData, 10)}. Only the layouts' .bak files hold them now, until those layouts are written again; note them if they are still needed.`);
  }
  if (replacedData.length > 0) {
    warnings.push(`Replaced ${replacedData.length} instance variable value(s) that do not fit the new type with the default: `
      + `${listSome(replacedData, 10)}. Only the layouts' .bak files hold them now, until those layouts are written again; note them if they are still needed.`);
  }

  const changing = [...plans].filter(([, plan]) => planChanges(plan));
  const skipped = unscannedFilesOf('layouts', await reader.listLayouts(), layouts, layoutFailures);
  const unscanned = changing.length > 0 && skipped.length > 0
    ? await checkUnscannedFiles(reader, skipped, [{ categories: ['layouts'], allOf: [changing.map(([name]) => nameTerm(name))] }])
    : [];
  warnings.push(...unsyncedLayoutWarnings(unscanned));
  return { warnings, unscanned };
}

/** Whether a plan adds, drops, moves, retypes or reorders anything (else it only fills in missing entries). */
function planChanges(plan: InstanceSyncPlan): boolean {
  return [plan.add, plan.drop, plan.addVariables, plan.dropVariables, plan.dropEffects, plan.addEffects, plan.orderEffects,
    plan.renameVariables, plan.retypeVariables, plan.orderBehaviors]
    .some(list => (list?.length ?? 0) > 0);
}

/** A value as JSON for a message, cut to 120 characters. */
function shortJson(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}

/**
 * Warnings for the layouts syncLayoutInstances could not parse: those whose
 * text names an object type whose instances it updates (possibly instances,
 * left as they were), and those it could not search.
 */
function unsyncedLayoutWarnings(reports: readonly UnscannedFileReport[]): string[] {
  const warnings: string[] = [];
  const possible = reports.filter(r => r.textSearch === 'possible-use');
  const unreadable = reports.filter(r => r.textSearch === 'unreadable');
  if (possible.length > 0) {
    warnings.push('Instances in layouts that could not be parsed were NOT updated: ' +
      possible.map(r => `${describeUnscannedFile(r)}, whose text names ${(r.names ?? []).map(n => `"${n}"`).join(', ')}`).join('; ') +
      '. Instances there possibly still have the old behavior entries, instance variable values or effect entries (a text search cannot tell an instance from the same name ' +
      'in another string); check them in the Construct 3 editor.');
  }
  if (unreadable.length > 0) {
    warnings.push('Layouts that could not be parsed could not be searched for instances either, and were NOT updated: ' +
      `${unreadable.map(describeUnscannedFile).join(', ')}.`);
  }
  return warnings;
}

/**
 * Ensure an instance has the standard fields C3 expects.
 * Returns true if the instance was modified.
 */
function ensureInstanceFields(instance: Instance): boolean {
  let modified = false;
  const inst = instance as Record<string, unknown>;

  if (!inst.behaviors || typeof inst.behaviors !== 'object') {
    inst.behaviors = {};
    modified = true;
  }
  if (!inst.instanceVariables || typeof inst.instanceVariables !== 'object') {
    inst.instanceVariables = {};
    modified = true;
  }

  return modified;
}
