/**
 * Replace tools: replace_object_in_events, replace_in_expressions.
 *
 * replace_object_in_events is Construct's event-sheet "Replace object": every
 * reference to one object type (or family) in the events of one sheet or the
 * whole project is swapped for another of the same plugin. The references
 * are the ones the rename tools rewrite (`src/construct3/references.ts`):
 * condition/action `objectClass`, the bare object-name parameters and
 * identifier tokens in expressions. An event is swapped only when the target
 * has everything its conditions and actions use from the source: the
 * behavior (`behaviorType`), the instance variable (`instance-variable`
 * parameter, 315 sample uses), the effect (`effect` parameter holding a
 * quoted name, 15 sample uses) and every `Source.Member` expression member
 * that is a behavior or instance variable. The unit of a swap is a branch (an
 * event with its sub-events, which share its picked instances): when any event
 * in it cannot be swapped, the whole branch is left alone and reported, so no
 * branch ends up half swapped. Layouts are not touched: Replace object is an
 * event-sheet command.
 *
 * replace_in_expressions is a bulk find-and-replace over condition and action
 * parameter values (the expression text shown in the event sheet), scoped to
 * chosen sheets and parameter keys, with dryRun and per-sheet counts. Name
 * and combo parameters are protected by default, zero-length matches are
 * refused, and matching runs under a time limit.
 */

import { z } from 'zod';
import vm from 'vm';
import type { MutationToolDeps } from './shared.js';
import type { EventSheet, C3Event } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import { aceTreeSnapshot, buildAceContext, changedAceSidsInTree, checkEventAces, describeEventAceProblem } from '../construct3/ace-catalog.js';
import { buildExpressionContext, checkEventExpressions, describeEventExpressionProblem } from '../construct3/expression-check.js';
import {
  collectObjectNameRefsInSheet,
  countUnrewrittenObjectMentions,
  countByKind,
  groupByFile,
  isExpressionIdentifier,
  OBJECT_NAME_PARAM_KEYS,
  type RefSite,
} from '../construct3/references.js';

type Reader = MutationToolDeps['reader'];
type Json = Record<string, unknown>;

const MAX_DEPTH = 60;

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

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(entry => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/**
 * What an object type or family offers to events. An object type also
 * exposes the behaviors, instance variables and effects of every family it
 * belongs to.
 */
async function readMembers(reader: Reader, name: string): Promise<ObjectMembers | null> {
  const add = (target: ObjectMembers, holder: Json) => {
    names(holder.behaviorTypes).forEach(n => target.behaviors.add(n));
    for (const b of Array.isArray(holder.behaviorTypes) ? holder.behaviorTypes as Json[] : []) {
      if (typeof b.name === 'string' && typeof b.behaviorId === 'string') target.behaviorIds.set(b.name, b.behaviorId);
    }
    names(holder.instanceVariables).forEach(n => target.variables.add(n));
    names(holder.effectTypes).forEach(n => target.effects.add(n));
  };
  if ((await reader.listObjectTypes()).includes(name)) {
    const obj = await reader.readObjectType(name) as unknown as Json;
    const animations = obj.animations as { items?: unknown } | undefined;
    const members: ObjectMembers = {
      kind: 'object',
      plugin: String(obj['plugin-id']),
      behaviors: new Set(),
      behaviorIds: new Map(),
      variables: new Set(),
      effects: new Set(),
      animations: animations ? new Set(collectAnimationNames(animations)) : null,
    };
    add(members, obj);
    for (const [, family] of await reader.readAllFamilies()) {
      if (Array.isArray(family.members) && (family.members as unknown[]).includes(name)) add(members, family);
    }
    return members;
  }
  if ((await reader.listFamilies()).includes(name)) {
    const family = await reader.readFamily(name);
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

function collectAnimationNames(container: unknown): string[] {
  const out: string[] = [];
  const walk = (folder: unknown, depth: number) => {
    if (!folder || typeof folder !== 'object' || depth > 32) return;
    const f = folder as { items?: unknown; subfolders?: unknown };
    out.push(...names(f.items));
    if (Array.isArray(f.subfolders)) f.subfolders.forEach(sub => walk(sub, depth + 1));
  };
  walk(container, 0);
  return out;
}

// ─── Expression members ────────────────────────────────────

/**
 * Member names used as `Name.Member` in expression text, outside string
 * literals, where `Name` is a whole identifier not itself preceded by `.`.
 */
export function expressionMembers(text: string, objectName: string): string[] {
  if (!text.includes(objectName)) return [];
  const isDelimiter = (ch: string) => !isExpressionIdentifier(ch);
  const out: string[] = [];
  let i = 0;
  let inString = false;
  let prev = '';
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '"') inString = false;
      prev = ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      prev = ch;
      i++;
      continue;
    }
    if (isDelimiter(ch)) {
      prev = ch;
      i++;
      continue;
    }
    let end = i;
    while (end < text.length && !isDelimiter(text[end])) end++;
    const run = text.slice(i, end);
    if (run === objectName && prev !== '.' && text[end] === '.') {
      let memberEnd = end + 1;
      while (memberEnd < text.length && !isDelimiter(text[memberEnd])) memberEnd++;
      if (memberEnd > end + 1) out.push(text.slice(end + 1, memberEnd));
    }
    prev = text[end - 1];
    i = end;
  }
  return out;
}

