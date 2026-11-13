// Cron verification checks for the Phase 2a hardening (2026-11-13).
// Companion to test_phase2a.mjs — covers what that suite does not.
// Run: node .phase2a-test/verify_cron_checks.mjs (from ~/workspace/sia-lab)
//   1. frequency mapping: nextRunAt = run +1d / +2d / +7d
//   2. failed run preserves totals + seen-map + queue (lastRun is replaced
//      by the failure record — by design, see output)
//   3. internal route with NO secret configured -> 403 (fail closed)
//   4. two CONCURRENT runs on one DO instance (cron + manual at the same
//      moment) — do they double-file? (overlap race check)
import assert from "node:assert/strict";
import { TunnelDO } from "./worker.mjs";

function makeKV(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async get(k, fmt) { const v = m.get(k); if (v == null) return null; return fmt === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    _map: m,
  };
}
function makeDO({ kv, tmdbKey = "FAKEKEY", cronSecret = "cronsecret", live = null, slowKey = false, failPut = false } = {}) {
  const env = { DATA_KV: kv, TMDB_KEY: undefined, DISCOVERY_CRON_SECRET: cronSecret, S3_ACCESS_KEY: "x", S3_SECRET_KEY: "y" };
  const state = { storage: {
    get: async (k) => {
      if (slowKey) await new Promise((r) => setTimeout(r, 5));
      return k === "tmdb_key" ? tmdbKey : k === "admin_pw" ? "pw123" : null;
    },
    put: async () => {},
  } };
  const d = new TunnelDO(state, env);
  d.listMovies = async () => live || [{ id: "emv", title: "Iron Man", tmdb: 1726, year: "2008", type: "movie" }];
  if (failPut) { const origPut = kv.put.bind(kv); kv.put = async (k, v) => { if (k === "ext:pending") throw new Error("kv put boom"); return origPut(k, v); }; }
  return d;
}
const DETAILS = {
  "movie:1001": { id: 1001, title: "New Movie One", release_date: "2026-11-12", overview: "One.", poster_path: "/p1.jpg", backdrop_path: "/b1.jpg", vote_average: 7.8, genres: [{ name: "Action" }] },
  "movie:1002": { id: 1002, title: "New Movie Two", release_date: "2026-11-11", overview: "Two.", poster_path: "/p2.jpg", backdrop_path: null, vote_average: 6.5, genres: [{ name: "Drama" }] },
  "tv:2001": { id: 2001, name: "New Show", first_air_date: "2026-11-10", overview: "Show.", poster_path: "/p3.jpg", backdrop_path: "/b3.jpg", vote_average: 8.1, genres: [{ name: "Sci-Fi" }] },
};
function cannedFetch() {
  return async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) return ok({ results: [{ id: 1001, popularity: 5 }, { id: 1726, popularity: 90 }] });
    if (u.includes("/discover/tv")) return ok({ results: [{ id: 2001, popularity: 8 }] });
    if (u.includes("/trending/movie")) return ok({ results: [{ id: 1001, popularity: 5 }, { id: 1002, popularity: 50 }] });
    if (u.includes("/trending/tv")) return ok({ results: [{ id: 2001, popularity: 8 }, { id: 3001, popularity: 1 }, { id: 4001, popularity: 1 }] });
    if (u.includes("/watch/providers")) return ok({ results: { BD: { flatrate: [{ provider_name: "Netflix" }] }, US: { flatrate: [{ provider_name: "Hulu" }] } } });
    const m = u.match(/\/(movie|tv)\/(\d+)\?/);
    if (m) return ok(DETAILS[m[1] + ":" + m[2]] || {});
    return ok({});
  };
}
async function kvObj(kv, key) { return JSON.parse(kv._map.get(key) || "{}"); }
const dayMs = 864e5;

console.log("--- 1. frequency mapping (nextRunAt after a run) ---");
for (const [freq, days] of [["daily", 1], ["every2days", 2], ["weekly", 7]]) {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv });
  await kv.put("ext:discovery:state", JSON.stringify({ enabled: true, frequency: freq, sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null }));
  const run = await d.runDiscovery(d.env, "manual");
  const st = await kvObj(kv, "ext:discovery:state");
  const gap = (Date.parse(st.nextRunAt) - Date.parse(run.at)) / dayMs;
  console.log(`  ${freq}: status=${run.status} nextRunAt-runAt = ${gap} day(s) (expect ${days})`);
  assert.equal(gap, days);
}

console.log("--- 2. failed run preserves totals + seen + queue ---");
{
  const kv = makeKV({
    "ext:pending": { "p-old": { id: "p-old", title: "Old", type: "movie", tmdb: 555, status: "pending", createdAt: 1 } },
    "ext:discovery:seen": { "movie:555": { type: "movie", tmdb: 555, title: "Old", firstSeen: "2026-11-12", lastSeen: "2026-11-12", status: "pending" } },
    "ext:discovery:state": { enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: { at: "2026-11-12T02:00:00.000Z", trigger: "cron", status: "ok", counts: { fetched: 80, newCandidates: 15, duplicates: 1, skipped: 64, failed: 0 }, durationMs: 4000, error: null }, totals: { discovered: 15, approved: 0, rejected: 0 }, nextRunAt: "2026-11-13T02:00:00.000Z" },
  });
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv, failPut: true }); // batch write throws mid-run
  const run = await d.runDiscovery(d.env, "cron");
  const st = await kvObj(kv, "ext:discovery:state");
  const pend = await kvObj(kv, "ext:pending");
  const seen = await kvObj(kv, "ext:discovery:seen");
  console.log(`  run status=${run.status} error=${run.error}`);
  console.log(`  lastRun now: status=${st.lastRun.status} (previous 'ok' record replaced: ${st.lastRun.status !== "ok"})`);
  console.log(`  totals.discovered still ${st.totals.discovered} (was 15); queue still ${Object.keys(pend).length} entry; seen still ${Object.keys(seen).length} entry`);
  assert.equal(run.status, "failed");
  assert.equal(st.totals.discovered, 15);
  assert.deepEqual(Object.keys(pend), ["p-old"]);
  assert.deepEqual(Object.keys(seen), ["movie:555"]);
}

console.log("--- 3. internal route with NO secret configured -> 403 ---");
{
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv, cronSecret: undefined });
  const res = await d.fetch(new Request("https://internal/api/internal/discovery/run", { method: "POST", headers: { "x-cron-secret": "anything" } }));
  console.log(`  status=${res.status} (expect 403)`);
  assert.equal(res.status, 403);
}

console.log("--- 4. two CONCURRENT runs on one DO (overlap race) ---");
{
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv, slowKey: true }); // production-like: TMDB key via async DO storage read
  await kv.put("ext:discovery:state", JSON.stringify({ enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null }));
  const [r1, r2] = await Promise.all([d.runDiscovery(d.env, "cron"), d.runDiscovery(d.env, "manual")]);
  const pend = await kvObj(kv, "ext:pending");
  const tmdbIds = Object.values(pend).map((c) => c.tmdb).sort();
  const dupes = tmdbIds.filter((v, i) => tmdbIds.indexOf(v) !== i);
  console.log(`  run1=${r1.status} run2=${r2.status} (one should be 'skipped' if the guard held)`);
  console.log(`  queue entries=${Object.keys(pend).length} (3 expected if guard held)`);
  console.log(`  double-filed tmdb ids: ${dupes.length ? dupes.join(",") : "none"}`);
}
console.log("DONE");
