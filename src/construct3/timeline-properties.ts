/**
 * What a timeline property track stores for each kind of property.
 *
 * Sampled from Construct 3 r495.2 (2026-09-17):
 * - A disposable project whose Box instance had known values (x 324, y 216,
 *   width 50, height 60, angle 0.5, opacity 0.7, color [0.25, 0.5, 0.75],
 *   z 5, a 1x1 frame, instance variables hp 7, tag "start", on true). Every
 *   property in the editor's "Add properties" picker was added to its track
 *   and the project was saved.
 * - 2,215 keyframes from 21 Construct timeline examples.
 *
 * Rules the samples fixed:
 * - World properties use `source: { type: 'world-instance', uid: <instance UID> }`
 *   and the ten names in WORLD_PROPERTIES. A new track's keyframes hold the
 *   instance's current value as `aValue`.
 * - Instance variables use `source: { type: 'instance-variable', uid: <variable name> }`
 *   and plugin properties use `source: { type: 'plugin', uid: <plugin id> }`;
 *   the track's `property` is the variable name or the plugin property id.
 * - Numbers: `rValue` is the offset from the instance's own value
 *   (`aValue - base`), and `value` repeats `aValue` when the effective result
 *   mode is "absolute" and `rValue` otherwise. This held for every sampled
 *   numeric keyframe.
 * - Strings and booleans: `value`, `rValue` and `aValue` are all the value.
 * - Color: `value` and `aValue` are the [r, g, b, a] array; there is no `rValue`.
 * - Only offsetX and offsetY use `pathMode: 'default'` and a `cubic-bezier`
 *   addon; offsetAngle carries an `angle` addon; Sprite's initial-animation and
 *   initial-frame carry addons named after themselves; everything else has
 *   `pathMode: 'none'` and no addons. Plugin tracks carry a `sourceAdapter`.
 * - Scale bases are the instance size divided by the size of the first frame
 *   of its initial animation (50 for width 50 over a 1x1 frame).
 * - The editor keeps property tracks in a fixed order whatever order they were
 *   added in: the world properties in TRACK_ORDER, then instance variables,
 *   then plugin properties. virtualPosition keys follow VIRTUAL_POSITION_ORDER.
 */

import type { Instance, ObjectType } from './types.js';

export type TimelineValue = number | string | boolean | number[];
export type PropertyKind = 'number' | 'string' | 'boolean' | 'color';

export interface PropertySpec {
  /** Name stored in the track's `property` field. */
  property: string;
  source: { type: string; uid: number | string };
  kind: PropertyKind;
  pathMode: 'default' | 'none';
  /** Addons for one new keyframe. */
  addons(): Array<{ id: string; data?: Record<string, unknown> }>;
  /** Extra fields for a new property track (plugin tracks carry `sourceAdapter`). */
  trackExtras: Record<string, unknown>;
  /** The instance's own value, when it can be read. */
  base?: TimelineValue;
  /** Key this property adds to the instance track's `virtualPosition`. */
  virtualKey?: string;
  /** False for a name that matched no sampled rule. */
  verified: boolean;
  /** Position among an instance track's property tracks; the editor keeps them in this order. */
  order: number;
}

const CUBIC_BEZIER = () => [{ id: 'cubic-bezier', data: { startAnchor: null, startEnable: false, endAnchor: null, endEnable: false } }];
const NO_ADDONS = () => [];

interface WorldRule {
  kind: 'number' | 'color';
  pathMode: 'default' | 'none';
  addons: () => Array<{ id: string; data?: Record<string, unknown> }>;
  base: (instance: Instance, objectType?: ObjectType) => TimelineValue | undefined;
}

function firstFrameSize(objectType?: ObjectType, animationName?: unknown): { width: number; height: number } | undefined {
  const animations = (objectType as { animations?: { items?: Array<{ name?: string; frames?: Array<{ width?: number; height?: number }> }> } } | undefined)?.animations;
  const items = animations?.items ?? [];
  const animation = items.find(a => a.name === animationName) ?? items[0];
  const frame = animation?.frames?.[0];
  if (!frame || typeof frame.width !== 'number' || typeof frame.height !== 'number' || frame.width <= 0 || frame.height <= 0) return undefined;
  return { width: frame.width, height: frame.height };
}