function parameterStrings(ace: Json): Array<{ key: string; value: string }> {
  const params = ace.parameters;
  if (Array.isArray(params)) {
    return params.flatMap((value, i) => (typeof value === 'string' ? [{ key: String(i), value }] : []));
  }
  if (!params || typeof params !== 'object') return [];
  return Object.entries(params as Json).flatMap(([key, value]) => (typeof value === 'string' ? [{ key, value }] : []));
}

function wholeLiteral(value: string): string | undefined {
  const m = /^"([^"]*)"$/.exec(value.trim());
  return m ? m[1] : undefined;
}

/** Why an event's conditions and actions cannot use `to` in place of `from`. */
function incompatibilities(
  event: Json,
  from: string,
  source: ObjectMembers,
  target: ObjectMembers,
  to: string,
  warnings: string[],
): string[] {
  const reasons: string[] = [];
  for (const key of ['conditions', 'actions'] as const) {
    const aces = event[key];
    if (!Array.isArray(aces)) continue;
    for (const raw of aces) {
      if (!raw || typeof raw !== 'object') continue;
      const ace = raw as Json;
      const label = String(ace.id ?? ace.customAction ?? ace.callFunction ?? key);
      if ((ace.objectClass === from && typeof ace.customAction === 'string') || ace.customActionObjectClass === from) {
        reasons.push(`"${label}" calls a custom action, which belongs to its object`);
        continue;
      }
      const params = parameterStrings(ace);
      if (ace.objectClass === from) {
        if (typeof ace.behaviorType === 'string' && !target.behaviors.has(ace.behaviorType)) {
          reasons.push(`"${label}" uses behavior "${ace.behaviorType}", which ${to} does not have`);
        } else if (typeof ace.behaviorType === 'string') {
          // Same name, different behavior: the ACE would address a behavior of another kind.
          const sourceId = source.behaviorIds.get(ace.behaviorType);
          const targetId = target.behaviorIds.get(ace.behaviorType);
          if (sourceId !== undefined && targetId !== undefined && sourceId !== targetId) {
            reasons.push(`"${label}" uses behavior "${ace.behaviorType}", which is a ${sourceId} behavior on ${from} but a ${targetId} behavior on ${to}`);
          }
        }
        for (const { key: paramKey, value } of params) {
          if (paramKey === 'instance-variable' && !target.variables.has(value)) {
            reasons.push(`"${label}" uses instance variable "${value}", which ${to} does not have`);
          }
          const literal = wholeLiteral(value);
          if (paramKey === 'effect' && literal !== undefined && source.effects.has(literal) && !target.effects.has(literal)) {
            reasons.push(`"${label}" uses effect "${literal}", which ${to} does not have`);
          }
          if (paramKey === 'animation' && literal !== undefined && target.animations && !target.animations.has(literal)) {
            warnings.push(`"${label}" names animation "${literal}", which ${to} does not have; it was swapped anyway.`);
          }
        }
      }
      for (const { value } of params) {
        for (const member of expressionMembers(value, from)) {
          if (source.behaviors.has(member) && !target.behaviors.has(member)) {
            reasons.push(`"${label}" reads ${from}.${member}, a behavior ${to} does not have`);
          } else if (source.variables.has(member) && !target.variables.has(member)) {
            reasons.push(`"${label}" reads ${from}.${member}, an instance variable ${to} does not have`);
          }
        }
      }
    }
  }
  return reasons;
}

