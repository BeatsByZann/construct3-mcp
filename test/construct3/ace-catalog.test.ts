/**
 * ACE validation against the catalogue generated from Construct r495.2's own
 * definitions (scripts/build-ace-catalog.mjs).
 */

import { describe, it, expect } from 'vitest';
import { ACE_CATALOG } from '../../src/construct3/ace-catalog-data.js';
import {
  ACE_CATALOG_RELEASE, aceOwner, aceSnapshot, changedAceSids, checkAce, checkEventAces, collectAceSids,
  describeEventAceProblem,
} from '../../src/construct3/ace-catalog.js';
import type { AceContext } from '../../src/construct3/ace-catalog.js';

const SPRITE = { kind: 'plugin', id: 'Sprite' } as const;
const SYSTEM = { kind: 'plugin', id: 'system' } as const;
const PLATFORM = { kind: 'behavior', id: 'Platform' } as const;

/** A project with a Sprite "Player" carrying Platform, a family "Enemies" of Sprites, and a third-party object. */
const context: AceContext = {
  pluginOf: name => ({ System: 'system', Player: 'Sprite', Enemies: 'Sprite', Grunt: 'Sprite', Logger: 'someone_advancedLog' } as Record<string, string>)[name],
  behaviorOf: (objectClass, behavior) => {
    if (objectClass === 'Player' && behavior === 'Platform') return 'Platform';
    if (objectClass === 'Grunt' && behavior === 'Brain') return 'someone_fsm';
    return undefined;
  },
};

describe('the generated catalogue', () => {
  it('is built from r495.2 and holds plugin, behavior, System and common ACEs', () => {
    expect(ACE_CATALOG.release).toBe('r495-2');
    expect(ACE_CATALOG_RELEASE).toBe('r495.2');
    expect(ACE_CATALOG.plugins.system.conditions['every-tick']).toEqual([]);
    expect(ACE_CATALOG.plugins.Sprite.actions['set-animation']).toEqual([
      { id: 'animation', type: 'animation' },
      { id: 'from', type: 'combo', items: ['current-frame', 'beginning'] },
    ]);
    expect(ACE_CATALOG.behaviors.Platform.actions['simulate-control']).toEqual([
      { id: 'control', type: 'combo', items: ['left', 'right', 'jump'] },
    ]);
    expect(ACE_CATALOG.common.actions['set-instvar-value']).toEqual([
      { id: 'instance-variable', type: 'instancevar' },
      { id: 'value', type: 'any' },
    ]);
    // Common ACEs are not repeated under each plugin.
    expect(ACE_CATALOG.plugins.Sprite.actions['set-instvar-value']).toBeUndefined();
  });
});

describe('checkAce', () => {
  it('accepts an ACE with exactly its defined parameters and a valid combo choice', () => {
    expect(checkAce('actions', { id: 'set-animation', parameters: { animation: '"Walk"', from: 'beginning' } }, SPRITE)).toEqual([]);
    expect(checkAce('conditions', { id: 'every-tick' }, SYSTEM)).toEqual([]);
  });

  it('reports an ID the owner does not define', () => {
    expect(checkAce('actions', { id: 'set-animaton', parameters: {} }, SPRITE)).toEqual([{
      code: 'unknown-ace',
      message: 'Construct r495.2 defines no action "set-animaton" for the Sprite plugin.',
    }]);
  });

  it('does not accept a condition ID as an action, or the reverse', () => {
    expect(checkAce('actions', { id: 'every-tick' }, SYSTEM)[0].code).toBe('unknown-ace');
    expect(checkAce('conditions', { id: 'wait', parameters: { seconds: '1', 'use-timescale': true } }, SYSTEM)[0].code).toBe('unknown-ace');
  });

  it('accepts common ACEs on plugin objects but not on System or on behaviors', () => {
    const setVar = { id: 'set-instvar-value', parameters: { 'instance-variable': 'hp', value: '3' } };
    expect(checkAce('actions', setVar, SPRITE)).toEqual([]);
    expect(checkAce('actions', setVar, SYSTEM)[0].message).toBe('Construct r495.2 defines no action "set-instvar-value" for the System object.');
    expect(checkAce('actions', setVar, PLATFORM)[0].code).toBe('unknown-ace');
  });

  it('reports unknown and missing parameter names', () => {
    const problems = checkAce('actions', { id: 'set-position', parameters: { x: '1', z: '2' } }, SPRITE);
    expect(problems.map(p => p.code)).toEqual(['unknown-parameter', 'missing-parameter']);
    expect(problems[0].message).toBe('The action "set-position" of the Sprite plugin has no parameter(s) "z". Its parameters are "x", "y".');
    expect(problems[1].message).toBe('The action "set-position" of the Sprite plugin is missing parameter(s) "y".');
  });

  it('reports a parameterized ACE given no parameters at all', () => {
    expect(checkAce('actions', { id: 'set-position' }, SPRITE)).toEqual([{
      code: 'missing-parameter',
      message: 'The action "set-position" of the Sprite plugin takes parameter(s) "x", "y", and none are given.',
    }]);
  });

  it('reports a combo value that is not one of its choices', () => {
    expect(checkAce('actions', { id: 'simulate-control', parameters: { control: 'jump' } }, PLATFORM)).toEqual([]);
    expect(checkAce('actions', { id: 'simulate-control', parameters: { control: 'fly' } }, PLATFORM)).toEqual([{
      code: 'invalid-choice',
      message: 'Parameter "control" of the action "simulate-control" is "fly"; the Platform behavior accepts "left", "right", "jump".',
    }]);
    // A combo stores the choice's ID string, not its index.
    expect(checkAce('actions', { id: 'simulate-control', parameters: { control: 2 } }, PLATFORM)[0].code).toBe('invalid-choice');
  });

  it('skips addons the catalogue does not know', () => {
    expect(checkAce('actions', { id: 'anything', parameters: { x: 1 } }, { kind: 'plugin', id: 'someone_advancedLog' })).toEqual([]);
    expect(checkAce('actions', { id: 'anything' }, { kind: 'behavior', id: 'someone_fsm' })).toEqual([]);
  });

  it('leaves positional parameters alone', () => {
    expect(checkAce('actions', { id: 'set-position', parameters: ['1', '2'] }, SPRITE)).toEqual([]);
  });
});

