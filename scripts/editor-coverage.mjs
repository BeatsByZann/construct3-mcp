#!/usr/bin/env node
/**
 * Editor checklist coverage: which of the Construct editor's capabilities the
 * tools reproduce in project files.
 *
 * `scripts/editor-coverage.json` maps every item of the 425-item editor
 * acceptance checklist (the capabilities the Construct 3 editor offers,
 * surface by surface, keyed like `EVC-01`) to a status and the tools that
 * produce the same end state:
 *
 *   covered      a tool writes or reads the same end state in the project files
 *   partial      part of it; the note says which part is the caller's
 *   open         the end state lives in project files but no tool writes it
 *   editor-only  no file representation: a menu, dialog, gesture, view,
 *                preview, debugger, export or drawing operation
 *
 * Usage:
 *   node scripts/editor-coverage.mjs            print the table
 *   node scripts/editor-coverage.mjs --write    rewrite the block in FORK.md
 *   node scripts/editor-coverage.mjs --check    exit 1 when FORK.md is stale
 *   node scripts/editor-coverage.mjs --list open    list items of one status
 *
 * Tool names are checked against the registrations in src/tools, so a
 * renamed or removed tool fails this script and the test that runs it.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUSES = ['covered', 'partial', 'open', 'editor-only'];
const START = '<!-- editor-coverage:start -->';
const END = '<!-- editor-coverage:end -->';

export function loadCoverage() {
  return JSON.parse(readFileSync(join(root, 'scripts', 'editor-coverage.json'), 'utf8'));
}

/** Tool names registered in src/tools/*.ts, read the way test/docs/tool-docs.test.ts reads them. */
export function registeredTools() {
  const names = new Set();
  const dir = join(root, 'src', 'tools');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(/^\s+'([a-z0-9_]+)',\r?$/gm)) names.add(match[1]);
  }
  return names;
}

/** Problems in the mapping: unknown statuses, tools that do not exist, duplicate ids. */
export function validate(coverage, tools = registeredTools()) {
  const problems = [];
  const seen = new Set();
  for (const item of coverage.items) {
    if (seen.has(item.id)) problems.push(`${item.id}: listed twice`);
    seen.add(item.id);
    if (!STATUSES.includes(item.status)) problems.push(`${item.id}: unknown status "${item.status}"`);
    if ((item.status === 'covered' || item.status === 'partial') && item.tools.length === 0) problems.push(`${item.id}: ${item.status} but names no tool`);
    if ((item.status === 'open' || item.status === 'editor-only') && item.tools.length > 0) problems.push(`${item.id}: ${item.status} but names tools`);
    for (const tool of item.tools) if (!tools.has(tool)) problems.push(`${item.id}: tool "${tool}" is not registered`);
  }
  return problems;
}

export function summarize(coverage) {
  const perSurface = new Map();
  for (const item of coverage.items) {
    if (!perSurface.has(item.surface)) perSurface.set(item.surface, { covered: 0, partial: 0, open: 0, 'editor-only': 0, total: 0 });
    const row = perSurface.get(item.surface);
    row[item.status]++;
    row.total++;
  }
  const totals = { covered: 0, partial: 0, open: 0, 'editor-only': 0, total: 0 };
  for (const row of perSurface.values()) for (const key of Object.keys(totals)) totals[key] += row[key];
  return { perSurface, totals };
}

/** The Markdown block FORK.md carries, generated so it cannot drift from the mapping. */
export function renderBlock(coverage) {
  const { perSurface, totals } = summarize(coverage);
  const lines = [START];
  lines.push(`Measured against the ${totals.total}-item editor acceptance checklist (${coverage.suite} version ${coverage.suiteVersion}, Construct ${coverage.construct}) by \`node scripts/editor-coverage.mjs\`.`);
  lines.push('');
  lines.push('| Surface | Items | Covered | Partial | Open | Editor-only |');
  lines.push('|---|---|---|---|---|---|');
  for (const [surface, row] of perSurface) {
    lines.push(`| ${surface} ${coverage.surfaces[surface]} | ${row.total} | ${row.covered} | ${row.partial} | ${row.open} | ${row['editor-only']} |`);
  }
  lines.push(`| **All** | **${totals.total}** | **${totals.covered}** | **${totals.partial}** | **${totals.open}** | **${totals['editor-only']}** |`);
  const fileBacked = totals.total - totals['editor-only'];
  lines.push('');
  lines.push(`Of the ${fileBacked} items that have a file representation, ${totals.covered} are covered by a tool, ${totals.partial} partly, and ${totals.open} not at all. The ${totals['editor-only']} editor-only items are menus, dialogs, selection gestures, views, preview, debugging, export and drawing, which no project-file edit can reproduce.`);
  const open = coverage.items.filter(item => item.status === 'open');
  lines.push('');
  lines.push('Open items: ' + open.map(item => `${item.id} (${item.note})`).join('; ') + '.');
  lines.push(END);
  return lines.join('\n');
}

export function forkMarkdown() {
  return readFileSync(join(root, 'FORK.md'), 'utf8');
}

/** Replace the block, keeping the file's own line endings. */
export function replaceBlock(markdown, block) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error(`FORK.md has no ${START} ... ${END} block`);
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  return markdown.slice(0, start) + block.replace(/\n/g, eol) + markdown.slice(end + END.length);
}

/** The block as the file holds it, with line endings normalized for comparison. */
export function currentBlock(markdown) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return markdown.slice(start, end + END.length).replace(/\r\n/g, '\n');
}

function main(args) {
  const coverage = loadCoverage();
  const problems = validate(coverage);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 2;
  }
  const listIndex = args.indexOf('--list');
  if (listIndex !== -1) {
    const status = args[listIndex + 1];
    for (const item of coverage.items.filter(i => i.status === status)) {
      console.log(`${item.id}  ${item.capability}${item.tools.length ? '  [' + item.tools.join(', ') + ']' : ''}${item.note ? '  ' + item.note : ''}`);
    }
    return 0;
  }
  const block = renderBlock(coverage);
  if (args.includes('--write')) {
    const markdown = forkMarkdown();
    const next = replaceBlock(markdown, block);
    if (next !== markdown) writeFileSync(join(root, 'FORK.md'), next);
    console.log(next === markdown ? 'FORK.md already current' : 'FORK.md updated');
    return 0;
  }
  if (args.includes('--check')) {
    if (currentBlock(forkMarkdown()) !== block) {
      console.error('FORK.md coverage block is stale; run node scripts/editor-coverage.mjs --write');
      return 1;
    }
    console.log('FORK.md coverage block is current');
    return 0;
  }
  console.log(block);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
