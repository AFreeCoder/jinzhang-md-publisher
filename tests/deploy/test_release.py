"""在临时目录执行真实发布脚本，替换 Docker/网络边界，验证失败时的文件与运行态。"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OLD_SHA = "1" * 40
NEW_SHA = "2" * 40
OLD_IMAGE = "ghcr.io/afreecoder/jinzhang@sha256:" + "a" * 64
NEW_IMAGE = "ghcr.io/afreecoder/jinzhang@sha256:" + "b" * 64

MOCK = r'''#!/usr/bin/env python3
import fcntl, json, os, pathlib, signal, sys
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ["TEST_ROOT"])
state_path = root / "state.json"
state = json.loads(state_path.read_text())
mode = os.environ.get("TEST_FAILURE", "")
old = os.environ["OLD_IMAGE"]
new = os.environ["NEW_IMAGE"]
old_sha, new_sha = "1" * 40, "2" * 40
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps([tool, *args]) + "\n")
def save(): state_path.write_text(json.dumps(state))
if tool == "flock":
    try: fcntl.flock(int(args[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(1)
elif tool == "sleep": pass
elif tool == "git":
    if mode == "git_error": sys.exit(128)
    sha = new_sha
    if mode == "stale" or (mode == "stale_after_pull" and state.get("pulled")):
        sha = "3" * 40
    print(sha + "\trefs/heads/main")
elif tool == "curl":
    url = args[-1]
    if state["image"] == new:
        if mode == "public" and url.startswith("https:"): sys.exit(22)
        if mode == "page" and url.endswith("/format"): sys.exit(22)
    if url.endswith("/api/health"):
        sha = old_sha if state["image"] == old else new_sha
        if mode == "health" and state["image"] == new: sha = old_sha
        print(json.dumps({"status": "ready", "revision": sha, "transitConfigured": True}))
elif tool == "docker":
    if args[0] == "login":
        state["logged_in"] = bool(sys.stdin.read())
        save()
        if mode == "login": sys.exit(1)
    elif args[0] == "pull":
        if mode == "pull": sys.exit(1)
        state["pulled"] = True
        save()
    elif args[:2] == ["image", "inspect"]:
        print(old_sha if mode == "image_revision" else new_sha)
    elif args[0] == "inspect":
        if "Config.Image" in args[2]:
            print(new if mode == "drift" else state["image"])
        else: print(old_sha if state["image"] == old else new_sha)
    elif args[0] == "compose":
        folder = pathlib.Path(args[args.index("--project-directory") + 1])
        command = args[args.index("-f") + 2]
        if command == "ps": print("jinzhang-web-1")
        elif command == "config" and mode == "config": sys.exit(1)
        elif command == "run":
            assert args[args.index("--entrypoint") + 1] == "haproxy"
            if mode == "haproxy": sys.exit(1)
        elif command == "up":
            state["image"] = (folder / ".env").read_text().strip().split("=", 1)[1]
            state.setdefault("started", []).append(state["image"])
            save()
            if state["image"] == new and mode == "signal":
                os.kill(os.getppid(), signal.SIGTERM)
                sys.exit(1)
            if state["image"] == new and mode in ("up", "recovery"):
                sys.exit(1)
            if state["image"] == old and mode == "recovery": sys.exit(1)
else: raise AssertionError(tool)
'''


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.deploy = self.root / "production"
        self.deploy.mkdir()
        self.backups = self.root / "backups"
        self.originals = {
            ".env": f"JINZHANG_IMAGE={OLD_IMAGE}\n",
            ".env.production": "TEST_SECRET=never-print-test-secret\n",
            ".env.previous": "previous-release-reference\n",
            "compose.yaml": "old compose configuration\n",
            "haproxy.cfg": "old gateway configuration\n",
        }
        for name, value in self.originals.items():
            (self.deploy / name).write_text(value)
        (self.root / "Caddyfile").write_text("unchanged shared proxy\n")
        (self.root / "state.json").write_text(json.dumps({"image": OLD_IMAGE}))
        binaries = self.root / "bin"
        binaries.mkdir()
        for name in ("docker", "curl", "git", "flock", "sleep"):
            path = binaries / name
            path.write_text(MOCK)
            path.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "TEST_ROOT": str(self.root),
            "JINZHANG_DEPLOY_DIR": str(self.deploy),
            "JINZHANG_BACKUP_ROOT": str(self.backups),
            "JINZHANG_CADDY_CONFIG": str(self.root / "Caddyfile"),
            "OLD_IMAGE": OLD_IMAGE,
            "NEW_IMAGE": NEW_IMAGE,
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_release(self, mode="", image=NEW_IMAGE):
        result = subprocess.run(
            ["bash", str(ROOT / "deploy/release.sh"), image, NEW_SHA, "test-user"],
            env={**self.env, "TEST_FAILURE": mode}, input="temporary-test-token",
            text=True, capture_output=True, timeout=20,
        )
        self.output = result.stdout + result.stderr
        self.assertNotIn("never-print-test-secret", self.output)
        self.assertNotIn("temporary-test-token", self.output)
        self.assertEqual(list(self.deploy.glob(".candidate.*")), [])
        self.assertEqual((self.root / "Caddyfile").read_text(), "unchanged shared proxy\n")
        return result

    def state(self):
        return json.loads((self.root / "state.json").read_text())

    def assert_original_files(self):
        for name, value in self.originals.items():
            self.assertEqual((self.deploy / name).read_text(), value, name)

    def test_success_updates_version_and_preserves_complete_private_backup(self):
        self.assertEqual(self.run_release().returncode, 0, self.output)
        self.assertEqual(self.state()["image"], NEW_IMAGE)
        self.assertEqual((self.deploy / ".env.previous").read_text(), self.originals[".env"])
        self.assertEqual((self.deploy / ".env.production").read_text(), self.originals[".env.production"])
        self.assertEqual((self.deploy / "compose.yaml").read_bytes(), (ROOT / "deploy/compose.yaml").read_bytes())
        backup, = self.backups.iterdir()
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        for name, value in self.originals.items():
            self.assertEqual((backup / name).read_text(), value)
            self.assertEqual((backup / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual((backup / "Caddyfile").read_text(), "unchanged shared proxy\n")
        self.assertIn("部署成功", self.output)

    def test_preflight_failures_never_replace_running_services(self):
        for mode in ("git_error", "drift", "login", "pull", "image_revision", "config", "haproxy"):
            with self.subTest(mode=mode):
                self.assertNotEqual(self.run_release(mode).returncode, 0, self.output)
                self.assert_original_files()
                self.assertEqual(self.state()["image"], OLD_IMAGE)
                self.assertNotIn("started", self.state())

    def test_stale_release_is_skipped_before_downloading(self):
        self.assertEqual(self.run_release("stale").returncode, 0, self.output)
        self.assert_original_files()
        self.assertNotIn("pulled", self.state())

    def test_main_advancing_during_pull_does_not_change_production(self):
        self.assertEqual(self.run_release("stale_after_pull").returncode, 0, self.output)
        self.assert_original_files()
        self.assertNotIn("started", self.state())

    def test_activation_and_acceptance_failures_restore_previous_version(self):
        for mode in ("up", "health", "public", "page", "signal"):
            with self.subTest(mode=mode):
                self.assertNotEqual(self.run_release(mode).returncode, 0, self.output)
                self.assert_original_files()
                self.assertEqual(self.state()["image"], OLD_IMAGE)
                self.assertEqual(self.state()["started"][-2:], [NEW_IMAGE, OLD_IMAGE])
                self.assertIn("旧版本已恢复", self.output)

    def test_recovery_failure_is_reported_without_success(self):
        self.assertNotEqual(self.run_release("recovery").returncode, 0, self.output)
        self.assert_original_files()
        self.assertIn("自动恢复未通过", self.output)
        self.assertNotIn("旧版本已恢复", self.output)

    def test_release_lock_prevents_parallel_changes(self):
        with (self.deploy / ".release.lock").open("w") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.run_release().returncode, 0, self.output)
        self.assert_original_files()
        self.assertNotIn("started", self.state())

    def test_missing_backup_source_fails_without_touching_services(self):
        (self.root / "Caddyfile").unlink()
        result = subprocess.run(
            ["bash", str(ROOT / "deploy/release.sh"), NEW_IMAGE, NEW_SHA],
            env=self.env, text=True, capture_output=True, timeout=20,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assert_original_files()
        self.assertNotIn("started", self.state())

    def test_mutable_image_tag_is_rejected(self):
        self.assertNotEqual(self.run_release(image="ghcr.io/afreecoder/jinzhang:latest").returncode, 0)
        self.assert_original_files()


if __name__ == "__main__":
    unittest.main()
