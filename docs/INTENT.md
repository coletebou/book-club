# Intent

What Book Club is for, written from the v1 documents (`2026-02-23-book-club-design.md`,
`2026-03-11-progress-comments-design.md`, `2026-03-09-session-summary.md`,
v1's project notes, the v1 git log and code) and the original brief. Every requirement here is traced to code and
tests in [TRACEABILITY.md](TRACEABILITY.md).

## The one-sentence version

A small, private reading room where a handful of friends read the same book at their own pace, on
their phones, and meet each other inside the book: where everyone is, what they felt, what they
said, exactly at the place they said it, and never a word from a page they have not reached yet.

## Who it is for

Three or four friends today, perhaps ten later. They already know each other. They read
asynchronously: one reads at lunch, one listens on a run, one binges on a Sunday. Most of them are
on iPhones, many will add the app to the home screen and use it like a native app. Cole runs the
instance. None of them want another account, another password policy, another settings page.

## What Cole actually asked for, and what was underneath it

| He asked for (v1) | What he was really after |
|---|---|
| Position-anchored comments, inline markers | The conversation lives *in the book*, not in a group chat that spoils it. You meet a friend's note when you get to it, like a pencil mark in a shared paperback. |
| Emoji reactions as "spoiler-free sentiment markers" | Anticipation without spoilers. You can see that Ana gasped two chapters ahead of you; you cannot see why until you get there. The promise "nobody here will ever spoil it for you" is the product. |
| Presence (who is reading, where) over WebSocket | Company. Reading alone together: opening the book and seeing that Ben is on chapter 4 right now. |
| A club progress bar with coloured member markers | A shared race track you never have to talk about: where everyone is, at a glance, live. |
| `ReadingProgress` with both `ebookProgress` and `audioProgress` in one record | A club reads a *book*, not a file. Some read the EPUB, some the PDF, some listen. Everyone's position, comments and reactions belong on one timeline whatever the format, and you can switch formats mid-chapter and carry on. |
| Upload with auto-extracted title, author, cover; tracks sorted by filename and reorderable | Bringing this month's book in should take ten seconds and no typing, including a 1 GB folder of MP3s, on bad Wi-Fi. |
| "Page 47 / 312" plus chapter page plus percentage | A reader that respects reading: real pages that mean something, that don't jump around, that you can quote ("I'm on page 47"). |
| Speed, scrubber, track list with chapter names, Media Session | A real audiobook player: lock screen controls, background playback, never losing your place. |
| PWA, add to home screen, IndexedDB book cache | It is an app on the phone, and the book is on the phone: a flight or a tunnel does not stop the reading, and nothing is lost when the signal comes back. |
| Shared upstream JWT, no registration | One identity. Nobody creates yet another account when an upstream identity exists. |
| Illuminated-manuscript look: parchment, ink, a sanguine accent (D117, restyled after a parchment-and-ink palette) | Calm and a little luxurious: a commonplace book kept by lamplight, not a dashboard. |
| A VPS + R2 + Atlas + Pages | Cheap. In practice four providers was fragile; the real want is *small, cheap, simple to deploy, simple to back up*. |

## A good evening of reading

Cole opens the app from his home screen. It is instant: no splash, no login. The library shows
this month's book with a thin gold line under the cover; on it sit four small coloured dots, one per
friend, and Ana's dot has a soft pulse because she is reading right now, in chapter 6.

He taps the book. It opens exactly where he stopped last night, even though last night he was
*listening* in the car: the reader has carried his audio position over to the matching page. The
footer says "Page 47 of 186 · 6 pages left in chapter · 25%". Across the top runs the club bar: his
own marker, Ben's a little behind, Ana's ahead, and two tiny emoji further along the bar where
someone reacted to something he has not reached.

He turns pages. Halfway down page 49 there is a small 😱 in the margin. It was not there before;
it appears because he has just reached the sentence Ana reacted to. He taps it: "Ana · I did NOT
see this coming". He selects a line he loves and taps ❤️. Later Ben will see a ❤️ dot appear on
the bar, ahead of him, with no idea what it is attached to.

He finishes the chapter. The end-of-chapter card shows what friends left in that chapter, now that
he has read all of it. He bumps the font size up; the book re-paginates in the background, the
same paragraph stays on screen, and the totals change once, correctly ("Page 61 of 243").

On the way to bed he switches to the audiobook, which starts at the paragraph he was reading. He
locks the phone; the lock screen shows the cover, the chapter name, a scrubber and ±15/30 s
buttons, and the audio keeps playing through the end of the track and into the next one.

## The moments that matter

1. **Opening it.** Instant, signed in, at the right place, showing who is here.
2. **Seeing friends' positions.** Live, at a glance, without spoilers, across formats.
3. **Reaching a friend's reaction.** The note appears exactly when you get to the passage. Before
   that it is only a marker (who, and which emoji), never its text or the passage.
4. **Finishing a chapter.** A natural pause: what friends said in the chapter you just finished.
5. **Finishing the book together.** When you reach the end everything unlocks; the club sees who is
   done.
6. **Switching formats.** Read on the train, listen in the car, read in bed, one position.
7. **Bringing in a new book.** Drop the EPUB, the PDF or the folder of tracks; title, author,
   cover and chapter names fill themselves in; the upload survives the hotel Wi-Fi.

## What must never happen

- **A spoiler.** No comment text, no quoted passage, and no notification may reach a member whose
  *read* range does not contain it. This is enforced by the server, not hidden by the UI. Jumping
  ahead via the table of contents or the scrubber does not count as reading the pages you skipped.
- **A lost position.** Progress is saved locally first and synced when possible; reconnecting never
  rolls a reader back; a reload, a font change, an app kill or a format switch lands on the same
  passage.
- **A failed big upload.** A 1 GB audiobook folder on flaky Wi-Fi resumes where it stopped, without
  starting over, even across a page reload.
- **Audio stopping when the phone locks.** Background playback, lock screen controls and automatic
  advance to the next track.
- **Page numbers that lie.** No doubling after a font change (v1), no count that restarts every
  chapter (v1 fallback), and the same page number for the same passage after a reload.
- **A comment that silently fails** because the reader's position was not wired to it (v1).
- **A friend's files leaking.** Only members of a club can see its books, files, covers, comments,
  progress or presence. Auth-gated media is never publicly cacheable, and signing out clears the
  device.
- **Another account to manage**, when an upstream identity exists.

## What the design document implied but never said

- **Spoiler safety must be enforced server-side**, and "reached" must mean *read*, not *jumped to*.
  The server tracks each member's read ranges (the parts of the book they have actually read or
  heard) and only releases a comment's text when its position falls inside one.
