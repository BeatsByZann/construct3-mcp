import { describe, it, expect } from 'vitest';
import { MockServer } from '../mocks/mock-server.js';
import { MockReader } from '../mocks/mock-reader.js';
import { MockWriter } from '../mocks/mock-writer.js';
import { MockIdGenerator } from '../mocks/mock-id-generator.js';
import { registerTimelineTools } from '../../src/tools/timeline-tools.js';

function setup(readerData: Record<string, unknown> = {}) {
  const server = new MockServer();
  const reader = new MockReader(readerData);
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerTimelineTools({ server, reader, writer, idGen } as any);
  return { server, reader, writer, idGen };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

// ─── list_timelines ───────────────────────────────────────

describe('list_timelines', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('list_timelines')).toBe(true);
  });

  it('returns empty list when no timelines', async () => {
    const { server } = setup();
    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.timelines).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('lists timelines from project root', async () => {
    // Override getProject to return timelines
    const server = new MockServer();
    const reader = new MockReader();
    // Patch getProject to include timelines
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1', 'reelStop'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.count).toBe(2);
    expect(data.timelines).toContain('Timeline 1');
    expect(data.timelines).toContain('reelStop');
  });

  it('lists timelines from subfolders too', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: {
        items: ['Timeline 1'],
        subfolders: [{ name: 'transitions', items: ['inback', 'reelStop'], subfolders: [] }],
      },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('list_timelines', {});
    const data = parseResult(result);
    expect(data.count).toBe(3);
    expect(data.timelines).toContain('inback');
  });
});

// ─── get_timeline_details ─────────────────────────────────

describe('get_timeline_details', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('get_timeline_details')).toBe(true);
  });

  it('errors when timeline not in project', async () => {
    const { server } = setup();
    const result = await server.callTool('get_timeline_details', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── create_timeline ──────────────────────────────────────

describe('create_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('create_timeline')).toBe(true);
  });

  it('rejects duplicate timeline name', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('create_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });
});

// ─── update_timeline ──────────────────────────────────────

describe('update_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('update_timeline')).toBe(true);
  });

  it('errors with no updates', async () => {
    const server = new MockServer();
    const reader = new MockReader();
    const origGetProject = reader.getProject.bind(reader);
    (reader as any).getProject = () => ({
      ...origGetProject(),
      timelines: { items: ['Timeline 1'], subfolders: [] },
    });
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    registerTimelineTools({ server, reader, writer, idGen } as any);

    const result = await server.callTool('update_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
  });

  it('errors when timeline not found', async () => {
    const { server } = setup();
    const result = await server.callTool('update_timeline', {
      name: 'Ghost',
      totalTime: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── delete_timeline ──────────────────────────────────────

describe('delete_timeline', () => {
  it('registers the tool', () => {
    const { server } = setup();
    expect(server.hasTool('delete_timeline')).toBe(true);
  });

  it('errors when timeline not found', async () => {
    const { server } = setup();
    const result = await server.callTool('delete_timeline', { name: 'Ghost' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"Ghost" not found');
  });
});

// ─── track and keyframe tools ─────────────────────────────
//
// These pin the guards that fire before any file I/O. The on-disk outcome,
// the r495.2 track shape and the value/aValue rule are proved in
// timeline-tools.integration.test.ts against a real project directory.

const TRACK_TOOLS = [
  'add_timeline_track',
  'remove_timeline_track',
  'add_property_track',
  'remove_property_track',
  'set_keyframe',
  'delete_keyframe',
  'update_track',
];

/** A reader whose project registers `Timeline 1` but has no timeline file. */
function setupRegistered() {
  const server = new MockServer();
  const reader = new MockReader();
  const origGetProject = reader.getProject.bind(reader);
  (reader as any).getProject = () => ({
    ...origGetProject(),
    timelines: { items: ['Timeline 1'], subfolders: [] },
  });
  const writer = new MockWriter();
  const idGen = new MockIdGenerator();
  registerTimelineTools({ server, reader, writer, idGen } as any);
  return { server, reader };
}

/** Minimal valid arguments for each track tool, addressing "Timeline 1". */
const TRACK_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  add_timeline_track: { timelineName: 'Timeline 1', layoutName: 'Layout 1', instanceUid: 0 },
  remove_timeline_track: { timelineName: 'Timeline 1', instanceUid: 0 },
  add_property_track: { timelineName: 'Timeline 1', instanceUid: 0, property: 'offsetX' },
  remove_property_track: { timelineName: 'Timeline 1', instanceUid: 0, property: 'offsetX' },
  set_keyframe: { timelineName: 'Timeline 1', instanceUid: 0, time: 0 },
  delete_keyframe: { timelineName: 'Timeline 1', instanceUid: 0, time: 0 },
  update_track: { timelineName: 'Timeline 1', instanceUid: 0, enabled: false },
};

describe('track and keyframe tools', () => {
  it('registers every track tool', () => {
    const { server } = setup();
    for (const name of TRACK_TOOLS) {
      expect(server.hasTool(name), name).toBe(true);
    }
  });

  it('errors when the timeline is not in the project', async () => {
    const { server } = setup();
    for (const name of TRACK_TOOLS) {
      const result = await server.callTool(name, { ...TRACK_TOOL_ARGS[name], timelineName: 'Ghost' });
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toContain('"Ghost" not found');
    }
  });

  it('errors when the timeline is registered but its file cannot be read', async () => {
    const { server } = setupRegistered();
    for (const name of TRACK_TOOLS) {
      const result = await server.callTool(name, TRACK_TOOL_ARGS[name]);
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toContain('could not be read');
    }
  });

  it('update_track errors with no updates, before touching the file', async () => {
    const { server } = setupRegistered();
    const result = await server.callTool('update_track', {
      timelineName: 'Timeline 1',
      instanceUid: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No updates');
    expect(result.content[0].text).toContain('initialVisibility');
  });
});

// ─── update_timeline playback fields ──────────────────────

describe('update_timeline playback fields', () => {
  it('counts each new field as an update', async () => {
    const fields: Array<Record<string, unknown>> = [
      { ease: 'noease' },
      { interpolationMode: 'default' },
      { resultMode: 'default' },
      { pathMode: 'line' },
      { transformWithSceneGraph: false },
    ];
    for (const field of fields) {
      const { server } = setupRegistered();
      const result = await server.callTool('update_timeline', { name: 'Timeline 1', ...field });
      const label = Object.keys(field)[0];
      expect(result.isError, label).toBe(true);
      // Past the "no updates" guard: it fails on the missing file instead.
      expect(result.content[0].text, label).not.toContain('No updates');
      expect(result.content[0].text, label).toContain('could not be read');
    }
  });

  it('lists the new fields in the no-updates error', async () => {
    const { server } = setupRegistered();
    const result = await server.callTool('update_timeline', { name: 'Timeline 1' });
    expect(result.isError).toBe(true);
    for (const field of ['ease', 'interpolationMode', 'resultMode', 'pathMode', 'transformWithSceneGraph']) {
      expect(result.content[0].text, field).toContain(field);
    }
  });
});
