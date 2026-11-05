/**
 * Helpers the tilemap tool modules share: the refusal of a write tool, the
 * check that a name is registered in that letter case, and messages without
 * the project folder.
 */

import type { z, ZodRawShape } from 'zod';
import { toolError, type MutationToolDeps } from './shared.js';
import { runInToolCall } from '../construct3/disk-state.js';
import { errorMessage } from '../construct3/error-text.js';
import { stoppedBeforeWrite } from './refusals.js';
import { unregisteredNameMessage } from './registered-names.js';

/**
 * The message for a `given` name that is not registered exactly, or
 * undefined when it is. A name that differs from a registered one only in
 * letter case names the registered spelling; otherwise `suggestions` (from
 * reader.findNearestName) or `listTool` are offered.
 */
export function unregisteredName(
  kind: string, given: string, registered: readonly string[], suggestions: readonly string[], listTool: string,
): string | undefined {
  return unregisteredNameMessage(kind, given, registered, () => [...suggestions], listTool);
}

/**
 * `server.tool` for the tilemap modules, with what `withProjectSync` does
 * (the handler runs as one tool call scope, after the reader has checked
 * project.c3proj) but with the failure of that check worded by the module's
 * own policy: `writeTool` returns the stopped-before-write refusal (no project folder in
 * the text, "Nothing was changed."), `readTool` returns a plain tool error
 * without the project folder. `withProjectSync` returns the reader's message
 * as it is, which can hold the project folder and has no such ending. The
 * handler receives the arguments only, not the SDK's second argument. Pass the
 * server itself, not a `withProjectSync` view of it, or that wrapper's check
 * and wording run first.
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
    readTool: register(error => toolError(`Error reading the project: ${errorMessage(error, projectDir())}`)),
    writeTool: register(error => toolError(stoppedBeforeWrite(error, projectDir()))),
  };
}
