/**
 * Real-filesystem tests for flowchart comment nodes and value-type changes.
 *
 * Key orders come from the 1,539 nodes of the 31 C3-ACE flowcharts
 * (2026-09-17 probe): every dictionary node has DICTIONARY_KEYS and every
 * one of the 166 comment nodes has COMMENT_NODE_KEYS, with no outputs,
 * no connections and `t: ""`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, cp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import { registerFlowchartTools, commentTextToHtml } from '../../src/tools/flowchart-tools.js';
import type { Flowchart, FlowchartNode } from '../../src/construct3/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

const DICTIONARY_KEYS = ['sid', 'pnSIDs', 'poSIDs', 'nodeSIDs', 'outputs', 'x', 'y', 'w', 'h', 't', 's', 'e', 'pi', 'c', 'ty', 'pr', 'prfsid', 'prfnsid'];
const COMMENT_NODE_KEYS = [...DICTIONARY_KEYS, 'n', 'fo', 'fs', 'fb', 'fi', 'fc'];

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('flowchart comment nodes and value types (real project on disk)', () => {
  let tmpDir: string;
  let server: MockServer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c3-flowchart-comment-'));
    await cp(FIXTURE_DIR, tmpDir, { recursive: true });
    const reader = new Construct3ProjectReader(join(tmpDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerFlowchartTools({ server, reader, writer, idGen } as any);
    expect(parseResult(await server.callTool('create_flowchart', { name: 'Graph' })).success).toBe(true);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function nodes(): Promise<FlowchartNode[]> {
    const data = JSON.parse(await readFile(join(tmpDir, 'flowcharts', 'Graph.json'), 'utf-8')) as Flowchart;
    return data.nodes;
  }

  async function add(args: Record<string, unknown>) {
    return server.callTool('add_flowchart_node', { flowchartName: 'Graph', caption: 'Note', x: 0, y: 0, ...args });
  }

  async function update(nodeSid: number, args: Record<string, unknown>) {
    return server.callTool('update_flowchart_node', { flowchartName: 'Graph', nodeSid, ...args });
  }

  it('stores plain comment text as the editor HTML', () => {
    expect(commentTextToHtml('Test A & B')).toBe('Test A &amp; B');
    expect(commentTextToHtml('Line 1\nLine <2>\n\nEnd')).toBe('Line 1<div>Line &lt;2&gt;</div><div><br></div><div>End</div>');
  });

  it('adds a comment node with the sampled keys, key order and formatting', async () => {
    const result = parseResult(await add({
      valueType: 'comment',
      commentText: 'Tests\nsecond',
      font: 'Arial',
      fontSize: 24,
      bold: true,
      italic: true,
      fontColor: '#98B530',
    }));
    expect(result.success).toBe(true);

    const [node] = await nodes();
    expect(Object.keys(node)).toEqual(COMMENT_NODE_KEYS);
    expect(node).toMatchObject({
      t: '', ty: 'comment', c: 'Note', outputs: [], pnSIDs: [],
      n: 'Tests<div>second</div>', fo: 'Arial', fs: 24, fb: true, fi: true, fc: '#98b530',
    });
    expect((result.warnings ?? []).join(' ')).not.toContain('most common');
  });

  it('fills missing comment formatting and says so', async () => {
    const result = parseResult(await add({ valueType: 'comment' }));
    const [node] = await nodes();
    expect(Object.keys(node)).toEqual(COMMENT_NODE_KEYS);
    expect(node).toMatchObject({ n: 'Note', fo: 'Calibri', fs: 36, fb: true, fi: false, fc: '#39b530' });
    expect(result.warnings.join(' ')).toContain('most common');
  });

  it('refuses outputs and comment fields where they do not belong', async () => {
    const withOutputs = await add({ valueType: 'comment', outputs: [{ name: 'Out' }] });
    expect(withOutputs.isError).toBe(true);
    expect(withOutputs.content[0].text).toContain('no outputs');

    const onDictionary = await add({ font: 'Arial' });
    expect(onDictionary.isError).toBe(true);
    expect(onDictionary.content[0].text).toContain('comment nodes only');

    expect(await nodes()).toEqual([]);
  });

  it('edits the formatting of an existing comment node in place', async () => {
    const { generatedSid } = parseResult(await add({ valueType: 'comment', font: 'Arial', fontSize: 12, bold: false, italic: false, fontColor: '#000000' }));
    const result = parseResult(await update(generatedSid, { commentHtml: '<b>x</b>', fontSize: 80, italic: true }));
    expect(result.success).toBe(true);
    const [node] = await nodes();
    expect(Object.keys(node)).toEqual(COMMENT_NODE_KEYS);
    expect(node).toMatchObject({ n: '<b>x</b>', fo: 'Arial', fs: 80, fb: false, fi: true, fc: '#000000' });
  });

  it('refuses comment fields on a dictionary node', async () => {
    const { generatedSid } = parseResult(await add({}));
    const result = await update(generatedSid, { bold: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('comment nodes only');
    expect(Object.keys((await nodes())[0])).toEqual(DICTIONARY_KEYS);
  });

  it('turns an unconnected dictionary node into a comment node with valid keys', async () => {
    const { generatedSid } = parseResult(await add({ caption: 'Remember this' }));
    const result = parseResult(await update(generatedSid, { valueType: 'comment', font: 'Arial' }));
    expect(result.success).toBe(true);
    const [node] = await nodes();
    expect(Object.keys(node)).toEqual(COMMENT_NODE_KEYS);
    expect(node).toMatchObject({ ty: 'comment', t: '', c: 'Remember this', n: 'Remember this', fo: 'Arial' });
  });

  it('turns a comment node back into a dictionary node without comment keys', async () => {
    const { generatedSid } = parseResult(await add({ valueType: 'comment', caption: 'Back' }));
    const result = parseResult(await update(generatedSid, { valueType: 'dictionary' }));
    expect(result.success).toBe(true);
    const [node] = await nodes();
    expect(Object.keys(node)).toEqual(DICTIONARY_KEYS);
    expect(node).toMatchObject({ ty: 'dictionary', t: 'Back', c: 'Back' });
  });

  it('refuses to make a node with outputs or connections a comment', async () => {
    const parent = parseResult(await add({ caption: 'A', outputs: [{ name: 'Next' }] }));
    const child = parseResult(await add({ caption: 'B' }));
    await server.callTool('connect_flowchart_nodes', { flowchartName: 'Graph', outputSid: parent.outputSids[0], targetNodeSid: child.generatedSid });

    for (const sid of [parent.generatedSid, child.generatedSid]) {
      const result = await update(sid, { valueType: 'comment' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('a comment node has none');
    }
    for (const node of await nodes()) expect(node.ty).toBe('dictionary');
  });
});
