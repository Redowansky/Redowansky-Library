# F1 Storage-Safety Addendum — the whole-object KV lost update

**Design-only.** No code was edited, no commit, push, PR, or deployment
was made. F1 remains a separate commit on top of pinned `88ef10b`; G1/G2
remain pinned and unchanged; production remains on `4f5ab64`. The
storage change proposed in §5 is **explicitly proposed here and needs
separate review** — it is not authorised by this document.

**The flaw this addendum addresses:** the earlier design said a retry
is safe because it "reapplies only the proposal's specified fields to
the fresh target object". That is insufficient. `ext:movies` is stored
as **one whole-object KV value**, so a retry that modifies one field in
memory still saves the entire catalogue object — and if the snapshot it
read from was stale, the write-back restores every other field to its
old value, losing newer changes. This addendum works the problem
through to a guaranteeing fix.

## 1. Every writer of `ext:movies` — the complete set

`saveExtMovies(env, obj)` (worker.js:540) is the **only** function that
writes the `ext:movies` KV key. It has exactly six call sites, each
inside a `_withAdminLock` callback (lock start → save):

| Route | Lock starts | Save |
|---|---|---|
| `POST /api/admin/external` (direct publish) | 2647 | 2651 |
| `POST /api/admin/extposter` | 2663 | 2667 |
| `POST /api/admin/extpublish` | 2677 | 2681 |
| `POST /api/admin/ytinfo` | 2688 | 2703 |
| `DELETE /api/admin/external` | 2712 | 2715 |
| `POST /api/admin/pending/approve` (entry publish) | 2781 | 2813 |

No other code path writes the catalogue. `runDiscovery` writes only
`ext:pending` (savePending, 2150); the reconciler writes only
`ext:discovery:seen` and `ext:discovery:state`; the scheduled handler
and the upload route do not touch the catalogue. The only live reader
and writer of `ext:movies` is the DO itself (all access goes through
its HTTP API); the `ext:movies` mentions outside worker.js are a
backup dump (`~/workspace/sia-lab/disaster-kit/kv-dump.json`), its
restore doc, build scripts, and the test stub — not live readers.

**Conclusion:** all catalogue writers are serialized through the same
authoritative writer — the single `main-v35` DO instance, via the
in-memory promise-chain lock. There is no second writer path. The
problem is therefore not a second writer; it is what the lock does and
does not guarantee about storage (§2).

## 2. What `_withAdminLock` does and does not do

`_withAdminLock` (worker.js:2204–2209) is an in-memory promise chain on
the DO instance. It **does**:
- Serialise the *execution* of admin write callbacks within the one DO
  instance. Two catalogue writes cannot interleave their
  read-modify-write cycles in time: writer 2's callback does not start
  until writer 1's callback has resolved (i.e. until writer 1's `put`
  promise resolved).
- Survive restarts correctly: Durable Objects guarantee at most one
  active instance per name, so a replacement instance starts with a
  fresh lock and no in-flight work from the old instance.

It does **not**:
- Provide a KV transaction or compare-and-swap. Cloudflare KV has no
  CAS API and no multi-key transaction.
- Provide read-your-writes for KV. Cloudflare KV is **eventually
  consistent**: a `get` after a `put` may be served from a replica that
  has not yet received the write. The `put` promise resolving means the
  write was accepted, not that every replica can see it.
- Protect against a stale read. A read inside the lock can return a
  stale replica even though it executes after the previous writer's
  `put` resolved — because the lock orders *execution*, not *storage
  visibility*.

So the lock eliminates execution-level races (two writers interleaving)
but leaves the storage-level race (a writer reading a stale replica).
The lost update in §3 needs only the second one.

## 3. The lost update, worked through the user's six steps

Setup: entry E has `title: "A"`, `poster: "P"`, `overview: "Old"`.

1. Entry E has title A and poster P (and overview "Old").
2. Another operation successfully changes an unrelated field to N —
   say `extposter` sets nothing, but a metadata approval (or any
   writer) sets E's `overview` to `"New"`. Its `put` resolves; the
   write is committed in KV.
3. A metadata approval for E's title reads the catalogue — but its
   `get` is served from a KV replica that has not yet received step
   2's write. Its snapshot has `overview: "Old"`.
4. A retry reads a stale replica that still lacks N (same lag).
5. The retry changes only the proposed title in memory — but the
   object it holds has `overview: "Old"`.
6. The retry saves the entire catalogue object. The whole-object write
   restores `overview` to `"Old"`, **losing N**.

The code modifying "only the proposal's fields" does not prevent this:
the in-memory modification is field-scoped, but the *storage* write is
whole-object-scoped. The stale snapshot's old values for every other
field are written back along with the one changed field. The
expected/proposed/neither check does not catch it either — it compares
only the fields the proposal changes (title), not the unrelated field
(overview), so a stale value in an unrelated field passes the check
silently.

**Scope note:** this risk is pre-existing, not introduced by F1. All
six writers share it (any of them can read a stale snapshot and write
it back). F1's meta-approve adds one more read-modify-write path with
the same risk. Fixing it for the catalogue fixes it for all six writers
at once.

