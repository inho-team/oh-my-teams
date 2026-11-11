/** Derives per-kind authoring cards from the document schema and usage rules, and plans their synchronization. */
import path from "node:path";

const header =
  "<!-- document.schema.json과 protocol.yaml에서 생성한 파일입니다. 직접 수정하지 않고 `npm run cards`로 갱신합니다. -->";
const scalars = {
  text: "문자열",
  texts: "문자열 목록",
  commit: "전체 커밋 SHA",
  timestamp: "RFC 3339 시각",
};
const kinds = {
  review_request: {
    payload: "reviewRequest",
    rules: ["review_rules"],
    examples: ["review-request.example.yaml"],
  },
  review_result: {
    payload: "reviewResult",
    rules: ["review_rules"],
    examples: ["review-result.example.yaml"],
  },
  status_report: {
    payload: "statusReport",
    rules: ["status_rules"],
    examples: ["status-report.example.yaml"],
  },
  task_request: {
    payload: "taskRequest",
    rules: ["lifecycle_rules", "task_request"],
    examples: ["verified-task.example.yaml", "task-request.example.yaml"],
  },
  completion_report: {
    payload: "completionReport",
    rules: ["lifecycle_rules", "completion_report"],
    examples: [
      "verified-completion.example.yaml",
      "completion-report.example.yaml",
    ],
  },
  interruption_report: {
    payload: "interruptionReport",
    rules: ["lifecycle_rules", "interruption_report"],
    examples: ["interruption-report.example.yaml"],
  },
};

function referenceName(node) {
  const match = /^#\/definitions\/([A-Za-z]+)$/.exec(node?.$ref ?? "");
  if (node?.$ref && !match)
    throw new TypeError(`unsupported schema reference: ${node.$ref}`);
  return match?.[1] ?? null;
}

function isObjectSchema(node) {
  return node?.type === "object" && node.properties;
}

/**
 * Renders the outline of one object and records the shared structures it refers to.
 * @param {object} schema - Complete document schema.
 * @param {object} node - Object schema to render.
 * @param {number} depth - Indentation depth.
 * @param {Set<string>} shared - Names of referenced object definitions, in first-use order.
 * @returns {string[]} Outline lines.
 */
function outline(schema, node, depth, shared) {
  const required = new Set(node.required ?? []);
  return Object.entries(node.properties).flatMap(([name, property]) =>
    field(
      schema,
      required.has(name) ? name : `${name}?`,
      property,
      depth,
      shared,
    ),
  );
}

function scalarType(schema, node, shared) {
  const name = referenceName(node);
  if (name) {
    if (scalars[name]) return scalars[name];
    if (!isObjectSchema(schema.definitions[name]))
      throw new TypeError(`unsupported schema definition: ${name}`);
    shared.add(name);
    return `<${name}>`;
  }
  if (Object.hasOwn(node, "const")) return JSON.stringify(node.const);
  if (node.enum) return node.enum.join(" | ");
  if (node.type === "boolean") return "true | false";
  if (node.type === "null") return "null";
  if (node.type === "string") return scalars.text;
  return null;
}

function field(schema, label, node, depth, shared) {
  const indent = "  ".repeat(depth);
  if (node.anyOf) {
    const inline = node.anyOf.find(isObjectSchema);
    const types = node.anyOf
      .filter((option) => option !== inline)
      .map((option) => scalarType(schema, option, shared));
    if (types.includes(null))
      throw new TypeError(`unsupported alternative in ${label}`);
    if (!inline) return [`${indent}${label}: ${types.join(" | ")}`];
    return [
      `${indent}${label}: 아래 객체 | ${types.join(" | ")}`,
      ...outline(schema, inline, depth + 1, shared),
    ];
  }
  if (node.type === "array") {
    const count = node.minItems > 0 ? ` (${node.minItems}개 이상)` : "";
    if (isObjectSchema(node.items))
      return [
        `${indent}${label}: 다음 객체의 목록${count}`,
        ...outline(schema, node.items, depth + 1, shared),
      ];
    const item = scalarType(schema, node.items, shared);
    if (!item) throw new TypeError(`unsupported array items in ${label}`);
    return [`${indent}${label}: ${item} 목록${count}`];
  }
  if (isObjectSchema(node))
    return [`${indent}${label}:`, ...outline(schema, node, depth + 1, shared)];
  if (node.type === "object") return [`${indent}${label}:`];
  const type = scalarType(schema, node, shared);
  if (!type) throw new TypeError(`unsupported schema node in ${label}`);
  return [`${indent}${label}: ${type}`];
}

function sentence(value) {
  return String(value)
    .trim()
    .split(/\s*\n\s*/)
    .join(" ");
}

function ruleLines(value) {
  if (typeof value === "string") return [`- ${sentence(value)}`];
  if (Array.isArray(value)) return value.flatMap(ruleLines);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([name, item]) =>
      typeof item === "string"
        ? [`- \`${name}\`: ${sentence(item)}`]
        : ruleLines(item),
    );
  throw new TypeError("usage rules must be text, lists or mappings");
}

function ruleSource(protocol, keys) {
  const value = keys.reduce((node, key) => node?.[key], protocol);
  if (value === undefined)
    throw new TypeError(`usage rules missing: ${keys.join(".")}`);
  return value;
}

function envelope(schema, kind) {
  const branch = schema.allOf.find(
    (item) => item.if?.properties?.kind?.const === kind,
  );
  if (!branch) throw new TypeError(`schema has no branch for ${kind}`);
  const payload = kinds[kind].payload;
  if (referenceName(branch.then.properties.payload) !== payload)
    throw new TypeError(`unexpected payload definition for ${kind}`);
  return {
    ...schema,
    required: [...schema.required, ...(branch.then.required ?? [])],
    properties: {
      ...schema.properties,
      ...branch.then.properties,
      kind: { const: kind },
      payload: schema.definitions[payload],
    },
  };
}

