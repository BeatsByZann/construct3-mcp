/**
 * Event-related helpers extracted from mutations.ts.
 * Contains Zod schemas, recursive builders, and validators
 * used by event tools (add_event_block, add_event_to_sheet).
 */

import { z } from 'zod';
import type { Construct3ProjectReader } from '../construct3/project-reader.js';
import type { IdGenerator } from '../construct3/id-generator.js';
import type { Condition, Action, BlockEvent } from '../construct3/types.js';
import { createBlockEvent } from '../construct3/templates.js';
import { boundedRecord } from './shared.js';

// ─── Zod Schemas ────────────────────────────────────────────

/** Condition schema shared by top-level and child events */
export const conditionSchema = z.object({
  id: z.string().describe('Condition ACE id (kebab-case, e.g., "on-start-of-layout", "on-collision-with-another-object")'),
  objectClass: z.string().describe('Object name or "System"'),
  behaviorType: z.string().optional().describe('Behavior type (e.g., "Platform", "8Direction")'),
  parameters: boundedRecord()
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Condition parameters as key-value pairs (max 100 keys, depth 6)'),
  isInverted: z.boolean().optional().describe('Negate the condition'),
  isOr: z.boolean().optional().describe('OR-combine with previous condition (default: AND)'),
});

/** Standard action schema */
export const standardActionSchema = z.object({
  id: z.string().describe('Action ACE id (kebab-case, e.g., "set-instvar-value", "destroy")'),
  objectClass: z.string().describe('Object name or "System"'),
  behaviorType: z.string().optional().describe('Behavior type'),
  parameters: boundedRecord()
    .refine(obj => JSON.stringify(obj).length <= 50_000, 'Parameters payload too large (max 50KB)')
    .optional().describe('Action parameters as key-value pairs (max 100 keys, depth 6)'),
  callFunction: z.string().optional().describe('For function call actions'),
  disabled: z.boolean().optional().describe('Disable this individual action'),
});

/** Script action schema — accepts a single string or an array of lines as input */
export const scriptActionSchema = z.object({
  type: z.literal('script').describe('Script action type'),
  script: z.union([z.string(), z.array(z.string())])
    .describe('Inline JavaScript code — a single string (split on newlines) or an array of lines'),
  disabled: z.boolean().optional().describe('Disable this individual script action'),
});

/**
 * Normalize script input to C3's on-disk serialization: an array of lines.
 * C3 stores script actions as { type: 'script', language: 'javascript',
 * script: [lines] } — the single-string form loads but the desktop editor
 * does not render the block.
 */
export function toScriptLines(script: string | string[]): string[] {
  return Array.isArray(script) ? script : script.split(/\r?\n/);
}

/** Build a condition and mint its globally unique SID. */
export async function buildCondition(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  input: z.infer<typeof conditionSchema>,
): Promise<Condition> {
  const sid = await idGen.generateSid(reader);
  const condition: Condition = {
    id: input.id,
    objectClass: input.objectClass,
    sid,
  };
  if (input.behaviorType) condition.behaviorType = input.behaviorType;
  if (input.parameters) condition.parameters = input.parameters;
  if (input.isInverted) condition.isInverted = true;
  if (input.isOr) condition.isOr = true;
  return condition;
}

/** Build an action and mint a SID for standard actions. Script actions have no SID in C3. */
export async function buildAction(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  input: z.infer<typeof actionSchema>,
): Promise<Action> {
  if ('type' in input && input.type === 'script') {
    const action: Action = {
      type: 'script',
      language: 'javascript',
      script: toScriptLines(input.script),
    };
    if (input.disabled) action.disabled = true;
    return action;
  }

  if (!('id' in input)) {
    throw new Error('Invalid action input: expected a standard action or script action.');
  }
  const sid = await idGen.generateSid(reader);
  const action: Action = {
    id: input.id,
    objectClass: input.objectClass,
    sid,
  };
  if (input.behaviorType) action.behaviorType = input.behaviorType;
  if (input.parameters) action.parameters = input.parameters;
  if (input.callFunction) action.callFunction = input.callFunction;
  if (input.disabled) action.disabled = true;
  return action;
}

/** Union of standard and script actions */
export const actionSchema = z.union([standardActionSchema, scriptActionSchema]);

// ─── Recursive Child Event Schema ───────────────────────────

export interface ChildEventInput {
  conditions?: Array<z.infer<typeof conditionSchema>>;
  actions?: Array<z.infer<typeof standardActionSchema> | z.infer<typeof scriptActionSchema>>;
  disabled?: boolean;
  isElse?: boolean;
  children?: ChildEventInput[];
}

