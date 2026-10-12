/** Role worktree creation, reuse, reclaim, and auditor launch boundaries. */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  AUDITOR_ROLE,
  readJSON,
  ROOT_ROLE,
  validateOrg,
} from "./core.mjs";
import { PERMISSION_BYPASS, roleCommand } from "./role-launch.mjs";
import { fetchModelCatalog, revalidateModelChoices } from "./model-catalog.mjs";
import { assertModelAssignmentChoice } from "./model-assignment.mjs";
import { assertDirectorAuthority } from "./delivery.mjs";
import { openRoleTerminal, readLaunchEnvironment } from "./role-terminal.mjs";
import { predictLaunchPath } from "./launch-matrix.mjs";
import { git as gitEvidence, verify } from "./evidence.mjs";
import {
  checkTerminalIdle,
  createWorktreeWithRoleSession,
  findActiveDispatch,
  isTrustedOrcaExecute,
  readTrustedOrcaVersion,
  reclaimWorktree,
  releaseWorker,
  resolveTrustedOrcaScriptPath,
  runOrcaJson,
  selectOrcaExecutable,
  trustedOrcaExecute,
  TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
} from "./orca-adapter.mjs";
import { prepareRoleLifecycle } from "./worktree-legacy.mjs";
import { withAutomaticWorktreeReuse } from "./worktree-reuse.mjs";
import { assertChildWorktreeCapacity } from "./worktree-limit.mjs";
import {
  withWorktreeLock,
  readWorktreeTransitions,
} from "./worktree-transactions.mjs";
import { readWorkflow } from "./workflow.mjs";
import {
  isSameOrWithinByIdentity,
  listKickoffs,
  sharesWorktreeWithAny,
} from "./kickoff-registry.mjs";
import { scanKickoffCleanup } from "./kickoff-cleanup.mjs";
import {
  readLaunches,
  readTerminalClosures,
  recordTerminalClosure,
} from "./usage-ledger.mjs";

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

const pmBootstrapSelectionSchemaFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../schemas/pm-bootstrap-selection.schema.json",
);

function assertPmBootstrapSchema(value, schema, location = "selection") {
  const typeMatches = {
    object:
      value !== null && typeof value === "object" && !Array.isArray(value),
    array: Array.isArray(value),
    string: typeof value === "string",
    integer: Number.isInteger(value),
  };
  if (schema.type)
    assert(
      typeMatches[schema.type],
      `PM bootstrap selection schema rejects ${location}: expected ${schema.type}`,
    );
  if (schema.const !== undefined)
    assert(
      value === schema.const,
      `PM bootstrap selection schema rejects ${location}: expected ${JSON.stringify(schema.const)}`,
    );
  if (schema.type === "string") {
    if (schema.minLength !== undefined)
      assert(
        value.length >= schema.minLength,
        `PM bootstrap selection schema rejects ${location}: string is too short`,
      );
    if (schema.pattern !== undefined)
      assert(
        new RegExp(schema.pattern).test(value),
        `PM bootstrap selection schema rejects ${location}: pattern mismatch`,
      );
    return;
  }
  if (schema.type === "integer" && schema.minimum !== undefined) {
    assert(
      value >= schema.minimum,
      `PM bootstrap selection schema rejects ${location}: value is below minimum`,
    );
    return;
  }
  if (schema.type === "array") {
    if (schema.minItems !== undefined)
      assert(
        value.length >= schema.minItems,
        `PM bootstrap selection schema rejects ${location}: too few items`,
      );
    if (schema.uniqueItems)
      assert(
        new Set(value.map((item) => JSON.stringify(item))).size ===
          value.length,
        `PM bootstrap selection schema rejects ${location}: duplicate items`,
      );
    if (schema.items)
      value.forEach((item, index) =>
        assertPmBootstrapSchema(item, schema.items, `${location}[${index}]`),
      );
    return;
  }
  if (schema.type === "object") {
    for (const key of schema.required ?? [])
      assert(
        Object.hasOwn(value, key),
        `PM bootstrap selection schema rejects ${location}: missing ${key}`,
      );
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        assert(
          Object.hasOwn(schema.properties ?? {}, key),
          `PM bootstrap selection schema rejects ${location}: unexpected ${key}`,
        );
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(value, key))
        assertPmBootstrapSchema(value[key], child, `${location}.${key}`);
  }
}

/**
 * Reads and revalidates the director's one-time resource choice before the
 * first PM worktree exists.  The input remains evidence only: both the live
 * organization bytes and a freshly fetched catalog must still agree with it.
 *
 * @param {object} args - Parsed role-worktree-create arguments.
 * @param {object} org - Current validated organization.
 * @param {object} ports - Catalog ports used by focused tests.
 * @returns {Promise<object>} Frozen selection and its input digest.
 */
async function validatePmBootstrapSelection(
  args,
  org,
  {
    catalog = fetchModelCatalog,
    revalidate = revalidateModelChoices,
    callerCwd = process.cwd(),
    readFile = fs.readFileSync,
  } = {},
) {
  assert(args.role === ROOT_ROLE, "--pm-selection is only valid for role pm");
  assert(
    org.resources,
    "--pm-selection is only valid for a resource organization",
  );
  assert(
    !args.state &&
      !args["workflow-id"] &&
      !args["workflow-task"] &&
      !args.worktree,
    "--pm-selection is only valid while creating the first PM worktree",
  );
  assert(
    path.resolve(args.repo) === path.resolve(callerCwd),
    "The first PM selection must be validated from the director checkout named by --repo",
  );
  const bytes = readFile(path.resolve(args["pm-selection"]));
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  let selection;
  try {
    selection = JSON.parse(text);
  } catch {
    throw new Error("PM bootstrap selection must be valid JSON");
  }
  assertPmBootstrapSchema(selection, readJSON(pmBootstrapSelectionSchemaFile));
  assert(
    selection.organization.revision === org.revision &&
      selection.organization.sha256 ===
        sha256(readFile(path.resolve(args.org))),
    "PM bootstrap selection organization revision or SHA256 has drifted",
  );
  const choice = selection.choice;
  const resource = org.resources[choice.resourceId];
  assert(resource, `PM bootstrap resource ${choice.resourceId} is unknown`);
  assert(
    selection.allowedResources.includes(choice.resourceId) &&
      selection.allowedPools.includes(resource.pool),
    "PM bootstrap selection is outside the director-approved resource or pool",
  );
  assert(
    typeof choice.model === "string" && choice.model.trim(),
    "PM bootstrap model is required",
  );
  assertModelAssignmentChoice(org, "pm", choice);
  const catalogResult = revalidate(await catalog(), [
    {
      key: "pm-bootstrap",
      provider: resource.provider,
      model: choice.model,
      ...(choice.effort === undefined ? {} : { effort: choice.effort }),
      catalogRevision: selection.catalog.providerRevision,
      touched: true,
    },
  ]);
  assert(
    catalogResult.savable && catalogResult.selections?.[0]?.savable,
    "PM bootstrap selection no longer passes catalog verification",
  );
  assert(
    catalogResult.catalogRevision === selection.catalog.catalogRevision &&
      catalogResult.providerRevisions?.[resource.provider] ===
        selection.catalog.providerRevision,
    "PM bootstrap selection catalog revision has drifted",
  );
  return {
    inputSha256: sha256(text),
    selection: {
      choice: structuredClone(choice),
      allowedResources: [...selection.allowedResources],
      allowedPools: [...selection.allowedPools],
      reason: selection.reason.trim(),
      organization: structuredClone(selection.organization),
      catalog: structuredClone(selection.catalog),
    },
  };
}

