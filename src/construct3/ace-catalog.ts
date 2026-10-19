/**
 * Condition and action (ACE) validation against a catalogue of the
 * definitions Construct ships for one release. The catalogue is always an
 * argument: this module holds none.
 *
 * Built-in plugins and behaviors are checked against the catalogue, and a
 * third-party addon against its own definitions when the registry given
 * holds them. An ACE of an addon with no definitions, or of an object this
 * project does not declare, is skipped rather than reported, because nothing
 * can know it.
 */

import type { Construct3ProjectReader } from './project-reader.js';
import { UNKNOWN_PARAM_TYPE, releaseFromSaved, releaseLabel, releaseNumber } from './ace-catalog-source.js';
import { nameKey } from './names.js';
import { unscannedFilesOf } from './analyzers/unscanned-uses.js';
import { LEGACY_BEHAVIOR_TYPE_KEY, isBehaviorName } from './analyzers/legacy-behavior-keys.js';
import type { AceCatalog, AceParam, AceSet, AddonLookup, ProjectData } from './ace-types.js';

export type { AceCatalog, AceParam, AceSet, AddonLookup, ExpressionDef, ProjectData } from './ace-types.js';

export type AceKind = 'conditions' | 'actions';

export type AceProblemCode = 'unknown-ace' | 'unknown-parameter' | 'missing-parameter' | 'invalid-choice';

export interface AceProblem {
  code: AceProblemCode;
  message: string;
}

/** Where an ACE is defined: a plugin (the System object is plugin "system") or a behavior. */
export type AceOwner = { kind: 'plugin'; id: string } | { kind: 'behavior'; id: string };

/** The value stored under an own key of a record, or undefined: ids come from project files and `constructor` or `__proto__` must not reach Object.prototype. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** True when the catalogue defines this plugin or behavior. */
export function isBuiltInAddon(kind: 'plugin' | 'behavior', id: string, catalog: AceCatalog): boolean {
  return own(kind === 'plugin' ? catalog.plugins : catalog.behaviors, id) !== undefined;
}

/** True when the ACEs of this owner can be checked: built in, or defined by the addon registry. */
export function hasAceDefinitions(owner: AceOwner, addons: AddonLookup | undefined, catalog: AceCatalog): boolean {
  return isBuiltInAddon(owner.kind, owner.id, catalog) || addons?.get(owner.kind, owner.id) !== undefined;
}

/**
 * The definition of one ACE, or undefined when the owner is known and has no
 * such ACE, or null when the owner is neither in the catalogue nor among the
 * registry's definitions.
 */
function lookup(kind: AceKind, id: string, owner: AceOwner, addons: AddonLookup | undefined, catalog: AceCatalog): AceParam[] | undefined | null {
  const set: AceSet | undefined = own(owner.kind === 'plugin' ? catalog.plugins : catalog.behaviors, owner.id)
    ?? addons?.get(owner.kind, owner.id)?.aces;
  if (!set) return null;
  const found = own(set[kind], id);
  if (found) return found;
  // Common ACEs belong to plugin objects, never to System or to behaviors.
  // The catalogue records no applicability for them (its common set is added
  // "by capability"), so one is accepted on every non-System plugin object.
  if (owner.kind === 'plugin' && owner.id !== 'system') return own(catalog.common[kind], id);
  return undefined;
}

function ownerLabel(owner: AceOwner): string {
  if (owner.kind === 'plugin' && owner.id === 'system') return 'the System object';
  return `the ${owner.id} ${owner.kind}`;
}

/**
 * Check one condition or action against the catalogue: its ID, and, when its
 * parameters are stored as a keyed object, their names and combo choices.
 * Parameters whose definition could not be read (type `unknown`) are not
 * checked, and while the owner has one the names are not either.
 */
