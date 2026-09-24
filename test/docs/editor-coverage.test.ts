/**
 * The editor checklist coverage table in FORK.md is generated from
 * scripts/editor-coverage.json by scripts/editor-coverage.mjs. These tests
 * keep the mapping honest (every tool it names is registered, every item has
 * one of the four statuses) and the published table current.
 */
import { describe, it, expect } from 'vitest';
import {
  currentBlock,
  forkMarkdown,
  loadCoverage,
  registeredTools,
  renderBlock,
  summarize,
  validate,
} from '../../scripts/editor-coverage.mjs';

describe('editor checklist coverage', () => {
  const coverage = loadCoverage();

  it('names only registered tools and valid statuses', () => {
    expect(validate(coverage)).toEqual([]);
    expect(registeredTools().size).toBeGreaterThan(150);
  });

  it('covers every item of the checklist exactly once', () => {
    const ids = coverage.items.map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(425);
    const { totals } = summarize(coverage);
    expect(totals.covered + totals.partial + totals.open + totals['editor-only']).toBe(425);
  });

  it("FORK.md carries the current table (run node scripts/editor-coverage.mjs --write)", () => {
    expect(currentBlock(forkMarkdown())).toBe(renderBlock(coverage));
  });

  it('reports a tool that no longer exists', () => {
    const broken = { ...coverage, items: [{ ...coverage.items[0], tools: ['no_such_tool'] }] };
    expect(validate(broken)).toEqual([`${coverage.items[0].id}: tool "no_such_tool" is not registered`]);
  });
});