/** Parses the comma-separated `--host-default` flag into a profile id list. */
async function preflightRoleWorktree(
  args,
  organization,
  environment,
  matrix,
  trustedLaunch = null,
  workflowRun = {},
) {
  const command = roleCommand(organization, args.role, {
    profile: args.profile,
    ...workflowRun,
  });
  const worktreePath = args.worktree
    ? pathFromWorktreeId(args.worktree)
    : undefined;
  // The auditor reads its environment exactly as role-terminal's auditor
  // branch does, through the launch's own trusted runner and never args.orca.
  const env = await environment(
    trustedLaunch
      ? {
          worktreePath,
          orcaExecutable: trustedLaunch.versionExecutable,
          ...auditorLaunchEnvironmentInputs(trustedLaunch.execute),
        }
      : { worktreePath, orcaExecutable: args.orca },
  );
  const prediction = matrix({
    runner: command.provider,
    model: command.modelRequested,
    platform: env.platform,
    shell: env.shell,
    trustRecordExists: env.trustRecordExists,
    codexTrustRecordExists: env.codexTrustRecordExists,
    skipDangerousModePermissionPrompt: Boolean(
      PERMISSION_BYPASS[command.provider],
    ),
    orcaVersion: env.orcaVersion,
    cliVersion: env.cliVersion,
    isCompoundCommand: false,
  });
  assert(
    prediction.path !== "blocked",
    `Role ${args.role} is refused by the launch matrix before worktree creation: ${prediction.reason.join(", ")}. ${prediction.nextAction}`,
  );
  return { command, prediction };
}

function receiptBody(receipt) {
  return receipt?.result ?? receipt ?? {};
}

function assertReleasedReceipt(receipt, dispatchId) {
  const release = receiptBody(receipt);
  const evidence = JSON.stringify(release);
  assert(
    release.dispatchId === dispatchId &&
      release.state === "retained" &&
      release.reason === "external_terminal" &&
      release.processAction === "none" &&
      !evidence.includes("terminal_stop_unverifiable") &&
      !evidence.includes("terminalStopUnverifiable"),
    `Dispatch ${dispatchId} was not conclusively released as an external terminal; preserve its worktree`,
  );
}

function assertClosedReceipt(receipt, terminal) {
  const body = receiptBody(receipt);
  const close = body.close;
  const evidence = JSON.stringify(body);
  const hasTabId =
    (typeof close?.tabId === "string" && close.tabId.length > 0) ||
    Number.isInteger(close?.tabId);
  assert(
    close?.handle === terminal &&
      hasTabId &&
      close.ptyKilled === true &&
      !/"ptyKilled"\s*:\s*false/.test(evidence) &&
      !evidence.includes("terminal_stop_unverifiable") &&
      !evidence.includes("terminalStopUnverifiable"),
    `Terminal ${terminal} did not prove its own PTY termination; preserve its worktree`,
  );
}

async function listWorktreeTerminals({ repo, worktreeId, orca, list }) {
  const listed = await list(
    selectOrcaExecutable(orca),
    ["terminal", "list", "--worktree", `id:${worktreeId}`],
    { cwd: repo },
  );
  const terminals = receiptBody(listed).terminals;
  assert(
    Array.isArray(terminals) &&
      !receiptBody(listed).truncated &&
      !receiptBody(listed).hostScope?.omittedHostIds?.length,
    "Orca did not prove the worktree terminal list; preserve the worktree",
  );
  return { terminals, receipt: listed };
}

function closureProvesTerminal(
  closure,
  worktreeId,
  worktreePath,
  entry,
  identity,
) {
  if (
    identity &&
    (closure.identity?.key !== identity.key ||
      !closure.at ||
      !entry.at ||
      closure.at < entry.at)
  )
    return false;
  if (
    closure?.worktreeId !== worktreeId ||
    path.resolve(closure.worktreePath ?? "") !== worktreePath ||
    !Array.isArray(closure.terminals)
  )
    return false;
  const terminal = closure.terminals.find(
    (candidate) => candidate?.terminal === entry.terminal,
  );
  if (
    !terminal ||
    terminal.dispatch?.result?.status !== "clear" ||
    !Array.isArray(terminal.releases)
  )
    return false;
  try {
    assertClosedReceipt(terminal.close?.receipt, entry.terminal);
    for (const dispatchId of entry.workerIds) {
      const release = terminal.releases.find(
        (candidate) => candidate?.dispatchId === dispatchId,
      );
      assertReleasedReceipt(release?.receipt, dispatchId);
    }
    const after = receiptBody(closure.afterReceipt).terminals;
    return Array.isArray(after) && after.length === 0;
  } catch {
    return false;
  }
}

function ownedTerminals(
  launches,
  closures,
  worktreeId,
  worktreePath,
  identity,
) {
  const byTerminal = new Map();
  for (const entry of launches) {
    if (
      entry.via !== "worker-start" ||
      typeof entry.terminal !== "string" ||
      typeof entry.workerId !== "string" ||
      path.resolve(entry.worktreePath ?? "") !== worktreePath
    )
      continue;
    const owned = byTerminal.get(entry.terminal) ?? {
      terminal: entry.terminal,
      workerIds: [],
    };
    if (entry.at && (!owned.at || entry.at > owned.at)) owned.at = entry.at;
    if (!owned.workerIds.includes(entry.workerId))
      owned.workerIds.push(entry.workerId);
    byTerminal.set(entry.terminal, owned);
  }
  return [...byTerminal.values()].filter(
    (entry) =>
      !closures.some((closure) =>
        closureProvesTerminal(
          closure,
          worktreeId,
          worktreePath,
          entry,
          identity,
        ),
      ),
  );
}

async function proveAndCloseOwnedTerminals({
  repo,
  worktreeId,
  worktreePath,
  orca,
  launches,
  closures,
  identity,
  active,
  release,
  close,
  list,
}) {
  const owned = ownedTerminals(
    launches,
    closures,
    worktreeId,
    worktreePath,
    identity,
  );
  const historical = ownedTerminals(launches, [], worktreeId, worktreePath);
  assert(
    owned.length > 0 || (identity && historical.length > 0),
    "No owned Dispatch and terminal receipt matches this role worktree; preserve it for reconciliation",
  );
  const dispatchesByTerminal = new Map();
  for (const entry of owned) {
    const dispatch = await active(entry.terminal, {
      executable: orca,
      cwd: repo,
    });
    assert(
      dispatch.status === "clear",
      `Role terminal ${entry.terminal} is ${dispatch.status}; do not reuse or reclaim its worktree`,
    );
    dispatchesByTerminal.set(entry.terminal, dispatch);
  }
  const before = await listWorktreeTerminals({ repo, worktreeId, orca, list });
  const expected = new Set(owned.map((entry) => entry.terminal));
  const actual = new Set(
    before.terminals
      .map((terminal) => terminal?.handle)
      .filter((handle) => typeof handle === "string"),
  );
  assert(
    before.terminals.length === actual.size &&
      actual.size === expected.size &&
      [...actual].every((handle) => expected.has(handle)),
    "Another or unowned terminal is connected to this worktree; preserve it without closing that session",
  );
  const released = [];
  for (const entry of owned) {
    for (const dispatchId of entry.workerIds) {
      const receipt = await release(dispatchId, {
        executable: orca,
        cwd: repo,
      });
      assertReleasedReceipt(receipt, dispatchId);
      released.push({ dispatchId, receipt });
    }
  }
  const closed = [];
  for (const entry of owned) {
    const receipt = await close(
      selectOrcaExecutable(orca),
      ["terminal", "close", "--terminal", entry.terminal],
      { cwd: repo },
    );
    assertClosedReceipt(receipt, entry.terminal);
    closed.push({ terminal: entry.terminal, receipt });
  }
  const after = await listWorktreeTerminals({ repo, worktreeId, orca, list });
  assert(
    after.terminals.length === 0,
    "A connected terminal remains after close; preserve the worktree",
  );
  return {
    worktreeId,
    worktreePath,
    ...(identity ? { identity } : {}),
    terminals: owned.map((entry) => ({
      terminal: entry.terminal,
      workerIds: entry.workerIds,
      dispatch: {
        terminal: entry.terminal,
        result: dispatchesByTerminal.get(entry.terminal),
      },
      releases: released.filter((item) =>
        entry.workerIds.includes(item.dispatchId),
      ),
      close: closed.find((item) => item.terminal === entry.terminal),
    })),
    beforeReceipt: before.receipt,
    afterReceipt: after.receipt,
    released,
    closed,
  };
}

