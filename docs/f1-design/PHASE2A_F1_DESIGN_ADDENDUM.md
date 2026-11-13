# F1 Design Addendum — concurrency, recovery, UI, and complete R38–R52

**Commit reviewed:** `88ef10bc1054367df51be9e6c11a073f297b6538` (repo HEAD verified
2026-11-13 ~21:20 +06). This is a **design addendum only** — no code was
edited, no commit, push, PR, or deployment was made. G1/G2 stays pinned at
`88ef10b`; production stays on `4f5ab64`. F1 remains a separate change.

**Evidence files (same directory):** `F1_REPRO.mjs` (9/9 pass),
`F1_FORGE.mjs` (7/7 pass). The addendum is grounded in the code as read at
88ef10b; line numbers below are that commit's.

## 1. Meta approval: fresh strict reads under the admin lock

### 1.1 The lock

`_withAdminLock` (worker.js:2204–2209) is an in-memory promise-chain mutex
on the DO instance: each admin write callback is appended to a chain, so
two admin writes cannot interleave. It does not survive a DO restart — but
a restart also abandons in-flight work, so no torn state results. Every
step below runs inside this lock; a concurrent admin write cannot slip
between the reads and the writes.

### 1.2 The exact sequence (meta branch of `POST /api/admin/pending/approve`)

1. Acquire `_withAdminLock`.
2. `getPendingStrict(env)` — the current queue (a failure aborts with a
   generic 500, nothing written).
3. `getExtMoviesStrict(env)` — the current catalogue (same abort rule).
4. Confirm the proposal still exists in the fresh queue and has
   `status === "pending"` (else 404 / 400, nothing written).
5. Confirm the target entry still exists in the fresh catalogue (else
   404, proposal stays queued for the admin to delete).
6. Revalidate the proposed changes against the fresh state (title
   non-empty and capped if present; poster passes `cleanImgUrl` if
   present; at least one change present — else 400).
7. Check title duplicates against the **fresh** catalogue, excluding the
   target entry itself (else 409).
8. Apply **only the proposal's specified fields** to the **fresh** target
   entry object. Never write back a stale copy of the entry.
9. Set `metaUpdatedAt: Date.now()` on the entry.
10. Persist: **catalogue first** (`saveExtMovies`), then **queue**
    (delete the proposal, `savePending`). See §1.3 for the failure
    behaviour of each save.

No snapshot captured before the lock is used for any decision or write.
The proposal's `expected` field (see §2) is the only pre-lock data
consulted, and only as a comparison value against the fresh read — never
as a write source.

### 1.3 Partial-write analysis (catalogue save vs queue save)

Cloudflare KV has no multi-key transaction: step 10 is two independent
puts. The design follows the exact pattern the existing entry-approve
handler already uses (worker.js:2812–2820), which is the codebase's
established answer to this problem:

- **Catalogue save first, hard failure.** `await saveExtMovies(...)` is
  awaited outside any try/catch. If it throws, the outer catch returns a
  generic 500 and **nothing was written** — the proposal stays pending in
  the queue and the entry is byte-identical. A retry is safe and
  idempotent.
- **Queue cleanup second, soft failure.** The proposal removal is
  `try { await savePending(...); } catch { cleanupOk = false; }`. If it
  fails, the response is **200 with `pendingCleanup: "failed"`** in the
  body — the change is already live, the proposal is still queued, and
  the admin is told to retry. The failure is never silent.
- **Self-heal on retry.** A retry re-reads the fresh target. If every
  changed field already equals the proposed value, the change is already
  in effect: the handler deletes the stale proposal (same `cleanupOk`
  flag) and returns `{ ok: true, already: true }` **without re-applying
  anything**. This mirrors the entry-approve pre-scan
  (worker.js:2796–2803), which detects a live entry already carrying
  `pendingId === id` and returns `already: true` instead of duplicating
  it.

**Failure matrix (exact recovery behaviour):**

