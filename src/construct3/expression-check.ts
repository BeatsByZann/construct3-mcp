/**
 * Expression checking: the parameter strings of conditions and actions are
 * Construct expressions, and until now they were never read. This module
 * parses them (numbers, strings, operators, ternaries, calls, dotted names)
 * and resolves every name against the project and the ACE catalogue:
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
 */

import { ACE_CATALOG } from './ace-catalog-data.js';
import { addonDefinition } from './addon-definitions.js';
import { aceOwner, buildAceContext, type AceCatalog, type AceContext, type AceOwner, type AceParam, type ExpressionDef } from './ace-catalog.js';
import type { Construct3ProjectReader } from './project-reader.js';

export type ExpressionProblemCode =
  | 'expression-syntax'
  | 'expression-unknown-object'
  | 'expression-unknown-member'
  | 'expression-unknown-function'
  | 'expression-unknown-name'
  | 'expression-argument-count';

export interface ExpressionProblem {
  code: ExpressionProblemCode;
  message: string;
}

/**
 * Parameter types whose values are expressions. Others hold a choice, a bare
 * name (a layout, an object, a variable, an audio file) or a flag; a layer
 * or animation parameter is an expression, usually a quoted name.
 */
export const EXPRESSION_PARAM_TYPES = new Set([
  'number', 'string', 'any', 'variadic', 'layer', 'animation', 'keyb', 'functionname', 'flowchart-string',
]);

// ─── Tokens ────────────────────────────────────────────────

type Token =
  | { type: 'number'; text: string }
  | { type: 'string'; text: string }
  | { type: 'name'; text: string }
  | { type: 'op'; text: string }
  | { type: 'bad'; text: string };

const TWO_CHAR_OPS = ['<>', '<=', '>='];
const ONE_CHAR_OPS = '+-*/%^&|=<>?:,.()';

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isNameChar(c: string): boolean {
  return !isSpace(c) && c !== '"' && c !== "'" && !ONE_CHAR_OPS.includes(c) && c !== '[' && c !== ']' && c !== '{' && c !== '}' && c !== ';' && c !== '!' && c !== '#' && c !== '@' && c !== '\\';
}

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

// ─── Context ───────────────────────────────────────────────

export interface ExpressionContext {
  /** A declared object type or family, matched without case, with its declared name. */
  classify(name: string): { kind: 'object' | 'family'; name: string } | undefined;
  pluginOf(name: string): string | undefined;
  /** Instance variable names an expression on this object or family can reach (its own and its families'). */
  instanceVariables(name: string): string[];
  behaviorOf(name: string, behaviorName: string): string | undefined;
  /** Function definitions by lowercase name, with their parameter counts. */
  functions: Map<string, number>;
  /** Every event variable and function parameter declared in any sheet, lowercase. */
  variables: Set<string>;
  /** The name functions are called through in expressions ("Functions" unless the project renames it). */
  functionsName: string;
}

interface DeclaredType {
  name: string;
  pluginId?: string;
  instanceVariables: string[];
  behaviors: Map<string, string>;
  members: string[];
}

function declaredType(raw: Record<string, unknown>): DeclaredType {
  const behaviors = new Map<string, string>();
  for (const b of Array.isArray(raw.behaviorTypes) ? raw.behaviorTypes as Array<Record<string, unknown>> : []) {
    if (typeof b.name === 'string' && typeof b.behaviorId === 'string') behaviors.set(b.name, b.behaviorId);
  }
  return {
    name: String(raw.name ?? ''),
    pluginId: typeof raw['plugin-id'] === 'string' ? raw['plugin-id'] as string : undefined,
    instanceVariables: (Array.isArray(raw.instanceVariables) ? raw.instanceVariables as Array<Record<string, unknown>> : [])
      .map(v => v.name).filter((n): n is string => typeof n === 'string'),
    behaviors,
    members: Array.isArray(raw.members) ? (raw.members as unknown[]).filter((m): m is string => typeof m === 'string') : [],
  };
}

/** Walk events of every sheet for function definitions and variable declarations. */
function collectDeclarations(sheets: Iterable<unknown>, functions: Map<string, number>, variables: Set<string>): void {
  const walk = (list: unknown, depth: number) => {
    if (!Array.isArray(list) || depth > 64) return;
    for (const event of list as Array<Record<string, unknown>>) {
      if (!event || typeof event !== 'object') continue;
      if (event.eventType === 'function-block' || event.eventType === 'custom-ace-block') {
        const params = Array.isArray(event.functionParameters) ? event.functionParameters as Array<Record<string, unknown>> : [];
        if (event.eventType === 'function-block' && typeof event.functionName === 'string') functions.set(event.functionName.toLowerCase(), params.length);
        // A parameter of a function or custom action is a bare name inside it, like a local variable.
        for (const p of params) if (typeof p.name === 'string') variables.add(p.name.toLowerCase());
      }
      if (event.eventType === 'variable' && typeof event.name === 'string') variables.add(event.name.toLowerCase());
      walk(event.children, depth + 1);
    }
  };
  for (const sheet of sheets) walk((sheet as { events?: unknown } | undefined)?.events, 0);
}

