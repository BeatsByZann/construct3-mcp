/**
 * Expression checking: the parameter strings of conditions and actions are
 * Construct expressions. This module parses them (numbers, strings,
 * operators, ternaries, calls, dotted names) and resolves every name against
 * the project and a catalogue of the definitions Construct ships:
 *
 *   Sprite.X, Sprite.AnimationName, Sprite.Platform.VectorX, Sprite.hp
 *   distance(a, b, c, d), random(6), loopindex, dt
 *   Score, lvTally             (global and local event variables)
 *   Functions.Total(1, 2)      (an object of the Function plugin)
 *   Self.hp                    (the ACE's own object)
 *
 * A problem is reported, never a refusal: an unknown object or family before a
 * dot, a member the object has no expression, instance variable or behavior
 * for, an unknown bare name or function, a wrong argument count, or text that
 * does not parse. Names are matched without case, as the editor accepts them.
 *
 * Only parameters whose declared type holds an expression are parsed; a combo
 * choice, an object name or a variable name is not an expression.
 *
 * The catalogue and the addon registry are always arguments: this module holds
 * neither. A finding that rests on the catalogue's expression lists is marked
 * `fromCatalog`, so a project saved with a newer release than the catalogue's
 * can have it hedged.
 *
 * Event variables resolve where they are written: a variable at the top level
 * of any sheet is global, a function or custom action parameter is visible in
 * its block, and any other variable is visible to the events beside it and
 * below them.
 */

import { aceOwner, releaseHedge } from './ace-catalog.js';
import type { AceContext, AceOwner } from './ace-catalog.js';
import type { AceCatalog, AceParam, AddonLookup, ExpressionDef, ProjectData } from './ace-types.js';
import { globalVariableNames } from './analyzers/delete-references.js';
import { hasOnlyLegacyBehaviorKey } from './analyzers/legacy-behavior-keys.js';
import { lintExpression } from './analyzers/load-rules.js';
import { DEFAULT_FUNCTIONS_OBJECT_NAME } from './event-shapes.js';
import { nameKey } from './names.js';

/** What is wrong with an expression: text that does not parse, or a name or argument count that does not fit the project or the catalogue. */
export type ExpressionProblemCode =
  | 'expression-grammar'
  | 'expression-unknown-object'
  | 'expression-unknown-member'
  | 'expression-unknown-function'
  | 'expression-unknown-name'
  | 'expression-argument-count';

/** One problem found in an expression string. */
export interface ExpressionProblem {
  code: ExpressionProblemCode;
  message: string;
  /** True when the finding rests on the catalogue's expression lists, which another release may extend. */
  fromCatalog: boolean;
}

/**
 * Codes that depend on what the project declares (object types, families,
 * functions, event variables), so they are not reported while a registered
 * file could not be read.
 */
const DECLARATION_CODES: ReadonlySet<ExpressionProblemCode> = new Set<ExpressionProblemCode>([
  'expression-unknown-object',
  'expression-unknown-member',
  'expression-unknown-function',
  'expression-unknown-name',
]);

/**
 * Parameter types whose values are expressions. Others hold a choice, a bare
 * name (a layout, an object, a variable, an audio file) or a flag; a layer
 * or animation parameter is an expression, usually a quoted name.
 */
export const EXPRESSION_PARAM_TYPES = new Set([
  'number', 'string', 'any', 'variadic', 'layer', 'animation', 'keyb', 'functionname', 'flowchart-string',
]);

/** The value stored under an own key of a record, or undefined: ids come from project files and `constructor` must not reach Object.prototype. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

// --- Tokens ------------------------------------------------

/** One token of an expression. */
export type Token =
  | { type: 'number'; text: string }
  | { type: 'string'; text: string }
  | { type: 'name'; text: string }
  | { type: 'op'; text: string }
  | { type: 'bad'; text: string };

const TWO_CHAR_OPS = ['<>', '<=', '>='];
const ONE_CHAR_OPS = '+-*/%^&|=<>?:,.()';

/** True for a character that separates tokens. */
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** True for a character that can be part of a name: any but the operators, quotes, brackets and the few symbols no name holds. */
function isNameChar(c: string): boolean {
  return !isSpace(c) && c !== '"' && c !== "'" && !ONE_CHAR_OPS.includes(c) && c !== '[' && c !== ']' && c !== '{' && c !== '}' && c !== ';' && c !== '!' && c !== '#' && c !== '@' && c !== '\\';
}

