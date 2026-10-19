/**
 * Types shared by the ACE catalogue, the ACE checker and the addon registry.
 * They hold no values, so any of those modules can import them without
 * pulling in another.
 */

import type { EventSheet, ObjectType } from './types.js';

/** One parameter of a condition, action or expression. */
export interface AceParam {
  id: string;
  type: string;
  /** The choices of a combo parameter, as the event stores them. */
  items?: string[];
}

/** An expression as an expression string names it: its name, parameter types, and whether more arguments may follow. */
export interface ExpressionDef {
  name: string;
  params: string[];
  variadic?: boolean;
  returns?: string;
}

/** The conditions, actions and expressions of one plugin, behavior or the common set. */
export interface AceSet {
  conditions: Record<string, AceParam[]>;
  actions: Record<string, AceParam[]>;
  /** Expressions by ID; the `name` is the form written in expression strings. */
  expressions: Record<string, ExpressionDef>;
}

/** What a Construct release defines, reduced to what validation needs. */
export interface AceCatalog {
  /** The Construct release the catalogue was built from, e.g. r495-2. */
  release: string;
  /** Built-in plugins by plugin ID; "system" holds the System object's ACEs. */
  plugins: Record<string, AceSet>;
  /** Built-in behaviors by behavior ID. */
  behaviors: Record<string, AceSet>;
  /** ACEs the editor adds to plugins by capability (instance variables, position, hierarchy, ...). */
  common: AceSet;
}

/** A third-party addon's definitions, read from its own aces.json. */
export interface AddonDefinition {
  id: string;
  type: 'plugin' | 'behavior';
  name: string;
  version?: string;
  /** Where it was read from. */
  source: string;
  /** Conditions, actions and expressions, in the catalogue's shape. */
  aces: AceSet;
  counts: { conditions: number; actions: number; expressions: number };
}

/** The one thing the checker needs from the addon registry. */
export interface AddonLookup {
  get(type: 'plugin' | 'behavior', id: string): AddonDefinition | undefined;
}

/** The parts of a project that ACE and expression checks read, with the files that could not be parsed. */
export interface ProjectData {
  objects: Map<string, ObjectType>;
  families: Map<string, Record<string, unknown>>;
  sheets: Map<string, EventSheet>;
  /** Files that could not be parsed, as `<category>/<name>`. */
  unreadable: { objectTypes: string[]; families: string[]; eventSheets: string[] };
}
