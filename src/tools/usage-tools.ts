/**
 * MCP tools that answer "where is this used" and "what does the project hold"
 * from the project's files without changing anything: project properties and
 * instance counts, and the helpers every usage query shares for saying how
 * complete its answer is.
 */

import { z } from 'zod';
import { Script, createContext } from 'node:vm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { classifyReadError, type Construct3ProjectReader, type EntityCategory, type ReadFailure } from '../construct3/project-reader.js';
import { getProjectIndex, type ProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  checkUnscannedFiles,
  unscannedFields,
  unscannedFilesOf,
  type UnscannedFile,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm, type RawTextTerm } from '../construct3/raw-text-search.js';
import { nameKey } from '../construct3/names.js';
import { forEachLayoutInstance } from '../construct3/layers.js';
import { registeredScriptFiles } from '../construct3/script-files.js';
import { notFoundError, toolError, toolResult } from './shared.js';
import { withProjectSync } from './project-sync.js';

/** What a usage query says about the parts of the project its answer leaves out. */
export interface Completeness {
  complete: boolean;
  unscannedFiles?: UnscannedFileReport[];
  partlyIndexedSheets?: string[];
  scriptsNotWalked?: string[];
  unreadableScripts?: string[];
}

/** Incompleteness a query knows about besides skipped project files. */
export interface CompletenessExtra {
  partlyIndexedSheets?: string[];
  scriptsNotWalked?: string[];
  unreadableScripts?: string[];
}

/**
 * Exported for tests. How complete an answer is: of `files` (the files the
 * bulk reads skipped), those in `categories` are the ones the query reads.
 * Each gets a report: searched as text for `allOf` when that has a group and
 * every group has a term, else (or when the search skipped the file)
 * `not-searched`. `complete` is true only with no such file and every
 * `extra` list empty; each non-empty `extra` list is returned under its key.
 */
export async function completeness(
  reader: Pick<Construct3ProjectReader, 'searchEntityTextRaw'>,
  files: readonly UnscannedFile[],
  categories: readonly EntityCategory[],
  allOf: ReadonlyArray<readonly RawTextTerm[]>,
  extra: CompletenessExtra = {},
): Promise<Completeness> {
  const selected = files.filter(f => categories.includes(f.category));
  const searchable = selected.length > 0 && allOf.length > 0 && allOf.every(group => group.length > 0);
  const searched = searchable ? await checkUnscannedFiles(reader, selected, [{ categories, allOf }]) : [];
  const byFile = new Map(searched.map(report => [report.file, report]));
  const reports = selected.map((f): UnscannedFileReport =>
    byFile.get(f.file) ?? { file: f.file, reason: f.reason, textSearch: 'not-searched' });
  const lists: CompletenessExtra = {};
  if (extra.partlyIndexedSheets && extra.partlyIndexedSheets.length > 0) lists.partlyIndexedSheets = extra.partlyIndexedSheets;
  if (extra.scriptsNotWalked && extra.scriptsNotWalked.length > 0) lists.scriptsNotWalked = extra.scriptsNotWalked;
  if (extra.unreadableScripts && extra.unreadableScripts.length > 0) lists.unreadableScripts = extra.unreadableScripts;
  return {
    complete: reports.length === 0 && Object.keys(lists).length === 0,
    ...unscannedFields(reports),
    ...lists,
  };
}

const PARTLY_INDEXED = /^Event sheet "(.*)": (?:traversal limit reached|max depth exceeded)/;

/**
 * Exported for tests. The event sheets the index stopped walking, as
 * `eventSheets/<name>`, once each: their references past the limit are
 * missing from the index.
 */
export function partlyIndexed(index: Pick<ProjectIndex, 'warnings'>): string[] {
  const sheets = new Set<string>();
  for (const warning of index.warnings) {
    const match = PARTLY_INDEXED.exec(warning);
    if (match) sheets.add(`eventSheets/${match[1]}`);
  }
  return [...sheets];
}