/**
 * Resolves a path's `fs.realpathSync.native` form, or `null` when the path
 * cannot be resolved (missing, or a broken symlink). A binding check that
 * cannot verify a path must refuse rather than fall through on a lucky string
 * match, so callers treat `null` as a mismatch, never a pass-through.
 *
 * @param {string} candidate - Path to resolve.
 * @returns {string | null} Resolved path, or `null` if resolution fails.
 */
export function realpathOrNull(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

/**
 * Reports whether `child` is `parent` itself, or sits anywhere inside it, by
 * filesystem identity. Unlike a plain string comparison, this survives a
 * symlink or path respelling; unlike {@link isSameOrWithinByIdentity} used
 * directly, an unresolvable path on either side counts as a mismatch instead
 * of throwing.
 *
 * @param {string} parent - Candidate ancestor directory.
 * @param {string} child - Candidate descendant (or the same) directory.
 * @returns {boolean} Whether `child` is `parent` itself or beneath it.
 */
export function identicalOrWithin(parent, child) {
  const parentReal = realpathOrNull(parent);
  const childReal = realpathOrNull(child);
  if (parentReal === null || childReal === null) return false;
  return isSameOrWithinByIdentity(parentReal, childReal);
}

/**
 * Applies the direct role-terminal binding table (D2/부록 F) to a non-auditor
 * launch: decides which registered kickoff, if any, owns `target`, and
 * refuses when the caller's --state or cwd disagrees with that ownership. A
 * caller-supplied --state is never trusted on its own (D2, msg_c9d1afb03fd4)
 * -- only the target worktree's own identity or an earlier role-terminal
 * ledger line recorded there establishes the binding. Skipped entirely when
 * no kickoff is registered in this organization at all.
 *
 * @param {object} params
 * @param {string} params.org - Organization JSON path (unresolved).
 * @param {string | null} params.target - Resolved --worktree directory, or
 *   `null` when the selector names no directory yet.
 * @param {object} params.args - Parsed `role-terminal` command arguments.
 * @returns {void}
 */
export function assertDirectRoleTerminalBinding({ org, target, args }) {
  const orgPath = path.resolve(org);
  const { kickoffs } = listKickoffs(orgPath);
  if (kickoffs.length === 0) return;
  const stateDir = args.state ? path.resolve(args.state) : null;
  const statedEntry = stateDir
    ? kickoffs.find(
        (candidate) => path.resolve(candidate.pm.stateDir) === stateDir,
      )
    : null;
  assert(
    stateDir === null || statedEntry,
    `No kickoff is registered with pm state directory ${stateDir}`,
  );
  assert(
    target,
    "role-terminal needs a resolvable --worktree while a kickoff is active in this organization",
  );
  const pmEntry = kickoffs.find((candidate) =>
    identicalOrWithin(candidate.pm.path, target),
  );
  if (pmEntry) {
    if (stateDir) {
      assert(
        statedEntry === pmEntry,
        `--state ${args.state} does not name the kickoff (${pmEntry.pm.worktreeId}) this worktree belongs to`,
      );
    } else {
      const callerCwdReal = realpathOrNull(process.cwd());
      const pmPathReal = realpathOrNull(pmEntry.pm.path);
      assert(
        callerCwdReal !== null &&
          pmPathReal !== null &&
          callerCwdReal === pmPathReal,
        `role-terminal without --state may only be opened from kickoff ${pmEntry.pm.worktreeId}'s own PM ` +
          "worktree; run it from that directory, or pass --state naming the kickoff you intend",
      );
    }
    return;
  }
  const activeWorktreeIds = new Set(
    kickoffs.map((candidate) => candidate.pm.worktreeId),
  );
  const bindingLaunch = readLaunches(orgPath).findLast(
    (line) =>
      line.via === "role-terminal" &&
      line.kickoffPmWorktreeId &&
      activeWorktreeIds.has(line.kickoffPmWorktreeId) &&
      line.worktreePath &&
      identicalOrWithin(line.worktreePath, target),
  );
  // A brand-new, never-before-seen child has no binding evidence at all; only
  // role-worktree-create's own internal open (viaRoleWorktreeCreate, never
  // reachable through the CLI) may open its first session.
  assert(
    bindingLaunch || args.viaRoleWorktreeCreate === true,
    `This launch (worktree ${target}) cannot be tied to any registered kickoff by sitting inside its PM ` +
      "worktree or by an earlier role-terminal launch recorded there; open it with role-worktree-create first",
  );
  if (bindingLaunch) {
    assert(
      statedEntry?.pm.worktreeId === bindingLaunch.kickoffPmWorktreeId,
      `--state must name the kickoff (${bindingLaunch.kickoffPmWorktreeId}) this worktree is already bound to`,
    );
  }
}

/**
 * Lists the worktree paths recorded by the workflow tasks under a kickoff's PM
 * state directory: the path half of each task's `<repo-id>::<path>` receipt.
 * A worker that never wrote a launch-ledger line still shows up here. A
 * workflow state that exists but cannot be read is a refusal, not a skipped
 * entry, so a corrupt state cannot silently shrink the independence check.
 *
 * @param {string} stateDir - The kickoff's PM `.omt` state directory.
 * @returns {string[]} Receipt worktree paths of every workflow task.
 * @throws {Error} With `preCreateRefusal` when a workflow state cannot be read.
 */
function workflowReceiptWorktreePaths(stateDir) {
  const root = path.join(stateDir, "workflows");
  if (!fs.existsSync(root)) return [];
  const paths = [];
  for (const name of fs.readdirSync(root)) {
    // Only a directory is a workflow; a stray file (e.g. .DS_Store) is not.
    if (!fs.lstatSync(path.join(root, name)).isDirectory()) continue;
    const file = path.join(root, name, "state.json");
    let state;
    try {
      state = readJSON(file);
      assert(
        state?.tasks !== null &&
          typeof state?.tasks === "object" &&
          !Array.isArray(state.tasks),
        "malformed state",
      );
    } catch (error) {
      const refusal = new Error(
        `The auditor cannot be placed: workflow ${name} under ${stateDir} cannot be read (${error.message}), ` +
          "so its workers' worktrees cannot be ruled out",
      );
      refusal.preCreateRefusal = { reason: "auditor-independence" };
      throw refusal;
    }
    for (const item of Object.values(state.tasks)) {
      for (const worktreeId of [
        item?.worktreeId,
        item?.execution?.worktreeId,
      ]) {
        const separator = String(worktreeId ?? "").indexOf("::");
        if (separator > 0) paths.push(String(worktreeId).slice(separator + 2));
      }
    }
  }
  return paths;
}

/**
 * Lists the paths a kickoff's auditor worktree must stay independent of: the
 * kickoff's own PM worktree, every non-auditor worktree this same kickoff has
 * already launched, and every worktree a workflow task of this kickoff
 * recorded in its receipt, so a worker absent from the launch ledger is still
 * covered. Shared by role-terminal's own D4 check and createRoleWorktree's
 * pre-open D4 check (director msg_e96fa626ec49, msg_8c39242a6c89), so both
 * compare against the same list.
 *
 * @param {string} orgFile - Resolved organization.json path.
 * @param {object} auditorEntry - The audited kickoff's registry entry.
 * @returns {string[]} Paths the auditor's own target must not share identity with.
 * @throws {Error} With `preCreateRefusal` when a workflow state cannot be read.
 */
export function auditorIndependenceForbiddenPaths(orgFile, auditorEntry) {
  return [
    auditorEntry.pm.path,
    ...readLaunches(orgFile)
      .filter(
        (line) =>
          line.kickoffPmWorktreeId === auditorEntry.pm.worktreeId &&
          line.role !== AUDITOR_ROLE &&
          line.worktreePath,
      )
      .map((line) => line.worktreePath),
    ...workflowReceiptWorktreePaths(auditorEntry.pm.stateDir),
  ];
}

/**
 * Creates one Orca child worktree only as part of opening its role session.
 * The callback reuses the same `role-terminal` implementation exposed by the
 * CLI, so a new operational path cannot accidentally bypass session proof.
 *
 * @param {object} args - Parsed `role-worktree-create` command arguments.
 * @param {object} [ports] - Injectable ports for focused lifecycle tests.
 * @param {Function} [ports.create=createWorktreeWithRoleSession] - Creator.
 * @param {Function} [ports.open] - Role-terminal opener.
 * @param {Function} [ports.read=readWorkflow] - Workflow-state reader.
 * @param {Function} [ports.git=gitEvidence] - Git evidence reader.
 * @param {Function} [ports.closures=readTerminalClosures] - Durable closure-proof reader.
 * @param {Function} [ports.recordClosure=recordTerminalClosure] - Closure-proof writer.
 * @param {Function} [ports.auditorLaunch=resolveAuditorLaunchExecution] - Builds the auditor's one trusted runner, for tests only.
 * @returns {Promise<object>} Worktree identity and proven role terminal.
 */
export async function createRoleWorktree(args, ports = {}) {
  const current = args.state
    ? listKickoffs(path.resolve(args.org)).kickoffs.find(
        (entry) => path.resolve(entry.pm.stateDir) === path.resolve(args.state),
      )
    : null;
  if (current && args["workflow-id"] && args["workflow-task"]) {
    const snapshot = (ports.read ?? readWorkflow)(
      path.resolve(args.state),
      args["workflow-id"],
    );
    const task = snapshot.state.tasks[args["workflow-task"]];
    assert(task, "Automatic reuse requires an existing target task");
    assert(
      fs.realpathSync(args.repo) === fs.realpathSync(current.pm.path),
      `--repo ${args.repo} does not match kickoff ${current.pm.worktreeId}'s PM worktree ${current.pm.path}`,
    );
    assert(
      fs.realpathSync(ports.callerCwd ?? process.cwd()) ===
        fs.realpathSync(current.pm.path),
      "Automatic reuse must run in the registered PM checkout",
    );
    assert(
      task.role === args.role,
      "Automatic reuse target execution role mismatch",
    );
    await preflightRoleWorktree(
      args,
      snapshot.organization,
      ports.environment ?? readLaunchEnvironment,
      ports.matrix ?? predictLaunchPath,
      null,
      {
        ...(snapshot.state.roles ? { roles: snapshot.state.roles } : {}),
        ...(snapshot.state.staffing
          ? { staffing: snapshot.state.staffing }
          : {}),
        workflowTask: args["workflow-task"],
        workflowState: snapshot.state,
      },
    );
    const existing = task.worktreeId ?? task.execution?.worktreeId;
    if (!existing) {
      const reuseArgs = { ...args };
      delete reuseArgs["fresh-reason"];
      return withAutomaticWorktreeReuse(
        {
          orgFile: args.org,
          stateDir: args.state,
          workflowId: args["workflow-id"],
          taskId: args["workflow-task"],
          role: args.role,
          repo: args.repo,
          base: args.base,
          executable: args.orca,
          selectedWorktreeId: args.worktree,
        },
        (source, prepare, reuseRejections) =>
          createRoleWorktreeUnderLock(
            source
              ? {
                  ...reuseArgs,
                  worktree: source.worktreeId,
                }
              : args,
            {
              ...ports,
              lifecycle: { prepare, current },
              reuseRejections,
              automaticSource: source
                ? {
                    workflowId: source.workflowId,
                    taskId: source.taskId,
                    task: source.task,
                  }
                : null,
            },
          ),
        ports.reuse,
      );
    }
  }
  if (fs.existsSync(args.org)) {
    return withWorktreeLock(args.org, (prepare) =>
      createRoleWorktreeUnderLock(args, {
        ...ports,
        lifecycle: { prepare, current },
      }),
    );
  }
  return createRoleWorktreeUnderLock(args, ports);
}

async function createRoleWorktreeUnderLock(
  args,
  {
    create = createWorktreeWithRoleSession,
    automaticSource = null,
    reuseRejections = [],
    lifecycle,
    show = runOrcaJson,
    scan = scanKickoffCleanup,
    open,
    executeCommand,
    read = readWorkflow,
    git = gitEvidence,
    organization = (orgFile) => validateOrg(readJSON(orgFile)),
    environment = readLaunchEnvironment,
    matrix = predictLaunchPath,
    launches = readLaunches,
    closures = readTerminalClosures,
    recordClosure = (evidence) => recordTerminalClosure(args.org, evidence),
    active = findActiveDispatch,
    release = releaseWorker,
    close = runOrcaJson,
    list = runOrcaJson,
    auditorLaunch = resolveAuditorLaunchExecution,
    catalog = fetchModelCatalog,
    revalidate = revalidateModelChoices,
    callerCwd = process.cwd(),
  } = {},
) {
  // The auditor is out-of-ladder (role-terminal's own comment: it never
  // folds, never runs a workflow), so it takes none of the workflow-task
  // reuse machinery below: --state alone names the audited
  // kickoff, exactly as role-terminal --role auditor itself requires, and
  // creation always makes a brand-new worktree (never --worktree reuse),
  // so its session proof is one unit with its creation (audit-worktree-create-path).
  const isAuditorRole = args.role === AUDITOR_ROLE;
  if (isAuditorRole) {
    assert(
      args.state &&
        args["workflow-id"] === undefined &&
        args["workflow-task"] === undefined &&
        args["prior-workflow-id"] === undefined &&
        args["prior-task-id"] === undefined &&
        args.worktree === undefined,
      "role-worktree-create --role auditor requires --state naming the audited kickoff's PM state directory, " +
        "and accepts none of --workflow-id/--workflow-task/--prior-workflow-id/--prior-task-id/--worktree " +
        "(the auditor never runs a workflow and always opens a brand-new worktree)",
    );
    // Mirrors role-terminal --role auditor's own --orca refusal (B.6, decision
    // B): this preflight step reads a launch environment through args.orca
    // before role-terminal's own trusted-executable check ever runs, so the
    // same refusal must happen here too, not only downstream.
    assert(
      args.orca === undefined,
      "role-worktree-create --role auditor does not accept --orca; the auditor launch always uses the trusted Orca executable",
    );
  }
  const workflowOptions = [
    args["workflow-id"] !== undefined,
    args["workflow-task"] !== undefined,
    args.state !== undefined,
  ];
  const hasWorkflow = !isAuditorRole && workflowOptions.some(Boolean);
  assert(
    !hasWorkflow || workflowOptions.every(Boolean),
    "--workflow-id, --workflow-task, and --state must be provided together",
  );
  assert(
    args["pm-selection"] === undefined || args.role === ROOT_ROLE,
    "--pm-selection is only valid for role pm",
  );
  const sourceWorkflowId = args["prior-workflow-id"];
  const sourceWorkflowTask = args["prior-task-id"];
  assert(
    Boolean(sourceWorkflowId) === Boolean(sourceWorkflowTask),
    "--prior-workflow-id and --prior-task-id must be provided together",
  );
  assert(
    !sourceWorkflowId || args.worktree,
    "A prior workflow/task is only valid when reusing its --worktree",
  );
  assert(
    !sourceWorkflowId ||
      (args["workflow-id"] && args["workflow-task"] && args.state),
    "Cross-workflow reuse requires the current --workflow-id, --workflow-task, and --state",
  );
  assert(
    args["fresh-reason"] === undefined ||
      (hasWorkflow &&
        !args.worktree &&
        typeof args["fresh-reason"] === "string" &&
        args["fresh-reason"].trim()),
    "--fresh-reason is only valid for a new workflow child and must explain why reuse is unavailable",
  );
  let reusable = automaticSource;
  let snapshot = null;
  let state = null;
  let task = null;
  let freshSelection = null;
  if (hasWorkflow) {
    snapshot = read(path.resolve(args.state), args["workflow-id"]);
    state = snapshot?.state;
    assert(
      state?.tasks && typeof state.tasks === "object",
      `Workflow ${args["workflow-id"]} has no readable task state`,
    );
    task = state.tasks[args["workflow-task"]];
    assert(task, `Unknown workflow task ${args["workflow-task"]}`);
    const existing = task?.worktreeId ?? task?.execution?.worktreeId;
    const assignedRole = task.role;
    assert(
      assignedRole === args.role,
      `Workflow task ${args["workflow-task"]} is assigned to ${assignedRole ?? "no role"}, not ${args.role}`,
    );
    assert(
      !existing,
      `Task ${args["workflow-task"]} already has worktree ${existing}; reuse it with role-terminal instead of creating another`,
    );
    if (args.worktree && !automaticSource) {
      let source = null;
      if (sourceWorkflowId) {
        const sourceState =
          sourceWorkflowId === args["workflow-id"]
            ? state
            : read(path.resolve(args.state), sourceWorkflowId).state;
        assert(
          sourceState?.tasks && typeof sourceState.tasks === "object",
          `Prior workflow ${sourceWorkflowId} has no readable task state`,
        );
        source = {
          workflowId: sourceWorkflowId,
          taskId: sourceWorkflowTask,
          state: sourceState,
        };
      }
      const prior = source
        ? [source.taskId, source.state.tasks[source.taskId]]
        : Object.entries(state.tasks).find(
            ([taskId, item]) =>
              taskId !== args["workflow-task"] &&
              item.state === "accepted" &&
              (item.worktreeId ?? item.execution?.worktreeId) ===
                args.worktree &&
              (item.executionRole ?? item.role) === args.role,
          );
      assert(
        prior?.[1]?.state === "accepted" &&
          (prior[1].worktreeId ?? prior[1].execution?.worktreeId) ===
            args.worktree &&
          (prior[1].executionRole ?? prior[1].role) === args.role,
        source
          ? "The explicit prior workflow/task must be accepted, use this worktree, and match the execution role"
          : "A reused role worktree needs an accepted prior task of the same execution role",
      );
      reusable = {
        workflowId: source?.workflowId ?? args["workflow-id"],
        taskId: prior[0],
        task: prior[1],
      };
      const conflictingTask = Object.entries(state.tasks).find(
        ([taskId, item]) =>
          taskId !== args["workflow-task"] &&
          taskId !== reusable.taskId &&
          (item.worktreeId ?? item.execution?.worktreeId) === args.worktree,
      );
      assert(
        !conflictingTask,
        `Worktree ${args.worktree} is also owned by current workflow task ${conflictingTask?.[0]}; preserve it instead of opening another role session`,
      );
    }
    if (!args.worktree) {
      const acceptedSameRole = Object.entries(state.tasks)
        .filter(
          ([taskId, item]) =>
            taskId !== args["workflow-task"] &&
            item.state === "accepted" &&
            (item.executionRole ?? item.role) === args.role &&
            (item.worktreeId ?? item.execution?.worktreeId),
        )
        .map(([taskId, item]) => ({
          taskId,
          worktreeId: item.worktreeId ?? item.execution?.worktreeId,
        }));
      assert(
        args["fresh-reason"],
        `A new workflow child requires --fresh-reason explaining why a separate worktree is needed ` +
          `(accepted same-role tasks: ${acceptedSameRole.map((item) => item.taskId).join(", ") || "none"})`,
      );
      freshSelection = {
        schemaVersion: 1,
        decision: "new-child",
        scope: "current-workflow-and-automatic-discovery",
        workflowId: args["workflow-id"],
        workflowTaskId: args["workflow-task"],
        role: args.role,
        currentWorkflowAcceptedSameRole: acceptedSameRole,
        reuseRejections,
        isolationReason: args["fresh-reason"].trim(),
      };
    }
  }
  // A workflow freezes its organization. This happens only after task and
  // role ownership are proven, and before any Orca create/open/release/close
  // effect, so the matrix predicts the same launch that role-terminal opens.
  const preflightOrganization = hasWorkflow
    ? snapshot.organization
    : organization(args.org);
  assert(
    preflightOrganization,
    `Workflow ${args["workflow-id"]} has no frozen organization snapshot`,
  );
  const pmBootstrap = args["pm-selection"]
    ? await validatePmBootstrapSelection(args, preflightOrganization, {
        catalog,
        revalidate,
        callerCwd,
      })
    : null;
  assert(
    !(preflightOrganization.resources && args.role === ROOT_ROLE) ||
      pmBootstrap,
    "The first PM launch for a resource organization requires --pm-selection FILE",
  );
  // D1/checklist 5: the matrix must predict the same pinned-policy launch
  // the nested role-terminal call below will actually open, not a live
  // organization.json read that may since disagree with it.
  let organizationForPreflight = preflightOrganization;
  let auditorEntry = null;
  let auditorTrustedLaunch = null;
  if (isAuditorRole) {
    const stateDir = path.resolve(args.state);
    auditorEntry = listKickoffs(path.resolve(args.org)).kickoffs.find(
      (entry) => path.resolve(entry.pm.stateDir) === stateDir,
    );
    assert(
      auditorEntry,
      `No kickoff is registered with pm state directory ${stateDir}`,
    );
    assert(
      auditorEntry.auditPolicy?.auditorConfigured === true,
      `Kickoff ${auditorEntry.pm.worktreeId} has no pinned auditor profile; ` +
        "the director must run kickoff-audit-policy-retrofit with --auditor-configured true " +
        "before an auditor worktree can be created for it",
    );
    assert(
      Object.hasOwn(
        preflightOrganization.profiles,
        auditorEntry.auditPolicy.profile,
      ),
      `Kickoff ${auditorEntry.pm.worktreeId}'s pinned auditor profile ` +
        `"${auditorEntry.auditPolicy.profile}" no longer exists in organization.json; ` +
        "it is not substituted with another profile, so the auditor worktree cannot be created",
    );
    // D2/부록 F: --repo must be this kickoff's own director checkout, and the
    // caller must actually hold that director's authority. Neither is proven
    // by --state alone; both are checked before Orca create runs below.
    const repoReal = realpathOrNull(path.resolve(args.repo));
    const directorCheckoutReal = realpathOrNull(
      path.resolve(auditorEntry.director.checkoutPath),
    );
    assert(
      repoReal !== null &&
        directorCheckoutReal !== null &&
        repoReal === directorCheckoutReal,
      `--repo ${args.repo} does not match kickoff ${auditorEntry.pm.worktreeId}'s director checkout ` +
        `(${auditorEntry.director.checkoutPath}); the auditor worktree must be created from that checkout`,
    );
    assertDirectorAuthority(
      auditorEntry,
      process.cwd(),
      "role-worktree-create --role auditor",
    );
    // One trusted runner serves the whole launch: the preflight version
    // read, worktree create and discovery, the internal role-terminal open,
    // and any automatic reclaim. Selecting it here, before any Orca create
    // runs, makes an unresolvable or untrusted script refuse with zero
    // worktrees created.
    auditorTrustedLaunch = assertTrustedAuditorLaunch(
      auditorLaunch({ auditorEntry, orcaArg: args.orca }),
    );
    organizationForPreflight = {
      ...preflightOrganization,
      auditor: {
        profile: auditorEntry.auditPolicy.profile,
        fallbacks: auditorEntry.auditPolicy.fallbacks ?? [],
      },
    };
  } else {
    // D2/부록 F: an active kickoff exists in this organization, so a non-PM
    // role's worktree must be tied to one by a registered --state, and that
    // --state's --repo must actually be its PM worktree -- otherwise any
    // caller could name another kickoff's --workflow-id/--workflow-task/
    // --state and pair it with an unrelated --repo (counterexamples 4/15).
    // role: pm's own first worktree is the only role that predates any
    // registered kickoff to tie itself to.
    const { kickoffs } = listKickoffs(path.resolve(args.org));
    if (kickoffs.length > 0) {
      assert(
        hasWorkflow || args.role === "pm",
        `An active kickoff exists in this organization; role-worktree-create for role "${args.role}" ` +
          "requires --workflow-id, --workflow-task, and --state (role: pm's first worktree is the only exception)",
      );
      if (hasWorkflow) {
        const stateDir = path.resolve(args.state);
        const statedEntry = kickoffs.find(
          (candidate) => path.resolve(candidate.pm.stateDir) === stateDir,
        );
        assert(
          statedEntry,
          `No kickoff is registered with pm state directory ${stateDir}`,
        );
        const repoReal = realpathOrNull(path.resolve(args.repo));
        const pmPathReal = realpathOrNull(path.resolve(statedEntry.pm.path));
        assert(
          repoReal !== null && pmPathReal !== null && repoReal === pmPathReal,
          `--repo ${args.repo} does not match kickoff ${statedEntry.pm.worktreeId}'s PM worktree ` +
            `(${statedEntry.pm.path})`,
        );
      }
    }
  }
  await preflightRoleWorktree(
    args,
    organizationForPreflight,
    environment,
    matrix,
    auditorTrustedLaunch,
    hasWorkflow
      ? {
          ...(state.roles ? { roles: state.roles } : {}),
          ...(state.staffing ? { staffing: state.staffing } : {}),
          workflowTask: args["workflow-task"],
          workflowState: state,
        }
      : pmBootstrap
        ? { pmSelection: pmBootstrap.selection }
        : {},
  );
  assert(
    !args.worktree || reusable,
    "--worktree requires an accepted prior task of the same role",
  );
  const openRoleSession = (workspace) => {
    const launchArgs = {
      ...args,
      command: "role-terminal",
      worktree: `id:${workspace.id}`,
      // Marks this as role-worktree-create's own internal first-session
      // open, never reachable through the CLI (role-terminal's
      // ALLOWED_OPTIONS has no such key; validateArgs would reject it).
      // role-terminal's general-branch binding check trusts this marker,
      // and only this marker, to open a session in a worktree that has no
      // earlier via="role-terminal" ledger line yet.
      viaRoleWorktreeCreate: true,
      ...(freshSelection ? { worktreeSelection: freshSelection } : {}),
      // Hands the internal role-terminal the launch's own trusted runner,
      // so terminal calls and any reclaim share one instance. Never
      // reachable through the CLI: ALLOWED_OPTIONS has no such key.
      ...(auditorTrustedLaunch ? { trustedLaunch: auditorTrustedLaunch } : {}),
      ...(pmBootstrap ? { pmSelection: pmBootstrap.selection } : {}),
    };
    assert(open || executeCommand, "Role terminal handler required");
    return open ? open(workspace, launchArgs) : executeCommand(launchArgs);
  };
  const existingRoleWorktree = Boolean(args.worktree && reusable);
  if (!existingRoleWorktree && create === createWorktreeWithRoleSession) {
    await assertChildWorktreeCapacity({
      parentWorktreeId:
        args.role === ROOT_ROLE ? undefined : lifecycle?.current?.pm.worktreeId,
      repo: lifecycle?.current?.pm.path ?? args.repo,
      executable: args.orca,
    });
  }
  const created = existingRoleWorktree
    ? await (async () => {
        const workspace = {
          id: args.worktree,
          path: pathFromWorktreeId(args.worktree),
        };
        const clean = await git(workspace.path, [
          "status",
          "--porcelain=v1",
          "-uall",
        ]);
        assert(
          !clean,
          "A reused role worktree must be clean before opening a new role session",
        );
        if (reusable) {
          const previousHead = await git(workspace.path, ["rev-parse", "HEAD"]);
          const integrationCommit = await git(workspace.path, [
            "rev-parse",
            `${args.base}^{commit}`,
          ]);
          const integrationHead = await git(path.resolve(args.repo), [
            "rev-parse",
            "HEAD",
          ]);
          assert(
            integrationCommit === integrationHead,
            "A reused role worktree must be based on the current PM integration HEAD",
          );
          await git(workspace.path, [
            "merge-base",
            "--is-ancestor",
            previousHead,
            integrationCommit,
          ]);
          const terminalEvidence = automaticSource
            ? null
            : await proveAndCloseOwnedTerminals({
                repo: path.resolve(args.repo),
                worktreeId: workspace.id,
                worktreePath: workspace.path,
                orca: args.orca,
                launches: launches(args.org),
                closures: closures(args.org),
                active,
                release,
                close,
                list,
              });
          if (terminalEvidence?.terminals.length)
            recordClosure(terminalEvidence);
          if (automaticSource)
            await git(workspace.path, [
              "merge",
              "--ff-only",
              integrationCommit,
            ]);
        }
        const session = await openRoleSession(workspace);
        assert(
          session?.ready === true &&
            session.terminal &&
            session.role === args.role &&
            session.worktree === `id:${workspace.id}` &&
            session.modelRequested,
          "Reused worktree has no matching proven role session",
        );
        return { workspace, session };
      })()
    : await create(path.resolve(args.repo), {
        ...(lifecycle
          ? {
              reclaimWithProof: async (workspace, remove) => {
                const executable =
                  auditorTrustedLaunch?.executable ??
                  selectOrcaExecutable(args.orca);
                const options = {
                  cwd: args.repo,
                  ...(auditorTrustedLaunch
                    ? { execute: auditorTrustedLaunch.execute }
                    : {}),
                };
                const shown = (
                  await show(
                    executable,
                    ["worktree", "show", "--worktree", `id:${workspace.id}`],
                    options,
                  )
                ).result?.worktree;
                assert(
                  shown?.identity?.key &&
                    shown.identity.key === workspace.worktree?.identity?.key &&
                    shown.parentWorktreeId ===
                      workspace.worktree?.parentWorktreeId,
                  "Created worktree identity changed; preserve it",
                );
                const transaction = lifecycle.prepare({
                  type: "creation-reclaim",
                  worktreeId: workspace.id,
                  identityKey: shown.identity.key,
                });
                const receipt = await remove(shown.identity.key);
                const inventory = (
                  await show(executable, ["worktree", "ps"], options)
                ).result;
                assert(
                  Array.isArray(inventory?.worktrees) &&
                    !inventory.truncated &&
                    !inventory.hostScope?.omittedHostIds?.length &&
                    !inventory.worktrees.some(
                      (item) => item.worktreeId === workspace.id,
                    ) &&
                    !fs.existsSync(workspace.path),
                  "Created worktree reclamation unverified",
                );
                return transaction.complete(receipt);
              },
            }
          : {}),
        name: args.name,
        base: args.base,
        setup: args.setup ?? "inherit",
        // The auditor never uses --orca or a PATH runner: create, discovery
        // and reclaim all run through the launch's trusted runner.
        executable: auditorTrustedLaunch
          ? auditorTrustedLaunch.executable
          : args.orca,
        ...(auditorTrustedLaunch
          ? { execute: auditorTrustedLaunch.execute }
          : {}),
        openRoleSession: async (workspace) => {
          // D4 pre-check (director msg_e96fa626ec49, msg_8c39242a6c89): the
          // injected `open` port, when a caller supplies one, replaces this
          // whole role-terminal call, so role-terminal's own D4 check
          // (3648-3679) never runs against an injected open. This repeats
          // that same independence check directly against the fresh
          // workspace.path first, so a D4 violation is caught -- and the
          // terminal-open port is never called at all for the rejected
          // worktree -- whether or not `open` is real or injected.
          if (isAuditorRole) {
            let forbidden;
            try {
              forbidden = auditorIndependenceForbiddenPaths(
                path.resolve(args.org),
                auditorEntry,
              );
            } catch (error) {
              // An unreadable workflow state is refused before any terminal
              // exists, exactly like a path collision: reclaim the worktree.
              if (error.preCreateRefusal) {
                return { ready: false, sessionObserved: false };
              }
              throw error;
            }
            if (sharesWorktreeWithAny(workspace.path, forbidden)) {
              return { ready: false, sessionObserved: false };
            }
          }
          let opened;
          try {
            opened = await openRoleSession(workspace);
          } catch (error) {
            // The matrix refuses before creating a terminal, and so does the
            // auditor's agy-provider independence check (role-terminal's
            // preCreateRefusal, 부록 F): both happen before any terminal
            // exists, so both are safe to reclaim automatically here. The D4
            // path check above already covers the auditor-independence
            // refusal for both real and injected `open`; this catch stays as
            // the reclaim path for the real role-terminal call's own D4
            // throw too, in case it is ever reached directly. Other throws
            // may follow a terminal/process creation and must stay for
            // reconciliation.
            if (error.matrixRefusal || error.preCreateRefusal) {
              return { ready: false, sessionObserved: false };
            }
            throw error;
          }
          return {
            ...opened,
            // A returned terminal alone can still be a shell or a blocked prompt.
            // Only role-terminal's ready proof is a session; an absent terminal is
            // the one failure state safe to reclaim automatically.
            sessionObserved:
              opened?.ready === true ||
              (typeof opened?.terminal === "string" &&
                opened.terminal.length > 0),
          };
        },
      });
  return {
    ...created.workspace,
    session: created.session,
    ...(args["fresh-reason"]
      ? { freshReason: args["fresh-reason"].trim() }
      : {}),
    ...(freshSelection ? { worktreeSelection: freshSelection } : {}),
    ...(reusable
      ? {
          reusedFrom: {
            workflowId: reusable.workflowId,
            workflowTaskId: reusable.taskId,
          },
        }
      : {}),
    ...(pmBootstrap
      ? {
          pmBootstrap: {
            inputSha256: pmBootstrap.inputSha256,
            selection: pmBootstrap.selection,
          },
        }
      : {}),
    // D2 rule 6 (director decision, msg_ebb6ab8a8f6b): recordLaunchSafely
    // swallows a launch-ledger write failure so the session itself still
    // opens; without a top-level marker here, `main`'s blockingOutcome never
    // sees it and process.exitCode stays 0 even though this worktree now has
    // no launch line for D2's own terminal-binding lookup to find later.
    // "blocked" is BLOCKING_STATUSES' existing value that fits (the worktree
    // and session both exist but must not be treated as a usable assignment
    // until the director looks at them); nothing here reclaims either one
    // automatically.
    ...(created.session?.ledgerError
      ? {
          status: "blocked",
          blockedReason:
            `role-worktree-create opened worktree ${created.workspace.path} and terminal ` +
            `${created.session.terminal ?? "(none observed)"}, but the launch ledger write failed: ` +
            `${created.session.ledgerError}. Neither the worktree nor the session is reclaimed ` +
            "automatically; the director must inspect them and decide whether to retry the launch " +
            "or discard this worktree.",
        }
      : {}),
  };
}

function pathFromWorktreeId(worktreeId) {
  const separator = String(worktreeId).indexOf("::");
  assert(separator > 0, "Workflow worktree receipt must include its path");
  return path.resolve(String(worktreeId).slice(separator + 2));
}

/**
 * Reclaims a child only after the completed workflow proves it is no longer a
 * live execution and its exact commit has reached an integration commit.
 *
 * This intentionally has no fallback removal path. A missing ledger row,
 * unknown Dispatch state, dirty child, or incomplete merge evidence leaves the
 * worktree intact for the PM to reconcile or reuse.
 *
 * @param {object} args - Parsed `role-worktree-reclaim` command arguments.
 * @param {object} [ports] - Injectable lifecycle ports for focused tests.
 * @param {Function} [ports.read=readWorkflow] - Workflow state reader.
 * @param {Function} [ports.launches=readLaunches] - Role-session ledger reader.
 * @param {Function} [ports.closures=readTerminalClosures] - Durable closure-proof reader.
 * @param {Function} [ports.recordClosure=recordTerminalClosure] - Closure-proof writer.
 * @param {Function} [ports.git=gitEvidence] - Explicit-repository Git adapter.
 * @param {Function} [ports.active=findActiveDispatch] - Orca Dispatch lookup.
 * @param {Function} [ports.release=releaseWorker] - Settled Dispatch releaser.
 * @param {Function} [ports.close=runOrcaJson] - Orca terminal closer.
 * @param {Function} [ports.list=runOrcaJson] - Orca worktree terminal lister.
 * @param {Function} [ports.reclaim=reclaimWorktree] - Orca worktree reclaimer.
 * @returns {Promise<object>} Evidence and Orca receipts for the reclaimed child.
 * @throws {Error} When any process, commit, integration, or cleanliness proof is absent.
 */
export async function reclaimIntegratedRoleWorktree(args, ports = {}) {
  return withWorktreeLock(args.org, (prepare) =>
    reclaimIntegratedRoleWorktreeUnderLock(args, { ...ports, prepare }),
  );
}

async function reclaimIntegratedRoleWorktreeUnderLock(
  args,
  {
    read = readWorkflow,
    prepare,
    show = runOrcaJson,
    scan = scanKickoffCleanup,
    launches = readLaunches,
    closures = readTerminalClosures,
    recordClosure = (evidence) => recordTerminalClosure(args.org, evidence),
    git = gitEvidence,
    active = findActiveDispatch,
    release = releaseWorker,
    close = runOrcaJson,
    list = runOrcaJson,
    reclaim = reclaimWorktree,
  } = {},
) {
  const repo = path.resolve(args.repo);
  const { state } = read(path.resolve(args.state), args["workflow-id"]);
  const task = state.tasks[args["workflow-task"]];
  assert(task, `Unknown workflow task ${args["workflow-task"]}`);
  assert(
    task.state === "accepted",
    `Task ${args["workflow-task"]} is ${task.state}; accepted task required before reclaim`,
  );
  const currentWorktreeId = task.worktreeId ?? task.execution?.worktreeId;
  const retiredTransition = (task.worktreeTransitions ?? []).find(
    (transition) =>
      transition.usedAt && transition.fromWorktreeId === args.worktree,
  );
  const worktreeId = retiredTransition?.fromWorktreeId ?? currentWorktreeId;
  assert(worktreeId, "Accepted task has no role-worktree receipt to reclaim");
  assert(
    worktreeId === args.worktree,
    `Task ${args["workflow-task"]} is bound to ${currentWorktreeId}, not ${args.worktree}`,
  );
  const last = readWorktreeTransitions(args.org)
    .entries.filter(
      (entry) => entry.type === "reuse" && entry.worktreeId === worktreeId,
    )
    .at(-1);
  const owner = listKickoffs(args.org).kickoffs.find(
    (entry) => path.resolve(entry.pm.stateDir) === path.resolve(args.state),
  );
  assert(
    owner && path.resolve(owner.pm.path) === repo,
    "Role reclaim requires the registered PM checkout",
  );
  assert(
    !last ||
      (last.targetWorktreeId === owner.pm.worktreeId &&
        last.workflowId === args["workflow-id"] &&
        last.taskId === args["workflow-task"]),
    "Role worktree ownership transferred; preserve it",
  );
  const identity = (
    await show(
      selectOrcaExecutable(args.orca),
      ["worktree", "show", "--worktree", `id:${worktreeId}`],
      { cwd: repo },
    )
  ).result?.worktree;
  assert(
    identity?.id === worktreeId &&
      identity.identity?.key &&
      identity.identity.instanceId &&
      identity.identity.executionHostId &&
      identity.parentWorktreeId === owner.pm.worktreeId,
    "Role reclaim identity or parent unproven",
  );
  const worktreePath = pathFromWorktreeId(worktreeId);
  // A reused child can carry receipts from earlier tasks. The terminal list is
  // worktree-scoped, so release and close every ledger-owned Dispatch in that
  // worktree rather than selecting only this task's newest receipt.
  const worktreeLaunches = launches(args.org);
  const status = await git(worktreePath, ["status", "--porcelain=v1", "-uall"]);
  assert(!status, "Child worktree has uncommitted changes; do not reclaim it");
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  const mergeCommit = await git(repo, [
    "rev-parse",
    "--verify",
    `${args["merge-commit"]}^{commit}`,
  ]);
  const integrationHead = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, [
    "merge-base",
    "--is-ancestor",
    mergeCommit,
    integrationHead,
  ]);
  await git(repo, ["merge-base", "--is-ancestor", head, mergeCommit]);

  const transaction = await prepareRoleLifecycle(
    {
      orgFile: args.org,
      owner,
      task,
      workflowState: state,
      workflowId: args["workflow-id"],
      taskId: args["workflow-task"],
      child: identity,
      expectedHead: head,
      executable: args.orca,
      repo,
      operation: {
        type: "role-reclaim",
        worktreeId,
        identityKey: identity.identity.key,
        sourceWorktreeId: owner.pm.worktreeId,
      },
    },
    { prepare, show, launches: launches(args.org, { strict: true }) },
  );
  const terminalEvidence = await proveAndCloseOwnedTerminals({
    repo,
    worktreeId,
    worktreePath,
    orca: args.orca,
    launches: worktreeLaunches,
    closures: closures(args.org),
    identity: identity.identity,
    active,
    release,
    close,
    list,
  });
  if (terminalEvidence.terminals.length) recordClosure(terminalEvidence);
  const postCloseStatus = await git(worktreePath, [
    "status",
    "--porcelain=v1",
    "-uall",
  ]);
  assert(
    !postCloseStatus,
    "Child worktree changed while closing its terminal; do not reclaim it",
  );
  const globalProof = await scan({
    orgFile: args.org,
    worktreeId: owner.pm.worktreeId,
    executable: args.orca,
    integrationCommit: mergeCommit,
  });
  assert(
    globalProof.inventoryComplete &&
      globalProof.candidates.some(
        (item) =>
          item.worktreeId === worktreeId && item.status === "safe-to-remove",
      ),
    "Role reclaim global session or Dispatch proof is incomplete",
  );
  const latestIdentity = (
    await show(
      selectOrcaExecutable(args.orca),
      ["worktree", "show", "--worktree", `id:${worktreeId}`],
      { cwd: repo },
    )
  ).result?.worktree;
  assert(
    latestIdentity?.identity?.key === identity.identity.key &&
      latestIdentity.parentWorktreeId === identity.parentWorktreeId,
    "Role reclaim identity or parent changed; preserve it",
  );
  if (transaction.revalidate) await transaction.revalidate();
  const reclaimed = await reclaim(repo, {
    id: worktreeId,
    identityKey: identity.identity.key,
    executable: args.orca,
  });
  const inventory = (
    await show(selectOrcaExecutable(args.orca), ["worktree", "ps"], {
      cwd: repo,
    })
  ).result;
  assert(
    Array.isArray(inventory?.worktrees) &&
      !inventory.truncated &&
      !inventory.hostScope?.omittedHostIds?.length &&
      !inventory.worktrees.some((item) => item.worktreeId === worktreeId),
    "Role reclaim postcheck incomplete",
  );
  assert(!fs.existsSync(worktreePath), "Reclaimed role path still exists");
  return transaction.complete({
    worktreeId,
    worktreePath,
    head,
    mergeCommit,
    integrationHead,
    dispatches: terminalEvidence.released,
    terminals: terminalEvidence.closed,
    // Keep the former singular fields for callers that reclaim exactly one
    // dispatch, while the receipt arrays retain every lifecycle proof.
    released: terminalEvidence.released.at(-1)?.receipt,
    closed: terminalEvidence.closed.at(-1)?.receipt,
    releaseReceipts: terminalEvidence.released,
    closeReceipts: terminalEvidence.closed,
    reclaimed,
  });
}

