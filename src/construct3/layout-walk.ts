/**
 * Walk helpers for layout JSON: layers nest through `subLayers`, and
 * non-world instances (Keyboard, Audio, ...) live outside any layer.
 */

import type { Layout, Layer, Instance } from './types.js';

/** Every layer in draw order, including nested sub-layers. */
export function collectLayers(layout: Layout): Layer[] {
  const out: Layer[] = [];
  const walk = (layers: Layer[] | undefined) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      out.push(layer);
      walk(layer.subLayers);
    }
  };
  walk(layout.layers);
  return out;
}

/** Every instance in the layout: all layers (nested) plus non-world instances. */
export function collectInstances(layout: Layout): Instance[] {
  const out: Instance[] = [];
  for (const layer of collectLayers(layout)) {
    if (Array.isArray(layer.instances)) out.push(...layer.instances);
  }
  const nonworld = layout['nonworld-instances'];
  if (Array.isArray(nonworld)) out.push(...(nonworld as unknown as Instance[]));
  return out;
}

/** Find a layer by name anywhere in the layout, or undefined. */
export function findLayer(layout: Layout, name: string): Layer | undefined {
  return collectLayers(layout).find(layer => layer.name === name);
}

/** Where a layer sits: the array holding it, its position, and its parent layer. */
export interface LayerLocation {
  layer: Layer;
  /** The live sibling array (`layout.layers` or a parent's `subLayers`). */
  siblings: Layer[];
  index: number;
  /** The containing layer, or undefined for a top-level layer. */
  parent?: Layer;
}

/**
 * Locate a layer by name anywhere in the layout, returning the live sibling
 * array it belongs to so callers can splice it out or reorder in place.
 */
export function findLayerLocation(layout: Layout, name: string): LayerLocation | undefined {
  const walk = (siblings: Layer[] | undefined, parent?: Layer): LayerLocation | undefined => {
    if (!Array.isArray(siblings)) return undefined;
    for (let i = 0; i < siblings.length; i++) {
      const layer = siblings[i];
      if (layer.name === name) return { layer, siblings, index: i, parent };
      const found = walk(layer.subLayers, layer);
      if (found) return found;
    }
    return undefined;
  };
  return walk(layout.layers);
}

/** Every layer nested below `layer` (its sub-layers and theirs), excluding itself. */
export function collectSubLayers(layer: Layer): Layer[] {
  const out: Layer[] = [];
  const walk = (layers: Layer[] | undefined) => {
    if (!Array.isArray(layers)) return;
    for (const child of layers) {
      out.push(child);
      walk(child.subLayers);
    }
  };
  walk(layer.subLayers);
  return out;
}

/** The layer's `subLayers` array, creating it when the layer has none yet. */
export function ensureSubLayers(layer: Layer): Layer[] {
  if (!Array.isArray(layer.subLayers)) layer.subLayers = [];
  return layer.subLayers;
}
