/**
 * Custom ease tools: list_eases, create_ease, update_ease, delete_ease.
 *
 * A custom ease is timelines/transitions/<name>.json, registered in the
 * Transitions folder of the project.c3proj `timelines` container (its first
 * first-level subfolder without a name, wherever it sits), and copied
 * into the `transitionsData` of every timeline that uses it. Shapes are
 * documented in ../construct3/timeline-model.ts.
 *
 * Every write tool reads the files it will change first, builds all new text,
 * and then writes through the writer; a failed step puts the earlier ones back.
 */

import { z } from 'zod';
import { readFile } from 'fs/promises';
import { parseJsonText } from '../construct3/json-format.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { listRegisteredFileEntries } from '../construct3/registered-file-entries.js';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { StaleFileError, type FileState } from '../construct3/disk-state.js';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import {
  checkEasePoints,
  createCustomEase,
  buildEaseKeyframes,
  clashesWithBuiltinEase,
  referencedEases,
  type CustomEase,
} from '../construct3/timeline-model.js';
import { ensureTransitionsFolder, transitionsFolder } from '../construct3/timeline-folders.js';
import { easeParameterName, easeParameterValue, forEachEaseParameter, EASE_PARAMETER_KEY } from '../construct3/ease-params.js';
import type { TimelineToolkit } from './timeline-kit.js';
import { withProjectSync } from './project-sync.js';
import {
  refuse,
  invalidName,
  readFailure,
  relativeMessage,
  caseHint,
  jsonFileText,
  writeJsonFile,
  readFileForWrite,
  rollBackToolCall,
  type ChangedFile,
} from './timeline-writes.js';

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

/** An event sheet with ease parameters that name an ease: a private copy of its data, and how many parameters embed or only name the ease. */
interface EventSheetUse {
  sheet: string;
  data: unknown;
  embedded: number;
  bare: number;
}

/** A file one of the write tools will change: its new text, its text before and the state it was read in. */
interface PlannedWrite {
  name: string;
  path: string;
  text: string;
  before: string;
  state: FileState;
}

/**
 * Register the custom ease tools.
 * @param deps The server, reader, writer and id generator.
 * @param kit The toolkit registerTimelineTools builds: timeline access and ease lookups.
 */
