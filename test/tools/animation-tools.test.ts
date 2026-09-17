import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';

function setup(readerData = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerAnimationTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

function makeSpriteObj(name = 'Hero') {
  return {
    name,
    'plugin-id': 'Sprite',
    sid: 1,
    isGlobal: false,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
    animations: {
      items: [{
        frames: [{ width: 100, height: 100, originX: 0.5, originY: 0.5 }],
        sid: 10,
        name: 'Animation 1',
        isLooping: false,
        isPingPong: false,
        repeatCount: 1,
        repeatTo: 0,
        speed: 0,
      }],
      subfolders: [],
    },
  };
}

describe('add_animation_to_sprite', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_animation_to_sprite')).toBe(true);
  });

  it('adds an animation to a Sprite', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Walk',
      speed: 10,
      isLooping: true,
      frameCount: 4,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.generatedSid).toBeDefined();

    // Verify the written data has 2 animations
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[1].name).toBe('Walk');
    expect(items[1].speed).toBe(10);
    expect((items[1].frames as unknown[]).length).toBe(4);
  });

  it('writes placeholder PNGs for each frame with imageSpriteId', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Run',
      frameCount: 3,
    });

    // Verify writeImageFiles was called with 3 files
    const imageCalls = writer.callsFor('writeImageFiles');
    expect(imageCalls).toHaveLength(1);
    const files = imageCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(3);
    expect(files[0].objectName).toBe('Hero');
    expect(files[0].animationName).toBe('Run');
    expect(files[0].frameIndex).toBe(0);
    expect(files[1].frameIndex).toBe(1);
    expect(files[2].frameIndex).toBe(2);

    // Verify each frame in the written data has an imageSpriteId
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    const newAnim = items[1];
    const frames = newAnim.frames as Array<Record<string, unknown>>;
    for (const frame of frames) {
      expect(frame.imageSpriteId).toBeDefined();
      expect(typeof frame.imageSpriteId).toBe('number');
    }
    // Each frame should have a unique imageSpriteId
    const ids = frames.map(f => f.imageSpriteId);
    expect(new Set(ids).size).toBe(3);
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'NonExistent',
      animationName: 'Walk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on non-Sprite object', async () => {
    const { server } = setup({
      objects: new Map([['Label', { name: 'Label', 'plugin-id': 'Text', sid: 1 }]]),
    });
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'Label',
      animationName: 'Walk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Sprite');
  });

  it('errors on duplicate animation name', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Animation 1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('uses existing sprite dimensions for frames by default', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    await server.callTool('add_animation_to_sprite', {
      objectName: 'Hero',
      animationName: 'Idle',
      frameCount: 1,
    });
    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    const newAnim = items[1];
    const frames = newAnim.frames as Array<Record<string, unknown>>;
    expect(frames[0].width).toBe(100);
    expect(frames[0].height).toBe(100);
  });
});

describe('update_animation_properties', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_animation_properties')).toBe(true);
  });

  it('updates speed and looping', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      speed: 15,
      isLooping: true,
    });
    expect(parseResult(result).success).toBe(true);

    const writtenData = writer.callsFor('writeEntityFile')[0].args[2] as Record<string, unknown>;
    const animations = writtenData.animations as Record<string, unknown>;
    const items = animations.items as Array<Record<string, unknown>>;
    expect(items[0].speed).toBe(15);
    expect(items[0].isLooping).toBe(true);
  });

  it('errors with no updates', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'Animation 1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors on nonexistent animation', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'NonExistent',
      speed: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('errors on nonexistent object', async () => {
    const { server } = setup();
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Ghost',
      animationName: 'Walk',
      speed: 5,
    });
    expect(result.isError).toBe(true);
  });

  it('errors on non-Sprite', async () => {
    const { server } = setup({
      objects: new Map([['Label', { name: 'Label', 'plugin-id': 'Text', sid: 1 }]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Label',
      animationName: 'X',
      speed: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Sprite');
  });

  it('warns when isLooping:true and repeatCount>1 are set simultaneously', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      isLooping: true,
      repeatCount: 3,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data.warnings[0]).toContain('repeatCount');
    expect(data.warnings[0]).toContain('looping');
  });

  it('does not warn when isLooping:true and repeatCount is 1', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    const result = await server.callTool('update_animation_properties', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      isLooping: true,
      repeatCount: 1,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
  });
});

// ─── delete_animation ─────────────────────────────────────

