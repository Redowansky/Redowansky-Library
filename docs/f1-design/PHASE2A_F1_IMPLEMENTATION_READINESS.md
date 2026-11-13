# F1 Implementation-Readiness Checklist (Revision 2.1)

**Design-only.** No code was edited, no commit, push, PR, or deployment
was made. F1 remains a separate commit on top of pinned `88ef10b`; G1/G2
remain pinned and unchanged; production remains on `4f5ab64`. No
deployment, production writes, or configuration changes are authorised
by this document. **Awaiting a separate explicit implementation
approval before any edit, commit, push, PR, or deployment.**

Verified before writing: repo HEAD is `88ef10b`; the working tree is
clean except the known untracked G1/G2 build scripts and generated test
outputs (which are intentionally uncommitted); `getExtMoviesStrict`
(worker.js:591–594) tags read failures with `KV_READ_FAILED` and
rethrows; the `json()` helper (worker.js:220) sets only `content-type`
— no `Cache-Control` exists anywhere in worker.js today.

## 1. Provenance format wording — corrected

**Correction to Revision 2.1 §1:** the bounded regex
`/^p[0-9a-z]{8,13}$/` must **not** be described as an exact format
match. It is a **format sanity check** only. It does not validate the
timestamp-plus-random structure the ID function generates — it accepts
any 8–13 lowercase base36 characters after the `p` prefix, including a
string that is not a real timestamp-plus-random composition. The bound
(minimum total length 9, maximum 14) is consistent with the generated
format's length range, but length + charset is all it checks.

**The invariant, stated exactly (use this wording in code comments and
docs):**
> Only the successful server-side approval path may assign `pendingId`
> (worker.js:2812). The regex is not proof of provenance.

The regex is defence-in-depth against malformed, stale, or corrupted
values. Provenance comes from write-path exclusivity (proven P1–P7:
no caller input can reach the field). If the candidate-id format ever
changes, the regex must be updated with it.

## 2. New admin entries lookup route — `GET /api/admin/entries`

Placed adjacent to the pending GET route (worker.js:2726). All seven
requirements are mandatory:

- [ ] **Strict read only.** Uses `getExtMoviesStrict()` — never the
  swallowing `getExtMovies()`. A KV read failure must never fall back
  to an empty catalogue (an empty fallback would make the admin think
  no entries exist).
- [ ] **Generic 500 on unreadable data.** On `KV_READ_FAILED`, return
  the generic 500 (`"stored data temporarily unreadable — try again"`),
  with **no write** of any kind.
- [ ] **`Cache-Control: no-store`.** The `json()` helper (worker.js:220)
  sets only `content-type`, so the route builds its Response directly:
  `new Response(JSON.stringify({ ok: true, entries }), { status: 200,
  headers: { "content-type": "application/json", "Cache-Control":
  "no-store" } })`.
- [ ] **Bounded query and results.** The `q` parameter is rejected
  with 400 if longer than **100 characters**. The result list is capped
  at **100 entries** (the catalogue is 11 entries today; the cap is a
  safety bound). An empty query returns all live entries, up to the cap.
- [ ] **Minimal fields only.** Each returned object carries exactly
  these seven fields: `{ id, title, type, tmdb, unlisted,
  hasPendingId, poster }`. `hasPendingId` is a boolean derived from the
  stored field — the raw `pendingId` value is **not** returned.
- [ ] **No private media data.** Never return `sources`, `url`,
  playback URLs, or any other media data. The lookup is for finding an
  entry, not for reading its playback data.
- [ ] **Authentication consistent with the admin API.** `checkPw`
  (the `?pw=` query parameter), 403 on a wrong or missing password —
  the same gate as every other admin route. The route is not linked
  from any public page, and `/api/movies` and `/view/` are unchanged
  (unlisted entries stay excluded from every public response).

**Manual-ID fallback — same strict validation.** The propose form's
pasted-id path and the search-based path converge on the same propose
handler (`POST /api/admin/pending/meta`), which must: (a) read the
catalogue with `getExtMoviesStrict` inside `_withAdminLock`; (b)
confirm the target id exists (404 if not); (c) capture the `expected`
values from that **fresh server-side read** — never from the request
body (any `expected` supplied in the body is ignored, so a caller
cannot forge it). The propose response echoes the target's current
title and the proposal id, so the admin can confirm the right entry
was targeted.

## 3. Metadata approval and recovery — confirmations

The implementation must do all of the following (each maps to a test
in §4):

