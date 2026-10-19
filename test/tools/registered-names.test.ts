import { describe, it, expect, vi } from 'vitest';
import { unregisteredNameMessage } from '../../src/tools/registered-names.js';

const registered = ['Layout 1', 'Layout 2'];

describe('unregisteredNameMessage', () => {
  it('gives undefined for a registered name', () => {
    const suggestions = vi.fn(() => ['unused']);
    expect(unregisteredNameMessage('Layout', 'Layout 1', registered, suggestions, 'list_layouts')).toBeUndefined();
    expect(suggestions).not.toHaveBeenCalled();
  });

  it('names the registered spelling of a name in another letter case', () => {
    expect(unregisteredNameMessage('Layout', 'layout 1', registered, () => [], 'list_layouts')).toBe(
      'Layout "layout 1" not found: names are matched with their letter case. Did you mean "Layout 1"?',
    );
  });

  it('gives the not-found text with the suggestions for an unknown name, asking for them once', () => {
    const suggestions = vi.fn(() => ['Layout 1']);
    expect(unregisteredNameMessage('Layout', 'Nope', registered, suggestions, 'list_layouts')).toBe(
      'Layout "Nope" not found.\nDid you mean: Layout 1?',
    );
    expect(suggestions).toHaveBeenCalledTimes(1);
  });

  it('points at the list tool when there is no suggestion', () => {
    expect(unregisteredNameMessage('Layout', 'Nope', registered, () => [], 'list_layouts')).toBe(
      'Layout "Nope" not found.\nUse list_layouts to see all available names.',
    );
  });

  it('does not ask for suggestions for a case variant', () => {
    const suggestions = vi.fn(() => ['x']);
    unregisteredNameMessage('Layout', 'LAYOUT 2', registered, suggestions, 'list_layouts');
    expect(suggestions).not.toHaveBeenCalled();
  });

  it('treats a name equal after Unicode normalisation as a case variant', () => {
    const message = unregisteredNameMessage('Object type', 'é', ['é'], () => [], 'list_objects');
    expect(message).toBe('Object type "é" not found: names are matched with their letter case. Did you mean "é"?');
  });
});