interface SkippedEvent {
  file: string;
  path: string;
  eventSid?: number;
  references: number;
  reasons: string[];
}

/**
 * Scan (and optionally swap) one sheet. The unit of a swap is a branch: an
 * event that references the replaced object together with all its
 * sub-events, because sub-events inherit the parent's picked instances.
 * Swapping a parent while a sub-event keeps the old object (or the reverse)
 * would change what the sub-event picks, so when any event in the branch
 * cannot be swapped, the whole branch is left alone and reported. An event
 * that does not reference the object passes each sub-event on as its own
 * branch. Each event is handed to the shared rename scanner on its own
 * (children detached), so paths and kinds match the rename tools.
 */
function replaceInSheet(
  file: string,
  sheet: EventSheet,
  from: string,
  to: string,
  source: ObjectMembers,
  target: ObjectMembers,
  apply: boolean,
  warnings: string[],
): { sites: RefSite[]; skipped: SkippedEvent[] } {
  const sites: RefSite[] = [];
  const skipped: SkippedEvent[] = [];
  const isOwnedDefinition = (event: Json) => event.eventType === 'custom-ace-block' && event.objectClass === from;
  const scanOne = (event: Json, path: string) => {
    const single = { name: sheet.name, events: [{ ...event, children: undefined }] } as unknown as EventSheet;
    const found = collectObjectNameRefsInSheet(file, single, from, to, false)
      .map(site => ({ ...site, path: path + site.path.slice('events[0]'.length) }));
    return { single, found };
  };

  interface Branch { sites: RefSite[]; singles: EventSheet[]; reasons: string[] }
  const collectBranch = (event: Json, path: string, rootPath: string, depth: number, branch: Branch) => {
    const where = path === rootPath ? '' : `sub-event ${path}: `;
    if (isOwnedDefinition(event)) {
      branch.reasons.push(`${where}custom action definition owned by ${from}`);
      return;
    }
    const { single, found } = scanOne(event, path);
    if (found.length > 0) {
      branch.sites.push(...found);
      branch.singles.push(single);
      for (const reason of incompatibilities(event, from, source, target, to, warnings)) {
        branch.reasons.push(where + reason);
      }
    }
    if (!Array.isArray(event.children) || depth > MAX_DEPTH) return;
    event.children.forEach((child, i) => {
      if (child && typeof child === 'object') {
        collectBranch(child as Json, `${path}.children[${i}]`, rootPath, depth + 1, branch);
      }
    });
  };

  const walk = (list: unknown, prefix: string, depth: number) => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return;
    list.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const event = raw as Json;
      const path = `${prefix}[${i}]`;
      const eventSid = typeof event.sid === 'number' ? event.sid : undefined;
      if (isOwnedDefinition(event)) {
        skipped.push({
          file, path, eventSid, references: 1,
          reasons: ['custom action definition: its owner and the events inside it are not replaced'],
        });
        return;
      }
      if (scanOne(event, path).found.length === 0) {
        walk(event.children, `${path}.children`, depth + 1);
        return;
      }
      const branch: Branch = { sites: [], singles: [], reasons: [] };
      collectBranch(event, path, path, depth, branch);
      if (branch.reasons.length > 0) {
        skipped.push({ file, path, eventSid, references: branch.sites.length, reasons: [...new Set(branch.reasons)] });
        return;
      }
      sites.push(...branch.sites);
      if (apply) {
        for (const single of branch.singles) collectObjectNameRefsInSheet(file, single, from, to, true);
      }
    });
  };
  walk(sheet.events, 'events', 0);
  return { sites, skipped };
}

// ─── Expression find-and-replace ───────────────────────────

/**
 * Parameter keys whose value is a name, not an expression. Sample evidence
 * (22 r495 examples, the template and C3-ACE): `variable` (635 uses),
 * `instance-variable` (616), `object` (235), `child` (135), `object-to-create`
 * (49), `timeline` (47), `property` (55, timeline property names), `parent`
 * (20), `object-class`, `pin-to`, `target`, `function`, `file` and
 * `audio-file`, plus `instance` and `layout` from the rename scanner. Quoted
 * names such as animation or layer names are expressions and stay searchable.
 */