export function registerTimelineEaseTools(deps: MutationToolDeps, kit: TimelineToolkit): void {
  const server = withProjectSync(deps.server, deps.reader);
  const { reader, writer } = deps;

  /** An ease file read once: the parsed data, the raw text (to put back) and the state it was read in. */
  async function readEaseFile(path: string): Promise<{ data: CustomEase; text: string; state: FileState }> {
    const read = await readFileForWrite(path);
    if (read === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { data: parseJsonText(read.text) as CustomEase, text: read.text, state: read.state };
  }

  /** The tool error for an unexpected failure; a writer refusal (a stale project.c3proj) is passed on as it says. */
  function failure(doing: string, error: unknown) {
    const text = relativeMessage(error, reader.getProjectDir());
    return toolError(error instanceof StaleFileError ? text : `Error ${doing}: ${text}`);
  }

  /** Register or deregister an ease name in project.c3proj. */
  async function updateEaseRegistration(name: string, add: boolean): Promise<void> {
    await writer.updateProject(project => {
      if (!project.timelines) project.timelines = { items: [], subfolders: [] };
      const container = project.timelines as ContainerFolder;
      if (!Array.isArray(container.subfolders)) container.subfolders = [];
      if (add) {
        const folder = ensureTransitionsFolder(container);
        if (!folder.items.includes(name)) folder.items.push(name);
        return;
      }
      const folder = transitionsFolder(container);
      if (folder) folder.items = folder.items.filter(item => item !== name);
    });
  }

  /**
   * Event sheets and script files that mention `name` as a whole word. The
   * Tween behavior stores its ease as an event parameter and scripts can
   * name eases too, so this is a lexical search; it can report false
   * positives but not miss a literal use.
   */
  async function textReferences(name: string): Promise<{ hits: string[]; unreadable: string[] }> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
    const hits: string[] = [];
    const unreadable: string[] = [];
    for (const sheet of await reader.listEventSheets()) {
      try {
        if (pattern.test(JSON.stringify(await reader.readEventSheet(sheet)))) hits.push(`event sheet "${sheet}"`);
      } catch {
        unreadable.push(`event sheet "${sheet}"`);
      }
    }
    for (const { entry, subfolder } of listRegisteredFileEntries(reader.getProject(), 'script')) {
      const parts = ['scripts', ...(subfolder ? subfolder.split('/') : []), entry.name];
      try {
        if (pattern.test(await readFile(resolveProjectPath(reader.getProjectDir(), ...parts), 'utf-8'))) hits.push(`script "${parts.join('/')}"`);
      } catch {
        unreadable.push(`script "${parts.join('/')}"`);
      }
    }
    return { hits, unreadable };
  }

  /**
   * Event sheets whose ACE `ease` parameters name `name`, as a bare string or
   * as the object Construct saves for a custom ease. Each call reads
   * the sheets afresh, so editing one for a write changes only this call's copy.
   */
  async function eventSheetUsers(name: string): Promise<{ sheets: EventSheetUse[]; unreadable: string[] }> {
    const sheets: EventSheetUse[] = [];
    const unreadable: string[] = [];
    for (const sheet of await reader.listEventSheets()) {
      let data: unknown;
      try {
        data = await reader.readEventSheet(sheet);
      } catch {
        unreadable.push(sheet);
        continue;
      }
      let embedded = 0;
      let bare = 0;
      forEachEaseParameter(data, params => {
        const value = params[EASE_PARAMETER_KEY];
        if (easeParameterName(value) !== name) return;
        if (typeof value === 'string') bare++;
        else embedded++;
      });
      if (embedded + bare > 0) sheets.push({ sheet, data, embedded, bare });
    }
    return { sheets, unreadable };
  }

  function easeNames(): string[] {
    return transitionsFolder(kit.projectContainer())?.items.slice() ?? [];
  }

  /** The result of a write tool; a new ease has no backup, so `backupFile` is added only when there is one. */
  function result(name: string, action: string, backupPath: string | undefined, extra: Record<string, unknown> = {}, warnings: string[] = []) {
    const out: WriteResult = {
      success: true,
      entity: name,
      category: 'ease',
      action,
      ...(backupPath === undefined ? {} : { backupFile: backupPath }),
    };
    if (warnings.length > 0) out.warnings = warnings;
    return toolResult({ ...out, ...extra });
  }

  const unsampledPointsWarning = (count: number) => count > 2
    ? ['No fixture holds an ease with points between the ends; check them in the Construct 3 editor.']
    : [];

  /** The refusal for an ease name that is not registered, with the letter-case hint when one fits. */
  function notFound(name: string) {
    const hint = caseHint(name, easeNames());
    return refuse(`Custom ease "${name}" not found. ${hint ?? 'Use list_eases to see the project\'s custom eases.'}`);
  }

  // ─── list_eases ───────────────────────────────────────────

  server.tool(
    'list_eases',
    'List the project\'s custom eases with their points, the timelines that use them, and the event sheets whose ACE ease parameters (e.g. Tween) name them',
    {},
    async () => {
      try {
        const { timelines, unreadable } = await kit.allTimelines();
        const eases = [];
        for (const name of easeNames()) {
          let ease: CustomEase | undefined;
          let error: string | undefined;
          try {
            ease = (await readEaseFile(kit.easeFilePath(name))).data;
          } catch (e: unknown) {
            error = `timelines/transitions/${name}.json could not be read: ${readFailure(e)}`;
          }
          eases.push({
            name,
            ...(ease ? { linear: ease.linear, purpose: ease.purpose, points: ease.transitionKeyframes } : {}),
            ...(error ? { error } : {}),
            usedBy: timelines.filter(t => referencedEases(t.data).has(name)).map(t => t.name),
            usedByEventSheets: (await eventSheetUsers(name)).sheets.map(s => s.sheet),
          });
        }
        return toolResult({ eases, count: eases.length, ...(unreadable.length > 0 ? { unreadableTimelines: unreadable } : {}) });
      } catch (error) {
        console.error('[list_eases] failed:', error);
        return toolError(`Error listing eases: ${relativeMessage(error, reader.getProjectDir())}`);
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
      linear: z.boolean().optional().default(false).describe('The "linear" flag (default: false)'),
    },
    async (args) => {
      try {
        const invalid = invalidName(args.name);
        if (invalid) return refuse(invalid);
        if (clashesWithBuiltinEase(args.name)) {
          return refuse(`"${args.name}" is one of Construct's own ease names; choose another name.`);
        }
        const registered = easeNames();
        if (registered.includes(args.name)) return refuse(`Custom ease "${args.name}" already exists.`);
        const hint = caseHint(args.name, registered);
        if (hint) return refuse(`A custom ease whose name differs from "${args.name}" only in letter case is registered. ${hint}`);
        if (kit.timelineNames().includes(args.name)) {
          return refuse(`"${args.name}" is already the name of a timeline in this project; choose another ease name.`);
        }
        const problem = checkEasePoints(args.points);
        if (problem) return refuse(problem);

        const filePath = kit.easeFilePath(args.name);
        const onDisk = await findFileIgnoringCase(filePath);
        if (onDisk) {
          return refuse(`${writer.projectRelative(onDisk)} already exists on disk but is not registered; remove or register it first.`);
        }

        const ease = createCustomEase(args.name, args.points, args.linear, 'any');
        await writer.assertProjectFileCurrent();
        const changed: ChangedFile[] = [{ path: filePath, before: null }];
        let backupPath: string | undefined;
        try {
          // A new ease file follows project.c3proj's text style, not an older ease file's.
          // null: the file must still be absent; one created since the check above is refused, not overwritten
          backupPath = await writeJsonFile(writer, filePath, ease, reader.getProjectPath(), null);
          await updateEaseRegistration(args.name, true);
        } catch (error) {
          return toolError(`Error creating ease: ${await rollBackToolCall(writer, reader.getProjectDir(), error, changed)}`);
        }
        await reader.reloadProject();
        return result(args.name, 'created', backupPath, {}, unsampledPointsWarning(args.points.length));
      } catch (error) {
        console.error('[create_ease] failed:', error);
        return failure('creating ease', error);
      }
    }
  );

  // ─── update_ease ──────────────────────────────────────────

  server.tool(
    'update_ease',
    'Change a custom ease\'s points or linear flag, and refresh the copy of it in every timeline that uses it and in every event-sheet ease parameter that embeds it. Refused, changing nothing, while a timeline or an event sheet cannot be read.',
    {
      name: z.string().max(200).describe('Ease name'),
      points: pointsSchema.optional().describe('New curve points from (0,0) to (1,1)'),
      linear: z.boolean().optional().describe('New "linear" flag'),
    },
    async (args) => {
      try {
        if (args.points === undefined && args.linear === undefined) {
          return refuse('No updates provided. Specify points or linear.');
        }
        if (!easeNames().includes(args.name)) return notFound(args.name);
        if (args.points) {
          const problem = checkEasePoints(args.points);
          if (problem) return refuse(problem);
        }
        const filePath = kit.easeFilePath(args.name);
        let read: { data: CustomEase; text: string; state: FileState };
        try {
          read = await readEaseFile(filePath);
        } catch (e: unknown) {
          return refuse(`Custom ease "${args.name}" is registered but timelines/transitions/${args.name}.json could not be read (${readFailure(e)}).`);
        }
        const ease = read.data;
        if (args.points) ease.transitionKeyframes = buildEaseKeyframes(args.points);
        if (args.linear !== undefined) ease.linear = args.linear;
        const eases = await kit.loadEases();
        eases.set(args.name, ease);
        const all = await kit.allTimelines();
        const users = await eventSheetUsers(args.name);
        // A copy that cannot be read would be left holding the old curve: refuse before the first write
        if (all.unreadable.length > 0 || users.unreadable.length > 0) {
          const names = [
            ...all.unreadable.map(n => `timeline "${n}"`),
            ...users.unreadable.map(n => `event sheet "${n}"`),
          ];
          return refuse(`Custom ease "${args.name}" was not updated: ${names.join(', ')} could not be read, so a copy of the ease in ${names.length === 1 ? 'it' : 'them'} could not be refreshed. Fix or remove ${names.length === 1 ? 'it' : 'them'} first.`);
        }
        const timelineWrites: PlannedWrite[] = [];
        for (const timeline of all.timelines) {
          if (!referencedEases(timeline.data).has(args.name)) continue;
          timelineWrites.push({
            name: timeline.name,
            path: timeline.filePath,
            text: await kit.timelineText(timeline.filePath, timeline.data, eases),
            before: timeline.text,
            state: timeline.state,
          });
        }
        const easeText = await jsonFileText(filePath, ease, reader.getProjectPath());
        const sheetWrites = users.sheets.filter(s => s.embedded > 0);
        for (const { data } of sheetWrites) {
          forEachEaseParameter(data, params => {
            const value = params[EASE_PARAMETER_KEY];
            if (typeof value !== 'string' && easeParameterName(value) === args.name) params[EASE_PARAMETER_KEY] = easeParameterValue(ease);
          });
        }
        // Writes: event sheets, then timelines, then the ease file, so the file that defines the ease changes last
        const changed: ChangedFile[] = [];
        let backupPath: string | undefined;
        try {
          for (const { sheet, data } of sheetWrites) {
            await writer.writeEntityFile('eventSheets', sheet, data, writer.getSubfolderForEntity('eventSheets', sheet));
          }
          for (const t of timelineWrites) {
            // Recorded before the write: a write that lands and then throws is still put back
            changed.push({ path: t.path, before: t.before });
            await writer.replaceFile(t.path, t.text, { expected: t.state });
          }
          changed.push({ path: filePath, before: read.text });
          backupPath = await writer.replaceFile(filePath, easeText, { expected: read.state });
        } catch (error) {
          return toolError(`Error updating ease: ${await rollBackToolCall(writer, reader.getProjectDir(), error, changed)}`);
        }
        await reader.reloadProject();
        return result(
          args.name,
          'updated',
          backupPath,
          { timelinesRefreshed: timelineWrites.map(t => t.name), eventSheetsRefreshed: sheetWrites.map(s => s.sheet) },
          unsampledPointsWarning(args.points?.length ?? 0),
        );
      } catch (error) {
        console.error('[update_ease] failed:', error);
        return failure('updating ease', error);
      }
    }
  );

  // ─── delete_ease ──────────────────────────────────────────

  server.tool(
    'delete_ease',
    'Delete a custom ease that no timeline uses: its registration, its file (keeping a .bak) and its editor-state file. A failed step puts the earlier ones back. Refused while a timeline uses it or cannot be opened, and, unless force is set, while an event sheet or script file mentions its name',
    {
      name: z.string().max(200).describe('Ease name'),
      force: z.boolean().optional().default(false).describe('Delete even though event sheets or script files mention the name, or cannot be read (default: false)'),
    },
    async (args) => {
      try {
        if (!easeNames().includes(args.name)) return notFound(args.name);
        const { timelines, unreadable } = await kit.allTimelines();
        if (unreadable.length > 0) {
          return refuse(`Timeline(s) ${unreadable.join(', ')} could not be opened, so it is unknown whether they use custom ease "${args.name}". Fix or remove them first.`);
        }
        const users = timelines.filter(t => referencedEases(t.data).has(args.name)).map(t => t.name);
        if (users.length > 0) {
          return refuse(`Custom ease "${args.name}" is used by timeline(s) ${users.join(', ')}; change those eases first (update_timeline, update_track, set_keyframe).`);
        }

        const warnings: string[] = [];
        const text = await textReferences(args.name);
        if (text.hits.length > 0 || text.unreadable.length > 0) {
          const parts: string[] = [];
          if (text.hits.length > 0) parts.push(`the name "${args.name}" appears in ${text.hits.join(', ')} (for example as a Tween ease)`);
          if (text.unreadable.length > 0) parts.push(`${text.unreadable.join(', ')} could not be read`);
          if (!args.force) {
            return refuse(`Custom ease "${args.name}" was not deleted: ${parts.join('; ')}. Check those uses, then pass force: true to delete anyway.`);
          }
          warnings.push(`Deleted with force although ${parts.join('; ')}.`);
          const embedded = (await eventSheetUsers(args.name)).sheets.filter(s => s.embedded > 0).map(s => s.sheet);
          if (embedded.length > 0) {
            warnings.push(`Event sheet(s) ${embedded.join(', ')} still hold an embedded copy of "${args.name}" in ease parameters; change those ease parameters.`);
          }
        }

        const filePath = kit.easeFilePath(args.name);
        const stale = timelines.filter(t => (Array.isArray(t.data.transitionsData) ? t.data.transitionsData : [])
          .some((entry) => (entry as { json?: { name?: unknown } })?.json?.name === args.name));
        const staleWrites: PlannedWrite[] = [];
        for (const timeline of stale) {
          // Copies of the ease that no timeline uses any more
          timeline.data.transitionsData = (timeline.data.transitionsData as Array<{ json?: { name?: unknown } }>).filter(entry => entry?.json?.name !== args.name);
          staleWrites.push({
            name: timeline.name,
            path: timeline.filePath,
            text: await jsonFileText(timeline.filePath, timeline.data, reader.getProjectPath()),
            before: timeline.text,
            state: timeline.state,
          });
        }
        const uistate = filePath.replace(/\.json$/, '.uistate.json');
        const uistateRead = await readFileForWrite(uistate);
        const easeRead = await readFileForWrite(filePath);
        // Before the first write of any file: a project.c3proj saved meanwhile is a refusal that changes nothing
        await writer.assertProjectFileCurrent();
        const changed: ChangedFile[] = [];
        let backupPath: string | undefined;
        try {
          for (const t of staleWrites) {
            changed.push({ path: t.path, before: t.before });
            await writer.replaceFile(t.path, t.text, { expected: t.state });
          }
          await updateEaseRegistration(args.name, false);
          if (uistateRead !== null) {
            changed.push({ path: uistate, before: uistateRead.text });
            await writer.deleteFile(uistate, { expected: uistateRead.state });
            warnings.push(`Also deleted ${args.name}.uistate.json (a .bak was written).`);
          }
          if (easeRead !== null) changed.push({ path: filePath, before: easeRead.text });
          backupPath = await writer.deleteFile(filePath, { expected: easeRead === null ? null : easeRead.state });
        } catch (error) {
          return toolError(`Error deleting ease: ${await rollBackToolCall(writer, reader.getProjectDir(), error, changed)}`);
        }
        await reader.reloadProject();
        if (staleWrites.length > 0) warnings.push(`Removed the ease's stored copy from timeline(s) ${staleWrites.map(t => t.name).join(', ')}.`);
        return result(args.name, 'deleted', backupPath, {}, warnings);
      } catch (error) {
        console.error('[delete_ease] failed:', error);
        return failure('deleting ease', error);
      }
    }
  );
}
