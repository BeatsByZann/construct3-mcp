/**
 * Bring a project.c3proj written by an older Construct release to the shape
 * the r495.2 editor saves, so that a tool write followed by an editor save
 * does not produce a diff the tool did not cause (roadmap C5, HANDOFF W94).
 *
 * Evidence: every project.c3proj on this machine saved by release 49502
 * (r495.2) or later carries `script-info` on its scripts, a `models3d` folder
 * after `flowcharts`, `uidAllocationMode` right after `preloadSounds` and
 * `scriptsType` last in `properties`. The r495.2 editor applied exactly these
 * changes to a release-44903 fixture on save (W90 round trip).
 *
 * `zAxisScale` is a setting, not a shape, so it is changed only where the
 * editor was seen to change it: r495.2 shows and saves "regular" for a project
 * saved by release 44903 that holds "normalized" (the W90 round trip and the
 * C5 load check), while a project r495.2 itself saved keeps "normalized"
 * (the timeline-properties fixture). The editor's cut-off release lies
 * somewhere between; projects saved between 44903 and 49502 are left alone.
 * Releases before 44903 are inferred, not observed: an editor migration keyed
 * on the saved release applies to every older release too.
 *
 * Deliberately not done:
 * - `usedAddons` pruning: it removes entries, and the owner ruled it out.
 * - Property order for projects saved at 49502 or later: the editor's order
 *   depends on its release (49700 puts `zAxisScale` after
 *   `uidAllocationMode`), so a newer project is left as its editor wrote it.
 */

/** `savedWithRelease` of Construct r495.2, the recorded editor baseline. */
export const SHAPE_BASELINE_RELEASE = 49502;

/** Latest release at which r495.2 was seen to turn zAxisScale "normalized" into "regular". */
export const Z_AXIS_SCALE_MIGRATED_RELEASE = 44903;

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
  const rest = Object.keys(target).filter(k => k !== key);
  let order: string[];
  if (anchor === null) {
    order = [...rest, key];
  } else {
    const at = rest.indexOf(anchor);
    if (at < 0) return false;
    order = [...rest.slice(0, at + 1), key, ...rest.slice(at + 1)];
  }
  const current = Object.keys(target);
  if (order.every((k, i) => k === current[i])) return false;
  reorderKeys(target, order);
  return true;
}

/**
 * Apply the r495.2 save shape to a parsed project.c3proj, in place. Returns one
 * line per change; an empty list means the file already had that shape.
 */
export function upgradeProjectShape(project: Json): string[] {
  const changes: string[] = [];

  // Scripts: the r495.2 editor stores script metadata under script-info.
  const roots = project.rootFileFolders;
  if (isObject(roots)) renameScriptInfo(roots.script, 'scripts', changes);

  // models3d: every r495.2 save has the folder, empty when there are no models.
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
    if (release <= Z_AXIS_SCALE_MIGRATED_RELEASE && properties.zAxisScale === 'normalized') {
      properties.zAxisScale = 'regular';
      changes.push('properties.zAxisScale "normalized" read as "regular", as r495.2 does for this release');
    }
  }

  return changes;
}
