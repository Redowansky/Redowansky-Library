# F1 Design Revision 2 — Server-enforced approval provenance + metadata review

**Commit reviewed:** `88ef10bc1054367df51be9e6c11a073f297b6538` (repo HEAD verified
2026-11-13 ~21:10 +06). G1+G2 deployment is on HOLD; this revision changes
nothing in that release or in production. Read-only design work only.

**Evidence files (same directory):** `F1_REPRO.mjs` (9 bypass/negative-control
tests, 9/9 pass) and `F1_FORGE.mjs` (7 provenance probes P1–P7, 7/7 pass).
Both run against a `worker.mjs` stub generated from the 88ef10b worker.js.

**What changed vs the first F1 proposal:** the first proposal used "entry has
a `pendingId`" as the approval test without proving the field could not be
forged, and it let `pendingId`-holding entries be edited freely. This
revision proves the provenance property empirically, defines the legacy
migration path, and replaces direct metadata edits with a reviewed
meta-edit mechanism.

## 1. Approval provenance

### 1.1 What the code actually guarantees (verified, not assumed)

`pendingId` appears in exactly **three** places in worker.js, all inside the
approve handler:
- worker.js:2812 — the **only assignment**: `extObj[liveId] = { id: liveId,
  pendingId: id, ... }`, where `id` is the candidate id from the queue.
- worker.js:2786 and 2796 — read-only idempotency / self-heal scans
  (`extObj[k].pendingId === id`).

No other route, function, or write path mentions the field. The direct POST
(2622–2658) destructures only `video_url, tmdb_id, type, title, sources,
poster` from the body and builds `meta` server-side; `pendingId` is never
spread from caller input. The pending-add route (2734–2764) generates the
candidate id server-side (`"p" + Date.now()...`) and never reads a body id.

**Probes P1–P7 (`F1_FORGE.mjs`, 7/7 pass on 88ef10b):**
- P1: direct POST with `pendingId: "p-forged"` in the body → created entry
  has no `pendingId`.
- P2: pending add with `id: "p-chosen"` + `pendingId: "p-forged"` → queued
  candidate has a server-generated id and no `pendingId`.
- P3–P5: extpublish / extposter / ytinfo with `pendingId` in the body →
  the entry's `pendingId` is unchanged (absent).
- P6: approve with an unknown id → 404, catalogue unchanged (no forged
  approval).
- P7 (positive control): pending add → approve → the live entry carries
  `pendingId` equal to the server-generated candidate id.

**Conclusion:** `pendingId` is assigned exclusively by the successful
server-side approval operation, and no caller-supplied identifier can
reach the field. "Entry carries a `pendingId`" is therefore a genuine
provenance signal — with one maintenance condition: the regression suite
must pin this property (P1–P5 become permanent regression tests, §4), so
no future code path can start writing the field.

### 1.2 Why the seen-map is NOT a provenance cross-check

`markSeen` (worker.js ~640–655) records approvals in `ext:discovery:seen`
keyed by `<type>:<tmdb>`, but it cannot serve as a second provenance
source:
- It is best-effort (wrapped in try/catch; a failure does not fail the
  approve), so an approved entry may have no seen record.
- It only records entries **with a TMDB** (`if (!cand || cand.tmdb == null)
  return`); TMDB-less entries have no record.
- It is keyed by TMDB, not by candidate id, so it cannot confirm *which*
  approval produced a given entry — and a stale `"approved"` status for a
  TMDB survives after the entry is deleted.
The design therefore does **not** cross-check the seen-map. Provenance
rests on the write-path exclusivity above, pinned by tests.

### 1.3 The provenance rule

> An ext entry is **approval-proven** iff it carries a `pendingId` field.
> The field is written only by the approve operation (worker.js:2812).
> Any operation that publishes, lists, or edits an entry must check this
> field; no operation may write it except approve.

No KV schema change is needed: the field already exists, and the rule uses
only the existing `ext:movies` and `ext:pending` keys.

### 1.4 Legacy entries (the 11 live entries, 0 approvals so far)

