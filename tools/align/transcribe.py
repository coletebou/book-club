#!/usr/bin/env python3
"""Transcribe audiobook tracks with word timings, for forced alignment (docs/ALIGNMENT.md).

    python3 -I tools/align/transcribe.py --out transcript.json [--model small.en] track1.mp3 track2.mp3 ...

Writes one JSON document (format "bookclub-transcript/1"): per track, its file name, SHA-256,
duration and every recognised word as [start_ms, end_ms, text, probability]. Book Club reads
this file: the club owner uploads it (PUT /api/editions/:id/transcript), or the server runs this
script itself on new audiobooks when TRANSCRIBE_COMMAND names it, as the deploy image does
(docs/RUNBOOK.md).

Needs faster-whisper (CTranslate2 Whisper); its own dependency PyAV carries the FFmpeg libraries
that decode the audio, so no ffmpeg program is needed. Audio files are untrusted input: each is
opened as one of the audio formats the server takes, from that file alone (no playlist or
concatenation format can make FFmpeg read another file, or the network), decoded to 16 kHz mono
samples, and nothing else is done with them.

A track is heard in windows of ten minutes (--window), each ending at the quietest moment of its
last half-minute, so that no word is cut in two: faster-whisper works out the spectrum of all it is
given at once, about a megabyte a second, and a ten-hour M4B taken whole would need tens of
gigabytes. Whisper drops the last word it is given now and then, so a window is heard a few
seconds past its end, and only the words that start before it are kept; each window is told the
words heard just before it, as Whisper is told inside one.
"""
import argparse
import hashlib
import json
import os
import sys
import time

# python -I omits the script directory from sys.path; keep sibling imports working.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from progress import write_progress
except ImportError:  # GPU box may get a new transcribe.py before progress.py is copied
    def write_progress(stage, **_kw):
        pass

SAMPLE_RATE = 16000

# FFmpeg's demuxers for the files the server takes as tracks (.mp3; .m4a, .m4b, .mp4; .aac; .ogg,
# .oga, .opus; .flac; .wav; .webm), and only those.
AUDIO_FORMATS = "mp3,mov,aac,ogg,flac,wav,matroska"

# A window ends at the quietest 0.4 s of its last half-minute, and is heard this far past its end;
# a track at most a half-minute longer than a window is heard in one.
QUIET_S = 0.4
SEARCH_S = 30
PAST_S = 5

# The words heard last in a window, given to the next as what came before.
PROMPT_WORDS = 100


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def decoded(path):
    """An audio file's 16 kHz mono float32 samples, piece by piece as they are decoded, as `ffmpeg
    -f f32le -ac 1 -ar 16000` gives them: a damaged packet is skipped, and a change of sample rate
    or layout midway is followed."""
    import av

    resampler, setup = None, None

    def samples(frames):
        for frame in frames:
            yield frame.to_ndarray().reshape(-1).copy()

    options = {"format_whitelist": AUDIO_FORMATS, "protocol_whitelist": "file"}
    with av.open(path, container_options=options) as container:
        if not container.streams.audio:
            raise SystemExit(f"{os.path.basename(path)}: no audio in this file")
        for packet in container.demux(container.streams.audio[0]):
            try:
                frames = packet.decode()
            except av.error.InvalidDataError:
                continue
            for frame in frames:
                frame.pts = None
                if (frame.format.name, frame.layout.name, frame.sample_rate) != setup:
                    if resampler is not None:
                        yield from samples(resampler.resample(None))
                    resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
                    setup = (frame.format.name, frame.layout.name, frame.sample_rate)
                yield from samples(resampler.resample(frame))
    if resampler is not None:
        yield from samples(resampler.resample(None))


