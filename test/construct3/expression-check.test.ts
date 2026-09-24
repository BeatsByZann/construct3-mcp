/**
 * Expression checking (roadmap C2): the tokenizer, the parser, and name
 * resolution against a small project: Sprite "Player" with instance variable
 * hp and behavior "Platform" (built-in), family "Hostiles" (Player, Enemy)
 * with instance variable rank, an object "Functions" of the Function plugin,
 * functions Total(a, b) and Reset(), event variables Score and lvTally, and
 * a custom action parameter thisAmount.
 */
import { describe, it, expect } from 'vitest';
import {
  EXPRESSION_PARAM_TYPES,
  checkEventExpressions,
  checkExpression,
  contextFromDeclarations,
  describeEventExpressionProblem,
  tokenize,
  type ExpressionContext,
} from '../../src/construct3/expression-check.js';
import type { AceContext } from '../../src/construct3/ace-catalog.js';

const ace: AceContext = {
  pluginOf: name => ({ System: 'system', Player: 'Sprite', Enemy: 'Sprite', Hostiles: 'Sprite', Functions: 'Function', Dict: 'Dictionary' } as Record<string, string>)[name],
  behaviorOf: (name, behavior) => ((name === 'Player' || name === 'Hostiles') && behavior === 'Platform' ? 'Platform' : undefined),
};

function context(functionsName = 'Functions'): ExpressionContext {
  const types = [
    { name: 'Player', pluginId: 'Sprite', instanceVariables: ['hp'], behaviors: new Map([['Platform', 'Platform']]), members: [] },
    { name: 'Enemy', pluginId: 'Sprite', instanceVariables: [], behaviors: new Map(), members: [] },
    { name: 'Functions', pluginId: 'Function', instanceVariables: [], behaviors: new Map(), members: [] },
    { name: 'Dict', pluginId: 'Dictionary', instanceVariables: [], behaviors: new Map(), members: [] },
  ];
  const families = [{ name: 'Hostiles', pluginId: 'Sprite', instanceVariables: ['rank'], behaviors: new Map(), members: ['Player', 'Enemy'] }];
  return contextFromDeclarations(types, families, new Map([['total', 2], ['reset', 0]]), new Set(['score', 'lvtally', 'thisamount']), ace, functionsName);
}

const codes = (text: string, self?: string) => checkExpression(text, context(), self).map(p => p.code);
const messages = (text: string, self?: string) => checkExpression(text, context(), self).map(p => p.message);

describe('tokenize', () => {
  it('reads numbers, strings with doubled quotes, names with any letters, and operators', () => {
    expect(tokenize('1 + .5 * 0x1f - "say ""hi""" & fTreeNodes🌲.X <> lvTally').map(t => `${t.type}:${t.text}`)).toEqual([
      'number:1', 'op:+', 'number:.5', 'op:*', 'number:0x1f', 'op:-', 'string:"say ""hi"""', 'op:&', 'name:fTreeNodes🌲', 'op:.', 'name:X', 'op:<>', 'name:lvTally',
    ]);
    expect(tokenize('a<=b>=c?d:e').filter(t => t.type === 'op').map(t => t.text)).toEqual(['<=', '>=', '?', ':']);
    expect(tokenize('"open').map(t => t.type)).toEqual(['bad']);
    expect(tokenize('x # y').map(t => t.type)).toEqual(['name', 'bad', 'name']);
  });
});

describe('parsing', () => {
  it('accepts arithmetic, comparison, concatenation, ternaries, unary minus and nesting', () => {
    for (const text of [
      'Player.X + (Player.Width / 2) * -1', 'Score >= 10 & Score <> 3', '"a" & "b" & Score', 'Score = 1 ? "one" : "many"',
      '(1 + 2) ^ 2 % 3', 'lvTally', '', '  ', 'Score\n? 1\n: 2', 'max(1, 2, 3)', 'distance(0, 0, Player.X, Player.Y)',
    ]) expect({ text, problems: messages(text) }).toEqual({ text, problems: [] });
  });

  it('reports text that does not parse, once, and stops there', () => {
    expect(codes('Player.X +')).toEqual(['expression-syntax']);
    expect(messages('(1 + 2')).toEqual(['a "(" without its ")"']);
    expect(messages('Score ? 1')).toEqual(['a "?" without its ":"']);
    expect(messages('1 2')).toEqual(['unexpected "2" after a complete expression']);
    expect(messages('Player.X # 2')).toEqual(['unexpected character "#" after a complete expression']);
    expect(messages('# 2')).toEqual(['the character "#" is not part of an expression']);
    expect(messages('random(1,')).toEqual(['the expression ends where a value was expected']);
    expect(messages('"unterminated')).toEqual(['a string without its closing quote']);
    expect(messages('1 + "open')).toEqual(['a string without its closing quote']);
  });
});