All 11 live ext entries predate the queue (totals approved = 0), so **none**
carries a `pendingId` and none carries a `createdAt` (ext entries have no
timestamp field — there is no way to distinguish legacy entries by age).
They keep their current visibility: 10 listed stay listed and playable,
1 unlisted (the WALL·E Lulustream test entry) stays unlisted. No action is
required for them today.

**Migration / re-approval path (no new code, uses only existing routes):**
for a legacy entry that needs listing via extpublish or a metadata edit,
1. Add it as a pending candidate with `force: true` (the add route's dup
   check 409s on the existing live entry; force overrides it).
2. Approve with `force: true` (the approve dup check also 409s; force
   overrides it). This creates a **new** live entry with `pendingId`,
   using the candidate's reviewed sources.
3. Delete the legacy entry via `DELETE /api/admin/external`.
- Transient state: two live entries for the same title exist between steps
  2 and 3 (seconds, a deliberate admin action). The admin deletes the old
  one immediately.
- Consequence to know: the re-approved entry gets a **new id** (and a new
  `/view/ext/<id>` URL); the old direct URL stops working once the legacy
  entry is deleted. For the unlisted test entry that is acceptable; for a
  listed entry it is a visible URL change, so re-approval is only done
  when an edit or flip is actually needed.
- Optional future enhancement (NOT recommended for this release): an
  "adopt" branch inside approve — when the dup found is a legacy entry
  (no `pendingId`), stamp the *existing* entry with `pendingId` (and the
  candidate's reviewed sources) instead of creating a duplicate. One step,
  no transient duplicate, no URL change. Rejected for now because it adds
  a surprising new behaviour to the most sensitive handler; the manual
  path above is sufficient and uses only tested operations.

**Consequence of the rule for legacy entries, stated plainly:** a legacy
entry that is unlisted can never be re-listed via extpublish (it has no
`pendingId`) — it must be re-approved first. Likewise its title/poster
cannot be edited via the legacy routes. That is the policy working as
intended, not a bug; the migration path above is the way back in.

## 2. Post-approval metadata modification

### 2.1 The problem with the first proposal

"Entry has a `pendingId`" proves the entry was approved — it says nothing
about whether a *later* change was approved. Under the first proposal, any
admin-authenticated call could still silently rewrite an approved entry's
title (ytinfo takes the title from an arbitrary YouTube video) or poster.
Approval history is not approval of future edits.

### 2.2 The mechanism: metadata-edit proposals in the existing queue

A small approval mechanism reusing the pending queue — no new KV key, no
new catalogue field except one timestamp (see §2.4):

- **Record shape** (stored in the existing `ext:pending` key):
  `{ id: "pm" + ..., kind: "meta", targetId: <live entry id>,
  targetTitle: <current title, display only>, changes: { title?: string,
  poster?: string }, status: "pending", createdAt }`.
  The proposed title/poster live inside `changes` only. The record carries
  **no top-level `tmdb` or `title`** that could be mistaken for a
  publication candidate.
- **Propose route** — `POST /api/admin/pending/meta` (new, admin-only):
  validates that the target entry exists in `ext:movies`; at least one
  change is present; a proposed title is a non-empty string (capped);
  a proposed poster passes `cleanImgUrl`. Any existing live entry may be
  the target — including a legacy one (a metadata fix on an already-public
  legacy entry does not newly publish anything, and the change itself is
  still reviewed). **Sources are never editable through this mechanism**
  (changing what plays is equivalent to re-publishing; it requires full
  re-approval via a new candidate).
- **Approve** — the existing `POST /api/admin/pending/approve` is extended
  to branch on `kind: "meta"`: it re-validates the changes, checks the
  proposed title against the live catalogue (excluding the target entry
  itself) and refuses on duplicate (409), applies the changes to the
  target entry, sets `metaUpdatedAt: Date.now()` on the entry, and deletes
  the proposal from the queue. If the target entry no longer exists, the
  approve returns 404 and the proposal stays queued for the admin to
  delete.
- **Reject / delete** work on meta proposals generically (they operate on
  the queue record, not on the entry). **Sources editing refuses meta
  records** (`POST /api/admin/pending/sources` must 400 on `kind: "meta"`,
  since they have no sources field).
- **Queue interactions, made explicit:** `findDuplicate` (worker.js:760)
  must skip records with `kind === "meta"` in its queue scan, so a meta
  proposal is never mistaken for a publication candidate by the add route
  or by discovery's dedupe second pass (worker.js ~2095–2102, which scans
  the queue through `findDuplicate`). Discovery's first pass uses only the
  seen-map, so meta records do not affect it.

