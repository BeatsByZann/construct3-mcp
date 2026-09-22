/**
 * The README and docs/API.md describe the tool surface, and they drifted: on
 * 2026-09-20 the server registered 169 tools while the README's tables listed
 * 78 and API.md documented 136. These tests hold the docs to the registered
 * list, so a tool added, removed or renamed without its documentation fails
 * here rather than on GitHub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerQueryTools } from '../../src/tools/query.js';
import { registerAnalysisTools } from '../../src/tools/analysis.js';
import { registerUsageTools } from '../../src/tools/usage-tools.js';
import { registerMutationTools } from '../../src/tools/mutations.js';
import { registerRuntimeTools } from '../../src/tools/runtime-tools.js';
import { registerSessionTools } from '../../src/tools/session-tools.js';
import { ProjectSession } from '../../src/construct3/project-session.js';
import { MockServer } from '../mocks/mock-server.js';

const ROOT = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf-8').replace(/\r\n/g, '\n');
const TOOL_NAME = /`([a-z][a-z0-9_]*)`/g;

/** Names in the first cell of every table whose header's first cell is "Tool". */
function toolTableNames(markdown: string): Set<string> {
  const names = new Set<string>();
  let inToolTable = false;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      inToolTable = false;
      continue;
    }
    const first = line.split('|')[1]?.trim() ?? '';
    if (/^Tool$/.test(first)) {
      inToolTable = true;
      continue;
    }
    if (!inToolTable || /^-+$/.test(first)) continue;
    for (const m of first.matchAll(TOOL_NAME)) names.add(m[1]);
  }
  return names;
}

/**
 * Names in headings made only of backticked names, such as "### `list_eases`" or
 * "### `add_timeline_folder`, `rename_timeline_folder`". A concept heading that
 * quotes a field ("Keyframe values: `value`") is not a tool heading. The scan
 * stops at the Prompts chapter, whose headings name prompts.
 */
function headingNames(markdown: string): Set<string> {
  const names = new Set<string>();
  const body = markdown.split('\n## Prompts\n')[0];
  for (const line of body.split('\n')) {
    if (!/^#{2,4} `[a-z0-9_]+`((, |, and | and )`[a-z0-9_]+`)*$/.test(line)) continue;
    for (const m of line.matchAll(TOOL_NAME)) names.add(m[1]);
  }
  return names;
}

const sorted = (set: Iterable<string>) => [...set].sort();

describe('tool documentation matches the registered tools', () => {
  let registered: string[];
  let runtime: { close: () => Promise<void> };

  beforeAll(async () => {
    const reader = new Construct3ProjectReader(join(ROOT, 'test', 'fixtures', 'minimal-project', 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    const server = new MockServer();
    registerQueryTools(server as any, reader);
    registerAnalysisTools(server as any, reader);
    registerUsageTools(server as any, reader);
    registerMutationTools(server as any, reader, writer, idGen);
    runtime = registerRuntimeTools({ server: server as any, reader, writer });
    registerSessionTools(server as any, await ProjectSession.start(reader.getProjectPath()), idGen);
    registered = sorted(server.getToolNames());
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it('registers each tool once, the same set index.ts wires up', () => {
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered).size).toBe(registered.length);
    const index = read('src/index.ts');
    for (const fn of ['registerQueryTools', 'registerAnalysisTools', 'registerUsageTools', 'registerMutationTools', 'registerRuntimeTools', 'registerSessionTools']) {
      expect(index, `index.ts no longer calls ${fn}; update this test's registration list`).toContain(`${fn}(`);
    }
  });

  it("README's tool tables list every registered tool and nothing else", () => {
    const listed = toolTableNames(read('README.md'));
    expect(sorted(registered.filter((n) => !listed.has(n))), 'registered but missing from the README tables').toEqual([]);
    expect(sorted([...listed].filter((n) => !registered.includes(n))), 'in the README tables but not registered').toEqual([]);
  });

  it("README's stated tool count is the registered count", () => {
    const readme = read('README.md');
    expect(readme).toContain(`**${registered.length} MCP tools instead of upstream's`);
    expect(readme).toContain(`All ${registered.length} tools.`);
  });

  it('docs/API.md documents every registered tool, and names no tool that does not exist', () => {
    const api = read('docs/API.md');
    const documented = new Set([...headingNames(api), ...toolTableNames(api)]);
    expect(sorted(registered.filter((n) => !documented.has(n))), 'registered but not documented in docs/API.md').toEqual([]);
    expect(sorted([...documented].filter((n) => !registered.includes(n))), 'docs/API.md names something that is not a registered tool').toEqual([]);
  });

  it("README's source tree gives each tool file its registered count", () => {
    const readme = read('README.md');
    const dir = join(ROOT, 'src', 'tools');
    const stated = new Map<string, number>();
    for (const m of readme.matchAll(/[├└]── ([a-z-]+\.ts)\s+# (\d+) /g)) stated.set(m[1], Number(m[2]));
    let total = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const count = (readFileSync(join(dir, file), 'utf-8').match(/server\.tool\(/g) ?? []).length;
      total += count;
      if (count === 0) continue;
      expect(stated.get(file), `README's tree gives ${file} no count, or the wrong one`).toBe(count);
    }
    expect(total, 'a tool is registered some other way than server.tool(, so the per-file counts no longer add up').toBe(registered.length);
  });
});