export function checkAce(
  kind: AceKind,
  ace: { id: string; parameters?: unknown },
  owner: AceOwner,
  addons: AddonLookup | undefined,
  catalog: AceCatalog,
): AceProblem[] {
  const params = lookup(kind, ace.id, owner, addons, catalog);
  if (params === null) return [];
  const noun = kind === 'conditions' ? 'condition' : 'action';
  if (params === undefined) {
    return [{
      code: 'unknown-ace',
      message: `Construct ${releaseLabel(catalog.release)} defines no ${noun} "${ace.id}" for ${ownerLabel(owner)}.`,
    }];
  }

  const known = params.filter(p => p.type !== UNKNOWN_PARAM_TYPE);
  const allKnown = known.length === params.length;
  const problems: AceProblem[] = [];
  const given = ace.parameters;
  if (given === undefined || given === null) {
    if (known.length > 0) {
      problems.push({
        code: 'missing-parameter',
        message: `The ${noun} "${ace.id}" of ${ownerLabel(owner)} takes parameter(s) ${known.map(p => `"${p.id}"`).join(', ')}, and none are given.`,
      });
    }
    return problems;
  }
  if (typeof given !== 'object' || Array.isArray(given)) return problems;

  const values = given as Record<string, unknown>;
  const byId = new Set(known.map(p => p.id));
  const unknown = allKnown ? Object.keys(values).filter(k => !byId.has(k)) : [];
  if (unknown.length > 0) {
    problems.push({
      code: 'unknown-parameter',
      message: `The ${noun} "${ace.id}" of ${ownerLabel(owner)} has no parameter(s) ${unknown.map(k => `"${k}"`).join(', ')}. Its parameters are ${known.map(p => `"${p.id}"`).join(', ') || '(none)'}.`,
    });
  }
  const missing = known.filter(p => !Object.hasOwn(values, p.id));
  if (missing.length > 0) {
    problems.push({
      code: 'missing-parameter',
      message: `The ${noun} "${ace.id}" of ${ownerLabel(owner)} is missing parameter(s) ${missing.map(p => `"${p.id}"`).join(', ')}.`,
    });
  }
  for (const p of known) {
    if (!p.items || !Object.hasOwn(values, p.id)) continue;
    const value = values[p.id];
    if (typeof value !== 'string' || !p.items.includes(value)) {
      problems.push({
        code: 'invalid-choice',
        message: `Parameter "${p.id}" of the ${noun} "${ace.id}" is ${JSON.stringify(value)}; ${ownerLabel(owner)} accepts ${p.items.map(i => `"${i}"`).join(', ')}.`,
      });
    }
  }
  return problems;
}

/** What resolving an event's objectClass and behaviorType needs from the project. */
export interface AceContext {
  /** The plugin ID behind an object type or family name, or undefined when the project has neither. */
  pluginOf(objectClass: string): string | undefined;
  /**
   * The behavior ID behind a behavior name on an object type or family,
   * looking at the families an object belongs to and the members of a family.
   * Behavior names are compared ignoring case, as the editor does.
   */
  behaviorOf(objectClass: string, behaviorName: string): string | undefined;
}

interface Declared {
  pluginId?: string;
  /** Behavior IDs by the declared behavior name's `nameKey`. */
  behaviors: Map<string, string>;
  members: string[];
}

function declared(raw: Record<string, unknown>): Declared {
  const behaviors = new Map<string, string>();
  for (const b of Array.isArray(raw.behaviorTypes) ? raw.behaviorTypes as Array<Record<string, unknown>> : []) {
    if (b && typeof b.name === 'string' && typeof b.behaviorId === 'string') behaviors.set(nameKey(b.name), b.behaviorId);
  }
  return {
    pluginId: typeof raw['plugin-id'] === 'string' ? raw['plugin-id'] : undefined,
    behaviors,
    members: Array.isArray(raw.members) ? (raw.members as unknown[]).filter((m): m is string => typeof m === 'string') : [],
  };
}

/**
 * Read the objects, families and (unless `sheets` is false) event sheets of a
 * project. Each bulk read is followed at once by its failures, because a
 * reload by a concurrent call clears them; a file that could not be parsed is
 * listed as `<category>/<name>`.
 */
