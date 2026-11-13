# F1 design documents — approval-first publishing + DO-storage migration readiness

Read-only design documentation for the Redowansky Library Worker
(`sia-lab`). No code in this folder is executed; these are the
review records for ChatGPT and for the decision log.

## Authoritative document

**`PHASE2A_F1_MIGRATION_READINESS_REV4_1.md`** is the final decision
document. The F1 migration-readiness design review is **closed**
(accepted 2026-11-13). The DO-storage migration is **not authorized**;
all seven approval gates remain separate. Production remains on
`4f5ab64`; G1/G2 remains pinned at `88ef10b`, undeployed.

## Reading order

1. `PHASE2A_SECURITY_AUDIT.md` + `PHASE2A_SECURITY_AUDIT_ADDENDUM.md`
   — security audit of production `4f5ab64` (findings F1–F10, G1–G6).
2. `PHASE2A_F1_AUDIT.md` — F1 audit: approval-first is a UI
   convention, not a server guarantee (confirmed with repros).
3. `PHASE2A_F1_DESIGN_REV2.md` — F1 design revision 2 (provenance,
   meta-edit proposals in the approval queue).
4. `PHASE2A_F1_DESIGN_ADDENDUM.md` — meta-approve sequence,
   partial-write model, consistency map.
5. `PHASE2A_F1_DESIGN_REV2_1.md` — revision 2.1 (bounded provenance
   regex, corrected partial-write matrix, admin lookup route).
6. `PHASE2A_F1_IMPLEMENTATION_READINESS.md` — implementation-readiness
   checklist (tests R38–R57, commit scope).
7. `PHASE2A_F1_STORAGE_SAFETY_ADDENDUM.md` — storage-safety addendum:
   whole-object KV write-back can lose unrelated newer fields; moving
   `ext:movies` into the existing DO's own storage is the proposed fix.
8. `PHASE2A_F1_MIGRATION_READINESS_ADDENDUM.md` — migration-readiness
   addendum v1 (backend, size, cutover/rollback, staging requirement).
9. `PHASE2A_F1_MIGRATION_READINESS_REV2.md` — revision 2 (canonical
   KV API read, corrected billing, freeze release contents).
10. `PHASE2A_F1_MIGRATION_READINESS_REV3.md` — revision 3 (qualified
    source guarantee, 50M/day row-read quota).
11. `PHASE2A_F1_MIGRATION_READINESS_REV4.md` — revision 4 (corrected
    disagreement rule, tightened cache-expiry procedure, quota
    unresolved).
12. `PHASE2A_F1_MIGRATION_READINESS_REV4_1.md` — **revision 4.1, the
    authoritative final document** (fixed read timeline with
    timestamps, backup reconciliation before seeding, complete
    uncertainties list and conclusion).
13. `GATE1_VERIFICATION_GUIDE.md` + `GATE1_DECISION_RECORD_TEMPLATE.md`
    — Gate 1: how to verify the existing `TunnelDO` storage backend
    (SQLite vs legacy KV) in the Cloudflare dashboard / API, and the
    decision-record template.

Earlier revisions are history. Do not review a superseded revision as
if it were current; Rev 4.1 supersedes them.
