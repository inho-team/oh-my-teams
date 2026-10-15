/**
 * Structural boundary contracts; core modules depend on these capabilities only.
 *
 * @typedef {{name: string, kind: 'directory'|'file'|'other'}} FileEntry
 * @typedef {{file: string, before: string, after: string}} FileChange
 * @typedef {object} FilesPort
 * @property {(file: string) => string} realPath Resolves existing filesystem aliases.
 * @property {(file: string) => string} kind Classifies an existing path.
 * @property {(directory: string) => FileEntry[]} entries Lists immediate entries without following links.
 * @property {(file: string) => string} readText Reads UTF-8 and preserves filesystem error context.
 * @property {(changes: FileChange[]) => void} writeBatch Stages writes and restores owned snapshots; preserves observed conflicts.
 *
 * @typedef {object} DocumentSyntaxPort
 * @property {(source: string) => object} skillMetadata Parses metadata; SyntaxError denotes invalid input.
 * @property {(source: string, options: object) => string[]} markdownDestinations Extracts actual links.
 * @property {(source: string, options: object) => string[]} markdownAnchors Extracts GitHub slugs and HTML IDs.
 *
 * @typedef {{status: 'passed'|'failed', skills: number, findings: string[]}} ValidationReport
 * @typedef {{node: string, path: string[]}} JavaScriptBinding
 * @typedef {{ast: object, comments: object[], bindings: Object<number, JavaScriptBinding[]>, globals: {name: string, line: number}[]}} JavaScriptModule
 * @typedef {(source: string) => JavaScriptModule} JavaScriptParser
 * @typedef {{isReleaseVersion: (version: unknown) => boolean, isBuildTimestamp: (value: unknown) => boolean}} VersionSyntaxPort
 */
