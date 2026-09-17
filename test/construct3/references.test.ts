/**
 * Unit tests for the shared reference scanner.
 *
 * The expression rewriter is the risky part of every rename: it edits free
 * text, so each rule it enforces (identifier boundaries, member names after a
 * dot, string literals) gets its own test.
 */

import { describe, it, expect } from 'vitest';
import type { EventSheet, Layout } from '../../src/construct3/types.js';
import {
  rewriteExpressionIdentifier,
  rewriteWholeStringLiteral,
  isExpressionIdentifier,
  collectObjectNameRefsInSheet,
  collectInstanceTypeRefsInLayout,
  collectFamilyMemberRefs,
  collectIncludeSheetRefs,
  collectLayoutParameterRefs,
  collectLayerRefsInSheet,
  collectVariableRefsInSheet,
  collectContainerMemberRefs,
  countUnrewrittenObjectMentions,
  renameTreeItem,
  countByKind,
  groupByFile,
} from '../../src/construct3/references.js';

describe('rewriteExpressionIdentifier', () => {
  it('rewrites a bare identifier and one followed by "." or "("', () => {
    expect(rewriteExpressionIdentifier('Player', 'Player', 'Hero')).toEqual({ text: 'Hero', count: 1 });
    expect(rewriteExpressionIdentifier('Player.X + 1', 'Player', 'Hero').text).toBe('Hero.X + 1');
    expect(rewriteExpressionIdentifier('Player(3)', 'Player', 'Hero').text).toBe('Hero(3)');
    expect(rewriteExpressionIdentifier('int(Player.X)', 'Player', 'Hero').text).toBe('int(Hero.X)');
  });

  it('only matches whole identifier runs', () => {
    expect(rewriteExpressionIdentifier('PlayerShip.X', 'Player', 'Hero')).toEqual({ text: 'PlayerShip.X', count: 0 });
    expect(rewriteExpressionIdentifier('MyPlayer + Player2', 'Player', 'Hero').count).toBe(0);
  });

  it('leaves a member name that follows a dot alone', () => {
    expect(rewriteExpressionIdentifier('Enemy.Player', 'Player', 'Hero')).toEqual({ text: 'Enemy.Player', count: 0 });
    expect(rewriteExpressionIdentifier('Player.Player', 'Player', 'Hero').text).toBe('Hero.Player');
  });

  /**
   * Revert check (d): making the rewriter textual instead of literal-aware
   * makes this fail — a string literal that merely contains the name as a
   * substring must survive untouched.
   */
  it('never rewrites inside a string literal, even an exact one', () => {
    const before = '"Player wins" & Player.AnimationName & " PlayerShip"';
    const after = rewriteExpressionIdentifier(before, 'Player', 'Hero');
    expect(after.text).toBe('"Player wins" & Hero.AnimationName & " PlayerShip"');
    expect(after.count).toBe(1);

    expect(rewriteExpressionIdentifier('"Player"', 'Player', 'Hero')).toEqual({ text: '"Player"', count: 0 });
    expect(rewriteExpressionIdentifier('"a Player b"', 'Player', 'Hero').count).toBe(0);
  });

  it('counts and rewrites every occurrence outside strings', () => {
    const result = rewriteExpressionIdentifier('Player.X + Player.Y + Player', 'Player', 'Hero');
    expect(result.count).toBe(3);
    expect(result.text).toBe('Hero.X + Hero.Y + Hero');
  });

  it('handles non-ASCII identifier characters', () => {
    const result = rewriteExpressionIdentifier('fTreeNodes\u{1F332}.UID', 'fTreeNodes\u{1F332}', 'fTreeNodes');
    expect(result).toEqual({ text: 'fTreeNodes.UID', count: 1 });
  });

  it('does nothing for a name that cannot be an identifier token', () => {
    expect(isExpressionIdentifier('My Sprite')).toBe(false);
    expect(isExpressionIdentifier('Player')).toBe(true);
    expect(rewriteExpressionIdentifier('My Sprite.X', 'My Sprite', 'Hero').count).toBe(0);
  });
});