/**
 * Resolves the executable placeholder and command runner the `role-terminal`
 * launch uses to open a terminal, in `executeCommand`'s `role-terminal` case.
 *
 * When `auditorEntry` is set (the auditor branch; `--orca` has already been
 * asserted absent there), this always returns the trusted invocation: a
 * placeholder name that `openRoleTerminal`/`checkTerminalIdle` never actually
 * read, paired with the runner `trustedExecuteFactory` builds, which
 * validates and then directly executes the fixed trusted script with a
 * pinned interpreter and an allowlisted environment (B.6, decision B). It
 * also returns `versionExecutable`, the same trusted script's resolved real
 * path (from `resolveScriptPath`, not the placeholder). The auditor launch's
 * `readLaunchEnvironment` no longer runs that path itself: it reads the Orca
 * version through `auditorLaunchEnvironmentInputs(execute)`, whose
 * `readOrcaVersion` is `readTrustedOrcaVersion({ execute })`, so the version
 * probe uses this same trusted runner and `orcaExecutable` is passed only
 * for shape. One returned runner serves the whole launch: the preflight
 * version read, worktree create and discovery, the internal `role-terminal`
 * open (handed over as `trustedLaunch`), every terminal call, and any
 * automatic reclaim.
 *
 * Outside the auditor branch, the caller's own `--orca` (or its absence)
 * passes through unchanged for both `executable` and `versionExecutable`, no
 * trusted runner is built, matching `selectOrcaExecutable`'s existing
 * behavior.
 *
 * @param {object} options - Selection inputs.
 * @param {object} [options.auditorEntry] - Kickoff entry when launching the auditor role.
 * @param {string} [options.orcaArg] - The caller's `--orca`, only read outside the auditor branch.
 * @param {Function} [options.trustedExecuteFactory=trustedOrcaExecute] - Trusted-runner factory, for tests only.
 * @param {Function} [options.resolveScriptPath=resolveTrustedOrcaScriptPath] - Trusted script path resolver, for tests only.
 * @returns {{executable: string | undefined, execute: Function | undefined, versionExecutable: string | undefined}}
 *   `execute` is `undefined` outside the auditor branch, so callers fall back
 *   to their own default runner.
 */