## 4. Why re-reading before the write does not fix it

A fresh read immediately before the write narrows the window, but the
re-read can itself be served from the same stale replica — there is no
way, using KV alone, to force a read to return the latest committed
value, and no way to make the write conditional on the storage state
(KV has no CAS). A read-then-write sequence is two independent
operations with no atomicity between them, however close together they
run. This is the point the user already ruled out; it is restated here
because it is the reason the fix must be architectural, not procedural.

## 5. The plain statement, and the proposed architecture

**Plain statement:** the existing KV architecture (one whole-object
value, no CAS, eventual consistency) **cannot guarantee** that a retry
never overwrites an unrelated newer catalogue field. `_withAdminLock`
serialises execution but not storage visibility, and no re-read, version
check, or freshness gate built on KV reads can close the gap, because
every one of those reads can itself be stale.

**Smallest viable architectural change — move `ext:movies` from KV
into the DO's own storage (`this.state.storage`).** This is explicitly
proposed here as a **storage change requiring separate review**.

Why it guarantees the property (verified against Cloudflare's Durable
Objects documentation):
- Durable Object storage is **strongly consistent**: reads always
  return the latest committed value — there is no stale replica. The
  transactional storage API wraps each method in a transaction, so
  results are atomic and isolated, and `state.storage.transaction()`
  provides all-or-nothing multi-key updates.
- The DO is single-instance and single-threaded, so all catalogue
  access already flows through one actor; moving the value into its
  own storage makes the read in the meta-approve guaranteed-fresh.
- With a guaranteed-fresh read, the existing design is sufficient: the
  approve reads the latest entry (including N), applies only its
  proposed fields, and writes back a whole object that includes N. The
  lost update becomes impossible — there is no stale snapshot to write
  back.

Why this is the smallest change:
- It uses a store the DO **already uses** (`state.storage` already
  holds `admin_pw`, `tmdb_key`, view counters, and per-object metadata
  — worker.js:208, 1838–1871, 1943, 2966–3042). No new service (D1
  would be a bigger introduction), no new backend (the existing
  key-value storage API is used, not a SQLite migration).
- The HTTP API is unchanged: the app, the site, and the admin UI all
  read through the DO's endpoints, never directly from KV. Only the
  DO's internal get/save functions for `ext:movies` change (from
  `env.DATA_KV` to `this.state.storage`).
- The code change stays within `worker.js` + the test file. The
  `state.storage` stub in the test harness already exists (it serves
  `admin_pw`/`tmdb_key`); it is extended to serve the catalogue.

**What the move does and does not fix:**
- It **fixes** the stale-read lost update (§3) for all six catalogue
  writers, because every catalogue read becomes strongly consistent.
- It does **not** make the meta-approve's two writes atomic: the
  catalogue would live in DO storage while the queue stays in KV, so
  the catalogue-first / queue-cleanup-second sequence and its
  self-heal (§1.3 of the addendum) still apply. A DO-storage
  transaction cannot span KV. Moving the queue too would make the
  approve fully atomic, but that is a larger migration and is **not**
  required for this gate.
- The queue (`ext:pending`) has the same theoretical whole-object
  stale-read risk. It is out of scope for this gate; the same approach
  would fix it if the user wants it later.

**Migration (one-time, separately reviewed):** an admin-gated
one-time copy of the `ext:movies` value from KV into DO storage,
performed explicitly (not as a silent fallback — a fallback read would
reintroduce dual-source ambiguity), verified by comparing the entry
count and a hash before the code is deployed reading DO storage. The
KV key is left in place as a backup until the migration is verified.
**Operational consequences to update as part of the storage change:**
the disaster kit's `kv-dump.json` + `RESTORE.md` reference the KV key
(the restore procedure must be updated to the DO-storage path); the
post-deploy checks that assert KV state ("live 11") must read the count
from the admin API (the new `GET /api/admin/entries` returns it)
instead of from KV; the G1/G2 strict-read pattern still applies to
DO-storage reads (a failed read aborts with a generic 500, never an
empty catalogue).

**If the storage change is not approved**, the honest options are:
(a) accept the residual — the meta-approval feature ships with the
known stale-read lost-update risk, mitigated by lock serialisation, a
fresh read immediately before the write, and the per-field check, with
the risk documented and R58 (below) recorded as a known-failing
demonstration rather than a passing test; or (b) defer the
meta-approval flow (keep the direct-write removal and the extpublish
guard, which do not add a new read-modify-write path) until the
storage change is approved. The direct-publish conversion and the
extpublish guard do not need the migration; only the meta-approve's
read-modify-write does.

## 6. Alternatives considered — and why they do not guarantee it

- **Per-entry KV keys** (`ext:movie:<id>`). Eliminates *cross-entry*
  lost updates (a stale read of entry X cannot affect entry Y), but
  **not** same-entry lost updates: a stale read of entry X's key can
  still lose a newer field of entry X. It reduces the blast radius
  without guaranteeing the property, and it is a larger change to
  `listMovies` (list + multi-get) than the DO-storage move.
