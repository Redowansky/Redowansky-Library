# F1 Migration-Readiness Addendum — backend, source of truth, cutover and rollback

**Design-only.** No code was edited, no commit, push, PR, or deployment
was made. F1 remains a separate commit on top of pinned `88ef10b`; G1/G2
remain pinned and unchanged; production remains on `4f5ab64`. The
storage migration, the freeze-flag pre-migration deploy, and the staging
Worker proposed here all need separate approval.

## 0. Headline finding — the backend is NOT yet determined

The storage-safety addendum proposed moving `ext:movies` into the DO's
own storage on the assumption that the DO's storage is strongly
consistent. That assumption is correct for **both** backends — but the
per-value limit differs by 64×, and the backend **cannot be determined
from the code or configuration in this workspace**. The migration must
not proceed until the backend is confirmed (§1). This is the single
most important finding in this addendum.

## 1. The actual DO storage backend and limits

### 1.1 What the code and config show

- `deploy_worker.py` deploys via the Cloudflare API
  (`PUT /accounts/{ACCT}/workers/scripts/sia-lab`) with
  `compatibility_date: "2025-10-01"` and bindings for `TUNNEL_DO`
  (class `TunnelDO`), `DATA_KV`, `MEDIA`, `MAILER`. The metadata has
  **no `migrations` key** — the comment reads *"migrations only
  needed once (class already created); omit on updates"*.
- There is **no `wrangler.toml` / `wrangler.json` anywhere** in the
  workspace, **no `new_sqlite_classes` anywhere**, and **no "sqlite"
  mention anywhere** in `~/workspace/sia-lab/` or `worker.js`.
- The git history starts at the "Initial backup 2026-10-20" commit
  (`8ee2dc0`); `idFromName("main-v35")` is present from the first
  commit. The class predates the repo's backup history, and the
  "v35" name implies many prior versions. The class was created before
  2026-10-20 — but exactly when, and with which migration payload,
  is not recorded in the workspace.
- The code uses only the key-value storage API
  (`state.storage.get` / `put` / `delete` / `list` / `transaction`)
  for `admin_pw`, `tmdb_key`, view counters, and per-object metadata.
  **Both backends support this API**, so the API usage does not
  distinguish them. The distinguishing APIs — `state.storage.sql`
  (SQLite only) and `state.storage.kv` (SQLite only) — are not used
  anywhere.

### 1.2 What the evidence points to — and why it is not proof

The evidence points toward **legacy KV-backed** storage: no SQLite
migration was ever recorded, the class predates the SQLite-default era
(SQLite-backed DOs became the recommended/GA backend in April 2025,
and the class name implies a history older than that), and the deploy
script has never carried a `new_sqlite_classes` payload. But this is
an **inference, not proof**. The compatibility date (`2025-10-01`)
does not determine the backend — the backend is fixed when the class
is provisioned, not by the Worker's compatibility date. **Do not
assume the backend from the presence of `state.storage`.**

### 1.3 How to determine the backend definitively

One of the following, before any migration step:

1. **Cloudflare dashboard** (the reliable path, no code): Workers &
   Pages → the `sia-lab` Worker → Durable Objects → the `TunnelDO`
   namespace → the storage type is shown (SQLite or key-value).
2. **Runtime probe in a staging DO**: create a staging DO with the
   same class and check whether `state.storage.sql` exists — present
   only on SQLite-backed DOs. (This is the same staging DO proposed
   in §6.3.)
3. **Cloudflare API**: the Durable Object namespace listing for the
   account (the dashboard reads the same data).

**Gate:** the migration does not proceed until the backend is
confirmed by one of these. If the dashboard and the staging probe
disagree, stop and investigate — do not pick the more convenient
answer.

### 1.4 The limits, verified against Cloudflare's current docs

(Cloudflare Durable Objects limits page, updated 2026-11-13; the
8 MB / 128 KiB figures the user gave match the current docs.)

