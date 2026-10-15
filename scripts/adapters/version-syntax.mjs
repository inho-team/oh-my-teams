/** Validates canonical release versions with npm's strict semantic version parser. */
import parse from "semver/functions/parse.js";

/**
 * Provides the release-version boundary used before metadata writes.
 * @returns {import('../core/ports.mjs').VersionSyntaxPort} Strict release syntax predicate.
 */
export function createVersionSyntax() {
  return {
    isReleaseVersion: (version) => {
      if (typeof version !== "string") return false;
      const parsed = parse(version);
      // Codex owns the build suffix; accepting one here would produce two plus signs.
      return (
        parsed !== null &&
        parsed.version === version &&
        parsed.build.length === 0
      );
    },
  };
}