- [ ] **Re-read pending and catalogue state strictly inside
  `_withAdminLock`.** `getPendingStrict` then `getExtMoviesStrict`,
  both inside the lock callback (worker.js:2204–2209, the in-memory
  promise-chain mutex). No snapshot captured before the lock is used
  for any decision or write.
- [ ] **Revalidate the target and proposed fields at approval time.**
  The proposal still exists with `status === "pending"`; the target
  entry still exists in the fresh catalogue; the proposed title is
  non-empty and capped and the proposed poster passes `cleanImgUrl`;
  at least one change is present; the proposed title does not duplicate
  another live entry (excluding the target itself).
- [ ] **Preserve the expected / proposed / neither stale-field
  comparison.** For each changed field, against the fresh current
  value: current == proposed → leave it; current == expected → apply
  it; current == neither → **409 stale**, the whole proposal is refused
  and stays queued. The end state matches the proposal exactly, or
  nothing is applied.
- [ ] **Keep the proposal queued if the target is missing or a genuine
  conflict occurs.** Target missing → 404, proposal stays queued for
  the admin to delete. Genuine conflict → 409, proposal stays queued;
  the admin deletes it or re-proposes with fresh expected values.
- [ ] **Distinguish a successful catalogue update followed by failed
  queue cleanup from a failed catalogue update.** Catalogue save first
  (hard failure → generic 500; see the caveat below — a thrown `put`
  is ambiguous, not proof of no-write). Queue cleanup second (soft
  failure → 200 with `pendingCleanup: "failed"`; the change is live
  and the proposal is still queued). The two outcomes have different
  responses and different retry paths.
- [ ] **Ensure retries do not overwrite unrelated newer metadata.**
  The approve applies **only the proposal's specified fields** to the
  **fresh** target entry object. It never writes back a stale copy of
  the entry, and it never touches a field outside the proposal's
  `changes`.

**Eventual-consistency caveat (accurate wording):** Cloudflare KV does
not offer a read-your-writes guarantee across edge locations, so a
retry's fresh strict read could theoretically observe pre-write state
from a stale replica. If it does, the retry re-applies the proposal —
which is safe because the apply is **idempotent**: it writes the same
proposed values to the same fields, so the end state is identical; only
`metaUpdatedAt` would refresh (a benign timestamp difference). A stale
read can therefore cause a redundant idempotent write and a refreshed
`metaUpdatedAt`, but it **must not corrupt unrelated fields** — and it
cannot, because the apply touches only the proposal's specified fields
on the fresh target object.

## 4. Test plan — R38–R52 retained, plus R53–R57 (lookup route)

All tests run locally with the existing stub harness (real
`listMovies()` via a stubbed `s3fetch`, public `/api/movies` for
visibility). Failure-path tests assert the stored KV strings are
byte-identical afterwards. New tests go into
`.phase2a-test/test_pending_sources.mjs`.

**Retained, unchanged in scope (full definitions in
`PHASE2A_F1_DESIGN_REV2_1.md` §4):**
- R38 forged `pendingId` via direct POST · R39 forged `pendingId` /
  chosen id via pending add · R40 forged `pendingId` via extpublish /
  extposter / ytinfo · R41 approve with an unknown id → 404 · R42 legacy
  entry cannot be listed + bounded `pendingId` validation (shortest
  valid 9 chars, longest valid 14, one over 15, oversized 200-char, one
  under 8) · R43 legacy entry metadata + unlisted-entry lookup +
  manual-ID fallback · R44 meta proposal lifecycle + public-feed
  visibility + target deleted · R45 meta validation + duplicate-title
  check excluding the target + concurrent / stale proposals · R46
  ytinfo read-only · R47 extposter removed · R48 safe hiding · R49
  safe deletion · R50 duplicate submissions · R51 strict KV read
  failures + partial-write recovery + **commit-then-throw (R51d)** ·
  R52 meta records excluded from discovery counts and publication
  totals + the full 47-test suite green.

**New — lookup route (R53–R57):**
- **R53 — lookup authentication.** No password → 403. Wrong password
  → 403. Correct password → 200 with the entries list. The route is
  not reachable through any public path (no link from any public page;
  `/api/movies` does not expose it).
- **R54 — lookup strict-read failure.** The KV `get` throws → **500**
  generic, no write. The test asserts the status is 500 — **not** 200
  with an empty list (an empty list would be the swallowing-getter
  failure mode this route must never exhibit).
- **R55 — lookup no-store.** A successful lookup response carries
  `Cache-Control: no-store` (and `content-type: application/json`).
