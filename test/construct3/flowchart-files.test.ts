/**
 * Reading and writing flowchart files, and the project.c3proj registration.
 * The data is synthetic; the reader, writer and ID generator are the real ones.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm } from 'fs/promises';
import { runInToolCall } from '../../src/construct3/disk-state.js';
import { createFlowchartData, createOutput, type Flowchart } from '../../src/construct3/flowchart-model.js';
import {
  describeError,
  flowchartFilePath,
  flowchartLabel,
  isRegistered,
  openFlowchart,
  registerFlowchart,
  unregisterFlowchart,
  withdrawFlowchart,
  writeFlowchart,
} from '../../src/construct3/flowchart-files.js';
import {
  editorSave,
  flowchartFile,
  makeProject,
  registerByHand,
  removeFlowchartProject,
  staleText,
  type FlowchartProject,
} from '../helpers/flowchart-project.js';

/** A folder of the flowcharts container of project.c3proj. */
interface FolderContainer {
  items: string[];
  subfolders: FolderContainer[];
  name?: string;
}

let project: FlowchartProject;

beforeEach(async () => {
  project = await makeProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeFlowchartProject(project);
});

function chartText(name = 'Graph'): string {
  return JSON.stringify(createFlowchartData(1, name), null, '\t');
}

/** Run `fn` as one tool call, as every tool handler does. */
function inCall<T>(fn: () => Promise<T>): Promise<T> {
  return runInToolCall(fn);
}

