/** OpenCodex runner provider support validation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateOrg,
  saveOrg,
  readJSON,
} from "../plugins/oh-my-teams/scripts/core.mjs";
import { OPENCODEX_RUNNER_PROVIDERS } from "../plugins/oh-my-teams/scripts/opencodex.mjs";

const fingerprint = `sha256:${"a".repeat(64)}`;

const baseOrg = {
  schemaVersion: 1,
  name: "test-org",
  revision: 1,
  profiles: {
    "claude-pm": {
      provider: "claude",
      command: ["claude"],
      account: "current",
      subscription: "User-selected Claude subscription",
      model: null,
    },
    "codex-fixed": {
      provider: "codex",
      command: ["codex"],
      account: "codex-fixed",
      subscription: "User-selected Codex subscription",
      model: "gpt-6-astra",
      runner: {
        kind: "opencodex",
        mode: "fixed-account",
        accountHomeRef: "codex-fixed",
        runtimeFingerprint: fingerprint,
      },
    },
  },
  roles: {
    pm: {
      profile: "claude-pm",
      concurrency: 1,
      attempts: 1,
      parent: null,
      fallbacks: [],
    },
  },
  policy: {
    onExhaustion: "stop",
    maxCalls: 5,
    timeoutMs: 30000,
    repeatFailureLimit: 1,
  },
};

test("codex runner profile passes validation", () => {
  const org = {
    ...baseOrg,
    profiles: {
      ...baseOrg.profiles,
      "codex-fixed": {
        ...baseOrg.profiles["codex-fixed"],
        provider: "codex",
      },
    },
  };
  assert.doesNotThrow(() => {
    validateOrg(org);
  });
});

test("claude provider with runner is rejected in validation", () => {
  const org = {
    ...baseOrg,
    profiles: {
      ...baseOrg.profiles,
      "claude-fixed": {
        provider: "claude",
        command: ["claude"],
        account: "claude-fixed",
        subscription: "User-selected Claude subscription",
        model: "claude-3-5-sonnet-20241022",
        runner: {
          kind: "opencodex",
          mode: "fixed-account",
          accountHomeRef: "claude-fixed",
          runtimeFingerprint: fingerprint,
        },
      },
    },
    roles: {
      pm: {
        profile: "claude-fixed",
        concurrency: 1,
        attempts: 1,
        parent: null,
        fallbacks: [],
      },
    },
  };
  assert.throws(
    () => validateOrg(org),
    /does not support runners|Invalid OpenCodex runner binding/,
  );
});

test("agy provider with runner is rejected in validation", () => {
  const org = {
    ...baseOrg,
    profiles: {
      ...baseOrg.profiles,
      "agy-fixed": {
        provider: "agy",
        command: ["agy"],
        account: "agy-fixed",
        subscription: "User-selected Agy subscription",
        model: "gemini-2.0-flash",
        runner: {
          kind: "opencodex",
          mode: "fixed-account",
          accountHomeRef: "agy-fixed",
          runtimeFingerprint: fingerprint,
        },
      },
    },
    roles: {
      pm: {
        profile: "agy-fixed",
        concurrency: 1,
        attempts: 1,
        parent: null,
        fallbacks: [],
      },
    },
  };
  assert.throws(
    () => validateOrg(org),
    /does not support runners|Invalid OpenCodex runner binding/,
  );
});

test("profile without runner is not affected by provider check", () => {
  const org = {
    ...baseOrg,
    profiles: {
      ...baseOrg.profiles,
      "claude-pm": {
        ...baseOrg.profiles["claude-pm"],
        provider: "claude",
      },
    },
  };
  assert.doesNotThrow(() => {
    validateOrg(org);
  });
});

test("save and validate commands reject unsupported runner providers", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omt-runner-test-"));
  try {
    const orgFile = path.join(tmpDir, "org.json");
    const invalidOrg = {
      ...baseOrg,
      profiles: {
        ...baseOrg.profiles,
        "claude-fixed": {
          provider: "claude",
          command: ["claude"],
          account: "claude-fixed",
          subscription: "User-selected Claude subscription",
          model: "claude-3-5-sonnet-20241022",
          runner: {
            kind: "opencodex",
            mode: "fixed-account",
            accountHomeRef: "claude-fixed",
            runtimeFingerprint: fingerprint,
          },
        },
      },
      roles: {
        pm: {
          profile: "claude-fixed",
          concurrency: 1,
          attempts: 1,
          parent: null,
          fallbacks: [],
        },
      },
    };

    // Attempt to save organization with invalid runner provider
    assert.throws(() => {
      saveOrg(orgFile, invalidOrg);
    }, /does not support runners|Invalid OpenCodex runner binding/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OPENCODEX_RUNNER_PROVIDERS contains only supported providers", () => {
  assert.ok(Array.isArray(OPENCODEX_RUNNER_PROVIDERS));
  assert.ok(Object.isFrozen(OPENCODEX_RUNNER_PROVIDERS));
  assert.deepEqual(OPENCODEX_RUNNER_PROVIDERS, ["codex"]);
});
