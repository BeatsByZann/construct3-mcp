/**
 * Names the tools take from the caller are matched with their letter case,
 * as they are registered in project.c3proj: a file system that ignores case
 * would otherwise read the file of another spelling, and a write would name
 * it as given.
 */

import { findNameClash } from '../construct3/names.js';
import { notFoundError } from './shared.js';

/**
 * The message for a name that is not registered exactly as given, or
 * undefined when it is. A name that differs from a registered one only in
 * case or normalisation gets that spelling named; `suggestions` is called
 * only for a name unknown in every spelling. A tool that changes files
 * passes the message to `nothingChanged`.
 */
export function unregisteredNameMessage(
  kind: string, name: string, registered: readonly string[], suggestions: () => string[], listTool: string,
): string | undefined {
  if (registered.includes(name)) return undefined;
  const sameIgnoringCase = findNameClash(name, registered);
  if (sameIgnoringCase !== undefined) {
    return `${kind} "${name}" not found: names are matched with their letter case. Did you mean "${sameIgnoringCase}"?`;
  }
  return notFoundError(kind, name, suggestions(), listTool).content[0].text;
}
