"""Shared progress reporting for Book Club transcription (docs/GPU-TRANSCRIPTION.md).

The server sets TRANSCRIBE_PROGRESS_FILE to a path this process (or the remote wrapper) writes.
TRANSCRIBE_AUDIO_MS_TOTAL and TRANSCRIBE_TRACKS_TOTAL, when set, are the audiobook's known size
so an ETA can be shown before every track has been heard. Writing never raises: a full disk or a
broken path must not stop transcription.

Format "bookclub-transcribe-progress/1". Also prints `PROGRESS <json>` on stderr so that
transcribe_service.py can forward structured progress to its caller (old services ignore the
line and keep treating the last stderr line as the human `progress` string).
"""
from __future__ import annotations

import json
import os
import sys
import time

FORMAT = "bookclub-transcribe-progress/1"

# Stages the server and UI understand. Keep this list stable: new ones need a server deploy.
STAGES = (
    "queued",
    "uploading",
    "transcribing_gpu",
    "transcribing_cpu",
    "aligning",
    "failed",
)


def write_progress(
    stage,
    *,
    tracks_done=None,
    tracks_total=None,
    audio_ms_done=None,
    audio_ms_total=None,
    started_at=None,
    engine=None,
    message=None,
):
    """Atomically write the progress file and emit a PROGRESS line. No-op when unset."""
    path = os.environ.get("TRANSCRIBE_PROGRESS_FILE", "").strip()
    doc = {
        "format": FORMAT,
        "stage": stage,
        "tracksDone": tracks_done,
        "tracksTotal": tracks_total if tracks_total is not None else _env_int("TRANSCRIBE_TRACKS_TOTAL"),
        "audioMsDone": audio_ms_done,
        "audioMsTotal": audio_ms_total if audio_ms_total is not None else _env_int("TRANSCRIBE_AUDIO_MS_TOTAL"),
        "startedAt": started_at,
        "updatedAt": time.time(),
        "engine": engine,
        "message": message,
    }
    # Drop nulls so old readers that only know a few keys stay comfortable.
    body = {k: v for k, v in doc.items() if v is not None or k in ("format", "stage", "updatedAt")}
    line = f"PROGRESS {json.dumps(body, separators=(',', ':'))}"
    try:
        print(line, file=sys.stderr, flush=True)
    except OSError:
        pass
    if not path:
        return
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError:
        pass


def _env_int(name):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def parse_progress_line(text):
    """A PROGRESS stderr line's JSON, or None."""
    if not text.startswith("PROGRESS "):
        return None
    try:
        doc = json.loads(text[len("PROGRESS ") :])
    except json.JSONDecodeError:
        return None
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        return None
    return doc
