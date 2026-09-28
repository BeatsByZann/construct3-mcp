import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerAnimationTools } from '../../src/tools/animation-tools.js';
import { EntityWriteError } from '../../src/construct3/project-writer.js';

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

  it('refuses a name that differs from an existing animation only in case, before writing images', async () => {
    const { server, writer } = setup({
      objects: new Map([['Hero', makeSpriteObj()]]),
    });
    for (const animationName of ['animation 1', 'ANIMATION 1']) {
      const result = await server.callTool('add_animation_to_sprite', { objectName: 'Hero', animationName });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('the existing animation "Animation 1" on "Hero"');
      expect(result.content[0].text).toContain('only in case');
      expect(result.content[0].text).toContain('images/hero-animation 1-000.png');
    }
    expect(writer.callsFor('writeImageFiles')).toHaveLength(0);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
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

  it('refuses a name that differs from another animation only in case, but allows recasing its own', async () => {
    const twoAnims = () => ({
      ...makeSpriteObj(),
      animations: {
        items: [
          { name: 'Idle', sid: 10, frames: [], isLooping: false, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 0 },
          { name: 'Walk', sid: 11, frames: [], isLooping: true, isPingPong: false, repeatCount: 1, repeatTo: 0, speed: 5 },
        ],
        subfolders: [],
      },
    });
    const clash = setup({ objects: new Map([['Hero', twoAnims()]]) });
    const refused = await clash.server.callTool('rename_animation', {
      objectName: 'Hero', animationName: 'Idle', newName: 'WALK',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('the existing animation "Walk" on "Hero"');
    expect(refused.content[0].text).toContain('only in case');
    expect(clash.writer.callsFor('writeEntityFile')).toHaveLength(0);

    const recase = setup({ objects: new Map([['Hero', twoAnims()]]) });
    const renamed = await recase.server.callTool('rename_animation', {
      objectName: 'Hero', animationName: 'Walk', newName: 'WALK',
    });
    expect(parseResult(renamed).success).toBe(true);
    const written = recase.writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items.map((a: { name: string }) => a.name)).toEqual(['Idle', 'WALK']);
  });

  function walkSprite() {
    const obj = makeSpriteObj();
    obj.animations.items[0] = {
      ...obj.animations.items[0],
      name: 'Walk',
      frames: [
        { width: 100, height: 100, originX: 0.5, originY: 0.5, fileType: 'image/png', imageSpriteId: 1000001 },
        { width: 100, height: 100, originX: 0.5, originY: 0.5, fileType: 'image/jpeg', imageSpriteId: 1000002 },
        { width: 100, height: 100, originX: 0.5, originY: 0.5, fileType: 'image/png', imageSpriteId: 1000003 },
      ],
    } as any;
    return obj;
  }

  const instance = (type: string, animation: string, uid: number) => ({
    type, uid, properties: { 'initial-animation': animation, 'initial-frame': 0 }, behaviors: {}, instanceVariables: {},
  });

  it('renames the frame image files and keeps frames and imageSpriteIds', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', walkSprite()]]) });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png', 'hero-idle-000.png'];
    const data = parseResult(await server.callTool('rename_animation', {
      objectName: 'Hero', animationName: 'Walk', newName: 'Run Fast',
    }));
    expect(data.success).toBe(true);
    expect(writer.callsFor('renameImageFiles')[0].args[0]).toEqual([
      { from: 'hero-walk-000.png', to: 'hero-run fast-000.png' },
      { from: 'hero-walk-001.jpg', to: 'hero-run fast-001.jpg' },
      { from: 'hero-walk-002.png', to: 'hero-run fast-002.png' },
    ]);
    const written = writer.callsFor('writeEntityFile')[0].args[2] as any;
    expect(written.animations.items[0].name).toBe('Run Fast');
    expect(written.animations.items[0].frames.map((f: { imageSpriteId: number }) => f.imageSpriteId)).toEqual([1000001, 1000002, 1000003]);
    expect(data.warnings).toContain('Renamed 3 frame image file(s) in images/ ("hero-walk-000.png" → "hero-run fast-000.png", …).');
    // Image files are renamed before the JSON is written
    const order = writer.calls.map(c => c.method).filter(m => m === 'renameImageFiles' || m === 'writeEntityFile');
    expect(order).toEqual(['renameImageFiles', 'writeEntityFile']);
  });

  it('refuses when a renamed image file would replace an existing file, and changes nothing', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', walkSprite()]]) });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png', 'hero-run-001.jpg'];
    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"images/hero-run-001.jpg", which already exist(s). Nothing was changed.');
    expect(writer.callsFor('renameImageFiles')).toHaveLength(0);
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
  });

  it('refuses a name with a path separator or a character Windows does not allow in file names', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', walkSprite()]]) });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png'];
    for (const char of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: `Run${char}Fast` });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`The animation name "Run${char}Fast" contains "${char}".`);
      expect(result.content[0].text).toContain('a file name cannot contain a path separator');
    }
    const control = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run\tFast' });
    expect(control.content[0].text).toContain('contains control character U+0009');
    expect(writer.calls).toHaveLength(0);
  });

  it('refuses an objectName that differs from the object\'s name in case, and changes nothing', async () => {
    // On Windows and macOS the object file is found under the other spelling
    const level = { name: 'Level', layers: [{ name: 'Main', instances: [instance('Hero', 'Walk', 1)] }] };
    const { server, writer } = setup({
      objects: new Map([['hero', walkSprite()]]),
      layouts: new Map<string, Record<string, unknown>>([['Level', level]]),
    });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png'];
    const result = await server.callTool('rename_animation', { objectName: 'hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Object "hero" is named "Hero" in the project. Object names are case-sensitive: use objectName "Hero". Nothing was changed.');
    expect(writer.calls).toHaveLength(0);
    expect(level.layers[0].instances[0].properties['initial-animation']).toBe('Walk');
  });

  it('refuses when another animation differs from the old name only in case and so uses the same image files', async () => {
    const obj = walkSprite();
    const legacy = { ...obj.animations.items[0], name: 'walk', sid: 11 };
    (obj.animations as { subfolders: unknown[] }).subfolders = [{ name: 'Old', items: [legacy], subfolders: [] }];
    const { server, writer } = setup({ objects: new Map([['Hero', obj]]) });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png'];
    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot rename "Walk" on "Hero": animation "walk" differs from it only in case, '
      + 'so both use the same frame image files (images/hero-walk-000.png, …)');
    expect(result.content[0].text).toContain('Nothing was changed.');
    expect(writer.calls.filter(c => c.method !== 'listImageFiles')).toHaveLength(0);

    // Without frames, the other animation uses no image files
    const noFrames = walkSprite();
    noFrames.animations.items.push({ ...noFrames.animations.items[0], name: 'WALK', sid: 12, frames: [] });
    const ok = setup({ objects: new Map([['Hero', noFrames]]) });
    ok.writer.imageFiles = ['hero-walk-000.png'];
    expect(parseResult(await ok.server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' })).success).toBe(true);
  });

  it('warns about frames without an image file and still renames', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', walkSprite()]]) });
    writer.imageFiles = ['hero-walk-000.png'];
    const data = parseResult(await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' }));
    expect(data.success).toBe(true);
    expect(data.warnings.join('\n')).toContain('No image file in images/ for 2 frame(s) of "Walk" (expected "hero-walk-001.jpg", "hero-walk-002.png")');
    expect(writer.callsFor('renameImageFiles')[0].args[0]).toEqual([{ from: 'hero-walk-000.png', to: 'hero-run-000.png' }]);
  });

  it('sets initial-animation of the object\'s layout instances that start with the old animation', async () => {
    const level = {
      name: 'Level',
      layers: [{
        name: 'Main',
        instances: [instance('Hero', 'Walk', 1), instance('Hero', 'Idle', 2), instance('Enemy', 'Walk', 3)],
        subLayers: [{ name: 'Front', instances: [instance('Hero', 'Walk', 4)], subLayers: [] }],
      }],
    };
    const other = { name: 'Level 2', layers: [{ name: 'Main', instances: [instance('Enemy', 'Walk', 5)] }] };
    const { server, writer } = setup({
      objects: new Map([['Hero', walkSprite()]]),
      layouts: new Map<string, Record<string, unknown>>([['Level', level], ['Level 2', other]]),
    });
    const data = parseResult(await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' }));
    expect(data.success).toBe(true);

    const layoutWrites = writer.callsFor('writeEntityFile').filter(c => c.args[0] === 'layouts');
    expect(layoutWrites.map(c => c.args[1])).toEqual(['Level']);
    const written = layoutWrites[0].args[2] as typeof level;
    expect(written.layers[0].instances.map(i => i.properties['initial-animation'])).toEqual(['Run', 'Idle', 'Walk']);
    expect(written.layers[0].subLayers[0].instances[0].properties['initial-animation']).toBe('Run');
    expect(data.warnings).toContain('Set "initial-animation" to "Run" on 2 instance(s) of "Hero" in layout(s): Level.');
  });

  it('warns about event sheet strings that still name the old animation', async () => {
    const sheet = {
      name: 'Game',
      events: [{
        eventType: 'block',
        conditions: [{ id: 'is-animation-playing', objectClass: 'Hero', parameters: { animation: '"Walk"' } }],
        actions: [{ id: 'set-animation', objectClass: 'Hero', parameters: { animation: '"Walk"', from: 'beginning' } }],
      }],
    };
    const { server, writer } = setup({
      objects: new Map([['Hero', walkSprite()]]),
      eventSheets: new Map([['Game', sheet]]),
    });
    const data = parseResult(await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' }));
    expect(data.warnings.join('\n')).toContain('2 condition/action parameter(s) of "Hero" still name "Walk" as a string, in event sheet(s): Game.');
    expect(writer.callsFor('writeEntityFile').map(c => c.args[0])).toEqual(['objectTypes']);
  });

  it('rolls back the object and the image files when a layout write fails', async () => {
    const level = { name: 'Level', layers: [{ name: 'Main', instances: [instance('Hero', 'Walk', 1)] }] };
    const { server, writer } = setup({
      objects: new Map([['Hero', walkSprite()]]),
      layouts: new Map<string, Record<string, unknown>>([['Level', level]]),
    });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png'];
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category: string, name: string, data: unknown, subfolder?: string) => {
      if (category === 'layouts') throw new Error('disk full');
      return write(category, name, data, subfolder);
    };

    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk full. The rename was rolled back');
    expect(writer.callsFor('restoreEntityFile').map(c => c.args[0])).toEqual(['/mock/backup/objectTypes/Hero.json.bak']);
    const [forward, back] = writer.callsFor('renameImageFiles').map(c => c.args[0]);
    expect(back).toEqual((forward as Array<{ from: string; to: string }>).map(r => ({ from: r.to, to: r.from })));
    expect(back).toHaveLength(3);
  });

  it('renames the image files back when the object write fails', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', walkSprite()]]) });
    writer.imageFiles = ['hero-walk-000.png'];
    writer.writeEntityFile = async () => { throw new Error('verification failed'); };

    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('verification failed. The rename was rolled back');
    expect(writer.callsFor('restoreEntityFile')).toHaveLength(0);
    expect(writer.callsFor('renameImageFiles').map(c => c.args[0])).toEqual([
      [{ from: 'hero-walk-000.png', to: 'hero-run-000.png' }],
      [{ from: 'hero-run-000.png', to: 'hero-walk-000.png' }],
    ]);
  });

  it('restores the object file too when its write failed after replacing it', async () => {
    const { server, writer } = setup({ objects: new Map([['Hero', walkSprite()]]) });
    writer.imageFiles = ['hero-walk-000.png'];
    writer.writeEntityFile = async () => {
      throw new EntityWriteError(new Error('Post-write verification failed for "Hero"'), '/mock/backup/objectTypes/Hero.json.bak');
    };

    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Post-write verification failed for "Hero". The rename was rolled back');
    expect(writer.callsFor('restoreEntityFile').map(c => c.args[0])).toEqual(['/mock/backup/objectTypes/Hero.json.bak']);
    expect(writer.callsFor('renameImageFiles').map(c => c.args[0])).toEqual([
      [{ from: 'hero-walk-000.png', to: 'hero-run-000.png' }],
      [{ from: 'hero-run-000.png', to: 'hero-walk-000.png' }],
    ]);
  });

  it('writes no JSON when renaming the image files fails', async () => {
    const level = { name: 'Level', layers: [{ name: 'Main', instances: [instance('Hero', 'Walk', 1)] }] };
    const { server, writer } = setup({
      objects: new Map([['Hero', walkSprite()]]),
      layouts: new Map<string, Record<string, unknown>>([['Level', level]]),
    });
    writer.imageFiles = ['hero-walk-000.png', 'hero-walk-001.jpg', 'hero-walk-002.png'];
    writer.renameImageFiles = async () => {
      throw new Error('Renaming image files failed: EBUSY. The files renamed before were renamed back.');
    };

    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Renaming image files failed: EBUSY. The files renamed before were renamed back.');
    expect(writer.callsFor('writeEntityFile')).toHaveLength(0);
    expect(writer.callsFor('restoreEntityFile')).toHaveLength(0);
  });

  it('names what could not be rolled back when the rollback fails', async () => {
    const level = { name: 'Level', layers: [{ name: 'Main', instances: [instance('Hero', 'Walk', 1)] }] };
    const { server, writer } = setup({
      objects: new Map([['Hero', walkSprite()]]),
      layouts: new Map<string, Record<string, unknown>>([['Level', level]]),
    });
    writer.imageFiles = ['hero-walk-000.png'];
    const write = writer.writeEntityFile.bind(writer);
    writer.writeEntityFile = async (category: string, name: string, data: unknown, subfolder?: string) => {
      if (category === 'layouts') throw new Error('disk full');
      return write(category, name, data, subfolder);
    };
    writer.restoreEntityFile = async () => { throw new Error('EPERM'); };
    let renameCalls = 0;
    writer.renameImageFiles = async () => {
      if (++renameCalls === 2) throw new Error('EBUSY');
    };

    const result = await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' });
    expect(result.isError).toBe(true);
    // Client-visible errors carry no absolute paths, so the file is named by its project-relative path
    expect(result.content[0].text).toContain('disk full. Rolling back the rename failed for: objectTypes/Hero.json; image files (EBUSY).');
  });

  it('counts the event sheet strings on the object\'s families too', async () => {
    const sheet = {
      name: 'Game',
      events: [{
        eventType: 'block',
        conditions: [{ id: 'is-animation-playing', objectClass: 'Characters', parameters: { animation: '"Walk"' } }],
        actions: [
          { id: 'set-animation', objectClass: 'Hero', parameters: { animation: '"Walk"', from: 'beginning' } },
          { id: 'set-animation', objectClass: 'Props', parameters: { animation: '"Walk"', from: 'beginning' } },
        ],
      }],
    };
    const { server } = setup({
      objects: new Map([['Hero', walkSprite()]]),
      eventSheets: new Map([['Game', sheet]]),
      families: new Map<string, Record<string, unknown>>([
        ['Characters', { name: 'Characters', members: ['Hero'] }],
        ['Props', { name: 'Props', members: ['Crate'] }],
      ]),
    });
    const data = parseResult(await server.callTool('rename_animation', { objectName: 'Hero', animationName: 'Walk', newName: 'Run' }));
    expect(data.warnings.join('\n')).toContain('2 condition/action parameter(s) of "Hero" and its families ("Characters") still name "Walk" as a string, in event sheet(s): Game.');
    expect(data.warnings.join('\n')).toContain('Parameters that compute an animation name are not counted.');
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

// ─── Animation names in image file names ─────────────────

describe('animation names that cannot be part of an image file name', () => {
  it('add_animation_to_sprite refuses them and writes nothing', async () => {
    for (const animationName of ['Walk/Left', 'Walk\\Left', 'Walk:Left', 'Walk?']) {
      const { server, writer } = setup({ objects: new Map([['Hero', makeSpriteObj()]]) });
      const result = await server.callTool('add_animation_to_sprite', { objectName: 'Hero', animationName });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`The animation name "${animationName}" contains`);
      expect(result.content[0].text).toContain('Choose another name.');
      expect(writer.calls).toHaveLength(0);
    }
  });

  it('add_frame_to_animation and replace_sprite_image refuse an existing animation with such a name', async () => {
    const obj = makeSpriteObj();
    obj.animations.items[0] = {
      ...obj.animations.items[0],
      name: 'Walk/Left',
      frames: [{ width: 100, height: 100, originX: 0.5, originY: 0.5, imageSpriteId: 1 }],
    } as any;
    const { server, writer } = setup({ objects: new Map([['Hero', obj]]) });

    const added = await server.callTool('add_frame_to_animation', { objectName: 'Hero', animationName: 'Walk/Left' });
    expect(added.isError).toBe(true);
    expect(added.content[0].text).toContain('Animation "Walk/Left" contains "/".');
    expect(added.content[0].text).toContain('Rename the animation first (rename_animation). Nothing was changed.');

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const replaced = await server.callTool('replace_sprite_image', {
      objectName: 'Hero', animationName: 'Walk/Left', frameIndex: 0, pngBase64: png,
    });
    expect(replaced.isError).toBe(true);
    expect(replaced.content[0].text).toContain('Animation "Walk/Left" contains "/".');
    expect(writer.calls).toHaveLength(0);
  });
});