export function contextFromDeclarations(
  types: DeclaredType[],
  families: DeclaredType[],
  functions: Map<string, number>,
  variables: Set<string>,
  ace: AceContext,
  functionsName = 'Functions',
): ExpressionContext {
  const byLower = new Map<string, { kind: 'object' | 'family'; decl: DeclaredType }>();
  for (const t of types) byLower.set(t.name.toLowerCase(), { kind: 'object', decl: t });
  for (const f of families) byLower.set(f.name.toLowerCase(), { kind: 'family', decl: f });
  const familiesOf = (objectName: string) => families.filter(f => f.members.includes(objectName));
  return {
    classify(name) {
      const hit = byLower.get(name.toLowerCase());
      return hit ? { kind: hit.kind, name: hit.decl.name } : undefined;
    },
    pluginOf: name => ace.pluginOf(name),
    instanceVariables(name) {
      const hit = byLower.get(name.toLowerCase());
      if (!hit) return [];
      const own = hit.decl.instanceVariables;
      if (hit.kind === 'family') return own;
      return [...own, ...familiesOf(hit.decl.name).flatMap(f => f.instanceVariables)];
    },
    behaviorOf: (name, behaviorName) => ace.behaviorOf(name, behaviorName),
    functions,
    variables,
    functionsName,
  };
}

/** Build the resolution context for a project: object types, families, functions and variables of every sheet. */
export async function buildExpressionContext(reader: Construct3ProjectReader): Promise<ExpressionContext> {
  const ace = await buildAceContext(reader);
  const types: DeclaredType[] = [];
  for (const name of await reader.listObjectTypes()) {
    try {
      types.push(declaredType(await reader.readObjectType(name) as unknown as Record<string, unknown>));
    } catch {
      // Reported by other checks; names it declares are unknown here.
    }
  }
  const families: DeclaredType[] = [];
  for (const [, family] of await reader.readAllFamilies()) families.push(declaredType(family as unknown as Record<string, unknown>));
  const functions = new Map<string, number>();
  const variables = new Set<string>();
  const sheets: unknown[] = [];
  for (const name of await reader.listEventSheets()) {
    try {
      sheets.push(await reader.readEventSheet(name));
    } catch {
      // An unreadable sheet cannot contribute declarations.
    }
  }
  collectDeclarations(sheets, functions, variables);
  const project = reader.getProject() as { functionsName?: unknown };
  const functionsName = typeof project.functionsName === 'string' && project.functionsName.length > 0 ? project.functionsName : 'Functions';
  return contextFromDeclarations(types, families, functions, variables, ace, functionsName);
}

// ─── Expression definitions ────────────────────────────────

function byLowerName(defs: Record<string, ExpressionDef> | undefined, into: Map<string, ExpressionDef>): void {
  if (!defs) return;
  for (const def of Object.values(defs)) if (!into.has(def.name.toLowerCase())) into.set(def.name.toLowerCase(), def);
}

/** The expressions an owner offers, by lowercase name, or undefined when nothing knows the owner. */
function expressionsOf(owner: AceOwner, catalog: AceCatalog): Map<string, ExpressionDef> | undefined {
  const set = (owner.kind === 'plugin' ? catalog.plugins[owner.id] : catalog.behaviors[owner.id])
    ?? addonDefinition(owner.kind, owner.id)?.aces;
  if (!set) return undefined;
  const out = new Map<string, ExpressionDef>();
  byLowerName(set.expressions, out);
  if (owner.kind === 'plugin' && owner.id !== 'system') byLowerName(catalog.common.expressions, out);
  return out;
}

// ─── Parser ────────────────────────────────────────────────