### 2.3 ytinfo and extposter under the new design

- **`POST /api/admin/ytinfo` becomes a read-only lookup.** It still takes
  a YouTube URL, still calls oEmbed, but returns `{ title, poster }`
  without writing anything. The admin uses the returned values to submit
  a meta proposal. Its useful function (fetching YouTube metadata) is
  preserved; its silent-write capability is removed.
- **`POST /api/admin/extposter` is removed as a direct-write route.**
  Its function (set a poster from an explicit URL) is subsumed by the meta
  proposal, which takes an explicit poster URL. (Equivalent alternative:
  keep the endpoint as an alias that creates a meta proposal instead of
  writing directly. Removal is recommended — one write path is easier to
  reason about than two.)
- **Title changes have no direct-write path at all.** The only way a live
  entry's title changes is an approved meta proposal.

### 2.4 Trade-offs, stated before the recommendation

- **Uniform rule (recommended): both title and poster go through
  meta-approval.** One invariant — "a live entry's title/poster changes
  only via an approved meta proposal" — no silent metadata changes of any
  kind. Cost: a poster fix becomes two steps (propose → approve) instead
  of one call. Poster fixes are rare, and the admin UI already has an
  Approve button per queue item, so the extra step is one tap in the same
  queue view.
- **Alternative — risk-based split:** title via meta-approval, poster
  directly on approval-proven entries. Less friction for poster fixes,
  but poster changes remain silent, and two rules must be enforced
  instead of one. Rejected as the primary because it leaves the "silent
  change" class half-open.
- **One-admin caveat (honest):** the proposer and the approver are the
  same person — Redowan is the only admin. This mechanism therefore does
  **not** provide separation of duties. What it does provide: (a) no
  silent change — every change is a visible proposal in the queue before
  it goes live; (b) a single compromised, stale, or scripted call cannot
  rewrite metadata — it takes two distinct operations; (c) the admin
  reviews the exact change in the queue UI before it applies; (d) the
  change is attributable to an explicit approve action. If a second admin
  is ever added, the same mechanism becomes real separation of duties
  with no redesign.
- **Audit trail:** the applied change sets `metaUpdatedAt: Date.now()` on
  the entry (one optional field, set only by the meta-approve step). The
  proposal itself is deleted on approve, consistent with entry
  candidates. A full before/after history is deliberately NOT added —
  that would be a larger schema change for marginal value while there is
  one admin.
- **Scope guard:** the mechanism covers title + poster only. Sources,
  URL, type, and TMDB are not editable through it.

## 3. Revised route policy

Auth for every admin route: `checkPw` — the `?pw=` query parameter must
equal the stored admin password (worker.js:215–218). A wrong or missing
password is 403 on every route below. All write routes run inside
`_withAdminLock`; a KV read failure aborts with a generic 500 and no
write (the G1/G2 pattern).

