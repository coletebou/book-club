"""Progress file helpers and remote progressDetail, without a real model."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from progress import write_progress  # noqa: E402

FAKE_RECOGNISER = r'''
import json, os, sys, time
def prog(stage, **kw):
    doc = {"format": "bookclub-transcribe-progress/1", "stage": stage, "updatedAt": time.time(), **kw}
    print("PROGRESS " + json.dumps(doc, separators=(",", ":")), file=sys.stderr, flush=True)
    path = os.environ.get("TRANSCRIBE_PROGRESS_FILE", "").strip()
    if path:
        open(path + ".tmp", "w").write(json.dumps(doc))
        os.replace(path + ".tmp", path)
args = sys.argv[1:]
out = args[args.index("--out") + 1]
tracks = args[args.index("--out") + 2:]
prog("transcribing_gpu", tracksDone=0, tracksTotal=len(tracks), audioMsDone=0, engine="gpu", startedAt=time.time())
time.sleep(0.4)
prog("transcribing_gpu", tracksDone=len(tracks), tracksTotal=len(tracks), audioMsDone=1000, engine="gpu", startedAt=time.time() - 1)
doc = {"format": "bookclub-transcript/1", "engine": "fake", "model": "fake", "tracks": []}
for p in tracks:
    digest = __import__("hashlib").sha256(open(p, "rb").read()).hexdigest()
    doc["tracks"].append({"file": os.path.basename(p), "sha256": digest, "durationMs": 1000, "words": [[0, 500, "Hi", 0.9]]})
open(out, "w").write(json.dumps(doc))
'''


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ProgressHelpers(unittest.TestCase):
    def test_write_progress_atomic_and_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "progress.json"
            env = {
                "TRANSCRIBE_PROGRESS_FILE": str(path),
                "TRANSCRIBE_TRACKS_TOTAL": "3",
                "TRANSCRIBE_AUDIO_MS_TOTAL": "90000",
            }
            # Capture stderr from write_progress by redirecting in-process.
            import io
            from contextlib import redirect_stderr
            old = {k: os.environ.get(k) for k in env}
            try:
                os.environ.update(env)
                buf = io.StringIO()
                with redirect_stderr(buf):
                    write_progress(
                        "transcribing_cpu",
                        tracks_done=1,
                        audio_ms_done=30000,
                        started_at=1700000000.0,
                        engine="cpu",
                    )
            finally:
                for k, v in old.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
            self.assertTrue(path.exists())
            doc = json.loads(path.read_text())
            self.assertEqual(doc["format"], "bookclub-transcribe-progress/1")
            self.assertEqual(doc["stage"], "transcribing_cpu")
            self.assertEqual(doc["tracksDone"], 1)
            self.assertEqual(doc["tracksTotal"], 3)
            self.assertEqual(doc["audioMsDone"], 30000)
            self.assertEqual(doc["audioMsTotal"], 90000)
            self.assertTrue(any(line.startswith("PROGRESS ") for line in buf.getvalue().splitlines()))

    def test_write_progress_noop_without_env(self):
        import io
        from contextlib import redirect_stderr
        os.environ.pop("TRANSCRIBE_PROGRESS_FILE", None)
        with redirect_stderr(io.StringIO()):
            write_progress("queued")  # must not raise


class ServiceProgressDetail(unittest.TestCase):
    def test_service_forwards_progress_detail(self):
        token = "test-token-0123456789"
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            fake = tmp / "fake.py"
            fake.write_text(FAKE_RECOGNISER)
            track = tmp / "a.mp3"
            track.write_bytes(os.urandom(50_000))
            port = free_port()
            env = {**os.environ, "TRANSCRIBE_SERVICE_TOKEN": token, "TRANSCRIBE_DISK_HEADROOM": str(1 << 20)}
            service = subprocess.Popen(
                [
                    sys.executable,
                    "-I",
                    str(HERE / "transcribe_service.py"),
                    "--listen",
                    f"127.0.0.1:{port}",
                    "--workdir",
                    str(tmp / "work"),
                    "--",
                    sys.executable,
                    "-I",
                    str(fake),
                ],
                env=env,
                cwd=str(HERE),
                stderr=subprocess.DEVNULL,
            )
            try:
                for _ in range(100):
                    try:
                        socket.create_connection(("127.0.0.1", port), 0.2).close()
                        break
                    except OSError:
                        time.sleep(0.05)
                else:
                    self.fail("service did not start")
                out = tmp / "out.json"
                env_c = {
                    "PATH": os.environ["PATH"],
                    "TRANSCRIBE_REMOTE_URL": f"http://127.0.0.1:{port}",
                    "TRANSCRIBE_REMOTE_TOKEN": token,
                    "TRANSCRIBE_REMOTE_LOST_AFTER": "5",
                    "TRANSCRIBE_PROGRESS_FILE": str(tmp / "client-progress.json"),
                }
                client = subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        str(HERE / "transcribe_remote.py"),
                        sys.executable,
                        "-I",
                        str(fake),
                        "--out",
                        str(out),
                        str(track),
                    ],
                    env=env_c,
                    cwd=str(HERE),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                self.assertEqual(client.returncode, 0, client.stderr)
                progress = json.loads((tmp / "client-progress.json").read_text())
                self.assertEqual(progress["format"], "bookclub-transcribe-progress/1")
                self.assertIn(progress["stage"], ("uploading", "transcribing_gpu"))
                self.assertEqual(json.loads(out.read_text())["format"], "bookclub-transcript/1")
            finally:
                service.terminate()
                service.wait(10)


if __name__ == "__main__":
    unittest.main()