describe('rewriteWholeStringLiteral', () => {
  it('rewrites a literal that is exactly the name', () => {
    expect(rewriteWholeStringLiteral('"UI"', 'UI', 'HUD')).toEqual({ text: '"HUD"', count: 1 });
    expect(rewriteWholeStringLiteral('LayerScale("UI") + 1', 'UI', 'HUD').text).toBe('LayerScale("HUD") + 1');
  });

  it('leaves a longer literal and a bare identifier alone', () => {
    expect(rewriteWholeStringLiteral('"UI layer"', 'UI', 'HUD').count).toBe(0);
    expect(rewriteWholeStringLiteral('UI.Something', 'UI', 'HUD').count).toBe(0);
  });

  it('rewrites every matching literal', () => {
    const result = rewriteWholeStringLiteral('ViewportLeft("UI") + ViewportTop("UI")', 'UI', 'HUD');
    expect(result.count).toBe(2);
    expect(result.text).toBe('ViewportLeft("HUD") + ViewportTop("HUD")');
  });
});

function sheetWith(events: unknown[]): EventSheet {
  return { name: 'S', events: events as EventSheet['events'], sid: 1 };
}

describe('collectObjectNameRefsInSheet', () => {
  const build = () => sheetWith([
    {
      eventType: 'block',
      conditions: [
        { id: 'c', objectClass: 'Player', sid: 1 },
        { id: 'pick', objectClass: 'System', sid: 2, parameters: { object: 'Player', expression: 'Player.X' } },
      ],
      actions: [
        { id: 'a', objectClass: 'Player', sid: 3, parameters: { text: '"Player" & Player.Name' } },
        { customAction: 'Do', objectClass: 'Player', sid: 4, parameters: ['Player.UID', '"Player"'] },
      ],
      sid: 5,
      children: [
        {
          eventType: 'custom-ace-block',
          aceType: 'action',
          objectClass: 'Player',
          conditions: [],
          actions: [],
          sid: 6,
        },
      ],
    },
  ]);

  it('reports every reference kind without mutating when apply is false', () => {
    const sheet = build();
    const sites = collectObjectNameRefsInSheet('eventSheets/S.json', sheet, 'Player', 'Hero', false);
    expect(countByKind(sites)).toEqual({
      objectClass: 3,
      customAceObjectClass: 1,
      parameterObjectName: 1,
      expression: 3,
    });
    expect(JSON.stringify(sheet)).toContain('"Player"');
    expect(JSON.stringify(sheet)).not.toContain('Hero');
  });

  it('rewrites exactly what it reported when apply is true', () => {
    const sheet = build();
    const before = collectObjectNameRefsInSheet('eventSheets/S.json', sheet, 'Player', 'Hero', false);
    const applied = collectObjectNameRefsInSheet('eventSheets/S.json', sheet, 'Player', 'Hero', true);
    expect(applied).toEqual(before);

    const block = sheet.events[0] as Record<string, any>;
    expect(block.conditions[0].objectClass).toBe('Hero');
    expect(block.conditions[1].parameters.object).toBe('Hero');
    expect(block.conditions[1].parameters.expression).toBe('Hero.X');
    expect(block.actions[0].parameters.text).toBe('"Player" & Hero.Name');
    expect(block.actions[1].parameters).toEqual(['Hero.UID', '"Player"']);
    expect(block.children[0].objectClass).toBe('Hero');

    // A second pass finds nothing: this is what makes a failed rename resumable.
    expect(collectObjectNameRefsInSheet('eventSheets/S.json', sheet, 'Player', 'Hero', false)).toHaveLength(0);
  });

  it('counts mentions in scripts, comments and initial values without rewriting them', () => {
    const sheet = sheetWith([
      { eventType: 'comment', text: 'Player setup' },
      { eventType: 'variable', name: 'v', type: 'string', initialValue: 'Player', sid: 1 },
      { eventType: 'script', language: 'javascript', script: ['// Player', 'noop();'] },
      {
        eventType: 'block',
        conditions: [],
        actions: [{ type: 'script', language: 'javascript', script: ['Player.x'] }],
        sid: 2,
      },
    ]);
    expect(countUnrewrittenObjectMentions(sheet, 'Player')).toBe(4);
    expect(collectObjectNameRefsInSheet('f', sheet, 'Player', 'Hero', true)).toHaveLength(0);
    expect(JSON.stringify(sheet)).not.toContain('Hero');
  });
});

