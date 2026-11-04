/**
 * Replace tools: replace_object_in_events and replace_in_expressions.
 *
 * replace_object_in_events is Construct's event-sheet "Replace object": every
 * reference to one object type (or family) in the events of one sheet or the
 * whole project is swapped for another of the same plugin. The references
 * are the ones the rename tools rewrite (`src/construct3/object-name-references.ts`):
 * condition/action `objectClass`, the object-valued parameters, the object of
 * an instance variable parameter and `ObjectName.Member` in expressions. An
 * event is swapped only when the target has everything its conditions and
 * actions use from the source: the behavior (`behaviorType`), the instance
 * variable (`instance-variable` parameter), the effect (`effect` parameter
 * holding a quoted name) and every `Source.Member` expression member that is
 * a behavior or instance variable. The unit of a swap is a branch (an event
 * with its sub-events, which share its picked instances): when any event in
 * it cannot be swapped, the whole branch is left alone and reported, so no
 * branch ends up half swapped. Layouts are not touched: Replace object is an
 * event-sheet command.
 *
 * All changed sheets are decided in memory first and written together; a
 * failed write puts the earlier sheets back. Sheets that could not be parsed
 * are never changed; they are listed, with what a text search of them found.
 *
 * replace_in_expressions finds and replaces text in the parameter values of
 * conditions and actions (the expressions shown in event sheets), with the
 * same all-or-nothing writes.
 */

import vm from 'vm';
import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { EventSheet } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { findNameClash, nameKey } from '../construct3/names.js';
import { walkEventStrings, type EventStringSite } from '../construct3/event-strings.js';
import { classifyReadError } from '../construct3/project-reader.js';
import {
  OBJECT_REWRITE_POLICY,
  OTHER_NAME_PARAMETER_KEYS,
  objectNameUsesInSheet,
  projectVariableNames,
  type ObjectNameUse,
} from '../construct3/object-name-references.js';
import { NON_OBJECT_PARAMETER_KEYS, OBJECT_PARAMETER_KEYS, expressionMemberChains, type ExpressionMemberChain } from '../construct3/analyzers/index-builder.js';
import { everyAnimation } from '../construct3/animation-rename.js';
import {
  checkUnscannedFiles,
  describeReadFailure,
  describeUnscannedFile,
  unscannedFields,
  unscannedFilesOf,
  type UnscannedFile,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { reasonOf } from './rename-files.js';
import { nothingChanged } from './event-helpers.js';
import { unregisteredNameMessage } from './registered-names.js';
import { withProjectSync } from './project-sync.js';

type Reader = MutationToolDeps['reader'];
type Json = Record<string, unknown>;

/** How deep the swap looks into sub-events; a branch or a reference below it is refused or listed, never left out silently. */
export const MAX_EVENT_DEPTH = 60;

/**
 * The parameter keys that never hold an object name, for the finder: the
 * reference index's keys for sounds, instance variables, event variables
 * and layouts, and the keys for timelines, properties, functions and files.
 * A value equal to an object's name under one of them is another kind of
 * name and is left alone, whatever else shares the name.
 */
const SWAP_NON_OBJECT_KEYS: ReadonlySet<string> = new Set([...NON_OBJECT_PARAMETER_KEYS, ...OTHER_NAME_PARAMETER_KEYS]);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Member accesses on the object in expression text outside string literals
 * (`Name.member`, `Name(i).member`, `Name.Behavior.Expression`), the name
 * compared as the editor does (letter case ignored). With `selfIsObject`,
 * `Self.member` counts as an access on the object too: in a condition or
 * action on that object, `Self` is that object.
 */
export function expressionMemberChainsOf(text: string, objectName: string, selfIsObject = false): ExpressionMemberChain[] {
  const key = nameKey(objectName);
  return expressionMemberChains(text).filter(chain => nameKey(chain.object) === key || (selfIsObject && chain.object.toLowerCase() === 'self'));
}

/** The member names of `expressionMemberChainsOf`. */
export function expressionMembers(text: string, objectName: string, selfIsObject = false): string[] {
  return expressionMemberChainsOf(text, objectName, selfIsObject).map(chain => chain.member);
}

// ─── Object members ────────────────────────────────────────

interface ObjectMembers {
  kind: 'object' | 'family';
  plugin: string;
  behaviors: Set<string>;
  /** Behavior name to behavior ID, for telling same-named behaviors of different types apart. */
  behaviorIds: Map<string, string>;
  variables: Set<string>;
  effects: Set<string>;
  animations: Set<string> | null;
}

/** The names of the entries of a list of named entries. */
function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(entry => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/**
 * What an object type or family offers to events. An object type also
 * exposes the behaviors, instance variables and effects of every family it
 * belongs to. `name` is a registered name. A file that cannot be parsed
 * gives `{ problem }` for the caller to refuse with.
 */
async function readMembers(reader: Reader, name: string): Promise<ObjectMembers | { problem: string } | null> {
  const add = (target: ObjectMembers, holder: Json) => {
    namesOf(holder.behaviorTypes).forEach(n => target.behaviors.add(n));
    for (const b of Array.isArray(holder.behaviorTypes) ? holder.behaviorTypes as Json[] : []) {
      if (typeof b.name === 'string' && typeof b.behaviorId === 'string') target.behaviorIds.set(b.name, b.behaviorId);
    }
    namesOf(holder.instanceVariables).forEach(n => target.variables.add(n));
    namesOf(holder.effectTypes).forEach(n => target.effects.add(n));
  };
  if ((await reader.listObjectTypes()).includes(name)) {
    let obj: Json;
    try {
      obj = await reader.readObjectType(name) as unknown as Json;
    } catch (error) {
      return { problem: `Cannot read object type "${name}" (${describeReadFailure(classifyReadError(error))}).` };
    }
    const animations = obj.animations as { items?: unknown } | undefined;
    const members: ObjectMembers = {
      kind: 'object',
      plugin: String(obj['plugin-id']),
      behaviors: new Set(),
      behaviorIds: new Map(),
      variables: new Set(),
      effects: new Set(),
      animations: animations
        ? new Set(everyAnimation<{ name?: unknown }>(animations).flatMap(a => (typeof a.name === 'string' ? [a.name] : [])))
        : null,
    };
    add(members, obj);
    for (const [, family] of await reader.readAllFamilies()) {
      if (Array.isArray(family.members) && (family.members as unknown[]).includes(name)) add(members, family);
    }
    return members;
  }
  if ((await reader.listFamilies()).includes(name)) {
    let family: Json;
    try {
      family = await reader.readFamily(name);
    } catch (error) {
      return { problem: `Cannot read family "${name}" (${describeReadFailure(classifyReadError(error))}).` };
    }
    const members: ObjectMembers = {
      kind: 'family',
      plugin: String(family['plugin-id']),
      behaviors: new Set(),
      behaviorIds: new Map(),
      variables: new Set(),
      effects: new Set(),
      animations: null,
    };
    add(members, family);
    return members;
  }
  return null;
}

/** The string values of a condition's or action's parameters, with their keys (positions for custom action arguments). */
function parameterStrings(ace: Json): Array<{ key: string; value: string }> {
  const params = ace.parameters;
  if (Array.isArray(params)) {
    return params.flatMap((value, i) => (typeof value === 'string' ? [{ key: String(i), value }] : []));
  }
  if (!params || typeof params !== 'object') return [];
  return Object.entries(params as Json).flatMap(([key, value]) => (typeof value === 'string' ? [{ key, value }] : []));
}

/** The text of a value that is one quoted string, or undefined. */
function wholeLiteral(value: string): string | undefined {
  const m = /^"([^"]*)"$/.exec(value.trim());
  return m ? m[1] : undefined;
}