function worldNumber(key: string, fallback?: number) {
  return (instance: Instance) => {
    const value = instance.world?.[key];
    return typeof value === 'number' ? value : fallback;
  };
}

/** The ten world properties the r495.2 picker offers, in picker-independent order. */
export const WORLD_PROPERTIES: Record<string, WorldRule> = {
  offsetX: { kind: 'number', pathMode: 'default', addons: CUBIC_BEZIER, base: worldNumber('x') },
  offsetY: { kind: 'number', pathMode: 'default', addons: CUBIC_BEZIER, base: worldNumber('y') },
  offsetZElevation: { kind: 'number', pathMode: 'none', addons: NO_ADDONS, base: worldNumber('z', 0) },
  offsetWidth: { kind: 'number', pathMode: 'none', addons: NO_ADDONS, base: worldNumber('width') },
  offsetHeight: { kind: 'number', pathMode: 'none', addons: NO_ADDONS, base: worldNumber('height') },
  offsetAngle: {
    kind: 'number', pathMode: 'none',
    addons: () => [{ id: 'angle', data: { direction: 'closest', revolutions: 0 } }],
    base: worldNumber('angle', 0),
  },
  offsetOpacity: {
    kind: 'number', pathMode: 'none', addons: NO_ADDONS,
    base: instance => (Array.isArray(instance.world?.color) ? instance.world!.color![3] : 1),
  },
  offsetColor: {
    kind: 'color', pathMode: 'none', addons: NO_ADDONS,
    base: instance => (Array.isArray(instance.world?.color) ? [...instance.world!.color!] : [1, 1, 1, 1]),
  },
  offsetScaleX: {
    kind: 'number', pathMode: 'none', addons: NO_ADDONS,
    base: (instance, objectType) => {
      const frame = firstFrameSize(objectType, instance.properties?.['initial-animation']);
      return frame && typeof instance.world?.width === 'number' ? instance.world.width / frame.width : undefined;
    },
  },
  offsetScaleY: {
    kind: 'number', pathMode: 'none', addons: NO_ADDONS,
    base: (instance, objectType) => {
      const frame = firstFrameSize(objectType, instance.properties?.['initial-animation']);
      return frame && typeof instance.world?.height === 'number' ? instance.world.height / frame.height : undefined;
    },
  },
};

/** Property-track order the editor saved for the world properties. */
const TRACK_ORDER = ['offsetX', 'offsetY', 'offsetZElevation', 'offsetWidth', 'offsetHeight', 'offsetScaleX', 'offsetScaleY', 'offsetAngle', 'offsetOpacity', 'offsetColor'];
/** virtualPosition key order the editor saved. */
const VIRTUAL_POSITION_ORDER = ['offsetX', 'offsetY', 'offsetZElevation', 'offsetWidth', 'offsetHeight', 'offsetAngle', 'offsetOpacity', 'offsetColor', 'offsetScaleX', 'offsetScaleY'];

/** Plugin properties the editor gives an addon, keyed by `<plugin id>/<property id>`. */
const PLUGIN_ADDONS: Record<string, () => Array<{ id: string; data?: Record<string, unknown> }>> = {
  'Sprite/initial-animation': () => [{ id: 'initial-animation', data: { sf: 'default' } }],
  'Sprite/initial-frame': () => [{ id: 'initial-frame' }],
};
const PLUGIN_SOURCE_ADAPTERS: Record<string, () => Record<string, unknown>> = {
  'Sprite/initial-animation': () => ({ up: { sf: 'beginning' } }),
};

function kindOf(value: unknown, declared?: unknown): PropertyKind | undefined {
  if (declared === 'number' || declared === 'string' || declared === 'boolean') return declared;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return undefined;
}

