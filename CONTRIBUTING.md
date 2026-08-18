# Contributing to MiutChat

Thanks for considering contributing. This document covers how the codebase is organized, the coding conventions it follows, how to get a change through review, and a glossary of the terms used throughout the code and issue tracker.

If you're looking for a general project overview first, start with [`README.md`](./README.md) — this document assumes you've read that.

## Table of contents

- [Before you start](#before-you-start)
- [Coding style](#coding-style)
- [Working with the build/version pipeline](#working-with-the-buildversion-pipeline)
- [Architecture notes for contributors](#architecture-notes-for-contributors)
- [Making a change: workflow](#making-a-change-workflow)
- [Commit messages](#commit-messages)
- [Testing your change](#testing-your-change)
- [Pull request checklist](#pull-request-checklist)
- [Reporting bugs](#reporting-bugs)
- [Reporting security issues](#reporting-security-issues)
- [Glossary](#glossary)

## Before you start

- Small, focused PRs are much easier to review than large ones. If you're planning a big change (a new feature, a refactor), open an issue first to discuss the approach before writing code.
- This project deliberately has **no framework and minimal dependencies** (see [README → Tech stack](./README.md#tech-stack)). Please don't introduce a UI framework, state-management library, or heavy dependency without discussing it first — that's a core design decision, not an oversight.
- All client-side crypto lives in `crypto-engine.js` / `crypto-bridge.js` / `crypto-worker.js`. Changes there deserve extra scrutiny — see [Testing your change](#testing-your-change).

## Coding style

The codebase is plain JavaScript (no TypeScript, no JSX) targeting modern evergreen browsers. There's no enforced linter/formatter config committed yet, so please match the existing style by eye:

- **Indentation:** 2 spaces, no tabs.
- **Semicolons:** always.
- **Quotes:** single quotes for strings in JS; double quotes in HTML attributes.
- **Naming:**
  - `camelCase` for functions and variables.
  - A leading underscore (`_extendRoomTtl`, `_pendingMsgPayloads`) marks something as module-internal/private-by-convention — it's still just a regular top-level function/variable (there's no real privacy in a single script), but the underscore signals "not part of the public surface other files should call."
  - `SCREAMING_SNAKE_CASE` for constants that are genuinely fixed configuration (`CONFIG.MAX_FILE_BYTES`, `_HISTORY_PAGE`).
- **Functions:** prefer small, single-purpose functions with a one-line comment above anything non-obvious. If a function's *purpose* isn't clear from its name plus a one-line comment, it's a sign it's doing too much.
- **Comments:** explain *why*, not *what*. `// extend by 5 min` is redundant next to `+= 300000`; `// only extend while the room is occupied — an empty room's countdown is set elsewhere` earns its place.
- **Async code:** always use `async`/`await` over raw `.then()` chains where reasonable. **Never call an `async` function inside a plain `.forEach()` without awaiting it** — this exact mistake caused a real, shipped bug (message history rendering out of order, because each message's decrypt raced independently instead of resolving in sequence). Use a `for...of` loop with `await` inside instead.
- **DOM manipulation:** this project builds HTML via template strings and `innerHTML` in several places (for performance/simplicity given the lack of a framework). When you do this, **always escape user-controlled content** through `esc()` (see `app.js`) before interpolating it — this is a chat app; message content, display names, and file names are all attacker-controlled input as far as XSS is concerned.
- **CSS:** one file (`style.css`), custom properties (`--teal`, `--surf2`, etc. — see the `:root` block) for the whole design system. Don't hardcode colors that already have a variable; add a new variable if you need a genuinely new one.

## Working with the build/version pipeline

- `build.js` is the only build step — no webpack/vite config to learn. It uses `esbuild` for bundling/minification and a few custom string-transform passes (see the `prepTmp` helper) for things like stamping the app version into files at build time.
- **Never hand-edit a version number** in `app.js`, `sw.js`, `manifest.json`, `wrangler.toml`, `index.html`'s meta tag, or `functions/api/health.js`. All of those are overwritten by `build.js` from the single source of truth in `package.json` (via `version.js`) every time it runs. If you need to bump the version deliberately (e.g. for a release), use `node version.js minor` (or `major`) — see [README → Versioning](./README.md#versioning).
- **While iterating locally, run `SKIP_VERSION_BUMP=1 node build.js`** so you're not bumping the version on every test build. A plain `node build.js` (no flag) *will* bump it — that's intentional default behavior for real deploys, but it means it's easy to accidentally burn through version numbers while just testing locally if you forget the flag.
- Run a full build (`node build.js`, or `SKIP_VERSION_BUMP=1 node build.js` while testing) before opening a PR, and make sure it completes with no errors. A change that doesn't build isn't ready for review.

## Architecture notes for contributors

A few things that aren't obvious from reading any single file in isolation:

- **`app.js` is one big file (~5,900 lines) by design**, not an oversight — there's no framework/module bundler splitting things up, and it's loaded as a single script. When adding a feature, look for the relevant existing section (rooms / messages / reactions / settings / crypto glue / UI wiring) and add near related code rather than appending to the end of the file.
- **Optimistic UI is a deliberate pattern used throughout**, not just for message sending. When you add a user-initiated action that involves a network round trip (Firestore write), strongly consider: (1) update the local UI immediately, (2) fire the write in the background, (3) reconcile via the live listener when it lands, (4) roll back visibly on failure. See `sendMessage()` → `_reconcileSentMessage()` / `_markMessageFailed()`, or `toggleReaction()`, as reference implementations.
- **The live Firestore listener in `startChatListeners()` is the single source of truth for "what's on screen."** Anything that renders a message (initial history load, live updates, edits, reactions, soft-deletes) ultimately flows through `renderMsg()` or `patchMsg()`. If you're adding a new kind of message mutation, it needs a `patchMsg()` branch so *other* members see it live, not just the person who triggered it.
- **Soft-delete, not hard-delete.** Messages are never actually removed from Firestore when a user "deletes" them — see `_softDeleteLocal()` / `_softDeleteRemote()`. The document is updated to a tombstone (`deleted: true`, content fields nulled) so everyone in the room sees "This message was deleted" instead of the message just silently disappearing with no explanation. If you touch delete-related code, preserve this — a hard delete regresses a bug that's already been fixed once.
- **Room expiry counts from emptiness, not general inactivity.** The room's `autoDeleteAt` is only ever set when the room is detected as genuinely empty (see `startPresenceListener`); while people are actively present, nothing is scheduled. If you're touching expiry logic, keep this distinction — conflating "no messages sent recently" with "nobody's here" was a real, reported bug.
- **Chunked file transfer can straddle a history-page boundary.** Large images/videos are split into multiple small Firestore documents; a new member's initial (paginated) history fetch can end up with only part of a file's chunks. `_healIncompleteChunkGroups()` exists specifically to backfill the rest by `groupId` after each history page loads — if you touch the chunking/reassembly code, keep this self-healing step intact or an equivalent.
- **Double-firing touch+click handlers is a recurring failure mode on this codebase's target devices.** Several real bugs (emoji reactions toggling on-then-off, message selection entering unexpectedly) came from wiring both `touchend` (with `preventDefault()`) *and* `click` on the same element, on mobile browsers that don't always fully suppress the synthetic click after `touchend`. If you wire both for compatibility, use the shared `_debounceFire()` guard (or an equivalent) so only one fires per physical tap.

## Making a change: workflow

1. **Fork** the repository and create a branch off `main` (or whatever the current default branch is) — use a short, descriptive branch name, e.g. `fix/message-order-race` or `feat/room-expiry-instant-option`.
2. **Make your change**, following the style guide above.
3. **Build and test locally** (see below).
4. **Commit** with a clear message (see [Commit messages](#commit-messages)).
5. **Open a pull request** against the main repository, filling in what changed and why, and — for anything touching the UI — a screenshot or short screen recording. (Video bug reports have directly led to several real fixes in this project; they're genuinely useful.)
6. Respond to review feedback. Please don't take review comments personally — this is a security-sensitive app (client-side encryption, no accounts) and scrutiny is proportionate to that, not a judgment of the contributor.

## Commit messages

- First line: short, imperative summary (`Fix message history rendering out of order`, not `Fixed a bug` or `Updates`).
- Body (optional but encouraged for anything non-trivial): explain *why* the change was needed and, if it fixes a specific reported bug, describe the root cause you found — future contributors (including future-you) will thank you when they hit something adjacent.

## Testing your change

There's no automated test suite in this repository yet (a good first contribution, if you're looking for one, would be introducing one). Until then:

- **Always run a full build** (`SKIP_VERSION_BUMP=1 node build.js`) and confirm it completes with no errors.
- **Manually exercise the change** in a real browser against a real (or emulated) Firestore backend — this app leans heavily on Firestore's realtime listener behavior, timestamp semantics (`serverTimestamp()` resolution timing has directly caused bugs before), and security rules, none of which a quick code read reliably substitutes for.
- **Test with at least two simultaneous "members"** (two browser tabs/profiles) for anything touching messages, reactions, presence, or room state — bugs in this codebase have repeatedly turned out to only manifest from a *second* participant's perspective (e.g. a new member's view, or what another member sees after you delete something).
- **If you touch crypto code**, verify round-trip correctness explicitly (encrypt then decrypt, across the exact code paths you changed) rather than trusting that it "looks right."

## Pull request checklist

Before requesting review, confirm:

- [ ] `SKIP_VERSION_BUMP=1 node build.js` completes with no errors
- [ ] No version numbers were hand-edited (see [Working with the build/version pipeline](#working-with-the-buildversion-pipeline))
- [ ] User-controlled content passed through `esc()` (or an equivalent) before being interpolated into HTML
- [ ] Any new Firestore write is reflected somewhere in `patchMsg()`/the relevant live listener, so other members see it in real time — not just the person who made the change
- [ ] Tested with at least two simultaneous participants, for anything touching shared room state
- [ ] Screenshot or short recording attached, for anything touching the UI

## Reporting bugs

Open a GitHub issue. Include:

- What you did, what you expected, what actually happened.
- Browser + OS/device (mobile bugs in this app have often turned out to be browser-specific — e.g. touch-event handling quirks).
- A screen recording if the bug is at all visual or timing-related — this has repeatedly been the difference between a report we could act on and one we couldn't reproduce.

## Reporting security issues

**Do not open a public issue for a security vulnerability.** See [`SECURITY.md`](./SECURITY.md) for how to report it privately.

## Glossary

Terms used throughout the codebase, issues, and this document that aren't necessarily self-explanatory:

| Term | Meaning |
|---|---|
| **Room** | A chat session, identified by a short room code. Backed by a Firestore document at `rooms/{roomCode}`. |
| **Room code** | The shared secret used to join a room and, combined with the room's salt, derive its encryption key. |
| **Epoch** | A version number for a room's derived encryption key. Rotating the epoch (admin action, or automatic after N messages) forces a fresh key derivation; old messages stay readable under the epoch they were encrypted with. |
| **Room expiry** | How long a room persists after it becomes *empty* (no members online) before being permanently deleted. Admin-configurable (Instant / 5 min / 1 hour / 24 hours / Never). See `_roomExpiryMs`, `setRoomExpiry()`. |
| **Message expiry (TTL)** | An optional, independent setting causing individual messages to auto-vanish after a set duration, regardless of room expiry. See `_roomTtlMs`, `setRoomTtl()`. |
| **Optimistic UI / optimistic render** | Updating the UI immediately in response to a user action, before the corresponding network write has actually completed — then reconciling with the real result once it lands (and rolling back on failure). Used throughout for sending messages, reactions, and deletions so the app doesn't feel like it's waiting on the network. |
| **Reconciliation** | The process of replacing an optimistically-rendered local placeholder (e.g. a message shown before Firestore confirms it) with the authoritative server state once it arrives. |
| **Tombstone** | A soft-deleted message: the Firestore document still exists, but its content fields are nulled and `deleted: true` is set, so it renders as "This message was deleted" instead of vanishing without explanation. |
| **Chunking / chunk group** | Splitting a large encrypted file (image/video) across multiple small Firestore documents (each under the ~1MB document size limit), linked by a shared `groupId`, and reassembled by the receiving client. |
| **Presence** | Whether a member is currently online in a room; tracked via a `members` subcollection and used to detect when a room has become empty (for room-expiry purposes) and for the "N online" indicator. |
| **Approval gate** | An admin-toggleable setting requiring new members to be explicitly approved by the admin before they can read messages or participate. |
| **ScreenGuard** | The anti-screenshot/recording subsystem (`screen-guard.js`) that blurs the screen and overlays a traceable watermark when the app loses focus or the screen is hidden. |
| **Canary** | A per-message integrity marker used to help detect message replay or injection attempts (see `security.js`, `_registerCanary`). |
| **Nonce tracking** | Deduplication of message identifiers within a short window, to reject exact-duplicate replayed messages (see `trackNonce()` in `security.js`). |
| **Debounce guard / double-fire guard** | A small timestamp-based check (`_debounceFire()`) used to prevent a single physical tap from triggering an action twice when both a `touchend` and a `click` handler are wired to the same element (a recurring cross-browser quirk on this project's target mobile browsers). |

---

Thanks again for contributing. If anything in this document is unclear or out of date, that's itself worth a small PR to fix.
