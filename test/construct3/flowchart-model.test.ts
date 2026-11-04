/**
 * The flowchart data model: locating registered flowcharts, the start-node
 * rule, connection bookkeeping and comment nodes. All data is synthetic.
 */

import { describe, it, expect } from 'vitest';
import {
  applyCommentFields,
  changeValueType,
  clearOtherStartNodes,
  commentTextToHtml,
  createFlowchartData,
  createOutput,
  defaultedWarning,
  disconnectOutput,
  findOutput,
  locateFlowcharts,
  nodeNotFoundMessage,
  outputNotFoundMessage,
  pruneChildLink,
  removeIncoming,
  removeNodeReferences,
  startNodeWarnings,
  type Flowchart,
  type FlowchartNode,
} from '../../src/construct3/flowchart-model.js';

const DICTIONARY_KEYS = ['sid', 'pnSIDs', 'poSIDs', 'nodeSIDs', 'outputs', 'x', 'y', 'w', 'h', 't', 's', 'e', 'pi', 'c', 'ty', 'pr', 'prfsid', 'prfnsid'];
const COMMENT_NODE_KEYS = [...DICTIONARY_KEYS, 'n', 'fo', 'fs', 'fb', 'fi', 'fc'];

function node(sid: number, extra: Partial<FlowchartNode> = {}): FlowchartNode {
  return {
    sid, pnSIDs: [], poSIDs: [], nodeSIDs: [], outputs: [], x: 0, y: 0, w: 300, h: 133,
    t: `n${sid}`, s: false, e: true, pi: 0, c: `n${sid}`, ty: 'dictionary', pr: false, prfsid: null, prfnsid: null,
    ...extra,
  };
}

function chart(...nodes: FlowchartNode[]): Flowchart {
  return { ...createFlowchartData(1, 'G'), nodes };
}

describe('locateFlowcharts', () => {
  it('finds flowcharts at the root and in nested folders, with the folders above each', () => {
    const { flowcharts, unresolved } = locateFlowcharts({
      items: ['Root A'],
      subfolders: [
        { name: 'AI', items: ['Mid'], subfolders: [{ name: 'States', items: ['Deep'], subfolders: [] }] },
        { name: 'Other', items: ['Side'], subfolders: [] },
      ],
    });
    expect([...flowcharts]).toEqual([['Root A', []], ['Mid', ['AI']], ['Deep', ['AI', 'States']], ['Side', ['Other']]]);
    expect(unresolved.size).toBe(0);
  });

  it('does not resolve a name registered in a folder without a name', () => {
    const { flowcharts, unresolved } = locateFlowcharts({
      items: [],
      subfolders: [
        { items: ['Hidden'], subfolders: [{ name: 'Inner', items: ['Deeper'], subfolders: [] }] },
        { name: '', items: ['Blank'], subfolders: [] },
      ],
    });
    expect(flowcharts.size).toBe(0);
    expect([...unresolved].sort()).toEqual(['Blank', 'Deeper', 'Hidden']);
  });

  it('keeps the first registration of a name registered twice', () => {
    const { flowcharts } = locateFlowcharts({ items: ['Dup'], subfolders: [{ name: 'F', items: ['Dup'], subfolders: [] }] });
    expect(flowcharts.get('Dup')).toEqual([]);
  });

  it('reads a damaged container without throwing', () => {
    const damaged = { items: 'x', subfolders: [null, 5, { name: 'A', items: ['One', 7], subfolders: 'no' }] };
    const { flowcharts } = locateFlowcharts(damaged);
    expect([...flowcharts]).toEqual([['One', ['A']]]);
    expect(locateFlowcharts(undefined).flowcharts.size).toBe(0);
  });

  it('stops at 50 levels of folders', () => {
    type Folder = { name: string; items: string[]; subfolders: Folder[] };
    let inner: Folder = { name: 'f60', items: ['Deep'], subfolders: [] };
    for (let level = 59; level >= 1; level--) {
      inner = { name: `f${level}`, items: level === 3 ? ['Shallow'] : [], subfolders: [inner] };
    }
    const { flowcharts, unresolved } = locateFlowcharts({ items: [], subfolders: [inner] });
    expect(flowcharts.get('Shallow')).toEqual(['f1', 'f2', 'f3']);
    expect(flowcharts.has('Deep')).toBe(false);
    expect(unresolved.has('Deep')).toBe(false);
  });

  it('keeps a name at level 50 and drops one at level 51', () => {
    type Folder = { name: string; items: string[]; subfolders: Folder[] };
    let inner: Folder = { name: 'f52', items: [], subfolders: [] };
    for (let level = 51; level >= 1; level--) {
      const items = level === 50 ? ['At50'] : level === 51 ? ['At51'] : [];
      inner = { name: `f${level}`, items, subfolders: [inner] };
    }
    const { flowcharts } = locateFlowcharts({ items: [], subfolders: [inner] });
    expect(flowcharts.get('At50')?.length).toBe(50);
    expect(flowcharts.has('At51')).toBe(false);
  });

  it('gives each name its own folder list', () => {
    const { flowcharts } = locateFlowcharts({ items: ['A', 'B'], subfolders: [{ name: 'F', items: ['C', 'D'], subfolders: [] }] });
    flowcharts.get('A')?.push('changed');
    flowcharts.get('C')?.push('changed');
    expect(flowcharts.get('B')).toEqual([]);
    expect(flowcharts.get('D')).toEqual(['F']);
  });

  it('stops at 50 levels of folders below a folder without a name too', () => {
    type Folder = { name?: string; items: string[]; subfolders: Folder[] };
    let inner: Folder = { name: 'f51', items: ['Beyond'], subfolders: [] };
    for (let level = 50; level >= 2; level--) {
      inner = { name: `f${level}`, items: level === 50 ? ['Edge'] : [], subfolders: [inner] };
    }
    const { unresolved } = locateFlowcharts({ items: [], subfolders: [{ items: [], subfolders: [inner] }] });
    expect(unresolved.has('Edge')).toBe(true);
    expect(unresolved.has('Beyond')).toBe(false);
  });
});

