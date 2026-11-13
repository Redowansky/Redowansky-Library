# Phase 2a — Security & Production-Readiness Audit (read-only)
**Date:** 2026-11-13 ~15:20 +06 · **Code under review:** `worker.js` at commit `4f5ab64`
(39/39 tests, CI green run 43397343148)
**Status:** READ-ONLY AUDIT — nothing modified, no deploy, no secrets touched,
no production data written.

**Framing correction:** 4f5ab64 is already deployed — it went live ~15:15 +06 on
his "refix and deploy" go-ahead (deployed sha256 `e965756c…` verified MATCH).
This audit therefore covers **live production code**, not a pre-deployment
candidate. The findings below apply to what is running now.

## Method and evidence standard
- **Code read:** full route inventory of worker.js (3,400+ lines at 4f5ab64),
  mechanical gating check (38 admin/internal branches), token/stream code,
  OAuth, cron, fetch/redirect inventory.
- **Local demonstration (stub KV/R2/fetch, no production writes):** a throwaway
  harness (`/tmp/audit-demo/demo.mjs` + `expiry.mjs`) importing TunnelDO from
  the 4f5ab64 worker.js. Results are labelled LOCAL.
- **Live production checks (read-only GETs + API reads, no writes):**
  deployed-sha MATCH, home 200, /api/movies 10, /admin 200, version gate
  (app UA: v41 ok / v40 426), sitemap 0 pending titles, secret NAMES only,
  R2 main-bucket listing vs catalogue, /api/play-token mint for nonexistent
  keys. Results are labelled LIVE.
- **Not demonstrated = not "confirmed".** Anything I could only reason about
  is marked suspected/hardening.

## F1 — HIGH — Legacy direct-publish route bypasses approval-first publishing
- **Where:** `POST /api/admin/external` (worker.js:2603–2634), `POST
  /api/admin/extpublish` (2650–2660), `DELETE /api/admin/external`
  (2684–2693), `POST /api/admin/extposter` (2636–2647), `POST
  /api/admin/ytinfo` (2662–2682). All six `saveExtMovies` call sites.
- **Confirmed (code + LOCAL demo).** `POST /api/admin/external` with the admin
  password returns 200 and writes an entry **directly into `ext:movies` with
  no `unlisted` flag** — i.e. listed immediately. The queue (`ext:pending`) is
  untouched (0 entries) and the public `/api/movies` lists the new title at
  once. No duplicate check (unlike approve, which 409s), no source-authorization
  check (URL validation is syntactic only: `cleanSrcUrl` blocks javascript:/
  data:/etc. but any http(s) host is accepted). `extpublish` flips any entry's
  `unlisted` flag — it can publish the unlisted WALL·E test entry (or any
  unlisted entry) with one call, again with no queue involvement.
- **UI usage:** NONE. The admin page no longer calls any of these — the
  strings occur only as the route definitions (plus one comment at 2734).
  The Movies & Songs section removal (f85bd96) orphaned them; they remain
  live and reachable by any direct HTTP caller holding the admin password
  (curl, an old bookmarked admin page, a script).
- **Impact:** approval-first publishing is currently enforced by convention
  (the UI) rather than by the server. Anyone holding the admin password can
  publish arbitrary content to the public catalogue and the app feed,
  bypassing the queue, the duplicate check, and the sources editor.
- **Smallest safe remediation:** (a) make `POST /api/admin/external` create a
  PENDING candidate in `ext:pending` (same shape/validation as the manual
  add form) instead of writing `ext:movies`; (b) make `extpublish` refuse
  entries that did not come from the queue (no `pendingId`); (c) keep
  `extposter`/`ytinfo` (metadata-only edits of existing entries) and keep
  DELETE for admin cleanup. Before removing anything, confirm no external
  script uses these routes (the VM uploader scripts use `/api/admin/r2/*`,
  not these).
- **Regression tests:** R16 — external POST creates a pending candidate, not a
  live entry; `/api/movies` does not list it. R17 — extpublish on a
  non-queue entry is refused. R18 — the approve flow still publishes
  (already covered by existing tests; keep them green).

