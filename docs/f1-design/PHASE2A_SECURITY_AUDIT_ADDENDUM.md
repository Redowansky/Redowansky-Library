# Phase 2a — Security Audit, Addendum (read-only)
**Date:** 2026-11-13 ~15:30 +06 · **Code under review:** `worker.js` at commit `4f5ab64`
(live production baseline, deployed ~15:15, sha256 `e965756c…` verified MATCH)
**Status:** READ-ONLY AUDIT — nothing modified, no deploy, no production writes,
no production media retrieved, no intrusive probing. All demonstrations use a
local stub harness (`/tmp/audit-demo2/demo.mjs`) importing TunnelDO from the
4f5ab64 worker.js with stub KV/R2/fetch and fake bytes.

This addendum continues `PHASE2A_SECURITY_AUDIT.md` (findings F1–F10). It
answers the follow-up questions on playback-token authorization, R2 key
discoverability, and — per the explicit instruction — the discovery initial
state snapshot and non-strict reads.

## G1 — CRITICAL — Swallowing read-modify-write can WIPE the live catalogue or the approval queue
- **Where:** `getExtMovies` (worker.js:537–539), `getPending` (550–552),
  `getSeen` (641), `getDiscoveryState` (573–575) — all swallow KV errors and
  return a fallback (`{}` or defaults). The wipe-capable writers:
  `POST /api/admin/external` (2629–2631), `DELETE /api/admin/external`
  (2688–2690), `POST /api/admin/pending/approve` publish step (2776–2778),
  `POST /api/admin/pending` add (2727–2729).
- **Confirmed (code + LOCAL demo).** Each of these four paths reads the whole
  object via a swallowing getter, mutates it, and unconditionally saves it —
  with NO existence check on the read result. If the KV read throws
  (transient network/timeout/5xx), the getter returns `{}` and the save
  overwrites the real data with the partial object:
  - **D1 — approve:** publish-step `ext:movies` read fails → approve returns
    **200 `{"ok":true}`** while the catalogue is wiped from **11 entries to
    1**. The admin sees success; the site/app lose 10 titles.
  - **D2 — pending add:** save-step `ext:pending` read fails → add returns
    **200 `{"ok":true}`** while the queue is wiped from **45 candidates to
    1**.
  - **D3 — DELETE external:** `ext:movies` read fails → delete returns **200
    `{"ok":true}`** while the catalogue is wiped from **11 entries to 0
    (empty)**.
  - Second failure mode on the same paths: a failed `ext:movies` read also
    blinds the duplicate check (`listMovies` → `getExtMovies` → `{}`), so
    approve/add can publish a duplicate of a live entry.
- **Why this matters despite rounds 5/7/8:** the codebase already knows this
  exact rule — the comment above the strict readers (worker.js:578–581) says
  *"A fallback {} or defaults must never be treated as genuine data by
  recovery: saving them would erase the real seen-map or reset the real
  discovery configuration."* The rule was applied ONLY to the
  discovery/recovery paths. The four admin write paths above violate it.
  The admin lock does NOT help: the reads happen inside the lock, but the
  lock serializes writers — it cannot turn a failed read into real data.
- **Attack/trigger conditions:** no attacker needed. A single transient KV
  read failure during an admin approve/add/publish/delete is enough. KV is
  highly available, so the trigger is rare — but the impact is catastrophic
  and the success response (200) hides it: there is no signal that the wipe
  happened until someone notices the catalogue is empty. Recovery would need
  a KV backup (none exists) or re-creating the entries by hand.
- **Fail-safe paths (checked, NOT vulnerable):** `extposter`, `extpublish`,
  `ytinfo`, pending reject/delete/sources — each checks the entry/candidate
  exists in the read result first, so a failed read yields a 404 and no
  write. Safe by accident of the existence check, not by read discipline.
- **Smallest safe remediation:** extend the round-5 strict-read pattern to
  all admin writers — add `getExtMoviesStrict` (throw on KV failure) and use
  it (and the existing `getPendingStrict`) in the four wipe-capable paths;
  on a failed read, abort with a 500 and write nothing. Keep the lock. No
  behaviour change on the happy path.
