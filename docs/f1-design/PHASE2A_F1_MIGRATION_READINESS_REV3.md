# F1 Migration-Readiness, Revision 3 — corrected decision document

**Design-only.** No code was edited, no commit, push, PR, deployment,
or production operation was made. This document revises Rev 2
(`PHASE2A_F1_MIGRATION_READINESS_REV2.md`) on the two points below and
supersedes its §1 (source proof) and its SQLite Free-tier row-read
quota. Everything else in Rev 2 stands, except where this document
says otherwise.

## 1. The migration source — qualified (no explicit Cloudflare guarantee found)

### 1.1 The correction

The probe's limitation is accepted. The probe key is **new**: when the
API reads it, no cached value exists for it, so the read must go to
the central store. The probe therefore proves the API can see a fresh
write. It does **not** prove that reading the frequently-accessed
existing `ext:movies` key bypasses cached stale values, because
`ext:movies` may have a cached value in the API's read path (if such a
cache exists) and the probe never tests that path.

### 1.2 What Cloudflare explicitly documents — and what it does not

I searched Cloudflare's own documentation (the KV API reference
"Read key-value pairs", crawled 2026-11-13 16:14 UTC; the "How KV
works" page; the consistency documentation). **Cloudflare does not
explicitly document that the REST value endpoint reads the
authoritative central value for existing, frequently-accessed keys,
bypassing cached stale values.**

What Cloudflare's docs do say:
- **"How KV works":** writes go to central stores; reads go through
  caches (local → regional → central → central stores); *"KV achieves
  high performance by caching which makes reads eventually-consistent
  with writes."* This describes the Worker binding read path. It does
  not explicitly discuss the REST API read path.
- **The read-key-value-pairs reference (Worker binding):** `cacheTtl`
  (default 60s, minimum 30s) defines how long a KV result is cached
  in the global network location it is accessed from. *"Once a key has
  been read with a given `cacheTtl` in a region, it will remain cached
  in that region until the end of the `cacheTtl` or eviction. This
  affects regional and central tiers of KV's built-in caching layers.
  When writing to Workers KV, the regions in the regional and central
  caching layers internal to KV will get revalidated with the newly
  written result."*
- **The API reference** confirms the endpoint
  (`GET .../values/{key}`) and the raw-byte response, but says nothing
  about the REST read path's consistency.

The strongest statement available is from a **third-party** client
(JSR `@tundraconnect/cloudflare-kv`): *"Reads go to Cloudflare's
central store, so a write is visible here at once, even before it
reaches every edge"* and *"a write made here is visible to `get` here
at once (it reads Cloudflare's central store), but a Worker reading
the same key elsewhere may see the old value for up to 60 seconds."*
This is a third-party client's documentation, not Cloudflare's own
guarantee, and it does not distinguish newly-created keys from
existing frequently-accessed keys.

### 1.3 The qualification (stated plainly)

The REST API read is the **best available canonical read**: the
management plane reads the central store per the KV architecture
(writes land in central stores; the API is the management plane) and
per the third-party client's documentation. But the guarantee is
**architectural, not an explicit documented guarantee for existing
keys**. The source procedure therefore provides **strong evidence, not
an absolute guarantee**. If an absolute guarantee is required, the
migration cannot proceed on this source — that guarantee does not
exist in Cloudflare's documentation.

### 1.4 The strengthened procedure (mitigations, not proof)

1. **Freeze** (the code-level `catalogue_frozen` flag, Rev 2 §3). No
   catalogue write can happen after this point.
2. **The DO writes a probe key** to KV via its binding:
   `migration:probe:<unix-timestamp>` with a known value. One KV
   write — negligible against the 1,000/day Free quota. The probe is
   deleted after the migration. This proves the API reaches the
   central store and sees a fresh write.
3. **Read the probe key via the Cloudflare API.** If the API returns
   the probe value, the API read path is seeing the central store's
   current state — verified empirically, at this moment, for this
   migration.
4. **Wait exceeding the cache TTL.** After the freeze, wait **10
   minutes** — 10× the default 60s `cacheTtl`. The code passes no
   custom `cacheTtl` (verified: 0 occurrences of `cacheTtl` in
   worker.js; the reads are `env.DATA_KV.get("ext:movies", "json")`,
   so the default 60s applies). Per the docs, a key "will remain
   cached in that region until the end of the `cacheTtl` or
   eviction" — so after 10 minutes, any cached value of `ext:movies`
   in any cache layer should have expired, and a read should fetch
   fresh from the central store. This applies to both the API read
   and the DO's edge read (if the API read path caches with a similar
   TTL — unverified, so this is a supporting argument, not a proof).
5. **Repeated API reads.** Read the API value, wait >60s (exceeding
   the default TTL), read again. If both agree and the freeze is in
   effect (no writes), the value is stable. Combined with the TTL
   expiry, this is evidence the second read fetched fresh. Caveat: if
   the API read path caches with a TTL longer than the wait, both
   reads could return the same stale cached value — the TTL of the
   API read path, if it caches at all, is unverified.
6. **Read `ext:movies` via the Cloudflare API** (the canonical source,
   best available evidence — §1.2/§1.3).
7. **The DO's edge read must agree with the API read.** After the
   freeze + wait, the DO's 60s cache has expired, so its read should
   be fresh. Two different read paths agreeing is corroborating
   evidence. If they disagree, the API read wins (it is central) —
   but the disagreement must be explainable as edge staleness (the
   edge value must match an older known state, e.g. the Oct 30
   backup). If the edge appears *newer* than the central store,
   which the architecture says is impossible, **stop and
   investigate**.
