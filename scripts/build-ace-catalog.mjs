// Build src/construct3/ace-catalog-data.ts from the ACE definitions a Construct
// release serves to its own editor.
//
// Usage: node scripts/build-ace-catalog.mjs [release]     (default r495-2)
//
// Sources, all public files of the editor at https://editor.construct.net/<release>/:
//   plugins/allAces.json    every built-in plugin's own conditions and actions
//   behaviors/allAces.json  every built-in behavior's conditions and actions
//   main.js                 the common ACEs the editor adds to plugins by
//                           capability (instance variables, position, size,
//                           angle, appearance, Z order, hierarchy, effects,
//                           picking, destroy), which allAces.json leaves out
//
// Only what validation needs is kept: each condition and action ID with its
// parameter IDs, types and combo items. Expressions are left out, because
// they are written inside parameter strings, not as their own entries.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const release = process.argv[2] ?? 'r495-2';
const base = `https://editor.construct.net/${release}/`;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'construct3', 'ace-catalog-data.ts');

async function get(path, kind) {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${base + path}: HTTP ${res.status}`);
  return kind === 'json' ? res.json() : res.text();
}

/** One ACE reduced to its parameter list. */
function params(ace) {
  return (ace.params ?? []).map(p => {
    const param = { id: p.id, type: p.type };
    if (Array.isArray(p.items)) param.items = p.items;
    return param;
  });
}

/** An addon's categories flattened to { conditions: {id: params}, actions: {id: params} }. */
function flatten(addon) {
  const result = { conditions: {}, actions: {} };
  for (const category of Object.values(addon)) {
    for (const kind of ['conditions', 'actions']) {
      for (const ace of category[kind] ?? []) result[kind][ace.id] = params(ace);
    }
  }
  return result;
}

/** End index of the bracket or brace that opens at `start`, skipping string literals. */
function matchBracket(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Rewrite a minified JavaScript object literal made only of data (strings in
 * either quote style, numbers such as .5, !0 and !1, bare keys, arrays and
 * objects) as JSON. Anything else, such as a call or a variable, throws.
 */
function literalToJson(src) {
  let out = '';
  let i = 0;
  const expectKey = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (src[j] !== c) {
        if (j >= src.length) throw new Error('unterminated string');
        if (src[j] === '\\') {
          const e = src[j + 1];
          value += { n: '\n', t: '\t', r: '\r' }[e] ?? e;
          j += 2;
        } else value += src[j++];
      }
      out += JSON.stringify(value);
      i = j + 1;
    } else if ('{['.includes(c)) {
      expectKey.push(c === '{');
      out += c;
      i++;
    } else if ('}]'.includes(c)) {
      expectKey.pop();
      out += c;
      i++;
    } else if (c === ',' || c === ':') {
      out += c;
      i++;
    } else if (c === '!' && (src[i + 1] === '0' || src[i + 1] === '1')) {
      out += src[i + 1] === '0' ? 'true' : 'false';
      i += 2;
    } else if (/[-\d.]/.test(c)) {
      const num = /^-?\d*\.?\d+(?:e[-+]?\d+)?/i.exec(src.slice(i))[0];
      out += String(Number(num));
      i += num.length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))[0];
      const inObject = expectKey[expectKey.length - 1];
      if (inObject && src[i + word.length] === ':') out += JSON.stringify(word);
      else if (word === 'true' || word === 'false' || word === 'null') out += word;
      else throw new Error(`not a data literal at "${src.slice(i, i + 30)}"`);
      i += word.length;
    } else {
      throw new Error(`unexpected "${c}" at "${src.slice(i, i + 30)}"`);
    }
  }
  return out;
}

/**
 * The common ACEs: object literals of the form fn({id:"...",...}) in main.js.
 * The registering function's minified name tells condition from action; it is
 * identified from IDs whose kind is certain rather than hard-coded, because it
 * changes between releases.
 */
function commonAces(mainJs) {
  const found = [];
  const re = /([A-Za-z_$][\w$]*)\(\{id:"([a-z0-9-]+)",(?:c2id|scriptName):/g;
  let m;
  while ((m = re.exec(mainJs))) {
    const start = m.index + m[1].length + 1;
    const end = matchBracket(mainJs, start);
    if (end < 0) continue;
    let ace;
    try {
      ace = JSON.parse(literalToJson(mainJs.slice(start, end + 1)));
    } catch (error) {
      throw new Error(`Could not read the common ACE "${m[2]}": ${error.message}`);
    }
    found.push({ fn: m[1], ace });
  }
  const kindOf = { 'compare-instance-variable': 'conditions', 'set-instvar-value': 'actions' };
  const fnKind = {};
  for (const { fn, ace } of found) if (kindOf[ace.id]) fnKind[fn] = kindOf[ace.id];
  if (Object.values(fnKind).sort().join() !== 'actions,conditions') {
    throw new Error(`Could not tell the condition and action registrations apart: ${JSON.stringify(fnKind)}`);
  }
  const result = { conditions: {}, actions: {} };
  for (const { fn, ace } of found) {
    const kind = fnKind[fn];
    if (kind) result[kind][ace.id] = params(ace);
  }
  return result;
}

const [plugins, behaviors, mainJs] = await Promise.all([
  get('plugins/allAces.json', 'json'),
  get('behaviors/allAces.json', 'json'),
  get('main.js', 'text'),
]);

const catalog = {
  release,
  plugins: Object.fromEntries(Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)).map(([id, addon]) => [id, flatten(addon)])),
  behaviors: Object.fromEntries(Object.entries(behaviors).sort(([a], [b]) => a.localeCompare(b)).map(([id, addon]) => [id, flatten(addon)])),
  common: commonAces(mainJs),
};

const count = group => Object.values(group).reduce((n, a) => n + Object.keys(a.conditions).length + Object.keys(a.actions).length, 0);
const header = `// Generated by scripts/build-ace-catalog.mjs from Construct ${release}. Do not edit by hand.
// ${Object.keys(catalog.plugins).length} plugins and ${Object.keys(catalog.behaviors).length} behaviors with ${count(catalog.plugins) + count(catalog.behaviors)} conditions and actions,
// plus ${Object.keys(catalog.common.conditions).length + Object.keys(catalog.common.actions).length} common ACEs.

import type { AceCatalog } from './ace-catalog.js';

export const ACE_CATALOG: AceCatalog = `;
writeFileSync(out, header + JSON.stringify(catalog, null, 1) + ';\n');
console.log(`Wrote ${out}`);
console.log(header.split('\n').slice(1, 3).join('\n'));
