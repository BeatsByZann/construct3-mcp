/**
 * Unit tests for src/construct3/custom-actions.ts. All data is synthetic.
 */
import { describe, it, expect } from 'vitest';
import {
  customActionDefinitionClashes,
  customActionDefinitions,
  customActionOwnerError,
  customActionScan,
  newCustomActionDuplicates,
  resolveCustomActionCall,
  type CustomActionDefinition,
} from '../../src/construct3/custom-actions.js';

/** A custom action block as the editor saves it. */
function block(owner: string, name: string, sid: number, parameters: string[] = [], children?: unknown[]): Record<string, unknown> {
  return {
    aceType: 'action',
    aceName: name,
    objectClass: owner,
    functionParameters: parameters.map((p, i) => ({ name: p, type: 'number', initialValue: '0', comment: '', sid: sid * 10 + i })),
    eventType: 'custom-ace-block',
    conditions: [],
    actions: [],
    sid,
    ...(children ? { children } : {}),
  };
}

function def(owner: string, name: string): CustomActionDefinition {
  return { owner, name, sheet: 'Sheet1', eventPath: 'events[0]', parameters: [] };
}

describe('customActionDefinitions', () => {
  it('finds definitions at the top level, in groups and below blocks, with their sheet, path, SID and parameter names', () => {
    const sheets = new Map<string, unknown>([
      ['Sheet1', [
        block('Alpha', 'Hurt', 500, ['amount', 'source']),
        { eventType: 'group', title: 'G', description: '', isActiveOnStart: true, children: [block('Beta', 'Heal', 510)], sid: 1 },
        { eventType: 'block', conditions: [], actions: [], sid: 2, children: [block('Alpha', 'Jump', 520)] },
      ]],
      ['Sheet2', [block('Fam', 'Wave', 530)]],
    ]);
    expect(customActionDefinitions(sheets)).toEqual([
      { owner: 'Alpha', name: 'Hurt', sheet: 'Sheet1', eventPath: 'events[0]', sid: 500, parameters: ['amount', 'source'] },
      { owner: 'Alpha', name: 'Jump', sheet: 'Sheet1', eventPath: 'events[2].children[0]', sid: 520, parameters: [] },
      { owner: 'Beta', name: 'Heal', sheet: 'Sheet1', eventPath: 'events[1].children[0]', sid: 510, parameters: [] },
      { owner: 'Fam', name: 'Wave', sheet: 'Sheet2', eventPath: 'events[0]', sid: 530, parameters: [] },
    ]);
  });
});

describe('customActionDefinitionClashes', () => {
  it('a clash is the same owner and the same name ignoring case', () => {
    const defs = [def('Alpha', 'Hurt')];
    expect(customActionDefinitionClashes(defs, 'Alpha', 'hurt')).toHaveLength(1);
    expect(customActionDefinitionClashes(defs, 'Alpha', 'HURT')).toHaveLength(1);
    expect(customActionDefinitionClashes(defs, 'Alpha', 'Heal')).toHaveLength(0);
  });

  it('another owner, or a member overriding its family\'s action, is no clash', () => {
    const defs = [def('Fam', 'Hurt')];
    expect(customActionDefinitionClashes(defs, 'Alpha', 'Hurt')).toHaveLength(0);
    expect(customActionDefinitionClashes(defs, 'Beta', 'Hurt')).toHaveLength(0);
  });
});