describe('delete_animation', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_animation')).toBe(true);
  });

  it('deletes an animation', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', {
        ...makeSpriteObj(),
        animations: {
          items: [
            { name: 'Idle', sid: 10, frames: [], isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 0 },
            { name: 'Walk', sid: 11, frames: [], isLooping: true, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 5 },
          ],
          subfolders: [],
        },
      }]]),
    });
    const result = await server.callTool('delete_animation', {
      objectName: 'Hero',
      animationName: 'Walk',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items).toHaveLength(1);
    expect(written.animations.items[0].name).toBe('Idle');
  });

  it('blocks deletion of last animation', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('delete_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('last animation');
  });

  it('errors on nonexistent animation', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('delete_animation', {
      objectName: 'Hero',
      animationName: 'Ghost',
    });
    expect(result.isError).toBe(true);
  });
});

// ─── rename_animation ─────────────────────────────────────

describe('rename_animation', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('rename_animation')).toBe(true);
  });

  it('renames an animation', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('rename_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      newName: 'Idle',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items[0].name).toBe('Idle');
  });

  it('rejects duplicate name', async () => {
    const { server } = setup({
      objects: new Map([['Hero', {
        ...makeSpriteObj(),
        animations: {
          items: [
            { name: 'Idle', sid: 10, frames: [], isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 0 },
            { name: 'Walk', sid: 11, frames: [], isLooping: true, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 5 },
          ],
          subfolders: [],
        },
      }]]),
    });
    const result = await server.callTool('rename_animation', {
      objectName: 'Hero',
      animationName: 'Idle',
      newName: 'Walk',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });
});

// ─── add_frame_to_animation ───────────────────────────────

describe('add_frame_to_animation', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('add_frame_to_animation')).toBe(true);
  });

  it('appends a frame', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('add_frame_to_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      width: 64,
      height: 64,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items[0].frames).toHaveLength(2);
    expect(written.animations.items[0].frames[1].width).toBe(64);
  });

  it('inserts a frame at index 0', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    await server.callTool('add_frame_to_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      index: 0,
    });
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items[0].frames).toHaveLength(2);
  });
});

describe('add_frame_to_animation index guard', () => {
  it('rejects an index past the end of the animation', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('add_frame_to_animation', {
      objectName: 'Hero', animationName: 'Animation 1', index: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
    expect(writer.callsFor('writeImageFiles')).toHaveLength(0);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('appends at the end without shifting anything', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('add_frame_to_animation', {
      objectName: 'Hero', animationName: 'Animation 1',
    });
    expect(parseResult(result).success).toBe(true);
    const files = writer.callsFor('writeImageFiles')[0].args[0] as Array<Record<string, unknown>>;
    expect(files[0].frameIndex).toBe(2);
  });

  it('writes the placeholder into the freed slot when inserting mid-animation', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(3)]]) });
    await server.callTool('add_frame_to_animation', {
      objectName: 'Hero', animationName: 'Animation 1', index: 1,
    });
    const files = writer.callsFor('writeImageFiles')[0].args[0] as Array<Record<string, unknown>>;
    expect(files[0].frameIndex).toBe(1);
    const frames = writtenFrames(writer);
    expect(frames.map((frame: any) => frame.imageSpriteId).slice(2)).toEqual([101, 102]);
  });
});

// ─── delete_frame_from_animation ─────────────────────────

describe('delete_frame_from_animation', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_frame_from_animation')).toBe(true);
  });

  it('deletes a frame', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', {
        ...makeSpriteObj(),
        animations: {
          items: [{
            name: 'Animation 1', sid: 10, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 0,
            frames: [
              { width: 100, height: 100, originX: 0.5, originY: 0.5, imageSpriteId: 1 },
              { width: 100, height: 100, originX: 0.5, originY: 0.5, imageSpriteId: 2 },
            ],
          }],
          subfolders: [],
        },
      }]]),
    });
    const result = await server.callTool('delete_frame_from_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      frameIndex: 0,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items[0].frames).toHaveLength(1);
    expect(written.animations.items[0].frames[0].imageSpriteId).toBe(2);
  });

  it('blocks deletion of last frame', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('delete_frame_from_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      frameIndex: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('last frame');
  });

  it('errors on out-of-range index', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('delete_frame_from_animation', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      frameIndex: 99,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });
});

// ─── update_frame ─────────────────────────────────────────

describe('update_frame', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_frame')).toBe(true);
  });

  it('updates frame duration and dimensions', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      frameIndex: 0,
      width: 64,
      height: 64,
      duration: 0.5,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    const frame = written.animations.items[0].frames[0];
    expect(frame.width).toBe(64);
    expect(frame.duration).toBe(0.5);
  });

  it('errors with no updates', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      frameIndex: 0,
    });
    expect(result.isError).toBe(true);
  });
});

