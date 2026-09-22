/**
 * The project this server serves: a folder project, or a .c3p archive served
 * through a working folder. `open` switches to another project while the
 * server runs; the reader, writer and ID generator every tool holds are the
 * same objects before and after, pointed at the new project.
 */

import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resetProjectIndex } from './analyzers/index-builder.js';
import { C3pProject, ToolGate, isC3pPath } from './c3p-project.js';
import type { C3pSyncResult } from './c3p-project.js';
import type { IdGenerator } from './id-generator.js';
import { Construct3ProjectReader } from './project-reader.js';

/** The .c3proj a folder path, a .c3proj path or a .c3p working folder names. */
export async function findProjectFile(path: string): Promise<string> {
  let projectFile = path;
  if (!path.endsWith('.c3proj')) {
    const found = await Construct3ProjectReader.findProjectFile(path);
    if (!found) throw new Error(`No .c3proj file found in directory "${path}"`);
    projectFile = found;
  }
  if (!(await Construct3ProjectReader.isValidProject(projectFile))) {
    throw new Error(`Invalid Construct3 project file "${projectFile}"`);
  }
  return projectFile;
}

/** What `open` reports about the project it left. */
export interface ClosedProject {
  name: string;
  projectFile: string;
  archivePath?: string;
  /** The last write of the archive before leaving it */
  lastWrite?: C3pSyncResult;
  /** The working folder, when it was kept because it holds changes the archive does not */
  keptWorkDir?: string;
}

export interface OpenedProject {
  name: string;
  projectFile: string;
  archivePath?: string;
  workDir?: string;
}

export class ProjectSession {
  readonly gate: ToolGate;
  private current: C3pProject | undefined;

  private constructor(
    readonly reader: Construct3ProjectReader,
    archive: C3pProject | undefined,
    /** Where .c3p working folders are made; the system temp folder unless given */
    private readonly workRoot: string | undefined,
  ) {
    this.current = archive;
    this.gate = new ToolGate(() => this.current);
  }

  /** Open the project the server starts with. */
  static async start(path: string, options: { workRoot?: string } = {}): Promise<ProjectSession> {
    const { projectFile, archive } = await ProjectSession.prepare(path, options.workRoot);
    const reader = new Construct3ProjectReader(projectFile);
    try {
      await reader.loadProject();
    } catch (error) {
      archive?.closeSync();
      throw error;
    }
    return new ProjectSession(reader, archive, options.workRoot);
  }

  /** The archive being served, when the project came from a .c3p. */
  get archive(): C3pProject | undefined {
    return this.current;
  }

  /** Make every tool registered on `server` from now on go through the gate. */
  install(server: McpServer): void {
    this.gate.install(server);
  }

  /**
   * Switch to another project. Call from inside a tool call: the switch waits
   * until no other call is running and holds new calls until it is done. If
   * the new project cannot be opened, the current one stays served.
   */
  async open(path: string, idGen: IdGenerator): Promise<{ opened: OpenedProject; closed: ClosedProject }> {
    return this.gate.exclusive(async () => {
      const { projectFile, archive } = await ProjectSession.prepare(path, this.workRoot);
      const previous = this.current;
      const closed: ClosedProject = {
        name: this.reader.getMetadata().name,
        projectFile: this.reader.getProjectPath(),
        ...(previous ? { archivePath: previous.archivePath } : {}),
      };
      try {
        // Write the archive being left before the reader lets go of it.
        if (previous) closed.lastWrite = await previous.sync();
        await this.reader.switchProject(projectFile);
      } catch (error) {
        archive?.closeSync();
        throw error;
      }
      this.current = archive;
      resetProjectIndex();
      idGen.reset();
      const kept = previous?.closeSync();
      if (kept) closed.keptWorkDir = kept;
      return {
        opened: {
          name: this.reader.getMetadata().name,
          projectFile,
          ...(archive ? { archivePath: archive.archivePath, workDir: archive.workDir } : {}),
        },
        closed,
      };
    });
  }

  /** Remove the working folder of the archive being served, unless it holds unsaved changes. */
  closeSync(): string | undefined {
    return this.current?.closeSync();
  }

  private static async prepare(path: string, workRoot?: string): Promise<{ projectFile: string; archive?: C3pProject }> {
    if (!isC3pPath(path)) return { projectFile: await findProjectFile(resolve(path)) };
    const archive = await C3pProject.open(path, workRoot);
    try {
      return { projectFile: await findProjectFile(archive.projectFile), archive };
    } catch (error) {
      archive.closeSync();
      throw error;
    }
  }
}