| | SQLite-backed | Legacy KV-backed |
|---|---|---|
| **Value size** | key + value combined ≤ **8 MB** (8,388,608 B) | **128 KiB** (131,072 B) |
| **Key size** | key + value combined ≤ 8 MB | 2 KiB (2,048 B) |
| **Storage per DO** | 10 GB (Paid) / **1 GB (Free)** | Unlimited |
| **Storage per account** | Unlimited (Paid) / **5 GB (Free)** | 50 GB |
| **Strong consistency** | Yes | Yes |
| **Switchable in place** | — | **No.** "Older classes created with the key-value backend cannot be switched to SQLite in place. Cloudflare says a migration path is planned." |

### 1.5 What each backend means for this migration

- **If SQLite-backed:** the whole-object move is viable with no size
  concern (§2: the ceiling is ~13,000 entries). Proceed as designed.
- **If legacy KV-backed:** the whole-object move is viable **now**
  but has a hard ceiling of **~130–200 entries** (§2). Switching to
  SQLite would require a **new DO class**, which breaks the `main-v35`
  identity — `idFromName("main-v35")` on a new class addresses a
  different, empty DO instance, and all DO-storage state (`admin_pw`,
  `tmdb_key`, sessions, progress, views, per-object metadata) would
  need migrating too. That is a DO-identity migration, a much larger
  project, and is **out of scope for this migration**. On the legacy
  backend, the plan is: proceed with the whole-object move, and when
  the catalogue approaches ~100 entries, switch the catalogue to
  **per-entry keys in DO storage** (one key per entry, each well under
  128 KiB) — a change to `listMovies`/`getExtMovies`/`saveExtMovies`
  only, no DO-identity change. The ceiling is a design constraint to
  monitor, not a reason to block the migration.

### 1.6 Billing and Free-plan implications

- **No new charges.** The migration moves a ~8 KB value from KV to
  DO storage. It **removes** catalogue puts from the KV write quota
  (Free plan: 1,000 writes/day, shared — the F3 finding), and adds
  DO-storage puts, which are not separately metered as KV writes;
  they are part of the DO's request handling, which already happens.
  The HTTP request count does not change (the same requests, the same
  DO calls). DO storage on the Free plan is capped at 5 GB per
  account and 1 GB per DO — the catalogue is ~8 KB, negligible.
- **Caveat:** the current docs note the Workers Free plan only allows
  SQLite-backed DOs for new classes. `main-v35` already exists and
  works, so if it is legacy KV-backed it is grandfathered (or the
  restriction does not apply retroactively). The dashboard check in
  §1.3 should also confirm the account's Workers plan, so this is
  known rather than assumed.

## 2. Current catalogue size and projected upper bound (measured)

Measured from the local backups (not estimated from entry shapes):

- **Oct 30 backup** (`~/workspace/sia-lab/ext-movies-backup-20261030.json`,
  mtime 2026-10-30 17:49): **12 entries, 7,839 bytes serialized**
  (compact JSON), average **640 B/entry**, largest **842 B**
  (Avatar: Fire and Ash). Note: this backup has 12 entries while the
  live catalogue has 11 — one entry was removed between Oct 30 and
  now. The backup is a snapshot, not the live catalogue; the removal
  must be identified and explained during the §4 cross-check.
- **Oct 21 disaster-kit dump** (`kv-dump.json`): 4 entries, 2,271
  bytes — too old to cross-check the live catalogue, but it
  establishes the entry-id format and the earliest entries.
- **Current live catalogue (11 entries, verified): ~7,040 B** at the
  measured 640 B/entry average (11 × 640), ~11 KB at a conservative
  1 KB/entry.

Projections (at the measured 640 B/entry average; at 1 KB/entry in
parentheses):

| Entries | Serialized size |
|---|---|
| 11 (current) | ~7.0 KB (11 KB) |
| 50 | ~32 KB (50 KB) |
| 100 | ~64 KB (100 KB) |
| **131** | ~84 KB (**131 KB — the legacy limit at 1 KB/entry**) |
| **204** | ~128 KB (**the legacy limit at the measured average**) |
| 500 | ~320 KB (500 KB) |
| 1,000 | ~640 KB (1 MB) |