/** Split an expression into tokens. An unterminated string or a character no expression holds becomes a `bad` token. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === c) {
          if (text[j + 1] === c) { j += 2; continue; } // a doubled quote is an escaped quote
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) { tokens.push({ type: 'bad', text: text.slice(i) }); return tokens; }
      tokens.push({ type: 'string', text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:0x[0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?|[0-9]+\.)/.exec(text.slice(i))!;
      tokens.push({ type: 'number', text: m[0] });
      i += m[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) { tokens.push({ type: 'op', text: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.includes(c)) { tokens.push({ type: 'op', text: c }); i++; continue; }
    if (isNameChar(c)) {
      let j = i + 1;
      while (j < text.length && isNameChar(text[j])) j++;
      tokens.push({ type: 'name', text: text.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ type: 'bad', text: c });
    i++;
  }
  return tokens;
}

// --- Context -----------------------------------------------

/** What a project declares that expression names resolve against. */
export interface ExpressionContext {
  /** A declared object type or family, matched without case, with its declared name. */
  classify(name: string): { kind: 'object' | 'family'; name: string } | undefined;
  pluginOf(name: string): string | undefined;
  /** Instance variable names an expression on this object or family can reach (its own and its families'). */
  instanceVariables(name: string): string[];
  /** The ID of a behavior on an object or family, found without case. */
  behaviorOf(name: string, behaviorName: string): string | undefined;
  /** The behavior's name as the object type registers it, or undefined when it has none by that name. */
  behaviorNameOf(name: string, behaviorName: string): string | undefined;
  /** Function definitions by lowercase name, with their parameter counts. */
  functions: Map<string, number>;
  /** The event variables at the top level of any sheet, lowercase. */
  globals: Set<string>;
  /** The name functions are called through in expressions ("Functions" unless the project renames it). */
  functionsName: string;
}

/**
 * The event variables visible at the place an expression is written, other
 * than the globals: the parameters of the enclosing function and custom action
 * blocks, and the variables beside the enclosing events.
 */
export interface ExpressionScope {
  /** True when the lower-cased name is such a parameter or variable. */
  has(lowerName: string): boolean;
}

/** A place with nothing in scope beyond the globals. */
export const NO_SCOPE: ExpressionScope = { has: () => false };

/** An object type or family as declared in its file, reduced to what expression names resolve against. */
interface DeclaredType {
  name: string;
  pluginId?: string;
  instanceVariables: string[];
  /** Registered behavior names and IDs, by the name's `nameKey`. */
  behaviors: Map<string, { name: string; id: string }>;
  members: string[];
}

/** Read the declaration of one object type or family file. */
function declaredType(name: string, raw: Record<string, unknown>): DeclaredType {
  const behaviors = new Map<string, { name: string; id: string }>();
  for (const b of Array.isArray(raw.behaviorTypes) ? raw.behaviorTypes as Array<Record<string, unknown>> : []) {
    if (b && typeof b.name === 'string' && typeof b.behaviorId === 'string') behaviors.set(nameKey(b.name), { name: b.name, id: b.behaviorId });
  }
  return {
    name,
    pluginId: typeof raw['plugin-id'] === 'string' ? raw['plugin-id'] : undefined,
    instanceVariables: (Array.isArray(raw.instanceVariables) ? raw.instanceVariables as Array<Record<string, unknown>> : [])
      .map(v => v?.name).filter((n): n is string => typeof n === 'string'),
    behaviors,
    members: Array.isArray(raw.members) ? (raw.members as unknown[]).filter((m): m is string => typeof m === 'string') : [],
  };
}

/** Record each function block of an event tree with its parameter count, by lowercase name. */
function collectFunctions(events: unknown, functions: Map<string, number>, depth = 0): void {
  if (!Array.isArray(events) || depth > 64) return;
  for (const event of events as Array<Record<string, unknown>>) {
    if (!event || typeof event !== 'object') continue;
    if (event.eventType === 'function-block' && typeof event.functionName === 'string') {
      functions.set(event.functionName.toLowerCase(), Array.isArray(event.functionParameters) ? event.functionParameters.length : 0);
    }
    collectFunctions(event.children, functions, depth + 1);
  }
}

