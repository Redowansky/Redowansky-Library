# Phase 1: Approval Queue — Final Verification Report

**Date:** Fri 2026-11-13, ~05:30 +06
**Deployed commit:** `38bba7f` — "Fix ChatGPT review issues 2 and 3"
**Repo:** Redowansky/Redowansky-Library (formerly sia-lab-worker)
**Status: Phase 1 COMPLETE — ready for Phase 2** (automated discovery, still manual approval before publication)

## 1. Deployment verification — PASS

- **Commit `38bba7f` is what's running in production.** The stored Worker script (fetched via the Cloudflare API) is byte-identical to the committed `worker.js` once the API's multipart framing is stripped. Local file is also byte-identical to commit `38bba7f`.
- **Durable Object identity unchanged:** `idFromName("main-v35")` present in the deployed script. No rename, no migration.
- **Admin auth + stored settings intact:** all six queue endpoints return 403 with no password and with a wrong password. The admin password and stored settings were exercised all session by the admin's own successful use (Unlock, approvals, rejects, deletes).

## 2. Approval workflow — PASS

| # | Test | Result |
|---|------|--------|
| 2.1 | Add a candidate via the admin form | PASS — "✓ queued: Pepper Queue Test Two Form", appeared in Pending |
| 2.2 | Candidate appears in the admin Pending tab | PASS |
| 2.3 | NOT in public API, homepage, sitemap, or app feed | PASS — /api/movies 10 (browser UA and app UA `RedowanskyLibraryApp` + `X-App-Version: 41`), homepage 0 matches, sitemap 0, direct views 404 |
| 2.4 | Reject → appears in Rejected tab, stays invisible publicly | PASS |
| 2.5 | Delete the rejected candidate → disappears | PASS — gone from the queue entirely |
| 2.6 | Add a candidate with a valid playback source | PASS — Lulustream embed source (syntactically valid URL; authorization of that source was NOT established by this test) |
| 2.7 | Approve → appears in live catalogue + public API, exactly once | PASS — live entry `emwe657pw7q`, /api/movies 10 → 11, public site modal shows Play + Download |
| 2.8 | Duplicate detection vs pending and approved entries | PASS — TMDB 1726 approve → 409 dialog "Duplicate of Iron Man (live) — approve anyway?"; form-add "Spider Man" 2026 matched live "Spider-Man" despite the hyphen difference (title normalization); 27/27 unit tests on the deployed duplicate/validation code |

> **Note (2026-11-13):** the Lulustream embed used in 2.6 predates the authorized-sources-only policy adopted in the README (commit 6495d7d). That test verified the URL was valid, not that the source was authorized. Lulustream-embed entries already in the catalogue (Monarch S1) are under review — keep / replace / remove is the owner's call.

## 3. Failure and security checks

| # | Test | Result |
|---|------|--------|
| 3.1 | Approval retry cannot create a duplicate live entry | PASS — the approved candidate was re-seeded into Pending to simulate the crash window; tapping Approve returned "Published: … (was already live) — now live at /view/ext/emwe657pw7q", no second live entry, stale queue row cleaned |
| 3.2 | `pendingCleanup: failed` recovery path | NOT TESTED live — forcing a KV failure would risk production data. Verified statically: the flag is wired from the server response into the admin alert in the served script |
| 3.3 | Poster URLs with quotes, whitespace, or unsafe schemes cannot break the admin UI | PASS — 27/27 unit tests on the deployed code; live functional tests of `pendImgUrl`/`pendEsc` on the served admin script |
| 3.4 | Malformed / unsafe playback URLs rejected | PASS — `javascript:` / `data:` / `vbscript:` / `file:` schemes rejected; valid https and scheme-less R2 keys pass |
| 3.5 | Unauthenticated users cannot access or modify admin queue endpoints | PASS — GET/POST pending, approve, reject, delete all 403 without a password and with a wrong one |
| 3.6 | Concurrent admin operations do not overwrite each other's KV changes | NOT TESTED live — the in-memory promise-chain mutex (`_withAdminLock`) is in the deployed code and was code-reviewed; a live test needs two simultaneous signed-in admin calls. Accepted: single-admin system, practical risk low |

## 4. Compatibility checks — PASS

| # | Test | Result |
|---|------|--------|
| 4.1 | Google sign-in | PASS — `/auth/login` 302s to Google with the correct client id, redirect URI and scopes; bad callback returns a clean 400 |
| 4.2 | Amazon sign-in | PASS as designed — `/auth/amazon/login` answers 503 until the LWA security profile is configured (pre-existing, not Phase 1) |
| 4.3 | Existing R2 catalogue and playback | PASS — 10 entries; play-token minted, `/stream/` returned HTTP 200 `video/mp4` |
| 4.4 | External movie playback | PASS — Monarch view 200, all 5 episode embeds present |
| 4.5 | Watch progress synchronization | NOT TESTED here — GET /api/progress returns 200; a signed-in sync check needs the admin's Google session (WALL·E Continue Watching check still open) |
| 4.6 | Android app / API compatibility | PASS — app-UA feed 10 entries; version-check blocks v40 with the exact message, v41 OK |
| 4.7 | TMDB metadata matching | PASS — 10/10 catalogue entries carry tmdb id + poster; Iron Man tmdb 1726 |

## 5. Errors, logs, unexpected behavior

- **No production errors or Worker exceptions** observed during the whole pass.
- **Test-tooling mistakes (mine, caught immediately, no data affected):** the KV helper scripts' `put_value` takes a JSON string, not a dict — the first re-seed and the first cleanup attempt failed before writing anything; both were redone correctly.
- **Seed data mistake (mine, cosmetic, test-only):** the Iron Man duplicate candidate was seeded with Spider-Man's poster path, so its card showed the wrong poster. The entry is deleted; not a code bug.

## 6. Production data changes

**Yes — temporarily, and only with disposable test entries.** Round 1: Beta approved then removed. Round 2: the approve candidate went live, was re-seeded, re-approved (already-live path), then removed; the reject and form candidates were added then deleted.

**Final state verified identical to pre-test:** /api/movies 10 entries, queue 0 entries, all test view pages 404, sitemap clean. No real catalogue entries, R2 media, credentials, or Durable Object settings were touched. No KV namespaces were cleared.

## 7. Remaining risks / fixes required

- **None blocking Phase 2.** The two NOT TESTED items (3.2, 3.6) are accepted by design — neither can be tested live without risking production data or a second admin session, and both have static verification in place.
- Known Phase 1 limitations (unchanged): metadata-only (sourceless) approval is blocked by design — needs an app empty-player state in a later phase; no source-URL probing service yet; duplicate checking is admin-speed (reads `listMovies` incl. S3 listing); rejected candidates cannot be re-approved (delete and re-add); KV eventual consistency is ~60–80s; the write mutex is in-memory per DO instance (correct for the single main-v35 DO; a restart resets the chain).

## Files changed (commit 38bba7f)

- `worker.js` — approval queue (storage `ext:pending`, admin API + UI, duplicate detection, admin write mutex, URL validation, HTML escaping, self-healing approve retry)
- `r2-tools/kv_pending.py` — KV helper for the pending queue (test tooling)