export type PropertyResolution = { ok: true; spec: PropertySpec } | { ok: false; error: string };

/**
 * Resolve a property name for an instance. Names are world property names,
 * instance variable names, or plugin property ids; `var:` and `plugin:`
 * prefixes select one when a name is both.
 */
export function resolveTimelineProperty(name: string, instance: Instance, objectType?: ObjectType): PropertyResolution {
  let wanted: 'any' | 'var' | 'plugin' = 'any';
  let bare = name;
  if (name.startsWith('var:')) { wanted = 'var'; bare = name.slice(4); }
  else if (name.startsWith('plugin:')) { wanted = 'plugin'; bare = name.slice(7); }

  if (wanted === 'any' && Object.prototype.hasOwnProperty.call(WORLD_PROPERTIES, bare)) {
    const rule = WORLD_PROPERTIES[bare];
    return {
      ok: true,
      spec: {
        property: bare,
        source: { type: 'world-instance', uid: instance.uid },
        kind: rule.kind,
        pathMode: rule.pathMode,
        addons: rule.addons,
        trackExtras: {},
        base: instance.world ? rule.base(instance, objectType) : undefined,
        virtualKey: bare,
        verified: true,
        order: TRACK_ORDER.indexOf(bare),
      },
    };
  }

  const variables = Array.isArray(objectType?.instanceVariables) ? objectType!.instanceVariables : [];
  const variable = variables.find(v => v.name === bare);
  const pluginId = objectType?.['plugin-id'];
  const pluginHas = bare !== 'live-preview' && instance.properties !== undefined
    && Object.prototype.hasOwnProperty.call(instance.properties, bare);

  if (variable && pluginHas && wanted === 'any') {
    return { ok: false, error: `"${bare}" is both an instance variable and a plugin property of "${instance.type}"; write "var:${bare}" or "plugin:${bare}".` };
  }

  if (variable && wanted !== 'plugin') {
    const current = instance.instanceVariables?.[bare];
    const kind = kindOf(current, variable.type);
    if (!kind) return { ok: false, error: `Instance variable "${bare}" has type "${String(variable.type)}", which a timeline cannot animate.` };
    return {
      ok: true,
      spec: {
        property: bare,
        source: { type: 'instance-variable', uid: bare },
        kind,
        pathMode: 'none',
        addons: NO_ADDONS,
        trackExtras: {},
        base: current as TimelineValue | undefined,
        verified: true,
        order: 1000 + variables.indexOf(variable),
      },
    };
  }

  if (pluginHas && wanted !== 'var' && typeof pluginId === 'string') {
    const current = instance.properties[bare];
    const kind = kindOf(current);
    if (!kind) return { ok: false, error: `Plugin property "${bare}" of "${instance.type}" holds a ${typeof current}, which a timeline cannot animate.` };
    const key = `${pluginId}/${bare}`;
    return {
      ok: true,
      spec: {
        property: bare,
        source: { type: 'plugin', uid: pluginId },
        kind,
        pathMode: 'none',
        addons: PLUGIN_ADDONS[key] ?? NO_ADDONS,
        trackExtras: { sourceAdapter: PLUGIN_SOURCE_ADAPTERS[key]?.() ?? {} },
        base: current as TimelineValue,
        verified: true,
        order: 2000 + Object.keys(instance.properties).indexOf(bare),
      },
    };
  }

  if (wanted !== 'any') {
    return { ok: false, error: `"${instance.type}" has no ${wanted === 'var' ? 'instance variable' : 'plugin property'} named "${bare}".` };
  }

  return {
    ok: true,
    spec: {
      property: bare,
      source: { type: 'world-instance', uid: instance.uid },
      kind: 'number',
      pathMode: 'none',
      addons: NO_ADDONS,
      trackExtras: {},
      verified: false,
      order: Number.MAX_SAFE_INTEGER,
    },
  };
}