describe('lookups and their messages', () => {
  it('names the SIDs that exist, as one sentence', () => {
    expect(nodeNotFoundMessage(chart(node(1), node(2)), 'G', 9)).toBe('Node 9 not found in flowchart "G". Node SIDs in this flowchart: 1, 2.');
    expect(nodeNotFoundMessage(chart(), 'G', 9)).toBe('Node 9 not found in flowchart "G". This flowchart has no nodes.');
    const many = chart(...[1, 2, 3, 4, 5, 6].map(sid => node(sid)));
    expect(nodeNotFoundMessage(many, 'G', 9)).toContain('1, 2, 3, 4, 5, ... (6 total).');
    const withOutput = chart(node(1, { outputs: [createOutput(10, 'a', '', true, false)] }));
    expect(outputNotFoundMessage(withOutput, 'G', 9)).toBe('Output 9 not found in flowchart "G". Output SIDs in this flowchart: 10.');
    expect(outputNotFoundMessage(chart(node(1)), 'G', 9)).toBe('Output 9 not found in flowchart "G". This flowchart has no outputs.');
  });

  it('lists output SIDs past a node that has no outputs list', () => {
    const noList = { sid: 1 } as unknown as FlowchartNode;
    const holder = node(2, { outputs: [createOutput(10, 'a', '', true, false)] });
    expect(outputNotFoundMessage(chart(noList, holder), 'G', 9)).toContain('Output SIDs in this flowchart: 10.');
  });

  it('finds an output past a node that has no outputs list', () => {
    const noList = { sid: 1 } as unknown as FlowchartNode;
    const holder = node(2, { outputs: [createOutput(10, 'a', '', true, false), createOutput(11, 'b', '', true, false)] });
    const found = findOutput(chart(noList, holder), 11);
    expect(found?.node.sid).toBe(2);
    expect(found?.index).toBe(1);
    expect(findOutput(chart(noList), 11)).toBeUndefined();
  });

  it('creates a flowchart with the keys in the order Construct 3 saves them', () => {
    const data = createFlowchartData(42, 'G');
    expect(Object.keys(data)).toEqual(['sid', 'nodes', 'preset-nodes', 'name', 'w', 'h']);
    expect(data).toMatchObject({ sid: 42, nodes: [], name: 'G', w: 20000, h: 20000 });
  });
});

describe('start node', () => {
  it('warns when a flowchart with nodes has no start node, or more than one', () => {
    expect(startNodeWarnings(chart())).toEqual([]);
    expect(startNodeWarnings(chart(node(1), node(2)))[0]).toContain('no start node');
    expect(startNodeWarnings(chart(node(1), node(2)))[0]).toContain('sampled editor-saved flowchart had exactly one');
    expect(startNodeWarnings(chart(node(1, { s: true }), node(2, { s: true })))[0]).toContain('sampled editor-saved flowchart had exactly one');
    expect(startNodeWarnings(chart(node(1, { s: true }), node(2, { s: true })))[0]).toContain('2 start nodes (1, 2)');
    expect(startNodeWarnings(chart(node(1, { s: true })))).toEqual([]);
  });

  it('clears the flag on every node but the one kept, and counts them', () => {
    const data = chart(node(1, { s: true }), node(2, { s: true }), node(3));
    expect(clearOtherStartNodes(data, 2)).toBe(1);
    expect(data.nodes.map(n => n.s)).toEqual([false, true, false]);
  });
});