/** The context of a project from its declarations; the plugin and behavior behind a name come from `ace`. */
function contextFromDeclarations(
  types: DeclaredType[],
  families: DeclaredType[],
  functions: Map<string, number>,
  globals: Set<string>,
  ace: AceContext,
  functionsName: string,
): ExpressionContext {
  const byKey = new Map<string, { kind: 'object' | 'family'; decl: DeclaredType }>();
  for (const t of types) byKey.set(nameKey(t.name), { kind: 'object', decl: t });
  for (const f of families) byKey.set(nameKey(f.name), { kind: 'family', decl: f });
  const familiesOf = (objectName: string) => families.filter(f => f.members.includes(objectName));
  /** The declarations that can hold a behavior of this object or family, in the order the ACE context looks. */
  const behaviorHolders = (objectName: string): DeclaredType[] => {
    const hit = byKey.get(nameKey(objectName));
    if (!hit) return [];
    const holders = [hit.decl];
    if (hit.kind === 'object') holders.push(...familiesOf(hit.decl.name));
    else for (const member of hit.decl.members) holders.push(...types.filter(t => t.name === member));
    return holders;
  };
  return {
    classify(name) {
      const hit = byKey.get(nameKey(name));
      return hit ? { kind: hit.kind, name: hit.decl.name } : undefined;
    },
    pluginOf: name => ace.pluginOf(name),
    instanceVariables(name) {
      const hit = byKey.get(nameKey(name));
      if (!hit) return [];
      const declared = hit.decl.instanceVariables;
      if (hit.kind === 'family') return declared;
      return [...declared, ...familiesOf(hit.decl.name).flatMap(f => f.instanceVariables)];
    },
    behaviorOf: (name, behaviorName) => ace.behaviorOf(name, behaviorName),
    behaviorNameOf(name, behaviorName) {
      const id = ace.behaviorOf(name, behaviorName);
      if (id === undefined) return undefined;
      const key = nameKey(behaviorName);
      for (const holder of behaviorHolders(name)) {
        const found = holder.behaviors.get(key);
        if (found?.id === id) return found.name;
      }
      return undefined;
    },
    functions,
    globals,
    functionsName,
  };
}

/**
 * Build the resolution context of a project from the maps already read: object
 * types, families, the functions and the global variables of the sheets in
 * `data.sheets` (as they will be written). It reads nothing. `complete` is
 * false, and `unreadable` lists the files as `<category>/<name>`, when an
 * object type, family or event sheet could not be parsed: names declared in
 * such a file are unknown, so the checks that depend on declarations stand
 * down. The Functions object is the object type of the Function plugin, by
 * its declared name ("Functions" when the project declares none).
 */
export function buildExpressionContext(
  data: ProjectData,
  aceContext: AceContext,
): ExpressionContext & { complete: boolean; unreadable: string[] } {
  const types = [...data.objects].map(([name, type]) => declaredType(name, type as unknown as Record<string, unknown>));
  const families = [...data.families].map(([name, family]) => declaredType(name, family));
  const functions = new Map<string, number>();
  for (const sheet of data.sheets.values()) collectFunctions(sheet.events, functions);
  const globals = globalVariableNames(new Map<string, unknown>([...data.sheets].map(([name, sheet]): [string, unknown] => [name, sheet.events])));
  const functionsName = types.find(t => t.pluginId === 'Function')?.name ?? DEFAULT_FUNCTIONS_OBJECT_NAME;
  const unreadable = [...data.unreadable.objectTypes, ...data.unreadable.families, ...data.unreadable.eventSheets];
  return {
    ...contextFromDeclarations(types, families, functions, globals, aceContext, functionsName),
    complete: unreadable.length === 0,
    unreadable,
  };
}

// --- Expression definitions --------------------------------

/** One expression an owner offers. */
interface ExpressionEntry {
  def: ExpressionDef;
  /** True when the catalogue, not an addon's own definitions, lists it. */
  fromCatalog: boolean;
}

/** The expressions an owner offers, by lowercase name. */
interface ExpressionTable {
  entries: Map<string, ExpressionEntry>;
  /** True when a name missing from the table is missing from the catalogue's lists (the owner is built in, or the common expressions were added). */
  absenceFromCatalog: boolean;
}

/** Add the expressions of a set to a table, keeping the first of two with one name. */
function addEntries(defs: Record<string, ExpressionDef> | undefined, fromCatalog: boolean, into: Map<string, ExpressionEntry>): void {
  if (!defs) return;
  for (const def of Object.values(defs)) if (!into.has(def.name.toLowerCase())) into.set(def.name.toLowerCase(), { def, fromCatalog });
}

