#!/usr/bin/env python3
"""Measure forced-alignment error independently (docs/ALIGNMENT.md).

    python3 -I tools/align/spotcheck.py --sentences sentences.json --audio DIR [--samples 80] [--out results.json]

For a seeded random sample of aligned sentences, cuts the audio from 3 s before to 5 s after the
time the alignment gives for the sentence's start, transcribes only that clip (a fresh decode
that knows nothing of the rest of the book), finds the sentence's first words in it and reports
how far from the predicted start they were actually spoken. The same is done for the
chapter-level map's prediction of the same sentences (with a wider clip, since it is further off).
"""
import argparse
import json
import random
import re
import statistics
import subprocess
import sys

SAMPLE_RATE = 16000


def decode(path):
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def norm(word):
    return re.sub(r"[^a-z0-9]", "", word.lower().replace("’", "'").replace("'", ""))


def words_of(text):
    return [w for w in (norm(x) for x in re.findall(r"[\w’']+", text)) if w]


def find_start(model, samples, start_s, before, after, wanted):
    """Seconds (absolute) at which the clip says the sentence's first words, or None."""
    lo = max(0, int((start_s - before) * SAMPLE_RATE))
    hi = min(len(samples), int((start_s + after) * SAMPLE_RATE))
    segments, _ = model.transcribe(samples[lo:hi], language="en", beam_size=5, word_timestamps=True,
                                   condition_on_previous_text=False, vad_filter=False)
    heard = [(norm(w.word), w.start) for seg in segments for w in (seg.words or []) if norm(w.word)]
    n = len(wanted)
    for i in range(len(heard) - n + 1):
        if [h[0] for h in heard[i:i + n]] == wanted:
            return lo / SAMPLE_RATE + heard[i][1]
    return None


def summary(errors):
    if not errors:
        return {"found": 0}
    a = sorted(abs(e) for e in errors)
    pick = lambda q: a[min(len(a) - 1, int(q * len(a)))]
    return {
        "found": len(errors),
        "median_abs_s": round(statistics.median(a), 3),
        "mean_signed_s": round(statistics.mean(errors), 3),
        "p90_abs_s": round(pick(0.9), 3),
        "p95_abs_s": round(pick(0.95), 3),
        "max_abs_s": round(a[-1], 3),
        "within_0_5_s": sum(1 for e in a if e <= 0.5),
        "within_1_s": sum(1 for e in a if e <= 1.0),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sentences", required=True)
    ap.add_argument("--audio", required=True, help="directory holding the tracks named in the sentences file")
    ap.add_argument("--samples", type=int, default=80)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--threads", type=int, default=5)
    ap.add_argument("--out")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    sentences = json.load(open(args.sentences, encoding="utf-8"))
    candidates = [s for s in sentences if len(words_of(s["text"])) >= 6]
    rng = random.Random(args.seed)
    sample = sorted(rng.sample(candidates, min(args.samples, len(candidates))), key=lambda s: (s["track"], s["startMs"]))
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)
    audio = {}
    rows = []
    for s in sample:
        if s["file"] not in audio:
            audio[s["file"]] = decode(f'{args.audio}/{s["file"]}')
        samples = audio[s["file"]]
        wanted = words_of(s["text"])[:3]
        predicted = s["startMs"] / 1000
        heard = find_start(model, samples, predicted, 3.0, 5.0, wanted)
        row = {"file": s["file"], "text": s["text"][:80], "predicted_s": predicted,
               "heard_s": heard, "error_s": None if heard is None else round(predicted - heard, 3)}
        if s.get("baselineMs") is not None:
            base = s["baselineMs"] / 1000
            # The chapter map can be a minute off: look in a wide window around it.
            b_heard = find_start(model, samples, base, 45.0, 45.0, wanted) if heard is not None else None
            row.update({"baseline_s": base, "baseline_error_s": None if b_heard is None else round(base - b_heard, 3)})
        rows.append(row)
        print(f'{s["file"]} {predicted:8.2f}s  heard {"-" if heard is None else f"{heard:8.2f}s"}  '
              f'error {"-" if heard is None else f"{predicted - heard:+.2f}s"}  {s["text"][:50]}', file=sys.stderr, flush=True)
    result = {
        "model": args.model,
        "samples": len(rows),
        "alignment": summary([r["error_s"] for r in rows if r["error_s"] is not None]),
        "chapter_map": summary([r["baseline_error_s"] for r in rows if r.get("baseline_error_s") is not None]),
        "rows": rows,
    }
    print(json.dumps({k: v for k, v in result.items() if k != "rows"}, indent=1))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
