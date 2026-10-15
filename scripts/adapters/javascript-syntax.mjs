/** Parses JavaScript for source checks without coupling core rules to Acorn. */
import { parse } from "acorn";
import { analyze } from "eslint-scope";

function nodeKey(node) {
  return `${node.start}:${node.type}`;
}

function patternValues(ast) {
  const writes = new Map();
  function bind(pattern, values) {
    if (!pattern) return;
    if (pattern.type === "Identifier") writes.set(pattern.start, values);
    else if (pattern.type === "AssignmentPattern")
      bind(pattern.left, [
        ...values,
        { node: nodeKey(pattern.right), path: [] },
      ]);
    else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        const key =
          !property.computed && property.key.type === "Identifier"
            ? property.key.name
            : property.key.value;
        if (typeof key === "string" || typeof key === "number")
          bind(
            property.value,
            values.map((value) => ({
              ...value,
              path: [...value.path, String(key)],
            })),
          );
      }
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((item, index) =>
        bind(
          item,
          values.map((value) => ({
            ...value,
            path: [...value.path, String(index)],
          })),
        ),
      );
    }
  }
  function visit(node) {
    if (!node || typeof node !== "object" || !node.type) return;
    if (node.type === "VariableDeclarator" && node.init)
      bind(node.id, [{ node: nodeKey(node.init), path: [] }]);
    if (node.type === "AssignmentExpression")
      bind(node.left, [{ node: nodeKey(node.right), path: [] }]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(ast);
  return writes;
}

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
  const writes = patternValues(ast);
  const bindings = {};
  for (const scope of scopes.scopes) {
    for (const variable of scope.variables) {
      const values = [
        ...variable.defs
          .filter((definition) => definition.type !== "Variable")
          .map((definition) => ({ node: nodeKey(definition.node), path: [] })),
        ...variable.references.flatMap((reference) =>
          reference.writeExpr
            ? (writes.get(reference.identifier.start) ?? [])
            : [],
        ),
      ];
      for (const identifier of [
        ...variable.identifiers,
        ...variable.references.map((reference) => reference.identifier),
      ]) {
        bindings[identifier.start] = values;
      }
    }
  }
  const globals = scopes.globalScope.through.map(({ identifier }) => ({
    name: identifier.name,
    line: identifier.loc.start.line,
  }));
  return { ast, comments, bindings, globals };
}