export async function readProjectData(
  reader: Pick<Construct3ProjectReader,
    'listObjectTypes' | 'listFamilies' | 'listEventSheets'
    | 'readAllObjectTypes' | 'readAllFamilies' | 'readAllEventSheets' | 'getReadFailures'>,
  options: { sheets?: boolean } = {},
): Promise<ProjectData> {
  const objects = await reader.readAllObjectTypes();
  const objectFailures = unscannedFilesOf('objectTypes', await reader.listObjectTypes(), objects, reader.getReadFailures('objectTypes'));
  const families = await reader.readAllFamilies();
  const familyFailures = unscannedFilesOf('families', await reader.listFamilies(), families, reader.getReadFailures('families'));
  let sheets: ProjectData['sheets'] = new Map();
  let sheetFailures: Array<{ file: string }> = [];
  if (options.sheets !== false) {
    sheets = await reader.readAllEventSheets();
    sheetFailures = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, reader.getReadFailures('eventSheets'));
  }
  return {
    objects,
    families,
    sheets,
    unreadable: {
      objectTypes: objectFailures.map(f => f.file),
      families: familyFailures.map(f => f.file),
      eventSheets: sheetFailures.map(f => f.file),
    },
  };
}

/**
 * Build the objectClass and behavior resolution from the maps of a project.
 * It reads nothing. `unreadable` lists the object types and families that
 * could not be parsed (their ACEs are skipped); `complete` is false then.
 */
export function buildAceContext(data: ProjectData): AceContext & { complete: boolean; unreadable: string[] } {
  const types = new Map<string, Declared>();
  for (const [name, type] of data.objects) types.set(name, declared(type as unknown as Record<string, unknown>));
  const families = new Map<string, Declared>();
  for (const [name, family] of data.families) families.set(name, declared(family));
  const unreadable = [...data.unreadable.objectTypes, ...data.unreadable.families];
  return { ...fromDeclarations(types, families), complete: unreadable.length === 0, unreadable };
}

function fromDeclarations(types: Map<string, Declared>, families: Map<string, Declared>): AceContext {
  return {
    pluginOf(objectClass) {
      if (objectClass === 'System') return 'system';
      return (types.get(objectClass) ?? families.get(objectClass))?.pluginId;
    },
    behaviorOf(objectClass, behaviorName) {
      const key = nameKey(behaviorName);
      const candidates: Array<Declared | undefined> = [types.get(objectClass) ?? families.get(objectClass)];
      if (types.has(objectClass)) {
        for (const family of families.values()) if (family.members.includes(objectClass)) candidates.push(family);
      }
      const family = families.get(objectClass);
      if (family) for (const member of family.members) candidates.push(types.get(member));
      for (const c of candidates) {
        const id = c?.behaviors.get(key);
        if (id) return id;
      }
      return undefined;
    },
  };
}

/** The owner of an ACE as stored in an event, or undefined when it cannot be resolved. */
export function aceOwner(ace: { objectClass?: unknown; behaviorType?: unknown }, context: AceContext): AceOwner | undefined {
  if (typeof ace.objectClass !== 'string') return undefined;
  if (typeof ace.behaviorType === 'string') {
    const id = context.behaviorOf(ace.objectClass, ace.behaviorType);
    return id ? { kind: 'behavior', id } : undefined;
  }
  const plugin = context.pluginOf(ace.objectClass);
  return plugin ? { kind: 'plugin', id: plugin } : undefined;
}

/** One problem found in an event list, located by the ACE's SID. */
export interface EventAceProblem extends AceProblem {
  kind: AceKind;
  aceId: string;
  objectClass: string;
  sid?: number;
}

/**
 * Check every standard condition and action in `events` and their sub-events.
 * Function calls, custom action calls, scripts and comments are not ACEs of
 * the catalogue and are skipped, as is an ACE that names its behavior only
 * under the legacy key (another check reports it). `only`, when given, limits
 * the check to ACEs whose SID it holds.
 */
