/** Registration and lifecycle tools for C3 scripts and imported Project Files. */

import { z } from 'zod';
import { basename, extname, join } from 'node:path';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { MutationToolDeps } from './shared.js';
import { toolError, toolResult, validateFileName, validateSubfolder } from './shared.js';
import {
  findFileEntry,
  getFileFolderDirectory,
  listFileEntries,
  type RegisteredFileFolder,
} from '../construct3/file-registration.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

const scriptType = z.string().min(1).max(100).optional().default('application/javascript');
const purposeType = z.string().min(1).max(100).optional().default('none');
const subfolderType = z.string().max(500).optional();
const scriptFolderSchema = {
  name: z.string().min(1).max(255).describe('Script file name, without a folder path'),
  type: scriptType.describe('MIME type recorded by Construct 3'),
  purpose: purposeType.describe('Construct 3 script-info purpose'),
  subfolder: subfolderType.describe('Optional slash-separated script subfolder'),
};

const projectFolder = z.enum(['general', 'sound', 'music', 'video', 'font']).optional();

function projectFileType(name: string, explicit?: string): string {
  if (explicit) return explicit;
  switch (extname(name).toLowerCase()) {
    case '.json': return 'application/json';
    case '.js': return 'application/javascript';
    case '.css': return 'text/css';
    case '.html': case '.htm': return 'text/html';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webm': return 'video/webm';
    case '.mp4': return 'video/mp4';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}

/** Kinds of data file create_data_file can write. */
type DataFileKind = 'array' | 'dictionary' | 'json' | 'text';

function parseJsonArgument(content: string, kind: DataFileKind): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`content for kind "${kind}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Build the file body Construct 3 expects for a data file.
 *
 * Array files are `{"c2array":true,"size":[w,h,d],"data":[[[...]]]}` and
 * Dictionary files are `{"c2dictionary":true,"data":{}}`; both are the shapes
 * the Array and Dictionary plugins load through AJAX. JSON and text files are
 * written verbatim for a project that reads them itself.
 */
function buildDataFileBody(
  kind: DataFileKind,
  content: string | undefined,
  arraySize: number[] | undefined,
): { body: string; type: string } {
  if (kind === 'array') {
    const width = arraySize?.[0] ?? 1;
    const height = arraySize?.[1] ?? 1;
    const depth = arraySize?.[2] ?? 1;
    let data: unknown;
    if (content !== undefined) {
      const parsed = parseJsonArgument(content, kind);
      if (!Array.isArray(parsed) || parsed.length !== width) {
        throw new Error(`content for kind "array" must be a JSON array of ${width} column(s) to match arraySize.`);
      }
      for (const column of parsed) {
        if (!Array.isArray(column) || column.length !== height) {
          throw new Error(`content for kind "array" must nest ${height} row(s) in every column to match arraySize.`);
        }
        for (const cell of column) {
          if (!Array.isArray(cell) || cell.length !== depth) {
            throw new Error(`content for kind "array" must nest ${depth} value(s) in every cell to match arraySize.`);
          }
        }
      }
      data = parsed;
    } else {
      data = Array.from({ length: width }, () =>
        Array.from({ length: height }, () => Array.from({ length: depth }, () => 0)));
    }
    return { body: JSON.stringify({ c2array: true, size: [width, height, depth], data }), type: 'application/json' };
  }

  if (kind === 'dictionary') {
    let data: unknown = {};
    if (content !== undefined) {
      const parsed = parseJsonArgument(content, kind);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('content for kind "dictionary" must be a JSON object holding the dictionary keys.');
      }
      data = parsed;
    }
    return { body: JSON.stringify({ c2dictionary: true, data }), type: 'application/json' };
  }

  if (kind === 'json') {
    const parsed = parseJsonArgument(content ?? '{}', kind);
    return { body: JSON.stringify(parsed, null, 2), type: 'application/json' };
  }

  return { body: content ?? '', type: 'text/plain' };
}

function parseFolder(folder: RegisteredFileFolder | undefined, category: RegisteredFileFolder | undefined): RegisteredFileFolder {
  if (folder !== undefined && category !== undefined && folder !== category) {
    throw new Error(`folder and category aliases disagree ("${folder}" versus "${category}")`);
  }
  return category ?? folder ?? 'general';
}

export function registerFileTools({ server, reader, writer }: MutationToolDeps): void {
  server.tool(
    'register_script_file',
    'Register an existing script file in rootFileFolders.script using Construct 3 script-info metadata and a collision-safe SID.',
    scriptFolderSchema,
    async (args) => {
      try {
        validateFileName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);
        const result = await writer.registerFileEntry('script', args.name, args.type, 'script-info', args.purpose, args.subfolder);
        return toolResult({
          success: true,
          entity: args.name,
          category: 'script-file',
          action: result.registered ? 'registered' : 'already_registered',
          generatedSid: result.sid,
          subfolder: args.subfolder,
        });
      } catch (error) {
        console.error('[register_script_file] failed:', error);
        return toolError(`Error registering script file: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'deregister_script_file',
    'Remove a script file registration from rootFileFolders.script. The script file itself is preserved.',
    {
      name: z.string().min(1).max(255).describe('Script file name'),
      subfolder: subfolderType.describe('Optional slash-separated script subfolder'),
    },
    async (args) => {
      try {
        validateFileName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);
        const removed = await writer.deregisterFileEntry('script', args.name, args.subfolder);
        if (!removed) return toolError(`Script file "${args.name}" is not registered in this project.`);
        return toolResult({ success: true, entity: args.name, category: 'script-file', action: 'deregistered', subfolder: args.subfolder });
      } catch (error) {
        console.error('[deregister_script_file] failed:', error);
        return toolError(`Error deregistering script file: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'register_project_file',
    'Copy a file into the directory its Project File family uses (files/, sounds/, music/, videos/, fonts/) and register it with file-info metadata and a collision-safe SID.',
    {
      name: z.string().min(1).max(255).optional().describe('Destination file name; defaults to the source basename'),
      sourcePath: z.string().min(1).optional().describe('Path to the source file to copy'),
      filePath: z.string().min(1).optional().describe('Alias for sourcePath'),
      source: z.string().min(1).optional().describe('Alias for sourcePath'),
      folder: projectFolder.describe('Project File family'),
      category: z.enum(['general', 'sound', 'music', 'video', 'font']).optional().describe('Alias for folder'),
      type: z.string().min(1).max(150).optional().describe('MIME type recorded by Construct 3'),
      mimeType: z.string().min(1).max(150).optional().describe('Alias for type'),
      purpose: purposeType.describe('Construct 3 file-info purpose'),
      subfolder: subfolderType.describe('Optional slash-separated subfolder inside the family directory'),
    },
    async (args) => {
      let destinationPath: string | undefined;
      let copied = false;
      try {
        const folder = parseFolder(args.folder, args.category);
        const sourcePath = args.sourcePath ?? args.filePath ?? args.source;
        const name = args.name ?? (sourcePath ? basename(sourcePath) : undefined);
        if (!name) return toolError('A name or sourcePath/filePath is required.');
        validateFileName(name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        const existing = findFileEntry(reader.getProject(), folder, name, args.subfolder);
        if (existing) {
          // Route existing entries through the writer too: this keeps the
          // short-circuit idempotent while repairing legacy script-info keys
          // and duplicate registrations under the same folder path.
          const repaired = await writer.registerFileEntry(
            folder,
            name,
            existing.entry.type,
            'file-info',
            args.purpose,
            args.subfolder,
          );
          return toolResult({ success: true, entity: name, category: 'project-file', action: 'already_registered', generatedSid: repaired.sid ?? existing.entry.sid, folder, subfolder: args.subfolder });
        }
        if (!sourcePath) return toolError('sourcePath (or filePath) is required when the Project File is not already registered.');

        const sourceStat = await stat(sourcePath);
        if (!sourceStat.isFile()) return toolError('Source path is not a file.');
        // C3 keeps each Project File family in its own directory: general files
        // under files/, sound entries under sounds/, and so on. Copying every
        // family into files/ would leave the registration pointing at nothing.
        const directory = getFileFolderDirectory(folder);
        const relativePath = `${directory}/${args.subfolder ? args.subfolder + '/' : ''}${name}`;
        destinationPath = resolveProjectPath(reader.getProjectDir(), directory, ...(args.subfolder ? [args.subfolder] : []), name);
        await mkdir(join(reader.getProjectDir(), directory, ...(args.subfolder ? args.subfolder.split('/') : [])), { recursive: true });
        try {
          await stat(destinationPath);
          return toolError(`Project file destination already exists but is not registered: ${relativePath}`);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') throw error;
        }
        await copyFile(sourcePath, destinationPath);
        copied = true;
        const result = await writer.registerFileEntry(folder, name, args.type ?? args.mimeType ?? projectFileType(name), 'file-info', args.purpose, args.subfolder);
        return toolResult({ success: true, entity: name, category: 'project-file', action: result.registered ? 'registered' : 'already_registered', generatedSid: result.sid, folder, subfolder: args.subfolder, path: relativePath });
      } catch (error) {
        if (copied && destinationPath) {
          try { await unlink(destinationPath); } catch { /* best effort */ }
        }
        console.error('[register_project_file] failed:', error);
        return toolError(`Error registering Project File: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'deregister_project_file',
    'Deregister a Project File and remove its file from the directory its family uses.',
    {
      name: z.string().min(1).max(255).describe('Project File name'),
      folder: projectFolder.describe('Project File family'),
      category: z.enum(['general', 'sound', 'music', 'video', 'font']).optional().describe('Alias for folder'),
      subfolder: subfolderType.describe('Optional slash-separated subfolder inside the family directory'),
    },
    async (args) => {
      try {
        const folder = parseFolder(args.folder, args.category);
        validateFileName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);
        const existing = findFileEntry(reader.getProject(), folder, args.name, args.subfolder);
        if (!existing) return toolError(`Project File "${args.name}" is not registered in ${folder}.`);
        const directory = getFileFolderDirectory(folder);
        const relativePath = `${directory}/${args.subfolder ? args.subfolder + '/' : ''}${args.name}`;
        const removed = await writer.deregisterFileEntry(folder, args.name, args.subfolder);
        if (!removed) return toolError(`Project File "${args.name}" is no longer registered in ${folder}.`);
        const filePath = resolveProjectPath(reader.getProjectDir(), directory, ...(args.subfolder ? [args.subfolder] : []), args.name);
        try { await unlink(filePath); } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
            return toolError(`Deregistered "${args.name}" but could not remove ${relativePath}: ${error instanceof Error ? error.message : String(error)}. The file is now orphaned; remove it manually.`);
          }
        }
        return toolResult({ success: true, entity: args.name, category: 'project-file', action: 'deregistered', folder, subfolder: args.subfolder, path: relativePath });
      } catch (error) {
        console.error('[deregister_project_file] failed:', error);
        return toolError(`Error deregistering Project File: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'create_data_file',
    'Create a Construct 3 data file (Array, Dictionary, JSON, or text) under files/ and register it as a general Project File.',
    {
      name: z.string().min(1).max(255).describe('File name including its extension, for example "levels.json"'),
      kind: z.enum(['array', 'dictionary', 'json', 'text']).describe('Body format: array and dictionary write the c2array/c2dictionary wrappers'),
      content: z.string().max(5_000_000).optional()
        .describe('dictionary/json: a JSON document. text: the literal body. array: an optional JSON [width][height][depth] data array.'),
      arraySize: z.array(z.number().int().min(0).max(10_000)).length(3).optional()
        .describe('array only: [width, height, depth] (default: [1, 1, 1])'),
      type: z.string().min(1).max(150).optional().describe('MIME type recorded by Construct 3 (inferred from kind when omitted)'),
      purpose: purposeType.describe('Construct 3 file-info purpose'),
      subfolder: subfolderType.describe('Optional slash-separated files subfolder'),
    },
    async (args) => {
      let destinationPath: string | undefined;
      let written = false;
      try {
        validateFileName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);
        if (args.arraySize !== undefined && args.kind !== 'array') {
          return toolError(`arraySize applies to kind "array" only; kind "${args.kind}" ignores it.`);
        }

        const directory = getFileFolderDirectory('general');
        const relativePath = `${directory}/${args.subfolder ? args.subfolder + '/' : ''}${args.name}`;

        const existing = findFileEntry(reader.getProject(), 'general', args.name, args.subfolder);
        if (existing) {
          return toolError(`Project File "${relativePath}" is already registered. Deregister it first, or choose another name.`);
        }

        const built = buildDataFileBody(args.kind, args.content, args.arraySize);

        destinationPath = resolveProjectPath(reader.getProjectDir(), directory, ...(args.subfolder ? [args.subfolder] : []), args.name);
        await mkdir(join(reader.getProjectDir(), directory, ...(args.subfolder ? args.subfolder.split('/') : [])), { recursive: true });
        try {
          await stat(destinationPath);
          return toolError(`A file already exists at ${relativePath}. create_data_file never overwrites an existing file.`);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') throw error;
        }

        await writeFile(destinationPath, built.body, 'utf8');
        written = true;

        const result = await writer.registerFileEntry('general', args.name, args.type ?? built.type, 'file-info', args.purpose, args.subfolder);
        return toolResult({
          success: true,
          entity: args.name,
          category: 'project-file',
          action: result.registered ? 'created' : 'already_registered',
          generatedSid: result.sid,
          folder: 'general',
          kind: args.kind,
          subfolder: args.subfolder,
          path: relativePath,
        });
      } catch (error) {
        if (written && destinationPath) {
          try { await unlink(destinationPath); } catch { /* best effort */ }
        }
        console.error('[create_data_file] failed:', error);
        return toolError(`Error creating data file: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'set_main_script',
    'Mark one registered script as the project main script, clearing script-info purpose "main" from every other script.',
    {
      name: z.string().min(1).max(255).describe('Registered script file name'),
      subfolder: subfolderType.describe('Script subfolder, required only when the same name is registered more than once'),
    },
    async (args) => {
      try {
        validateFileName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);

        // Snapshot the tree before writing: every registerFileEntry call
        // reloads the project, which replaces the entry objects.
        const entries = listFileEntries(reader.getProject(), 'script').map(located => ({
          name: located.entry.name,
          subfolder: located.subfolder,
          type: located.entry.type,
          purpose: located.entry['script-info']?.purpose ?? 'none',
        }));

        const matches = entries.filter(entry =>
          entry.name === args.name && (args.subfolder === undefined || entry.subfolder === args.subfolder));
        if (matches.length === 0) {
          const registered = entries.map(entry => `${entry.subfolder ? entry.subfolder + '/' : ''}${entry.name}`).join(', ');
          return toolError(`Script "${args.name}" is not registered in this project. Registered scripts: ${registered || '(none)'}.`);
        }
        if (matches.length > 1) {
          const paths = matches.map(entry => `${entry.subfolder ? entry.subfolder + '/' : ''}${entry.name}`).join(', ');
          return toolError(`Script "${args.name}" is registered in more than one script folder (${paths}). Pass subfolder to choose one.`);
        }
        const target = matches[0];

        // Exactly one script may carry purpose "main", so clear it everywhere else.
        const changes: string[] = [];
        for (const entry of entries) {
          const desired = entry === target ? 'main' : (entry.purpose === 'main' ? 'none' : entry.purpose);
          if (desired === entry.purpose) continue;
          await writer.registerFileEntry('script', entry.name, entry.type, 'script-info', desired, entry.subfolder);
          changes.push(`${entry.subfolder ? entry.subfolder + '/' : ''}${entry.name} -> ${desired}`);
        }

        return toolResult({
          success: true,
          entity: target.name,
          category: 'script-file',
          action: changes.length > 0 ? 'updated' : 'unchanged',
          subfolder: target.subfolder,
          warnings: changes.length > 0
            ? [`script-info purpose changes: ${changes.join('; ')}.`]
            : [`"${args.name}" was already the main script.`],
        });
      } catch (error) {
        console.error('[set_main_script] failed:', error);
        return toolError(`Error setting the main script: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
