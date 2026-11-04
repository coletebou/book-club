#!/usr/bin/env python3
"""Fetch a Whisper model for transcribe.py into a directory, every file checked against its SHA-256.

    python3 -I tools/align/fetch_model.py base.en /opt/align/models/base.en

The deploy image runs this as it is built (Dockerfile, TRANSCRIBER_MODEL), so that the recogniser
never downloads anything when it runs: `transcribe.py --model DIR --offline`. The models are the
CTranslate2 conversions faster-whisper uses (huggingface.co/Systran), at a pinned revision. Another
model needs its revision and checksums added below. Only the Python standard library is used.
"""
import hashlib
import http.client
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

# name: (repository, revision, {file: (bytes, sha256)})
MODELS = {
    "base.en": ("Systran/faster-whisper-base.en", "3d3d5dee26484f91867d81cb899cfcf72b96be6c", {
        "config.json": (2227, "f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb"),
        "model.bin": (145216508, "2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef"),
        "tokenizer.json": (2128466, "929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df"),
        "vocabulary.txt": (422309, "ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf"),
    }),
    "small.en": ("Systran/faster-whisper-small.en", "d1d751a5f8271d482d14ca55d9e2deeebbae577f", {
        "config.json": (2657, "666a9605530ac1f61fa8177f3702b4dacec9966749e42610839fcc32661d5fae"),
        "model.bin": (483545366, "62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a"),
        "tokenizer.json": (2128466, "929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df"),
        "vocabulary.txt": (422309, "ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf"),
    }),
}

ATTEMPTS = 4


def tls():
    """Certificates from certifi when it is there (the recogniser's venv has it), else the system's."""
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def fetch(url, dest, size, sha256, context):
    """Download url to dest, going on from where a dropped connection left off; check it whole."""
    part = dest + ".part"
    if os.path.exists(part):
        os.remove(part)
    for attempt in range(1, ATTEMPTS + 1):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have >= size:
            break
        headers = {"User-Agent": "bookclub-fetch-model"}
        if have:
            headers["Range"] = f"bytes={have}-"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60, context=context) as r:
                if have and r.status != 206:
                    have = 0  # the server sent it whole
                with open(part, "ab" if have else "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
            # A connection closed early ends the body quietly: what came is counted.
            problem = f"the connection closed after {os.path.getsize(part)} of {size} bytes"
        except (OSError, http.client.HTTPException) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code == 416 and have:
                break  # nothing past what is here: the check below says whether it is whole
            problem = repr(e)
        if os.path.exists(part) and os.path.getsize(part) >= size:
            break
        if attempt == ATTEMPTS:
            raise SystemExit(f"{url}: {problem}")
        print(f"{os.path.basename(dest)}: {problem}; trying again", file=sys.stderr, flush=True)
        time.sleep(5 * attempt)
    h = hashlib.sha256()
    with open(part, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    got = os.path.getsize(part)
    if got != size or h.hexdigest() != sha256:
        os.remove(part)
        raise SystemExit(f"{url}: {got} bytes, sha256 {h.hexdigest()}; expected {size} bytes, sha256 {sha256}")
    os.replace(part, dest)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in MODELS:
        raise SystemExit(f"usage: fetch_model.py MODEL DIR (MODEL: {', '.join(MODELS)})")
    name, out = sys.argv[1], sys.argv[2]
    repo, revision, files = MODELS[name]
    os.makedirs(out, exist_ok=True)
    context = tls()
    for file, (size, sha256) in files.items():
        began = time.time()
        fetch(f"https://huggingface.co/{repo}/resolve/{revision}/{file}", os.path.join(out, file), size, sha256, context)
        print(f"{name}/{file}: {size} bytes, checked, in {time.time() - began:.0f} s", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