/** Rebuild a spec for an existing track from its stored source. */
export function specForExistingTrack(
  track: { property: string; source: { type: string; uid: number | string } },
  instance: Instance | undefined,
  objectType?: ObjectType,
): PropertyResolution {
  if (!instance) {
    return { ok: false, error: `The instance animated by property track "${track.property}" was not found in any layout.` };
  }
  const prefix = track.source.type === 'instance-variable' ? 'var:' : track.source.type === 'plugin' ? 'plugin:' : '';
  if (track.source.type !== 'world-instance' && prefix === '') {
    return { ok: false, error: `Property track "${track.property}" has source type "${track.source.type}", which these tools do not edit.` };
  }
  return resolveTimelineProperty(prefix + track.property, instance, objectType);
}

/** First non-default result mode, from the keyframe outward. */
export function effectiveResultMode(...modes: Array<unknown>): string {
  for (const mode of modes) {
    if (typeof mode === 'string' && mode !== '' && mode !== 'default') return mode;
  }
  return 'default';
}

export interface KeyframeValues {
  value: TimelineValue;
  rValue?: number | string | boolean;
  aValue: TimelineValue;
}

/** The three stored values for an absolute value under a result mode. */
export function valuesFor(spec: PropertySpec, absolute: TimelineValue, mode: string): KeyframeValues {
  if (spec.kind === 'color') return { value: absolute, aValue: absolute };
  if (spec.kind !== 'number') return { value: absolute, rValue: absolute as string | boolean, aValue: absolute };
  const relative = (absolute as number) - (spec.base as number);
  return { value: mode === 'absolute' ? absolute : relative, rValue: relative, aValue: absolute };
}

/** Validate a caller-supplied absolute value against the property kind. */
export function checkValue(spec: PropertySpec, value: unknown): string | null {
  switch (spec.kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `"${spec.property}" needs a number.`;
    case 'string':
      return typeof value === 'string' ? null : `"${spec.property}" needs a string.`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${spec.property}" needs true or false.`;
    case 'color':
      return Array.isArray(value) && value.length === 4 && value.every(c => typeof c === 'number' && c >= 0 && c <= 1)
        ? null
        : `"${spec.property}" needs [r, g, b, a] with each part from 0 to 1.`;
  }
}

/** Add a property's key to an instance track's virtualPosition, in the editor's key order before the flag keys. */
export function addVirtualPositionKey(virtualPosition: Record<string, unknown>, key: string, kind: PropertyKind): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(virtualPosition, key)) return virtualPosition;
  const offsets: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(virtualPosition)) {
    if (k.startsWith('offset')) offsets[k] = v;
    else rest[k] = v;
  }
  offsets[key] = kind === 'color' ? [0, 0, 0, 1] : 0;
  const rank = (k: string) => {
    const i = VIRTUAL_POSITION_ORDER.indexOf(k);
    return i === -1 ? VIRTUAL_POSITION_ORDER.length : i;
  };
  const ordered = Object.keys(offsets).sort((a, b) => rank(a) - rank(b));
  const out: Record<string, unknown> = {};
  for (const k of ordered) out[k] = offsets[k];
  return { ...out, ...rest };
}

/** Rank of an existing property track, for inserting a new one in the editor's order. */
export function trackRank(
  track: { property: string; source?: { type?: string } },
  instance: Instance | undefined,
  objectType: ObjectType | undefined,
): number {
  const type = track.source?.type;
  if (type === 'world-instance') {
    const i = TRACK_ORDER.indexOf(track.property);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }
  if (type === 'instance-variable') {
    const variables = Array.isArray(objectType?.instanceVariables) ? objectType!.instanceVariables : [];
    const i = variables.findIndex(v => v.name === track.property);
    return i === -1 ? 1999 : 1000 + i;
  }
  if (type === 'plugin') {
    const i = instance ? Object.keys(instance.properties ?? {}).indexOf(track.property) : -1;
    return i === -1 ? 2999 : 2000 + i;
  }
  return Number.MAX_SAFE_INTEGER;
}
