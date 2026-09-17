/**
 * Flowchart tools: list_flowcharts, get_flowchart_details, create_flowchart,
 * delete_flowchart, add_flowchart_node, update_flowchart_node,
 * delete_flowchart_node, add_flowchart_output, update_flowchart_output,
 * delete_flowchart_output, reorder_flowchart_outputs,
 * connect_flowchart_nodes, disconnect_flowchart_nodes.
 *
 * Flowchart JSON files live in projectDir/flowcharts/[subfolder/]<name>.json.
 * The project.c3proj flowcharts container tracks their names, exactly like
 * timelines. JSON shape confirmed against a real Construct 3 r495 project.
 *
 * Field meanings confirmed from that sample:
 *   t   node type/title (equal to `c` on 1170 of 1539 sampled nodes)
 *   c   caption (NOT a color: node and output colors live in the sibling
 *       <name>.uistate.json, which these tools never write)
 *   s   start node; every one of the 31 sampled files has exactly one
 *   e   enabled
 *   ty  value type; observed values "dictionary" and "comment"
 *   pi  observed 0, 1 and 2; meaning not determined
 *   pnSIDs/poSIDs  strictly parallel, one entry per incoming connection
 *                  (1295 of 1295 sampled pairs valid): poSIDs[i] is an
 *                  output of the node pnSIDs[i]
 *   nodeSIDs       distinct child node SIDs, in an order independent of the
 *                  outputs array order
 *
 * `pr`, `prfsid` and `prfnsid` identify preset-derived nodes. They are never
 * taken from tool input: new nodes get pr:false / prfsid:null / prfnsid:null,
 * and existing nodes keep whatever they carry. Every other unknown key is
 * preserved on read-modify-write.
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir, copyFile, unlink, rename, stat } from 'fs/promises';
import { dirname } from 'path';
import type { MutationToolDeps } from './shared.js';
import type {
  Construct3Project,
  Flowchart,
  FlowchartNode,
  FlowchartOutput,
  FlowchartsContainer,
  Subfolder,
  WriteResult,
} from '../construct3/types.js';
import { validateName, validateSubfolder, toolResult, toolError, notFoundError } from './shared.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

type Reader = MutationToolDeps['reader'];

/** usedAddons id of the plugin that owns flowcharts. */
const FLOWCHART_PLUGIN_ID = 'Flowchart';

/** Canvas size C3 gives a new flowchart. */
const DEFAULT_CANVAS_SIZE = 20000;

/** Most common node box in the sample (297x133 on 395 single-output nodes). */
const DEFAULT_NODE_WIDTH = 300;
const DEFAULT_NODE_HEIGHT = 133;

// ─── Container helpers ─────────────────────────────────────

function getFlowchartsContainer(project: Construct3Project): FlowchartsContainer {
  return project.flowcharts ?? { items: [], subfolders: [] };
}

/** Collect all flowchart names from a container (root + all subfolders). */
function collectFlowchartNames(container: FlowchartsContainer): string[] {
  const names: string[] = [...container.items];
  const walk = (subfolders: Subfolder[]) => {
    for (const sf of subfolders) {
      names.push(...sf.items);
      walk(sf.subfolders);
    }
  };
  walk(container.subfolders);
  return names;
}

/**
 * Slash-separated subfolder path holding `name`: '' for the container root,
 * or null when the name is not registered at all.
 */
function locateFlowchart(container: FlowchartsContainer, name: string): string | null {
  if (container.items.includes(name)) return '';
  const walk = (subfolders: Subfolder[], prefix: string): string | null => {
    for (const sf of subfolders) {
      const path = prefix ? `${prefix}/${sf.name}` : sf.name;
      if (sf.items.includes(name)) return path;
      const deeper = walk(sf.subfolders, path);
      if (deeper !== null) return deeper;
    }
    return null;
  };
  return walk(container.subfolders, '');
}

function hasFlowchartPlugin(project: Construct3Project): boolean {
  const addons = project.usedAddons;
  if (!Array.isArray(addons)) return false;
  return addons.some(a => a && a.type === 'plugin' && a.id === FLOWCHART_PLUGIN_ID);
}

// ─── File helpers ──────────────────────────────────────────

