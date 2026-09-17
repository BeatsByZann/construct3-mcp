/**
 * Layout tools: create_layout, add_instance_to_layout, delete_layout, update_layout,
 * add_layer, delete_layer, update_layer, reorder_layers, move_layer,
 * delete_instance_from_layout, update_instance, move_instance, set_instance_parent,
 * remove_instance_children.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type {
  WriteResult, Layout, Layer, Instance, SceneGraphData, SceneGraphFlags, SceneGraphPreview,
} from '../construct3/types.js';
import { validateName, toolResult, toolError, notFoundError, orphanedFileError, boundedRecord } from './shared.js';
import { getProjectIndex } from '../construct3/analyzers/index-builder.js';
import {
  collectInstances, collectLayers, collectSubLayers, ensureSubLayers, findLayerLocation,
} from '../construct3/layout-walk.js';
import {
  DEFAULT_INSTANCE_PROPERTIES,
  createLayout,
  createInstance,
  createLayer,
} from '../construct3/templates.js';
import type { InstanceOverrides } from '../construct3/templates.js';

/**
 * Behavior and effect names an instance of `objectType` may carry: those on
 * the object type itself plus those on every family that lists it as a member.
 * Returns undefined when the object type cannot be read (unknown type).
 */
async function definedBehaviorsAndEffects(
  reader: MutationToolDeps['reader'],
  objectType: string,
): Promise<{ behaviors: Set<string>; effects: Set<string> } | undefined> {
  let obj: Record<string, unknown>;
  try {
    obj = await reader.readObjectType(objectType) as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const names = (list: unknown): string[] => Array.isArray(list)
    ? (list as Array<{ name?: unknown }>).map(e => e.name).filter((n): n is string => typeof n === 'string')
    : [];
  const behaviors = new Set(names(obj.behaviorTypes));
  const effects = new Set(names(obj.effectTypes));
  for (const family of (await reader.readAllFamilies()).values()) {
    const members = Array.isArray(family.members) ? (family.members as string[]) : [];
    if (!members.includes(objectType)) continue;
    for (const n of names(family.behaviorTypes)) behaviors.add(n);
    for (const n of names(family.effectTypes)) effects.add(n);
  }
  return { behaviors, effects };
}

/**
 * Sampling modes accepted for a layer or layout. Construct 3 r495 projects
 * write 'auto' (inherit the project setting) at both levels; the other three
 * are the project-level sampling options Construct documents.
 */
const SAMPLING_MODES = ['auto', 'nearest', 'bilinear', 'trilinear'] as const;

/**
 * Blend modes accepted for a placed instance: the same list add_layer offers.
 * r495 omits the key for "normal" (27 instances in 5 example packages carry
 * "additive"; none carry "normal").
 */
const INSTANCE_BLEND_MODES = [
  'normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in',
  'source-out', 'destination-out', 'source-atop', 'destination-atop',
] as const;

/**
 * Copy of `record` with `key` inserted right after the first of `afterKeys`
 * it holds (or at the end), so a new key lands where Construct writes it.
 */
function insertKeyAfter(record: Record<string, unknown>, key: string, value: unknown, afterKeys: string[]): Record<string, unknown> {
  const anchor = afterKeys.find(k => k in record);
  if (anchor === undefined) return { ...record, [key]: value };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = v;
    if (k === anchor) out[key] = value;
  }
  return out;
}

/**
 * The "origin" instance property (Text, Tiled Background, 9-patch, Sprite Font,
 * SVG Picture, Drawing Canvas) and the world origin it stands for. The r495.2
 * editor recomputes world.originX/Y from this property on load (a Tiled
 * Background written with 0.5/0.5 and "top-left" came back as 0/0), and in
 * the examples the pair agrees for every Tiled Background, 9-patch, Sprite
 * Font and SVG Picture instance.
 */
const ORIGIN_GRID: Record<string, [number, number]> = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

/**
 * Plugins whose instances always carry an `origin` property. In the 30 r495.2
 * packages every one of the 165 instances of these plugins has the key
 * (TiledBg 85, Text 46, Spritefont2 13, NinePatch 12, SVGPicture 8,
 * DrawingCanvas 1), and none of the 1,148 instances of the others ever does
 * (Sprite 1078, Particles 36, Shape3D 27, Tilemap 6, Button 1). The editor
 * therefore never writes such an instance without one, so neither do we.
 */
const ORIGIN_PROPERTY_PLUGINS = new Set(['TiledBg', 'Text', 'Spritefont2', 'NinePatch', 'SVGPicture', 'DrawingCanvas']);

/**
 * The origin r495.2 itself writes for a new instance, harvested by placing one
 * with no origin set and reading the editor's own save. Only what has actually
 * been observed belongs here; usage frequency in existing projects is not a
 * default, because authors change it.
 */
const EDITOR_DEFAULT_ORIGIN: Record<string, string> = {
  DrawingCanvas: 'top-left',
};

/** The modal origin of each of those plugins in the same sample. */
const SAMPLED_ORIGIN: Record<string, string> = {
  TiledBg: 'top-left (70 of 85)', Text: 'center (21 of 46)', Spritefont2: 'center (8 of 13)',
  NinePatch: 'top-left (4 of 12)', SVGPicture: 'center (8 of 8)', DrawingCanvas: 'top-left (1 of 1)',
};

function originGridName(x: number, y: number): string | undefined {
  return Object.keys(ORIGIN_GRID).find(name => ORIGIN_GRID[name][0] === x && ORIGIN_GRID[name][1] === y);
}

/**
 * The origin of a Sprite's first frame in its initial animation. Every one of
 * the 30,223 sampled Sprite instances but one carries exactly this origin.
 */