| Failure point | State after | Response | Recovery |
|---|---|---|---|
| Queue read fails (step 2) | nothing written | 500 generic | retry; proposal and entry unchanged |
| Catalogue read fails (step 3) | nothing written | 500 generic | retry; proposal and entry unchanged |
| Catalogue save fails (step 10a) | nothing written | 500 generic | retry; proposal still pending, entry unchanged |
| Queue save fails (step 10b) | change applied, proposal still queued | 200 + `pendingCleanup: "failed"` | retry → self-heal path (`already: true`, proposal removed); if the removal fails again, the flag repeats and the admin retries or deletes the proposal manually — the change is already live, nothing is lost |
| DO/process crash between 10a and 10b | change applied, proposal still queued | (no response) | identical to queue-save failure; the next approve self-heals |

**What is guaranteed:** the proposal is never lost while the change is
unapplied (catalogue-first order); the change is never applied twice
(the already-applied check); the review state is never silently
discarded. **What is not guaranteed:** atomicity across the two keys.
The residual is a proposal that stays queued after its change is live,
until a retry or a manual delete clears it — visible, retryable, and
never wrong. The codebase already accepts this class of residual for the
discovery reconciler (worker.js ~628: "No KV transaction or atomicity is
claimed anywhere"); the meta-approve's self-heal is strictly stronger
than the reconciler's, because the reconciler's equivalent gap (seen
saved, state save failed) undercounts a display total with no repair,
while the meta-approve's gap repairs itself on the next approve.

**No third write:** the meta branch must NOT call `markSeen` or
`bumpDiscoveryTotal` (both are best-effort and belong to discovery
outcomes). The meta-approve has exactly two writes, in the order above.

## 2. Concurrent metadata proposals

### 2.1 The `expected` field

Every meta proposal records the target's field values **at proposal
time**, for the fields it changes:
`expected: { title?: <current title>, poster?: <current poster> }`.
Multiple proposals for the same entry are allowed. The UI lists each one
separately (see §5), so the admin can tell them apart.

### 2.2 The per-field decision at approve time

For each field in the proposal's `changes`, the approve compares the
**fresh** current value against `expected` and `proposed`:
- current == proposed → the field is already at the desired value;
  leave it (do not re-apply).
- current == expected → apply the proposed value.
- current == neither → **409 conflict** (`{ error: "stale proposal",
  field: <name>, current: <value> }`). The proposal stays queued; the
  admin deletes it or re-proposes with fresh expected values. Nothing is
  overwritten silently.

The whole proposal is applied only if **no** field conflicts. A proposal
whose fields are all already at their proposed values takes the
already-applied self-heal path (§1.3) instead of re-applying. A proposal
whose fields are a mix of already-applied and expected is applied for
the expected fields only — the end state matches the proposal exactly.

### 2.3 Worked examples

- **Two proposals, same field, different values.** P1 proposes title
  "Alpha", P2 proposes title "Beta" (both `expected: "Old"`). P1 is
  approved → title "Alpha". P2 is approved → current "Alpha" is neither
  P2's expected ("Old") nor P2's proposed ("Beta") → **409 stale**.
  P2 stays queued; the admin deletes it or re-proposes "Beta" (which
  captures `expected: "Alpha"`).
- **Two proposals, same field, same value.** P1 and P2 both propose
  title "Alpha". P1 approved → title "Alpha". P2 approved → current
  equals P2's proposed value → **already-applied self-heal**: P2 is
  removed from the queue, `{ ok: true, already: true }`, no re-apply.
- **Two proposals, different fields.** P1 changes the title, P2 changes
  the poster. Either order works: each approve applies **only its own
  fields** to the fresh target entry and never touches the other field.
  A stale snapshot is never written back.
- **Proposal vs a direct legacy edit.** There is no direct legacy edit
  left (extposter removed, ytinfo read-only), so a proposal can only be
  made stale by another approved proposal — the conflict above is the
  only staleness source.

## 3. Provenance check, made explicit

### 3.1 The exact validation rule

For `POST /api/admin/extpublish`, listing is allowed only when the
entry's `pendingId` satisfies:
```
typeof pendingId === "string" && /^p[0-9a-z]{8,}$/.test(pendingId)
```
Rationale: server-generated candidate ids are `"p" +
Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`
(pending-add, worker.js ~2752) — a `p` prefix followed by base36
alphanumerics (currently 12 characters, all lowercase). The regex
requires the `p` prefix and at least 8 base36 characters: deliberately
loose on length so a future id-format change is not rejected, strict
enough to reject every malformed value below. The rule is applied to the
**entry's stored field**, never to caller input (no request body can
reach the field — proven P1–P5).

