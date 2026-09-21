#!/usr/bin/env python3
"""Measure the OpenCodex runtime install, idempotence and repair paths.

The script locates the repository from its own position, so it measures the
checkout it lives in. Every runtime command runs with HOME, the XDG directories,
CODEX_HOME and OPENCODEX_HOME pointing into one temporary directory, and on macOS
under a sandbox profile that denies file writes below the real home directory
and the repository. npm is a PATH shim that records each call. The real user
configuration is compared before and after only for the files an OpenCodex run
could plausibly touch; everything else under ~/.codex and ~/.claude is written
by live sessions and is reported as not attributable instead of being compared.

Usage: python3 run_platform_proof.py [--org FILE] [--output FILE]
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")


def utc_now():
    """Return the current time as an ISO 8601 string that really is UTC."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(cmd, env=None, cwd=None, timeout=600):
    """Run a command and return its exit code, output and duration."""
    started = time.monotonic()
    try:
        done = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env
        )
        code, out, err = done.returncode, done.stdout, done.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        code, out, err = 1, "", str(error)
    return {
        "code": code,
        "stdout": out,
        "stderr": err,
        "seconds": round(time.monotonic() - started, 2),
    }


def repository_root():
    """Find the repository root from this script's location."""
    done = run(["git", "rev-parse", "--show-toplevel"], cwd=str(SCRIPT_DIR))
    if done["code"] != 0:
        sys.exit("git rev-parse --show-toplevel failed: " + done["stderr"].strip())
    return Path(done["stdout"].strip()).resolve()


def git_output(root, *args):
    """Return stripped stdout of a git command run in the repository root."""
    done = run(["git", *args], cwd=str(root))
    return done["stdout"].strip() if done["code"] == 0 else None