- **R56 — lookup unlisted visibility.** An unlisted entry appears in
  the lookup with `unlisted: true`; the same entry is absent from the
  public `/api/movies` response. A listed entry appears in both. A
  title query matching only the unlisted entry returns exactly that
  entry.
- **R57 — lookup response-field restrictions and bounds.** Each
  returned object has **exactly** the seven minimal fields (`id`,
  `title`, `type`, `tmdb`, `unlisted`, `hasPendingId`, `poster`) — no
  `sources`, no `url`, no raw `pendingId`, no other fields. A query
  longer than 100 characters → **400**. With 105 seeded live entries
  matching the query, at most **100** are returned.

**Suite totals after F1:** 47 existing + 15 (R38–R52) + 5 (R53–R57) =
**67 tests**, all local. The F1 repro tests (F1-A–E, N1–N4) are updated
to the new expected behaviour (F1-A queues instead of publishing; F1-B
is the 400 refusal; F1-C is the read-only / proposal flow). R28 is
re-targeted at the converted pending-write path with the same
assertions; R25–R27 and R29–R32 are unaffected.

## 5. Release boundaries

- [ ] F1 is a **new commit on top of `88ef10b`** (parent `88ef10b`).
  Never an amendment, rebase, or merge of `88ef10b`; never a change to
  the pinned release's files outside the F1 commit.
- [ ] G1/G2 remain pinned and unchanged. The 47-test suite (including
  R25–R32) passes on the F1 code.
- [ ] The CI workflow (`.github/workflows/test.yml`) is **not**
  altered — it already runs both test files.
- [ ] Production remains on `4f5ab64`. No deployment, production
  writes, or configuration changes as part of F1.
- [ ] F2/G3 and F3 remain separate. No bundling.

## 6. Exact commit scope

**Files (2):** `worker.js` and
`.phase2a-test/test_pending_sources.mjs` — nothing else.

| Location | Change |
|---|---|
| `POST /api/admin/external` (worker.js:2622) | Convert to a pending-submission alias. |
| `POST /api/admin/extpublish` (2674) | Bounded provenance guard on the listing branch only; hiding branch unchanged. |
| `POST /api/admin/extposter` (2660) | Remove as a direct-write route. |
| `POST /api/admin/ytinfo` (2686) | Read-only lookup. |
| `DELETE /api/admin/external` (2708) | Unchanged. |
| `GET /api/admin/entries` (new, near 2726) | Admin-only lookup (§2). |
| `POST /api/admin/pending/meta` (new) | Propose a metadata change; `expected` captured server-side from a strict read inside the lock; response echoes the target's current title. |
| `POST /api/admin/pending/approve` (2775) | Extend with the meta branch (§3); entry branch unchanged. |
| `POST /api/admin/pending/reject` (2829) | Skip `markSeen` + `bumpDiscoveryTotal` for `kind === "meta"`. |
| `POST /api/admin/pending/delete` (2848) | Skip `markSeen` for `kind === "meta"`. |
| `POST /api/admin/pending/sources` (2873) | 400 on `kind === "meta"`. |
| `findDuplicate` (760) | Skip `kind === "meta"` records in the queue scan. |
| `reconcileDiscoveryState` (605) | Explicit `kind === "meta"` skip. |
| ADMIN_PAGE queue UI (965–1030) | Split Publications / Metadata edits with separate counts; meta card with diff view and "Approve edit" wording; propose form with the lookup + manual-ID fallback. |
| `.phase2a-test/test_pending_sources.mjs` | Add R38–R57 (§4). |

## 7. Pre-implementation verification (run before writing code)

- [ ] `git log --oneline -1` in the staging repo shows `88ef10b`;
  `git status --short` shows no modifications to tracked files.
- [ ] The existing 47-test suite passes locally (and the F1 repro /
  forge files still pass: 9/9 and 7/7).
- [ ] The implementation is written against the Revision 2.1 design
  (`PHASE2A_F1_DESIGN_REV2_1.md`), this checklist, and the addendum
  (`PHASE2A_F1_DESIGN_ADDENDUM.md`) — in that order of precedence for
  any conflict (this checklist governs wording, the lookup route, and
  the recovery confirmations).

## 8. Confirmation

This checklist is **design-only**. No files were edited, no code was
implemented, no commit, push, PR, or deployment was made. The pinned
G1/G2 release (`88ef10b`) and production (`4f5ab64`) are untouched.
Awaiting the separate explicit implementation approval.
