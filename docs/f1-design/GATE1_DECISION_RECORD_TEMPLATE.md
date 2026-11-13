# Gate 1 Decision Record — TunnelDO storage backend

**Gate 1 of the F1 migration-readiness decision (Rev 4.1 §5).**
Fill in after performing the check in `GATE1_VERIFICATION_GUIDE.md`.
Record facts only. **No token, password, session value, or one-time
code is recorded in this record — ever.**

## Check

- **Date / time (Dhaka):**
- **Checked by:**
- **Cloudflare account:** Main — rkpk7242@gmail.com (account ID `676d7eaee0bab349422d3c91c9690679`)
- **Worker:** `sia-lab`
- **DO class:** `TunnelDO`
- **DO object name:** `main-v35`
- **Namespace ID (UUID, from dashboard/API):**

## Method(s) used

- [ ] A — Dashboard: Workers & Pages → Durable Objects → TunnelDO / sia-lab namespace
- [ ] B — API: `GET /accounts/676d7eaee0bab349422d3c91c9690679/workers/durable_objects/namespaces`
- [ ] C — Runtime probe (only if separately approved — not available at Gate 1)

## Exact evidence

- **Dashboard — "Total storage" chart:** present / absent
  (Exact label seen, if any other storage label is shown:)
- **API — `use_sqlite` value:** true / false / not run
  (Quote the field exactly as returned for the TunnelDO / sia-lab entry.)
- **Screenshot:** (file name / link — crop out any token or key if visible)

## Conclusion

- **Backend:** SQLite-backed / legacy KV-backed / inconclusive
- **Evidence level:** confirmed (API `use_sqlite`) / confirmed (dashboard Total storage chart present) / inconclusive
- **What was NOT used as evidence:** (confirm: no inference from the class/object name, the code, or the account plan)

## Effect on the migration path

- If **SQLite-backed**: whole-object catalogue move fits (ceiling ~13,000 entries at the measured average). No per-entry-keys change needed. Proceed to gate 2.
- If **legacy KV-backed**: whole-object move fits now (~7 KB) but the 128 KiB per-value ceiling applies (~130–200 entries). Gate 3 decision required: accept the ceiling + the per-entry-keys plan at ~100 entries, or choose the larger DO-identity migration instead. In-place switch to SQLite is not possible.
- If **inconclusive**: Gate 1 does not pass. Migration stops here. Fallback: staging-DO runtime probe (needs gate 5 approval) or re-check dashboard/API.

## Gate 1 verdict

- [ ] **PASS** — backend confirmed (SQLite-backed / legacy KV-backed), evidence recorded above.
- [ ] **FAIL / INCONCLUSIVE** — backend not established. Migration stops at Gate 1.

## Secrets attestation

- [ ] No API token, password, session cookie, or one-time code is recorded in this record or in any screenshot attached to it.