## F2 — MEDIUM (design) — /api/play-token mints for any key; /stream serves any object in MEDIA
- **Where:** `GET /api/play-token` (worker.js:2491–2499), `/stream/<key>`
  (2502–2540), `mintStreamToken`/`verifyStreamToken` (41–76).
- **Confirmed (code + LOCAL demo + LIVE mint).** `/api/play-token` takes
  `?key=` with **no authentication, no catalogue check, no existence check**
  (only non-empty + no `..` segment). `/stream` checks only the token
  (HMAC, key-bound, expiry) — **no catalogue check and no app-version gate**.
  LOCAL demo: mint for a non-catalogue key → 200; `/stream` serves that
  object → 200 with bytes; mint for a nonexistent key → 200 (token valid,
  object missing → 404 at serve time). LIVE: mint for
  `movies/english/does-not-exist-xyz.mp4` and for `incoming/raw-test.mp4`
  both returned 200 with a token.
- **Impact TODAY: LOW.** The MAIN bucket holds exactly 5 objects, and all 5
  are public catalogue movies (verified LIVE via the R2 list API, diffed
  against `ext:movies`: **0 non-catalogue objects**). There is currently no
  private, unlisted, or deleted media in the main bucket to steal — the
  token gate today provides NO access control, only the death of direct
  public R2 URLs. The code comment claiming a token "can only be minted by
  a current-version app (or the site itself)" is **inaccurate**: any browser
  can mint (old app builds are refused only when they identify as the app).
- **Forward risk: MEDIUM.** If a raw, unlisted, or private file ever lands in
  the main bucket (a processing leftover, an `incoming/` raw, a test file),
  it becomes streamable by anyone who guesses its key — and keys are
  predictable (`movies/<lang>/<title>-<year>-<lang>.mp4`). Separately, the
  acct2 bucket's public r2.dev is ON, so acct2 catalogue entries are
  directly downloadable without any token (public catalogue by design).
- **Smallest safe remediation:** add a catalogue check to `/api/play-token`
  — mint only if the key is referenced by a listed `ext:movies` entry or a
  bucket movie from `listMovies()` — plus a `MEDIA.head` existence check
  (404 for unknown keys). Keep the 24h TTL. The site player
  (`streamUrlFor`) and the app both mint only for catalogue keys, so this
  does not break playback or downloads (`/go/` → `/stream` also uses
  catalogue keys). Optionally add the same catalogue check inside `/stream`
  as defense-in-depth.
- **Regression tests:** R19 — mint for a non-catalogue key → 404; mint for a
  catalogue key → 200. R20 — mint for a deleted key → 404. Keep the
  existing token tests (tampered/expired/cross-key → 426).

## F3 — MEDIUM — /api/request is unauthenticated and writes KV + sends email on every call
- **Where:** `POST /api/request` (worker.js, Ask for a Movie).
- **Confirmed by code.** No auth, no captcha, no rate limit. Every POST
  writes one KV key (`requests:<ts>:<rand>`) and sends one email via the
  MAILER binding. (Header injection is handled: the subject strips
  `\r\n`; the user email goes in the body, not headers.)
- **Impact:** an attacker can flood the endpoint and exhaust the shared KV
  write quota (**1,000 writes/day on the free tier**, shared by the whole
  account), which would break discovery runs, approvals, and queue writes —
  and spam his mailbox at the same time. This is the easiest unauthenticated
  write path in the worker.
- **Smallest safe remediation:** per-IP rate limit inside the worker (an
  in-DO counter with a 1-hour window, 429 beyond it; e.g. 5 requests/IP/hour
  for `/api/request`). Cloudflare's own rate limiting is a paid feature; do
  it in code. Optionally add Turnstile (already used on the download gate)
  or require sign-in.
- **Regression tests:** R21 — 6 rapid requests from one IP → the 6th is 429;
  a different IP is unaffected. R22 — a legitimate single request still
  writes + mails (existing behaviour preserved).

