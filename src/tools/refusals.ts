/**
 * The refusal vocabulary of the tools that write: a refusal made before
 * anything was written ends once with "Nothing was changed.", and an error
 * thrown by a check before the first write is worded the same way in every
 * tool, with no absolute path in it.
 */

import { toolError } from './shared.js';
import { errorReason } from '../construct3/error-text.js';

/**
 * A refusal's text, ending with "Nothing was changed." exactly once: for the
 * refusals that come before a tool's first write.
 */
export function nothingChanged(message: string): string {
  const text = message.trimEnd();
  if (text === '') return 'Nothing was changed.';
  if (text.endsWith('Nothing was changed.')) return text;
  return `${/[.?!]$/.test(text) ? text : `${text}.`} Nothing was changed.`;
}

/** A refusal made before anything was written, as a tool error. */
export function refuse(message: string) {
  return toolError(nothingChanged(message));
}

/**
 * The refusal text for an error thrown by a check before anything was
 * written. The reason is the error worded by `errorReason` (an fs error as
 * "<code> on <path>", any absolute path in a message replaced) with a closing
 * "Nothing was written" sentence removed, so the text ends in one sentence.
 * `projectDir` is the project folder, so a path inside it shows as a relative
 * path.
 */
export function stoppedBeforeWrite(error: unknown, projectDir?: string): string {
  const reason = errorReason(error, { projectDir }).replace(/\.\s*Nothing was written$/, '');
  return nothingChanged(`The change was stopped before anything was written: ${reason}`);
}
