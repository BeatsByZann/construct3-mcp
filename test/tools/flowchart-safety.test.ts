/**
 * What the flowchart tools do when a write fails or a file changed during the
 * call: the create and delete undo, stale files, failed writes. The data is
 * synthetic; failures are injected into the real writer with spies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { statFileState } from '../../src/construct3/disk-state.js';
import {
  editorSave,
  editorSaveSync,
  flowchartFile,
  makeFlowchartProject,
  parseResult,
  registeredFlowcharts,
  removeFlowchartProject,
  setFlowchartContainer,
  snapshotFiles,
  staleText,
  type FlowchartProject,
} from '../helpers/flowchart-project.js';

let project: FlowchartProject;

beforeEach(async () => {
  project = await makeFlowchartProject();
  // The handlers log the error they answer with; the tests assert the answer
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeFlowchartProject(project);
});

/** The change an update of project.c3proj runs on the parsed file. */
type ProjectUpdate = Parameters<FlowchartProject['writer']['updateProject']>[0];

const projectFile = (): string => join(project.dir, 'project.c3proj');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function call(tool: string, args: Record<string, unknown>) {
  const result = await project.server.callTool(tool, args);
  return { result, text: result.content[0].text, isError: result.isError === true };
}

/** project.c3proj as an editor save would leave it: another length, and a note that tells the saves apart. */
async function editedProjectText(note = 'saved in the editor'): Promise<string> {
  return JSON.stringify({ ...JSON.parse(await readFile(projectFile(), 'utf-8')), editorNote: note }, null, '\t');
}

/** The note of the second of two editor saves. */
const LATER_NOTE = 'saved in the editor again, a little later';

/** A snapshot without project.c3proj, which a rollback writes again (same data, text compared by parsing it). */
function withoutProject(snapshot: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshot).filter(([path]) => path !== 'project.c3proj'));
}

/**
 * The change of an update, wrapped so that each round saves the next of
 * `saves` as project.c3proj the way the editor does, after the round's
 * change ran. The writer takes its one backup after the first round's
 * change, so a save made in a later round is not in the backup, and an
 * undo that put the backup back would lose it.
 */
function savingEachRound(saves: readonly string[], change: ProjectUpdate): ProjectUpdate {
  let round = 0;
  return parsed => {
    const result = change(parsed);
    if (round < saves.length) editorSaveSync(projectFile(), saves[round]);
    round++;
    return result;
  };
}

/**
 * A replacement for writer.updateProject that runs the real one with two
 * editor saves landing in its first two rounds, so the update reads again
 * twice and merges both in; then it throws, as a check after the write
 * would.
 */
function updateThatMergesTwoSavesThenFails(first: string, second: string) {
  const original = project.writer.updateProject.bind(project.writer);
  return async (change: ProjectUpdate): Promise<string | undefined> => {
    await original(savingEachRound([first, second], change));
    throw new Error('the check failed');
  };
}

describe('deleteFile with an expected state', () => {
  beforeEach(async () => {
    await mkdir(join(project.dir, 'flowcharts'), { recursive: true });
  });

  it('refuses a file that changed since its state was taken, and deletes one that did not', async () => {
    const path = flowchartFile(project.dir, 'Graph');
    await writeFile(path, '{}');
    const seen = await statFileState(path);
    await editorSave(path, '{"changed":true}');
    await expect(project.writer.deleteFile(path, { expected: seen })).rejects.toThrow('was changed on disk after this server read it');
    expect(await readFile(path, 'utf-8')).toBe('{"changed":true}');
    await project.writer.deleteFile(path, { expected: await statFileState(path) });
    expect(await exists(path)).toBe(false);
  });

  it('takes a missing file as the state null, and refuses a file that appeared', async () => {
    const path = flowchartFile(project.dir, 'Graph');
    await expect(project.writer.deleteFile(path, { expected: null })).resolves.toBeUndefined();
    await writeFile(path, '{}');
    await expect(project.writer.deleteFile(path, { expected: null })).rejects.toThrow('was changed on disk after this server read it');
    expect(await exists(path)).toBe(true);
  });
});