- **Legacy KV-backed (131,072 B): fits ~204 entries at the measured
  average, ~131 entries at 1 KB/entry.** The current 11 entries use
  ~5% of the limit. The ceiling is real but distant: at the discovery
  pipeline's pace (15 candidates per run, only the approved fraction
  entering the catalogue), reaching ~130 entries would take many
  weeks of steady approvals.
- **SQLite-backed (8,388,608 B): fits ~13,107 entries at the measured
  average.** No practical concern; the catalogue would need to grow
  ~1,200× before the limit mattered.

## 3. The trustworthy migration source

**The problem, stated plainly:** hashing the KV value after reading
it proves the copy matches the value **read**. It does not prove the
read was the latest catalogue value. Cloudflare documents that KV
changes "may take up to 60 seconds or more" to be visible in other
locations, that 60 seconds is "typical, not a guarantee", that
read-your-writes is "likely but not promised", and that "no code path
should write a KV key and read it back as part of the same logical
operation". A single KV read + hash is therefore **not** proof of
source freshness. The source is established by a procedure, not a
single read.

### 3.1 The procedure

1. **Freeze catalogue writes.** The catalogue only changes via the
   six admin routes (direct POST, extposter, extpublish, ytinfo,
   DELETE, approve) — all require the admin password and the admin's
   deliberate action; discovery never writes the catalogue. The freeze
   has two layers:
   - **Code-level (the reliable layer):** a `catalogue_frozen` flag
     in DO storage, checked by all six write routes, returning
     `503 "catalogue frozen for migration"` while set. This is a
     small pre-migration deploy (adds a check only; no storage
     change) and needs its own approval as part of the migration
     procedure. The flag's state is readable via an admin endpoint,
     so the freeze is verifiable, not assumed.
   - **Operational (the backup layer):** the admin agrees not to use
     any admin catalogue function during the migration window.
   - The freeze is verified before proceeding: the admin endpoint
     returns the flag state, and a test write is rejected with 503.
2. **Wait for convergence.** After the freeze, wait **10 minutes**
   (10× the documented typical 60 s propagation). This is necessary
   but **not sufficient** — the docs give no hard bound, so a wait
   alone cannot prove convergence. It is the cross-checks below that
   provide the evidence.
3. **Read the catalogue from KV** (via the DO, through the same read
   path the code uses). Record the SHA-256 hash, the entry count, and
   the entry ids.
4. **Cross-check the read against independent sources.** All must
   agree; any disagreement stops the migration:
   - (a) **The Oct 30 backup (12 entries, 7,839 B).** The fresh read
     must be explainable against it: the entry ids present in the
     backup but absent from the fresh read must be identified (the
     live catalogue has 11 entries; one was removed since Oct 30)
     and the removal explained (which entry, when, why — an admin
     DELETE or a known cleanup). An unexplained difference stops the
     migration.
   - (b) **The public `/api/movies`.** The fresh read's listed
     entries (ids + titles) must match `/api/movies` exactly — 10
     listed entries. The unlisted entry (`emvsu47s4`, WALL·E
     Lulustream test) must be present in the fresh read and absent
     from `/api/movies`.
   - (c) **The admin UI.** The admin visually confirms the entry
     list in the admin panel matches the fresh read.
   - (d) **No queue contamination.** No entry id in the fresh read
     may be a pending-candidate id (the 45 candidates in
     `ext:pending` are a different key); a candidate id in the
     catalogue would indicate a corrupt or mixed-up read.
   - (e) **No `pendingId` anomalies.** The fresh read must contain
     no `pendingId` on any entry (0 approvals have happened; the
     provenance design says only approve assigns one). A `pendingId`
     would indicate the read is not the catalogue the design
     describes.
