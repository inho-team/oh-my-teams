"""Run a no-inference, isolated plugin installation probe."""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).parent
PLUGIN = ROOT / "plugin"


def run(command, *, cwd, env):
    """Run a command and retain only non-secret output and its exit code."""
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    return {
        "command": command,
        "exit": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def main():
    """Execute fixture, npm, and host CLI probes under temporary homes."""
    with tempfile.TemporaryDirectory(prefix="omt-host-probe-", dir="/tmp") as temp:
        temp_root = Path(temp)
        host_home = temp_root / "home"
        host_home.mkdir()
        codex_home = temp_root / "codex"
        codex_home.mkdir()
        host_plugin = temp_root / "plugin"
        shutil.copytree(PLUGIN, host_plugin)
        marker = temp_root / "lifecycle.marker"
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(host_home),
                "CODEX_HOME": str(codex_home),
                "OMT_MARKER": str(marker),
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            }
        )
        records = {
            "versions": [
                run(["claude", "--version"], cwd=temp_root, env=env),
                run(["codex", "--version"], cwd=temp_root, env=env),
                run(["npm", "--version"], cwd=temp_root, env=env),
                run(["bun", "--version"], cwd=temp_root, env=env),
            ],
            "isolation": {
                "home": str(host_home),
                "codex_home": str(codex_home),
                "original_home_not_read": True,
                "credentials_copied": False,
            },
            "checks": [],
        }
        records["checks"].append(
            {
                "name": "claude_validate",
                **run(
                    ["claude", "--bare", "plugin", "validate", str(host_plugin)],
                    cwd=temp_root,
                    env=env,
                ),
            }
        )
        records["checks"].append(
            {
                "name": "npm_ci_ignore_scripts",
                **run(
                    ["npm", "ci", "--ignore-scripts"], cwd=host_plugin, env=env
                ),
                "marker_exists": marker.exists(),
                "node_modules_exists": (host_plugin / "node_modules").is_dir(),
            }
        )
        records["checks"].append(
            {
                "name": "npm_install_lifecycle",
                **run(["npm", "install"], cwd=host_plugin, env=env),
                "marker_exists": marker.exists(),
                "marker_lines": marker.read_text().splitlines() if marker.exists() else [],
            }
        )
        records["checks"].append(
            {
                "name": "npm_ci_repeat_ignore_scripts",
                **run(
                    ["npm", "ci", "--ignore-scripts"], cwd=host_plugin, env=env
                ),
                "marker_lines": marker.read_text().splitlines() if marker.exists() else [],
            }
        )

        marketplace = temp_root / "marketplace"
        (marketplace / ".agents" / "plugins").mkdir(parents=True)
        shutil.copy2(
            ROOT / ".agents" / "plugins" / "marketplace.json",
            marketplace / ".agents" / "plugins" / "marketplace.json",
        )
        shutil.copytree(PLUGIN, marketplace / "plugin")
        codex_env = env | {"CODEX_HOME": str(codex_home)}
        records["checks"].append(
            {
                "name": "codex_marketplace_add",
                **run(
                    ["codex", "plugin", "marketplace", "add", str(marketplace), "--json"],
                    cwd=temp_root,
                    env=codex_env,
                ),
            }
        )
        cache_plugin = codex_home / "plugins" / "cache" / "omt-isolated-probe" / "install-probe" / "1.0.0"
        first_add = run(
            ["codex", "plugin", "add", "install-probe@omt-isolated-probe", "--json"],
            cwd=temp_root,
            env=codex_env,
        )
        first_add.update(
            {
                "name": "codex_plugin_add",
                "cache_has_node_modules": (cache_plugin / "node_modules").is_dir(),
                "marker_lines": marker.read_text().splitlines() if marker.exists() else [],
            }
        )
        records["checks"].append(first_add)
        repeat_add = run(
            ["codex", "plugin", "add", "install-probe@omt-isolated-probe", "--json"],
            cwd=temp_root,
            env=codex_env,
        )
        repeat_add.update(
            {
                "name": "codex_plugin_add_repeat",
                "cache_has_node_modules": (cache_plugin / "node_modules").is_dir(),
                "marker_lines": marker.read_text().splitlines() if marker.exists() else [],
            }
        )
        records["checks"].append(repeat_add)
        records["codex_cache_entries"] = sorted(
            str(path.relative_to(codex_home))
            for path in codex_home.rglob("*")
            if path.is_file() and "auth" not in path.name.lower()
        )
        records["lifecycle_marker_lines"] = marker.read_text().splitlines() if marker.exists() else []
        records["ocx_2_59_0"] = {
            "status": "not_run",
            "reason": "ocx is not on PATH; no OpenCodex 2.59.0 executable was available.",
        }
        (ROOT / "result.json").write_text(json.dumps(records, indent=2) + "\n")


if __name__ == "__main__":
    main()
