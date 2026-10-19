/**
 * Bulk forms of the instance tools (#ISSUE): add_instances_to_layout,
 * update_instances and delete_instances_from_layout. Each takes one layout
 * and a list of items and applies them in order to the layout in memory
 * through the single tools' own code (instanceOperations, layout-tools.ts).
 * When an item is refused, or a step throws, the call is refused before
 * anything is written, naming the item; otherwise the layout is written
 * once (writeEntityOrRollBack: a failed write is rolled back). dryRun
 * applies the items and writes nothing.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Layout } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { mergeUnscannedReports, unscannedFields, type UnscannedFileReport } from '../construct3/analyzers/unscanned-uses.js';
import { readFamiliesForInstances } from '../construct3/instance-behaviors.js';
import {
  instanceOperations,
  placeInstanceShape,
  type FamiliesForInstances,
  type PlacementType,
} from './layout-tools.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { withProjectSync } from './project-sync.js';

type Reader = MutationToolDeps['reader'];

/**
 * Most items one bulk call takes: a guard on the size of one request and
 * its result (each item may carry up to 50KB of property values and 50KB
 * of behavior values, and the result lists every item). The size of a
 * layout is bounded by the writer instead: it refuses a file whose text
 * as written is over the file size limit, before anything is written.
 */
export const MAX_BULK_INSTANCES = 500;

/** An error's message without its final full stop. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

/** A bulk call's refusal for item `index`: its message, ending once with "Nothing was changed." */
export function bulkItemRefusal(index: number, message: string): string {
  const core = message.replace(/\s*Nothing was changed\.\s*$/, '').trimEnd();
  return `Item ${index}: ${core}${/[.!?]$/.test(core) ? '' : '.'} Nothing was changed.`;
}

/** The refusal when a step outside the items throws before anything was written. */
export function stoppedBeforeWrite(error: unknown): string {
  return `The change was stopped before anything was written: ${messageOf(error)}. Nothing was changed.`;
}

/**
 * The layout a bulk call writes, by its registered name: a name in another
 * letter case is refused (a case-blind file system would read the file,
 * and the write would name it as given), and so is a layout file that
 * cannot be read. Every refusal ends with "Nothing was changed.".
 */
export async function readRegisteredLayout(reader: Reader, layoutName: string): Promise<{ layout: Layout } | { refusal: string }> {
  let registered: string[];
  try {
    registered = await reader.listLayouts();
  } catch (error) {
    return { refusal: stoppedBeforeWrite(error) };
  }
  if (!registered.includes(layoutName)) {
    const sameIgnoringCase = registered.find(n => n.toLowerCase() === layoutName.toLowerCase());
    if (sameIgnoringCase !== undefined) {
      return { refusal: `Layout "${layoutName}" not found: names are matched with their letter case. Did you mean "${sameIgnoringCase}"? Nothing was changed.` };
    }
    const notFound = notFoundError('Layout', layoutName, reader.findNearestName(layoutName, 'layouts'), 'list_layouts').content[0].text;
    return { refusal: `${notFound} Nothing was changed.` };
  }
  let layout: unknown;
  try {
    layout = await reader.readLayout(layoutName);
  } catch (error) {
    return { refusal: `Cannot read layout "${layoutName}": ${messageOf(error)}. Nothing was changed.` };
  }
  // A file of valid JSON that is not an object (null, a number) parses, and every item step would throw on it
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
    return { refusal: `Cannot read layout "${layoutName}": it does not hold a layout object. Nothing was changed.` };
  }
  return { layout: layout as Layout };
}

/**
 * Apply `step` to each item in order. The first item it refuses, or that
 * throws, refuses the whole call with that item's index; nothing has been
 * written then.
 */
export async function applyItems<T, R extends object>(
  items: readonly T[], step: (item: T, index: number) => Promise<R | { error: string }>,
): Promise<{ done: R[] } | { refusal: string }> {
  const done: R[] = [];
  for (const [index, item] of items.entries()) {
    let outcome: R | { error: string };
    try {
      outcome = await step(item, index);
    } catch (error) {
      return { refusal: bulkItemRefusal(index, messageOf(error)) };
    }
    if ('error' in outcome && typeof outcome.error === 'string') return { refusal: bulkItemRefusal(index, outcome.error) };
    done.push(outcome as R);
  }
  return { done };
}

