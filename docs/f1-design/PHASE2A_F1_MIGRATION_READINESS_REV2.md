# F1 Migration-Readiness, Revision 2 — decision document

**Design-only.** No code was edited, no commit, push, PR, deployment,
or production operation was made. This document revises
`PHASE2A_F1_MIGRATION_READINESS_ADDENDUM.md` on the three points
below and supersedes its §3 (source procedure) and §1.6 (billing).
Everything else in that addendum stands, except where this document
says otherwise.

## 1. The migration source is authoritative — the canonical central-store read

### 1.1 The correction

The previous addendum's cross-checks (public `/api/movies`, the admin
UI, the Oct 30 backup) are **not independent proof of freshness**.
The public API and the admin UI both read through the DO, which reads
KV through its binding — the same edge-cached read path. They can
corroborate (if they agree with the canonical read, the edge has
converged), but they cannot prove freshness. They are demoted from
"source" to "consistency checks".

### 1.2 The canonical read — verified against Cloudflare's docs

Workers KV stores data in **central data stores** and caches it at
the edge. Cloudflare's "How KV works" docs state: *"When you write to
KV, your data is written to central data stores. Your data is not sent
automatically to every location's cache."* A `put` resolving means the
value is durable in the central store. The REST API reads from that
central store: the Cloudflare KV API client documents the single-value
read as *"Reads go to Cloudflare's central store, so a write is
visible here at once, even before it reaches every edge."*

The canonical read is therefore:

```
GET https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key}
Authorization: Bearer <token with Workers KV Storage: Read>
```

For this account: account `676d7eaee0bab349422d3c91c9690679`, namespace
`1d03652f9f5f4dceb8f276abbb95d4a2`, key `ext:movies`. The response body
is the raw stored value (not a JSON envelope); a missing key returns
404. The migration script uses the same Cloudflare API credential
mechanism as `deploy_worker.py` (`dynamic_credentials`). The token's
permissions must include Workers KV Storage: Read — to be confirmed
before the migration run (if the deploy token lacks it, a token with
that scope is needed).

### 1.3 The verifiable method — the probe

The API read is the canonical source by architecture (§1.2). The
probe makes that verifiable **at migration time**, empirically, rather
than trusting the docs alone:

1. **Freeze** (the code-level `catalogue_frozen` flag, §3). No
   catalogue write can happen after this point.
2. **The DO writes a probe key** to KV via its binding:
   `migration:probe:<unix-timestamp>` with a known value (e.g. the
   freeze timestamp). One KV write — negligible against the 1,000/day
   Free quota. The probe is deleted after the migration.
3. **Read the probe key via the Cloudflare API** (§1.2). If the API
   returns the probe value, the API read path is seeing the central
   store's current state — the central read is verified empirically,
   at this moment, for this migration.
4. **Read `ext:movies` via the Cloudflare API** (same endpoint, same
   central store). This **is** the latest successful catalogue write:
   the central store holds the last resolved `put` for the key (writes
   land there; the `put` resolving means it is durable there), and no
   catalogue write happened after the freeze.
5. **The seed is written FROM the API-read value**, not from the DO's
   edge read. The DO's edge read (`/api/movies`, admin UI) is then a
   cross-check, not the source.
6. **The seed is verified** by DO-storage read-back (SHA-256 hash +
   entry count + entry ids must match the API-read value exactly).

### 1.4 How the cross-checks are used now

- The DO's edge read (`/api/movies` — 10 listed entries, exact ids +
  titles; the admin UI; the unlisted `emvsu47s4` present in the
  catalogue and absent from `/api/movies`) must agree with the API
  read. If it agrees, the edge has converged — corroboration.
- **If it disagrees, the API read wins** (it is central). The
  disagreement must be explainable as edge staleness: the edge value
  must be an older version of the catalogue (a hash matching an
  earlier known state, e.g. the Oct 30 backup). If the edge value is
  not explainable as an older state — in particular, if the edge
  appears *newer* than the central store, which the architecture says
  is impossible — **stop the migration and investigate**.
- The Oct 30 backup (12 entries) and the 12→11 removal must still be
  explained (§3 of the previous addendum), as a consistency check on
  the API-read value.

### 1.5 Stop conditions

If any of these holds, **freshness cannot be established and the
migration must stop** — do not silently choose a potentially stale
catalogue:
- The API read of the probe key fails or does not return the probe
  value (the central read cannot be verified).
