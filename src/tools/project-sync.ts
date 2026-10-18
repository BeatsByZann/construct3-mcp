/**
 * Every tool call, resource read and prompt starts from the project as it is
 * on disk (#51): the handlers registered through withProjectSync() run as one
 * tool call scope (disk-state.ts) and first let the reader check
 * project.c3proj (Construct3ProjectReader.checkProjectFile); the files its
 * caches hold are checked when the call first uses them (ensureCachesFresh).
 * In the scope the writer backs each file up once, with its state from before
 * the call, and refuses to write a file that changed on disk after the call
 * read it. Each tool call that opens the scope is recorded in the change
 * journal (change-journal.ts) when it ends, and a result that is not an error
 * then ends with a line naming the files the call changed.
 */

import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import { currentToolCall, runInToolCall } from '../construct3/disk-state.js';
import { changedFilesLine, recordToolCall, type JournalEntry } from '../construct3/change-journal.js';
import { toolError } from './shared.js';

/** The registration methods whose last argument is the handler (McpServer and the test double). */
const TOOL_METHODS = new Set(['tool', 'registerTool']);
const OTHER_METHODS = new Set(['resource', 'registerResource', 'prompt', 'registerPrompt']);
const SYNCED = Symbol('construct3-mcp.projectSync');

/**
 * A view of `server` whose tool, resource and prompt registrations sync the
 * project with the disk before each call. A tool whose sync fails (the
 * project file changed and cannot be read) returns the reason as a tool
 * error; a resource read or prompt throws it. Wrapping a view again returns
 * it unchanged.
 */
export function withProjectSync<S extends object>(server: S, reader: Construct3ProjectReader): S {
  if ((server as Record<symbol, unknown>)[SYNCED]) return server;
  return new Proxy(server, {
    get(target, prop) {
      if (prop === SYNCED) return true;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const isTool = typeof prop === 'string' && TOOL_METHODS.has(prop);
      if (!isTool && !(typeof prop === 'string' && OTHER_METHODS.has(prop))) return value.bind(target);
      return (...args: unknown[]) => {
        const last = args.length - 1;
        const handler = args[last];
        if (typeof handler === 'function') {
          const tool = isTool && typeof args[0] === 'string' ? args[0] : undefined;
          args[last] = syncedHandler(handler as (...a: unknown[]) => unknown, reader, isTool, tool);
        }
        return value.apply(target, args);
      };
    },
  });
}

function syncedHandler(
  handler: (...args: unknown[]) => unknown,
  reader: Construct3ProjectReader,
  isTool: boolean,
  tool: string | undefined,
): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => {
    // Only the call that opens the scope is journaled: a handler run inside
    // another call's scope is part of that call
    const journaled = tool !== undefined && currentToolCall() === undefined;
    return runInToolCall(async () => {
      try {
        await reader.checkProjectFile();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTool) return toolError(message);
        throw new Error(message);
      }
      if (!journaled) return handler(...args);
      return journaledCall(reader, tool as string, () => handler(...args));
    });
  };
}

/**
 * Run a tool handler as a journaled call: what it changed is recorded in the
 * change journal when it ends, also when it throws, and a result that is not
 * an error gets the line naming the changed files as its last content item.
 * A fault in this bookkeeping is logged and never changes the result.
 */
async function journaledCall(reader: Construct3ProjectReader, tool: string, run: () => unknown): Promise<unknown> {
  const startedAt = Date.now();
  let result: unknown;
  try {
    result = await run();
  } catch (error) {
    recordSafely(reader, tool, startedAt);
    throw error;
  }
  const entry = recordSafely(reader, tool, startedAt);
  try {
    const shaped = result as { content?: unknown; isError?: unknown } | undefined;
    if (entry && shaped && Array.isArray(shaped.content) && shaped.isError !== true) {
      shaped.content.push({ type: 'text', text: changedFilesLine(entry) });
    }
  } catch (error) {
    console.error('[change journal] could not add the changed files to the result:', error);
  }
  return result;
}

/** Record the running call in the change journal; a fault is logged, not thrown. */
function recordSafely(reader: Construct3ProjectReader, tool: string, startedAt: number): JournalEntry | undefined {
  try {
    const scope = currentToolCall();
    return scope ? recordToolCall(reader, tool, startedAt, scope) : undefined;
  } catch (error) {
    console.error('[change journal] could not record the call:', error);
    return undefined;
  }
}
