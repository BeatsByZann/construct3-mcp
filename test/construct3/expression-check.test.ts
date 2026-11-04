/**
 * Expression checking: the tokenizer, the parser, and name resolution against
 * a small project: Sprite with instance variable hp and behavior "Platform"
 * (built in), Enemy with a behavior named "Walker" that is a Platform,
 * family "Hostiles" (Sprite, Enemy) with instance variable rank, the
 * functions Total(a, b) and Reset(), the event variables Score and lvTally,
 * and a custom action Retreat with the parameter thisAmount. Every test
 * passes TEST_CATALOG, and nothing reads the network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPRESSION_PARAM_TYPES,
  buildExpressionContext,
  checkEventExpressions,
  checkExpression,
  describeEventExpressionProblem,
  hasExpressionParameters,
  tokenize,
  type EventExpressionProblem,
  type ExpressionContext,
  type ExpressionScope,
} from '../../src/construct3/expression-check.js';
import { buildAceContext, readProjectData } from '../../src/construct3/ace-catalog.js';
import type { AceContext } from '../../src/construct3/ace-catalog.js';
import type { AceCatalog, AddonDefinition, AddonLookup, ProjectData } from '../../src/construct3/ace-types.js';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import type { EventSheet, ObjectType } from '../../src/construct3/types.js';
import { TEST_CATALOG } from '../fixtures/ace-catalog.js';
import { guardNetwork } from './ace-fetch-stub.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'minimal-project');
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

// --- Fixtures ----------------------------------------------

function objectType(name: string, pluginId: string, options: { ivars?: string[]; behaviors?: Array<[string, string]> } = {}): ObjectType {
  return {
    name,
    'plugin-id': pluginId,
    sid: 1,
    instanceVariables: (options.ivars ?? []).map(v => ({ name: v, type: 'number', initialValue: 0, sid: 3 })),
    behaviorTypes: (options.behaviors ?? []).map(([behaviorName, behaviorId]) => ({ name: behaviorName, behaviorId, sid: 2 })),
  } as unknown as ObjectType;
}

function familyOf(name: string, members: string[], ivars: string[] = []): Record<string, unknown> {
  return {
    name,
    'plugin-id': 'Sprite',
    members,
    instanceVariables: ivars.map(v => ({ name: v, type: 'number', initialValue: 0, sid: 4 })),
  };
}

/** An action that writes `text` to an event variable, so the expression sits in the "any" parameter `value`. */
function use(sid: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'set-eventvar-value', objectClass: 'System', sid, parameters: { variable: 'Score', value: text }, ...extra };
}

function block(sid: number, actions: unknown[], children: unknown[] = []): Record<string, unknown> {
  return { eventType: 'block', conditions: [], actions, children, sid };
}

function variable(name: string): Record<string, unknown> {
  return { eventType: 'variable', name, type: 'number', initialValue: '0', sid: 9 };
}

const MAIN_EVENTS: unknown[] = [
  variable('Score'),
  variable('lvTally'),
  { eventType: 'function-block', functionName: 'Total', functionParameters: [{ name: 'a' }, { name: 'b' }], children: [], sid: 10 },
  { eventType: 'function-block', functionName: 'Reset', functionParameters: [], children: [], sid: 11 },
  { eventType: 'custom-ace-block', functionName: 'Retreat', functionParameters: [{ name: 'thisAmount' }], children: [], sid: 12 },
];

function sheetOf(name: string, events: unknown[]): EventSheet {
  return { name, sid: 1, events } as unknown as EventSheet;
}

/** The maps of the test project; `sheets` replace the default sheet. */
function projectData(sheets: Record<string, unknown[]> = { Main: MAIN_EVENTS }, extraObjects: ObjectType[] = []): ProjectData {
  const objects = [
    objectType('Sprite', 'Sprite', { ivars: ['hp'], behaviors: [['Platform', 'Platform']] }),
    objectType('Enemy', 'Sprite', { behaviors: [['Walker', 'Platform']] }),
    objectType('Timer', 'Some_ThirdParty'),
    ...extraObjects,
  ];
  return {
    objects: new Map(objects.map(o => [o.name, o])),
    families: new Map([['Hostiles', familyOf('Hostiles', ['Sprite', 'Enemy'], ['rank'])]]),
    sheets: new Map(Object.entries(sheets).map(([name, events]) => [name, sheetOf(name, events)])),
    unreadable: { objectTypes: [], families: [], eventSheets: [] },
  };
}

function contextOf(data: ProjectData): { ace: AceContext; ctx: ExpressionContext & { complete: boolean; unreadable: string[] } } {
  const ace = buildAceContext(data);
  return { ace, ctx: buildExpressionContext(data, ace) };
}

const base = contextOf(projectData());
const scopeOf = (...names: string[]): ExpressionScope => ({ has: name => names.includes(name) });

const codes = (text: string, self?: string) => checkExpression(text, base.ctx, self, undefined, TEST_CATALOG).map(p => p.code);
const messages = (text: string, self?: string) => checkExpression(text, base.ctx, self, undefined, TEST_CATALOG).map(p => p.message);