// ─── replace_sprite_image ─────────────────────────────────

describe('replace_sprite_image', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('replace_sprite_image')).toBe(true);
  });

  it('rejects invalid base64 / non-PNG data', async () => {
    const { server } = setup({
      objects: new Map([['Hero', {
        ...makeSpriteObj(),
        animations: {
          items: [{
            name: 'Animation 1', sid: 10, isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 0,
            frames: [{ width: 100, height: 100, originX: 0.5, originY: 0.5, imageSpriteId: 1 }],
          }],
          subfolders: [],
        },
      }]]),
    });
    // "aGVsbG8=" decodes to "hello" — not a PNG
    const result = await server.callTool('replace_sprite_image', {
      objectName: 'Hero',
      animationName: 'Animation 1',
      frameIndex: 0,
      pngBase64: 'aGVsbG8=',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('valid PNG');
  });
});

// ─── update_frame: tag, image points, collision polygon ──

function makeFramedSprite(frameCount: number, extra: Record<string, unknown> = {}) {
  return {
    name: 'Hero',
    'plugin-id': 'Sprite',
    sid: 1,
    isGlobal: false,
    instanceVariables: [],
    behaviorTypes: [],
    effectTypes: [],
    animations: {
      items: [{
        name: 'Animation 1',
        sid: 10,
        isLooping: false,
        isPingPong: false,
        repeatCount: 1,
        repeatTo: 0,
        speed: 0,
        frames: Array.from({ length: frameCount }, (_unused, index) => ({
          width: 100,
          height: 100,
          originX: 0.5,
          originY: 0.5,
          duration: 1,
          tag: '',
          imageSpriteId: 100 + index,
          ...extra,
        })),
      }],
      subfolders: [] as Array<Record<string, unknown>>,
    },
  };
}

function writtenFrames(writer: any, call = 0) {
  const written = writer.callsFor('writeEntityFile')[call].args[2] as any;
  return written.animations.items[0].frames;
}

describe('update_frame image points, tag and collision polygon', () => {
  it('sets a frame tag', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, tag: 'hitbox',
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenFrames(writer)[0].tag).toBe('hitbox');
  });

  it('replaces the whole image point list', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeFramedSprite(1, { imagePoints: [{ name: 'Old', x: 0, y: 0 }] })]]),
    });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      imagePoints: [{ name: 'Muzzle', x: 0.25, y: 0.75 }],
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenFrames(writer)[0].imagePoints).toEqual([{ name: 'Muzzle', x: 0.25, y: 0.75 }]);
  });

  it('rejects an image point outside the normalized 0-1 range', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      imagePoints: [{ name: 'Muzzle', x: 1.5, y: 0.5 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a negative image point coordinate', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      imagePoints: [{ name: 'Muzzle', x: 0.5, y: -0.01 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('normalized 0-1');
  });

  it('rejects duplicate image point names', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      imagePoints: [{ name: 'Muzzle', x: 0.1, y: 0.1 }, { name: 'Muzzle', x: 0.2, y: 0.2 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('appears twice');
  });

  it('adds image points to an existing list', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeFramedSprite(1, { imagePoints: [{ name: 'Head', x: 0.5, y: 0 }] })]]),
    });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      addImagePoints: [{ name: 'Feet', x: 0.5, y: 1 }],
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenFrames(writer)[0].imagePoints).toEqual([
      { name: 'Head', x: 0.5, y: 0 },
      { name: 'Feet', x: 0.5, y: 1 },
    ]);
  });

  it('rejects an added image point that collides with an existing name', async () => {
    const { server } = setup({
      objects: new Map([['Hero', makeFramedSprite(1, { imagePoints: [{ name: 'Head', x: 0.5, y: 0 }] })]]),
    });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      addImagePoints: [{ name: 'Head', x: 0.1, y: 0.1 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('resulting image point list');
  });

  it('rejects an added image point outside the normalized 0-1 range', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      addImagePoints: [{ name: 'Far', x: 0.5, y: 2 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('removes image points by name, and reports names that are absent', async () => {
    const points = [{ name: 'Head', x: 0.5, y: 0 }, { name: 'Feet', x: 0.5, y: 1 }];
    const { server, writer } = setup({
      objects: new Map([['Hero', makeFramedSprite(1, { imagePoints: points })]]),
    });
    const removed = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, removeImagePoints: ['Head'],
    });
    expect(parseResult(removed).success).toBe(true);
    expect(writtenFrames(writer)[0].imagePoints).toEqual([{ name: 'Feet', x: 0.5, y: 1 }]);

    const missing = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, removeImagePoints: ['Nope'],
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('not found on frame 0');
  });

  it('rejects combining imagePoints with addImagePoints', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      imagePoints: [{ name: 'A', x: 0, y: 0 }],
      addImagePoints: [{ name: 'B', x: 1, y: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('do not combine');
  });

  it('writes a normalized collision polygon and toggles useCollisionPoly', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      collisionPoly: [0, 0, 1, 0, 1, 1, 0, 1],
      useCollisionPoly: false,
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings).toBeUndefined();
    const frame = writtenFrames(writer)[0];
    expect(frame.collisionPoly).toEqual({ points: [0, 0, 1, 0, 1, 1, 0, 1] });
    expect(frame.useCollisionPoly).toBe(false);
  });

  it('rejects an odd-length collision polygon', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      collisionPoly: [0, 0, 1, 0, 1],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be even');
  });

  it('rejects a collision polygon with fewer than three points', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      collisionPoly: [0, 0, 1, 1],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 3 points');
  });

  it('clears the collision polygon with an empty array', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeFramedSprite(1, { collisionPoly: { points: [0, 0, 1, 0, 1, 1] } })]]),
    });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, collisionPoly: [],
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenFrames(writer)[0].collisionPoly).toEqual({ points: [] });
  });

  it('warns when a collision polygon point falls outside 0-1', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('update_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
      collisionPoly: [0, 0, 1.5, 0, 1, 1],
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.warnings[0]).toContain('outside 0-1');
  });
});

