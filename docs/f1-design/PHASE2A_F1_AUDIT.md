# F1 Audit — Approval-first server enforcement (read-only)

**Commit reviewed:** `88ef10bc1054367df51be9e6c11a073f297b6538` (verified: repo HEAD,
`git log --oneline -1`, 2026-11-13 ~21:00 +06). G1+G2 deployment is on HOLD;
this audit touched nothing in that release or in production.

**Reproductions:** `F1_REPRO.mjs` (same directory) — 9 stub tests, 9/9 pass on
88ef10b, local only. Regenerate the worker stub with the repo's sed
(`sed '1s/.*/...EmailMessage stub.../' worker.js > worker.mjs`) and run
`node --test F1_REPRO.mjs` from the directory holding `worker.mjs`.

**Verdict in one line:** approval-first is a UI convention, not a server
guarantee. Every route that writes `ext:movies` is gated only by the admin
password — none of them checks the approval queue, and the admin UI calls
none of the direct routes, so the bypass is invisible in normal use.

## A. Findings

### F1-1 (High, CONFIRMED) — POST /api/admin/external publishes directly, no queue
- **Route:** `POST /api/admin/external`, worker.js:2622–2658. Auth: `checkPw`
  only (worker.js:2623; `checkPw` at 215–218 compares `?pw=` to the stored
  admin password, `adminPw` at 206–214). No queue read, no `pendingId`,
  no `findDuplicate` call, no approval check.
- **Flow:** body (`video_url`/`sources`, `tmdb_id`, `title`) → URL cleaned
  (`cleanSrcUrl`, `toDirectUrlSrv`) → optional TMDB enrichment → inside
  `_withAdminLock`, strict read of `ext:movies`, insert new entry, save
  (2651). The entry is written **without the `unlisted` flag**, so
  `listMovies` (1930, rule at 1961–1967: include unless `unlisted`) lists
  it immediately in `/api/movies` (2568–2570), the home page, the sitemap,
  and the Android app feed.
- **Reproduction F1-A:** empty catalogue + empty queue → POST → 200 →
  catalogue has 1 entry, `unlisted` unset, `pendingId` absent, queue still
  empty, entry present in the public `/api/movies` feed. **Identical public
  visibility to an approved entry** — the only difference is the queue and
  the checks were skipped.
- **Precondition:** knowledge of the admin password (same credential the
  admin UI itself uses; it travels as `?pw=` on every admin call). No
  session, role, or second factor is involved. N4 confirms a wrong password
  is 403 on every bypass route — this is an **authenticated** bypass, not
  an unauthenticated exploit.
- **Impact:** any admin-authenticated caller (the admin himself, a script,
  an old bookmark, a `curl` one-liner, any tool that learned the password)
  can publish any URL into the live catalogue without review, and the
  queue never sees it. The approval policy provides no server-side
  guarantee; a single leaked or shared password publishes directly.
- **Callers:** NONE in the current admin UI (ADMIN_PAGE calls only the
  pending routes — see F1-5). The route is orphaned but live.

### F1-2 (High, CONFIRMED) — POST /api/admin/extpublish lists any entry, approved or not
- **Route:** `POST /api/admin/extpublish`, worker.js:2674–2685. Auth:
  `checkPw` only. Reads `ext:movies` (swallowing getter), 404s if the id
  is missing, sets `extObj[id].unlisted = !!unlisted`, saves (2681).
- **No approval-state check:** the handler never reads `pendingId`, the
  queue, or any status. It flips visibility on **any** entry — including
  one that was never approved, never queued, or created before the policy
  existed.
- **Reproduction F1-B:** an unlisted entry with no `pendingId` is absent
  from `/api/movies` → one extpublish call (`unlisted: false`) → 200 →
  the entry is in the public feed, still with no `pendingId`. The reverse
  also works: a listed entry can be hidden the same way, with no review.
