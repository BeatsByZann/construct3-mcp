/** unregisteredNameMessage: a name is registered exactly as given, or the message names the registered spelling. */

import { describe, it, expect, vi } from 'vitest';
import { unregisteredNameMessage } from '../../src/tools/registered-names.js';

const registered = ['Layout 1', 'Menu'];

describe('unregisteredNameMessage', () => {
  it('gives undefined for a registered name', () => {
    const suggestions = vi.fn(() => []);
    expect(unregisteredNameMessage('Layout', 'Layout 1', registered, suggestions, 'list_layouts')).toBeUndefined();
    expect(suggestions).not.toHaveBeenCalled();
  });

  it('names the registered spelling of a name in another letter case, with no ending', () => {
    expect(unregisteredNameMessage('Layout', 'layout 1', registered, () => [], 'list_layouts'))
      .toBe('Layout "layout 1" not found: names are matched with their letter case. Did you mean "Layout 1"?');
  });

  it('gives the not-found text with the suggestions for an unknown name, calling suggestions once', () => {
    const suggestions = vi.fn(() => ['Layout 1']);
    expect(unregisteredNameMessage('Layout', 'Nope', registered, suggestions, 'list_layouts'))
      .toBe('Layout "Nope" not found.\nDid you mean: Layout 1?');
    expect(suggestions).toHaveBeenCalledTimes(1);
    expect(unregisteredNameMessage('Layout', 'Nope', registered, () => [], 'list_layouts'))
      .toBe('Layout "Nope" not found.\nUse list_layouts to see all available names.');
  });

  it('does not call suggestions for a case variant', () => {
    const suggestions = vi.fn(() => ['Layout 1']);
    unregisteredNameMessage('Layout', 'MENU', registered, suggestions, 'list_layouts');
    expect(suggestions).not.toHaveBeenCalled();
  });

  it('treats a name equal after Unicode normalisation as a case variant', () => {
    const suggestions = vi.fn(() => []);
    expect(unregisteredNameMessage('Layout', 'é', ['é'], suggestions, 'list_layouts'))
      .toBe('Layout "é" not found: names are matched with their letter case. Did you mean "é"?');
    expect(suggestions).not.toHaveBeenCalled();
  });
});