/** The expressions an owner offers, by lowercase name, or undefined when neither the catalogue nor the registry knows the owner. */
function expressionsOf(owner: AceOwner, addons: AddonLookup | undefined, catalog: AceCatalog): ExpressionTable | undefined {
  const builtIn = own(owner.kind === 'plugin' ? catalog.plugins : catalog.behaviors, owner.id);
  const set = builtIn ?? addons?.get(owner.kind, owner.id)?.aces;
  if (!set) return undefined;
  const entries = new Map<string, ExpressionEntry>();
  addEntries(set.expressions, builtIn !== undefined, entries);
  const common = owner.kind === 'plugin' && owner.id !== 'system';
  if (common) addEntries(catalog.common.expressions, true, entries);
  return { entries, absenceFromCatalog: builtIn !== undefined || common };
}

// --- Parser ------------------------------------------------

/** A recursive-descent reader of one expression that collects the problems it finds. */
class Parser {
  private pos = 0;
  readonly problems: ExpressionProblem[] = [];
  private stopped = false;
  private depth = 0;

  /** Levels of parentheses, arguments, ternaries and signs a value may nest; real values stay far below it. */
  private static readonly MAX_DEPTH = 200;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: ExpressionContext,
    private readonly selfClass: string | undefined,
    private readonly addons: AddonLookup | undefined,
    private readonly catalog: AceCatalog,
    private readonly scope: ExpressionScope,
  ) {}

  private peek(offset = 0): Token | undefined { return this.tokens[this.pos + offset]; }
  private isOp(text: string, offset = 0): boolean { const t = this.peek(offset); return t?.type === 'op' && t.text === text; }
  private take(): Token | undefined { return this.tokens[this.pos++]; }

  private syntax(message: string): void {
    if (!this.stopped) this.problems.push({ code: 'expression-grammar', message, fromCatalog: false });
    this.stopped = true;
    this.pos = this.tokens.length;
  }

  private report(code: ExpressionProblemCode, message: string, fromCatalog: boolean): void {
    if (!this.problems.some(p => p.message === message)) this.problems.push({ code, message, fromCatalog });
  }

  parse(): void {
    if (this.tokens.length === 0) return;
    this.expression();
    if (!this.stopped && this.pos < this.tokens.length) {
      const t = this.take()!;
      this.syntax(`unexpected ${t.type === 'op' ? `"${t.text}"` : t.type === 'bad' ? `character "${t.text}"` : `"${t.text}"`} after a complete expression`);
    }
  }

  private expression(): void {
    if (!this.enter()) return;
    this.ternary();
    this.depth--;
  }

  /** Count one level of nesting; past the limit, report it and stop, so a deep value cannot overflow the stack. */
  private enter(): boolean {
    if (++this.depth <= Parser.MAX_DEPTH) return true;
    this.depth--;
    this.syntax(`the expression is nested more than ${Parser.MAX_DEPTH} levels deep`);
    return false;
  }

  private ternary(): void {
    this.binary(0);
    if (this.stopped) return;
    if (this.isOp('?')) {
      this.take();
      this.expression();
      if (this.stopped) return;
      if (!this.isOp(':')) { this.syntax('a "?" without its ":"'); return; }
      this.take();
      this.expression();
    }
  }

  private static readonly LEVELS: string[][] = [['|'], ['&'], ['=', '<>', '<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%'], ['^']];

  private binary(level: number): void {
    if (level >= Parser.LEVELS.length) { this.unary(); return; }
    this.binary(level + 1);
    while (!this.stopped) {
      const t = this.peek();
      if (!t || t.type !== 'op' || !Parser.LEVELS[level].includes(t.text)) return;
      this.take();
      this.binary(level + 1);
    }
  }

  private unary(): void {
    if (this.isOp('-') || this.isOp('+')) {
      this.take();
      if (!this.enter()) return;
      this.unary();
      this.depth--;
      return;
    }
    this.primary();
  }

  private primary(): void {
    const t = this.peek();
    if (!t) { this.syntax('the expression ends where a value was expected'); return; }
    if (t.type === 'number' || t.type === 'string') { this.take(); return; }
    if (t.type === 'op' && t.text === '(') {
      this.take();
      this.expression();
      if (this.stopped) return;
      if (!this.isOp(')')) { this.syntax('a "(" without its ")"'); return; }
      this.take();
      return;
    }
    if (t.type === 'name') { this.path(); return; }
    if (t.type === 'bad') {
      this.take();
      this.syntax(t.text.startsWith('"') || t.text.startsWith("'") ? 'a string without its closing quote' : `the character "${t.text}" is not part of an expression`);
      return;
    }
    this.take();
    this.syntax(`"${t.text}" where a value was expected`);
  }

  /** Arguments after a name: returns the count, or undefined when there were no parentheses. */
  private args(): number | undefined {
    if (!this.isOp('(')) return undefined;
    this.take();
    if (this.isOp(')')) { this.take(); return 0; }
    let count = 0;
    for (;;) {
      this.expression();
      count++;
      if (this.stopped) return count;
      if (this.isOp(',')) { this.take(); continue; }
      if (this.isOp(')')) { this.take(); return count; }
      this.syntax('an argument list without its ")"');
      return count;
    }
  }

  /** Report a call whose argument count does not fit the definition: exactly its parameters, or at least them when it is variadic. */
  private checkArity(label: string, def: ExpressionDef, given: number | undefined, fromCatalog: boolean): void {
    const count = given ?? 0;
    const wanted = def.params.length;
    if (def.variadic ? count >= wanted : count === wanted) return;
    this.report('expression-argument-count', def.variadic
      ? `${label} takes at least ${wanted} argument(s); ${count} given.`
      : `${label} takes ${wanted} argument(s); ${count} given.`, fromCatalog);
  }

  private path(): void {
    const head = this.take() as Token & { type: 'name' };
    const headArgs = this.args();
    if (this.stopped) return;

    if (!this.isOp('.')) {
      this.bareName(head.text, headArgs);
      return;
    }

    // The functions namespace: Functions.Name(args), or whatever the project calls it.
    if (head.text.toLowerCase() === this.ctx.functionsName.toLowerCase() && headArgs === undefined) {
      this.take();
      const fn = this.take();
      if (!fn || fn.type !== 'name') { this.syntax('a "." with no name after it'); return; }
      const fnArgs = this.args();
      if (this.stopped) return;
      this.functionCall(fn.text, fnArgs);
      while (this.isOp('.')) { this.take(); const extra = this.take(); if (!extra || extra.type !== 'name') { this.syntax('a "." with no name after it'); return; } this.args(); }
      return;
    }

    // A dotted path: the head is an object type, a family, or Self.
    const isSelf = head.text.toLowerCase() === 'self';
    let owner = isSelf ? (this.selfClass ? this.ctx.classify(this.selfClass) : undefined) : this.ctx.classify(head.text);
    // "Self" in a call that names no object has nothing to resolve against.
    if (!owner && !(isSelf && !this.selfClass)) {
      this.report('expression-unknown-object', `"${head.text}" is not an object type or family of this project.`, false);
      owner = undefined;
    }
    while (this.isOp('.')) {
      this.take();
      const member = this.take();
      if (!member || member.type !== 'name') { this.syntax(`a "." with no name after it`); return; }
      const memberArgs = this.args();
      if (this.stopped) return;
      if (!owner) continue;
      owner = this.member(owner.name, member.text, memberArgs);
    }
  }

  /**
   * Resolve one member of an object or family. Returns the owner of any
   * further member (a behavior's expressions have none), or undefined when
   * nothing more can be resolved.
   */
  private member(ownerName: string, memberName: string, args: number | undefined): { kind: 'object' | 'family'; name: string } | undefined {
    const lower = memberName.toLowerCase();
    if (this.ctx.instanceVariables(ownerName).some(v => v.toLowerCase() === lower)) {
      if (args !== undefined) this.report('expression-argument-count', `"${ownerName}.${memberName}" is an instance variable and takes no arguments.`, false);
      return undefined;
    }
    const behaviorId = this.ctx.behaviorOf(ownerName, memberName);
    if (behaviorId) {
      const registered = this.ctx.behaviorNameOf(ownerName, memberName) ?? memberName;
      // The next member is one of the behavior's expressions.
      if (!this.isOp('.')) { this.report('expression-unknown-member', `"${ownerName}.${registered}" names a behavior; an expression of it must follow, such as "${ownerName}.${registered}.Speed".`, false); return undefined; }
      this.take();
      const expr = this.take();
      if (!expr || expr.type !== 'name') { this.syntax('a "." with no name after it'); return undefined; }
      const exprArgs = this.args();
      const table = expressionsOf({ kind: 'behavior', id: behaviorId }, this.addons, this.catalog);
      if (!table) return undefined; // no definitions loaded for this behavior
      const entry = table.entries.get(expr.text.toLowerCase());
      if (!entry) { this.report('expression-unknown-member', `The "${registered}" behavior on "${ownerName}" has no expression "${expr.text}".`, table.absenceFromCatalog); return undefined; }
      this.checkArity(`"${ownerName}.${registered}.${entry.def.name}"`, entry.def, exprArgs, entry.fromCatalog);
      return undefined;
    }
    const pluginId = this.ctx.pluginOf(ownerName);
    if (!pluginId) return undefined;
    if (pluginId === 'Function') {
      const count = this.ctx.functions.get(lower);
      if (count !== undefined) {
        const given = args ?? 0;
        if (given !== count) this.report('expression-argument-count', `The function "${memberName}" takes ${count} argument(s); ${given} given.`, false);
        return undefined;
      }
    }
    const table = expressionsOf({ kind: 'plugin', id: pluginId }, this.addons, this.catalog);
    if (!table) return undefined; // third-party plugin without definitions
    const entry = table.entries.get(lower);
    if (!entry) {
      // In "Name.X.Y" an X that is no expression, instance variable or behavior is reported by the check for missing behaviors and variables.
      if (!this.isOp('.')) {
        this.report('expression-unknown-member', `"${ownerName}" has no expression, instance variable or behavior named "${memberName}".`, table.absenceFromCatalog);
      }
      return undefined;
    }
    this.checkArity(`"${ownerName}.${entry.def.name}"`, entry.def, args, entry.fromCatalog);
    return undefined;
  }

  /**
   * Functions.Name(args): a function defined in a sheet, the system's CallMapped
   * under that namespace, or an expression the Function plugin lists in the
   * catalogue (such as Param and ParamCount).
   */
  private functionCall(name: string, args: number | undefined): void {
    const lower = name.toLowerCase();
    const count = this.ctx.functions.get(lower);
    if (count !== undefined) {
      const given = args ?? 0;
      if (given !== count) this.report('expression-argument-count', `The function "${name}" takes ${count} argument(s); ${given} given.`, false);
      return;
    }
    if (lower === 'callmapped') {
      const entry = expressionsOf({ kind: 'plugin', id: 'system' }, this.addons, this.catalog)?.entries.get(lower);
      if (entry) this.checkArity(`"${this.ctx.functionsName}.${entry.def.name}"`, entry.def, args, true);
      return;
    }
    const table = expressionsOf({ kind: 'plugin', id: 'Function' }, this.addons, this.catalog);
    if (!table) return; // nothing lists the Function plugin's expressions: a name cannot be called unknown
    const listed = table.entries.get(lower);
    if (listed) {
      this.checkArity(`"${this.ctx.functionsName}.${listed.def.name}"`, listed.def, args, listed.fromCatalog);
      return;
    }
    this.report('expression-unknown-function', `No function named "${name}" is defined in any event sheet.`, table.absenceFromCatalog);
  }

  private bareName(name: string, args: number | undefined): void {
    const lower = name.toLowerCase();
    const system = expressionsOf({ kind: 'plugin', id: 'system' }, this.addons, this.catalog);
    if (!system) return; // the catalogue holds no System object: nothing can be said about a bare name
    const entry = system.entries.get(lower);
    if (args !== undefined) {
      if (!entry) { this.report('expression-unknown-function', `"${name}" is not a system expression.`, true); return; }
      this.checkArity(`"${entry.def.name}"`, entry.def, args, true);
      return;
    }
    if (entry) {
      if (entry.def.params.length > 0) this.checkArity(`"${entry.def.name}"`, entry.def, 0, true);
      return;
    }
    if (this.ctx.globals.has(lower) || this.scope.has(lower)) return;
    if (this.ctx.classify(name)) return; // an object name on its own: left to Construct
    if (lower === 'self') return;
    this.report('expression-unknown-name', `"${name}" is not a system expression, an event variable, or an object of this project.`, true);
  }
}