/** Every event sheet of `data` checked as the top level of its own file. */
function checkSheets(data: ProjectData, addons?: AddonLookup, catalog: AceCatalog = TEST_CATALOG): EventExpressionProblem[] {
  const { ace, ctx } = contextOf(data);
  return [...data.sheets.values()].flatMap(s => checkEventExpressions(s.events, ctx, ace, addons, catalog));
}

// --- Tests -------------------------------------------------

describe('tokenize', () => {
  it('reads numbers, strings with doubled quotes, names with any letters, and operators', () => {
    expect(tokenize('1 + .5 * 0x1f - "say ""hi""" & fTreeNodes\u{1F332}.X <> lvTally').map(t => `${t.type}:${t.text}`)).toEqual([
      'number:1', 'op:+', 'number:.5', 'op:*', 'number:0x1f', 'op:-', 'string:"say ""hi"""', 'op:&', 'name:fTreeNodes\u{1F332}', 'op:.', 'name:X', 'op:<>', 'name:lvTally',
    ]);
    expect(tokenize('a<=b>=c?d:e').filter(t => t.type === 'op').map(t => t.text)).toEqual(['<=', '>=', '?', ':']);
    expect(tokenize('"open').map(t => t.type)).toEqual(['bad']);
    expect(tokenize('x # y').map(t => t.type)).toEqual(['name', 'bad', 'name']);
  });
});

describe('parsing', () => {
  it('accepts arithmetic, comparison, concatenation, ternaries, unary minus and nesting', () => {
    for (const text of [
      'Sprite.X + (Sprite.Width / 2) * -1', 'Score >= 10 & Score <> 3', '"a" & "b" & Score', 'Score = 1 ? "one" : "many"',
      '(1 + 2) ^ 2 % 3', 'lvTally', '', '  ', 'Score\n? 1\n: 2', 'max(1, 2, 3)', 'distance(0, 0, Sprite.X, Sprite.Y)',
    ]) expect({ text, problems: messages(text) }).toEqual({ text, problems: [] });
  });

  it('reports text that does not parse, once, and stops there', () => {
    expect(codes('Sprite.X +')).toEqual(['expression-grammar']);
    expect(messages('(1 + 2')).toEqual(['a "(" without its ")"']);
    expect(messages('Score ? 1')).toEqual(['a "?" without its ":"']);
    expect(messages('1 2')).toEqual(['unexpected "2" after a complete expression']);
    expect(messages('Sprite.X # 2')).toEqual(['unexpected character "#" after a complete expression']);
    expect(messages('# 2')).toEqual(['the character "#" is not part of an expression']);
    expect(messages('random(1,')).toEqual(['the expression ends where a value was expected']);
    expect(messages('"unterminated')).toEqual(['a string without its closing quote']);
    expect(messages('1 + "open')).toEqual(['a string without its closing quote']);
  });

  it('reports nesting past the limit once, instead of overflowing the stack, and accepts real depths', () => {
    const tooDeep = ['expression-grammar'];
    const message = ['the expression is nested more than 200 levels deep'];
    const parens = (n: number) => `${'('.repeat(n)}1${')'.repeat(n)}`;
    expect(messages(parens(1000))).toEqual(message);
    expect(codes(parens(5000))).toEqual(tooDeep);
    expect(messages(`${'max('.repeat(5000)}1`)).toEqual(message);
    expect(messages(`${'1 ? '.repeat(5000)}1`)).toEqual(message);
    expect(messages(`${'-'.repeat(5000)}1`)).toEqual(message);
    expect(messages(parens(50))).toEqual([]);
    expect(messages(`${'-'.repeat(50)}1`)).toEqual([]);
  });
});

