/** Parses JavaScript for source checks without coupling core rules to Acorn. */
import { parse } from "acorn";

/**
 * Parses a module and retains comment positions for adjacent JSDoc checks.
 * @param {string} source - JavaScript module source.
 * @returns {{ast: object, comments: object[]}} Syntax tree and comments.
 * @throws {SyntaxError} For malformed JavaScript.
 */
export function parseModule(source) {
  const comments = [];
  const ast = parse(source, {
    ecmaVersion: 2025,
    sourceType: "module",
    locations: true,
    onComment: comments,
  });
  return { ast, comments };
}
