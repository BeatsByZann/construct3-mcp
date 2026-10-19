/**
 * readRegisteredTimelines and timelineFileText: the registered timelines
 * read with their file states, the ones that cannot be read named, and the
 * text a timeline is written with. On a temp copy of the minimal fixture; the
 * timeline names and folders are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInToolCall, statFileState } from '../../src/construct3/disk-state.js';
import { listSome } from '../../src/construct3/analyzers/unscanned-uses.js';
import { readRegisteredTimelines, timelineFileText, type Timeline } from '../../src/tools/timeline-tools.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

let dir: string;
let container: unknown;
const at = (...segments: string[]) => join(dir, ...segments);

/** A timeline with nested values, so its text has several lines. */
const timeline = { name: 'Intro', enabled: true, tracks: [{ name: 'Track', keyframes: [] }] } as unknown as Timeline;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c3-registered-timelines-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  container = {
    items: ['Intro', 'Broken', 'Array', 'Missing'],
    subfolders: [
      { name: 'Cutscenes', items: ['Outro'], subfolders: [] },
      // The first folder without a name is the editor's Transitions folder
      { items: ['Ease'], subfolders: [] },
      // A second one is a folder the timeline tools cannot resolve
      { items: ['Lost'], subfolders: [] },
    ],
  };
  const project = JSON.parse(await readFile(at('project.c3proj'), 'utf-8')) as Record<string, unknown>;
  project.timelines = container;
  await writeFile(at('project.c3proj'), JSON.stringify(project, null, '\t'));
  await mkdir(at('timelines', 'Cutscenes'), { recursive: true });
  await writeFile(at('timelines', 'Intro.json'), JSON.stringify(timeline, null, '\t').replace(/\n/g, '\r\n'));
  await writeFile(at('timelines', 'Cutscenes', 'Outro.json'), JSON.stringify({ ...timeline, name: 'Outro' }, null, '\t'));
  await writeFile(at('timelines', 'Broken.json'), '{ not json');
  await writeFile(at('timelines', 'Array.json'), '[]');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readRegisteredTimelines', () => {
  it('reads each registered timeline with its file, its state and its bytes, and names the ones it cannot read', async () => {
    const { timelines, unreadable } = await runInToolCall(() => readRegisteredTimelines(dir, container));
    expect(timelines.map(t => [t.name, t.file])).toEqual([
      ['Intro', 'timelines/Intro.json'],
      ['Outro', 'timelines/Cutscenes/Outro.json'],
    ]);
    for (const t of timelines) {
      expect(t.read.state).toEqual(await statFileState(at(...t.file.split('/'))));
      expect(t.read.bytes).toEqual(await readFile(at(...t.file.split('/'))));
      expect(t.data.name).toBe(t.name);
    }
    // The transition (Ease) and the timeline without a file (Missing) are in neither list
    expect(unreadable).toEqual([
      'timelines/Lost (in a folder the timeline tools cannot resolve)',
      'timelines/Broken.json',
      'timelines/Array.json',
    ]);
  });

  it('counts a timeline in a folder the tools cannot resolve as unreadable', async () => {
    const { timelines, unreadable } = await runInToolCall(() => readRegisteredTimelines(dir, { items: [], subfolders: [{ items: ['Ease'], subfolders: [] }, { items: ['Also'], subfolders: [] }] }));
    expect(timelines).toEqual([]);
    expect(unreadable).toEqual(['timelines/Also (in a folder the timeline tools cannot resolve)']);
  });
});

describe('timelineFileText', () => {
  it('keeps the line endings of an existing file, and follows the project for a new one', async () => {
    const projectPath = at('project.c3proj');
    const existing = await timelineFileText(at('timelines', 'Intro.json'), timeline, projectPath);
    expect(existing).toBe(JSON.stringify(timeline, null, '\t').replace(/\n/g, '\r\n'));
    const created = await timelineFileText(at('timelines', 'New.json'), timeline, projectPath);
    expect(created).toBe(JSON.stringify(timeline, null, '\t'));
  });
});

describe('listSome', () => {
  it('lists the first five names and counts the rest', () => {
    expect(listSome(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and 2 more');
    expect(listSome(['a', 'b'])).toBe('a, b');
  });
});
