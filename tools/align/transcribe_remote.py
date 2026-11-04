#!/usr/bin/env python3
"""Transcribe on a remote GPU recogniser when one answers, else run the local one (docs/GPU-TRANSCRIPTION.md).

    transcribe_remote.py LOCAL-COMMAND... --out transcript.json track1.mp3 track2.mp3 ...

The server runs TRANSCRIBE_COMMAND with `--out <json> <tracks...>` added (apps/server/src/services/
readalong.ts). Put this script in front of the local recogniser's command line, and the argument
list it is given is that command line, whole: with TRANSCRIBE_REMOTE_URL unset, or when the remote
recogniser (tools/align/transcribe_service.py) does not answer, fails, or goes away midway (a GPU box
stopped while it ran), this process becomes the local command (exec), exactly as if the server had
run it itself. Otherwise the tracks are sent to the remote recogniser, and what it writes is checked
(format, one track per file, each file's SHA-256) before it is written to --out as transcribe.py
would write it.

Settings, from the environment (the server passes on TRANSCRIBE_* only):
  TRANSCRIBE_REMOTE_URL     base URL of the remote recogniser, for example http://host.docker.internal:8790
  TRANSCRIBE_REMOTE_TOKEN   its bearer token
  TRANSCRIBE_REMOTE_HEALTH_TIMEOUT   seconds the health check may take (default 5)
  TRANSCRIBE_REMOTE_LOST_AFTER       seconds without an answer before the run falls back (default 90)

SIGTERM (the server stopping it) cancels the remote job and exits; once fallen back, the local
recogniser is this process, and gets the server's signals itself.
"""
import hashlib
import http.client
import json
import os
import signal
import sys
import time
import urllib.parse

# python -I omits the script directory from sys.path; keep sibling imports working.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from progress import write_progress
except ImportError:  # GPU box may get a new transcribe.py before progress.py is copied
    def write_progress(stage, **_kw):
        pass

POLL_S = 5
CHUNK = 1 << 20


def log(message):
    print(f"transcribe_remote: {message}", file=sys.stderr, flush=True)


class Unavailable(Exception):
    """The remote recogniser cannot do this run: the local one does."""


class Remote:
    def __init__(self, url, token, timeout):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise Unavailable(f"TRANSCRIBE_REMOTE_URL is not an http(s) URL: {url!r}")
        self.parts, self.token, self.timeout = parts, token, timeout
        self.base = parts.path.rstrip("/")

    def connection(self, timeout=None):
        cls = http.client.HTTPSConnection if self.parts.scheme == "https" else http.client.HTTPConnection
        return cls(self.parts.hostname, self.parts.port, timeout=timeout or self.timeout)

    def request(self, method, path, body=None, headers=None, timeout=None, length=None):
        conn = self.connection(timeout)
        try:
            h = {"authorization": f"Bearer {self.token}"}
            h.update(headers or {})
            if length is not None:
                h["content-length"] = str(length)
            conn.request(method, self.base + path, body=body, headers=h)
            res = conn.getresponse()
            data = res.read()
        except (OSError, http.client.HTTPException) as e:
            raise Unavailable(f"{method} {path}: {e}") from e
        finally:
            conn.close()
        if res.status >= 300:
            raise Unavailable(f"{method} {path}: HTTP {res.status} {data[:200].decode('utf-8', 'replace')}")
        return json.loads(data) if data else None


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def split_args(argv):
    """(local command, out, tracks) from `LOCAL-COMMAND... --out OUT TRACK...`: the last --out."""
    if "--out" not in argv:
        raise SystemExit("transcribe_remote: no --out (usage: transcribe_remote.py LOCAL-COMMAND... --out OUT TRACK...)")
    i = len(argv) - 1 - argv[::-1].index("--out")
    local, rest = argv[:i], argv[i + 1:]
    if not local:
        raise SystemExit("transcribe_remote: no local recogniser command before --out")
    if len(rest) < 2:
        raise SystemExit("transcribe_remote: --out needs a file and at least one track")
    return local, rest[0], rest[1:]


def check(doc, tracks, sums):
    """The remote transcript, held to what transcribe.py writes for these files."""
    if not isinstance(doc, dict) or doc.get("format") != "bookclub-transcript/1":
        raise Unavailable("remote transcript is not bookclub-transcript/1")
    got = doc.get("tracks")
    if not isinstance(got, list) or len(got) != len(tracks):
        raise Unavailable(f"remote transcript has {len(got) if isinstance(got, list) else 'no'} tracks, not {len(tracks)}")
    for track, path, digest in zip(got, tracks, sums):
        if not isinstance(track, dict) or track.get("sha256") != digest:
            raise Unavailable(f"remote transcript's track for {os.path.basename(path)} has another SHA-256")
        if not isinstance(track.get("words"), list) or not isinstance(track.get("durationMs"), (int, float)):
            raise Unavailable("remote transcript track lacks words or durationMs")
        track["file"] = os.path.basename(path)
    return doc


