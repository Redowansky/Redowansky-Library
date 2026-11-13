#!/usr/bin/env python3
"""Fix the runDiscovery flag-cleanup edge case (review 2026-11-13 item 1).

The TMDB-key lookup (and the state read) sat before the main try/finally:
if either await threw, _discoveryRunning stayed true forever and every
later run returned "skipped". Fix: everything after the flag set now sits
inside an outer try/finally, and the outer catch records a setup failure
as a failed run (queue/seen/totals untouched) when state is reachable.
Each anchor is asserted to occur exactly once.
"""
P = "/home/hatch/workspace/sia-lab/worker.js"
src = open(P, encoding="utf-8").read()

def rep(old, new, count=1):
    global src
    n = src.count(old)
    assert n == count, f"anchor count {n} (want {count}): {old[:100]!r}"
    src = src.replace(old, new)

# --- head: open the outer try right after the flag set ---
rep('''    // Overlap guard (hardening 2026-11-13): the flag is set synchronously
    // BEFORE the first await, so two invocations arriving together cannot
    // both pass the check (the old code checked it before the async
    // TMDB-key read, leaving a gap). Every early return clears it.
    if (this._discoveryRunning) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "a run is already in progress" };
    this._discoveryRunning = true;
    const state = await getDiscoveryState(env);
    const finish = async (status, error) => {
      state.lastRun = { at: runAt, trigger, status, counts, durationMs: Date.now() - started, error: error || null };
      if (status === "ok") state.lastSuccess = { at: runAt, trigger, counts: { ...counts }, durationMs: Date.now() - started };
      state.nextRunAt = nextRunAtFor(state.frequency, started);
      await saveDiscoveryState(env, state);
      return state.lastRun;
    };
    if (trigger === "cron") {
      if (!state.enabled) { this._discoveryRunning = false; return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "discovery disabled" }; }
      if (state.nextRunAt && started < Date.parse(state.nextRunAt)) { this._discoveryRunning = false; return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "not due yet" }; }
    }
    const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
    if (!apiKey) { const r = await finish("failed", "no TMDB key"); this._discoveryRunning = false; return r; }
    try {''',
'''    // Overlap guard (hardening 2026-11-13, flag cleanup fixed 2026-11-13):
    // the flag is set synchronously BEFORE the first await, so two
    // invocations arriving together cannot both pass the check. The
    // try/finally below guarantees the flag is always reset, even if
    // the state read or the TMDB-key read throws.
    if (this._discoveryRunning) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "a run is already in progress" };
    this._discoveryRunning = true;
    try {
    const state = await getDiscoveryState(env);
    const finish = async (status, error) => {
      state.lastRun = { at: runAt, trigger, status, counts, durationMs: Date.now() - started, error: error || null };
      if (status === "ok") state.lastSuccess = { at: runAt, trigger, counts: { ...counts }, durationMs: Date.now() - started };
      state.nextRunAt = nextRunAtFor(state.frequency, started);
      await saveDiscoveryState(env, state);
      return state.lastRun;
    };
    if (trigger === "cron") {
      if (!state.enabled) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "discovery disabled" };
      if (state.nextRunAt && started < Date.parse(state.nextRunAt)) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "not due yet" };
    }
    const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
    if (!apiKey) return finish("failed", "no TMDB key");
    try {''')

# --- tail: outer catch records setup failures; outer finally resets the flag ---
rep('''      return finish("ok", null);
    } catch (e) {
      return finish("failed", String((e && e.message) || e));
    } finally {
      this._discoveryRunning = false;
    }
  }''',
'''      return finish("ok", null);
    } catch (e) {
      return finish("failed", String((e && e.message) || e));
    }
    } catch (e) {
      // Setup failure (state read / TMDB-key read threw, or finish()
      // threw while saving): record a failed run if state is reachable,
      // otherwise return the failure inline. Queue/seen/totals untouched.
      try {
        const s2 = await getDiscoveryState(env);
        s2.lastRun = { at: runAt, trigger, status: "failed", counts, durationMs: Date.now() - started, error: String((e && e.message) || e) };
        s2.nextRunAt = nextRunAtFor(s2.frequency, started);
        await saveDiscoveryState(env, s2);
        return s2.lastRun;
      } catch (e2) {
        return { at: runAt, trigger, status: "failed", counts, durationMs: Date.now() - started, error: String((e && e.message) || e) };
      }
    } finally {
      this._discoveryRunning = false;
    }
  }''')

open(P, "w", encoding="utf-8").write(src)
print("flag-cleanup fix applied OK, new size:", len(src))