/**
 * Check one expression string. `selfClass` is the object the ACE belongs to,
 * for "Self". `scope` holds the parameters and local variables visible where
 * the expression is written; the globals come from `ctx`.
 */
export function checkExpression(
  text: string,
  ctx: ExpressionContext,
  selfClass: string | undefined,
  addons: AddonLookup | undefined,
  catalog: AceCatalog,
  scope: ExpressionScope = NO_SCOPE,
): ExpressionProblem[] {
  const parser = new Parser(tokenize(text), ctx, selfClass, addons, catalog, scope);
  parser.parse();
  return parser.problems;
}

// --- Events ------------------------------------------------

/** An expression problem located in an event: which ACE, which parameter and what text. */
export interface EventExpressionProblem extends ExpressionProblem {
  kind: 'conditions' | 'actions';
  aceId: string;
  objectClass: string;
  sid?: number;
  parameter: string;
  expression: string;
}

/** The parameter list of an ACE of an owner: the catalogue's, else the registry's, with the common ACEs on plugin objects. */
function paramTypes(kind: 'conditions' | 'actions', id: string, owner: AceOwner, addons: AddonLookup | undefined, catalog: AceCatalog): AceParam[] | undefined {
  const set = own(owner.kind === 'plugin' ? catalog.plugins : catalog.behaviors, owner.id)
    ?? addons?.get(owner.kind, owner.id)?.aces;
  if (!set) return undefined;
  const found = own(set[kind], id);
  if (found) return found;
  if (owner.kind === 'plugin' && owner.id !== 'system') return own(catalog.common[kind], id);
  return undefined;
}

