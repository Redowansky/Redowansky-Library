# Gate 1 Verification Guide — TunnelDO storage backend

**Read-only guide.** Do not access or change Cloudflare settings on
anyone's behalf, do not create a staging Worker, do not run a
migration probe, do not modify the repository, and do not perform any
production operation. This guide is for Redowan to perform the check
himself in his own Cloudflare account and share the result. It
changes nothing.

## Purpose

Gate 1 of the F1 migration-readiness decision (Rev 4.1 §5): determine
whether the existing `main-v35` Durable Object uses **SQLite-backed**
or **legacy KV-backed** Durable Object storage. The answer decides
the migration path and the storage ceiling (§5 below). No migration
work proceeds until this gate passes.

## Identifiers — check the right object, in the right account

Redowan has two Cloudflare accounts. Check the **main** account only:

| Item | Value |
|---|---|
| Cloudflare account | Main account — **rkpk7242@gmail.com** (NOT acct2 / ironthrone2580@gmail.com) |
| Account ID | `676d7eaee0bab349422d3c91c9690679` |
| Worker (script) | `sia-lab` |
| DO binding | `TUNNEL_DO` |
| DO class | `TunnelDO` |
| DO object name | `main-v35` (via `idFromName("main-v35")` — this is the object instance name, not the namespace ID) |

In the dashboard and in the API, the namespace is identified by
**class `TunnelDO`** and **script `sia-lab`**. The namespace ID itself
is a generated UUID shown in the dashboard/API — record it, it is an
identifier, not a secret.

## Method A — Cloudflare Dashboard (primary)

1. Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) as
   the **main** account (rkpk7242@gmail.com). Confirm you are in the
   main account before proceeding — the account switcher is top-right.
2. Go to **Workers & Pages** → **Durable Objects**. This opens the
   Durable Object namespace list.
3. Find the namespace with **class `TunnelDO`** and **script
   `sia-lab`**. Open it (click the namespace).
4. On the namespace page, look for the **"Total storage"** chart
   (under Metrics / analytics).
   - **If the "Total storage" chart is present → SQLite-backed.**
     Cloudflare's Storage Changelog (Jul 20, 2026) states: *"The chart
     appears only for SQLite-backed Durable Object namespaces. It does
     not appear for namespaces that use the legacy key-value storage
     backend."* Presence of the chart is documented evidence for
     SQLite.
   - **If the chart is absent → NOT conclusive on its own.** Absence
     suggests legacy KV-backed, but it could also mean the chart has
     not populated or there is no data to show yet. **Do not conclude
     legacy from absence alone** — confirm with Method B.
5. Note: the namespace page also has a **Deployments** tab
   (Workers & Pages → Durable Objects → select namespace →
   Deployments tab). It shows the versions of the backing Worker that
   are currently live and the traffic split between them. It does
   **not** show the storage type. Do not mistake the Deployments tab
   for storage evidence.

**What the dashboard does not show:** as far as the current
documentation shows, the dashboard does not display a plain
"Storage backend: SQLite / legacy KV" label on the namespace page.
The documented dashboard signal is the Total storage chart. If the
dashboard UI has changed and shows an explicit storage-type label,
record the exact label text and a screenshot — that would be direct
evidence.

## Method B — Cloudflare API (definitive cross-check, read-only)

If the dashboard is ambiguous (chart absent, or you want certainty),
use the API. This is a read-only `GET` — it changes nothing. It is
the authoritative evidence for this gate.

**Endpoint:**

```
GET https://api.cloudflare.com/client/v4/accounts/676d7eaee0bab349422d3c91c9690679/workers/durable_objects/namespaces
```

**Authentication:** a token with Workers Read permission (at least
one of: Workers Scripts Read, Workers Metadata Read-Only, Workers
Content Read-Only, or the equivalent Individual Workers read
permission). Use the token in an `Authorization: Bearer` header.
**Never paste the token value into chat, into the decision record, or
into any file.**

**Command** (run it yourself; substitute your own token):

```bash
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/676d7eaee0bab349422d3c91c9690679/workers/durable_objects/namespaces?per_page=1000" \
  | python3 -m json.tool
```