/** The refusal text of a lookup that found nothing, ending as every read-only tool's refusals do. */
function nothingReturned(result: ReturnType<typeof toolError>) {
  return toolError(`${result.content[0].text} Nothing was returned.`);
}

/** The registered spelling of `name` among `registered` (compared with nameKey), if any. */
function registeredName(registered: readonly string[], name: string): string | undefined {
  const key = nameKey(name);
  return registered.find(r => nameKey(r) === key);
}

/** Limits of one search, and the clock they are read from; tests replace them. */
export const SEARCH_LIMITS = {
  perCallMs: 1000,
  budgetMs: 10_000,
  maxMatchesPerText: 100,
  /** Values of one file's JSON the string walk counts, each as it is queued, before it gives up. */
  maxNodes: 2_000_000,
  now: (): number => performance.now(),
};

/** A search ran past a limit: one call (`call`) or the whole search (`budget`). */
export class SearchTimeout extends Error {
  constructor(readonly limit: 'call' | 'budget') {
    super(limit === 'call' ? 'A regular expression ran past its time limit' : 'The search ran past its time budget');
  }
}

/** The time one search may take in all. */
export interface SearchBudget {
  /** Throws SearchTimeout('budget') once the budget is used up. */
  check(): void;
  /** Milliseconds left, never below 0. */
  remaining(): number;
}

/** A budget that starts now; `>=` so a budget of 0 refuses at the first check on any clock. */
export function newBudget(): SearchBudget {
  const deadline = SEARCH_LIMITS.now() + SEARCH_LIMITS.budgetMs;
  return {
    check() {
      if (SEARCH_LIMITS.now() >= deadline) throw new SearchTimeout('budget');
    },
    remaining: () => Math.max(0, deadline - SEARCH_LIMITS.now()),
  };
}

/** One match: the position of its text in the array searched, and where in that text. */
export interface Hit { text: number; index: number; length: number }

/**
 * What a matcher found in a file's texts: the first `keep` matches (`hits`),
 * every match counted (`count`, each text stopping at maxMatchesPerText) and
 * whether some text held more than that (`capped`: `count` is then a lower bound).
 */
export interface MatchResult { hits: Hit[]; count: number; capped: boolean }

/** Matches of one pattern in a file's texts; at most `keep` match objects are held, whatever the texts hold. */
export type Matcher = (texts: readonly string[], keep: number) => MatchResult;

/**
 * The loop both matchers run. A function expression called at once, so the
 * script declares nothing at the context's top level and can run again in
 * the same context. The native copy below must stay the same code.
 */
const MATCH_LOOP = `(function (pattern, texts, cap, keep) {
  const hits = [];
  let count = 0;
  let capped = false;
  for (let t = 0; t < texts.length; t++) {
    const text = texts[t];
    let n = 0;
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      if (n === cap) { capped = true; break; }
      n++;
      count++;
      if (hits.length < keep) hits.push({ text: t, index: m.index, length: m[0].length });
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
  return { hits, count, capped };
})`;

/** How many texts the native loop reads between two looks at the budget. */
const CHECK_EVERY = 256;