describe('create_flowchart', () => {
  // The fixture has no flowcharts folder; most cases below are about the files, so it exists
  beforeEach(async () => {
    await mkdir(join(project.dir, 'flowcharts'), { recursive: true });
  });

  // getUsedAddons is the last thing the handler reads before createFlowchartFile, after every check
  it('refuses when project.c3proj was saved in the editor after the call decided on it', async () => {
    const edited = await editedProjectText();
    const original = project.reader.getUsedAddons.bind(project.reader);
    vi.spyOn(project.reader, 'getUsedAddons').mockImplementationOnce(() => {
      editorSaveSync(projectFile(), edited);
      return original();
    });
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe(staleText('project.c3proj'));
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
    expect(await readFile(projectFile(), 'utf-8')).toBe(edited);
  });

  it('checks the name against project.c3proj as saved in the editor while the SID was generated', async () => {
    // A first call makes the reader know the layout file, so a change to it makes generateSid load project.c3proj again
    expect((await call('create_flowchart', { name: 'Other' })).isError).toBe(false);
    const layoutPath = join(project.dir, 'layouts', 'Layout 1.json');
    const layout = JSON.stringify({ ...JSON.parse(await readFile(layoutPath, 'utf-8')), editorNote: 'saved in the editor' }, null, '\t');
    const json = JSON.parse(await readFile(projectFile(), 'utf-8'));
    json.flowcharts.items.push('graph');
    const edited = JSON.stringify(json, null, '\t');
    const original = project.idGen.generateSid.bind(project.idGen);
    vi.spyOn(project.idGen, 'generateSid').mockImplementationOnce(async reader => {
      await editorSave(layoutPath, layout);
      await editorSave(projectFile(), edited);
      return original(reader);
    });
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toContain('"Graph" differs only in case from the existing flowchart "graph".');
    // The handler's own check refused: the check inside the registration update never ran, and no file was written to remove
    expect(text).not.toContain('project.c3proj was saved while this call was working');
    expect(text).not.toContain('was removed again');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
    expect(await readFile(projectFile(), 'utf-8')).toBe(edited);
  });

  it('refuses a create over a file that appeared during the call', async () => {
    const original = project.reader.getUsedAddons.bind(project.reader);
    const editorFile = '{"nodes":[],"made":"in the editor"}';
    vi.spyOn(project.reader, 'getUsedAddons').mockImplementationOnce(() => {
      mkdirSync(dirname(flowchartFile(project.dir, 'Graph')), { recursive: true });
      editorSaveSync(flowchartFile(project.dir, 'Graph'), editorFile);
      return original();
    });
    const before = await readFile(projectFile(), 'utf-8');
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe(staleText('flowcharts/Graph.json'));
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(editorFile);
    expect(await readFile(projectFile(), 'utf-8')).toBe(before);
  });

  it('creates the flowchart with the plugin warning when project.c3proj has no usedAddons', async () => {
    const json = JSON.parse(await readFile(projectFile(), 'utf-8'));
    delete json.usedAddons;
    await writeFile(projectFile(), JSON.stringify(json, null, '\t'));
    await project.reader.loadProject();
    const { result, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(false);
    expect(parseResult(result).warnings?.join(' ')).toContain('The Flowchart plugin is not listed');
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('removes the new file again when its write fails after the file was written', async () => {
    const before = await snapshotFiles(project.dir);
    const original = project.writer.replaceFile.bind(project.writer);
    vi.spyOn(project.writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await original(path, content, options);
      throw new Error('the read-back failed');
    });
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the read-back failed. flowcharts/Graph.json, which this call created, was removed again. Nothing was changed.');
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('says the new file is not registered when its write failed after it landed and it cannot be removed', async () => {
    const original = project.writer.replaceFile.bind(project.writer);
    vi.spyOn(project.writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await original(path, content, options);
      throw new Error('the read-back failed');
    });
    vi.spyOn(project.writer, 'restoreForCall').mockRejectedValue(new Error('locked'));
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toBe('the read-back failed. flowcharts/Graph.json may have been written by this call and is not registered in project.c3proj; it could not be removed again, so it was left as it is. Check it before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
    expect(await registeredFlowcharts(project.dir)).toBeUndefined();
  });

  it('keeps the new file, and says why, when the registration landed and cannot be removed again', async () => {
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject')
      .mockImplementationOnce(async change => {
        await original(change);
        throw new Error('the check failed');
      })
      .mockRejectedValueOnce(new Error('locked'));
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the check failed. flowcharts/Graph.json, which this call created, was kept: project.c3proj still registers it. The registration could not be removed again: locked. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('keeps the new file when project.c3proj cannot be read to check that it does not register it', async () => {
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject')
      .mockImplementationOnce(async change => {
        await original(change);
        throw new Error('the check failed');
      })
      .mockImplementationOnce(async () => {
        await writeFile(projectFile(), 'not json');
        throw new Error('locked');
      });
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toBe('the check failed. flowcharts/Graph.json, which this call created, was kept: project.c3proj could not be read to check that it does not register it. The registration could not be removed again: locked. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
  });

  it('keeps what the editor saved when the update merged it in and the call then failed', async () => {
    // The first save lands in the first round and the second in the next one, after the writer took its backup, so the last save is in no backup
    const mergesThenFails = updateThatMergesTwoSavesThenFails(await editedProjectText(), await editedProjectText(LATER_NOTE));
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(mergesThenFails);
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the check failed. flowcharts/Graph.json, which this call created, was removed again. The registration of "Graph" was removed from project.c3proj again. Nothing was changed.');
    const after = JSON.parse(await readFile(projectFile(), 'utf-8'));
    expect(after.editorNote).toBe(LATER_NOTE);
    expect(after.flowcharts).toBeUndefined();
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
  });

  // replaceFile is the last thing the call does before the registration: the save lands after the call's checks and its assertProjectFileCurrent
  const savedMeanwhile: Array<[string, Record<string, unknown>, unknown, string]> = [
    ['the name in another case in another folder', { name: 'Graph' }, { items: [], subfolders: [{ items: ['graph'], subfolders: [], name: 'Elsewhere' }] }, '"Graph" differs only in case from the existing flowchart "graph".'],
    ['the same name in another folder', { name: 'Graph', subfolder: 'AI' }, { items: [], subfolders: [{ items: ['Graph'], subfolders: [], name: 'Elsewhere' }] }, 'Flowchart "Graph" already exists.'],
    ['a folder in another case', { name: 'Graph', subfolder: 'AI' }, { items: [], subfolders: [{ items: [], subfolders: [], name: 'ai' }] }, 'differs only in case from the existing project-bar folder path "ai"'],
    ['the name in a folder without a name', { name: 'Graph' }, { items: [], subfolders: [{ items: ['Graph'], subfolders: [] }] }, 'is registered in project.c3proj in a folder without a name'],
  ];
  for (const [title, args, container, fragment] of savedMeanwhile) {
    it(`checks the names again on the project it registers in: ${title} saved in the editor after the checks`, async () => {
      const json = JSON.parse(await readFile(projectFile(), 'utf-8'));
      json.flowcharts = container;
      const edited = JSON.stringify(json, null, '\t');
      const original = project.writer.replaceFile.bind(project.writer);
      vi.spyOn(project.writer, 'replaceFile').mockImplementationOnce(async (path, content, options) => {
        const backup = await original(path, content, options);
        await editorSave(projectFile(), edited);
        return backup;
      });
      const { text, isError } = await call('create_flowchart', args);
      expect(isError).toBe(true);
      expect(text).toContain(fragment);
      expect(text).toContain('project.c3proj was saved while this call was working, after its checks. ');
      expect(text).toContain('which this call created, was removed again.');
      expect(text).not.toContain('stopped before anything was written');
      const folders = typeof args.subfolder === 'string' ? args.subfolder.split('/') : [];
      expect(await exists(flowchartFile(project.dir, 'Graph', folders))).toBe(false);
      expect(await readFile(projectFile(), 'utf-8')).toBe(edited);
    });
  }

  it('keeps the new file when the editor saved the same name into project.c3proj meanwhile', async () => {
    const json = JSON.parse(await readFile(projectFile(), 'utf-8'));
    json.flowcharts = { items: ['Graph'], subfolders: [] };
    const edited = JSON.stringify(json, null, '\t');
    const original = project.writer.replaceFile.bind(project.writer);
    vi.spyOn(project.writer, 'replaceFile').mockImplementationOnce(async (path, content, options) => {
      const backup = await original(path, content, options);
      await editorSave(projectFile(), edited);
      return backup;
    });
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toBe('Flowchart "Graph" already exists. project.c3proj was saved while this call was working, after its checks. flowcharts/Graph.json, which this call created, was kept: project.c3proj still registers it. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
    expect(await readFile(projectFile(), 'utf-8')).toBe(edited);
  });

  it("does not remove the editor's registration of the same name when a later round of the update refuses", async () => {
    // Round 1 registers Graph and the save lands; round 2 reads the saved project, which registers Graph already
    const json = JSON.parse(await readFile(projectFile(), 'utf-8'));
    json.flowcharts = { items: ['Graph'], subfolders: [] };
    const edited = JSON.stringify(json, null, '\t');
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(change => original(savingEachRound([edited], change)));
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toContain('Flowchart "Graph" already exists.');
    expect(text).toContain('was kept: project.c3proj still registers it.');
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
  });

  it('removes the file it created again when the registration fails, and says nothing was changed', async () => {
    const before = await snapshotFiles(project.dir);
    vi.spyOn(project.writer, 'updateProject').mockRejectedValue(new Error('disk full'));
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('disk full. flowcharts/Graph.json, which this call created, was removed again. Nothing was changed.');
    expect(await snapshotFiles(project.dir)).toEqual(before);
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
  });

  it('names the folder it made when the project had no flowcharts folder at all', async () => {
    await rm(join(project.dir, 'flowcharts'), { recursive: true });
    vi.spyOn(project.writer, 'updateProject').mockRejectedValue(new Error('disk full'));
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toBe('disk full. flowcharts/Graph.json, which this call created, was removed again. The empty folder flowcharts, and any parent folder this call created, was left. Nothing else was changed.');
  });

  it('removes the file again but names the empty folder it made, and does not say nothing was changed', async () => {
    vi.spyOn(project.writer, 'updateProject').mockRejectedValue(new Error('disk full'));
    const { text } = await call('create_flowchart', { name: 'Graph', subfolder: 'AI' });
    expect(text).toBe('disk full. flowcharts/AI/Graph.json, which this call created, was removed again. The empty folder flowcharts/AI, and any parent folder this call created, was left. Nothing else was changed.');
    expect(await exists(flowchartFile(project.dir, 'Graph', ['AI']))).toBe(false);
    expect(await exists(join(project.dir, 'flowcharts', 'AI'))).toBe(true);
  });

  it('names the empty folder it made when the file write fails after the folder was made', async () => {
    vi.spyOn(project.writer, 'replaceFile').mockImplementation(async path => {
      await mkdir(dirname(path), { recursive: true });
      throw new Error('disk full');
    });
    const { text, isError } = await call('create_flowchart', { name: 'Graph', subfolder: 'AI' });
    expect(isError).toBe(true);
    expect(text).toBe('disk full. The empty folder flowcharts/AI, and any parent folder this call created, was left. Nothing else was changed.');
  });

  it('does not name a folder that was already there', async () => {
    await mkdir(join(project.dir, 'flowcharts', 'AI'), { recursive: true });
    vi.spyOn(project.writer, 'updateProject').mockRejectedValue(new Error('disk full'));
    const { text } = await call('create_flowchart', { name: 'Graph', subfolder: 'AI' });
    expect(text).toBe('disk full. flowcharts/AI/Graph.json, which this call created, was removed again. Nothing was changed.');
  });

  it('names the file it could not remove again, and does not say nothing was changed', async () => {
    vi.spyOn(project.writer, 'updateProject').mockRejectedValue(new Error('disk full'));
    vi.spyOn(project.writer, 'restoreForCall').mockRejectedValue(new Error('locked'));
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toBe('disk full. flowcharts/Graph.json, which this call created, could not be removed and is still there. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
  });

  it('removes the file and its own registration when the registration failed after it wrote the project', async () => {
    const before = await snapshotFiles(project.dir, { backups: false });
    const beforeProject = JSON.parse(await readFile(projectFile(), 'utf-8'));
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(async change => {
      await original(change);
      throw new Error('the check failed');
    });
    const { text } = await call('create_flowchart', { name: 'Graph' });
    expect(text).toBe('the check failed. flowcharts/Graph.json, which this call created, was removed again. The registration of "Graph" was removed from project.c3proj again. Nothing was changed.');
    expect(withoutProject(await snapshotFiles(project.dir, { backups: false }))).toEqual(withoutProject(before));
    expect(JSON.parse(await readFile(projectFile(), 'utf-8'))).toEqual(beforeProject);
    expect(await registeredFlowcharts(project.dir)).toBeUndefined();
  });

  it('removes the container and the Project Bar folders its registration made', async () => {
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(async change => {
      await original(change);
      throw new Error('the check failed');
    });
    const { text } = await call('create_flowchart', { name: 'Graph', subfolder: 'AI/States' });
    expect(text).toContain('The registration of "Graph" was removed from project.c3proj again.');
    expect(await registeredFlowcharts(project.dir)).toBeUndefined();
  });

  it('removes the file again when project.c3proj has a flowcharts entry it cannot register in', async () => {
    await setFlowchartContainer(project, 'text');
    const before = await snapshotFiles(project.dir);
    const { text, isError } = await call('create_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('project.c3proj has a "flowcharts" entry that is not a folder container. flowcharts/Graph.json, which this call created, was removed again. Nothing was changed.');
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });
});

describe('delete_flowchart', () => {
  async function createGraph(): Promise<void> {
    expect(parseResult((await call('create_flowchart', { name: 'Graph' })).result).success).toBe(true);
  }

  it('says nothing was changed when the registration cannot be removed', async () => {
    await createGraph();
    const before = await snapshotFiles(project.dir);
    vi.spyOn(project.writer, 'updateProject').mockRejectedValue(new Error('disk full'));
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('disk full. Nothing was changed.');
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('says nothing was changed when the registration is not there to remove, and does not register it', async () => {
    await createGraph();
    // The call looked while Graph was registered; the editor then saves a project that no longer has it, and the update reads that
    const emptied = JSON.parse(await readFile(projectFile(), 'utf-8'));
    emptied.flowcharts = { items: [], subfolders: [] };
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(async change => {
      await editorSave(projectFile(), JSON.stringify(emptied, null, '\t'));
      return original(change);
    });
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('"Graph" is not registered in flowcharts of project.c3proj. Nothing was changed.');
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: [], subfolders: [] });
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
  });

  it('puts the registration back when the file cannot be deleted', async () => {
    await createGraph();
    const before = await snapshotFiles(project.dir, { backups: false });
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      if (path.endsWith('Graph.json')) throw new Error('disk full');
      return original(path, options);
    });
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('disk full. The registration of "Graph" was put back in project.c3proj. Nothing was changed.');
    expect(withoutProject(await snapshotFiles(project.dir, { backups: false }))).toEqual(withoutProject(before));
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('puts the registration back on top of the editor save when removing it failed after it wrote', async () => {
    await createGraph();
    const mergesThenFails = updateThatMergesTwoSavesThenFails(await editedProjectText(), await editedProjectText(LATER_NOTE));
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(mergesThenFails);
    // The update wrote and then failed: the registration is gone, so it is put back on top of the saved project
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the check failed. The registration of "Graph" was put back in project.c3proj. Nothing was changed.');
    const after = JSON.parse(await readFile(projectFile(), 'utf-8'));
    expect(after.editorNote).toBe(LATER_NOTE);
    expect(after.flowcharts).toEqual({ items: ['Graph'], subfolders: [] });
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
  });

  it('keeps what the editor saved when the file cannot be deleted after the update merged a save in', async () => {
    await createGraph();
    const first = await editedProjectText();
    const second = await editedProjectText(LATER_NOTE);
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(change => original(savingEachRound([first, second], change)));
    vi.spyOn(project.writer, 'deleteFile').mockRejectedValue(new Error('disk full'));
    const { text } = await call('delete_flowchart', { name: 'Graph' });
    expect(text).toBe('disk full. The registration of "Graph" was put back in project.c3proj. Nothing was changed.');
    const after = JSON.parse(await readFile(projectFile(), 'utf-8'));
    expect(after.editorNote).toBe(LATER_NOTE);
    expect(after.flowcharts).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('refuses, restores the registration and keeps the file when the editor saved it during the call', async () => {
    await createGraph();
    const editorFile = JSON.stringify({ sid: 1, nodes: [], name: 'Graph', w: 1, h: 1, saved: 'in the editor' }, null, '\t');
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(async change => {
      const backup = await original(change);
      await editorSave(flowchartFile(project.dir, 'Graph'), editorFile);
      return backup;
    });
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe(`${staleText('flowcharts/Graph.json').replace(/\.$/, '')}. The registration of "Graph" was put back in project.c3proj. Nothing was changed.`);
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(editorFile);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('refuses and keeps a file that appeared during the call where there was none', async () => {
    await createGraph();
    await rm(flowchartFile(project.dir, 'Graph'));
    const editorFile = JSON.stringify({ sid: 1, nodes: [], name: 'Graph', w: 1, h: 1, saved: 'in the editor' }, null, '\t');
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(async change => {
      const backup = await original(change);
      await editorSave(flowchartFile(project.dir, 'Graph'), editorFile);
      return backup;
    });
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe(`${staleText('flowcharts/Graph.json').replace(/\.$/, '')}. The registration of "Graph" was put back in project.c3proj. Nothing was changed.`);
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(editorFile);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('refuses when project.c3proj was saved in the editor after the call decided on it', async () => {
    await createGraph();
    const edited = await editedProjectText();
    const original = project.writer.assertProjectFileCurrent.bind(project.writer);
    vi.spyOn(project.writer, 'assertProjectFileCurrent').mockImplementation(async () => {
      await editorSave(projectFile(), edited);
      return original();
    });
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe(staleText('project.c3proj'));
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
    expect(await readFile(projectFile(), 'utf-8')).toBe(edited);
  });

  it('restores the file from its backup, then the registration, when the delete fails after it removed the file', async () => {
    await createGraph();
    const bytes = await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8');
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      const backup = await original(path, options);
      if (path.endsWith('Graph.json')) throw new Error('the check failed');
      return backup;
    });
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the check failed. flowcharts/Graph.json was restored from its backup. The registration of "Graph" was put back in project.c3proj. Nothing was changed.');
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(bytes);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('leaves the registration removed, and names the backup, when the deleted file cannot be restored', async () => {
    await createGraph();
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      const backup = await original(path, options);
      if (path.endsWith('Graph.json')) throw new Error('the check failed');
      return backup;
    });
    vi.spyOn(project.writer, 'restoreForCall').mockRejectedValue(new Error('locked'));
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the check failed. flowcharts/Graph.json is gone and could not be restored (locked). Its state from before the call is in flowcharts/Graph.json.bak. The registration was left removed, so project.c3proj names no flowchart without a file. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: [], subfolders: [] });
  });

  it('does not restore a deleted file from a backup that is not the state from before the call', async () => {
    await createGraph();
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      const backup = await original(path, options);
      if (path.endsWith('Graph.json')) {
        await writeFile(backup as string, 'something else');
        throw new Error('the check failed');
      }
      return backup;
    });
    const { text } = await call('delete_flowchart', { name: 'Graph' });
    expect(text).toBe('the check failed. flowcharts/Graph.json is gone and could not be restored (its backup was replaced after it was made). Its state from before the call is in flowcharts/Graph.json.bak. The registration was left removed, so project.c3proj names no flowchart without a file. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
  });

  it('says a deleted file could not be restored when the call holds no backup of it', async () => {
    await createGraph();
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async path => {
      await rm(path);
      throw new Error('the check failed');
    });
    const { text } = await call('delete_flowchart', { name: 'Graph' });
    expect(text).toBe('the check failed. flowcharts/Graph.json is gone and could not be restored (this call has no backup of it). The registration was left removed, so project.c3proj names no flowchart without a file. Check the project (validate_project, git diff) before you run the tool again.');
  });

  it('puts the registration back, with nothing to restore, when the file was missing and the delete failed', async () => {
    await setFlowchartContainer(project, { items: ['Ghost'], subfolders: [] });
    vi.spyOn(project.writer, 'deleteFile').mockRejectedValue(new Error('disk full'));
    const { text } = await call('delete_flowchart', { name: 'Ghost' });
    expect(text).toBe('disk full. The registration of "Ghost" was put back in project.c3proj. Nothing was changed.');
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Ghost'], subfolders: [] });
  });

  it('keeps a file the editor saved at its path right after the delete, and puts the registration back', async () => {
    await createGraph();
    const editorFile = '{"nodes":[],"saved":"in the editor"}';
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      const backup = await original(path, options);
      if (path.endsWith('Graph.json')) {
        await editorSave(path, editorFile);
        throw new Error('the check failed');
      }
      return backup;
    });
    const { text } = await call('delete_flowchart', { name: 'Graph' });
    // The file is there again, so it is not gone: the registration is put back for the file the editor saved
    expect(text).toBe('the check failed. The registration of "Graph" was put back in project.c3proj. Nothing was changed.');
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(editorFile);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: ['Graph'], subfolders: [] });
  });

  it('refuses a registration whose folder leaves the flowcharts folder, and deletes nothing outside it', async () => {
    await setFlowchartContainer(project, {
      items: [],
      subfolders: [{ items: [], subfolders: [{ items: ['Sprite'], subfolders: [], name: 'objectTypes' }], name: '..' }],
    });
    const before = await snapshotFiles(project.dir);
    const { text, isError } = await call('delete_flowchart', { name: 'Sprite' });
    expect(isError).toBe(true);
    expect(text).toBe('The change was stopped before anything was written: Path traversal detected: path escapes project directory. Nothing was changed.');
    expect(await exists(join(project.dir, 'objectTypes', 'Sprite.json'))).toBe(true);
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('deletes the flowchart and says so when its editor-state file cannot be deleted', async () => {
    await createGraph();
    await writeFile(flowchartFile(project.dir, 'Graph').replace(/\.json$/, '.uistate.json'), '{}');
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      if (path.endsWith('.uistate.json')) throw new Error(`EBUSY: resource busy or locked, unlink '${path}'`);
      return original(path, options);
    });
    const { result } = await call('delete_flowchart', { name: 'Graph' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toEqual(['The editor-state file flowcharts/Graph.uistate.json could not be deleted: EBUSY: resource busy or locked. It was left in place.']);
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
    expect(await exists(flowchartFile(project.dir, 'Graph').replace(/\.json$/, '.uistate.json'))).toBe(true);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: [], subfolders: [] });
  });

  for (const [title, existedBefore] of [['an editor-state file the editor saved during the call', true], ['an editor-state file that appeared where there was none', false]] as const) {
    it(`keeps ${title}`, async () => {
      await createGraph();
      const statePath = flowchartFile(project.dir, 'Graph').replace(/\.json$/, '.uistate.json');
      if (existedBefore) await writeFile(statePath, '{}');
      const original = project.writer.updateProject.bind(project.writer);
      vi.spyOn(project.writer, 'updateProject').mockImplementationOnce(async change => {
        const backup = await original(change);
        await editorSave(statePath, '{"saved":"in the editor"}');
        return backup;
      });
      const data = parseResult((await call('delete_flowchart', { name: 'Graph' })).result);
      expect(data.success).toBe(true);
      expect(data.warnings).toEqual(['The editor-state file flowcharts/Graph.uistate.json changed on disk during the call, so it was left in place.']);
      expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(false);
      expect(await readFile(statePath, 'utf-8')).toBe('{"saved":"in the editor"}');
    });
  }

  it('does not delete the editor-state file of a flowchart whose own file could not be deleted', async () => {
    await createGraph();
    const statePath = flowchartFile(project.dir, 'Graph').replace(/\.json$/, '.uistate.json');
    await writeFile(statePath, '{}');
    const original = project.writer.deleteFile.bind(project.writer);
    vi.spyOn(project.writer, 'deleteFile').mockImplementation(async (path, options) => {
      if (path.endsWith('Graph.json')) throw new Error('disk full');
      return original(path, options);
    });
    await call('delete_flowchart', { name: 'Graph' });
    expect(await readFile(statePath, 'utf-8')).toBe('{}');
  });

  it('removes only the registration of a flowchart whose file is missing', async () => {
    await setFlowchartContainer(project, { items: ['Ghost'], subfolders: [] });
    const { result } = await call('delete_flowchart', { name: 'Ghost' });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.backupFile).toBeUndefined();
    expect(data.warnings).toEqual(['flowcharts/Ghost.json was not found; only the registration was removed.']);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: [], subfolders: [] });
  });

  it('refuses a name in another letter case, an unknown name and a name in a folder without a name', async () => {
    await createGraph();
    await setFlowchartContainer(project, { items: ['Graph'], subfolders: [{ items: ['Hidden'], subfolders: [] }] });
    const before = await snapshotFiles(project.dir);
    const variant = await call('delete_flowchart', { name: 'graph' });
    expect(variant.text).toBe('Flowchart "graph" not found: names are matched with their letter case. Did you mean "Graph"? Nothing was changed.');
    const unknown = await call('delete_flowchart', { name: 'Ghost' });
    expect(unknown.text).toBe('Flowchart "Ghost" not found. Use list_flowcharts to see all available names. Nothing was changed.');
    const hidden = await call('delete_flowchart', { name: 'Hidden' });
    expect(hidden.text).toContain('in a folder without a name, so its file cannot be resolved.');
    expect(hidden.text.endsWith(' Nothing was changed.')).toBe(true);
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('says the file is there without a registration when the file cannot be deleted and the put-back fails too', async () => {
    await createGraph();
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject')
      .mockImplementationOnce(change => original(change))
      .mockRejectedValueOnce(new Error('locked'));
    vi.spyOn(project.writer, 'deleteFile').mockRejectedValue(new Error('disk full'));
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('disk full. The registration of "Graph" could not be put back in project.c3proj (locked), so flowcharts/Graph.json is there without a registration. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
    expect(await registeredFlowcharts(project.dir)).toEqual({ items: [], subfolders: [] });
  });

  it('says the registration could not be put back when removing it wrote and failed, and the put-back fails', async () => {
    await createGraph();
    const original = project.writer.updateProject.bind(project.writer);
    vi.spyOn(project.writer, 'updateProject')
      .mockImplementationOnce(async change => {
        await original(change);
        throw new Error('the check failed');
      })
      .mockRejectedValueOnce(new Error('locked'));
    const { text, isError } = await call('delete_flowchart', { name: 'Graph' });
    expect(isError).toBe(true);
    expect(text).toBe('the check failed. project.c3proj no longer registers "Graph" and the registration could not be put back (locked); flowcharts/Graph.json was not deleted. Check the project (validate_project, git diff) before you run the tool again.');
    expect(await exists(flowchartFile(project.dir, 'Graph'))).toBe(true);
  });
});

describe('create_flowchart refusals', () => {
  it('refuses an unsafe name, an unsafe folder, a duplicate, a case variant, a folder in another case and an unregistered file, changing nothing', async () => {
    expect((await call('create_flowchart', { name: 'Graph', subfolder: 'AI' })).isError).toBe(false);
    await mkdir(join(project.dir, 'flowcharts'), { recursive: true });
    await writeFile(flowchartFile(project.dir, 'Loose'), '{}');
    const before = await snapshotFiles(project.dir);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: '../escape' }, 'Name must start with a letter or underscore'],
      [{ name: 'Other', subfolder: '../evil' }, 'Subfolder path contains invalid characters'],
      [{ name: 'Graph', subfolder: 'Elsewhere' }, 'Flowchart "Graph" already exists.'],
      [{ name: 'graph', subfolder: 'Elsewhere' }, '"graph" differs only in case from the existing flowchart "Graph".'],
      [{ name: 'Other', subfolder: 'ai' }, 'differs only in case from the existing project-bar folder path "AI"'],
      [{ name: 'Loose' }, 'The file flowcharts/Loose.json already exists'],
      [{ name: 'loose' }, 'The file flowcharts/Loose.json already exists'],
    ];
    for (const [args, fragment] of cases) {
      const { text, isError } = await call('create_flowchart', args);
      expect(isError, JSON.stringify(args)).toBe(true);
      expect(text, JSON.stringify(args)).toContain(fragment);
      expect(text, JSON.stringify(args)).not.toContain('stopped before anything was written');
      expect(text.endsWith(' Nothing was changed.')).toBe(true);
      expect(text).not.toContain(project.dir);
    }
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('refuses a name registered in a folder without a name, and its case variant, changing nothing', async () => {
    await setFlowchartContainer(project, { items: [], subfolders: [{ items: ['Hidden'], subfolders: [] }] });
    const before = await snapshotFiles(project.dir);
    const same = await call('create_flowchart', { name: 'Hidden' });
    expect(same.isError).toBe(true);
    expect(same.text).toBe('Flowchart "Hidden" is registered in project.c3proj in a folder without a name, so its file cannot be resolved; creating it again would register the name twice. Choose another name, or fix the folder in project.c3proj first. Nothing was changed.');
    const variant = await call('create_flowchart', { name: 'hidden' });
    expect(variant.isError).toBe(true);
    expect(variant.text).toContain('"hidden" differs only in case from the existing flowchart "Hidden".');
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });
});

describe('add_flowchart_node and update_flowchart_node', () => {
  async function createGraph(): Promise<void> {
    expect(parseResult((await call('create_flowchart', { name: 'Graph' })).result).success).toBe(true);
  }

  it('refuses to overwrite a flowchart the editor saved during the call, and keeps the editor file', async () => {
    await createGraph();
    const editorFile = JSON.stringify({ sid: 1, nodes: [], name: 'Graph', w: 1, h: 1, saved: 'in the editor' }, null, '\t');
    const original = project.writer.replaceFile.bind(project.writer);
    vi.spyOn(project.writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await editorSave(path, editorFile);
      return original(path, content, options);
    });
    const { text, isError } = await call('add_flowchart_node', { flowchartName: 'Graph', caption: 'A', x: 0, y: 0, isStart: true });
    expect(isError).toBe(true);
    expect(text).toBe(staleText('flowcharts/Graph.json'));
    expect(await readFile(flowchartFile(project.dir, 'Graph'), 'utf-8')).toBe(editorFile);
  });

  it('says what is on disk when the write fails after it replaced the file', async () => {
    await createGraph();
    const original = project.writer.replaceFile.bind(project.writer);
    vi.spyOn(project.writer, 'replaceFile').mockImplementation(async (path, content, options) => {
      await original(path, content, options);
      throw new Error('the read-back failed');
    });
    const { text, isError } = await call('add_flowchart_node', { flowchartName: 'Graph', caption: 'A', x: 0, y: 0 });
    expect(isError).toBe(true);
    expect(text).toBe('the read-back failed. flowcharts/Graph.json may have been changed by this call. Its state from before the call is in flowcharts/Graph.json.bak. Check it before you run the tool again.');
  });

  it('says nothing was changed when the write fails before it touched the file, without a path in the text', async () => {
    await createGraph();
    const before = await snapshotFiles(project.dir);
    vi.spyOn(project.writer, 'replaceFile').mockRejectedValue(new Error(`EACCES: permission denied, open '${flowchartFile(project.dir, 'Graph')}'`));
    const { text } = await call('add_flowchart_node', { flowchartName: 'Graph', caption: 'A', x: 0, y: 0 });
    expect(text).toBe('EACCES: permission denied. Nothing was changed.');
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('stops before anything is written when no SID can be generated', async () => {
    await createGraph();
    const before = await snapshotFiles(project.dir);
    vi.spyOn(project.idGen, 'generateSid').mockRejectedValue(new Error('Cannot generate a safe SID'));
    const { text, isError } = await call('add_flowchart_node', { flowchartName: 'Graph', caption: 'A', x: 0, y: 0, outputs: [{ name: 'Next' }] });
    expect(isError).toBe(true);
    expect(text).toBe('The change was stopped before anything was written: Cannot generate a safe SID. Nothing was changed.');
    expect(await snapshotFiles(project.dir)).toEqual(before);
  });

  it('keeps the line endings and the byte order mark of the file it changes', async () => {
    await createGraph();
    const path = flowchartFile(project.dir, 'Graph');
    const text = await readFile(path, 'utf-8');
    await writeFile(path, String.fromCharCode(0xfeff) + text.replace(/\n/g, '\r\n') + '\r\n');
    await project.reader.loadProject();
    expect((await call('add_flowchart_node', { flowchartName: 'Graph', caption: 'A', x: 0, y: 0, isStart: true })).isError).toBe(false);
    const raw = await readFile(path, 'utf-8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    expect(raw.endsWith('\r\n')).toBe(true);
    expect(JSON.parse(raw.slice(1)).nodes).toHaveLength(1);
  });

  const THROWING_CALLS: Array<[string, Record<string, unknown>]> = [
    ['update_flowchart_node', { flowchartName: 'Graph', nodeSid: 1, caption: 'A2' }],
    ['delete_flowchart_node', { flowchartName: 'Graph', nodeSid: 1 }],
  ];
  for (const [tool, args] of THROWING_CALLS) {
    it(`${tool} stops before anything is written when reading the file's state throws`, async () => {
      await createGraph();
      const before = await snapshotFiles(project.dir);
      vi.spyOn(project.reader, 'stateAsRead').mockImplementation(() => { throw new Error('boom'); });
      const { text, isError } = await call(tool, args);
      expect(isError).toBe(true);
      expect(text).toBe('The change was stopped before anything was written: boom. Nothing was changed.');
      expect(await snapshotFiles(project.dir)).toEqual(before);
    });
  }

  // Every tool that edits a flowchart, one row each: one write of the flowchart file and nothing else written
  interface Seeded { a: number; aOut1: number; aOut2: number; b: number; c: number }
  const EDITING_CALLS: Array<[string, (ids: Seeded) => Record<string, unknown>]> = [
    ['add_flowchart_node', () => ({ flowchartName: 'Graph', caption: 'N', x: 0, y: 0 })],
    ['update_flowchart_node', ids => ({ flowchartName: 'Graph', nodeSid: ids.a, caption: 'A2' })],
    ['delete_flowchart_node', ids => ({ flowchartName: 'Graph', nodeSid: ids.c })],
  ];

  /** Graph with a start node A (outputs Next and Other) and two more nodes, B and C, made through the tools. */
  async function seedGraph(): Promise<Seeded> {
    await createGraph();
    const add = async (args: Record<string, unknown>) =>
      parseResult((await call('add_flowchart_node', { flowchartName: 'Graph', x: 0, y: 0, ...args })).result);
    const a = await add({ caption: 'A', isStart: true, outputs: [{ name: 'Next' }, { name: 'Other' }] });
    const b = await add({ caption: 'B' });
    const c = await add({ caption: 'C' });
    return {
      a: a.generatedSid, aOut1: a.outputSids[0], aOut2: a.outputSids[1],
      b: b.generatedSid, c: c.generatedSid,
    };
  }

  for (const [tool, args] of EDITING_CALLS) {
    it(`${tool} writes the flowchart once and writes nothing else`, async () => {
      const ids = await seedGraph();
      const statePath = flowchartFile(project.dir, 'Graph').replace(/\.json$/, '.uistate.json');
      await writeFile(statePath, '{"nodes":[]}');
      const replaceFile = vi.spyOn(project.writer, 'replaceFile');
      const deleteFile = vi.spyOn(project.writer, 'deleteFile');
      const updateProject = vi.spyOn(project.writer, 'updateProject');
      const done = await call(tool, args(ids));
      expect(done.isError, done.text).toBe(false);
      expect(replaceFile).toHaveBeenCalledTimes(1);
      expect(String(replaceFile.mock.calls[0][0]).endsWith('Graph.json')).toBe(true);
      expect(deleteFile).not.toHaveBeenCalled();
      expect(updateProject).not.toHaveBeenCalled();
      expect(await readFile(statePath, 'utf-8')).toBe('{"nodes":[]}');
      expect(await exists(`${statePath}.bak`)).toBe(false);
    });
  }

  for (const [what, content] of [['a list', '[]'], ['an object without nodes', '{"sid":1}']]) {
    it(`refuses a flowchart file that is ${what}, naming it project-relative`, async () => {
      await createGraph();
      await writeFile(flowchartFile(project.dir, 'Graph'), content);
      const before = await snapshotFiles(project.dir);
      const { text, isError } = await call('add_flowchart_node', { flowchartName: 'Graph', caption: 'A', x: 0, y: 0 });
      expect(isError).toBe(true);
      expect(text).toBe('Flowchart "Graph" is registered in the project but flowcharts/Graph.json does not hold a flowchart: it has no list of nodes. Nothing was changed.');
      expect(await snapshotFiles(project.dir)).toEqual(before);
    });
  }
});
