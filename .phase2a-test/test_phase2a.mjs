// Phase 2a unit tests for runDiscovery + discovery routes (real code, stubbed I/O).
// Run: node --test .phase2a-test/test_phase2a.mjs  (from ~/workspace/sia-lab)
// worker.mjs is a local copy of worker.js with the cloudflare:email import
// stubbed — regenerate it before running:
//   sed '1s/.*/\/\/ test stub: EmailMessage is cloudflare-only\nclass EmailMessage { constructor(from, to, body) { this.from = from; this.to = to; this.body = body; } }/' worker.js > .phase2a-test/worker.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { TunnelDO } from "./worker.mjs";

// ---- stubs ---------------------------------------------------------------
function makeKV(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async get(k, fmt) { const v = m.get(k); if (v == null) return null; return fmt === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    _map: m,
  };
}
function makeDO({ kv, tmdbKey = "FAKEKEY", cronSecret = "cronsecret", live = null, fetchFn = null } = {}) {
  const env = { DATA_KV: kv, TMDB_KEY: undefined, DISCOVERY_CRON_SECRET: cronSecret, S3_ACCESS_KEY: "x", S3_SECRET_KEY: "y" };
  const state = { storage: {
    get: async (k) => (k === "tmdb_key" ? tmdbKey : k === "admin_pw" ? "pw123" : null),
    put: async () => {},
  } };
  const d = new TunnelDO(state, env);
  d.listMovies = async () => live || [{ id: "emv", title: "Iron Man", tmdb: 1726, year: "2008", type: "movie" }];
  return d;
}
const DETAILS = {
  "movie:1001": { id: 1001, title: "New Movie One", release_date: "2026-11-12", overview: "One.", poster_path: "/p1.jpg", backdrop_path: "/b1.jpg", vote_average: 7.8, genres: [{ name: "Action" }] },
  "movie:1002": { id: 1002, title: "New Movie Two", release_date: "2026-11-11", overview: "Two.", poster_path: "/p2.jpg", backdrop_path: null, vote_average: 6.5, genres: [{ name: "Drama" }] },
  "tv:2001": { id: 2001, name: "New Show", first_air_date: "2026-11-10", overview: "Show.", poster_path: "/p3.jpg", backdrop_path: "/b3.jpg", vote_average: 8.1, genres: [{ name: "Sci-Fi" }] },
};
function cannedFetch({ failDiscoverMovie = false } = {}) {
  let calls = 0;
  const fn = async (url) => {
    calls++;
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    const bad = () => ({ ok: false, status: 429, json: async () => ({}) });
    if (u.includes("/discover/movie")) return failDiscoverMovie ? bad() : ok({ results: [{ id: 1001, popularity: 5 }, { id: 1726, popularity: 90 }] });
    if (u.includes("/discover/tv")) return ok({ results: [{ id: 2001, popularity: 8 }] });
    if (u.includes("/trending/movie")) return ok({ results: [{ id: 1001, popularity: 5 }, { id: 1002, popularity: 50 }] });
    if (u.includes("/trending/tv")) return ok({ results: [{ id: 2001, popularity: 8 }, { id: 3001, popularity: 1 }, { id: 4001, popularity: 1 }] });
    if (u.includes("/watch/providers")) return ok({ results: { BD: { flatrate: [{ provider_name: "Netflix" }] }, US: { flatrate: [{ provider_name: "Hulu" }] } } });
    const m = u.match(/\/(movie|tv)\/(\d+)\?/);
    if (m) return ok(DETAILS[m[1] + ":" + m[2]] || {});
    return ok({});
  };
  fn.calls = () => calls;
  return fn;
}
async function kvObj(kv, key) { return JSON.parse(kv._map.get(key) || "{}"); }

// ---- tests ---------------------------------------------------------------
test("manual run files only the genuinely new titles", async () => {
  const kv = makeKV({
    "ext:pending": { "p-rej": { id: "p-rej", title: "Old Reject", type: "movie", tmdb: 4001, status: "rejected", createdAt: 1 } },
    "ext:discovery:seen": { "tv:3001": { type: "tv", tmdb: 3001, title: "Rejected Show", firstSeen: "2026-11-01", lastSeen: "2026-11-10", status: "rejected" } },
  });
  const fetchFn = cannedFetch();
  globalThis.fetch = fetchFn;
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "ok");
  assert.deepEqual(run.counts, { fetched: 8, newCandidates: 3, duplicates: 3, skipped: 0, failed: 0, bySource: { "tmdb-discover": 3, "tmdb-trending": 5 } });
  const pend = await kvObj(kv, "ext:pending");
  const fresh = Object.values(pend).filter((c) => c.id !== "p-rej");
  assert.equal(fresh.length, 3);
  const byTmdb = Object.fromEntries(fresh.map((c) => [c.tmdb, c]));
  assert.equal(byTmdb[1001].discoveredVia, "tmdb-discover"); // first via wins
  assert.equal(byTmdb[1002].discoveredVia, "tmdb-trending");
  assert.equal(byTmdb[2001].type, "tv");
  for (const c of fresh) { assert.equal(c.needsSource, true); assert.deepEqual(c.sources, []); assert.equal(c.status, "pending"); }
  assert.deepEqual(byTmdb[1001].providers, { BD: ["Netflix"], US: ["Hulu"] });
  const seen = await kvObj(kv, "ext:discovery:seen");
  assert.equal(seen["movie:1001"].status, "pending");
  assert.equal(seen["movie:1726"].status, "live-dup"); // Iron Man, live
  assert.equal(seen["tv:3001"].status, "rejected");
  assert.equal(seen["tv:4001"].status, "rejected"); // found in queue as rejected (seen key uses the discovery type: tv)
  const state = await kvObj(kv, "ext:discovery:state");
  assert.equal(state.totals.discovered, 3);
  assert.equal(state.lastRun.trigger, "manual");
  assert.ok(state.nextRunAt);
});