/**
 * The instance variable an `instance-variable` parameter names: a name
 * (owned by the condition's or action's own object), or `{ name,
 * objectClass }` of the object it belongs to. `objectClass` is undefined
 * for the string form and for a record without one.
 */
function instanceVariableParameter(ace: Json): { name: string; objectClass?: string } | undefined {
  const value = isRecord(ace.parameters) ? ace.parameters['instance-variable'] : undefined;
  if (typeof value === 'string') return { name: value };
  if (isRecord(value) && typeof value.name === 'string') {
    return { name: value.name, ...(typeof value.objectClass === 'string' ? { objectClass: value.objectClass } : {}) };
  }
  return undefined;
}

interface ReplaceContext {
  from: string;
  to: string;
  source: ObjectMembers;
  target: ObjectMembers;
  variableNames: ReadonlySet<string>;
}

/** Why an event's conditions and actions cannot use `to` in place of `from` (names of behaviors, instance variables and effects are compared exactly). */
function incompatibilities(event: Json, ctx: ReplaceContext, warnings: string[]): string[] {
  const { from, to, source, target } = ctx;
  const fromKey = nameKey(from);
  const isFrom = (value: unknown): boolean => typeof value === 'string' && nameKey(value) === fromKey;
  const reasons: string[] = [];
  for (const key of ['conditions', 'actions'] as const) {
    const aces = event[key];
    if (!Array.isArray(aces)) continue;
    for (const raw of aces) {
      if (!isRecord(raw)) continue;
      const label = String(raw.id ?? raw.customAction ?? raw.callFunction ?? key);
      const onFrom = isFrom(raw.objectClass);
      if ((onFrom && typeof raw.customAction === 'string') || isFrom(raw.customActionObjectClass)) {
        reasons.push(`"${label}" calls a custom action; whether ${to} has it is not checked`);
        continue;
      }
      const params = parameterStrings(raw);
      /**
       * Why behavior `name`, used by this condition, action or expression
       * member, cannot be served by `to`: it has none of that name, or the
       * name is another kind of behavior there (compared by behavior id,
       * for conditions, actions and expression members alike).
       */
      const behaviorProblem = (name: string): string | undefined => {
        if (!target.behaviors.has(name)) return `${to} does not have it`;
        const sourceId = source.behaviorIds.get(name);
        const targetId = target.behaviorIds.get(name);
        if (sourceId !== undefined && targetId !== undefined && sourceId !== targetId) {
          return `it is a ${sourceId} behavior on ${from} but a ${targetId} behavior on ${to}`;
        }
        return undefined;
      };
      if (onFrom) {
        if (typeof raw.behaviorType === 'string') {
          const problem = behaviorProblem(raw.behaviorType);
          if (problem !== undefined) reasons.push(`"${label}" uses behavior "${raw.behaviorType}": ${problem}`);
        }
        for (const { key: paramKey, value } of params) {
          const literal = wholeLiteral(value);
          if (paramKey === 'effect' && literal !== undefined && source.effects.has(literal) && !target.effects.has(literal)) {
            reasons.push(`"${label}" uses effect "${literal}", which ${to} does not have`);
          }
          if (paramKey === 'animation' && literal !== undefined && target.animations && !target.animations.has(literal)) {
            warnings.push(`"${label}" names animation "${literal}", which ${to} does not have; it was swapped anyway.`);
          }
        }
      }
      // The variable's owner is the record's own objectClass when it has one (a record naming another object is not about `from`,
      // as the finder leaves it); the string form and a record without an owner belong to the condition's or action's object
      const variable = instanceVariableParameter(raw);
      if (variable !== undefined && (variable.objectClass !== undefined ? isFrom(variable.objectClass) : onFrom) && !target.variables.has(variable.name)) {
        reasons.push(`"${label}" uses instance variable "${variable.name}", which ${to} does not have`);
      }
      for (const { value } of params) {
        // `Self.x` in a condition or action on `from` is `from` (Self in any other is another object)
        for (const chain of expressionMemberChainsOf(value, from, onFrom)) {
          const member = chain.member;
          const shown = `${isFrom(chain.object) ? from : 'Self'}.${member}`;
          if (source.behaviors.has(member)) {
            const problem = behaviorProblem(member);
            if (problem !== undefined) reasons.push(`"${label}" reads ${shown}, a behavior: ${problem}`);
          } else if (source.variables.has(member) && !target.variables.has(member)) {
            reasons.push(`"${label}" reads ${shown}, an instance variable ${to} does not have`);
          }
        }
      }
    }
  }
  return reasons;
}

