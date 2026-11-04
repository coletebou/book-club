"""The remote recogniser and its client, end to end with a stand-in for transcribe.py (no model, no GPU).

    python3 -I -m unittest discover -s tools/align -p 'test_*.py'
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).parent
TOKEN = "test-token-0123456789"

# Writes what transcribe.py writes, one word per track; FAKE_MODE changes how it behaves.
FAKE = r'''
import hashlib, json, os, sys, time
args = sys.argv[1:]
mode = os.environ.get("FAKE_MODE", "ok")
out = args[args.index("--out") + 1]
tracks = args[args.index("--out") + 2:]
if mode == "slow":
    time.sleep(60)
if mode == "fail":
    print("boom", file=sys.stderr); sys.exit(3)
doc = {"format": "bookclub-transcript/1", "engine": "fake", "model": os.environ.get("FAKE_NAME", "fake"), "tracks": []}
for p in tracks:
    digest = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if mode == "badsha":
        digest = "0" * 64
    doc["tracks"].append({"file": os.path.basename(p), "sha256": digest, "durationMs": 1000, "words": [[0, 500, "Alice", 0.9]]})
    print(f"{os.path.basename(p)}: 1 words", file=sys.stderr, flush=True)
open(out, "w").write(json.dumps(doc))
'''


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.fake = self.tmp / "fake_transcribe.py"
        self.fake.write_text(FAKE)
        self.tracks = []
        for i in range(2):
            p = self.tmp / f"blob{i}"
            p.write_bytes(os.urandom(300_000 + i))
            self.tracks.append(str(p))
        self.out = str(self.tmp / "out.json")
        self.service = None

    def tearDown(self):
        if self.service:
            self.service.terminate()
            self.service.wait(10)
        subprocess.run(["rm", "-rf", str(self.tmp)])

    def start_service(self, mode="ok"):
        self.port = free_port()
        env = {**os.environ, "TRANSCRIBE_SERVICE_TOKEN": TOKEN, "FAKE_MODE": mode, "FAKE_NAME": "remote",
               "TRANSCRIBE_DISK_HEADROOM": str(1 << 20)}
        self.service = subprocess.Popen(
            [sys.executable, "-I", str(HERE / "transcribe_service.py"), "--listen", f"127.0.0.1:{self.port}",
             "--workdir", str(self.tmp / "work"), "--busy-file", str(self.tmp / "busy"), "--",
             sys.executable, "-I", str(self.fake)],
            env=env, stderr=open(self.tmp / "service.log", "wb"))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.2).close()
                return
            except OSError:
                time.sleep(0.05)
        self.fail("service did not start")

    def client(self, url=None, token=TOKEN, wait=True, **extra):
        env = {"PATH": os.environ["PATH"], "FAKE_NAME": "local", "TRANSCRIBE_REMOTE_LOST_AFTER": "2", **extra}
        if url is not False:
            env["TRANSCRIBE_REMOTE_URL"] = url or f"http://127.0.0.1:{self.port}"
            env["TRANSCRIBE_REMOTE_TOKEN"] = token
        p = subprocess.Popen([sys.executable, "-I", str(HERE / "transcribe_remote.py"), sys.executable, "-I",
                              str(self.fake), "--out", self.out, *self.tracks],
                             env=env, stderr=subprocess.PIPE, text=True, start_new_session=True)
        if wait:
            p.stderr_text = p.communicate(timeout=60)[1]
        return p

    def result(self):
        doc = json.loads(Path(self.out).read_text())
        self.assertEqual(doc["format"], "bookclub-transcript/1")
        for track, path in zip(doc["tracks"], self.tracks):
            self.assertEqual(track["file"], os.path.basename(path))
            self.assertEqual(track["sha256"], hashlib.sha256(Path(path).read_bytes()).hexdigest())
            self.assertTrue(track["words"])
        return doc

    def test_remote_transcribes(self):
        self.start_service()
        p = self.client()
        self.assertEqual(p.returncode, 0, p.stderr_text)
        self.assertEqual(self.result()["model"], "remote")
        self.assertIn("remote job", p.stderr_text)
        self.assertEqual(os.listdir(self.tmp / "work"), [])  # the job is removed once read

    def test_no_url_runs_locally(self):
        p = self.client(url=False)
        self.assertEqual(p.returncode, 0, p.stderr_text)
        self.assertEqual(self.result()["model"], "local")

    def test_unreachable_falls_back(self):
        p = self.client(url=f"http://127.0.0.1:{free_port()}")
        self.assertEqual(p.returncode, 0, p.stderr_text)
        self.assertEqual(self.result()["model"], "local")
        self.assertIn("transcribing locally", p.stderr_text)

    def test_wrong_token_falls_back(self):
        self.start_service()
        p = self.client(token="wrong-token-0123456789")
        self.assertEqual(self.result()["model"], "local")
        self.assertIn("401", p.stderr_text)

    def test_remote_failure_falls_back(self):
        self.start_service("fail")
        p = self.client()
        self.assertEqual(p.returncode, 0, p.stderr_text)
        self.assertEqual(self.result()["model"], "local")

    def test_wrong_sha_falls_back(self):
        self.start_service("badsha")
        p = self.client()
        self.assertIn("SHA-256", p.stderr_text)
        self.assertEqual(self.result()["model"], "local")

    def test_lost_midway_falls_back(self):
        self.start_service("slow")
        p = self.client(wait=False)
        for _ in range(100):
            if (self.tmp / "work").exists() and any((self.tmp / "work").iterdir()):
                break
            time.sleep(0.1)
        time.sleep(0.5)
        self.service.kill()  # the box stopping under it
        self.service.wait()
        self.service = None
        _, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 0, err)
        self.assertIn("lost", err)
        self.assertEqual(self.result()["model"], "local")

    def test_sigterm_cancels_remote_job(self):
        self.start_service("slow")
        p = self.client(wait=False)
        busy = self.tmp / "busy"
        for _ in range(200):
            if busy.exists():
                break
            time.sleep(0.1)
        self.assertTrue(busy.exists(), "busy file written while a job runs")
        os.killpg(p.pid, signal.SIGTERM)  # as the server stops it: the whole group
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 128 + signal.SIGTERM)
        self.assertFalse(Path(self.out).exists())
        for _ in range(100):
            if not any((self.tmp / "work").iterdir()):
                break
            time.sleep(0.1)
        self.assertEqual(os.listdir(self.tmp / "work"), [])


if __name__ == "__main__":
    unittest.main()