describe('connections', () => {
  it('removes the incoming entries of an output, and tolerates a node without connection lists', () => {
    const target = node(2, { pnSIDs: [1, 1, 3], poSIDs: [10, 11, 12] });
    removeIncoming(target, 11);
    expect(target.pnSIDs).toEqual([1, 3]);
    expect(target.poSIDs).toEqual([10, 12]);
    expect(() => removeIncoming({ sid: 5 } as unknown as FlowchartNode, 11)).not.toThrow();
  });

  it('keeps a child link while another output points at the child, and tolerates a node without lists', () => {
    const parent = node(1, { nodeSIDs: [2, 3], outputs: [createOutput(10, 'a', '', true, false), createOutput(11, 'b', '', true, false)] });
    parent.outputs[0].cnSID = 2;
    pruneChildLink(parent, 2);
    expect(parent.nodeSIDs).toEqual([2, 3]);
    parent.outputs[0].cnSID = null;
    pruneChildLink(parent, 2);
    expect(parent.nodeSIDs).toEqual([3]);
    expect(() => pruneChildLink({ sid: 9 } as unknown as FlowchartNode, 2)).not.toThrow();
  });

  it('disconnects one output and leaves a second connection between the same nodes', () => {
    const parent = node(1, {
      nodeSIDs: [2],
      outputs: [createOutput(10, 'a', '', true, false), createOutput(11, 'b', '', true, false)],
    });
    parent.outputs[0].cnSID = 2;
    parent.outputs[1].cnSID = 2;
    const child = node(2, { pnSIDs: [1, 1], poSIDs: [10, 11] });
    const data = chart(parent, child);
    expect(disconnectOutput(data, parent, parent.outputs[0])).toBe(2);
    expect(parent.outputs[0].cnSID).toBeNull();
    expect(parent.nodeSIDs).toEqual([2]);
    expect(child.pnSIDs).toEqual([1]);
    expect(child.poSIDs).toEqual([11]);
    expect(disconnectOutput(data, parent, parent.outputs[1])).toBe(2);
    expect(parent.nodeSIDs).toEqual([]);
    expect(child.pnSIDs).toEqual([]);
    expect(disconnectOutput(data, parent, parent.outputs[1])).toBeNull();
  });

  it('prunes a child link when the parent has no outputs list', () => {
    const parent = { sid: 1, nodeSIDs: [2, 3] } as unknown as FlowchartNode;
    pruneChildLink(parent, 2);
    expect(parent.nodeSIDs).toEqual([3]);
  });

  it('disconnects an output whose target node is not in the flowchart', () => {
    const parent = node(1, { nodeSIDs: [99], outputs: [createOutput(10, 'a', '', true, false)] });
    parent.outputs[0].cnSID = 99;
    expect(disconnectOutput(chart(parent), parent, parent.outputs[0])).toBe(99);
    expect(parent.outputs[0].cnSID).toBeNull();
    expect(parent.nodeSIDs).toEqual([]);
  });

  it('treats an output with no target value at all as unconnected', () => {
    const parent = node(1, { outputs: [createOutput(10, 'a', '', true, false)] });
    delete (parent.outputs[0] as { cnSID?: unknown }).cnSID;
    expect(disconnectOutput(chart(parent), parent, parent.outputs[0])).toBeNull();
    expect('cnSID' in parent.outputs[0]).toBe(false);
  });

  it('removes a deleted node from entries where only the parent node or only the parent output matches', () => {
    const doomed = node(2, { outputs: [createOutput(20, 'c', '', true, false)] });
    const other = node(3, { pnSIDs: [2, 4, 5], poSIDs: [99, 20, 50] });
    const data = chart(other);
    removeNodeReferences(data, doomed);
    expect(other.pnSIDs).toEqual([5]);
    expect(other.poSIDs).toEqual([50]);
  });

  it('removes references from nodes and a deleted node that lack their lists', () => {
    const bare = { sid: 5 } as unknown as FlowchartNode;
    const doomed = { sid: 2 } as unknown as FlowchartNode;
    expect(() => removeNodeReferences(chart(bare), doomed)).not.toThrow();
  });

  it('removes every reference to a deleted node', () => {
    const parent = node(1, { nodeSIDs: [2, 3], outputs: [createOutput(10, 'a', '', true, false), createOutput(11, 'b', '', true, false)] });
    parent.outputs[0].cnSID = 2;
    parent.outputs[1].cnSID = 3;
    const doomed = node(2, { pnSIDs: [1], poSIDs: [10], nodeSIDs: [3], outputs: [createOutput(20, 'c', '', true, false)] });
    doomed.outputs[0].cnSID = 3;
    const grandchild = node(3, { pnSIDs: [1, 2], poSIDs: [11, 20] });
    const data = chart(parent, doomed, grandchild);
    data.nodes.splice(1, 1);
    removeNodeReferences(data, doomed);
    expect(parent.nodeSIDs).toEqual([3]);
    expect(parent.outputs[0].cnSID).toBeNull();
    expect(parent.outputs[1].cnSID).toBe(3);
    expect(grandchild.pnSIDs).toEqual([1]);
    expect(grandchild.poSIDs).toEqual([11]);
  });
});

