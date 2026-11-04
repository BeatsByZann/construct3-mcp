/**
 * Warnings the event tools add to a write: the conditions, actions and
 * expressions a call added or changed are checked against the definitions of
 * the project's release, as validate_project checks a whole project.
 */

import {
  aceTreeSnapshot,
  buildAceContext,
  changedAceSidsInTree,
  checkEventAces,
  describeEventAceProblem,
  readProjectData,
} from './ace-catalog.js';
import { aceCatalogProviderFor, describeCatalogSubstitute } from './ace-catalog-provider.js';
import type { ProjectData } from './ace-types.js';
import { addonDefinitionsOf } from './addon-definitions.js';
import {
  buildExpressionContext,
  checkEventExpressions,
  describeEventExpressionProblem,
  hasExpressionParameters,
} from './expression-check.js';
import type { Construct3ProjectReader } from './project-reader.js';
import type { C3Event } from './types.js';

/**
 * `data` with the events of `sheetName` replaced by `events`, as the tool is
 * about to write them (the sheet is added when `data` has none of that name).
 * `data` itself is not changed.
 */
export function withSheetEvents(data: ProjectData, sheetName: string, events: unknown): ProjectData {
  const sheets = new Map(data.sheets);
  const cached = sheets.get(sheetName);
  sheets.set(sheetName, { ...(cached ?? { name: sheetName }), events: events as C3Event[] });
  return { ...data, sheets };
}

/**
 * Obtain the catalogue for the project's release now, so that the first fetch
 * of a release (up to 60 seconds) is not spent between an event tool's read of
 * the sheet and its write. The outcome is kept by the provider; a failure is
 * not reported here, `checkEventChange` reports it. Never throws.
 */
export async function warmAceCatalog(reader: Construct3ProjectReader): Promise<void> {
  try {
    const release = (reader.getProject() as { savedWithRelease?: unknown }).savedWithRelease;
    await aceCatalogProviderFor(reader).catalogFor(release);
  } catch {
    // checkEventChange asks again and reports what it finds.
  }
}

/**
 * Warnings for the conditions and actions an event tool added or changed:
 * `before` is the snapshot taken before the change, `after` the sheet's
 * events. Unchanged ACEs are not checked. Checks ACEs against the catalogue
 * for the project's release (built on first use; without one, a single
 * warning says why and nothing else is checked) and the reader's loaded addon
 * definitions, then the expressions in the changed ACEs' parameters, against
 * the project with `sheetName` as the tool is about to write it (`after` in
 * place of the cached copy, so a declaration added in the same call counts).
 * Reads the project once, and the event sheets only when a changed ACE has an
 * expression-typed parameter. Never throws: a failure of the check itself
 * becomes one warning with a fixed text, the detail on stderr.
 */
export async function checkEventChange(
  reader: Construct3ProjectReader,
  sheetName: string,
  before: unknown,
  after: unknown,
): Promise<string[]> {
  try {
    const changed = changedAceSidsInTree(aceTreeSnapshot(before), after);
    if (changed.size === 0) return [];
    const addons = addonDefinitionsOf(reader);
    const release = (reader.getProject() as { savedWithRelease?: unknown }).savedWithRelease;
    const lookup = await aceCatalogProviderFor(reader).catalogFor(release);
    if (!lookup.ok) return [lookup.message];
    const catalog = lookup.catalog;
    const saved = typeof release === 'number' ? release : undefined;
    const warnings: string[] = [];
    const substitute = describeCatalogSubstitute(lookup);
    if (substitute) warnings.push(substitute);
    const base = await readProjectData(reader, { sheets: false });
    const aceContext = buildAceContext(base);
    warnings.push(...checkEventAces(after, aceContext, addons, catalog, changed).map(p => describeEventAceProblem(p, catalog.release, saved)));
    if (!hasExpressionParameters(after, aceContext, addons, catalog, changed)) return warnings;
    const data = withSheetEvents(await readProjectData(reader), sheetName, after);
    const expressionContext = buildExpressionContext(data, aceContext);
    warnings.push(...checkEventExpressions(after, expressionContext, aceContext, addons, catalog, changed).map(p => describeEventExpressionProblem(p, catalog.release, saved)));
    if (!expressionContext.complete) {
      warnings.push(`Names in the expressions written were not checked, because these files could not be read: ${expressionContext.unreadable.join(', ')}.`);
    }
    return warnings;
  } catch (error) {
    console.error('checkEventChange:', error);
    return ['The ACE and expression checks could not run for this change; run validate_project to check the sheet.'];
  }
}
