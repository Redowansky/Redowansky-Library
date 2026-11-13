# F1 Design Revision 2.1 — bounded provenance, corrected partial-write
guarantees, unlisted-entry lookup

**Commit reviewed:** `88ef10bc1054367df51be9e6c11a073f297b6538` (repo HEAD
verified 2026-11-13 ~21:30 +06). **Design-only.** No code was edited, no
commit, push, PR, or deployment was made. F1 remains a separate commit on
top of pinned `88ef10b`; G1/G2 remain pinned and unchanged; production
remains on `4f5ab64`. No deployment, production writes, or configuration
changes are authorised by this work. This is not implementation
authorization.

**What changed vs Revision 2 + the addendum:** (1) the provenance regex
now has an explicit maximum length, derived from the actual id format
and verified by computation; (2) the partial-write failure matrix is
corrected — a thrown `put()` no longer claims the catalogue is unchanged,
and a commit-then-throw test proves the retry handles the ambiguous case;
(3) an admin-only lookup path is specified for unlisted legacy entries.
All three changes are corrections/clarifications, not redesigns.

## 1. Bounded provenance check

### 1.1 The actual id format (verified by computation)

Candidate ids are generated in the pending-add route (worker.js ~2752):
`"p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`.
- **Timestamp part:** `Date.now().toString(36)` is currently **8**
  characters. It becomes 9 characters when epoch milliseconds reach
  36^8 (2,821,109,907,456 ms = **2059-05-25**), and stays 9 until 36^9
  ms (year 5188). So 8–9 characters for the foreseeable future.
- **Random part:** `Math.random().toString(36).slice(2, 6)` is **4**
  characters in 10,000 samples (theoretically 0–4; it is empty only if
  `Math.random()` returns exactly 0).
- **Total length:** 1 (prefix) + 8–9 (timestamp) + 0–4 (random) =
  **9–14 characters**. A real id today is 13 characters (verified:
  sample `pmwf4v0brllic`).

### 1.2 The bounded rule

```
typeof pendingId === "string" && /^p[0-9a-z]{8,13}$/.test(pendingId)
```
Accepted total length: **minimum 9, maximum 14**. The `{8,13}` quantifier
counts the base36 characters after the `p` prefix: 8 = an 8-character
timestamp with an empty random part (the theoretical minimum); 13 = a
9-character timestamp (post-2059) plus 4 random characters (the
theoretical maximum). The bound is deliberately exact to the format —
no headroom for forged values, no risk of rejecting a real id (the
format cannot produce a longer id before the year 5188).

### 1.3 Boundary tests (in R42)

- **Shortest valid (9 chars):** `"p"` + 8 base36 characters → accepted
  (a real id with an empty random part).
- **Longest valid (14 chars):** `"p"` + 13 base36 characters →
  accepted (a post-2059 id: 9-char timestamp + 4 random).
- **One character over (15 chars):** `"p"` + 14 base36 characters →
  rejected.
- **Oversized forged (200 chars):** `"p"` + 199 base36 characters →
  rejected (this value passed the old unbounded regex — the hole this
  revision closes).
- **One character under (8 chars):** `"p"` + 7 base36 characters →
  rejected.

### 1.4 The core guarantee, restated

The regex is **format validation only**. Actual provenance comes from
exclusive server-side assignment during successful approval: only the
approve operation writes the `pendingId` field (worker.js:2812), and no
caller input can reach it (proven P1–P7, `F1_FORGE.mjs`, 7/7 pass). The
bounded regex is defence-in-depth against malformed, stale, or
corrupted values — it cannot distinguish a well-formed-but-forged
`"p..."` string from a real one, and it does not need to, because the
check reads the entry's stored field, which only approve can set.

## 2. Corrected KV partial-write guarantees

### 2.1 The correction

The addendum stated that a thrown catalogue save means "nothing was
written". **That claim is withdrawn.** A rejected or timed-out KV
`put()` does not prove the write was never committed: the write may have
landed server-side while its response was lost (timeout, network error,
or a crash after commit). Only failures that occur **before** a `put` is
issued are provably pre-write. The design therefore does not rely on
what a failed write did or did not do — it relies on the retry
inspecting fresh strict state.

### 2.2 The revised failure matrix

