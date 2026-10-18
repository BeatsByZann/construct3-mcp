/**
 * Hierarchy link tools (#ISSUE): set_instance_parent and
 * remove_instance_children. The link functions are in
 * construct3/hierarchy.ts; these tools read the layout, apply one, and
 * write the layout once (a failed write is rolled back,
 * rollBackFailedCall).
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Layout } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import {
  PREVIEW_FOR_NEW_RECORD,
  blankPreviewLike,
  linkInstances,
  sceneGraphOf,
  unlinkChildren,
  unlinkInstance,
  type LinkFlags,
} from '../construct3/hierarchy.js';
import { findInstanceByUid, forEachLayoutInstance } from '../construct3/layers.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { withProjectSync } from './project-sync.js';

/** `message` as a refusal, ending with "Nothing was changed." */
function refusal(message: string): ReturnType<typeof toolError> {
  return toolError(`${message}${message.endsWith('.') ? '' : '.'} Nothing was changed.`);
}

/** Register set_instance_parent and remove_instance_children. */
export function registerHierarchyTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  /** Write the layout once; a failed write is rolled back and its message thrown (writeEntityOrRollBack). */
  const writeLayout = (layoutName: string, layout: Layout): Promise<string> =>
    writeEntityOrRollBack(writer, 'layouts', layoutName, layout);

  /** The warning for entries of instances that listed the child without the child naming them. */
  function staleEntriesWarning(childUid: number, listers: readonly number[]): string {
    return `Removed UID ${childUid} from the children of UID ${listers.join(', ')}, which listed it although it did not name them as its parent (a one-sided link, child-not-linked in validate_project).`;
  }

  /**
   * The preview a new record gets: the keys of the first record with a
   * preview in the project's layouts (numbers 0, booleans false), else
   * PREVIEW_FOR_NEW_RECORD.
   */
  async function previewForNewRecords(): Promise<Readonly<Record<string, unknown>> | undefined> {
    for (const layout of (await reader.readAllLayouts()).values()) {
      const previews: unknown[] = [];
      forEachLayoutInstance(layout, instance => {
        previews.push(sceneGraphOf(instance)?.preview);
      });
      const sample = previews.map(blankPreviewLike).find(preview => preview !== undefined);
      if (sample) return sample;
    }
    return PREVIEW_FOR_NEW_RECORD;
  }

  // ─── set_instance_parent ──────────────────────────────────

  server.tool(
    'set_instance_parent',
    'Make a placed instance the hierarchy child of another one in the same layout, or with parentUid null take it off its '
      + 'parent. Both sides of the link are written: the child\'s sceneGraphData names the parent, the parent lists the '
      + 'child. A child with another parent leaves that one. An existing link keeps its flags; given flags go over them, and '
      + 'a child without a hierarchy record (or a record without flags) gets the flags Construct 3 r495.2 saves for a record (one editor-saved project checked). Refuses a link '
      + 'that would close a loop, an instance that is not on a layer, and a UID that several instances of the layout have.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      childUid: z.number().int().describe('UID of the instance that becomes (or stops being) the child'),
      parentUid: z.number().int().nullable().describe('UID of the parent instance; null takes the child off its parent'),
      flags: z.object({
        x: z.boolean().optional(), y: z.boolean().optional(), z: z.boolean().optional(),
        w: z.boolean().optional(), h: z.boolean().optional(), a: z.boolean().optional(),
        o: z.boolean().optional(), v: z.boolean().optional(), d: z.boolean().optional(),
        sm: z.string().max(50).optional(),
      }).strict().optional()
        .describe('Flags of the link as the layout file saves them (booleans x, y, z, w, h, a, o, v, d and the mode sm), written over the link\'s saved flags, or over the defaults for a child without a hierarchy record (or a record without flags); other keys a saved link has are kept, unknown keys given here are refused'),
    },
    async (args) => {
      try {
        if (args.parentUid === null && args.flags !== undefined) return refusal('flags belong to a link: give a parentUid with them');
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const common = { success: true, entity: args.layoutName, category: 'layout', childUid: args.childUid, parentUid: args.parentUid };

        if (args.parentUid === null) {
          const unlinked = unlinkInstance(layout, args.childUid);
          if ('error' in unlinked) return refusal(unlinked.error);
          if (unlinked.previousParent === undefined && unlinked.staleEntries === undefined) {
            return toolResult({ ...common, action: 'unchanged', message: `UID ${args.childUid} has no hierarchy parent.` }, { projectWritten: false });
          }
          const backupPath = await writeLayout(args.layoutName, layout);
          return toolResult({
            ...common, action: 'updated',
            ...(unlinked.previousParent !== undefined ? { previousParentUid: unlinked.previousParent } : {}),
            ...(unlinked.staleEntries ? { staleEntries: unlinked.staleEntries } : {}),
            backupFile: backupPath,
            warnings: unlinked.staleEntries ? [staleEntriesWarning(args.childUid, unlinked.staleEntries)] : undefined,
          });
        }

        // Only the keys the caller set: linkInstances puts them over the link's saved flags (or the defaults for a new record)
        const given: LinkFlags = {};
        for (const [key, value] of Object.entries(args.flags ?? {})) {
          if (value !== undefined) given[key] = value;
        }
        const parentUid = args.parentUid;
        const needsRecord = [args.childUid, parentUid].some(uid => !sceneGraphOf(findInstanceByUid(layout, uid)?.instance));
        const preview = needsRecord ? await previewForNewRecords() : undefined;
        const link = linkInstances(layout, args.childUid, parentUid, given, preview);
        if ('error' in link) return refusal(link.error);
        if (!link.changed) return toolResult({ ...common, flags: link.flags, action: 'unchanged' }, { projectWritten: false });

        const warnings = [
          ...(link.previousParent !== undefined ? [`Took UID ${args.childUid} off its previous parent, UID ${link.previousParent}.`] : []),
          ...(link.staleEntries ? [staleEntriesWarning(args.childUid, link.staleEntries)] : []),
        ];
        const backupPath = await writeLayout(args.layoutName, layout);
        return toolResult({
          ...common, flags: link.flags, action: 'updated',
          ...(link.previousParent !== undefined ? { previousParentUid: link.previousParent } : {}),
          ...(link.staleEntries ? { staleEntries: link.staleEntries } : {}),
          ...(link.createdRecords.length > 0 ? { createdRecords: link.createdRecords } : {}),
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[set_instance_parent] failed:', error);
        return toolError(`Error setting the hierarchy parent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_instance_children ─────────────────────────────

  server.tool(
    'remove_instance_children',
    'Take every hierarchy child off a placed instance: each child it lists that names it as its parent, and each instance that '
      + 'names it as its parent without being listed (a one-sided link), gets none, and the instance no longer lists children. '
      + 'Entries that name no instance of the layout, or a child of another parent, are removed and listed.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      parentUid: z.number().int().describe('UID of the instance whose children are detached'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }
        const result = unlinkChildren(layout, args.parentUid);
        if ('error' in result) return refusal(result.error);
        const common = { success: true, entity: args.layoutName, category: 'layout', parentUid: args.parentUid, detached: result.detached };
        if (result.detached.length + result.unlisted.length + result.missing.length + result.otherParent.length === 0) {
          return toolResult({ ...common, action: 'unchanged', message: `UID ${args.parentUid} has no hierarchy children.` }, { projectWritten: false });
        }
        const warnings = [
          ...(result.unlisted.length > 0
            ? [`UID ${result.unlisted.join(', ')} named UID ${args.parentUid} as their parent without being listed as its children (a one-sided link); they were detached too.`]
            : []),
          ...(result.missing.length > 0 ? [`Removed child entries whose UID ${result.missing.join(', ')} names no instance of the layout.`] : []),
          ...(result.otherParent.length > 0
            ? [`Removed the entries of UID ${result.otherParent.join(', ')}, which name another parent or none; their own records were left as they are.`]
            : []),
        ];
        const backupPath = await writeLayout(args.layoutName, layout);
        return toolResult({
          ...common, action: 'updated',
          ...(result.unlisted.length > 0 ? { unlisted: result.unlisted } : {}),
          ...(result.missing.length > 0 ? { missing: result.missing } : {}),
          ...(result.otherParent.length > 0 ? { otherParent: result.otherParent } : {}),
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[remove_instance_children] failed:', error);
        return toolError(`Error removing hierarchy children: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