def _apply_detail(detail, started, tracks_total):
    """Mirror a remote progressDetail (or invent uploading/transcribing_gpu) into the progress file."""
    if not isinstance(detail, dict):
        return
    write_progress(
        detail.get("stage") or "transcribing_gpu",
        tracks_done=detail.get("tracksDone"),
        tracks_total=detail.get("tracksTotal", tracks_total),
        audio_ms_done=detail.get("audioMsDone"),
        audio_ms_total=detail.get("audioMsTotal"),
        started_at=detail.get("startedAt", started),
        engine=detail.get("engine") or "gpu",
        message=detail.get("message"),
    )


def run_remote(remote, out, tracks, state, lost_after):
    remote.request("GET", "/healthz")
    sums = [sha256_of(p) for p in tracks]
    tracks_total = len(tracks)
    started = time.time()
    write_progress("uploading", tracks_done=0, tracks_total=tracks_total, audio_ms_done=0,
                   started_at=started, engine="gpu")
    job = remote.request(
        "POST", "/jobs",
        body=json.dumps({"tracks": [{"name": os.path.basename(p), "size": os.path.getsize(p), "sha256": s}
                                    for p, s in zip(tracks, sums)]}),
        headers={"content-type": "application/json"},
    )
    state["job"] = job_id = job["id"]
    log(f"remote job {job_id}: sending {len(tracks)} tracks")
    for i, path in enumerate(tracks):
        with open(path, "rb") as f:
            remote.request("PUT", f"/jobs/{job_id}/tracks/{i}", body=f, length=os.path.getsize(path),
                           headers={"content-type": "application/octet-stream"}, timeout=max(remote.timeout, 120))
        write_progress("uploading", tracks_done=i + 1, tracks_total=tracks_total, audio_ms_done=0,
                       started_at=started, engine="gpu")
    write_progress("transcribing_gpu", tracks_done=0, tracks_total=tracks_total, audio_ms_done=0,
                   started_at=started, engine="gpu")
    began, last_ok, seen = time.time(), time.time(), None
    while True:
        try:
            status = remote.request("GET", f"/jobs/{job_id}")
            last_ok = time.time()
        except Unavailable as e:
            if time.time() - last_ok > lost_after:
                raise Unavailable(f"remote recogniser lost: {e}") from e
            time.sleep(POLL_S)
            continue
        if status.get("state") == "done":
            break
        if status.get("state") == "failed":
            raise Unavailable(f"remote recogniser failed: {status.get('error', '')}")
        detail = status.get("progressDetail")
        if detail:
            _apply_detail(detail, started, tracks_total)
        if status.get("progress") != seen:
            seen = status.get("progress")
            if seen:
                log(f"remote: {seen}")
        time.sleep(POLL_S)
    doc = check(remote.request("GET", f"/jobs/{job_id}/result", timeout=max(remote.timeout, 120)), tracks, sums)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out)
    words = sum(len(t["words"]) for t in doc["tracks"])
    log(f"remote job {job_id}: {words} words in {time.time() - began:.0f} s ({doc.get('engine')}, {doc.get('model')})")
    cancel(remote, state)


def cancel(remote, state):
    job_id = state.pop("job", None)
    if job_id:
        try:
            remote.request("DELETE", f"/jobs/{job_id}", timeout=3)
        except Unavailable:
            pass


def main(argv):
    local, out, tracks = split_args(argv)
    url = os.environ.get("TRANSCRIBE_REMOTE_URL", "").strip()
    if url:
        state = {}
        remote = None
        try:
            remote = Remote(url, os.environ.get("TRANSCRIBE_REMOTE_TOKEN", ""),
                            float(os.environ.get("TRANSCRIBE_REMOTE_HEALTH_TIMEOUT", "5")))

            def stopped(signum, _frame):
                cancel(remote, state)
                log("stopped")
                os._exit(128 + signum)

            signal.signal(signal.SIGTERM, stopped)
            signal.signal(signal.SIGINT, stopped)
            run_remote(remote, out, tracks, state, float(os.environ.get("TRANSCRIBE_REMOTE_LOST_AFTER", "90")))
            return 0
        except Exception as e:  # noqa: BLE001 - whatever went wrong remotely, the local recogniser runs
            log(f"{e}; transcribing locally")
            if remote is not None:
                cancel(remote, state)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            write_progress("transcribing_cpu", tracks_done=0, tracks_total=len(tracks),
                           audio_ms_done=0, started_at=time.time(), engine="cpu",
                           message="falling back to this host")
    try:
        os.execvp(local[0], [*local, "--out", out, *tracks])
    except OSError as e:
        raise SystemExit(f"transcribe_remote: cannot run {local[0]}: {e}") from e


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