**Honest scope of the check:** the format check is defence-in-depth
against malformed, stale, or corrupted values. It cannot distinguish a
well-formed-but-forged `"p..."` string from a real one — and it does not
need to, because the actual provenance guarantee is write-path
exclusivity (only the approve operation writes the field, worker.js:2812;
proven by P1–P7). A caller who could guess a real candidate id gains
nothing: the check reads the entry's stored field, which only approve
can set.

### 3.2 Guard placement — hiding can never be blocked

In the extpublish handler, **after** the entry-existence check (404 if
missing):
- If the resulting visibility is **listing** (`!!unlisted === false`,
  including a call with no `unlisted` field at all — the current handler
  defaults a missing field to listing), run the provenance check. A
  failing check returns **400** `{ error: "not approved — re-approve via
  the queue" }` and writes nothing.
- If the resulting visibility is **hiding** (`unlisted === true`), skip
  the check entirely and apply the flip. Unlisting is available for
  **every** entry — approval-proven, legacy, or with a malformed/missing
  `pendingId`. The listing guard cannot accidentally block the safe
  hiding operation, because the two branches are separate code paths and
  the guard exists only on the listing branch.

### 3.3 Malformed values (all must be treated as "not approval-proven")

`undefined` (legacy entry), `""`, `"p"`, `"p123"`, `"forged"`,
`"P..."` (uppercase — server ids are lowercase base36), `0`, `123`,
`null`, `{}`, `["p..."]`, a 200-character string, `"e..."` (a live-entry
id prefix, not a candidate id). Each must refuse listing (400) and leave
the entry unlisted and the public feed unchanged. A genuine `pendingId`
(from a real approve) must list normally. See R42.

## 4. Meta proposals handled consistently throughout

Complete map of every consumer of `ext:pending` at 88ef10b, and the
required behaviour for `kind: "meta"` records. Verified by grep:
`getPending` callers are the pending GET (2728), reject (2835), delete
(2854), sources (2881); `getPendingStrict` callers are pending-add
(2756), approve (2782), discovery dedupe (2073), reconciler (632).

