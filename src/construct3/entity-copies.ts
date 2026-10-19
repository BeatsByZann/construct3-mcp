/**
 * Transforms for copying an entity: every SID in a copy is fresh (a number
 * under a `sid` key), a layout copy's instances get fresh UIDs, and the
 * hierarchy links inside the copy (`sceneGraphData.uid`, `parent-uid`,
 * `children[].uid`) and a template's replica list are mapped through the same
 * new UIDs. A copy that cannot be made faithful (a template name can exist
 * only once, a link leaves the copy) is found by the checks here.
 */

import { everyAnimation, expectedFrameImageName, frameImageBaseName, indexImageFiles } from './animation-rename.js';
import { nameKey } from './names.js';
import type { Construct3ProjectReader } from './project-reader.js';
import type { IdGenerator } from './id-generator.js';
import type { Instance } from './types.js';

type Json = Record<string, unknown>;

/** The part of the ID generator a copy uses. */
export type CopyIdGenerator = Pick<IdGenerator, 'generateSid' | 'generateUid'>;

/** A memoized SID remapper: one old SID always maps to the same fresh SID. */
export function sidRemapper(reader: Construct3ProjectReader, idGen: CopyIdGenerator) {
  const map = new Map<number, number>();
  return {
    map,
    /** The fresh SID for `old`, the same one every time. */
    async fresh(old: number): Promise<number> {
      let next = map.get(old);
      if (next === undefined) {
        next = await idGen.generateSid(reader);
        map.set(old, next);
      }
      return next;
    },
  };
}

/** Rewrite every numeric `sid` key under `value` through `fresh`; returns how many were rewritten. */
export async function remapAllSids(value: unknown, fresh: (old: number) => Promise<number>): Promise<number> {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node && typeof node === 'object') {
      const record = node as Json;
      for (const [key, child] of Object.entries(record)) {
        if (key === 'sid' && typeof child === 'number') {
          record.sid = await fresh(child);
          count++;
        } else if (child && typeof child === 'object') {
          stack.push(child);
        }
      }
    }
  }
  return count;
}

/** An instance that is a template: where it is and the name it declares. */
export interface TemplateInstance {
  uid: number;
  type: string;
  templateName: unknown;
}

/**
 * Instances that ARE a template (`template.mode: "template"`). Template names
 * are unique per object type, so a copy would declare the same template
 * twice. Replicas (`mode: "replica"`) only name their source template and
 * copy safely.
 */
export function templateInstances(instances: Instance[]): TemplateInstance[] {
  const out: TemplateInstance[] = [];
  for (const instance of instances) {
    const template = (instance as unknown as Json).template as Json | undefined;
    if (template && template.mode === 'template') {
      out.push({ uid: instance.uid, type: instance.type, templateName: template.templateName });
    }
  }
  return out;
}

/** Hierarchy links from the copied instances to instances outside the copy. */
export function hierarchyEscapes(instances: Instance[], uids: Set<number>): string[] {
  const out: string[] = [];
  for (const instance of instances) {
    const graph = instance.sceneGraphData as unknown as Json | undefined;
    if (!graph) continue;
    const parent = graph['parent-uid'];
    if (typeof parent === 'number' && !uids.has(parent)) {
      out.push(`uid ${instance.uid} (${instance.type}) has parent uid ${parent}`);
    }
    const children = Array.isArray(graph.children) ? graph.children as Json[] : [];
    for (const child of children) {
      if (typeof child?.uid === 'number' && !uids.has(child.uid)) {
        out.push(`uid ${instance.uid} (${instance.type}) has child uid ${child.uid}`);
      }
    }
  }
  return out;
}

/** Give every instance a fresh UID and rewrite the hierarchy links and replica lists through the same map. Returns old UID to new UID. */
export async function remapInstanceUids(
  instances: Instance[],
  reader: Construct3ProjectReader,
  idGen: CopyIdGenerator,
): Promise<Map<number, number>> {
  const uidMap = new Map<number, number>();
  for (const instance of instances) {
    if (typeof instance.uid !== 'number') continue;
    uidMap.set(instance.uid, await idGen.generateUid(reader));
  }
  const map = (value: unknown) => (typeof value === 'number' && uidMap.has(value) ? uidMap.get(value)! : value);
  for (const instance of instances) {
    instance.uid = map(instance.uid) as number;
    const graph = instance.sceneGraphData as unknown as Json | undefined;
    if (graph) {
      if ('uid' in graph) graph.uid = map(graph.uid);
      if ('parent-uid' in graph) graph['parent-uid'] = map(graph['parent-uid']);
      if (Array.isArray(graph.children)) {
        for (const child of graph.children as Json[]) {
          if (child && typeof child === 'object' && 'uid' in child) child.uid = map(child.uid);
        }
      }
    }
    const template = (instance as unknown as Json).template as Json | undefined;
    if (template && Array.isArray(template.replicasUIDs)) {
      template.replicasUIDs = (template.replicasUIDs as unknown[]).map(map);
    }
  }
  return uidMap;
}

/** The image files of an object type, copied under another object name. */
export interface ImageCopyPlan {
  /** File names in images/ */
  copies: Array<{ from: string; to: string }>;
  /** Expected names of frames that have no image file */
  missing: string[];
  /** Target names that exist already or are planned twice */
  clashes: string[];
}

/**
 * Plan the copies of an object type's image files for a copy of it named
 * `newName`: each frame's file, found as the frame tools find it (the
 * frame's fileType, letter case and normalisation ignored), gets the
 * lower-case name of the same frame of the copy; a single image
 * (`image` without animations) is `<name>.<ext>`. `files` lists images/.
 */
export function planImageCopies(files: readonly string[], objectName: string, objectType: unknown, newName: string): ImageCopyPlan {
  const index = indexImageFiles(files);
  const plan: ImageCopyPlan = { copies: [], missing: [], clashes: [] };
  const add = (oldBase: string, newBase: string, fileType: unknown) => {
    const sources = index.frameFiles(oldBase, fileType);
    if (sources.length === 0) {
      plan.missing.push(expectedFrameImageName(oldBase, fileType));
      return;
    }
    for (const from of sources) {
      const to = `${newBase}.${from.slice(from.lastIndexOf('.') + 1).toLowerCase()}`;
      if (index.named(to).length > 0 || plan.copies.some(c => nameKey(c.to) === nameKey(to))) plan.clashes.push(to);
      else plan.copies.push({ from, to });
    }
  };
  const record = typeof objectType === 'object' && objectType !== null ? objectType as Record<string, unknown> : {};
  if (record.animations !== undefined) {
    for (const anim of everyAnimation<{ name?: unknown; frames?: unknown }>(record.animations)) {
      if (typeof anim.name !== 'string' || !Array.isArray(anim.frames)) continue;
      anim.frames.forEach((frame, i) => {
        const fileType = typeof frame === 'object' && frame !== null ? (frame as { fileType?: unknown }).fileType : undefined;
        add(frameImageBaseName(objectName, anim.name as string, i), frameImageBaseName(newName, anim.name as string, i), fileType);
      });
    }
  } else if (typeof record.image === 'object' && record.image !== null) {
    add(objectName.toLowerCase(), newName.toLowerCase(), (record.image as { fileType?: unknown }).fileType);
  }
  return plan;
}