| Route | Permitted operation | Approval requirement | Failure responses |
|---|---|---|---|
| `POST /api/admin/external` | **Converted to a pending-submission alias.** Validates exactly like the pending-add route (URL rules, TMDB enrichment, dup check), then writes a candidate to `ext:pending` (status `"pending"`) and returns the pending id. Writes **nothing** to `ext:movies`. | The submission itself needs no prior approval (it *is* the submission). Publication still requires a separate approve. | 400 missing/invalid URL or title; 409 duplicate (unless `force`); 500 unreadable store, nothing written |
| `POST /api/admin/extpublish` | Flip `unlisted` on an existing entry. **Unlisting (`unlisted: true`) is allowed on any entry.** **Listing (`unlisted: false`) is allowed only when the entry carries a `pendingId`.** | Listing requires approval provenance (§1.3). Unlisting requires none (safe direction). | 403 wrong pw; 404 unknown id; 400 listing an entry without `pendingId` ("not approved — re-approve via the queue") |
| `POST /api/admin/extposter` | **Removed** (direct write). Poster changes go through `POST /api/admin/pending/meta`. | — | 404 route gone (or, if kept as an alias, it creates a meta proposal and returns the proposal id — never a direct write) |
| `POST /api/admin/ytinfo` | **Read-only lookup.** Given a YouTube URL, returns `{ title, poster }` from oEmbed. Writes nothing. | None (no write). The returned values are used to submit a meta proposal if the admin wants them. | 400 not a YouTube link; 502 lookup failed; 403 wrong pw |
| `DELETE /api/admin/external` | Delete any ext entry by id. **Unchanged.** | None — removal is the safe direction and the workflow has no removal step. Documented as the intentional catalogue-removal path. | 403 wrong pw; 200 on success (deleting a missing id is a no-op 200, as today) |
| `POST /api/admin/pending` | Add an entry candidate to the queue. Unchanged (dup check, `force` override, strict reads). | Submission needs no prior approval; publication requires approve. | 400 missing title; 409 duplicate (unless `force`); 500 unreadable store |
| `POST /api/admin/pending/approve` | **Extended.** Entry candidates: existing behaviour (requires status `"pending"`, ≥1 source, dup check, publishes with `pendingId`, deletes the candidate). Meta proposals (`kind: "meta"`): re-validates changes, dup-checks the proposed title against the live catalogue (excluding the target), applies title/poster to the target entry, sets `metaUpdatedAt`, deletes the proposal. | The approve step *is* the approval. Entry approve requires a pending candidate; meta approve requires a pending meta proposal. | 404 unknown id / target gone; 400 not pending, no sources (entry), no changes (meta); 409 duplicate; 500 unreadable store |
| `POST /api/admin/pending/meta` | **New.** Submit a metadata-change proposal for a live entry: `{ targetId, changes: { title?, poster? } }`. | The proposal itself needs no prior approval; applying it requires approve. Target may be any live entry (approval-proven or legacy). | 403 wrong pw; 404 unknown target; 400 no changes / invalid title or poster URL; 500 unreadable store |
| `POST /api/admin/pending/reject` | Mark any pending record (entry or meta) as `"rejected"`. Unchanged. | None (it only removes from consideration). | 403 wrong pw; 404 unknown id |
| `POST /api/admin/pending/delete` | Delete any pending record (entry or meta). Unchanged. | None. | 403 wrong pw; 404 unknown id |
| `POST /api/admin/pending/sources` | Edit a **pending entry candidate's** sources. Unchanged, plus: refuses `kind: "meta"` records (400). | The edit is on a queued candidate, not a live entry; approve still required to publish. | 400 not pending / not an entry candidate / invalid URL; 404 unknown id |

### State-transition examples

- **Direct publish (new behaviour):** catalogue {A} + queue {} → POST
  /api/admin/external {title B} → 200 `{ok, id: "p-…", queued: true}` →
  catalogue {A}, queue {B pending}. B is NOT in `/api/movies`.
- **Listing an unapproved entry:** entry E, no `pendingId`, unlisted →
  extpublish `{unlisted: false}` → 400 "not approved" → E stays unlisted,
  public feed unchanged. After re-approval (force add → force approve →
  delete old E), the new entry E′ carries `pendingId` → extpublish
  `{unlisted: false}` → 200, E′ public.
- **Title change (new behaviour):** live entry E, title "Old" → POST
  /api/admin/pending/meta `{targetId: E, changes: {title: "New"}}` → 200,
  proposal queued, E still "Old" and public → approve → 200, E title
  "New", `metaUpdatedAt` set, proposal gone. A ytinfo call in between
  returns the YouTube title but changes nothing.
- **Hiding (unchanged, safe):** live entry E, listed → extpublish
  `{unlisted: true}` → 200 → E leaves the public feed immediately.
- **Deletion (unchanged):** live entry E → DELETE → 200 → E gone from
  catalogue and feed, queue untouched.

## 4. Regression plan (R38–R52, all local stubs)