| Outcome | What is known | Response | Retry behaviour |
|---|---|---|---|
| **Confirmed pre-write failure** — a strict read fails, a validation check fails (400), or a conflict is found (409), all before any `put` is issued | Nothing was written (no `put` was issued) | 500 generic / 400 / 409 | Safe: the retry re-reads fresh state; the proposal is still pending and the entry is unchanged |
| **Catalogue `put` throws, write did NOT commit** (rejected before commit) | Catalogue unchanged — but the caller cannot distinguish this row from the next one | 500 generic | The retry re-reads fresh state: fields are at their `expected` values → apply normally |
| **Catalogue `put` throws, write DID commit** (response lost / timeout / crash after commit) | Catalogue updated — but the caller does not know | 500 generic | The retry re-reads fresh state: fields are already at their `proposed` values → already-applied self-heal (remove the proposal, return `{ ok: true, already: true }`, do **not** re-apply) |
| **Catalogue `put` succeeds, queue `put` fails** | Change applied, proposal still queued | 200 + `pendingCleanup: "failed"` | Same self-heal as the row above |
| **Both `put`s succeed** | Change applied, proposal removed | 200 | Done |

Rows 2 and 3 are indistinguishable to the caller — both are a thrown
`put` returning 500. The retry handles both identically, because it
never assumes anything about the failed write: it inspects fresh strict
state and acts on what it finds (expected → apply; proposed → self-heal;
neither → 409 stale). That is the whole guarantee: **the retry's
correctness comes from fresh-state inspection, not from any claim about
the failed write.**

### 2.3 The commit-then-throw test (R51d)

A KV stub whose `put` on `ext:movies` **commits the value to the
underlying map and then throws** (simulating a lost response). The test
asserts: (1) the approve call returns 500; (2) the stored `ext:movies`
**does** contain the applied change (the write landed despite the
throw); (3) the proposal is still in the queue; (4) a retry with a
normal KV returns 200 with `already: true`, removes the proposal, and
the entry is byte-identical to the state after step 2 — including
`metaUpdatedAt`, which the retry must **not** refresh (it did not
re-apply). This test proves the ambiguous outcome is handled correctly,
and it is the test that would have caught the addendum's incorrect
"nothing was written" claim.

### 2.4 The remaining KV eventual-consistency limitation

Cloudflare KV does not offer a read-your-writes guarantee across edge
locations: a retry's fresh strict read could, in theory, observe the
pre-write state if served from a stale replica (the DO is
single-instance, so in practice its reads are served from the same edge
as its writes, but the design does not depend on that). If a retry
observed stale state, it would re-apply the proposal — which is safe
because the apply is **idempotent**: it writes the same proposed values
to the same fields, so the end state is identical; only `metaUpdatedAt`
would refresh (a benign timestamp difference). The already-applied check
is therefore a best-effort guard under eventual consistency, and the
idempotence of the apply is the real guarantee. No corruption is
possible from a stale read — only a redundant write of identical field
values.

## 3. Metadata proposals for unlisted legacy entries

### 3.1 The problem

The public `/api/movies` endpoint excludes unlisted entries, so the
admin's metadata-edit form (which looks a title up against
`/api/movies`) cannot find the unlisted WALL·E test entry (id
`emvsu47s4`). The admin needs a way to target it without exposing
unlisted entries publicly.

### 3.2 The lookup path (recommended) + the manual-ID fallback

**Admin-only lookup route (new):** `GET /api/admin/entries?q=<query>`
- `checkPw`-gated, like every admin route (403 on a wrong password).
- The query matches the entry **id** (exact or prefix) and the **title**
  (case-insensitive substring). An empty query returns all live entries
  (the catalogue is small — 11 entries; cap the response at 100).
- **Includes unlisted entries**, each flagged `unlisted: true`.
- Returns minimal fields only: `{ id, title, type, tmdb, unlisted,
  hasPendingId, poster }`. **No sources or playback URLs** — the lookup
  is for finding an entry, not for reading its playback data.
- Not linked from any public page. `/api/movies` and `/view/` are
  unchanged: unlisted entries stay excluded from every public response.

**Manual-ID fallback (required, no new route):** the propose form
accepts a pasted entry id. The propose route already validates the
target by id (404 if it does not exist), and its response echoes the
target's current title and the proposal id — so the admin can confirm
the right entry was targeted. If the wrong id was pasted, the response
shows the wrong title and the admin deletes the proposal. The WALL·E
entry can be targeted this way today, by its id, with no new code.

**Worked example:** the admin searches "WALL·E" in the lookup → the
unlisted test entry appears (`unlisted: true`, no `pendingId`) → the
admin picks it → proposes a poster fix → the proposal appears in the
Metadata edits group → approve applies it. The entry stays unlisted
throughout; nothing about it becomes public.

## 4. Complete regression plan R38–R52