export const childEventSchema: z.ZodType<ChildEventInput> = z.lazy(() => z.object({
  conditions: z.array(conditionSchema).optional().default([]),
  actions: z.array(actionSchema).optional().default([]),
  disabled: z.boolean().optional(),
  isElse: z.boolean().optional(),
  children: z.array(childEventSchema).optional().default([]),
}));

// ─── Safety Limits ──────────────────────────────────────────

export const MAX_NESTING_DEPTH = 5;
export const MAX_TOTAL_EVENTS = 50;
export const MAX_ITEMS_PER_BLOCK = 100;

// Limits for SID-search traversal (matching index-builder.ts)
export const MAX_SEARCH_NODES = 100_000;
export const MAX_SEARCH_DEPTH = 50;

// ─── SID-Based Event Finder ─────────────────────────────────

export interface FindResult {
  event: Record<string, unknown>;
  parentArray: Record<string, unknown>[];
  index: number;
  parentEvent?: Record<string, unknown>;
}

/**
 * Find an event by SID anywhere in the event tree.
 * Iterative stack-based traversal (no recursion) with safety guards.
 * Returns the event, its parent array, and index for safe splice operations.
 */
export function findEventBySid(
  events: Record<string, unknown>[],
  targetSid: number,
): FindResult | null {
  const stack: Array<{ events: Record<string, unknown>[]; depth: number; parentEvent?: Record<string, unknown> }> = [
    { events, depth: 0 },
  ];
  let nodeCount = 0;

  while (stack.length > 0) {
    if (++nodeCount > MAX_SEARCH_NODES) {
      throw new Error(`SID search exceeded ${MAX_SEARCH_NODES} nodes`);
    }
    const { events: currentEvents, depth, parentEvent } = stack.pop()!;
    if (depth > MAX_SEARCH_DEPTH) continue;

    for (let i = 0; i < currentEvents.length; i++) {
      const event = currentEvents[i];
      if (event.sid === targetSid) {
        return { event, parentArray: currentEvents, index: i, parentEvent };
      }
      // Recurse into children (groups, blocks, function-blocks)
      if (Array.isArray(event.children)) {
        stack.push({
          events: event.children as Record<string, unknown>[],
          depth: depth + 1,
          parentEvent: event,
        });
      }
    }
  }
  return null;
}

/**
 * Count all descendant events inside an event (groups, blocks with children).
 * Iterative to match safety pattern.
 */
export function countDescendants(event: Record<string, unknown>): number {
  let count = 0;
  const stack: Array<Record<string, unknown>[]> = [];
  if (Array.isArray(event.children)) {
    stack.push(event.children as Record<string, unknown>[]);
  }

  while (stack.length > 0) {
    const children = stack.pop()!;
    for (const child of children) {
      count++;
      if (Array.isArray(child.children)) {
        stack.push(child.children as Record<string, unknown>[]);
      }
    }
  }
  return count;
}

/**
 * Build a navigable summary of top-level events in a sheet (for error messages).
 * Truncated to maxItems to keep error messages manageable.
 */
export function summarizeEvents(
  events: Record<string, unknown>[],
  maxItems = 10,
): string {
  const lines: string[] = [];
  const total = events.length;

  for (let i = 0; i < Math.min(total, maxItems); i++) {
    const e = events[i];
    const type = e.eventType as string;
    switch (type) {
      case 'block': {
        const sid = e.sid as number;
        const conds = (e.conditions as unknown[] | undefined)?.length ?? 0;
        const acts = (e.actions as unknown[] | undefined)?.length ?? 0;
        lines.push(`  - block (SID ${sid}): ${conds} condition(s), ${acts} action(s)`);
        break;
      }
      case 'group': {
        const title = e.title as string;
        const sid = e.sid as number;
        const childCount = Array.isArray(e.children) ? (e.children as unknown[]).length : 0;
        lines.push(`  - group "${title}" (SID ${sid}): ${childCount} children`);
        break;
      }
      case 'function-block': {
        const name = e.functionName as string;
        const sid = e.sid as number;
        lines.push(`  - function "${name}" (SID ${sid})`);
        break;
      }
      case 'variable': {
        const name = e.name as string;
        const sid = e.sid as number;
        lines.push(`  - variable "${name}" (SID ${sid})`);
        break;
      }
      case 'include':
        lines.push(`  - include: "${e.includeSheet as string}"`);
        break;
      case 'comment':
        lines.push(`  - comment: "${(e.text as string).slice(0, 50)}"`);
        break;
      default:
        lines.push(`  - ${type}`);
    }
  }

  if (total > maxItems) {
    lines.push(`  ... (${total - maxItems} more)`);
  }

  return lines.join('\n');
}

