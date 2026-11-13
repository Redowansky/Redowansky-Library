#!/usr/bin/env python3
"""Idempotent partial-write recovery for discovery (review 2026-11-13 item 1).

A discovery run's batch writes are three separate KV PUTs (queue, seen,
state) — not a transaction. If the queue write lands but the seen write
fails, candidates sit in ext:pending with no seen entry and the totals
bump is lost. reconcileDiscoveryState heals that gap from the queue
itself, using existing candidate IDs / TMDB IDs, and is safe to run any
time (re-running finds no gaps). Called at the start of every run and in
the mid-run failure path, both inside the admin lock. Each anchor is
asserted to occur exactly once.
"""
P = "/home/hatch/workspace/sia-lab/worker.js"
src = open(P, encoding="utf-8").read()

def rep(old, new, count=1):
    global src
    n = src.count(old)
    assert n == count, f"anchor count {n} (want {count}): {old[:100]!r}"
    src = src.replace(old, new)

# --- 1. the reconciler helper (after saveDiscoveryState) ---
rep('''async function saveDiscoveryState(env, obj){
  await env.DATA_KV.put("ext:discovery:state", JSON.stringify(obj));
}''',
'''async function saveDiscoveryState(env, obj){
  await env.DATA_KV.put("ext:discovery:state", JSON.stringify(obj));
}
// Idempotent recovery for partial-write failures (review 2026-11-13).
// A discovery run persists three separate KV keys (queue, seen, state),
// not a transaction. If the queue write lands but the seen write fails,
// candidates sit in ext:pending with no seen entry (and the totals bump
// is lost). Heal that gap from the queue itself: every queued discovery
// candidate (has discoveredAt — manual candidates do not) missing from
// seen gets a seen entry in its own status (pending/rejected), and
// totals.discovered is bumped by the healed count. Safe to run any time:
// re-running finds no gaps and writes nothing. Never throws.
// `state` is the caller's in-memory state object — it is kept in sync so
// a later finish() cannot overwrite the bump with a stale value; the
// state is re-read fresh before saving so a concurrent admin config
// change is not clobbered.
async function reconcileDiscoveryState(env, state){
  try {
    const pend = await getPending(env);
    const seen = await getSeen(env);
    const today = new Date().toISOString().slice(0, 10);
    let healed = 0;
    for (const c of Object.values(pend)) {
      if (!c || !c.tmdb || !c.discoveredAt) continue;
      const k = c.type + ":" + c.tmdb;
      if (seen[k]) continue;
      seen[k] = { type: c.type, tmdb: c.tmdb, title: c.title, firstSeen: (c.discoveredAt || "").slice(0, 10) || today, lastSeen: today, status: c.status === "rejected" ? "rejected" : "pending" };
      healed++;
    }
    if (!healed) return 0;
    await saveSeen(env, seen);
    const fresh = await getDiscoveryState(env);
    fresh.totals.discovered = (fresh.totals.discovered || 0) + healed;
    await saveDiscoveryState(env, fresh);
    if (state) state.totals.discovered = fresh.totals.discovered;
    return healed;
  } catch (e) { return 0; }
}''')

# --- 2. call site (a): start of every run, after the API-key check ---
rep('''    const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
    if (!apiKey) return finish("failed", "no TMDB key");
    try {''',
'''    const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
    if (!apiKey) return finish("failed", "no TMDB key");
    // Heal any seen-map gap left by an earlier partial-write failure
    // before this run dedupes (idempotent; no-op when nothing is missing).
    await this._withAdminLock(() => reconcileDiscoveryState(env, state));
    try {''')

# --- 3. call site (b): mid-run failure path, before recording the failure ---
rep('''      return finish("ok", null);
    } catch (e) {
      return finish("failed", String((e && e.message) || e));
    }''',
'''      return finish("ok", null);
    } catch (e) {
      // Heal any partial write from the run that just failed, so the
      // failed run itself leaves queue/seen consistent.
      await this._withAdminLock(() => reconcileDiscoveryState(env, state));
      return finish("failed", String((e && e.message) || e));
    }''')

open(P, "w", encoding="utf-8").write(src)
print("reconciler build applied OK, new size:", len(src))
