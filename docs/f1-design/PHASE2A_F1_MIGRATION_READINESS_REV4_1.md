# F1 Migration-Readiness, Revision 4.1 — corrected decision document

**Design-only.** No code was edited, no commit, push, PR, deployment,
staging creation, or production operation was made. This document
revises Rev 4 (`PHASE2A_F1_MIGRATION_READINESS_REV4.md`) on the three
points below and supersedes its §1.4 (execution sequence), its §1.5
(stop conditions), and its §6 (remaining uncertainties). It is the
complete corrected document, self-contained. Everything else in Rev 4
stands, except where this document says otherwise.

## 1. The migration source — qualified, with a corrected disagreement rule, a tightened cache-expiry procedure, and the final execution sequence

### 1.1 The qualification (unchanged from Rev 3 / Rev 4)

Cloudflare does not explicitly document that the REST value endpoint
reads the authoritative central value for existing,
frequently-accessed keys, bypassing cached stale values. The API
reference confirms the endpoint (`GET .../values/{key}`) and the
raw-byte response only. The strongest statement available is from a
third-party client (JSR `@tundraconnect/cloudflare-kv`): *"Reads go to
Cloudflare's central store, so a write is visible here at once, even
before it reaches every edge."* That is a third-party client's
documentation, not Cloudflare's own guarantee, and it does not
distinguish newly-created keys from existing frequently-accessed keys.
The probe (a newly-written key) proves the API can see a fresh write;
it does not prove that reading the frequently-accessed existing
`ext:movies` key bypasses cached stale values. The API read is the
best available canonical read, but the guarantee is architectural, not
an explicit documented guarantee for existing keys. The procedure
provides **strong evidence, not an absolute guarantee**.

### 1.2 The disagreement rule (unchanged from Rev 4)

- **If the API and DO reads agree, continue to the backup
  cross-check.**
- **If they disagree, stop and investigate. Do not automatically
  select either value.**
- **Resume only after the discrepancy is independently explained and
  the source decision is justified.**
- **Neither read is declared authoritative solely from the evidence
  currently documented.**

"Independently explained" means the explanation comes from evidence
independent of the two disagreeing reads themselves — for example:
(a) re-reading both after a further wait (e.g. another 10 minutes)
and seeing them converge to one value, with the convergence
documented; (b) identifying the specific write that accounts for the
difference (e.g. the DO read matches the Oct 30 backup and the API
read matches a newer state, and the difference is a named admin
action that happened after Oct 30 — the action must be identified,
not merely asserted); or (c) a third independent read (e.g. the
Cloudflare dashboard's KV browser, or a `wrangler kv get` from a
different location) that agrees with one of them. The source decision
(which value to use, or to abort) must be documented with reasoning
before the migration resumes. A disagreement that is merely
"explained as edge staleness" without independent evidence is not
sufficient to resume.

### 1.3 The cache-expiry procedure — tightened (unchanged from Rev 4, with the A2 timestamp added)

The 10-minute wait is a useful mitigation, but the 60-second
`cacheTtl` documentation applies to the Worker KV binding; it does
not establish the REST API's caching behaviour. The procedure is
therefore defined explicitly, with documented guarantees separated
from assumptions.

**Timeline.** Let **T0** be the moment the `catalogue_frozen` flag is
set in DO storage (the freeze). Let **Tw** be the time of the last
catalogue write (`saveExtMovies` put) that resolved before T0
(Tw ≤ T0). After Tw, the catalogue value is constant (equal to the
value as of Tw), because the freeze blocks all writes from T0 onward.

**When the last potentially stale pre-freeze cache population could
have occurred.** A cache entry can hold a value older than the current
value only if it was populated before Tw (before the last write) and
not revalidated by that write. To be conservative, assume a cache
entry populated at any time up to T0 could hold a stale value. That
entry expires 60s after population (the default `cacheTtl` — see the
guarantees below). So the last possible stale cache population is at
**T0**, and it expires by **T0 + 60s**.

