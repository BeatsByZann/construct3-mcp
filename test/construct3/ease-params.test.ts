import { describe, it, expect } from 'vitest';
import {
  needsEaseLookup,
  easeParameterName,
  easeParameterValue,
  embedCustomEase,
  forEachEaseParameter,
} from '../../src/construct3/ease-params.js';
import { buildEaseKeyframes, type CustomEase } from '../../src/construct3/timeline-model.js';

const EASE: CustomEase = { name: 'Bouncy', linear: false, purpose: 'any', transitionKeyframes: buildEaseKeyframes([{ x: 0, y: 0 }, { x: 1, y: 1 }]) };

describe('ease parameters', () => {
  it('looks up only bare names that are not built in', () => {
    expect(needsEaseLookup({ ease: 'Bouncy' })).toBe(true);
    expect(needsEaseLookup({ ease: 'easeinsine' })).toBe(false);
    expect(needsEaseLookup({ ease: 'default' })).toBe(false);
    expect(needsEaseLookup({ ease: easeParameterValue(EASE) })).toBe(false);
    expect(needsEaseLookup({ time: '1' })).toBe(false);
    expect(needsEaseLookup(['Bouncy'])).toBe(false);
  });

  it('reads the ease name from a string or an embedded copy', () => {
    expect(easeParameterName('Bouncy')).toBe('Bouncy');
    expect(easeParameterName(easeParameterValue(EASE))).toBe('Bouncy');
    expect(easeParameterName(3)).toBeUndefined();
    expect(easeParameterName(null)).toBeUndefined();
  });

  it('embeds only registered custom eases, and copies them', () => {
    const eases = new Map([['Bouncy', EASE]]);
    const params: Record<string, unknown> = { time: '1', ease: 'Bouncy', loop: 'no' };
    expect(embedCustomEase(params, eases)).toBe('Bouncy');
    expect(Object.keys(params)).toEqual(['time', 'ease', 'loop']);
    expect(params.ease).toEqual({ name: 'Bouncy', json: [{ folders: [], json: EASE }] });
    expect((params.ease as any).json[0].json).not.toBe(EASE);

    const other: Record<string, unknown> = { ease: 'Missing' };
    expect(embedCustomEase(other, eases)).toBeUndefined();
    expect(other.ease).toBe('Missing');
  });

  it('visits every parameters object with an ease key', () => {
    const sheet = {
      events: [
        { actions: [{ parameters: { ease: 'a' } }, { parameters: ['x'] }], children: [{ conditions: [{ parameters: { ease: 'b' } }] }] },
        { actions: [{ parameters: { time: '1' } }] },
      ],
    };
    const seen: unknown[] = [];
    forEachEaseParameter(sheet, params => seen.push(params.ease));
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