test("second identical run files nothing (idempotent)", async () => {
  const kv = makeKV({
    "ext:pending": { "p-rej": { id: "p-rej", title: "Old Reject", type: "movie", tmdb: 4001, status: "rejected", createdAt: 1 } },
    "ext:discovery:seen": { "tv:3001": { type: "tv", tmdb: 3001, title: "Rejected Show", firstSeen: "2026-11-01", lastSeen: "2026-11-10", status: "rejected" } },
  });
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv });
  await d.runDiscovery(d.env, "manual");
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok");
  assert.equal(run2.counts.newCandidates, 0);
  assert.equal(run2.counts.duplicates, 8); // all 8 rows now known
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 4); // 3 new + 1 pre-seeded reject
});

test("popularity-first ordering across lists", async () => {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv });
  const state0 = { enabled: false, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 2, maxDetailCalls: 30 }, lastRun: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null };
  await kv.put("ext:discovery:state", JSON.stringify(state0));
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.counts.newCandidates, 2);
  const pend = await kvObj(kv, "ext:pending");
  const filed = Object.values(pend).map((c) => c.tmdb).sort();
  // 1002 (trending, pop 50) and 2001 (pop 8) beat 1001 (discover, pop 5)
  // even though discover/movie is fetched first.
  assert.deepEqual(filed, [1002, 2001]);
});

test("budget cap: overflow titles wait for the next run", async () => {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv });
  const state0 = { enabled: false, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 2, maxDetailCalls: 30 }, lastRun: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null };
  await kv.put("ext:discovery:state", JSON.stringify(state0));
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.counts.newCandidates, 2);
  const seen1 = await kvObj(kv, "ext:discovery:seen");
  assert.equal(Object.keys(seen1).filter((k) => seen1[k].status === "pending").length, 2);
  // Popularity-first: with budget 2 the run files the two most popular
  // fresh titles (1002 pop 50, 2001 pop 8) — not the first two in list
  // order (1001 pop 5 would have won under the old date/list order).
  assert.equal(seen1["movie:1002"].status, "pending");
  assert.equal(seen1["tv:2001"].status, "pending");
  assert.ok(!seen1["movie:1001"]);
  state0.budget.maxNewPerRun = 15;
  await kv.put("ext:discovery:state", JSON.stringify(state0));
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.counts.newCandidates, 1);
});

test("cron run while disabled makes no TMDB calls", async () => {
  const kv = makeKV({});
  const fetchFn = cannedFetch();
  globalThis.fetch = fetchFn;
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "cron");
  assert.equal(run.status, "skipped");
  assert.equal(run.error, "discovery disabled");
  assert.equal(fetchFn.calls(), 0);
  assert.equal(kv._map.has("ext:discovery:state"), false); // no writes at all
});

test("missing TMDB key fails the run cleanly", async () => {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv, tmdbKey: null });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "failed");
  assert.equal(run.error, "no TMDB key");
});

test("one failing list endpoint does not abort the run", async () => {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch({ failDiscoverMovie: true });
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "ok");
  assert.equal(run.counts.failed, 1);
  assert.equal(run.counts.newCandidates, 3); // tv + trending still filed
});

test("internal route: wrong secret 403, right secret runs", async () => {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv });
  const wrong = await d.fetch(new Request("https://internal/api/internal/discovery/run", { method: "POST", headers: { "x-cron-secret": "nope" } }));
  assert.equal(wrong.status, 403);
  const right = await d.fetch(new Request("https://internal/api/internal/discovery/run", { method: "POST", headers: { "x-cron-secret": "cronsecret" } }));
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.run.status, "skipped"); // disabled by default
});

test("admin state/config/run endpoints are pw-gated and validate", async () => {
  const kv = makeKV({});
  globalThis.fetch = cannedFetch();
  const d = makeDO({ kv });
  const noPw = await d.fetch(new Request("https://internal/api/admin/discovery/state"));
  assert.equal(noPw.status, 403);
  const state = await (await d.fetch(new Request("https://internal/api/admin/discovery/state?pw=pw123"))).json();
  assert.equal(state.state.enabled, false);
  const badFreq = await (await d.fetch(new Request("https://internal/api/admin/discovery/config?pw=pw123", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frequency: "bogus", enabled: true, budget: { maxNewPerRun: 99 } }) }))).json();
  assert.equal(badFreq.state.frequency, "daily"); // invalid ignored
  assert.equal(badFreq.state.enabled, true);
  assert.equal(badFreq.state.budget.maxNewPerRun, 30); // clamped
  const run = await (await d.fetch(new Request("https://internal/api/admin/discovery/run?pw=pw123", { method: "POST" }))).json();
  assert.equal(run.ok, true);
  assert.equal(run.run.counts.newCandidates, 3); // manual run ignores disabled flag
});
