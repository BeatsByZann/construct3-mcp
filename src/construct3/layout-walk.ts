/**
 * Walk helpers for layout JSON: layers nest through `subLayers`, and
 * non-world instances (Keyboard, Audio, ...) live outside any layer.
 */

import type { Layout, Layer, Instance } from './types.js';

/** Every layer in draw order, including nested sub-layers. */
export function collectLayers(layout: Layout): Layer[] {
  const out: Layer[] = [];
  const walk = (layers: unknown[] | undefined) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers as Layer[]) {
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