| Consumer | Current behaviour | Required behaviour for meta records |
|---|---|---|
| `findDuplicate` (worker.js:760) | Queue scan matches on `tmdb`/`title` | **Skip records with `kind === "meta"`** in the queue scan. (The meta record carries no top-level `tmdb`; its display field `targetTitle` must never be matched — the skip is required, not optional.) |
| Discovery dedupe, 2nd pass (~2095–2102) | Calls `findDuplicate` with the queue | Covered by the `findDuplicate` skip. 1st pass uses the seen-map only — unaffected. |
| `reconcileDiscoveryState` (605–655) | Heals queue records with `c.tmdb && c.discoveredAt` into the seen-map, bumps `totals.discovered` | Meta records carry neither field, so the existing guard already skips them. Add an explicit `c.kind === "meta"` skip for defence in depth, so a future shape change cannot heal a meta record into the seen-map or bump the total. |
| `POST /api/admin/pending/sources` (2873) | Edits a pending record's `sources` | **400 on `kind === "meta"`** (meta records have no sources field). |
| `POST /api/admin/pending/approve` (2775) | Entry-candidate flow | **Branch on `cand.kind` first**: `"meta"` → meta branch (§1); `undefined` or `"entry"` → entry branch; any other kind → 400. (Without the branch, the entry flow's "need at least one playback source" check would 400 on a meta record — a safe failure, but a confusing one.) |
| `POST /api/admin/pending/reject` (2829) | Sets status `"rejected"`, then calls `markSeen(..., "rejected")` (2842) and `bumpDiscoveryTotal(..., "rejected")` (2843) | Works on meta records (sets the status), but **must skip both calls for `kind === "meta"`**. `markSeen` is a no-op today (meta records have no `tmdb`, and `markSeen` returns early), but the skip must be explicit; `bumpDiscoveryTotal` is NOT a no-op — it would inflate `totals.rejected`. |
| `POST /api/admin/pending/delete` (2848) | Deletes the record, then `markSeen(..., "skipped")` (2862) | Works on meta records; **skip `markSeen` for `kind === "meta"`** (no-op today, explicit skip for safety). No total is bumped by delete. |
| `POST /api/admin/pending` GET (2726) | Returns `pending` + `rejected` lists, all records | No server change (returns all records); the UI splits by kind (§5). |
| Admin queue rendering + counts (969, 975–1000) | `pendCountP` counts all pending records; `renderPend` renders every record as a publication candidate | Split by kind (§5): separate counts for publications and metadata edits. |
| Discovery state totals | `totals.discovered` bumped by runs (2022, 2157) and the reconciler (650); `totals.approved` bumped by entry-approve (2801, 2818) | **Meta proposals touch no discovery statistic.** The meta-approve branch calls neither `markSeen` nor `bumpDiscoveryTotal`; meta records are never filed by discovery and never healed by the reconciler. A meta proposal, approval, or rejection must leave `totals.discovered`, `totals.approved`, and `totals.rejected` byte-identical. |

## 5. Admin UI: display the actual proposed changes

Current UI (worker.js:959–1030): `loadPending()` fetches the queue and
sets `pendCountP` to the full pending length; `renderPend()` renders
every record identically as a publication candidate (poster, title,
year, type, TMDB, source count, "needs a playback source", Inspect /
Approve / Reject / Delete, sources editor); `approvePending()` alerts
"✓ Published: … — now live at /view/ext/<id>".

**Required UI behaviour for meta proposals** (all inside the existing
queue section; no new page):
- **Separate sections and counts.** The Pending tab shows two groups:
  "Publications" (records with `kind` undefined or `"entry"`) and
  "Metadata edits" (records with `kind === "meta"`), each with its own
  count. `pendCountP` becomes the publications count; a new
  `pendCountM` (or equivalent) counts metadata edits. The Rejected tab
  splits the same way. A meta proposal must never inflate the
  publications count.
- **Distinct card.** Each meta proposal renders with a clear
  "✏️ Metadata edit" label (not a movie/TV card): target entry id and
  **current title**; the **proposed title, if changed** (shown next to
  the current title as "Old → New"); the **current and proposed poster,
  if changed** (both thumbnails side by side, so the admin sees what
  will replace what); and an explicit field list — exactly which fields
  will change ("Title", "Poster", or both). The sources editor, the
  "needs a playback source" notice, TMDB/type/discoveredVia details,
  and the providers line do not render for meta records (they have
  none).
- **Actions.** Approve, Reject, and Delete buttons, as for candidates.
  The Approve button is labelled "Approve edit" (not "Approve"). The
  confirm/alert wording must say the change **modifies an existing
  entry** — e.g. "✓ Updated: <title> — metadata changed on the
  existing entry" — and must **not** say "Published" or "now live at
  /view/ext/<id>" (the entry is already live there). A 409 stale
  response shows: "This edit is out of date — the entry changed since
  the proposal was made. Delete it and propose again." A
  `pendingCleanup: "failed"` response shows: "Saved — but the queue
  entry could not be removed. Tap Approve again to clear it." (the same
  wording the entry-approve path already uses).
- **Propose form.** A small "Propose metadata edit" form in the queue
  section: target entry id (with a title lookup against `/api/movies`
  for the one-admin workflow — the admin types a title, picks the
  entry, the form fills the id), new title (optional), new poster URL
  (optional). Submitting calls `POST /api/admin/pending/meta` and the
  proposal appears in the Metadata edits group. The form must require at
  least one changed field.
