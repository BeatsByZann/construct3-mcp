/**
 * Custom actions: definitions (event type "custom-ace-block", on an object
 * type or a family, named by aceName) and the calls that run them
 * ({ customAction, objectClass, customActionObjectClass?, ... }). A call on
 * an object type runs that object's own custom action of the name, else its
 * family's; customActionObjectClass names the family whose original runs
 * when the object overrides it (the editor's label "Name (Family)", manual:
 * Custom actions). Names of definitions are compared ignoring case for
 * clashes, as the other event names are; a call finds its definition ignoring
 * case too (Construct 3 r506-2 (Free edition) ran a call whose name differed from its
 * definition only in letter case, and saved it with the definition's spelling).
 */

import { nameKey } from './names.js';

/** A custom action block in an event sheet. */
export interface CustomActionDefinition {
  owner: string;
  name: string;
  sheet: string;
  /** JSON path of the block, e.g. "events[2].children[0]" */
  eventPath: string;
  sid?: number;
  /** Parameter names in order */
  parameters: string[];
}

const MAX_DEPTH = 50;
const MAX_NODES = 100_000;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every custom action block in `sheets` (sheet name to events), in sheet and
 * document order, and whether the scan saw every event: false when it
 * stopped at its depth or node limit, so a definition past it is unknown.
 */
export function customActionScan(sheets: ReadonlyMap<string, unknown>): { definitions: CustomActionDefinition[]; complete: boolean } {
  const found: CustomActionDefinition[] = [];
  let complete = true;
  let nodes = 0;
  for (const [sheet, events] of sheets) {
    if (!Array.isArray(events)) continue;
    const stack: Array<{ list: unknown[]; path: string; depth: number }> = [{ list: events, path: 'events', depth: 0 }];
    while (stack.length > 0) {
      const { list, path, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) {
        complete = false;
        continue;
      }
      list.forEach((ev, i) => {
        if (!isRecord(ev)) return;
        if (++nodes > MAX_NODES) {
          complete = false;
          return;
        }
        const eventPath = `${path}[${i}]`;
        if (ev.eventType === 'custom-ace-block' && typeof ev.aceName === 'string' && typeof ev.objectClass === 'string') {
          const params = Array.isArray(ev.functionParameters) ? ev.functionParameters : [];
          found.push({
            owner: ev.objectClass, name: ev.aceName, sheet, eventPath,
            ...(typeof ev.sid === 'number' ? { sid: ev.sid } : {}),
            parameters: params.filter(isRecord).map(p => String(p.name)),
          });
        }
        if (Array.isArray(ev.children)) stack.push({ list: ev.children, path: `${eventPath}.children`, depth: depth + 1 });
      });
    }
  }
  return { definitions: found, complete };
}

/** The definitions customActionScan finds, for a lookup that only warns (a protective check uses customActionScan and its `complete`). */
export function customActionDefinitions(sheets: ReadonlyMap<string, unknown>): CustomActionDefinition[] {
  return customActionScan(sheets).definitions;
}

/** The definitions on `owner` whose name equals `name` ignoring case. */
export function customActionDefinitionClashes(definitions: readonly CustomActionDefinition[], owner: string, name: string): CustomActionDefinition[] {
  return definitions.filter(d => d.owner === owner && nameKey(d.name) === nameKey(name));
}

/** Groups of definitions sharing an owner and a name (ignoring case) that have more members in `after` than in `before`. */
export function newCustomActionDuplicates(
  before: readonly CustomActionDefinition[],
  after: readonly CustomActionDefinition[],
): CustomActionDefinition[][] {
  const key = (d: CustomActionDefinition) => `${d.owner}\u0000${nameKey(d.name)}`;
  const countBefore = new Map<string, number>();
  for (const d of before) countBefore.set(key(d), (countBefore.get(key(d)) ?? 0) + 1);
  const groups = new Map<string, CustomActionDefinition[]>();
  for (const d of after) groups.set(key(d), [...(groups.get(key(d)) ?? []), d]);
  return [...groups.entries()].filter(([k, g]) => g.length > 1 && g.length > (countBefore.get(k) ?? 0)).map(([, g]) => g);
}

/**
 * Why `objectClass` cannot own or be called with a custom action, or
 * undefined: it must be an object type or family of the project, with its
 * letter case (System and the Functions object own none).
 */
export function customActionOwnerError(objectClass: string, objectTypes: readonly string[], families: readonly string[]): string | undefined {
  if (objectTypes.includes(objectClass) || families.includes(objectClass)) return undefined;
  const sameIgnoringCase = [...objectTypes, ...families].find(n => n.toLowerCase() === objectClass.toLowerCase());
  return sameIgnoringCase !== undefined
    ? `Unknown objectClass "${objectClass}": object type and family names are matched with their letter case. Did you mean "${sameIgnoringCase}"?`
    : `Unknown objectClass "${objectClass}". A custom action belongs to an object type or family (not System or the Functions object).`;
}