describe('comment nodes', () => {
  it('stores plain comment text as the editor HTML', () => {
    expect(commentTextToHtml('Test A & B')).toBe('Test A &amp; B');
    expect(commentTextToHtml('Line 1\nLine <2>\n\nEnd')).toBe('Line 1<div>Line &lt;2&gt;</div><div><br></div><div>End</div>');
  });

  it('keeps runs of spaces the way the editor stores them', () => {
    expect(commentTextToHtml('a b')).toBe('a b');
    expect(commentTextToHtml('a  b')).toBe('a&nbsp; b');
    expect(commentTextToHtml('x   y')).toBe('x&nbsp; &nbsp;y');
    expect(commentTextToHtml('x    y')).toBe('x&nbsp; &nbsp; y');
    expect(commentTextToHtml(' lead')).toBe('&nbsp;lead');
    expect(commentTextToHtml('end ')).toBe('end&nbsp;');
    expect(commentTextToHtml('end  ')).toBe('end&nbsp;&nbsp;');
    expect(commentTextToHtml('end    ')).toBe('end&nbsp; &nbsp;&nbsp;');
    expect(commentTextToHtml('top\n     indented')).toBe('top<div>&nbsp; &nbsp; &nbsp;indented</div>');
  });

  it('writes the comment keys after every other key, in the order the editor has them', () => {
    const n = node(1);
    const defaulted = applyCommentFields(n, { commentText: 'Hi', fontColor: '#ABCDEF' }, 'fallback');
    expect(Object.keys(n)).toEqual(COMMENT_NODE_KEYS);
    expect(n).toMatchObject({ n: 'Hi', fo: 'Calibri', fs: 36, fb: true, fi: false, fc: '#abcdef' });
    expect(defaulted).toEqual(['fo', 'fs', 'fb', 'fi']);
  });

  it('turns a node without connections into a comment and back', () => {
    const n = node(1, { c: 'Remember' });
    const toComment = changeValueType(n, 'comment', {});
    expect(toComment).toMatchObject({ ok: true });
    expect(Object.keys(n)).toEqual(COMMENT_NODE_KEYS);
    expect(n).toMatchObject({ ty: 'comment', t: '', n: 'Remember' });
    expect(toComment.ok && toComment.warnings.join(' ')).toContain('most common');
    expect(changeValueType(n, 'dictionary', {})).toMatchObject({ ok: true });
    expect(Object.keys(n)).toEqual(DICTIONARY_KEYS);
    expect(n).toMatchObject({ ty: 'dictionary', t: 'Remember' });
  });

  it('turns a node that lacks its connection lists into a comment', () => {
    const bare = { sid: 6, c: 'Bare', t: 'Bare', ty: 'dictionary' } as unknown as FlowchartNode;
    expect(changeValueType(bare, 'comment', {})).toMatchObject({ ok: true });
    expect(bare.ty).toBe('comment');
  });

  it('gives no warning when every comment key is given', () => {
    const n = node(1);
    const result = changeValueType(n, 'comment', { commentText: 'x', font: 'Arial', fontSize: 10, bold: false, italic: true, fontColor: '#000000' });
    expect(result).toEqual({ ok: true, warnings: [] });
    expect(defaultedWarning([])).toEqual([]);
  });

  it('refuses to make a node with outputs or connections a comment, and a value type it does not know', () => {
    const withOutput = node(1, { outputs: [createOutput(10, 'a', '', true, false)] });
    const refused = changeValueType(withOutput, 'comment', {});
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain('a comment node has none');
    const incoming = node(2, { pnSIDs: [1], poSIDs: [10] });
    expect(changeValueType(incoming, 'comment', {}).ok).toBe(false);
    const parentOnly = node(4, { nodeSIDs: [2] });
    const blocked = changeValueType(parentOnly, 'comment', {});
    expect(!blocked.ok && blocked.error).toContain('0 output(s), 0 incoming connection(s) and 1 child link(s)');
    expect(parentOnly.ty).toBe('dictionary');
    const odd = node(3, { ty: 'other' });
    const unknown = changeValueType(odd, 'comment', {});
    expect(!unknown.ok && unknown.error).toContain('which these tools do not convert');
    expect(odd.ty).toBe('other');
  });
});