describe('name resolution', () => {
  it('knows plugin, common and behavior expressions, instance variables and families, without case', () => {
    for (const text of [
      'Sprite.X', 'sprite.x', 'Sprite.AnimationName', 'Sprite.ImagePointX("origin")', 'Sprite.hp', 'Sprite.HP', 'Sprite.rank',
      'Sprite.Platform.VectorX', 'Hostiles.rank', 'Sprite(2).Y', 'Sprite.PickedCount',
    ]) expect({ text, problems: messages(text) }).toEqual({ text, problems: [] });
  });

  it('reports an unknown object, member, behavior expression or function, and a bare name nothing declares', () => {
    expect(messages('Ghost.X')).toEqual(['"Ghost" is not an object type or family of this project.']);
    expect(messages('Sprite.Speeed')).toEqual(['"Sprite" has no expression, instance variable or behavior named "Speeed".']);
    expect(messages('Sprite.Platform.Vector')).toEqual(['The "Platform" behavior on "Sprite" has no expression "Vector".']);
    expect(messages('Sprite.Platform')).toEqual(['"Sprite.Platform" names a behavior; an expression of it must follow, such as "Sprite.Platform.Speed".']);
    // A family's instance variable reaches its members; another member's own variable does not.
    expect(messages('Enemy.rank')).toEqual([]);
    expect(messages('Enemy.hp')).toEqual(['"Enemy" has no expression, instance variable or behavior named "hp".']);
    expect(messages('distanse(1, 2, 3, 4)')).toEqual(['"distanse" is not a system expression.']);
    expect(messages('Scor + 1')).toEqual(['"Scor" is not a system expression, an event variable, or an object of this project.']);
  });

  it('checks argument counts, with variadic minimums', () => {
    expect(messages('distance(1, 2)')).toEqual(['"distance" takes 4 argument(s); 2 given.']);
    expect(messages('Sprite.ImagePointX()')).toEqual(['"Sprite.ImagePointX" takes 1 argument(s); 0 given.']);
    expect(messages('Sprite.hp(1)')).toEqual(['"Sprite.hp" is an instance variable and takes no arguments.']);
    expect(messages('random()')).toEqual(['"random" takes at least 1 argument(s); 0 given.']);
    expect(messages('random(1)')).toEqual([]);
    expect(messages('random(1, 6) + loopindex + loopindex("i") + max(1, 2, 3)')).toEqual([]);
    expect(messages('dt + pi + LayoutName')).toEqual([]);
  });

  it('resolves the functions namespace by name, function arity, CallMapped and Self', () => {
    expect(messages('Functions.Total(1, 2) + Functions.Reset()')).toEqual([]);
    expect(messages('Functions.Total(1)')).toEqual(['The function "Total" takes 2 argument(s); 1 given.']);
    expect(messages('Functions.Missing(1)')).toEqual(['No function named "Missing" is defined in any event sheet.']);
    expect(messages('Functions.CallMapped("map", "key")')).toEqual([]);
    expect(messages('Functions.CallMapped()')).toEqual(['"Functions.CallMapped" takes at least 1 argument(s); 0 given.']);
    expect(messages('Ghost.X.Y.Z')).toEqual(['"Ghost" is not an object type or family of this project.']);
    // The Functions object is the project's object of the Function plugin, whatever it is called.
    const renamed = contextOf(projectData({ Main: MAIN_EVENTS }, [objectType('Fn', 'Function')]));
    expect(renamed.ctx.functionsName).toBe('Fn');
    expect(base.ctx.functionsName).toBe('Functions');
    const inRenamed = (text: string) => checkExpression(text, renamed.ctx, undefined, undefined, TEST_CATALOG).map(p => p.message);
    expect(inRenamed('Fn.Total(1, 2) + Fn.ParamCount')).toEqual([]);
    expect(inRenamed('Fn.Missing(1)')).toEqual(['No function named "Missing" is defined in any event sheet.']);
    expect(inRenamed('Fn.Param()')).toEqual(['"Fn.Param" takes 1 argument(s); 0 given.']);
    expect(messages('Self.hp + Self.X', 'Sprite')).toEqual([]);
    expect(messages('Self.hp', 'Enemy')).toEqual(['"Enemy" has no expression, instance variable or behavior named "hp".']);
    expect(checkExpression('thisAmount * 2', base.ctx, undefined, undefined, TEST_CATALOG, scopeOf('thisamount'))).toEqual([]);
  });

  it('resolves the Function plugin\'s own expressions under the functions namespace', () => {
    expect(messages('Functions.Param(0) + Functions.ParamCount + functions.param(1)')).toEqual([]);
    expect(messages('Functions.Param()')).toEqual(['"Functions.Param" takes 1 argument(s); 0 given.']);
    // A name found in no sheet and not in the catalogue's list is unknown only as far as the catalogue goes.
    const noFunctionPlugin = clone(TEST_CATALOG);
    delete (noFunctionPlugin.plugins as Record<string, unknown>).Function;
    expect(checkExpression('Functions.Param(0) + Functions.Whatever', base.ctx, undefined, undefined, noFunctionPlugin)).toEqual([]);
    expect(checkExpression('Functions.Total(1)', base.ctx, undefined, undefined, noFunctionPlugin).map(p => p.code)).toEqual(['expression-argument-count']);
  });

  it('leaves an object of a plugin without definitions alone', () => {
    expect(messages('Timer.Anything(1, 2)')).toEqual([]);
  });

  it('says nothing about a bare name when the catalogue holds no System object', () => {
    const noSystem = clone(TEST_CATALOG);
    delete (noSystem.plugins as Record<string, unknown>).system;
    expect(checkExpression('Whatever + nothing(1)', base.ctx, undefined, undefined, noSystem)).toEqual([]);
  });
});

describe('Name.X.Y is left to the check for missing behaviors and variables', () => {
  it('reports no member for an unknown middle part, but still reports a two-part name and a behavior expression', () => {
    expect(codes('Sprite.NoSuchBehavior.Speed')).toEqual([]);
    expect(codes('Sprite.NoSuchBehavior.Speed(1).More')).toEqual([]);
    expect(codes('Sprite.NoSuchThing')).toEqual(['expression-unknown-member']);
    expect(codes('Sprite.Platform.NoSuchExpr')).toEqual(['expression-unknown-member']);
  });
});

