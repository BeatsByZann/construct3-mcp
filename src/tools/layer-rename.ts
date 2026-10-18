/**
 * rename_layer: rename a layer in one or more layouts in one call, with the
 * "layer" parameters that name it (#ISSUE). It shares update_layer's layer
 * lookup, reference plan (planLayerReferences) and failure rollback
 * (rollBackLayerRename), which stay in layout-tools.ts.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Layout, Layer } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { findNameClash } from '../construct3/names.js';
import { findLayerNameClash, findLayersByName, layerNameKey } from '../construct3/layers.js';
import { unscannedFields } from '../construct3/analyzers/unscanned-uses.js';
import { StaleFileError } from '../construct3/disk-state.js';
import { withProjectSync } from './project-sync.js';
import { layerNameClashError, listUses, planLayerReferences, resolveLayer, rollBackLayerRename } from './layout-tools.js';

/**
 * The layer rename_layer renames in one layout: the one update_layer finds
 * (resolveLayer: the exact name, or a sub-layer by its path), else the one
 * whose name differs from `layerName` only in letter case, which the editor
 * takes for the same name (so "HUD" in one layout and "hud" in another are
 * renamed together).
 */
function layerToRename(layout: Layout, layerName: string, layoutName: string): { layer: Layer } | { error: string } {
  const resolved = resolveLayer(layout, layerName, layoutName);
  if (!('error' in resolved)) return { layer: resolved.entry.layer };
  const variant = findLayersByName(layout.layers, layerName).length === 0 ? findLayerNameClash(layout.layers, layerName) : undefined;
  return variant ? { layer: variant.layer } : resolved;
}

/** Register rename_layer. */
export function registerLayerRenameTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  // ─── rename_layer ─────────────────────────────────────────

  server.tool(
    'rename_layer',
    'Rename a layer in one or more layouts in one call. The "layer" parameters of conditions and actions that are exactly the quoted '
      + 'old name (ignoring case) are pointed at the new name when every layout with a layer of the old name is renamed in the call, '
      + 'since a layer parameter names a layer of whatever layout runs the event sheet; otherwise they, and other strings that name '
      + 'the layer, are listed in a warning and never changed. dryRun reports the files it would write and changes nothing. When a '
      + 'write fails, the files the call wrote are rolled back, except one another write changed since.',
    {
      layoutNames: z.array(z.string().max(200)).min(1).max(200)
        .describe('Layouts whose layer of this name is renamed; list every layout that has the layer to have the event parameters updated'),
      layerName: z.string().max(200)
        .describe('Current layer name, also matched ignoring case (a sub-layer can also be given by its path, e.g. "Main > HUD")'),
      newName: z.string().min(1).max(200)
        .describe('New layer name (must not match another layer of any of these layouts, sub-layers included, ignoring case)'),
      updateReferences: z.boolean().optional().default(true)
        .describe('Point the "layer" parameters whose whole expression is the quoted old name at the new name, when no other layout has a layer of the old name (default: true)'),
      dryRun: z.boolean().optional().default(false).describe('Report what would change and write nothing (default: false)'),
    },
    async (args) => {
      try {
        // Each layout once, by its registered name (the editor compares layout names ignoring case)
        const registered = await reader.listLayouts();
        const layoutNames: string[] = [];
        for (const requested of args.layoutNames) {
          const name = findNameClash(requested, registered);
          if (name === undefined) {
            return notFoundError('Layout', requested, reader.findNearestName(requested, 'layouts'), 'list_layouts');
          }
          if (!layoutNames.includes(name)) layoutNames.push(name);
        }

        // Every layout's layer and the clash check, before anything is written
        const targets: Array<{ name: string; layout: Layout; layer: Layer }> = [];
        for (const name of layoutNames) {
          let layout: Layout;
          try {
            layout = await reader.readLayout(name);
          } catch (error) {
            return toolError(`Layout "${name}" could not be read: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
          }
          const found = layerToRename(layout, args.layerName, name);
          if ('error' in found) return toolError(`${found.error} Nothing was changed.`);
          const clash = findLayerNameClash(layout.layers, args.newName, found.layer);
          if (clash) return toolError(`${layerNameClashError(args.newName, clash, name)} Nothing was changed.`);
          targets.push({ name, layout, layer: found.layer });
        }

        const oldName = String(targets[0].layer.name);
        const renamed = targets.filter(t => t.layer.name !== args.newName);
        if (renamed.length === 0) {
          return toolError(`The layer is already named "${args.newName}" in ${listUses(layoutNames.map(n => `"${n}"`))}. Nothing was changed.`);
        }
        for (const target of renamed) target.layer.name = args.newName;
        // A rename that only changes the letter case breaks no reference: the editor looks layer names up ignoring case
        const references = layerNameKey(oldName) !== layerNameKey(args.newName)
          ? await planLayerReferences(reader, layoutNames, oldName, args.newName, args.updateReferences, args.dryRun)
          : undefined;
        const files = [
          ...renamed.map(t => reader.getEntityRelativePath('layouts', t.name)),
          ...[...(references?.rewrites.keys() ?? [])].map(sheet => reader.getEntityRelativePath('eventSheets', sheet)),
        ];
        const warnings = references?.warnings ?? [];
        const common = {
          success: true,
          entity: oldName,
          category: 'layer',
          newName: args.newName,
          layouts: renamed.map(t => t.name),
          warnings: warnings.length > 0 ? warnings : undefined,
          ...(references ? unscannedFields(references.unscanned) : {}),
        };

        if (args.dryRun) return toolResult({ ...common, action: 'rename_preview', dryRun: true, wouldWrite: files });

        // The layouts first, then the event sheets; when a write fails, what the call wrote is rolled back.
        // A write refused because its file changed on disk during the call (StaleFileError) has had the writer do so already
        try {
          for (const target of renamed) {
            await writer.writeEntityFile('layouts', target.name, target.layout, writer.getSubfolderForEntity('layouts', target.name));
          }
          for (const [sheetName, sheet] of references?.rewrites ?? []) {
            await writer.writeEntityFile('eventSheets', sheetName, sheet, writer.getSubfolderForEntity('eventSheets', sheetName));
          }
        } catch (error) {
          if (error instanceof StaleFileError) throw error;
          throw new Error(await rollBackLayerRename(writer, error, 'the layouts'));
        }

        return toolResult({ ...common, action: 'renamed', filesWritten: files });
      } catch (error) {
        console.error('[rename_layer] failed:', error);
        return toolError(`Error renaming layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
