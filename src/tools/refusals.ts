/**
 * The refusal vocabulary of the tools that write: a refusal made before
 * anything was written ends once with "Nothing was changed.", and an error
 * thrown by a check before the first write is worded the same way in every
 * tool, with no absolute path in it.
 */

import { toolError } from './shared.js';
import { errorReason } from '../construct3/error-text.js';

/** The closing sentence of a refusal made before anything was written. */
const NOTHING_CHANGED = 'Nothing was changed.';

/**
 * A refusal's text, ending with "Nothing was changed." exactly once: for the
 * refusals that come before a tool's first write. A message that already
 * ends with it keeps it, and a full stop is put before it when the message
 * before it has none.
 */
export function nothingChanged(message: string): string {
  const text = message.trimEnd();
  const body = (text.endsWith(NOTHING_CHANGED) ? text.slice(0, -NOTHING_CHANGED.length) : text).trimEnd();
  if (body === '') return NOTHING_CHANGED;
  return `${/[.?!]$/.test(body) ? body : `${body}.`} ${NOTHING_CHANGED}`;
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
