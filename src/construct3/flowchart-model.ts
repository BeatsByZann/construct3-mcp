/**
 * The flowchart data model: the shape of a flowchart file as Construct 3
 * saves it, and the changes the flowchart tools make to one in memory.
 * Nothing here reads or writes a file (flowchart-files.ts does).
 *
 * A flowchart is flowcharts/[folders/]<name>.json, registered in the
 * `flowcharts` container of project.c3proj as timelines are. Field
 * meanings, as observed in flowcharts saved by Construct 3 r495 (an
 * editor-saved project with 31 flowcharts and 1,539 nodes):
 *   t   node type/title (often equal to `c`)
 *   c   caption (not a color: node and output colors live in the sibling
 *       <name>.uistate.json, which these tools never write)
 *   s   start node; every file had exactly one
 *   e   enabled
 *   ty  value type; observed values "dictionary" and "comment"
 *   pi  observed 0, 1 and 2; meaning not determined
 *   pnSIDs/poSIDs  strictly parallel, one entry per incoming connection:
 *                  poSIDs[i] is an output of the node pnSIDs[i]
 *   nodeSIDs       distinct child node SIDs, in an order independent of
 *                  the outputs array order
 *
 * Comment nodes (166 of the nodes) have no outputs or connections, `t: ""`,
 * and six more keys after `prfnsid`, in this order:
 *   n   comment body as the editor's HTML (first line plain, later lines in
 *       <div>, blank lines as <div><br></div>, &nbsp; and &amp; entities)
 *   fo  font face   fs  font size   fb  bold   fi  italic
 *   fc  font color as "#rrggbb"
 * `c` on a comment node is a separate caption.
 *
 * `pr`, `prfsid` and `prfnsid` identify preset-derived nodes. They are never
 * taken from tool input: new nodes get pr:false / prfsid:null / prfnsid:null,
 * and existing nodes keep whatever they carry. Every other unknown key is
 * preserved when a flowchart is changed.
 */

import { isNamelessFolder, type ProjectFolderNode } from './timeline-folders.js';

// ─── Types ─────────────────────────────────────────────────

/** One output pin on a flowchart node. */
export interface FlowchartOutput {
  sid: number;
  /** SID of the node this output connects to, or null when unconnected. */
  cnSID: number | null;
  name: string;
  value: string;
  enable: boolean;
  default: boolean;
  [key: string]: unknown;
}

/**
 * One flowchart node. `t` is the node type/title and `c` the caption.
 * `pnSIDs` and `poSIDs` are strictly parallel arrays with one entry per
 * incoming connection: `poSIDs[i]` is an output of the node `pnSIDs[i]`.
 * `nodeSIDs` holds the distinct child node SIDs in creation order, which is
 * independent of the `outputs` array order.
 */