/** An event (with its sub-events) left unchanged, and why. */
interface SkippedEvent {
  file: string;
  path: string;
  eventSid?: number;
  /** How many definite uses of the replaced object it holds */
  references: number;
  reasons: string[];
}

/** The result of scanning one sheet: the swapped uses, the events left whole, and the uses that no swap changes. */
interface SheetScan {
  swapped: ObjectNameUse[];
  skipped: SkippedEvent[];
  notChanged: ObjectNameUse[];
}

/**
 * Scan (and with `apply`, swap in memory) one sheet. The unit of a swap is a
 * branch: an event that references the replaced object with all its
 * sub-events, because sub-events inherit the parent's picked instances; when
 * any event of the branch cannot be swapped the whole branch is left alone
 * and reported. Each event is handed to the finder on its own (children
 * detached, its conditions and actions shared with the sheet), so a rewrite
 * reaches the sheet and the paths match the finder's.
 */
function replaceInSheet(file: string, sheet: EventSheet, ctx: ReplaceContext, apply: boolean, warnings: string[]): SheetScan {
  const { from, to, variableNames } = ctx;
  const swapped: ObjectNameUse[] = [];
  const skipped: SkippedEvent[] = [];
  const isOwnedDefinition = (event: Json) => event.eventType === 'custom-ace-block' && typeof event.objectClass === 'string' && nameKey(event.objectClass) === nameKey(from);
  const scanOne = (event: Json, path: string, rewrite: boolean) => {
    const single = { ...sheet, events: [{ ...event, children: undefined }] } as unknown as EventSheet;
    return objectNameUsesInSheet(single, file, from, variableNames, OBJECT_REWRITE_POLICY, rewrite ? to : undefined, SWAP_NON_OBJECT_KEYS)
      .filter(use => use.definite)
      .map(use => ({ ...use, eventPath: path + (use.eventPath ?? '').slice('events[0]'.length) }));
  };
  // Definite uses in an event and all its sub-events (a definition left whole is counted with what is inside it)
  const usesInBranch = (event: Json) => objectNameUsesInSheet({ ...sheet, events: [event] } as unknown as EventSheet, file, from, variableNames, OBJECT_REWRITE_POLICY, undefined, SWAP_NON_OBJECT_KEYS)
    .filter(use => use.definite).length;
  interface Branch { uses: ObjectNameUse[]; events: Array<{ event: Json; path: string }>; reasons: string[]; warnings: string[] }
  const collectBranch = (event: Json, path: string, rootPath: string, depth: number, branch: Branch) => {
    const where = path === rootPath ? '' : `sub-event ${path}: `;
    if (isOwnedDefinition(event)) {
      branch.reasons.push(`${where}custom action definition owned by ${from}`);
      return;
    }
    const found = scanOne(event, path, false);
    if (found.length > 0) {
      branch.uses.push(...found);
      branch.events.push({ event, path });
      for (const reason of incompatibilities(event, ctx, branch.warnings)) branch.reasons.push(where + reason);
    }
    if (!Array.isArray(event.children) || event.children.length === 0) return;
    if (depth >= MAX_EVENT_DEPTH) {
      // Not descended into: the events below might use something `to` lacks, so the branch is refused whole
      branch.reasons.push(`${where}nested deeper than ${MAX_EVENT_DEPTH} levels; the events below it were not checked`);
      return;
    }
    event.children.forEach((child, i) => {
      if (isRecord(child)) collectBranch(child, `${path}.children[${i}]`, rootPath, depth + 1, branch);
    });
  };
  const walk = (list: unknown, prefix: string, depth: number) => {
    if (!Array.isArray(list)) return;
    if (depth > MAX_EVENT_DEPTH) {
      // Events this deep are not walked; any that use the object are listed, not left out
      const events = list.filter(isRecord);
      const references = usesInBranch({ eventType: 'group', children: events } as Json);
      if (references > 0) skipped.push({ file, path: prefix, references, reasons: [`nested deeper than ${MAX_EVENT_DEPTH} levels; the events below it were not checked`] });
      return;
    }
    list.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const event = raw;
      const path = `${prefix}[${i}]`;
      const eventSid = typeof event.sid === 'number' ? event.sid : undefined;
      if (isOwnedDefinition(event)) {
        skipped.push({ file, path, eventSid, references: usesInBranch(event), reasons: ['custom action definition: its owner and the events inside it are not replaced'] });
        return;
      }
      if (scanOne(event, path, false).length === 0) {
        walk(event.children, `${path}.children`, depth + 1);
        return;
      }
      const branch: Branch = { uses: [], events: [], reasons: [], warnings: [] };
      collectBranch(event, path, path, depth, branch);
      if (branch.reasons.length > 0) {
        // Warnings about a swap ("swapped anyway") are dropped with the branch, which is not swapped
        skipped.push({ file, path, eventSid, references: usesInBranch(event), reasons: [...new Set(branch.reasons)] });
        return;
      }
      warnings.push(...branch.warnings);
      swapped.push(...branch.uses);
      if (apply) for (const member of branch.events) scanOne(member.event, member.path, true);
    });
  };
  walk(sheet.events, 'events', 0);
  // Uses that no swap changes (scripts, string literals, variable values, possible expressions), anywhere in the sheet
  const notChanged = objectNameUsesInSheet(sheet, file, from, variableNames, OBJECT_REWRITE_POLICY, undefined, SWAP_NON_OBJECT_KEYS).filter(use => !use.definite);
  return { swapped, skipped, notChanged };
}

