/**
 * Instance template tools: list_templates, set_instance_template and
 * set_default_template. A template is a layout instance the editor treats as
 * the master copy of its replicas; the state is the instance's `template`
 * block (construct3/instance-templates.ts). The default template of an object
 * type is the object type's own pair of fields.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { Instance, Layout, ObjectType, WriteResult } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { withProjectSync } from './project-sync.js';
import { unregisteredNameMessage } from './registered-names.js';
import { nothingChanged } from './event-helpers.js';
import { writeEntityOrRollBack } from './call-rollback.js';
import { classifyReadError } from '../construct3/project-reader.js';
import { unscannedFilesOf, describeReadFailure, type UnscannedFile } from '../construct3/analyzers/unscanned-uses.js';
import { forEachLayoutInstance, findInstanceByUid } from '../construct3/layers.js';
import {
  buildInstanceTemplate, findTemplateInstance, readTemplate, sameTemplateName, templateKey,
} from '../construct3/instance-templates.js';

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

/**
 * What still names a template that a call removes, renames or turns into
 * a replica: the replicas of that name in every layout (`layout`, the
 * edited one, in place of its file) and the object type's default
 * template. Warnings only: what the editor does with such replicas was not
 * observed.
 */
async function endedTemplateWarnings(
  reader: Reader, objectType: string, templateName: string, layoutName: string, layout: Layout,
): Promise<string[]> {
  const search = await layoutsForSearch(reader);
  search.layouts.set(layoutName, layout);
  let replicas = 0;
  for (const searched of search.layouts.values()) {
    forEachLayoutInstance(searched, instance => {
      const block = readTemplate(instance);
      if (instance.type === objectType && block?.mode === 'replica' && sameTemplateName(block.sourceTemplateName, templateName)) replicas += 1;
    });
  }
  const warnings: string[] = [];
  if (replicas > 0) {
    warnings.push(`${replicas} replica(s) of "${objectType}" follow the template "${templateName}", which no instance is any more; `
      + 'list_templates lists them as orphanedReplicas.');
  }
  warnings.push(...skippedWarnings(search.skipped.filter(f => f.name !== layoutName), `Replicas of "${templateName}" in these layouts were not counted.`));
  try {
    const type = await reader.readObjectType(objectType);
    const named = type.editorNewInstanceTemplateName;
    if (named !== undefined && sameTemplateName(named, templateName)) {
      warnings.push(`Object type "${objectType}" creates new instances from the template "${templateName}"; clear or change it with set_default_template.`);
    }
  } catch (error) {
    warnings.push(`Whether object type "${objectType}" creates new instances from "${templateName}" could not be checked (${describeReadFailure(classifyReadError(error))}).`);
  }
  return warnings;
}

