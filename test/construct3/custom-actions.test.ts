/**
 * Unit tests for src/construct3/custom-actions.ts. All data is synthetic.
 */
import { describe, it, expect } from 'vitest';
import {
  customActionCallSites,
  customActionRenameCaptures,
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

describe('customActionCallSites', () => {
  const call = (name: string, sid: number, extra: Record<string, unknown> = {}) => ({ customAction: name, objectClass: 'Alpha', sid, ...extra });
  it('lists every custom action call with its sheet, path, event SID, call and stored action, and nothing else', () => {
    const hurt = call('Hurt', 11, { customActionObjectClass: 'Fam', parameters: ['1'] });
    const sheets = new Map<string, unknown>([
      ['Sheet1', [null, { eventType: 'block', conditions: [], sid: 10, actions: [{ callFunction: 'F', sid: 12 }, hurt], children: [
        { eventType: 'block', conditions: [], actions: [call('Wave', 21)], sid: 20 },
      ] }]],
      ['Other', 'not a list'],
    ]);
    const { sites, complete } = customActionCallSites(sheets);
    expect(complete).toBe(true);
    expect(sites.map(s => [s.sheet, s.path, s.sid, s.call])).toEqual([
      ['Sheet1', 'events[1] > action:1', 10, { customAction: 'Hurt', objectClass: 'Alpha', customActionObjectClass: 'Fam' }],
      ['Sheet1', 'events[1].children[0] > action:0', 20, { customAction: 'Wave', objectClass: 'Alpha' }],
    ]);
    expect(sites[0].ace).toBe(hurt);
  });

  it('says it is incomplete, and which limit stopped it, past its node limit and its depth limit', () => {
    const comments = Array.from({ length: 100_000 }, () => ({ eventType: 'comment', text: 'x' }));
    const late = { eventType: 'block', conditions: [], actions: [call('Late', 2)], sid: 1 };
    const wide = customActionCallSites(new Map<string, unknown>([['Sheet1', [...comments, late]]]));
    expect([wide.complete, wide.limit, wide.sites]).toEqual([false, 'events', []]);
    let inner: Record<string, unknown> = late;
    for (let i = 0; i < 52; i++) inner = { eventType: 'block', conditions: [], actions: [], sid: 100 + i, children: [inner] };
    const deep = customActionCallSites(new Map<string, unknown>([['Sheet1', [inner]]]));
    expect([deep.complete, deep.limit, deep.sites]).toEqual([false, 'depth', []]);
  });
});

describe('customActionRenameCaptures', () => {
  const families = (objectClass: string) => (objectClass === 'Alpha' ? ['Fam'] : []);
  const at = (owner: string, name: string, eventPath: string): CustomActionDefinition => ({ owner, name, sheet: 'Sheet1', eventPath, parameters: [] });
  const site = (customAction: string, sid: number, customActionObjectClass?: string) => {
    const c = { customAction, objectClass: 'Alpha', ...(customActionObjectClass ? { customActionObjectClass } : {}) };
    return { sheet: 'Other', path: `events[${sid}] > action:0`, sid, call: c, ace: { ...c } };
  };

  it('resolves each rewritten call against the definitions after the rename', () => {
    // Alpha.Hurt and Fam.Wave: renaming Alpha.Hurt to Wave captures a plain Wave call on Alpha, which ran Fam.Wave
    const hurt = at('Alpha', 'Hurt', 'events[0]');
    const wave = at('Fam', 'Wave', 'events[1]');
    const sites = [site('Hurt', 1), site('Wave', 2), site('Wave', 3, 'Fam')];
    const captures = customActionRenameCaptures(sites, [hurt, wave], hurt, 'Wave', families);
    expect(captures.rewrite).toEqual([sites[0]]);
    expect(captures.captured).toEqual([{ site: sites[1], before: wave, after: { ...hurt, name: 'Wave' } }]);
    // Renamed to a name nothing else has, every call that ran it is rewritten and none is captured
    const free = customActionRenameCaptures(sites, [hurt, wave], hurt, 'Strike', families);
    expect([free.rewrite, free.captured]).toEqual([[sites[0]], []]);
  });

  it('a rewritten call that would run another definition after the rename stops running the renamed one, and is captured', () => {
    // Fam.Hurt and Alpha.Wave: renaming Fam.Hurt to Wave would send a plain Hurt call on Alpha to Alpha.Wave
    const famHurt = at('Fam', 'Hurt', 'events[0]');
    const alphaWave = at('Alpha', 'Wave', 'events[1]');
    const sites = [site('Hurt', 1), site('Hurt', 2, 'Fam')];
    const captures = customActionRenameCaptures(sites, [famHurt, alphaWave], famHurt, 'Wave', families);
    expect(captures.rewrite).toEqual([sites[1]]);
    expect(captures.captured).toEqual([{ site: sites[0], before: famHurt, after: alphaWave }]);
  });
});
