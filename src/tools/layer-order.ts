/**
 * Layer and instance order tools (#ISSUE): reorder_layers, move_layer,
 * move_instance. A layout's layers, each layer's sub-layers and each
 * layer's instances are arrays in the layout file; these tools change the
 * order of those arrays and move an entry from one to another, in one
 * layout. Layers are found as update_layer finds them (resolveLayer: the
 * exact name, or a sub-layer by its path, "Main > HUD"). Each tool writes
 * the layout once, and a failed write is rolled back (rollBackFailedCall).
 * A "layer" parameter can also name a layer by a number
 * (layer-references.ts), which may count layers by their position: a
 * change of the order lists such parameters and never changes them.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { EventSheet, Layer, Layout } from '../construct3/types.js';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { findInstanceByUid, findLayersByName, forEachLayoutInstance, layerPathLabel, type LayerEntry } from '../construct3/layers.js';
import { unscannedFilesOf } from '../construct3/analyzers/unscanned-uses.js';
import { resolveLayer } from './layout-tools.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { withProjectSync } from './project-sync.js';

/** `message` as a refusal, ending with "Nothing was changed." */
function refusal(message: string): ReturnType<typeof toolError> {
  return toolError(`${message}${message.endsWith('.') ? '' : '.'} Nothing was changed.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The layer as update_layer finds it (resolveLayer); for a name several
 * layers share, an error that points to the sub-layer path without
 * resolveLayer's advice to rename with update_layer, which does not fit a
 * move or a reorder.
 */
function findLayer(layout: Layout, layerName: string, layoutName: string): { entry: LayerEntry } | { error: string } {
  const resolved = resolveLayer(layout, layerName, layoutName);
  const matches = findLayersByName(layout.layers, layerName);
  if (!('error' in resolved) || matches.length < 2) return resolved;
  return {
    error: `Layer name "${layerName}" is used by ${matches.length} layers in layout "${layoutName}" (${matches.map(layerPathLabel).join('; ')}). `
      + 'Give a sub-layer by its path to pick one (e.g. "Main > HUD"), where the paths tell them apart',
  };
}

/** The first few items and how many more there are. */
function listSome(items: string[], max = 5): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * A "layer" parameter that is not one quoted string, so it may be a layer
 * number (Revision 3): a number literal in any form ("1", "1.0", "+1",
 * "1e0", " 1 "), or any other expression (a variable, arithmetic), which
 * may evaluate to one. A quoted name is a name (layer-references.ts:4-8).
 */
function mayBeLayerNumber(expression: string): boolean {
  return !/^\s*"(?:[^"]|"")*"\s*$/.test(expression) && expression.trim() !== '';
}

/** Conditions and actions whose "layer" parameter may be a layer number, in the parsed event sheets: '"Sheet" events[2] action 0 ("1.0")'. */
function layerNumberUses(sheets: ReadonlyMap<string, EventSheet>): string[] {
  const found: string[] = [];
  for (const [sheetName, sheet] of sheets) {
    const stack: Array<{ events: unknown; path: string }> = [{ events: sheet?.events, path: 'events' }];
    while (stack.length > 0) {
      const { events, path } = stack.pop()!;
      if (!Array.isArray(events)) continue;
      events.forEach((event: unknown, i) => {
        if (!isRecord(event)) return;
        const eventPath = `${path}[${i}]`;
        for (const kind of ['conditions', 'actions'] as const) {
          const aces = event[kind];
          if (!Array.isArray(aces)) continue;
          aces.forEach((ace: unknown, j) => {
            const layer = isRecord(ace) && isRecord(ace.parameters) ? ace.parameters.layer : undefined;
            if (typeof layer === 'string' && mayBeLayerNumber(layer)) {
              found.push(`"${sheetName}" ${eventPath} ${kind === 'conditions' ? 'condition' : 'action'} ${j} (${layer.trim().slice(0, 40)})`);
            }
          });
        }
        stack.push({ events: event.children, path: `${eventPath}.children` });
      });
    }
  }
  return found;
}

/**
 * The warnings of a change to a layout's layer order: "layer" parameters
 * given as a number (never changed), and event sheets the reader could not
 * parse, which were not searched for them.
 */
async function layerNumberWarnings(reader: Construct3ProjectReader): Promise<string[]> {
  const sheets = await reader.readAllEventSheets();
  const uses = layerNumberUses(sheets);
  const unparsed = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, reader.getReadFailures('eventSheets'));
  return [
    ...(uses.length > 0
      ? [`${uses.length} "layer" parameter(s) are a number or an expression that may give one, which may count layers by their position, and this call `
        + `changed the positions; they were NOT changed: ${listSome(uses)}. Check that they still name the layer they should.`]
      : []),
    ...(unparsed.length > 0
      ? [`Event sheet(s) that could not be parsed were not searched for layer numbers: ${listSome(unparsed.map(f => f.file))}.`]
      : []),
  ];
}

/** How many instances of the layout (layers, sub-layers and non-world) have this UID. */
function instancesWithUid(layout: Layout, uid: number): number {
  let count = 0;
  forEachLayoutInstance(layout, instance => {
    if (instance.uid === uid) count++;
  });
  return count;
}

/** A level of the layer tree in results: the parent layer's path, or null for the layout's own layers. */
function levelOf(parent: LayerEntry | undefined): string | null {
  return parent ? layerPathLabel(parent) : null;
}

const quoted = (names: readonly string[]) => names.map(n => `"${n}"`).join(', ');

/** Register reorder_layers, move_layer and move_instance. */
export function registerLayerOrderTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  /** Write the layout once; a failed write is rolled back and its message thrown (writeEntityOrRollBack). */
  const writeLayout = (layoutName: string, layout: Layout): Promise<string> =>
    writeEntityOrRollBack(writer, 'layouts', layoutName, layout);

  // ─── reorder_layers ───────────────────────────────────────

  server.tool(
    'reorder_layers',
    'Put the layers of one level of a layout in a new order: the layout\'s own layers, or the sub-layers of one layer. '
      + 'layerNames lists every layer of that level once, first to last (index 0 first, as add_layer counts); sub-layers '
      + 'and instances stay with their layer. "layer" parameters of conditions and actions given as a number or another expression than a quoted name may count layers '
      + 'by their position: they are listed in a warning and never changed.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerNames: z.array(z.string().max(200)).min(1).max(500)
        .describe('Every layer of the level, each once and with its exact name, in the new order (first to last)'),
      parentLayer: z.string().max(200).optional()
        .describe('Reorder the sub-layers of this layer (a sub-layer can be given by its path, e.g. "Main > HUD"); default: the layout\'s own layers'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        let parent: LayerEntry | undefined;
        if (args.parentLayer !== undefined) {
          const resolved = findLayer(layout, args.parentLayer, args.layoutName);
          if ('error' in resolved) return refusal(resolved.error);
          parent = resolved.entry;
        }
        const siblings: Layer[] = parent
          ? (Array.isArray(parent.layer.subLayers) ? parent.layer.subLayers : [])
          : layout.layers;
        const scope = parent ? `the sub-layers of "${layerPathLabel(parent)}"` : `layout "${args.layoutName}"`;

        // The level's layers by name: a level whose names repeat cannot be ordered by name
        const current = siblings.map(l => l.name);
        const repeated = [...new Set(current.filter((n, i) => current.indexOf(n) !== i))];
        if (current.some(n => typeof n !== 'string') || repeated.length > 0) {
          return refusal(`The layers of ${scope} cannot be told apart by name (${repeated.length > 0 ? `repeated: ${quoted(repeated)}` : 'a layer has no name'}); `
            + 'rename them first with update_layer');
        }
        const listed = args.layerNames;
        const twice = [...new Set(listed.filter((n, i) => listed.indexOf(n) !== i))];
        const unknown = listed.filter(n => !current.includes(n));
        const missing = current.filter(n => !listed.includes(n));
        if (twice.length > 0 || unknown.length > 0 || missing.length > 0) {
          const problems = [
            ...(missing.length > 0 ? [`missing: ${quoted(missing)}`] : []),
            ...(twice.length > 0 ? [`listed more than once: ${quoted(twice)}`] : []),
            ...(unknown.length > 0 ? [`not at this level: ${quoted(unknown)}`] : []),
          ];
          return refusal(`layerNames must list every layer of ${scope} exactly once (${problems.join('; ')}). `
            + `Current order, first to last: ${quoted(current)}`);
        }

        const common = {
          success: true, entity: args.layoutName, category: 'layout', order: listed,
          ...(parent ? { parentLayer: layerPathLabel(parent) } : {}),
        };
        if (listed.every((n, i) => n === current[i])) {
          return toolResult({ ...common, action: 'unchanged' }, { projectWritten: false });
        }
        const byName = new Map(siblings.map(l => [l.name, l]));
        siblings.splice(0, siblings.length, ...listed.map(n => byName.get(n)!));
        const warnings = await layerNumberWarnings(reader);
        const backupPath = await writeLayout(args.layoutName, layout);
        return toolResult({ ...common, action: 'updated', backupFile: backupPath, warnings: warnings.length > 0 ? warnings : undefined });
      } catch (error) {
        console.error('[reorder_layers] failed:', error);
        return toolError(`Error reordering layers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_layer ───────────────────────────────────────────

  server.tool(
    'move_layer',
    'Move a layer, with its sub-layers and instances, to another place in the same layout: within its level, into the '
      + 'sub-layers of another layer, or to the layout\'s own layers, at an index. Refuses a move into the layer itself or one '
      + 'of its sub-layers. "layer" parameters given as a number or another expression than a quoted name may count layers by their position: they are listed in a '
      + 'warning and never changed.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer to move (a sub-layer can be given by its path, e.g. "Main > HUD")'),
      parentLayer: z.string().max(200).nullable().optional()
        .describe('Layer whose sub-layers it joins (a path is accepted); null: the layout\'s own layers; omitted: its current parent (a move within its level)'),
      index: z.number().int().min(0).optional()
        .describe('Its position at the destination once moved (0 = first, as add_layer counts; default: last)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const resolved = findLayer(layout, args.layerName, args.layoutName);
        if ('error' in resolved) return refusal(resolved.error);
        const moving = resolved.entry;
        const name = layerPathLabel(moving);

        // Omitted: its current parent (a move within its level); null: the layout's own layers
        let destination: LayerEntry | undefined = args.parentLayer === undefined ? moving.parent : undefined;
        if (args.parentLayer !== undefined && args.parentLayer !== null) {
          const found = findLayer(layout, args.parentLayer, args.layoutName);
          if ('error' in found) return refusal(found.error);
          destination = found.entry;
          // Into itself or one of its sub-layers: the branch would hold itself and leave the layout
          for (let e: LayerEntry | undefined = destination; e; e = e.parent) {
            if (e.layer === moving.layer) {
              return refusal(destination.layer === moving.layer
                ? `Cannot move layer "${name}" into itself`
                : `Cannot move layer "${name}" into "${layerPathLabel(destination)}", one of its own sub-layers`);
            }
          }
        }
        const where = destination ? `the sub-layers of "${layerPathLabel(destination)}"` : `the layers of layout "${args.layoutName}"`;
        const target: Layer[] = destination
          ? (Array.isArray(destination.layer.subLayers) ? destination.layer.subLayers : (destination.layer.subLayers = []))
          : layout.layers;
        const sameLevel = target === moving.siblings;
        const highest = sameLevel ? target.length - 1 : target.length;
        const toIndex = args.index ?? highest;
        if (toIndex > highest) {
          return refusal(`index ${toIndex} is out of range: ${where} would hold ${highest + 1} layer(s) with it, so the highest index is ${highest}`);
        }

        const common = {
          success: true, entity: args.layoutName, category: 'layout', layer: name,
          from: { parentLayer: levelOf(moving.parent), index: moving.index },
          to: { parentLayer: destination ? layerPathLabel(destination) : null, index: toIndex },
        };
        if (sameLevel && toIndex === moving.index) {
          return toolResult({ ...common, action: 'unchanged' }, { projectWritten: false });
        }
        moving.siblings.splice(moving.index, 1);
        target.splice(toIndex, 0, moving.layer);
        const warnings = await layerNumberWarnings(reader);
        const backupPath = await writeLayout(args.layoutName, layout);
        return toolResult({ ...common, action: 'updated', backupFile: backupPath, warnings: warnings.length > 0 ? warnings : undefined });
      } catch (error) {
        console.error('[move_layer] failed:', error);
        return toolError(`Error moving layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_instance ────────────────────────────────────────

  server.tool(
    'move_instance',
    'Move a placed instance to another layer or sub-layer of its layout, to another place in its layer\'s instances, or both. '
      + 'A layer keeps its instances in an array: position counts in it, from "first" to "last". '
      + 'Hierarchy links stay as they are.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to move (an instance on a layer or sub-layer)'),
      toLayer: z.string().max(200).optional()
        .describe('Destination layer (a sub-layer can be given by its path, e.g. "Main > HUD"); default: its own layer'),
      position: z.union([z.enum(['first', 'last']), z.number().int().min(0)]).optional()
        .describe('"first", "last" or an index in the destination layer\'s instances once moved; default "last" when it changes layer'),
      afterUid: z.number().int().optional().describe('Place it right after this instance of the destination layer'),
      beforeUid: z.number().int().optional().describe('Place it right before this instance of the destination layer'),
    },
    async (args) => {
      try {
        const placements = [args.position, args.afterUid, args.beforeUid].filter(v => v !== undefined).length;
        if (placements > 1) return refusal('Give at most one of position, afterUid and beforeUid');
        if (placements === 0 && args.toLayer === undefined) return refusal('Nothing to do: give toLayer, position, afterUid or beforeUid');
        if (args.afterUid === args.uid || args.beforeUid === args.uid) return refusal('An instance cannot be placed next to itself');

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const anchor = args.afterUid ?? args.beforeUid;
        for (const uid of anchor === undefined ? [args.uid] : [args.uid, anchor]) {
          const count = instancesWithUid(layout, uid);
          if (count > 1) {
            return refusal(`UID ${uid} is used by ${count} instances of layout "${args.layoutName}" (duplicate-uid in validate_project), `
              + 'so which one is meant cannot be told');
          }
        }
        const found = findInstanceByUid(layout, args.uid);
        if (!found) {
          return refusal(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs`);
        }
        if (!found.entry) return refusal(`Instance ${args.uid} is a non-world instance of layout "${args.layoutName}": it is on no layer`);
        const source = found.entry;
        let target = source;
        if (args.toLayer !== undefined) {
          const resolved = findLayer(layout, args.toLayer, args.layoutName);
          if ('error' in resolved) return refusal(resolved.error);
          target = resolved.entry;
        }
        const sameLayer = target.layer === source.layer;

        // Take it out, then find its place among the destination's instances as they are without it
        const [instance] = found.list.splice(found.index, 1);
        if (!Array.isArray(target.layer.instances)) target.layer.instances = [];
        const list = target.layer.instances;
        let toIndex: number;
        if (anchor !== undefined) {
          const at = list.findIndex(i => i?.uid === anchor);
          if (at === -1) {
            return refusal(`Instance ${anchor} is not on the destination layer "${layerPathLabel(target)}": `
              + 'afterUid and beforeUid name an instance of the destination layer');
          }
          toIndex = args.afterUid !== undefined ? at + 1 : at;
        } else if (args.position === 'first') {
          toIndex = 0;
        } else if (typeof args.position === 'number') {
          if (args.position > list.length) {
            return refusal(`position ${args.position} is out of range: layer "${layerPathLabel(target)}" would hold ${list.length + 1} instance(s), `
              + `so the highest index is ${list.length}`);
          }
          toIndex = args.position;
        } else if (args.position === undefined && sameLayer) {
          toIndex = found.index; // toLayer named its own layer: nothing moves
        } else {
          toIndex = list.length;
        }
        list.splice(toIndex, 0, instance);

        const common = {
          success: true, entity: args.layoutName, category: 'layout', uid: args.uid,
          fromLayer: layerPathLabel(source), fromIndex: found.index,
          toLayer: layerPathLabel(target), toIndex, layerInstanceCount: list.length,
        };
        if (sameLayer && toIndex === found.index) {
          return toolResult({ ...common, action: 'unchanged' }, { projectWritten: false });
        }
        const backupPath = await writeLayout(args.layoutName, layout);
        return toolResult({ ...common, action: 'updated', backupFile: backupPath });
      } catch (error) {
        console.error('[move_instance] failed:', error);
        return toolError(`Error moving instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
