/**
 * Bring a project.c3proj that an older Construct release saved to a fixed
 * save shape, so that a tool write followed by an editor save shows fewer
 * differences the tool did not cause.
 *
 * The shape: script entries carry `script-info` instead of `file-info`, an empty `models3d`
 * folder follows `flowcharts`, `uidAllocationMode` follows `preloadSounds`
 * and `scriptsType` ends `properties`. The first two apply to a project of
 * any release; for a file without `flowcharts` the folder goes before
 * `properties`, a placement inferred, not recorded. Projects saved at
 * release 49502 or later keep their editor's own property order.
 *
 * Deliberately not done:
 * - `zAxisScale` and every other setting: left as saved. Construct 3 r506-2
 *   updated a legacy "normalized" itself when it opened a release-44903
 *   project in one recorded check; a tool that changed it while writing
 *   something else would hide that.
 * - `usedAddons` pruning: it removes entries a project may still use.
 * - Property order for a project saved at 49502 or later: the order depends
 *   on the editor's release (49700 puts `zAxisScale` after
 *   `uidAllocationMode`), so a newer project is left as its editor wrote it.
 */

/** `savedWithRelease` of Construct r495.2, the recorded editor baseline. */
export const SHAPE_BASELINE_RELEASE = 49502;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rewrite `target`'s keys in `order`, in place, keeping the object's identity. */
function reorderKeys(target: Json, order: string[]): void {
  const entries = order.map(key => [key, target[key]] as const);
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of entries) target[key] = value;
}

/** Replace `from` with `to` at the same position in `target`. */
function renameKey(target: Json, from: string, to: string): void {
  const order = Object.keys(target).map(key => (key === from ? to : key));
  const value = target[from];
  delete target[from];
  target[to] = value;
  reorderKeys(target, order);
}

/** Rename `file-info` to `script-info` on every script entry of a folder and its subfolders. */
function renameScriptInfo(folder: unknown, path: string, changes: string[]): void {
  if (!isObject(folder)) return;
  const items = Array.isArray(folder.items) ? folder.items : [];
  for (const item of items) {
    if (isObject(item) && 'file-info' in item && !('script-info' in item)) {
      renameKey(item, 'file-info', 'script-info');
      changes.push(`${path}: script "${String(item.name)}" file-info renamed to script-info`);
    }
  }
  const subfolders = Array.isArray(folder.subfolders) ? folder.subfolders : [];
  for (const sub of subfolders) {
    renameScriptInfo(sub, `${path}/${isObject(sub) ? String(sub.name) : '?'}`, changes);
  }
}

/** Move `key` to sit right after `anchor` (or to the end when anchor is null). */
function moveKey(target: Json, key: string, anchor: string | null): boolean {
  if (!(key in target)) return false;
  const current = Object.keys(target);
  const rest = current.filter(k => k !== key);
  let order: string[];
  if (anchor === null) {
    order = [...rest, key];
  } else {
    const at = rest.indexOf(anchor);
    if (at < 0) return false;
    order = [...rest.slice(0, at + 1), key, ...rest.slice(at + 1)];
  }
  if (order.every((k, i) => k === current[i])) return false;
  reorderKeys(target, order);
  return true;
}

/**
 * Apply the save shape to a parsed project.c3proj, in place. Returns one
 * line per change; an empty list means the file already had that shape.
 */
export function upgradeProjectShape(project: Json): string[] {
  const changes: string[] = [];

  // Scripts: the shape stores script metadata under script-info.
  const roots = project.rootFileFolders;
  if (isObject(roots)) renameScriptInfo(roots.script, 'scripts', changes);

  // models3d: the shape has the folder, empty when there are no models.
  if (!('models3d' in project)) {
    const keys = Object.keys(project);
    const after = keys.includes('flowcharts') ? keys.indexOf('flowcharts') + 1
      : keys.includes('properties') ? keys.indexOf('properties')
        : keys.length;
    project.models3d = { items: [], subfolders: [] };
    reorderKeys(project, [...keys.slice(0, after), 'models3d', ...keys.slice(after)]);
    changes.push('models3d folder added');
  }

  // Property order: only for projects an older release saved.
  const release = project.savedWithRelease;
  const properties = project.properties;
  if (typeof release === 'number' && release < SHAPE_BASELINE_RELEASE && isObject(properties)) {
    if (moveKey(properties, 'uidAllocationMode', 'preloadSounds')) {
      changes.push('properties.uidAllocationMode moved after preloadSounds');
    }
    if (moveKey(properties, 'scriptsType', null)) {
      changes.push('properties.scriptsType moved to the end');
    }
  }

  return changes;
}