Extend `.phase2a-test/test_pending_sources.mjs` when implementation is
authorized. Harness: the existing `makeKV`/`makeDO`/`call` helpers plus
the real `listMovies()` (stubbed `s3fetch`, as in R30–R32) and the public
`/api/movies` read for visibility. Every failure-path test asserts the
stored KV strings are byte-identical afterwards.

- **R38 — forged `pendingId` via direct POST (P1 as a regression test).**
  POST /api/admin/external with `pendingId` in the body → the queued
  candidate has no `pendingId`.
- **R39 — forged `pendingId` / chosen id via pending add (P2).** Body
  carries `id` + `pendingId` → candidate id is server-generated,
  `pendingId` absent.
- **R40 — forged `pendingId` via extpublish / extposter / ytinfo (P3–P5).**
  Each call with `pendingId` in the body → the entry's `pendingId`
  unchanged (absent).
- **R41 — approve with an unknown id (P6).** → 404, catalogue unchanged.
- **R42 — legacy entry cannot be listed.** Unlisted entry without
  `pendingId` → extpublish `{unlisted: false}` → 400, public feed
  unchanged, entry still unlisted. Same entry after re-approval (force
  add → force approve → delete old) → the new entry lists via extpublish.
- **R43 — legacy entry metadata.** Direct poster/title write refused;
  meta proposal for the legacy entry → 200 (queued, entry unchanged);
  approve → title/poster applied, `metaUpdatedAt` set, entry still has
  no `pendingId` (meta approval does not grant publication provenance).
- **R44 — meta proposal lifecycle.** Title change proposed → entry title
  unchanged and still public until approve → approve → title changed,
  proposal deleted, `metaUpdatedAt` set. Reject path: proposal rejected →
  approve → 400, entry unchanged.
- **R45 — meta proposal validation.** No changes → 400. Unknown target →
  404. Proposed title duplicating another live entry → 409 at approve
  (target entry itself excluded). Proposal carrying `sources` → 400.
  Sources route on a meta record → 400.
- **R46 — ytinfo is read-only.** Call with a stubbed oEmbed response →
  200 with `{title, poster}` returned, entry byte-identical, catalogue
  and queue byte-identical.
- **R47 — extposter removed.** Direct poster write → 404 (or, if the
  alias option is chosen, a meta proposal is created and the entry is
  byte-identical until approve).
- **R48 — safe hiding.** extpublish `{unlisted: true}` on any entry
  (approval-proven or legacy) → 200, entry leaves the public feed.
- **R49 — safe deletion.** DELETE a live entry → 200, catalogue and
  public feed lose the entry, queue unchanged.
- **R50 — duplicate submissions.** Converted direct POST duplicating a
  live entry → 409; same call with `force: true` → queued (not
  published). Meta proposal whose new title duplicates another live
  entry → 409 at approve.
- **R51 — strict KV read failures (G1 pattern).** Simulated read failure
  during the converted direct-POST write → 500, queue + catalogue
  byte-identical. During meta-approve → 500, entry + queue
  byte-identical. During the extpublish provenance check → 500, entry
  byte-identical.
- **R52 — G1/G2 suite green.** The full existing suite (47 tests) passes
  on the new code. Note: R28 (external POST failure path) must be
  re-targeted at the converted pending-write path with the same
  assertions; R25–R27 and R29–R32 are unaffected. The F1 repro tests
  (F1-A–E, N1–N4) are updated to the new expected behaviour: F1-A now
  expects a queued candidate (not a live entry); F1-B expects the 400
  refusal; F1-C expects the read-only / proposal flow.

## Recommendation

Implement the design in §2–§3 as one scoped change: convert the direct
POST to a pending alias, gate extpublish listing on `pendingId`, replace
direct metadata writes with the meta-proposal flow (ytinfo read-only,
extposter removed), and leave DELETE unchanged. No KV schema change is
required (the meta record lives in the existing `ext:pending` key; the
only new field is the optional `metaUpdatedAt` on entries). The admin UI
needs a small addition to render meta proposals in the queue and to call
the new propose route; the approve button it already has applies them.
Android playback is unaffected (it reads `/api/movies` only), and the
existing 11 entries keep their visibility.

**Nothing in this revision is implemented.** No code was edited, no commit,
push, or deployment was made. Awaiting review and separate authorization
before implementing.
