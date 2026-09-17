/**
 * Read-only project queries: get_project_properties, search_project,
 * find_behavior_usage, find_effect_usage, find_instance_variable_references,
 * get_instance_counts.
 *
 * None of these write. They answer the questions a person answers in the
 * editor with the Project Properties dialog, Find, and "Find all references".
 */

import { z } from 'zod';
import { readFile } from 'fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { Layout, Layer, Instance } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import { collectInstances, collectLayers } from '../construct3/layout-walk.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { buildInstanceVariablePattern } from './object-tools.js';

/** Top-level project.c3proj keys that hold entity trees, not settings. */
const TREE_KEYS = new Set([
  'objectTypes', 'families', 'layouts', 'eventSheets', 'timelines', 'flowcharts',
  'rootFileFolders', 'usedAddons', 'containers', 'models3d', 'properties',
]);

const MAX_SEARCH_RESULTS = 1000;

interface SearchHit {
  where: 'event-sheet' | 'script' | 'layout';
  file: string;
  /** Nearest enclosing event SID, when the hit is inside an event sheet. */
  eventSid?: number;
  /** JSON path inside the file, or the line number in a script. */
  path: string;
  field: string;
  text: string;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

/** Walk every string leaf of a JSON value, tracking the path and the nearest event SID. */
function walkStrings(
  value: unknown,
  visit: (text: string, path: string, field: string, eventSid: number | undefined) => void,
): void {
  const stack: Array<{ node: unknown; path: string; field: string; sid: number | undefined }> = [
    { node: value, path: '', field: '', sid: undefined },
  ];
  let guard = 0;
  while (stack.length > 0) {
    if (++guard > 2_000_000) throw new Error('Search exceeded the node limit.');
    const { node, path, field, sid } = stack.pop()!;
    if (typeof node === 'string') {
      visit(node, path, field, sid);
    } else if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        stack.push({ node: node[i], path: `${path}[${i}]`, field, sid });
      }
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const ownSid = typeof record.eventType === 'string' && typeof record.sid === 'number' ? record.sid : sid;
      const entries = Object.entries(record);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        stack.push({ node: child, path: path ? `${path}.${key}` : key, field: key, sid: ownSid });
      }
    }
  }
}

/** Registered script files with their project-relative paths. */
function listScriptFiles(reader: Construct3ProjectReader): string[] {
  const project = reader.getProject() as unknown as { rootFileFolders?: { script?: unknown } };
  const out: string[] = [];
  const walk = (folder: unknown, prefix: string[]) => {
    const f = folder as { items?: Array<{ name?: string }>; subfolders?: Array<{ name?: string }> } | undefined;
    if (!f) return;
    for (const item of f.items ?? []) {
      if (typeof item?.name === 'string') out.push(['scripts', ...prefix, item.name].join('/'));
    }
    for (const sub of f.subfolders ?? []) {
      if (typeof sub?.name === 'string') walk(sub, [...prefix, sub.name]);
    }
  };
  walk(project.rootFileFolders?.script, []);
  return out;
}

function behaviorEntries(holder: Record<string, unknown>): Array<{ behaviorId?: string; name?: string }> {
  return Array.isArray(holder.behaviorTypes) ? holder.behaviorTypes as Array<{ behaviorId?: string; name?: string }> : [];
}

function effectEntries(holder: Record<string, unknown>): Array<{ effectId?: string; name?: string }> {
  return Array.isArray(holder.effectTypes) ? holder.effectTypes as Array<{ effectId?: string; name?: string }> : [];
}

