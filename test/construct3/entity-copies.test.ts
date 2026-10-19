/**
 * Transforms for copying entities: fresh SIDs, fresh instance UIDs with the
 * hierarchy links and replica lists mapped through the same new UIDs, and
 * the checks that a copy can be made. Synthetic values and a deterministic
 * ID generator.
 */

import { describe, it, expect } from 'vitest';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import {
  hierarchyEscapes, remapAllSids, remapInstanceUids, sidRemapper, templateInstances,
  type CopyIdGenerator,
} from '../../src/construct3/entity-copies.js';
import type { Instance } from '../../src/construct3/types.js';

const idGen = (): CopyIdGenerator => new MockIdGenerator() as unknown as CopyIdGenerator;
const noReader = undefined as never;

function instance(uid: number, extra: Record<string, unknown> = {}): Instance {
  return { type: 'Sprite', uid, ...extra } as unknown as Instance;
}

describe('remapAllSids', () => {
  it('gives every numeric sid key a fresh value, the same old sid the same new one, and leaves other numbers', async () => {
    const sids = sidRemapper(noReader, idGen());
    const value = {
      sid: 5, x: 5, uid: 7,
      list: [{ sid: 6, n: 6 }, { sid: 5 }],
      nested: { deeper: { sid: 6, text: 'sid' } },
      sidText: { sid: 'not a number' },
    };
    const count = await remapAllSids(value, sids.fresh);
    expect(count).toBe(4);
    expect(value.sid).not.toBe(5);
    expect(value.list[1].sid).toBe(value.sid);
    expect(value.nested.deeper.sid).toBe(value.list[0].sid);
    expect(value.list[0].sid).not.toBe(value.sid);
    expect([value.x, value.uid, value.list[0].n]).toEqual([5, 7, 6]);
    expect(value.sidText.sid).toBe('not a number');
    expect(sids.map.size).toBe(2);
  });
});

describe('remapInstanceUids', () => {
  it('gives every instance a fresh uid and maps the hierarchy links and replica lists through the same map', async () => {
    const parent = instance(10, { sceneGraphData: { uid: 10, 'parent-uid': null, children: [{ uid: 11, flags: {} }] } });
    const child = instance(11, { sceneGraphData: { uid: 11, 'parent-uid': 10 } });
    const template = instance(12, { template: { mode: 'template', templateName: 'T', replicasUIDs: [10, 99] } });
    const map = await remapInstanceUids([parent, child, template], noReader, idGen());
    expect([...map.keys()]).toEqual([10, 11, 12]);
    const [newParent, newChild, newTemplate] = [map.get(10)!, map.get(11)!, map.get(12)!];
    expect(new Set([newParent, newChild, newTemplate]).size).toBe(3);
    expect(parent.uid).toBe(newParent);
    const parentGraph = parent.sceneGraphData as unknown as { uid: number; 'parent-uid': unknown; children: Array<{ uid: number }> };
    expect(parentGraph.uid).toBe(newParent);
    expect(parentGraph['parent-uid']).toBeNull();
    expect(parentGraph.children[0].uid).toBe(newChild);
    const childGraph = child.sceneGraphData as unknown as { uid: number; 'parent-uid': number };
    expect(childGraph.uid).toBe(newChild);
    expect(childGraph['parent-uid']).toBe(newParent);
    expect((newTemplate)).toBe(template.uid);
    expect((template as unknown as { template: { replicasUIDs: number[] } }).template.replicasUIDs).toEqual([newParent, 99]);
  });
});

describe('hierarchyEscapes', () => {
  it('names a parent or child outside the set and nothing inside it', () => {
    const inside = [
      instance(1, { sceneGraphData: { uid: 1, 'parent-uid': null, children: [{ uid: 2 }] } }),
      instance(2, { sceneGraphData: { uid: 2, 'parent-uid': 1 } }),
    ];
    expect(hierarchyEscapes(inside, new Set([1, 2]))).toEqual([]);
    const outside = [
      instance(3, { sceneGraphData: { uid: 3, 'parent-uid': 50, children: [{ uid: 60 }, { uid: 3 }] } }),
    ];
    expect(hierarchyEscapes(outside, new Set([3]))).toEqual([
      'uid 3 (Sprite) has parent uid 50',
      'uid 3 (Sprite) has child uid 60',
    ]);
  });
});

describe('templateInstances', () => {
  it('finds instances that are templates and not replicas', () => {
    const found = templateInstances([
      instance(1, { template: { mode: 'template', templateName: 'Hero' } }),
      instance(2, { template: { mode: 'replica', sourceTemplateName: 'Hero' } }),
      instance(3),
    ]);
    expect(found).toEqual([{ uid: 1, type: 'Sprite', templateName: 'Hero' }]);
  });
});