function fileName(kind) {
  return `${kind.replaceAll("_", "-")}.md`;
}

function kindCard(schema, protocol, kind) {
  const { rules, examples } = kinds[kind];
  const shared = new Set();
  const top = envelope(schema, kind);
  const body = outline(schema, top, 0, shared).map((line) =>
    line === `kind: ${JSON.stringify(kind)}` ? `kind: ${kind}` : line,
  );
  const structures = [];
  // Shared structures may refer to further structures, so the set grows while it is read.
  for (const name of shared) {
    structures.push(
      `<${name}>`,
      ...outline(schema, schema.definitions[name], 1, shared),
    );
  }
  const exampleLinks = examples
    .map((file) => `[${file}](../${file})`)
    .join(", ");
  return [
    header,
    "",
    `# ${kind}`,
    "",
    sentence(ruleSource(protocol, ["scope", kind])),
    "",
    "## 필드",
    "",
    "`?`가 붙은 필드만 생략할 수 있으며, 여기에 없는 필드는 추가하지 않습니다. `<이름>`은 아래의 공통 구조를 가리킵니다.",
    "",
    "```text",
    ...body,
    ...(structures.length ? ["", ...structures] : []),
    "```",
    "",
    "## 규칙",
    "",
    ...ruleLines(ruleSource(protocol, rules)),
    "",
    "## 함께 읽을 자료",
    "",
    `- 식별자, 시각, 대상과 YAML 작성의 [공통 규칙](common.md)을 따릅니다.`,
    `- 값의 형태는 예제에서 확인합니다: ${exampleLinks}. 예제의 식별자와 관측값은 가상의 값입니다.`,
    "- 이 카드에 없는 내용을 확인해야 할 때에만 [스키마](../document.schema.json)와 [사용 규칙](../protocol.yaml)을 읽습니다.",
    "",
  ].join("\n");
}

function commonCard(protocol) {
  const rendering = ruleSource(protocol, ["rendering"]);
  return [
    header,
    "",
    "# 공통 규칙",
    "",
    "여섯 종류의 문서에 공통으로 적용하는 규칙입니다. 종류별 필드와 규칙은 같은 디렉터리의 카드에 있습니다.",
    "",
    "## 전달과 식별",
    "",
    ...ruleLines(ruleSource(protocol, ["transport"])),
    "",
    "## YAML 작성",
    "",
    ...ruleLines(ruleSource(protocol, ["yaml_rules"])),
    "",
    "## 사용자에게 보여줄 때",
    "",
    ...ruleLines({ input: rendering.input, output: rendering.output }),
    ...ruleLines(rendering.rules),
    "",
  ].join("\n");
}

/**
 * Renders the common card and one card per document kind.
 * The schema stays the validation source and the protocol stays the rule source; cards only restate them.
 * @param {object} schema - Parsed document.schema.json.
 * @param {object} protocol - Parsed protocol.yaml.
 * @returns {{name: string, text: string}[]} Card file names and Markdown, in a stable order.
 * @throws {TypeError} For schema constructs or rule shapes the cards cannot express.
 */
export function renderDocumentCards(schema, protocol) {
  const declared = schema.properties.kind.enum;
  const unknown = declared.filter((kind) => !kinds[kind]);
  if (unknown.length || declared.length !== Object.keys(kinds).length)
    throw new TypeError(
      `document kinds differ from the card definitions: ${declared.join(", ")}`,
    );
  return [
    { name: "common.md", text: commonCard(protocol) },
    ...declared.map((kind) => ({
      name: fileName(kind),
      text: kindCard(schema, protocol, kind),
    })),
  ];
}

function existing(directory, files) {
  try {
    return files
      .entries(directory)
      .filter((item) => item.kind === "file")
      .map((item) => item.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Compares generated cards with the card directory and optionally writes the difference.
 * Files in the directory that are not generated are reported and never deleted.
 * @param {boolean} write - Whether to create missing cards and replace outdated ones.
 * @param {object} options - Inputs and boundaries.
 * @param {string} options.directory - Card directory inside the plugin.
 * @param {{name: string, text: string}[]} options.cards - Generated cards.
 * @param {import("./ports.mjs").FilesPort} options.files - Filesystem capabilities.
 * @returns {{changed: string[], mismatches: string[]}} Written cards, or cards that differ when not writing.
 * @throws {Error} For stale snapshots or failed writes.
 */
export function synchronizeCards(write, { directory, cards, files }) {
  const present = new Set(existing(directory, files));
  const generated = new Set(cards.map((card) => card.name));
  const unexpected = [...present]
    .filter((name) => !generated.has(name))
    .sort()
    .map((name) => `${name}: not generated`);
  const missing = [];
  const outdated = [];
  for (const card of cards) {
    const file = path.join(directory, card.name);
    if (!present.has(card.name)) {
      missing.push({ file, name: card.name, after: card.text });
      continue;
    }
    const before = files.readText(file);
    if (before.replaceAll("\r\n", "\n") !== card.text)
      outdated.push({ file, name: card.name, before, after: card.text });
  }
  const names = [...missing, ...outdated].map((item) => item.name).sort();
  if (!write) return { changed: [], mismatches: [...names, ...unexpected] };
  files.writeBatch(outdated);
  for (const item of missing) files.createText(item.file, item.after);
  return { changed: names, mismatches: unexpected };
}