def quietest(samples, lo, hi):
    """The middle of the quietest QUIET_S of samples[lo:hi], to 20 ms."""
    import numpy as np

    step = SAMPLE_RATE // 50
    frames = samples[lo:lo + (hi - lo) // step * step].reshape(-1, step).astype(np.float64)
    span = round(QUIET_S * 50)
    energy = np.convolve((frames ** 2).mean(axis=1), np.ones(span), "valid")
    return lo + (int(energy.argmin()) + span // 2) * step


def windows(pieces, seconds):
    """Samples in windows of about `seconds` (0: all of them in one), as (first sample, samples to
    hear, how many of them are the window's own): a window's samples run PAST_S beyond its end."""
    import numpy as np

    size, search = int(seconds * SAMPLE_RATE), SEARCH_S * SAMPLE_RATE
    held, have, first = [], 0, 0
    for piece in pieces:
        held.append(piece)
        have += len(piece)
        if size and have >= size + search:
            audio = np.concatenate(held)
            cut = quietest(audio, size - search, size)
            yield first, audio[:cut + PAST_S * SAMPLE_RATE], cut
            first += cut
            held, have = [audio[cut:]], len(audio) - cut
    if have:
        audio = np.concatenate(held)
        yield first, audio, len(audio)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, help="where to write the transcript JSON")
    ap.add_argument("--model", default="small.en",
                    help="Whisper model: a name (fetched into HF_HOME) or a directory holding one (default small.en)")
    ap.add_argument("--offline", action="store_true",
                    help="never download: the model is a directory, or already in HF_HOME")
    ap.add_argument("--threads", type=int, default=6, help="CPU threads (default 6)")
    ap.add_argument("--device", choices=("cpu", "cuda", "auto"), default="cpu",
                    help="where the model runs: cpu (default), cuda (an NVIDIA GPU), or auto (cuda if there is one)")
    ap.add_argument("--compute-type", default=None,
                    help="CTranslate2 compute type (default int8 on the CPU, float16 on a GPU)")
    ap.add_argument("--beam", type=int, default=1, help="beam size (default 1, greedy)")
    ap.add_argument("--window", type=float, default=600,
                    help="seconds of audio heard at once (default 600; 0: each track whole)")
    ap.add_argument("tracks", nargs="+", help="audio files, in edition order")
    args = ap.parse_args()

    from faster_whisper import WhisperModel  # imported late so --help works without it
    import faster_whisper

    device = args.device
    if device == "auto":
        import ctranslate2
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    compute_type = args.compute_type or ("float16" if device == "cuda" else "int8")
    model = WhisperModel(args.model, device=device, compute_type=compute_type, cpu_threads=args.threads,
                         local_files_only=args.offline)
    doc = {
        "format": "bookclub-transcript/1",
        "engine": f"faster-whisper {faster_whisper.__version__}",
        # A model kept in a directory is named by it (the deploy image's /opt/align/models/base.en).
        "model": os.path.basename(os.path.normpath(args.model)) if os.path.isdir(args.model) else args.model,
        "tracks": [],
    }
    engine = "gpu" if device == "cuda" else "cpu"
    stage = "transcribing_gpu" if engine == "gpu" else "transcribing_cpu"
    started = time.time()
    tracks_total = len(args.tracks)
    audio_ms_done = 0
    write_progress(stage, tracks_done=0, tracks_total=tracks_total, audio_ms_done=0,
                   started_at=started, engine=engine)
    for track_i, path in enumerate(args.tracks):
        began = time.time()
        words = []
        heard = 0
        for first, samples, own in windows(decoded(path), args.window):
            segments, _ = model.transcribe(
                samples,
                language="en",
                beam_size=args.beam,
                word_timestamps=True,
                vad_filter=False,
                condition_on_previous_text=True,
                initial_prompt=" ".join(w[2] for w in words[-PROMPT_WORDS:]) or None,
            )
            at, end = first / SAMPLE_RATE, own / SAMPLE_RATE
            for seg in segments:
                for w in seg.words or []:
                    text = w.word.strip()
                    if not text or w.start >= end:
                        continue
                    words.append([round((at + w.start) * 1000), round((at + w.end) * 1000), text, round(w.probability, 3)])
            heard = first + own
            # Live within a long track: audio heard so far across finished tracks + this window.
            write_progress(
                stage,
                tracks_done=track_i,
                tracks_total=tracks_total,
                audio_ms_done=audio_ms_done + round(heard / SAMPLE_RATE * 1000),
                started_at=started,
                engine=engine,
            )
        took = time.time() - began
        duration = heard / SAMPLE_RATE
        audio_ms_done += round(duration * 1000)
        doc["tracks"].append({
            "file": os.path.basename(path),
            "sha256": sha256_of(path),
            "durationMs": round(duration * 1000),
            "words": words,
        })
        print(f"{os.path.basename(path)}: {len(words)} words, {duration:.0f} s of audio in {took:.0f} s",
              file=sys.stderr, flush=True)
        write_progress(
            stage,
            tracks_done=track_i + 1,
            tracks_total=tracks_total,
            audio_ms_done=audio_ms_done,
            started_at=started,
            engine=engine,
        )
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)


if __name__ == "__main__":
    main()
