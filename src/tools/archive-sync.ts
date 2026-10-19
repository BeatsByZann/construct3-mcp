/**
 * The calls of a server that serves a single-file .c3p archive
 * (c3p-archive.ts). A call that starts while no call runs first lets the
 * archive refresh the working folder when the archive changed on disk;
 * when the archive changed and cannot be read again, the call is refused
 * without running. When the last running call finishes and a tool call has
 * run since the last write-back, whatever kind of call finishes last, the
 * archive is written back; new calls wait until that write is done, so an
 * archive never holds a call halfway through its changes. A tool result
 * gets one note about the call's own archive work: the write-back or
 * refresh it ran, else the conflict while one stands; a write-back failure
 * no tool result carried yet (it ended after a resource read or prompt) is
 * added to the next tool result. close() waits for the running calls,
 * refuses new ones, and closes the archive once.
 *
 * One archive gets one gate: the server is wrapped once (index.ts does),
 * and every registration goes through that view. Two views of the same
 * archive would have two gates that do not know of each other, so a
 * refresh could overlap a write-back; wrapping the same view again is safe
 * (it returns the same gate), wrapping the server twice is a caller error.
 *
 * Wraps the same registration methods as withProjectSync (project-sync.ts)
 * and is applied outside it, so the refresh comes before the project file
 * check of the call.
 */

import type { ArchiveRefreshResult, ArchiveSyncResult, C3pArchive } from '../construct3/c3p-archive.js';
import { describeArchiveRefresh, describeArchiveSync } from '../construct3/c3p-archive.js';

type Archive = Pick<C3pArchive, 'refresh' | 'sync' | 'close' | 'status' | 'archivePath' | 'workDir'>;
type CloseResult = Awaited<ReturnType<C3pArchive['close']>>;

const TOOL_METHODS = new Set(['tool', 'registerTool']);
const OTHER_METHODS = new Set(['resource', 'registerResource', 'prompt', 'registerPrompt']);
const WRAPPED = Symbol('construct3-mcp.archiveSync');
const STOPPING = 'The server is stopping; nothing was run.';

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
}

/** One gate per server: the calls running, whether a tool call ran since the last write-back, and the refresh or write-back in progress. */
class ArchiveGate {
  private running = 0;
  private dirty = false;
  private busy: Promise<unknown> | undefined;
  private closing: Promise<CloseResult> | undefined;
  private idleWaiters: Array<() => void> = [];
  private startupNote: string | undefined;
  /** A write-back's failure or conflict no tool result has carried yet */
  private deferredNote: string | undefined;

  constructor(private readonly archive: Archive, startupNote?: string) {
    this.startupNote = startupNote;
  }

  /** Run a step no call may overlap: the refresh before a call, the write-back after the last one. */
  private async alone<T>(step: () => Promise<T>): Promise<T> {
    const run = step();
    this.busy = run;
    try {
      return await run;
    } finally {
      this.busy = undefined;
    }
  }

  private settleIdle(): void {
    if (this.running > 0 || this.busy) return;
    for (const resolveWaiter of this.idleWaiters.splice(0)) resolveWaiter();
  }