/**
 * The definition a call runs: on customActionObjectClass when the call names
 * one, else on its objectClass, else on a family the objectClass belongs to
 * (the first such family, in the order the families are read, that defines the name).
 * `familiesOf` is upstream's familiesContaining over the project's
 * families. The name is matched ignoring letter case: Construct 3 r506-2 (Free
 * edition) ran a call whose name differed from its definition only in letter
 * case. On one owner a definition with the call's exact spelling wins over one
 * that differs in case; an owner earlier in the order above wins over a later
 * one whatever the spelling. Undefined when none.
 */
export function resolveCustomActionCall(
  call: { customAction: string; objectClass: string; customActionObjectClass?: string },
  definitions: readonly CustomActionDefinition[],
  familiesOf: (objectClass: string) => readonly string[],
): CustomActionDefinition | undefined {
  const on = (owner: string) => definitions.find(d => d.owner === owner && d.name === call.customAction)
    ?? definitions.find(d => d.owner === owner && nameKey(d.name) === nameKey(call.customAction));
  if (call.customActionObjectClass !== undefined) return on(call.customActionObjectClass);
  return on(call.objectClass) ?? familiesOf(call.objectClass).map(on).find(d => d !== undefined);
}

/** A custom action call where it stands, for the tools that list or rewrite calls. */
export interface CustomActionCallSite {
  sheet: string;
  /** Path of the action, e.g. "events[2].children[0] > action:1" */
  path: string;
  sid?: number;
  call: { customAction: string; objectClass: string; customActionObjectClass?: string };
  /** The stored action, for a rewrite in place */
  ace: Record<string, unknown>;
}

/**
 * Every custom action call in `sheets`, and whether the walk saw every
 * event (false past its depth or node limit; `limit` says which, the node
 * limit when both stopped it).
 */
export function customActionCallSites(sheets: ReadonlyMap<string, unknown>): { sites: CustomActionCallSite[]; complete: boolean; limit?: 'events' | 'depth' } {
  const sites: CustomActionCallSite[] = [];
  let limit: 'events' | 'depth' | undefined;
  let nodes = 0;
  for (const [sheet, events] of sheets) {
    if (!Array.isArray(events)) continue;
    const stack: Array<{ list: unknown[]; path: string; depth: number }> = [{ list: events, path: 'events', depth: 0 }];
    while (stack.length > 0) {
      const { list, path, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) {
        limit ??= 'depth';
        continue;
      }
      list.forEach((ev, i) => {
        if (!isRecord(ev)) return;
        if (++nodes > MAX_NODES) {
          limit = 'events';
          return;
        }
        const eventPath = `${path}[${i}]`;
        (Array.isArray(ev.actions) ? ev.actions : []).forEach((ace, j) => {
          if (!isRecord(ace) || typeof ace.customAction !== 'string' || typeof ace.objectClass !== 'string') return;
          sites.push({
            sheet, path: `${eventPath} > action:${j}`, ...(typeof ev.sid === 'number' ? { sid: ev.sid } : {}), ace,
            call: {
              customAction: ace.customAction, objectClass: ace.objectClass,
              ...(typeof ace.customActionObjectClass === 'string' ? { customActionObjectClass: ace.customActionObjectClass } : {}),
            },
          });
        });
        if (Array.isArray(ev.children)) stack.push({ list: ev.children, path: `${eventPath}.children`, depth: depth + 1 });
      });
    }
  }
  return { sites, complete: limit === undefined, ...(limit !== undefined ? { limit } : {}) };
}

/**
 * What renaming the definition `renamed` to `newName` does to every call.
 * Each call is resolved before the rename; a call that ran `renamed` is to
 * be rewritten to the new name. Each call is then resolved again as it
 * will stand (the rewritten ones with the new name) against the
 * definitions after the rename: a call to rewrite must still run `renamed`,
 * and any other call must still run what it ran before (or nothing, as
 * before). A call that fails this is `captured`. Definitions are compared
 * by their sheet and event path.
 */
export function customActionRenameCaptures(
  sites: readonly CustomActionCallSite[],
  definitions: readonly CustomActionDefinition[],
  renamed: CustomActionDefinition,
  newName: string,
  familiesOf: (objectClass: string) => readonly string[],
): {
  rewrite: CustomActionCallSite[];
  captured: Array<{ site: CustomActionCallSite; before?: CustomActionDefinition; after?: CustomActionDefinition }>;
} {
  const same = (a?: CustomActionDefinition, b?: CustomActionDefinition) =>
    a === undefined || b === undefined ? a === b : a.sheet === b.sheet && a.eventPath === b.eventPath;
  const after = definitions.map(d => (same(d, renamed) ? { ...d, name: newName } : d));
  const rewrite: CustomActionCallSite[] = [];
  const captured: Array<{ site: CustomActionCallSite; before?: CustomActionDefinition; after?: CustomActionDefinition }> = [];
  for (const site of sites) {
    const before = resolveCustomActionCall(site.call, definitions, familiesOf);
    const toRewrite = before !== undefined && same(before, renamed);
    const proposed = toRewrite ? { ...site.call, customAction: newName } : site.call;
    const now = resolveCustomActionCall(proposed, after, familiesOf);
    if (!same(now, before)) captured.push({ site, before, after: now });
    else if (toRewrite) rewrite.push(site);
  }
  return { rewrite, captured };
}