describe('behavior names', () => {
  it('resolves a behavior without case and names it as registered', () => {
    for (const text of ['Sprite.Platform.VectorX', 'Sprite.platform.VectorX', 'Sprite.PLATFORM.vectorx', 'Hostiles.platform.VectorX']) {
      expect({ text, problems: messages(text) }).toEqual({ text, problems: [] });
    }
    expect(messages('Sprite.platform.NoSuchExpr')).toEqual(['The "Platform" behavior on "Sprite" has no expression "NoSuchExpr".']);
    // Both spellings are one fault, reported once.
    expect(messages('Sprite.platform.NoSuchExpr + Sprite.PLATFORM.NoSuchExpr')).toHaveLength(1);
    expect(messages('Sprite.PLATFORM')).toEqual(['"Sprite.Platform" names a behavior; an expression of it must follow, such as "Sprite.Platform.Speed".']);
    expect(codes('Sprite.NoSuchBehavior.VectorX')).toEqual([]);
  });

  it('names the behavior as the object registers it, not by its ID, and through a family', () => {
    expect(messages('Enemy.walker.NoSuch')).toEqual(['The "Walker" behavior on "Enemy" has no expression "NoSuch".']);
    expect(messages('Hostiles.platform.NoSuch')).toEqual(['The "Platform" behavior on "Hostiles" has no expression "NoSuch".']);
    expect(messages('Hostiles.walker.VectorX')).toEqual([]);
  });
});

describe('variadic minimum', () => {
  it('reports a bare or called variadic expression that has fewer than its required arguments', () => {
    for (const text of ['choose', 'choose()', 'choose(1)']) {
      expect({ text, codes: codes(text) }).toEqual({ text, codes: ['expression-argument-count'] });
    }
    expect(messages('choose')).toEqual(['"choose" takes at least 2 argument(s); 0 given.']);
    expect(messages('choose(1)')).toEqual(['"choose" takes at least 2 argument(s); 1 given.']);
    for (const text of ['choose(1, 2)', 'choose(1, 2, 3)', 'loopindex', 'loopindex()']) {
      expect({ text, problems: messages(text) }).toEqual({ text, problems: [] });
    }
  });
});

describe('catalogue-dependent findings and the release hedge', () => {
  const hedge = 'The project was saved with release r506.2, newer than r495.2 whose definitions were used, so the editor that saved it may define this.';
  const defined = [{ name: 'Calc', params: ['x'] }];
  const functions = (): unknown[] => defined.map((f, i) => ({
    eventType: 'function-block', functionName: f.name, functionParameters: f.params.map(name => ({ name })), children: [], sid: 100 + i,
  }));

  function found(texts: string[]): EventExpressionProblem[] {
    const events = [...functions(), block(1, texts.map((t, i) => use(20 + i, t)))];
    return checkSheets(projectData({ Main: events }));
  }

  it('marks and hedges what rests on the catalogue and nothing else', () => {
    const [unknownFunction, unknownMember, unknownName, count, namespaced, paramCount] = found([
      'newfunc(1)', 'Sprite.NoSuchExpr', 'Whatsit', 'distance(1)', 'Functions.NewThing(1)', 'Functions.Param()',
    ]);
    for (const p of [unknownFunction, unknownMember, unknownName, count, namespaced, paramCount]) {
      expect(p.fromCatalog).toBe(true);
      expect(describeEventExpressionProblem(p, 'r495-2', 50602)).toMatch(new RegExp(`${hedge.replace(/\./g, '\\.')}$`));
      expect(describeEventExpressionProblem(p, 'r495-2', 49502)).not.toContain('saved with release');
      expect(describeEventExpressionProblem(p, 'r495-2')).not.toContain('saved with release');
    }
    expect([unknownFunction.code, unknownMember.code, unknownName.code, count.code, namespaced.code, paramCount.code]).toEqual([
      'expression-unknown-function', 'expression-unknown-member', 'expression-unknown-name', 'expression-argument-count',
      'expression-unknown-function', 'expression-argument-count',
    ]);
  });

  it('does not mark grammar, an unknown object, a sheet function, an instance variable or a behavior name', () => {
    const problems = found(['1 +', 'Hero.x', 'Functions.Calc(1, 2)', 'Sprite.hp(1)', 'Sprite.Platform']);
    expect(problems.map(p => p.code)).toEqual([
      'expression-grammar', 'expression-unknown-object', 'expression-argument-count', 'expression-argument-count', 'expression-unknown-member',
    ]);
    for (const p of problems) {
      expect({ code: p.code, fromCatalog: p.fromCatalog }).toEqual({ code: p.code, fromCatalog: false });
      expect(describeEventExpressionProblem(p, 'r495-2', 50602)).not.toContain('saved with release');
    }
  });

  it('marks a count checked against the catalogue and not one checked against an addon\'s own definition', () => {
    const addon: AddonDefinition = {
      id: 'someone_thing', type: 'plugin', name: 'Thing', source: 'thing',
      aces: { conditions: {}, actions: {}, expressions: { known: { name: 'Known', params: ['number'] } } },
      counts: { conditions: 0, actions: 0, expressions: 1 },
    };
    const behavior: AddonDefinition = { ...addon, id: 'someone_fsm', type: 'behavior', aces: { ...addon.aces, expressions: {} } };
    const registry: AddonLookup = { get: (type, id) => [addon, behavior].find(d => d.type === type && d.id === id) };
    const data = projectData({ Main: [block(1, [use(2, 'Gadget.Known()'), use(3, 'Gadget.Unlisted'), use(4, 'Gadget.Machine.Anything')])] }, [
      objectType('Gadget', 'someone_thing', { behaviors: [['Machine', 'someone_fsm']] }),
    ]);
    const problems = checkSheets(data, registry);
    expect(problems.map(p => [p.sid, p.code, p.fromCatalog])).toEqual([
      // The addon's own definition: another release of Construct has no say.
      [2, 'expression-argument-count', false],
      // The common expressions are the catalogue's, so a name in neither list is hedged.
      [3, 'expression-unknown-member', true],
      // An addon behavior's list is the addon's alone.
      [4, 'expression-unknown-member', false],
    ]);
  });
});