/** Uses counted by kind. */
function countKinds(uses: readonly ObjectNameUse[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const use of uses) counts[use.kind] = (counts[use.kind] ?? 0) + 1;
  return counts;
}

/** Uses grouped by the file they are in, with their kinds. */
function groupByFile(uses: readonly ObjectNameUse[]): Array<{ file: string; count: number; kinds: Record<string, number> }> {
  const files = new Map<string, ObjectNameUse[]>();
  for (const use of uses) files.set(use.file, [...(files.get(use.file) ?? []), use]);
  return [...files].map(([file, list]) => ({ file, count: list.length, kinds: countKinds(list) }));
}

/** Warnings for the sheets that could not be parsed: what the text search found, and that they were not changed. */
function unparsedSheetWarnings(reports: readonly UnscannedFileReport[]): string[] {
  return reports.map(report => {
    const file = describeUnscannedFile(report);
    if (report.textSearch === 'possible-use') return `${file} could not be parsed; its text names ${(report.names ?? []).map(n => `"${n}"`).join(', ')}. It was not changed.`;
    if (report.textSearch === 'unreadable') return `${file} could not be searched either. It was not changed.`;
    if (report.textSearch === 'not-searched') return `${file} could not be parsed and was not searched. It was not changed.`;
    return `${file} could not be parsed and was only searched as text; no mention was found. It was not changed.`;
  });
}

/**
 * `text` without absolute paths: the project folder (in either slash style) and any other drive or
 * rooted path in it are replaced, so an unexpected error never shows where the project is on disk.
 */