/** Each warning once, with the items that gave it: "Item 2: ..." or "Items 0, 1: ...". */
function itemWarnings(byItem: ReadonlyArray<{ index: number; warnings: readonly string[] }>): string[] {
  const items = new Map<string, number[]>();
  for (const { index, warnings } of byItem) for (const w of warnings) items.set(w, [...(items.get(w) ?? []), index]);
  return [...items].map(([warning, indexes]) => {
    const shown = indexes.length > 5 ? `${indexes.slice(0, 5).join(', ')} and ${indexes.length - 5} more` : indexes.join(', ');
    return `${indexes.length === 1 ? 'Item' : 'Items'} ${shown}: ${warning}`;
  });
}

/** Register add_instances_to_layout, update_instances and delete_instances_from_layout. */
export function registerBulkInstanceTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);
  const ops = instanceOperations({ reader, idGen });

  /**
   * The result of a call whose items all applied: written once (rolled back
   * on a failure), or, for a dry run, the write's own checks run
   * (checkEntityWrite) and nothing written. A refusal of those checks is
   * returned as a refusal in both cases, before anything is written.
   */
  async function finishBulk(
    layoutName: string, layout: Layout, dryRun: boolean,
    results: Array<Record<string, unknown>>, warnings: string[], unscanned: readonly UnscannedFileReport[], dryRunNote?: string,
  ) {
    const base = {
      success: true,
      entity: layoutName,
      category: 'layout',
      count: results.length,
      results,
      warnings: warnings.length > 0 ? warnings : undefined,
      ...unscannedFields(mergeUnscannedReports(unscanned)),
    };
    try {
      await writer.checkEntityWrite('layouts', layoutName, layout, writer.getSubfolderForEntity('layouts', layoutName));
    } catch (error) {
      return toolError(stoppedBeforeWrite(error));
    }
    if (dryRun) {
      return toolResult({ ...base, action: 'dry-run', dryRun: true, message: `Nothing was written.${dryRunNote ? ` ${dryRunNote}` : ''}` });
    }
    let backupPath: string;
    try {
      backupPath = await writeEntityOrRollBack(writer, 'layouts', layoutName, layout);
    } catch (error) {
      // writeEntityOrRollBack's message says what is on disk
      console.error(`[bulk ${layoutName}] write failed:`, error);
      return toolError(`Error writing layout "${layoutName}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return toolResult({ ...base, action: 'updated', backupFile: backupPath });
  }

  const bulkDryRun = z.boolean().optional().default(false)
    .describe('Check every item and apply it to the layout in memory, report the results, and write nothing (default: false)');

  // ─── add_instances_to_layout ──────────────────────────────

  server.tool(
    'add_instances_to_layout',
    `Place many object instances on one layout in one call: each item takes add_instance_to_layout's arguments without layoutName and is placed as that tool places it, in list order. Every item is checked and placed in memory first; if one is refused, nothing is changed and the message names the item by its 0-based index. Otherwise the layout file is written once; a failed write is rolled back, and the error names any file that could not safely be put back. Up to ${MAX_BULK_INSTANCES} items; a layout whose file would pass the file size limit is refused, in a dry run too.`,
    {
      layoutName: z.string().max(200).describe('Target layout (its name as registered, in that letter case)'),
      instances: z.array(z.object(placeInstanceShape)).min(1).max(MAX_BULK_INSTANCES)
        .describe('Instances to place, in order; each is an add_instance_to_layout call without layoutName'),
      dryRun: bulkDryRun,
    },
    async (args) => {
      try {
        const read = await readRegisteredLayout(reader, args.layoutName);
        if ('refusal' in read) return toolError(read.refusal);
        const { layout } = read;

        // No families when they cannot be read, as for add_instance_to_layout (readFamiliesForInstances never rejects)
        const families: FamiliesForInstances = await readFamiliesForInstances(reader);
        const types = new Map<string, PlacementType | { error: string }>();
        const applied = await applyItems(args.instances, async (item, index) => {
          let type = types.get(item.objectType);
          if (!type) {
            type = await ops.readPlacementType(item.objectType);
            types.set(item.objectType, type);
          }
          if ('error' in type) return type;
          const placed = await ops.placeInstance(layout, args.layoutName, item, type, families);
          if ('error' in placed) return placed;
          return { index, objectType: item.objectType, ...placed };
        });
        if ('refusal' in applied) return toolError(applied.refusal);

        return await finishBulk(args.layoutName, layout, args.dryRun,
          applied.done.map(p => ({ index: p.index, objectType: p.objectType, uid: p.uid, sid: p.sid })),
          itemWarnings(applied.done),
          applied.done.flatMap(p => p.unscanned),
          'The UIDs and SIDs shown were taken for this preview only; a call without dryRun gives new ones.');
      } catch (error) {
        // The write's failures are answered in finishBulk: what reaches here was thrown before anything was written
        console.error('[add_instances_to_layout] failed:', error);
        return toolError(stoppedBeforeWrite(error));
      }
    }
  );
}
