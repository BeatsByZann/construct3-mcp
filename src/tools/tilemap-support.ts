/**
 * Helpers the tilemap tool modules share: the refusal of a write tool, the
 * check that a name is registered in that letter case, and messages without
 * the project folder.
 */

import type { z, ZodRawShape } from 'zod';
import { toolError, type MutationToolDeps } from './shared.js';
import { findNameClash } from '../construct3/names.js';
import { runInToolCall } from '../construct3/disk-state.js';

/** A write tool's refusal: its message, ending once with "Nothing was changed.". */
export function refusal(message: string) {
  const core = message.replace(/\s*Nothing was changed\.\s*$/, '').trimEnd();
  return toolError(`${core}${/[.!?]$/.test(core) ? '' : '.'} Nothing was changed.`);
}

/**
 * The message for a `given` name that is not registered exactly, or
 * undefined when it is. A name that differs from a registered one only in
 * letter case names the registered spelling; otherwise `suggestions` (from
 * reader.findNearestName) or `listTool` are offered.
 */
export function unregisteredName(
  kind: string, given: string, registered: readonly string[], suggestions: readonly string[], listTool: string,
): string | undefined {
  if (registered.includes(given)) return undefined;
  const clash = findNameClash(given, registered);
  if (clash !== undefined) return `${kind} "${given}" not found: names are matched with their letter case. Did you mean "${clash}"?`;
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ` Use ${listTool} to see all available names.`;
  return `${kind} "${given}" not found.${hint}`;
}

/** An error's message with the project folder replaced by ".", in both slash forms; its ending is kept. */
export function messageWithoutPaths(error: unknown, projectDir: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const forward = projectDir.replace(/\\/g, '/');
  return message.split(projectDir).join('.').split(forward).join('.').split(forward.replace(/\//g, '\\')).join('.');
}

/** An error's message without the project folder and without its final full stop, to be placed inside a sentence. */
export function causeWithoutPaths(error: unknown, projectDir: string): string {
  return messageWithoutPaths(error, projectDir).replace(/\.$/, '');
}

/** The refusal for an error thrown by a check before anything was written. */
export function stoppedBeforeWrite(error: unknown, projectDir: string) {
  return refusal(`The change was stopped before anything was written: ${causeWithoutPaths(error, projectDir)}.`);
}

/**
 * `server.tool` for the tilemap modules, with what `withProjectSync` does
 * (the handler runs as one tool call scope, after the reader has checked
 * project.c3proj) but with the failure of that check worded by the module's
 * own policy: `writeTool` returns `stoppedBeforeWrite` (no project folder in
 * the text, "Nothing was changed."), `readTool` returns a plain tool error
 * without the project folder. `withProjectSync` returns the reader's message
 * as it is, which can hold the project folder and has no such ending.
 */
export function syncedTools(server: MutationToolDeps['server'], reader: MutationToolDeps['reader']) {
  const register = (onSyncError: (error: unknown) => ReturnType<typeof toolError>) =>
    <Shape extends ZodRawShape>(
      name: string,
      description: string,
      shape: Shape,
      handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => unknown,
    ) =>
      server.tool(name, description, shape, ((args: z.objectOutputType<Shape, z.ZodTypeAny>) => runInToolCall(async () => {
        try {
          await reader.checkProjectFile();
        } catch (error) {
          return onSyncError(error);
        }
        return handler(args);
      })) as never);
  const projectDir = () => reader.getProjectDir();
  return {
    readTool: register(error => toolError(`Error reading the project: ${messageWithoutPaths(error, projectDir())}`)),
    writeTool: register(error => stoppedBeforeWrite(error, projectDir())),
  };
}
