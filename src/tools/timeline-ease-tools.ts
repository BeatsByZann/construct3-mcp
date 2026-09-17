/**
 * Custom ease tools: list_eases, create_ease, update_ease, delete_ease.
 *
 * A custom ease is timelines/transitions/<name>.json, registered in the first,
 * nameless subfolder of the project.c3proj `timelines` container, and copied
 * into the `transitionsData` of every timeline that uses it (sample:
 * tasty-cappuccino "LightOutBack", used by 4 of its 15 timelines). Shapes are
 * documented in ../construct3/timeline-model.ts.
 */

import { z } from 'zod';
import { readFile, unlink, stat } from 'fs/promises';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { validateName, toolResult, toolError } from './shared.js';
import {
  checkEasePoints,
  createCustomEase,
  buildEaseKeyframes,
  ensureEasesFolder,
  easesFolder,
  isBuiltinEaseName,
  referencedEases,
  type CustomEase,
} from '../construct3/timeline-model.js';
import { atomicWriteJson, backupFile, type TimelineToolkit } from './timeline-tools.js';

const handleSchema = z.object({
  x: z.number().min(-10).max(10),
  y: z.number().min(-10).max(10),
});

const pointsSchema = z.array(z.object({
  x: z.number().min(0).max(1).describe('Point x (time fraction); the first point is 0 and the last 1'),
  y: z.number().min(-10).max(10).describe('Point y (progress); the first point is 0 and the last 1'),
  startHandle: handleSchema.optional().describe('Outgoing curve handle, as an offset from the point (not on the last point)'),
  endHandle: handleSchema.optional().describe('Incoming curve handle, as an offset from the point (not on the first point)'),
})).min(2).max(50);

type ContainerFolder = { name?: string; items: string[]; subfolders: unknown[] };