export function resolveAuditorLaunchExecution({
  auditorEntry,
  orcaArg,
  trustedExecuteFactory = trustedOrcaExecute,
  resolveScriptPath = resolveTrustedOrcaScriptPath,
} = {}) {
  if (!auditorEntry)
    return {
      executable: orcaArg,
      execute: undefined,
      versionExecutable: orcaArg,
    };
  return {
    executable: TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER,
    execute: trustedExecuteFactory(),
    versionExecutable: resolveScriptPath(),
  };
}

/**
 * Inputs the auditor launch passes to `readLaunchEnvironment`, shared by
 * role-worktree-create's preflight and role-terminal's auditor branch so the
 * two cannot read the environment differently.
 *
 * The Orca version is read through `execute`, the one trusted runner this
 * launch holds; the agy probe is skipped, the home directory comes from
 * `os.userInfo()` rather than an inheritable `HOME`, and an unverified Orca
 * version throws instead of being tolerated.
 *
 * @param {Function} execute - Runner `trustedOrcaExecute` built for this launch.
 * @returns {{readOrcaVersion: Function, skipAgyVersion: true, homedir: string, throwOnUnverifiedOrca: true}}
 *   Options for `readLaunchEnvironment`.
 */
export function auditorLaunchEnvironmentInputs(execute) {
  return {
    readOrcaVersion: () => readTrustedOrcaVersion({ execute }),
    skipAgyVersion: true,
    homedir: os.userInfo().homedir,
    throwOnUnverifiedOrca: true,
  };
}

// Accepts an auditor launch role-worktree-create built and refuses anything
// whose runner is not one trustedOrcaExecute made, so no caller can slip a
// general runner in beside the trusted placeholder.
/**
 * Ensures an auditor launch uses the one trusted Orca runner.
 * @param {object} launch - Proposed auditor launch.
 * @returns {object} The trusted launch.
 */
export function assertTrustedAuditorLaunch(launch) {
  assert(
    launch?.executable === TRUSTED_ORCA_EXECUTABLE_PLACEHOLDER &&
      isTrustedOrcaExecute(launch.execute),
    "The auditor launch must use the placeholder executable with a runner trustedOrcaExecute built",
  );
  return launch;
}