class Parser {
  private pos = 0;
  readonly problems: ExpressionProblem[] = [];
  private stopped = false;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: ExpressionContext,
    private readonly selfClass: string | undefined,
    private readonly catalog: AceCatalog,
  ) {}

  private peek(offset = 0): Token | undefined { return this.tokens[this.pos + offset]; }
  private isOp(text: string, offset = 0): boolean { const t = this.peek(offset); return t?.type === 'op' && t.text === text; }
  private take(): Token | undefined { return this.tokens[this.pos++]; }

  private syntax(message: string): void {
    if (!this.stopped) this.problems.push({ code: 'expression-syntax', message });
    this.stopped = true;
    this.pos = this.tokens.length;
  }

  private report(code: ExpressionProblemCode, message: string): void {
    if (!this.problems.some(p => p.message === message)) this.problems.push({ code, message });
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
    this.ternary();
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
    if (this.isOp('-') || this.isOp('+')) { this.take(); this.unary(); return; }
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

  private checkArity(label: string, def: ExpressionDef, given: number | undefined): void {
    const count = given ?? 0;
    const wanted = def.params.length;
    if (def.variadic ? count >= wanted : count === wanted) return;
    this.report('expression-argument-count', def.variadic
      ? `${label} takes at least ${wanted} argument(s); ${count} given.`
      : `${label} takes ${wanted} argument(s); ${count} given.`);
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
    let owner = head.text.toLowerCase() === 'self' && this.selfClass ? this.ctx.classify(this.selfClass) : this.ctx.classify(head.text);
    if (!owner) {
      this.report('expression-unknown-object', `"${head.text}" is not an object type or family of this project.`);
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
      if (args !== undefined) this.report('expression-argument-count', `"${ownerName}.${memberName}" is an instance variable and takes no arguments.`);
      return undefined;
    }
    const behaviorId = this.ctx.behaviorOf(ownerName, memberName);
    if (behaviorId) {
      // The next member is one of the behavior's expressions.
      if (!this.isOp('.')) { this.report('expression-unknown-member', `"${ownerName}.${memberName}" names a behavior; an expression of it must follow, such as "${ownerName}.${memberName}.Speed".`); return undefined; }
      this.take();
      const expr = this.take();
      if (!expr || expr.type !== 'name') { this.syntax('a "." with no name after it'); return undefined; }
      const exprArgs = this.args();
      const defs = expressionsOf({ kind: 'behavior', id: behaviorId }, this.catalog);
      if (!defs) return undefined; // no definitions loaded for this behavior
      const def = defs.get(expr.text.toLowerCase());
      if (!def) { this.report('expression-unknown-member', `The ${behaviorId} behavior on "${ownerName}" has no expression "${expr.text}".`); return undefined; }
      this.checkArity(`"${ownerName}.${memberName}.${def.name}"`, def, exprArgs);
      return undefined;
    }
    const pluginId = this.ctx.pluginOf(ownerName);
    if (!pluginId) return undefined;
    if (pluginId === 'Function') {
      const count = this.ctx.functions.get(lower);
      if (count !== undefined) {
        const given = args ?? 0;
        if (given !== count) this.report('expression-argument-count', `The function "${memberName}" takes ${count} argument(s); ${given} given.`);
        return undefined;
      }
    }
    const defs = expressionsOf({ kind: 'plugin', id: pluginId }, this.catalog);
    if (!defs) return undefined; // third-party plugin without definitions
    const def = defs.get(lower);
    if (!def) {
      this.report('expression-unknown-member', `"${ownerName}" has no expression, instance variable or behavior named "${memberName}".`);
      return undefined;
    }
    this.checkArity(`"${ownerName}.${def.name}"`, def, args);
    return undefined;
  }

  /** Functions.Name(args): a function defined in a sheet, or the system's CallMapped under that namespace. */
  private functionCall(name: string, args: number | undefined): void {
    const lower = name.toLowerCase();
    const count = this.ctx.functions.get(lower);
    if (count !== undefined) {
      const given = args ?? 0;
      if (given !== count) this.report('expression-argument-count', `The function "${name}" takes ${count} argument(s); ${given} given.`);
      return;
    }
    const system = expressionsOf({ kind: 'plugin', id: 'system' }, this.catalog)!;
    const def = system.get(lower);
    if (def && lower === 'callmapped') { this.checkArity(`"${this.ctx.functionsName}.${def.name}"`, def, args); return; }
    this.report('expression-unknown-function', `No function named "${name}" is defined in any event sheet.`);
  }

  private bareName(name: string, args: number | undefined): void {
    const lower = name.toLowerCase();
    const system = expressionsOf({ kind: 'plugin', id: 'system' }, this.catalog)!;
    const def = system.get(lower);
    if (args !== undefined) {
      if (!def) { this.report('expression-unknown-function', `"${name}" is not a system expression.`); return; }
      this.checkArity(`"${def.name}"`, def, args);
      return;
    }
    if (def) {
      if (def.params.length > 0 && !def.variadic) this.report('expression-argument-count', `"${def.name}" takes ${def.params.length} argument(s); none given.`);
      return;
    }
    if (this.ctx.variables.has(lower)) return;
    if (this.ctx.classify(name)) return; // an object name on its own: left to Construct
    if (lower === 'self') return;
    this.report('expression-unknown-name', `"${name}" is not a system expression, an event variable, or an object of this project.`);
  }
}