function flowchartFilePath(projectDir: string, name: string, subfolder?: string): string {
  if (subfolder) {
    return resolveProjectPath(projectDir, 'flowcharts', ...subfolder.split('/'), `${name}.json`);
  }
  return resolveProjectPath(projectDir, 'flowcharts', `${name}.json`);
}

/** Sibling editor-state file C3 writes next to a flowchart. */
function uistateFilePath(flowchartPath: string): string {
  return flowchartPath.replace(/\.json$/, '.uistate.json');
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/** Write JSON with C3's tab indentation, via a temp file and a rename. */
async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, '\t');
  const tmpPath = filePath + '.tmp';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, json, 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EEXIST') {
      await unlink(filePath);
      await rename(tmpPath, filePath);
    } else {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/** Copy filePath to filePath.bak when it exists; returns the backup path. */
async function backupFile(filePath: string): Promise<string> {
  const bak = filePath + '.bak';
  try {
    await stat(filePath);
    await copyFile(filePath, bak);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') return bak;
    throw e;
  }
  return bak;
}

/** Add a flowchart name to the project.c3proj flowcharts container. */
async function addFlowchartToProject(
  projectPath: string,
  name: string,
  subfolder?: string,
): Promise<void> {
  const project = await readJsonFile<Record<string, unknown>>(projectPath);

  if (!project.flowcharts) project.flowcharts = { items: [], subfolders: [] };
  const container = project.flowcharts as FlowchartsContainer;
  if (!Array.isArray(container.items)) container.items = [];
  if (!Array.isArray(container.subfolders)) container.subfolders = [];

  if (subfolder) {
    let cur: FlowchartsContainer | Subfolder = container;
    for (const part of subfolder.split('/')) {
      let found: Subfolder | undefined = cur.subfolders.find(sf => sf.name === part);
      if (!found) {
        // Key order matches the sample: items, subfolders, name.
        found = { items: [], subfolders: [], name: part };
        cur.subfolders.push(found);
      }
      cur = found;
    }
    if (!cur.items.includes(name)) cur.items.push(name);
  } else {
    if (!container.items.includes(name)) container.items.push(name);
  }

  await writeJsonFile(projectPath, project);
}

/** Remove a flowchart name from the project.c3proj flowcharts container. */
async function removeFlowchartFromProject(projectPath: string, name: string): Promise<void> {
  const project = await readJsonFile<Record<string, unknown>>(projectPath);
  const container = project.flowcharts as FlowchartsContainer | undefined;
  if (!container) return;

  const idx = container.items.indexOf(name);
  if (idx !== -1) {
    container.items.splice(idx, 1);
  } else {
    const removeFrom = (subfolders: Subfolder[]): boolean => {
      for (const sf of subfolders) {
        const i = sf.items.indexOf(name);
        if (i !== -1) { sf.items.splice(i, 1); return true; }
        if (removeFrom(sf.subfolders)) return true;
      }
      return false;
    };
    removeFrom(container.subfolders);
  }

  await writeJsonFile(projectPath, project);
}

// ─── Flowchart open/save ───────────────────────────────────

type OpenResult =
  | { ok: true; data: Flowchart; filePath: string }
  | { ok: false; error: ReturnType<typeof toolError> };

/** Locate a registered flowchart and parse its file. */
async function openFlowchart(reader: Reader, name: string): Promise<OpenResult> {
  const container = getFlowchartsContainer(reader.getProject());
  const subfolder = locateFlowchart(container, name);
  if (subfolder === null) {
    return { ok: false, error: notFoundError('Flowchart', name, [], 'list_flowcharts') };
  }

  let filePath: string;
  try {
    filePath = flowchartFilePath(reader.getProjectDir(), name, subfolder);
  } catch (e: unknown) {
    return { ok: false, error: toolError(`Flowchart "${name}": ${e instanceof Error ? e.message : String(e)}`) };
  }

  try {
    const data = await readJsonFile<Flowchart>(filePath);
    if (!Array.isArray(data.nodes)) data.nodes = [];
    return { ok: true, data, filePath };
  } catch (e: unknown) {
    const relative = `flowcharts/${subfolder ? subfolder + '/' : ''}${name}.json`;
    return {
      ok: false,
      error: toolError(
        `Flowchart "${name}" is registered in the project but ${relative} could not be read: ` +
        `${e instanceof Error ? e.message : String(e)}`
      ),
    };
  }
}

/** Back up and rewrite a flowchart file; returns the backup path. */
async function saveFlowchart(filePath: string, data: Flowchart): Promise<string> {
  const backupPath = await backupFile(filePath);
  await writeJsonFile(filePath, data);
  return backupPath;
}

// ─── Node/output lookup ────────────────────────────────────

function findNode(data: Flowchart, sid: number): FlowchartNode | undefined {
  return data.nodes.find(n => n.sid === sid);
}

function findOutput(
  data: Flowchart,
  outputSid: number,
): { node: FlowchartNode; output: FlowchartOutput; index: number } | undefined {
  for (const node of data.nodes) {
    if (!Array.isArray(node.outputs)) continue;
    const index = node.outputs.findIndex(o => o.sid === outputSid);
    if (index !== -1) return { node, output: node.outputs[index], index };
  }
  return undefined;
}

function sidHint(sids: number[]): string {
  if (sids.length === 0) return '';
  const shown = sids.slice(0, 5).join(', ');
  return sids.length > 5 ? `${shown}, ... (${sids.length} total)` : shown;
}

function nodeNotFound(data: Flowchart, flowchartName: string, nodeSid: number) {
  const hint = sidHint(data.nodes.map(n => n.sid));
  return toolError(
    `Node ${nodeSid} not found in flowchart "${flowchartName}".` +
    (hint ? `\nNode SIDs in this flowchart: ${hint}` : '\nThis flowchart has no nodes.')
  );
}

function outputNotFound(data: Flowchart, flowchartName: string, outputSid: number) {
  const sids: number[] = [];
  for (const n of data.nodes) for (const o of n.outputs ?? []) sids.push(o.sid);
  const hint = sidHint(sids);
  return toolError(
    `Output ${outputSid} not found in flowchart "${flowchartName}".` +
    (hint ? `\nOutput SIDs in this flowchart: ${hint}` : '\nThis flowchart has no outputs.')
  );
}

// ─── Start-node invariant ──────────────────────────────────

/**
 * C3 keeps exactly one start node per flowchart (verified: 1 of N in all 31
 * sampled files). Clear `s` on every node except `keepSid`.
 */
function clearOtherStartNodes(data: Flowchart, keepSid: number): number {
  let cleared = 0;
  for (const node of data.nodes) {
    if (node.sid !== keepSid && node.s === true) {
      node.s = false;
      cleared++;
    }
  }
  return cleared;
}

/** Warn when the file no longer satisfies the one-start-node invariant. */
function startNodeWarnings(data: Flowchart): string[] {
  const starts = data.nodes.filter(n => n.s === true);
  if (data.nodes.length > 0 && starts.length === 0) {
    return ['This flowchart has no start node. Set isStart on one node so Construct 3 knows where execution begins.'];
  }
  if (starts.length > 1) {
    return [`This flowchart has ${starts.length} start nodes (${starts.map(n => n.sid).join(', ')}); Construct 3 expects exactly one.`];
  }
  return [];
}

// ─── Connection helpers ────────────────────────────────────

/**
 * Remove the incoming-connection entry for `outputSid` from `target`, keeping
 * pnSIDs and poSIDs parallel.
 */
function removeIncoming(target: FlowchartNode, outputSid: number): void {
  const len = Math.max(target.pnSIDs?.length ?? 0, target.poSIDs?.length ?? 0);
  for (let i = len - 1; i >= 0; i--) {
    if (target.poSIDs[i] === outputSid) {
      target.pnSIDs.splice(i, 1);
      target.poSIDs.splice(i, 1);
    }
  }
}

/** Drop `childSid` from `parent.nodeSIDs` unless another output still points at it. */
function pruneChildLink(parent: FlowchartNode, childSid: number): void {
  if (parent.outputs.some(o => o.cnSID === childSid)) return;
  for (let i = parent.nodeSIDs.length - 1; i >= 0; i--) {
    if (parent.nodeSIDs[i] === childSid) parent.nodeSIDs.splice(i, 1);
  }
}

/**
 * Undo whatever connection `output` holds, leaving other connections between
 * the same two nodes intact. Returns the former target SID, or null when the
 * output was already unconnected.
 */
function disconnectOutput(data: Flowchart, node: FlowchartNode, output: FlowchartOutput): number | null {
  const targetSid = output.cnSID;
  if (targetSid === null || targetSid === undefined) return null;
  output.cnSID = null;
  const target = findNode(data, targetSid);
  if (target) removeIncoming(target, output.sid);
  pruneChildLink(node, targetSid);
  return targetSid;
}

/**
 * Remove every reference to a node that has already been spliced out of
 * data.nodes: other nodes' nodeSIDs, their parallel pnSIDs/poSIDs entries,
 * and outputs whose cnSID pointed at it.
 */
function removeNodeReferences(data: Flowchart, removed: FlowchartNode): void {
  const removedOutputSids = new Set((removed.outputs ?? []).map(o => o.sid));

  for (const node of data.nodes) {
    if (Array.isArray(node.nodeSIDs)) {
      for (let i = node.nodeSIDs.length - 1; i >= 0; i--) {
        if (node.nodeSIDs[i] === removed.sid) node.nodeSIDs.splice(i, 1);
      }
    }

    if (Array.isArray(node.pnSIDs) && Array.isArray(node.poSIDs)) {
      const len = Math.max(node.pnSIDs.length, node.poSIDs.length);
      for (let i = len - 1; i >= 0; i--) {
        if (node.pnSIDs[i] === removed.sid || removedOutputSids.has(node.poSIDs[i])) {
          node.pnSIDs.splice(i, 1);
          node.poSIDs.splice(i, 1);
        }
      }
    }

    for (const output of node.outputs ?? []) {
      if (output.cnSID === removed.sid) output.cnSID = null;
    }
  }
}

// ─── Factories ─────────────────────────────────────────────

function createFlowchartData(sid: number, name: string): Flowchart {
  // Key order matches a real r495 flowchart file.
  return {
    sid,
    nodes: [],
    'preset-nodes': { items: [], subfolders: [] },
    name,
    w: DEFAULT_CANVAS_SIZE,
    h: DEFAULT_CANVAS_SIZE,
  };
}

function createOutput(sid: number, name: string, value: string, enable: boolean, isDefault: boolean): FlowchartOutput {
  return { sid, cnSID: null, name, value, enable, default: isDefault };
}

// ─── Zod fragments ─────────────────────────────────────────

const outputInput = z.object({
  name: z.string().min(1).max(200).describe('Output pin name'),
  value: z.string().max(1000).optional().describe('Output value (default: empty string)'),
  enabled: z.boolean().optional().describe('Enable the output (default: true)'),
  isDefault: z.boolean().optional().describe('Mark the output as the default (default: false)'),
});

// ─── Registration ──────────────────────────────────────────

export function registerFlowchartTools({ server, reader, idGen }: MutationToolDeps) {
  // ─── list_flowcharts ────────────────────────────────────

  server.tool(
    'list_flowcharts',
    'List all flowcharts in the project (root and every subfolder)',
    {},
    async () => {
      try {
        const names = collectFlowchartNames(getFlowchartsContainer(reader.getProject()));
        return toolResult({ flowcharts: names, count: names.length });
      } catch (error) {
        console.error('[list_flowcharts] failed:', error);
        return toolError(`Error listing flowcharts: ${error instanceof Error ? error.message : String(error)}`);
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
        const opened = await openFlowchart(reader, args.name);
        if (!opened.ok) return opened.error;
        return toolResult(opened.data);
      } catch (error) {
        console.error('[get_flowchart_details] failed:', error);
        return toolError(`Error getting flowchart details: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── create_flowchart ───────────────────────────────────

  server.tool(
    'create_flowchart',
    'Create a new, empty flowchart file and register it in project.c3proj. Warns when the Flowchart plugin is not in the project: the editor loads the flowchart anyway, but a Flowchart object is needed to use it at runtime.',
    {
      name: z.string().max(200).describe('Flowchart name'),
      subfolder: z.string().max(500).optional().describe('Subfolder within flowcharts/ (e.g. "AI Graph/State Machines")'),
    },
    async (args) => {
      try {
        validateName(args.name);
        if (args.subfolder !== undefined) validateSubfolder(args.subfolder);

        const project = reader.getProject();
        const warnings: string[] = [];
        if (!hasFlowchartPlugin(project)) {
          // A load check on r495.2 showed the editor opens a project whose flowchart
          // has no Flowchart plugin (it even prunes the unused plugin), so this is
          // advisory: the plugin is only needed to drive the flowchart at runtime.
          warnings.push(
            `The Flowchart plugin is not listed in this project's usedAddons. The editor loads the flowchart, ` +
            `but add a Flowchart object in the Construct 3 editor before using it at runtime; this tool does not register plugins.`
          );
        }

        const existing = collectFlowchartNames(getFlowchartsContainer(project));
        if (existing.includes(args.name)) {
          return toolError(`Flowchart "${args.name}" already exists.`);
        }

        const sid = await idGen.generateSid(reader);
        const data = createFlowchartData(sid, args.name);

        const filePath = flowchartFilePath(reader.getProjectDir(), args.name, args.subfolder);
        const backupPath = await backupFile(filePath);
        await writeJsonFile(filePath, data);

        const projectPath = reader.getProjectPath();
        await backupFile(projectPath);
        await addFlowchartToProject(projectPath, args.name, args.subfolder);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'flowchart',
          action: 'created',
          generatedSid: sid,
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_flowchart] failed:', error);
        return toolError(`Error creating flowchart: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_flowchart ───────────────────────────────────

  server.tool(
    'delete_flowchart',
    'Delete a flowchart: remove its file (keeping a .bak) and its project.c3proj registration',
    {
      name: z.string().max(200).describe('Flowchart name to delete'),
    },
    async (args) => {
      try {
        const container = getFlowchartsContainer(reader.getProject());
        const subfolder = locateFlowchart(container, args.name);
        if (subfolder === null) {
          return notFoundError('Flowchart', args.name, [], 'list_flowcharts');
        }

        const filePath = flowchartFilePath(reader.getProjectDir(), args.name, subfolder);
        const backupPath = await backupFile(filePath);

        // Delete the file first: a failure here leaves the registration intact
        // and the call retryable, rather than stranding a dangling name.
        try {
          await unlink(filePath);
        } catch (e: unknown) {
          if (!(e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT')) {
            throw e;
          }
        }

        // The sibling editor-state file is derived from this flowchart.
        const warnings: string[] = [];
        const uistatePath = uistateFilePath(filePath);
        try {
          await stat(uistatePath);
          await backupFile(uistatePath);
          await unlink(uistatePath);
          warnings.push(`Also deleted the sibling editor-state file ${args.name}.uistate.json (a .bak was written).`);
        } catch { /* no uistate file, nothing to do */ }

        const projectPath = reader.getProjectPath();
        await backupFile(projectPath);
        await removeFlowchartFromProject(projectPath, args.name);
        await reader.reloadProject();

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'flowchart',
          action: 'deleted',
          backupFile: backupPath,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_flowchart] failed:', error);
        return toolError(`Error deleting flowchart: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_flowchart_node ─────────────────────────────────

  server.tool(
    'add_flowchart_node',
    'Add a node to a flowchart. Outputs are created unconnected; use connect_flowchart_nodes to wire them.',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      caption: z.string().max(500).describe('Node caption (the "c" field)'),
      nodeType: z.string().max(200).optional().describe('Node type/title (the "t" field; defaults to the caption)'),
      x: z.number().describe('Canvas X position'),
      y: z.number().describe('Canvas Y position'),
      width: z.number().positive().optional().default(DEFAULT_NODE_WIDTH).describe(`Box width (default: ${DEFAULT_NODE_WIDTH})`),
      height: z.number().positive().optional().default(DEFAULT_NODE_HEIGHT).describe(`Box height (default: ${DEFAULT_NODE_HEIGHT})`),
      isStart: z.boolean().optional().default(false).describe('Make this the start node; clears the flag on every other node (default: false)'),
      enabled: z.boolean().optional().default(true).describe('Enable the node (default: true)'),
      valueType: z.string().max(100).optional().default('dictionary').describe('Value type ("ty"); observed values: dictionary, comment (default: dictionary)'),
      outputs: z.array(outputInput).max(100).optional().describe('Output pins to create on the node'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const nodeSid = await idGen.generateSid(reader);
        const outputs: FlowchartOutput[] = [];
        for (const spec of args.outputs ?? []) {
          const outSid = await idGen.generateSid(reader);
          outputs.push(createOutput(
            outSid,
            spec.name,
            spec.value ?? '',
            spec.enabled ?? true,
            spec.isDefault ?? false,
          ));
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
          t: args.nodeType ?? args.caption,
          s: args.isStart,
          e: args.enabled,
          pi: 0,
          c: args.caption,
          ty: args.valueType,
          pr: false,
          prfsid: null,
          prfnsid: null,
        };

        data.nodes.push(node);
        if (args.isStart) clearOtherStartNodes(data, nodeSid);

        const warnings = startNodeWarnings(data);
        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${nodeSid}`,
          category: 'flowchart-node',
          action: 'created',
          generatedSid: nodeSid,
          backupFile: backupPath,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        return toolResult({ ...result, outputSids: outputs.map(o => o.sid) });
      } catch (error) {
        console.error('[add_flowchart_node] failed:', error);
        return toolError(`Error adding flowchart node: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_flowchart_node ──────────────────────────────

  server.tool(
    'update_flowchart_node',
    'Update properties of an existing flowchart node. Connections, preset links and unknown keys are preserved.',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      nodeSid: z.number().int().describe('SID of the node to update'),
      caption: z.string().max(500).optional().describe('New caption (the "c" field)'),
      nodeType: z.string().max(200).optional().describe('New node type/title (the "t" field)'),
      tags: z.string().max(500).optional().describe('Writes a "tags" key. NOT OBSERVED in any r495 sample flowchart; use at your own risk'),
      isStart: z.boolean().optional().describe('Make this the start node (clears the flag on every other node), or clear it'),
      enabled: z.boolean().optional().describe('Enable/disable the node'),
      parentIndex: z.number().int().min(0).optional().describe('The "pi" field; observed values 0, 1 and 2, meaning not determined'),
      x: z.number().optional().describe('New canvas X position'),
      y: z.number().optional().describe('New canvas Y position'),
      width: z.number().positive().optional().describe('New box width'),
      height: z.number().positive().optional().describe('New box height'),
    },
    async (args) => {
      try {
        const hasUpdates = args.caption !== undefined || args.nodeType !== undefined ||
          args.tags !== undefined || args.isStart !== undefined || args.enabled !== undefined ||
          args.parentIndex !== undefined || args.x !== undefined || args.y !== undefined ||
          args.width !== undefined || args.height !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: caption, nodeType, tags, isStart, enabled, parentIndex, x, y, width, height.');
        }

        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const node = findNode(data, args.nodeSid);
        if (!node) return nodeNotFound(data, args.flowchartName, args.nodeSid);

        const warnings: string[] = [];
        if (args.caption !== undefined) node.c = args.caption;
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
        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${node.sid}`,
          category: 'flowchart-node',
          action: 'updated',
          backupFile: backupPath,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_flowchart_node] failed:', error);
        return toolError(`Error updating flowchart node: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_flowchart_node ──────────────────────────────

  server.tool(
    'delete_flowchart_node',
    'Delete a flowchart node and every reference to it: other nodes\' nodeSIDs, pnSIDs and poSIDs entries, and outputs that pointed at it',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      nodeSid: z.number().int().describe('SID of the node to delete'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const index = data.nodes.findIndex(n => n.sid === args.nodeSid);
        if (index === -1) return nodeNotFound(data, args.flowchartName, args.nodeSid);

        const [removed] = data.nodes.splice(index, 1);
        removeNodeReferences(data, removed);

        const warnings: string[] = [];
        if (removed.s === true) {
          warnings.push(`Node ${removed.sid} was the start node.`);
        }
        warnings.push(...startNodeWarnings(data));

        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${removed.sid}`,
          category: 'flowchart-node',
          action: 'deleted',
          backupFile: backupPath,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_flowchart_node] failed:', error);
        return toolError(`Error deleting flowchart node: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_flowchart_output ───────────────────────────────

  server.tool(
    'add_flowchart_output',
    'Add an output pin to a flowchart node. The pin is created unconnected.',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      nodeSid: z.number().int().describe('SID of the node to add the output to'),
      name: z.string().min(1).max(200).describe('Output pin name'),
      value: z.string().max(1000).optional().default('').describe('Output value (default: empty string)'),
      enabled: z.boolean().optional().default(true).describe('Enable the output (default: true)'),
      isDefault: z.boolean().optional().default(false).describe('Mark the output as the default (default: false)'),
      index: z.number().int().min(0).optional().describe('Insertion index in the outputs array (default: append)'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const node = findNode(data, args.nodeSid);
        if (!node) return nodeNotFound(data, args.flowchartName, args.nodeSid);
        if (!Array.isArray(node.outputs)) node.outputs = [];

        if (args.index !== undefined && args.index > node.outputs.length) {
          return toolError(`Index ${args.index} is out of range: node ${node.sid} has ${node.outputs.length} output(s), so the highest valid index is ${node.outputs.length}.`);
        }

        const outputSid = await idGen.generateSid(reader);
        const output = createOutput(outputSid, args.name, args.value, args.enabled, args.isDefault);
        if (args.index === undefined) {
          node.outputs.push(output);
        } else {
          node.outputs.splice(args.index, 0, output);
        }

        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${node.sid}/${outputSid}`,
          category: 'flowchart-output',
          action: 'created',
          generatedSid: outputSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_flowchart_output] failed:', error);
        return toolError(`Error adding flowchart output: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_flowchart_output ────────────────────────────

  server.tool(
    'update_flowchart_output',
    'Update an output pin. Its connection (cnSID) is preserved; use connect/disconnect_flowchart_nodes to change that.',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      outputSid: z.number().int().describe('SID of the output to update'),
      name: z.string().min(1).max(200).optional().describe('New output pin name'),
      value: z.string().max(1000).optional().describe('New output value'),
      enabled: z.boolean().optional().describe('Enable/disable the output'),
      isDefault: z.boolean().optional().describe('Mark/unmark the output as the default'),
    },
    async (args) => {
      try {
        const hasUpdates = args.name !== undefined || args.value !== undefined ||
          args.enabled !== undefined || args.isDefault !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: name, value, enabled, isDefault.');
        }

        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const found = findOutput(data, args.outputSid);
        if (!found) return outputNotFound(data, args.flowchartName, args.outputSid);

        if (args.name !== undefined) found.output.name = args.name;
        if (args.value !== undefined) found.output.value = args.value;
        if (args.enabled !== undefined) found.output.enable = args.enabled;
        if (args.isDefault !== undefined) found.output.default = args.isDefault;

        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${found.node.sid}/${args.outputSid}`,
          category: 'flowchart-output',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_flowchart_output] failed:', error);
        return toolError(`Error updating flowchart output: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_flowchart_output ────────────────────────────

  server.tool(
    'delete_flowchart_output',
    'Delete an output pin, first undoing any connection it holds',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      outputSid: z.number().int().describe('SID of the output to delete'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const found = findOutput(data, args.outputSid);
        if (!found) return outputNotFound(data, args.flowchartName, args.outputSid);

        const formerTarget = disconnectOutput(data, found.node, found.output);
        found.node.outputs.splice(found.index, 1);

        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${found.node.sid}/${args.outputSid}`,
          category: 'flowchart-output',
          action: 'deleted',
          backupFile: backupPath,
          ...(formerTarget !== null
            ? { warnings: [`The output was connected to node ${formerTarget}; that connection was removed too.`] }
            : {}),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_flowchart_output] failed:', error);
        return toolError(`Error deleting flowchart output: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── reorder_flowchart_outputs ──────────────────────────

  server.tool(
    'reorder_flowchart_outputs',
    'Reorder a node\'s output pins. outputSids must be a permutation of the node\'s current output SIDs. Output array order is execution order in Construct 3, so this changes behavior.',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      nodeSid: z.number().int().describe('SID of the node whose outputs to reorder'),
      outputSids: z.array(z.number().int()).min(1).max(200).describe('The node\'s output SIDs in their new order'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const node = findNode(data, args.nodeSid);
        if (!node) return nodeNotFound(data, args.flowchartName, args.nodeSid);

        const current = (node.outputs ?? []).map(o => o.sid);
        const sorted = (a: number[]) => [...a].sort((x, y) => x - y).join(',');
        if (args.outputSids.length !== current.length || sorted(args.outputSids) !== sorted(current)) {
          return toolError(
            `outputSids must be a permutation of node ${node.sid}'s outputs. ` +
            `Expected exactly these ${current.length} SID(s): ${current.join(', ')}; got ${args.outputSids.join(', ')}.`
          );
        }

        const bySid = new Map(node.outputs.map(o => [o.sid, o]));
        node.outputs = args.outputSids.map(sid => bySid.get(sid)!);

        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${node.sid}`,
          category: 'flowchart-output',
          action: 'reordered',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[reorder_flowchart_outputs] failed:', error);
        return toolError(`Error reordering flowchart outputs: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── connect_flowchart_nodes ────────────────────────────

  server.tool(
    'connect_flowchart_nodes',
    'Connect an output pin to a target node: sets the output\'s cnSID and updates the target\'s pnSIDs/poSIDs and the source\'s nodeSIDs',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      outputSid: z.number().int().describe('SID of the source output pin'),
      targetNodeSid: z.number().int().describe('SID of the node to connect to'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const found = findOutput(data, args.outputSid);
        if (!found) return outputNotFound(data, args.flowchartName, args.outputSid);
        const { node, output } = found;

        const target = findNode(data, args.targetNodeSid);
        if (!target) return nodeNotFound(data, args.flowchartName, args.targetNodeSid);

        if (node.sid === args.targetNodeSid) {
          return toolError(
            `Cannot connect node ${node.sid} to itself: output ${args.outputSid} belongs to that same node.`
          );
        }

        if (output.cnSID !== null && output.cnSID !== undefined) {
          return toolError(
            `Output ${args.outputSid} is already connected to node ${output.cnSID}. ` +
            `Call disconnect_flowchart_nodes first.`
          );
        }

        output.cnSID = target.sid;
        if (!Array.isArray(target.pnSIDs)) target.pnSIDs = [];
        if (!Array.isArray(target.poSIDs)) target.poSIDs = [];
        // pnSIDs and poSIDs stay parallel, one entry per connection.
        target.pnSIDs.push(node.sid);
        target.poSIDs.push(output.sid);
        if (!Array.isArray(node.nodeSIDs)) node.nodeSIDs = [];
        if (!node.nodeSIDs.includes(target.sid)) node.nodeSIDs.push(target.sid);

        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${node.sid}/${args.outputSid}`,
          category: 'flowchart-connection',
          action: 'connected',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[connect_flowchart_nodes] failed:', error);
        return toolError(`Error connecting flowchart nodes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── disconnect_flowchart_nodes ─────────────────────────

  server.tool(
    'disconnect_flowchart_nodes',
    'Disconnect an output pin, leaving any other connection between the same two nodes intact',
    {
      flowchartName: z.string().max(200).describe('Flowchart name'),
      outputSid: z.number().int().describe('SID of the output pin to disconnect'),
    },
    async (args) => {
      try {
        const opened = await openFlowchart(reader, args.flowchartName);
        if (!opened.ok) return opened.error;
        const { data, filePath } = opened;

        const found = findOutput(data, args.outputSid);
        if (!found) return outputNotFound(data, args.flowchartName, args.outputSid);

        if (found.output.cnSID === null || found.output.cnSID === undefined) {
          return toolError(`Output ${args.outputSid} is not connected to anything.`);
        }

        const formerTarget = disconnectOutput(data, found.node, found.output);
        const backupPath = await saveFlowchart(filePath, data);

        const result: WriteResult = {
          success: true,
          entity: `${args.flowchartName}/${found.node.sid}/${args.outputSid}`,
          category: 'flowchart-connection',
          action: 'disconnected',
          backupFile: backupPath,
        };
        return toolResult({ ...result, formerTargetNodeSid: formerTarget });
      } catch (error) {
        console.error('[disconnect_flowchart_nodes] failed:', error);
        return toolError(`Error disconnecting flowchart nodes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