## F4 — LOW — Admin password travels as a URL query parameter (?pw=) on every admin request
- **Where:** `checkPw` (worker.js:215–218) — `url.searchParams.get("pw") ===
  pw`; the admin page appends `?pw=` to every admin API call (GET and POST).
- **Confirmed by code.** Impact: the master admin credential is recorded in
  Cloudflare logs, browser history, and any referrer header, and is visible
  in the address bar. Requires log/history access to exploit; the password
  is a single shared credential.
- **Smallest safe remediation:** send the password in an `Authorization`
  header (or POST body) instead of the query string; keep `?pw=` as a
  fallback for one release, then remove it.
- **Regression tests:** R23 — admin call with the Authorization header
  succeeds; `?pw=` still works during the transition.

## F5 — LOW — No rate limiting anywhere in the worker
- Cross-cutting. No rate-limit code exists (grep for rate/429 finds only CSS
  and comments). F3 carries the concrete exploitable path; the other
  unauthenticated endpoints (`/api/play-token` minting, `/api/presence`,
  `/api/gate/verify`, `/api/movies`) are unthrottled but cheap (minting and
  presence write no KV). Hardening: per-IP in-DO counters on the
  unauthenticated write paths. Standalone severity Low.

## F6 — LOW (theoretical) — Plain `===` comparisons for secrets and HMACs
- `checkPw` (pw), `r2ok` (upload key), `verifyStreamToken` (signature),
  `/go/` and `/px/` (signatures). Confirmed by code; exploitability is
  theoretical (remote timing attacks against a Workers endpoint are
  impractical; no evidence of exploitation). Hardening: constant-time
  compare. Low.

## F7 — LOW — The R2 upload key can overwrite ANY object in MEDIA (no key-prefix restriction)
- **Where:** `r2ok` (worker.js:3012) + `POST /api/admin/r2/init` — accepts
  any `body.key` (only non-empty is checked) and starts a multipart upload
  for it.
- **Confirmed by code.** Impact: anyone holding the upload key (a bearer
  secret used by the VM uploader) can overwrite catalogue movies — no
  delete route exists, but overwrite breaks playback. The key carries the
  same trust as the admin password, so this is a scope note, not an active
  vulnerability.
