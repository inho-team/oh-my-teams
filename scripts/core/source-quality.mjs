/** Checks documentation and dependency boundaries from parsed source data. */
import path from "node:path";

function layer(file) {
  if (file.startsWith("scripts/core/")) return "core";
  if (file.startsWith("scripts/adapters/")) return "adapter";
  if (/^scripts\/[^/]+\.mjs$/.test(file)) return "entry";
  if (/^(tests|examples)\//.test(file)) return "test";
  return "unknown";
}

function visit(node, callback) {
  if (!node || typeof node !== "object" || !node.type) return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback));
    else if (value && typeof value === "object") visit(value, callback);
  }
}

function jsdocBefore(module, offset) {
  return module.comments.findLast(
    (comment) =>
      comment !== module.comments[0] &&
      comment.type === "Block" &&
      comment.value.startsWith("*") &&
      comment.end <= offset &&
      !module.source.slice(comment.end, offset).trim(),
  );
}

function parameterNames(doc) {
  return [...doc.matchAll(/@param\s+\{/g)].flatMap((tag) => {
    let depth = 1;
    let index = tag.index + tag[0].length;
    // Object and function types may themselves contain braces.
    for (; index < doc.length && depth; index++) {
      if (doc[index] === "{") depth++;
      else if (doc[index] === "}") depth--;
    }
    const name = doc.slice(index).match(/^\s+(\[[^\]]+\]|[^\s]+)/)?.[1];
    return name ? [name.replace(/^\[|\]$/g, "").split("=")[0]] : [];
  });
}

function checkDocumentation(module, findings) {
  const first = module.comments[0];
  if (
    !first ||
    first.type !== "Block" ||
    !first.value.startsWith("*") ||
    module.source.slice(0, first.start).trim()
  ) {
    findings.push(`${module.file}: module JSDoc missing`);
  }
  for (const node of module.ast.body) {
    if (!node.type.startsWith("Export")) continue;
    const doc = jsdocBefore(module, node.start);
    if (!doc) {
      findings.push(
        `${module.file}:${node.loc.start.line}: public export JSDoc missing`,
      );
      continue;
    }
    const functions = exportedFunctions(module, node);
    for (const fn of functions) {
      const params = parameterNames(doc.value);
      const rootParams = params.filter((name) => !name.includes("."));
      const names = fn.params.map((param) => {
        const target =
          param.type === "AssignmentPattern"
            ? param.left
            : param.type === "RestElement"
              ? param.argument
              : param;
        return target.type === "Identifier" ? target.name : null;
      });
      if (
        rootParams.length < fn.params.length ||
        names.some((name) => name && !rootParams.includes(name))
      ) {
        findings.push(
          `${module.file}:${node.loc.start.line}: public function @param missing`,
        );
      }
      if (!/@returns\s+\{/.test(doc.value))
        findings.push(
          `${module.file}:${node.loc.start.line}: public function @returns missing`,
        );
    }
  }
  // Ignore comments, preserving offsets and newlines so diagnostics stay accurate.
  const characters = module.source.split("");
  for (const comment of module.comments) {
    for (let index = comment.start; index < comment.end; index++) {
      if (!/[\r\n]/.test(characters[index])) characters[index] = " ";
    }
  }
  characters
    .join("")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.trimEnd().length > 180)
        findings.push(
          `${module.file}:${index + 1}: executable line exceeds 180 characters`,
        );
    });
}

function exportedFunctions(module, node) {
  const nodes = new Map();
  visit(module.ast, (item) => nodes.set(`${item.start}:${item.type}`, item));
  function resolve(value, seen = new Set()) {
    if (!value) return [];
    const key = `${value.start}:${value.type}`;
    if (seen.has(key)) return [];
    const next = new Set([...seen, key]);
    if (/Function/.test(value.type)) return [value];
    if (value.type === "Identifier") {
      return (module.bindings[value.start] ?? []).flatMap((start) =>
        resolve(nodes.get(start), next),
      );
    }
    if (value.type === "VariableDeclaration")
      return value.declarations.flatMap((item) => resolve(item, next));
    if (value.type === "VariableDeclarator") return resolve(value.init, next);
    return [];
  }
  const values = node.declaration
    ? [node.declaration]
    : node.source
      ? []
      : node.specifiers.map((specifier) => specifier.local);
  return [...new Set(values.flatMap((value) => resolve(value)))];
}

function checkDependency(file, target, findings) {
  const current = layer(file);
  if (!target.startsWith(".")) {
    const allowed =
      current === "test" ||
      current === "adapter" ||
      target === "node:path" ||
      (current === "entry" && target === "node:url");
    if (!allowed)
      findings.push(`${file}: ${current} cannot import ${target}; use a port`);
    return null;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), target),
  );
  const next = layer(resolved);
  const allowed =
    current === "test" ||
    (current === "entry" && ["core", "adapter"].includes(next)) ||
    (current === "adapter" && ["adapter", "core"].includes(next)) ||
    (current === "core" && next === "core");
  if (!allowed)
    findings.push(
      `${file}: dependency from ${current} to ${next} is forbidden: ${target}`,
    );
  return resolved;
}

function dependencies(module, findings) {
  const edges = [];
  visit(module.ast, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      (node.type.startsWith("Export") && node.source) ||
      node.type === "ImportExpression"
    ) {
      if (typeof node.source?.value !== "string") {
        findings.push(
          `${module.file}:${node.loc.start.line}: computed imports cannot be checked`,
        );
      } else {
        const resolved = checkDependency(
          module.file,
          node.source.value,
          findings,
        );
        if (resolved) edges.push(resolved);
      }
    }
  });
  if (layer(module.file) === "core") {
    for (const reference of module.globals) {
      if (["process", "globalThis"].includes(reference.name)) {
        findings.push(
          `${module.file}:${reference.line}: core cannot access ${reference.name}; inject a port`,
        );
      } else if (reference.name === "Date") {
        findings.push(
          `${module.file}:${reference.line}: core clock must be provided by the caller`,
        );
      }
    }
  }
  return edges;
}

function checkCycles(graph, findings) {
  const active = new Set();
  const done = new Set();
  function walk(file, chain) {
    if (active.has(file)) {
      findings.push(`Dependency cycle: ${[...chain, file].join(" -> ")}`);
      return;
    }
    if (done.has(file)) return;
    active.add(file);
    for (const target of graph.get(file) ?? []) walk(target, [...chain, file]);
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) walk(file, []);
}

/**
 * Checks every supplied module and its internal dependency graph.
 * @param {(import('./ports.mjs').JavaScriptModule & {file: string, source: string})[]} modules - Parsed repository-relative modules.
 * @returns {string[]} Documentation and architecture failures.
 */
export function inspectSources(modules) {
  const findings = [];
  const graph = new Map();
  for (const module of modules) {
    if (layer(module.file) === "unknown")
      findings.push(
        `${module.file}: module is outside declared architecture layers`,
      );
    checkDocumentation(module, findings);
    graph.set(module.file, dependencies(module, findings));
  }
  for (const [file, targets] of graph) {
    for (const target of targets)
      if (!graph.has(target))
        findings.push(`${file}: unresolved source import ${target}`);
  }
  checkCycles(graph, findings);
  return findings;
}