/** MATCH_LOOP on this thread, for escaped literal queries (they cannot backtrack); looks at the budget as it goes. */
function nativeLoop(pattern: RegExp, texts: readonly string[], cap: number, keep: number, budget: SearchBudget): MatchResult {
  const hits: Hit[] = [];
  let count = 0;
  let capped = false;
  for (let t = 0; t < texts.length; t++) {
    if (t > 0 && t % CHECK_EVERY === 0) budget.check();
    const text = texts[t];
    let n = 0;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      if (n === cap) { capped = true; break; }
      n++;
      count++;
      if (hits.length < keep) hits.push({ text: t, index: m.index, length: m[0].length });
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
  return { hits, count, capped };
}

/** Refuse a pattern whose exec loop would never advance. */
function requireGlobal(pattern: RegExp): void {
  if (!pattern.global) throw new Error('A search pattern needs the g flag');
}

/** Matcher for an escaped literal query, run natively; the budget is checked before, during (every CHECK_EVERY texts) and after each call. */
export function literalMatcher(pattern: RegExp, budget: SearchBudget = newBudget()): Matcher {
  requireGlobal(pattern);
  return (texts, keep) => {
    budget.check();
    const result = nativeLoop(pattern, texts, SEARCH_LIMITS.maxMatchesPerText, keep, budget);
    budget.check();
    return result;
  };
}

/**
 * Matcher for a regex query: one vm call per file, each under the smaller of
 * SEARCH_LIMITS.perCallMs and what is left of the budget; the budget is
 * also checked before and after each call.
 */
export function regexMatcher(pattern: RegExp, budget: SearchBudget = newBudget()): Matcher {
  requireGlobal(pattern);
  const sandbox: { pattern: RegExp; texts: readonly string[]; cap: number; keep: number } =
    { pattern, texts: [], cap: SEARCH_LIMITS.maxMatchesPerText, keep: 0 };
  const context = createContext(sandbox);
  const script = new Script(`${MATCH_LOOP}(pattern, texts, cap, keep)`);
  return (texts, keep) => {
    budget.check();
    sandbox.texts = texts;
    sandbox.keep = keep;
    try {
      const timeout = Math.max(1, Math.ceil(Math.min(SEARCH_LIMITS.perCallMs, budget.remaining())));
      const found = script.runInContext(context, { timeout }) as MatchResult;
      budget.check();
      // Copy out of the vm's realm: plain arrays and objects of this one.
      return {
        hits: found.hits.map(hit => ({ text: hit.text, index: hit.index, length: hit.length })),
        count: found.count,
        capped: found.capped,
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        budget.check();
        throw new SearchTimeout('call');
      }
      throw error;
    }
  };
}

const MAX_SEARCH_RESULTS = 1000;

/** The string walk visited more nodes than SEARCH_LIMITS.maxNodes. */
class NodeLimitExceeded extends Error {}

/** One hit of search_project. */
interface SearchHit {
  where: 'event-sheet' | 'script' | 'layout';
  /** The file's path in the project. */
  file: string;
  /** Nearest enclosing event SID, when the hit is inside an event sheet. */
  eventSid?: number;
  /** Path inside the file, or the line number in a script. */
  path: string;
  field: string;
  /** The matched text with up to 60 characters on each side. */
  text: string;
}

/** A string found by the walk, with where it was. */
interface FoundString {
  text: string;
  path: string;
  field: string;
  sid: number | undefined;
}

/** `text` around a match, with "..." where it was cut. */
function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

/** Event fields that name a kind or a language, not content a person wrote. */
const KIND_FIELDS = new Set(['eventType', 'type', 'language']);

/**
 * Add every string of a JSON value to `out`, with its path (prefixed by
 * `prefix`), the key it sits under and the nearest enclosing event SID.
 * Iterative; `state.nodes` counts the nodes visited over all calls for one
 * file, and the budget is looked at every 10,000 of them.
 */
function collectStrings(
  value: unknown,
  prefix: string,
  skipKinds: boolean,
  state: { nodes: number },
  budget: SearchBudget,
  out: FoundString[],
): void {
  /** Count `n` nodes as they are pushed, before they are: the limit and the budget look at the count. */
  const count = (n: number): void => {
    const before = state.nodes;
    state.nodes += n;
    if (state.nodes > SEARCH_LIMITS.maxNodes) throw new NodeLimitExceeded();
    if (Math.floor(state.nodes / 10_000) > Math.floor(before / 10_000)) budget.check();
  };
  const stack: Array<{ node: unknown; path: string; field: string; sid: number | undefined }> = [];
  count(1);
  stack.push({ node: value, path: '', field: '', sid: undefined });
  while (stack.length > 0) {
    const { node, path, field, sid } = stack.pop()!;
    if (typeof node === 'string') {
      if (!(skipKinds && KIND_FIELDS.has(field))) out.push({ text: node, path: prefix + path, field, sid });
    } else if (Array.isArray(node)) {
      count(node.length);
      for (let i = node.length - 1; i >= 0; i--) {
        stack.push({ node: node[i], path: `${path}[${i}]`, field, sid });
      }
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const ownSid = typeof record.eventType === 'string' && typeof record.sid === 'number' ? record.sid : sid;
      const entries = Object.entries(record);
      count(entries.length);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        stack.push({ node: child, path: path ?`${path}.${key}` : key, field: key, sid: ownSid });
      }
    }
  }
}