All tests run locally with the existing stub harness (`makeKV` /
`makeDO` / `call`, real `listMovies()` via a stubbed `s3fetch` returning
an empty bucket listing, and the public `/api/movies` read for
visibility — the R30–R32 approach). Every failure-path test asserts the
stored KV strings for `ext:movies` and `ext:pending` are byte-identical
afterwards. New tests go into `.phase2a-test/test_pending_sources.mjs`;
the CI workflow already runs that file, so no workflow change is needed.
The harness needs a put-failure-injection KV stub keyed by KV key (the
existing R25–R28 failing-KV pattern, extended to fail one key at a time,
and to commit-then-throw for R51d).

- **R38 — forged `pendingId` via direct POST (P1).** Setup: empty
  catalogue + empty queue. Call POST /api/admin/external with
  `pendingId: "p-forged"` in the body. Expect 200 and a queued
  candidate whose stored record has **no** `pendingId` field. Assert
  the catalogue is empty and the candidate is not in `/api/movies`.
- **R39 — forged `pendingId` / chosen id via pending add (P2).**
  Setup: empty queue. Call POST /api/admin/pending with `id:
  "p-chosen"` + `pendingId: "p-forged"` in the body. Expect 200. Assert
  the queued candidate's id is server-generated (not `"p-chosen"`) and
  its `pendingId` is absent.
- **R40 — forged `pendingId` via extpublish / extposter / ytinfo
  (P3–P5).** Setup: one live entry, no `pendingId`. Call each of the
  three routes with `pendingId: "p-forged"` in the body. Expect 200 for
  each (the routes' normal behaviour). Assert the entry's `pendingId`
  is still absent after all three calls.
- **R41 — approve with an unknown id (P6).** Setup: empty catalogue +
  empty queue. Call POST /api/admin/pending/approve `{ id: "p-forged"
  }`. Expect **404**. Assert the catalogue is empty.
- **R42 — legacy entry cannot be listed; bounded `pendingId`
  validation.** Setup: an unlisted legacy entry (no `pendingId`).
  (a) extpublish `{ unlisted: false }` → **400**, the entry stays
  unlisted, the public feed is unchanged. (b) Repeat with the entry's
  stored `pendingId` set to each malformed value in turn — `""`,
  `"p"`, `"p123"`, `"forged"`, `"P..."` (uppercase), `0`, `123`,
  `null`, `{}`, `["p..."]`, `"e..."` (a live-entry id prefix), a
  15-character `"p"` + 14 base36 string (one over the limit), and a
  200-character `"p"` + 199 base36 string (oversized forged) — each →
  **400**, the entry stays unlisted. (c) Boundary accepts: a 9-character
  `"p"` + 8 base36 string (shortest valid) and a 14-character `"p"` +
  13 base36 string (longest valid) → each lists normally (**200**, the
  entry becomes public). (d) A genuine `pendingId` (from a real approve
  in the same test) → extpublish `{ unlisted: false }` → **200**, the
  entry becomes public. (e) Unlisting works for every entry regardless
  of `pendingId` (including all malformed values above) → **200**, the
  entry leaves the feed.
- **R43 — legacy entry metadata + unlisted-entry lookup.** Setup: the
  unlisted WALL·E legacy entry (no `pendingId`). (a) A direct
  poster/title write is refused (extposter 404; ytinfo returns values
  but writes nothing — entry byte-identical). (b) The admin lookup:
  GET /api/admin/entries?q=WALL·E with the admin password → 200 and
  the entry appears with `unlisted: true` and no `pendingId`; the
  response contains no `sources` field. The same call without a password
  → 403; the same call on the public `/api/movies` → the entry is
  absent. (c) Manual-ID fallback: propose a meta edit by pasting the
  entry id → 200; the response echoes the target's current title and
  the proposal id; the entry is byte-identical. (d) Approve the
  proposal → 200; the title/poster are applied, `metaUpdatedAt` is set,
  the entry still has **no** `pendingId` (a metadata approval does not
  grant publication provenance), and the entry is still unlisted.
- **R44 — meta proposal lifecycle, public-feed visibility, target
  deleted.** Setup: a live listed entry, title "Old". (a) Propose a
  title change → 200; the entry is still "Old" in the catalogue **and**
  still listed in `/api/movies` (visibility is unchanged while the
  proposal is pending). (b) Approve → 200; the entry is "New" in the
  catalogue **and** in `/api/movies`; the proposal is gone from the
  queue; `metaUpdatedAt` is set. (c) Reject path: a second proposal is
  rejected → approve → 400, the entry is unchanged. (d) Target deleted:
  a proposal is queued, then the target entry is deleted via DELETE
  /api/admin/external → approve the proposal → **404**, the proposal
  stays queued for the admin to delete, the catalogue is unchanged.
- **R45 — meta proposal validation, duplicate-title check,
  concurrent / stale proposals.** (a) No changes → 400. Unknown target
  → 404. A proposal carrying `sources` → 400. The sources route on a
  meta record → 400. (b) Duplicate title: live entries A ("Alpha") and
  B ("Beta"); propose B's title → "Alpha" → approve → **409** (the
  check excludes the target itself, so proposing B's title → "Beta" —
  its own current value — is not a duplicate). (c) Concurrent, same
  field, different values: P1 and P2 both target the same entry and
  the same field; approve P1 → 200; approve P2 → **409 stale**, P2
  stays queued, the entry keeps P1's value. (d) Same value: P1 and P2
  propose the identical title; approve P1 → 200; approve P2 → 200
  with `already: true`, P2 is removed, the entry is unchanged. (e)
  Different fields: P1 changes the title, P2 changes the poster;
  approve both in either order → each applies only its own field and
  the other field is untouched.