- The API read of `ext:movies` fails.
- The edge-vs-API disagreement is not explainable as edge staleness.
- The DO-storage seed read-back does not match the API-read value.

## 2. Billing — corrected analysis

The previous addendum's claim ("no new charges") is **withdrawn**. It
conflated two separate meters and assumed the account plan and usage.
This section separates them, uses the exact published rates, and
states what is still unverified.

### 2.1 The two meters, separated

**Workers KV (the binding)** — the meter the migration *leaves*:
- Free: 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day,
  1,000 lists/day, 1 GB storage.
- Paid (per month): 10M reads included, then $0.50/million; 1M
  writes included, then $5.00/million; 1M deletes and 1M lists
  included, then $5.00/million each; 1 GB storage included, then
  $0.50/GB-month. The Paid plan has a $5/month minimum per account
  (covering Workers, Pages Functions, KV, Hyperdrive, DOs).

**Durable Object storage** — the meter the migration *joins* (from
the official DO pricing page, crawled 2026-11-13):
- **SQLite backend:** rows read — Free 5M/day, Paid first 25B/month
  included + $0.001/million rows; rows written — Free 100K/day, Paid
  first 50M/month included + $1.00/million rows; stored data — Free
  5 GB total, Paid 5 GB-month included + $0.20/GB-month. Footnote:
  *"Key-value methods like `get()`, `put()`, `delete()`, or `list()`
  store and query data in a hidden SQLite table and are billed as
  rows read and rows written."* So the migration's
  `state.storage.get/put` calls are billed as SQLite row reads/writes.
- **Legacy key-value backend (Paid only):** read request units — 1M
  included/month + $0.20/million; write request units — 1M included
  + $1.00/million; delete requests — 1M included + $1.00/million;
  stored data — 1 GB included + $0.20/GB-month. A request unit is
  4 KB of data read or written (a 9 KB write consumes 3 units). The
  docs state the Free plan *"can only create and access SQLite-backed
  Durable Objects"* and the key-value backend is *"only available on
  the Workers Paid plan"*.
- **Free-plan failure mode:** *"If you exceed any one of the free
  tier limits, further operations of that type will fail with an
  error."* Daily limits reset at 00:00 UTC. On Free, the risk is
  operational (failures), not financial. On Paid, overages are
  charged.

### 2.2 The migration's incremental usage, quantified

The operation count does not change — each catalogue read becomes 1
DO-storage read instead of 1 KV read; each catalogue write becomes 1
DO-storage write instead of 1 KV put. The catalogue volume (generous
upper bound; realistic traffic is lower):

| Operation | Volume (generous/day) | If SQLite | If legacy KV |
|---|---|---|---|
| Catalogue reads (`/api/movies`, admin) | 1,000–5,000 | 1,000–5,000 row reads/day (Free quota 5M/day; Paid included 25B/month) | ~8 KB value = 2 read units per read → 2,000–10,000 units/day = 60K–300K/month (included 1M/month) |
| Catalogue writes (admin actions only) | <10 (generous 50) | <50 row writes/day (Free quota 100K/day; Paid included 50M/month) | ~8 KB value = 2 write units per write → <100 units/day (included 1M/month) |
| Stored data | ~8 KB | 0.000008 GB → $0.0000016/month at $0.20/GB-month (included 5 GB / 5 GB-month) | Same (included 1 GB) |

### 2.3 What is still unverified — and why "no additional charges" cannot be claimed

- **The account plan is unverified** (Free vs Paid). This determines
  whether an overage is a failure (Free) or a charge (Paid), and
  whether the legacy backend is even possible (legacy is Paid-only;
  if the account is Free, the DO is almost certainly SQLite — which
  is itself evidence about the backend, §4).
- **The current total DO-storage usage is unverified.** The quotas
  above are shared across *all* DO-storage operations in the account
  — the DO already uses DO storage for `admin_pw`, `tmdb_key`,
  views, per-object metadata, sessions, and progress. The catalogue's
  increment is small, but the *total* must be far below the quotas.
  That total is only visible in the dashboard (metrics).
- **The backend is unverified** (which metering applies — SQLite row
  reads/writes, or legacy request units).

