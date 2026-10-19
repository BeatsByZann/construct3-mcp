/**
 * unregisteredNameMessage: a name the caller gives is matched with its letter
 * case, as it is registered in project.c3proj.
 */

import { describe, it, expect, vi } from 'vitest';
import { unregisteredNameMessage } from '../../src/tools/registered-names.js';

describe('unregisteredNameMessage', () => {
  it('gives undefined for a registered name', () => {
    const suggestions = vi.fn(() => []);
    expect(unregisteredNameMessage('Layout', 'Layout 1', ['Layout 1', 'Layout 2'], suggestions, 'list_layouts')).toBeUndefined();
    expect(suggestions).not.toHaveBeenCalled();
  });

  it('names the registered spelling of a name that differs only in letter case', () => {
    expect(unregisteredNameMessage('Layout', 'layout 1', ['Layout 1'], () => [], 'list_layouts')).toBe(
      'Layout "layout 1" not found: names are matched with their letter case. Did you mean "Layout 1"?',
    );
  });

  it('gives the not-found text with suggestions for an unknown name, asking for the suggestions once', () => {
    const suggestions = vi.fn(() => ['Layout 1']);
    expect(unregisteredNameMessage('Layout', 'Nope', ['Layout 1'], suggestions, 'list_layouts')).toBe(
      'Layout "Nope" not found.\nDid you mean: Layout 1?',
    );
    expect(suggestions).toHaveBeenCalledTimes(1);
  });

  it('does not ask for suggestions for a case variant', () => {
    const suggestions = vi.fn(() => ['x']);
    unregisteredNameMessage('Layout', 'LAYOUT 1', ['Layout 1'], suggestions, 'list_layouts');
    expect(suggestions).not.toHaveBeenCalled();
  });

  it('treats a name equal after Unicode normalisation as a case variant', () => {
    const message = unregisteredNameMessage('Layout', 'é', ['é'], () => [], 'list_layouts');
    expect(message).toBe('Layout "é" not found: names are matched with their letter case. Did you mean "é"?');
  });
});
