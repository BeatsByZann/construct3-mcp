/**
 * Finds raw file writes in tool modules, for the direct-write guard: calls
 * of writeFile, atomicReplace, unlink, rename or copyFile, under any import
 * alias (`import { writeFile as w }`, `const { unlink } = await import(...)`)
 * or as a property (`fs.unlink(...)`), spread over any number of lines.
 */

import ts from 'typescript';
import { readdirSync } from 'fs';
import { join } from 'path';

/** Function names that write or remove files directly, bypassing the project writer. */
export const RAW_WRITE_NAMES = new Set(['writeFile', 'atomicReplace', 'unlink', 'rename', 'copyFile']);

/** Every .ts file under `dir`, recursively, relative to it with forward slashes. */
export function listToolModules(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listToolModules(dir, rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** The raw write calls in one source file. */
export function rawWriteCalls(fileName: string, sourceText: string): Array<{ name: string; line: number; text: string }> {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  // Local names bound to a raw write function: imports and destructured dynamic imports
  const aliases = new Map<string, string>();
  const bind = (local: string, original: string) => { if (RAW_WRITE_NAMES.has(original)) aliases.set(local, original); };
  const visitBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) bind(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const original = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        bind(el.name.text, original);
      }
    }
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(source);

  const out: Array<{ name: string; line: number; text: string }> = [];
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name: string | undefined;
      if (ts.isIdentifier(callee)) name = aliases.get(callee.text);
      else if (ts.isPropertyAccessExpression(callee) && RAW_WRITE_NAMES.has(callee.name.text)) name = callee.name.text;
      if (name) {
        out.push({
          name,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: node.getText(source).replace(/\s+/g, ' '),
        });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return out;
}