**Which reads happen during the waiting period.** The migration
procedure performs **no `ext:movies` reads** during the waiting
period (T0 to T0 + 10 min). The probe write and probe read (a
different key, `migration:probe:<timestamp>`) happen immediately
after T0 and do not touch the `ext:movies` cache. The public site/app
may read `/api/movies` during the waiting period (those reads are
outside the procedure's control — the site remains live; the freeze
blocks writes, not reads). Those reads cannot introduce a new stale
value: the catalogue is constant after T0, so a read after T0 can only
return the current value or an older cached value, and a read that
hits a cached value does not re-populate the cache (see the
assumptions below). A read that misses the cache fetches the current
value from the central store.

**When the comparison reads are performed.** The comparison reads
(the API read of `ext:movies`, **A1**, + the DO edge read, **D1**)
are performed at **T0 + 10:00** (600s after the freeze) — 10× the 60s
default `cacheTtl`. By this time, any cache entry populated before T0
has expired (60s TTL), and any cache entry populated during the
waiting period by a public read holds the current value (if populated
after T0 + 60s, it fetched fresh) or is a pre-freeze entry that has
expired. The second API read (**A2**) is performed at **T0 + 11:10**,
70 seconds after A1, as the repeated-read check (§1.4 step 5).

**Documented guarantees:**
- The `cacheTtl` (default 60s, minimum 30s) defines how long a KV
  result is cached in the global network location it is accessed from
  (the Worker KV binding read path). Source: the KV API reference
  ("Read key-value pairs", crawled 2026-11-13 16:14 UTC).
- *"Once a key has been read with a given `cacheTtl` in a region, it
  will remain cached in that region until the end of the `cacheTtl`
  or eviction."* (Same source.)
- *"When writing to Workers KV, the regions in the regional and
  central caching layers internal to KV will get revalidated with the
  newly written result."* (Same source.)
- The code passes no custom `cacheTtl` (verified: 0 occurrences of
  `cacheTtl` in worker.js; the reads are
  `env.DATA_KV.get("ext:movies", "json")`), so the default 60s
  applies to the DO's KV reads.

**Assumptions (not documented guarantees):**
- The REST API read path (if it caches at all) has a cache TTL of
  ≤60s, or no cache. The 60s `cacheTtl` documentation applies to the
  Worker KV binding, **not** to the REST API. The REST API's caching
  behaviour is undocumented. The 10-minute wait's ability to expire a
  cached value in the API read path is therefore an assumption, not a
  documented guarantee.
- A cache hit does not refresh or extend the TTL (the TTL is fixed
  from population). This is the standard interpretation of "will
  remain cached... until the end of the `cacheTtl`", but Cloudflare
  does not explicitly state that a hit does not extend it.
- The write revalidation ("will get revalidated") happens promptly
  enough that caches hold the new value shortly after a write. The
  timing is not quantified in the docs.
- No catalogue write happens after T0. This is enforced by the freeze
  flag (code), but it assumes the flag is set correctly and the freeze
  code is deployed correctly (verified by the FZ tests + the live
  check after the freeze deploy).
- The comparison reads at T0 + 10:00 are the first `ext:movies`
  reads by the procedure after T0 (no procedure reads during the
  waiting period). This is a procedural rule, enforced by the
  migration script, not by code.

**Qualified conclusion.** This procedure increases confidence that
the comparison reads return the current value, but it **cannot prove
absolute freshness**, because (a) the REST API's caching behaviour is
undocumented (the 60s TTL applies to the Worker binding, not the
API), and (b) the TTL-expiry reasoning relies on assumptions about
cache behaviour (fixed TTL, no refresh on hit) that Cloudflare does
not explicitly guarantee for the API read path.

### 1.4 The final execution sequence — chronological, with timestamps

