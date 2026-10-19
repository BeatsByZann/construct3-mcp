/**
 * Flowchart tools: list_flowcharts, get_flowchart_details, create_flowchart,
 * delete_flowchart, add_flowchart_node, update_flowchart_node,
 * delete_flowchart_node, add_flowchart_output, update_flowchart_output,
 * delete_flowchart_output, reorder_flowchart_outputs,
 * connect_flowchart_nodes, disconnect_flowchart_nodes.
 *
 * The data model is in construct3/flowchart-model.ts, the files and the
 * project.c3proj registration in construct3/flowchart-files.ts. A tool that
 * changes a flowchart reads its file, changes it in memory, and writes it
 * back once through the project writer, or refuses before anything is
 * written.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import { validateName, validateSubfolder, toolResult, toolError, folderCaseClashError } from './shared.js';
import { withProjectSync } from './project-sync.js';
import { unknownKeysErrorMap } from './event-helpers.js';
import { StaleFileError } from '../construct3/disk-state.js';
import { findFileIgnoringCase } from '../construct3/atomic-write.js';
import { findFolderPathClash, findNameClash } from '../construct3/names.js';
import { FLOWCHART_PLUGIN_ID, createFlowchartData, locateFlowcharts } from '../construct3/flowchart-model.js';
import {
  createFlowchartFile,
  deleteFlowchartFiles,
  describeError,
  flowchartFilePath,
  openFlowchart,
} from '../construct3/flowchart-files.js';

/** The project reader the tools are registered with (flowchart-files.ts has its own narrower `Reader`). */
type ProjectReader = MutationToolDeps['reader'];

// ─── Answers ───────────────────────────────────────────────

/** A refusal of a tool that writes: given before the first change, so it says nothing was changed. */
function refuse(message: string) {
  return toolError(`${/[.?!]$/.test(message) ? message : `${message}.`} Nothing was changed.`);
}

/** The answer to an error thrown before the tool's first write. */
function stoppedBeforeWrite(error: unknown) {
  if (error instanceof StaleFileError) return toolError(error.message);
  return toolError(`The change was stopped before anything was written: ${describeError(error)}. Nothing was changed.`);
}

/** The folders of a flowchart registered under exactly this name, or the sentence that says why it is not found. */
function lookupFlowchart(reader: ProjectReader, name: string): { folders: string[] } | { refusal: string } {
  const { flowcharts, unresolved } = locateFlowcharts(reader.getProject().flowcharts);
  const folders = flowcharts.get(name);
  if (folders) return { folders };
  if (unresolved.has(name)) {
    return { refusal: `Flowchart "${name}" is registered in project.c3proj in a folder without a name, so its file cannot be resolved. The flowchart tools do not read, change or delete it.` };
  }
  const registered = findNameClash(name, flowcharts.keys());
  if (registered !== undefined) {
    return { refusal: `Flowchart "${name}" not found: names are matched with their letter case. Did you mean "${registered}"?` };
  }
  return { refusal: `Flowchart "${name}" not found. Use list_flowcharts to see all available names.` };
}

/**
 * Why a flowchart cannot be created in this `flowcharts` entry of
 * project.c3proj, as a sentence, or undefined: a name registered in a
 * folder without a name, a name registered already or differing only in
 * case (in any folder), a folder differing only in case. It runs before the
 * create and again inside the update that registers the flowchart, on every
 * round, so a save of the editor in between is checked too.
 */
function createRefusal(container: unknown, name: string, subfolder: string | undefined): string | undefined {
  const located = locateFlowcharts(container as Parameters<typeof locateFlowcharts>[0]);
  if (located.unresolved.has(name)) {
    return `Flowchart "${name}" is registered in project.c3proj in a folder without a name, so its file cannot be resolved; creating it again would register the name twice. Choose another name, or fix the folder in project.c3proj first.`;
  }
  const existing = findNameClash(name, [...located.flowcharts.keys(), ...located.unresolved]);
  if (existing === name) return `Flowchart "${name}" already exists.`;
  if (existing !== undefined) {
    return `"${name}" differs only in case from the existing flowchart "${existing}". Flowchart names are matched with their letter case here, and on Windows and macOS two such names in one folder are one file. Choose a different name.`;
  }
  if (subfolder !== undefined) {
    const folderClash = findFolderPathClash(container as Parameters<typeof findFolderPathClash>[0], subfolder);
    if (folderClash !== undefined) return folderCaseClashError(subfolder, folderClash);
  }
  return undefined;
}

/**
 * The object schema of a tool that writes: strict, so an argument the tool
 * does not take is refused instead of dropped.
 */
function strictArguments<Shape extends z.ZodRawShape>(tool: string, shape: Shape) {
  const keys = Object.keys(shape);
  const list = keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
  return z.object(shape, { errorMap: unknownKeysErrorMap(`the arguments of ${tool}`, `${tool} takes ${list}.`) }).strict();
}

// ─── Zod fragments ─────────────────────────────────────────

const createShape = {
  name: z.string().max(200).describe('Flowchart name'),
  subfolder: z.string().max(500).optional().describe('Subfolder within flowcharts/ (e.g. "AI Graph/State Machines")'),
};

