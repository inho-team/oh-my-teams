"""Run a no-inference, isolated plugin installation probe."""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).parent
PLUGIN = ROOT / "plugin"
OCX = Path("/tmp/omt-opencodex-probe.dAKX3U/install/node_modules/.bin/ocx")


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
        claude_marketplace = temp_root / "claude-marketplace"
        (claude_marketplace / ".claude-plugin").mkdir(parents=True)
        shutil.copy2(
            ROOT / ".claude-plugin" / "marketplace.json",
            claude_marketplace / ".claude-plugin" / "marketplace.json",
        )
        shutil.copytree(PLUGIN, claude_marketplace / "plugin")
        claude_add = run(
            [
                "claude",
                "--bare",
                "plugin",
                "marketplace",
                "add",
                str(claude_marketplace),
                "--scope",
                "local",
            ],
            cwd=temp_root,
            env=env,
        )
        records["checks"].append({"name": "claude_marketplace_add", **claude_add})
        claude_install = run(
            [
                "claude",
                "--bare",
                "plugin",
                "install",
                "install-probe@omt-isolated-probe",
                "--scope",
                "local",
                "--yes",
                "--json",
            ],
            cwd=temp_root,
            env=env,
        )
        claude_install.update(
            {
                "name": "claude_plugin_install",
                "marker_lines": marker.read_text().splitlines() if marker.exists() else [],
            }
        )
        records["checks"].append(claude_install)
        records["checks"].append(
            {
                "name": "claude_plugin_install_repeat",
                **run(
                    [
                        "claude",
                        "--bare",
                        "plugin",
                        "install",
                        "install-probe@omt-isolated-probe",
                        "--scope",
                        "local",
                        "--yes",
                        "--json",
                    ],
                    cwd=temp_root,
                    env=env,
                ),
                "marker_lines": marker.read_text().splitlines() if marker.exists() else [],
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
        marker_before_codex = marker.read_text().splitlines() if marker.exists() else []
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
                "marker_before_host_install": marker_before_codex,
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
                "marker_before_host_install": marker_before_codex,
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
        ocx_home = temp_root / "ocx-home"
        ocx_env = env | {
            "HOME": str(ocx_home),
            "XDG_CONFIG_HOME": str(ocx_home / "config"),
            "XDG_DATA_HOME": str(ocx_home / "data"),
            "XDG_CACHE_HOME": str(ocx_home / "cache"),
            "CODEX_HOME": str(ocx_home / "codex"),
        }
        for path in [
            ocx_home,
            ocx_home / "config",
            ocx_home / "data",
            ocx_home / "cache",
            ocx_home / "codex",
        ]:
            path.mkdir(parents=True, exist_ok=True)
        records["ocx_2_59_0"] = {
            "path": str(OCX),
            "version": run([str(OCX), "--version"], cwd=temp_root, env=ocx_env),
            "health": run([str(OCX), "health", "--json"], cwd=temp_root, env=ocx_env),
            "ready": run([str(OCX), "ready", "--json"], cwd=temp_root, env=ocx_env),
            "capabilities": run(
                [str(OCX), "capabilities", "--json"], cwd=temp_root, env=ocx_env
            ),
            "isolated_home": str(ocx_home),
        }
        (ROOT / "result.json").write_text(json.dumps(records, indent=2) + "\n")


if __name__ == "__main__":
    main()