// ─── reorder_frames / reverse_frames ─────────────────────

describe('reorder_frames', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('reorder_frames')).toBe(true);
  });

  it('applies a full permutation to the frame list', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(3)]]) });
    const result = await server.callTool('reorder_frames', {
      objectName: 'Hero', animationName: 'Animation 1', order: [2, 0, 1],
    });
    expect(parseResult(result).success).toBe(true);
    expect(writtenFrames(writer).map((frame: any) => frame.imageSpriteId)).toEqual([102, 100, 101]);
  });

  it('rejects a partial permutation', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(3)]]) });
    const result = await server.callTool('reorder_frames', {
      objectName: 'Hero', animationName: 'Animation 1', order: [1, 0],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('every frame exactly once');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a repeated frame index', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(3)]]) });
    const result = await server.callTool('reorder_frames', {
      objectName: 'Hero', animationName: 'Animation 1', order: [0, 1, 1],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('repeats frame index');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects an out-of-range frame index', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(3)]]) });
    const result = await server.callTool('reorder_frames', {
      objectName: 'Hero', animationName: 'Animation 1', order: [0, 1, 7],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('reports when no frame image files were found', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('reorder_frames', {
      objectName: 'Hero', animationName: 'Animation 1', order: [1, 0],
    });
    expect(parseResult(result).warnings[0]).toContain('No frame image files');
  });

  it('errors for an unknown animation and lists the available names', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('reorder_frames', {
      objectName: 'Hero', animationName: 'Nope', order: [1, 0],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Animation 1');
  });
});

describe('reverse_frames', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('reverse_frames')).toBe(true);
  });

  it('reverses the frame list', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(4)]]) });
    const result = await server.callTool('reverse_frames', { objectName: 'Hero', animationName: 'Animation 1' });
    expect(parseResult(result).success).toBe(true);
    expect(writtenFrames(writer).map((frame: any) => frame.imageSpriteId)).toEqual([103, 102, 101, 100]);
  });

  it('rejects a non-Sprite object', async () => {
    const { server } = setup({
      objects: new Map([['Label', { name: 'Label', 'plugin-id': 'Text', sid: 5, isGlobal: false, instanceVariables: [], behaviorTypes: [], effectTypes: [] }]]),
    });
    const result = await server.callTool('reverse_frames', { objectName: 'Label', animationName: 'Animation 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a Sprite');
  });
});

// ─── duplicate_frame ─────────────────────────────────────

