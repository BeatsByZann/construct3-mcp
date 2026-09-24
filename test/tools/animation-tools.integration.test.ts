import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Construct3ProjectReader } from '../../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../../src/construct3/project-writer.js';
import { IdGenerator } from '../../src/construct3/id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { generatePlaceholderPng } from '../../src/construct3/png-generator.js';
import { MockServer } from '../mocks/mock-server.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'minimal-project');
const ANIMATION = 'Animation 1';

function resultOf(value: { content: Array<{ text: string }>; isError?: boolean }): Record<string, unknown> {
  if (value.isError) throw new Error(value.content[0]?.text);
  return JSON.parse(value.content[0].text) as Record<string, unknown>;
}

/** Construct saves frame files under an all-lowercase name, the animation part included. */
function imageName(frameIndex: number): string {
  return `sprite-${ANIMATION.toLowerCase()}-${String(frameIndex).padStart(3, '0')}.png`;
}

/** Width and height from a PNG's IHDR chunk, which always starts at byte 16. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('animation frame tools against a real project on disk', () => {
  let projectDir: string;
  let reader: Construct3ProjectReader;
  let server: MockServer;

  async function readFrames(): Promise<Array<Record<string, unknown>>> {
    const obj = JSON.parse(await readFile(join(projectDir, 'objectTypes', 'Sprite.json'), 'utf8')) as any;
    return obj.animations.items[0].frames;
  }

  async function readImage(frameIndex: number): Promise<string> {
    return readFile(join(projectDir, 'images', imageName(frameIndex)), 'utf8');
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'c3-animation-tools-'));
    await cp(FIXTURE_DIR, projectDir, { recursive: true });

    // Give the fixture sprite three distinguishable frames plus their images.
    const objectPath = join(projectDir, 'objectTypes', 'Sprite.json');
    const obj = JSON.parse(await readFile(objectPath, 'utf8')) as any;
    obj.animations.items[0].frames = [0, 1, 2].map(index => ({
      width: 64,
      height: 64,
      originX: 0.5,
      originY: 0.5,
      duration: 1,
      tag: '',
      imageSpriteId: 500 + index,
    }));
    await writeFile(objectPath, JSON.stringify(obj, null, '\t'), 'utf8');

    await mkdir(join(projectDir, 'images'), { recursive: true });
    for (const index of [0, 1, 2]) {
      await writeFile(join(projectDir, 'images', imageName(index)), `image-${index}`, 'utf8');
    }

    reader = new Construct3ProjectReader(join(projectDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerAnimationTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reorder_frames renames the frame image files to match the new order', async () => {
    const result = resultOf(await server.callTool('reorder_frames', {
      objectName: 'Sprite', animationName: ANIMATION, order: [2, 0, 1],
    }));
    expect(result.success).toBe(true);
    expect((result.warnings as string[])[0]).toContain('Renamed 3 frame image file(s)');

    const frames = await readFrames();
    expect(frames.map(frame => frame.imageSpriteId)).toEqual([502, 500, 501]);
    expect(await readImage(0)).toBe('image-2');
    expect(await readImage(1)).toBe('image-0');
    expect(await readImage(2)).toBe('image-1');

    // No temporary parking files may survive a successful reorder.
    const images = await readdir(join(projectDir, 'images'));
    expect(images.filter(name => name.includes('reorder-tmp'))).toHaveLength(0);
    // Exact names: readdir reports the case even where lookups ignore it.
    expect(images.filter(name => name.endsWith('.png')).sort()).toEqual([0, 1, 2].map(imageName));
  });

  it('reverse_frames reverses both the frame JSON and the image files', async () => {
    resultOf(await server.callTool('reverse_frames', { objectName: 'Sprite', animationName: ANIMATION }));

    const frames = await readFrames();
    expect(frames.map(frame => frame.imageSpriteId)).toEqual([502, 501, 500]);
    expect(await readImage(0)).toBe('image-2');
    expect(await readImage(1)).toBe('image-1');
    expect(await readImage(2)).toBe('image-0');
  });

  it('reorder_frames leaves the project untouched when the order is not a permutation', async () => {
    const result = await server.callTool('reorder_frames', {
      objectName: 'Sprite', animationName: ANIMATION, order: [2, 0],
    });
    expect(result.isError).toBe(true);

    const frames = await readFrames();
    expect(frames.map(frame => frame.imageSpriteId)).toEqual([500, 501, 502]);
    expect(await readImage(0)).toBe('image-0');
    expect(await readImage(2)).toBe('image-2');
  });

  it('duplicate_frame shifts later image files up and copies the source image', async () => {
    const result = resultOf(await server.callTool('duplicate_frame', {
      objectName: 'Sprite', animationName: ANIMATION, frameIndex: 0,
    }));
    expect(result.success).toBe(true);

    const frames = await readFrames();
    expect(frames).toHaveLength(4);
    expect(frames[1].imageSpriteId).not.toBe(frames[0].imageSpriteId);
    expect(frames.map(frame => frame.width)).toEqual([64, 64, 64, 64]);

    expect(await readImage(0)).toBe('image-0');
    expect(await readImage(1)).toBe('image-0');
    expect(await readImage(2)).toBe('image-1');
    expect(await readImage(3)).toBe('image-2');
  });

  it('duplicate_frame honours insertAt when the source sits after the insert point', async () => {
    resultOf(await server.callTool('duplicate_frame', {
      objectName: 'Sprite', animationName: ANIMATION, frameIndex: 2, insertAt: 0,
    }));

    const frames = await readFrames();
    expect(frames).toHaveLength(4);
    expect(frames[0].imageSpriteId).not.toBe(502);
    expect(frames.slice(1).map(frame => frame.imageSpriteId)).toEqual([500, 501, 502]);

    expect(await readImage(0)).toBe('image-2');
    expect(await readImage(1)).toBe('image-0');
    expect(await readImage(2)).toBe('image-1');
    expect(await readImage(3)).toBe('image-2');
  });

  it('add_frame_to_animation shifts later image files up when inserting mid-animation', async () => {
    const result = resultOf(await server.callTool('add_frame_to_animation', {
      objectName: 'Sprite', animationName: ANIMATION, index: 1,
    }));
    expect(result.success).toBe(true);
    expect((result.warnings as string[])[0]).toContain('Shifted 2 frame image file(s)');

    const frames = await readFrames();
    expect(frames).toHaveLength(4);
    expect(frames.map(frame => frame.imageSpriteId).slice(2)).toEqual([501, 502]);

    // The inserted slot holds the freshly written placeholder PNG, and every
    // later frame still owns the image it had before the insert.
    const placeholder = await readFile(join(projectDir, 'images', imageName(1)));
    expect(placeholder.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await readImage(0)).toBe('image-0');
    expect(await readImage(2)).toBe('image-1');
    expect(await readImage(3)).toBe('image-2');
  });

  it('add_frame_to_animation leaves the existing image files alone when appending', async () => {
    const result = resultOf(await server.callTool('add_frame_to_animation', {
      objectName: 'Sprite', animationName: ANIMATION,
    }));
    expect(result.warnings).toBeUndefined();

    expect(await readImage(0)).toBe('image-0');
    expect(await readImage(1)).toBe('image-1');
    expect(await readImage(2)).toBe('image-2');
    const appended = await readFile(join(projectDir, 'images', imageName(3)));
    expect(appended.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('add_frame_to_animation rejects an index past the end of the animation', async () => {
    const result = await server.callTool('add_frame_to_animation', {
      objectName: 'Sprite', animationName: ANIMATION, index: 9,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
    expect(await readFrames()).toHaveLength(3);
    const images = await readdir(join(projectDir, 'images'));
    expect(images.filter(name => name.endsWith('.png'))).toHaveLength(3);
  });

  it('delete_frame_from_animation shifts later image files down and drops the freed slot', async () => {
    const result = resultOf(await server.callTool('delete_frame_from_animation', {
      objectName: 'Sprite', animationName: ANIMATION, frameIndex: 0,
    }));
    expect(result.success).toBe(true);
    expect((result.warnings as string[])[0]).toContain('Removed or shifted 3 frame image file(s)');

    const frames = await readFrames();
    expect(frames.map(frame => frame.imageSpriteId)).toEqual([501, 502]);
    expect(await readImage(0)).toBe('image-1');
    expect(await readImage(1)).toBe('image-2');
    await expect(readFile(join(projectDir, 'images', imageName(2)))).rejects.toMatchObject({ code: 'ENOENT' });

    const images = await readdir(join(projectDir, 'images'));
    expect(images.filter(name => name.includes('reorder-tmp'))).toHaveLength(0);
    expect(images).toHaveLength(2);
  });

  it('delete_frame_from_animation removes only the last image file when deleting the last frame', async () => {
    resultOf(await server.callTool('delete_frame_from_animation', {
      objectName: 'Sprite', animationName: ANIMATION, frameIndex: 2,
    }));

    expect(await readImage(0)).toBe('image-0');
    expect(await readImage(1)).toBe('image-1');
    await expect(readFile(join(projectDir, 'images', imageName(2)))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('update_frame persists image points, a tag and a collision polygon', async () => {
    resultOf(await server.callTool('update_frame', {
      objectName: 'Sprite', animationName: ANIMATION, frameIndex: 1,
      tag: 'contact',
      imagePoints: [{ name: 'Muzzle', x: 0.75, y: 0.25 }],
      collisionPoly: [0, 0, 1, 0, 1, 1],
      useCollisionPoly: true,
    }));

    const frames = await readFrames();
    expect(frames[1]).toMatchObject({
      tag: 'contact',
      imagePoints: [{ name: 'Muzzle', x: 0.75, y: 0.25 }],
      collisionPoly: { points: [0, 0, 1, 0, 1, 1] },
      useCollisionPoly: true,
    });
  });

  it('create_animation_folder and move_animation_to_folder persist the animations tree', async () => {
    resultOf(await server.callTool('create_animation_folder', { objectName: 'Sprite', folderPath: 'Combat/Melee' }));
    resultOf(await server.callTool('move_animation_to_folder', {
      objectName: 'Sprite', animationName: ANIMATION, folderPath: 'Combat/Melee',
    }));

    const obj = JSON.parse(await readFile(join(projectDir, 'objectTypes', 'Sprite.json'), 'utf8')) as any;
    expect(obj.animations.items).toHaveLength(0);
    const melee = obj.animations.subfolders[0].subfolders[0];
    expect(melee.name).toBe('Melee');
    expect(melee.items[0].name).toBe(ANIMATION);

    resultOf(await server.callTool('move_animation_to_folder', {
      objectName: 'Sprite', animationName: ANIMATION, folderPath: null,
    }));
    const back = JSON.parse(await readFile(join(projectDir, 'objectTypes', 'Sprite.json'), 'utf8')) as any;
    expect(back.animations.items[0].name).toBe(ANIMATION);
    expect(back.animations.subfolders[0].subfolders[0].items).toHaveLength(0);
  });

  /**
   * r495.2 reads a frame image's real IHDR on load and rewrites the frame's
   * width and height to match, so a placeholder written at a size other than
   * the one the JSON declares comes back changed. The two must agree.
   */
  it('writes the new frame placeholder at the size the frame declares', async () => {
    resultOf(await server.callTool('add_frame_to_animation', {
      objectName: 'Sprite', animationName: ANIMATION, width: 48, height: 32,
    }));

    const frames = await readFrames();
    const added = frames[frames.length - 1];
    expect(added.width).toBe(48);
    expect(added.height).toBe(32);

    const png = await readFile(join(projectDir, 'images', imageName(frames.length - 1)));
    expect(pngSize(png)).toEqual({ width: 48, height: 32 });
  });

  it('writes each placeholder of a new animation at the declared frame size', async () => {
    resultOf(await server.callTool('add_animation_to_sprite', {
      objectName: 'Sprite', animationName: 'Walk', frameCount: 2, frameWidth: 64, frameHeight: 24,
    }));

    const obj = JSON.parse(await readFile(join(projectDir, 'objectTypes', 'Sprite.json'), 'utf8')) as any;
    const walk = obj.animations.items.find((a: any) => a.name === 'Walk');
    expect(walk.frames.map((f: any) => [f.width, f.height])).toEqual([[64, 24], [64, 24]]);

    for (const index of [0, 1]) {
      const name = `sprite-walk-${String(index).padStart(3, '0')}.png`;
      const png = await readFile(join(projectDir, 'images', name));
      expect(pngSize(png)).toEqual({ width: 64, height: 24 });
    }
  });

  // rename_animation moves the frame files (W127).

  async function pngNames(): Promise<string[]> {
    return (await readdir(join(projectDir, 'images'))).filter(name => name.endsWith('.png')).sort();
  }

  async function animationNames(): Promise<string[]> {
    const obj = JSON.parse(await readFile(join(projectDir, 'objectTypes', 'Sprite.json'), 'utf8')) as any;
    return obj.animations.items.map((a: any) => a.name);
  }

  it('rename_animation moves every frame image file to the new animation name', async () => {
    const result = resultOf(await server.callTool('rename_animation', {
      objectName: 'Sprite', animationName: ANIMATION, newName: 'Run',
    }));
    expect((result.warnings as string[])[0]).toContain('Renamed 3 frame image file(s)');
    expect(await animationNames()).toEqual(['Run']);
    expect(await pngNames()).toEqual(['sprite-run-000.png', 'sprite-run-001.png', 'sprite-run-002.png']);
    for (const index of [0, 1, 2]) {
      expect(await readFile(join(projectDir, 'images', `sprite-run-00${index}.png`), 'utf8')).toBe(`image-${index}`);
    }
  });

  it('rename_animation moves nothing when the names differ only in case', async () => {
    const before = await pngNames();
    const result = resultOf(await server.callTool('rename_animation', {
      objectName: 'Sprite', animationName: ANIMATION, newName: 'ANIMATION 1',
    }));
    expect((result.warnings as string[])[0]).toContain('No frame image files needed renaming');
    expect(await animationNames()).toEqual(['ANIMATION 1']);
    expect(await pngNames()).toEqual(before);
  });

  it('rename_animation refuses a name another animation has in a different case', async () => {
    resultOf(await server.callTool('add_animation_to_sprite', { objectName: 'Sprite', animationName: 'Walk' }));
    const before = await pngNames();
    const r = await server.callTool('rename_animation', {
      objectName: 'Sprite', animationName: ANIMATION, newName: 'walk',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('only in case');
    expect(await animationNames()).toEqual([ANIMATION, 'Walk']);
    expect(await pngNames()).toEqual(before);
  });

  it('rename_animation refuses, and moves nothing, when a file for the new name is already there', async () => {
    await writeFile(join(projectDir, 'images', 'sprite-run-001.png'), 'stray', 'utf8');
    const r = await server.callTool('rename_animation', {
      objectName: 'Sprite', animationName: ANIMATION, newName: 'Run',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('would overwrite');
    expect(await animationNames()).toEqual([ANIMATION]);
    expect(await pngNames()).toEqual([imageName(0), imageName(1), imageName(2), 'sprite-run-001.png'].sort());
    expect(await readFile(join(projectDir, 'images', 'sprite-run-001.png'), 'utf8')).toBe('stray');
  });

  it('rename_animation adopts frame files an earlier version left under the new name', async () => {
    // An earlier rename_animation renamed "Run" to "Animation 1" in the JSON
    // and left the files under "run", which renaming back should repair.
    for (const index of [0, 1, 2]) {
      await rename(join(projectDir, 'images', imageName(index)), join(projectDir, 'images', `sprite-run-00${index}.png`));
    }
    const result = resultOf(await server.callTool('rename_animation', {
      objectName: 'Sprite', animationName: ANIMATION, newName: 'Run',
    }));
    expect((result.warnings as string[])[0]).toContain('No frame image files needed renaming');
    expect(await animationNames()).toEqual(['Run']);
    expect(await pngNames()).toEqual(['sprite-run-000.png', 'sprite-run-001.png', 'sprite-run-002.png']);
  });
});

/**
 * A-O1: frame files take their extension from the frame's fileType. C3-ACE
 * holds 30 image/gif frames; every frame tool must move, copy, rename and
 * replace those under their .gif names rather than assume .png.
 */
describe('frame tools on GIF-backed frames', () => {
  let projectDir: string;
  let server: MockServer;

  async function readFrames(): Promise<Array<Record<string, unknown>>> {
    const obj = JSON.parse(await readFile(join(projectDir, 'objectTypes', 'Sprite.json'), 'utf8')) as any;
    return obj.animations.items[0].frames;
  }
  async function imageFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of (await readdir(join(projectDir, 'images'))).sort()) {
      out[name] = await readFile(join(projectDir, 'images', name), 'utf8');
    }
    return out;
  }
  const name = (index: number, ext: string) => `sprite-${ANIMATION.toLowerCase()}-${String(index).padStart(3, '0')}.${ext}`;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'c3-animation-gif-'));
    await cp(FIXTURE_DIR, projectDir, { recursive: true });
    const objectPath = join(projectDir, 'objectTypes', 'Sprite.json');
    const obj = JSON.parse(await readFile(objectPath, 'utf8')) as any;
    // Frame 1 is a GIF among PNGs, as in C3-ACE.
    obj.animations.items[0].frames = [0, 1, 2].map(index => ({
      width: 64, height: 64, originX: 0.5, originY: 0.5, duration: 1, tag: '',
      imageSpriteId: 500 + index,
      ...(index === 1 ? { fileType: 'image/gif' } : {}),
    }));
    await writeFile(objectPath, JSON.stringify(obj, null, '\t'), 'utf8');
    await mkdir(join(projectDir, 'images'), { recursive: true });
    await writeFile(join(projectDir, 'images', name(0, 'png')), 'image-0', 'utf8');
    await writeFile(join(projectDir, 'images', name(1, 'gif')), 'image-1', 'utf8');
    await writeFile(join(projectDir, 'images', name(2, 'png')), 'image-2', 'utf8');
    const reader = new Construct3ProjectReader(join(projectDir, 'project.c3proj'));
    await reader.loadProject();
    const idGen = new IdGenerator();
    const writer = new Construct3ProjectWriter(reader, idGen);
    server = new MockServer();
    registerAnimationTools({ server, reader, writer, idGen } as any);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reorder_frames moves the GIF under its new index as a GIF', async () => {
    resultOf(await server.callTool('reorder_frames', { objectName: 'Sprite', animationName: ANIMATION, order: [1, 0, 2] }));
    expect((await readFrames()).map(f => f.fileType)).toEqual(['image/gif', undefined, undefined]);
    expect(await imageFiles()).toEqual({
      [name(0, 'gif')]: 'image-1',
      [name(1, 'png')]: 'image-0',
      [name(2, 'png')]: 'image-2',
    });
  });

  it('duplicate_frame copies the GIF and shifts the later PNG', async () => {
    resultOf(await server.callTool('duplicate_frame', { objectName: 'Sprite', animationName: ANIMATION, frameIndex: 1 }));
    expect((await readFrames()).map(f => f.fileType)).toEqual([undefined, 'image/gif', 'image/gif', undefined]);
    expect(await imageFiles()).toEqual({
      [name(0, 'png')]: 'image-0',
      [name(1, 'gif')]: 'image-1',
      [name(2, 'gif')]: 'image-1',
      [name(3, 'png')]: 'image-2',
    });
  });

  it('delete_frame_from_animation shifts the GIF down under its own extension', async () => {
    resultOf(await server.callTool('delete_frame_from_animation', { objectName: 'Sprite', animationName: ANIMATION, frameIndex: 0 }));
    expect((await readFrames()).map(f => f.fileType)).toEqual(['image/gif', undefined]);
    expect(await imageFiles()).toEqual({
      [name(0, 'gif')]: 'image-1',
      [name(1, 'png')]: 'image-2',
    });
  });

  it('rename_animation moves the GIF with the PNGs', async () => {
    resultOf(await server.callTool('rename_animation', { objectName: 'Sprite', animationName: ANIMATION, newName: 'Run' }));
    expect(Object.keys(await imageFiles())).toEqual(['sprite-run-000.png', 'sprite-run-001.gif', 'sprite-run-002.png']);
  });

  it('replace_sprite_image turns a GIF frame into a PNG and removes the old file', async () => {
    const png = generatePlaceholderPng(8, 8).toString('base64');
    resultOf(await server.callTool('replace_sprite_image', { objectName: 'Sprite', animationName: ANIMATION, frameIndex: 1, pngBase64: png }));
    expect((await readFrames())[1].fileType).toBe('image/png');
    const files = Object.keys(await imageFiles());
    expect(files).toContain(name(1, 'png'));
    expect(files).not.toContain(name(1, 'gif'));
  });
});