/** One expression string of a condition or action, where it stands. */
interface ExpressionSite {
  kind: 'conditions' | 'actions';
  ace: Record<string, unknown>;
  parameter: string;
  text: string;
  aceId: string;
  objectClass: string;
  /** The object "Self" means: the ACE's own object, or undefined for a call that names none. */
  selfClass: string | undefined;
  scope: ExpressionScope;
}

/** The lower-cased names in a function or custom action block's parameter list. */
function parameterNames(event: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const p of Array.isArray(event.functionParameters) ? event.functionParameters as Array<Record<string, unknown>> : []) {
    if (p && typeof p.name === 'string') names.push(p.name.toLowerCase());
  }
  return names;
}

/**
 * Visit every expression string of every condition and action in `events` and
 * their sub-events that a check would read: the expression-typed parameters of
 * a standard ACE and every argument of a function or custom action call. An
 * ACE with no definition, one that names its behavior only under the legacy
 * key, and a parameter of any other type are not visited. `only` limits the
 * walk to ACEs whose SID it holds. `visit` returns true to stop the walk;
 * the walk then returns true.
 */
function walkExpressionSites(
  events: unknown,
  aceContext: AceContext,
  addons: AddonLookup | undefined,
  catalog: AceCatalog,
  only: Set<number> | undefined,
  visit: (site: ExpressionSite) => boolean | void,
): boolean {
  const variableNames = new Map<unknown[], Set<string>>();
  /** The lower-cased names of the variable events in a list, read once per list. */
  const namesIn = (list: unknown[]): Set<string> => {
    let names = variableNames.get(list);
    if (!names) {
      names = new Set();
      for (const v of list as Array<Record<string, unknown>>) {
        if (v && typeof v === 'object' && v.eventType === 'variable' && typeof v.name === 'string') names.add(v.name.toLowerCase());
      }
      variableNames.set(list, names);
    }
    return names;
  };
  /** Walk one event list; `params` are the lower-cased block parameters in force, `lists` the enclosing lists whose variables are local. */
  const walk = (list: unknown, depth: number, params: readonly string[], lists: readonly unknown[][]): boolean => {
    if (!Array.isArray(list) || depth > 64) return false;
    // Variables beside an event are local unless the list is the top level, whose variables are global.
    const visible = depth === 0 ? lists : [...lists, list];
    for (const event of list as Array<Record<string, unknown>>) {
      if (!event || typeof event !== 'object') continue;
      const eventParams = event.eventType === 'function-block' || event.eventType === 'custom-ace-block' ? [...params, ...parameterNames(event)] : params;
      const scope: ExpressionScope = { has: name => eventParams.includes(name) || visible.some(l => namesIn(l).has(name)) };
      for (const kind of ['conditions', 'actions'] as const) {
        const items = event[kind];
        if (!Array.isArray(items)) continue;
        for (const ace of items as Array<Record<string, unknown>>) {
          if (!ace || typeof ace !== 'object') continue;
          const sid = typeof ace.sid === 'number' ? ace.sid : undefined;
          if (only && (sid === undefined || !only.has(sid))) continue;
          const given = ace.parameters;
          if (typeof ace.callFunction === 'string' || typeof ace.customAction === 'string') {
            const label = typeof ace.callFunction === 'string' ? ace.callFunction : String(ace.customAction);
            const objectClass = typeof ace.objectClass === 'string' ? ace.objectClass : 'Functions';
            if (!Array.isArray(given)) continue;
            for (let i = 0; i < given.length; i++) {
              const value: unknown = given[i];
              if (typeof value === 'string' && visit({ kind, ace, parameter: `#${i}`, text: value, aceId: label, objectClass, selfClass: typeof ace.objectClass === 'string' ? ace.objectClass : undefined, scope })) return true;
            }
            continue;
          }
          // Narrows the types for what follows; an ACE without either is skipped by the owner lookup in any case.
          if (typeof ace.id !== 'string' || typeof ace.objectClass !== 'string') continue;
          if (hasOnlyLegacyBehaviorKey(ace)) continue;
          const owner = aceOwner(ace, aceContext);
          if (!owner) continue;
          const types = paramTypes(kind, ace.id, owner, addons, catalog);
          if (!types || !given || typeof given !== 'object' || Array.isArray(given)) continue;
          const typeOf = new Map(types.map(p => [p.id, p.type]));
          for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
            if (typeof value !== 'string') continue;
            const type = typeOf.get(key);
            if (!type || !EXPRESSION_PARAM_TYPES.has(type)) continue;
            if (visit({ kind, ace, parameter: key, text: value, aceId: ace.id, objectClass: ace.objectClass, selfClass: ace.objectClass, scope })) return true;
          }
        }
      }
      if (walk(event.children, depth + 1, eventParams, visible)) return true;
    }
    return false;
  };
  return walk(events, 0, [], []);
}