5. **Seed DO storage and verify the seed.** Write the snapshot to DO
   storage (an admin migration endpoint). Read it **back from DO
   storage** — a strongly-consistent read — and compare the SHA-256
   hash, the entry count, and the entry ids against the snapshot. The
   seed is verified only when the read-back matches exactly. If it
   does not match, stop: the DO-storage key is deleted (or left as an
   unverified seed, clearly marked), the application still reads KV,
   the freeze is lifted, and the migration is retried later.
6. **The authoritative source is therefore:** the KV value read after
   the freeze + the 10-minute wait, corroborated by all five
   cross-checks, and verified by the DO-storage read-back. The hash
   proves the copy matches the value read; the freeze + wait +
   cross-checks are what make the value read trustworthy. If any
   cross-check disagrees, or the wait cannot be verified, **stop the
   migration rather than silently choosing a potentially stale
   catalogue**.

## 4. Cutover and rollback — the explicit state-transition plan

### 4.1 The six states

| State | Catalogue source | Code reads | Code writes | KV `ext:movies` |
|---|---|---|---|---|
| **1. Existing KV mode** | KV | KV | KV | Live, written by the app |
| **2. Catalogue writes frozen** | KV | KV | **None** (all six routes 503) | Live, unchanged |
| **3. Source snapshot acquired and validated** | KV | KV | None | Live, unchanged; snapshot recorded (hash + count + ids) |
| **4. DO storage seeded and verified** | KV | KV | None | Live, unchanged; DO-storage copy verified by read-back |
| **5. DO storage authoritative** | **DO storage** | **DO storage** | **DO storage** | Frozen backup (the pre-cutover snapshot); no app writes |
| **6. KV retained as backup** | DO storage | DO storage | DO storage | Frozen backup; no app writes, ever |

### 4.2 The transitions and their verification gates

- **1 → 2:** Deploy the freeze flag (pre-migration deploy, separately
  approved). Set the flag. Verify: the admin endpoint returns the
  flag as set; a test write to each of the six routes returns 503.
  Discovery continues (it only writes the queue).
- **2 → 3:** Wait 10 minutes. Read the catalogue from KV. Run the
  five cross-checks (§3.1 step 4). Record the hash + count + ids.
  **Gate:** any cross-check failure → stay in state 2, lift the
  freeze, abort the migration (nothing has changed; retry later).
- **3 → 4:** Seed DO storage via the admin migration endpoint. Read
  it back from DO storage and compare hash + count + ids.
  **Gate:** read-back mismatch → stay in state 3, delete the seed,
  lift the freeze, abort (the application never left KV mode).
- **4 → 5 (the cutover):** Deploy the new code (reads/writes DO
  storage). The freeze flag is cleared as part of the cutover deploy
  (the new code's write routes check the flag too, so the flag remains
  a permanent feature — it is cleared, not removed). Verify
  post-deploy: `/api/movies` returns the 10 listed entries;
  `GET /api/admin/entries` returns all 11; an admin catalogue read
  matches the snapshot hash. **Gate:** any post-deploy check failure
  → roll back using §4.3 (do not improvise).
- **5 → 6:** No action — state 6 is state 5 after the verification
  passes. The KV key is left in place as a frozen backup. The
  disaster-kit restore procedure is updated to record that the KV
  backup is stale as of the cutover date and that the authoritative
  source is DO storage. The post-deploy checks that assert KV state
  ("live 11") are updated to read the count from the admin API
  instead of from KV.

### 4.3 Rollback after step 5

**Simply reverting the Worker to the old KV-reading code would lose
every catalogue change made after cutover** — those changes went to
DO storage, not KV, and the KV key still holds the pre-cutover
snapshot. The rollback procedure is therefore a **verified transfer
back**, not a code revert:

1. **Freeze writes again.** Set the `catalogue_frozen` flag (the new
   code's write routes check it too — the flag is a permanent
   feature, not a migration-only hack). Verify all six routes 503.
2. **Read the authoritative DO-storage catalogue** via the admin API
   (strongly consistent). Record its hash + count + ids.