describe('resolveCustomActionCall', () => {
  const familiesOf = (objectClass: string): readonly string[] => (objectClass === 'Alpha' ? ['Fam'] : []);

  it('a call finds its definition: the named family first, then its own object class, then a family it belongs to', () => {
    const defs = [def('Fam', 'Wave'), def('Alpha', 'Wave'), def('Alpha', 'Own')];
    expect(resolveCustomActionCall({ customAction: 'Wave', objectClass: 'Alpha', customActionObjectClass: 'Fam' }, defs, familiesOf)).toBe(defs[0]);
    expect(resolveCustomActionCall({ customAction: 'Own', objectClass: 'Alpha' }, defs, familiesOf)).toBe(defs[2]);
    expect(resolveCustomActionCall({ customAction: 'Wave', objectClass: 'Alpha' }, [defs[0]!], familiesOf)).toBe(defs[0]);
  });

  it('a member\'s own definition wins over its family\'s for a call without customActionObjectClass', () => {
    const defs = [def('Fam', 'Wave'), def('Alpha', 'Wave')];
    expect(resolveCustomActionCall({ customAction: 'Wave', objectClass: 'Alpha' }, defs, familiesOf)).toBe(defs[1]);
  });

  it('a call to a name nobody defines finds none', () => {
    const defs = [def('Fam', 'Wave'), def('Beta', 'Hurt')];
    expect(resolveCustomActionCall({ customAction: 'Hurt', objectClass: 'Alpha' }, defs, familiesOf)).toBeUndefined();
    expect(resolveCustomActionCall({ customAction: 'Wave', objectClass: 'Alpha', customActionObjectClass: 'Other' }, defs, familiesOf)).toBeUndefined();
  });

  it('a call matches a definition ignoring letter case, and a definition with the call\'s exact spelling wins', () => {
    const defs = [def('Alpha', 'Hurt'), def('Alpha', 'hurt')];
    expect(resolveCustomActionCall({ customAction: 'HURT', objectClass: 'Alpha' }, defs, familiesOf)).toBe(defs[0]);
    expect(resolveCustomActionCall({ customAction: 'hurt', objectClass: 'Alpha' }, defs, familiesOf)).toBe(defs[1]);
  });
});

describe('newCustomActionDuplicates', () => {
  it('a copy that adds a second definition of a name on one owner is a new duplicate, an existing pair is not', () => {
    const one = [def('Alpha', 'Hurt')];
    const two = [def('Alpha', 'Hurt'), def('Alpha', 'hurt')];
    expect(newCustomActionDuplicates(one, two)).toHaveLength(1);
    expect(newCustomActionDuplicates(one, two)[0]).toHaveLength(2);
    expect(newCustomActionDuplicates(two, two)).toEqual([]);
    expect(newCustomActionDuplicates(two, [...two, def('Alpha', 'HURT')])).toHaveLength(1);
  });
});

describe('customActionOwnerError', () => {
  it('the owner rule refuses System, the Functions object and an unknown name, with a hint for a case variant', () => {
    expect(customActionOwnerError('System', ['Alpha'], ['Fam']))
      .toBe('Unknown objectClass "System". A custom action belongs to an object type or family (not System or the Functions object).');
    expect(customActionOwnerError('Functions', ['Alpha'], ['Fam']))
      .toBe('Unknown objectClass "Functions". A custom action belongs to an object type or family (not System or the Functions object).');
    expect(customActionOwnerError('alpha', ['Alpha'], []))
      .toBe('Unknown objectClass "alpha": object type and family names are matched with their letter case. Did you mean "Alpha"?');
    expect(customActionOwnerError('Fam', ['Alpha'], ['Fam'])).toBeUndefined();
    expect(customActionOwnerError('Alpha', ['Alpha'], ['Fam'])).toBeUndefined();
  });
});

describe('customActionScan', () => {
  it('says it is incomplete when a definition lies past its node limit, and lists none of what it did not reach', () => {
    const comments = Array.from({ length: 100_000 }, () => ({ eventType: 'comment', text: 'x' }));
    const result = customActionScan(new Map<string, unknown>([['Sheet1', [...comments, block('Alpha', 'Late', 1)]]]));
    expect(result.complete).toBe(false);
    expect(result.definitions).toEqual([]);
  });

  it('says it is incomplete when a definition lies past its depth limit', () => {
    let inner: Record<string, unknown> = block('Alpha', 'Deep', 1);
    for (let i = 0; i < 52; i++) inner = { eventType: 'block', conditions: [], actions: [], sid: 100 + i, children: [inner] };
    const result = customActionScan(new Map<string, unknown>([['Sheet1', [inner]]]));
    expect(result.complete).toBe(false);
    expect(result.definitions).toEqual([]);
  });

  it('is complete for an ordinary sheet', () => {
    const result = customActionScan(new Map<string, unknown>([['Sheet1', [block('Alpha', 'Hurt', 1)]]]));
    expect(result.complete).toBe(true);
    expect(result.definitions).toHaveLength(1);
  });
});