/** Check one expression string. `selfClass` is the object the ACE belongs to, for "Self". */
export function checkExpression(text: string, ctx: ExpressionContext, selfClass?: string, catalog: AceCatalog = ACE_CATALOG): ExpressionProblem[] {
  const parser = new Parser(tokenize(text), ctx, selfClass, catalog);
  parser.parse();
  return parser.problems;
}

// ─── Events ────────────────────────────────────────────────

export interface EventExpressionProblem extends ExpressionProblem {
  kind: 'conditions' | 'actions';
  aceId: string;
  objectClass: string;
  sid?: number;
  parameter: string;
  expression: string;
}

function paramTypes(kind: 'conditions' | 'actions', ace: { id: string }, owner: AceOwner, catalog: AceCatalog): AceParam[] | undefined {
  const set = (owner.kind === 'plugin' ? catalog.plugins[owner.id] : catalog.behaviors[owner.id])
    ?? addonDefinition(owner.kind, owner.id)?.aces;
  if (!set) return undefined;
  const own = set[kind][ace.id];
  if (own) return own;
  if (owner.kind === 'plugin' && owner.id !== 'system') return catalog.common[kind][ace.id];
  return undefined;
}

/**
 * Check every expression-typed parameter of every condition and action in
 * `events` and their sub-events. Function and custom action call arguments
 * are all expressions. An ACE with no definition is skipped, since its
 * parameter types are unknown. `only` limits the check to ACEs whose SID it holds.
 */
export function checkEventExpressions(
  events: unknown,
  ctx: ExpressionContext,
  aceContext: AceContext,
  only?: Set<number>,
  catalog: AceCatalog = ACE_CATALOG,
): EventExpressionProblem[] {
  const problems: EventExpressionProblem[] = [];
  const check = (kind: 'conditions' | 'actions', ace: Record<string, unknown>, parameter: string, text: string, aceId: string, objectClass: string) => {
    for (const p of checkExpression(text, ctx, objectClass, catalog)) {
      problems.push({ ...p, kind, aceId, objectClass, sid: typeof ace.sid === 'number' ? ace.sid : undefined, parameter, expression: text.length > 120 ? text.slice(0, 117) + '...' : text });
    }
  };
  const walk = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || depth > 64) return;
    for (const event of list as Array<Record<string, unknown>>) {
      if (!event || typeof event !== 'object') continue;
      for (const kind of ['conditions', 'actions'] as const) {
        const items = event[kind];
        if (!Array.isArray(items)) continue;
        for (const ace of items as Array<Record<string, unknown>>) {
          if (!ace || typeof ace !== 'object') continue;
          const sid = typeof ace.sid === 'number' ? ace.sid : undefined;
          if (only && (sid === undefined || !only.has(sid))) continue;
          const params = ace.parameters;
          if (typeof ace.callFunction === 'string' || typeof ace.customAction === 'string') {
            const label = typeof ace.callFunction === 'string' ? ace.callFunction : String(ace.customAction);
            const objectClass = typeof ace.objectClass === 'string' ? ace.objectClass : 'Functions';
            if (Array.isArray(params)) params.forEach((value, i) => { if (typeof value === 'string') check(kind, ace, `#${i}`, value, label, objectClass); });
            continue;
          }
          if (typeof ace.id !== 'string' || typeof ace.objectClass !== 'string') continue;
          const owner = aceOwner(ace, aceContext);
          if (!owner) continue;
          const types = paramTypes(kind, { id: ace.id }, owner, catalog);
          if (!types || !params || typeof params !== 'object' || Array.isArray(params)) continue;
          const typeOf = new Map(types.map(p => [p.id, p.type]));
          for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
            if (typeof value !== 'string') continue;
            const type = typeOf.get(key);
            if (!type || !EXPRESSION_PARAM_TYPES.has(type)) continue;
            check(kind, ace, key, value, ace.id, ace.objectClass);
          }
        }
      }
      walk(event.children, depth + 1);
    }
  };
  walk(events, 0);
  return problems;
}

/** A problem worded for a tool warning. */
export function describeEventExpressionProblem(p: EventExpressionProblem): string {
  const noun = p.kind === 'conditions' ? 'Condition' : 'Action';
  return `${noun} "${p.aceId}" on "${p.objectClass}"${p.sid !== undefined ? ` (SID ${p.sid})` : ''}, parameter "${p.parameter}" = ${JSON.stringify(p.expression)}: ${p.message}`;
}