describe('collectInstanceTypeRefsInLayout', () => {
  const build = (): Layout => ({
    name: 'L',
    sid: 1,
    layers: [
      {
        name: 'Game',
        sid: 2,
        instances: [{ type: 'Player', uid: 1, sid: 3, properties: {} }],
        subLayers: [
          { name: 'UI', sid: 4, instances: [{ type: 'Player', uid: 2, sid: 5, properties: {} }] },
        ],
      },
    ] as unknown as Layout['layers'],
    'nonworld-instances': [{ type: 'Player', uid: 3, sid: 6, properties: {} }],
  });

  it('finds instances in nested sub-layers and non-world instances', () => {
    const layout = build();
    const sites = collectInstanceTypeRefsInLayout('layouts/L.json', layout, 'Player', 'Hero', false);
    expect(sites).toHaveLength(3);
    expect(sites.every(site => site.kind === 'instanceType')).toBe(true);

    collectInstanceTypeRefsInLayout('layouts/L.json', layout, 'Player', 'Hero', true);
    expect(JSON.stringify(layout)).not.toContain('"Player"');
    expect(JSON.stringify(layout).match(/"Hero"/g)).toHaveLength(3);
  });
});

describe('collectFamilyMemberRefs / collectContainerMemberRefs / renameTreeItem', () => {
  it('rewrites a family member entry', () => {
    const family = { name: 'F', members: ['Enemy', 'Player'] };
    const sites = collectFamilyMemberRefs('families/F.json', family, 'Player', 'Hero', true);
    expect(sites).toEqual([{ file: 'families/F.json', path: 'members[1]', kind: 'familyMember' }]);
    expect(family.members).toEqual(['Enemy', 'Hero']);
  });

  it('rewrites containers[].members and tolerates a missing containers key', () => {
    const project = { containers: [{ members: ['Player', 'Enemy'] }] };
    expect(collectContainerMemberRefs(project, 'Player', 'Hero', true)).toHaveLength(1);
    expect(project.containers[0].members).toEqual(['Hero', 'Enemy']);
    expect(collectContainerMemberRefs({}, 'Player', 'Hero', true)).toHaveLength(0);
  });

  it('renames a tree item in place and reports its subfolder', () => {
    const container = {
      items: ['Tiles'],
      subfolders: [{ name: 'Actors', items: ['Other', 'Player'], subfolders: [] }],
    };
    expect(renameTreeItem(container, 'Player', 'Hero', true)).toBe('Actors');
    expect(container.subfolders[0].items).toEqual(['Other', 'Hero']);
    expect(renameTreeItem(container, 'Tiles', 'Ground', true)).toBe('');
    expect(container.items).toEqual(['Ground']);
    expect(renameTreeItem(container, 'Missing', 'X', true)).toBeNull();
  });
});

