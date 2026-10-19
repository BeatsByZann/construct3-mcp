/**
 * The strings of an event sheet that can name something by its name: the
 * string parameters of conditions and actions, and the lines of script
 * actions and script events, in events, groups, function blocks and
 * sub-events to any depth (and the events themselves, for keys such as an
 * include's "includeSheet"). Shared by the analyses that look for an entity's
 * name in them (entity-name-references.ts, object-name-references.ts).
 */

import type { EventSheet } from './types.js';

/** Where a string is: its event and its condition, action or script. */
export interface EventStringSite {
  /** JSON path of the event, e.g. "events[3].children[1]" */
  eventPath: string;
  /** "condition 0", "action 2", or "script" for a script event */
  ace: string;
  /** The condition's or action's id ("go-to-layout"), when it has one */
  id?: string;
}

/** A string parameter of a condition or action. */
export interface EventStringParameter {
  /** Parameter key ("layer", "x", ...), or the argument index of a positional function call */
  key: string;
  value: string;
  /** True for a named parameter (parameters is an object), false for a positional argument */
  named: boolean;
  /** Replace the value in the sheet (in memory) */
  set(value: string): void;
}

export interface EventStringVisitor {
  /** Every event, before its conditions and actions (an include event names a sheet in "includeSheet") */
  event?(event: Record<string, unknown>, eventPath: string): void;
  /** Every condition and action object, before its script lines and parameters (its objectClass, object-valued parameters) */
  ace?(site: EventStringSite, ace: Record<string, unknown>): void;
  parameter?(site: EventStringSite, parameter: EventStringParameter): void;
  /** A line of a script action (its "script" lines) or of a script event */
  scriptLine?(site: EventStringSite, line: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Visit every string parameter and script line of `sheet` (see the module comment). */
export function walkEventStrings(sheet: EventSheet | undefined, visitor: EventStringVisitor): void {
  const stack: Array<{ events: unknown; path: string }> = [{ events: sheet?.events, path: 'events' }];
  while (stack.length > 0) {
    const { events, path } = stack.pop()!;
    if (!Array.isArray(events)) continue;
    events.forEach((event, i) => {
      if (!isRecord(event)) return;
      const eventPath = `${path}[${i}]`;
      visitor.event?.(event, eventPath);
      for (const kind of ['conditions', 'actions'] as const) {
        const aces = event[kind];
        if (!Array.isArray(aces)) continue;
        aces.forEach((ace, j) => {
          if (!isRecord(ace)) return;
          const site: EventStringSite = {
            eventPath,
            ace: `${kind === 'conditions' ? 'condition' : 'action'} ${j}`,
            ...(typeof ace.id === 'string' ? { id: ace.id } : {}),
          };
          visitor.ace?.(site, ace);
          if (Array.isArray(ace.script)) {
            for (const line of ace.script) {
              if (typeof line === 'string') visitor.scriptLine?.(site, line);
            }
          }
          const params = ace.parameters;
          if (isRecord(params)) {
            for (const [key, value] of Object.entries(params)) {
              if (typeof value === 'string') {
                visitor.parameter?.(site, { key, value, named: true, set: v => { params[key] = v; } });
              }
            }
          } else if (Array.isArray(params)) {
            params.forEach((value, n) => {
              if (typeof value === 'string') {
                visitor.parameter?.(site, { key: String(n), value, named: false, set: v => { params[n] = v; } });
              }
            });
          }
        });
      }
      if (typeof event.script === 'string' || Array.isArray(event.script)) {
        const lines = Array.isArray(event.script) ? event.script : [event.script];
        for (const line of lines) {
          if (typeof line === 'string') visitor.scriptLine?.({ eventPath, ace: 'script' }, line);
        }
      }
      stack.push({ events: event.children, path: `${eventPath}.children` });
    });
  }
}

/** A pattern that finds `name` quoted in script text (double, single or back quotes), ignoring case. */
export function quotedNamePattern(name: string): RegExp {
  return new RegExp(`(["'\`])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'i');
}
