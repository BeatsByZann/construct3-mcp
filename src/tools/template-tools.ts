/**
 * Instance template tools: list_templates. A template is a layout instance
 * the editor treats as the master copy of its replicas; the state is the
 * instance's `template` block (construct3/instance-templates.ts).
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Instance, Layout } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { withProjectSync } from './project-sync.js';
import { unregisteredNameMessage } from './registered-names.js';
import { unscannedFilesOf, type UnscannedFile } from '../construct3/analyzers/unscanned-uses.js';
import { forEachLayoutInstance } from '../construct3/layers.js';
import { readTemplate, templateKey } from '../construct3/instance-templates.js';

type Reader = MutationToolDeps['reader'];

/**
 * Every registered layout the reader parses (shared with other callers:
 * only read it), and the registered layouts it could not parse, which a
 * search for templates cannot see.
 */
async function layoutsForSearch(reader: Reader): Promise<{ layouts: Map<string, Layout>; skipped: UnscannedFile[] }> {
  const layouts = new Map(await reader.readAllLayouts());
  const skipped = unscannedFilesOf('layouts', await reader.listLayouts(), layouts, reader.getReadFailures('layouts'));
  return { layouts, skipped };
}

/** A warning that names the layouts a search could not read ("layouts/Big (not valid JSON)"), or none. */
function skippedWarnings(skipped: readonly UnscannedFile[], consequence: string): string[] {
  if (skipped.length === 0) return [];
  return [`${consequence} Layouts that could not be parsed: ${skipped.map(f => `${f.file} (${f.reason})`).join(', ')}.`];
}

/** The most orphaned replicas one result lists. */
const ORPHAN_LIST_LIMIT = 50;

/** The text with every absolute path (drive, UNC or rooted) replaced, from its start to the end of the line or a quote. */
function withoutAbsolutePaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^"'\r\n]*/g, '(path removed)')
    .replace(/\\\\[^"'\r\n]*/g, '(path removed)')
    .replace(/(?<![\w.])\/(?:[\w.-]+\/)+[^"'\r\n]*/g, '(path removed)');
}

/** Register list_templates. */
export function registerTemplateTools({ server: mcpServer, reader }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  // ─── list_templates ───────────────────────────────────────

  server.tool(
    'list_templates',
    'List every instance template in the project: the layout, UID and object type of each template instance, and how many replicas point at it. Layouts that could not be parsed are named (unscannedFiles, complete: false): templates in them are not listed.',
    {
      objectType: z.string().max(200).optional().describe('Only list templates for this object type (its name as registered, in that letter case)'),
    },
    async (args) => {
      try {
        if (args.objectType !== undefined) {
          const missing = unregisteredNameMessage('Object', args.objectType, await reader.listObjectTypes(),
            () => reader.findNearestName(args.objectType!, 'objects'), 'list_objects');
          if (missing !== undefined) return toolError(missing);
        }
        const { layouts, skipped } = await layoutsForSearch(reader);

        interface Row { templateName: string; objectType: string; layout: string; uid: number; replicaCount: number }
        interface Replica { objectType: string; layout: string; uid: number; sourceTemplateName: string }
        const templates: Row[] = [];
        const replicas: Replica[] = [];
        for (const layoutName of await reader.listLayouts()) {
          forEachLayoutInstance(layouts.get(layoutName), (instance: Instance) => {
            const block = readTemplate(instance);
            if (!block || (args.objectType !== undefined && instance.type !== args.objectType)) return;
            if (block.mode === 'template' && block.templateName) {
              templates.push({ templateName: block.templateName, objectType: instance.type, layout: layoutName, uid: instance.uid, replicaCount: 0 });
            } else if (block.mode === 'replica' && block.sourceTemplateName) {
              replicas.push({ objectType: instance.type, layout: layoutName, uid: instance.uid, sourceTemplateName: block.sourceTemplateName });
            }
          });
        }
        // A replica names its source template, not the source's UID: counted per (object type, name), names compared as templateKey does (exactly, like sameTemplateName)
        const counts = new Map<string, number>();
        for (const r of replicas) {
          const key = templateKey(r.objectType, r.sourceTemplateName);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const row of templates) row.replicaCount = counts.get(templateKey(row.objectType, row.templateName)) ?? 0;
        const known = new Set(templates.map(row => templateKey(row.objectType, row.templateName)));
        const orphans = replicas.filter(r => !known.has(templateKey(r.objectType, r.sourceTemplateName)));

        const cut = orphans.length > ORPHAN_LIST_LIMIT;
        const warnings = [
          ...skippedWarnings(skipped, 'Templates and replicas in these layouts are not listed, so counts and orphans may be wrong.'),
          ...(cut ? [`Only the first ${ORPHAN_LIST_LIMIT} of ${orphans.length} orphaned replicas are listed.`] : []),
        ];

        return toolResult({
          templates,
          count: templates.length,
          // A replica whose template instance was not found in the layouts that could be read
          orphanedReplicas: orphans.length > 0 ? orphans.slice(0, ORPHAN_LIST_LIMIT) : undefined,
          orphanedReplicaCount: orphans.length > 0 ? orphans.length : undefined,
          orphanedReplicasTruncated: cut ? true : undefined,
          ...(skipped.length > 0 ? { complete: false, unscannedFiles: skipped.map(({ file, reason }) => ({ file, reason })) } : {}),
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } catch (error) {
        console.error('[list_templates] failed:', error);
        return toolError(`Error listing templates: ${withoutAbsolutePaths(error instanceof Error ? error.message : String(error))}`);
      }
    }
  );
}