- **Comment anchors must be layout-independent.** A page number means nothing on another phone or at
  another font size. Anchors are text positions (EPUB), page-and-offset (PDF) or time (audio), and
  every anchor also has a position on the shared timeline.
- **Pages are personal; percentages and chapters are shared.** Two friends on different phones
  have different page counts. The club bar, presence and "where is everyone" use the shared
  timeline (chapter and percentage); "Page 47 of 186" is for you.
- **Cross-format positions need a map.** Character 41,000 of the EPUB and minute 23 of track 3 are
  the same moment only through a sync map (chapter boundaries by default; sentence-level when
  forced alignment is available).
- **Progress belongs to the book, not the file**, so a listener who later opens the EPUB starts at
  the right page.
- **The iPhone home-screen app has its own cookie jar.** Sign-in inside the installed app must be
  easy and sessions must be long-lived, or the "instant" promise breaks on day one.
- **Invite links are keys.** The owner must be able to rotate them, and members can be removed.
- **Backups are part of the product.** A club's comments are irreplaceable; "simple to back up"
  means one command and a tested restore.
- **The phone is the primary device**, so 44 px touch targets (26 px only on the club bar, whose markers sit closer than that and group when they would overlap: D31), safe-area insets, one-handed paging,
  VoiceOver labels and no hover-only affordances.
- **Gutenberg books carry boilerplate.** The licence at the end is not the story; "100%" should mean
  you finished the book, not the licence.

## What I will deliberately not build, and why

| Not building | Why |
|---|---|
| Public clubs, discovery, open sign-up | It is a private room for friends. Invite-only is the feature. |
| DRM'd books (Kindle, Apple Books, Adobe ACS) | Cannot be opened legally without the vendor's reader; friends bring DRM-free EPUBs, PDFs and MP3s. |
| Chat or DMs | A side channel would carry spoilers around the gating. The conversation is the comments in the book. |
| Native iOS app | A well-made PWA covers home screen, offline, background audio and lock-screen controls without an App Store. |
| Multi-host scaling, Kubernetes, microservices | Ten friends. One process, one SQLite file, one data directory. |
| Format conversion (MOBI/AZW3, CBZ, video) | Out of scope; EPUB, PDF and audio cover what the club reads. |
| AI summaries or recommendations | Not what the club is for, and summaries are spoilers by construction. |
| Email-dependent flows | No SMTP to configure or fail; the owner can issue a reset link and hand it over in person. Email can be added later behind the same interface. |
| A follow-along "watch my screen" mode | Asynchronous reading is the point; live co-reading would pressure the slower reader. |

## How we will know it is right

- The original acceptance goal, scripted as the acceptance run.
- A fresh-context review of fidelity to this document, recorded in `docs/REVIEW.md`.
- Cole opening it on his phone and not finding a rough edge in the first evening.
