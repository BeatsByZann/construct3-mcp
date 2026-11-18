/**
 * planFrameImageReorder (#ISSUE): the image file renames that keep a Sprite
 * animation's frames and their images together when the frames are put in
 * a new order. Synthetic file listings; nothing is written.
 */

import { describe, it, expect } from 'vitest';
import { planFrameImageReorder, simulateImageRenames } from '../../src/construct3/animation-rename.js';

const png = { fileType: 'image/png' };
const jpeg = { fileType: 'image/jpeg' };
const gif = { fileType: 'image/gif' };
const name = (index: number, extension = 'png') => `hero-walk-00${index}.${extension}`;

describe('planFrameImageReorder', () => {
  it('swaps two frames\' images through a temporary name', () => {
    const plan = planFrameImageReorder([name(0), name(1)], 'Hero', 'Walk', [png, png], [1, 0]);
    expect(plan.moved).toEqual([{ from: name(1), to: name(0) }, { from: name(0), to: name(1) }]);
    expect(plan.renames).toEqual([
      { from: name(1), to: `${name(1)}.reorder` },
      { from: name(0), to: name(1) },
      { from: `${name(1)}.reorder`, to: name(0) },
    ]);
    expect(plan).toMatchObject({ backedUp: [], missing: [], clashes: [] });
  });

  it('rotates three frames with one temporary name, and the reverse of the renames undoes them', () => {
    const files = [name(0), name(1), name(2)];
    const plan = planFrameImageReorder(files, 'Hero', 'Walk', [png, png, png], [1, 2, 0]);
    expect(plan.renames).toEqual([
      { from: name(1), to: `${name(1)}.reorder` },
      { from: name(2), to: name(1) },
      { from: name(0), to: name(2) },
      { from: `${name(1)}.reorder`, to: name(0) },
    ]);
    const forward = simulateImageRenames(files, plan.renames);
    expect(forward.clashes).toEqual([]);
    // The reverse runs on the files as the forward renames left them
    const after = [...forward.present.values()].flat();
    const back = plan.renames.map(r => ({ from: r.to, to: r.from })).reverse();
    expect(simulateImageRenames(after, back).clashes).toEqual([]);
  });

  it('reversing three frames leaves the middle one where it is', () => {
    const plan = planFrameImageReorder([name(0), name(1), name(2)], 'Hero', 'Walk', [png, png, png], [2, 1, 0]);
    expect(plan.moved).toEqual([{ from: name(2), to: name(0) }, { from: name(0), to: name(2) }]);
    expect(plan.renames).toEqual([
      { from: name(2), to: `${name(2)}.reorder` },
      { from: name(0), to: name(2) },
      { from: `${name(2)}.reorder`, to: name(0) },
    ]);
  });

  it('keeps each file\'s extension, and needs no temporary name when the names do not collide', () => {
    const plan = planFrameImageReorder([name(0), name(1, 'jpg'), name(2, 'gif')], 'Hero', 'Walk', [png, jpeg, gif], [2, 1, 0]);
    expect(plan.renames).toEqual([{ from: name(2, 'gif'), to: name(0, 'gif') }, { from: name(0), to: name(2) }]);
  });

  it('keeps a file no frame uses under a target name as .bak first', () => {
    // Frame 1 is JPEG; a stale PNG sits next to its .jpg under the name frame 0's image needs
    const plan = planFrameImageReorder([name(0), name(1, 'jpg'), name(1)], 'Hero', 'Walk', [png, jpeg], [1, 0]);
    expect(plan.backedUp).toEqual([{ from: name(1), to: `${name(1)}.bak` }]);
    expect(plan.renames).toEqual([
      { from: name(1), to: `${name(1)}.bak` },
      { from: name(1, 'jpg'), to: name(0, 'jpg') },
      { from: name(0), to: name(1) },
    ]);
  });

  it('keeps an unused file at the new index of a frame without an image file as .bak, so the frame does not take it', () => {
    // Frame 0 is JPEG and has no file; an orphan 001.jpg sits where it goes
    const plan = planFrameImageReorder([name(1), name(1, 'jpg')], 'Hero', 'Walk', [jpeg, png], [1, 0]);
    expect(plan.missing).toEqual([name(0, 'jpg')]);
    expect(plan.backedUp).toEqual([{ from: name(1, 'jpg'), to: `${name(1, 'jpg')}.bak` }]);
    expect(plan.renames).toEqual([{ from: name(1, 'jpg'), to: `${name(1, 'jpg')}.bak` }, { from: name(1), to: name(0) }]);
  });

  it('keeps an unused file of another extension that a frame of another fileType would bind at its new index', () => {
    // A frame of another fileType binds every file with its name and a single extension
    const webp = { fileType: 'image/webp' };
    const plan = planFrameImageReorder([name(0), name(0, 'webp'), name(1, 'gif')], 'Hero', 'Walk', [png, webp], [1, 0]);
    expect(plan.backedUp).toEqual([{ from: name(0, 'webp'), to: `${name(0, 'webp')}.bak` }]);
  });

  it('takes the next free temporary name when one is taken, e.g. by a stopped earlier run', () => {
    const plan = planFrameImageReorder([name(0), name(1), `${name(1)}.reorder`], 'Hero', 'Walk', [png, png], [1, 0]);
    expect(plan.renames[0]).toEqual({ from: name(1), to: 'hero-walk-001.png.1.reorder' });
    expect(plan.clashes).toEqual([]);
  });

  it('lists frames that change index but have no image file, and moves the others', () => {
    const plan = planFrameImageReorder([name(0), name(2)], 'Hero', 'Walk', [png, png, png], [1, 2, 0]);
    expect(plan.missing).toEqual([name(1)]);
    expect(plan.renames).toEqual([{ from: name(2), to: name(1) }, { from: name(0), to: name(2) }]);
  });

  it('reports a clash and plans nothing when two files that differ only in case would get the same name', () => {
    // Possible on a case-sensitive file system
    const plan = planFrameImageReorder(['Hero-Walk-000.png', name(0), name(1)], 'Hero', 'Walk', [png, png], [1, 0]);
    expect(plan.clashes).toEqual([`images/Hero-Walk-000.png and images/${name(0)} would both be renamed to images/${name(1)}`]);
    expect(plan.renames).toEqual([]);
  });

  it('moves nothing for the order the frames already have', () => {
    expect(planFrameImageReorder([name(0), name(1)], 'Hero', 'Walk', [png, png], [0, 1]))
      .toEqual({ renames: [], moved: [], backedUp: [], missing: [], clashes: [] });
  });
});