def sha256_file(path):
    """Return the SHA-256 hex digest of a file's bytes."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_manifest(directory):
    """Summarise a directory tree by names, sizes, link targets and file contents.

    Symlinks are recorded by target and never followed. The digest changes when
    any file is added, removed or edited, including manifest.json, whose
    verifiedAt value differs after every real install.
    """
    directory = Path(directory)
    if not directory.exists():
        return {"exists": False}
    lines, files, links, dirs = [], 0, 0, 0
    for current, dirnames, filenames in os.walk(directory, followlinks=False):
        dirnames.sort()
        for name in sorted(dirnames):
            full = Path(current) / name
            if full.is_symlink():
                links += 1
                lines.append(f"L {full.relative_to(directory)} -> {os.readlink(full)}")
            else:
                dirs += 1
        for name in sorted(filenames):
            full = Path(current) / name
            rel = full.relative_to(directory)
            if full.is_symlink():
                links += 1
                lines.append(f"L {rel} -> {os.readlink(full)}")
            else:
                files += 1
                lines.append(f"F {rel} {full.stat().st_size} {sha256_file(full)}")
    digest = hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()
    return {"exists": True, "files": files, "symlinks": links, "dirs": dirs, "sha256": digest}


def metadata_digest(directory):
    """Summarise a directory by names, sizes and mtimes only, without reading contents."""
    directory = Path(directory)
    if not directory.exists():
        return {"exists": False}
    lines, count, size, newest = [], 0, 0, 0
    for current, dirnames, filenames in os.walk(directory, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            full = Path(current) / name
            try:
                stat = full.lstat()
            except OSError:
                continue
            count += 1
            size += stat.st_size
            newest = max(newest, stat.st_mtime_ns)
            lines.append(f"{full.relative_to(directory)} {stat.st_size} {stat.st_mtime_ns}")
    digest = hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()
    return {"exists": True, "files": count, "size": size, "max_mtime_ns": newest, "sha256": digest}


def file_meta(path, content_hash):
    """Return existence, size and mtime of one file, with a hash prefix when allowed."""
    path = Path(path)
    try:
        stat = path.lstat()
    except FileNotFoundError:
        return {"exists": False}
    entry = {"exists": True, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    if content_hash and path.is_file():
        entry["sha256_prefix"] = sha256_file(path)[:12]
    return entry


def snapshot_real_state(home):
    """Snapshot only the real user files an OpenCodex run could change.

    ~/.codex and ~/.claude as a whole are not walked: running Codex and Claude
    Code sessions write logs and databases there all the time, so a whole-tree
    comparison cannot tell this experiment's writes from theirs.
    """
    snapshot = {"files": {}, "trees": {}}
    hashed = [
        ".codex/config.toml",
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/plugins/installed_plugins.json",
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".zlogin",
        ".bash_profile",
        ".bash_login",
        ".bashrc",
        ".profile",
    ]
    for rel in hashed:
        snapshot["files"]["~/" + rel] = file_meta(home / rel, True)
    # A credential file: size and mtime only, never its content or a digest of it.
    snapshot["files"]["~/.codex/auth.json"] = file_meta(home / ".codex/auth.json", False)
    for rel in [".opencodex", ".omt"]:
        snapshot["trees"]["~/" + rel] = metadata_digest(home / rel)
    launch = run(["launchctl", "getenv", "ANTHROPIC_BASE_URL"])
    value = launch["stdout"].strip()
    snapshot["launchctl_ANTHROPIC_BASE_URL"] = {
        "set": bool(value),
        "sha256_prefix": hashlib.sha256(value.encode()).hexdigest()[:12] if value else None,
    }
    return snapshot


def diff_snapshots(before, after):
    """Return every entry as 'unchanged' or a before/after pair."""
    diff = {}
    for group in ("files", "trees"):
        for key in sorted(set(before[group]) | set(after[group])):
            same = before[group].get(key) == after[group].get(key)
            diff[key] = "unchanged" if same else {"before": before[group].get(key), "after": after[group].get(key)}
    key = "launchctl_ANTHROPIC_BASE_URL"
    diff[key] = "unchanged" if before[key] == after[key] else {"before": before[key], "after": after[key]}
    return diff


def write_shims(directory, log, real_npm):
    """Create two npm shims that record every call: one forwards to real npm, one fails."""
    forward = Path(directory) / "forward"
    failing = Path(directory) / "failing"
    forward.mkdir(parents=True)
    failing.mkdir(parents=True)
    record = f'printf \'%s\\t%s\\n\' "$PWD" "$*" >> "{log}"\n'
    (forward / "npm").write_text(f'#!/bin/sh\n{record}exec "{real_npm}" "$@"\n')
    (failing / "npm").write_text(f"#!/bin/sh\n{record}exit 1\n")
    for shim in (forward / "npm", failing / "npm"):
        shim.chmod(0o755)
    return forward, failing


def read_npm_calls(log):
    """Return the argument lists of the npm calls recorded so far."""
    if not Path(log).exists():
        return []
    calls = []
    for line in Path(log).read_text().splitlines():
        cwd, _, argv = line.partition("\t")
        calls.append({"argv": argv, "in_runtime_staging": "/staging/" in cwd})
    return calls


def parse_json(text):
    """Parse JSON output, or report why it could not be parsed."""
    try:
        return json.loads(text)
    except ValueError:
        return {"parse_error": True, "raw": text[:300]}


def sandbox_denials(start, end, guarded):
    """Read kernel sandbox denials in a time window that touched a guarded path."""
    fmt = "%Y-%m-%d %H:%M:%S"
    done = run(
        [
            "/usr/bin/log", "show", "--style", "compact",
            "--start", start.strftime(fmt), "--end", end.strftime(fmt),
            "--predicate", 'eventMessage CONTAINS "deny(1) file-write"',
        ]
    )
    found = []
    for line in done["stdout"].splitlines():
        match = re.search(r"Sandbox: (\S+?)\((\d+)\) (deny\(1\) \S+) (.*)$", line)
        if match and any(match.group(4).startswith(prefix) for prefix in guarded):
            found.append({"process": match.group(1), "pid": int(match.group(2)), "operation": match.group(3), "path": match.group(4)})
    return {"log_exit_code": done["code"], "denials": found}


def main():
    """Run the whole measurement and write the result JSON next to the script."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--org", help="organization file; default is the repository example")
    parser.add_argument("--output", help="result path; default is next to this script")
    args = parser.parse_args()

    root = repository_root()
    org = Path(args.org).resolve() if args.org else root / "plugins/oh-my-teams/examples/organization.json"
    output = Path(args.output).resolve() if args.output else SCRIPT_DIR / "runtime-test-results.json"
    cli = root / "plugins/oh-my-teams/scripts/teams-org.mjs"
    real_home = Path.home().resolve()
    real_npm = shutil.which("npm")
    if not org.is_file() or not real_npm:
        sys.exit("organization file or npm is missing")

    started = datetime.now(timezone.utc)
    status_lines = (git_output(root, "status", "--porcelain", "--untracked-files=all") or "").splitlines()
    versions = {}
    for line in run(["sw_vers"])["stdout"].splitlines():
        key, _, value = line.partition(":")
        versions[key.strip()] = value.strip()
    results = {
        "schemaVersion": 2,
        "repository": {
            "head": git_output(root, "rev-parse", "HEAD"),
            "dirty": bool(status_lines),
            "status_porcelain": status_lines,
            "plugin_tree": git_output(root, "rev-parse", "HEAD:plugins/oh-my-teams"),
            "organization_file": str(org.relative_to(root)) if org.is_relative_to(root) else "external",
            "organization_sha256": sha256_file(org),
        },
        "environment": {
            "node": run(["node", "--version"])["stdout"].strip(),
            "npm": run([real_npm, "--version"])["stdout"].strip(),
            "sw_vers": versions,
            "machine": platform.machine(),
        },
        "started_utc": utc_now(),
        "tests": {},
    }

    with tempfile.TemporaryDirectory(prefix="omt-platform-proof-") as scratch:
        scratch = Path(scratch).resolve()
        if scratch.is_relative_to(real_home) or scratch.is_relative_to(root):
            sys.exit("the temporary directory must be outside the real home and the repository")
        home = scratch / "home"
        for name in ("config", "cache", "data", "state", "work"):
            (scratch / name).mkdir(parents=True)
        # OpenCodex refuses a CODEX_HOME that does not exist, so both homes are created.
        (home / ".codex").mkdir(parents=True)
        (home / ".opencodex").mkdir()
        env = os.environ.copy()
        env.update(
            HOME=str(home),
            XDG_CONFIG_HOME=str(scratch / "config"),
            XDG_CACHE_HOME=str(scratch / "cache"),
            XDG_DATA_HOME=str(scratch / "data"),
            XDG_STATE_HOME=str(scratch / "state"),
            CODEX_HOME=str(home / ".codex"),
            OPENCODEX_HOME=str(home / ".opencodex"),
        )
        npm_log = scratch / "npm-calls.log"
        forward, failing = write_shims(scratch / "shims", npm_log, real_npm)
        original_path = env.get("PATH", "")

        guarded = [str(real_home), str(root)]
        guard = []
        if platform.system() == "Darwin" and SANDBOX_EXEC.exists():
            deny = " ".join(f'(subpath "{path}")' for path in guarded)
            guard = [str(SANDBOX_EXEC), "-p", f"(version 1)(allow default)(deny file-write* {deny})"]
        # Positive control: a write below the real home must be refused, otherwise
        # the guard proves nothing. The probe file is removed if it was created.
        control = None
        if guard:
            probe = real_home / f".omt-guard-probe-{os.getpid()}"
            attempt = run([*guard, "sh", "-c", f'touch "{probe}"'])
            control = {"write_below_real_home_denied": attempt["code"] != 0 and not probe.exists()}
            probe.unlink(missing_ok=True)
        results["isolation"] = {
            "guard_control": control,
            "env_overrides": sorted(k for k in env if k in ("HOME", "CODEX_HOME", "OPENCODEX_HOME") or k.startswith("XDG_")),
            "temp_directory_outside_real_home_and_repository": True,
            "write_guard": "sandbox-exec: deny file-write* below the real home and the repository" if guard else "none (not macOS or no sandbox-exec)",
            "npm": "PATH shim that records every call",
        }

        def cli_run(name, subcommand, extra=(), shim=forward):
            """Run one teams-org.mjs runtime command and store its result."""
            env["PATH"] = f"{shim}:{original_path}"
            calls_before = len(read_npm_calls(npm_log))
            cmd = [*guard, "node", str(cli), subcommand, "--org", str(org), "--state", str(scratch / "state"), *extra]
            done = run(cmd, env=env, cwd=str(scratch / "work"))
            calls = read_npm_calls(npm_log)[calls_before:]
            entry = {
                "command": f"node plugins/oh-my-teams/scripts/teams-org.mjs {subcommand} --org <org> --state <temp>" + "".join(f" {x}" for x in extra),
                "code": done["code"],
                "seconds": done["seconds"],
                "stderr_head": done["stderr"].strip()[:300],
                "npm_calls": calls,
                "npm_ci_calls": sum(1 for call in calls if call["argv"].split(" ")[0] == "ci"),
                "result": parse_json(done["stdout"]),
            }
            results["tests"][name] = entry
            return entry

        paths = {}

        def tests_so_far():
            """Return the recorded steps for a failure message."""
            return {k: {f: v[f] for f in ("code", "stderr_head", "npm_calls") if f in v} for k, v in results["tests"].items()}

        def runtime_dir():
            """Locate the runtime directory of the active fingerprint."""
            runtimes = home / ".omt/runtime/opencodex/runtimes"
            if not paths and runtimes.is_dir():
                found = sorted(p for p in runtimes.iterdir() if ".failed-" not in p.name)
                paths["runtime"] = found[0] if found else None
            return paths.get("runtime")

        real_before = snapshot_real_state(real_home)

        cli_run("doctor-before", "runtime-doctor", ["--format", "json"])

        entry = cli_run("install-dryrun", "runtime-install", ["--dry-run"])
        entry["omt_directory_created"] = (home / ".omt").exists()

        cli_run("install-actual", "runtime-install")
        runtime = runtime_dir()
        results["tests"]["install-actual"]["tree"] = tree_manifest(runtime) if runtime else None
        results["tests"]["install-actual"]["active_json"] = json.loads((home / ".omt/runtime/opencodex/active.json").read_text()) if runtime else None

        cli_run("doctor-after", "runtime-doctor", ["--format", "json"])

        if runtime is None:
            sys.exit("no runtime directory after install: " + json.dumps(tests_so_far(), indent=1)[:3000])

        second = cli_run("install-second", "runtime-install")
        second["tree"] = tree_manifest(runtime)
        second["tree_hash_equal"] = second["tree"] == results["tests"]["install-actual"]["tree"]

        manifest = runtime / "manifest.json"
        manifest.write_text("CORRUPTED")
        cli_run("doctor-damaged", "runtime-doctor", ["--format", "json"])
        cli_run("repair-real-npm", "runtime-repair")
        repaired = cli_run("doctor-repaired", "runtime-doctor", ["--format", "json"])
        base = home / ".omt/runtime/opencodex"
        repaired["runtimes_entries"] = sorted(re.sub(r"\.failed-\d+$", ".failed-<epoch-ms>", p.name) for p in (base / "runtimes").iterdir())

        def snapshot_runtime():
            """Capture what a failed repair must leave alone."""
            staging = base / "staging"
            return {
                "active_json_sha256": sha256_file(base / "active.json"),
                "runtime_tree": tree_manifest(runtime),
                "runtimes_entries": sorted(re.sub(r"\.failed-\d+$", ".failed-<epoch-ms>", p.name) for p in (base / "runtimes").iterdir()),
                "staging_entries": sorted(p.name for p in staging.iterdir()) if staging.is_dir() else [],
            }

        manifest.write_text("CORRUPTED-FOR-FAILED-TEST")
        held_before = snapshot_runtime()
        failed = cli_run("failed-staging", "runtime-repair", shim=failing)
        held_after = snapshot_runtime()
        failed["before"] = held_before
        failed["after"] = held_after
        failed["active_json_equal"] = held_before["active_json_sha256"] == held_after["active_json_sha256"]
        failed["runtime_tree_equal"] = held_before["runtime_tree"] == held_after["runtime_tree"]
        failed["runtimes_entries_equal"] = held_before["runtimes_entries"] == held_after["runtimes_entries"]

        cli_run("repair-after-failure", "runtime-repair")
        cli_run("doctor-recovered", "runtime-doctor", ["--format", "json"])

        real_after = snapshot_real_state(real_home)
        time.sleep(3)
        finished = datetime.now(timezone.utc)
        results["isolation"]["isolated_home_top_level"] = sorted(p.name for p in home.iterdir())
        if guard:
            window = sandbox_denials(started.astimezone() - timedelta(seconds=2), finished.astimezone() + timedelta(seconds=2), guarded)
            # The control probe's own denial proves the log query sees denials; it is not a leak.
            control["denial_logged"] = any(item["path"] == str(probe) for item in window["denials"])
            window["denials"] = [item for item in window["denials"] if item["path"] != str(probe)]
            results["isolation"]["sandbox_denials_excluding_control"] = window
        else:
            results["isolation"]["sandbox_denials_excluding_control"] = "not measured"

    tests = results["tests"]
    healthy = lambda name: tests[name]["result"].get("runtimeHealthy") is True
    checks = {
        "doctor-before reports needs-install": tests["doctor-before"]["result"].get("status") == "needs-install",
        "dry-run creates no ~/.omt in the isolated home": tests["install-dryrun"]["omt_directory_created"] is False and tests["install-dryrun"]["result"].get("dryRun") is True,
        "first install runs npm ci exactly once and installs": tests["install-actual"]["code"] == 0 and tests["install-actual"]["npm_ci_calls"] == 1 and tests["install-actual"]["result"].get("installed") is True,
        "doctor-after reports a healthy runtime": healthy("doctor-after"),
        "second install reuses without npm ci and leaves the tree equal": tests["install-second"]["result"].get("reused") is True and tests["install-second"]["npm_ci_calls"] == 0 and tests["install-second"]["tree_hash_equal"] is True,
        "corrupted manifest is reported as needs-install": tests["doctor-damaged"]["result"].get("status") == "needs-install",
        "repair runs npm ci exactly once and the runtime is healthy again": tests["repair-real-npm"]["npm_ci_calls"] == 1 and healthy("doctor-repaired"),
        "failing npm: exit code non-zero, one npm ci, error names the failed install": tests["failed-staging"]["code"] != 0 and tests["failed-staging"]["npm_ci_calls"] == 1 and "runtime-npm-install-failed" in tests["failed-staging"]["stderr_head"],
        "failing npm: active.json, runtime tree and runtimes listing unchanged, no staging left": tests["failed-staging"]["active_json_equal"] and tests["failed-staging"]["runtime_tree_equal"] and tests["failed-staging"]["runtimes_entries_equal"] and tests["failed-staging"]["after"]["staging_entries"] == [],
        "repair after the failure restores a healthy runtime": healthy("doctor-recovered"),
    }
    if control:
        checks["the write guard refuses a probe write below the real home and logs the denial"] = control["write_below_real_home_denied"] and control["denial_logged"]
        checks["no other write was denied while the experiment ran"] = results["isolation"]["sandbox_denials_excluding_control"]["denials"] == []
    results["expectations"] = checks
    results["finished_utc"] = utc_now()
    results["real_user_state"] = {
        "compared": "files an OpenCodex run could change, listed under before/after",
        "not_attributable": "everything else under ~/.codex and ~/.claude (session logs, databases) is written by live sessions and is not compared",
        "before": real_before,
        "after": real_after,
        "diff": diff_snapshots(real_before, real_after),
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")

    print(f"HEAD {results['repository']['head']} dirty={results['repository']['dirty']}")
    print(f"UTC {results['started_utc']} .. {results['finished_utc']}")
    for label, passed in checks.items():
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
    print("real user state diff:")
    for key, value in results["real_user_state"]["diff"].items():
        print(f"  {key}: {'unchanged' if value == 'unchanged' else json.dumps(value)}")
    print("sandbox denials:", json.dumps(results["isolation"]["sandbox_denials_excluding_control"]))
    print(f"Results: {output}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