- **Impact:** the "unlisted" state is not a holding pen — it is a
  one-call-away publication. Any entry parked as unlisted (e.g. the
  pre-policy WALL·E test entry, or a direct-POST entry later unlisted)
  can be made public without approval. The safe direction (hiding) and the
  dangerous direction (listing) share one unchecked toggle.

### F1-3 (Medium, CONFIRMED) — post-approval content edits without re-approval
- **Routes:** `POST /api/admin/extposter` (worker.js:2660–2672, sets
  `poster`, save 2667) and `POST /api/admin/ytinfo` (2686–2707, sets
  `title` + `poster` from a YouTube oEmbed lookup, save 2703). Both
  `checkPw`-only; both operate on **any** ext entry by id with no
  `pendingId`/queue/status check.
- **Reproduction F1-C:** an approved entry (with `pendingId`) gets its
  poster rewritten by extposter and its title + poster rewritten by
  ytinfo; the queue is never involved and the renamed entry stays public.
- **Impact:** the title a reviewer approved can be silently replaced
  afterwards (ytinfo takes the title from an arbitrary YouTube video), and
  the poster can be swapped. The approval was for a title + sources; the
  server does not bind the live entry to what was approved. Risk is
  bounded (admin-only, cosmetic fields only — URL/sources cannot be
  changed in place), but it is a genuine post-approval modification path.
- **Note:** the queue-side edit route (`POST /api/admin/pending/sources`,
  2873–2901) is correctly gated — it rejects non-pending candidates and
  never touches `ext:movies`. The gap is only on the live side.

### F1-4 (Medium, CONFIRMED) — direct publish skips duplicate detection
- **Route:** same as F1-1. The pending-add and approve routes both call
  `findDuplicate` (worker.js:760–779: TMDB id first, then normalized
  title + year) against the live catalogue and the queue, returning 409
  unless `force: true`. `POST /api/admin/external` never calls it.
- **Reproduction F1-E:** a live entry (TMDB 1726, "Iron Man") exists →
  direct POST of the same TMDB/title → 200 (not 409) → catalogue now has
  TWO public entries for the same title. The queue would have refused
  this at 409.
- **Impact:** duplicate catalogue entries, confused Continue Watching /
  progress keys, and a degraded catalogue. The dup guard the queue
  enforces does not exist on the direct path.

### F1-5 (Medium, CONFIRMED) — catalogue removal outside the workflow
- **Route:** `DELETE /api/admin/external`, worker.js:2708–2725. `checkPw`
  only; deletes any ext entry by id (save 2715). No queue involvement.
- **Reproduction F1-D:** an approved live entry → DELETE → 200 → catalogue
  empty, public feed empty, queue untouched.
- **Impact:** an approved entry can be removed without any workflow step.
  This is the safe direction (it reduces exposure, it never publishes),
  and the approval workflow has no "remove from catalogue" step, so
  deletion has to live somewhere. Classed as a confirmed bypass of the
  workflow's completeness, but **not** a publication risk.

### F1-6 — Callers: the admin UI uses only the queue (CONFIRMED)
- **ADMIN_PAGE** (`api()` helper at worker.js:949) calls, for catalogue
  work: `/api/admin/pending` GET (965) and POST (1006), `/pending/approve`
  (1013, 1016 incl. the force-confirm), `/pending/reject` (1021),
  `/pending/delete` (1026), `/pending/sources` (1031), plus discovery,
  stats, presence, R2, and password routes. **Zero calls** to
  `/api/admin/external`, `/api/admin/extpublish`, `/api/admin/extposter`,
  or `/api/admin/ytinfo` anywhere in the page.
- **Other callers:** none found. `saveExtMovies` has exactly 6 call sites
  (2651, 2667, 2681, 2703, 2715, 2813 — the four legacy routes, DELETE,
  and approve). `runDiscovery` writes only to `ext:pending` (savePending
  at 2150; its header comment states it never touches `ext:movies`).
  No server-side code calls the legacy routes. The Android app reads
  `/api/movies`, `/api/progress`, `/api/play-token`, `/api/version-check`
  — it never calls admin endpoints.
