"""验证 runner 的版本门禁、SSH 主机验证、临时凭据清理及失败传播。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SHA = "2" * 40
IMAGE = "ghcr.io/afreecoder/jinzhang@sha256:" + "b" * 64

MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["TEST_ROOT"])
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
mode = os.environ.get("TEST_FAILURE", "")
with (root / "calls.jsonl").open("a") as f:
    f.write(json.dumps([tool, *args]) + "\n")
if tool == "git":
    if args[0] == "rev-parse": print("1" * 40 if mode == "checkout" else "2" * 40)
    else: print(("3" * 40 if mode == "stale" else "2" * 40) + "\trefs/heads/main")
elif tool == "ssh":
    assert "StrictHostKeyChecking=yes" in args
    assert "IdentitiesOnly=yes" in args
    key = pathlib.Path(args[args.index("-i") + 1])
    assert key.read_text().strip() == "private-test-key"
    assert key.stat().st_mode & 0o777 == 0o600
    hosts = pathlib.Path(next(a.split("=", 1)[1] for a in args if a.startswith("UserKnownHostsFile=")))
    assert hosts.read_text().strip() == "trusted-host-key"
    if mode == "connection": sys.exit(255)
    command = args[-1]
    if "mktemp" in command:
        print("/unsafe/path" if mode == "path" else "/home/work/online/.jinzhang-release.Test123")
    elif command.startswith("tar"):
        sys.stdin.buffer.read()
    elif command.startswith("bash"):
        assert sys.stdin.read() == "temporary-test-token"
        (root / "delivered").touch()
        if mode == "deployment": sys.exit(1)
'''


class SSHTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        binaries = self.root / "bin"
        binaries.mkdir()
        for tool in ("git", "ssh"):
            path = binaries / tool
            path.write_text(MOCK)
            path.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "TEST_ROOT": str(self.root), "TMPDIR": str(self.root),
            "DEPLOY_REVISION": SHA, "DEPLOY_IMAGE": IMAGE,
            "SILICON_HOST": "example.invalid",
            "SILICON_SSH_PRIVATE_KEY": "private-test-key",
            "SILICON_SSH_KNOWN_HOSTS": "trusted-host-key",
            "GITHUB_ACTOR": "test-user", "GHCR_TOKEN": "temporary-test-token",
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_deploy(self, mode="", **overrides):
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/deploy-ssh.sh")], cwd=ROOT,
            env={**self.env, "TEST_FAILURE": mode, **overrides},
            capture_output=True, text=True, timeout=15,
        )
        self.output = result.stdout + result.stderr
        self.assertNotIn("private-test-key", self.output)
        self.assertNotIn("temporary-test-token", self.output)
        self.assertEqual(list(self.root.glob("tmp.*")), [])
        return result

    def calls(self):
        path = self.root / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_success_uses_pinned_host_and_stdin_token_then_cleans_up(self):
        self.assertEqual(self.run_deploy().returncode, 0, self.output)
        self.assertTrue((self.root / "delivered").exists())
        calls = self.calls()
        self.assertTrue(calls[-1][-1].startswith("rm -rf -- '/home/work/online/.jinzhang-release."))
        self.assertNotIn("temporary-test-token", json.dumps(calls))

    def test_missing_credentials_and_checkout_mismatch_do_not_connect(self):
        for mode, overrides in [("", {"SILICON_SSH_PRIVATE_KEY": ""}), ("checkout", {})]:
            with self.subTest(mode=mode):
                self.assertNotEqual(self.run_deploy(mode, **overrides).returncode, 0)
                self.assertFalse(any(c[0] == "ssh" for c in self.calls()))

    def test_stale_build_does_not_connect(self):
        self.assertEqual(self.run_deploy("stale").returncode, 0, self.output)
        self.assertFalse(any(c[0] == "ssh" for c in self.calls()))

    def test_ssh_failure_removes_private_key(self):
        self.assertNotEqual(self.run_deploy("connection").returncode, 0)

    def test_remote_deployment_failure_propagates_and_cleans_staging(self):
        self.assertNotEqual(self.run_deploy("deployment").returncode, 0)
        self.assertTrue(self.calls()[-1][-1].startswith("rm -rf"))

    def test_unexpected_remote_path_is_not_used_or_removed(self):
        self.assertNotEqual(self.run_deploy("path").returncode, 0)
        self.assertFalse(any("rm -rf" in c[-1] or "tar -xzf" in c[-1] for c in self.calls()))


if __name__ == "__main__":
    unittest.main()