- **Version / freshness gate** (refuse the approve if the entry's
  `metaUpdatedAt` differs from the proposal's captured value). Detects
  *concurrent* changes, but not a *stale read*: a stale snapshot shows
  the old version, which matches the proposal's captured value, so the
  gate passes and the write-back still loses N. It fixes a problem the
  lock already fixes, not the one in §3.
- **Re-reading before the write.** Ruled out in §4: the re-read can be
  stale too.
- **Accept the residual.** Honest, and the probability is low in
  practice (same-location KV reads are typically consistent; the lock
  removes execution races). But it does not *prevent* the loss, and the
  loss is silent (a metadata field reverts with no error). Presented
  as option (a) in §5, not recommended.

## 7. Regression tests R58–R60

Harness: the existing stub harness, extended with (i) a
`makeStaleKV` wrapper — an eventually-consistent KV stub with an
authoritative map (what `put` writes) and a replica map (what `get`
returns), where the replica only catches up when the test explicitly
propagates; and (ii) the `state.storage` stub extended to serve the
catalogue authoritatively (a single map; `get` always returns the
latest `put`), simulating DO storage. Suite total becomes **70 tests**
(47 existing + 15 R38–R52 + 5 R53–R57 + 3 R58–R60).

- **R58 — stale catalogue read cannot lose an unrelated newer field
  (the required test).** Setup: the DO-storage stub holds entry E
  (`title: "A"`, `poster: "P"`, `overview: "Old"`). A direct write
  (simulating another operation) updates E's `overview` to `"New"` in
  the authoritative store. The KV layer is seeded with a stale snapshot
  of the catalogue (`overview: "Old"`) to prove the implementation does
  not read the catalogue from KV. Invoke the meta-approve for a title
  change (propose → approve). **Assert:** after the approve, the
  authoritative entry has the proposed title **and** `overview:
  "New"` (N survives); the proposal is removed; `metaUpdatedAt` is
  set. **Why it proves the property:** on the proposed architecture
  the approve reads the catalogue from strongly-consistent DO storage,
  so its read sees `"New"` and its write-back includes it. The same
  test run against the current KV code **fails** (the approve reads the
  stale KV snapshot and writes `overview: "Old"` back) — demonstrating
  the gap the migration closes. R58 is a passing test on the new
  architecture and a documented failing demonstration on the old one.
- **R59 — concurrent same-entry field change is preserved (fresh
  state).** A second operation changes a different field of the same
  entry (the poster) between the proposal and the approve, with no
  staleness involved. The approve applies only its title change.
  **Assert:** the entry ends with the proposed title **and** the newer
  poster; the unrelated field was never touched by the approve.
- **R60 — cross-entry isolation.** A change to a different entry's
  field survives a meta-approve on another entry. **Assert:** the other
  entry is byte-identical after the approve (the whole-object
  write-back did not clobber it).

## 8. Wording corrections

- **R42, 9-character case.** Describe it as **"the shortest accepted
  sanity-check value, not necessarily a real generated candidate ID."**
  A real generated id is 13 characters today (verified); a 9-character
  id would require an empty random part, which is theoretically
  possible but was not observed in 10,000 samples. The 9-character
  test is a boundary of the sanity check, not a claim about real ids.
  (The R42 test name/comment in the test file must use this wording.)
- **Admin lookup route authorisation.** The route is
  **authentication-protected, not inaccessible publicly.** Distinguish
  the two properties: (a) *discoverability* — the route is not linked
  from any public page; (b) *authorisation* — the route is
  `checkPw`-gated and returns 403 without a valid admin password. The
  route **is** reachable over HTTP by anyone; its security comes from
  the password gate, not from obscurity. Earlier wording that implied
  the route is "not reachable publicly" is corrected to the two
  properties above.

## 9. Decision point and scope

- The storage change (move `ext:movies` from KV to DO storage) is
  **explicitly proposed here and needs separate review**. It is not
  part of the F1 code change unless that review approves it.
- If approved, the code change stays within `worker.js` + the test
  file; the additional work is the one-time migration, the disaster-kit
  restore-procedure update, and the post-deploy verification-path
  update (all procedures, reviewed with the storage change).
- If not approved, the options are §5(a) accept the residual (with
  R58 recorded as a known-failing demonstration) or §5(b) defer the
  meta-approval flow. The direct-publish conversion, the extpublish
  guard, ytinfo's read-only conversion, and extposter's removal do not
  depend on the migration and can proceed either way.
- Everything else remains pinned: F1 as a separate commit on top of
  `88ef10b`; G1/G2 unchanged; production on `4f5ab64`; no
  implementation, commit, push, PR, or deployment yet.

## 10. Confirmation

This addendum is **design-only**. No files were edited, no code was
implemented, no commit, push, PR, or deployment was made. The pinned
G1/G2 release (`88ef10b`) and production (`4f5ab64`) are untouched.
Awaiting the separate explicit implementation decision — including,
now, a separate decision on the proposed storage change.