- **R46 — ytinfo is read-only.** Setup: a live entry. Call
  /api/admin/ytinfo with a stubbed oEmbed response → 200 with `{
  title, poster }` returned. Assert the entry, the catalogue, and the
  queue are byte-identical afterwards.
- **R47 — extposter removed.** Setup: a live entry. A direct poster
  write → **404** (or, if the alias option is chosen, a meta proposal
  is created and the entry is byte-identical until approve). Assert the
  entry's poster is unchanged in either case.
- **R48 — safe hiding.** extpublish `{ unlisted: true }` on any entry
  (approval-proven, legacy, or with a malformed `pendingId`) → **200**;
  the entry leaves the public feed immediately.
- **R49 — safe deletion.** DELETE a live entry → **200**; the catalogue
  and the public feed lose the entry; the queue is unchanged.
- **R50 — duplicate submissions.** (a) The converted direct POST
  duplicating a live entry → **409**; the same call with `force: true`
  → queued (not published), the catalogue is unchanged. (b) A meta
  proposal whose new title duplicates another live entry → **409** at
  approve (see R45b). (c) A meta proposal for a title that matches
  only a *queued* (unapproved) candidate is allowed — the queue is not
  public, so it is not a duplicate.
- **R51 — strict KV read failures and partial-write recovery.** (a)
  Simulated read failure during the meta-proposal write → **500**
  generic, the queue + catalogue are byte-identical. (b) Simulated
  read failure during meta-approve (the queue read and the catalogue
  read, separately) → **500** generic, the queue + catalogue are
  byte-identical. (c) Catalogue save fails (the KV stub fails `put` on
  `ext:movies` only, before committing) → **500**, nothing is written,
  the proposal is still pending; a retry with the failure removed →
  **200**. (d) **Commit-then-throw:** the KV stub's `put` on
  `ext:movies` commits the value and then throws → the approve returns
  **500**, but the stored `ext:movies` **does** contain the applied
  change and the proposal is still queued; a retry with a normal KV →
  **200** with `already: true`, the proposal is removed, and the entry
  is byte-identical to the state after the first call's commit —
  including `metaUpdatedAt`, which the retry must **not** refresh.
  (e) Queue save fails (the stub fails `put` on `ext:pending` only,
  after the catalogue save) → **200** with `pendingCleanup: "failed"`,
  the change is applied, the proposal is still queued; a retry → **200**
  with `already: true`, the proposal is removed, the entry is unchanged
  by the retry. (f) Same as (e) but the retry's queue removal also
  fails → **200** with `pendingCleanup: "failed"` again, the entry is
  still applied exactly once.
