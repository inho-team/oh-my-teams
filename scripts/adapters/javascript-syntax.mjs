/** Parses JavaScript for source checks without coupling core rules to Acorn. */
import { parse } from "acorn";
import { analyze } from "eslint-scope";

/**
 * Parses a module and retains comment positions for adjacent JSDoc checks.
 * @param {string} source - JavaScript module source.
 * @returns {import('../core/ports.mjs').JavaScriptModule} Syntax, comments and lexical bindings.
 * @throws {SyntaxError} For malformed JavaScript.
 */
export function parseModule(source) {
  const comments = [];
  const ast = parse(source, {
    ecmaVersion: 2025,
    sourceType: "module",
    locations: true,
    ranges: true,
    onComment: comments,
  });
  const scopes = analyze(ast, { ecmaVersion: 2025, sourceType: "module" });
  const bindings = {};
  for (const scope of scopes.scopes) {
    for (const variable of scope.variables) {
      const values = [
        ...variable.defs.map(
          (definition) => `${definition.node.start}:${definition.node.type}`,
        ),
        ...variable.references.flatMap((reference) =>
          reference.writeExpr
            ? [`${reference.writeExpr.start}:${reference.writeExpr.type}`]
            : [],
        ),
      ];
      for (const identifier of [
        ...variable.identifiers,
        ...variable.references.map((reference) => reference.identifier),
      ]) {
        bindings[identifier.start] = [...new Set(values)];
      }
    }
  }
  const globals = scopes.globalScope.through.map(({ identifier }) => ({
    name: identifier.name,
    line: identifier.loc.start.line,
  }));
  return { ast, comments, bindings, globals };
}