8. **The seed is written FROM the API-read value**, not from the DO's
   edge read. The seed is verified by DO-storage read-back (SHA-256
   hash + entry count + entry ids must match the API-read value
   exactly).
9. **The backup cross-check.** The API-read value must be
   explainable against the Oct 30 backup (12 entries) and the known
   entry list (the 12→11 removal identified and explained).

### 1.5 Stop conditions

If any of these holds, **freshness cannot be established and the
migration must stop** — do not silently choose a potentially stale
catalogue:
- The API read of the probe key fails or does not return the probe
  value (the central read cannot be verified).
- The API read of `ext:movies` fails.
- The repeated API reads disagree.
- The edge-vs-API disagreement is not explainable as edge staleness.
- The DO-storage seed read-back does not match the API-read value.
- An absolute guarantee is required (it does not exist in
  Cloudflare's documentation — §1.3).

## 2. Billing — SQLite Free-tier row-read quota corrected

**Correction:** the SQLite Free-tier row-read quota is **50 million
rows read per day**, not 5 million. The row-write limit is retained:
**100,000 rows written per day.** (Per the user's check of the current
Cloudflare Durable Objects pricing documentation. Note: the pricing
page copy accessed during this review, crawled 2026-11-13 16:08 UTC,
still showed 5M/day — the 50M/day figure is per the user's check of
the current docs, and is applied here as the current documented
value.)

The corrected SQLite table:

| | Workers Free plan | Workers Paid plan |
|---|---|---|
| Rows read | **50 million / day** | First 25 billion / month included + $0.001 / million rows |
| Rows written | **100,000 / day** | First 50 million / month included + $1.00 / million rows |
| SQL Stored data | 5 GB (total) | 5 GB-month, + $0.20 / GB-month |

The quantified incremental usage (Rev 2 §2.2) is unchanged in volume
and is now further below the quota: catalogue reads 1,000–5,000 row
reads/day are **0.002–0.01%** of the 50M/day Free quota (was
0.02–0.1% of 5M/day). The conclusion is unchanged: the increment is
negligible, but the account plan and the current total DO-storage
usage must still be verified in the dashboard before the migration
run (the quotas are shared across all DO-storage operations), and the
"no additional charges" claim remains withdrawn (Rev 2 §2.3).

## 3. The freeze deployment — exact base and complete diff

Unchanged from Rev 2 §3. Restated here so this document is
self-contained:

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

## 4. Unresolved risks

1. **The source guarantee is qualified, not absolute.** Cloudflare
   does not explicitly document that the REST value endpoint reads
   the authoritative central value for existing frequently-accessed
   keys. The procedure (§1.4) provides strong evidence (probe +
   TTL-exceeding wait + repeated reads + edge agreement + backup
   cross-check), not an absolute guarantee. If an absolute guarantee
   is required, the migration cannot proceed on this source.
2. **The DO storage backend is still unconfirmed.** The dashboard
   check (or a staging-DO probe) is the first gate. If legacy, the
   ~130–200 entry ceiling applies and the per-entry-keys plan is
   needed at ~100 entries; switching to SQLite would require a new DO
   class and breaks the `main-v35` identity.
3. **The account plan is unverified.** It determines whether an
   overage is a failure (Free) or a charge (Paid), and it constrains
   the backend (Free can only access SQLite-backed DOs).
4. **The current total DO-storage usage is unverified.** The quotas
   are shared across all DO-storage operations. The catalogue's
   increment is small, but the total must be far below the quotas
   (dashboard metrics) before the migration run.
5. **The API token's KV Read permission is unverified.** The
   canonical read needs a token with Workers KV Storage: Read.
6. **The freeze flag's production behaviour is untested in the live
   runtime.** The stub tests (FZ1–FZ3) test the logic; the production
   deploy's correctness (all six routes returning 503) needs a live
   check after the freeze deploy.
7. **KV propagation has no hard bound.** The probe + the
   TTL-exceeding wait + the repeated reads address this, but the
   guarantee rests on Cloudflare's documented architecture.
8. **Docs version question on the row-read quota.** The pricing page
   copy accessed during this review (crawled 2026-11-13 16:08 UTC)
   still showed 5M/day; the 50M/day figure is per the user's check of
   the current docs (§2). If the live docs show 50M, that is the
   current value.

## 5. Exact approvals required (in order)

1. **Backend confirmation** — dashboard check (Worker → Durable
   Objects → `TunnelDO` storage type) or staging-DO probe. No
   migration work until this passes.
2. **Account plan + current DO-storage usage confirmation** —
   dashboard (plan; metrics showing total row reads/writes or
   request units far below the quotas). No migration work until this
   passes.
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

## 6. Boundaries and confirmation

- No code changes, commits, pushes, PRs, or deployments. No staging
  Worker creation. No production freeze or migration. No F1
  implementation. No changes to `main-v35`. No dual-source fallback
  or dual writes.
- F1 approval-first design: accepted in principle. DO-storage
  architecture: preferred and accepted in principle. Storage
  migration and operational procedure: awaiting the approvals in §5.
  F1 implementation: not authorized. G1/G2: pinned at `88ef10b`.
  Production: remains on `4f5ab64`.
- This document is **design-only**. No files were edited, no code was
  implemented, no commit, push, PR, deployment, or production
  operation was made. The pinned G1/G2 release (`88ef10b`) and
  production (`4f5ab64`) are untouched.