describe('aceOwner', () => {
  it('resolves System, objects, families and behaviors, and gives up on what the project does not declare', () => {
    expect(aceOwner({ objectClass: 'System' }, context)).toEqual(SYSTEM);
    expect(aceOwner({ objectClass: 'Enemies' }, context)).toEqual(SPRITE);
    expect(aceOwner({ objectClass: 'Player', behaviorType: 'Platform' }, context)).toEqual(PLATFORM);
    expect(aceOwner({ objectClass: 'Player', behaviorType: 'Nope' }, context)).toBeUndefined();
    expect(aceOwner({ objectClass: 'Fn' }, context)).toBeUndefined();
  });
});

describe('checkEventAces', () => {
  const events = [
    {
      eventType: 'block',
      conditions: [{ id: 'every-tick', objectClass: 'System', sid: 1 }],
      actions: [
        { id: 'set-position', objectClass: 'Player', sid: 2, parameters: { x: '1', y: '2' } },
        { id: 'teleport', objectClass: 'Player', sid: 3, parameters: {} },
        { callFunction: 'Reset', sid: 4 },
        { type: 'comment', text: 'not an ACE' },
        { id: 'whatever', objectClass: 'Logger', sid: 5 },
        { id: 'simulate-control', objectClass: 'Player', behaviorType: 'Platform', sid: 6, parameters: { control: 'up' } },
        { id: 'go', objectClass: 'Grunt', behaviorType: 'Brain', sid: 7 },
      ],
      children: [
        { eventType: 'block', conditions: [{ id: 'is-on-screen', objectClass: 'Enemies', sid: 8 }], actions: [{ id: 'explode', objectClass: 'Enemies', sid: 9 }] },
      ],
    },
  ];

  it('checks standard ACEs at every depth and skips calls, comments and third-party addons', () => {
    const problems = checkEventAces(events, context);
    expect(problems.map(p => [p.sid, p.code])).toEqual([[3, 'unknown-ace'], [6, 'invalid-choice'], [9, 'unknown-ace']]);
    expect(describeEventAceProblem(problems[0])).toBe('Action "teleport" on "Player" (SID 3): Construct r495.2 defines no action "teleport" for the Sprite plugin.');
  });

  it('limits the check to the SIDs it is given', () => {
    expect(checkEventAces(events, context, new Set([9])).map(p => p.sid)).toEqual([9]);
    expect(checkEventAces(events, context, new Set([2]))).toEqual([]);
  });

  it('collects every ACE SID, and tells which of a block\'s own ACEs an edit touched', () => {
    expect([...collectAceSids(events)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const block = JSON.parse(JSON.stringify(events[0]));
    const before = aceSnapshot(block);
    block.actions[0].parameters.x = '5';
    block.actions.push({ id: 'destroy', objectClass: 'Player', sid: 10 });
    expect([...changedAceSids(before, block)].sort((a, b) => a - b)).toEqual([2, 10]);
  });
});
