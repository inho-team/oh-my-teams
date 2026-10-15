/** Validates canonical release versions with npm's strict semantic version parser. */
import parse from "semver/functions/parse.js";

/**
 * Provides the release-version boundary used before metadata writes.
 * @returns {import('../core/ports.mjs').VersionSyntaxPort} Strict release syntax predicate.
 */
export function createVersionSyntax() {
  return {
    isBuildTimestamp: (value) => {
      if (
        typeof value !== "string" ||
        !/^\d{14}$/.test(value) ||
        value.startsWith("0000")
      )
        return false;
      const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
      const date = new Date(iso);
      return !Number.isNaN(date.getTime()) && date.toISOString() === iso;
    },
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