describe('collectIncludeSheetRefs / collectLayoutParameterRefs', () => {
  it('rewrites includeSheet', () => {
    const sheet = sheetWith([{ eventType: 'include', includeSheet: 'Main' }]);
    const sites = collectIncludeSheetRefs('eventSheets/S.json', sheet, 'Main', 'Core', true);
    expect(sites).toEqual([{ file: 'eventSheets/S.json', path: 'events[0].includeSheet', kind: 'includeSheet' }]);
    expect((sheet.events[0] as Record<string, unknown>).includeSheet).toBe('Core');
  });

  it('rewrites both the bare and quoted layout parameter forms and nothing else', () => {
    const sheet = sheetWith([
      {
        eventType: 'block',
        conditions: [],
        actions: [
          { id: 'go', objectClass: 'System', sid: 1, parameters: { layout: 'Level 2' } },
          { id: 'go-by-name', objectClass: 'System', sid: 2, parameters: { layout: '"Level 2"' } },
          { id: 'go-expr', objectClass: 'System', sid: 3, parameters: { layout: 'Self.NextLevel' } },
          { id: 'other', objectClass: 'System', sid: 4, parameters: { value: '"Level 2"' } },
        ],
        sid: 5,
      },
    ]);
    const sites = collectLayoutParameterRefs('eventSheets/S.json', sheet, 'Level 2', 'Stage 2', true);
    expect(sites).toHaveLength(2);
    const actions = (sheet.events[0] as Record<string, any>).actions;
    expect(actions[0].parameters.layout).toBe('Stage 2');
    expect(actions[1].parameters.layout).toBe('"Stage 2"');
    expect(actions[2].parameters.layout).toBe('Self.NextLevel');
    expect(actions[3].parameters.value).toBe('"Level 2"');
  });
});

describe('collectLayerRefsInSheet', () => {
  it('rewrites the bare layer parameter and whole literals, but not expressions', () => {
    const sheet = sheetWith([
      {
        eventType: 'block',
        conditions: [],
        actions: [
          { id: 'move', objectClass: 'S', sid: 1, parameters: { layer: 'UI' } },
          { id: 'create', objectClass: 'S', sid: 2, parameters: { layer: '"UI"' } },
          { id: 'scale', objectClass: 'S', sid: 3, parameters: { layer: '"UI"', scale: 'LayerScale("UI")+1' } },
          { id: 'expr', objectClass: 'S', sid: 4, parameters: { layer: 'Self.LayerName' } },
          { id: 'text', objectClass: 'S', sid: 5, parameters: { text: '"UI layer"' } },
        ],
        sid: 6,
      },
    ]);
    const sites = collectLayerRefsInSheet('eventSheets/S.json', sheet, 'UI', 'HUD', true);
    expect(countByKind(sites)).toEqual({ layerParameter: 3, layerLiteral: 1 });
    const actions = (sheet.events[0] as Record<string, any>).actions;
    expect(actions[0].parameters.layer).toBe('HUD');
    expect(actions[1].parameters.layer).toBe('"HUD"');
    expect(actions[2].parameters.scale).toBe('LayerScale("HUD")+1');
    expect(actions[3].parameters.layer).toBe('Self.LayerName');
    expect(actions[4].parameters.text).toBe('"UI layer"');
  });
});

describe('collectVariableRefsInSheet', () => {
  it('rewrites the variable parameter and expression uses, never instance-variable', () => {
    const sheet = sheetWith([
      {
        eventType: 'block',
        conditions: [],
        actions: [
          { id: 'set', objectClass: 'System', sid: 1, parameters: { variable: 'score', value: 'score + 1' } },
          { id: 'inst', objectClass: 'Player', sid: 2, parameters: { 'instance-variable': 'score', value: '1' } },
          { id: 'other', objectClass: 'System', sid: 3, parameters: { value: 'Player.score' } },
        ],
        sid: 4,
      },
    ]);
    const sites = collectVariableRefsInSheet('eventSheets/S.json', sheet, 'score', 'points', true);
    expect(countByKind(sites)).toEqual({ variableParameter: 1, expression: 1 });
    const actions = (sheet.events[0] as Record<string, any>).actions;
    expect(actions[0].parameters).toEqual({ variable: 'points', value: 'points + 1' });
    expect(actions[1].parameters['instance-variable']).toBe('score');
    expect(actions[2].parameters.value).toBe('Player.score');
  });
});

describe('groupByFile', () => {
  it('groups counts per file in discovery order', () => {
    const grouped = groupByFile([
      { file: 'b.json', path: 'p', kind: 'objectClass' },
      { file: 'a.json', path: 'p', kind: 'expression' },
      { file: 'b.json', path: 'q', kind: 'objectClass' },
    ]);
    expect(grouped).toEqual([
      { file: 'b.json', count: 2, kinds: { objectClass: 2 } },
      { file: 'a.json', count: 1, kinds: { expression: 1 } },
    ]);
  });
});