export function registerUsageTools(server: McpServer, reader: Construct3ProjectReader) {
  // ─── get_project_properties ───────────────────────────────

  server.tool(
    'get_project_properties',
    'Read every project setting: the full project.c3proj "properties" bag (viewport, fullscreen mode, sampling, loader style, workers, Z axis, preview options and so on) plus the top-level settings such as name, version and bundleAddons. Entity lists are left out; use the list_* tools for those.',
    {},
    async () => {
      try {
        const project = reader.getProject() as unknown as Record<string, unknown>;
        const topLevel: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(project)) {
          if (!TREE_KEYS.has(key)) topLevel[key] = value;
        }
        return toolResult({
          topLevel,
          properties: project.properties ?? {},
          editableWith: 'update_project_properties (properties bag and selected top-level keys), update_project_metadata',
        });
      } catch (error) {
        return toolError(`Error reading project properties: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── search_project ───────────────────────────────────────

  server.tool(
    'search_project',
    'Find text across the project like the editor\'s Find: event-sheet content (parameters and expressions, comments, names, titles, script actions and blocks), script files, and layout instance values. Returns each hit with its file, nearest event SID and field.',
    {
      query: z.string().min(1).max(500).describe('Text to find, or a regular expression when regex is true'),
      regex: z.boolean().optional().default(false).describe('Treat query as a JavaScript regular expression'),
      caseSensitive: z.boolean().optional().default(false).describe('Match case'),
      wholeWord: z.boolean().optional().default(false).describe('Match whole words only'),
      scopes: z.array(z.enum(['events', 'scripts', 'layouts'])).min(1).optional().default(['events', 'scripts'])
        .describe('Where to search (default: events and scripts)'),
      sheets: z.array(z.string().max(200)).max(500).optional().describe('Limit the event search to these sheets'),
      maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional().default(200).describe(`Maximum hits returned (max ${MAX_SEARCH_RESULTS})`),
    },
    async (args) => {
      try {
        let pattern: RegExp;
        try {
          const source = args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(args.wholeWord ? `\\b(?:${source})\\b` : source, args.caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return toolError(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
        }

        const hits: SearchHit[] = [];
        let total = 0;
        const record = (hit: SearchHit) => {
          total++;
          if (hits.length < args.maxResults) hits.push(hit);
        };
        const scan = (text: string, make: (index: number, length: number) => SearchHit) => {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(text)) !== null) {
            record(make(m.index, m[0].length));
            if (m[0].length === 0) pattern.lastIndex++;
          }
        };

        const skipped: string[] = [];
        if (args.scopes.includes('events')) {
          const names = args.sheets ?? await reader.listEventSheets();
          for (const name of names) {
            let sheet;
            try {
              sheet = await reader.readEventSheet(name);
            } catch {
              skipped.push(`event sheet "${name}"`);
              continue;
            }
            walkStrings(sheet.events, (text, path, field, eventSid) => {
              if (field === 'eventType' || field === 'type' || field === 'language') return;
              scan(text, (index, length) => ({
                where: 'event-sheet', file: name, eventSid, path: `events${path}`, field, text: snippet(text, index, length),
              }));
            });
          }
        }

        if (args.scopes.includes('scripts')) {
          for (const rel of listScriptFiles(reader)) {
            let content: string;
            try {
              content = await readFile(resolveProjectPath(reader.getProjectDir(), ...rel.split('/')), 'utf-8');
            } catch {
              skipped.push(`script "${rel}"`);
              continue;
            }
            const lines = content.split(/\r?\n/);
            lines.forEach((line, i) => scan(line, (index, length) => ({
              where: 'script', file: rel, path: `line ${i + 1}`, field: 'code', text: snippet(line, index, length),
            })));
          }
        }

        if (args.scopes.includes('layouts')) {
          for (const [name, layout] of await reader.readAllLayouts()) {
            collectInstances(layout).forEach(instance => {
              walkStrings({ properties: instance.properties, instanceVariables: instance.instanceVariables, tags: instance.tags }, (text, path, field) => {
                scan(text, (index, length) => ({
                  where: 'layout', file: name, path: `instance uid ${instance.uid} (${instance.type}) ${path}`, field, text: snippet(text, index, length),
                }));
              });
            });
          }
        }

        return toolResult({
          query: args.query,
          totalHits: total,
          returned: hits.length,
          truncated: total > hits.length,
          hits,
          skipped: skipped.length > 0 ? skipped : undefined,
        });
      } catch (error) {
        return toolError(`Error searching the project: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── find_behavior_usage ──────────────────────────────────

  server.tool(
    'find_behavior_usage',
    'Find where a behavior is used: the object types and families that declare it, event conditions and actions that use it (including through family members), and placed instances with their own settings for it.',
    {
      behaviorName: z.string().max(200).optional().describe('Behavior name as declared on the object type or family (e.g. "Platform")'),
      behaviorId: z.string().max(200).optional().describe('Behavior addon id (e.g. "Platform", "Sin"); matches every declaration of that addon'),
    },
    async (args) => {
      try {
        if (!args.behaviorName && !args.behaviorId) {
          return toolError('Specify behaviorName, behaviorId, or both.');
        }
        const matches = (entry: { behaviorId?: string; name?: string }) =>
          (!args.behaviorName || entry.name === args.behaviorName) && (!args.behaviorId || entry.behaviorId === args.behaviorId);

        const declarations: Array<{ owner: string; ownerKind: 'object' | 'family'; name: string; behaviorId?: string }> = [];
        for (const [name, obj] of await reader.readAllObjectTypes()) {
          for (const entry of behaviorEntries(obj as unknown as Record<string, unknown>)) {
            if (matches(entry)) declarations.push({ owner: name, ownerKind: 'object', name: String(entry.name), behaviorId: entry.behaviorId });
          }
        }
        const families = await reader.readAllFamilies();
        for (const [name, family] of families) {
          for (const entry of behaviorEntries(family)) {
            if (matches(entry)) declarations.push({ owner: name, ownerKind: 'family', name: String(entry.name), behaviorId: entry.behaviorId });
          }
        }

        // Event references use the declared name on the owner, a member of a
        // declaring family, or the family itself.
        const index = await getProjectIndex(reader);
        const scopes = new Map<string, Set<string>>();
        const addScope = (objectClass: string, name: string) => {
          if (!scopes.has(objectClass)) scopes.set(objectClass, new Set());
          scopes.get(objectClass)!.add(name);
        };
        for (const d of declarations) {
          addScope(d.owner, d.name);
          if (d.ownerKind === 'family') {
            const members = families.get(d.owner)?.members;
            if (Array.isArray(members)) for (const m of members) addScope(String(m), d.name);
          }
        }
        const eventReferences = [];
        for (const [objectClass, names] of scopes) {
          for (const name of names) {
            eventReferences.push(...(index.behaviorReferences.get(`${objectClass}::${name}`) ?? []));
          }
        }

        const instanceSettings: Array<{ layout: string; uid: number; type: string; behavior: string; properties: Record<string, unknown> }> = [];
        for (const [layoutName, layout] of await reader.readAllLayouts()) {
          for (const instance of collectInstances(layout)) {
            const names = scopes.get(instance.type);
            if (!names || !instance.behaviors) continue;
            for (const name of names) {
              const state = (instance.behaviors as Record<string, { properties?: Record<string, unknown> }>)[name];
              if (state && state.properties && Object.keys(state.properties).length > 0) {
                instanceSettings.push({ layout: layoutName, uid: instance.uid, type: instance.type, behavior: name, properties: state.properties });
              }
            }
          }
        }

        return toolResult({
          declarations,
          eventReferences,
          eventReferenceCount: eventReferences.length,
          sheets: [...new Set(eventReferences.map(r => r.eventSheet))],
          instanceSettings,
          note: 'References inside script actions, script files and expression text (e.g. Player.Platform.Speed) are not counted; use search_project for those.',
        });
      } catch (error) {
        return toolError(`Error finding behavior usage: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── find_effect_usage ────────────────────────────────────

  server.tool(
    'find_effect_usage',
    'Find where an effect is used across the project: object types, families, layouts and layers that list it, and placed instances with per-instance state for it.',
    {
      effectId: z.string().max(200).optional().describe('Effect addon id (e.g. "hsladjust")'),
      effectName: z.string().max(200).optional().describe('Effect name as listed on the target'),
    },
    async (args) => {
      try {
        if (!args.effectId && !args.effectName) {
          return toolError('Specify effectId, effectName, or both.');
        }
        const matches = (entry: { effectId?: string; name?: string }) =>
          (!args.effectId || entry.effectId === args.effectId) && (!args.effectName || entry.name === args.effectName);

        const uses: Array<{ targetType: string; target: string; layout?: string; name: string; effectId?: string }> = [];
        const instanceNames = new Map<string, Set<string>>();
        const noteInstanceName = (type: string, name: string) => {
          if (!instanceNames.has(type)) instanceNames.set(type, new Set());
          instanceNames.get(type)!.add(name);
        };
        for (const [name, obj] of await reader.readAllObjectTypes()) {
          for (const e of effectEntries(obj as unknown as Record<string, unknown>)) {
            if (matches(e)) {
              uses.push({ targetType: 'objectType', target: name, name: String(e.name), effectId: e.effectId });
              noteInstanceName(name, String(e.name));
            }
          }
        }
        for (const [name, family] of await reader.readAllFamilies()) {
          for (const e of effectEntries(family)) {
            if (matches(e)) {
              uses.push({ targetType: 'family', target: name, name: String(e.name), effectId: e.effectId });
              const members = Array.isArray(family.members) ? family.members as string[] : [];
              for (const m of members) noteInstanceName(m, String(e.name));
            }
          }
        }
        const instanceStates: Array<{ layout: string; uid: number; type: string; effect: string; isEnabled?: boolean }> = [];
        for (const [layoutName, layout] of await reader.readAllLayouts()) {
          for (const e of effectEntries(layout as unknown as Record<string, unknown>)) {
            if (matches(e)) uses.push({ targetType: 'layout', target: layoutName, name: String(e.name), effectId: e.effectId });
          }
          for (const layer of collectLayers(layout as Layout)) {
            for (const e of effectEntries(layer as unknown as Record<string, unknown>)) {
              if (matches(e)) uses.push({ targetType: 'layer', target: (layer as Layer).name, layout: layoutName, name: String(e.name), effectId: e.effectId });
            }
          }
          for (const instance of collectInstances(layout)) {
            const names = instanceNames.get(instance.type);
            const effects = (instance as Record<string, unknown>).effects as Record<string, { isEnabled?: boolean }> | undefined;
            if (!names || !effects) continue;
            for (const name of names) {
              if (effects[name]) instanceStates.push({ layout: layoutName, uid: instance.uid, type: instance.type, effect: name, isEnabled: effects[name].isEnabled });
            }
          }
        }

        return toolResult({ uses, useCount: uses.length, instanceStates });
      } catch (error) {
        return toolError(`Error finding effect usage: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── find_instance_variable_references ────────────────────

  server.tool(
    'find_instance_variable_references',
    'Find every event-sheet reference to an instance variable (instance-variable ACE parameters and <Object>.<variable> expressions, including call arguments) and the placed instances that store a value for it. Read-only; update_instance_variable uses the same rules when renaming.',
    {
      objectName: z.string().max(200).optional().describe('Object type that owns the variable (supply exactly one of objectName/familyName)'),
      familyName: z.string().max(200).optional().describe('Family that owns the variable'),
      variableName: z.string().max(200).describe('Instance variable name'),
    },
    async (args) => {
      try {
        if ((args.objectName === undefined) === (args.familyName === undefined)) {
          return toolError('Specify exactly one of objectName or familyName.');
        }
        const isFamily = args.familyName !== undefined;
        const ownerName = (args.objectName ?? args.familyName) as string;
        let owner: Record<string, unknown>;
        try {
          owner = isFamily
            ? await reader.readFamily(ownerName)
            : await reader.readObjectType(ownerName) as unknown as Record<string, unknown>;
        } catch {
          return isFamily
            ? toolError(`Family "${ownerName}" not found. Use list_families to see available families.`)
            : notFoundError('Object', ownerName, reader.findNearestName(ownerName, 'objects'), 'list_objects');
        }
        const vars = Array.isArray(owner.instanceVariables) ? owner.instanceVariables as Array<{ name?: string }> : [];
        if (!vars.some(v => v.name === args.variableName)) {
          return toolError(`Instance variable "${args.variableName}" not found on ${isFamily ? 'family' : 'object'} "${ownerName}". Available: ${vars.map(v => v.name).join(', ') || '(none)'}.`);
        }

        const affected = new Set<string>(isFamily && Array.isArray(owner.members) ? owner.members as string[] : [ownerName]);
        const referringNames = new Set<string>(affected);
        if (isFamily) referringNames.add(ownerName);
        const pattern = buildInstanceVariablePattern(referringNames, args.variableName);

        const references: Array<{ sheet: string; eventSid?: number; objectClass?: string; kind: 'ace-parameter' | 'expression'; field: string; text: string }> = [];
        for (const [sheetName, sheet] of await reader.readAllEventSheets()) {
          const stack: Array<{ node: unknown; scope?: string; sid?: number }> = [{ node: sheet.events }];
          while (stack.length > 0) {
            const { node, scope, sid } = stack.pop()!;
            if (Array.isArray(node)) {
              for (const item of node) stack.push({ node: item, scope, sid });
              continue;
            }
            if (!node || typeof node !== 'object') continue;
            const record = node as Record<string, unknown>;
            const nextScope = typeof record.objectClass === 'string' ? record.objectClass : scope;
            const nextSid = typeof record.eventType === 'string' && typeof record.sid === 'number' ? record.sid : sid;
            const params = record.parameters;
            const entries: Array<[string, unknown]> = Array.isArray(params)
              ? params.map((v, i) => [`parameters[${i}]`, v])
              : params && typeof params === 'object' ? Object.entries(params as Record<string, unknown>) : [];
            for (const [key, value] of entries) {
              if (typeof value !== 'string') continue;
              if (key === 'instance-variable' && value === args.variableName && nextScope && referringNames.has(nextScope)) {
                references.push({ sheet: sheetName, eventSid: nextSid, objectClass: nextScope, kind: 'ace-parameter', field: key, text: value });
                continue;
              }
              pattern.lastIndex = 0;
              if (pattern.test(value)) {
                references.push({ sheet: sheetName, eventSid: nextSid, objectClass: nextScope, kind: 'expression', field: key, text: value.length > 200 ? `${value.slice(0, 200)}...` : value });
              }
            }
            for (const [key, value] of Object.entries(record)) {
              if (key !== 'parameters' && value && typeof value === 'object') stack.push({ node: value, scope: nextScope, sid: nextSid });
            }
          }
        }

        const storedValues: Array<{ layout: string; uid: number; type: string; value: unknown }> = [];
        for (const [layoutName, layout] of await reader.readAllLayouts()) {
          for (const instance of collectInstances(layout) as Instance[]) {
            if (!affected.has(instance.type)) continue;
            const values = instance.instanceVariables as Record<string, unknown> | undefined;
            if (values && Object.prototype.hasOwnProperty.call(values, args.variableName)) {
              storedValues.push({ layout: layoutName, uid: instance.uid, type: instance.type, value: values[args.variableName] });
            }
          }
        }

        return toolResult({
          owner: ownerName,
          ownerKind: isFamily ? 'family' : 'object',
          variableName: args.variableName,
          references,
          referenceCount: references.length,
          sheets: [...new Set(references.map(r => r.sheet))],
          storedValues,
          note: 'References built by string concatenation or written in script actions or script files are not detected; use search_project for those.',
        });
      } catch (error) {
        return toolError(`Error finding instance variable references: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── get_instance_counts ──────────────────────────────────

  server.tool(
    'get_instance_counts',
    'Count placed instances per object type and layout, including instances on sub-layers and non-world instances. Object types with no placed instance are listed separately.',
    {
      objectName: z.string().max(200).optional().describe('Limit to one object type'),
      layoutName: z.string().max(200).optional().describe('Limit to one layout'),
    },
    async (args) => {
      try {
        const index = await getProjectIndex(reader);
        if (args.objectName && !index.allObjects.includes(args.objectName)) {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }
        if (args.layoutName && !index.allLayouts.includes(args.layoutName)) {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const rows: Array<{ objectType: string; total: number; byLayout: Record<string, number> }> = [];
        for (const [type, perLayout] of index.objectInstanceCounts) {
          if (args.objectName && type !== args.objectName) continue;
          const byLayout: Record<string, number> = {};
          let total = 0;
          for (const [layout, count] of perLayout) {
            if (args.layoutName && layout !== args.layoutName) continue;
            byLayout[layout] = count;
            total += count;
          }
          if (total > 0) rows.push({ objectType: type, total, byLayout });
        }
        rows.sort((a, b) => b.total - a.total || a.objectType.localeCompare(b.objectType));
        const placed = new Set(rows.map(r => r.objectType));
        const notPlaced = args.objectName
          ? (placed.has(args.objectName) ? [] : [args.objectName])
          : index.allObjects.filter(name => !placed.has(name));
        return toolResult({
          totalInstances: rows.reduce((n, r) => n + r.total, 0),
          objectTypes: rows,
          notPlaced,
        });
      } catch (error) {
        return toolError(`Error counting instances: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