function spriteFrameOrigin(obj: Record<string, unknown> | undefined, props: Record<string, unknown> | undefined): [number, number] | undefined {
  const items = (obj?.animations as { items?: Array<{ name?: string; frames?: Array<{ originX?: number; originY?: number }> }> } | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const initial = typeof props?.['initial-animation'] === 'string' ? props['initial-animation'] : undefined;
  const anim = items.find(a => a.name === initial) ?? items[0];
  const frame = anim.frames?.[0];
  if (typeof frame?.originX !== 'number' || typeof frame?.originY !== 'number') return undefined;
  return [frame.originX, frame.originY];
}

/**
 * Resolve a requested origin for an instance the way the editor stores it.
 * Returns the world origin to write (and the property value to set, if any),
 * or an error message.
 */
function resolveInstanceOrigin(
  pluginId: string | undefined,
  obj: Record<string, unknown> | undefined,
  props: Record<string, unknown>,
  requested: { x?: number; y?: number },
  current: { x: number; y: number },
): { x: number; y: number; property?: string; warning?: string } | { error: string } {
  if (pluginId === 'Sprite') {
    const frame = spriteFrameOrigin(obj, props);
    if (requested.x !== undefined || requested.y !== undefined) {
      if (!frame) return { x: requested.x ?? current.x, y: requested.y ?? current.y };
      if ((requested.x ?? current.x) === frame[0] && (requested.y ?? current.y) === frame[1]) {
        return { x: frame[0], y: frame[1] };
      }
      return { error: 'A Sprite instance takes its origin from its animation frame, and the editor overwrites any other value. Change the frame origin with update_frame instead.' };
    }
    return frame ? { x: frame[0], y: frame[1] } : { x: current.x, y: current.y };
  }
  const hasOriginProperty = typeof props.origin === 'string' && props.origin in ORIGIN_GRID;
  if (hasOriginProperty && requested.x === undefined && requested.y === undefined) {
    const [x, y] = ORIGIN_GRID[props.origin as string];
    return { x, y };
  }
  if (hasOriginProperty || (pluginId !== undefined && ORIGIN_PROPERTY_PLUGINS.has(pluginId))) {
    const x = requested.x ?? current.x;
    const y = requested.y ?? current.y;
    const name = originGridName(x, y);
    if (!name) {
      return { error: `This object's origin is the "origin" property, which only takes the nine grid points (${Object.entries(ORIGIN_GRID).map(([n, [gx, gy]]) => `${n} = ${gx},${gy}`).join('; ')}).` };
    }
    // An instance of one of these plugins with no origin property is a shape
    // the editor never saves, so one is always written.
    const unstated = !hasOriginProperty && requested.x === undefined && requested.y === undefined;
    if (unstated && pluginId !== undefined) {
      // Where the editor's own default has been harvested, use it.
      const harvested = EDITOR_DEFAULT_ORIGIN[pluginId];
      if (harvested) {
        const [hx, hy] = ORIGIN_GRID[harvested];
        return { x: hx, y: hy, property: harvested };
      }
      // Otherwise write the name matching the origin already stored and say
      // that the editor's default is unknown, rather than guess it.
      return { x, y, property: name, warning: `No origin given, so "${name}" was written to match the default ${x},${y}. The editor's own default for a new ${pluginId} instance is unsampled; the most common value in the sampled projects is ${SAMPLED_ORIGIN[pluginId] ?? 'unknown'}. Pass originX and originY to choose, or harvest the default from the editor.` };
    }
    return { x, y, property: name };
  }
  return { x: requested.x ?? current.x, y: requested.y ?? current.y };
}

/** The plugin id of an object type, or undefined when it cannot be read. */
async function pluginOf(reader: MutationToolDeps['reader'], objectType: string): Promise<string | undefined> {
  try {
    return (await reader.readObjectType(objectType))['plugin-id'];
  } catch {
    return undefined;
  }
}

/** Layout camera projection. Observed in r495 projects: 'perspective'. */
const LAYOUT_PROJECTIONS = ['perspective', 'orthographic'] as const;

/** Hierarchy transform-inheritance modes observed in r495: normal, wrap, all. */
const SCENE_GRAPH_MODES = ['normal', 'wrap', 'all'] as const;

/**
 * Flag defaults for a newly attached child.
 *
 * Reading of the sample (C3-ACE, Construct 3 r495): every one of the 669
 * `sceneGraphData.children[].flags` records carries exactly the keys
 * `x, y, z, w, h, d, a, o, v, sm`. `x, y, z, w, h, d, a` are `true` in all
 * 669; `o` and `v` are `false` in 598 of 669; `sm` is `"normal"` in 665 of
 * 669 (`"wrap"` in the rest, `"all"` on some root instances). The majority
 * shape is used as the fresh-child default, so opacity and visibility are NOT
 * inherited unless the caller asks for them.
 */
const DEFAULT_SCENE_GRAPH_FLAGS: SceneGraphFlags = {
  x: true, y: true, z: true, w: true, h: true, d: true, a: true,
  o: false, v: false, sm: 'normal',
};

/** Editor scratch state Construct writes next to every `sceneGraphData`. */
function createScenePreview(): SceneGraphPreview {
  return {
    transformX: 0, transformY: 0, transformZ: 0, transformW: 0,
    transformH: 0, transformD: 0, transformA: 0,
    transformSX: 0, transformSY: 0, transformSZ: 0, transformO: 0,
    previewSceneGraph: false,
  };
}

/** World instances of a layout keyed by UID (hierarchy applies to these only). */
function worldInstancesByUid(layout: Layout): Map<number, Instance> {
  const map = new Map<number, Instance>();
  for (const inst of collectInstances(layout)) {
    if (inst.world) map.set(inst.uid, inst);
  }
  return map;
}

/**
 * Move `keys` to the end of `obj`, in the order given, skipping absent ones.
 *
 * JSON key order is insertion order, and Construct writes each object's keys
 * in a fixed order, so a key added to an existing object lands after keys the
 * editor puts later. Re-inserting those trailing keys restores the editor's
 * order without rebuilding the object, which would break held references.
 */
function moveKeysToEnd(obj: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    delete obj[key];
    obj[key] = value;
  }
}

/**
 * Instance keys r495 writes after `sceneGraphData`. Confirmed against an
 * r495.2 Download-a-copy: `... behaviors, sceneGraphData, showing, locked,
 * world`, and against the r495-era sample packages for `instanceFolderItem`,
 * which sits between `sceneGraphData` and `showing` when present.
 */
const INSTANCE_KEYS_AFTER_SCENE_GRAPH_DATA = ['instanceFolderItem', 'showing', 'locked', 'world'] as const;

/** `sceneGraphData` keys r495 writes after `children`. */
const SCENE_GRAPH_KEYS_AFTER_CHILDREN = ['flags', 'preview'] as const;

/** The instance's hierarchy record, created in Construct's shape if absent. */
function ensureSceneGraphData(inst: Instance): SceneGraphData {
  if (!inst.sceneGraphData) {
    inst.sceneGraphData = {
      'parent-uid': null,
      uid: inst.uid,
      flags: { ...DEFAULT_SCENE_GRAPH_FLAGS },
      preview: createScenePreview(),
    };
    moveKeysToEnd(inst, INSTANCE_KEYS_AFTER_SCENE_GRAPH_DATA);
  }
  return inst.sceneGraphData;
}

/**
 * Detach a child from whatever parent currently lists it: clears the child's
 * `parent-uid` and removes the matching `children` entry on the parent,
 * dropping an emptied `children` array to match Construct's own shape.
 * Returns the previous parent UID, or null when it had none.
 */
function unlinkFromParent(byUid: Map<number, Instance>, child: Instance): number | null {
  const sg = child.sceneGraphData;
  if (!sg) return null;
  const parentUid = sg['parent-uid'];
  if (parentUid === null || parentUid === undefined) return null;
  const parentSg = byUid.get(parentUid)?.sceneGraphData;
  if (parentSg && Array.isArray(parentSg.children)) {
    const idx = parentSg.children.findIndex(c => c.uid === child.uid);
    if (idx !== -1) parentSg.children.splice(idx, 1);
    if (parentSg.children.length === 0) delete parentSg.children;
  }
  sg['parent-uid'] = null;
  return parentUid;
}

/** True when walking `startUid` up its `parent-uid` chain reaches `ancestorUid`. */
function hasAncestor(byUid: Map<number, Instance>, startUid: number, ancestorUid: number): boolean {
  const seen = new Set<number>();
  let current: number | null | undefined = startUid;
  while (current !== null && current !== undefined) {
    if (current === ancestorUid) return true;
    if (seen.has(current)) return false; // pre-existing loop in the file
    seen.add(current);
    current = byUid.get(current)?.sceneGraphData?.['parent-uid'] ?? null;
  }
  return false;
}