- **Never presented as a publication.** No meta card may carry a
  "Publish" label, a "now live" message, or a new-entry affordance. The
  visual distinction (label + diff view + wording) is part of the
  server-enforced policy's presentation, not decoration.

## 6. Complete regression plan R38–R52

All tests run locally with the existing stub harness (`makeKV` /
`makeDO` / `call`, real `listMovies()` via a stubbed `s3fetch` returning
an empty bucket listing, and the public `/api/movies` read for
visibility — the R30–R32 approach). Every failure-path test asserts the
stored KV strings for `ext:movies` and `ext:pending` are byte-identical
afterwards. New tests go into `.phase2a-test/test_pending_sources.mjs`;
the CI workflow already runs that file, so no workflow change is needed.

- **R38 — forged `pendingId` via direct POST (P1).** POST
  /api/admin/external with `pendingId: "p-forged"` in the body → the
  queued candidate has no `pendingId` field.
- **R39 — forged `pendingId` / chosen id via pending add (P2).** Body
  carries `id: "p-chosen"` + `pendingId: "p-forged"` → the candidate id
  is server-generated (not `"p-chosen"`) and `pendingId` is absent.
- **R40 — forged `pendingId` via extpublish / extposter / ytinfo
  (P3–P5).** Each call with `pendingId` in the body → the entry's
  `pendingId` is unchanged (absent).
- **R41 — approve with an unknown id (P6).** POST
  /api/admin/pending/approve `{ id: "p-forged" }` → 404, catalogue
  unchanged.
- **R42 — legacy entry cannot be listed; malformed `pendingId` values.**
  Setup: an unlisted legacy entry (no `pendingId`). (a) extpublish
  `{ unlisted: false }` → 400, entry stays unlisted, public feed
  unchanged. (b) Repeat with `pendingId` set in the stored entry to
  each malformed value in turn — `""`, `"p"`, `"p123"`, `"forged"`,
  `"P..."` (uppercase), `0`, `123`, `null`, `{}`, `["p..."]`, a
  200-character string, `"e..."` — each → 400, entry stays unlisted.
  (c) A genuine `pendingId` (from a real approve in the same test) →
  extpublish `{ unlisted: false }` → 200, entry public. (d) Unlisting
  works for every entry regardless of `pendingId` (including all
  malformed values above) → 200, entry leaves the feed.
- **R43 — legacy entry metadata.** Direct poster/title write refused
  (extposter 404 / ytinfo returns values but writes nothing). A meta
  proposal for the legacy entry → 200 (queued, entry byte-identical).
  Approve → title/poster applied, `metaUpdatedAt` set, the entry still
  has **no** `pendingId` (a metadata approval does not grant
  publication provenance). The entry's visibility is unchanged.
- **R44 — meta proposal lifecycle, public-feed visibility, target
  deleted.** Setup: a live listed entry, title "Old". (a) Propose a
  title change → 200; the entry is still "Old" in the catalogue and
  still listed in `/api/movies` (visibility unchanged while the
  proposal is pending). (b) Approve → 200; the entry is "New" in the
  catalogue **and** in `/api/movies`; the proposal is gone from the
  queue; `metaUpdatedAt` is set. (c) Reject path: a second proposal,
  rejected → approve → 400, entry unchanged. (d) Target deleted: a
  proposal is queued, then the target entry is deleted via DELETE
  /api/admin/external → approve the proposal → 404, the proposal stays
  queued for the admin to delete, catalogue unchanged.