All times are relative to **T0**, the moment the `catalogue_frozen`
flag is set in DO storage. The freeze blocks all catalogue writes
from T0 onward. **No write to DO storage happens until steps 6 and 7
pass.**

1. **T0 — Freeze.** Set the `catalogue_frozen` flag in DO storage
   (the freeze release's `POST /api/admin/catalogue-freeze`
   endpoint). From T0 onward, all six catalogue write routes return
   503. No catalogue write can happen after T0.
2. **T0 + 0:00–0:30 — Probe.** The DO writes
   `migration:probe:<unix-timestamp>` to KV via its binding (one KV
   write). Then read the probe key via the Cloudflare API. If the API
   returns the probe value, the API read path is seeing the central
   store's current state — verified empirically, at this moment, for
   this migration. The probe is a different key, so this does not
   touch the `ext:movies` cache. The probe is deleted after the
   migration.
3. **T0 + 0:30 to T0 + 10:00 — Waiting period.** No `ext:movies`
   reads by the procedure. The public site/app may read `/api/movies`
   during this period (outside the procedure's control); those reads
   cannot introduce a new stale value (§1.3).
4. **T0 + 10:00 — First comparison reads.** Read `ext:movies` via
   the Cloudflare API (**A1**) and via the DO edge read (**D1**),
   both at T0 + 10:00. These are the comparison pair. By this time,
   any cache entry populated before T0 has expired (60s TTL), and any
   cache entry populated during the waiting period by a public read
   holds the current value or has expired (§1.3).
5. **T0 + 11:10 — Second API read.** Read `ext:movies` via the
   Cloudflare API again (**A2**), 70 seconds after A1 — strictly more
   than 60 seconds. This is the repeated-read check: if the API read
   path caches with a TTL of ≤60s, then A1 and A2 are two independent
   fetches; if they agree, the API value is stable. Caveat: if the
   API read path caches with a TTL longer than 70s, both reads could
   return the same stale cached value — the TTL of the API read path,
   if it caches at all, is unverified (§1.3).
6. **T0 + 11:10 onwards — Agreement checks.** (a) Repeated-read
   agreement: **A1 == A2**. (b) API/DO agreement: **A1 == D1**. If
   either fails, apply the disagreement rule (§1.2) — stop and
   investigate; do not select either value.
7. **Backup reconciliation — before any write to DO storage.** The
   agreed value (A1 == A2 == D1) must be explainable against the Oct
   30 backup (12 entries) and the known entry list. Specifically,
   the 12→11 entry difference must be identified (which entry was
   removed, when, and why) and explained. If the difference cannot
   be explained, stop. **No write to DO storage happens until this
   step passes.**
8. **Seed.** Only after steps 6 and 7 pass, write the candidate
   catalogue (the agreed API-read value) into DO storage. This is
   the first write to DO storage in the migration.
9. **Verify the seed.** Read back the DO-storage value and verify it
   matches the agreed API-read value exactly: SHA-256 hash + entry
   count + entry ids. If the read-back does not match, stop.

**Summary of the sequence:** freeze (T0) → probe (T0+0:00–0:30) →
wait (to T0+10:00) → A1 + D1 (T0+10:00) → A2 (T0+11:10) →
agreement checks (A1 == A2, A1 == D1) → backup reconciliation →
seed → verify seed. All validation gates (API/DO agreement,
repeated-read agreement, backup reconciliation) pass **before** any
write to DO storage. The seed is written only from the fully-validated
agreed value, and is verified by read-back.

### 1.5 Stop conditions

If any of these holds, **freshness cannot be established and the
migration must stop** — do not silently choose a potentially stale
catalogue:
- The API read of the probe key fails or does not return the probe
  value (the central read cannot be verified).
- The API read of `ext:movies` fails (A1 or A2).
- The repeated API reads disagree (**A1 != A2**).
- **The API and DO reads disagree (A1 != D1)** — any disagreement
  (§1.2).
- The backup reconciliation fails (the 12→11 entry difference cannot
  be explained) — step 7, before any write to DO storage.
- The DO-storage seed read-back does not match the agreed value.
- An absolute guarantee is required (it does not exist in
  Cloudflare's documentation — §1.1).

## 2. Billing — SQLite Free-tier row-read quota status (unchanged from Rev 4)

**Status: the 50 million/day figure is unverified and the quota is
unresolved.** Rev 3 corrected the quota to 50M/day per the user's
check of the current docs. I attempted to verify it independently and
**could not**:

- The Durable Objects pricing page copy I can access
  (developers.cloudflare.com/durable-objects/platform/pricing/,
  crawled 2026-11-13 16:08 UTC) lists **"Rows reads | 5 million /
  day"** for the Free plan, and "Rows written | 100,000 / day".
- The D1 pricing page (which the DO pricing footnote says the row
  limits "match") lists **5 million rows read/day** and 100,000 rows
  written/day on Free, confirmed by multiple independent sources
  citing the official D1 pricing page (layerbase.com, checked Oct 19,
  2026; tanstackship.com, updated 2026-11-08; tamimiqbal.com, Sep
  2026; getcostiq.com, read Oct 24, 2026; agentdeals.dev, read Oct
  20, 2026).
- The "50 million" figure **does** appear in the official docs — as
  the **Paid tier's monthly rows WRITTEN included** (50 million/month),
  not as Free row reads/day.

**Therefore:** the 50M/day figure is retained as an **unverified
user-reported figure** and the quota is marked **unresolved pending
dashboard/documentation confirmation**. The working figure for the
quota check is **5 million/day** (verified from the docs I can
access). The row-write limit is retained at **100,000/day** (verified
by both the DO pricing page and the D1 pricing).

The billing conclusion is unchanged by this: the catalogue's read
volume (1,000–5,000 row reads/day) is negligible against either
figure (0.02–0.1% of 5M/day; 0.002–0.01% of 50M/day), and the
increment is small. But the quota itself is unresolved and must be
confirmed from the dashboard (gate 2) before the migration run — the
dashboard shows the account's actual limits and usage, which is the
authoritative source for this account.

## 3. The freeze deployment — exact base and complete diff (unchanged from Rev 2 / Rev 3 / Rev 4)

- **Base: `88ef10b`** (the G1/G2 commit). The freeze release is a new
  commit on top of `88ef10b`.
- **G1/G2: INCLUDED.** Deploying the freeze release deploys G1/G2;
  the freeze deployment approval therefore also approves the G1/G2
  deployment (or G1/G2 may be deployed first separately, then the
  freeze release on top — same end state, two deploys).
- **F1 implementation: EXCLUDED. Catalogue migration: EXCLUDED.**
- **F1's base moves:** the chain is `4f5ab64` → `88ef10b` → freeze
  → F1. F1 remains a separate commit, on top of the freeze release.
- **The freeze release's own diff (on top of `88ef10b`):**
  `worker.js` — a `catalogue_frozen` flag in DO storage (same pattern
  as `admin_pw`/`tmdb_key`: `state.storage.get` at line 208, `put` at
  line 2966); a freeze check inside each of the six catalogue write
  routes' `_withAdminLock` callbacks (route → lock start, at
  `88ef10b`: `POST /api/admin/external` 2622→2647,
  `POST /api/admin/extposter` 2660→2663,
  `POST /api/admin/extpublish` 2674→2677,
  `POST /api/admin/ytinfo` 2686→2688,
  `DELETE /api/admin/external` 2708→2712,
  `POST /api/admin/pending/approve` 2775→2781) returning HTTP 503
  `"catalogue frozen for migration — try again later"` when set; and
  `POST`/`GET /api/admin/catalogue-freeze` endpoints (checkPw). The
  flag lives in DO storage, not KV. `.phase2a-test/test_pending_sources.mjs`
  — new tests FZ1–FZ3 (freeze blocks all six routes with 503 and no
  write; flag clear → normal; set/clear round-trips, 403 without the
  password). No other files, no CI workflow change, no production
  config change. **50 tests** at the freeze release (47 + 3); the F1
  commit on top brings the suite to 78.

## 4. Unresolved risks (unchanged from Rev 4)

1. **The source guarantee is qualified, not absolute.** Cloudflare
   does not explicitly document that the REST value endpoint reads
   the authoritative central value for existing frequently-accessed
   keys. The procedure (§1.4) provides strong evidence (probe +
   TTL-exceeding wait + repeated reads + edge agreement + backup
   cross-check), not an absolute guarantee. If an absolute guarantee
   is required, the migration cannot proceed on this source.
2. **The disagreement rule is now a stop, not a selection.** Any
   API-vs-DO disagreement stops the migration (§1.2). Resuming
   requires an independent explanation and a justified source
   decision — the investigation path is defined, but its outcome is
   not predetermined.
3. **The REST API's caching behaviour is undocumented.** The 60s
   `cacheTtl` applies to the Worker KV binding, not to the REST API
   (§1.3). The 10-minute wait's ability to expire a cached value in
   the API read path is an assumption, not a documented guarantee.
4. **The DO storage backend is still unconfirmed.** The dashboard
   check (or a staging-DO probe) is the first gate. If legacy, the
   ~130–200 entry ceiling applies and the per-entry-keys plan is
   needed at ~100 entries; switching to SQLite would require a new DO
   class and breaks the `main-v35` identity.
5. **The account plan is unverified.** It determines whether an
   overage is a failure (Free) or a charge (Paid), and it constrains
   the backend (Free can only access SQLite-backed DOs).
6. **The current total DO-storage usage is unverified.** The quotas
   are shared across all DO-storage operations. The catalogue's
   increment is small, but the total must be far below the quotas
   (dashboard metrics) before the migration run.
7. **The SQLite Free-tier row-read quota is unresolved (§2).** The
   working figure is 5M/day (verified); the user's reported 50M/day
   is unverified. The dashboard must confirm the actual quota for
   this account before the migration run.
8. **The API token's KV Read permission is unverified.** The
   canonical read needs a token with Workers KV Storage: Read.
9. **The freeze flag's production behaviour is untested in the live
   runtime.** The stub tests (FZ1–FZ3) test the logic; the production
   deploy's correctness (all six routes returning 503) needs a live
   check after the freeze deploy.
10. **KV propagation has no hard bound.** The probe + the
    TTL-exceeding wait + the repeated reads address this, but the
    guarantee rests on Cloudflare's documented architecture and the
    assumptions in §1.3.

## 5. Exact approvals required (in order)

1. **Backend confirmation** — dashboard check (Worker → Durable
   Objects → `TunnelDO` storage type) or staging-DO probe. No
   migration work until this passes.
2. **Account plan + current DO-storage usage + row-read quota
   confirmation** — dashboard (plan; metrics showing total row
   reads/writes or request units far below the quotas; the actual
   Free-tier row-read quota for this account, resolving §2). No
   migration work until this passes.
3. **If the backend is legacy: accept the ~130–200 entry ceiling
   and the per-entry-keys plan** (or choose the larger DO-identity
   migration instead). No migration work until this decision is made.
4. **Freeze release approval** — the commit on top of `88ef10b`
   (§3). Approving its deployment also approves the G1/G2
   deployment. The freeze release is deployed (one deploy, or two if
   `88ef10b` is deployed first separately).
5. **Staging Worker approval** — create `sia-lab-staging` (separate
   Worker + DO, Free plan, no charge) and run the full migration
   end-to-end there first (freeze → probe → API read → seed →
   verify → cutover → post-cutover change → rollback). No production
   migration until the staging run succeeds.
6. **Production migration run approval** — the cutover itself
   (states 2–5 of the migration-readiness addendum), using the
   qualified source procedure (§1) and the gates (§1.5). No production
   migration until gates 1–5 pass.
7. **F1 implementation approval** — separate, as before. The F1
   commit is on top of the freeze release (§3).

## 6. Remaining uncertainties — explicit list (complete)

1. Whether the REST API value endpoint bypasses caches for existing
   frequently-accessed keys (no explicit Cloudflare guarantee;
   §1.1). Residual risk: the API read could return a stale cached
   value. Mitigated by the probe, the TTL-exceeding wait, the
   repeated reads, and the edge agreement — but not eliminated.
2. Whether the REST API read path caches at all, and if so with what
   TTL (§1.3). The 60s `cacheTtl` is documented for the Worker
   binding only.
3. Whether a cache hit refreshes or extends the TTL (§1.3). Assumed
   fixed from population; not explicitly documented.
4. The DO storage backend (SQLite vs legacy KV) — gate 1.
5. The account plan (Free vs Paid) — gate 2.
6. The current total DO-storage usage vs the quotas — gate 2.
7. The SQLite Free-tier row-read quota (5M/day verified vs 50M/day
   user-reported, unresolved) — gate 2 (§2).
8. The API token's Workers KV Storage: Read permission.
9. The freeze flag's behaviour in the live runtime (stub-tested
   only). The stub tests (FZ1–FZ3) test the logic; the production
   deploy's correctness (all six routes returning 503) needs a live
   check after the freeze deploy.
