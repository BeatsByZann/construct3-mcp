/**
 * ACE validation against a catalogue passed in as an argument. Every test
 * uses the hand-written TEST_CATALOG (or a copy of it); nothing reads the
 * network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aceOwner, aceTreeSnapshot, buildAceContext, changedAceSidsInTree, checkAce, checkEventAces,
  describeEventAceProblem, hasAceDefinitions, isBuiltInAddon, readProjectData, releaseHedge,
} from '../../src/construct3/ace-catalog.js';
import type { AceContext, EventAceProblem } from '../../src/construct3/ace-catalog.js';
import type { AceCatalog, AddonDefinition, AddonLookup, ProjectData } from '../../src/construct3/ace-types.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import type { ObjectType } from '../../src/construct3/types.js';
import { TEST_CATALOG } from '../fixtures/ace-catalog.js';
import { guardNetwork } from './ace-fetch-stub.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
const SPRITE = { kind: 'plugin', id: 'Sprite' } as const;
const SYSTEM = { kind: 'plugin', id: 'system' } as const;
const AUDIO = { kind: 'plugin', id: 'Audio' } as const;
const PLATFORM = { kind: 'behavior', id: 'Platform' } as const;
const clone = (catalog: AceCatalog): AceCatalog => JSON.parse(JSON.stringify(catalog)) as AceCatalog;

let restoreFetch: () => void;
const dirs: string[] = [];
beforeEach(() => {
  restoreFetch = guardNetwork();
});
afterEach(async () => {
  restoreFetch();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A project with a Sprite "Player" carrying Platform, a family "Enemies" of Sprites, and a third-party object. */
const context: AceContext = {
  pluginOf: name => ({ System: 'system', Player: 'Sprite', Enemies: 'Sprite', Grunt: 'Sprite', Logger: 'someone_advancedLog' } as Record<string, string>)[name],
  behaviorOf: (objectClass, behavior) => {
    if (objectClass === 'Player' && behavior === 'Platform') return 'Platform';
    if (objectClass === 'Grunt' && behavior === 'Brain') return 'someone_fsm';
    return undefined;
  },
};

/** An addon registry holding exactly the definitions it is given. */
function registry(...defs: AddonDefinition[]): AddonLookup {
  return { get: (type, id) => defs.find(d => d.type === type && d.id === id) };
}

/** A third-party plugin whose one action `log` takes the given parameters. */
function logger(params: Array<{ id: string; type: string }>): AddonDefinition {
  return {
    id: 'someone_advancedLog',
    type: 'plugin',
    name: 'Advanced Log',
    source: 'advancedLog',
    aces: { conditions: {}, actions: { log: params }, expressions: {} },
    counts: { conditions: 0, actions: 1, expressions: 0 },
  };
}

/** An object type as the reader returns it. */
function objectType(name: string, pluginId: string, behaviors: Array<[string, string]> = []): ObjectType {
  return {
    name,
    'plugin-id': pluginId,
    sid: 1,
    behaviorTypes: behaviors.map(([behaviorName, behaviorId]) => ({ name: behaviorName, behaviorId, sid: 2 })),
  } as unknown as ObjectType;
}

/** The maps of a project, with nothing unreadable. */
function projectData(objects: ObjectType[], families: Array<Record<string, unknown>> = []): ProjectData {
  return {
    objects: new Map(objects.map(o => [o.name, o])),
    families: new Map(families.map(f => [f.name as string, f])),
    sheets: new Map(),
    unreadable: { objectTypes: [], families: [], eventSheets: [] },
  };
}