/** Register list_templates, set_instance_template and set_default_template. */
export function registerTemplateTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
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

  // ─── set_instance_template ────────────────────────────────

  server.tool(
    'set_instance_template',
    'Make a layout instance a template, a replica of a named template, or neither. The template block is built from the instance\'s own plugin properties, instance variables, behaviors and effects. The layout name must be given as registered, in that letter case. A failed write is rolled back.',
    {
      layoutName: z.string().max(200).describe('Layout holding the instance (as registered, in that letter case)'),
      uid: z.number().int().describe('Instance UID'),
      mode: z.enum(['none', 'template', 'replica']).describe('none removes the template block; template makes this the master; replica links it to a template'),
      templateName: z.string().max(200).optional().describe('Template name; required for mode "template"'),
      sourceTemplateName: z.string().max(200).optional().describe('Name of the template to follow; required for mode "replica"'),
    },
    async (args) => {
      const refuse = (message: string) => toolError(nothingChanged(message));
      try {
        const { layoutName, uid, mode } = args;
        if (mode === 'template' && !args.templateName) return refuse('mode "template" requires templateName.');
        if (mode === 'replica' && !args.sourceTemplateName) return refuse('mode "replica" requires sourceTemplateName.');
        const missing = unregisteredNameMessage('Layout', layoutName, await reader.listLayouts(),
          () => reader.findNearestName(layoutName, 'layouts'), 'list_layouts');
        if (missing !== undefined) return refuse(missing);
        let layout: Layout;
        try {
          layout = await reader.readLayout(layoutName);
        } catch (error) {
          return refuse(`Cannot read layout "${layoutName}" (${describeReadFailure(classifyReadError(error))}).`);
        }
        const found = findInstanceByUid(layout, uid);
        if (!found) return refuse(`No instance with UID ${uid} in layout "${layoutName}". Use get_layout_details to see the instances.`);
        const instance = found.instance as Instance & Record<string, unknown>;

        const warnings: string[] = [];
        const previous = readTemplate(instance);
        let action: string;
        if (mode === 'none') {
          if (!previous) return refuse(`Instance UID ${uid} in layout "${layoutName}" has no template block; nothing to remove.`);
          delete instance.template;
          action = 'template removed';
        } else if (mode === 'template') {
          const templateName = args.templateName!;
          // Two templates of one object type with one name would make every replica of that name ambiguous
          const search = await layoutsForSearch(reader);
          search.layouts.set(layoutName, layout);
          const clash = findTemplateInstance(search.layouts, instance.type, templateName, { layout: layoutName, uid });
          if (clash) {
            return refuse(`Instance UID ${clash.uid} in layout "${clash.layout}" is already a template named "${templateName}" `
              + `for object type "${instance.type}". Template names must be unique per object type.`);
          }
          warnings.push(...skippedWarnings(search.skipped.filter(f => f.name !== layoutName),
            `Whether another instance of "${instance.type}" is already a template named "${templateName}" could not be checked in every layout.`));
          instance.template = buildInstanceTemplate(instance, 'template', templateName, '') as unknown as Record<string, unknown>;
          action = 'template created';
        } else {
          const sourceTemplateName = args.sourceTemplateName!;
          if (previous?.mode === 'template' && sameTemplateName(previous.templateName, sourceTemplateName)) {
            return refuse(`Instance UID ${uid} in layout "${layoutName}" is the template "${previous.templateName}" itself; `
              + 'it cannot be a replica of its own template.');
          }
          const search = await layoutsForSearch(reader);
          search.layouts.set(layoutName, layout);
          // The instance itself cannot be found here: a template of this name it was is refused above
          if (!findTemplateInstance(search.layouts, instance.type, sourceTemplateName)) {
            warnings.push(`No instance of "${instance.type}" is a template named "${sourceTemplateName}". `
              + 'The replica is written anyway; it has no template to follow until one of that name exists.');
            warnings.push(...skippedWarnings(search.skipped.filter(f => f.name !== layoutName), 'The template may be in a layout that could not be checked.'));
          }
          instance.template = buildInstanceTemplate(instance, 'replica', '', sourceTemplateName) as unknown as Record<string, unknown>;
          action = 'replica linked';
        }
        if (previous !== undefined && previous.mode === mode) {
          warnings.push(`The instance's existing ${mode} block was rebuilt from its current properties, instance variables, behaviors and effects; `
            + 'sync settings changed in the editor were reset.');
        }
        // A template this call removes, renames or turns into a replica leaves what named it without a template
        if (previous?.mode === 'template' && !(mode === 'template' && sameTemplateName(previous.templateName, args.templateName!))) {
          warnings.push(...await endedTemplateWarnings(reader, instance.type, previous.templateName, layoutName, layout));
        }
        if (mode !== 'none' && found.entry === undefined) {
          warnings.push(`UID ${uid} is a non-world instance. The block is written, but Construct 3 r506-2 (Free edition, guest) offered no template properties `
            + 'for the Array object type\'s non-world instance and saved it with no template key.');
        }

        let backupPath: string;
        try {
          backupPath = await writeEntityOrRollBack(writer, 'layouts', layoutName, layout);
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
        }
        const result: WriteResult = {
          success: true, entity: `${layoutName}#${uid}`, category: 'template', action,
          warnings: warnings.length > 0 ? warnings : undefined, backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_instance_template] failed:', error);
        return refuse(`Error setting instance template: ${withoutAbsolutePaths(error instanceof Error ? error.message : String(error))}`);
      }
    }
  );

  // ─── set_default_template ─────────────────────────────────

  server.tool(
    'set_default_template',
    'Set or clear the template a new instance of an object type is created from in the editor (editorNewInstanceIsReplica and editorNewInstanceTemplateName on the object type). The object type name must be given as registered, in that letter case. A failed write is rolled back.',
    {
      objectName: z.string().max(200).describe('Object type name (as registered, in that letter case)'),
      templateName: z.string().min(1).max(200).nullable().describe('Template to create new instances from, or null to clear it'),
    },
    async (args) => {
      const refuse = (message: string) => toolError(nothingChanged(message));
      try {
        const missing = unregisteredNameMessage('Object', args.objectName, await reader.listObjectTypes(),
          () => reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        if (missing !== undefined) return refuse(missing);
        let objectType: ObjectType;
        try {
          objectType = await reader.readObjectType(args.objectName);
        } catch (error) {
          return refuse(`Cannot read object type "${args.objectName}" (${describeReadFailure(classifyReadError(error))}).`);
        }
        const warnings: string[] = [];
        if (args.templateName === null) {
          // A cleared default as Construct 3 r506-2 (Free edition, guest) saves it: no name, the flag true.
          delete objectType.editorNewInstanceTemplateName;
          objectType.editorNewInstanceIsReplica = true;
        } else {
          const search = await layoutsForSearch(reader);
          if (!findTemplateInstance(search.layouts, args.objectName, args.templateName)) {
            warnings.push(`No instance of "${args.objectName}" is a template named "${args.templateName}". `
              + 'Create one with set_instance_template first.');
            warnings.push(...skippedWarnings(search.skipped, 'The template may be in a layout that could not be checked.'));
          }
          objectType.editorNewInstanceIsReplica = true;
          objectType.editorNewInstanceTemplateName = args.templateName;
        }
        let backupPath: string;
        try {
          backupPath = await writeEntityOrRollBack(writer, 'objectTypes', args.objectName, objectType);
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
        }
        const result: WriteResult = {
          success: true, entity: args.objectName, category: 'objecttype',
          action: args.templateName === null ? 'default template cleared' : 'default template set',
          warnings: warnings.length > 0 ? warnings : undefined, backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_default_template] failed:', error);
        return refuse(`Error setting default template: ${withoutAbsolutePaths(error instanceof Error ? error.message : String(error))}`);
      }
    }
  );
}
