# Reading along: an audiobook lined up with its text

The original brief's stretch item 1: "Sentence-level sync between an EPUB and its audiobook by forced alignment
(speech recognition plus text alignment), so a listener's position maps to the exact sentence and
back, with highlight-as-you-listen. Measure the error on the reference pair." Decision D46.

## What it does for the club

- **One timeline, to the sentence.** Without it, an audiobook is placed on the book's timeline by
  chapter (each track starts its chapter, linear inside). With it, every sentence of the audiobook
  sits where the text has it. A listener's marker on a reader's club bar, a note made while
  listening, and "open the book here" all land on the sentence being read, and back.
- **Reading along.** The listen page shows the sentence being read, with the one before and after;
  tapping one plays it again. "Follow in the book" opens the EPUB with that sentence marked; the
  pages turn with the narrator until you turn one yourself ("Follow the narrator" brings you back,
  ending any look in the way, and the narrator reaching the page you turned to follows on by
  itself). Before the text (the opening credits, a track's announcement, a whole track of credits)
  the panel says the text has not begun and shows the sentence it begins with, and the book waits
  open at that page; past its end it says so (D184).
- **The demo reads along.** The demo image ships the transcript of its LibriVox recording, so the
  seeded club has it from the first start.

## How it works

1. **Speech recognition, beside the app.** `tools/align/transcribe.py` runs faster-whisper (CPU,
   int8; `base.en` in the deploy image, `small.en` for the measurement below) on each track, ten
   minutes at a time, and writes every word it heard with its start and end (format
   `bookclub-transcript/1`, tracks named by SHA-256). The server never runs Python itself: it runs
   the recogniser as a process of its own when `TRANSCRIBE_COMMAND` is set, on its own job queue so
   an hour of recognition never holds up an upload, and the deploy image carries one and sets it
   (docs/RUNBOOK.md, "Reading along"); or a transcript made elsewhere is uploaded
   (`PUT /api/editions/:id/transcript`, by the club owner).
2. **Text alignment, in the app** (`packages/shared/src/timeline/forced.ts`, `text/words.ts`):
   - Both sides become normalised words: lower case, no accents or apostrophes; digits and the
     Roman numerals of headings are spelled out ("CHAPTER IV" and "Chapter 4" both become
     "chapter four"), so headings match however the recogniser wrote them.
   - Only the story's reading is lined up: its title page's lines and its own printed contents and
     lists of pictures, which no narrator reads (the front matter the reader's contents leave out,
     `readingContents`), are not, so what a recording says of the book before reading it
     (LibriVox's "Chapter one of The Strange Case of Dr Jekyll and Mr Hyde…") is never taken for
     its contents page (FR154). A preface stays.
   - **Anchors**: runs of four words found exactly once in the book's story and once in what was
     heard; the longest chain of anchors in the same order on both sides is kept (an out-of-order
     anchor is a coincidence).
   - Between anchors, a small edit-distance alignment pairs the remaining words (an exact match
     scores 2, one letter off 1, a substitution or a skipped word −1). A stretch too long for that
     is cut by anchors unique inside it, longer runs first.
   - Sentences come from the EPUB's exact text measure (the same offsets the reader, comments and
     read ranges use), cut at sentence punctuation and at block edges (paragraphs, headings, the
     lines of a poem). A very long sentence is also cut at `;` or `:`.
   - Each sentence starts at its first word heard (words before it that were missed are given the
     average word time); a sentence with fewer than two words heard is not trusted. A sentence is
     said in one breath: of its matched words, only the longest run heard one after another in
     one track, no more than four words apart (the Alice has at most two in any sentence), count
     for it. The words of "End of chapter 1. Read by Krista McQuillan, Tokyo, Japan, November 15,
     2005" at the end of the Alice's first track, and the "2." the next one opens with, are no
     longer "CHAPTER II." (FR160).
   - A track is trusted when at least half of what was heard in it matched the text, and its
     sentences stay inside the chapters the chapter-level map already puts them in (a sentence
     may move within its chapter, never across the book; a transcript that belongs to another
     recording, or was made up, cannot move anyone's notes far).
   - A chapter starts in the track heard saying its text: the first track that says twenty of its
     words (half, for a short chapter) from its first sentence on. What an earlier track's end
     says of it is that track's credits heard as its heading ("End of chapter 9. Recording by James
     K. White" as The Time Machine's "The Trap of the White Sphinx"), and is left unaligned
     (`withChapterOpenings`, FR160).
3. **Sync maps** (`refineAudioSync`, `refineTextSync`): the edition the timeline does not rest on
   is refined. Usually the EPUB defines the timeline and the audiobook's map gets a tie point at
   each sentence's start and end (simplified so that no sentence moves by more than one second,
   each track on its own); if the audiobook came first and defines the timeline, the text's map
   is refined instead. Wherever a track was not trusted, the chapter-level map stays. A
   recording's opening words, before its first sentence (within its first 90 seconds), are at
   that sentence, not on the title page where a straight line would put the recording's start
   (FR154). A track's closing words, after its last sentence (within 90 seconds of its end), stay
   at that sentence when the next track goes on from there: a place in LibriVox's "End of chapter
   1…" is in chapter I, and chapter II's start translates into the second track (FR160).
   Where the alignment hears each chapter start (its first sentence, its heading or opening line,
   in the trusted track heard saying its text) is kept with the map, and so is the chapter each
   track opens with (its first sentence's): a track holding several chapters lists them in the
   player, each going to its start, the player names the one heard (FR152), and a track of one
   chapter is named by it, whatever its tag says or its chapter match (FR161). A read-along lined
   up by older rules is lined up again once at the next start.
4. **What is placed with the old map moves with it** (D47): notes and places made in the refined
   edition keep their locators and get new timeline values. The book's merged read ranges (its
   progress and bar) keep, for a member whose place is in that edition, only what both maps agree
   they read: never more, at worst the part the two maps place differently. Whether a note is open
   is decided from reading kept per edition in its own measure (D63), which a new map does not move;
   where the forced alignment is trusted, the cross-format margin is dropped.
5. **Read-along data** (`GET /api/editions/:id/readalong?track=N`): each sentence's section,
   offset, length, start and end in the track, and its words, for members of the club only.

## Measured on the reference pair

Project Gutenberg's *Alice's Adventures in Wonderland* (EPUB #11) and the LibriVox recording
(12 tracks, 2 h 59 min, one reader), transcribed on this box with faster-whisper 1.1.1,
`small.en`, greedy decoding, 5 CPU threads: 21 minutes for 179 minutes of audio (8.5x real time).

**Alignment coverage** (`tools/align/report.ts`, 165 ms to align the whole book):

| | |
|---|---|
| words in the story | 26,775 |
| words heard | 26,856 |
| words matched | 26,092 (97.4 % of the text) |
| sentences | 1,643, of which aligned 1,597 (97.2 %; 1,598 before FR160, the one more being "CHAPTER II." in the first track's credits) |
| tracks trusted | 12 of 12 (94 % to 99 % of each track's words matched) |

**Error, measured independently** (`tools/align/spotcheck.py`; the result is in
[alignment/spotcheck-librivox-alice.json](alignment/spotcheck-librivox-alice.json)). For a seeded
random sample of 80 aligned sentences, the audio from 3 s before to 5 s after the predicted start
is cut out and transcribed on its own (beam search, no context from the rest of the book); the
time at which the sentence's first three words are heard in that clip is compared with the
prediction. The same is done for the chapter-level map's prediction, in a ±45 s window.

| | forced alignment | chapter-level map |
|---|---|---|
| sentences found by the clip check | 72 of 80 | 71 of 80 |
| median error | **0.11 s** | 10.5 s |
| 90th percentile | 0.56 s | 29.1 s |
| 95th percentile | 0.68 s | 36.1 s |
| largest | 2.44 s | 44.1 s |
| within 0.5 s / within 1 s | 64 / 71 | 0 / 3 |
| mean signed error (bias) | +0.01 s | −7.0 s |

The 8 sentences the clip check could not find all start with dialogue punctuation the clip's own
transcription splits differently ("It's—it's", "Hush!" after a quote); they are misses of the
check, not of the alignment. The largest error (2.44 s) is a sentence of dialogue after a pause the
recogniser placed late. The chapter-level map is off by ten seconds at the median, and late in long
chapters by more than half a minute: about a paragraph.

**The app's own tests** prove the pieces with exact ground truth: `forced.test.ts` narrates a
generated book (one track per chapter, an introduction and a closing line per track, 5 % of words
dropped and 5 % misheard) and checks every sentence is timed within one word of when it is read,
that an untrusted track keeps the chapter map, and that the refined map puts every sentence of the
audiobook within the one-second tolerance of where the text has it, in both directions; it also
lines the LibriVox transcript up with the book's real text (every chapter heard starting in its own
track, the credits of each track in the chapter it ends) and crafted credits as the Alice's and
The Time Machine's (FR160). The server test `readalong.test.ts` runs the whole flow (upload,
transcript, lining up, read-along, retiming a note, forgetting the transcript, deleting the text,
and a recogniser process run by the server), and e2e `readalong.spec` and `polish18-audio.spec`
drive it in both browsers with the real LibriVox recording.

## The recogniser in the deploy image: which model, how many threads

Fidelity review round 13 found that without a transcript a note between a reader and a listener
opens about a tenth of a chapter late (D63's margin; six iPhone pages on A Christmas Carol's long
chapters), so the deploy image carries a recogniser and the server runs it on each new audiobook
(docs/RUNBOOK.md, "Reading along"). It has to suit a small host: 2 to 4 vCPUs, 4 to 8 GB, the app
beside it. Measured on this box (Xeon Platinum 8259CL, 2.5 GHz, shared with other work: load 4 to
23), under nice, with `transcribe.py` as it ships (ten-minute windows), on three chapters of the
LibriVox Alice from its start, middle and end (I, IV and XI: 2,454 s of audio, 6,743 words of the
book). Each run is pinned to the two hyperthreads of one core, as a 2-vCPU cloud host has them, or
to those of two cores (4 vCPUs):

| model, threads on vCPUs | audio s per wall s | the whole Alice (179 min) | peak memory | words of the chapters matched | sentence start, median / 95th percentile error |
|---|---|---|---|---|---|
| **base.en, 2 on 2** (the image's) | **8.1** (7.9 in the image) | **22 min** | **0.97 GB** (0.89 in the image) | **97.2 %** | **0.16 s / 1.08 s** |
| base.en, 2 on 4 | 13.4 | 13 min | 0.97 GB | 97.2 % | |
| base.en, 4 on 4 | 12.9 | 14 min | 0.92 GB | 97.2 % | |
| base.en, 4 on 2 | 7.4 | 24 min | 0.92 GB | 97.2 % | |
| small.en, 2 on 2 | 3.0 | 59 min | 1.27 GB | 97.6 % | |
| small.en, 4 on 4 | 5.1 | 35 min | 1.29 GB | 97.6 % | 0.10 s / 0.56 s |

(The match rate is the measure of the whole-book table above, the share of the chapters' words
matched, `tools/align/report.ts`; the error is `spotcheck.py`'s, 80 sentences. The whole book with
small.en, taken whole on 5 to 6 threads, matched 97.8 % of its chapters' words, 97.4 % of the text.)

**base.en with 2 threads.** It lines a whole book up within the hour after its upload on the
smallest of those hosts (eight hours of audio an hour); small.en at 3 times the audio's speed
would take an hour for Alice and an hour and a half for A Christmas Carol, for 0.4 points more of
the words matched and sentence starts a little closer (0.56 s against 1.08 s at the 95th
percentile). Either places a sentence well under a second off at the median, where a chapter map
is ten seconds and more off (above) and the margin it needs is a minute or a tenth of the chapter
(D63). Two threads never contend with each other on two vCPUs (four squeezed onto two run 10 %
slower) and on four vCPUs already run as fast as four threads (one a core: the hyperthreads add
little here), leaving the other two to the app; at the lowest priority the recogniser yields the
CPU to the server anyway. More threads help only with more cores, and small.en is a build argument
away (docs/RUNBOOK.md).

**Ten-minute windows.** faster-whisper works out the spectrum of all it is given at once, about a
megabyte a second of audio: taken whole, chapter IV (20 minutes) needed 1.41 GB with base.en, an
hour-long track (A Christmas Carol's) would need 3 to 4 GB, and a ten-hour M4B tens. Cut at the
quietest 0.4 s of their last half-minute and heard 5 s past it (Whisper now and then drops the
last word it is given), the windows hold base.en under a gigabyte, however long the track
(small.en 1.29 GB, against 1.60 GB for chapter IV whole), and each is told the words heard before
it. About as many
words are matched: a window's spectrum is scaled to its own loudest moment, so a phrase here and
there comes out differently, either way (base.en 96.9 % whole, 97.2 % in windows; small.en 98.0 %
and 97.6 %, a phrase of chapter IV misheard).

**Decoding.** PyAV, which faster-whisper needs anyway, decodes with FFmpeg's own libraries: these
MP3s come out sample for sample as the `ffmpeg` program gave them (and so the same transcripts),
so the image carries no ffmpeg (Debian's adds 481 MB). A file is opened only as one of the audio
formats the server takes and only from itself: FFmpeg's playlist and concatenation formats, which
read other files or the network, are not on the list.

**The image's Python.** Debian 12's Python 3.11 runs the venv's versions of faster-whisper,
CTranslate2, tokenizers and the Hub client; av and numpy are the last releases for 3.11 (18.1.0,
2.4.6, against 19.0.2 and 2.5.4 here). In the image, chapters I and IV were transcribed word for
word as here, and the three chapters matched the same 97.2 %.

## Reproducing the measurement

```sh
uv venv --python 3.12 .cache/tools/align-venv
VIRTUAL_ENV=.cache/tools/align-venv uv pip install --python .cache/tools/align-venv/bin/python faster-whisper==1.1.1 requests
export HF_HOME=$PWD/.cache/tools/hf
# The whole book, each track taken whole as it was measured (spotcheck.py also needs ffmpeg).
.cache/tools/align-venv/bin/python -I tools/align/transcribe.py --window 0 --out /tmp/alice.json .cache/downloads/librivox-alice/*.mp3
apps/server/node_modules/.bin/tsx tools/align/report.ts fixtures/books/alice-gutenberg-11.epub /tmp/alice.json /tmp/sentences.json
.cache/tools/align-venv/bin/python -I tools/align/spotcheck.py --sentences /tmp/sentences.json --audio .cache/downloads/librivox-alice --out /tmp/spotcheck.json
# The model and threads table: one line of it (base.en, 2 threads on one core's two hyperthreads).
.cache/tools/align-venv/bin/hf download Systran/faster-whisper-base.en
/usr/bin/time -v taskset -c 12,28 nice .cache/tools/align-venv/bin/python -I tools/align/transcribe.py --offline \
  --model base.en --threads 2 --out /tmp/b2.json .cache/downloads/librivox-alice/wonderland_ch_{01,04,11}_64kb.mp3
apps/server/node_modules/.bin/tsx tools/align/report.ts fixtures/books/alice-gutenberg-11.epub /tmp/b2.json
```

## Limits

- A track whose recording does not follow the text (an abridged reading, another translation)
  is not trusted and keeps the chapter map; there is no partial-track fallback below that.
- Footnotes, illustrations' captions and tables of contents that a narrator skips are simply
  unmatched: the sentences around them are still timed.
- Recognition is English (`base.en` in the deploy image, `small.en` measured above); another
  language needs a multilingual model, pinned in `tools/align/fetch_model.py` for the image, and
  `transcribe.py` asks for English.

# A PDF lined up with its text, line by line

Decision D75. Fidelity review round 12's must-fix: the Alice PDF was lined up with the book by
its chapters only (one tie point per chapter, 14 in all), so a note from the EPUB sat up to a
paragraph off on its page and opened a page late (D63's margin), a note from the PDF showed eleven
lines from its quote in the EPUB and opened two pages late, and switching from the PDF to listening
started about 40 s early. Both files are the same Gutenberg text; the PDF's own text says, line by
line, where it is in the book, the way a transcript does for the audiobook.

## What it does for the club

- **Notes between the PDF and the EPUB are judged as within one edition.** A note made in the EPUB
  opens for a PDF reader the moment its page is read, and sits at the top of its line there; a note
  made in the PDF sits on its line in the EPUB, and opens once that printed line has been read.
- **Switching formats lands on the line.** The top of a PDF page opens the EPUB at its first word,
  and the audiobook (when it reads along) at the narrator's first word of the page.
- **Either order, bookmarks or not.** A PDF added to a book with an EPUB is lined up as its reading
  ends; an EPUB added to a PDF is lined up with it (the PDF then defines the timeline, and the
  EPUB's map is refined). A PDF without bookmarks, or one whose chapters start mid-page (a straight
  line before, D74), is lined up the same way.

## How it works

1. **The PDF's text, read once.** The worker that reads a PDF's chapter headings (D74,
   `ingest/pdf.ts` `readPdfText`) reads every page's text runs once and makes lines of them, top
   down, as pdf.js's text layer places them in the reader: runs level on the page as shown, on one
   baseline, in the order they stand on it. A line's height on the page is the top of its type (an
   em above the baseline, just above where a selection on it starts: the PDF locator's `y`). The
   lines are kept beside the edition (`.printed.json` in its folder) under the same time and memory
   limits, at most 1,000 characters a line and 32 M characters in all. A PDF read before this is
   read once more at the next start.
2. **Lined up with the text** (`packages/shared/src/timeline/textalign.ts`, in a worker with the
   alignment's limits, `services/readalong.ts`): the EPUB's sections as readers measure them
   (`bodyTextWithBreaks`, the offsets comments and read ranges use) and the PDF's lines become
   normalised words, as for a transcript (`text/words.ts`); a word cut by a hyphen at a line's end
   is whole again where the text has it whole ("conver-" "sations"; "rabbit-" "hole" stays two
   words). `matchWords` (forced.ts) pairs them: runs of four words found once on each side, the
   longest chain of them in the same order, small edit-distance alignments between. A printed word
   counts as lined up only inside a run of four or more pairs in a row on both sides: a common word
   an edit-distance alignment pairs between unrelated texts does not.
3. **Ties.** Each printed line with a word lined up is tied to the text where its words start; a
   line between two such lines with none (a row of stars, a dash alone) where the one before ended;
   the last line of a page also where its words end, so that a page holds exactly its own words.
4. **Trust.** A page is trusted when at least half of its words are lined up and its ties stay
   where the chapter-level map puts them, give or take the stretch that map interpolates there or
   the chapter they are in (a straight line: six per cent of the book, its own margin, D74): a line
   may move inside its chapter, never across the book. More than one tie in twenty out of place in
   all, and nothing is trusted: the chapter map is not of this text (half of the book spread over
   all of it, D73) or the text is not the book's. A refused PDF keeps its chapter map, as an
   untrusted track does (D61, D46).
5. **The map.** The refined edition's map is tied at every line of the trusted pages (one point a
   line; Alice: 2,547 points, 86 KB of JSON), keeps the chapter map before the first trusted line and
   after the last, and follows the ties across an untrusted page between trusted ones. It is a
   forced alignment like the transcript's (`method: 'forced'`, the chapter match kept beside it):
   the gate drops the cross-format margin wherever it holds, and chains it with the audiobook's
   when the EPUB between them is itself lined up with the reference. A PDF note's place is the line
   its `y` is on: the gate judges all of that line, up to where the next one starts.

## Measured on the fixtures

The Alice PDF (`fixtures/books/alice.pdf`, 91 pages) against the Alice EPUB (`server
printed.test.ts`, `shared textalign.test.ts`):

| | |
|---|---|
| printed words | 26,853, of which lined up 26,691 (99.4 %): all but the page numbers and the title page |
| printed lines | 2,538 with words, 2,446 tied (the 92 others: the page numbers, the title page) |
| pages trusted | 90 of 91 (not the title page); ties out of place: 3, on the title page |

**Line error**, against 2,055 printed lines found in the EPUB by their own words (their first five
words once in a row in the story, all their words following them), not by the alignment:

| | lined up | chapter map |
|---|---|---|
| words of those lines (24,720) placed on their own line | **24,720 (100 %)** | 1,042 (4.2 %) |
| furthest a word was placed from its line | 0 lines | 31 lines |
| a selection at a line's top opens the EPUB, from the line's first word | **3 to 26 characters on**, never past the line | 1,688 before to 570 after; 400 lines past their end |
| from a page's top, the audiobook (LibriVox, its transcript) starts before the narrator's first word of the page (67 pages) | **18 ms to 1.04 s** (the pause before its sentence) | median 21.5 s early, up to 181 s early or 26 s late; 30 pages over 30 s early |

The reviewer's three notes: Ana's EPUB note on "Down, down, down…" sat three lines up on page 3
and opened on page 4, now on its line, opening with page 3; Cleo's 🤯 on "I wish I hadn't cried so
much!" sat eleven lines below on page 11 and opened on page 12, now on its line, with page 11;
Cole's PDF note on page 12 ("Perhaps it doesn't understand English") showed 478 characters above
its quote in the EPUB (eleven lines on a phone) and opened a page late, on a phone's pages of 858
characters as on a laptop's of 2,132 (the reviewer's, two); now 10 characters into its quote (which
starts the printed line), opening on the page that holds it on both.

**Refused** (each keeps its chapter map): Alice set backwards (the same words: the edit-distance
alignment pairs one in six, under 1 % in runs of four; no page trusted), the Project Gutenberg
licence (another text), and the first six chapters of Alice on the straight line D73 gives a part
of a book (every word lined up, most ties out of place); matched to chapters I to VI by hand, that
last one is lined up line by line.

**Time and size.** Alice: its text read in a worker in 0.7 s (0.3 s of it the pages' text), lined
up in 0.13 s. *War and Peace* set as a 1,855-page PDF in the test's way: read in 4.6 s, lined up in
3.0 s (567,265 words lined up, 1,840 pages trusted), well within the limits (the reading's 23 s,
the alignment's 60 s and 768 MB); its map has 53,104 points (1.9 MB of JSON, sent with the book).

## Limits

- A PDF's place is a line: the PDF locator says how far down the page, not where along the line.
  A note made from a selection carries only its start, so a quote over several lines is judged by
  its first; the reader could send the selection's end as its end locator.
- Two columns on a page are read across, as one line each: such pages are mostly untrusted, and
  keep the chapter map's error there. So are pages whose text layer is not the printed text (a scan
  with poor recognition, a font without its character map).
- A word cut at a line's end and continued after a running head in lower case stays two words
  (one word unmatched); a hyphenated compound cut at its hyphen is right either way.
- Another edition, translation or abridgement of the book is lined up where its words are the
  text's and refused where they are not; a PDF of part of the book is refused until its owner
  matches its chapters by hand ("Match to chapters"), as D73 asks already.

## Optional NVIDIA GPU transcription

`tools/align/transcribe.py` accepts `--device cpu|cuda|auto` and `--compute-type`.
The default remains **CPU int8**; existing deployments and `TRANSCRIBE_COMMAND` do not change.
An explicit `cuda` request fails if CUDA cannot be used (it does not silently run on the CPU).
`auto` selects CUDA when CTranslate2 sees a device, otherwise CPU. The default compute type is
float16 on CUDA and int8 on CPU; `--compute-type int8_float16` is an explicit alternative.
This is a CLI option, **not a remote GPU scheduler**: a CPU-only app host does not acquire a GPU
by setting it to `auto`. To hand the server's own runs to a GPU box when it is up, with this
host as the fallback, see docs/GPU-TRANSCRIPTION.md.

On a separately provisioned NVIDIA host, use the recogniser dependencies in
`tools/align/requirements.in` and compatible CUDA/cuDNN runtime libraries. For the tested CUDA 12
runtime with a CUDA 13-capable driver, the extra libraries were `nvidia-cublas-cu12` and
`nvidia-cudnn-cu12` (cuDNN 9). Make their libraries visible before starting CTranslate2:

```sh
SP=$(venv/bin/python -c 'import site; print(site.getsitepackages()[0])')
export LD_LIBRARY_PATH="$SP/nvidia/cublas/lib:$SP/nvidia/cudnn/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export HF_HOME="$HOME/align/hf"
venv/bin/python tools/align/transcribe.py --device cuda --model large-v3 \
  --out alice-large-v3.json path/to/wonderland_ch_*_64kb.mp3
```

Omit `--offline` on the initial download; use it for subsequent cached/local-model runs.
The output is the unchanged `bookclub-transcript/1` format. Its SHA-256 hashes must match the
edition's actual audio files: a transcript of real narration cannot attach to the short tone
files from `fixtures/audio/alice-tiny`. Those tones correctly produce no recognised words;
an empty transcript there is not evidence of a broken speech recogniser. Replacing live edition
files changes its timeline and must be coordinated before applying a new transcript.

CLI regression tests (stdlib only; no model download or GPU required):

```sh
python3 -I -m unittest discover -s tools/align -p 'test_*.py'
```

### Alice GPU experiment, 2026-10-30

Reference: the same 12 checksum-pinned LibriVox Alice tracks from the Dockerfile (about 179 minutes)
and `fixtures/books/alice-gutenberg-11.epub`, running faster-whisper 1.1.1 / CTranslate2 4.8.3,
greedy decoding, ten-minute windows, CUDA float16 on one RTX PRO 6000 Blackwell (96 GB).

| Model | Observed whole run (including initial model setup/download) | Text words matched | Sentences aligned |
|---|---:|---:|---:|
| large-v3 | 367 s | 26,008 / 26,775 (97.1%) | 1,596 / 1,643 (97.1%) |
| large-v3-turbo | 89 s | 25,381 / 26,775 (94.8%) | 1,564 / 1,643 (95.2%) |
| small.en on GPU | 107 s | 26,034 / 26,775 (97.2%) | 1,597 / 1,643 (97.2%) |

The small.en GPU run overlapped CPU measurement work, so these are observed end-to-end durations,
not an isolated hardware throughput benchmark. The existing small.en fixture matches 97.4% of
text words and aligns 1,597 sentences; its older run used a different window setup. Bigger is
not automatically better for this alignment task: do not promise higher accuracy from large-v3
or switch the production default solely on parameter count.

Independent timing check: `spotcheck.py`, 80 seeded aligned sentences per run, freshly decoded
clips evaluated with CPU small.en (not the full-book decode's context). Chapter-map evaluation
was omitted here; the original chapter-map comparison is above. This is a recogniser-based
spot check, not manually labelled ground truth, and the sentence sample can differ slightly
when the models align different sentence sets.

| Transcript model | Sentences whose opening words were found | Median absolute start error | 95th-percentile error |
|---|---:|---:|---:|
| large-v3 | 73 / 80 | 0.34 s | 1.46 s |
| large-v3-turbo | 72 / 80 | 0.30 s | 1.06 s |
| small.en GPU | 73 / 80 | 0.12 s | 0.58 s |

For **this reference book**, small.en on GPU gave the strongest sync result. Large-v3 does not
improve it in this test. Pick a model by measured alignment and timestamps, not size alone.
JSON evidence for these checks is in `docs/alignment/spotcheck-gpu-alice-*.json`.
