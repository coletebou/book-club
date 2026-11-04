#!/usr/bin/env python3
"""A remote recogniser for Book Club: transcribe.py on a GPU, behind a small authenticated HTTP API.

    TRANSCRIBE_SERVICE_TOKEN_FILE=/etc/bookclub-transcriber/token \\
    transcribe_service.py --listen 127.0.0.1:8790 --workdir /var/tmp/bookclub-transcriber \\
        -- venv/bin/python -I transcribe.py --device cuda --model small.en

tools/align/transcribe_remote.py, the server's TRANSCRIBE_COMMAND, talks to it (docs/GPU-TRANSCRIPTION.md).
Everything after `--` is the recogniser's command line; `--out <json> <tracks...>` is added, so its
output is transcribe.py's own. One job at a time (a second gets 503, and is transcribed locally by
its caller). Only stdlib.

  GET    /healthz                 {"ok": true, "busy": bool}
  POST   /jobs                    {"tracks": [{"name", "size", "sha256"}]}  -> 201 {"id"}
  PUT    /jobs/<id>/tracks/<i>    the track's bytes (Content-Length), checked against size and sha256;
                                  the recogniser starts once every track is in
  GET    /jobs/<id>               {"state": uploading|running|done|failed, "error", "progress", "progressDetail"?}
  GET    /jobs/<id>/result        the transcript JSON, once done
  DELETE /jobs/<id>               stop and forget it

Every request needs `Authorization: Bearer <token>`. A job its caller stops asking about (--abandon
seconds) is stopped and removed. While a job exists, --busy-file is touched every 15 s so that the
box's idle shutdown counts it as work.
"""
import argparse
import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

# python -I omits the script directory from sys.path; keep sibling imports working.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from progress import parse_progress_line
except ImportError:  # GPU box may still have only the two scripts until redeployed
    def parse_progress_line(text):
        if not text.startswith("PROGRESS "):
            return None
        try:
            doc = json.loads(text[len("PROGRESS "):])
        except json.JSONDecodeError:
            return None
        if not isinstance(doc, dict) or doc.get("format") != "bookclub-transcribe-progress/1":
            return None
        return doc

CHUNK = 1 << 20
MAX_TRACKS = 2000
MAX_TRACK_BYTES = 8 << 30


class Job:
    def __init__(self, job_id, tracks, root):
        self.id, self.tracks, self.dir = job_id, tracks, os.path.join(root, job_id)
        self.have = [False] * len(tracks)
        self.state, self.error, self.progress = "uploading", None, None
        # Structured progress from a PROGRESS stderr line (bookclub-transcribe-progress/1);
        # absent on older recognisers that only print human lines.
        self.progressDetail = None
        self.proc, self.seen = None, time.time()
        os.makedirs(self.dir, mode=0o700)

    def path(self, i):
        # Each in a directory of its own, under its own base name: transcribe.py names a track by it.
        return os.path.join(self.dir, str(i), self.tracks[i]["name"])

    @property
    def out(self):
        return os.path.join(self.dir, "transcript.json")