- **Conclusion:** the legacy routes are orphaned from every legitimate
  workflow in the current code. They survive only as live HTTP endpoints.

### Boundary notes (NOT F1 findings — recorded so the policy scope is explicit)
- **Bucket ingestion is outside the approval policy.** `PUT
  /api/admin/upload` (worker.js:2475–2484) writes an R2 object; a video
  file placed in the media bucket appears in `listMovies`' bucket side
  without any approval. That is the pre-queue hosted-ingestion path, not
  an external entry, and it predates the approval-first decision. If the
  policy is ever meant to cover hosted uploads too, that is a separate
  design decision — it is not part of this F1 finding.
- **Unlisted entries are directly playable.** `/view/ext/<id>`
  (worker.js:3185–3191) serves any ext entry by id with no `unlisted`
  check and no auth. `unlisted` controls catalogue listing only, never
  access. An unlisted entry's URL is effectively public to anyone who
  knows (or guesses) the id. This is by design (embed verification), but
  it means "unlisted" is not a privacy boundary.
- **Theoretical only — no evidence:** no unauthenticated path to any of
  these routes was found (all 6 save sites are `checkPw`-gated; N4
  confirms 403). No SSRF via ytinfo (the oEmbed fetch targets a fixed
  YouTube host). No alternate internal writer to `ext:movies` exists.

## B. Reproduction

File `F1_REPRO.mjs` (same directory as this report). 9 tests, 9/9 pass on
88ef10b. Harness: in-memory KV + DO-state stubs, admin password `pw123`,
real `listMovies()` (empty bucket listing via a stubbed `s3fetch` + ext
entries from the real KV read), public `/api/movies` read for visibility.

| Test | Before | Call | After (actual) | Expected if approval were enforced |
|---|---|---|---|---|
| F1-A direct publish | catalogue 0, queue 0 | POST /api/admin/external | 200; catalogue 1, listed, no pendingId, queue 0, public feed 1 | refused, or queued — not listed |
| F1-B extpublish | unlisted entry, public feed 0 | POST /api/admin/extpublish {unlisted:false} | 200; public feed 1, still no pendingId | refused (never approved) |
| F1-C post-approval edit | approved entry, title "Approved Film" | extposter + ytinfo | 200; poster + title rewritten, queue 0, still public | refused or re-review |
| F1-D removal | approved entry live | DELETE /api/admin/external?id=… | 200; catalogue 0, public feed 0 | (removal is safe-direction; no workflow step exists) |
| F1-E duplicate | live entry TMDB 1726 | direct POST same TMDB/title | 200; catalogue 2 for one title, both public | 409 duplicate |
| N1 workflow | queue 0, catalogue 0 | pending add → approve | add 200 (queued, not public) → approve 200 (catalogue 1, pendingId set, queue 0, public 1) | same — the intended flow works |
| N2 reject blocks | candidate pending | reject → approve | reject 200 → approve 400, catalogue 0 | same |
| N3 no sources | candidate, no sources | approve | 400, catalogue 0 | same |
| N4 auth | — | all 5 bypass routes, wrong pw | 403 on every route, catalogue 0 | same |

## C. Remediation proposal (smallest safe server-enforced fix)

**Recommended: convert, don't just delete.** The legacy routes are orphaned
from the UI, but an unknown out-of-band caller (a script, a bookmarked
curl) may still use them. Conversion preserves the endpoint and its
response contract as far as possible while making the queue the only path
to the live catalogue.

1. **`POST /api/admin/external` → pending-submission alias.** Inside the
   existing lock, run the pending-add logic instead of the direct insert:
   same URL validation, same TMDB enrichment, same `findDuplicate` check
   (409 unless `force`), then write to `ext:pending` with status
   `"pending"` and return the pending id. The entry is queued for review,
   never listed. One shared helper for add + alias keeps the two paths
   from drifting. *Alternative (acceptable, harder break):* remove the
   route entirely (404). Choose conversion unless he prefers the hard break.
