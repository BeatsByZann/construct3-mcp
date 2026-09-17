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
 * that is a behavior or instance variable. Otherwise the whole event is left
 * alone and reported, so no event ends up half swapped. Layouts are not
 * touched: Replace object is an event-sheet command.
 *
 * replace_in_expressions is a bulk find-and-replace over condition and action
 * parameter values (the expression text shown in the event sheet), scoped to
 * chosen sheets and parameter keys, with dryRun and per-sheet counts.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { EventSheet, C3Event } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { resetProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  collectObjectNameRefsInSheet,
  countUnrewrittenObjectMentions,
  countByKind,
  groupByFile,
  isExpressionIdentifier,
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
 * Scan (and optionally swap) one sheet event by event. Each event is handed
 * to the shared rename scanner on its own (children detached), so the paths
 * and kinds match the rename tools exactly.
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
  const walk = (list: unknown, prefix: string, depth: number) => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return;
    list.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const event = raw as Json;
      const path = `${prefix}[${i}]`;
      const eventSid = typeof event.sid === 'number' ? event.sid : undefined;
      if (event.eventType === 'custom-ace-block' && event.objectClass === from) {
        skipped.push({
          file, path, eventSid, references: 1,
          reasons: ['custom action definition: its owner and the events inside it are not replaced'],
        });
        return;
      }
      const single = { name: sheet.name, events: [{ ...event, children: undefined }] } as unknown as EventSheet;
      const found = collectObjectNameRefsInSheet(file, single, from, to, false);
      if (found.length > 0) {
        const reasons = incompatibilities(event, from, source, target, to, warnings);
        if (reasons.length > 0) {
          skipped.push({ file, path, eventSid, references: found.length, reasons: [...new Set(reasons)] });
        } else {
          for (const site of found) sites.push({ ...site, path: path + site.path.slice('events[0]'.length) });
          if (apply) collectObjectNameRefsInSheet(file, single, from, to, true);
        }
      }
      walk(event.children, `${path}.children`, depth + 1);
    });
  };
  walk(sheet.events, 'events', 0);
  return { sites, skipped };
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
        for (const name of scope) {
          const file = reader.getEntityRelativePath('eventSheets', name);
          let sheet: EventSheet;
          try {
            sheet = await reader.readEventSheet(name);
          } catch (e) {
            warnings.push(`Event sheet "${name}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          const result = replaceInSheet(file, sheet, from, to, source, target, !args.dryRun, warnings);
          sites.push(...result.sites);
          skipped.push(...result.skipped);
          unrewritten += countUnrewrittenObjectMentions(sheet, from);
          if (!args.dryRun && result.sites.length > 0) {
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
    'Find and replace text in condition and action parameter values (the expressions shown in event sheets) across the project or chosen sheets. Comments, scripts, names and variable declarations are not touched. Use dryRun to see every change first.',
    {
      find: z.string().min(1).max(500).describe('Text to find, or a regular expression when regex is true'),
      replace: z.string().max(2000).describe('Replacement text; with regex, $1-style group references are expanded'),
      regex: z.boolean().optional().default(false).describe('Treat find as a JavaScript regular expression'),
      caseSensitive: z.boolean().optional().default(true).describe('Match case (default true)'),
      wholeWord: z.boolean().optional().default(false).describe('Match whole words only'),
      sheets: z.array(z.string().max(200)).max(500).optional().describe('Limit to these event sheets (default: all)'),
      parameterKeys: z.array(z.string().max(200)).max(100).optional()
        .describe('Only change parameters with these keys (e.g. ["value", "expression"]); positional custom-action or function arguments use their index ("0", "1", ...)'),
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
        if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test('')) {
          return toolError('The search pattern matches empty text, which would insert the replacement everywhere. Use a pattern that needs at least one character.');
        }

        const allSheets = await reader.listEventSheets();
        const scope = args.sheets ?? allSheets;
        const missing = scope.filter(name => !allSheets.includes(name));
        if (missing.length > 0) return toolError(`Event sheet(s) not found: ${missing.join(', ')}. Use list_eventsheets to see all names.`);
        const keyFilter = args.parameterKeys ? new Set(args.parameterKeys) : null;
        // Plain text: a literal replacement, so escape String.replace's $ patterns.
        const replacement = args.regex ? args.replace : args.replace.replace(/\$/g, '$$$$');

        const changes: Array<{ sheet: string; eventSid?: number; path: string; key: string; before: string; after: string }> = [];
        const perSheet: Array<{ sheet: string; parameters: number; matches: number }> = [];
        let totalMatches = 0;
        let totalParameters = 0;
        const warnings: string[] = [];

        for (const name of scope) {
          let sheet: EventSheet;
          try {
            sheet = await reader.readEventSheet(name);
          } catch (e) {
            warnings.push(`Event sheet "${name}" could not be read and was not scanned: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          let sheetMatches = 0;
          let sheetParameters = 0;
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
                    pattern.lastIndex = 0;
                    const count = value.match(pattern)?.length ?? 0;
                    if (count === 0) continue;
                    pattern.lastIndex = 0;
                    const after = value.replace(pattern, replacement);
                    if (after === value) continue;
                    sheetMatches += count;
                    sheetParameters++;
                    const paramPath = Array.isArray(params) ? `${path}.${listKey}[${j}].parameters[${key}]` : `${path}.${listKey}[${j}].parameters.${key}`;
                    if (changes.length < args.maxReported) {
                      changes.push({ sheet: name, eventSid, path: paramPath, key, before: value, after });
                    }
                    if (!args.dryRun) record[key] = after;
                  }
                });
              }
              walk(event.children, `${path}.children`, depth + 1);
            });
          };
          walk(sheet.events as unknown as C3Event[], 'events', 0);
          if (sheetParameters === 0) continue;
          perSheet.push({ sheet: name, parameters: sheetParameters, matches: sheetMatches });
          totalMatches += sheetMatches;
          totalParameters += sheetParameters;
          if (!args.dryRun) {
            const subfolder = writer.getSubfolderForEntity('eventSheets', name);
            await writer.writeEntityFile('eventSheets', name, sheet, subfolder);
            resetProjectIndex();
            filesWritten.push(reader.getEntityRelativePath('eventSheets', name));
          }
        }

        return toolResult({
          success: true,
          action: args.dryRun ? 'dry-run' : 'replaced',
          find: args.find,
          replace: args.replace,
          sheetsScanned: scope.length,
          totalMatches,
          parametersChanged: totalParameters,
          bySheet: perSheet,
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
