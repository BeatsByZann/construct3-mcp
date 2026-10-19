/** renameContainerMember on synthetic parsed project.c3proj objects. */

import { describe, it, expect } from 'vitest';
import { renameContainerMember } from '../../src/construct3/containers.js';

describe('renameContainerMember', () => {
  it('renames the member in every container that lists it, ignoring case, and keeps everything else in place', () => {
    // null: an entry whose members cannot even be looked up (the record check is what keeps it from throwing)
    const project = { containers: [{ members: ['Alpha', 'Beta'] }, { members: ['Txt', 'alpha', 5], extra: true }, { members: ['Beta', 'Txt'] }, 'odd', null, { other: 1 }] };
    const changed = renameContainerMember(project, 'Alpha', 'Gamma');
    expect(changed).toEqual([{ index: 0, members: ['Gamma', 'Beta'] }, { index: 1, members: ['Txt', 'Gamma'] }]);
    expect(project.containers).toEqual([{ members: ['Gamma', 'Beta'] }, { members: ['Txt', 'Gamma', 5], extra: true }, { members: ['Beta', 'Txt'] }, 'odd', null, { other: 1 }]);
  });

  it('changes nothing when no container lists it or there are no containers', () => {
    const project = { containers: [{ members: ['Beta', 'Txt'] }] };
    expect(renameContainerMember(project, 'Alpha', 'Gamma')).toEqual([]);
    expect(project.containers).toEqual([{ members: ['Beta', 'Txt'] }]);
    expect(renameContainerMember({}, 'Alpha', 'Gamma')).toEqual([]);
  });
});
