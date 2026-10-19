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
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  FLOWCHART_PLUGIN_ID,
  VALUE_TYPES,
  applyCommentFields,
  changeValueType,
  clearOtherStartNodes,
  createFlowchartData,
  createOutput,
  defaultedWarning,
  disconnectOutput,
  findNode,
  findOutput,
  hasCommentInput,
  locateFlowcharts,
  nodeNotFoundMessage,
  outputNotFoundMessage,
  removeNodeReferences,
  startNodeWarnings,
  type FlowchartNode,
  type FlowchartOutput,
} from '../construct3/flowchart-model.js';
import {
  createFlowchartFile,
  deleteFlowchartFiles,
  describeError,
  flowchartFilePath,
  openFlowchart,
  writeFlowchart,
  type OpenedFlowchart,
} from '../construct3/flowchart-files.js';
import type { WriteResult } from '../construct3/types.js';

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

const outputInput = z.object({
  name: z.string().min(1).max(200).describe('Output pin name'),
  value: z.string().max(1000).optional().describe('Output value (default: empty string)'),
  enabled: z.boolean().optional().describe('Enable the output (default: true)'),
  isDefault: z.boolean().optional().describe('Mark the output as the default (default: false)'),
}, {
  errorMap: unknownKeysErrorMap('an output of add_flowchart_node', 'An output has name, value, enabled and isDefault.'),
}).strict();

const commentFields = {
  commentText: z.string().max(20000).optional().describe('Comment node: body as plain text, stored as the editor\'s HTML (the "n" field)'),
  commentHtml: z.string().max(40000).optional().describe('Comment node: body as HTML, stored unchanged (the "n" field); give this or commentText'),
  font: z.string().min(1).max(100).optional().describe('Comment node: font face ("fo"), e.g. "Arial"'),
  fontSize: z.number().positive().max(1000).optional().describe('Comment node: font size ("fs"), e.g. 24'),
  bold: z.boolean().optional().describe('Comment node: bold ("fb")'),
  italic: z.boolean().optional().describe('Comment node: italic ("fi")'),
  fontColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Comment node: font color as "#rrggbb" ("fc")'),
};

const addNodeShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  caption: z.string().max(500).describe('Node caption (the "c" field)'),
  nodeType: z.string().max(200).optional().describe('Node type/title (the "t" field; defaults to the caption)'),
  x: z.number().finite().describe('Canvas X position'),
  y: z.number().finite().describe('Canvas Y position'),
  width: z.number().finite().positive().optional().default(DEFAULT_NODE_WIDTH).describe(`Box width (default: ${DEFAULT_NODE_WIDTH})`),
  height: z.number().finite().positive().optional().default(DEFAULT_NODE_HEIGHT).describe(`Box height (default: ${DEFAULT_NODE_HEIGHT})`),
  isStart: z.boolean().optional().default(false).describe('Make this the start node; clears the flag on every other node (default: false)'),
  enabled: z.boolean().optional().default(true).describe('Enable the node (default: true)'),
  valueType: z.enum(VALUE_TYPES).optional().default('dictionary').describe('Value type ("ty"): "dictionary" or "comment" (default: dictionary). A comment node takes no outputs and the comment fields below'),
  outputs: z.array(outputInput).max(100).optional().describe('Output pins to create on the node'),
  ...commentFields,
};

const updateNodeShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  nodeSid: z.number().int().describe('SID of the node to update'),
  caption: z.string().max(500).optional().describe('New caption (the "c" field)'),
  nodeType: z.string().max(200).optional().describe('New node type/title (the "t" field)'),
  tags: z.string().max(500).optional().describe('Writes a "tags" key. NOT OBSERVED in any r495 sample flowchart; use at your own risk'),
  isStart: z.boolean().optional().describe('Make this the start node (clears the flag on every other node), or clear it'),
  enabled: z.boolean().optional().describe('Enable/disable the node'),
  parentIndex: z.number().int().min(0).optional().describe('The "pi" field; observed values 0, 1 and 2, meaning not determined'),
  x: z.number().finite().optional().describe('New canvas X position'),
  y: z.number().finite().optional().describe('New canvas Y position'),
  width: z.number().finite().positive().optional().describe('New box width'),
  height: z.number().finite().positive().optional().describe('New box height'),
  valueType: z.enum(VALUE_TYPES).optional().describe('New value type ("ty"). To "comment": the node must have no outputs or connections; its caption becomes the comment body unless one is given, and "t" is cleared. To "dictionary": the comment fields are removed and an empty "t" takes the caption'),
  ...commentFields,
};

const deleteNodeShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  nodeSid: z.number().int().describe('SID of the node to delete'),
};

const addOutputShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  nodeSid: z.number().int().describe('SID of the node to add the output to'),
  name: z.string().min(1).max(200).describe('Output pin name'),
  value: z.string().max(1000).optional().default('').describe('Output value (default: empty string)'),
  enabled: z.boolean().optional().default(true).describe('Enable the output (default: true)'),
  isDefault: z.boolean().optional().default(false).describe('Mark the output as the default (default: false)'),
  index: z.number().int().min(0).optional().describe('Insertion index in the outputs array (default: append)'),
};

const updateOutputShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  outputSid: z.number().int().describe('SID of the output to update'),
  name: z.string().min(1).max(200).optional().describe('New output pin name'),
  value: z.string().max(1000).optional().describe('New output value'),
  enabled: z.boolean().optional().describe('Enable/disable the output'),
  isDefault: z.boolean().optional().describe('Mark/unmark the output as the default'),
};

const deleteOutputShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  outputSid: z.number().int().describe('SID of the output to delete'),
};

const reorderShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  nodeSid: z.number().int().describe('SID of the node whose outputs to reorder'),
  outputSids: z.array(z.number().int()).min(1).max(200).describe('The node\'s output SIDs in their new order'),
};

const connectShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  outputSid: z.number().int().describe('SID of the source output pin'),
  targetNodeSid: z.number().int().describe('SID of the node to connect to'),
};

const disconnectShape = {
  flowchartName: z.string().max(200).describe('Flowchart name'),
  outputSid: z.number().int().describe('SID of the output pin to disconnect'),
};

// ─── Registration ──────────────────────────────────────────

