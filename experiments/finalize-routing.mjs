#!/usr/bin/env node
/** Adds an optional quota-after snapshot and finalizes one routing manifest. */
import path from "node:path";
import { readJSON, writeJSON } from "../plugins/oh-my-teams/scripts/core.mjs";
import {
  compareQuotaSnapshots,
  validateQuotaSnapshot,
} from "../plugins/oh-my-teams/scripts/quota.mjs";

if (!process.argv[2])
  throw new Error("Usage: finalize-routing.mjs MANIFEST [QUOTA_AFTER]");
const manifestFile = path.resolve(process.argv[2]),
  afterFile = process.argv[3] ? path.resolve(process.argv[3]) : null;
const manifest = readJSON(manifestFile);
if (afterFile) manifest.quotaAfter = validateQuotaSnapshot(readJSON(afterFile));
manifest.quotaComparison =
  manifest.quotaBefore && manifest.quotaAfter
    ? compareQuotaSnapshots(manifest.quotaBefore, manifest.quotaAfter)
    : {
        attributable: false,
        reasons: ["missing-before-or-after-snapshot"],
        consumption: null,
      };
manifest.finalizedAt = new Date().toISOString();
writeJSON(manifestFile, manifest);
console.log(
  JSON.stringify(
    { manifest: manifestFile, quotaComparison: manifest.quotaComparison },
    null,
    2,
  ),
);