- **Regression tests:** R25 — approve with a failing `ext:movies` read →
  500, catalogue byte-identical. R26 — pending add with a failing read →
  500, queue byte-identical. R27 — DELETE with a failing read → 500,
  catalogue intact. R28 — external POST with a failing read → 500,
  catalogue intact. (Each test fails on the current code — the demos above
  are the proof — and passes after the fix.)

## G2 — MEDIUM — Discovery dedupe-phase non-strict reads cause wasted runs and a misleading "ok"
- **Where:** `runDiscovery` dedupe phase (worker.js:2052–2053):
  `const seen = await getSeen(env); const pend = await getPending(env);`
  — swallowing reads that feed the `wanted` map and the in-run dedupe.
- **Confirmed (code + LOCAL demo D4).** If either read fails, the run treats
  every fetched title as unseen/not-queued and spends its detail budget
  (up to 30 calls) fetching details for titles it already knows — then the
  batch re-check (strict reads, 2120–2121) drops them as duplicates. Demo:
  control run (healthy reads) files 0 with dup=2; failing dedupe read files
  0 with dup=1 — same "ok" status, same empty queue, one wasted detail
  fetch. The run record says "ok" when the run was actually blind.
- **Impact:** wasted TMDB subrequests (counts toward the 50/invocation
  limit) and a misleading last-run record. NO data loss: the batch re-check
  is the safety net and it held in the demo (no duplicate filed, queue
  unchanged). This is the one discovery path where the non-strict read
  survives — the initial state snapshot itself is now safe (strict load at
  1984 + `finish()` merging onto a fresh read, round 8).
- **Smallest safe remediation:** use the strict readers in the dedupe phase
  too — a failed dedupe read fails the run (the existing failed-record path)
  instead of running blind. One-line change per read.
- **Regression tests:** R29 — dedupe-phase seen read fails → run status
  "failed", 0 filed, queue unchanged, lastRun records the failure.

## G3 — MEDIUM (structural) — Playback-token authorization: answers to the specific questions
- **Can an unauthenticated browser request a valid token for an arbitrary R2
  key? YES — confirmed LIVE in the previous audit** (mint for two
  nonexistent keys returned 200 with a token). No auth, no catalogue check,
  no existence check on `GET /api/play-token` (worker.js:2491–2499).
- **Does the app-version check protect the endpoint appropriately?** For old
  APP clients, yes: a `RedowanskyLibraryApp` UA with `X-App-Version` < 41
  gets 426 (verified in the stub harness). For browsers, there is no
  protection BY DESIGN: the site player is a browser and must mint tokens to
  play, and the endpoint cannot distinguish the site player from any other
  browser/script (no session/auth on the anonymous player). The version
  check is an app-update enforcement mechanism, not an access control — and
  it is trivially bypassable by any script that sets the UA + version
  headers (both client-controlled).
- **Can a caller access unlisted, deleted, private, or unauthorized media?**
  NOT currently — because none exists in the main bucket. Verified LIVE:
  the main bucket holds exactly 5 objects, all 5 public catalogue movies, 0
  non-catalogue objects. The only unlisted entry (WALL·E Lulustream test) is
  an embed, not an R2 object, so `/stream` cannot serve it. R2 deletes are
  immediate (a deleted object → 404 at `MEDIA.head`). There is no "private"
  concept in the main bucket: every object in it is streamable with a
  freely-minted token. The exposure is structural, not current: any future
  non-catalogue object in the main bucket (a processing leftover, an
  `incoming/` raw, a test file) would be streamable by anyone who guesses
  its key.
- **Are R2 keys discoverable? YES for catalogue keys, NO for non-catalogue
  keys.** Catalogue keys are public by design: `/api/movies` returns the
  full R2 URLs (keys visible), and view pages render
  `<video src="/stream/<key>?t=<token>">` (worker.js:1321) plus per-source
  stream URLs (1326) — so any visitor sees the key AND a valid 24h token in
  the page source. The token is a bearer credential: copyable, shareable,
  valid 24h. Non-catalogue keys are NOT listable: `GET /api/buckets` is
  public but returns only bucket NAMES, and there is no public object-listing
  route (`/api/admin/r2/incoming` is admin-gated). But keys follow a
  predictable scheme (`movies/<lang>/<title>-<year>-<lang>.mp4`), so a
  non-catalogue key is guessable for any likely title.