3. **Write it back to KV** (an admin migration endpoint, the reverse
   of the seed), overwriting the stale KV backup.
4. **Verify the KV value.** Read it back from KV via the DO (same
   location as the write — read-your-writes is "likely" there) and
   compare the hash. Then verify via the Cloudflare API
   (`wrangler kv get` / the API read, which reads from the central
   store) and compare the hash again. Both must match the DO-storage
   hash. If either does not match, wait and re-read (KV propagation);
   if it still does not match, **do not proceed**.
5. **Only after the KV value is verified** → revert the code to read
   KV (deploy the old code) → verify post-deploy (`/api/movies`
   returns the 10 listed entries; the catalogue matches the hash) →
   clear the freeze flag.
6. **If the KV write-back cannot be verified, rollback is
   PROHIBITED.** The application stays on DO storage, which is the
   authoritative source and is working. A code revert without the
   transfer is a data-loss operation and must not happen.

**Pre-cutover abort is trivial:** before state 5, no code has been
deployed that reads DO storage, and the KV value is untouched — the
abort is just "lift the freeze and stop". Only after state 5 does
rollback require the transfer-back procedure.

### 4.4 No dual-source fallback, no indefinite dual writes

- The code reads from **exactly one source at a time** (KV before
  cutover, DO storage after). There is **no runtime fallback**: if the
  DO-storage read fails, the code returns a generic 500 — it does
  **not** fall back to KV (R62, §5).
- The code writes to **exactly one source at a time**. There are **no
  dual writes** (the migration and the rollback are deliberate,
  verified, one-way transfers, not ongoing writes to both stores).
- The KV key after cutover is a **frozen backup**, not a second
  source. It is never read by the application and never written by
  the application.

## 5. Strengthened tests R61–R65 (suite total: 75)

R58–R60 are retained (the stale-KV demonstration, same-entry
preservation, cross-entry isolation). Suite total becomes **75 tests**
(47 existing + 15 R38–R52 + 5 R53–R57 + 3 R58–R60 + 5 R61–R65).
The harness is extended with a `makeStaleKV` wrapper (an authoritative
map + a lagging replica map) and an authoritative DO-storage stub (a
single map; `get` always returns the latest `put`), as in the
storage-safety addendum.

- **R61 — every catalogue reader and writer uses DO storage after
  cutover.** Harness: a KV stub that **throws on any `ext:movies`
  get/put** (simulating the KV key being unreachable/removed), and a
  DO-storage stub serving the catalogue. Run all catalogue operations
  (list, approve, meta-approve, extpublish, extposter, ytinfo,
  delete, direct POST). **Assert:** all succeed. This proves no code
  path still reads KV for the catalogue.
- **R62 — a KV read failure cannot silently trigger fallback to the
  old catalogue.** Harness: the KV stub throws on `ext:movies` get;
  the DO-storage stub holds the catalogue. **Assert:** the operation
  returns the DO-storage catalogue (not an empty object, not a KV
  fallback). Negative control: with the old (KV) code, a KV failure
  returns a generic 500 (the G1 strict-read pattern) — no fallback to
  a default.
- **R63 — a DO-storage read/write failure produces a safe error
  without replacing the catalogue with an empty/default object.**
  Harness: (a) the DO-storage stub throws on `get` → **assert** the
  operation returns a generic 500 and the stored catalogue is
  byte-identical afterwards (no empty object written, no default
  substituted); (b) the DO-storage stub throws on `put` → **assert**
  the operation returns a generic 500 and the stored catalogue is
  byte-identical (the failed write did not partially overwrite).
  This is the G1 lesson applied to DO storage.
- **R64 — a simulated interrupted migration cannot leave the
  application in an ambiguous dual-source state.** Harness: the
  DO-storage key is **absent** (the seed never completed) while the
  KV key is intact. **Assert:** (a) the pre-cutover code reads the KV
  catalogue correctly (the absent DO-storage key does not affect it —
  the pre-cutover code does not read DO storage for the catalogue);
  (b) the post-cutover code, if deployed without a completed seed,
  returns a clear error (generic 500) — **not** an empty catalogue
  and **not** the KV value (no fallback). This proves the cutover is
  all-or-nothing: either the seed is complete and verified (cutover
  proceeds) or it is absent (the application fails loudly, never
  silently serving an empty or stale catalogue).