- **Smallest safe remediation:** restrict `init` to the `incoming/` prefix
  (the uploader's actual use) and require the admin password for keys
  outside it.
- **Regression tests:** R24 — init with a `movies/...` key + upload-key only
  → 403; with the admin password → 200.

## F8 — LOW — Admin password minimum length is 4 characters
- `POST /api/admin/password`: `if (n.length < 4) return 400`. Confirmed.
  The admin password is a single shared credential; 4 characters is a weak
  floor. Hardening: raise the minimum to 12 for future changes (do not
  force a change of the current password). Low.

## F9 — LOW — Outer catch-all returns internal error messages to any caller
- `export default.fetch` catch (worker.js:3409): `json({ error:
  String(e.message) }, 500)`. Confirmed. Error messages from DO/S3 failures
  can leak internal details (hostnames, binding names) to unauthenticated
  callers; in practice the messages are generic. Remediation: return a
  generic "internal error" publicly and log the detail. Regression test:
  force a DO error → the public response contains no internal strings.

## F10 — LOW (cosmetic) — Presence can be faked (no auth)
- `POST /api/presence`: no auth, but the id format is validated
  (`[A-Za-z0-9_-]{8,64}`), title ≤200, storage is in-memory only with a 90s
  TTL and self-pruning. Impact: fake "users online" counts on the admin
  dashboard. No data impact. Remediation: none required; optionally require
  a session cookie.

## Verified OK (no finding)
- **Admin gating:** all **38** admin/internal route branches are
  authenticated — 33 via `checkPw`, 5 via `r2ok()` (admin pw OR
  `x-upload-key` matching `UPLOAD_KEY`). Mechanical check on 4f5ab64.
- **OAuth (Google + Amazon):** state is a 24-byte random value stored in KV
  with a 600s TTL (Google) / PKCE code_verifier (Amazon), validated
  single-use at the callback; sessions are 48-hex-char random sids in KV
  with a 30-day TTL; cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`.
- **/api/progress:** session cookie OR a verified Google ID token; app-version
  gated; per-user keys (`progress:<sub>:<movieId>`).
- **Cron:** fail-closed on `x-cron-secret` (2871); overlap flag; failure
  recovery per rounds 4–7; schedule `0 2 * * *` (verified in the earlier
  audit; deploys do not touch schedules).
- **SSRF:** server `fetch()` goes only to fixed hosts
  (api.themoviedb.org, oauth2.googleapis.com, api.amazon.com,
  youtube.com/oembed with an admin-extracted video id,
  challenges.cloudflare.com). No user-controlled URL is fetched.
- **Redirects:** all absolute (`url.origin + path`) or fixed targets.
- **Embeds:** unsandboxed iframes for Lulustream by design (Lulustream
  refuses sandboxed iframes) — documented, his constraint.
- **/go/ signed links:** HMAC + expiry (410 on expired). **/px/ proxy:**
  catalog-bound.
- **main-v35:** unchanged (`idFromName("main-v35")`, worker.js:3419, 3430).
- **KV recovery:** strict reads (rounds 5/7) + the config-race fix (round 8).
- **TMDB key GET** returns only `{has: bool}`, never the key.
- **Token crypto (LOCAL demo):** HMAC-SHA256, key-bound, TTL exactly 86400s,
  expired → 426, tampered → 426, cross-key → 426, no token → 426. Path
  traversal is a non-issue for R2 (flat key namespace; the URL parser
  normalizes `..` before the handler; double-encoding yields a literal key,
  404/426 — not traversal).
- **Public surfaces:** `/api/movies` = 10 live entries, 0 pending titles;
  sitemap 0 pending titles (LIVE).
- **Secrets (names only, LIVE):** ADMIN_PW, DISCOVERY_CRON_SECRET,
  GOOGLE_CLIENT_SECRET, PLAY_TOKEN_SECRET, S3D_HOST, S3_ACCESS_KEY,
  S3_SECRET_KEY, TMDB_KEY, TURNSTILE_SECRET, UPLOAD_KEY — all present.
  AMAZON_CLIENT_SECRET still missing (known pending LWA step).

## Repo/CI vs production verification
- **Repo/CI (mocked):** 39/39 unit tests pass under stub KV/fetch/R2,
  template + cron checks pass, CI run 43397343148 green. These verify
  LOGIC under stubs — they cannot prove live R2 contents, live token
  behaviour, live admin flows, or live cron runs.
- **Production (live, read-only, this audit):** deployed sha256 `e965756c…`
  == 4f5ab64 blob (MATCH); home 200; `/api/movies` 10; `/admin` 200;
  version gate v41 ok / v40 426 (app UA); R2 main bucket = 5 objects, all
  catalogue; `/api/play-token` live mint for nonexistent keys; sitemap 0
  pending titles; secret names present.
- **Not covered by either:** live admin flows requiring the admin password
  (not known to Pepper, not requested in this audit — the stub demos cover
  the logic); a live cron run (first due Sun Nov 15 02:00 UTC); signed-in
  progress sync on the new code (needs his Google session).

## Checks NOT performed (read-only boundaries)
- Live `POST /api/admin/external` (would write production data — forbidden).
- Live `/stream` byte fetch for a non-catalogue object (none exists in the
  main bucket; the stub demo covers the serve path).
- Live admin flows needing the admin password.

## Recommended order (for his approval)
1. **F1** (High) — close the direct-publish bypass; approval-first must be
   enforced by the server, not the UI.
2. **F2** (Medium) — catalogue check on `/api/play-token` (cheap, no
   behaviour change for legitimate playback).
3. **F3** (Medium) — rate-limit `/api/request` (protects the shared KV
   write quota).
4. **F4 + F7 + F8 + F9** (Low) — password out of the query string, upload-key
   prefix restriction, password-length floor, generic public errors.
5. **F5/F6/F10** — hardening backlog; no action required now.