// ─── Group Path Traversal ───────────────────────────────────

/** Traverse event tree to find a group by title path (e.g., "Movement > Collision").
 *  Two-pass: verify the full path resolves before mutating any data. */
export function findGroupByPath(
  events: Record<string, unknown>[],
  groupPath: string,
): Record<string, unknown>[] | null {
  const segments = groupPath.split('>').map(s => s.trim());

  // First pass: verify all segments resolve without mutating
  let current = events;
  const groups: Array<Record<string, unknown>> = [];
  for (const seg of segments) {
    const group = current.find(
      (e) => e.eventType === 'group' && e.title === seg,
    ) as Record<string, unknown> | undefined;
    if (!group) return null;
    groups.push(group);
    current = Array.isArray(group.children) ? group.children as Record<string, unknown>[] : [];
  }

  // Full path resolved — ensure all groups have children arrays
  for (const g of groups) {
    if (!Array.isArray(g.children)) g.children = [];
  }

  return groups[groups.length - 1].children as Record<string, unknown>[];
}

// ─── Object Class Validation ────────────────────────────────

/** Validate objectClass references against project objects, families, and "System". */
export async function validateObjectClasses(
  reader: Construct3ProjectReader,
  refs: Array<{ objectClass: string; behaviorType?: string }>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const objects = await reader.listObjectTypes();
  // listFamilies() reads from an in-memory Map and never throws — no try/catch needed.
  const families = await reader.listFamilies();
  const validClasses = new Set([...objects, ...families, 'System']);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const ref of refs) {
    if (!validClasses.has(ref.objectClass)) {
      const suggestions = reader.findNearestName(ref.objectClass, 'objects');
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : '';
      errors.push(`Unknown objectClass "${ref.objectClass}".${hint}`);
    }
    if (ref.behaviorType) {
      // Soft validate: warn but allow (behavior may come from families or third-party plugins)
      warnings.push(`BehaviorType "${ref.behaviorType}" on "${ref.objectClass}" was not validated — ensure it exists on the object or its families.`);
    }
  }

  return { errors, warnings };
}

// ─── Object Reference Collection ────────────────────────────

/** Collect all objectClass references from a block and all its descendants.
 *  Depth-limited to match buildBlockEvent's MAX_NESTING_DEPTH guard. */