function withoutPaths(projectDir: string, text: string): string {
  let shown = text;
  for (const variant of new Set([projectDir, projectDir.replace(/\\/g, '/'), projectDir.replace(/\//g, '\\')])) {
    if (variant.length > 0) shown = shown.split(variant).join('<project>');
  }
  return shown
    .replace(/[A-Za-z]:[\\/][^\s"'`]*/g, '<path>')
    .replace(/(?<![\w.\-:<])\/(?:[\w.\-]+\/)+[\w.\-]*/g, '<path>');
}

// ─── Expression find-and-replace ───────────────────────────

/**
 * Parameter keys whose value is a name, not an expression: the reference
 * index's object and non-object name keys, and the keys of other kinds of
 * name that the index does not look at.
 */
export const NAME_PARAMETER_KEYS = new Set([
  ...OBJECT_PARAMETER_KEYS, ...NON_OBJECT_PARAMETER_KEYS, ...OTHER_NAME_PARAMETER_KEYS,
  'parent', 'instance', 'object-class', 'target',
]);

/**
 * Parameter keys that hold a combo choice (a fixed lower-case ID such as
 * `enabled`, `easeinsine` or `d-pad-left`) in editor-saved projects. `state`
 * also holds expressions for some addons, so a value under these keys counts
 * as a combo only when it looks like one.
 */
export const COMBO_PARAMETER_KEYS = new Set([
  'which', 'ease', 'destroy-on-complete', 'loop', 'ping-pong', 'from', 'type',
  'mode', 'button', 'visibility', 'control', 'deltatimetype', 'pauseresume',
  'where', 'collisions', 'axis', 'axes', 'mouse-button', 'action', 'match',
  'width-type', 'height-type', 'input', 'click-type', 'order', 'state',
]);

const COMBO_VALUE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** True when a parameter holds a name or a combo choice rather than an expression. */
export function isProtectedParameter(key: string, value: string): boolean {
  if (NAME_PARAMETER_KEYS.has(key)) return true;
  return COMBO_PARAMETER_KEYS.has(key) && COMBO_VALUE.test(value);
}

/**
 * Total time one find-and-replace may spend matching. A user regular
 * expression can backtrack catastrophically, so all matching runs in one `vm`
 * script with this timeout; V8 enforces it inside regex execution too, and a
 * bad pattern fails the call instead of hanging the server.
 */
export const REGEX_TIME_LIMIT_MS = 2000;

const MATCH_SCRIPT = [
  'const re = new RegExp(input.source, input.flags);',
  'const out = [];',
  'for (const value of input.values) {',
  '  let count = 0;',
  '  let empty = false;',
  '  for (const m of value.matchAll(re)) {',
  '    count++;',
  "    if (m[0] === '') { empty = true; break; }",
  '  }',
  '  out.push([count, empty, count > 0 && !empty ? value.replace(re, input.replacement) : value]);',
  '}',
  'out;',
].join('\n');

/** What matching one value gave. */
export interface MatchOutcome {
  count: number;
  /** The pattern matched zero characters somewhere in this value. */
  empty: boolean;
  after: string;
}

/** The pattern did not finish within the time limit. */
export class RegexTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The search pattern took longer than ${timeoutMs} ms to run (probably catastrophic backtracking). Simplify the pattern or narrow the sheets.`);
    this.name = 'RegexTimeoutError';
  }
}

/** Match and replace every value within `timeoutMs`; throws RegexTimeoutError past it. */
export function matchAllBounded(
  pattern: RegExp,
  replacement: string,
  values: string[],
  timeoutMs = REGEX_TIME_LIMIT_MS,
): MatchOutcome[] {
  const input = { source: pattern.source, flags: pattern.flags, replacement, values };
  let raw: Array<[number, boolean, string]>;
  try {
    raw = vm.runInNewContext(MATCH_SCRIPT, { input }, { timeout: timeoutMs }) as Array<[number, boolean, string]>;
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new RegexTimeoutError(timeoutMs);
    }
    throw e;
  }
  const out: MatchOutcome[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push({ count: Number(raw[i][0]), empty: raw[i][1] === true, after: String(raw[i][2]) });
  }
  return out;
}

/** The path of a parameter as `changes` reports it: "events[0].actions[1].parameters.value" or "...parameters[0]". */
function parameterPath(site: EventStringSite, key: string, named: boolean): string {
  const m = /^(condition|action) (\d+)$/.exec(site.ace);
  const list = m ? `${m[1]}s[${m[2]}]` : site.ace;
  return `${site.eventPath}.${list}.parameters${named ? `.${key}` : `[${key}]`}`;
}

/**
 * Compare two slots by their place in the sheet: an event's conditions,
 * then its actions, then its sub-events, each in index order (the
 * numbers of the path, with conditions below actions below children). A
 * positional parameter compares by its index as a number; parameters of one
 * condition or action that remain tied compare by path text.
 */
function documentOrder(a: { path: string }, b: { path: string }): number {
  const offset: Record<string, number> = { events: 0, conditions: 0, actions: 1e6, children: 2e6, parameters: 0 };
  const key = (slot: { path: string }) => [...slot.path.matchAll(/(events|children|conditions|actions|parameters)\[(\d+)\]/g)]
    .map(m => offset[m[1]] + Number(m[2]));
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  if (ka.length !== kb.length) return ka.length - kb.length;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** A condition or action parameter value that may be replaced. */
interface ParameterSlot {
  /** Index into the scanned sheets */
  sheet: number;
  set(value: string): void;
  key: string;
  value: string;
  path: string;
  eventSid?: number;
  /** The value holds a name or a combo choice, which is left alone unless parameterKeys names it */
  protectedName: boolean;
}

/** One change as the result lists it. */
interface ReportedChange {
  sheet: string;
  eventSid?: number;
  path: string;
  key: string;
  before: string;
  after: string;
}

/** Register the replace tools. */
export function registerReplaceTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  // ─── replace_object_in_events ─────────────────────────────

  server.tool(
    'replace_object_in_events',
    'Swap every reference to one object type or family for another of the same plugin in the event sheets, in one sheet or all of them '
      + '(objectClass, object parameters, the object-valued instance variable parameter, and ObjectName.Member expressions). '
      + 'An event is swapped only when the replacement has the behaviors, instance variables and effects it uses; a sub-event goes with its parent, '
      + 'and other events are left unchanged and listed with the reason. Layouts are not changed. '
      + 'Both names must be given as registered, in that letter case. All changed sheets are written together, and a failed write is rolled back; '
      + 'sheets that could not be parsed are listed and not changed, and a global variable declared in one of them is not known to the swap.',
    {
      fromObject: z.string().max(200).describe('Object type or family to replace (as registered, in that letter case)'),
      toObject: z.string().max(200).describe('Object type or family to use instead (same plugin; as registered)'),
      sheetName: z.string().max(200).optional().describe('Limit the swap to this event sheet; omit for the whole project'),
      dryRun: z.boolean().optional().default(false).describe('Report what would be swapped and skipped, and write nothing'),
    },
    async (args) => {
      const refuse = (message: string) => toolError(nothingChanged(message));
      try {
        const { fromObject: from, toObject: to } = args;
        const names = [...await reader.listObjectTypes(), ...await reader.listFamilies()];
        for (const name of [from, to]) {
          const missing = unregisteredNameMessage('Object or family', name, names, () => reader.findNearestName(name, 'objects'), 'list_objects');
          if (missing !== undefined) return refuse(missing);
        }
        if (nameKey(from) === nameKey(to)) return refuse('fromObject and toObject are the same.');
        // A family the reader could not parse may give `from` or `to` members the check cannot see
        const families = await reader.readAllFamilies();
        const brokenFamilies = unscannedFilesOf('families', await reader.listFamilies(), families, reader.getReadFailures('families'));
        if (brokenFamilies.length > 0) {
          return refuse(`Cannot read ${brokenFamilies.map(f => `family "${f.name}" (${f.reason})`).join(', ')}; `
            + 'what it gives its members is unknown, so whether an event can be swapped cannot be decided.');
        }
        const source = (await readMembers(reader, from))!;
        if ('problem' in source) return refuse(source.problem);
        const target = (await readMembers(reader, to))!;
        if ('problem' in target) return refuse(target.problem);
        if (source.plugin !== target.plugin) {
          return refuse(`"${from}" is a ${source.plugin} and "${to}" is a ${target.plugin}. Replace object only swaps objects of the same plugin, because their conditions, actions and expressions differ.`);
        }
        const registered = await reader.listEventSheets();
        if (args.sheetName !== undefined) {
          const missing = unregisteredNameMessage('Event sheet', args.sheetName, registered, () => reader.findNearestName(args.sheetName!, 'eventsheets'), 'list_eventsheets');
          if (missing !== undefined) return refuse(missing);
        }
        // The project's variable names decide whether a whole-value parameter is a variable or the object; read-only
        const all = await reader.readAllEventSheets();
        const unparsed = unscannedFilesOf('eventSheets', registered, all, reader.getReadFailures('eventSheets'));
        const ctx: ReplaceContext = { from, to, source, target, variableNames: projectVariableNames(all) };
        const warnings: string[] = [];
        if (!/^[\p{L}\p{N}_]+$/u.test(to)) warnings.push(`"${to}" cannot appear in expression text (it contains a delimiter such as a space); swapped expressions will not parse.`);

        // Everything is decided and changed in memory first; nothing is written until all sheets are done
        const scope = args.sheetName !== undefined ? [args.sheetName] : registered.filter(n => !unparsed.some(f => f.name === n));
        const changed: Array<{ name: string; sheet: EventSheet; file: string }> = [];
        const swapped: ObjectNameUse[] = [];
        const skipped: SkippedEvent[] = [];
        const notChanged: ObjectNameUse[] = [];
        for (const name of scope) {
          let sheet: EventSheet;
          try {
            sheet = await reader.readEventSheet(name);
          } catch (error) {
            return refuse(`Cannot read event sheet "${name}" (${describeReadFailure(classifyReadError(error))}).`);
          }
          const file = reader.getEntityRelativePath('eventSheets', name);
          const scan = replaceInSheet(file, sheet, ctx, !args.dryRun, warnings);
          swapped.push(...scan.swapped);
          skipped.push(...scan.skipped);
          notChanged.push(...scan.notChanged);
          if (scan.swapped.length > 0) changed.push({ name, sheet, file });
        }
        // Sheets that could not be parsed are outside a call limited to one sheet
        const outOfScope = args.sheetName === undefined ? unparsed : [];
        const reports = await checkUnscannedFiles(reader, outOfScope, [{ categories: ['eventSheets'], allOf: [[nameTerm(from)]] }]);
        warnings.push(...unparsedSheetWarnings(reports));
        if (notChanged.length > 0) {
          warnings.push(`${notChanged.length} mention(s) of "${from}" were listed and not changed (${Object.entries(countKinds(notChanged)).map(([k, n]) => `${k}: ${n}`).join(', ')}).`);
        }

        const filesWritten: string[] = [];
        if (!args.dryRun) {
          for (const { name, sheet, file } of changed) {
            try {
              await writeEntityOrRollBack(writer, 'eventSheets', name, sheet);
            } catch (error) {
              return toolError(error instanceof Error ? error.message : String(error));
            }
            filesWritten.push(file);
          }
        }
        return toolResult({
          success: true, entity: to, category: source.kind, action: args.dryRun ? 'dry-run' : 'replaced',
          fromObject: from, toObject: to, sheetsScanned: scope.length,
          references: { total: swapped.length, byKind: countKinds(swapped), byFile: groupByFile(swapped) },
          skippedEvents: skipped,
          notChanged: { total: notChanged.length, byKind: countKinds(notChanged) },
          filesWritten, dryRun: args.dryRun,
          ...(outOfScope.length > 0 ? { complete: false } : {}),
          warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
          ...unscannedFields(reports),
        }, { projectWritten: filesWritten.length > 0 });
      } catch (error) {
        console.error('[replace_object_in_events] failed:', error);
        // Everything before the first write is in this try, and the writes return from their own catch: nothing was changed
        return refuse(`Error replacing object: ${withoutPaths(reader.getProjectDir(), reasonOf(error, file => writer.projectRelative(file)))}`);
      }
    }
  );

  // ─── replace_in_expressions ───────────────────────────────

  server.tool(
    'replace_in_expressions',
    'Find and replace text in condition and action parameter values (the expressions shown in event sheets) across the project or chosen sheets. '
      + 'Parameters that hold a name (variable, instance-variable, object, layout, timeline, ...) or a combo choice are left alone unless parameterKeys names them. '
      + 'Comments, scripts and variable declarations are not touched. Matching is limited to 2 seconds in total. '
      + 'Sheets that could not be parsed are listed in unscannedFiles (with complete: false), were not changed, and are only searched as text for a plain name. '
      + 'Use dryRun to see every change first.',
    {
      find: z.string().min(1).max(500).describe('Text to find, or a regular expression when regex is true'),
      replace: z.string().max(2000).describe('Replacement text; with regex, $1-style group references are expanded'),
      regex: z.boolean().optional().default(false).describe('Treat find as a JavaScript regular expression'),
      caseSensitive: z.boolean().optional().default(true).describe('Match case (default true)'),
      wholeWord: z.boolean().optional().default(false).describe('Match whole words only'),
      sheets: z.array(z.string().max(200)).max(500).optional().describe('Limit to these event sheets (as registered, in that letter case; default: all)'),
      parameterKeys: z.array(z.string().max(200)).max(100).optional()
        .describe('Only change parameters with these keys (e.g. ["value", "expression"]); naming a name or combo key here makes it replaceable. Positional custom-action or function arguments use their index ("0", "1", ...)'),
      dryRun: z.boolean().optional().default(false).describe('Report the changes and write nothing'),
      maxReported: z.number().int().min(0).max(1000).optional().default(100).describe('Maximum individual changes listed in the result (counts are always complete)'),
    },
    async (args) => {
      const refuse = (message: string) => toolError(nothingChanged(message));
      try {
        let pattern: RegExp;
        try {
          const sourceText = args.regex ? args.find : args.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(args.wholeWord ? `\\b(?:${sourceText})\\b` : sourceText, args.caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return refuse(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
        }
        const registered = await reader.listEventSheets();
        const requested = args.sheets === undefined ? undefined : [...new Set(args.sheets)];
        const missing = (requested ?? []).filter(name => !registered.includes(name));
        if (missing.length > 0) {
          const shown = missing.map(name => {
            const variant = findNameClash(name, registered);
            return variant === undefined ? name : `${name} (Did you mean "${variant}"?)`;
          });
          return refuse(`Event sheet(s) not found: ${shown.join(', ')}. Use list_eventsheets to see all names.`);
        }
        // Sheets that cannot be parsed are outside a call that names its sheets
        let unparsed: UnscannedFile[] = [];
        if (requested === undefined) {
          const all = await reader.readAllEventSheets();
          unparsed = unscannedFilesOf('eventSheets', registered, all, reader.getReadFailures('eventSheets'));
        }
        const scope = requested ?? registered.filter(name => !unparsed.some(f => f.name === name));
        const keyFilter = args.parameterKeys ? new Set(args.parameterKeys) : null;
        // Plain text: a literal replacement, so escape String.replace's $ patterns.
        const replacement = args.regex ? args.replace : args.replace.replace(/\$/g, '$$$$');
        const warnings: string[] = [];

        // Phase 1: collect every candidate parameter without matching, in each sheet's order.
        const sheets: Array<{ name: string; data: EventSheet }> = [];
        const slots: ParameterSlot[] = [];
        for (const name of scope) {
          let data: EventSheet;
          try {
            data = await reader.readEventSheet(name);
          } catch (error) {
            return refuse(`Cannot read event sheet "${name}" (${describeReadFailure(classifyReadError(error))}).`);
          }
          const sheetIndex = sheets.push({ name, data }) - 1;
          const found: ParameterSlot[] = [];
          const sids = new Map<string, number>();
          walkEventStrings(data, {
            event(event, eventPath) { if (typeof event.sid === 'number') sids.set(eventPath, event.sid); },
            parameter(site, parameter) {
              if (keyFilter && !keyFilter.has(parameter.key)) return;
              found.push({
                sheet: sheetIndex, set: parameter.set, key: parameter.key, value: parameter.value, eventSid: sids.get(site.eventPath),
                path: parameterPath(site, parameter.key, parameter.named),
                protectedName: !keyFilter && parameter.named && isProtectedParameter(parameter.key, parameter.value),
              });
            },
          });
          slots.push(...found.sort(documentOrder));
        }

        // Phase 2: match everything under one time limit. The empty string
        // goes first so a pattern that matches nothing at all is caught too.
        let outcomes: MatchOutcome[];
        try {
          outcomes = matchAllBounded(pattern, replacement, ['', ...slots.map(slot => slot.value)]);
        } catch (e) {
          if (e instanceof RegexTimeoutError) return refuse(e.message);
          throw e;
        }
        const emptyAt = outcomes.findIndex(outcome => outcome.empty);
        if (emptyAt !== -1) {
          const where = emptyAt === 0 ? 'on empty text' : `in ${sheets[slots[emptyAt - 1].sheet].name} ${slots[emptyAt - 1].path}`;
          return refuse(
            `The search pattern matches zero characters (${where}), which would insert the replacement between characters. `
            + 'Use a pattern that always consumes at least one character.'
          );
        }

        // Phase 3: apply in memory and report.
        const changes: ReportedChange[] = [];
        const perSheet = new Map<number, { sheet: string; parameters: number; matches: number }>();
        const protectedHits = new Map<string, number>();
        let totalMatches = 0;
        let totalParameters = 0;
        slots.forEach((slot, n) => {
          const outcome = outcomes[n + 1];
          if (outcome.count === 0 || outcome.after === slot.value) return;
          if (slot.protectedName) {
            protectedHits.set(slot.key, (protectedHits.get(slot.key) ?? 0) + 1);
            return;
          }
          const name = sheets[slot.sheet].name;
          let entry = perSheet.get(slot.sheet);
          if (!entry) {
            entry = { sheet: name, parameters: 0, matches: 0 };
            perSheet.set(slot.sheet, entry);
          }
          entry.parameters++;
          entry.matches += outcome.count;
          totalParameters++;
          totalMatches += outcome.count;
          if (changes.length < args.maxReported) {
            changes.push({ sheet: name, eventSid: slot.eventSid, path: slot.path, key: slot.key, before: slot.value, after: outcome.after });
          }
          // These are this call's own copies of the sheets; a dry run never writes them
          slot.set(outcome.after);
        });
        if (protectedHits.size > 0) {
          const list = [...protectedHits].map(([key, count]) => `${key} (${count})`).join(', ');
          warnings.push(`Matches in parameters that hold a name or a combo choice were left unchanged: ${list}. Name those keys in parameterKeys to change them.`);
        }

        // Sheets that could not be parsed: a plain name is searched for as text; with no name to search for they are listed as not searched
        const searchable = !args.regex && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(args.find);
        const reports: UnscannedFileReport[] = searchable
          ? await checkUnscannedFiles(reader, unparsed, [{ categories: ['eventSheets'], allOf: [[nameTerm(args.find)]] }])
          // No unchecked: nothing is refused for them; they are listed, warned about and never changed
          : unparsed.map(({ file, reason }) => ({ file, reason, textSearch: 'not-searched' as const }));
        warnings.push(...unparsedSheetWarnings(reports));

        const touched = [...perSheet].sort((x, y) => x[0] - y[0]);
        const filesWritten: string[] = [];
        if (!args.dryRun) {
          for (const [index] of touched) {
            const { name, data } = sheets[index];
            try {
              await writeEntityOrRollBack(writer, 'eventSheets', name, data);
            } catch (error) {
              return toolError(error instanceof Error ? error.message : String(error));
            }
            filesWritten.push(reader.getEntityRelativePath('eventSheets', name));
          }
        }

        return toolResult({
          success: true,
          action: args.dryRun ? 'dry-run' : 'replaced',
          find: args.find,
          replace: args.replace,
          sheetsScanned: sheets.length,
          totalMatches,
          parametersChanged: totalParameters,
          bySheet: touched.map(([, entry]) => entry),
          changes,
          changesTruncated: totalParameters > changes.length,
          filesWritten,
          dryRun: args.dryRun,
          ...(reports.length > 0 ? { complete: false } : {}),
          warnings: warnings.length > 0 ? warnings : undefined,
          ...unscannedFields(reports),
        }, { projectWritten: filesWritten.length > 0 });
      } catch (error) {
        console.error('[replace_in_expressions] failed:', error);
        // Everything before the first write is in this try, and the writes return from their own catch: nothing was changed
        return refuse(`Error replacing text: ${withoutPaths(reader.getProjectDir(), reasonOf(error, file => writer.projectRelative(file)))}`);
      }
    }
  );
}
