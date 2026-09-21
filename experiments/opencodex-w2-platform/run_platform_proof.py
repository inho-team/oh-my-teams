#!/usr/bin/env python3
"""Measure OpenCodex runtime install, idempotency, and repair reproducibly."""
import json
import subprocess
import tempfile
import shutil
import os
import hashlib
from pathlib import Path
from datetime import datetime

WORKDIR = Path("/Users/jinsungkim/orca/workspaces/oh-my-teams/opencodex-w3-platform")
ORG_FILE = Path("/Users/jinsungkim/orca/oh-my-teams/.omt/organization.json")

def run_cmd(cmd, env=None):
    """Run command and return output."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(WORKDIR),
            env=env or os.environ.copy()
        )
        return {
            "code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except Exception as e:
        return {
            "code": 1,
            "stdout": "",
            "stderr": str(e),
        }

def get_head_hash():
    """Get current HEAD commit hash (40 chars)."""
    result = run_cmd(["git", "rev-parse", "HEAD"])
    return result["stdout"].strip() if result["code"] == 0 else "unknown"

def get_os_version():
    """Get macOS version from sw_vers."""
    result = subprocess.run(["sw_vers"], capture_output=True, text=True)
    if result.returncode == 0:
        lines = result.stdout.strip().split('\n')
        return {line.split(':')[0].strip(): line.split(':')[1].strip() for line in lines if ':' in line}
    return {}

def get_node_version():
    """Get Node version."""
    result = run_cmd(["node", "--version"])
    return result["stdout"].strip() if result["code"] == 0 else "unknown"

def file_tree_hash(directory):
    """Calculate hash of directory tree structure (file names and sizes)."""
    try:
        files = sorted([
            f"{f.relative_to(directory)}:{f.stat().st_size}"
            for f in Path(directory).rglob("*") if f.is_file()
        ])
        content = '\n'.join(files)
        return hashlib.sha256(content.encode()).hexdigest()
    except:
        return None

def list_files_with_metadata(directory):
    """List files with metadata (size, mtime)."""
    try:
        files = []
        for f in sorted(Path(directory).rglob("*")):
            if f.is_file():
                try:
                    stat = f.stat()
                    files.append({
                        "path": str(f.relative_to(directory)),
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                    })
                except (OSError, FileNotFoundError):
                    pass
        return files
    except:
        return []

def snapshot_global_state():
    """Snapshot global state: ~/.codex, ~/.claude, ~/.opencodex, launchctl, rc files."""
    snapshot = {}

    # Home directories (safely handle broken symlinks)
    for dirname in [".codex", ".claude", ".opencodex"]:
        path = Path.home() / dirname
        if path.exists():
            try:
                files = []
                mtimes = []
                sizes = 0
                for f in path.rglob("*"):
                    try:
                        if f.is_file():
                            files.append(f)
                            mtimes.append(f.stat().st_mtime)
                            sizes += f.stat().st_size
                    except (OSError, FileNotFoundError):
                        pass
                snapshot[dirname] = {
                    "exists": True,
                    "files": len(files),
                    "mtime": max(mtimes) if mtimes else 0,
                    "size": sizes,
                }
            except Exception as e:
                snapshot[dirname] = {"exists": True, "error": str(e)}
        else:
            snapshot[dirname] = {"exists": False}

    # launchctl
    result = subprocess.run(
        ["launchctl", "getenv", "ANTHROPIC_BASE_URL"],
        capture_output=True,
        text=True
    )
    snapshot["launchctl_ANTHROPIC_BASE_URL"] = result.stdout.strip() if result.returncode == 0 else None

    # Shell rc files
    rc_files = [
        Path.home() / ".bashrc",
        Path.home() / ".zshrc",
        Path.home() / ".bash_profile",
    ]
    snapshot["rc_files"] = {}
    for rc in rc_files:
        if rc.exists():
            stat = rc.stat()
            with open(rc, "rb") as f:
                content_hash = hashlib.sha256(f.read()).hexdigest()[:8]
            snapshot["rc_files"][rc.name] = {
                "exists": True,
                "mtime": stat.st_mtime,
                "size": stat.st_size,
                "hash_prefix": content_hash,
            }
        else:
            snapshot["rc_files"][rc.name] = {"exists": False}

    return snapshot

def parse_json_output(output):
    """Extract JSON from command output."""
    try:
        return json.loads(output)
    except:
        return {"error": "parse_failed", "raw": output[:200] if output else ""}

def get_runtime_path(fingerprint, temp_home):
    """Derive runtime path from fingerprint."""
    return Path(temp_home) / ".omt" / "runtime" / "opencodex" / "runtimes" / fingerprint

# Main test flow
results = {
    "schemaVersion": 1,
    "head": get_head_hash(),
    "timestamp": datetime.now().isoformat() + "Z",
    "environment": {
        "node": get_node_version(),
        "os": get_os_version(),
    },
    "global_state_before": None,
    "tests": {},
    "global_state_after": None,
    "global_state_diff": {},
}

# Record global state before
print("Snapshotting global state (before)...")
results["global_state_before"] = snapshot_global_state()

with tempfile.TemporaryDirectory() as temp_home:
    env = os.environ.copy()
    env["HOME"] = temp_home

    print(f"Temp HOME: {temp_home}")

    # Test 1: doctor before install
    print("Test 1: doctor (before install)...")
    cmd = [
        "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
        "runtime-doctor", "--org", str(ORG_FILE), "--state", temp_home, "--format", "json"
    ]
    doctor_before = run_cmd(cmd, env)
    doctor_before_data = parse_json_output(doctor_before["stdout"])
    results["tests"]["doctor-before"] = {
        "command": " ".join(cmd[2:]),
        "code": doctor_before["code"],
        "result": doctor_before_data,
    }

    # Test 2: install --dry-run with file listing
    print("Test 2: install --dry-run (with file listing)...")
    runtime_base = Path(temp_home) / ".omt" / "runtime"
    files_before_dryrun = list_files_with_metadata(runtime_base) if runtime_base.exists() else []

    cmd = [
        "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
        "runtime-install", "--org", str(ORG_FILE), "--state", temp_home, "--dry-run"
    ]
    install_dryrun = run_cmd(cmd, env)
    install_dryrun_data = parse_json_output(install_dryrun["stdout"])

    files_after_dryrun = list_files_with_metadata(runtime_base) if runtime_base.exists() else []
    results["tests"]["install-dryrun"] = {
        "command": " ".join(cmd[2:]),
        "code": install_dryrun["code"],
        "result": install_dryrun_data,
        "files_before_count": len(files_before_dryrun),
        "files_after_count": len(files_after_dryrun),
        "files_changed": len(files_before_dryrun) != len(files_after_dryrun),
    }

    # Extract fingerprint for later use
    fingerprint = None
    if install_dryrun_data.get("runtime", {}).get("prefixFingerprint"):
        fingerprint = install_dryrun_data["runtime"]["prefixFingerprint"].replace("sha256:", "")

    # Test 3: actual install with checksum
    print("Test 3: actual install (with checksum)...")
    cmd = [
        "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
        "runtime-install", "--org", str(ORG_FILE), "--state", temp_home
    ]
    install_actual = run_cmd(cmd, env)
    install_actual_data = parse_json_output(install_actual["stdout"])

    runtime_path = None
    if install_actual_data.get("runtime", {}).get("prefixFingerprint"):
        fingerprint = install_actual_data["runtime"]["prefixFingerprint"].replace("sha256:", "")
        runtime_path = get_runtime_path(fingerprint, temp_home)

    tree_hash_1 = file_tree_hash(runtime_path) if runtime_path and runtime_path.exists() else None
    files_after_install = list_files_with_metadata(runtime_path) if runtime_path and runtime_path.exists() else []

    results["tests"]["install-actual"] = {
        "command": " ".join(cmd[2:]),
        "code": install_actual["code"],
        "result": install_actual_data,
        "tree_hash": tree_hash_1,
        "file_count": len(files_after_install),
    }

    # Test 4: second install (idempotency) with npm check
    print("Test 4: second install (idempotency)...")
    cmd = [
        "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
        "runtime-install", "--org", str(ORG_FILE), "--state", temp_home
    ]
    install_second = run_cmd(cmd, env)
    install_second_data = parse_json_output(install_second["stdout"])

    tree_hash_2 = file_tree_hash(runtime_path) if runtime_path and runtime_path.exists() else None
    files_after_second = list_files_with_metadata(runtime_path) if runtime_path and runtime_path.exists() else []

    # Check if npm was called (look for npm output)
    npm_called = "npm ci" in install_second["stderr"] or "added" in install_second["stderr"]

    results["tests"]["install-second"] = {
        "command": " ".join(cmd[2:]),
        "code": install_second["code"],
        "result": install_second_data,
        "tree_hash": tree_hash_2,
        "file_count": len(files_after_second),
        "tree_hash_equal": tree_hash_1 == tree_hash_2 if tree_hash_1 and tree_hash_2 else None,
        "file_count_equal": len(files_after_install) == len(files_after_second),
        "npm_called_likely": npm_called,
    }

    # Test 5: damage (corrupt manifest.json)
    print("Test 5: damage simulation (corrupt manifest.json)...")
    manifest_file = None
    if runtime_path and runtime_path.exists():
        manifest_file = runtime_path / "manifest.json"
        if not manifest_file.exists():
            manifest_file = None

    damage_result = None
    if manifest_file:
        print(f"  Damaging {manifest_file}")
        backup_file = str(manifest_file) + ".backup"
        shutil.copy(str(manifest_file), backup_file)
        manifest_file.write_text("CORRUPTED")

        # Doctor should detect damage
        print("  Running doctor on damaged runtime...")
        cmd = [
            "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
            "runtime-doctor", "--org", str(ORG_FILE), "--state", temp_home, "--format", "json"
        ]
        doctor_damaged = run_cmd(cmd, env)
        doctor_damaged_data = parse_json_output(doctor_damaged["stdout"])

        # Repair
        print("  Attempting repair...")
        cmd = [
            "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
            "runtime-repair", "--org", str(ORG_FILE), "--state", temp_home
        ]
        repair = run_cmd(cmd, env)
        repair_data = parse_json_output(repair["stdout"])

        # Doctor after repair
        print("  Running doctor after repair...")
        cmd = [
            "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
            "runtime-doctor", "--org", str(ORG_FILE), "--state", temp_home, "--format", "json"
        ]
        doctor_repaired = run_cmd(cmd, env)
        doctor_repaired_data = parse_json_output(doctor_repaired["stdout"])

        damage_result = {
            "damage_method": "corrupt_manifest_json",
            "damaged_status": doctor_damaged_data.get("status"),
            "repair_command": "runtime-repair",
            "repair_status": repair_data.get("status"),
            "repaired_status": doctor_repaired_data.get("status"),
            "result": "pass" if doctor_repaired_data.get("status") == "ready" else "fail",
        }

        # Restore (backup may have been replaced during repair, skip if not found)
        if Path(backup_file).exists():
            shutil.copy(backup_file, str(manifest_file))

    results["tests"]["damage-manifest"] = damage_result or {"status": "skipped", "reason": "manifest not found"}

    # Test 6: failed staging (npm fails, existing runtime should be preserved)
    print("Test 6: failed staging test (npm fails)...")
    # Create a fake npm in PATH that fails
    fake_npm_dir = Path(temp_home) / "fake-npm-fail"
    fake_npm_dir.mkdir()
    fake_npm = fake_npm_dir / "npm"
    fake_npm.write_text("#!/bin/sh\nexit 1\n")
    fake_npm.chmod(0o755)

    # Get current runtime state before failed repair
    runtime_before_fail = None
    if runtime_path and runtime_path.exists():
        runtime_before_fail = list_files_with_metadata(runtime_path)

    # Corrupt and attempt repair with failing npm
    if manifest_file:
        manifest_file.write_text("CORRUPTED-FOR-FAILED-TEST")

    env_with_fake_npm = env.copy()
    env_with_fake_npm["PATH"] = str(fake_npm_dir) + ":" + env_with_fake_npm.get("PATH", "")

    cmd = [
        "node", str(WORKDIR / "plugins/oh-my-teams/scripts/teams-org.mjs"),
        "runtime-repair", "--org", str(ORG_FILE), "--state", temp_home
    ]
    failed_repair = run_cmd(cmd, env_with_fake_npm)

    # Check if runtime was preserved
    runtime_after_fail = None
    if runtime_path and runtime_path.exists():
        runtime_after_fail = list_files_with_metadata(runtime_path)

    results["tests"]["failed-staging"] = {
        "command": "runtime-repair (with failing npm in PATH)",
        "code": failed_repair["code"],
        "runtime_files_before": len(runtime_before_fail) if runtime_before_fail else 0,
        "runtime_files_after": len(runtime_after_fail) if runtime_after_fail else 0,
        "runtime_preserved": runtime_before_fail is not None and runtime_after_fail is not None and len(runtime_before_fail) == len(runtime_after_fail),
    }

    # Restore manifest (may have been replaced during repair, skip if not found)
    if manifest_file and backup_file and Path(backup_file).exists():
        shutil.copy(backup_file, str(manifest_file))

# Record global state after
print("Snapshotting global state (after)...")
results["global_state_after"] = snapshot_global_state()

# Compare global state
def compare_snapshots(before, after):
    """Compare before/after snapshots."""
    diff = {}
    for key in set(list(before.keys()) + list(after.keys())):
        if before.get(key) == after.get(key):
            diff[key] = "unchanged"
        else:
            diff[key] = {"before": before.get(key), "after": after.get(key)}
    return diff

results["global_state_diff"] = compare_snapshots(
    results["global_state_before"] or {},
    results["global_state_after"] or {}
)

# Output results
output_file = WORKDIR / "experiments/opencodex-w2-platform/runtime-test-results.json"
output_file.parent.mkdir(parents=True, exist_ok=True)
with open(output_file, "w") as f:
    json.dump(results, f, indent=2)

print(f"\nResults saved to: {output_file}")
print(f"HEAD: {results['head']}")
print(f"macOS version: {results['environment'].get('os', {}).get('ProductVersion')}")
print(f"Global state diff summary:")
for key, val in results["global_state_diff"].items():
    if isinstance(val, str):
        print(f"  {key}: {val}")
