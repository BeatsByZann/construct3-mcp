/**
 * A throwaway copy of test/fixtures/minimal-project on the real reader,
 * writer and ID generator, and helpers to look at it. All data is synthetic.
 */

import { mkdtemp, mkdir, cp, rm, readFile, writeFile, stat, utimes, readdir } from 'fs/promises';
import { statSync, utimesSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { dirname, join, relative, sep } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { MockServer } from '../mocks/mock-server.js';
import type { Flowchart } from '../../src/construct3/flowchart-model.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');

/** A Flowchart plugin entry of usedAddons, as the editor writes it. */
export const FLOWCHART_PLUGIN = { type: 'plugin', id: 'Flowchart', name: 'Flowchart controller', author: 'Scirra', bundled: false };

export interface FlowchartProject {
  dir: string;
  reader: Construct3ProjectReader;
  writer: Construct3ProjectWriter;
  idGen: IdGenerator;
  server: MockServer;
}

/**
 * A temp copy of the fixture project, loaded. With `plugin` (the default) the
 * Flowchart plugin is in usedAddons. No tool is registered yet.
 */
export async function makeProject(options: { plugin?: boolean } = {}): Promise<FlowchartProject> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-flowchart-'));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  if (options.plugin !== false) {
    const projectPath = join(dir, 'project.c3proj');
    const project = JSON.parse(await readFile(projectPath, 'utf-8'));
    project.usedAddons.push(FLOWCHART_PLUGIN);
    await writeFile(projectPath, JSON.stringify(project, null, '\t'), 'utf-8');
  }
  const reader = new Construct3ProjectReader(join(dir, 'project.c3proj'));
  await reader.loadProject();
  const idGen = new IdGenerator();
  const writer = new Construct3ProjectWriter(reader, idGen);
  return { dir, reader, writer, idGen, server: new MockServer() };
}

/** Remove a project made by makeProject. */
export async function removeFlowchartProject(project: FlowchartProject): Promise<void> {
  await rm(project.dir, { recursive: true, force: true, maxRetries: 3 });
}

export type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** The fields of a tool result the tests look at. */
export interface ToolData {
  success?: boolean;
  entity?: string;
  category?: string;
  action?: string;
  generatedSid: number;
  outputSids: number[];
  warnings?: string[];
  backupFile?: string;
  formerTargetNodeSid?: number | null;
  editorNote?: string;
  flowcharts?: string[];
  count?: number;
  sid?: number;
}

/** The JSON of a tool result. */
export function parseResult(result: ToolResponse): ToolData {
  return JSON.parse(result.content[0].text) as ToolData;
}

/** The path of a flowchart file in the project. */
export function flowchartFile(dir: string, name: string, folders: string[] = []): string {
  return join(dir, 'flowcharts', ...folders, `${name}.json`);
}

/** A flowchart file read straight off the disk. */
export async function readFlowchartFile(dir: string, name: string, folders: string[] = []): Promise<Flowchart> {
  return JSON.parse(await readFile(flowchartFile(dir, name, folders), 'utf-8')) as Flowchart;
}

/** The `flowcharts` entry of project.c3proj as it is on the disk. */
export async function registeredFlowcharts(dir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'project.c3proj'), 'utf-8')).flowcharts;
}

/**
 * Write a flowchart file and add its name to project.c3proj by hand (not
 * through a tool), then load the project again.
 */
export async function registerByHand(project: FlowchartProject, name: string, text: string, folders: string[] = []): Promise<void> {
  const file = flowchartFile(project.dir, name, folders);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  const projectPath = join(project.dir, 'project.c3proj');
  const json = JSON.parse(await readFile(projectPath, 'utf-8'));
  json.flowcharts ??= { items: [], subfolders: [] };
  let folder = json.flowcharts;
  for (const part of folders) {
    let next = folder.subfolders.find((sf: { name?: string }) => sf.name === part);
    if (!next) { next = { items: [], subfolders: [], name: part }; folder.subfolders.push(next); }
    folder = next;
  }
  folder.items.push(name);
  await writeFile(projectPath, JSON.stringify(json, null, '\t'));
  await project.reader.loadProject();
}

/**
 * A SHA-256 of every file below `dir`, by project-relative path. With
 * `backups: false` the `.bak` copies are left out (an undone write leaves
 * them behind).
 */
export async function snapshotFiles(dir: string, options: { backups?: boolean } = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (options.backups !== false || !entry.name.endsWith('.bak')) {
        out[relative(dir, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  };
  await walk(dir);
  return out;
}

/** An editor save: other bytes, another length, and an mtime the writer's stamp check cannot miss within one Windows timestamp tick. */
export async function editorSave(path: string, text: string): Promise<void> {
  await writeFile(path, text);
  const { mtime } = await stat(path);
  const later = new Date(mtime.getTime() + 2000);
  await utimes(path, later, later);
}

/** editorSave for a spy on a method that is not async (the save lands before the method returns). */
export function editorSaveSync(path: string, text: string): void {
  writeFileSync(path, text);
  const { mtime } = statSync(path);
  const later = new Date(mtime.getTime() + 2000);
  utimesSync(path, later, later);
}

/**
 * The writer's whole refusal of a write to a file that changed on disk after
 * the call read it, when the call had changed nothing before. Tests compare
 * with all of it, so a refusal reworded on its way out is seen.
 */
export function staleText(label: string): string {
  return `${label} was changed on disk after this server read it (saved in the Construct 3 editor, restored with git, ` +
    'or written by another program or a tool call running in parallel). It was not written, so that change is kept. ' +
    'Run the tool again: it reads the file as it is now.';
}
