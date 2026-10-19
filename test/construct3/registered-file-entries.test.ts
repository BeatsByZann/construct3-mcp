import { describe, it, expect } from 'vitest';
import { listRegisteredFileEntries } from '../../src/construct3/registered-file-entries.js';
import type { Construct3Project, FileItem } from '../../src/construct3/types.js';

const SOUND: FileItem = { name: 'Blip.webm', type: 'audio/webm', sid: 1 };
const OTHER: FileItem = { name: 'Chime.webm', type: 'audio/webm', sid: 2 };
const DEEP: FileItem = { name: 'Rumble.webm', type: 'audio/webm', sid: 3 };

/** A project holding only the given `rootFileFolders`; the function reads nothing else. */
function projectWith(rootFileFolders: unknown): Construct3Project {
  return { rootFileFolders } as unknown as Construct3Project;
}

describe('listRegisteredFileEntries', () => {
  it('gives root entries no subfolder and entries in subfolders their slash-separated path', () => {
    const project = projectWith({
      sound: {
        items: [SOUND],
        subfolders: [{ name: 'A', items: [OTHER], subfolders: [{ name: 'B', items: [DEEP], subfolders: [] }] }],
      },
    });
    expect(listRegisteredFileEntries(project, 'sound')).toEqual([
      { entry: SOUND, subfolder: undefined },
      { entry: OTHER, subfolder: 'A' },
      { entry: DEEP, subfolder: 'A/B' },
    ]);
  });

  it('gives [] for a project without rootFileFolders and for an absent family', () => {
    expect(listRegisteredFileEntries({} as unknown as Construct3Project, 'sound')).toEqual([]);
    expect(listRegisteredFileEntries(projectWith({ music: { items: [SOUND], subfolders: [] } }), 'sound')).toEqual([]);
  });

  it('reads a family folder that has no items array', () => {
    const project = projectWith({ sound: { subfolders: [{ name: 'A', items: [SOUND], subfolders: [] }] } });
    expect(listRegisteredFileEntries(project, 'sound')).toEqual([{ entry: SOUND, subfolder: 'A' }]);
  });

  it('reads a subfolder that has no subfolders array', () => {
    const project = projectWith({ sound: { items: [], subfolders: [{ name: 'B', items: [SOUND] }] } });
    expect(listRegisteredFileEntries(project, 'sound')).toEqual([{ entry: SOUND, subfolder: 'B' }]);
  });
});