export function checkEventAces(
  events: unknown,
  context: AceContext,
  addons: AddonLookup | undefined,
  catalog: AceCatalog,
  only?: Set<number>,
): EventAceProblem[] {
  const problems: EventAceProblem[] = [];
  const walk = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || depth > 64) return;
    for (const event of list as Array<Record<string, unknown>>) {
      if (!event || typeof event !== 'object') continue;
      for (const kind of ['conditions', 'actions'] as const) {
        const items = event[kind];
        if (!Array.isArray(items)) continue;
        for (const ace of items as Array<Record<string, unknown>>) {
          if (!ace || typeof ace.id !== 'string' || typeof ace.objectClass !== 'string') continue;
          const sid = typeof ace.sid === 'number' ? ace.sid : undefined;
          if (only && (sid === undefined || !only.has(sid))) continue;
          if (isBehaviorName(ace[LEGACY_BEHAVIOR_TYPE_KEY]) && !isBehaviorName(ace.behaviorType)) continue;
          const owner = aceOwner(ace, context);
          if (!owner) continue;
          for (const p of checkAce(kind, { id: ace.id, parameters: ace.parameters }, owner, addons, catalog)) {
            problems.push({ ...p, kind, aceId: ace.id, objectClass: ace.objectClass, sid });
          }
        }
      }
      walk(event.children, depth + 1);
    }
  };
  walk(events, 0);
  return problems;
}

/**
 * The sentence added to a finding that depends on the catalogue when the
 * project was saved with a newer release than the one whose definitions were
 * used, or '' when it was not (also when either release cannot be ordered).
 */
export function releaseHedge(catalogRelease: string, savedWithRelease?: number): string {
  if (savedWithRelease === undefined || !(savedWithRelease > releaseNumber(catalogRelease))) return '';
  const saved = releaseFromSaved(savedWithRelease);
  if (saved === undefined) return '';
  return ` The project was saved with release ${releaseLabel(saved)}, newer than ${releaseLabel(catalogRelease)} whose definitions were used, so the editor that saved it may define this.`;
}

/** A problem worded for a tool warning: which ACE, on which object, and what is wrong. */
export function describeEventAceProblem(p: EventAceProblem, catalogRelease: string, savedWithRelease?: number): string {
  const noun = p.kind === 'conditions' ? 'Condition' : 'Action';
  return `${noun} "${p.aceId}" on "${p.objectClass}"${p.sid !== undefined ? ` (SID ${p.sid})` : ''}: ${p.message}${releaseHedge(catalogRelease, savedWithRelease)}`;
}

/** The block's own conditions and actions by SID, as JSON, to tell afterwards which ones an edit touched. */
function aceSnapshot(event: Record<string, unknown>): Map<number, string> {
  const snapshot = new Map<number, string>();
  for (const kind of ['conditions', 'actions']) {
    for (const ace of Array.isArray(event[kind]) ? event[kind] as Array<Record<string, unknown>> : []) {
      if (typeof ace?.sid === 'number') snapshot.set(ace.sid, JSON.stringify(ace));
    }
  }
  return snapshot;
}

/** Every condition and action in an event tree by SID, as JSON, to tell afterwards which ones an edit touched. */
export function aceTreeSnapshot(events: unknown, into: Map<number, string> = new Map(), depth = 0): Map<number, string> {
  if (!Array.isArray(events) || depth > 64) return into;
  for (const event of events as Array<Record<string, unknown>>) {
    if (!event || typeof event !== 'object') continue;
    for (const [sid, json] of aceSnapshot(event)) into.set(sid, json);
    aceTreeSnapshot(event.children, into, depth + 1);
  }
  return into;
}

/** SIDs of the conditions and actions anywhere in `events` that are new or changed since `before`. */
export function changedAceSidsInTree(before: Map<number, string>, events: unknown): Set<number> {
  const changed = new Set<number>();
  for (const [sid, json] of aceTreeSnapshot(events)) if (before.get(sid) !== json) changed.add(sid);
  return changed;
}