describe('name resolution', () => {
  it('knows plugin, common and behavior expressions, instance variables and families, without case', () => {
    for (const text of [
      'Player.X', 'player.x', 'Player.AnimationName', 'Player.ImagePointX("origin")', 'Player.hp', 'Player.HP', 'Player.rank',
      'Player.Platform.VectorX', 'Hostiles.rank', 'Hostiles.Count', 'Player(2).Y', 'Player.PickedCount', 'Dict.Get("k")',
    ]) expect({ text, problems: messages(text) }).toEqual({ text, problems: [] });
  });

  it('reports an unknown object, member, behavior expression or function, and a bare name nothing declares', () => {
    expect(messages('Ghost.X')).toEqual(['"Ghost" is not an object type or family of this project.']);
    expect(messages('Player.Speeed')).toEqual(['"Player" has no expression, instance variable or behavior named "Speeed".']);
    expect(messages('Player.Platform.Vector')).toEqual(['The Platform behavior on "Player" has no expression "Vector".']);
    expect(messages('Player.Platform')).toEqual(['"Player.Platform" names a behavior; an expression of it must follow, such as "Player.Platform.Speed".']);
    // A family's instance variable reaches its members; another member's own variable does not.
    expect(messages('Enemy.rank')).toEqual([]);
    expect(messages('Enemy.hp')).toEqual(['"Enemy" has no expression, instance variable or behavior named "hp".']);
    expect(messages('distanse(1, 2, 3, 4)')).toEqual(['"distanse" is not a system expression.']);
    expect(messages('Scor + 1')).toEqual(['"Scor" is not a system expression, an event variable, or an object of this project.']);
  });

  it('checks argument counts, with variadic minimums', () => {
    expect(messages('distance(1, 2)')).toEqual(['"distance" takes 4 argument(s); 2 given.']);
    expect(messages('Player.ImagePointX()')).toEqual(['"Player.ImagePointX" takes 1 argument(s); 0 given.']);
    expect(messages('Player.hp(1)')).toEqual(['"Player.hp" is an instance variable and takes no arguments.']);
    expect(messages('random()')).toEqual(['"random" takes at least 1 argument(s); 0 given.']);
    expect(messages('random(1) + random(1, 6) + loopindex + loopindex("i") + max(1, 2, 3)')).toEqual([]);
    expect(messages('dt + pi + LayoutName')).toEqual([]);
  });

  it('resolves the functions namespace by name, function arity, CallMapped and Self', () => {
    expect(messages('Functions.Total(1, 2) + Functions.Reset()')).toEqual([]);
    expect(messages('Functions.Total(1)')).toEqual(['The function "Total" takes 2 argument(s); 1 given.']);
    expect(messages('Functions.Missing(1)')).toEqual(['No function named "Missing" is defined in any event sheet.']);
    expect(messages('Functions.CallMapped("map", "key")')).toEqual([]);
    expect(checkExpression('Fn.Total(1, 2)', context('Fn')).map(p => p.message)).toEqual([]);
    expect(messages('Self.hp + Self.X', 'Player')).toEqual([]);
    expect(messages('Self.hp', 'Enemy')).toEqual(['"Enemy" has no expression, instance variable or behavior named "hp".']);
    expect(messages('thisAmount * 2')).toEqual([]);
  });

  it('leaves an object of a plugin without definitions alone', () => {
    const ctx = contextFromDeclarations(
      [{ name: 'Timer', pluginId: 'Some_ThirdParty', instanceVariables: [], behaviors: new Map(), members: [] }],
      [], new Map(), new Set(), { pluginOf: () => 'Some_ThirdParty', behaviorOf: () => undefined },
    );
    expect(checkExpression('Timer.Anything(1, 2)', ctx)).toEqual([]);
  });
});

describe('checkEventExpressions', () => {
  const events = [{
    eventType: 'block', sid: 1,
    conditions: [
      { id: 'compare-two-values', objectClass: 'System', sid: 2, parameters: { 'first-value': 'Player.hp', comparison: 0, 'second-value': 'Scor' } },
    ],
    actions: [
      { id: 'set-position', objectClass: 'Player', sid: 3, parameters: { x: 'Player.X + 1', y: 'Enemy.hp' } },
      { id: 'set-animation', objectClass: 'Player', sid: 4, parameters: { animation: '"Walk"', from: 'beginning' } },
      { id: 'go-to-layout', objectClass: 'System', sid: 5, parameters: { layout: 'Level 2' } },
      { callFunction: 'Total', sid: 6, parameters: ['Player.X', 'Nope'] },
      { customAction: 'Retreat', objectClass: 'Player', sid: 7, parameters: ['Self.hp'] },
      { id: 'no-such-action', objectClass: 'Player', sid: 8, parameters: { x: 'Nope' } },
    ],
  }];

  it('checks expression-typed parameters and call arguments, and skips choices, names and unknown ACEs', () => {
    const problems = checkEventExpressions(events, context(), ace);
    expect(problems.map(p => [p.sid, p.parameter, p.code])).toEqual([
      [2, 'second-value', 'expression-unknown-name'],
      [3, 'y', 'expression-unknown-member'],
      [6, '#1', 'expression-unknown-name'],
    ]);
    expect(describeEventExpressionProblem(problems[1])).toBe('Action "set-position" on "Player" (SID 3), parameter "y" = "Enemy.hp": "Enemy" has no expression, instance variable or behavior named "hp".');
    expect(EXPRESSION_PARAM_TYPES.has('layout')).toBe(false);
    expect(EXPRESSION_PARAM_TYPES.has('layer')).toBe(true);
  });

  it('limits itself to the given SIDs', () => {
    expect(checkEventExpressions(events, context(), ace, new Set([6])).map(p => p.sid)).toEqual([6]);
  });
});