export function registerTimelineEaseTools({ server, reader }: MutationToolDeps, kit: TimelineToolkit) {
  async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  }

  /** Register or deregister an ease name in project.c3proj. */
  async function updateEaseRegistration(name: string, add: boolean): Promise<void> {
    const projectPath = reader.getProjectPath();
    const project = await readJson<Record<string, unknown>>(projectPath);
    if (!project.timelines) project.timelines = { items: [], subfolders: [] };
    const container = project.timelines as ContainerFolder;
    if (!Array.isArray(container.subfolders)) container.subfolders = [];
    if (add) {
      const folder = ensureEasesFolder(container as { items: string[]; subfolders: unknown[] });
      if (!folder.items.includes(name)) folder.items.push(name);
    } else {
      const folder = easesFolder(container);
      if (folder) folder.items = folder.items.filter(item => item !== name);
    }
    await backupFile(projectPath);
    await atomicWriteJson(projectPath, project);
    await reader.reloadProject();
  }

  function easeNames(): string[] {
    return easesFolder(kit.projectContainer())?.items.slice() ?? [];
  }

  function result(name: string, action: string, backupPath: string, extra: Record<string, unknown> = {}, warnings: string[] = []) {
    const out: WriteResult = { success: true, entity: name, category: 'ease', action, backupFile: backupPath };
    if (warnings.length > 0) out.warnings = warnings;
    return toolResult({ ...out, ...extra });
  }

  const unsampledPointsWarning = (count: number) => count > 2
    ? ['The sampled ease has two points only; check points between the ends in the Construct 3 editor.']
    : [];

  // ─── list_eases ───────────────────────────────────────────

  server.tool(
    'list_eases',
    'List the project\'s custom eases with their points and the timelines that use them',
    {},
    async () => {
      try {
        const timelines = await kit.allTimelines();
        const eases = [];
        for (const name of easeNames()) {
          let ease: CustomEase | undefined;
          let error: string | undefined;
          try {
            ease = await readJson<CustomEase>(kit.easeFilePath(name));
          } catch (e: unknown) {
            error = `timelines/transitions/${name}.json could not be read: ${e instanceof Error ? e.message : String(e)}`;
          }
          eases.push({
            name,
            ...(ease ? { linear: ease.linear, purpose: ease.purpose, points: ease.transitionKeyframes } : {}),
            ...(error ? { error } : {}),
            usedBy: timelines.filter(t => referencedEases(t.data).has(name)).map(t => t.name),
          });
        }
        return toolResult({ eases, count: eases.length });
      } catch (error) {
        console.error('[list_eases] failed:', error);
        return toolError(`Error listing eases: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_ease ──────────────────────────────────────────

  server.tool(
    'create_ease',
    'Create a custom ease curve: a file in timelines/transitions/ registered in the project. Timelines can then name it as an ease',
    {
      name: z.string().max(200).describe('Ease name'),
      points: pointsSchema.describe('Curve points from (0,0) to (1,1) with optional handles, e.g. [{"x":0,"y":0,"startHandle":{"x":0.43,"y":1.33}},{"x":1,"y":1,"endHandle":{"x":-0.36,"y":0.01}}]'),
      linear: z.boolean().optional().default(false).describe('The "linear" flag (default: false, as in the sample)'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (isBuiltinEaseName(args.name)) {
          return toolError(`"${args.name}" is, or looks like, one of Construct's own ease names; choose another name.`);
        }
        if (easeNames().includes(args.name)) return toolError(`Custom ease "${args.name}" already exists.`);
        if (kit.timelineNames().includes(args.name)) {
          return toolError(`"${args.name}" is already the name of a timeline in this project; choose another ease name.`);
        }
        const problem = checkEasePoints(args.points);
        if (problem) return toolError(problem);

        const filePath = kit.easeFilePath(args.name);
        try {
          await stat(filePath);
          return toolError(`timelines/transitions/${args.name}.json already exists on disk but is not registered; remove or register it first.`);
        } catch { /* free */ }

        const ease = createCustomEase(args.name, args.points, args.linear, 'any');
        const backupPath = await backupFile(filePath);
        await atomicWriteJson(filePath, ease);
        await updateEaseRegistration(args.name, true);
        return result(args.name, 'created', backupPath, {}, unsampledPointsWarning(args.points.length));
      } catch (error) {
        console.error('[create_ease] failed:', error);
        return toolError(`Error creating ease: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_ease ──────────────────────────────────────────

  server.tool(
    'update_ease',
    'Change a custom ease\'s points or linear flag, and refresh the copy of it in every timeline that uses it',
    {
      name: z.string().max(200).describe('Ease name'),
      points: pointsSchema.optional().describe('New curve points from (0,0) to (1,1)'),
      linear: z.boolean().optional().describe('New "linear" flag'),
    },
    async (args) => {
      try {
        if (args.points === undefined && args.linear === undefined) {
          return toolError('No updates provided. Specify points or linear.');
        }
        if (!easeNames().includes(args.name)) {
          return toolError(`Custom ease "${args.name}" not found. Use list_eases to see the project's custom eases.`);
        }
        if (args.points) {
          const problem = checkEasePoints(args.points);
          if (problem) return toolError(problem);
        }
        const filePath = kit.easeFilePath(args.name);
        let ease: CustomEase;
        try {
          ease = await readJson<CustomEase>(filePath);
        } catch {
          return toolError(`Custom ease "${args.name}" is registered but timelines/transitions/${args.name}.json could not be read.`);
        }
        if (args.points) ease.transitionKeyframes = buildEaseKeyframes(args.points);
        if (args.linear !== undefined) ease.linear = args.linear;

        const backupPath = await backupFile(filePath);
        await atomicWriteJson(filePath, ease);

        const refreshed: string[] = [];
        for (const timeline of await kit.allTimelines()) {
          if (!referencedEases(timeline.data).has(args.name)) continue;
          await kit.saveTimeline(timeline.filePath, timeline.data);
          refreshed.push(timeline.name);
        }
        return result(args.name, 'updated', backupPath, { timelinesRefreshed: refreshed }, unsampledPointsWarning(args.points?.length ?? 0));
      } catch (error) {
        console.error('[update_ease] failed:', error);
        return toolError(`Error updating ease: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_ease ──────────────────────────────────────────

  server.tool(
    'delete_ease',
    'Delete a custom ease that no timeline uses: its file (keeping a .bak), its editor-state file and its registration',
    {
      name: z.string().max(200).describe('Ease name'),
    },
    async (args) => {
      try {
        if (!easeNames().includes(args.name)) {
          return toolError(`Custom ease "${args.name}" not found. Use list_eases to see the project's custom eases.`);
        }
        const timelines = await kit.allTimelines();
        const users = timelines.filter(t => referencedEases(t.data).has(args.name)).map(t => t.name);
        if (users.length > 0) {
          return toolError(`Custom ease "${args.name}" is used by timeline(s) ${users.join(', ')}; change those eases first (update_timeline, update_track, set_keyframe).`);
        }

        const filePath = kit.easeFilePath(args.name);
        const backupPath = await backupFile(filePath);
        try { await unlink(filePath); } catch (e: unknown) {
          if (!(e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT')) throw e;
        }
        const warnings: string[] = [];
        const uistate = filePath.replace(/\.json$/, '.uistate.json');
        try {
          await stat(uistate);
          await backupFile(uistate);
          await unlink(uistate);
          warnings.push(`Also deleted ${args.name}.uistate.json (a .bak was written).`);
        } catch { /* none */ }

        await updateEaseRegistration(args.name, false);

        // Drop stale copies of the ease left in timelines that no longer use it.
        const cleaned: string[] = [];
        for (const timeline of timelines) {
          const entries = Array.isArray(timeline.data.transitionsData) ? timeline.data.transitionsData as Array<{ json?: { name?: unknown } }> : [];
          if (!entries.some(entry => entry?.json?.name === args.name)) continue;
          timeline.data.transitionsData = entries.filter(entry => entry?.json?.name !== args.name);
          await kit.saveTimeline(timeline.filePath, timeline.data);
          cleaned.push(timeline.name);
        }
        if (cleaned.length > 0) warnings.push(`Removed the ease's stored copy from timeline(s) ${cleaned.join(', ')}.`);

        return result(args.name, 'deleted', backupPath, {}, warnings);
      } catch (error) {
        console.error('[delete_ease] failed:', error);
        return toolError(`Error deleting ease: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