/**
 * Check every expression-typed parameter of every condition and action in
 * `events` and their sub-events. Function and custom action call arguments
 * are all expressions. An ACE with no definition is skipped, since its
 * parameter types are unknown. `only` limits the check to ACEs whose SID it holds.
 *
 * `events` is read as the top level of a sheet: its variables are global, and
 * a variable or parameter resolves only inside the events it is visible to.
 * A text for which the load-time rule (`lintExpression`) reports a problem
 * yields no grammar problem here, since that rule reports it. While
 * `ctx.complete` is false the codes that depend on declarations are left out.
 */
export function checkEventExpressions(
  events: unknown,
  ctx: ExpressionContext & { complete?: boolean },
  aceContext: AceContext,
  addons: AddonLookup | undefined,
  catalog: AceCatalog,
  only?: Set<number>,
): EventExpressionProblem[] {
  const problems: EventExpressionProblem[] = [];
  walkExpressionSites(events, aceContext, addons, catalog, only, site => {
    const linted = lintExpression(site.text) !== null;
    for (const p of checkExpression(site.text, ctx, site.selfClass, addons, catalog, site.scope)) {
      if (linted && p.code === 'expression-grammar') continue;
      if (ctx.complete === false && DECLARATION_CODES.has(p.code)) continue;
      const sid = typeof site.ace.sid === 'number' ? site.ace.sid : undefined;
      problems.push({
        ...p,
        kind: site.kind,
        aceId: site.aceId,
        objectClass: site.objectClass,
        sid,
        parameter: site.parameter,
        expression: site.text.length > 120 ? site.text.slice(0, 117) + '...' : site.text,
      });
    }
  });
  return problems;
}

/**
 * True when one of the ACEs whose SID `only` holds has a parameter that
 * `checkEventExpressions` would check: the same selection, without parsing.
 */
export function hasExpressionParameters(
  events: unknown,
  aceContext: AceContext,
  addons: AddonLookup | undefined,
  catalog: AceCatalog,
  only: Set<number>,
): boolean {
  return walkExpressionSites(events, aceContext, addons, catalog, only, () => true);
}

/**
 * A problem worded for a tool warning. A finding that rests on the catalogue
 * gets the release hedge when the project was saved with a newer release than
 * `catalogRelease`.
 */
export function describeEventExpressionProblem(p: EventExpressionProblem, catalogRelease: string, savedWithRelease?: number): string {
  const noun = p.kind === 'conditions' ? 'Condition' : 'Action';
  const base = `${noun} "${p.aceId}" on "${p.objectClass}"${p.sid !== undefined ? ` (SID ${p.sid})` : ''}, parameter "${p.parameter}" = ${JSON.stringify(p.expression)}: ${p.message}`;
  return p.fromCatalog ? base + releaseHedge(catalogRelease, savedWithRelease) : base;
}