describe('duplicate_frame', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('duplicate_frame')).toBe(true);
  });

  it('inserts a copy after the source frame with a fresh imageSpriteId', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('duplicate_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0,
    });
    expect(parseResult(result).success).toBe(true);
    const frames = writtenFrames(writer);
    expect(frames).toHaveLength(3);
    expect(frames[1].width).toBe(frames[0].width);
    expect(frames[1].imageSpriteId).not.toBe(frames[0].imageSpriteId);
    expect(frames[2].imageSpriteId).toBe(101);
  });

  it('honours insertAt', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(3)]]) });
    await server.callTool('duplicate_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 2, insertAt: 0,
    });
    const frames = writtenFrames(writer);
    expect(frames).toHaveLength(4);
    expect(frames.slice(1).map((frame: any) => frame.imageSpriteId)).toEqual([100, 101, 102]);
  });

  it('does not copy an imageSpriteId onto a frame that has none', async () => {
    const sprite = makeFramedSprite(1);
    delete (sprite.animations.items[0].frames[0] as any).imageSpriteId;
    const { server, writer } = setup({ objects: new Map([['Hero', sprite]]) });
    await server.callTool('duplicate_frame', { objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0 });
    const frames = writtenFrames(writer);
    expect(frames).toHaveLength(2);
    expect(frames[1].imageSpriteId).toBeUndefined();
  });

  it('rejects an out-of-range frameIndex', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('duplicate_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('out of range');
  });

  it('rejects an insertAt beyond the end of the animation', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(2)]]) });
    const result = await server.callTool('duplicate_frame', {
      objectName: 'Hero', animationName: 'Animation 1', frameIndex: 0, insertAt: 3,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insertAt 3 is out of range');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });
});

// ─── animation folders ───────────────────────────────────

describe('create_animation_folder', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('create_animation_folder')).toBe(true);
  });

  it('creates a nested animation folder', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('create_animation_folder', {
      objectName: 'Hero', folderPath: 'Combat/Melee',
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.subfolders[0].name).toBe('Combat');
    expect(written.animations.subfolders[0].subfolders[0]).toMatchObject({ name: 'Melee', items: [], subfolders: [] });
  });

  it('rejects a folder path that already exists', async () => {
    const sprite = makeFramedSprite(1);
    sprite.animations.subfolders.push({ items: [], subfolders: [], name: 'Combat' });
    const { server, writer } = setup({ objects: new Map([['Hero', sprite]]) });
    const result = await server.callTool('create_animation_folder', { objectName: 'Hero', folderPath: 'Combat' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a traversing folder path', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('create_animation_folder', { objectName: 'Hero', folderPath: '../escape' });
    expect(result.isError).toBe(true);
  });
});

describe('move_animation_to_folder', () => {
  it('registers the tool', () => {
    expect(setup().server.hasTool('move_animation_to_folder')).toBe(true);
  });

  it('moves an animation into an existing folder and back to the root', async () => {
    const sprite = makeFramedSprite(1);
    sprite.animations.subfolders.push({ items: [], subfolders: [], name: 'Combat' });
    const { server, writer } = setup({ objects: new Map([['Hero', sprite]]) });

    const moved = await server.callTool('move_animation_to_folder', {
      objectName: 'Hero', animationName: 'Animation 1', folderPath: 'Combat',
    });
    expect(parseResult(moved).success).toBe(true);
    const intoFolder = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(intoFolder.animations.items).toHaveLength(0);
    expect(intoFolder.animations.subfolders[0].items[0].name).toBe('Animation 1');

    const back = await server.callTool('move_animation_to_folder', {
      objectName: 'Hero', animationName: 'Animation 1', folderPath: null,
    });
    expect(parseResult(back).success).toBe(true);
  });

  it('rejects a destination folder that does not exist', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('move_animation_to_folder', {
      objectName: 'Hero', animationName: 'Animation 1', folderPath: 'Missing',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('create_animation_folder');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('rejects a move that would not change the folder', async () => {
    const { server } = setup({ objects: new Map([['Hero', makeFramedSprite(1)]]) });
    const result = await server.callTool('move_animation_to_folder', {
      objectName: 'Hero', animationName: 'Animation 1', folderPath: null,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already in the animations root');
  });

  it('finds an animation that already sits inside a folder', async () => {
    const sprite = makeFramedSprite(1);
    const nested = sprite.animations.items.splice(0, 1);
    sprite.animations.subfolders.push({ items: nested, subfolders: [], name: 'Combat' });
    const { server, writer } = setup({ objects: new Map([['Hero', sprite]]) });
    const result = await server.callTool('move_animation_to_folder', {
      objectName: 'Hero', animationName: 'Animation 1', folderPath: null,
    });
    expect(parseResult(result).success).toBe(true);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items[0].name).toBe('Animation 1');
    expect(written.animations.subfolders[0].items).toHaveLength(0);
  });
});