10. The outcome of an API-vs-DO disagreement investigation, if one
    occurs (§1.2) — the investigation path is defined, the outcome
    is not predetermined.

## 7. Recommendation — is the design review ready to close?

**Yes, the design review is ready to close — as a design.** The
architecture, the source procedure, the final execution sequence
(§1.4), the cutover/rollback sequence, the freeze release contents,
the tests, and the seven gates are all specified. Every limitation
found during the review has been documented honestly rather than
papered over: the source guarantee is qualified (§1.1), the
disagreement rule is a stop rather than a selection (§1.2), the
cache-expiry procedure separates documented guarantees from
assumptions (§1.3), the read timeline is unambiguous with timestamps
(§1.4), backup reconciliation happens before any write to DO storage
(§1.4 step 7), and the row-read quota is marked unresolved rather
than treated as established (§2). No further design work is needed —
the remaining uncertainties (§6) are all captured as explicit gates
or stop conditions, not as open design questions.

**Closing the design review does not authorize any migration work.**
The migration itself is **not** ready to start: it is blocked on the
seven approval gates in §5, the first of which (backend confirmation)
requires a dashboard check only the user can perform. Each gate is
decided separately. If any gate fails — in particular, if the backend
is legacy and the ceiling is not accepted, if the dashboard does not
confirm the plan/usage/quota, if the staging run fails, or if an
API-vs-DO disagreement cannot be independently explained — the
migration stops at that gate and does not proceed.

## 8. Boundaries and confirmation

- Design-only; no code changes, commits, pushes, PRs, deployments,
  staging creation, or production operations. G1/G2 remain pinned at
  `88ef10b`, undeployed. Production remains at `4f5ab64`. The freeze
  release remains unapproved and includes G1/G2. F1 implementation
  and catalogue migration remain separate approvals. Preserve the
  `main-v35` identity. No dual-source fallback or dual writes.
- F1 approval-first design: accepted in principle. DO-storage
  architecture: preferred and accepted in principle. Storage
  migration and operational procedure: awaiting the approvals in §5.
  F1 implementation: not authorized.
- This document is **design-only**. No files were edited, no code was
  implemented, no commit, push, PR, deployment, or production
  operation was made. The pinned G1/G2 release (`88ef10b`) and
  production (`4f5ab64`) are untouched.