- **R65 — rollback preserves all changes made after cutover.**
  Harness: after cutover (DO storage authoritative), make a catalogue
  change (a meta-approve changing a title, and an approve adding an
  entry). Then run the rollback procedure (copy DO storage → KV,
  verify the hash, switch the code to read KV). **Assert:** the KV
  value now contains both post-cutover changes, and the application
  (now reading KV) shows them. Also assert the negative: a rollback
  **without** the transfer (reverting the code while KV is stale) is
  caught — the procedure's verification step (hash comparison) fails
  and the revert is blocked.

## 6. What the stub tests cannot prove — the staging test

The stub tests are useful, but these guarantees still require a
Cloudflare-runtime staging test:

- **(a) The actual DO storage backend and its per-value limit.** A
  stub cannot tell you whether `main-v35` is SQLite-backed or legacy
  KV-backed, and cannot enforce the real 128 KiB / 8 MB limit (the
  stub's limit is whatever the test author wrote). Only the dashboard
  (§1.3) or a runtime probe (`state.storage.sql`) can.
- **(b) KV propagation/convergence timing in production.** The stub's
  "stale replica" is simulated. The real 60 s+ propagation window,
  and whether the catalogue read after the freeze + 10-minute wait is
  converged, can only be measured in the live runtime.
- **(c) The actual migration copy (KV → DO storage) against the live
  stores.** The stub's seed/verify is simulated. The real copy's
  behaviour — including the DO-storage per-value limit enforcement
  (which throws "Value too large" if exceeded) — can only be proven
  in the runtime.
- **(d) DO-storage strong consistency under real conditions.** The
  stub assumes it; the runtime is where the platform guarantees it.
- **(e) The freeze flag's behaviour in production.** The stub tests
  the logic; the production deploy's correctness (all six routes
  returning 503) needs a live check.

### 6.1 The staging test plan (a prerequisite, not optional)

Create a **staging Worker + DO** on the same account (e.g.
`sia-lab-staging`, a separate Worker with its own DO class and a
test catalogue seeded from the Oct 30 backup). Run the **full
migration procedure** against it — freeze → wait → snapshot →
cross-check → seed → verify → cutover → a post-cutover change →
rollback (transfer-back + verify) — and run the R58–R65 equivalents
in the staging runtime. Only after the staging migration succeeds
end-to-end do we run it in production. The staging Worker is a new
resource on the Free plan (no charge) and needs his approval to
create.

## 7. Decision points (kept separate, as requested)

- **F1 approval-first design:** accepted in principle (unchanged).
- **DO-storage architecture:** preferred and accepted in principle
  (unchanged).
- **Storage migration and operational procedure:** awaiting this
  review. The gates, in order: (1) confirm the backend (§1.3);
  (2) if legacy, accept the ~130–200 entry ceiling and the
  per-entry-keys plan (§1.5), or choose the larger DO-identity
  migration instead; (3) approve the staging Worker (§6.1);
  (4) approve the freeze-flag pre-migration deploy (§3.1 step 1);
  (5) approve the migration run itself (states 2–5, §4).
- **F1 implementation:** not authorized.
- **G1/G2:** pinned at `88ef10b`.
- **Production:** remains on `4f5ab64`.

## 8. Confirmation

This addendum is **design-only**. No files were edited, no code was
implemented, no commit, push, PR, deployment, or production operation
was made. The pinned G1/G2 release (`88ef10b`) and production
(`4f5ab64`) are untouched. Awaiting the separate explicit decisions
listed in §7 — starting with the backend confirmation, which is the
first gate and the one piece of evidence this design cannot supply
from the workspace alone.