**Corrected conclusion:** the migration's incremental cost is
*expected* to be $0 — the catalogue volume is tiny relative to the
included quotas on either plan, and the KV side is a clear saving
(catalogue reads/writes leave the KV meter, relieving the 1,000/day
Free write quota that F3 identified as constrained). But "expected"
is not "guaranteed". Before the migration run, verify: (1) the
account plan in the dashboard, (2) the current total DO-storage
usage (row reads/writes, or request units) is far below the quotas,
(3) the backend (§4). If any check shows the account near a limit,
the migration's cost must be quantified before proceeding. On Free,
the failure mode is an error, not a bill; on Paid, the charge for
this volume would be fractions of a cent — but that must be confirmed
from the account's actual usage, not assumed.

## 3. The freeze deployment — exact base and complete diff

### 3.1 Base and scope

- **Base: `88ef10b`** (the G1/G2 commit, `88ef10bc1054367df51be9e6c11a073f297b6538`).
  The freeze release is a new commit on top of `88ef10b`.
- **G1/G2: INCLUDED.** The freeze release's base is `88ef10b`, which
  contains G1/G2. Deploying the freeze release deploys G1/G2. The
  freeze release's own diff does not re-introduce G1/G2; it inherits
  them from its base. **The freeze deployment approval therefore also
  approves the G1/G2 deployment.** Equivalently, G1/G2 may be deployed
  first separately (deploy `88ef10b`), and then the freeze release on
  top — same end state, two deploys.
- **F1 implementation: EXCLUDED.** No direct-POST conversion, no
  extpublish `pendingId` guard, no meta proposals, no ytinfo
  read-only conversion, no extposter removal, no `pendingId`
  assignment changes. No R38–R65 tests.
- **Catalogue migration: EXCLUDED.** No DO-storage catalogue code, no
  seed, no cutover. The catalogue still lives in KV (`ext:movies`).
  The freeze release only adds the freeze flag.
- **F1's base moves.** F1 is now a commit on top of the **freeze
  release**, not `88ef10b` directly. The chain is
  `4f5ab64` → `88ef10b` → freeze → F1. F1 remains a separate commit.
  (Earlier documents said F1 is "on top of `88ef10b`"; that is
  superseded by this chain.)
- **Alternative (not recommended):** base `4f5ab64` (freeze without
  G1/G2). This would require rebasing `88ef10b` onto the freeze —
  changing its hash, re-review, re-CI — and creates a divergent
  branch. Not recommended.

### 3.2 The freeze release's own diff (on top of `88ef10b`)

**`worker.js` only** (verified line numbers at `88ef10b`):

1. A `catalogue_frozen` flag in DO storage, using the existing
   pattern (`this.state.storage.get("admin_pw")` at line 208,
   `this.state.storage.put("admin_pw", n)` at line 2966,
   `this.state.storage.get("tmdb_key")` at lines 2037/2640/2746):
   `this.state.storage.get("catalogue_frozen")` /
   `put("catalogue_frozen", "1")` / `delete("catalogue_frozen")` to
   clear. Stored in **DO storage (strongly consistent), not in KV**
   — a KV flag would be eventually consistent and the freeze would
   not be reliable.
2. A helper reading the flag (returns boolean; `"1"` = frozen, absent
   = not frozen).
3. A freeze check at the start of each of the six catalogue write
   routes' `_withAdminLock` callbacks — if frozen, return HTTP 503
   `"catalogue frozen for migration — try again later"`, no write.
   The check is inside the lock, so it is atomic with the write (the
   freeze cannot be set between the check and the write). The six
   sites (route line → lock start, at `88ef10b`):
   - `POST /api/admin/external` — 2622 → 2647
   - `POST /api/admin/extposter` — 2660 → 2663
   - `POST /api/admin/extpublish` — 2674 → 2677
   - `POST /api/admin/ytinfo` — 2686 → 2688
   - `DELETE /api/admin/external` — 2708 → 2712
   - `POST /api/admin/pending/approve` — 2775 → 2781
   (`_withAdminLock` is defined at line 2204.)
4. Admin endpoints (new routes, placed near the other admin routes):
   `POST /api/admin/catalogue-freeze` with `{frozen: true/false}`
   (checkPw, takes `_withAdminLock`, writes/clears the flag, returns
   `{frozen: bool}`) and `GET /api/admin/catalogue-freeze` (checkPw,
   returns `{frozen: bool}`).

