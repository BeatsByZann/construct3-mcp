/**
 * Usage index coverage: placements on sub-layers and non-world instances,
 * custom action definitions and calls, function parameters read from
 * functionParameters, and behavior references.
 */

import { describe, it, expect } from 'vitest';
import { ProjectIndex } from '../../src/construct3/analyzers/index-builder.js';
import { MockReader } from '../mocks/mock-reader.js';

function project() {
  return new MockReader({
    objects: new Map([
      ['Player', { name: 'Player', 'plugin-id': 'Sprite', sid: 1 }],
      ['Deep', { name: 'Deep', 'plugin-id': 'Sprite', sid: 2 }],
      ['Keys', { name: 'Keys', 'plugin-id': 'Keyboard', sid: 3 }],
      ['Unused', { name: 'Unused', 'plugin-id': 'Sprite', sid: 4 }],
    ]),
    families: new Map([['Actors', { name: 'Actors', members: ['Player', 'Deep'] }]]),
    layouts: new Map([['Level', {
      name: 'Level',
      layers: [{
        name: 'Top', sid: 10,
        instances: [{ type: 'Player', uid: 1, sid: 11, properties: {}, world: { x: 0, y: 0, width: 1, height: 1 } }],
        subLayers: [{
          name: 'Inner', sid: 12,
          instances: [
            { type: 'Deep', uid: 2, sid: 13, properties: {}, world: { x: 0, y: 0, width: 1, height: 1 } },
            { type: 'Deep', uid: 3, sid: 14, properties: {}, world: { x: 0, y: 0, width: 1, height: 1 } },
          ],
        }],
      }],
      'nonworld-instances': [{ type: 'Keys', uid: 4, sid: 15, properties: {} }],
    }]]),
    eventSheets: new Map([['Main', {
      name: 'Main', sid: 20,
      events: [
        {
          eventType: 'function-block', functionName: 'hit', sid: 21,
          functionParameters: [{ name: 'amount', type: 'number', sid: 22 }],
          conditions: [], actions: [],
        },
        {
          eventType: 'custom-ace-block', aceType: 'action', aceName: 'Jump', objectClass: 'Actors', sid: 23,
          functionParameters: [{ name: 'height', type: 'number', sid: 24 }],
          conditions: [{ id: 'is-on-floor', objectClass: 'Player', behaviorType: 'Platform', sid: 25 }],
          actions: [{ id: 'simulate-control', objectClass: 'Player', behaviorType: 'Platform', sid: 26 }],
          children: [],
        },
        {
          eventType: 'block', sid: 27,
          conditions: [{ id: 'every-tick', objectClass: 'System', sid: 28 }],
          actions: [
            { type: 'comment', text: 'note' },
            { callFunction: 'hit', sid: 29, parameters: ['1'] },
            { customAction: 'Jump', objectClass: 'Deep', customActionObjectClass: 'Actors', sid: 30, parameters: ['5'] },
          ],
        },
      ],
    }]]),
  });
}

describe('ProjectIndex', () => {
  it('records placements on sub-layers and non-world instances, with counts', async () => {
    const index = new ProjectIndex();
    await index.build(project() as any);
    expect(index.objectToLayouts.get('Deep')).toEqual(['Level']);
    expect(index.objectToLayouts.get('Keys')).toEqual(['Level']);
    expect(index.objectInstanceCounts.get('Deep')?.get('Level')).toBe(2);
    expect(index.objectInstanceCounts.get('Player')?.get('Level')).toBe(1);
    expect(index.objectToLayouts.has('Unused')).toBe(false);
  });

  it('indexes custom action bodies, definitions and calls', async () => {
    const index = new ProjectIndex();
    await index.build(project() as any);
    expect(index.customActionDefinitions.get('Actors::Jump')).toMatchObject({ sheet: 'Main', sid: 23, params: ['height'] });
    expect(index.customActionCalls.get('Jump')).toEqual([
      expect.objectContaining({ objectClass: 'Deep', customActionObjectClass: 'Actors' }),
    ]);
    // Conditions and actions inside the custom action body count as uses.
    expect(index.getEventSheetsForObject('Player')).toEqual(['Main']);
    // The call's customActionObjectClass and objectClass both count.
    expect(index.objectToEventSheets.get('Actors')?.length).toBeGreaterThanOrEqual(2);
    expect(index.objectToEventSheets.get('Deep')?.length).toBe(1);
  });

  it('reads function parameters from functionParameters and indexes positional calls', async () => {
    const index = new ProjectIndex();
    await index.build(project() as any);
    expect(index.functionDefinitions.get('hit')).toEqual({ sheet: 'Main', params: ['amount'] });
    expect(index.functionCalls.get('hit')).toHaveLength(1);
  });

  it('records behavior references from conditions and actions', async () => {
    const index = new ProjectIndex();
    await index.build(project() as any);
    const refs = index.behaviorReferences.get('Player::Platform') ?? [];
    expect(refs.map(r => r.context).sort()).toEqual(['action', 'condition']);
  });
});