class Service:
    def __init__(self, token, workdir, command, busy_file, abandon):
        self.token, self.workdir, self.command = token.encode(), workdir, command
        self.busy_file, self.abandon = busy_file, abandon
        self.lock = threading.Lock()
        self.job = None
        os.makedirs(workdir, mode=0o700, exist_ok=True)
        for name in os.listdir(workdir):  # left by a run before a restart
            shutil.rmtree(os.path.join(workdir, name), ignore_errors=True)

    def authorised(self, header):
        given = (header or "").removeprefix("Bearer ").encode()
        return bool(self.token) and hmac.compare_digest(given, self.token)

    def start(self, job):
        argv = [*self.command, "--out", job.out, *(job.path(i) for i in range(len(job.tracks)))]
        env = os.environ.copy()
        # Recogniser writes the progress file the service forwards as progressDetail; also used
        # when the caller (transcribe_remote) is an older one that only reads the human string.
        env.setdefault("TRANSCRIBE_PROGRESS_FILE", os.path.join(job.dir, "progress.json"))
        env.setdefault("TRANSCRIBE_TRACKS_TOTAL", str(len(job.tracks)))
        job.proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, start_new_session=True, env=env)
        job.state = "running"
        log(f"job {job.id}: transcribing {len(job.tracks)} tracks")
        threading.Thread(target=self.watch, args=(job,), daemon=True).start()

    def watch(self, job):
        tail = []
        for line in job.proc.stderr:
            text = line.decode("utf-8", "replace").rstrip()
            detail = parse_progress_line(text)
            if detail is not None:
                job.progressDetail = detail
                # Keep a short human line for older callers that only read `progress`.
                tracks = detail.get("tracksDone"), detail.get("tracksTotal")
                if tracks[0] is not None and tracks[1]:
                    job.progress = f"track {tracks[0]}/{tracks[1]}"
                continue
            tail = (tail + [text])[-20:]
            job.progress = text[-200:]
            log(f"job {job.id}: {text}")
        code = job.proc.wait()
        with self.lock:
            if job.state != "running":
                return
            if code == 0 and os.path.exists(job.out):
                job.state = "done"
            else:
                job.state, job.error = "failed", f"recogniser exited with {code}: {tail[-1] if tail else ''}"
            log(f"job {job.id}: {job.state}{' ' + job.error if job.error else ''}")

    def drop(self, job):
        """Stop a job and remove its files (with the lock held)."""
        if job.proc and job.proc.poll() is None:
            try:
                os.killpg(job.proc.pid, signal.SIGTERM)
                job.proc.wait(10)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(job.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        job.state = "gone"
        shutil.rmtree(job.dir, ignore_errors=True)
        if self.job is job:
            self.job = None
        log(f"job {job.id}: removed")

    def tend(self):
        while True:
            with self.lock:
                job = self.job
                if job and time.time() - job.seen > self.abandon:
                    log(f"job {job.id}: abandoned by its caller")
                    self.drop(job)
                    job = None
            self.mark(job)
            time.sleep(15)

    def mark(self, job):
        if not self.busy_file:
            return
        try:
            if job:
                with open(self.busy_file, "w") as f:
                    f.write(f"{job.id} {job.state}\n")
            elif os.path.exists(self.busy_file):
                os.remove(self.busy_file)
        except OSError as e:
            log(f"busy file: {e}")


def log(message):
    print(message, file=sys.stderr, flush=True)


def handler(service):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "bookclub-transcriber"

        def log_message(self, fmt, *args):
            pass

        def reply(self, status, body=None, raw=None):
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def gate(self):
            if not service.authorised(self.headers.get("authorization")):
                self.close_connection = True
                self.reply(401, {"error": "unauthorised"})
                return None
            m = re.fullmatch(r"/jobs/([0-9a-f]{32})(?:/(tracks/(\d+)|result))?", self.path)
            return m or True

        def current(self, m):
            job = service.job
            if not job or m is True or job.id != m.group(1):
                self.reply(404, {"error": "no such job"})
                return None
            job.seen = time.time()
            return job

        def do_GET(self):
            m = self.gate()
            if not m:
                return
            if self.path == "/healthz":
                return self.reply(200, {"ok": True, "busy": service.job is not None})
            job = self.current(m)
            if not job:
                return
            if m.group(2) == "result":
                if job.state != "done":
                    return self.reply(409, {"error": f"job is {job.state}"})
                with open(job.out, "rb") as f:
                    return self.reply(200, raw=f.read())
            if m.group(2) is None:
                body = {"state": job.state, "error": job.error, "progress": job.progress}
                if job.progressDetail is not None:
                    body["progressDetail"] = job.progressDetail
                return self.reply(200, body)
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            m = self.gate()
            if not m:
                return
            if self.path != "/jobs":
                return self.reply(404, {"error": "not found"})
            length = int(self.headers.get("content-length") or 0)
            if length > 1 << 20:
                self.close_connection = True
                return self.reply(413, {"error": "too large"})
            try:
                tracks = json.loads(self.rfile.read(length))["tracks"]
                assert isinstance(tracks, list) and 0 < len(tracks) <= MAX_TRACKS
                for t in tracks:
                    assert re.fullmatch(r"[^/\x00]{1,200}", t["name"]) and t["name"] not in (".", "..")
                    assert isinstance(t["size"], int) and 0 <= t["size"] <= MAX_TRACK_BYTES
                    assert re.fullmatch(r"[0-9a-f]{64}", t["sha256"])
            except (ValueError, KeyError, TypeError, AssertionError):
                return self.reply(400, {"error": "bad job"})
            with service.lock:
                if service.job:
                    return self.reply(503, {"error": "busy"})
                need = sum(t["size"] for t in tracks)
                # 1 GiB spare by default so a real job cannot fill a GPU box; tests set
                # TRANSCRIBE_DISK_HEADROOM lower so a packed CI host is not a false 507.
                headroom = int(os.environ.get("TRANSCRIBE_DISK_HEADROOM", str(1 << 30)))
                if shutil.disk_usage(service.workdir).free < need + headroom:
                    return self.reply(507, {"error": "no room"})
                service.job = Job(uuid.uuid4().hex, tracks, service.workdir)
                log(f"job {service.job.id}: {len(tracks)} tracks, {need >> 20} MiB")
                service.mark(service.job)
                return self.reply(201, {"id": service.job.id})

        def do_PUT(self):
            m = self.gate()
            if not m:
                return
            job = self.current(m)
            if not job:
                return
            if not m.group(3) or job.state != "uploading" or int(m.group(3)) >= len(job.tracks):
                self.close_connection = True
                return self.reply(409, {"error": "not expecting that track"})
            i = int(m.group(3))
            want = job.tracks[i]
            length = int(self.headers.get("content-length") or -1)
            if length != want["size"]:
                self.close_connection = True
                return self.reply(400, {"error": "size differs"})
            path = job.path(i)
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            h, left = hashlib.sha256(), length
            with open(path, "wb") as f:
                while left:
                    chunk = self.rfile.read(min(CHUNK, left))
                    if not chunk:
                        break
                    h.update(chunk)
                    f.write(chunk)
                    left -= len(chunk)
                    job.seen = time.time()
            if left or h.hexdigest() != want["sha256"]:
                self.close_connection = True
                return self.reply(400, {"error": "track differs from its SHA-256"})
            with service.lock:
                if service.job is not job or job.state != "uploading":
                    return self.reply(409, {"error": "job gone"})
                job.have[i] = True
                if all(job.have):
                    service.start(job)
            self.reply(204)

        def do_DELETE(self):
            m = self.gate()
            if not m:
                return
            job = self.current(m)
            if not job:
                return
            with service.lock:
                service.drop(job)
            self.reply(204)

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--listen", default="127.0.0.1:8790", help="host:port (default 127.0.0.1:8790)")
    ap.add_argument("--workdir", required=True, help="where tracks and transcripts are kept while a job runs")
    ap.add_argument("--busy-file", default="", help="touched while a job exists (for an idle shutdown)")
    ap.add_argument("--abandon", type=float, default=180, help="seconds without a caller before a job is dropped")
    ap.add_argument("command", nargs="+", help="the recogniser (after --)")
    args = ap.parse_args()
    token_file = os.environ.get("TRANSCRIBE_SERVICE_TOKEN_FILE")
    token = open(token_file).read().strip() if token_file else os.environ.get("TRANSCRIBE_SERVICE_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("set TRANSCRIBE_SERVICE_TOKEN_FILE (or TRANSCRIBE_SERVICE_TOKEN) to a token of 16+ characters")
    service = Service(token, args.workdir, args.command, args.busy_file, args.abandon)
    threading.Thread(target=service.tend, daemon=True).start()
    host, port = args.listen.rsplit(":", 1)
    server = http.server.ThreadingHTTPServer((host, int(port)), handler(service))
    server.daemon_threads = True

    def stopped(_signum, _frame):
        with service.lock:
            if service.job:
                service.drop(service.job)
        os._exit(0)

    signal.signal(signal.SIGTERM, stopped)
    log(f"listening on {args.listen}: {' '.join(args.command)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