describe('checkEventExpressions', () => {
  const events = [{
    eventType: 'block', sid: 1,
    conditions: [
      { id: 'compare-two-values', objectClass: 'System', sid: 2, parameters: { 'first-value': 'Sprite.hp', comparison: 0, 'second-value': 'Scor' } },
    ],
    actions: [
      { id: 'set-position', objectClass: 'Sprite', sid: 3, parameters: { x: 'Sprite.X + 1', y: 'Enemy.hp' } },
      { id: 'set-animation', objectClass: 'Sprite', sid: 4, parameters: { animation: '"Walk"', from: 'beginning' } },
      { id: 'set-eventvar-value', objectClass: 'System', sid: 5, parameters: { variable: 'Nope', value: '1' } },
      { callFunction: 'Total', sid: 6, parameters: ['Sprite.X', 'Nope'] },
      { customAction: 'Retreat', objectClass: 'Sprite', sid: 7, parameters: ['Self.hp'] },
      { id: 'no-such-action', objectClass: 'Sprite', sid: 8, parameters: { x: 'Nope' } },
    ],
  }];

  it('checks expression-typed parameters and call arguments, and skips choices, names and unknown ACEs', () => {
    const problems = checkEventExpressions(events, base.ctx, base.ace, undefined, TEST_CATALOG);
    expect(problems.map(p => [p.sid, p.parameter, p.code])).toEqual([
      [2, 'second-value', 'expression-unknown-name'],
      [3, 'y', 'expression-unknown-member'],
      [6, '#1', 'expression-unknown-name'],
    ]);
    expect(describeEventExpressionProblem(problems[1], 'r495-2')).toBe('Action "set-position" on "Sprite" (SID 3), parameter "y" = "Enemy.hp": "Enemy" has no expression, instance variable or behavior named "hp".');
    expect(EXPRESSION_PARAM_TYPES.has('layout')).toBe(false);
    expect(EXPRESSION_PARAM_TYPES.has('layer')).toBe(true);
  });

  it('reads Self in a call that names no object as nothing to resolve, and as the ACE\'s object otherwise', () => {
    const call = (extra: Record<string, unknown>) => [block(1, [{ callFunction: 'Total', sid: 2, parameters: ['Self.hp'], ...extra }])];
    expect(checkEventExpressions(call({}), base.ctx, base.ace, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkEventExpressions(call({ objectClass: 'Sprite' }), base.ctx, base.ace, undefined, TEST_CATALOG)).toEqual([]);
    expect(checkEventExpressions(call({ objectClass: 'Enemy' }), base.ctx, base.ace, undefined, TEST_CATALOG).map(p => p.code)).toEqual(['expression-unknown-member']);
  });

  it('limits itself to the given SIDs', () => {
    expect(checkEventExpressions(events, base.ctx, base.ace, undefined, TEST_CATALOG, new Set([6])).map(p => p.sid)).toEqual([6]);
  });

  it('skips a parameter whose definition could not be read', () => {
    const unreadable = clone(TEST_CATALOG);
    unreadable.common.actions['set-position'][1] = { id: 'y', type: 'unknown' };
    expect(checkEventExpressions(events, base.ctx, base.ace, undefined, unreadable).map(p => p.sid)).toEqual([2, 6]);
  });

  it('reads the parameter types of a third-party addon from the registry', () => {
    const addon: AddonDefinition = {
      id: 'someone_thing', type: 'plugin', name: 'Thing', source: 'thing',
      aces: { conditions: {}, actions: { log: [{ id: 'text', type: 'string' }, { id: 'mode', type: 'combo', items: ['a'] }] }, expressions: {} },
      counts: { conditions: 0, actions: 1, expressions: 0 },
    };
    const registry: AddonLookup = { get: (type, id) => (type === 'plugin' && id === addon.id ? addon : undefined) };
    const data = projectData({ Main: [block(1, [{ id: 'log', objectClass: 'Gadget', sid: 2, parameters: { text: 'Scor', mode: 'Scor' } }])] }, [objectType('Gadget', 'someone_thing')]);
    expect(checkSheets(data, registry).map(p => [p.sid, p.parameter, p.code])).toEqual([[2, 'text', 'expression-unknown-name']]);
    expect(checkSheets(data)).toEqual([]);
  });

  it('skips what is not an event, an ACE or a parameter list, and gives up below 64 levels', () => {
    const nested = (levels: number, sid: number): unknown[] => (levels === 0
      ? [block(sid, [use(sid + 1, 'Zzz')])]
      : [{ eventType: 'block', conditions: [], actions: [], children: nested(levels - 1, sid) }]);
    const events: unknown[] = [
      null, 'text', 7,
      { eventType: 'block', conditions: 'none', actions: null },
      {
        eventType: 'block',
        conditions: [null, 'text'],
        actions: [
          { id: 'set-x', sid: 2, parameters: { x: 'Zzz' } },
          { objectClass: 'Sprite', sid: 3, parameters: { x: 'Zzz' } },
          { id: 'set-x', objectClass: 'Ghost', sid: 4, parameters: { x: 'Zzz' } },
          { id: 'set-x', objectClass: 'Sprite', sid: 5 },
          { id: 'set-x', objectClass: 'Sprite', sid: 6, parameters: ['Zzz'] },
          { id: 'set-x', objectClass: 'Sprite', sid: 7, parameters: null },
          { callFunction: 'Total', sid: 8, parameters: { length: 1, 0: 'Zzz' } },
          { callFunction: 'Total', sid: 10 },
          { id: 'set-x', objectClass: 'Sprite', sid: 9, parameters: { x: 5, y: 'Zzz' } },
        ],
      },
      ...nested(5, 100),
      ...nested(70, 200),
    ];
    const all = checkEventExpressions(events, base.ctx, base.ace, undefined, TEST_CATALOG);
    expect(all.map(p => p.sid)).toEqual([101]);
    expect(checkEventExpressions({ not: 'a list' }, base.ctx, base.ace, undefined, TEST_CATALOG)).toEqual([]);
  });

  it('collects the functions of a sheet that holds entries which are not events', () => {
    const { ctx } = contextOf(projectData({ Main: [null, 'text', { eventType: 'function-block', functionName: 'Solo', children: [] }] }));
    expect(ctx.functions.get('solo')).toBe(0);
  });

  it('does not fail on ids that are names of Object.prototype', () => {
    const data = projectData({ Main: [block(1, [
      { id: 'constructor', objectClass: 'Sprite', sid: 2, parameters: { x: 'Nope' } },
      { id: 'toString', objectClass: 'Gadget', sid: 3, parameters: { x: 'Nope' } },
      use(4, 'Gadget.X + Gadget.constructor + Gadget.Odd.constructor'),
    ])] }, [
      objectType('Gadget', 'constructor', { behaviors: [['Odd', 'toString']] }),
    ]);
    expect(() => checkSheets(data)).not.toThrow();
    expect(checkSheets(data).map(p => p.sid)).toEqual([]);
  });
});

describe('one report per fault', () => {
  const grammar = (text: string): string[] => {
    const events = [block(1, [use(2, text)])];
    return checkEventExpressions(events, base.ctx, base.ace, undefined, TEST_CATALOG).filter(p => p.code === 'expression-grammar').map(p => p.message);
  };

  it('leaves a text the load-time rule reports to that rule, and reports other grammar faults', () => {
    expect(grammar('"abc')).toEqual([]);
    expect(grammar('1 + "abc')).toEqual([]);
    expect(grammar('1 \\ 2')).toEqual([]);
    expect(grammar('1 +')).toEqual(['the expression ends where a value was expected']);
    // The text parser still reports an unterminated string on its own.
    expect(codes('"abc')).toEqual(['expression-grammar']);
  });
});

describe('declarations that could not be read', () => {
  /** A temp copy of the minimal project with extra object type, family and event sheet files registered. */
  async function createProject(
    files: { objectTypes?: Record<string, string>; families?: Record<string, string>; eventSheets?: Record<string, string> },
  ): Promise<Construct3ProjectReader> {
    const dir = await mkdtemp(join(tmpdir(), 'c3-expr-check-'));
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
    await writeFile(c3proj, JSON.stringify(project, null, '\t'));
    const reader = new Construct3ProjectReader(c3proj);
    await reader.loadProject();
    return reader;
  }

  async function problemsOf(reader: Construct3ProjectReader): Promise<{ problems: EventExpressionProblem[]; complete: boolean; unreadable: string[] }> {
    const data = await readProjectData(reader);
    const ace = buildAceContext(data);
    const ctx = buildExpressionContext(data, ace);
    const problems = [...data.sheets.values()].flatMap(s => checkEventExpressions(s.events, ctx, ace, undefined, TEST_CATALOG));
    return { problems, complete: ctx.complete, unreadable: ctx.unreadable };
  }

  const sheet = (name: string, events: unknown[]): string => JSON.stringify({ name, sid: 1, events });
  const globalScore = sheet('A', [variable('Score')]);
  const user = sheet('B', [block(2, [use(3, 'Score + Ghostly'), use(4, 'Hero.hp'), use(5, 'Score +'), use(6, 'distance(1)')])]);

  it('does not report a name declared in a sheet that could not be read', async () => {
    const broken = await problemsOf(await createProject({ eventSheets: { A: '{ broken', B: user } }));
    expect(broken.complete).toBe(false);
    expect(broken.unreadable).toEqual(['eventSheets/A']);
    // Only the codes that need no declarations remain: the grammar fault and the argument count.
    expect(broken.problems.map(p => [p.sid, p.code])).toEqual([[5, 'expression-grammar'], [6, 'expression-argument-count']]);
  });

  it('resolves the name once the file reads, and still reports a name nothing declares', async () => {
    const whole = await problemsOf(await createProject({ eventSheets: { A: globalScore, B: user } }));
    expect(whole.complete).toBe(true);
    expect(whole.unreadable).toEqual([]);
    expect(whole.problems.map(p => [p.sid, p.code, p.expression])).toEqual([
      [3, 'expression-unknown-name', 'Score + Ghostly'],
      [4, 'expression-unknown-object', 'Hero.hp'],
      [5, 'expression-grammar', 'Score +'],
      [6, 'expression-argument-count', 'distance(1)'],
    ]);
  });

  it('does not report an object whose file could not be read', async () => {
    const broken = await problemsOf(await createProject({ objectTypes: { Hero: '{ broken' }, eventSheets: { A: globalScore, B: user } }));
    expect(broken.unreadable).toEqual(['objectTypes/Hero']);
    expect(broken.problems.map(p => [p.sid, p.code])).toEqual([[5, 'expression-grammar'], [6, 'expression-argument-count']]);
    const hero = JSON.stringify(objectType('Hero', 'Sprite', { ivars: ['hp'] }));
    const whole = await problemsOf(await createProject({ objectTypes: { Hero: hero }, eventSheets: { A: globalScore, B: user } }));
    expect(whole.problems.map(p => p.sid)).toEqual([3, 5, 6]);
  });

  it('lists an unreadable family and sheet in the order object types, families, sheets', async () => {
    const result = await problemsOf(await createProject({ objectTypes: { Hero: '[' }, families: { Gang: '{ x' }, eventSheets: { A: '{' } }));
    expect(result.unreadable).toEqual(['objectTypes/Hero', 'families/Gang', 'eventSheets/A']);
  });
});

describe('lexical scope', () => {
  /** Sheet A: a function Calc(Secret) with a local Tmp and sub-events, a second function, a group, a custom action Act(Amount). */
  const sheetA: unknown[] = [
    variable('Score'),
    {
      eventType: 'function-block', functionName: 'Calc', functionParameters: [{ name: 'Secret' }], sid: 30,
      conditions: [], actions: [use(31, 'Secret')],
      children: [
        variable('Tmp'),
        block(32, [use(33, 'Secret + Tmp')], [block(34, [use(35, 'Secret + Tmp')])]),
      ],
    },
    { eventType: 'function-block', functionName: 'Other', functionParameters: [], sid: 40, children: [block(41, [use(42, 'Secret')])] },
    block(50, [use(51, 'Secret'), use(52, 'Score')]),
    { eventType: 'group', title: 'G', sid: 60, children: [block(61, [use(62, 'Tmp')])] },
    {
      eventType: 'custom-ace-block', functionName: 'Act', functionParameters: [{ name: 'Amount' }], sid: 70,
      conditions: [], actions: [use(71, 'Amount')], children: [block(72, [use(73, 'Amount')])],
    },
    block(80, [use(81, 'Amount')]),
  ];
  const sheetB: unknown[] = [block(90, [use(91, 'Score'), use(92, 'Secret')])];

  const reported = (data: ProjectData): Array<[string, number]> => {
    const { ace, ctx } = contextOf(data);
    return [...data.sheets].flatMap(([name, s]) => checkEventExpressions(s.events, ctx, ace, undefined, TEST_CATALOG)
      .filter(p => p.code === 'expression-unknown-name').map((p): [string, number] => [name, p.sid!]));
  };

  it('resolves a parameter or local variable where it is visible and reports it elsewhere', () => {
    expect(reported(projectData({ A: sheetA, B: sheetB }))).toEqual([
      ['A', 42], // another function without that parameter
      ['A', 51], // a top-level event outside the function
      ['A', 62], // a variable of a function's sub-events, used in a sibling group
      ['A', 81], // a custom action's parameter, outside the custom action
      ['B', 92], // another sheet
    ]);
  });

  it('resolves a global declared in one sheet in another', () => {
    const problems = reported(projectData({ A: sheetA, B: sheetB }));
    expect(problems).not.toContainEqual(['B', 91]);
    expect(problems).not.toContainEqual(['A', 52]);
  });

  it('resolves a function parameter in its own actions and its sub-events at any depth', () => {
    const problems = reported(projectData({ A: sheetA }));
    for (const sid of [31, 33, 35]) expect(problems).not.toContainEqual(['A', sid]);
  });

  it('resolves a custom action parameter inside the custom action', () => {
    const problems = reported(projectData({ A: sheetA }));
    for (const sid of [71, 73]) expect(problems).not.toContainEqual(['A', sid]);
  });

  it('does not show a variable declared among an event\'s sub-events to that event\'s own actions', () => {
    // This follows the scope rule of the base reference walk (delete-references walkAces): a variable is visible to
    // the events beside it and below them. It was not observed in the editor, so this pins the rule as stated, not as verified.
    const sheet: unknown[] = [{
      eventType: 'block', conditions: [], sid: 1,
      actions: [use(2, 'Tmp')],
      children: [variable('Tmp'), block(3, [use(4, 'Tmp')]), { eventType: 'block', conditions: [], actions: [use(5, 'Tmp')], children: [], sid: 6 }],
    }];
    expect(reported(projectData({ A: sheet }))).toEqual([['A', 2]]);
  });

  it('reports none of them while a sheet could not be read, whatever their scope', () => {
    const data = projectData({ A: sheetA, B: sheetB });
    data.unreadable.eventSheets.push('eventSheets/Lost');
    expect(reported(data)).toEqual([]);
  });
});

describe('hasExpressionParameters', () => {
  const params = (data: ProjectData) => contextOf(data).ace;
  const ace = params(projectData());

  /** Each case: events that carry `text` in the place under test, and whether that place is an expression parameter a check reads. */
  const cases: Array<{ name: string; events: (text: string) => unknown[]; only: number[]; expected: boolean }> = [
    { name: 'an expression-typed parameter', events: t => [block(1, [use(2, t)])], only: [2], expected: true },
    { name: 'a parameter that names a variable', events: t => [block(1, [{ id: 'set-eventvar-value', objectClass: 'System', sid: 2, parameters: { variable: t } }])], only: [2], expected: false },
    { name: 'a combo parameter', events: t => [block(1, [{ id: 'set-animation', objectClass: 'Sprite', sid: 2, parameters: { from: t } }])], only: [2], expected: false },
    { name: 'an ACE no definition lists', events: t => [block(1, [{ id: 'no-such-action', objectClass: 'Sprite', sid: 2, parameters: { x: t } }])], only: [2], expected: false },
    { name: 'a function call argument', events: t => [block(1, [{ callFunction: 'Total', sid: 2, parameters: [t, '1'] }])], only: [2], expected: true },
    { name: 'a custom action call argument', events: t => [block(1, [{ customAction: 'Retreat', objectClass: 'Sprite', sid: 2, parameters: [t] }])], only: [2], expected: true },
    { name: 'a condition of a sub-event', events: t => [block(1, [], [{ eventType: 'block', actions: [], children: [], conditions: [{ id: 'compare-two-values', objectClass: 'System', sid: 2, parameters: { 'first-value': t, comparison: 0, 'second-value': '1' } }] }])], only: [2], expected: true },
    { name: 'a parameter of an ACE outside the selection', events: t => [block(1, [use(2, t), { id: 'set-eventvar-value', objectClass: 'System', sid: 3, parameters: { variable: 'Score' } }])], only: [3], expected: false },
    { name: 'a parameter that is not a string', events: t => [block(1, [{ ...use(2, t), parameters: { variable: 'Score', value: 5 } }])], only: [2], expected: false },
  ];

  it('agrees with checkEventExpressions finding something to check, case by case', () => {
    const { ctx } = contextOf(projectData());
    for (const c of cases) {
      const found = checkEventExpressions(c.events('Zzz'), ctx, ace, undefined, TEST_CATALOG, new Set(c.only)).length > 0;
      expect({ name: c.name, found }).toEqual({ name: c.name, found: c.expected });
      expect({ name: c.name, has: hasExpressionParameters(c.events('Zzz'), ace, undefined, TEST_CATALOG, new Set(c.only)) }).toEqual({ name: c.name, has: c.expected });
    }
  });

  it('is true for a parameter that is valid, since it is still read', () => {
    expect(hasExpressionParameters([block(1, [use(2, '1')])], ace, undefined, TEST_CATALOG, new Set([2]))).toBe(true);
  });
});

describe('a legacy-keyed ACE', () => {
  it('is not read as an ACE of the plain object', () => {
    // set-x is a common action of a Sprite; with only the legacy key naming a behavior, the owner would be the plain plugin.
    const withLegacy = [block(1, [{ id: 'set-x', objectClass: 'Sprite', 'behavior-type': 'Platform', sid: 2, parameters: { x: 'Zzz' } }])];
    const plain = [block(1, [{ id: 'set-x', objectClass: 'Sprite', sid: 2, parameters: { x: 'Zzz' } }])];
    expect(checkEventExpressions(plain, base.ctx, base.ace, undefined, TEST_CATALOG, new Set([2])).map(p => p.code)).toEqual(['expression-unknown-name']);
    expect(checkEventExpressions(withLegacy, base.ctx, base.ace, undefined, TEST_CATALOG, new Set([2]))).toEqual([]);
    expect(hasExpressionParameters(withLegacy, base.ace, undefined, TEST_CATALOG, new Set([2]))).toBe(false);
    const current = [block(1, [{ id: 'set-x', objectClass: 'Sprite', behaviorType: 'Platform', 'behavior-type': 'Platform', sid: 2, parameters: { x: 'Zzz' } }])];
    // Under the current key too, the ACE belongs to the behavior, which has no set-x.
    expect(checkEventExpressions(current, base.ctx, base.ace, undefined, TEST_CATALOG, new Set([2]))).toEqual([]);
  });
});