  async run(handler: () => unknown, isTool: boolean): Promise<unknown> {
    while (this.busy) await this.busy.catch(() => undefined);
    if (this.closing) return this.refuse(STOPPING, isTool);
    // Counted in before anything is awaited: no other call can see running at 0 and refresh meanwhile
    this.running++;
    let refreshNote: string | undefined;
    if (this.running === 1) {
      let refresh: ArchiveRefreshResult;
      try {
        refresh = await this.alone(() => this.archive.refresh());
      } catch (error) {
        // refresh() returns its failures; if one escapes, the call count must still come out right
        refresh = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      refreshNote = describeArchiveRefresh(this.archive, refresh);
      if (refresh.status === 'failed') {
        this.running--;
        this.settleIdle();
        return this.refuse(refreshNote ?? 'The archive could not be read again.', isTool);
      }
    }
    let result: unknown;
    let failure: { error: unknown } | undefined;
    try {
      result = await handler();
    } catch (error) {
      failure = { error };
    }
    this.running--;
    if (isTool) this.dirty = true;
    let sync: ArchiveSyncResult | undefined;
    if (this.running === 0 && this.dirty && !this.closing) {
      this.dirty = false;
      try {
        sync = await this.alone(() => this.archive.sync());
      } catch (error) {
        // sync() returns its failures; if one escapes, a waiting close() must still be released
        sync = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
    }
    this.settleIdle();
    const syncNote = sync && describeArchiveSync(this.archive, sync);
    const content = (result as ToolResultLike | undefined)?.content;
    if (!isTool || failure || !Array.isArray(content)) {
      // No tool result carries it: the next one does, and the log has it now
      if (syncNote && sync && sync.status !== 'saved') {
        this.deferredNote = syncNote;
        console.error(syncNote);
      }
      if (failure) throw failure.error;
      return result;
    }
    // This call's write-back, else its refresh, else the standing conflict; a failure deferred from an earlier call comes first
    const conflict = this.archive.status().conflict;
    const own = syncNote ?? refreshNote
      ?? (conflict ? describeArchiveSync(this.archive, { status: 'conflict', reason: conflict }) : undefined);
    const notes = [this.deferredNote, own].filter((note, index, all): note is string => note !== undefined && all.indexOf(note) === index);
    this.deferredNote = undefined;
    for (const note of notes) content.push({ type: 'text', text: note });
    if (this.startupNote) {
      content.push({ type: 'text', text: this.startupNote });
      this.startupNote = undefined;
    }
    return result;
  }

  /** A call refused without running: an error result for a tool, a rejection for a resource or prompt. */
  private refuse(text: string, isTool: boolean): unknown {
    if (isTool) return { content: [{ type: 'text', text }], isError: true };
    throw new Error(text);
  }

  /** Wait for the running calls and any write-back, refuse new calls, then close the archive; once. */
  close(): Promise<CloseResult> {
    this.closing ??= (async () => {
      while (this.running > 0 || this.busy) await new Promise<void>(resolveWaiter => this.idleWaiters.push(resolveWaiter));
      return this.archive.close();
    })();
    return this.closing;
  }
}

/**
 * A view of `server` whose tool, resource and prompt registrations go
 * through the archive's gate (see the module comment), and the gate's
 * close. Wrapping a view again returns it with the same gate.
 */
export function withArchiveSync<S extends object>(
  server: S, archive: Archive, options: { startupNote?: string } = {},
): { server: S; close(): Promise<CloseResult> } {
  const existing = (server as Record<symbol, unknown>)[WRAPPED] as ArchiveGate | undefined;
  if (existing) return { server, close: () => existing.close() };
  const gate = new ArchiveGate(archive, options.startupNote);
  const view = new Proxy(server, {
    get(target, prop) {
      if (prop === WRAPPED) return gate;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const isTool = typeof prop === 'string' && TOOL_METHODS.has(prop);
      if (!isTool && !(typeof prop === 'string' && OTHER_METHODS.has(prop))) return value.bind(target);
      return (...args: unknown[]) => {
        const last = args.length - 1;
        const handler = args[last];
        if (typeof handler === 'function') {
          args[last] = (...callArgs: unknown[]) => gate.run(() => (handler as (...a: unknown[]) => unknown)(...callArgs), isTool);
        }
        return value.apply(target, args);
      };
    },
  });
  return { server: view, close: () => gate.close() };
}

/**
 * What to tell the user when the server stopped, or undefined when there is
 * nothing to say. A kept folder means two different things: with a
 * conflict or a failed write it holds changes the archive lacks; after a
 * saved write-back it is only a folder that could not be removed, and the
 * project is saved.
 */
export function describeArchiveClose(
  archive: Pick<C3pArchive, 'archivePath' | 'workDir'>, result: CloseResult,
): string | undefined {
  const { kept, sync } = result;
  const also = sync.notes?.length ? ` Also: ${sync.notes.join('; ')}.` : '';
  if (sync.status === 'conflict' || sync.status === 'failed') {
    return `The project was NOT saved to "${archive.archivePath}" (${sync.reason ?? sync.status}); this session's changes are in "${kept ?? archive.workDir}".${also}`;
  }
  if (kept) {
    // The notes name the one folder that could not be removed
    return sync.status === 'saved'
      ? describeArchiveSync(archive, sync)
      : `Nothing needed writing back to "${archive.archivePath}".${also}`;
  }
  return undefined;
}
