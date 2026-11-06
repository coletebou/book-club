# @bookclub/chat-core

The parts of a small group chat that belong to no particular app: who an `@` names and how a
composer offers names, how a live, paged, threaded list of messages stays right as messages
arrive, change and go, and the composer's own state. Book Club is its first user; it is written
to be lifted out and shared with Cole's other projects, the way the Badland real-time voice core
is (D202 in `docs/DECISIONS.md`).

- **No runtime dependencies.** Not React, not zod, nothing. Types are structural; an app's own
  message type passes through untouched.
- **No platform.** No Node built-ins, no `process`, no `Buffer`, no DOM. It runs the same in Node,
  Bun, a browser, a Worker or React Native. `src/boundary.test.ts` fails the build otherwise.
- **No app.** Nothing here imports `@bookclub/*`. Rules an app has of its own (Book Club's "never
  let a hidden copy replace one you can read") are passed in as arguments.

## What is here

| Module | What it does |
|---|---|
| `text.ts` | `nameKey` (the folded key a name is matched by), `foldForSearch`, `collapseSpaces`, `snippet` (a message cut to a quote, never splitting a word or an emoji when it can help it) |
| `mentions.ts` | `mentionDirectory` (who can be named, and by which keys), `findMentions` (the spans a message's `@`s name, the source of truth), `mentionQueryAt` / `rankMentionCandidates` / `mentionTokenFor` / `applyMention` (autocomplete), `segmentText` (runs and mentions, for drawing highlights) |
| `messages.ts` | The thread model (`ThreadedMessage`: `parentId`, `threadId`, `replyCount`) and pure reducers over newest-first pages: `upsertMessage`, `removeMessage`, `appendOlder`, `refreshNewest`, `threadOf`, `groupRuns` |
| `store.ts` | `createStore`: one immutable snapshot, `getState` and `subscribe` as arrow properties |
| `composer.ts` | `createComposerStore`: text, caret, the message being answered and the @-mention picker, driven by what the person does |

## The mention rules

A message is stored as typed. An `@` starts a mention only at the start of the text, after
whitespace or after opening punctuation, never inside a word, an email address, a path or an
inline code span. A name may run to several words, and the longest run that is someone's whole
display name wins. One word may be a whole display name (strongest), an agent's handle, or a first
name (weakest). A name ends where its word does, without a trailing `'s` or full stop. Case, accents
and punctuation fold away. A key that names two people at its strongest names nobody, and
`mentionTokenFor` writes a longer form that names one. Both ends call `findMentions`: the server to
notify, the composer to check that what it writes reads back as the person picked.

## Using it

```ts
import { createComposerStore, findMentions, mentionDirectory, upsertMessage } from '@bookclub/chat-core';

// Who can be named in this conversation.
const directory = mentionDirectory([
  { target: { kind: 'member', id: 'u1' }, displayName: 'Ana' },
  { target: { kind: 'agent', handle: 'cal' }, displayName: 'Cal', handle: 'cal' },
]);

// Server: who a message names (to notify them, and to send the spans with the message).
const spans = findMentions('@Ana have you asked @cal?', directory);

// Client: keep a list live. Book Club passes its own rules in.
const next = upsertMessage(page, incoming, { keepExisting: (held, inc) => !held.hidden && inc.hidden });

// Client: the composer, outside any framework.
const composer = createComposerStore<{ id: string }>({ directory: () => directory });
composer.input('hi @a', 5); // composer.getState().mention holds the picker
```

In React, `useSyncExternalStore(composer.subscribe, composer.getState)`.

## How Book Club plugs in

- **Server** (`apps/server/src/services/chat.ts`): `chatDirectory` builds the directory from a
  club's members; `ChatViews` reads every message's mentions with `findMentions` and quotes
  replies with `snippet`; `notifyMentions` notifies whom a message names.
- **Web** (`apps/web/src/lib/chat-model.ts`, `lib/queries.ts`, `live/ChatComposer.tsx`): the
  react-query cache keeps each channel and each thread with `upsertMessage`, `removeMessage`,
  `appendOlder` and `refreshNewest`; `ChatComposer` draws `createComposerStore`'s snapshot.
- Book Club consumes it as source (no build step), as it does `@bookclub/shared`.

## Run it

```sh
pnpm --filter @bookclub/chat-core test       # vitest, offline (fetch throws in tests)
pnpm --filter @bookclub/chat-core typecheck
```

## Limits and known gaps

- A name that begins another member's whole name, followed by the rest of it, reads as the
  longer name: with an Ana and an Ana Bell in the club, `@Ana bell rang` names Ana Bell. Plain
  text cannot tell the two apart; a structured token could, at the cost D201 rejects.
- Mentions are read in UTF-16 offsets, which is what JavaScript strings index by; a client in
  another language must count the same way.

## Moving it out

The plan (D202), for Cole to decide: a repository of its own, a licence (AGPL-3.0-only like Book
Club, or a permissive one so non-AGPL projects can use it; Cole holds the copyright either way),
and a scope (GitHub Packages, as the voice core plans). The move itself is mechanical: copy this
folder, add a `build` (`tsc` to `dist`, an `exports` map with `types` and `import`), rename the
package, and point Book Club's two `workspace:*` dependencies at the published one.
