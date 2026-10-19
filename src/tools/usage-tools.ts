/**
 * MCP tools that answer "where is this used" and "what does the project hold"
 * from the project's files without changing anything: project properties and
 * instance counts, and the helpers every usage query shares for saying how
 * complete its answer is.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Construct3ProjectReader, EntityCategory } from '../construct3/project-reader.js';
import { getProjectIndex, type ProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  checkUnscannedFiles,
  unscannedFields,
  type UnscannedFile,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import type { RawTextTerm } from '../construct3/raw-text-search.js';
import { nameKey } from '../construct3/names.js';
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
}