**`.phase2a-test/test_pending_sources.mjs`** — new tests FZ1–FZ3:
- **FZ1:** when the flag is set, each of the six catalogue write
  routes returns 503 and makes no write (the catalogue is
  byte-identical afterwards).
- **FZ2:** when the flag is clear, the six routes work normally (the
  freeze blocks nothing).
- **FZ3:** the flag set/clear round-trips via the admin endpoint
  (set → read returns `frozen: true`; clear → read returns
  `frozen: false`; the endpoint requires the admin password, 403
  without it).

**No other files.** No CI workflow change (the workflow already runs
the test files). No production config change. No binding, DO identity,
or compatibility-date change. Test count at the freeze release:
**50 tests** (47 G1/G2 suite + 3 FZ1–FZ3). The F1 commit on top then
brings the suite to 78 (50 + 15 R38–R52 + 5 R53–R57 + 3 R58–R60 + 5
R61–R65).

### 3.3 What the freeze release does not change

The catalogue source (still KV), the queue, the discovery state, the
seen map, the DO identity (`main-v35`), the bindings, the
compatibility date, the CI workflow, production config. No F1 code.
No migration code. The freeze flag is a permanent feature (the
rollback procedure in the previous addendum relies on it), not a
migration-only hack.

## 4. Unresolved risks

1. **The DO storage backend is still unconfirmed.** The dashboard
   check (or a staging-DO probe) is the first gate. If legacy, the
   ~130–200 entry ceiling applies and the per-entry-keys plan is
   needed at ~100 entries; switching to SQLite would require a new DO
   class and breaks the `main-v35` identity.
2. **The account plan is unverified.** It determines whether an
   overage is a failure (Free) or a charge (Paid), and it constrains
   the backend (Free can only access SQLite-backed DOs — if the
   account is Free, the DO is almost certainly SQLite; if the DO is
   legacy, the account is almost certainly Paid). The plan and the
   backend must be confirmed together.
3. **The current total DO-storage usage is unverified.** The quotas
   are shared across all DO-storage operations. The catalogue's
   increment is small, but the total must be far below the quotas
   (dashboard metrics) before the migration run.
4. **The API token's KV Read permission is unverified.** The
   canonical read needs a token with Workers KV Storage: Read. If
   the deploy token lacks it, a token with that scope is needed.
5. **The freeze flag's production behaviour is untested in the live
   runtime.** The stub tests (FZ1–FZ3) test the logic; the production
   deploy's correctness (all six routes returning 503) needs a live
   check after the freeze deploy.
6. **KV propagation has no hard bound.** The 10-minute wait + the
   probe + the API central read address this, but the guarantee rests
   on Cloudflare's documented architecture (writes land in the
   central store; the API reads it). If that architecture does not
   hold as documented, the probe (§1.3 step 3) is the check that
   catches it — and the stop condition (§1.5) is the response.

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
   (§3.2). Approving its deployment also approves the G1/G2
   deployment (§3.1). The freeze release is deployed (one deploy,
   or two if `88ef10b` is deployed first separately).
5. **Staging Worker approval** — create `sia-lab-staging` (separate
   Worker + DO, Free plan, no charge) and run the full migration
   end-to-end there first (freeze → probe → API read → seed →
   verify → cutover → post-cutover change → rollback). No production
   migration until the staging run succeeds.
6. **Production migration run approval** — the cutover itself
   (states 2–5 of the previous addendum), using the canonical source
   (§1) and the gates (§1.5). No production migration until gates
   1–5 pass.
7. **F1 implementation approval** — separate, as before. The F1
   commit is on top of the freeze release (§3.1).

## 6. Boundaries and confirmation

- No edits, commits, pushes, PRs, deployments, or production
  operations. No staging Worker creation until separately approved
  (gate 5). No catalogue migration until backend confirmation and all
  source/cutover gates pass. No changes to the `main-v35` DO identity.
  No dual-source fallback or dual writes.
- F1 approval-first design: accepted in principle. DO-storage
  architecture: preferred and accepted in principle. Storage
  migration and operational procedure: awaiting the approvals in §5.
  F1 implementation: not authorized. G1/G2: pinned at `88ef10b`.
  Production: remains on `4f5ab64`.
- This document is **design-only**. No files were edited, no code was
  implemented, no commit, push, PR, deployment, or production
  operation was made. The pinned G1/G2 release (`88ef10b`) and
  production (`4f5ab64`) are untouched.