- **`/stream/*` normalization/encoding/traversal/token weaknesses?** Checked,
  none exploitable. R2 keys are a flat namespace (no filesystem traversal);
  the URL parser normalizes `..` before the handler sees it; double-encoding
  yields a literal key (404/426, not traversal) — verified in the stub
  harness. Token checks: HMAC-SHA256, key-bound, TTL exactly 86400s,
  expired/tampered/cross-key all refused (426). The `download=1`
  Content-Disposition filename is built AFTER `MEDIA.head(key)` returns
  non-null (404 first), so a CRLF-in-key header injection is unreachable
  for nonexistent keys; no catalogue key contains CRLF, and the Workers
  Headers API rejects invalid header values anyway. Tokens in URLs are
  logged like the `?pw=` password (see F4) — a Low note, inherent to the
  design.
- **Actual impact and smallest safe remediation:** same as F2 in the main
  audit — impact today LOW (nothing private to steal), forward risk MEDIUM.
  Remediation: catalogue check on `/api/play-token` (mint only for keys
  referenced by a listed `ext:movies` entry or a bucket movie) + a
  `MEDIA.head` existence check. Preserves all legitimate playback (site
  player, app, `/go/` downloads all use catalogue keys). Regression tests
  R19/R20 (non-catalogue → 404; deleted → 404).

## G4 — LOW — `GET /api/buckets` is unauthenticated
- **Where:** worker.js (`/api/buckets` handler, no `checkPw`/`r2ok`).
- **Confirmed by code.** Returns bucket NAMES only (via the S3 backend),
  not object keys. The bucket name (`media`) is not sensitive (it is in the
  worker config and the R2 public URL). Impact is negligible; the route
  exists for the admin upload UI. Hardening: gate it with `r2ok()` like the
  other R2 routes, or leave it (the name is public anyway).

## G5 — INFORMATIONAL — Lock scope is complete; read discipline is not
- **Verified (mechanical):** every shared-key writer takes `_withAdminLock`
  — reconciler (635/637), `markSeen`/`bumpDiscoveryTotal` (672/679, called
  from inside the lock), `finish()` (2009), batch (2131/2135), outer catch
  (2168), all six `ext:movies` writers (2631/2643/2657/2679/2690/2778),
  pending add/reject/delete/sources (2729/2802/2819/2862), config (2912).
  Per-user/unique keys (progress, sessions, oauth-state, requests) need no
  lock. The lock is NOT the gap — the swallowing reads feeding the locked
  writes are (G1). The discovery paths are the only ones with strict reads;
  the admin catalogue/queue paths are the remainder.

## G6 — INFORMATIONAL — Discovery initial state snapshot: safe; the remaining snapshot risk is G2
- The run-start snapshot is safe: strict load (1984) aborts on failure with
  no writes, and `finish()` merges onto a fresh read inside the lock (round
  8). The cron gates use the run-start snapshot, which is correct
  (a run that was due at start proceeds; a mid-run disable sticks for the
  next tick). The remaining snapshot issue is the dedupe-phase snapshot
  (G2) and the admin handlers' snapshots (G1).

## Verified OK in this continuation (no finding)
- **Lock scope:** complete (G5). **Cron:** fail-closed, overlap flag,
  failure recovery (unchanged). **OAuth/progress:** as in the main audit.
- **`/stream` edge cases:** traversal, double-encoding, CRLF filename —
  checked, not exploitable (G3).
- **`/api/buckets`:** names only, no object listing (G4).

## Checks NOT performed (boundaries)
- No live `/stream` byte fetches (would retrieve production media —
  forbidden). No live admin writes. No live cron run (first due Sun Nov 15
  02:00 UTC). No live admin flows (admin password not known to Pepper).

## Recommended order (for his approval)
1. **G1 (Critical)** — strict reads on the four wipe-capable admin writers.
   This is the one actively dangerous finding: a single transient KV failure
   during a routine admin action can silently empty the catalogue or the
   queue while returning 200.
2. **G2 (Medium)** — strict dedupe reads in discovery (fail the run instead
   of running blind).
3. **F2/G3 (Medium)** — catalogue check on `/api/play-token` (from the main
   audit).
4. **F3 (Medium)** — rate-limit `/api/request`.
5. **F1 (High, main audit)** — server-enforced approval-first (external POST
   → queue; extpublish requires `pendingId`).
6. Lows (F4, F7, F8, F9, G4) and hardening (F5, F6, F10) — backlog.