export function registerLayoutTools({ server, reader, writer, idGen }: MutationToolDeps) {
  // ─── create_layout ────────────────────────────────────────

  server.tool(
    'create_layout',
    'Create a new layout in the project',
    {
      name: z.string().max(200).describe('Layout name'),
      width: z.number().int().positive().optional().describe('Width in pixels (default: project viewport width)'),
      height: z.number().int().positive().optional().describe('Height in pixels (default: project viewport height)'),
      eventSheet: z.string().max(200).optional().describe('Linked event sheet name'),
      layers: z.array(z.string()).optional().describe('Layer names (default: single "Layer 0")'),
    },
    async (args) => {
      try {
        validateName(args.name);

        // Check uniqueness
        const existing = await reader.listLayouts();
        if (existing.includes(args.name)) {
          return toolError(`Layout "${args.name}" already exists.`);
        }

        // Validate event sheet
        if (args.eventSheet) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            return toolError(`Event sheet "${args.eventSheet}" does not exist. Use list_eventsheets to see available sheets.`);
          }
        }

        const metadata = reader.getMetadata();
        const width = args.width || metadata.viewportWidth;
        const height = args.height || metadata.viewportHeight;

        const layoutSid = await idGen.generateSid(reader);

        // Generate layer SIDs
        let layerDefs: Array<{ name: string; sid: number }>;
        if (args.layers && args.layers.length > 0) {
          layerDefs = [];
          for (const layerName of args.layers) {
            layerDefs.push({ name: layerName, sid: await idGen.generateSid(reader) });
          }
        } else {
          const layerSid = await idGen.generateSid(reader);
          layerDefs = [{ name: 'Layer 0', sid: layerSid }];
        }

        const data = createLayout(args.name, layoutSid, width, height, args.eventSheet, layerDefs);

        await writer.writeEntityFile('layouts', args.name, data);
        await writer.addToProject('layouts', args.name);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'created',
          generatedSid: layoutSid,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[create_layout] failed:', error);
        return toolError(`Error creating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_instance_to_layout ───────────────────────────────

  server.tool(
    'add_instance_to_layout',
    'Place an object instance on a layout layer. For copying instances between layouts, read the source with get_layout_details and pass instance properties here — all visual and behavioral properties (angle, color, instanceVariables, behaviors, etc.) are preserved when specified.',
    {
      layoutName: z.string().max(200).describe('Target layout'),
      layerName: z.string().max(200).describe('Target layer within layout'),
      objectType: z.string().max(200).describe('Object type name to place'),
      x: z.number().describe('X position'),
      y: z.number().describe('Y position'),
      width: z.number().optional().default(100).describe('Instance width'),
      height: z.number().optional().default(100).describe('Instance height'),
      properties: boundedRecord()
        .refine(obj => JSON.stringify(obj).length <= 50_000, 'Properties payload too large (max 50KB)')
        .optional()
        .describe('Plugin-specific instance properties — auto-filled for known plugins if omitted (max 100 keys, depth 6)'),
      // Instance-level overrides
      angle: z.number().optional().describe('Rotation angle in radians (default: 0)'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('RGBA tint as [r, g, b, a] with values 0-1 (default: [1,1,1,1])'),
      zElevation: z.number().optional().describe('Z elevation for 3D layering (default: 0)'),
      originX: z.number().min(0).max(1).optional().describe('Horizontal origin 0-1 (default: 0.5 = center)'),
      originY: z.number().min(0).max(1).optional().describe('Vertical origin 0-1 (default: 0.5 = center)'),
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
        .describe('Instance variable values as {varName: value}'),
      behaviors: z.record(z.string(), boundedRecord())
        .refine(obj => Object.keys(obj).length <= 50, 'Too many behaviors (max 50)')
        .refine(obj => JSON.stringify(obj).length <= 50_000, 'Behaviors payload too large (max 50KB)')
        .optional()
        .describe('Behavior runtime state as {behaviorName: {prop: val}} (each behavior props: max 100 keys, depth 6)'),
      tags: z.string().max(500).regex(/^[a-zA-Z0-9_, ]*$/).optional()
        .describe('Comma-separated instance tags (default: empty)'),
      showing: z.boolean().optional().describe('Whether instance is initially visible (default: true)'),
      locked: z.boolean().optional().describe('Whether instance is locked in the editor (default: false)'),
    },
    async (args) => {
      try {
        // Validate object type exists and read its plugin ID
        let pluginId: string | undefined;
        let isNonworld = false;
        let objData: import('../construct3/types.js').ObjectType | undefined;
        try {
          const obj = await reader.readObjectType(args.objectType);
          objData = obj;
          pluginId = obj['plugin-id'];
          // Block global-only objects from being placed on layouts
          if (obj['singleglobal-inst']) {
            return toolError(`Object "${args.objectType}" is a global plugin (${pluginId}) and cannot be placed on layouts.`);
          }
          // Nonworld-global objects (Arr, Json, Dictionary) go in nonworld-instances, not on layers
          if (obj.isGlobal === true) {
            isNonworld = true;
          }
        } catch {
          return toolError(`Object type "${args.objectType}" does not exist. Use list_objects to see available objects.`);
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const uid = await idGen.generateUid(reader);
        const sid = await idGen.generateSid(reader);
        const warnings: string[] = [];

        // Validate instanceVariables keys against object type definition
        if (args.instanceVariables && objData) {
          const definedVars = new Set((objData.instanceVariables ?? []).map(v => v.name));
          for (const key of Object.keys(args.instanceVariables)) {
            if (!definedVars.has(key)) {
              warnings.push(`Instance variable "${key}" is not defined on "${args.objectType}". Defined variables: ${[...definedVars].join(', ') || '(none)'}. It may be inherited from a family.`);
            }
          }
        }

        // Validate behaviors keys against object type definition
        if (args.behaviors && objData) {
          const definedBehaviors = new Set((objData.behaviorTypes ?? []).map(b => b.name));
          for (const key of Object.keys(args.behaviors)) {
            if (!definedBehaviors.has(key)) {
              warnings.push(`Behavior "${key}" is not defined on "${args.objectType}". Defined behaviors: ${[...definedBehaviors].join(', ') || '(none)'}. It may be inherited from a family.`);
            }
          }
        }

        // Build overrides from optional params
        const overrides: InstanceOverrides = {};
        if (args.angle !== undefined) overrides.angle = args.angle;
        if (args.color !== undefined) overrides.color = args.color;
        if (args.zElevation !== undefined) overrides.zElevation = args.zElevation;
        if (args.originX !== undefined) overrides.originX = args.originX;
        if (args.originY !== undefined) overrides.originY = args.originY;
        if (args.instanceVariables !== undefined) overrides.instanceVariables = args.instanceVariables;
        if (args.behaviors !== undefined) overrides.behaviors = args.behaviors;
        if (args.tags !== undefined) overrides.tags = args.tags;
        if (args.showing !== undefined) overrides.showing = args.showing;
        if (args.locked !== undefined) overrides.locked = args.locked;
        const hasOverrides = Object.keys(overrides).length > 0;

        if (isNonworld) {
          if (!layout['nonworld-instances']) layout['nonworld-instances'] = [];
          layout['nonworld-instances'].push({
            type: args.objectType,
            properties: args.properties ?? {},
            uid,
            sid,
            tags: overrides.tags ?? '',
            instanceVariables: overrides.instanceVariables ?? {},
            behaviors: overrides.behaviors ?? {},
            showing: overrides.showing ?? true,
            locked: overrides.locked ?? false,
          });
          warnings.push(`"${args.objectType}" is a global (nonworld) object — placed in nonworld-instances instead of on a layer. Layer and position parameters were ignored.`);
        } else {
          // Sub-layers hold instances too.
          const targetLayer = collectLayers(layout).find(l => l.name === args.layerName);
          if (!targetLayer) {
            const layerNames = collectLayers(layout).map(l => l.name).join(', ');
            return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${layerNames}`);
          }

          // Copied, not aliased: the instance keeps this object, so handing out
          // the shared table would let a later edit of one instance change the
          // template and every other instance of the same plugin.
          const defaults = pluginId ? DEFAULT_INSTANCE_PROPERTIES[pluginId] : undefined;
          const pluginProps = args.properties ?? (defaults ? { ...defaults } : {});

          if (!args.properties && pluginId && !DEFAULT_INSTANCE_PROPERTIES[pluginId]) {
            warnings.push(`No default instance properties known for plugin "${pluginId}". Instance created with empty properties — you may need to configure them in the C3 editor.`);
          }

          const instance = createInstance(
            args.objectType, uid, sid, args.x, args.y, args.width, args.height,
            pluginProps,
            hasOverrides ? overrides : undefined,
          );
          if (instance.world) {
            const origin = resolveInstanceOrigin(
              pluginId, objData as unknown as Record<string, unknown> | undefined, instance.properties,
              { x: args.originX, y: args.originY },
              { x: instance.world.originX ?? 0.5, y: instance.world.originY ?? 0.5 },
            );
            if ('error' in origin) return toolError(origin.error);
            instance.world.originX = origin.x;
            instance.world.originY = origin.y;
            if (origin.property) instance.properties = { ...instance.properties, origin: origin.property };
            if (origin.warning) warnings.push(origin.warning);
          }

          targetLayer.instances.push(instance);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          generatedSid: sid,
          generatedUid: uid,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_instance_to_layout] failed:', error);
        return toolError(`Error adding instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_layout ────────────────────────────────────────

  server.tool(
    'delete_layout',
    'Delete a layout from the project (checks references first)',
    {
      name: z.string().max(200).describe('Layout name to delete'),
      force: z.boolean().optional().default(false).describe('If true, delete even if referenced (does NOT clean up references)'),
    },
    async (args) => {
      try {
        // Verify the layout exists
        const existing = await reader.listLayouts();
        if (!existing.includes(args.name)) {
          return notFoundError('Layout', args.name, reader.findNearestName(args.name, 'layouts'), 'list_layouts');
        }

        // Block deletion of the startup layout unconditionally
        const metadata = reader.getMetadata();
        if (metadata.firstLayout === args.name) {
          return toolError(`Cannot delete "${args.name}" — it is the project's startup layout (firstLayout). Change the startup layout in project settings first.`);
        }

        // Check references via project index
        const index = await getProjectIndex(reader);

        const warnings: string[] = [];

        // Warn about bound event sheet
        const boundSheet = index.layoutToEventSheet.get(args.name);
        if (boundSheet) {
          warnings.push(`Layout was bound to event sheet "${boundSheet}". The event sheet was NOT deleted.`);
        }

        // Warn about objects placed on this layout
        const placedObjects: string[] = [];
        for (const [objName, layouts] of index.objectToLayouts) {
          if (layouts.includes(args.name)) {
            placedObjects.push(objName);
          }
        }
        if (placedObjects.length > 0) {
          warnings.push(`Objects placed on this layout: ${placedObjects.join(', ')}. Instances were removed with the layout file.`);
        }

        if (!args.force && (placedObjects.length > 0 || boundSheet)) {
          return toolResult({
            success: false,
            entity: args.name,
            category: 'layout',
            action: 'delete_blocked',
            message: 'Layout has associated data. Use force=true to delete anyway.',
            references: {
              boundEventSheet: boundSheet || null,
              placedObjects,
            },
          });
        }

        // Capture the subfolder first: removeFromProject reloads project.c3proj,
        // after which the name is no longer resolvable.
        const subfolder = writer.getSubfolderForEntity('layouts', args.name);
        // Deregister before deleting the file. A failure in the second step
        // then leaves an orphaned file (info-level) instead of a dangling
        // registration (a file-existence error).
        await writer.removeFromProject('layouts', args.name);
        let backupPath: string;
        try {
          backupPath = await writer.deleteEntityFile('layouts', args.name, subfolder);
        } catch (error) {
          console.error('[delete_layout] file delete failed after deregistration:', error);
          return orphanedFileError('layouts', args.name, subfolder, error);
        }

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'deleted',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_layout] failed:', error);
        return toolError(`Error deleting layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_layout ────────────────────────────────────────

  server.tool(
    'update_layout',
    'Update layout properties (event sheet binding, dimensions, scrolling, sampling, projection, viewport anchor)',
    {
      name: z.string().max(200).describe('Layout name to update'),
      eventSheet: z.string().max(200).optional().describe('New event sheet binding (validated for existence)'),
      width: z.number().int().positive().optional().describe('New layout width in pixels'),
      height: z.number().int().positive().optional().describe('New layout height in pixels'),
      unboundedScrolling: z.boolean().optional().describe('Allow scrolling beyond the layout bounds'),
      sampling: z.enum(SAMPLING_MODES).optional().describe("Layout sampling; 'auto' inherits the project setting"),
      projection: z.enum(LAYOUT_PROJECTIONS).optional().describe('Camera projection'),
      vpX: z.number().optional().describe('Viewport anchor X, 0-1 (Construct writes 0.5)'),
      vpY: z.number().optional().describe('Viewport anchor Y, 0-1 (Construct writes 0.5)'),
    },
    async (args) => {
      try {
        // Check at least one update is provided
        const hasLayoutUpdates = args.eventSheet !== undefined || args.width !== undefined ||
          args.height !== undefined || args.unboundedScrolling !== undefined ||
          args.sampling !== undefined || args.projection !== undefined ||
          args.vpX !== undefined || args.vpY !== undefined;
        if (!hasLayoutUpdates) {
          return toolError('No updates provided. Specify at least one of: eventSheet, width, height, unboundedScrolling, sampling, projection, vpX, vpY.');
        }

        // Read existing layout
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.name);
        } catch {
          return notFoundError('Layout', args.name, reader.findNearestName(args.name, 'layouts'), 'list_layouts');
        }

        const warnings: string[] = [];

        // Validate and apply event sheet binding
        if (args.eventSheet !== undefined) {
          const sheets = await reader.listEventSheets();
          if (!sheets.includes(args.eventSheet)) {
            return notFoundError('Event sheet', args.eventSheet, reader.findNearestName(args.eventSheet, 'eventsheets'), 'list_eventsheets');
          }
          layout.eventSheet = args.eventSheet;
        }

        // Apply dimension and view updates
        if (args.width !== undefined) layout.width = args.width;
        if (args.height !== undefined) layout.height = args.height;
        if (args.unboundedScrolling !== undefined) layout.unboundedScrolling = args.unboundedScrolling;
        if (args.sampling !== undefined) layout.sampling = args.sampling;
        if (args.projection !== undefined) layout.projection = args.projection;
        if (args.vpX !== undefined) layout.vpX = args.vpX;
        if (args.vpY !== undefined) layout.vpY = args.vpY;

        // Write back
        const subfolder = writer.getSubfolderForEntity('layouts', args.name);
        const backupPath = await writer.writeEntityFile('layouts', args.name, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.name,
          category: 'layout',
          action: 'updated',
          warnings: warnings.length > 0 ? warnings : undefined,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_layout] failed:', error);
        return toolError(`Error updating layout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_layer ────────────────────────────────────────────

  server.tool(
    'add_layer',
    'Add a new layer to an existing layout, optionally as a sub-layer of another layer',
    {
      layoutName: z.string().max(200).describe('Layout to add the layer to'),
      layerName: z.string().max(200).describe('New layer name (must be unique across every layer of the layout, sub-layers included)'),
      parentLayer: z.string().max(200).optional().describe("Create the layer inside this layer's subLayers (default: top level)"),
      index: z.number().int().min(0).optional().describe('Insert at this position among its siblings (0 = bottom, default: append to top)'),
      isInitiallyVisible: z.boolean().optional().default(true).describe('Layer starts visible (default: true)'),
      isTransparent: z.boolean().optional().default(true).describe('Layer is transparent (default: true)'),
      parallaxX: z.number().optional().default(1).describe('Horizontal parallax rate (default: 1)'),
      parallaxY: z.number().optional().default(1).describe('Vertical parallax rate (default: 1)'),
      blendMode: z.enum(['normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop']).optional().default('normal').describe('Blend mode (default: normal)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Layer names must be unique across the whole layout, sub-layers included
        if (collectLayers(layout).some(l => l.name === args.layerName)) {
          return toolError(`Layer "${args.layerName}" already exists in layout "${args.layoutName}".`);
        }

        // Resolve the sibling list: a parent layer's subLayers, or the top level
        let siblings: Layer[] = layout.layers;
        if (args.parentLayer !== undefined) {
          const parentLocation = findLayerLocation(layout, args.parentLayer);
          if (!parentLocation) {
            const available = collectLayers(layout).map(l => l.name).join(', ');
            return toolError(`Parent layer "${args.parentLayer}" not found in layout "${args.layoutName}". Available layers: ${available}`);
          }
          siblings = ensureSubLayers(parentLocation.layer);
        }

        const layerSid = await idGen.generateSid(reader);
        const newLayer: Layer = {
          ...createLayer(args.layerName, layerSid),
          isInitiallyVisible: args.isInitiallyVisible,
          isTransparent: args.isTransparent,
          parallaxX: args.parallaxX,
          parallaxY: args.parallaxY,
          blendMode: args.blendMode,
        };

        if (args.index !== undefined) {
          siblings.splice(args.index, 0, newLayer);
        } else {
          siblings.push(newLayer);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          generatedSid: layerSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_layer] failed:', error);
        return toolError(`Error adding layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_layer ─────────────────────────────────────────

  server.tool(
    'delete_layer',
    'Delete a layer from a layout (must not be the last layer)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to delete'),
      force: z.boolean().optional().default(false).describe('Delete even if the layer contains instances (instances will be lost)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const layerIdx = layout.layers.findIndex(l => l.name === args.layerName);
        if (layerIdx === -1) {
          const available = layout.layers.map(l => l.name).join(', ');
          return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${available}`);
        }

        // Prevent deleting the last layer
        if (layout.layers.length <= 1) {
          return toolError(`Cannot delete the last layer in layout "${args.layoutName}". A layout must have at least one layer.`);
        }

        const layer = layout.layers[layerIdx];
        const instanceCount = layer.instances.length;

        if (instanceCount > 0 && !args.force) {
          return toolResult({
            success: false,
            entity: args.layoutName,
            category: 'layout',
            action: 'delete_blocked',
            message: `Layer "${args.layerName}" contains ${instanceCount} instance(s). Use force=true to delete the layer and all its instances.`,
            instanceCount,
          });
        }

        layout.layers.splice(layerIdx, 1);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: instanceCount > 0 ? [`Deleted layer contained ${instanceCount} instance(s) — they have been removed.`] : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_layer] failed:', error);
        return toolError(`Error deleting layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_layer ─────────────────────────────────────────

  server.tool(
    'update_layer',
    'Update properties of an existing layer, at the top level or nested in another layer (name, visibility, parallax, blend mode, color, sampling, render settings)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer name to update (searched at every nesting level)'),
      newName: z.string().max(200).optional().describe('Rename the layer'),
      isInitiallyVisible: z.boolean().optional().describe('Change initial visibility'),
      isInitiallyInteractive: z.boolean().optional().describe('Change initial interactivity'),
      isTransparent: z.boolean().optional().describe('Change transparency'),
      parallaxX: z.number().optional().describe('Horizontal parallax rate'),
      parallaxY: z.number().optional().describe('Vertical parallax rate'),
      blendMode: z.enum(['normal', 'additive', 'xor', 'copy', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop']).optional().describe('Blend mode'),
      scaleRate: z.number().optional().describe('Scale rate (parallax zoom)'),
      zElevation: z.number().optional().describe('Z elevation for 3D layering'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('Layer tint as RGBA [r,g,b,a], values 0-1'),
      backgroundColor: z.array(z.number().min(0).max(1)).length(4).optional().describe('Background color as RGBA [r,g,b,a], values 0-1 (used when the layer is not transparent)'),
      global: z.boolean().optional().describe('Make the layer global (shared across layouts)'),
      isHTMLElementsLayer: z.boolean().optional().describe('Mark the layer as the HTML elements layer'),
      sampling: z.enum(SAMPLING_MODES).optional().describe('Layer sampling; "auto" inherits the project setting'),
      renderingMode: z.string().max(50).optional().describe('Rendering mode; Construct 3 r495 projects write "3d"'),
      forceOwnTexture: z.boolean().optional().describe('Render the layer to its own texture'),
      useRenderCells: z.boolean().optional().describe('Use render cells for culling'),
      drawOrder: z.string().max(50).optional().describe('Draw order; Construct 3 r495 projects write "z-order"'),
    },
    async (args) => {
      try {
        const hasUpdates = args.newName !== undefined || args.isInitiallyVisible !== undefined ||
          args.isInitiallyInteractive !== undefined || args.isTransparent !== undefined ||
          args.parallaxX !== undefined || args.parallaxY !== undefined ||
          args.blendMode !== undefined || args.scaleRate !== undefined || args.zElevation !== undefined ||
          args.color !== undefined || args.backgroundColor !== undefined || args.global !== undefined ||
          args.isHTMLElementsLayer !== undefined || args.sampling !== undefined ||
          args.renderingMode !== undefined || args.forceOwnTexture !== undefined ||
          args.useRenderCells !== undefined || args.drawOrder !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: newName, isInitiallyVisible, isInitiallyInteractive, isTransparent, parallaxX, parallaxY, blendMode, scaleRate, zElevation, color, backgroundColor, global, isHTMLElementsLayer, sampling, renderingMode, forceOwnTexture, useRenderCells, drawOrder.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Layers nest through subLayers; search every level.
        const allLayers = collectLayers(layout);
        const layer = allLayers.find(l => l.name === args.layerName);
        if (!layer) {
          const available = allLayers.map(l => l.name).join(', ');
          return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${available}`);
        }

        // Check new name uniqueness across every layer, sub-layers included
        if (args.newName !== undefined && args.newName !== args.layerName) {
          if (allLayers.some(l => l.name === args.newName)) {
            return toolError(`Layer "${args.newName}" already exists in layout "${args.layoutName}".`);
          }
          layer.name = args.newName;
        }

        if (args.isInitiallyVisible !== undefined) layer.isInitiallyVisible = args.isInitiallyVisible;
        if (args.isInitiallyInteractive !== undefined) layer.isInitiallyInteractive = args.isInitiallyInteractive;
        if (args.isTransparent !== undefined) layer.isTransparent = args.isTransparent;
        if (args.parallaxX !== undefined) layer.parallaxX = args.parallaxX;
        if (args.parallaxY !== undefined) layer.parallaxY = args.parallaxY;
        if (args.blendMode !== undefined) layer.blendMode = args.blendMode;
        if (args.scaleRate !== undefined) layer.scaleRate = args.scaleRate;
        if (args.zElevation !== undefined) layer.zElevation = args.zElevation;
        if (args.color !== undefined) layer.color = args.color;
        if (args.backgroundColor !== undefined) layer.backgroundColor = args.backgroundColor;
        if (args.global !== undefined) layer.global = args.global;
        if (args.isHTMLElementsLayer !== undefined) layer.isHTMLElementsLayer = args.isHTMLElementsLayer;
        if (args.sampling !== undefined) layer.sampling = args.sampling;
        if (args.renderingMode !== undefined) layer.renderingMode = args.renderingMode;
        if (args.forceOwnTexture !== undefined) layer.forceOwnTexture = args.forceOwnTexture;
        if (args.useRenderCells !== undefined) layer.useRenderCells = args.useRenderCells;
        if (args.drawOrder !== undefined) layer.drawOrder = args.drawOrder;

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_layer] failed:', error);
        return toolError(`Error updating layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── reorder_layers ───────────────────────────────────────

  server.tool(
    'reorder_layers',
    'Reorder one nesting level of a layout: pass every sibling name in the new bottom-to-top order',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerNames: z.array(z.string().max(200)).min(1).max(500).describe('Every layer at that level, in the new order (index 0 = bottom)'),
      parentLayer: z.string().max(200).optional().describe('Reorder this layer\'s sub-layers instead of the top-level layers'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        let siblings: Layer[] = layout.layers;
        let scope = `layout "${args.layoutName}"`;
        if (args.parentLayer !== undefined) {
          const parentLocation = findLayerLocation(layout, args.parentLayer);
          if (!parentLocation) {
            const available = collectLayers(layout).map(l => l.name).join(', ');
            return toolError(`Parent layer "${args.parentLayer}" not found in layout "${args.layoutName}". Available layers: ${available}`);
          }
          siblings = ensureSubLayers(parentLocation.layer);
          scope = `the sub-layers of "${args.parentLayer}"`;
        }

        // The new order must be a full permutation of that level: a partial
        // list would silently drop or duplicate layers on write.
        const current = siblings.map(l => l.name);
        const duplicates = args.layerNames.filter((n, i) => args.layerNames.indexOf(n) !== i);
        if (duplicates.length > 0) {
          return toolError(`Duplicate layer name(s) in layerNames: ${[...new Set(duplicates)].join(', ')}.`);
        }
        const unknown = args.layerNames.filter(n => !current.includes(n));
        const missing = current.filter(n => !args.layerNames.includes(n));
        if (unknown.length > 0 || missing.length > 0) {
          const parts: string[] = [];
          if (unknown.length > 0) parts.push(`not at this level: ${unknown.join(', ')}`);
          if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
          return toolError(
            `layerNames must list every layer of ${scope} exactly once (${parts.join('; ')}). ` +
            `Current order: ${current.join(', ')}.`
          );
        }

        const reordered = args.layerNames.map(name => siblings.find(l => l.name === name)!);
        siblings.splice(0, siblings.length, ...reordered);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[reorder_layers] failed:', error);
        return toolError(`Error reordering layers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_layer ───────────────────────────────────────────

  server.tool(
    'move_layer',
    'Move a layer to another nesting level of the same layout (into a layer\'s sub-layers, or back to the top level)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      layerName: z.string().max(200).describe('Layer to move (searched at every nesting level)'),
      parentLayer: z.string().max(200).nullable().optional().describe('Destination parent layer; null or omitted moves the layer to the top level'),
      index: z.number().int().min(0).optional().describe('Position among the destination siblings after removal (default: append to top)'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const location = findLayerLocation(layout, args.layerName);
        if (!location) {
          const available = collectLayers(layout).map(l => l.name).join(', ');
          return toolError(`Layer "${args.layerName}" not found in layout "${args.layoutName}". Available layers: ${available}`);
        }

        const parentName = args.parentLayer ?? undefined;

        if (parentName === args.layerName) {
          return toolError(`Cannot move layer "${args.layerName}" into itself.`);
        }

        let target: Layer[];
        let destination: string;
        if (parentName === undefined) {
          target = layout.layers;
          destination = 'the top level';
        } else {
          const parentLocation = findLayerLocation(layout, parentName);
          if (!parentLocation) {
            const available = collectLayers(layout).map(l => l.name).join(', ');
            return toolError(`Parent layer "${parentName}" not found in layout "${args.layoutName}". Available layers: ${available}`);
          }
          // A layer cannot become a child of one of its own descendants: that
          // would detach the whole branch from the layout.
          if (collectSubLayers(location.layer).some(l => l.name === parentName)) {
            return toolError(`Cannot move layer "${args.layerName}" into "${parentName}", which is one of its own sub-layers.`);
          }
          target = ensureSubLayers(parentLocation.layer);
          destination = `the sub-layers of "${parentName}"`;
        }

        // A layout must keep at least one top-level layer.
        if (location.parent === undefined && parentName !== undefined && layout.layers.length <= 1) {
          return toolError(`Cannot move layer "${args.layerName}": it is the only top-level layer in layout "${args.layoutName}", and a layout must have at least one.`);
        }

        location.siblings.splice(location.index, 1);
        const insertAt = args.index === undefined ? target.length : Math.min(args.index, target.length);
        target.splice(insertAt, 0, location.layer);

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Moved layer "${args.layerName}" to ${destination} at index ${insertAt}.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[move_layer] failed:', error);
        return toolError(`Error moving layer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_instance_from_layout ─────────────────────────

  server.tool(
    'delete_instance_from_layout',
    'Remove a placed object instance from a layout by its UID',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to remove'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Hierarchy links point at UIDs; detach the instance from its parent
        // and its children from it before it goes.
        const byUidBefore = worldInstancesByUid(layout);
        const target = byUidBefore.get(args.uid);
        const detachedChildren: number[] = [];
        if (target) {
          unlinkFromParent(byUidBefore, target);
          for (const child of target.sceneGraphData?.children ?? []) {
            const childInst = byUidBefore.get(child.uid);
            if (childInst?.sceneGraphData && childInst.sceneGraphData['parent-uid'] === args.uid) {
              childInst.sceneGraphData['parent-uid'] = null;
              detachedChildren.push(child.uid);
            }
          }
        }

        // Search every layer, sub-layers included
        let found = false;
        let removedType: string | undefined;

        for (const layer of collectLayers(layout)) {
          if (!Array.isArray(layer.instances)) continue;
          const idx = layer.instances.findIndex(inst => inst.uid === args.uid);
          if (idx !== -1) {
            removedType = layer.instances[idx].type;
            layer.instances.splice(idx, 1);
            found = true;
            break;
          }
        }

        // Search nonworld-instances
        if (!found) {
          const nonworld = layout['nonworld-instances'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(nonworld)) {
            const idx = nonworld.findIndex(inst => inst.uid === args.uid);
            if (idx !== -1) {
              removedType = nonworld[idx].type as string;
              nonworld.splice(idx, 1);
              found = true;
            }
          }
        }

        if (!found) {
          return toolError(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: removedType
            ? [
              `Removed instance of "${removedType}" (UID ${args.uid}).`,
              ...(detachedChildren.length > 0 ? [`Detached its hierarchy children: ${detachedChildren.join(', ')}.`] : []),
            ]
            : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_instance_from_layout] failed:', error);
        return toolError(`Error deleting instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── update_instance ─────────────────────────────────────

  server.tool(
    'update_instance',
    'Update properties of a placed instance on a layout (position, size, angle, visibility, etc.)',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the instance to update'),
      x: z.number().optional().describe('New X position'),
      y: z.number().optional().describe('New Y position'),
      width: z.number().optional().describe('New width'),
      height: z.number().optional().describe('New height'),
      angle: z.number().optional().describe('New rotation angle in radians'),
      zElevation: z.number().optional().describe('New Z elevation'),
      color: z.array(z.number().min(0).max(1)).length(4).optional().describe('New RGBA tint [r,g,b,a] values 0-1'),
      originX: z.number().min(-100).max(100).optional().describe('Instance origin X as a fraction of its width (0 = left, 0.5 = center, 1 = right)'),
      originY: z.number().min(-100).max(100).optional().describe('Instance origin Y as a fraction of its height (0 = top, 0.5 = center, 1 = bottom)'),
      blendMode: z.enum(INSTANCE_BLEND_MODES).optional().describe('Instance blend mode; "normal" removes the stored value, as Construct does'),
      depth: z.number().min(0).optional().describe('3D depth of the instance (3D Shape); written as world.depth'),
      showing: z.boolean().optional().describe('Initial visibility'),
      locked: z.boolean().optional().describe('Locked in editor'),
      tags: z.string().max(500).optional().describe('Comma-separated tags'),
      instanceVariables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Instance variable values to update'),
      properties: boundedRecord(100, 4).optional().describe('Plugin property values to merge (e.g. Text "text", iframe "url", Tilemap "tile-width"); keys are the plugin\'s property IDs'),
      behaviors: z.record(z.string(), z.object({
        properties: boundedRecord(100, 4).describe('Behavior property values to merge'),
      })).refine(obj => Object.keys(obj).length <= 50, 'Too many behaviors (max 50)').optional()
        .describe('Per-instance behavior settings keyed by behavior name, e.g. { "Platform": { "properties": { "max-speed": 330 } } }'),
      effects: z.record(z.string(), z.object({
        isEnabled: z.boolean().optional().describe('Enable or disable this effect on the instance'),
        parameters: boundedRecord(50, 3).optional().describe('Effect parameter values to merge'),
      })).refine(obj => Object.keys(obj).length <= 50, 'Too many effects (max 50)').optional()
        .describe('Per-instance effect state keyed by effect name, as defined on the object type or its family'),
    },
    async (args) => {
      try {
        const hasUpdates = args.x !== undefined || args.y !== undefined || args.width !== undefined ||
          args.height !== undefined || args.angle !== undefined || args.zElevation !== undefined ||
          args.color !== undefined || args.originX !== undefined || args.originY !== undefined ||
          args.blendMode !== undefined || args.depth !== undefined ||
          args.showing !== undefined || args.locked !== undefined ||
          args.tags !== undefined || args.instanceVariables !== undefined ||
          args.properties !== undefined || args.behaviors !== undefined || args.effects !== undefined;

        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one property to update.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        // Instances live in nested layers and in nonworld-instances alike.
        const inst: Instance | undefined = collectInstances(layout).find(i => i.uid === args.uid);
        if (!inst) {
          return toolError(`Instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }

        const warnings: string[] = [];

        // Behavior and effect names must be defined on the object type or on a
        // family it belongs to; a stray effect key would fail the editor load.
        if (args.behaviors || args.effects) {
          const defined = await definedBehaviorsAndEffects(reader, inst.type);
          if (args.behaviors && defined) {
            for (const key of Object.keys(args.behaviors)) {
              if (!defined.behaviors.has(key)) {
                warnings.push(`Behavior "${key}" is not defined on "${inst.type}" or its families. Defined behaviors: ${[...defined.behaviors].join(', ') || '(none)'}.`);
              }
            }
          }
          if (args.effects && defined) {
            const unknown = Object.keys(args.effects).filter(key => !defined.effects.has(key));
            if (unknown.length > 0) {
              return toolError(`Effect(s) ${unknown.map(k => `"${k}"`).join(', ')} are not defined on "${inst.type}" or its families. Add them with add_effect first. Defined effects: ${[...defined.effects].join(', ') || '(none)'}.`);
            }
          }
        }

        // World properties apply only to world instances.
        if (inst.world) {
          if (args.x !== undefined) inst.world.x = args.x;
          if (args.y !== undefined) inst.world.y = args.y;
          if (args.width !== undefined) inst.world.width = args.width;
          if (args.height !== undefined) inst.world.height = args.height;
          if (args.angle !== undefined) inst.world.angle = args.angle;
          if (args.zElevation !== undefined) {
            // Older saves store the value as zElevation (the r424 examples),
            // newer ones as z (r476 and r495). Keep whichever key the
            // instance already has.
            if ('zElevation' in inst.world && !('z' in inst.world)) inst.world.zElevation = args.zElevation;
            else inst.world.z = args.zElevation;
          }
          if (args.color !== undefined) inst.world.color = args.color;
          const originProperty = args.properties && typeof args.properties.origin === 'string' ? args.properties.origin : undefined;
          if (args.originX !== undefined || args.originY !== undefined || originProperty !== undefined) {
            let obj: Record<string, unknown> | undefined;
            try {
              obj = await reader.readObjectType(inst.type) as unknown as Record<string, unknown>;
            } catch {
              obj = undefined;
            }
            const origin = resolveInstanceOrigin(
              typeof obj?.['plugin-id'] === 'string' ? obj['plugin-id'] as string : undefined,
              obj, { ...(inst.properties ?? {}), ...(args.properties ?? {}) },
              { x: args.originX, y: args.originY },
              { x: inst.world.originX ?? 0.5, y: inst.world.originY ?? 0.5 },
            );
            if ('error' in origin) return toolError(origin.error);
            if (origin.property && originProperty !== undefined && origin.property !== originProperty) {
              return toolError(`properties.origin "${originProperty}" and originX/originY (${origin.x}, ${origin.y} = "${origin.property}") disagree; give one of them.`);
            }
            inst.world.originX = origin.x;
            inst.world.originY = origin.y;
            if (origin.property) inst.properties = { ...(inst.properties ?? {}), origin: origin.property };
            if (origin.warning) warnings.push(origin.warning);
          }
          if (args.depth !== undefined) {
            if (!('depth' in inst.world)) {
              inst.world = insertKeyAfter(inst.world, 'depth', args.depth, ['zElevation', 'z']) as typeof inst.world;
            } else {
              inst.world.depth = args.depth;
            }
            const plugin = await pluginOf(reader, inst.type);
            if (plugin !== undefined && plugin !== 'Shape3D') {
              warnings.push(`Depth is a 3D Shape property; "${inst.type}" uses the ${plugin} plugin, which may ignore it.`);
            }
          }
          if (args.blendMode !== undefined) {
            if (args.blendMode === 'normal') delete inst.world.blendMode;
            else inst.world.blendMode = args.blendMode;
          }
        } else {
          const ignoredWorldProps = [
            args.x, args.y, args.width, args.height, args.angle, args.zElevation, args.color,
            args.originX, args.originY, args.blendMode, args.depth,
          ].filter(v => v !== undefined);
          if (ignoredWorldProps.length > 0) {
            warnings.push(`Instance ${args.uid} is a non-world instance; position, size, angle, Z elevation, color, origin, blend mode and depth were ignored.`);
          }
        }
        if (args.showing !== undefined) inst.showing = args.showing;
        if (args.locked !== undefined) inst.locked = args.locked;
        if (args.tags !== undefined) inst.tags = args.tags;
        if (args.instanceVariables !== undefined) {
          inst.instanceVariables = { ...(inst.instanceVariables ?? {}), ...args.instanceVariables };
        }
        if (args.properties !== undefined) {
          inst.properties = { ...(inst.properties ?? {}), ...args.properties };
        }
        if (args.behaviors !== undefined) {
          const behaviors = (inst.behaviors ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
          for (const [name, update] of Object.entries(args.behaviors)) {
            const existing = behaviors[name] ?? { properties: {} };
            behaviors[name] = { ...existing, properties: { ...(existing.properties ?? {}), ...update.properties } };
          }
          inst.behaviors = behaviors;
        }
        if (args.effects !== undefined) {
          const instRecord = inst as Record<string, unknown>;
          const effects = (instRecord.effects && typeof instRecord.effects === 'object'
            ? instRecord.effects
            : {}) as Record<string, { isEnabled?: boolean; parameters?: Record<string, unknown> }>;
          for (const [name, update] of Object.entries(args.effects)) {
            const existing = effects[name] ?? { isEnabled: true, parameters: {} };
            effects[name] = {
              ...existing,
              isEnabled: update.isEnabled ?? existing.isEnabled ?? true,
              parameters: { ...(existing.parameters ?? {}), ...(update.parameters ?? {}) },
            };
          }
          instRecord.effects = effects;
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_instance] failed:', error);
        return toolError(`Error updating instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── move_instance ───────────────────────────────────────

  server.tool(
    'move_instance',
    'Move a placed world instance to another layer and/or change its Z order within its layer (the editor\'s "Move to layer", "Move to top/bottom" and Z Order Bar drag). A layer\'s instances are stored bottom to top.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      uid: z.number().int().describe('UID of the world instance to move'),
      toLayer: z.string().max(200).optional().describe('Destination layer (any depth); default: the instance\'s current layer'),
      position: z.union([z.enum(['top', 'bottom']), z.number().int().min(0)]).optional()
        .describe('Z position in the destination layer: "top", "bottom", or a 0-based index counted from the bottom. Default: top when changing layer'),
      aboveUid: z.number().int().optional().describe('Place the instance directly above this instance (same destination layer)'),
      belowUid: z.number().int().optional().describe('Place the instance directly below this instance (same destination layer)'),
    },
    async (args) => {
      try {
        const placements = [args.position !== undefined, args.aboveUid !== undefined, args.belowUid !== undefined].filter(Boolean).length;
        if (placements > 1) {
          return toolError('Give at most one of position, aboveUid and belowUid.');
        }
        if (placements === 0 && args.toLayer === undefined) {
          return toolError('Nothing to do. Give toLayer, position, aboveUid or belowUid.');
        }
        if (args.aboveUid === args.uid || args.belowUid === args.uid) {
          return toolError('An instance cannot be placed relative to itself.');
        }

        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const layers = collectLayers(layout);
        const source = layers.find(l => Array.isArray(l.instances) && l.instances.some(i => i.uid === args.uid));
        if (!source) {
          const nonworld = collectInstances(layout).some(i => i.uid === args.uid);
          return toolError(nonworld
            ? `Instance ${args.uid} is a non-world instance; it has no layer or Z order.`
            : `World instance with UID ${args.uid} not found in layout "${args.layoutName}". Use get_layout_details to see all instance UIDs.`);
        }

        let target = source;
        if (args.toLayer !== undefined) {
          const found = layers.find(l => l.name === args.toLayer);
          if (!found) {
            return toolError(`Layer "${args.toLayer}" not found in layout "${args.layoutName}". Layers: ${layers.map(l => l.name).join(', ')}`);
          }
          target = found;
        }

        const fromIndex = source.instances.findIndex(i => i.uid === args.uid);
        const [inst] = source.instances.splice(fromIndex, 1);
        if (!Array.isArray(target.instances)) target.instances = [];

        let toIndex: number;
        const relative = args.aboveUid ?? args.belowUid;
        if (relative !== undefined) {
          const anchor = target.instances.findIndex(i => i.uid === relative);
          if (anchor === -1) {
            return toolError(`Instance ${relative} is not on layer "${target.name}". aboveUid and belowUid must name an instance on the destination layer.`);
          }
          toIndex = args.aboveUid !== undefined ? anchor + 1 : anchor;
        } else if (args.position === 'bottom') {
          toIndex = 0;
        } else if (typeof args.position === 'number') {
          if (args.position > target.instances.length) {
            return toolError(`position ${args.position} is out of range: layer "${target.name}" would hold ${target.instances.length + 1} instance(s), so the highest index is ${target.instances.length}.`);
          }
          toIndex = args.position;
        } else if (args.position === 'top' || target !== source) {
          toIndex = target.instances.length;
        } else {
          toIndex = fromIndex;
        }
        target.instances.splice(toIndex, 0, inst);

        const unchanged = target === source && toIndex === fromIndex;
        if (unchanged) {
          return toolResult({
            success: true,
            entity: args.layoutName,
            category: 'layout',
            action: 'unchanged',
            message: `Instance ${args.uid} is already at index ${fromIndex} of layer "${source.name}".`,
          });
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        return toolResult({
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          uid: args.uid,
          fromLayer: source.name,
          fromIndex,
          toLayer: target.name,
          toIndex,
          layerInstanceCount: target.instances.length,
        });
      } catch (error) {
        console.error('[move_instance] failed:', error);
        return toolError(`Error moving instance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── set_instance_parent ─────────────────────────────────

  server.tool(
    'set_instance_parent',
    'Attach a world instance to a hierarchy parent in the same layout, or detach it by passing parentUid: null. Both sides of the link are maintained.',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      childUid: z.number().int().describe('UID of the instance that becomes the child'),
      parentUid: z.number().int().nullable().describe('UID of the parent instance, or null to detach the child from its current parent'),
      flags: z.object({
        x: z.boolean().optional().describe('Inherit X position'),
        y: z.boolean().optional().describe('Inherit Y position'),
        z: z.boolean().optional().describe('Inherit Z elevation'),
        w: z.boolean().optional().describe('Inherit width'),
        h: z.boolean().optional().describe('Inherit height'),
        d: z.boolean().optional().describe('Inherit depth'),
        a: z.boolean().optional().describe('Inherit angle'),
        o: z.boolean().optional().describe('Inherit opacity (Construct default: false)'),
        v: z.boolean().optional().describe('Inherit visibility (Construct default: false)'),
        sm: z.enum(SCENE_GRAPH_MODES).optional().describe('Transform mode written by Construct (default: normal)'),
      }).strict().optional().describe('Inheritance flags merged over the defaults; unknown keys are rejected'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const byUid = worldInstancesByUid(layout);

        const child = byUid.get(args.childUid);
        if (!child) {
          return toolError(`World instance with UID ${args.childUid} not found in layout "${args.layoutName}". Hierarchies only apply to instances placed on a layer; use get_layout_details to see all instance UIDs.`);
        }

        // Detach
        if (args.parentUid === null) {
          const sg = child.sceneGraphData;
          const previousParent = sg ? unlinkFromParent(byUid, child) : null;
          if (args.flags !== undefined) {
            const target = ensureSceneGraphData(child);
            target.flags = { ...target.flags, ...args.flags };
          }
          if (previousParent === null && !sg) {
            return toolResult({
              success: true,
              entity: args.layoutName,
              category: 'layout',
              action: 'unchanged',
              message: `Instance ${args.childUid} has no hierarchy parent; nothing to detach.`,
            });
          }

          const detachSubfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
          const detachBackup = await writer.writeEntityFile('layouts', args.layoutName, layout, detachSubfolder);
          const detachResult: WriteResult = {
            success: true,
            entity: args.layoutName,
            category: 'layout',
            action: 'updated',
            backupFile: detachBackup,
            warnings: previousParent !== null
              ? [`Detached instance ${args.childUid} from parent ${previousParent}.`]
              : undefined,
          };
          return toolResult(detachResult);
        }

        if (args.parentUid === args.childUid) {
          return toolError(`Instance ${args.childUid} cannot be its own hierarchy parent.`);
        }

        const parent = byUid.get(args.parentUid);
        if (!parent) {
          return toolError(`World instance with UID ${args.parentUid} not found in layout "${args.layoutName}". A hierarchy parent must be a world instance in the same layout.`);
        }

        // A parent that already descends from the child would close a loop the
        // editor cannot resolve.
        if (hasAncestor(byUid, args.parentUid, args.childUid)) {
          return toolError(`Cannot parent instance ${args.childUid} to ${args.parentUid}: ${args.parentUid} is already a descendant of ${args.childUid}, which would create a hierarchy cycle.`);
        }

        const childSg = ensureSceneGraphData(child);
        unlinkFromParent(byUid, child);

        const flags: SceneGraphFlags = { ...DEFAULT_SCENE_GRAPH_FLAGS, ...(args.flags ?? {}) };
        childSg['parent-uid'] = args.parentUid;
        childSg.flags = flags;

        const parentSg = ensureSceneGraphData(parent);
        if (!Array.isArray(parentSg.children)) {
          parentSg.children = [];
          moveKeysToEnd(parentSg, SCENE_GRAPH_KEYS_AFTER_CHILDREN);
        }
        const existingIdx = parentSg.children.findIndex(c => c.uid === args.childUid);
        // Construct stores the same flag values on both sides of the link.
        const entry = { uid: args.childUid, flags: { ...flags } };
        if (existingIdx === -1) {
          parentSg.children.push(entry);
        } else {
          parentSg.children[existingIdx] = entry;
        }

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[set_instance_parent] failed:', error);
        return toolError(`Error setting instance parent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── remove_instance_children ────────────────────────────

  server.tool(
    'remove_instance_children',
    'Detach every hierarchy child of a world instance, clearing both the parent\'s children list and each child\'s parent-uid',
    {
      layoutName: z.string().max(200).describe('Layout name'),
      parentUid: z.number().int().describe('UID of the parent instance whose children are detached'),
    },
    async (args) => {
      try {
        let layout: Layout;
        try {
          layout = await reader.readLayout(args.layoutName);
        } catch {
          return notFoundError('Layout', args.layoutName, reader.findNearestName(args.layoutName, 'layouts'), 'list_layouts');
        }

        const byUid = worldInstancesByUid(layout);
        const parent = byUid.get(args.parentUid);
        if (!parent) {
          return toolError(`World instance with UID ${args.parentUid} not found in layout "${args.layoutName}". Hierarchies only apply to instances placed on a layer; use get_layout_details to see all instance UIDs.`);
        }

        const parentSg = parent.sceneGraphData;
        const children = parentSg && Array.isArray(parentSg.children) ? parentSg.children : [];
        if (!parentSg || children.length === 0) {
          return toolResult({
            success: true,
            entity: args.layoutName,
            category: 'layout',
            action: 'unchanged',
            message: `Instance ${args.parentUid} has no hierarchy children.`,
            detached: 0,
          });
        }

        const orphanedUids: number[] = [];
        for (const entry of [...children]) {
          const childSg = byUid.get(entry.uid)?.sceneGraphData;
          if (childSg) {
            childSg['parent-uid'] = null;
          } else {
            orphanedUids.push(entry.uid);
          }
        }
        const detached = children.length;
        delete parentSg.children;

        const subfolder = writer.getSubfolderForEntity('layouts', args.layoutName);
        const backupPath = await writer.writeEntityFile('layouts', args.layoutName, layout, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.layoutName,
          category: 'layout',
          action: 'updated',
          backupFile: backupPath,
          warnings: orphanedUids.length > 0
            ? [`Removed ${detached} child link(s) from instance ${args.parentUid}; UID(s) ${orphanedUids.join(', ')} were listed as children but no matching world instance exists in this layout.`]
            : [`Detached ${detached} child instance(s) from instance ${args.parentUid}.`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[remove_instance_children] failed:', error);
        return toolError(`Error removing instance children: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
