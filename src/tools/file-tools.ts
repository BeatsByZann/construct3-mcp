/**
 * Script and Project File tools: register_script_file, deregister_script_file,
 * set_main_script, register_project_file, deregister_project_file and
 * create_data_file. project.c3proj is changed by one writer.updateProject
 * per tool call; a file is written only after its registration, and a
 * failed write puts the registration back. Files are written and deleted
 * through the writer (replaceFile, deleteFile).
 */

import { z } from 'zod';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import type { MutationToolDeps } from './shared.js';
import { folderCaseClashError, toolError, toolResult, validateFileName, validateSubfolder } from './shared.js';
import { withProjectSync } from './project-sync.js';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { StaleFileError, statFileState } from '../construct3/disk-state.js';
import { filesLeftClause } from '../construct3/project-writer.js';
import { nameKey } from '../construct3/names.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { buildDataFileBody, projectFileMimeType } from '../construct3/data-file-body.js';
import { BRIDGE_FILENAME } from './runtime-tools.js';
import type { Construct3Project } from '../construct3/types.js';
import {
  applyMainScript, applyRegistration, entryPurpose, findEntryNameClash, findFileEntry, findSubfolderClash,
  getFileFolderDirectory, listFileEntries, removeFileEntry,
  type FileInfoKey, type RegisteredFileFolder, type RegistrationOutcome,
} from '../construct3/file-registration.js';

type Writer = MutationToolDeps['writer'];
type Reader = MutationToolDeps['reader'];

/** The largest source file register_project_file copies: the writer holds a file's content in memory while it writes it. */
export const MAX_PROJECT_FILE_BYTES = 100 * 1024 * 1024;

/** A refusal made before anything was changed: the message, then "Nothing was changed.". */
function refuse(message: string) {
  return toolError(`${message.replace(/\.$/, '')}. Nothing was changed.`);
}

/** A refusal found inside a project update, which then writes nothing; the tool answers it with refuse(). */
class Refusal extends Error {}

/**
 * Why a call failed, for a message: a Node fs error by its code (its
 * message carries an absolute path), any other error by its message (the
 * writer's and the reader's own errors explain themselves).
 */