export function collectObjectRefs(
  conditions: Array<{ objectClass: string; behaviorType?: string }>,
  actions: Array<Record<string, unknown>>,
  children: ChildEventInput[],
  refs: Array<{ objectClass: string; behaviorType?: string }>,
  depth = 0,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`collectObjectRefs nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
  }
  for (const c of conditions) {
    refs.push({ objectClass: c.objectClass, behaviorType: c.behaviorType });
  }
  for (const a of actions) {
    if ('objectClass' in a && typeof a.objectClass === 'string') {
      refs.push({ objectClass: a.objectClass, behaviorType: a['behaviorType'] as string | undefined });
    }
  }
  for (const child of children) {
    collectObjectRefs(
      child.conditions ?? [],
      (child.actions ?? []) as Array<Record<string, unknown>>,
      child.children ?? [],
      refs,
      depth + 1,
    );
  }
}

// ─── Recursive Block Builder ────────────────────────────────

/** Recursively build a block event with conditions, actions, and children.
 *  Returns the built block and increments the counter (for safety limit). */
export async function buildBlockEvent(
  reader: Construct3ProjectReader,
  idGen: IdGenerator,
  block: {
    conditions: Array<z.infer<typeof conditionSchema>>;
    actions: Array<z.infer<typeof standardActionSchema> | z.infer<typeof scriptActionSchema>>;
    disabled?: boolean;
    isElse?: boolean;
    children: ChildEventInput[];
  },
  depth: number,
  counter: { count: number; warnings: string[] },
): Promise<BlockEvent> {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Sub-event nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}`);
  }
  counter.count++;
  if (counter.count > MAX_TOTAL_EVENTS) {
    throw new Error(`Total event count exceeds maximum of ${MAX_TOTAL_EVENTS}`);
  }

  // Validate: non-else blocks must have at least one condition
  if (!block.isElse && block.conditions.length === 0) {
    throw new Error(`Non-else event block at depth ${depth} has no conditions. Add conditions or set isElse: true.`);
  }

  // Cap conditions and actions per block to prevent SID amplification
  if (block.conditions.length > MAX_ITEMS_PER_BLOCK) {
    throw new Error(`Block has ${block.conditions.length} conditions (max ${MAX_ITEMS_PER_BLOCK})`);
  }
  if (block.actions.length > MAX_ITEMS_PER_BLOCK) {
    throw new Error(`Block has ${block.actions.length} actions (max ${MAX_ITEMS_PER_BLOCK})`);
  }

  // Warn: isElse blocks with conditions (C3 ignores them)
  if (block.isElse && block.conditions.length > 0) {
    counter.warnings.push(`Else block at depth ${depth} has ${block.conditions.length} condition(s) — C3 ignores conditions on else blocks.`);
  }

  // Warn: isOr on the first condition is meaningless
  if (block.conditions.length > 0 && block.conditions[0].isOr) {
    counter.warnings.push(`First condition at depth ${depth} has isOr: true — this is ignored by C3 (no previous condition to OR with).`);
  }

  const blockSid = await idGen.generateSid(reader);

  // Build conditions with SIDs
  const builtConditions: Condition[] = [];
  for (const c of block.conditions) {
    builtConditions.push(await buildCondition(reader, idGen, c));
  }

  // Build actions with SIDs (or as script actions)
  const builtActions: Action[] = [];
  for (const a of block.actions) {
    builtActions.push(await buildAction(reader, idGen, a));
  }

  // Recursively build children
  const builtChildren: BlockEvent[] = [];
  for (const child of block.children) {
    const childBlock = await buildBlockEvent(
      reader,
      idGen,
      {
        conditions: child.conditions ?? [],
        actions: child.actions ?? [],
        disabled: child.disabled,
        isElse: child.isElse,
        children: child.children ?? [],
      },
      depth + 1,
      counter,
    );
    builtChildren.push(childBlock);
  }

  return createBlockEvent(
    blockSid,
    builtConditions,
    builtActions,
    block.disabled || undefined,
    builtChildren.length > 0 ? builtChildren : undefined,
    block.isElse || undefined,
  );
}

// ─── Container Resolution (shared by add_* and move_* tools) ─

/** Resolve a group path without creating missing children arrays. */
export function resolveGroupContainer(
  events: Record<string, unknown>[],
  groupPath: string,
): { owner: Record<string, unknown>; children: Record<string, unknown>[] } | null {
  const segments = groupPath.split('>').map(segment => segment.trim());
  let current = events;
  let owner: Record<string, unknown> | undefined;
  for (const segment of segments) {
    const group = current.find(event => event.eventType === 'group' && event.title === segment);
    if (!group) return null;
    owner = group;
    if (!Array.isArray(group.children)) {
      current = [];
    } else {
      current = group.children as Record<string, unknown>[];
    }
  }
  return owner ? {
    owner,
    children: Array.isArray(owner.children) ? owner.children as Record<string, unknown>[] : [],
  } : null;
}

/** Event types that can hold nested children in a C3 event sheet. */
export const CONTAINER_EVENT_TYPES = new Set(['group', 'block', 'function-block']);

export interface LocatorInput {
  groupPath?: string;
  parentSid?: number;
  siblingSid?: number;
  position: 'start' | 'end' | 'before' | 'after';
}

/**
 * Validate the locator/position combination shared by add_event_block,
 * add_event_to_sheet and move_event_block. Returns an error message, or null
 * when the combination is usable.
 */
export function validateLocator(locator: LocatorInput): string | null {
  const locatorCount = [locator.groupPath, locator.parentSid, locator.siblingSid]
    .filter(value => value !== undefined).length;
  if (locatorCount > 1) {
    return 'Specify at most one of: groupPath, parentSid, siblingSid.';
  }
  if (locator.siblingSid === undefined && (locator.position === 'before' || locator.position === 'after')) {
    return 'position before/after requires siblingSid.';
  }
  if (locator.siblingSid !== undefined && locator.position !== 'before' && locator.position !== 'after') {
    return 'siblingSid requires position before or after.';
  }
  if (locator.parentSid !== undefined && (locator.position === 'before' || locator.position === 'after')) {
    return 'parentSid requires position start or end.';
  }
  return null;
}

export interface ResolvedContainer {
  /** The array the event will be inserted into. */
  targetEvents: Record<string, unknown>[];
  /** The event that owns targetEvents, when the destination is nested. */
  owner?: Record<string, unknown>;
  /** The sibling event itself, for before/after insertion (index is read at insert time). */
  siblingEvent?: Record<string, unknown>;
}