**Pagination — check it explicitly.** The API returns 20 namespaces
per page by default, so a namespace can be overlooked in a larger
list if you only read the first page. The schema allows
`per_page` up to **1000** (verified against the official API
reference, 2026-11-13), so request `?per_page=1000`. Then, before
concluding anything, read **`result_info`** in the response
(`total_count`, `total_pages`, `page`, `per_page`):
- If `total_pages` is 1, you have the whole list.
- If `total_pages` is greater than 1, fetch each subsequent page
  (`?page=2&per_page=1000`, `?page=3&per_page=1000`, …) and search
  each one, until the TunnelDO / sia-lab entry is found or all pages
  are exhausted.
- Only conclude the entry is absent after **all** pages are checked.
  (This account is expected to have very few namespaces, so one page
  will almost certainly suffice — but check `result_info` rather than
  assuming it.)

**How to read the result:** the response is a list of namespaces.
Find the entry where `class == "TunnelDO"` and `script == "sia-lab"`.
Read its **`use_sqlite`** field (Cloudflare API reference, "List
Durable Object Namespaces": `Namespace { id, class, name, script?,
use_sqlite? }`).

- **`use_sqlite: true` → SQLite-backed. (Definitive.)**
- **`use_sqlite: false` → legacy KV-backed. (Definitive.)**
- **`use_sqlite` absent or `null` → INCONCLUSIVE.** The field is
  **optional** in the official API schema (`use_sqlite : optional
  boolean`, verified 2026-11-13). A missing or null field is not
  evidence for either backend. **Never interpret a missing field as
  `false`, and never automatically classify it as legacy KV-backed.**
  If the field is absent or null, record the backend as INCONCLUSIVE
  and use the dashboard evidence (Method A) or the staging-DO probe
  fallback (Method C, needs gate 5 approval) instead.

Record the namespace `id` (UUID), the exact `use_sqlite` value (or
"absent/null"), and the pagination check (`result_info.total_pages`
and the pages checked). That is the evidence for the decision record.

## Method C — Runtime probe (NOT available now; do not attempt)

`state.storage.sql` exists only on SQLite-backed Durable Objects;
calling the SQL API on a KV-backed class returns an error. A runtime
check (e.g. `typeof state.storage.sql !== "undefined"`) would be
definitive. **But it is not available now:** it requires either
(a) a staging DO (gate 5, not approved) or (b) a code change plus a
deployment to production (not approved). There is no existing endpoint
in `worker.js` that exposes `state.storage.sql`. **Do not attempt a
runtime probe now.** If Methods A and B both fail to establish the
backend, the fallback is the staging-DO probe — which needs its own
separate approval (gate 5) — not an improvised production change.

## What does NOT establish the backend (do not infer)

- **The class name `TunnelDO` or the object name `main-v35`.**
  Names carry no storage information.
- **The existing code.** `worker.js` uses only the KV-style storage
  API (`state.storage.get` / `put`), which **both** backends support.
  There is no `wrangler.toml`; the deploy script omits the
  `migrations` key entirely (comment: "migrations only needed once
  (class already created); omit on updates"). The code and config give
  no evidence either way. (Cloudflare docs note the config trace
  — `new_sqlite_classes` = SQLite, `new_classes` = legacy KV — but
  there is no config file to trace here.)
- **The account plan alone.** Free can only create/access
  SQLite-backed DOs, so a Free plan would *suggest* SQLite — but
  that is an inference from the plan, not direct evidence of this
  namespace's backend. (And the plan is itself unverified — gate 2.)
- **The fact that the DO works, or that it holds data.** Both
  backends store data and serve requests.
- **"It is probably SQLite because it is newer."** Not evidence.

## Confirmed evidence vs assumptions

| | Status |
|---|---|
| `use_sqlite: true/false` from the API for the TunnelDO / sia-lab namespace | **Confirmed** (direct, authoritative) |
| `use_sqlite` absent or `null` in the API response | **Inconclusive** — the field is optional in the schema; a missing field is not evidence for either backend. Never interpret it as `false` / legacy KV-backed. |
| "Total storage" chart present in the dashboard for this namespace | **Confirmed** (documented to appear only for SQLite-backed namespaces) |
| "Total storage" chart absent | **Suggestive only** — points toward legacy, but not conclusive; confirm with Method B |
| Class/object names, code style, account plan, "probably SQLite" | **Assumption, not evidence** |
| The TunnelDO / sia-lab entry not found in the API list | **Inconclusive until all pages are checked** — verify `result_info.total_pages` and fetch every page (`per_page=1000`) before concluding it is absent |

Record the evidence level for whatever you find: `confirmed (API
use_sqlite)`, `confirmed (dashboard Total storage chart present)`, or
`inconclusive (chart absent, API not run)`.

## What to record — and what NOT to record

**Record:**
- Date and time of the check.
- Account (main, rkpk7242@gmail.com — no password), Worker `sia-lab`,
  class `TunnelDO`, object `main-v35`, namespace ID (UUID).
- Method(s) used (A, B, or both).
- The exact evidence: e.g. "`use_sqlite: true`" or "Total storage
  chart present". Quote the field/label exactly.
- A screenshot of the dashboard namespace page (crop out any token
  or API key if one is visible on screen).
- The conclusion: SQLite-backed / legacy KV-backed / inconclusive.
- The evidence level (see the table above).

**Do NOT record:**
- Any API token value, password, session cookie, or one-time code.
  Never paste a token into chat or into the decision record. The
  namespace ID and account ID are identifiers, not secrets — they are
  safe to record. If an API response is pasted, check it contains no
  credential before sharing it.

## How the result affects the migration path

**If SQLite-backed:**
- The whole-object catalogue move fits easily. Current catalogue
  ~7 KB (11 entries, ~640 B/entry average). SQLite per-value limit is
  **8 MB** (key + value combined) → ceiling ~13,000 entries at the
  measured average. No per-entry-keys change is needed.
- The migration proceeds (subject to gates 2–7).

**If legacy KV-backed:**
- The whole-object catalogue fits **now** (~7 KB) but the per-value
  limit is **128 KiB (131,072 B)** → ceiling ~130–200 entries
  (~204 at the measured 640 B/entry average; ~131 at 1 KB/entry).
- The migration can still proceed with the whole-object move, **but**
  the per-entry-keys plan must be adopted when the catalogue
  approaches ~100 entries. This is the gate 3 decision: accept the
  ceiling + the per-entry-keys plan, or choose the larger
  DO-identity migration instead.
- Switching the existing namespace to SQLite **in place is not
  possible**: storage type is immutable once a namespace exists, and
  Cloudflare rejects a switch with `storage_type_mismatch`. Switching
  would require deleting the namespace and re-provisioning it under
  SQLite (with full data loss in between) or creating a **new** DO
  class — which breaks the `main-v35` identity and requires migrating
  all DO-storage state (`admin_pw`, `tmdb_key`, sessions, progress,
  views, `meta:*`). That is a DO-identity migration, **out of scope**
  for this F1 work.

**If inconclusive:**
- Gate 1 does **not** pass. Do not proceed to gate 2 on an
  assumption. The fallback is the staging-DO runtime probe (needs
  gate 5 approval) or re-checking the dashboard/API. The migration
  stops at gate 1 until the backend is confirmed.

## Context (not evidence about `main-v35`)

- Cloudflare Storage Changelog (Jul 15, 2026): "New Durable Object
  namespaces must use the SQLite storage backend... If your account
  does not already have a key-value (KV) backed Durable Object
  namespace, you can no longer create new ones." This is about *new*
  namespaces, not about `main-v35`, which predates it. It is context,
  not evidence.
- The storage backend is immutable once a namespace exists
  (Cloudflare docs, "Durable Object class exports").

## Sources

- Cloudflare Storage Changelog (Jul 20, 2026) — "View total SQLite
  storage for Durable Object namespaces": the Total storage chart
  "appears only for SQLite-backed Durable Object namespaces."
  (developers.cloudflare.com/changelog/product-group/storage/2/)
- Cloudflare Storage Changelog (Sep 16, 2026) — "View deployments
  for Durable Objects in the dashboard": Workers & Pages → Durable
  Objects → select a namespace → Deployments tab.
- Cloudflare API reference — "List Durable Object Namespaces":
  `GET /accounts/{account_id}/workers/durable_objects/namespaces`,
  `Namespace { id, class, name, script?, use_sqlite? }`.
  (developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/)
  Verified 2026-11-13: `use_sqlite` is **optional** (`use_sqlite :
  optional boolean`); `per_page` accepts up to **1000** (default 20);
  `result_info` carries `count`, `page`, `per_page`, `total_count`,
  `total_pages`.
- Cloudflare docs — "Durable Object class exports": storage is
  `"sqlite"` or `"legacy-kv"`; immutable once a namespace exists;
  `storage_type_mismatch` on a switch.
- Cloudflare docs — "SQLite-backed Durable Object Storage": SQL API
  available on SQLite only; KV API (async) on both.
- Cloudflare docs — Durable Objects pricing: SQLite per-value limit
  8 MB; legacy KV per-value limit 128 KiB.