- **R45 — meta proposal validation, duplicate-title check, concurrent
  / stale proposals.** (a) No changes → 400. Unknown target → 404.
  Proposal carrying `sources` → 400. Sources route on a meta record →
  400. (b) Duplicate title: live entries A ("Alpha") and B ("Beta");
  propose B's title → "Alpha" → approve → **409** (the check excludes
  the target itself, so proposing B's title → "Beta" — its own current
  value — is not a duplicate). (c) Concurrent: P1 and P2 both target
  the same entry and the same field with different values; approve P1
  → 200; approve P2 → **409 stale**, P2 stays queued, entry keeps P1's
  value. (d) Same value: P1 and P2 propose the identical title; approve
  P1 → 200; approve P2 → 200 with `already: true`, P2 removed, entry
  unchanged. (e) Different fields: P1 changes the title, P2 changes
  the poster; approve both in either order → each applies only its own
  field, the other field is untouched.
- **R46 — ytinfo is read-only.** Call with a stubbed oEmbed response →
  200 with `{ title, poster }` returned; the entry, catalogue, and
  queue are byte-identical afterwards.
- **R47 — extposter removed.** A direct poster write → 404 (or, if the
  alias option is chosen, a meta proposal is created and the entry is
  byte-identical until approve). The entry's poster is unchanged in
  either case.
- **R48 — safe hiding.** extpublish `{ unlisted: true }` on any entry
  (approval-proven, legacy, or with a malformed `pendingId`) → 200; the
  entry leaves the public feed immediately.
- **R49 — safe deletion.** DELETE a live entry → 200; the catalogue and
  public feed lose the entry; the queue is unchanged.
- **R50 — duplicate submissions.** (a) Converted direct POST
  duplicating a live entry → 409; the same call with `force: true` →
  queued (not published), catalogue unchanged. (b) A meta proposal
  whose new title duplicates another live entry → 409 at approve (see
  R45b). (c) A meta proposal for a title that matches only a *queued*
  (unapproved) candidate is allowed — the queue is not public, so it is
  not a duplicate.
- **R51 — strict KV read failures and partial-write recovery.** (a)
  Simulated read failure during the meta-proposal write → 500 generic,
  queue + catalogue byte-identical. (b) Simulated read failure during
  meta-approve (queue read and catalogue read, separately) → 500
  generic, queue + catalogue byte-identical. (c) Catalogue save fails
  (KV stub fails `put` on `ext:movies` only) → 500, nothing written,
  proposal still pending; a retry with the failure removed → 200. (d)
  Queue save fails (KV stub fails `put` on `ext:pending` only, after
  the catalogue save) → 200 with `pendingCleanup: "failed"`, the change
  is applied, the proposal is still queued; a retry → 200 with
  `already: true`, the proposal is removed, the entry is unchanged by
  the retry (not applied twice). (e) Same as (d) but the retry's queue
  removal also fails → 200 with `pendingCleanup: "failed"` again, the
  entry still applied exactly once. The harness needs a
  put-failure-injection KV stub keyed by KV key (the existing R25–R28
  failing-KV pattern, extended to fail one key at a time).
