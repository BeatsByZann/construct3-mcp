import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_PATTERN,
  buildCatalog,
  catalogCounts,
  UNKNOWN_PARAM_TYPE,
  isAceCatalog,
  literalToJson,
  releaseFromSaved,
  releaseLabel,
  releaseNumber,
  type CatalogSources,
} from '../../src/construct3/ace-catalog-source.js';
import { SYSTEM_EXPRESSION_NAMES } from '../../src/construct3/event-variable-names.js';
import type { AceCatalog } from '../../src/construct3/ace-types.js';
import { TEST_CATALOG } from '../fixtures/ace-catalog.js';

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ace-source', 'r495-2');

async function loadSources(): Promise<CatalogSources> {
  const [plugins, behaviors, mainJs] = await Promise.all([
    readFile(join(sourceDir, 'plugins', 'allAces.json'), 'utf8').then(text => JSON.parse(text) as unknown),
    readFile(join(sourceDir, 'behaviors', 'allAces.json'), 'utf8').then(text => JSON.parse(text) as unknown),
    readFile(join(sourceDir, 'main.js'), 'utf8'),
  ]);
  return { release: 'r495-2', plugins, behaviors, mainJs };
}

const clone = (catalog: AceCatalog): AceCatalog => JSON.parse(JSON.stringify(catalog)) as AceCatalog;

describe('buildCatalog', () => {
  it('turns the hand-written source folder into TEST_CATALOG', async () => {
    expect(buildCatalog(await loadSources())).toEqual(TEST_CATALOG);
  });

  it('counts what the catalogue holds', () => {
    expect(catalogCounts(TEST_CATALOG)).toEqual({
      plugins: 3,
      behaviors: 1,
      aces: 7,
      expressions: 4,
      commonAces: 4,
      commonExpressions: 1,
    });
  });

  it('refuses sources it cannot read', async () => {
    const sources = await loadSources();
    expect(() => buildCatalog({ ...sources, mainJs: 'x({id:"set-x",scriptName:"SetX"});' }))
      .toThrow('Could not tell the condition, action and expression registrations apart');
    expect(() => buildCatalog({ ...sources, mainJs: sources.mainJs.replace('"SetX"', 'SetX') }))
      .toThrow('not a data literal');
    expect(() => buildCatalog({ ...sources, plugins: [] })).toThrow('plugins/allAces.json is not an object of addons');
    expect(() => buildCatalog({ ...sources, behaviors: null })).toThrow('behaviors/allAces.json is not an object of addons');
  });

  it('leaves no registration out, whatever the order of its keys', async () => {
    const sources = await loadSources();
    const catalog = buildCatalog(sources);
    // The fixture writes set-x with the id second.
    expect(sources.mainJs).toContain('{scriptName:"SetX",id:"set-x"');
    expect(catalog.common.actions['set-x']).toEqual([{ id: 'x', type: 'number' }]);
    // A literal the transform does not understand stops the build; it never returns a catalogue without the entry.
    const broken = sources.mainJs.replace('{scriptName:"SetX",id:"set-x"', '{scriptName:f(),id:"set-x"');
    expect(broken).not.toBe(sources.mainJs);
    expect(() => buildCatalog({ ...sources, mainJs: broken })).toThrow('Could not read a common ACE registration');
    // A call whose nested object alone holds the marker keys registers nothing.
    expect(JSON.stringify(catalog.common)).not.toContain('nested-only');
  });
});

describe('common ACE candidates', () => {
  it('reads a registration inside an enclosing call that is not itself a registration', async () => {
    const sources = await loadSources();
    const enclosing = 'x({run:function(){return a({id:"set-y",scriptName:"SetY",params:[]})},valid:"yes",extra:{scriptName:"N"}});\n';
    const catalog = buildCatalog({ ...sources, mainJs: sources.mainJs + enclosing });
    expect(catalog.common.actions['set-y']).toEqual([]);
    expect(Object.keys(catalog.common.actions)).toHaveLength(Object.keys(TEST_CATALOG.common.actions).length + 1);
  });

  it('still refuses an unreadable object whose own keys are a registration', async () => {
    const sources = await loadSources();
    const text = sources.mainJs + 'a({id:"set-z",scriptName:g(),valid:1});\n';
    expect(() => buildCatalog({ ...sources, mainJs: text })).toThrow('Could not read a common ACE registration');
  });

  it('refuses a template string and names the reader error', async () => {
    const sources = await loadSources();
    const text = sources.mainJs + 'a({id:"set-z",scriptName:`SetZ`});\n';
    expect(() => buildCatalog({ ...sources, mainJs: text })).toThrow(/Could not read a common ACE registration near "\{id:"set-z",scriptName:`SetZ`\}": unexpected "`"/);
  });

  it('skips a call whose registering function is named like an Object.prototype member', async () => {
    const sources = await loadSources();
    const catalog = buildCatalog({ ...sources, mainJs: sources.mainJs + 'constructor({id:"ctor-one",scriptName:"Ctor"});\n' });
    expect(catalog).toEqual(TEST_CATALOG);
  });

  it('keeps an id such as __proto__ as an entry of its own', async () => {
    const sources = await loadSources();
    const plugins = JSON.parse('{"Odd":{"c":{"actions":[{"id":"__proto__","params":[]}]}}}') as unknown;
    const catalog = buildCatalog({ ...sources, plugins });
    expect(Object.keys(catalog.plugins.Odd.actions)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(catalog.plugins.Odd.actions)).toBe(Object.prototype);
  });
});

