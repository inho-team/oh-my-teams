#!/usr/bin/env node
/**
 * Compatibility entry point for the pre-1.1 runtime path.
 *
 * The active implementation lives under `plugins/oh-my-teams`.
 */
import { main } from "../../oh-my-teams/scripts/teams-org.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