export const NAME_PARAMETER_KEYS = new Set([
  ...OBJECT_NAME_PARAM_KEYS,
  'variable', 'instance-variable', 'layout', 'timeline', 'property',
  'object-class', 'pin-to', 'target', 'function', 'file', 'audio-file',
]);

/**
 * Parameter keys that hold a combo choice (a fixed lower-case ID such as
 * `enabled`, `easeinsine` or `d-pad-left`) in the samples. `state` also holds
 * expressions for some addons, so a value under these keys counts as a combo
 * only when it looks like one.
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

export interface MatchOutcome {
  count: number;
  /** The pattern matched zero characters somewhere in this value. */
  empty: boolean;
  after: string;
}

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

// ─── Registration ──────────────────────────────────────────

export function registerReplaceTools({ server, reader, writer }: MutationToolDeps) {
  // ─── replace_object_in_events ─────────────────────────────

  server.tool(
    'replace_object_in_events',
    'Construct\'s "Replace object" for event sheets: swap every reference to one object type or family for another of the same plugin, in one sheet or all sheets (objectClass, object parameters, and ObjectName.Member expressions). An event is swapped only when the replacement has the behaviors, instance variables and effects it uses; other events are left unchanged and listed with the reason. Layouts are not changed.',
    {
      fromObject: z.string().max(200).describe('Object type or family to replace'),
      toObject: z.string().max(200).describe('Object type or family to use instead (same plugin)'),
      sheetName: z.string().max(200).optional().describe('Limit the swap to this event sheet; omit for the whole project'),
      dryRun: z.boolean().optional().default(false).describe('Report what would be swapped and skipped, and write nothing'),
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        const { fromObject: from, toObject: to } = args;
        if (from === to) return toolError('fromObject and toObject are the same.');
        const source = await readMembers(reader, from);
        if (!source) return notFoundError('Object or family', from, reader.findNearestName(from, 'objects'), 'list_objects');
        const target = await readMembers(reader, to);
        if (!target) return notFoundError('Object or family', to, reader.findNearestName(to, 'objects'), 'list_objects');
        if (source.plugin !== target.plugin) {
          return toolError(
            `"${from}" is a ${source.plugin} and "${to}" is a ${target.plugin}. Replace object only swaps objects of the same plugin, because their conditions, actions and expressions differ.`
          );
        }

        const sheets = await reader.listEventSheets();
        if (args.sheetName !== undefined && !sheets.includes(args.sheetName)) {
          return notFoundError('Event sheet', args.sheetName, reader.findNearestName(args.sheetName, 'eventsheets'), 'list_eventsheets');
        }
        const scope = args.sheetName !== undefined ? [args.sheetName] : sheets;
        const warnings: string[] = [];
        if (!isExpressionIdentifier(to)) {
          warnings.push(`"${to}" cannot appear in expression text (it contains a delimiter such as a space); swapped expressions will not parse.`);
        }

        const sites: RefSite[] = [];
        const skipped: SkippedEvent[] = [];
        let unrewritten = 0;
        let aceContext: Awaited<ReturnType<typeof buildAceContext>> | undefined;
        let expressionContext: Awaited<ReturnType<typeof buildExpressionContext>> | undefined;
        for (const name of scope) {
          const file = reader.getEntityRelativePath('eventSheets', name);
          let sheet: EventSheet;
          try {
            sheet = await reader.readEventSheet(name);
          } catch (e) {
            warnings.push(`Event sheet "${name}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          const acesBefore = aceTreeSnapshot(sheet.events);
          const result = replaceInSheet(file, sheet, from, to, source, target, !args.dryRun, warnings);
          sites.push(...result.sites);
          skipped.push(...result.skipped);
          unrewritten += countUnrewrittenObjectMentions(sheet, from);
          if (!args.dryRun && result.sites.length > 0) {
            // The swapped conditions and actions, against Construct's own definitions.
            aceContext ??= await buildAceContext(reader);
            expressionContext ??= await buildExpressionContext(reader);
            const changed = changedAceSidsInTree(acesBefore, sheet.events);
            for (const problem of checkEventAces(sheet.events, aceContext, changed)) {
              warnings.push(`${name}: ${describeEventAceProblem(problem)}`);
            }
            for (const problem of checkEventExpressions(sheet.events, expressionContext, aceContext, changed)) {
              warnings.push(`${name}: ${describeEventExpressionProblem(problem)}`);
            }
            const subfolder = writer.getSubfolderForEntity('eventSheets', name);
            await writer.writeEntityFile('eventSheets', name, sheet, subfolder);
            resetProjectIndex();
            filesWritten.push(file);
          }
        }
        if (unrewritten > 0) {
          warnings.push(`${unrewritten} mention(s) of "${from}" in script bodies, comments or variable initial values were not changed.`);
        }

        return toolResult({
          success: true,
          entity: to,
          category: source.kind,
          action: args.dryRun ? 'dry-run' : 'replaced',
          fromObject: from,
          toObject: to,
          sheetsScanned: scope.length,
          references: { total: sites.length, byKind: countByKind(sites), byFile: groupByFile(sites) },
          skippedEvents: skipped,
          filesWritten,
          dryRun: args.dryRun,
          warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
        });
      } catch (error) {
        console.error('[replace_object_in_events] failed:', error);
        const written = filesWritten.length > 0 ? ` Files already written: ${filesWritten.join(', ')}.` : '';
        return toolError(`Error replacing object: ${error instanceof Error ? error.message : String(error)}.${written}`);
      }
    }
  );

  // ─── replace_in_expressions ───────────────────────────────

  server.tool(
    'replace_in_expressions',
    'Find and replace text in condition and action parameter values (the expressions shown in event sheets) across the project or chosen sheets. Parameters that hold a name (variable, instance-variable, object, layout, timeline, ...) or a combo choice are left alone unless parameterKeys names them. Comments, scripts and variable declarations are not touched. Matching is limited to 2 seconds in total. Use dryRun to see every change first.',
    {
      find: z.string().min(1).max(500).describe('Text to find, or a regular expression when regex is true'),
      replace: z.string().max(2000).describe('Replacement text; with regex, $1-style group references are expanded'),
      regex: z.boolean().optional().default(false).describe('Treat find as a JavaScript regular expression'),
      caseSensitive: z.boolean().optional().default(true).describe('Match case (default true)'),
      wholeWord: z.boolean().optional().default(false).describe('Match whole words only'),
      sheets: z.array(z.string().max(200)).max(500).optional().describe('Limit to these event sheets (default: all)'),
      parameterKeys: z.array(z.string().max(200)).max(100).optional()
        .describe('Only change parameters with these keys (e.g. ["value", "expression"]); naming a name or combo key here makes it replaceable. Positional custom-action or function arguments use their index ("0", "1", ...)'),
      dryRun: z.boolean().optional().default(false).describe('Report the changes and write nothing'),
      maxReported: z.number().int().min(0).max(1000).optional().default(100).describe('Maximum individual changes listed in the result (counts are always complete)'),
    },
    async (args) => {
      const filesWritten: string[] = [];
      try {
        let pattern: RegExp;
        try {
          const sourceText = args.regex ? args.find : args.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(args.wholeWord ? `\\b(?:${sourceText})\\b` : sourceText, args.caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return toolError(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
        }
        const allSheets = await reader.listEventSheets();
        const scope = [...new Set(args.sheets ?? allSheets)];
        const missing = scope.filter(name => !allSheets.includes(name));
        if (missing.length > 0) return toolError(`Event sheet(s) not found: ${missing.join(', ')}. Use list_eventsheets to see all names.`);
        const keyFilter = args.parameterKeys ? new Set(args.parameterKeys) : null;
        // Plain text: a literal replacement, so escape String.replace's $ patterns.
        const replacement = args.regex ? args.replace : args.replace.replace(/\$/g, '$$$$');
        const warnings: string[] = [];

        // Phase 1: collect every candidate parameter without matching.
        interface Slot {
          sheet: number;
          record: Record<string, unknown>;
          key: string;
          value: string;
          path: string;
          eventSid?: number;
          protectedName: boolean;
        }
        const sheets: Array<{ name: string; data: EventSheet }> = [];
        const slots: Slot[] = [];
        for (const name of scope) {
          let data: EventSheet;
          try {
            data = await reader.readEventSheet(name);
          } catch (e) {
            warnings.push(`Event sheet "${name}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          const sheetIndex = sheets.push({ name, data }) - 1;
          const walk = (list: unknown, prefix: string, depth: number) => {
            if (!Array.isArray(list) || depth > MAX_DEPTH) return;
            list.forEach((raw, i) => {
              if (!raw || typeof raw !== 'object') return;
              const event = raw as Json;
              const path = `${prefix}[${i}]`;
              const eventSid = typeof event.sid === 'number' ? event.sid : undefined;
              for (const listKey of ['conditions', 'actions'] as const) {
                const aces = event[listKey];
                if (!Array.isArray(aces)) continue;
                aces.forEach((aceRaw, j) => {
                  if (!aceRaw || typeof aceRaw !== 'object') return;
                  const params = (aceRaw as Json).parameters;
                  if (!params || typeof params !== 'object') return;
                  const record = params as Record<string, unknown>;
                  for (const key of Object.keys(record)) {
                    const value = record[key];
                    if (typeof value !== 'string') continue;
                    if (keyFilter && !keyFilter.has(key)) continue;
                    slots.push({
                      sheet: sheetIndex, record, key, value, eventSid,
                      path: Array.isArray(params) ? `${path}.${listKey}[${j}].parameters[${key}]` : `${path}.${listKey}[${j}].parameters.${key}`,
                      protectedName: !keyFilter && !Array.isArray(params) && isProtectedParameter(key, value),
                    });
                  }
                });
              }
              walk(event.children, `${path}.children`, depth + 1);
            });
          };
          walk(data.events as unknown as C3Event[], 'events', 0);
        }

        // Phase 2: match everything under one time limit. The empty string
        // goes first so a pattern that matches nothing at all is caught too.
        let outcomes: MatchOutcome[];
        try {
          outcomes = matchAllBounded(pattern, replacement, ['', ...slots.map(slot => slot.value)]);
        } catch (e) {
          if (e instanceof RegexTimeoutError) return toolError(e.message);
          throw e;
        }
        const emptyAt = outcomes.findIndex(outcome => outcome.empty);
        if (emptyAt !== -1) {
          const where = emptyAt === 0 ? 'on empty text' : `in ${sheets[slots[emptyAt - 1].sheet].name} ${slots[emptyAt - 1].path}`;
          return toolError(
            `The search pattern matches zero characters (${where}), which would insert the replacement between characters. ` +
            'Use a pattern that always consumes at least one character.'
          );
        }

        // Phase 3: apply and report.
        const acesBefore = args.dryRun ? [] : sheets.map(sheet => aceTreeSnapshot(sheet.data.events));
        const changes: Array<{ sheet: string; eventSid?: number; path: string; key: string; before: string; after: string }> = [];
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
          if (!args.dryRun) slot.record[slot.key] = outcome.after;
        });
        if (protectedHits.size > 0) {
          const list = [...protectedHits].map(([key, count]) => `${key} (${count})`).join(', ');
          warnings.push(`Matches in parameters that hold a name or a combo choice were left unchanged: ${list}. Name those keys in parameterKeys to change them.`);
        }

        const touched = [...perSheet].sort((x, y) => x[0] - y[0]);
        if (!args.dryRun && touched.length > 0) {
          // The rewritten parameters, against Construct's own definitions (a
          // combo value changed through parameterKeys can stop being a choice).
          const aceContext = await buildAceContext(reader);
          const expressionContext = await buildExpressionContext(reader);
          for (const [index] of touched) {
            const { name, data } = sheets[index];
            const changed = changedAceSidsInTree(acesBefore[index], data.events);
            for (const problem of checkEventAces(data.events, aceContext, changed)) {
              warnings.push(`${name}: ${describeEventAceProblem(problem)}`);
            }
            // The rewritten text itself: a replacement can leave a name nothing defines.
            for (const problem of checkEventExpressions(data.events, expressionContext, aceContext, changed)) {
              warnings.push(`${name}: ${describeEventExpressionProblem(problem)}`);
            }
          }
        }
        if (!args.dryRun) {
          for (const [index] of touched) {
            const { name, data } = sheets[index];
            const subfolder = writer.getSubfolderForEntity('eventSheets', name);
            await writer.writeEntityFile('eventSheets', name, data, subfolder);
            resetProjectIndex();
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
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[replace_in_expressions] failed:', error);
        const written = filesWritten.length > 0 ? ` Files already written: ${filesWritten.join(', ')}.` : '';
        return toolError(`Error replacing text: ${error instanceof Error ? error.message : String(error)}.${written}`);
      }
    }
  );
}
