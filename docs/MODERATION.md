# MiutChat moderation: how it runs without anyone operating it

Nothing here needs a human. No one reads messages, reviews reports or answers email.

## In the browser (sender and receiver both run it)
- `src/app/lazy/moderation.js` checks text on send, on edit and on receive, and files on send and on receive.
- Bad words become stars (`****`). Explicit threats, hate slurs, sexualised-minor content, illegal-sale offers and executable files are blocked.
- Word lists: `config/moderation/lists/*.txt` (LDNOOBW, CC BY 4.0) plus `config/moderation/curated.json`. Regenerate with `node scripts/build-moderation-data.js`, then `npm test`.

## Strikes and cooldown (Cloudflare KV, binding `MIUT_RL`)
- Three blocked attempts in 10 minutes start a cooldown of 60 s, then 5, 15 and 30 minutes on repeats (the level resets after an hour).
- Keys are `st:`, `cd:` and `lv:` plus a pseudonymous network token. They expire on their own. The browser also keeps `miut_safety` in local storage so a refresh does not reset the pause.

## Reports (KV, `functions/api/report.js`)
- A report carries only the hashed room id, the message id, a category and a hashed reporter id. No message text is ever sent.
- A message is hidden for everyone automatically once 3 distinct members (from at least 2 network tokens) report it, or 2 members for child-safety, intimate-image or threat reports.
- Records expire after 7 days.

## Privacy of the infrastructure
- Room codes never reach the server: Firestore documents are keyed by `r` + base64url(SHA-256("miut-room-doc-v1" + 0x00 + code)), the registry sees only its own hash, and invite links put the code after `#`.
- `functions/_lib/ip-token.js` is the only place a raw IP is read. It produces an HMAC with a random daily salt stored in KV for 36 hours. Rate limits, bans (6 h) and strikes use only that token.
- Analytics: the browser sends none, and `/api/analytics` discards writes.
