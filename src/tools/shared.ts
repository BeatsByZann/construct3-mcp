/**
 * Shared utilities for mutation tools.
 * Extracted from mutations.ts to reduce duplication.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { entityFilePath, type Construct3ProjectReader, type EntityCategory } from '../construct3/project-reader.js';
import { filesLeftClause, type Construct3ProjectWriter, type EntityOnDisk } from '../construct3/project-writer.js';
import { StaleFileError } from '../construct3/disk-state.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import { RESERVED_NAMES } from '../construct3/templates.js';

/** Dependency bundle passed to each domain's registerXTools() function. */
export interface MutationToolDeps {
  server: McpServer;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
  idGen: IdGenerator;
}

/** Validate that a name is safe for use as a filename and C3 identifier. */
export function validateName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error('Name cannot be empty');
  }
  if (name.length > 200) {
    throw new Error('Name too long (max 200 characters)');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(name)) {
    throw new Error('Name must start with a letter or underscore and contain only alphanumeric characters, underscores, and spaces');
  }
  // Reserved name check
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved name in Construct 3 and cannot be used`);
  }
}

/** Validate a subfolder path is safe. */
export function validateSubfolder(subfolder: string): void {
  if (subfolder.includes('..') || subfolder.includes('\\') || subfolder.startsWith('/')) {
    throw new Error('Subfolder path contains invalid characters (use forward slashes only, no "..")');
  }
  const parts = subfolder.split('/');
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new Error('Subfolder path contains invalid segments');
    }
  }
}

/**
 * Added as `editorNote` to every response that reports a completed change to
 * the project on disk. The Construct 3 editor keeps an open project in memory,
 * so saving from a session opened before these edits can overwrite them. Its
 * only documented in-editor reload (Project Bar → Scripts folder, F9) re-reads
 * script files, not event sheets, layouts or project.c3proj — hence "close and
 * reopen". (Rule from komabear/c3-skill, MIT.)
 *
 * Known gap: errors carry no note, also when a multi-step tool failed after an
 * earlier step had already written (e.g. create_object after auto-registering
 * an addon).
 */
export const EDITOR_RELOAD_NOTE =
  'If this project is open in Construct 3, close and reopen it there before saving, or the editor can overwrite these changes.';

/** Options for toolResult. */
export interface ToolResultOptions {
  /**
   * Whether this call wrote to the project on disk. When omitted, a
   * WriteResult-style payload decides: `success: true` and not a dry run.
   * Pass it for payloads whose `success` does not imply a write (no-ops,
   * runtime tools whose write depends on an argument).
   */
  projectWritten?: boolean;
}

/**
 * True when a tool result reports a completed write to the project: the
 * explicit `projectWritten` option when given, otherwise the WriteResult
 * convention (`success: true`, not `dryRun: true`).
 */
export function reportsProjectWrite(data: unknown, options: ToolResultOptions = {}): boolean {
  if (options.projectWritten !== undefined) return options.projectWritten;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const payload = data as Record<string, unknown>;
  return payload.success === true && payload.dryRun !== true;
}

/**
 * Format a successful tool result as MCP content.
 * Results that report a project write get the editor reload note.
 */
export function toolResult(data: unknown, options: ToolResultOptions = {}) {
  const isObject = typeof data === 'object' && data !== null && !Array.isArray(data);
  const payload = isObject && reportsProjectWrite(data, options)
    ? { ...(data as Record<string, unknown>), editorNote: EDITOR_RELOAD_NOTE }
    : data;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Format an error tool result as MCP content. */
export function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

/**
 * Delete a registered object type, family, event sheet or layout (#ISSUE).
 * The steps run in this order:
 * - look up its project-bar folder, which cannot be found once the name has
 *   left project.c3proj;
 * - refuse when its file changed on disk since the server read it, before
 *   anything is written;
 * - take the name out of project.c3proj;
 * - delete the file, backed up.
 * A failed step never leaves a name registered without its file. When a step
 * fails, the writer puts back what the call changed (undoToolCall; after a
 * refusal as stale it has done so already), and one Error is thrown that
 * says what was put back and what is on disk now, read again
 * (writer.entityOnDisk), never inferred from the undo alone. After the
 * delete, the disk is read again too: project.c3proj saved during the delete
 * (the editor saves the project it holds) may list the name again, and that
 * is reported as an error, not a success. Returns the file's backup path.
 * Runs inside the tool call.
 */
export async function deleteRegisteredEntity(
  writer: Construct3ProjectWriter,
  category: EntityCategory,
  name: string,
): Promise<string> {
  const subfolder = writer.getSubfolderForEntity(category, name);
  const file = entityFilePath(category, subfolder ?? '', name);
  await writer.assertEntityFileCurrent(category, name, subfolder);
  let backupPath: string;
  try {
    await writer.removeFromProject(category, name);
    backupPath = await writer.deleteEntityFile(category, name, subfolder);
  } catch (error) {
    const undo = error instanceof StaleFileError ? undefined : await writer.undoToolCall();
    // A refusal of the writer ends with a full stop already, and says what it put back
    const cause = error instanceof Error ? error.message : String(error);
    const sentences = [cause.endsWith('.') ? cause : `${cause}.`];
    if (undo && undo.restored.length > 0) sentences.push(`Put back from its backup: ${undo.restored.join(', ')}.`);
    if (undo && undo.left.length > 0) sentences.push(`Not all of it could be undone: ${filesLeftClause(undo.left)}.`);
    const now = describeOnDisk(await writer.entityOnDisk(category, name, subfolder), name, file);
    sentences.push(now.sentence);
    if ((!now.consistent || (undo !== undefined && undo.left.length > 0)) && !cause.includes('Check the project')) {
      sentences.push('Check the project (validate_project, git diff) before you run the tool again.');
    }
    throw new Error(sentences.join(' '));
  }
  const onDisk = await writer.entityOnDisk(category, name, subfolder);
  if (onDisk.project === 'lists' && onDisk.file === 'absent') {
    throw new Error(`${file} was deleted, but project.c3proj was saved again during the delete (saved in the Construct 3 editor, restored with git, or written by another program) ` +
      `and lists "${name}" again. Put the file back from ${file}.bak, or remove "${name}" in the editor.`);
  }
  if (onDisk.project !== 'omits' || onDisk.file !== 'absent') {
    throw new Error(`${file} was deleted, but the project is not as the delete left it: ${describeOnDisk(onDisk, name, file).sentence} ` +
      'Check the project (validate_project, git diff).');
  }
  return backupPath;
}

/**
 * A sentence on what entityOnDisk found after a delete, and whether the
 * registration and the file agree (both there, or both gone).
 */
function describeOnDisk(onDisk: EntityOnDisk, name: string, file: string): { sentence: string; consistent: boolean } {
  if (onDisk.project === 'missing') {
    return { sentence: 'project.c3proj is missing: put it back from project.c3proj.bak (its last backup) before you open the project.', consistent: false };
  }
  if (onDisk.project === 'unreadable') return { sentence: 'project.c3proj could not be read.', consistent: false };
  if (onDisk.file === 'unknown') return { sentence: `Whether ${file} is still on disk could not be checked.`, consistent: false };
  const listed = onDisk.project === 'lists';
  if (listed && onDisk.file === 'present') return { sentence: `project.c3proj still lists "${name}", and ${file} is on disk.`, consistent: true };
  if (!listed && onDisk.file === 'absent') return { sentence: `project.c3proj no longer lists "${name}", and ${file} is gone.`, consistent: true };
  if (listed) {
    return { sentence: `project.c3proj lists "${name}", but ${file} is missing: put it back from ${file}.bak, or remove "${name}" in the Construct 3 editor.`, consistent: false };
  }
  return { sentence: `project.c3proj no longer lists "${name}", but ${file} is still on disk: check it and delete it by hand.`, consistent: false };
}

/**
 * Build a "not found" toolError response with name suggestions.
 * Replaces the copy-pasted 3-line suggestion block in all mutation tools.
 *
 * @param entityKind  Human-readable entity kind (e.g., 'Object', 'Event sheet', 'Layout')
 * @param name        The name that was not found
 * @param suggestions Names returned by reader.findNearestName()
 * @param listTool    The MCP tool name users can call to see all valid names (e.g., 'list_objects')
 */
export function notFoundError(
  entityKind: string,
  name: string,
  suggestions: string[],
  listTool: string,
): ReturnType<typeof toolError> {
  const hint = suggestions.length > 0
    ? `\nDid you mean: ${suggestions.join(', ')}?`
    : `\nUse ${listTool} to see all available names.`;
  return toolError(`${entityKind} "${name}" not found.${hint}`);
}

/**
 * Error text for a new name that differs from an existing one only in case,
 * for the kinds of names the Construct 3 editor compares ignoring case (see
 * construct3/names.ts).
 */
export function caseClashError(kind: string, name: string, existing: string): string {
  return `"${name}" differs only in case from the existing ${kind} "${existing}". ` +
    `Construct 3 treats names that differ only in case as the same ${kind} name. Choose a different name.`;
}

/**
 * Error text for a subfolder path with a folder whose name differs from an
 * existing sibling project-bar folder only in case. `existingPath` is the path
 * spelled like the existing folders (from findFolderPathClash).
 */
export function folderCaseClashError(subfolder: string, existingPath: string): string {
  return `Subfolder "${subfolder}" differs only in case from the existing project-bar folder path "${existingPath}". ` +
    'Construct 3 treats sibling folder names that differ only in case as the same name, and on Windows and macOS ' +
    `they are the same directory. Use subfolder "${existingPath}".`;
}

// ─── Parameter Naming Convention ────────────────────────────
//
// All MCP tool Zod schemas use the `<entityKind>Name` convention:
//   objectName    — name of the object type (Sprite, Text, etc.)
//   layoutName    — name of the layout
//   sheetName     — name of the event sheet
//   animationName — name of the animation
//   familyName    — name of the family
//   timelineName  — name of the timeline
//   layerName     — name of the layer
//
// Exception: `objectType` in add_instance_to_layout refers to the *kind* of
// object being instantiated (its plugin type identity), not a mutable entity
// name — it is intentionally kept distinct for semantic clarity.
//
// Generic `name` is used only when the tool itself creates an entity (the
// name of the thing being created), e.g., create_layout { name }, create_object { name }.

// ─── Bounded Record Validator ────────────────────────────────

/**
 * Computes the maximum nesting depth of an object value.
 * Returns early once `maxDepth` is exceeded to keep it O(nodes).
 */
function depthOf(value: unknown, maxDepth: number, currentDepth = 0): number {
  if (currentDepth > maxDepth) return currentDepth;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return currentDepth;
  }
  let max = currentDepth;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const d = depthOf(v, maxDepth, currentDepth + 1);
    if (d > max) max = d;
    if (max > maxDepth) return max; // short-circuit
  }
  return max;
}

/**
 * A Zod record validator with explicit key-count and nesting-depth guards.
 * Prevents unbounded payloads from reaching C3 project files.
 *
 * @param maxKeys   Maximum number of top-level keys (default: 100)
 * @param maxDepth  Maximum object nesting depth (default: 6)
 */
export function boundedRecord(maxKeys = 100, maxDepth = 6) {
  return z.record(z.unknown()).superRefine((val, ctx) => {
    const keys = Object.keys(val);
    if (keys.length > maxKeys) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many keys: ${keys.length} (max ${maxKeys})`,
      });
    }
    if (depthOf(val, maxDepth) > maxDepth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Object nesting too deep (max depth ${maxDepth})`,
      });
    }
  });
}