/**
 * Resolve a locator to an insertion container. Purely read-only: a missing
 * children array is reported as an empty array and only committed to the owner
 * by commitContainer() once the caller has finished validating.
 */
export function resolveContainer(
  events: Record<string, unknown>[],
  sheetName: string,
  locator: LocatorInput,
): { container: ResolvedContainer } | { error: string } {
  if (locator.groupPath !== undefined) {
    const resolved = resolveGroupContainer(events, locator.groupPath);
    if (!resolved) {
      const topGroups = events
        .filter(e => e.eventType === 'group')
        .map(e => e.title as string);
      const hint = topGroups.length > 0
        ? `\nAvailable top-level groups: ${topGroups.join(', ')}`
        : '\nNo groups found in this event sheet.';
      return { error: `Group path "${locator.groupPath}" not found in "${sheetName}".${hint}` };
    }
    return { container: { targetEvents: resolved.children, owner: resolved.owner } };
  }

  if (locator.parentSid !== undefined) {
    const parent = findEventBySid(events, locator.parentSid);
    if (!parent) {
      return { error: `Parent event with SID ${locator.parentSid} not found in sheet "${sheetName}".` };
    }
    if (!CONTAINER_EVENT_TYPES.has(parent.event.eventType as string)) {
      return { error: `Event with SID ${locator.parentSid} is a "${parent.event.eventType}" and cannot contain sub-events.` };
    }
    return {
      container: {
        targetEvents: Array.isArray(parent.event.children)
          ? parent.event.children as Record<string, unknown>[]
          : [],
        owner: parent.event,
      },
    };
  }

  if (locator.siblingSid !== undefined) {
    const sibling = findEventBySid(events, locator.siblingSid);
    if (!sibling) {
      return { error: `Sibling event with SID ${locator.siblingSid} not found in sheet "${sheetName}".` };
    }
    return {
      container: {
        targetEvents: sibling.parentArray,
        siblingEvent: sibling.event,
      },
    };
  }

  return { container: { targetEvents: events } };
}

/**
 * Attach a deferred children array to its owner. Call only after every
 * validation has passed, so an invalid request leaves the tree untouched.
 */
export function commitContainer(container: ResolvedContainer): void {
  const owner = container.owner;
  if (owner && !Array.isArray(owner.children)) {
    owner.children = container.targetEvents;
  }
}

/**
 * Insert an event into a resolved container at the requested position.
 * The sibling index is read at insert time so callers that removed an event
 * from the same array beforehand still land in the right place.
 */
export function insertIntoContainer(
  container: ResolvedContainer,
  position: 'start' | 'end' | 'before' | 'after',
  event: Record<string, unknown>,
): void {
  const { targetEvents, siblingEvent } = container;
  if (siblingEvent && (position === 'before' || position === 'after')) {
    const index = targetEvents.indexOf(siblingEvent);
    // indexOf can only be -1 if the sibling left the array between resolution
    // and insertion; fall back to appending rather than splicing at -1.
    if (index === -1) {
      targetEvents.push(event);
    } else {
      targetEvents.splice(position === 'before' ? index : index + 1, 0, event);
    }
    return;
  }
  if (position === 'start') {
    targetEvents.unshift(event);
  } else {
    targetEvents.push(event);
  }
}

// ─── Subtree Identity Helpers ───────────────────────────────

export interface SubtreeIdentity {
  /** The event itself plus every descendant event, by object identity. */
  events: Set<Record<string, unknown>>;
  /** Every children array inside the subtree, by object identity. */
  childArrays: Set<Record<string, unknown>[]>;
}

/**
 * Collect object identities for an event and everything below it. Used to
 * refuse a move that would place an event inside its own subtree, which would
 * detach the branch from the sheet.
 */
export function collectSubtree(event: Record<string, unknown>): SubtreeIdentity {
  const events = new Set<Record<string, unknown>>([event]);
  const childArrays = new Set<Record<string, unknown>[]>();
  const stack: Record<string, unknown>[] = [event];
  let nodeCount = 0;

  while (stack.length > 0) {
    if (++nodeCount > MAX_SEARCH_NODES) {
      throw new Error(`Subtree scan exceeded ${MAX_SEARCH_NODES} nodes`);
    }
    const current = stack.pop()!;
    if (!Array.isArray(current.children)) continue;
    const children = current.children as Record<string, unknown>[];
    childArrays.add(children);
    for (const child of children) {
      events.add(child);
      stack.push(child);
    }
  }

  return { events, childArrays };
}