const deleteShape = {
  name: z.string().max(200).describe('Flowchart name to delete'),
};

// ─── Registration ──────────────────────────────────────────

/** Register the flowchart tools on the server. */
export function registerFlowchartTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);

  // ─── list_flowcharts ────────────────────────────────────

  server.tool(
    'list_flowcharts',
    'List all flowcharts in the project (root and every subfolder)',
    {},
    async () => {
      try {
        const names = [...locateFlowcharts(reader.getProject().flowcharts).flowcharts.keys()];
        return toolResult({ flowcharts: names, count: names.length });
      } catch (error) {
        console.error('[list_flowcharts] failed:', error);
        return toolError(`Error listing flowcharts: ${describeError(error)}.`);
      }
    }
  );

  // ─── get_flowchart_details ──────────────────────────────

  server.tool(
    'get_flowchart_details',
    'Get the full contents of a flowchart: its nodes, outputs and connections',
    {
      name: z.string().max(200).describe('Flowchart name'),
    },
    async (args) => {
      try {
        const found = lookupFlowchart(reader, args.name);
        if ('refusal' in found) return toolError(found.refusal);
        const opened = await openFlowchart(reader, args.name, found.folders);
        if (!opened.ok) return toolError(opened.refusal);
        return toolResult(opened.flowchart.data);
      } catch (error) {
        console.error('[get_flowchart_details] failed:', error);
        return toolError(`Error getting flowchart details: ${describeError(error)}.`);
      }
    }
  );

  // ─── create_flowchart ───────────────────────────────────

  server.registerTool(
    'create_flowchart',
    {
      description: 'Create a new, empty flowchart file and register it in project.c3proj. Warns when the Flowchart plugin is not in the project: the editor loads the flowchart anyway, but a Flowchart object is needed to use it at runtime.',
      inputSchema: strictArguments('create_flowchart', createShape),
    },
    async (args) => {
      try {
        try {
          validateName(args.name);
          if (args.subfolder !== undefined) validateSubfolder(args.subfolder);
        } catch (error) {
          return refuse(describeError(error));
        }

        // Taken before the checks: generating a SID loads project.c3proj again when a file
        // the generator scanned changed on disk, and the checks must use the project that
        // assertProjectFileCurrent (in createFlowchartFile) then compares with the disk
        const sid = await idGen.generateSid(reader);

        // The same checks run again inside the registration's project update, on the project it reads
        const check = (container: unknown) => createRefusal(container, args.name, args.subfolder);
        const refusal = check(reader.getProject().flowcharts);
        if (refusal !== undefined) return refuse(refusal);

        const folders = args.subfolder === undefined ? [] : args.subfolder.split('/');
        const onDisk = await findFileIgnoringCase(flowchartFilePath(reader.getProjectDir(), args.name, folders));
        if (onDisk !== undefined) {
          return refuse(`The file ${writer.projectRelative(onDisk)} already exists: it is not a registered flowchart, or it is registered under a name that differs only in case. It was left unchanged. Choose another name, or, if the file is a leftover of a deleted flowchart, check it and remove it first.`);
        }

        const warnings: string[] = [];
        // Read once, and last before the write; a missing or damaged usedAddons is only the warning
        const addons: unknown = reader.getUsedAddons();
        const hasPlugin = Array.isArray(addons) && addons.some(a => typeof a === 'object' && a !== null
          && (a as { type?: unknown }).type === 'plugin' && (a as { id?: unknown }).id === FLOWCHART_PLUGIN_ID);
        if (!hasPlugin) {
          // A load check on r495.2 showed the editor opens a project whose flowchart has no
          // Flowchart plugin (it even prunes the unused plugin), so this is advisory.
          warnings.push(
            `The Flowchart plugin is not listed in this project's usedAddons. The editor loads the flowchart, ` +
            `but add a Flowchart object in the Construct 3 editor before using it at runtime; this tool does not register plugins.`
          );
        }

        const created = await createFlowchartFile(reader, writer, args.name, folders, createFlowchartData(sid, args.name), check);
        if (!created.ok) return toolError(created.message);
        return toolResult({
          success: true,
          entity: args.name,
          category: 'flowchart',
          action: 'created',
          generatedSid: sid,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        console.error('[create_flowchart] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── delete_flowchart ───────────────────────────────────

  server.registerTool(
    'delete_flowchart',
    {
      description: 'Delete a flowchart: remove its file (keeping a .bak) and its project.c3proj registration',
      inputSchema: strictArguments('delete_flowchart', deleteShape),
    },
    async (args) => {
      try {
        const found = lookupFlowchart(reader, args.name);
        if ('refusal' in found) return refuse(found.refusal);
        const deleted = await deleteFlowchartFiles(reader, writer, args.name, found.folders);
        if (!deleted.ok) return toolError(deleted.message);
        return toolResult({
          success: true,
          entity: args.name,
          category: 'flowchart',
          action: 'deleted',
          backupFile: deleted.backupFile,
          ...(deleted.warnings.length > 0 ? { warnings: deleted.warnings } : {}),
        });
      } catch (error) {
        console.error('[delete_flowchart] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );
}