export function registerFlowchartTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);

  /** Open a registered flowchart for a tool that changes it: the flowchart, or the tool result that refuses. */
  async function openForChange(name: string): Promise<{ flowchart: OpenedFlowchart } | { result: ReturnType<typeof toolError> }> {
    const found = lookupFlowchart(reader, name);
    if ('refusal' in found) return { result: refuse(found.refusal) };
    const opened = await openFlowchart(reader, name, found.folders);
    if (!opened.ok) return { result: refuse(opened.refusal) };
    return { flowchart: opened.flowchart };
  }

  /** Write a changed flowchart back and answer with `result` (plus the backup file and `extra`), or with the write's failure. */
  async function saveAndReport(flowchart: OpenedFlowchart, result: WriteResult, extra: Record<string, unknown> = {}) {
    const written = await writeFlowchart(reader, writer, flowchart);
    if (!written.ok) return toolError(written.message);
    return toolResult({ ...result, backupFile: written.backupFile, ...extra });
  }

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

  // ─── add_flowchart_node ─────────────────────────────────

  server.registerTool(
    'add_flowchart_node',
    {
      description: 'Add a node to a flowchart. Outputs are created unconnected; use connect_flowchart_nodes to wire them.',
      inputSchema: strictArguments('add_flowchart_node', addNodeShape),
    },
    async (args) => {
      try {
        const isComment = args.valueType === 'comment';
        if (isComment && args.isStart) return refuse('A comment node cannot be the start node.');
        if (isComment && (args.outputs?.length ?? 0) > 0) return refuse('A comment node has no outputs; omit outputs or use valueType "dictionary".');
        if (!isComment && hasCommentInput(args)) {
          return refuse('commentText, commentHtml, font, fontSize, bold, italic and fontColor apply to comment nodes only (valueType "comment").');
        }
        if (args.commentText !== undefined && args.commentHtml !== undefined) return refuse('Give commentText or commentHtml, not both.');

        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const nodeSid = await idGen.generateSid(reader);
        const outputs: FlowchartOutput[] = [];
        for (const spec of args.outputs ?? []) {
          outputs.push(createOutput(await idGen.generateSid(reader), spec.name, spec.value ?? '', spec.enabled ?? true, spec.isDefault ?? false));
        }

        const node: FlowchartNode = {
          sid: nodeSid,
          pnSIDs: [],
          poSIDs: [],
          nodeSIDs: [],
          outputs,
          x: args.x,
          y: args.y,
          w: args.width,
          h: args.height,
          t: args.nodeType ?? (isComment ? '' : args.caption),
          s: args.isStart,
          e: args.enabled,
          pi: 0,
          c: args.caption,
          ty: args.valueType,
          pr: false,
          prfsid: null,
          prfnsid: null,
        };

        const warnings: string[] = [];
        if (isComment) warnings.push(...defaultedWarning(applyCommentFields(node, args, args.caption)));

        data.nodes.push(node);
        if (args.isStart) clearOtherStartNodes(data, nodeSid);
        warnings.push(...startNodeWarnings(data));

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${nodeSid}`,
          category: 'flowchart-node',
          action: 'created',
          generatedSid: nodeSid,
          ...(warnings.length > 0 ? { warnings } : {}),
        }, { outputSids: outputs.map(o => o.sid) });
      } catch (error) {
        console.error('[add_flowchart_node] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── update_flowchart_node ──────────────────────────────

  server.registerTool(
    'update_flowchart_node',
    {
      description: 'Update properties of an existing flowchart node. Connections, preset links and unknown keys are preserved.',
      inputSchema: strictArguments('update_flowchart_node', updateNodeShape),
    },
    async (args) => {
      try {
        const hasUpdates = args.caption !== undefined || args.nodeType !== undefined ||
          args.tags !== undefined || args.isStart !== undefined || args.enabled !== undefined ||
          args.parentIndex !== undefined || args.x !== undefined || args.y !== undefined ||
          args.width !== undefined || args.height !== undefined ||
          args.valueType !== undefined || hasCommentInput(args);
        if (!hasUpdates) {
          return refuse('No updates provided. Specify at least one of: caption, nodeType, tags, isStart, enabled, parentIndex, x, y, width, height, valueType, commentText, commentHtml, font, fontSize, bold, italic, fontColor.');
        }
        if (args.commentText !== undefined && args.commentHtml !== undefined) return refuse('Give commentText or commentHtml, not both.');

        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const node = findNode(data, args.nodeSid);
        if (!node) return refuse(nodeNotFoundMessage(data, args.flowchartName, args.nodeSid));

        const finalType = args.valueType ?? node.ty;
        if (finalType === 'comment' && (args.isStart ?? node.s) === true) {
          return refuse(`Node ${node.sid} would be a comment and the start node; a comment node cannot be the start node. Make another node the start node first.`);
        }
        if (hasCommentInput(args) && finalType !== 'comment') {
          return refuse(`Node ${node.sid} is a "${finalType}" node; commentText, commentHtml, font, fontSize, bold, italic and fontColor apply to comment nodes only.`);
        }

        const warnings: string[] = [];
        if (args.caption !== undefined) node.c = args.caption;
        if (args.valueType !== undefined && args.valueType !== node.ty) {
          const changed = changeValueType(node, args.valueType, args);
          if (!changed.ok) return refuse(changed.error);
          warnings.push(...changed.warnings);
        } else if (finalType === 'comment' && hasCommentInput(args)) {
          warnings.push(...defaultedWarning(applyCommentFields(node, args, node.c)));
        }
        if (args.nodeType !== undefined) node.t = args.nodeType;
        if (args.tags !== undefined) {
          node.tags = args.tags;
          warnings.push('A "tags" key was written. No flowchart in the r495 sample carries that key, so Construct 3 may ignore or reject it.');
        }
        if (args.enabled !== undefined) node.e = args.enabled;
        if (args.parentIndex !== undefined) node.pi = args.parentIndex;
        if (args.x !== undefined) node.x = args.x;
        if (args.y !== undefined) node.y = args.y;
        if (args.width !== undefined) node.w = args.width;
        if (args.height !== undefined) node.h = args.height;
        if (args.isStart !== undefined) {
          node.s = args.isStart;
          if (args.isStart) clearOtherStartNodes(data, node.sid);
        }

        warnings.push(...startNodeWarnings(data));
        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${node.sid}`,
          category: 'flowchart-node',
          action: 'updated',
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        console.error('[update_flowchart_node] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── delete_flowchart_node ──────────────────────────────

  server.registerTool(
    'delete_flowchart_node',
    {
      description: 'Delete a flowchart node and every reference to it: other nodes\' nodeSIDs, pnSIDs and poSIDs entries, and outputs that pointed at it',
      inputSchema: strictArguments('delete_flowchart_node', deleteNodeShape),
    },
    async (args) => {
      try {
        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const index = data.nodes.findIndex(n => n.sid === args.nodeSid);
        if (index === -1) return refuse(nodeNotFoundMessage(data, args.flowchartName, args.nodeSid));

        const [removed] = data.nodes.splice(index, 1);
        removeNodeReferences(data, removed);

        const warnings: string[] = [];
        if (removed.s === true) warnings.push(`Node ${removed.sid} was the start node.`);
        warnings.push(...startNodeWarnings(data));

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${removed.sid}`,
          category: 'flowchart-node',
          action: 'deleted',
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        console.error('[delete_flowchart_node] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── add_flowchart_output ───────────────────────────────

  server.registerTool(
    'add_flowchart_output',
    {
      description: 'Add an output pin to a flowchart node. The pin is created unconnected.',
      inputSchema: strictArguments('add_flowchart_output', addOutputShape),
    },
    async (args) => {
      try {
        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const node = findNode(data, args.nodeSid);
        if (!node) return refuse(nodeNotFoundMessage(data, args.flowchartName, args.nodeSid));
        if (node.ty === 'comment') return refuse(`Node ${node.sid} is a comment node, and a comment node has no outputs.`);
        if (!Array.isArray(node.outputs)) node.outputs = [];

        if (args.index !== undefined && args.index > node.outputs.length) {
          return refuse(`Index ${args.index} is out of range: node ${node.sid} has ${node.outputs.length} output(s), so the highest valid index is ${node.outputs.length}.`);
        }

        const outputSid = await idGen.generateSid(reader);
        const output = createOutput(outputSid, args.name, args.value, args.enabled, args.isDefault);
        if (args.index === undefined) node.outputs.push(output);
        else node.outputs.splice(args.index, 0, output);

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${node.sid}/${outputSid}`,
          category: 'flowchart-output',
          action: 'created',
          generatedSid: outputSid,
        });
      } catch (error) {
        console.error('[add_flowchart_output] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── update_flowchart_output ────────────────────────────

  server.registerTool(
    'update_flowchart_output',
    {
      description: 'Update an output pin. Its connection (cnSID) is preserved; use connect/disconnect_flowchart_nodes to change that.',
      inputSchema: strictArguments('update_flowchart_output', updateOutputShape),
    },
    async (args) => {
      try {
        const hasUpdates = args.name !== undefined || args.value !== undefined ||
          args.enabled !== undefined || args.isDefault !== undefined;
        if (!hasUpdates) return refuse('No updates provided. Specify at least one of: name, value, enabled, isDefault.');

        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const found = findOutput(data, args.outputSid);
        if (!found) return refuse(outputNotFoundMessage(data, args.flowchartName, args.outputSid));

        if (args.name !== undefined) found.output.name = args.name;
        if (args.value !== undefined) found.output.value = args.value;
        if (args.enabled !== undefined) found.output.enable = args.enabled;
        if (args.isDefault !== undefined) found.output.default = args.isDefault;

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${found.node.sid}/${args.outputSid}`,
          category: 'flowchart-output',
          action: 'updated',
        });
      } catch (error) {
        console.error('[update_flowchart_output] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── delete_flowchart_output ────────────────────────────

  server.registerTool(
    'delete_flowchart_output',
    {
      description: 'Delete an output pin, first undoing any connection it holds',
      inputSchema: strictArguments('delete_flowchart_output', deleteOutputShape),
    },
    async (args) => {
      try {
        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const found = findOutput(data, args.outputSid);
        if (!found) return refuse(outputNotFoundMessage(data, args.flowchartName, args.outputSid));

        const formerTarget = disconnectOutput(data, found.node, found.output);
        found.node.outputs.splice(found.index, 1);

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${found.node.sid}/${args.outputSid}`,
          category: 'flowchart-output',
          action: 'deleted',
          ...(formerTarget !== null
            ? { warnings: [`The output was connected to node ${formerTarget}; that connection was removed too.`] }
            : {}),
        });
      } catch (error) {
        console.error('[delete_flowchart_output] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── reorder_flowchart_outputs ──────────────────────────

  server.registerTool(
    'reorder_flowchart_outputs',
    {
      description: 'Reorder a node\'s output pins. outputSids must be a permutation of the node\'s current output SIDs. The new order is the order of the outputs array in the flowchart file. Whether Construct 3 runs the outputs in that order was not observed, so check the flowchart\'s behavior after a reorder.',
      inputSchema: strictArguments('reorder_flowchart_outputs', reorderShape),
    },
    async (args) => {
      try {
        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const node = findNode(data, args.nodeSid);
        if (!node) return refuse(nodeNotFoundMessage(data, args.flowchartName, args.nodeSid));

        const current = (node.outputs ?? []).map(o => o.sid);
        const repeated = current.find((sid, index) => current.indexOf(sid) !== index);
        if (repeated !== undefined) {
          return refuse(`Node ${node.sid} holds output SID ${repeated} more than once, so its outputs cannot be reordered without losing one. Fix the flowchart file first.`);
        }
        const sorted = (sids: number[]) => [...sids].sort((x, y) => x - y).join(',');
        if (args.outputSids.length !== current.length || sorted(args.outputSids) !== sorted(current)) {
          return refuse(
            `outputSids must be a permutation of node ${node.sid}'s outputs. ` +
            `Expected exactly these ${current.length} SID(s): ${current.join(', ')}; got ${args.outputSids.join(', ')}.`
          );
        }

        const bySid = new Map(node.outputs.map(o => [o.sid, o]));
        node.outputs = args.outputSids.map(sid => bySid.get(sid) as FlowchartOutput);

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${node.sid}`,
          category: 'flowchart-output',
          action: 'reordered',
        });
      } catch (error) {
        console.error('[reorder_flowchart_outputs] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── connect_flowchart_nodes ────────────────────────────

  server.registerTool(
    'connect_flowchart_nodes',
    {
      description: 'Connect an output pin to a target node: sets the output\'s cnSID and updates the target\'s pnSIDs/poSIDs and the source\'s nodeSIDs',
      inputSchema: strictArguments('connect_flowchart_nodes', connectShape),
    },
    async (args) => {
      try {
        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const found = findOutput(data, args.outputSid);
        if (!found) return refuse(outputNotFoundMessage(data, args.flowchartName, args.outputSid));
        const { node, output } = found;

        const target = findNode(data, args.targetNodeSid);
        if (!target) return refuse(nodeNotFoundMessage(data, args.flowchartName, args.targetNodeSid));

        if (node.ty === 'comment' || target.ty === 'comment') {
          return refuse(`Cannot connect ${node.ty === 'comment' ? `from comment node ${node.sid}` : `to comment node ${target.sid}`}: a comment node has no connections.`);
        }
        if (node.sid === args.targetNodeSid) {
          return refuse(`Cannot connect node ${node.sid} to itself: output ${args.outputSid} belongs to that same node.`);
        }
        if (output.cnSID !== null && output.cnSID !== undefined) {
          return refuse(`Output ${args.outputSid} is already connected to node ${output.cnSID}. Call disconnect_flowchart_nodes first.`);
        }

        output.cnSID = target.sid;
        if (!Array.isArray(target.pnSIDs)) target.pnSIDs = [];
        if (!Array.isArray(target.poSIDs)) target.poSIDs = [];
        // pnSIDs and poSIDs stay parallel, one entry per connection.
        target.pnSIDs.push(node.sid);
        target.poSIDs.push(output.sid);
        if (!Array.isArray(node.nodeSIDs)) node.nodeSIDs = [];
        if (!node.nodeSIDs.includes(target.sid)) node.nodeSIDs.push(target.sid);

        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${node.sid}/${args.outputSid}`,
          category: 'flowchart-connection',
          action: 'connected',
        });
      } catch (error) {
        console.error('[connect_flowchart_nodes] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );

  // ─── disconnect_flowchart_nodes ─────────────────────────

  server.registerTool(
    'disconnect_flowchart_nodes',
    {
      description: 'Disconnect an output pin, leaving any other connection between the same two nodes intact',
      inputSchema: strictArguments('disconnect_flowchart_nodes', disconnectShape),
    },
    async (args) => {
      try {
        const opened = await openForChange(args.flowchartName);
        if ('result' in opened) return opened.result;
        const { flowchart } = opened;
        const { data } = flowchart;

        const found = findOutput(data, args.outputSid);
        if (!found) return refuse(outputNotFoundMessage(data, args.flowchartName, args.outputSid));
        if (found.output.cnSID === null || found.output.cnSID === undefined) {
          return refuse(`Output ${args.outputSid} is not connected to anything.`);
        }

        const formerTarget = disconnectOutput(data, found.node, found.output);
        return await saveAndReport(flowchart, {
          success: true,
          entity: `${args.flowchartName}/${found.node.sid}/${args.outputSid}`,
          category: 'flowchart-connection',
          action: 'disconnected',
        }, { formerTargetNodeSid: formerTarget });
      } catch (error) {
        console.error('[disconnect_flowchart_nodes] failed:', error);
        return stoppedBeforeWrite(error);
      }
    }
  );
}
