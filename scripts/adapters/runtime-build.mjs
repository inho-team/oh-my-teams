/** Generates closed CommonJS validators from the schema and copies the canonical pure core. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parse } from "acorn";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const require = createRequire(import.meta.url);
const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const generated = "plugins/oh-my-teams/scripts/generated";
const supports = new Map([
  ["ajv/dist/runtime/ucs2length", "./ucs2length.cjs"],
  ["ajv-formats/dist/formats", "./formats.cjs"],
]);

/**
 * Rewrites only AST dependency literals from the finite standalone support list.
 * @param {string} source - Generated validator or third-party support source.
 * @returns {string} Source with exclusively local runtime dependencies.
 * @throws {Error} When an unknown or computed executable dependency is present.
 */
export function localizeRuntime(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const replacements = [];
  function visit(node) {
    if (!node || typeof node !== "object" || !node.type) return;
    let dependency;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      if (node.arguments.length !== 1)
        throw new Error("unexpected runtime dependency arguments");
      dependency = node.arguments[0];
    } else if (
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      (node.type.startsWith("Export") && node.source)
    ) {
      dependency = node.source;
    }
    if (dependency) {
      const target = dependency.value;
      const local = supports.get(target);
      if (
        typeof target !== "string" ||
        (!local && ![...supports.values()].includes(target))
      )
        throw new Error(
          `unexpected runtime dependency: ${target ?? "computed"}`,
        );
      if (local)
        replacements.push({
          start: dependency.start,
          end: dependency.end,
          local,
        });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(ast);
  for (const { start, end, local } of replacements.sort(
    (a, b) => b.start - a.start,
  ))
    source = source.slice(0, start) + JSON.stringify(local) + source.slice(end);
  return source;
}

/**
 * Builds or checks every derived runtime artifact without installing runtime packages.
 * @param {object} [options] - Explicit checkout and write mode.
 * @param {string} [options.root] - Checkout containing the schema and pure core.
 * @param {boolean} [options.write] - Whether to replace missing or stale generated files.
 * @returns {{changed: string[], mismatches: string[]}} Exact changed or stale paths.
 */
export function buildRuntime({ root = defaultRoot, write = false } = {}) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    code: { source: true, lines: true },
  });
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(
      read("plugins/oh-my-teams/references/documents/document.schema.json"),
    ),
  );
  const artifacts = new Map([
    [
      `${generated}/document-validator.cjs`,
      localizeRuntime(standaloneCode(ajv, validate)),
    ],
  ]);
  for (const [dependency, local] of supports)
    artifacts.set(
      `${generated}/${local.slice(2)}`,
      localizeRuntime(fs.readFileSync(require.resolve(dependency), "utf8")),
    );
  const notices = ["# Generated runtime third-party notices\n"];
  for (const name of ["ajv", "ajv-formats"]) {
    const directory = path.dirname(require.resolve(`${name}/package.json`));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    const repository =
      typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
    notices.push(
      `## ${name} ${pkg.version}\n\nSource: ${repository}\n\nLicense: ${pkg.license}\n`,
      fs.readFileSync(path.join(directory, "LICENSE"), "utf8").trim(),
    );
  }
  artifacts.set(
    `${generated}/THIRD_PARTY_NOTICES.md`,
    `${notices.join("\n\n")}\n`,
  );
  artifacts.set(
    "plugins/oh-my-teams/scripts/core/omt-documents.mjs",
    read("scripts/core/omt-documents.mjs"),
  );
  const result = { changed: [], mismatches: [] };
  for (const [file, source] of artifacts) {
    const target = path.join(root, file);
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === source)
      continue;
    if (!write) result.mismatches.push(file);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
      result.changed.push(file);
    }
  }
  return result;
}