describe('describeError', () => {
  it('drops the path Node appends to an fs error, also one with an apostrophe in it', () => {
    const error = new Error("EPERM: operation not permitted, rename 'C:\\Users\\O'Brien\\g\\a.tmp' -> 'C:\\Users\\O'Brien\\g\\a.json'");
    expect(describeError(error)).toBe('EPERM: operation not permitted');
    expect(describeError(new Error("ENOENT: no such file or directory, open 'C:\\x\\y.json'"))).toBe('ENOENT: no such file or directory');
    expect(describeError(new Error('Something failed.'))).toBe('Something failed');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('openFlowchart', () => {
  it('reads a registered flowchart with the state it was read in', async () => {
    await registerByHand(project, 'Graph', chartText(), ['AI']);
    const opened = await inCall(() => openFlowchart(project.reader, 'Graph', ['AI']));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.flowchart.label).toBe('flowcharts/AI/Graph.json');
    expect(opened.flowchart.data.nodes).toEqual([]);
    expect(opened.flowchart.state).toBeDefined();
    expect(opened.flowchart.filePath).toBe(flowchartFile(project.dir, 'Graph', ['AI']));
  });

  const refusals: Array<[string, () => Promise<void>, string]> = [
    ['a registered name with no file', async () => { await registerByHand(project, 'Graph', chartText()); await rmFile('Graph'); }, 'could not be read: ENOENT'],
    ['a folder in the place of the file', async () => { await registerByHand(project, 'Graph', chartText()); await rmFile('Graph'); await mkdir(flowchartFile(project.dir, 'Graph'), { recursive: true }); }, 'could not be read'],
    ['text that is not JSON', async () => { await registerByHand(project, 'Graph', '{ broken'); }, 'is not valid JSON'],
    ['an array', async () => { await registerByHand(project, 'Graph', '[]'); }, 'does not hold a flowchart'],
    ['an object without nodes', async () => { await registerByHand(project, 'Graph', '{"name":"x"}'); }, 'does not hold a flowchart'],
    ['nodes that are not a list', async () => { await registerByHand(project, 'Graph', '{"nodes":{}}'); }, 'it has no list of nodes'],
    ['nodes that are text', async () => { await registerByHand(project, 'Graph', '{"nodes":"x"}'); }, 'it has no list of nodes'],
    ['a node that is a number', async () => { await registerByHand(project, 'Graph', '{"nodes":[{"sid":1},5]}'); }, 'a node in it is not an object'],
    ['a node that is null', async () => { await registerByHand(project, 'Graph', '{"nodes":[null]}'); }, 'a node in it is not an object'],
    ['a node that is a list', async () => { await registerByHand(project, 'Graph', '{"nodes":[[]]}'); }, 'a node in it is not an object'],
    ['outputs that are not a list', async () => { await registerByHand(project, 'Graph', '{"nodes":[{"sid":1,"outputs":{}}]}'); }, 'the outputs of a node are not a list'],
    ['an output that is a number', async () => { await registerByHand(project, 'Graph', '{"nodes":[{"sid":1,"outputs":[{"sid":2},7]}]}'); }, 'an output in it is not an object'],
    ['an output that is null', async () => { await registerByHand(project, 'Graph', '{"nodes":[{"sid":1,"outputs":[null]}]}'); }, 'an output in it is not an object'],
  ];
  for (const [title, arrange, fragment] of refusals) {
    it(`refuses ${title}, without the project folder in the text`, async () => {
      await arrange();
      const opened = await inCall(() => openFlowchart(project.reader, 'Graph', []));
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.refusal).toContain('Flowchart "Graph" is registered in the project but flowcharts/Graph.json');
      expect(opened.refusal).toContain(fragment);
      expect(opened.refusal).not.toContain(project.dir);
      expect(opened.refusal.endsWith('.')).toBe(true);
    });
  }

  it('opens a node that has no outputs entry, and a node with a list of objects', async () => {
    await registerByHand(project, 'Graph', '{"nodes":[{"sid":1},{"sid":2,"outputs":[{"sid":3}]}]}');
    const opened = await inCall(() => openFlowchart(project.reader, 'Graph', []));
    expect(opened.ok).toBe(true);
  });

  it('refuses a folder that leaves the flowcharts folder', async () => {
    const opened = await inCall(() => openFlowchart(project.reader, 'x', ['..']));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.refusal).toContain('Path traversal detected');
    expect(opened.refusal).not.toContain(project.dir);
  });

  async function rmFile(name: string): Promise<void> {
    await rm(flowchartFile(project.dir, name));
  }
});

describe('writeFlowchart', () => {
  async function openGraph(text = chartText()) {
    await registerByHand(project, 'Graph', text);
    const opened = await openFlowchart(project.reader, 'Graph', []);
    if (!opened.ok) throw new Error(opened.refusal);
    return opened.flowchart;
  }

  it('writes the changed flowchart and keeps a backup of the state before the call', async () => {
    const result = await inCall(async () => {
      const flowchart = await openGraph();
      flowchart.data.nodes.push({ sid: 5, pnSIDs: [], poSIDs: [], nodeSIDs: [], outputs: [createOutput(6, 'o', '', true, false)], x: 1, y: 2, w: 3, h: 4, t: 't', s: true, e: true, pi: 0, c: 'c', ty: 'dictionary', pr: false, prfsid: null, prfnsid: null });
      return writeFlowchart(project.reader, project.writer, flowchart);
    });
    expect(result.ok).toBe(true);
    const onDisk = JSON.parse(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')) as Flowchart;
    expect(onDisk.nodes.map(n => n.sid)).toEqual([5]);
    if (!result.ok) return;
    expect(JSON.parse(await readFile(result.backupFile as string, 'utf-8')).nodes).toEqual([]);
  });

  it('keeps the byte order mark, the line endings and the trailing newline of the file', async () => {
    const crlf = '\uFEFF' + chartText().replace(/\n/g, '\r\n') + '\r\n';
    await inCall(async () => {
      const flowchart = await openGraph(crlf);
      flowchart.data.name = 'Renamed';
      const written = await writeFlowchart(project.reader, project.writer, flowchart);
      expect(written.ok).toBe(true);
    });
    const raw = await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('"name": "Renamed"');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    expect(raw.endsWith('\r\n')).toBe(true);
  });

  it('refuses to overwrite a flowchart the editor saved after the call read it', async () => {
    const edited = JSON.stringify({ ...createFlowchartData(1, 'Graph'), note: 'saved in the editor' }, null, '\t');
    const result = await inCall(async () => {
      const flowchart = await openGraph();
      await editorSave(flowchartFile(project.dir, 'Graph'), edited);
      flowchart.data.name = 'Mine';
      return writeFlowchart(project.reader, project.writer, flowchart);
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(staleText('flowcharts/Graph.json'));
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(edited);
  });

  it('says nothing was changed when the write fails before it touched the file, without a path in the text', async () => {
    const result = await inCall(async () => {
      const flowchart = await openGraph();
      vi.spyOn(project.writer, 'replaceFile').mockRejectedValue(new Error(`EACCES: permission denied, open '${flowchartFile(project.dir, 'Graph')}'`));
      return writeFlowchart(project.reader, project.writer, flowchart);
    });
    expect(result).toEqual({ ok: false, message: 'EACCES: permission denied. Nothing was changed.' });
  });

  it('names the backup when the write fails after it replaced the file', async () => {
    const original = project.writer.replaceFile.bind(project.writer);
    const result = await inCall(async () => {
      const flowchart = await openGraph();
      flowchart.data.name = 'Mine';
      vi.spyOn(project.writer, 'replaceFile').mockImplementation(async (path, content, options) => {
        await original(path, content, options);
        throw new Error('the read-back failed');
      });
      return writeFlowchart(project.reader, project.writer, flowchart);
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('the read-back failed. flowcharts/Graph.json may have been changed by this call. Its state from before the call is in flowcharts/Graph.json.bak. Check it before you run the tool again.');
  });

  it('does not call the file untouched when it changed without a backup being made', async () => {
    const result = await inCall(async () => {
      const flowchart = await openGraph();
      vi.spyOn(project.writer, 'replaceFile').mockImplementation(async () => {
        await editorSave(flowchartFile(project.dir, 'Graph'), '{"nodes":[],"other":true}');
        throw new Error('lock failed');
      });
      return writeFlowchart(project.reader, project.writer, flowchart);
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('lock failed. flowcharts/Graph.json may have been changed by this call. Check it before you run the tool again.');
  });
});

describe('the project.c3proj registration', () => {
  it('creates the container and the folders the way the editor saves them', () => {
    const project: { flowcharts?: unknown } = {};
    expect(registerFlowchart(project, 'Deep', ['AI', 'States'])).toEqual({ container: true, foldersMade: 2 });
    expect(project.flowcharts).toEqual({
      items: [],
      subfolders: [{ items: [], subfolders: [{ items: ['Deep'], subfolders: [], name: 'States' }], name: 'AI' }],
    });
    const ai = (project.flowcharts as { subfolders: Array<Record<string, unknown>> }).subfolders[0];
    expect(Object.keys(ai)).toEqual(['items', 'subfolders', 'name']);
  });

  it('reuses an existing folder and reports a name that is already registered there', () => {
    const project = { flowcharts: { items: ['Root'], subfolders: [{ items: ['A'], subfolders: [], name: 'AI' }] } };
    expect(registerFlowchart(project, 'B', ['AI'])).toEqual({ container: false, foldersMade: 0 });
    expect(registerFlowchart(project, 'B', ['AI'])).toBeUndefined();
    expect(registerFlowchart(project, 'Root', [])).toBeUndefined();
    expect(project.flowcharts.subfolders[0].items).toEqual(['A', 'B']);
  });

  it('counts the folders it made, the innermost ones', () => {
    const project = { flowcharts: { items: [], subfolders: [{ items: [], subfolders: [], name: 'AI' }] } };
    expect(registerFlowchart(project, 'Deep', ['AI', 'States', 'Deeper'])).toEqual({ container: false, foldersMade: 2 });
  });

  it('refuses a flowcharts entry that is not a folder container', () => {
    for (const flowcharts of ['text', 5, null, []]) {
      expect(() => registerFlowchart({ flowcharts }, 'X', [])).toThrow('is not a folder container');
    }
  });

  it('removes a name from exactly the folder it is registered in', () => {
    const project = { flowcharts: { items: ['Same'], subfolders: [{ name: 'AI', items: ['Same', 'Other'], subfolders: [] }] } };
    unregisterFlowchart(project, 'Same', ['AI']);
    expect(project.flowcharts.items).toEqual(['Same']);
    expect(project.flowcharts.subfolders[0].items).toEqual(['Other']);
    expect(() => unregisterFlowchart(project, 'Same', ['AI'])).toThrow('"Same" is not registered in flowcharts/AI of project.c3proj');
    expect(() => unregisterFlowchart({}, 'Same', [])).toThrow('is not registered in flowcharts of project.c3proj');
  });

  it('skips subfolder entries that are not folders, as locateFlowcharts does', () => {
    const project = { flowcharts: { items: [], subfolders: [null, 5, { items: ['A'], subfolders: [], name: 'AI' }] } };
    expect(registerFlowchart(project, 'B', ['AI'])).toEqual({ container: false, foldersMade: 0 });
    expect(project.flowcharts.subfolders[2]).toEqual({ items: ['A', 'B'], subfolders: [], name: 'AI' });
    expect(isRegistered(project, 'B', ['AI'])).toBe(true);
    unregisterFlowchart(project, 'B', ['AI']);
    expect(project.flowcharts.subfolders[2]).toEqual({ items: ['A'], subfolders: [], name: 'AI' });
    expect(isRegistered(project, 'B', ['AI'])).toBe(false);
  });

  it('copes with a folder that has no subfolders or items list', () => {
    const project: { flowcharts?: unknown } = { flowcharts: { items: ['A'] } };
    expect(isRegistered(project, 'A', [])).toBe(true);
    expect(isRegistered(project, 'A', ['X'])).toBe(false);
    expect(registerFlowchart(project, 'B', ['X'])).toEqual({ container: false, foldersMade: 1 });
    expect(project.flowcharts).toEqual({ items: ['A'], subfolders: [{ items: ['B'], subfolders: [], name: 'X' }] });
  });

  it('creates the items list of a root and of a named folder that has none', () => {
    const root: { flowcharts?: unknown } = { flowcharts: { subfolders: [] } };
    expect(registerFlowchart(root, 'A', [])).toEqual({ container: false, foldersMade: 0 });
    expect(root.flowcharts).toEqual({ subfolders: [], items: ['A'] });
    const named: { flowcharts?: unknown } = { flowcharts: { items: [], subfolders: [{ name: 'X', subfolders: [] }] } };
    expect(registerFlowchart(named, 'B', ['X'])).toEqual({ container: false, foldersMade: 0 });
    expect(named.flowcharts).toEqual({ items: [], subfolders: [{ name: 'X', subfolders: [], items: ['B'] }] });
  });

  it('says whether a name is registered in exactly one folder', () => {
    const project = { flowcharts: { items: ['Root'], subfolders: [{ items: ['A'], subfolders: [], name: 'AI' }] } };
    expect(isRegistered(project, 'Root', [])).toBe(true);
    expect(isRegistered(project, 'Root', ['AI'])).toBe(false);
    expect(isRegistered(project, 'A', ['AI'])).toBe(true);
    expect(isRegistered(project, 'A', ['Other'])).toBe(false);
    expect(isRegistered({}, 'Root', [])).toBe(false);
    expect(isRegistered({ flowcharts: 'text' }, 'Root', [])).toBe(false);
  });
});

describe('withdrawing a registration', () => {
  it('removes the name, the folders and the container the registration made, and nothing else', () => {
    const project: { flowcharts?: unknown } = {};
    const made = registerFlowchart(project, 'Deep', ['AI', 'States'])!;
    expect(withdrawFlowchart(project, 'Deep', ['AI', 'States'], made)).toBe(true);
    expect(project.flowcharts).toBeUndefined();
    expect(Object.keys(project)).toEqual([]);
  });

  it('keeps a folder that already existed, and a folder something was saved into since', () => {
    const plain: { flowcharts?: FolderContainer } = { flowcharts: { items: [], subfolders: [{ items: [], subfolders: [], name: 'AI' }] } };
    const madePlain = registerFlowchart(plain, 'Deep', ['AI', 'States'])!;
    expect(withdrawFlowchart(plain, 'Deep', ['AI', 'States'], madePlain)).toBe(true);
    expect(plain.flowcharts).toEqual({ items: [], subfolders: [{ items: [], subfolders: [], name: 'AI' }] });

    const project: { flowcharts?: FolderContainer } = { flowcharts: { items: ['Root'], subfolders: [{ items: [], subfolders: [], name: 'AI' }] } };
    const made = registerFlowchart(project, 'Deep', ['AI', 'States', 'Deeper'])!;
    expect(made).toEqual({ container: false, foldersMade: 2 });
    // Saved in the editor since: another flowchart in the folder this call made
    project.flowcharts!.subfolders[0].subfolders[0].items.push('Saved');
    expect(withdrawFlowchart(project, 'Deep', ['AI', 'States', 'Deeper'], made)).toBe(true);
    expect(project.flowcharts).toEqual({
      items: ['Root'],
      subfolders: [{ items: [], subfolders: [{ items: ['Saved'], subfolders: [], name: 'States' }], name: 'AI' }],
    });
  });

  it('keeps a container something was saved into, and does nothing when the name is not registered there', () => {
    const project: { flowcharts?: FolderContainer } = {};
    const made = registerFlowchart(project, 'Graph', [])!;
    project.flowcharts!.items.push('Saved');
    expect(withdrawFlowchart(project, 'Graph', [], made)).toBe(true);
    expect(project.flowcharts).toEqual({ items: ['Saved'], subfolders: [] });
    expect(withdrawFlowchart(project, 'Graph', [], made)).toBe(false);
    expect(project.flowcharts).toEqual({ items: ['Saved'], subfolders: [] });
  });
});

describe('flowchartFilePath', () => {
  it('stays inside the flowcharts folder', () => {
    expect(flowchartFilePath(project.dir, 'G', ['A'])).toBe(flowchartFile(project.dir, 'G', ['A']));
    expect(() => flowchartFilePath(project.dir, 'x', ['..'])).toThrow('Path traversal detected');
    expect(() => flowchartFilePath(project.dir, '../x', [])).toThrow('Path traversal detected');
  });
});

describe('flowchartLabel', () => {
  it('is the project-relative path of the file', () => {
    expect(flowchartLabel('G', [])).toBe('flowcharts/G.json');
    expect(flowchartLabel('G', ['A', 'B'])).toBe('flowcharts/A/B/G.json');
  });
});