- **R52 — metadata records excluded from discovery counts and
  publication totals; G1/G2 suite green.** (a) Queue a meta proposal →
  the pending GET's publication count (records with `kind` undefined or
  `"entry"`) is unchanged; the discovery state's
  `totals.discovered`/`totals.approved`/`totals.rejected` (read from the
  stub KV's `ext:discovery:state`) are byte-identical. (b) Approve the
  meta proposal → the three totals are still byte-identical. (c) Reject
  the meta proposal → the three totals are still byte-identical. (d)
  The full existing suite (47 tests: 9 Phase 2a + 38 hardening) passes
  on the new code. Note: R28 (external POST failure path) is re-targeted
  at the converted pending-write path with the same assertions; R25–R27
  and R29–R32 are unaffected. The F1 repro tests (F1-A–E, N1–N4) are
  updated to the new expected behaviour: F1-A expects a queued
  candidate (not a live entry); F1-B expects the 400 refusal; F1-C
  expects the read-only / proposal flow.

## 7. Trade-offs and limitations

- **No KV atomicity.** The two-put sequence plus the already-applied
  self-heal is the mitigation, not a transaction. The residual is a
  proposal that stays queued after its change is live until a retry or
  a manual delete clears it — visible, retryable, never double-applied.
  The codebase already accepts this class of residual for the
  reconciler (worker.js ~628).
- **The `expected` field is a snapshot, not a version counter.** There
  is no automatic merge of conflicting proposals; a stale proposal is
  rejected and the admin re-proposes with fresh expected values. This
  is the correct behaviour for a one-admin system — silent merging
  would defeat the review.
- **The `pendingId` format check is defence-in-depth, not the
  provenance guarantee.** The guarantee is write-path exclusivity
  (only approve writes the field); the regex only rejects malformed
  values. If the candidate-id format ever changes, the regex must be
  updated with it (it is deliberately loose: `p` + ≥8 base36 chars).
- **The admin lock is an in-memory promise chain** (worker.js:2204–
  2209). It serialises writes within the DO instance; it does not
  survive a restart — but a restart abandons in-flight work, so no
  torn state results.
- **One-admin caveat (from Revision 2, unchanged):** proposer and
  approver are the same person, so the meta mechanism gives visibility
  plus a two-step barrier against silent/scripted changes — not
  separation of duties. If a second admin is ever added, the same
  mechanism becomes real separation with no redesign.
- **Legacy re-approval still changes the entry id** (force add →
  force approve → delete old). The transient duplicate and the new
  `/view/ext/<id>` URL are the cost of granting provenance to a
  pre-policy entry; the "adopt" enhancement (stamp the existing entry
  in approve) remains a possible future option, not part of this
  release.

## 8. Exact intended files and routes to change

**One file: `worker.js`** in the staging repo
(`~/workspace/github-backup/sia-lab-worker/`, branch `main`), as a **new
commit on top of `88ef10b`** — never an amendment, rebase, or merge of
`88ef10b`. The pinned release is untouched; F1 is a separate change.
**One test file: `.phase2a-test/test_pending_sources.mjs`** (add R38–
R52). The CI workflow (`.github/workflows/test.yml`) needs no change —
it already runs both test files.

| Location | Change |
|---|---|
| `POST /api/admin/external` (worker.js:2622) | Convert to a pending-submission alias (validates like pending-add, writes to `ext:pending`, returns the pending id; writes nothing to `ext:movies`). |
| `POST /api/admin/extpublish` (2674) | Provenance guard on the listing branch only (§3); hiding branch unchanged. |
| `POST /api/admin/extposter` (2660) | Remove as a direct-write route (function moves to the meta proposal). |
| `POST /api/admin/ytinfo` (2686) | Read-only lookup (returns `{ title, poster }`, writes nothing). |
| `DELETE /api/admin/external` (2708) | Unchanged. |
| `POST /api/admin/pending/meta` (new) | Propose a metadata change (`targetId`, `changes: {title?, poster?}`, `expected` captured server-side). |
| `POST /api/admin/pending/approve` (2775) | Extend with the meta branch (§1–§2); entry branch unchanged. |
| `POST /api/admin/pending/reject` (2829) | Skip `markSeen` + `bumpDiscoveryTotal` for `kind === "meta"`. |
| `POST /api/admin/pending/delete` (2848) | Skip `markSeen` for `kind === "meta"`. |
| `POST /api/admin/pending/sources` (2873) | 400 on `kind === "meta"`. |
| `findDuplicate` (760) | Skip `kind === "meta"` records in the queue scan. |
| `reconcileDiscoveryState` (605) | Explicit `kind === "meta"` skip (defence in depth; the existing `tmdb`/`discoveredAt` guard already excludes them). |
| ADMIN_PAGE queue UI (965–1030) | Split Publications / Metadata edits with separate counts; meta card with diff view and "Approve edit" wording (§5); propose form. |
| `.phase2a-test/test_pending_sources.mjs` | Add R38–R52 (§6). |

## 9. Confirmation

This addendum is **design-only**. No files were edited, no code was
implemented, no commit, push, PR, or deployment was made. The pinned
G1/G2 release (`88ef10b`) and production (`4f5ab64`) are untouched. No
production writes, deployment, or configuration changes were performed
or are authorised by this work. F2/G3 and F3 remain separate. Awaiting
the separate explicit implementation decision.
