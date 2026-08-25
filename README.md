<p align="center">
  <img src="icons/icon-192.png" width="72" alt="MiutChat logo"/>
</p>

<h1 align="center">MiutChat</h1>
<p align="center"><strong>End-to-end encrypted, anonymous, self-destructing chat rooms. No accounts. No phone number. No trace.</strong></p>

<p align="center"><strong><a href="https://miutchat.pages.dev">🚀 Launch the live app →</a></strong> — no install, no account, no phone number.</p>

<p align="center">
  <a href="https://miutchat.pages.dev">Live app</a> ·
  <a href="https://miutchat.pages.dev/about.html">About</a> ·
  <a href="https://miutchat.pages.dev/privacy.html">Privacy Policy</a> ·
  <a href="https://miutchat.pages.dev/terms.html">Terms of Service</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

---

## What is MiutChat?

MiutChat is a free, anonymous, end-to-end encrypted chat room app. You create a room, share a short code with whoever you want to talk to, and start chatting — no sign-up, no email, no phone number. Messages are encrypted **on your device** before they're ever sent, using a key derived from the room code itself, so the server (Firestore) only ever stores ciphertext it cannot read.

Rooms are ephemeral by design: once everyone leaves, the room and everything in it is deleted, on a timer the room's admin controls (instantly, after 5 minutes by default, after an hour, after a day, or never).

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Versioning](#versioning)
- [Security model](#security-model)
- [Contributing](#contributing)
- [License](#license)

## Features

- **End-to-end encryption** — AES-256-GCM, keys derived client-side via PBKDF2 from the room code. The server never sees plaintext.
- **No accounts, no identity** — join with just a room code; a random display name is generated per session.
- **Self-destructing rooms** — admin-configurable expiry (Instant / 5 min / 1 hour / 24 hours / Never), counted from the moment the room becomes empty.
- **Self-destructing messages** — optional per-message auto-vanish (30s up to 7 days), independent of room expiry.
- **Reactions, replies, editing, and soft-delete** — deleted messages become a "This message was deleted" tombstone visible to everyone, rather than silently vanishing.
- **Image & video sharing** — encrypted client-side, chunked for large files, reassembled and decrypted lazily as messages scroll into view.
- **Read receipts & delivery ticks**, typing indicators, emoji reactions.
- **Admin approval gate** — optionally require the room admin to approve new members before they can read or send messages.
- **Key rotation ("epochs")** — admins can rotate the room's encryption key at any time; auto-rotates on a message-count threshold too.
- **Anonymous in-app feedback** — stored in its own top-level Firestore collection, never linked to a room's messages or a user's identity.
- **Installable PWA** with offline-readable cached history (IndexedDB) via a service worker.
- **Fully static + serverless** — no backend server to run; deploys as a static site plus a handful of Cloudflare Pages Functions.

## Tech stack

| Layer | Choice |
|---|---|
| UI | Vanilla HTML/CSS/JS — no framework, no build-time templating beyond esbuild bundling |
| Data & realtime | [Firebase Firestore](https://firebase.google.com/docs/firestore) (client SDK, realtime listeners) |
| Crypto | Browser [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (AES-256-GCM, PBKDF2, ECDSA P-256 for message signing) |
| Hosting | [Cloudflare Pages](https://pages.cloudflare.com/) (static assets + Pages Functions for a few edge endpoints) |
| Bundler | [esbuild](https://esbuild.github.io/) via a small custom [`build.js`](./build.js) — no webpack/vite |
| Offline / caching | Service worker (`sw.js`) + IndexedDB (`db-manager.js`) |

There is intentionally no framework, no npm-dependency-heavy UI layer, and no server-rendered anything. The entire client is a handful of plain JS files loaded by `index.html`, bundled/minified by `build.js` for production.

## Project structure

```
MiutChat/
├── index.html              The app itself (chat UI)
├── app.js                  Core client logic: rooms, messages, reactions, UI wiring (~5.9k lines)
├── style.css                All styling (~900 lines, one file, CSS custom properties for theming)
├── crypto-engine.js         AES-256-GCM encrypt/decrypt, key derivation, signing primitives
├── crypto-bridge.js         Glue between the UI and crypto-engine/crypto-worker
├── crypto-worker.js         Web Worker offload for heavier crypto operations
├── security.js               Replay protection, nonce tracking, timestamp validation, canaries
├── screen-guard.js           Anti-screenshot/recording blur + watermark overlay
├── db-manager.js             IndexedDB wrapper (message cache, blob cache)
├── storage-engine.js         Higher-level cache read/write helpers used by app.js
├── sw.js / sw-bridge.js       Service worker + main-thread bridge (cache-first shell, offline fallback)
├── miut-protocol.js          Shared protocol constants/helpers
├── placeholder-rotator.js    Small cosmetic input-placeholder rotation on the join screen
├── build.js                  Build pipeline (esbuild + custom transforms; see below)
├── version.js                 Single source of truth for the app version (see Versioning)
├── landing.html / about.html / privacy.html / terms.html / 404.html / offline.html / maintenance.html / vault.html
│                              Static marketing/legal/utility pages
├── manifest.json              PWA manifest
├── wrangler.toml              Cloudflare Pages config (KV namespaces, env vars, rate-limit tuning)
└── functions/api/             Cloudflare Pages Functions (edge endpoints)
    ├── health.js               Uptime/health check
    ├── rate-limit.js            Server-side rate limiting for room create/join/send
    ├── cleanup.js               Cron-triggered sweep that deletes expired rooms
    ├── canary.js                 Replay/injection canary registration
    ├── validate-room.js          Room-code validation endpoint
    ├── csp-report.js             CSP violation report sink
    ├── maintenance.js            Maintenance-mode toggle endpoint
    └── config.js                 Client runtime config endpoint
```

There's no `src/`/`dist/` split in the repo — `dist/` is generated by `build.js` and is not committed (see `.gitignore` if present, or just note it's build output).

## How it works

### Rooms and identity

A room is a Firestore document at `rooms/{roomCode}`, with subcollections for `members` and `messages`. There are no user accounts: a "member" is just a random per-session identity (name + color) stored in `localStorage`, tied to a room via a signed session token. Anyone with the room code can join (optionally subject to admin approval — see `APPROVAL GATE` in Settings).

### Encryption

Each room has a random salt, generated at creation time. The room code + that salt are fed through PBKDF2 to derive an AES-256 key entirely **client-side** — the server only ever stores the salt and ciphertext, never the derived key or plaintext. Messages are additionally signed (ECDSA P-256) so recipients can verify a message actually came from the sender it claims to be from, not just that it decrypted successfully.

Key rotation ("epochs"): an admin can force a new key to be derived (e.g. after removing a bad actor), or the room can auto-rotate after a configurable number of messages. Old messages remain readable using the epoch they were encrypted under; new messages use the new epoch.

### Room & message expiry

Two independent expiry systems:

- **Room expiry** (`inactivityTtlMs` on the room doc) — how long the *entire room* persists after the last member leaves. Configured by the admin in Settings (Instant / 5 min / 1 hour / 24 hours / Never). Tracked client-side via presence listeners and enforced server-side by a scheduled Cloudflare Pages Function ([`functions/api/cleanup.js`](./functions/api/cleanup.js)) that sweeps for rooms whose `autoDeleteAt` has passed.
- **Message expiry** (`msgTtlMs` on the room doc) — optional per-message auto-vanish, independent of the room itself expiring.

### Large file transfer

Images and videos are encrypted client-side, then — since a single Firestore document is capped at ~1MB — split into ~600KB chunks, each written as its own message document tagged with a shared `groupId`. The receiving client reassembles chunks by `groupId` once all pieces have arrived, then decrypts. If a new member's initial history fetch happens to only pick up part of a large file's chunks (a real edge case with paginated history), a self-healing backfill directly queries the rest by `groupId` so the media doesn't just silently fail to render.

## Local development

There's no dev server with hot reload — the project is simple enough that you can iterate directly against the built output.

```bash
git clone https://github.com/MiutChat/MiutChat.git
cd MiutChat
npm install
node build.js
```

This produces a `dist/` folder. Serve it with any static file server, e.g.:

```bash
npx serve dist
```

You'll need your own Firebase project (Firestore) to actually connect to a backend — this repo doesn't include Firebase credentials. Wire up your project's config in wherever `app.js` initializes Firebase, and set up Firestore Security Rules (see the comment block above the feedback-collection code in `app.js` for one example of the rule shape this app expects; other collections need similar rules — there's no `firestore.rules` file committed to this repo, rules are managed directly in the Firebase console).

Local builds never touch the version number — see [Versioning](#versioning) below.

## Deployment

The project deploys to [Cloudflare Pages](https://pages.cloudflare.com/). `wrangler.toml` defines the Pages project config, KV namespaces (used for rate limiting), and environment variables.

Whatever your deploy path — Cloudflare's Git integration running `node build.js` as the configured build command, or building locally/in CI and running `wrangler pages deploy dist` — make sure **`node build.js` is the step that actually produces what gets deployed**. Skipping it (e.g. deploying a stale `dist/` folder) means none of the build-time work (minification, version stamping, SRI hashes) happens.

## Versioning

The app version is a single source of truth: the `version` field in `package.json`. Every other place a version appears — `app.js`, `sw.js`, `index.html`'s meta tag, `manifest.json`, `wrangler.toml`, `functions/api/health.js`, and the footer of the marketing pages — is stamped in at build time by `build.js` reading through [`version.js`](./version.js). None of those are meant to be hand-edited.

**Bump scheme** (a deliberate product decision, not strict semver): the patch number increments normally and caps at `25`; the next bump after that rolls into the minor version instead of continuing past 25:

```
1.0.24 → 1.0.25 → 1.1.0 → 1.1.1 → ...
```

**When it bumps, and where:** automatically, on every push to `main`, via the GitHub Action at [`.github/workflows/bump-version.yml`](./.github/workflows/bump-version.yml). That workflow is the actual source of the bump — it runs `node version.js patch` and **commits the result back to the repository**.

This lives in a GitHub Action rather than in `build.js` deliberately. An earlier version of this project tried bumping the version inside `build.js` during the Cloudflare Pages build itself — that doesn't work, because Cloudflare (like most CI) clones the repository fresh, and shallow, for every single build. Any change `build.js` made to `package.json` during that build only ever existed inside that one throwaway container; it never made it back into the actual GitHub repo, so the next push started from the exact same committed version and computed the exact same "next" value — the version looked permanently stuck one bump behind, no matter how many times you deployed. Bumping via a GitHub Action instead means the new version is genuinely committed to git history *before* anything ever clones the repo to build or deploy it, which is the only way this can actually persist across separate deploys.

`build.js` itself never bumps anything — it only reads whatever's currently in `package.json` and stamps that value everywhere.

**Setup required for this to work:** the workflow needs permission to push commits back to the repo. In your repository's settings: **Settings → Actions → General → Workflow permissions**, select **"Read and write permissions"**. Without this, the Action will fail to push and the version won't advance.

**Manual bumps** (e.g. to deliberately jump to a new minor/major before a release):

```bash
node version.js patch   # explicit patch bump (same as an automatic one)
node version.js minor   # 1.4.9  → 1.5.0
node version.js major   # 1.5.0  → 2.0.0
```

Commit and push the result like any other change — the next automatic bump picks up from wherever this left off.

## Security model

MiutChat is designed so that the operator cannot read message content — encryption keys are derived and used entirely client-side. That said:

- This is **not audited cryptography** in the sense of a formal third-party security audit. Treat it accordingly for anything genuinely high-stakes.
- The room code itself is effectively the shared secret; anyone who has it can join (or, if the Approval Gate is off, immediately read). Share codes only with people you trust.
- Anti-screenshot measures are a deterrent, not a technical guarantee — screen capture can never be fully prevented in a browser.
- If you find a genuine security issue, please see [`SECURITY.md`](./SECURITY.md) / [`security.txt`](./security.txt) for how to report it responsibly rather than opening a public issue.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the coding style this project follows, how the build/versioning pipeline works, and the PR process.

## License

Treat the code as all-rights-reserved by default — open an issue if you'd like to use it elsewhere and want to check in first.
