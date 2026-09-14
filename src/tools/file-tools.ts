/** Registration and lifecycle tools for C3 scripts and imported Project Files. */

import { z } from 'zod';
import { basename, extname, join } from 'node:path';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import type { MutationToolDeps } from './shared.js';
import { toolError, toolResult, validateFileName, validateSubfolder } from './shared.js';
import { findFileEntry, type RegisteredFileFolder } from '../construct3/file-registration.js';
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
    'Copy a file into files/ and register it in a Construct 3 Project File folder with file-info metadata and a collision-safe SID.',
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
      subfolder: subfolderType.describe('Optional slash-separated files subfolder'),
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
        if (!sourceStat.isFile()) return toolError(`Source path is not a file: ${sourcePath}`);
        destinationPath = resolveProjectPath(reader.getProjectDir(), 'files', ...(args.subfolder ? [args.subfolder] : []), name);
        await mkdir(join(reader.getProjectDir(), 'files', ...(args.subfolder ? args.subfolder.split('/') : [])), { recursive: true });
        try {
          await stat(destinationPath);
          return toolError(`Project file destination already exists but is not registered: files/${args.subfolder ? args.subfolder + '/' : ''}${name}`);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') throw error;
        }
        await copyFile(sourcePath, destinationPath);
        copied = true;
        const result = await writer.registerFileEntry(folder, name, args.type ?? args.mimeType ?? projectFileType(name), 'file-info', args.purpose, args.subfolder);
        return toolResult({ success: true, entity: name, category: 'project-file', action: result.registered ? 'registered' : 'already_registered', generatedSid: result.sid, folder, subfolder: args.subfolder, path: `files/${args.subfolder ? args.subfolder + '/' : ''}${name}` });
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
    'Deregister a Project File and remove its file under files/.',
    {
      name: z.string().min(1).max(255).describe('Project File name'),
      folder: projectFolder.describe('Project File family'),
      category: z.enum(['general', 'sound', 'music', 'video', 'font']).optional().describe('Alias for folder'),
      subfolder: subfolderType.describe('Optional slash-separated files subfolder'),
    },
    async (args) => {
      try {
        const folder = parseFolder(args.folder, args.category);
        validateFileName(args.name);
        if (args.subfolder) validateSubfolder(args.subfolder);
        const existing = findFileEntry(reader.getProject(), folder, args.name, args.subfolder);
        if (!existing) return toolError(`Project File "${args.name}" is not registered in ${folder}.`);
        const relativePath = `files/${args.subfolder ? args.subfolder + '/' : ''}${args.name}`;
        const removed = await writer.deregisterFileEntry(folder, args.name, args.subfolder);
        if (!removed) return toolError(`Project File "${args.name}" is no longer registered in ${folder}.`);
        const filePath = resolveProjectPath(reader.getProjectDir(), 'files', ...(args.subfolder ? [args.subfolder] : []), args.name);
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
}