describe('literalToJson', () => {
  it('refuses a string that never ends', () => {
    expect(() => literalToJson('{a:"x')).toThrow('unterminated string');
  });

  it('refuses a character and a number it cannot read', () => {
    expect(() => literalToJson('{a:#}')).toThrow('unexpected "#"');
    expect(() => literalToJson('{a:-}')).toThrow('unexpected "-"');
  });

  it('refuses a name that is not a data literal', () => {
    expect(() => literalToJson('{a:f()}')).toThrow('not a data literal');
  });
});

describe('parameters that cannot be read', () => {
  const withParams = (list: unknown[]): unknown => ({
    X: { c: { actions: [{ id: 'act', params: list }], expressions: [{ id: 'ex', params: list }] } },
  });

  it('keep their position as an entry of unknown type', async () => {
    const sources = await loadSources();
    const list = [
      { id: 'a', type: 'number' },
      5,
      { id: 'b' },
      { type: 'string' },
      { id: 'c', type: 'combo', items: [1] },
      { id: 'd', type: 'string' },
    ];
    const catalog = buildCatalog({ ...sources, plugins: withParams(list) });
    expect(UNKNOWN_PARAM_TYPE).toBe('unknown');
    expect(catalog.plugins.X.actions.act).toEqual([
      { id: 'a', type: 'number' },
      { id: '', type: 'unknown' },
      { id: 'b', type: 'unknown' },
      { id: '', type: 'unknown' },
      { id: 'c', type: 'unknown' },
      { id: 'd', type: 'string' },
    ]);
    expect(catalog.plugins.X.expressions.ex.params).toEqual(['number', 'unknown', 'unknown', 'unknown', 'unknown', 'string']);
  });
});

describe('release names', () => {
  it('names the release a project was saved with', () => {
    expect(releaseFromSaved(49502)).toBe('r495-2');
    expect(releaseFromSaved(44000)).toBe('r440');
    expect(releaseFromSaved(44903)).toBe('r449-3');
    expect(releaseFromSaved(50602)).toBe('r506-2');
    for (const bad of [undefined, '49502', 49502.5, -1, 99, 1000000, NaN]) expect(releaseFromSaved(bad)).toBeUndefined();
  });

  it('orders and labels releases', () => {
    expect(releaseNumber('r495-2')).toBe(49502);
    expect(releaseNumber('r495.2')).toBe(49502);
    expect(releaseNumber('r440')).toBe(44000);
    expect(releaseNumber('bad')).toBeNaN();
    expect(releaseLabel('r495-2')).toBe('r495.2');
    expect(releaseLabel('r495.2')).toBe('r495.2');
    expect(releaseLabel('r440')).toBe('r440');
    expect(releaseLabel('bad')).toBe('bad');
  });

  it('accepts only names that cannot reach a URL or a path as anything else', () => {
    expect(RELEASE_PATTERN.test('r495')).toBe(true);
    expect(RELEASE_PATTERN.test('r495-2')).toBe(true);
    for (const bad of ['r495-2/../x', 'r495-2?x', 'r495-2#x', 'r495-2%2F', 'R495', 'r0495', 'r495-', 'r495-2 ', 'https://x', '']) {
      expect(RELEASE_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe('isAceCatalog', () => {
  it('accepts a whole catalogue', () => {
    expect(isAceCatalog(TEST_CATALOG)).toBe(true);
  });

  it('refuses a partial or malformed one', () => {
    expect(isAceCatalog(null)).toBe(false);

    const noSystem = clone(TEST_CATALOG);
    delete noSystem.plugins.system;
    expect(isAceCatalog(noSystem)).toBe(false);

    const noConditions = clone(TEST_CATALOG);
    noConditions.plugins.system.conditions = {};
    expect(isAceCatalog(noConditions)).toBe(false);

    const numericType = clone(TEST_CATALOG) as unknown as { common: { actions: Record<string, Array<{ type: unknown }>> } };
    numericType.common.actions['set-x'][0].type = 5;
    expect(isAceCatalog(numericType)).toBe(false);

    const numericItems = clone(TEST_CATALOG) as unknown as { plugins: { Sprite: { actions: Record<string, Array<{ items?: unknown }>> } } };
    numericItems.plugins.Sprite.actions['set-animation'][1].items = [1];
    expect(isAceCatalog(numericItems)).toBe(false);

    const noName = clone(TEST_CATALOG) as unknown as { plugins: { system: { expressions: Record<string, { name?: string }> } } };
    delete noName.plugins.system.expressions.int.name;
    expect(isAceCatalog(noName)).toBe(false);

    expect(isAceCatalog({ ...clone(TEST_CATALOG), release: '../x' })).toBe(false);
  });
});

describe('the hand-written catalogue', () => {
  it('uses real System expression names', () => {
    for (const expression of Object.values(TEST_CATALOG.plugins.system.expressions)) {
      expect(SYSTEM_EXPRESSION_NAMES, expression.name).toContain(expression.name);
    }
  });
});