describe('checkAce', () => {
  it('accepts an ACE with exactly its defined parameters and a valid combo choice', () => {
    expect(checkAce('actions', { id: 'set-animation', parameters: { animation: '"Walk"', from: 'beginning' } }, SPRITE, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkAce('conditions', { id: 'on-start-of-layout' }, SYSTEM, undefined, TEST_CATALOG)).toEqual([]);
  });

  it('reports an ID the owner does not define, naming the release of the catalogue it was given', () => {
    expect(checkAce('actions', { id: 'set-animaton', parameters: {} }, SPRITE, undefined, TEST_CATALOG)).toEqual([{
      code: 'unknown-ace',
      message: 'Construct r495.2 defines no action "set-animaton" for the Sprite plugin.',
    }]);
  });

  it('does not accept a condition ID as an action, or the reverse', () => {
    expect(checkAce('actions', { id: 'on-start-of-layout' }, SYSTEM, undefined, TEST_CATALOG)[0].code).toBe('unknown-ace');
    const setVar = { id: 'set-eventvar-value', parameters: { variable: 'a', value: '1' } };
    expect(checkAce('conditions', setVar, SYSTEM, undefined, TEST_CATALOG)[0].code).toBe('unknown-ace');
  });

  it('accepts common ACEs on plugin objects but not on System or on behaviors', () => {
    const setVar = { id: 'set-instvar-value', parameters: { 'instance-variable': 'hp', value: '3' } };
    expect(checkAce('actions', setVar, SPRITE, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkAce('actions', setVar, SYSTEM, undefined, TEST_CATALOG)[0].message).toBe('Construct r495.2 defines no action "set-instvar-value" for the System object.');
    expect(checkAce('actions', setVar, PLATFORM, undefined, TEST_CATALOG)[0].code).toBe('unknown-ace');
  });

  it('reports unknown and missing parameter names', () => {
    const problems = checkAce('actions', { id: 'set-position', parameters: { x: '1', z: '2' } }, SPRITE, undefined, TEST_CATALOG);
    expect(problems.map(p => p.code)).toEqual(['unknown-parameter', 'missing-parameter']);
    expect(problems[0].message).toBe('The action "set-position" of the Sprite plugin has no parameter(s) "z". Its parameters are "x", "y".');
    expect(problems[1].message).toBe('The action "set-position" of the Sprite plugin is missing parameter(s) "y".');
  });

  it('reports a parameterized ACE given no parameters at all', () => {
    expect(checkAce('actions', { id: 'set-position' }, SPRITE, undefined, TEST_CATALOG)).toEqual([{
      code: 'missing-parameter',
      message: 'The action "set-position" of the Sprite plugin takes parameter(s) "x", "y", and none are given.',
    }]);
  });

  it('reports a combo value that is not one of its choices', () => {
    expect(checkAce('actions', { id: 'simulate-control', parameters: { control: 'jump' } }, PLATFORM, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkAce('actions', { id: 'simulate-control', parameters: { control: 'fly' } }, PLATFORM, undefined, TEST_CATALOG)).toEqual([{
      code: 'invalid-choice',
      message: 'Parameter "control" of the action "simulate-control" is "fly"; the Platform behavior accepts "left", "right", "jump".',
    }]);
    // A combo stores the choice's ID string, not its index.
    expect(checkAce('actions', { id: 'simulate-control', parameters: { control: 2 } }, PLATFORM, undefined, TEST_CATALOG)[0].code).toBe('invalid-choice');
  });

  it('skips addons that neither the catalogue nor the registry knows', () => {
    expect(checkAce('actions', { id: 'anything', parameters: { x: 1 } }, { kind: 'plugin', id: 'someone_advancedLog' }, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkAce('actions', { id: 'anything' }, { kind: 'behavior', id: 'someone_fsm' }, registry(logger([])), TEST_CATALOG)).toEqual([]);
  });

  it('leaves positional parameters alone', () => {
    expect(checkAce('actions', { id: 'set-position', parameters: ['1', '2'] }, SPRITE, undefined, TEST_CATALOG)).toEqual([]);
  });

  it('names the release of the catalogue given, whatever it is', () => {
    const newer = { ...clone(TEST_CATALOG), release: 'r506-2' };
    const [problem] = checkAce('actions', { id: 'nope' }, SPRITE, undefined, newer);
    expect(problem.code).toBe('unknown-ace');
    expect(problem.message).toContain('Construct r506.2 defines no action "nope"');
  });

  it('does not check parameters whose definition could not be read, and keeps checking the others', () => {
    const catalog = clone(TEST_CATALOG);
    catalog.plugins.Sprite.actions.mixed = [
      { id: 'a', type: 'string' },
      { id: '', type: 'unknown' },
      { id: 'c', type: 'combo', items: ['x', 'y'] },
    ];
    const check = (parameters: unknown) => checkAce('actions', { id: 'mixed', parameters }, SPRITE, undefined, catalog);
    expect(check({ a: '1', c: 'x' })).toEqual([]);
    // With an unreadable parameter the names a call may carry are not known.
    expect(check({ a: '1', c: 'x', extra: '3' })).toEqual([]);
    expect(check({ a: '1' }).map(p => p.message)).toEqual(['The action "mixed" of the Sprite plugin is missing parameter(s) "c".']);
    expect(check({ a: '1', c: 'z' }).map(p => p.code)).toEqual(['invalid-choice']);
    expect(check(null)[0].message).toContain('takes parameter(s) "a", "c", and none are given');
    catalog.plugins.Sprite.actions.opaque = [{ id: '', type: 'unknown' }];
    expect(checkAce('actions', { id: 'opaque' }, SPRITE, undefined, catalog)).toEqual([]);
  });

  it('still checks names when an unreadable parameter kept its id', () => {
    const catalog = clone(TEST_CATALOG);
    catalog.plugins.Sprite.actions.named = [{ id: 'a', type: 'string' }, { id: 'b', type: 'unknown' }];
    const check = (parameters: unknown) => checkAce('actions', { id: 'named', parameters }, SPRITE, undefined, catalog);
    expect(check({ a: '1', b: '2' })).toEqual([]);
    expect(check({ a: '1' })).toEqual([]);
    const problems = check({ a: '1', zz: '3' });
    expect(problems.map(p => p.code)).toEqual(['unknown-parameter']);
    expect(problems[0].message).toContain('Its parameters are "a", "b".');
  });
});

describe('ids that are names on Object.prototype', () => {
  it('are unknown ACEs and unknown owners, not errors', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(checkAce('actions', { id }, SPRITE, undefined, TEST_CATALOG).map(p => p.code)).toEqual(['unknown-ace']);
      expect(checkAce('conditions', { id }, SYSTEM, registry(), TEST_CATALOG).map(p => p.code)).toEqual(['unknown-ace']);
      expect(checkAce('actions', { id }, { kind: 'plugin', id }, undefined, TEST_CATALOG)).toEqual([]);
      expect(checkAce('actions', { id }, { kind: 'behavior', id }, undefined, TEST_CATALOG)).toEqual([]);
      expect(isBuiltInAddon('plugin', id, TEST_CATALOG)).toBe(false);
      expect(isBuiltInAddon('behavior', id, TEST_CATALOG)).toBe(false);
      expect(hasAceDefinitions({ kind: 'plugin', id }, undefined, TEST_CATALOG)).toBe(false);
    }
  });

  it('are not parameters a call is taken to carry', () => {
    const catalog = clone(TEST_CATALOG);
    catalog.plugins.Sprite.actions.probe = [{ id: 'toString', type: 'string' }];
    expect(checkAce('actions', { id: 'probe', parameters: {} }, SPRITE, undefined, catalog).map(p => p.code)).toEqual(['missing-parameter']);
    expect(checkAce('actions', { id: 'probe', parameters: { toString: '1' } }, SPRITE, undefined, catalog)).toEqual([]);
    const extra = checkAce('actions', { id: 'set-x', parameters: { x: '1', constructor: '2' } }, SPRITE, undefined, TEST_CATALOG);
    expect(extra.map(p => p.code)).toEqual(['unknown-parameter']);
    expect(extra[0].message).toContain('"constructor"');
  });

  it('give no problem for a project object or behavior of that name', () => {
    const events = [{ conditions: [], actions: [{ id: 'constructor', objectClass: 'toString', sid: 1 }, { id: 'x', objectClass: 'Player', behaviorType: '__proto__', sid: 2 }] }];
    const ctx = buildAceContext(projectData([objectType('Player', 'Sprite')]));
    expect(checkEventAces(events, ctx, undefined, TEST_CATALOG)).toEqual([]);
  });
});

describe('the addon registry is an argument', () => {
  it('gives different answers for the same third-party ACE under different registries', () => {
    const owner = { kind: 'plugin', id: 'someone_advancedLog' } as const;
    const ace = { id: 'log', parameters: {} };
    const none = registry(logger([]));
    const wide = registry(logger([{ id: 'text', type: 'string' }]));
    expect(checkAce('actions', ace, owner, none, TEST_CATALOG)).toEqual([]);
    expect(checkAce('actions', ace, owner, wide, TEST_CATALOG).map(p => p.code)).toEqual(['missing-parameter']);
    expect(checkAce('actions', { id: 'other' }, owner, none, TEST_CATALOG).map(p => p.code)).toEqual(['unknown-ace']);
    expect(checkAce('actions', ace, owner, undefined, TEST_CATALOG)).toEqual([]);
    expect(hasAceDefinitions(owner, none, TEST_CATALOG)).toBe(true);
    expect(hasAceDefinitions(owner, registry(), TEST_CATALOG)).toBe(false);
    expect(hasAceDefinitions(owner, undefined, TEST_CATALOG)).toBe(false);
    expect(hasAceDefinitions(SPRITE, undefined, TEST_CATALOG)).toBe(true);
  });

  it('checks events against the registry it is given', () => {
    const events = [{ actions: [{ id: 'log', objectClass: 'Logger', sid: 5, parameters: {} }] }];
    expect(checkEventAces(events, context, registry(logger([])), TEST_CATALOG)).toEqual([]);
    expect(checkEventAces(events, context, registry(logger([{ id: 'text', type: 'string' }])), TEST_CATALOG).map(p => [p.sid, p.code]))
      .toEqual([[5, 'missing-parameter']]);
  });
});

describe('common ACEs are not capability-checked (stated limit)', () => {
  it('accepts a common action on Audio, which cannot move, and still reports an unknown id or a wrong parameter', () => {
    expect(checkAce('actions', { id: 'set-x', parameters: { x: '1' } }, AUDIO, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkAce('actions', { id: 'set-sideways', parameters: {} }, AUDIO, undefined, TEST_CATALOG).map(p => p.code)).toEqual(['unknown-ace']);
    expect(checkAce('actions', { id: 'set-x', parameters: { y: '1' } }, AUDIO, undefined, TEST_CATALOG).map(p => p.code))
      .toEqual(['unknown-parameter', 'missing-parameter']);
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

describe('behavior names match without case', () => {
  const ctx = buildAceContext(projectData(
    [objectType('Player', 'Sprite', [['Platform', 'Platform']]), objectType('Grunt', 'Sprite')],
    [{ name: 'Mobs', 'plugin-id': 'Sprite', members: ['Grunt'], behaviorTypes: [{ name: 'Platform', behaviorId: 'Platform', sid: 3 }] }],
  ));

  it('resolves the same behavior for every spelling of the name', () => {
    for (const spelling of ['platform', 'PLATFORM', 'Platform']) {
      expect(ctx.behaviorOf('Player', spelling)).toBe('Platform');
      expect(ctx.behaviorOf('Mobs', spelling)).toBe('Platform');
      expect(ctx.behaviorOf('Grunt', spelling)).toBe('Platform');
    }
    expect(ctx.behaviorOf('Player', 'Jetpack')).toBeUndefined();
    expect(ctx.behaviorOf('Grunt', 'Jetpack')).toBeUndefined();
  });

  it('checks an ACE whose behaviorType is written in another case against that behavior', () => {
    const events = [{
      actions: [
        { id: 'simulate-control', objectClass: 'Player', behaviorType: 'platform', sid: 1, parameters: { control: 'jump' } },
        { id: 'simulate-controls', objectClass: 'Player', behaviorType: 'platform', sid: 2, parameters: { control: 'jump' } },
        { id: 'simulate-controls', objectClass: 'Grunt', behaviorType: 'PLATFORM', sid: 3, parameters: { control: 'jump' } },
        { id: 'simulate-controls', objectClass: 'Mobs', behaviorType: 'platform', sid: 4, parameters: { control: 'jump' } },
        { id: 'simulate-controls', objectClass: 'Player', behaviorType: 'Jetpack', sid: 5 },
      ],
    }];
    expect(checkEventAces(events, ctx, undefined, TEST_CATALOG).map(p => [p.sid, p.code])).toEqual([
      [2, 'unknown-ace'], [3, 'unknown-ace'], [4, 'unknown-ace'],
    ]);
  });
});

describe('an ACE that names its behavior only under the legacy key', () => {
  const ctx = buildAceContext(projectData([objectType('Player', 'Sprite', [['Platform', 'Platform']])]));

  it('is left to the legacy-key check, not reported as an unknown ACE of the base plugin', () => {
    const events = [{
      actions: [
        { id: 'simulate-control', objectClass: 'Player', 'behavior-type': 'Platform', sid: 1, parameters: { control: 'jump' } },
        { id: 'simulate-control', objectClass: 'Player', 'behavior-type': 'Platform', behaviorType: 'Platform', sid: 2, parameters: { control: 'fly' } },
        { id: 'simulate-control', objectClass: 'Player', sid: 3, parameters: { control: 'jump' } },
      ],
    }];
    expect(checkEventAces(events, ctx, undefined, TEST_CATALOG).map(p => [p.sid, p.code])).toEqual([
      [2, 'invalid-choice'], [3, 'unknown-ace'],
    ]);
  });
});

describe('checkEventAces', () => {
  const events = [
    {
      eventType: 'block',
      conditions: [{ id: 'on-start-of-layout', objectClass: 'System', sid: 1 }],
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
        {
          eventType: 'block',
          conditions: [{ id: 'compare-instance-variable', objectClass: 'Enemies', sid: 8, parameters: { 'instance-variable': 'hp', comparison: 0, value: '1' } }],
          actions: [{ id: 'explode', objectClass: 'Enemies', sid: 9 }],
        },
      ],
    },
  ];

  it('checks standard ACEs at every depth and skips calls, comments and third-party addons', () => {
    const problems = checkEventAces(events, context, undefined, TEST_CATALOG);
    expect(problems.map(p => [p.sid, p.code])).toEqual([[3, 'unknown-ace'], [6, 'invalid-choice'], [9, 'unknown-ace']]);
    expect(describeEventAceProblem(problems[0], 'r495-2')).toBe('Action "teleport" on "Player" (SID 3): Construct r495.2 defines no action "teleport" for the Sprite plugin.');
  });

  it('skips a function call and a custom action call by its shape, also when it carries an id and an object class', () => {
    const calls = [{
      actions: [
        { id: 'call-function', objectClass: 'System', callFunction: 'fn1', sid: 20, parameters: { 0: '1' } },
        { id: 'call-function', objectClass: 'System', callFunction: 'fn1', sid: 21, parameters: { p1: '2' } },
        { id: 'do-it', objectClass: 'Player', customAction: 'Heal', sid: 22, parameters: { 0: '1' } },
        { id: 'call-function', objectClass: 'System', sid: 23, parameters: { 0: '1' } },
      ],
    }];
    expect(checkEventAces(calls, context, undefined, TEST_CATALOG).map(p => [p.sid, p.code])).toEqual([[23, 'unknown-ace']]);
  });

  it('stops below 64 levels of children, for the check and for the snapshot', () => {
    const nest = (levels: number): unknown[] => {
      let events: unknown[] = [{ actions: [{ id: 'deep', objectClass: 'Player', sid: 1000 + levels }] }];
      for (let i = levels - 1; i >= 0; i--) events = [{ actions: [{ id: 'deep', objectClass: 'Player', sid: 1000 + i }], children: events }];
      return events;
    };
    const tree = nest(70);
    const sids = checkEventAces(tree, context, undefined, TEST_CATALOG).map(p => p.sid);
    expect(sids).toContain(1064);
    expect(sids).not.toContain(1065);
    expect(sids).not.toContain(1070);
    const snapshot = aceTreeSnapshot(tree);
    expect(snapshot.has(1064)).toBe(true);
    expect(snapshot.has(1065)).toBe(false);
  });

  it('checks no ACE without a SID when it is limited to SIDs', () => {
    const noSid = [{ actions: [{ id: 'teleport', objectClass: 'Player' }] }];
    expect(checkEventAces(noSid, context, undefined, TEST_CATALOG)).toHaveLength(1);
    expect(checkEventAces(noSid, context, undefined, TEST_CATALOG, new Set([1]))).toEqual([]);
  });

  it('limits the check to the SIDs it is given', () => {
    expect(checkEventAces(events, context, undefined, TEST_CATALOG, new Set([9])).map(p => p.sid)).toEqual([9]);
    expect(checkEventAces(events, context, undefined, TEST_CATALOG, new Set([2]))).toEqual([]);
  });

  it('tells which ACEs anywhere in the tree an edit touched', () => {
    const edited = JSON.parse(JSON.stringify(events)) as typeof events;
    const before = aceTreeSnapshot(edited);
    expect([...before.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    edited[0].actions[0].parameters = { x: '5', y: '2' };
    edited[0].children[0].actions.push({ id: 'destroy', objectClass: 'Enemies', sid: 10 } as never);
    expect([...changedAceSidsInTree(before, edited)].sort((a, b) => a - b)).toEqual([2, 10]);
    expect(changedAceSidsInTree(before, JSON.parse(JSON.stringify(events)))).toEqual(new Set());
  });
});

describe('releaseHedge and describeEventAceProblem', () => {
  const problem: EventAceProblem = {
    code: 'unknown-ace', message: 'Construct r495.2 defines no action "x" for the Sprite plugin.',
    kind: 'actions', aceId: 'x', objectClass: 'Player', sid: 3,
  };
  const sentence = ' The project was saved with release r506.2, newer than r495.2 whose definitions were used, so the editor that saved it may define this.';

  it('ends the finding with the sentence when the project was saved with a newer release', () => {
    const text = describeEventAceProblem(problem, 'r495-2', 50602);
    expect(text.endsWith(sentence)).toBe(true);
    expect(text).not.toContain('50602');
    expect(releaseHedge('r495-2', 50602)).toBe(sentence);
  });

  it('says the project is older when it was saved with an older release', () => {
    const older = ' The project was saved with release r440, older than r495.2 whose definitions were used, so the editor that saved it may have defined this differently.';
    expect(releaseHedge('r495-2', 44000)).toBe(older);
    expect(describeEventAceProblem(problem, 'r495-2', 44000).endsWith(older)).toBe(true);
  });

  it('adds nothing for an equal or unknown release', () => {
    for (const saved of [49502, undefined]) {
      expect(describeEventAceProblem(problem, 'r495-2', saved)).toBe(describeEventAceProblem(problem, 'r495-2'));
      expect(describeEventAceProblem(problem, 'r495-2', saved)).not.toContain('saved with release');
    }
    expect(releaseHedge('r495-2', 49502)).toBe('');
  });

  it('never hedges against a catalogue release it cannot order', () => {
    expect(releaseHedge('bad', 50602)).toBe('');
    expect(describeEventAceProblem(problem, 'bad', 50602)).not.toContain('saved with release');
  });

  it('adds nothing for a saved-with number that is not a release', () => {
    expect(releaseHedge('r495-2', 10_000_000)).toBe('');
  });

  it('names the release of a catalogue given as r506-2', () => {
    const catalog = { ...clone(TEST_CATALOG), release: 'r506-2' };
    const [found] = checkEventAces([{ actions: [{ id: 'nope', objectClass: 'Player', sid: 1 }] }], context, undefined, catalog);
    expect(found.message).toBe('Construct r506.2 defines no action "nope" for the Sprite plugin.');
  });
});

/** A temp copy of the minimal project with extra object type, family and event sheet files registered. */
async function createProject(
  files: { objectTypes?: Record<string, string>; families?: Record<string, string>; eventSheets?: Record<string, string> },
  registeredWithoutFile: string[] = [],
): Promise<Construct3ProjectReader> {
  const dir = await mkdtemp(join(tmpdir(), 'c3-ace-catalog-'));
  dirs.push(dir);
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const c3proj = join(dir, 'project.c3proj');
  const project = JSON.parse(await readFile(c3proj, 'utf-8')) as Record<'objectTypes' | 'families' | 'eventSheets', { items: string[] }>;
  for (const category of ['objectTypes', 'families', 'eventSheets'] as const) {
    for (const [name, text] of Object.entries(files[category] ?? {})) {
      project[category].items.push(name);
      await mkdir(join(dir, category), { recursive: true });
      await writeFile(join(dir, category, `${name}.json`), text);
    }
  }
  project.objectTypes.items.push(...registeredWithoutFile);
  await writeFile(c3proj, JSON.stringify(project, null, '\t'));
  const reader = new Construct3ProjectReader(c3proj);
  await reader.loadProject();
  return reader;
}

type ProjectReaderLike = Parameters<typeof readProjectData>[0];

/** The reader's own methods, with some replaced. */
function delegating(reader: Construct3ProjectReader, overrides: Partial<ProjectReaderLike>): ProjectReaderLike {
  return {
    listObjectTypes: () => reader.listObjectTypes(),
    listFamilies: () => reader.listFamilies(),
    listEventSheets: () => reader.listEventSheets(),
    readAllObjectTypes: () => reader.readAllObjectTypes(),
    readAllFamilies: () => reader.readAllFamilies(),
    readAllEventSheets: () => reader.readAllEventSheets(),
    getReadFailures: category => reader.getReadFailures(category),
    ...overrides,
  };
}

const GOOD_PLAYER = JSON.stringify(objectType('Player', 'Sprite', [['Platform', 'Platform']]));

describe('readProjectData and buildAceContext', () => {
  const sheet = (action: Record<string, unknown>): string => JSON.stringify({
    name: 'S', sid: 1, events: [{ eventType: 'block', conditions: [], actions: [action], sid: 2 }],
  });

  it('marks the context incomplete for an unreadable object type, skips its ACEs and checks the others', async () => {
    const reader = await createProject({
      objectTypes: { Player: GOOD_PLAYER, Broken: '{ broken' },
      eventSheets: {
        Uses: sheet({ id: 'nope', objectClass: 'Broken', sid: 10 }),
        Uses2: sheet({ id: 'nope', objectClass: 'Player', sid: 11 }),
      },
    });
    const data = await readProjectData(reader);
    expect(data.unreadable).toEqual({ objectTypes: ['objectTypes/Broken'], families: [], eventSheets: [] });
    const ctx = buildAceContext(data);
    expect(ctx.complete).toBe(false);
    expect(ctx.unreadable).toEqual(['objectTypes/Broken']);
    const problems = [...data.sheets.values()].flatMap(s => checkEventAces(s.events, ctx, undefined, TEST_CATALOG));
    expect(problems.map(p => [p.sid, p.objectClass, p.code])).toEqual([[11, 'Player', 'unknown-ace']]);
  });

  it('is complete when everything is readable', async () => {
    const reader = await createProject({ objectTypes: { Player: GOOD_PLAYER } });
    const ctx = buildAceContext(await readProjectData(reader));
    expect(ctx.complete).toBe(true);
    expect(ctx.unreadable).toEqual([]);
    expect(ctx.pluginOf('Player')).toBe('Sprite');
  });

  it('lists an unreadable family and an unreadable event sheet as <category>/<name>', async () => {
    const reader = await createProject({
      objectTypes: { Player: GOOD_PLAYER },
      families: { Bad: '{ nope' },
      eventSheets: { Torn: '[' },
    });
    const data = await readProjectData(reader);
    expect(data.unreadable).toEqual({ objectTypes: [], families: ['families/Bad'], eventSheets: ['eventSheets/Torn'] });
    const ctx = buildAceContext(data);
    expect(ctx.complete).toBe(false);
    expect(ctx.unreadable).toEqual(['families/Bad']);
  });

  it('takes each category\'s failures before the next read', async () => {
    // "Ghost" is registered with no file: a bulk read records it as not found, which is not an unparsable file.
    const reader = await createProject({ objectTypes: { Player: GOOD_PLAYER, Broken: '{ broken' } }, ['Ghost']);
    expect((await readProjectData(reader)).unreadable.objectTypes).toEqual(['objectTypes/Broken']);
    reader.invalidateCaches();
    // A concurrent reload clears the object types' failures while the family read runs.
    let reloaded = false;
    const reloading = delegating(reader, {
      readAllFamilies: async () => {
        reloaded = true;
        return reader.readAllFamilies();
      },
      getReadFailures: category => (reloaded && category === 'objectTypes' ? new Map() : reader.getReadFailures(category)),
    });
    const data = await readProjectData(reloading);
    expect(data.unreadable.objectTypes).toEqual(['objectTypes/Broken']);
    expect(buildAceContext(data).unreadable).toEqual(['objectTypes/Broken']);
  });

  it('reads no event sheets and reports none unreadable with sheets: false', async () => {
    const reader = await createProject({ objectTypes: { Player: GOOD_PLAYER }, eventSheets: { Torn: '[' } });
    let sheetReads = 0;
    const counting = delegating(reader, {
      readAllEventSheets: async () => {
        sheetReads++;
        return reader.readAllEventSheets();
      },
    });
    const data = await readProjectData(counting, { sheets: false });
    expect(sheetReads).toBe(0);
    expect(data.sheets.size).toBe(0);
    expect(data.unreadable.eventSheets).toEqual([]);
    expect((await readProjectData(counting)).unreadable.eventSheets).toEqual(['eventSheets/Torn']);
    expect(sheetReads).toBe(1);
  });

  it('reads nothing when it builds the context', () => {
    const data = projectData([objectType('Player', 'Sprite')]);
    data.unreadable.families.push('families/Gone');
    const ctx = buildAceContext(data);
    expect(ctx.complete).toBe(false);
    expect(ctx.unreadable).toEqual(['families/Gone']);
    expect(ctx.pluginOf('Player')).toBe('Sprite');
    expect(ctx.pluginOf('Unknown')).toBeUndefined();
  });
});