function failureReason(error: unknown): string {
  // The writer wraps a failed backup stat in an error whose message carries the absolute path; its cause has the code
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && 'syscall' in cause && typeof (cause as NodeJS.ErrnoException).code === 'string') {
    return (cause as NodeJS.ErrnoException).code as string;
  }
  if (error instanceof Error && 'syscall' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The message of a call that failed with an error the tool did not expect:
 * what the call wrote through the writer is put back (writer.undoToolCall)
 * and named; a call that wrote nothing ends with "Nothing was changed.". A
 * stale-file refusal the writer already undid says itself what became of
 * the files.
 */
async function failureText(writer: Writer, prefix: string, error: unknown): Promise<string> {
  if (error instanceof Refusal) return `${error.message.replace(/\.$/, '')}. Nothing was changed.`;
  const undo = await writer.undoToolCall();
  const parts = [`${prefix}: ${failureReason(error).replace(/\.$/, '')}.`];
  if (undo.restored.length > 0) parts.push(`What this call had written was put back: ${undo.restored.join(', ')}.`);
  if (undo.left.length > 0) {
    parts.push(`It could not be put back: ${filesLeftClause(undo.left)}. Check the project (validate_project) before you run the tool again.`);
  }
  const undoneBefore = error instanceof StaleFileError && error.undone;
  if (undo.restored.length === 0 && undo.left.length === 0 && !undoneBefore) parts.push('Nothing was changed.');
  return parts.join(' ');
}

/**
 * Why a name or subfolder is refused for its letter case against a
 * registered one, or undefined. Run on the loaded project before the
 * update and again inside it, on the file as it is then. The file-name
 * message states the file system fact only.
 */
function caseRefusal(
  project: Construct3Project,
  folder: RegisteredFileFolder,
  name: string,
  subfolder: string | undefined,
  kind: string,
  options: { skipNameClash?: boolean } = {},
): string | undefined {
  if (subfolder) {
    const spelled = findSubfolderClash(project, folder, subfolder);
    if (spelled !== undefined) return folderCaseClashError(subfolder, spelled);
  }
  if (options.skipNameClash) return undefined;
  const clash = findEntryNameClash(project, folder, name, subfolder);
  if (clash !== undefined) {
    return `"${name}" differs only in case from the registered ${kind} "${clash}"; on Windows and macOS both names are the same file. Use the registered name "${clash}"`;
  }
  return undefined;
}

/**
 * Why a name or subfolder is refused (its shape, in the name and in every
 * subfolder part, or its letter case against a registered one), or undefined.
 */
function nameRefusal(
  project: Construct3Project,
  folder: RegisteredFileFolder,
  name: string,
  subfolder: string | undefined,
  kind: string,
  options: { skipNameClash?: boolean } = {},
): string | undefined {
  try {
    validateFileName(name);
    if (subfolder) {
      validateSubfolder(subfolder);
      for (const part of subfolder.split('/')) validateFileName(part, 'Subfolder part');
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return caseRefusal(project, folder, name, subfolder, kind, options);
}

/** The script that is "main" other than `name` in `subfolder`, as "path", or undefined. */
function otherMainScript(project: Construct3Project, name: string, subfolder: string | undefined): string | undefined {
  const main = listFileEntries(project, 'script')
    .find(located => entryPurpose(located.entry) === 'main' && !(located.entry.name === name && located.subfolder === subfolder));
  return main ? `${main.subfolder ? `${main.subfolder}/` : ''}${main.entry.name}` : undefined;
}

/** The refusal text for a second main script. */
function secondMainRefusal(mainPath: string, name: string): string {
  return `"${mainPath}" already has script-info purpose "main". Use set_main_script, which moves "main" from it to "${name}"`;
}

/**
 * Why a file cannot be written to or deleted at `destination` without
 * replacing one of the writer's own files, or undefined. The writer stages a
 * write as `<file>.tmp` and renames it onto the file, and backs a file up
 * as `<file>.bak`; a registered file (or a file on disk, for `.tmp`) of that
 * name would be replaced. `suffix` is the one the coming operation uses:
 * `.tmp` for a write, `.bak` for a delete. Checked on the project as it is
 * now; a file that appears afterwards is not covered.
 */
async function sidecarRefusal(
  project: Construct3Project,
  folder: RegisteredFileFolder,
  name: string,
  subfolder: string | undefined,
  destination: string,
  suffix: '.tmp' | '.bak',
): Promise<string | undefined> {
  const sidecar = `${name}${suffix}`;
  const registered = findFileEntry(project, folder, sidecar, subfolder)?.entry.name ?? findEntryNameClash(project, folder, sidecar, subfolder);
  const onDisk = suffix === '.tmp' ? await findFileIgnoringCase(`${destination}${suffix}`) : undefined;
  if (registered === undefined && onDisk === undefined) return undefined;
  const what = registered !== undefined ? `"${registered}" is a registered file` : `"${basename(onDisk as string)}" is a file in the same folder`;
  const doing = suffix === '.tmp' ? 'writes a file through' : 'keeps a backup of a deleted file as';
  return `${what}, and this server ${doing} "${name}${suffix}". Rename or deregister it first`;
}

/**
 * Why `destination` is refused because a link or junction leads outside the
 * project folder, or undefined. The real path of the nearest existing path
 * (the destination itself, else its closest existing ancestor) must be
 * inside the real path of the project folder. Checked before a file is
 * written or deleted; a link swapped in afterwards is not covered.
 */
async function linkRefusal(projectDir: string, destination: string, relativePath: string): Promise<string | undefined> {
  let nearest = destination;
  for (;;) {
    try {
      await lstat(nearest);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(nearest);
      if (parent === nearest) return undefined;
      nearest = parent;
    }
  }
  let inside: boolean;
  try {
    const path = relative(await realpath(projectDir), await realpath(nearest));
    inside = path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  } catch {
    inside = false; // a link that cannot be resolved leads nowhere that can be checked
  }
  return inside ? undefined : `${relativePath} is reached through a link or junction that leads outside the project folder, so it is not used`;
}

/**
 * Why a file cannot be written (`.tmp`) or deleted (`.bak`) at `destination`
 * by the writer: a link out of the project, or one of the writer's own files
 * in the way (linkRefusal, sidecarRefusal), on the project as it is now.
 */
async function writeBlocker(
  reader: Reader,
  folder: RegisteredFileFolder,
  name: string,
  subfolder: string | undefined,
  destination: string,
  relativePath: string,
  suffix: '.tmp' | '.bak',
): Promise<string | undefined> {
  return (await linkRefusal(reader.getProjectDir(), destination, relativePath))
    // A delete backs the file up as <file>.bak, which is written through a link at that name
    ?? (suffix === '.bak' ? await linkRefusal(reader.getProjectDir(), `${destination}${suffix}`, `${relativePath}${suffix}`) : undefined)
    ?? (await sidecarRefusal(reader.getProject(), folder, name, subfolder, destination, suffix));
}

/** The outcomes of a registration that found or made an entry. */
type RegistrationDone = Exclude<RegistrationOutcome, { kind: 'needs-sid' }>;

/**
 * Register an entry (or repair the existing one) with one writer.updateProject.
 * A SID is taken only for an entry the loaded project lacks, before
 * project.c3proj is read for the update: taking one on every call would
 * scan the project for already-registered entries too, and an entry that
 * vanishes during the call is rare enough to answer with a refusal. Inside
 * the update, on the file as it is then, a case variant is refused and,
 * with `createOnly`, so is an entry of the name (another writer registered
 * it meanwhile), and with `exclusiveMain` a second main script (another
 * writer made one main meanwhile). `written` is whether the file was written.
 */
async function registerInProject(
  writer: Writer,
  reader: Reader,
  input: {
    folder: RegisteredFileFolder; name: string; type: string; infoKey: FileInfoKey; purpose?: string; subfolder?: string;
    kind: string; createOnly?: boolean; exclusiveMain?: boolean;
  },
): Promise<{ outcome: RegistrationDone; written: boolean }> {
  const known = findFileEntry(reader.getProject(), input.folder, input.name, input.subfolder);
  const sid = known ? undefined : await writer.generateSid();
  const seen: { outcome?: RegistrationOutcome } = {};
  const backup = await writer.updateProject(project => {
    const parsed = project as Construct3Project;
    const clash = caseRefusal(parsed, input.folder, input.name, input.subfolder, input.kind);
    if (clash) throw new Refusal(clash);
    if (input.createOnly && findFileEntry(parsed, input.folder, input.name, input.subfolder)) {
      throw new Refusal(`"${input.name}" was registered by another writer while this call ran, so no file was written`);
    }
    if (input.exclusiveMain) {
      const main = otherMainScript(parsed, input.name, input.subfolder);
      if (main) throw new Refusal(secondMainRefusal(main, input.name));
    }
    seen.outcome = applyRegistration(parsed, input.folder, {
      name: input.name, type: input.type, infoKey: input.infoKey, purpose: input.purpose, subfolder: input.subfolder, sid,
    });
    if (seen.outcome.kind === 'needs-sid') {
      throw new Refusal(`"${input.name}" is no longer registered: project.c3proj changed on disk while this call ran. Run the tool again`);
    }
    return seen.outcome.kind === 'unchanged' ? false : undefined;
  });
  return { outcome: seen.outcome as RegistrationDone, written: backup !== undefined };
}

/** The result of a registration; `generatedSid` is the entry's SID, new or existing. */
function registrationResult(
  outcome: RegistrationDone,
  base: { entity: string; category: 'script-file' | 'project-file'; folder?: RegisteredFileFolder; subfolder?: string; path?: string },
) {
  return {
    success: true,
    entity: base.entity,
    category: base.category,
    action: outcome.kind === 'added' ? 'registered' : 'already_registered',
    generatedSid: outcome.sid,
    ...(outcome.kind === 'repaired' ? { repaired: outcome.repairs } : {}),
    ...(base.folder ? { folder: base.folder } : {}),
    subfolder: base.subfolder,
    ...(base.path ? { path: base.path } : {}),
  };
}

/**
 * The message of a call whose file write failed after project.c3proj was
 * updated: the update is put back (writer.undoToolCall); what could not be
 * put back, and a file that is on disk after all, are named. The file is
 * called "not registered" only when the update was put back; otherwise the
 * message says its registration may still be in project.c3proj.
 */
async function failedAfterRegistration(writer: Writer, destination: string, relativePath: string, problem: string): Promise<string> {
  const undo = await writer.undoToolCall();
  // The undo above has cleared what the call changed, so this message must not throw: a second undo would find nothing and report "Nothing was changed."
  let onDisk: boolean | undefined;
  try {
    onDisk = (await findFileIgnoringCase(destination)) !== undefined;
  } catch {
    onDisk = undefined;
  }
  const putBack = undo.restored.length > 0 && undo.left.length === 0;
  const parts = [`${problem}.`];
  if (undo.restored.length > 0) parts.push('The registration in project.c3proj was put back.');
  if (undo.left.length > 0) parts.push(`The registration could not be put back: ${filesLeftClause(undo.left)}.`);
  if (onDisk === undefined) {
    parts.push(`Whether ${relativePath} is on disk could not be checked; check it.`);
  } else if (onDisk) {
    parts.push(putBack
      ? `${relativePath} is on disk and not registered; check it.`
      : `${relativePath} is on disk, and its registration in project.c3proj may still be there; check both.`);
  }
  if (undo.left.length > 0 || onDisk !== false) parts.push('Check the project (validate_project) before you run the tool again.');
  return parts.join(' ');
}

/** The source file's bytes, or why it is refused. */
async function readSourceFile(sourcePath: string): Promise<{ bytes: Buffer } | { refusal: string }> {
  try {
    const info = await stat(sourcePath);
    if (!info.isFile()) return { refusal: 'The source path is not a file' };
    if (info.size > MAX_PROJECT_FILE_BYTES) {
      return { refusal: `The source file is ${(info.size / 1048576).toFixed(1)} MB; register_project_file copies files up to ${MAX_PROJECT_FILE_BYTES / 1048576} MB` };
    }
    return { bytes: await readFile(sourcePath) };
  } catch (error) {
    return { refusal: `The source file cannot be read (${failureReason(error)})` };
  }
}

const purposeField = z.string().min(1).max(100);
const subfolderField = z.string().min(1).max(500);
const familyField = z.enum(['general', 'sound', 'music', 'video', 'font']);

/** Register register_script_file, deregister_script_file and set_main_script. */
export function registerFileTools({ server: mcpServer, reader, writer }: MutationToolDeps): void {
  const server = withProjectSync(mcpServer, reader);

  server.tool(
    'register_script_file',
    'Register an existing script file in rootFileFolders.script with script-info metadata and a collision-safe SID. Changes project.c3proj only: the script file is neither copied nor checked. An entry that is registered already keeps its SID, type and purpose (a purpose is changed only when one is given); an older registration is repaired (metadata key, duplicates). Names are matched with their letter case.',
    {
      name: z.string().min(1).max(255).describe('Script file name, without a folder path'),
      type: z.string().min(1).max(100).optional().default('application/javascript').describe('MIME type recorded by Construct 3 (new entries)'),
      purpose: purposeField.optional().describe('script-info purpose ("main", "imports-for-events" or "none"); a new entry gets "none" when omitted, an existing entry keeps its purpose'),
      subfolder: subfolderField.optional().describe('Optional slash-separated script subfolder'),
    },
    async (args) => {
      try {
        const refusal = nameRefusal(reader.getProject(), 'script', args.name, args.subfolder, 'script file');
        if (refusal) return refuse(refusal);
        // Refused here on the loaded project and again inside the update, on the file as it is then
        const exclusiveMain = args.purpose === 'main';
        const main = exclusiveMain ? otherMainScript(reader.getProject(), args.name, args.subfolder) : undefined;
        if (main) return refuse(secondMainRefusal(main, args.name));
        const { outcome, written } = await registerInProject(writer, reader, {
          folder: 'script', name: args.name, type: args.type, infoKey: 'script-info', purpose: args.purpose, subfolder: args.subfolder, kind: 'script file',
          exclusiveMain,
        });
        return toolResult(registrationResult(outcome, { entity: args.name, category: 'script-file', subfolder: args.subfolder }), { projectWritten: written });
      } catch (error) {
        if (!(error instanceof Refusal)) console.error('[register_script_file] failed:', error);
        return toolError(await failureText(writer, 'Error registering script file', error));
      }
    },
  );

  server.tool(
    'deregister_script_file',
    'Remove a script file registration from rootFileFolders.script (every registration of the name in that folder). The script file itself is preserved. Names are matched with their letter case.',
    {
      name: z.string().min(1).max(255).describe('Script file name'),
      subfolder: subfolderField.optional().describe('Optional slash-separated script subfolder'),
    },
    async (args) => {
      try {
        const refusal = nameRefusal(reader.getProject(), 'script', args.name, args.subfolder, 'script file');
        if (refusal) return refuse(refusal);
        if (!findFileEntry(reader.getProject(), 'script', args.name, args.subfolder)) {
          return refuse(`Script file "${args.name}" is not registered in this project`);
        }
        const backup = await writer.updateProject(project => (removeFileEntry(project as Construct3Project, 'script', args.name, args.subfolder) ? undefined : false));
        if (backup === undefined) return refuse(`Script file "${args.name}" is no longer registered: project.c3proj changed on disk while this call ran`);
        return toolResult({ success: true, entity: args.name, category: 'script-file', action: 'deregistered', subfolder: args.subfolder });
      } catch (error) {
        if (!(error instanceof Refusal)) console.error('[deregister_script_file] failed:', error);
        return toolError(await failureText(writer, 'Error deregistering script file', error));
      }
    },
  );

  server.tool(
    'set_main_script',
    'Mark one registered script as the project main script: it gets script-info purpose "main" and every other script that had "main" gets "none"; other purposes are left alone. One update of project.c3proj. Names are matched with their letter case.',
    {
      name: z.string().min(1).max(255).describe('Registered script file name'),
      subfolder: subfolderField.optional().describe('Script subfolder; omitted: the script of that name at the root of the script folder, else the only subfolder that has one'),
    },
    async (args) => {
      try {
        // The letter case of the name is checked below, against the scripts of every folder when none is given
        const invalid = nameRefusal(reader.getProject(), 'script', args.name, args.subfolder, 'script file', { skipNameClash: true });
        if (invalid) return refuse(invalid);
        const label = (located: { entry: { name: string }; subfolder?: string }) => `${located.subfolder ? `${located.subfolder}/` : ''}${located.entry.name}`;
        const scripts = listFileEntries(reader.getProject(), 'script');
        const here = (located: { subfolder?: string }) => args.subfolder === undefined || located.subfolder === args.subfolder;
        const matches = scripts.filter(located => located.entry.name === args.name && here(located));
        if (matches.length === 0) {
          const variant = scripts.find(located => nameKey(located.entry.name) === nameKey(args.name) && here(located));
          if (variant) return refuse(`Script "${args.name}" is not registered; "${label(variant)}" is. Names are matched with their letter case, so use that name`);
          return refuse(`Script "${args.name}" is not registered in this project. Registered scripts: ${scripts.map(label).join(', ') || '(none)'}`);
        }
        // Without a subfolder the root script of the name is meant, as in the other file tools
        const atRoot = matches.filter(located => located.subfolder === undefined);
        const chosen = args.subfolder === undefined && atRoot.length > 0 ? atRoot : matches;
        if (new Set(chosen.map(located => located.subfolder ?? '')).size > 1) {
          return refuse(`Script "${args.name}" is registered in more than one script subfolder (${chosen.map(label).join(', ')}). Pass subfolder to choose one`);
        }
        const target = chosen[0];
        // Construct loads only the main script, and the runtime bridge is the main script when no other is: moving "main" away would stop it loading
        const bridge = scripts.find(located => located.entry.name === BRIDGE_FILENAME && entryPurpose(located.entry) === 'main' && located !== target);
        if (bridge) {
          return refuse(`"${label(bridge)}" is the current main script, which is how the runtime bridge loads; making "${label(target)}" the main script would stop the bridge loading. Call remove_runtime_bridge first, then set_main_script again`);
        }

        const seen: { changed: string[] } = { changed: [] };
        await writer.updateProject(project => {
          const applied = applyMainScript(project as Construct3Project, target.entry.name, target.subfolder);
          if ('missing' in applied) {
            throw new Refusal(`Script "${target.entry.name}" is no longer registered: project.c3proj changed on disk while this call ran. Run the tool again`);
          }
          seen.changed = applied.changed;
          return applied.changed.length === 0 ? false : undefined;
        });
        return toolResult({
          success: true,
          entity: target.entry.name,
          category: 'script-file',
          action: seen.changed.length > 0 ? 'updated' : 'unchanged',
          subfolder: target.subfolder,
          warnings: seen.changed.length > 0
            ? [`script-info purpose changes: ${seen.changed.join('; ')}.`]
            : [`"${args.name}" was already the main script.`],
        }, { projectWritten: seen.changed.length > 0 });
      } catch (error) {
        if (!(error instanceof Refusal)) console.error('[set_main_script] failed:', error);
        return toolError(await failureText(writer, 'Error setting the main script', error));
      }
    },
  );

  server.tool(
    'register_project_file',
    'Copy a file into the directory its Project File family uses (files/, sounds/, music/, videos/, fonts/) and register it with file-info metadata and a collision-safe SID. The registration is written first; a failed copy puts it back. A file that is registered already needs no source (a source given then is not copied, and the result says so). A file at the destination is refused, checked again after the registration, and a third time by the writer under the file lock right before it writes (the registration is then put back); a file another program creates in the moment between that last check and the write is replaced and kept as <file>.bak. A destination reached through a link or junction that leaves the project folder is refused, and so is a name whose <name>.tmp is a registered or existing file (the server writes through it). The server copies any file its process can read. Names are matched with their letter case.',
    {
      name: z.string().min(1).max(255).optional().describe('Destination file name; defaults to the source basename'),
      sourcePath: z.string().min(1).optional().describe('Path to the source file to copy (up to 100 MB)'),
      filePath: z.string().min(1).optional().describe('Alias for sourcePath'),
      source: z.string().min(1).optional().describe('Alias for sourcePath'),
      folder: familyField.optional().describe('Project File family (default: general)'),
      category: familyField.optional().describe('Alias for folder'),
      type: z.string().min(1).max(150).optional().describe('MIME type recorded by Construct 3 (inferred from the extension when omitted)'),
      mimeType: z.string().min(1).max(150).optional().describe('Alias for type'),
      purpose: purposeField.optional().describe('file-info purpose; a new entry gets "none" when omitted, an existing entry keeps its purpose'),
      subfolder: subfolderField.optional().describe('Optional slash-separated subfolder inside the family directory'),
    },
    async (args) => {
      try {
        if (args.folder !== undefined && args.category !== undefined && args.folder !== args.category) {
          return refuse(`folder and category aliases disagree ("${args.folder}" versus "${args.category}")`);
        }
        const folder: RegisteredFileFolder = args.category ?? args.folder ?? 'general';
        const sourcePath = args.sourcePath ?? args.filePath ?? args.source;
        const name = args.name ?? (sourcePath ? basename(sourcePath) : undefined);
        if (!name) return refuse('A name or sourcePath/filePath is required');
        const refusal = nameRefusal(reader.getProject(), folder, name, args.subfolder, 'Project File');
        if (refusal) return refuse(refusal);

        const subfolderParts = args.subfolder ? args.subfolder.split('/') : [];
        const directory = getFileFolderDirectory(folder);
        const relativePath = [directory, ...subfolderParts, name].join('/');
        const base = { entity: name, category: 'project-file' as const, folder, subfolder: args.subfolder, path: relativePath };
        const destination = resolveProjectPath(reader.getProjectDir(), directory, ...subfolderParts, name);

        const known = findFileEntry(reader.getProject(), folder, name, args.subfolder);
        if (known) {
          const { outcome, written } = await registerInProject(writer, reader, {
            folder, name, type: known.entry.type, infoKey: 'file-info', purpose: args.purpose, subfolder: args.subfolder, kind: 'Project File',
          });
          const warnings: string[] = [];
          if (sourcePath) warnings.push(`"${name}" is already registered, so the source was not copied.`);
          if (!(await findFileIgnoringCase(destination))) {
            warnings.push(`${relativePath} is not on disk. To copy a source into it, run deregister_project_file and then register_project_file with the source.`);
          }
          return toolResult({ ...registrationResult(outcome, base), ...(warnings.length > 0 ? { warnings } : {}) }, { projectWritten: written });
        }
        if (!sourcePath) return refuse('sourcePath (or filePath) is required when the Project File is not already registered');
        const source = await readSourceFile(sourcePath);
        if ('refusal' in source) return refuse(source.refusal);
        if (await findFileIgnoringCase(destination)) {
          return refuse(`${relativePath} already exists (or a file whose name differs only in case does) but is not a registered Project File. It was left unchanged. Remove it or choose another name`);
        }
        // Not through a link out of the project; none of the writer's own files in the way
        const blocked = await writeBlocker(reader, folder, name, args.subfolder, destination, relativePath, '.tmp');
        if (blocked) return refuse(blocked);

        const { outcome, written } = await registerInProject(writer, reader, {
          folder, name, type: args.type ?? args.mimeType ?? projectFileMimeType(name), infoKey: 'file-info', purpose: args.purpose, subfolder: args.subfolder, kind: 'Project File',
        });
        // Registered by another writer meanwhile: that file is theirs, not copied over
        if (outcome.kind !== 'added') {
          return toolResult({
            ...registrationResult(outcome, base),
            warnings: [`"${name}" was registered by another writer while this call ran, so the source was not copied.`],
          }, { projectWritten: written });
        }
        // Checked again after the registration: a file another program created meanwhile is left as it is
        if (await findFileIgnoringCase(destination)) {
          return toolError(await failedAfterRegistration(writer, destination, relativePath, `${relativePath} appeared on disk while this call ran and was left as it is`));
        }
        const blockedNow = await writeBlocker(reader, folder, name, args.subfolder, destination, relativePath, '.tmp');
        if (blockedNow) return toolError(await failedAfterRegistration(writer, destination, relativePath, `Nothing was copied: ${blockedNow}`));
        try {
          // expected null: a file that exists when the writer checks under its lock is refused, not replaced
          await writer.replaceFile(destination, source.bytes, { expected: null });
        } catch (error) {
          return toolError(await failedAfterRegistration(writer, destination, relativePath, `Copying the file into ${relativePath} failed (${failureReason(error)})`));
        }
        return toolResult(registrationResult(outcome, base));
      } catch (error) {
        if (!(error instanceof Refusal)) console.error('[register_project_file] failed:', error);
        return toolError(await failureText(writer, 'Error registering Project File', error));
      }
    },
  );

  server.tool(
    'deregister_project_file',
    'Deregister a Project File and delete its file from the directory its family uses; the file is backed up to <file>.bak first (a later delete of the same path replaces that copy; the call is refused, before anything is changed, when <name>.bak is a registered file or a link leaving the project). Only the file that was registered when the call selected it is deleted: one replaced meanwhile is left in place and named. A file reached through a link or junction that leaves the project folder is not deleted. Names are matched with their letter case.',
    {
      name: z.string().min(1).max(255).describe('Project File name'),
      folder: familyField.optional().describe('Project File family (default: general)'),
      category: familyField.optional().describe('Alias for folder'),
      subfolder: subfolderField.optional().describe('Optional slash-separated subfolder inside the family directory'),
    },
    async (args) => {
      try {
        if (args.folder !== undefined && args.category !== undefined && args.folder !== args.category) {
          return refuse(`folder and category aliases disagree ("${args.folder}" versus "${args.category}")`);
        }
        const folder: RegisteredFileFolder = args.category ?? args.folder ?? 'general';
        const refusal = nameRefusal(reader.getProject(), folder, args.name, args.subfolder, 'Project File');
        if (refusal) return refuse(refusal);
        const selected = findFileEntry(reader.getProject(), folder, args.name, args.subfolder);
        if (!selected) {
          return refuse(`Project File "${args.name}" is not registered in ${folder}`);
        }
        const subfolderParts = args.subfolder ? args.subfolder.split('/') : [];
        const directory = getFileFolderDirectory(folder);
        const relativePath = [directory, ...subfolderParts, args.name].join('/');
        const filePath = resolveProjectPath(reader.getProjectDir(), directory, ...subfolderParts, args.name);
        const blocked = await writeBlocker(reader, folder, args.name, args.subfolder, filePath, relativePath, '.bak');
        if (blocked) return refuse(blocked);

        // The file as it is when the registration is selected: only this file is deleted
        const expected = await statFileState(filePath);
        const selectedSid = selected.entry.sid;
        const removed = await writer.updateProject(project => {
          const current = findFileEntry(project as Construct3Project, folder, args.name, args.subfolder);
          if (current && current.entry.sid !== selectedSid) {
            throw new Refusal(`The registration of Project File "${args.name}" changed since this call selected it (it was registered again, or saved in the editor with a new SID), so its file was not touched`);
          }
          return removeFileEntry(project as Construct3Project, folder, args.name, args.subfolder) ? undefined : false;
        });
        if (removed === undefined) return refuse(`Project File "${args.name}" is no longer registered in ${folder}: project.c3proj changed on disk while this call ran`);
        // Checked again before the delete; a link swapped in after this check is not covered
        const blockedNow = (await linkRefusal(reader.getProjectDir(), filePath, relativePath))
          ?? (await linkRefusal(reader.getProjectDir(), `${filePath}.bak`, `${relativePath}.bak`));
        if (blockedNow) return toolError(`Deregistered "${args.name}" but ${blockedNow}. ${relativePath} was left in place.`);
        let backup: string | undefined;
        try {
          backup = await writer.deleteFile(filePath, { expected });
        } catch (error) {
          if (error instanceof StaleFileError) {
            return toolError(`Deregistered "${args.name}", but ${relativePath} was changed since this call selected it, so it was left in place. Check it and remove it by hand if it is not needed.`);
          }
          return toolError(`Deregistered "${args.name}" but could not remove ${relativePath} (${failureReason(error)}). The file is now orphaned; remove it manually.`);
        }
        return toolResult({
          success: true, entity: args.name, category: 'project-file', action: 'deregistered', folder, subfolder: args.subfolder,
          path: relativePath, fileRemoved: backup !== undefined, ...(backup ? { backup: writer.projectRelative(backup) } : {}),
        });
      } catch (error) {
        if (!(error instanceof Refusal)) console.error('[deregister_project_file] failed:', error);
        return toolError(await failureText(writer, 'Error deregistering Project File', error));
      }
    },
  );

  server.tool(
    'create_data_file',
    'Create a Construct 3 data file (Array, Dictionary, JSON or text) under files/ and register it as a general Project File. The registration is written first; a failed write puts it back. A file at the path is refused, checked again after the registration, and a third time by the writer under the file lock right before it writes (the registration is then put back); a file another program creates in the moment between that last check and the write is replaced and kept as <file>.bak. A path through a link or junction that leaves the project folder is refused, and so is a name whose <name>.tmp is a registered or existing file. "array" and "dictionary" write the c2array / c2dictionary bodies the plugins load (an array of up to 1,000,000 cells, counting a depth of 0 as 1); "json" checks the content parses and writes it as given; "text" writes the content as given.',
    {
      name: z.string().min(1).max(255).describe('File name including its extension, for example "levels.json"'),
      kind: z.enum(['array', 'dictionary', 'json', 'text']).describe('Body format'),
      content: z.string().max(5_000_000).optional()
        .describe('dictionary/json: a JSON document. text: the literal body. array: an optional JSON [width][height][depth] data array.'),
      arraySize: z.array(z.number().int().min(0).max(10_000)).length(3).optional().describe('array only: [width, height, depth] (default: [1, 1, 1])'),
      type: z.string().min(1).max(150).optional().describe('MIME type recorded by Construct 3 (inferred from kind when omitted)'),
      purpose: purposeField.optional().describe('file-info purpose (default: none)'),
      subfolder: subfolderField.optional().describe('Optional slash-separated files subfolder'),
    },
    async (args) => {
      try {
        if (args.arraySize !== undefined && args.kind !== 'array') {
          return refuse(`arraySize applies to kind "array" only; kind "${args.kind}" ignores it`);
        }
        const refusal = nameRefusal(reader.getProject(), 'general', args.name, args.subfolder, 'Project File');
        if (refusal) return refuse(refusal);
        const subfolderParts = args.subfolder ? args.subfolder.split('/') : [];
        const directory = getFileFolderDirectory('general');
        const relativePath = [directory, ...subfolderParts, args.name].join('/');
        if (findFileEntry(reader.getProject(), 'general', args.name, args.subfolder)) {
          return refuse(`Project File "${relativePath}" is already registered. Deregister it first, or choose another name`);
        }
        let built: { body: string; type: string };
        try {
          built = buildDataFileBody(args.kind, args.content, args.arraySize);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        const destination = resolveProjectPath(reader.getProjectDir(), directory, ...subfolderParts, args.name);
        if (await findFileIgnoringCase(destination)) {
          return refuse(`A file already exists at ${relativePath} (or one whose name differs only in case). It was left unchanged. Remove it or choose another name`);
        }
        // Not through a link out of the project; none of the writer's own files in the way
        const blocked = await writeBlocker(reader, 'general', args.name, args.subfolder, destination, relativePath, '.tmp');
        if (blocked) return refuse(blocked);

        const base = { entity: args.name, category: 'project-file' as const, folder: 'general' as const, subfolder: args.subfolder, path: relativePath };
        // Create-only: another writer's registration of the name meanwhile is refused inside the update
        const { outcome } = await registerInProject(writer, reader, {
          folder: 'general', name: args.name, type: args.type ?? built.type, infoKey: 'file-info', purpose: args.purpose, subfolder: args.subfolder,
          kind: 'Project File', createOnly: true,
        });
        // Checked again after the registration: a file another program created meanwhile is left as it is
        if (await findFileIgnoringCase(destination)) {
          return toolError(await failedAfterRegistration(writer, destination, relativePath, `${relativePath} appeared on disk while this call ran and was left as it is`));
        }
        const blockedNow = await writeBlocker(reader, 'general', args.name, args.subfolder, destination, relativePath, '.tmp');
        if (blockedNow) return toolError(await failedAfterRegistration(writer, destination, relativePath, `Nothing was written: ${blockedNow}`));
        try {
          // expected null: a file that exists when the writer checks under its lock is refused, not replaced
          await writer.replaceFile(destination, built.body, { expected: null });
        } catch (error) {
          return toolError(await failedAfterRegistration(writer, destination, relativePath, `Writing ${relativePath} failed (${failureReason(error)})`));
        }
        return toolResult({ ...registrationResult(outcome, base), action: 'created', kind: args.kind });
      } catch (error) {
        if (!(error instanceof Refusal)) console.error('[create_data_file] failed:', error);
        return toolError(await failureText(writer, 'Error creating data file', error));
      }
    },
  );
}
