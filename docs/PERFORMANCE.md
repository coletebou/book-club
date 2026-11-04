# A very long book

The original brief's stretch item 6: "a very long EPUB (War and Peace) opens quickly at a saved position.
Measure it and improve it." Decision D50.

## How it is measured

`e2e/perf/long-book.spec.ts` (run on demand: `BOOKCLUB_URL=… pnpm exec playwright test -c
perf/playwright.config.ts` in `e2e`) uploads Project Gutenberg's *War and Peace* (#2600, EPUB 3
with images: 368 sections, 3.58 million characters), saves a place three quarters of the way
through, and opens the reader there on a device that has never counted this book's pages:

- **first page**: from navigation to the saved page drawn on screen (the reader's `data-start`);
- **page turn**: a tap on "next page" while the pages are still being counted, until the next
  page is on screen;
- **page numbers**: until "Page X of Y" (exact, book-wide) is shown;
- then the same again on the same device (page counts cached for this layout), and, in Chromium,
  a fresh device on an emulated phone network (150 ms round trips, 9 Mbit/s).

Desktop Chromium (1280 × 860) and WebKit with iPhone 15 emulation, against the stack on this box.
The results are in [perf/](perf/).

## Results

| | Chromium desktop | WebKit iPhone |
|---|---|---|
| pages (at the default font) | 1,681 | 4,176 |
| ingest (upload to ready) | 4.9 s | 4.8 s |
| **first page at the saved place** | **0.94 s** | **1.11 s** |
| a page turn while counting | 91 ms | 93 ms |
| page numbers, first open (before) | 8.3 s | 13.1 s |
| page numbers, first open (now) | **7.4 s** | **9.6 s** |
| first page / page numbers, second open | 0.85 s / 0.86 s | 0.88 s / 0.90 s |
| first page / page numbers on a phone network | 1.31 s / 7.8 s | (Chromium only) |

**What makes it fast.** The reader never waits for page numbers: it opens the saved section at
the saved character (layout-independent locators, D11) and draws that page; the footer shows the
page within the section ("Section page 3 of 5") and "Paginating… 45 %" until the book-wide
numbers are ready, and a page turn meanwhile takes under a tenth of a second. The counts are cached
on the device per layout (D9), so every later opening has them at once.

**What was improved.** The page counter used to wait for an idle moment before every section;
WebKit has no `requestIdleCallback`, so that was 16 ms × 368 sections of nothing. It now yields
only after 40 ms of work (a section's own load already gives the page back), which made the first
count 27 % faster in WebKit and 11 % in Chromium, with exactly the same page numbers. Fetching the
next sections ahead was tried and dropped: opening a book already keeps every file of it on the
device (D19), which warms the HTTP cache for the counter, and the extra requests only competed on a
slow network (7.7 s without them, 8.7 s with them).

## Limits

- The first count of a 4,000-page book takes ten seconds on this machine and more on an old phone;
  it runs in the background and only the book-wide numbers wait for it.
- A font or screen change recounts from nothing (D9): never appended to the old counts, which is
  how v1's totals doubled.
