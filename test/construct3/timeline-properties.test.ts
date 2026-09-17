/**
 * Unit tests for the timeline property rules that the editor fixture cannot
 * pin on its own (its Box frame is 1x1, so scale equals size there).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTimelineProperty,
  valuesFor,
  effectiveResultMode,
  addVirtualPositionKey,
} from '../../src/construct3/timeline-properties.js';

const instance: any = {
  type: 'Hero', uid: 9, sid: 1,
  properties: { 'initial-animation': 'Run', 'initial-frame': 0, speed: 3 },
  instanceVariables: { speed: 4, name: 'a' },
  world: { x: 10, y: 20, width: 60, height: 90, angle: 0, color: [1, 1, 1, 0.5] },
};
const objectType: any = {
  name: 'Hero', 'plugin-id': 'Sprite',
  instanceVariables: [{ name: 'speed', type: 'number' }, { name: 'name', type: 'string' }],
  animations: { items: [
    { name: 'Idle', frames: [{ width: 1, height: 1 }] },
    { name: 'Run', frames: [{ width: 20, height: 30 }] },
  ] },
};

describe('resolveTimelineProperty', () => {
  it('divides the instance size by the initial animation frame for scale', () => {
    const x = resolveTimelineProperty('offsetScaleX', instance, objectType);
    const y = resolveTimelineProperty('offsetScaleY', instance, objectType);
    expect(x.ok && x.spec.base).toBe(3);
    expect(y.ok && y.spec.base).toBe(3);
  });

  it('reads opacity from the color alpha', () => {
    const r = resolveTimelineProperty('offsetOpacity', instance, objectType);
    expect(r.ok && r.spec.base).toBe(0.5);
  });

  it('asks for a prefix when a name is both a variable and a plugin property', () => {
    const r = resolveTimelineProperty('speed', instance, objectType);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"var:speed" or "plugin:speed"');
    const v = resolveTimelineProperty('var:speed', instance, objectType);
    expect(v.ok && v.spec.source).toEqual({ type: 'instance-variable', uid: 'speed' });
    expect(v.ok && v.spec.base).toBe(4);
    const p = resolveTimelineProperty('plugin:speed', instance, objectType);
    expect(p.ok && p.spec.source).toEqual({ type: 'plugin', uid: 'Sprite' });
    expect(p.ok && p.spec.base).toBe(3);
  });

  it('never animates live-preview', () => {
    const r = resolveTimelineProperty('live-preview', { ...instance, properties: { 'live-preview': false } }, objectType);
    expect(r.ok && r.spec.verified).toBe(false);
  });
});

describe('valuesFor', () => {
  const number = resolveTimelineProperty('offsetX', instance, objectType);
  it('relates numbers to the base under each result mode', () => {
    if (!number.ok) throw new Error('resolve failed');
    expect(valuesFor(number.spec, 15, 'default')).toEqual({ value: 5, rValue: 5, aValue: 15 });
    expect(valuesFor(number.spec, 15, 'relative')).toEqual({ value: 5, rValue: 5, aValue: 15 });
    expect(valuesFor(number.spec, 15, 'absolute')).toEqual({ value: 15, rValue: 5, aValue: 15 });
  });

  it('picks the first non-default result mode from the keyframe outward', () => {
    expect(effectiveResultMode('default', undefined, 'absolute', 'relative')).toBe('absolute');
    expect(effectiveResultMode('relative', 'absolute')).toBe('relative');
    expect(effectiveResultMode('default', '', undefined)).toBe('default');
  });
});

describe('addVirtualPositionKey', () => {
  it('orders offset keys like the editor and keeps flag keys last', () => {
    let vp: Record<string, unknown> = { useColor: true, colorSet: false, relativeFlags: 16383, version: 1 };
    for (const key of ['offsetScaleY', 'offsetColor', 'offsetX', 'offsetAngle']) {
      vp = addVirtualPositionKey(vp, key, key === 'offsetColor' ? 'color' : 'number');
    }
    expect(Object.keys(vp)).toEqual(['offsetX', 'offsetAngle', 'offsetColor', 'offsetScaleY', 'useColor', 'colorSet', 'relativeFlags', 'version']);
    expect(vp.offsetColor).toEqual([0, 0, 0, 1]);
  });
});