export interface FlowchartNode {
  sid: number;
  /** Parent node SIDs, one entry per incoming connection. */
  pnSIDs: number[];
  /** Parent output SIDs, parallel to pnSIDs. */
  poSIDs: number[];
  /** Distinct child node SIDs. */
  nodeSIDs: number[];
  outputs: FlowchartOutput[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Node type/title. Empty string on comment boxes. */
  t: string;
  /** True on the single start node; Construct 3 keeps exactly one per flowchart. */
  s: boolean;
  /** Enabled. */
  e: boolean;
  /** Observed values 0, 1 and 2; meaning not determined. */
  pi: number;
  /** Caption. */
  c: string;
  /** Value type: "dictionary" or "comment". */
  ty: string;
  /** Preset flag. False on ordinary nodes. */
  pr: boolean;
  /** Source preset flowchart SID, or null. Never written by the tools. */
  prfsid?: number | null;
  /** Source preset node SID, or null. Never written by the tools. */
  prfnsid?: number | null;
  [key: string]: unknown;
}

/** A flowchart file. */
export interface Flowchart {
  sid: number;
  nodes: FlowchartNode[];
  'preset-nodes': { items: unknown[]; subfolders: unknown[] };
  name: string;
  w: number;
  h: number;
  [key: string]: unknown;
}

// ─── Constants ─────────────────────────────────────────────

/** usedAddons id of the plugin that owns flowcharts. */
export const FLOWCHART_PLUGIN_ID = 'Flowchart';

/** Canvas size Construct 3 gives a new flowchart. */
export const DEFAULT_CANVAS_SIZE = 20000;

/** Value types observed in editor-saved flowcharts; no other value was seen. */
export const VALUE_TYPES = ['dictionary', 'comment'] as const;
export type ValueType = typeof VALUE_TYPES[number];

/** Comment formatting keys, in the order editor-saved comment nodes have them after `prfnsid`. */
const COMMENT_KEYS = ['n', 'fo', 'fs', 'fb', 'fi', 'fc'] as const;

/**
 * Formatting a new comment gets when the caller gives none: the most common
 * value of each key in editor-saved flowcharts. Construct's own defaults
 * were not observed.
 */
const COMMENT_DEFAULTS = { fo: 'Calibri', fs: 36, fb: true, fi: false, fc: '#39b530' };

/** Most common node box in editor-saved flowcharts. */
export const DEFAULT_NODE_WIDTH = 300;
export const DEFAULT_NODE_HEIGHT = 133;

// ─── Locating registered flowcharts ────────────────────────

/** Deepest folder level searched, so a damaged container cannot recurse without end. */
const MAX_FOLDER_DEPTH = 50;

/** The string items of a folder; other entries are skipped. */
function itemsOf(folder: ProjectFolderNode): string[] {
  return Array.isArray(folder.items) ? folder.items.filter((item): item is string => typeof item === 'string') : [];
}

/** The subfolders of a folder that are objects; other entries are skipped. */
function subfoldersOf(folder: ProjectFolderNode): ProjectFolderNode[] {
  return Array.isArray(folder.subfolders)
    ? (folder.subfolders as unknown[]).filter((sub): sub is ProjectFolderNode => typeof sub === 'object' && sub !== null)
    : [];
}

/** What locateFlowcharts finds in the flowcharts container. */
export interface LocatedFlowcharts {
  /** Every flowchart a file can be resolved for, in project-bar order, with the named folders above it (outermost first). */
  flowcharts: Map<string, string[]>;
  /** Names registered in a folder without a name: no file can be resolved for them. */
  unresolved: Set<string>;
}

/**
 * Map every name in the flowcharts container of project.c3proj to the
 * folders it is registered in. A name registered twice keeps its first
 * place; folders nested deeper than 50 levels below the container, named
 * or not, are not searched.
 */
export function locateFlowcharts(container: ProjectFolderNode | undefined): LocatedFlowcharts {
  const flowcharts = new Map<string, string[]>();
  const unresolved = new Set<string>();
  // `depth` is the folder's level below the container, as `folders.length` is in walk
  const collect = (folder: ProjectFolderNode, into: Set<string>, depth: number): void => {
    if (depth > MAX_FOLDER_DEPTH) return;
    for (const item of itemsOf(folder)) into.add(item);
    for (const sub of subfoldersOf(folder)) collect(sub, into, depth + 1);
  };
  const walk = (folder: ProjectFolderNode, folders: string[]): void => {
    if (folders.length > MAX_FOLDER_DEPTH) return;
    for (const item of itemsOf(folder)) {
      if (!flowcharts.has(item)) flowcharts.set(item, folders);
    }
    for (const sub of subfoldersOf(folder)) {
      if (isNamelessFolder(sub)) collect(sub, unresolved, folders.length + 1);
      else walk(sub, [...folders, sub.name as string]);
    }
  };
  if (container) walk(container, []);
  return { flowcharts, unresolved };
}

// ─── Node and output lookup ────────────────────────────────

/** The node with this SID, if the flowchart has it. */
export function findNode(data: Flowchart, sid: number): FlowchartNode | undefined {
  return data.nodes.find(n => n.sid === sid);
}

/** The output pin with this SID, with its node and index, if any node has it. */
export function findOutput(
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

/** The first five SIDs of a list, with the total when there are more. */
function sidHint(sids: number[]): string {
  if (sids.length === 0) return '';
  const shown = sids.slice(0, 5).join(', ');
  return sids.length > 5 ? `${shown}, ... (${sids.length} total)` : shown;
}

/** Why a node SID names no node: the SIDs that do exist, as sentences. */
export function nodeNotFoundMessage(data: Flowchart, flowchartName: string, nodeSid: number): string {
  const hint = sidHint(data.nodes.map(n => n.sid));
  return `Node ${nodeSid} not found in flowchart "${flowchartName}".` +
    (hint ? ` Node SIDs in this flowchart: ${hint}.` : ' This flowchart has no nodes.');
}

/** Why an output SID names no output: the SIDs that do exist, as sentences. */
export function outputNotFoundMessage(data: Flowchart, flowchartName: string, outputSid: number): string {
  const sids: number[] = [];
  for (const n of data.nodes) for (const o of n.outputs ?? []) sids.push(o.sid);
  const hint = sidHint(sids);
  return `Output ${outputSid} not found in flowchart "${flowchartName}".` +
    (hint ? ` Output SIDs in this flowchart: ${hint}.` : ' This flowchart has no outputs.');
}

// ─── Start-node rule ───────────────────────────────────────

/**
 * Construct 3 keeps exactly one start node per flowchart. Clear `s` on every
 * node except `keepSid`; returns how many were cleared.
 */
export function clearOtherStartNodes(data: Flowchart, keepSid: number): number {
  let cleared = 0;
  for (const node of data.nodes) {
    if (node.sid !== keepSid && node.s === true) {
      node.s = false;
      cleared++;
    }
  }
  return cleared;
}

/** Warn when the flowchart no longer satisfies the one-start-node rule. */
export function startNodeWarnings(data: Flowchart): string[] {
  const starts = data.nodes.filter(n => n.s === true);
  if (data.nodes.length > 0 && starts.length === 0) {
    return ['This flowchart has no start node. Set isStart on one node so Construct 3 knows where execution begins.'];
  }
  if (starts.length > 1) {
    return [`This flowchart has ${starts.length} start nodes (${starts.map(n => n.sid).join(', ')}); Construct 3 expects exactly one.`];
  }
  return [];
}

// ─── Connection bookkeeping ────────────────────────────────

/**
 * Remove the incoming-connection entry for `outputSid` from `target`,
 * keeping pnSIDs and poSIDs parallel. A node without both lists has none.
 */
export function removeIncoming(target: FlowchartNode, outputSid: number): void {
  if (!Array.isArray(target.pnSIDs) || !Array.isArray(target.poSIDs)) return;
  for (let i = Math.max(target.pnSIDs.length, target.poSIDs.length) - 1; i >= 0; i--) {
    if (target.poSIDs[i] === outputSid) {
      target.pnSIDs.splice(i, 1);
      target.poSIDs.splice(i, 1);
    }
  }
}

/** Drop `childSid` from `parent.nodeSIDs` unless another output still points at it. */
export function pruneChildLink(parent: FlowchartNode, childSid: number): void {
  if (!Array.isArray(parent.nodeSIDs)) return;
  if (Array.isArray(parent.outputs) && parent.outputs.some(o => o.cnSID === childSid)) return;
  for (let i = parent.nodeSIDs.length - 1; i >= 0; i--) {
    if (parent.nodeSIDs[i] === childSid) parent.nodeSIDs.splice(i, 1);
  }
}

/**
 * Undo whatever connection `output` holds, leaving other connections between
 * the same two nodes intact. Returns the former target SID, or null when the
 * output was already unconnected.
 */
export function disconnectOutput(data: Flowchart, node: FlowchartNode, output: FlowchartOutput): number | null {
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
export function removeNodeReferences(data: Flowchart, removed: FlowchartNode): void {
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

/** A new, empty flowchart, with its keys in the order Construct 3 saves them. */
export function createFlowchartData(sid: number, name: string): Flowchart {
  return {
    sid,
    nodes: [],
    'preset-nodes': { items: [], subfolders: [] },
    name,
    w: DEFAULT_CANVAS_SIZE,
    h: DEFAULT_CANVAS_SIZE,
  };
}

/** A new, unconnected output pin. */
export function createOutput(sid: number, name: string, value: string, enable: boolean, isDefault: boolean): FlowchartOutput {
  return { sid, cnSID: null, name, value, enable, default: isDefault };
}

// ─── Comment nodes ─────────────────────────────────────────

/** Escape the characters HTML reads as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Spaces as the editor's HTML keeps them: a run alternates &nbsp; and a
 * space starting with &nbsp;, ends in &nbsp; at the end of a line, and a lone
 * space at the start or end of a line is &nbsp;. Counting a tag as a line
 * boundary, this matches 7,888 of the 7,922 space runs in the comment bodies
 * of an r495 editor-saved project; the rest are left over from edits inside
 * styled spans.
 */
function encodeSpaces(line: string): string {
  return line.replace(/ +/g, (run: string, offset: number) => {
    const atStart = offset === 0;
    const atEnd = offset + run.length === line.length;
    if (run.length === 1) return atStart || atEnd ? '&nbsp;' : ' ';
    let out = '';
    for (let i = 0; i < run.length; i++) out += i % 2 === 0 ? '&nbsp;' : ' ';
    if (atEnd && run.length % 2 === 0) out = out.slice(0, -1) + '&nbsp;';
    return out;
  });
}

/** Plain text as the editor stores a comment body: later lines in <div>, blank lines as <div><br></div>. */
export function commentTextToHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.map((line, i) => {
    const escaped = encodeSpaces(escapeHtml(line));
    if (i === 0) return escaped;
    return `<div>${escaped === '' ? '<br>' : escaped}</div>`;
  }).join('');
}

/** The comment fields of the node tools' arguments. */
export interface CommentInput {
  commentText?: string;
  commentHtml?: string;
  font?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  fontColor?: string;
}

/** Whether any comment field is given. */
export function hasCommentInput(args: CommentInput): boolean {
  return args.commentText !== undefined || args.commentHtml !== undefined || args.font !== undefined
    || args.fontSize !== undefined || args.bold !== undefined || args.italic !== undefined || args.fontColor !== undefined;
}

/**
 * Write the comment keys, keeping them after every other key in the order
 * editor-saved nodes have them. Missing keys are filled from `fallbackText`
 * and COMMENT_DEFAULTS; returns the names of keys that were defaulted.
 */
export function applyCommentFields(node: FlowchartNode, args: CommentInput, fallbackText: string): string[] {
  const current: Record<string, unknown> = {};
  for (const key of COMMENT_KEYS) {
    if (key in node) current[key] = node[key];
    delete node[key];
  }
  if (args.commentHtml !== undefined) current.n = args.commentHtml;
  else if (args.commentText !== undefined) current.n = commentTextToHtml(args.commentText);
  if (args.font !== undefined) current.fo = args.font;
  if (args.fontSize !== undefined) current.fs = args.fontSize;
  if (args.bold !== undefined) current.fb = args.bold;
  if (args.italic !== undefined) current.fi = args.italic;
  if (args.fontColor !== undefined) current.fc = args.fontColor.toLowerCase();
  const defaulted: string[] = [];
  if (current.n === undefined) current.n = commentTextToHtml(fallbackText);
  for (const [key, value] of Object.entries(COMMENT_DEFAULTS)) {
    if (current[key] === undefined) { current[key] = value; defaulted.push(key); }
  }
  for (const key of COMMENT_KEYS) node[key] = current[key];
  return defaulted;
}

/** The warning that says which comment formatting took a default. */
export function defaultedWarning(defaulted: string[]): string[] {
  if (defaulted.length === 0) return [];
  return [`Comment formatting ${defaulted.join(', ')} took the values most common in editor-saved flowcharts (Calibri, 36, bold, not italic, #39b530); Construct's own defaults were not observed.`];
}

/**
 * Change a node's value type, keeping it valid for the new type: a comment
 * has no outputs or connections and an empty `t`; a dictionary node has no
 * comment keys and a `t` (the caption when it was empty).
 */
export function changeValueType(
  node: FlowchartNode,
  to: ValueType,
  args: CommentInput & { nodeType?: string },
): { ok: true; warnings: string[] } | { ok: false; error: string } {
  if (node.ty === to) return { ok: true, warnings: [] };
  if (!(VALUE_TYPES as readonly string[]).includes(node.ty)) {
    return { ok: false, error: `Node ${node.sid} has value type "${node.ty}", which these tools do not convert.` };
  }
  if (to === 'comment') {
    const outputs = node.outputs?.length ?? 0;
    const incoming = node.pnSIDs?.length ?? 0;
    if (outputs > 0 || incoming > 0 || (node.nodeSIDs?.length ?? 0) > 0) {
      return { ok: false, error: `Node ${node.sid} has ${outputs} output(s) and ${incoming} incoming connection(s); a comment node has none. Delete its outputs and disconnect the nodes that lead to it first.` };
    }
    node.ty = 'comment';
    if (args.nodeType === undefined) node.t = '';
    return { ok: true, warnings: defaultedWarning(applyCommentFields(node, args, node.c)) };
  }
  for (const key of COMMENT_KEYS) delete node[key];
  node.ty = 'dictionary';
  if (args.nodeType === undefined && node.t === '') node.t = node.c;
  return { ok: true, warnings: [] };
}