2. **`POST /api/admin/extpublish` → listing requires approval.**
   Unlisting (`unlisted: true`) stays allowed on any entry — hiding is
   the safe direction and needs no review. Listing (`unlisted: false`)
   is allowed only when the entry carries a `pendingId` (approved through
   the queue). An entry without one must be re-approved via the queue
   first (add as candidate → approve). Pre-policy entries already listed
   are unaffected — the rule only gates the flip.
3. **`POST /api/admin/extposter` + `POST /api/admin/ytinfo` → approved
   entries only.** Refuse (404 or 400) when the target entry has no
   `pendingId`. An unapproved entry that needs a poster/title fix goes
   through the queue first. This closes the post-approval rewrite path
   for never-approved entries while keeping metadata fixes available on
   approved ones.
4. **`DELETE /api/admin/external` → unchanged.** Removal is the safe
   direction and the workflow has no removal step. Document it as the
   intentional catalogue-removal path.
5. **Pending routes unchanged.** They are already the enforcement point;
   no changes needed there.

**Compatibility.**
- Existing entries (11 live: 10 listed + 1 unlisted) are untouched — the
  fix changes how entries *get into* `ext:movies` and how visibility
  flips, not the stored data. No KV migration.
- Android app: reads `/api/movies` only — playback, Continue Watching,
  and the version gate are unaffected.
- Admin UI: calls only pending routes — unaffected. The approve/reject/
  delete/sources flows keep working exactly as they do today.
- Out-of-band callers of the direct routes: under conversion they get a
  200 + a pending id instead of a live id (the entry is queued, not
  published); under removal they get a 404. Either way the catalogue no
  longer gains entries outside the queue.
- G1/G2 interaction: the converted route must keep the strict-read +
  deterministic-500 pattern from 88ef10b (the R25–R28 tests cover the
  external POST/DELETE paths and will need updating for the converted
  route — see §D).

## D. Regression plan

New tests (same stub harness as `F1_REPRO.mjs`, to be added to
`.phase2a-test/test_pending_sources.mjs` when implementation is authorized):

- **R33 — direct publish cannot bypass approval.** POST
  `/api/admin/external` with a valid body → catalogue unchanged, queue
  gains exactly one candidate with status `"pending"` (or 404 if the
  removal alternative is chosen). The candidate must NOT appear in
  `/api/movies`.
- **R34 — extpublish refuses to list an unapproved entry.** Unlisted
  entry without `pendingId` → listing refused, catalogue + public feed
  unchanged. Same call on an entry *with* `pendingId` → allowed, entry
  becomes public.
- **R35 — extpublish still allows hiding.** Any entry, `unlisted: true`
  → 200, entry leaves the public feed.
- **R36 — extposter/ytinfo refuse unapproved entries.** Entry without
  `pendingId` → refused, stored title/poster byte-identical. Entry with
  `pendingId` → allowed, fields updated.
- **R37 — only approved candidates become public.** Full flow: pending
  add → approve → entry public with `pendingId`; plus a direct-publish
  attempt for the same title that must not create a second public entry.
- **Auth / duplicate / failure paths.** Wrong password → 403 on all four
  legacy routes (N4, already passing). Duplicate via the converted route
  → 409. Simulated KV read failure during the converted write → 500,
  queue + catalogue byte-identical (the G1 pattern, same assertions as
  R25–R28).
- **G1/G2 unaffected.** The full existing suite (47 tests) must still
  pass. Note: R28 covers the external POST failure path — it will need
  to be re-targeted at the converted pending-write path (same assertions,
  different route). R25–R27 and R29–R32 are unaffected by this change.

**Nothing in this report is implemented.** No code was edited, no commit,
push, or deployment was made for F1. Awaiting review and separate
authorization before implementing the §C proposal.