/** Register the read-only usage and inventory tools. */
export function registerUsageTools(mcpServer: McpServer, reader: Construct3ProjectReader): void {
  const server = withProjectSync(mcpServer, reader);

  server.tool(
    'get_project_properties',
    'Get the project\'s property settings (the "properties" bag of project.c3proj) and its other top-level scalar settings, such as the name and the release it was saved with. Reads project.c3proj only.',
    {},
    async () => {
      try {
        const project = reader.getProject() as unknown as Record<string, unknown>;
        const topLevel: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(project)) {
          if (value === null || typeof value !== 'object') topLevel[key] = value;
        }
        const properties = project.properties;
        return toolResult({
          properties: properties !== null && typeof properties === 'object' ? properties : {},
          topLevel,
        });
      } catch (error) {
        return toolError(`Error reading project properties: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'get_instance_counts',
    'Count the instances each object type has on the project\'s layouts, per layout, sub-layers and non-world instances included. Object types with no instance are listed in notPlaced (with layoutName set, notPlaced lists the types with no instance on that layout). A layout that could not be parsed is not counted. A layout or object type that could not be parsed makes the result complete false and is named.',
    {
      objectName: z.string().max(200).optional().describe('Only this object type (any letter case)'),
      layoutName: z.string().max(200).optional().describe('Only this layout (any letter case)'),
    },
    async (args) => {
      try {
        const index = await getProjectIndex(reader);
        let objectNames = index.allObjects;
        let layoutNames = index.allLayouts;
        if (args.objectName !== undefined) {
          const found = registeredName(index.allObjects, args.objectName);
          if (found === undefined) {
            return nothingReturned(notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects'));
          }
          objectNames = [found];
        }
        if (args.layoutName !== undefined) {
          const found = registeredName(index.allLayouts, args.layoutName);
          if (found === undefined) {
            return nothingReturned(notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts'));
          }
          layoutNames = [found];
        }
        const wanted = new Set(layoutNames);

        const objects: Array<{ name: string; total: number; byLayout: Array<{ layout: string; instances: number }> }> = [];
        const notPlaced: string[] = [];
        let totalInstances = 0;
        for (const name of objectNames) {
          const perLayout = new Map<string, number>();
          for (const placement of index.getObjectUsage(name).placements) {
            if (!wanted.has(placement.layout)) continue;
            perLayout.set(placement.layout, (perLayout.get(placement.layout) ?? 0) + placement.instances);
          }
          const byLayout = [...perLayout].map(([layout, instances]) => ({ layout, instances }))
            .sort((a, b) => b.instances - a.instances || (a.layout < b.layout ? -1 : a.layout > b.layout ? 1 : 0));
          const total = byLayout.reduce((sum, entry) => sum + entry.instances, 0);
          if (total === 0) {
            notPlaced.push(name);
            continue;
          }
          totalInstances += total;
          objects.push({ name, total, byLayout });
        }
        objects.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        const status = await completeness(reader, index.unscannedFiles, ['layouts', 'objectTypes'], []);
        return toolResult({
          totalInstances,
          objects,
          ...(status.complete
            ? { notPlaced }
            : { notPlacedOmitted: 'Object types with no instance are not listed, because a file that could not be parsed leaves the list unreliable.' }),
          ...status,
        });
      } catch (error) {
        return toolError(`Error counting instances: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'search_project',
    `Find text across the project: event-sheet content (parameters and expressions, comments, names, titles, script actions and blocks), registered script files, and with scopes layouts the instance property, instance variable and tag values on layouts. Returns each hit with its file (its path in the project), nearest event SID and field. A literal query is matched directly; a regular expression runs under a time limit of one second per file. The whole search, either kind, has ten seconds. At most ${SEARCH_LIMITS.maxMatchesPerText} matches are counted per string, and the call is refused naming the limit when it runs past one. A string with more matches than that makes truncated true and totalHits a lower bound (totalHitsIsLowerBound). A file that could not be parsed, a registered script that could not be read and script folders nested too deep to be walked are named and make the result complete false.`,
    {
      query: z.string().min(1).max(500).describe('Text to find, or a regular expression when regex is true'),
      regex: z.boolean().optional().default(false).describe('Treat query as a JavaScript regular expression'),
      caseSensitive: z.boolean().optional().default(false).describe('Match case'),
      wholeWord: z.boolean().optional().default(false).describe('Match whole words only'),
      scopes: z.array(z.enum(['events', 'scripts', 'layouts'])).min(1).optional().default(['events', 'scripts'])
        .describe('Where to search (default: events and scripts)'),
      sheets: z.array(z.string().max(200)).max(500).optional().describe('Limit the event search to these sheets (any letter case)'),
      maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional().default(200).describe(`Maximum hits returned (max ${MAX_SEARCH_RESULTS})`),
    },
    async (args) => {
      /** The file being searched, for the message of a timeout. */
      let current = '';
      try {
        let pattern: RegExp;
        try {
          const source = args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(args.wholeWord ? `\\b(?:${source})\\b` : source, args.caseSensitive ? 'g' : 'gi');
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression: /, '');
          return toolError(`Invalid regular expression: ${message}. Nothing was returned.`);
        }

        const wantEvents = args.scopes.includes('events');
        const wantScripts = args.scopes.includes('scripts');
        const wantLayouts = args.scopes.includes('layouts');

        let namedSheets: string[] | undefined;
        if (args.sheets !== undefined) {
          const registered = await reader.listEventSheets();
          namedSheets = [];
          for (const name of args.sheets) {
            const found = registeredName(registered, name);
            if (found === undefined) {
              return nothingReturned(notFoundError('Event sheet', name, reader.findNearestName(name, 'eventsheets'), 'list_eventsheets'));
            }
            if (!namedSheets.includes(found)) namedSheets.push(found);
          }
        }

        const budget = newBudget();
        const match = args.regex ? regexMatcher(pattern, budget) : literalMatcher(pattern, budget);
        const hits: SearchHit[] = [];
        let totalHits = 0;
        let capped = false;
        const skipped: UnscannedFile[] = [];
        const categories: EntityCategory[] = [];

        /** One matcher call for a file's strings; its hits are made by `locate`. */
        const searchFile = (file: string, texts: string[], locate: (index: number, at: Hit) => SearchHit): void => {
          current = file;
          const found = match(texts, args.maxResults - hits.length);
          totalHits += found.count;
          capped ||= found.capped;
          for (const hit of found.hits) hits.push(locate(hit.text, hit));
        };
        /** The strings of a JSON file as `texts`, and a locator for their hits. */
        const searchStrings = (file: string, where: SearchHit['where'], strings: FoundString[]): void => {
          searchFile(file, strings.map(s => s.text), (index, hit) => {
            const found = strings[index];
            return {
              where, file, eventSid: found.sid, path: found.path, field: found.field, text: snippet(found.text, hit.index, hit.length),
            };
          });
        };

        if (wantEvents) {
          categories.push('eventSheets');
          let sheets: Map<string, unknown>;
          let failures: ReadonlyMap<string, ReadFailure>;
          let registered: string[];
          if (namedSheets === undefined) {
            registered = await reader.listEventSheets();
            sheets = await reader.readAllEventSheets();
            failures = reader.getReadFailures('eventSheets');
          } else {
            registered = namedSheets;
            sheets = new Map();
            const failed = new Map<string, ReadFailure>();
            for (const name of namedSheets) {
              try {
                sheets.set(name, await reader.readEventSheet(name));
              } catch (error) {
                failed.set(name, { code: classifyReadError(error), message: error instanceof Error ? error.message : String(error) });
              }
            }
            failures = failed;
          }
          skipped.push(...unscannedFilesOf('eventSheets', registered, sheets, failures));
          for (const [name, sheet] of sheets) {
            const file = reader.getEntityRelativePath('eventSheets', name);
            current = file;
            const strings: FoundString[] = [];
            collectStrings((sheet as { events?: unknown }).events, 'events', true, { nodes: 0 }, budget, strings);
            searchStrings(file, 'event-sheet', strings);
          }
        }

        const unreadableScripts: string[] = [];
        let scriptsNotWalked: string[] = [];
        if (wantScripts) {
          const registry = registeredScriptFiles(reader.getProject().rootFileFolders?.script);
          scriptsNotWalked = registry.notWalked;
          for (const { path } of registry.files) {
            const file = `scripts/${path}`;
            let content: string;
            try {
              content = await reader.readScriptFile(path);
            } catch {
              unreadableScripts.push(file);
              continue;
            }
            const lines = content.split(/\r?\n/);
            searchFile(file, lines, (index, hit) =>
              ({ where: 'script', file, path: `line ${index + 1}`, field: 'code', text: snippet(lines[index], hit.index, hit.length) }));
          }
        }

        if (wantLayouts) {
          categories.push('layouts');
          const layouts = await reader.readAllLayouts();
          skipped.push(...unscannedFilesOf('layouts', await reader.listLayouts(), layouts, reader.getReadFailures('layouts')));
          for (const [name, layout] of layouts) {
            const file = reader.getEntityRelativePath('layouts', name);
            current = file;
            const strings: FoundString[] = [];
            const state = { nodes: 0 };
            forEachLayoutInstance(layout, instance => {
              collectStrings(
                { properties: instance.properties, instanceVariables: instance.instanceVariables, tags: instance.tags },
                `instance uid ${instance.uid} (${instance.type}) `, false, state, budget, strings,
              );
            });
            searchStrings(file, 'layout', strings);
          }
        }
        budget.check();

        const wordQuery = /^[\p{L}\p{N}_]/u.test(args.query) && /[\p{L}\p{N}_]$/u.test(args.query);
        const status = await completeness(
          reader, skipped, categories,
          !args.regex && args.wholeWord && wordQuery ? [[nameTerm(args.query)]] : [],
          { scriptsNotWalked, unreadableScripts },
        );
        return toolResult({
          query: args.query,
          totalHits,
          returned: hits.length,
          truncated: capped || totalHits > hits.length,
          ...(capped ? { totalHitsIsLowerBound: true } : {}),
          hits,
          ...status,
        });
      } catch (error) {
        if (error instanceof SearchTimeout) {
          return error.limit === 'call'
            ? toolError(`The regular expression took too long to run in ${current}. Make the pattern simpler or narrow the scope. Nothing was returned.`)
            : toolError(`The search ran past its time budget of ${SEARCH_LIMITS.budgetMs / 1000} seconds. Narrow the scope or the sheets searched. Nothing was returned.`);
        }
        if (error instanceof NodeLimitExceeded) {
          return toolError('The search exceeded the node limit. Nothing was returned.');
        }
        return toolError(`Error searching the project: ${error instanceof Error ? error.message : String(error)}. Nothing was returned.`);
      }
    },
  );
}