- **R52 — metadata records excluded from discovery counts and
  publication totals; G1/G2 suite green.** (a) Queue a meta proposal →
  the pending GET's publication count (records with `kind` undefined or
  `"entry"`) is unchanged; the discovery state's
  `totals.discovered` / `totals.approved` / `totals.rejected` (read from
  the stub KV's `ext:discovery:state`) are byte-identical. (b) Approve
  the meta proposal → the three totals are still byte-identical. (c)
  Reject the meta proposal → the three totals are still byte-identical.
  (d) The full existing suite (**47 tests**: 9 Phase 2a + 38 hardening)
  passes on the new code. Note: R28 (external POST failure path) is
  re-targeted at the converted pending-write path with the same
  assertions; R25–R27 and R29–R32 are unaffected. The F1 repro tests
  (F1-A–E, N1–N4) are updated to the new expected behaviour: F1-A
  expects a queued candidate (not a live entry); F1-B expects the 400
  refusal; F1-C expects the read-only / proposal flow.

## 5. Remaining trade-offs and limitations

- **No KV atomicity.** The two-put sequence plus the already-applied
  self-heal is the mitigation, not a transaction. The residual is a
  proposal that stays queued after its change is live until a retry or
  a manual delete clears it — visible, retryable, never double-applied.
- **Eventual consistency (new, §2.4).** A retry's fresh read could
  theoretically observe pre-write state; the re-apply is idempotent
  (same values to the same fields), so the worst case is a redundant
  write of identical values plus a refreshed `metaUpdatedAt` — never a
  corruption.
- **The `expected` field is a snapshot, not a version counter.** There
  is no automatic merge of conflicting proposals; a stale proposal is
  rejected and the admin re-proposes with fresh expected values.
- **The `pendingId` format check is defence-in-depth, not the
  provenance guarantee** (§1.4). If the candidate-id format ever
  changes, the regex must be updated with it.
- **The admin lock is an in-memory promise chain** (worker.js:2204–
  2209). It serialises writes within the DO instance; it does not
  survive a restart — but a restart abandons in-flight work, so no
  torn state results.
- **One-admin caveat (unchanged):** proposer and approver are the same
  person, so the meta mechanism gives visibility plus a two-step
  barrier against silent/scripted changes — not separation of duties.
- **Legacy re-approval still changes the entry id** (force add → force
  approve → delete old), with a transient duplicate and a new
  `/view/ext/<id>` URL. The "adopt" enhancement remains a possible
  future option, not part of this release.

## 6. Exact intended files and routes to change

**One file: `worker.js`** in the staging repo
(`~/workspace/github-backup/sia-lab-worker/`, branch `main`), as a **new
commit on top of `88ef10b`** — never an amendment, rebase, or merge of
`88ef10b`. **One test file: `.phase2a-test/test_pending_sources.mjs`**
(add R38–R52). The CI workflow (`.github/workflows/test.yml`) needs no
change — it already runs both test files.

| Location | Change |
|---|---|
| `POST /api/admin/external` (worker.js:2622) | Convert to a pending-submission alias (validates like pending-add, writes to `ext:pending`, returns the pending id; writes nothing to `ext:movies`). |
| `POST /api/admin/extpublish` (2674) | Bounded provenance guard on the listing branch only (§1–§2 of the addendum, §1 here); hiding branch unchanged. |
| `POST /api/admin/extposter` (2660) | Remove as a direct-write route (function moves to the meta proposal). |
| `POST /api/admin/ytinfo` (2686) | Read-only lookup (returns `{ title, poster }`, writes nothing). |
| `DELETE /api/admin/external` (2708) | Unchanged. |
| `GET /api/admin/entries` (new) | Admin-only lookup (§3): title/id search over live entries including unlisted, minimal fields, no sources/URLs. |
| `POST /api/admin/pending/meta` (new) | Propose a metadata change (`targetId`, `changes: {title?, poster?}`, `expected` captured server-side); response echoes the target's current title. |
| `POST /api/admin/pending/approve` (2775) | Extend with the meta branch (§1–§2 of the addendum, §2 here); entry branch unchanged. |
| `POST /api/admin/pending/reject` (2829) | Skip `markSeen` + `bumpDiscoveryTotal` for `kind === "meta"`. |
| `POST /api/admin/pending/delete` (2848) | Skip `markSeen` for `kind === "meta"`. |
| `POST /api/admin/pending/sources` (2873) | 400 on `kind === "meta"`. |
| `findDuplicate` (760) | Skip `kind === "meta"` records in the queue scan. |
| `reconcileDiscoveryState` (605) | Explicit `kind === "meta"` skip (defence in depth). |
| ADMIN_PAGE queue UI (965–1030) | Split Publications / Metadata edits with separate counts; meta card with diff view and "Approve edit" wording; propose form with the lookup + manual-ID fallback. |
| `.phase2a-test/test_pending_sources.mjs` | Add R38–R52 (§4). |

## 7. Confirmation

This revision is **design-only**. No files were edited, no code was
implemented, no commit, push, PR, or deployment was made. The pinned
G1/G2 release (`88ef10b`) and production (`4f5ab64`) are untouched. No
production writes, deployment, or configuration changes were performed
or are authorised by this work. F2/G3 and F3 remain separate. Awaiting
the separate explicit implementation decision.
