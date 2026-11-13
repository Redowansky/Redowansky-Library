// Tests for the Phase 2a hardening: editable pending sources (T1–T11),
// lastSuccess recording, and the overlap-guard fix.
// Run: node --test .phase2a-test/test_pending_sources.mjs (from ~/workspace/sia-lab)
// worker.mjs is regenerated from worker.js (see test_phase2a.mjs header).
import test from "node:test";
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
function makeDO({ kv, tmdbKey = "FAKEKEY", live = null, slowKey = false } = {}) {
  const env = { DATA_KV: kv, TMDB_KEY: undefined, DISCOVERY_CRON_SECRET: "cronsecret", S3_ACCESS_KEY: "x", S3_SECRET_KEY: "y" };
  const state = { storage: {
    get: async (k) => {
      if (slowKey) await new Promise((r) => setTimeout(r, 5));
      return k === "tmdb_key" ? tmdbKey : k === "admin_pw" ? "pw123" : null;
    },
    put: async () => {},
  } };
  const d = new TunnelDO(state, env);
  d.listMovies = async () => live || [{ id: "emv", title: "Iron Man", tmdb: 1726, year: "2008", type: "movie" }];
  return d;
}
async function kvObj(kv, key) { return JSON.parse(kv._map.get(key) || "{}"); }
const PW = "?pw=pw123";
async function call(d, path, body) {
  const res = await d.fetch(new Request("https://internal" + path + PW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function seedCand(over = {}) {
  return { id: "p-test1", title: "Test Candidate", type: "movie", tmdb: 999001, year: "2026", sources: [], needsSource: true, status: "pending", createdAt: 1, discoveredVia: "tmdb-trending", ...over };
}

// T1: save valid sources — Drive share link normalized, long label sliced
test("T1 save valid sources normalizes + trims", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv });
  const r = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [
    { label: "A very long label that is definitely over thirty characters", url: "https://drive.google.com/file/d/ABC123/view?usp=sharing" },
    { label: "Direct", url: "https://example.com/video.mp4" },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.length, 2);
  assert.equal(r.body.sources[0].url, "https://drive.google.com/uc?export=download&id=ABC123");
  assert.equal(r.body.sources[0].label.length, 30);
  assert.equal(r.body.sources[1].url, "https://example.com/video.mp4");
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(pend["p-test1"].sources.length, 2);
  assert.equal(pend["p-test1"].needsSource, false);
});

// T2: javascript: URL in row 2 -> 400 naming the row, nothing saved
test("T2 bad scheme fails the whole save", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv });
  const r = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [
    { label: "Good", url: "https://example.com/a.mp4" },
    { label: "Bad", url: "javascript:alert(1)" },
  ] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /source 2/);
  const pend = await kvObj(kv, "ext:pending");
  assert.deepEqual(pend["p-test1"].sources, []);
});

// T3: data: URL and a URL with a space -> 400, nothing saved
test("T3 data: URL and spaced URL rejected", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv });
  for (const bad of ["data:text/html,<b>x</b>", "https://example.com/my video.mp4"]) {
    const r = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Bad", url: bad }] });
    assert.equal(r.status, 400);
  }
  const pend = await kvObj(kv, "ext:pending");
  assert.deepEqual(pend["p-test1"].sources, []);
});

// T4: empty save allowed; approve still refuses a sourceless candidate
test("T4 empty save clears sources, approve still blocked", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand({ sources: [{ label: "Old", url: "https://example.com/old.mp4" }], needsSource: false }) } });
  const d = makeDO({ kv });
  const r = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sources, []);
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(pend["p-test1"].needsSource, true);
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 400);
  assert.match(ap.body.error, /at least one playback source/);
});

// T5: attach a source, then approve publishes with exactly that source
test("T5 attach then approve publishes with the source", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv });
  const r = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/film.mp4" }] });
  assert.equal(r.status, 200);
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 200);
  const ext = await kvObj(kv, "ext:movies");
  assert.equal(Object.keys(ext).length, 1);
  const live = Object.values(ext)[0];
  assert.equal(live.url, "https://example.com/film.mp4");
  assert.equal(live.sources[0].url, "https://example.com/film.mp4");
  assert.equal(live.pendingId, "p-test1");
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 0);
});

// T6: rejected / missing / unauthenticated
test("T6 rejected + missing + no-pw rejected", async () => {
  const kv = makeKV({ "ext:pending": { "p-rej": seedCand({ id: "p-rej", status: "rejected" }), "p-test1": seedCand() } });
  const d = makeDO({ kv });
  const rej = await call(d, "/api/admin/pending/sources", { id: "p-rej", sources: [{ label: "X", url: "https://example.com/x.mp4" }] });
  assert.equal(rej.status, 400);
  const miss = await call(d, "/api/admin/pending/sources", { id: "p-nope", sources: [{ label: "X", url: "https://example.com/x.mp4" }] });
  assert.equal(miss.status, 404);
  const noPw = await d.fetch(new Request("https://internal/api/admin/pending/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "p-test1", sources: [] }) }));
  assert.equal(noPw.status, 403);
});

// T7: approve with a stored invalid source -> 400, nothing published
test("T7 approve re-validates stored sources", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand({ sources: [{ label: "Bad", url: "javascript:alert(1)" }], needsSource: false }) } });
  const d = makeDO({ kv });
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 400);
  assert.match(ap.body.error, /source URL invalid/);
  const ext = await kvObj(kv, "ext:movies");
  assert.equal(Object.keys(ext).length, 0);
});

// T8: duplicate handling unchanged (409, then force publishes)
test("T8 duplicate still 409, force still publishes", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand({ tmdb: 1726, title: "Iron Man" }) } });
  const d = makeDO({ kv });
  await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/iron.mp4" }] });
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 409);
  assert.equal(ap.body.duplicate.where, "live");
  const forced = await call(d, "/api/admin/pending/approve", { id: "p-test1", force: true });
  assert.equal(forced.status, 200);
});

// T9: approve retry recovery unchanged (already-live self-heal)
test("T9 self-heal on already-published candidate", async () => {
  const kv = makeKV({
    "ext:pending": { "p-test1": seedCand() },
    "ext:movies": { "e-live1": { id: "e-live1", pendingId: "p-test1", title: "Test Candidate", url: "https://example.com/film.mp4" } },
  });
  const d = makeDO({ kv });
  await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/film.mp4" }] });
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.already, true);
  const ext = await kvObj(kv, "ext:movies");
  assert.equal(Object.keys(ext).length, 1); // no second live entry
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 0);
});

// T10: concurrent edit + approve -> at most one live entry, no lost update
test("T10 concurrent edit + approve serializes safely", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv });
  const [edit, ap] = await Promise.all([
    call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/film.mp4" }] }),
    call(d, "/api/admin/pending/approve", { id: "p-test1" }),
  ]);
  const ext = await kvObj(kv, "ext:movies");
  const mine = Object.values(ext).filter((e) => e.pendingId === "p-test1");
  assert.ok(mine.length <= 1, "at most one live entry, got " + mine.length);
  if (ap.status === 200) {
    assert.equal(mine.length, 1);
    assert.equal(mine[0].url, "https://example.com/film.mp4");
  } else {
    // approve ran first and correctly refused the sourceless candidate;
    // the edit must still have landed
    assert.equal(ap.status, 400);
    const pend = await kvObj(kv, "ext:pending");
    assert.equal(pend["p-test1"].sources[0].url, "https://example.com/film.mp4");
  }
});

// T11: max 5 sources; duplicate URLs deduped to one row
test("T11 max 5 sources, duplicate URLs deduped", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv });
  const six = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [1, 2, 3, 4, 5, 6].map((i) => ({ label: "S" + i, url: "https://example.com/" + i + ".mp4" })) });
  assert.equal(six.status, 400);
  assert.match(six.body.error, /at most 5/);
  const dup = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [
    { label: "A", url: "https://example.com/same.mp4" },
    { label: "B", url: "https://example.com/same.mp4" },
  ] });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.sources.length, 1);
});

// Flag cleanup regression (review 2026-11-13 item 1): the TMDB-key
// lookup throws on the first call, then works. The first run must fail
// WITHOUT sticking the flag, so the second run proceeds normally.
test("flag reset when the TMDB-key lookup throws", async () => {
  const kv = makeKV({});
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) return ok({ results: [{ id: 1001, popularity: 5 }] });
    if (u.includes("/discover/tv")) return ok({ results: [] });
    if (u.includes("/trending/movie")) return ok({ results: [] });
    if (u.includes("/trending/tv")) return ok({ results: [] });
    if (u.includes("/watch/providers")) return ok({ results: {} });
    const m = u.match(/\/(movie|tv)\/(\d+)\?/);
    if (m) return ok({ id: 1001, title: "T1001", release_date: "2026-11-12", overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genres: [] });
    return ok({});
  };
  let keyCalls = 0;
  const env = { DATA_KV: kv, TMDB_KEY: undefined, DISCOVERY_CRON_SECRET: "cronsecret", S3_ACCESS_KEY: "x", S3_SECRET_KEY: "y" };
  const state = { storage: {
    get: async (k) => {
      if (k === "tmdb_key") { keyCalls++; if (keyCalls === 1) throw new Error("storage boom"); return "FAKEKEY"; }
      return k === "admin_pw" ? "pw123" : null;
    },
    put: async () => {},
  } };
  const d = new TunnelDO(state, env);
  d.listMovies = async () => [];
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed");
  assert.match(run1.error, /storage boom/);
  let st = await kvObj(kv, "ext:discovery:state");
  assert.equal(st.lastRun.status, "failed");
  assert.equal(st.totals.discovered, 0); // nothing filed by the failed run
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok"); // flag was reset — otherwise "skipped"
  assert.equal(run2.counts.newCandidates, 1);
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1);
});

// Second case: the state read itself throws once. getDiscoveryState
// swallows KV errors and returns defaults by design (fail-open), so the
// run proceeds with defaults — the point here is the flag still resets
// and both runs complete instead of the second one reporting "skipped".
test("state read failure does not stick the flag either", async () => {
  const kv = makeKV({});
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  let threw = false;
  const origGet = kv.get.bind(kv);
  kv.get = async (k, fmt) => { if (k === "ext:discovery:state" && !threw) { threw = true; throw new Error("kv boom"); } return origGet(k, fmt); };
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "ok"); // fail-open to defaults, not a stuck flag
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok"); // flag was reset — otherwise "skipped"
});

// lastSuccess: recorded on ok runs only, survives a later failed run
test("lastSuccess recorded on ok, kept after a failed run", async () => {
  const kv = makeKV({});
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) return ok({ results: [{ id: 1001, popularity: 5 }] });
    if (u.includes("/discover/tv")) return ok({ results: [] });
    if (u.includes("/trending/movie")) return ok({ results: [] });
    if (u.includes("/trending/tv")) return ok({ results: [] });
    if (u.includes("/watch/providers")) return ok({ results: {} });
    const m = u.match(/\/(movie|tv)\/(\d+)\?/);
    if (m) return ok({ id: 1001, title: "T", release_date: "2026-11-12", overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genres: [] });
    return ok({});
  };
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "ok");
  let st = await kvObj(kv, "ext:discovery:state");
  assert.ok(st.lastSuccess);
  assert.equal(st.lastSuccess.status, undefined); // lastSuccess has no status field by design
  assert.equal(st.lastSuccess.trigger, "manual");
  assert.deepEqual(st.lastSuccess.counts.bySource, { "tmdb-discover": 1, "tmdb-trending": 0 });
  const d2 = makeDO({ kv, tmdbKey: null }); // no key -> failed run
  const run2 = await d2.runDiscovery(d2.env, "manual");
  assert.equal(run2.status, "failed");
  st = await kvObj(kv, "ext:discovery:state");
  assert.equal(st.lastRun.status, "failed");
  assert.ok(st.lastSuccess, "lastSuccess survives the failed run");
  assert.equal(st.lastSuccess.trigger, "manual");
});

// Overlap guard: two concurrent runs -> exactly one ok, one skipped
test("overlap guard: concurrent runs serialize, no double-filing", async () => {
  const kv = makeKV({});
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) return ok({ results: [{ id: 1001, popularity: 5 }, { id: 1726, popularity: 90 }] });
    if (u.includes("/discover/tv")) return ok({ results: [{ id: 2001, popularity: 8 }] });
    if (u.includes("/trending/movie")) return ok({ results: [{ id: 1001, popularity: 5 }, { id: 1002, popularity: 50 }] });
    if (u.includes("/trending/tv")) return ok({ results: [{ id: 2001, popularity: 8 }, { id: 3001, popularity: 1 }, { id: 4001, popularity: 1 }] });
    if (u.includes("/watch/providers")) return ok({ results: {} });
    const m = u.match(/\/(movie|tv)\/(\d+)\?/);
    if (m) { const d = { "1001": { id: 1001, title: "T1001", release_date: "2026-11-12", overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genres: [] }, "1002": { id: 1002, title: "T1002", release_date: "2026-11-11", overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genres: [] }, "2001": { id: 2001, name: "T2001", first_air_date: "2026-11-10", overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genres: [] } }[m[2]]; return ok(d || {}); }
    return ok({});
  };
  const d = makeDO({ kv, slowKey: true });
  await kv.put("ext:discovery:state", JSON.stringify({ enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null }));
  const [r1, r2] = await Promise.all([d.runDiscovery(d.env, "cron"), d.runDiscovery(d.env, "manual")]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, ["ok", "skipped"]);
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 3);
});

// ---- Partial-write recovery (review 2026-11-13 item 1) ----
// A discovery run persists three separate KV keys (queue, seen, state) —
// not a transaction. These tests fail one write at a time and check the
// three stores stay consistent (or heal) and a retry never duplicates.
function makeFailingKV(initial = {}, failPut = null) {
  const kv = makeKV(initial);
  const perKey = {};
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v) => {
    perKey[k] = (perKey[k] || 0) + 1;
    if (failPut && failPut(k, perKey[k])) throw new Error("kv put boom: " + k);
    return origPut(k, v);
  };
  return kv;
}
function oneMovieFetch() {
  return async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) return ok({ results: [{ id: 1001, popularity: 5 }] });
    if (u.includes("/discover/tv")) return ok({ results: [] });
    if (u.includes("/trending/movie")) return ok({ results: [] });
    if (u.includes("/trending/tv")) return ok({ results: [] });
    if (u.includes("/watch/providers")) return ok({ results: {} });
    const m = u.match(/\/(movie|tv)\/(\d+)\?/);
    if (m) return ok({ id: 1001, title: "T1001", release_date: "2026-11-12", overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genres: [] });
    return ok({});
  };
}
async function stateOf(kv) { return kvObj(kv, "ext:discovery:state"); }

// R1: queue write lands, seen write throws once -> failure-path
// reconciler heals immediately; retry files nothing twice.
test("R1 queue ok + seen fails once: healed in the failed run, retry clean", async () => {
  const kv = makeFailingKV({}, (k, n) => k === "ext:discovery:seen" && n === 1);
  globalThis.fetch = oneMovieFetch();
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed");
  let pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1); // candidate landed in the queue
  let seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:1001"], "seen healed by the failure-path reconciler");
  assert.equal(seen["movie:1001"].status, "pending");
  let st = await stateOf(kv);
  assert.equal(st.totals.discovered, 1, "totals bump healed too");
  assert.equal(st.lastRun.status, "failed");
  assert.equal(st.lastSuccess, null);
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok");
  assert.equal(run2.counts.newCandidates, 0, "retry dedupes via seen");
  pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "no duplicate filing on retry");
  st = await stateOf(kv);
  assert.equal(st.totals.discovered, 1, "totals not double-bumped");
});

// R2: seen write throws twice (batch + failure-path reconciler both fail)
// -> gap persists after run 1; start-of-run reconciler heals it on run 2.
test("R2 seen fails twice: gap persists, next run heals it, retry clean", async () => {
  const kv = makeFailingKV({}, (k, n) => k === "ext:discovery:seen" && n <= 2);
  globalThis.fetch = oneMovieFetch();
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed");
  let pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1);
  let seen = await kvObj(kv, "ext:discovery:seen");
  assert.equal(Object.keys(seen).length, 0, "seen gap persists after run 1");
  let st = await stateOf(kv);
  assert.equal(st.totals.discovered, 0, "totals bump lost with the seen write");
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok");
  assert.equal(run2.counts.newCandidates, 0, "retry dedupes via the healed seen entry");
  pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "no duplicate filing on retry");
  seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:1001"], "start-of-run reconciler healed the gap");
  st = await stateOf(kv);
  assert.equal(st.totals.discovered, 1, "totals healed by the retry");
});

// R3: queue + seen land, state save throws once (transient) -> the
// failed-record save persists the totals bump; retry files nothing twice.
test("R3 state save fails once: totals survive via the failed-record save", async () => {
  const kv = makeFailingKV({}, (k, n) => k === "ext:discovery:state" && n === 1);
  globalThis.fetch = oneMovieFetch();
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed");
  let pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1);
  let seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:1001"]);
  let st = await stateOf(kv);
  assert.equal(st.lastRun.status, "failed");
  assert.equal(st.totals.discovered, 1, "bump survived: finish(failed) re-saved state");
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok");
  assert.equal(run2.counts.newCandidates, 0);
  pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "no duplicate filing on retry");
});

// R3b: state save fails persistently -> nothing about the run is recorded
// (lastRun stays stale, totals stay stale), but queue + seen are intact
// and the retry still cannot duplicate. This residual totals gap is
// documented, not hidden: totals is best-effort, queue/seen authoritative.
test("R3b state save fails always: run unrecorded, queue+seen intact, retry clean", async () => {
  const kv = makeFailingKV({}, (k) => k === "ext:discovery:state");
  globalThis.fetch = oneMovieFetch();
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed");
  let pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1);
  let seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:1001"]);
  let st = await stateOf(kv);
  assert.equal(kv._map.get("ext:discovery:state"), undefined, "no run record persisted (state key never written)");
  assert.equal((st.totals || {}).discovered || 0, 0, "totals bump lost (known residual gap)");
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "failed", "state save still down");
  pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "no duplicate filing on retry");
});

// R5: a rejected discovery candidate missing from seen is healed with
// status "rejected" (not "pending") and counts toward totals.
test("R5 rejected candidate healed with rejected status", async () => {
  const kv = makeKV({ "ext:pending": { "p-rej1": { id: "p-rej1", title: "Old Film", type: "movie", tmdb: 999002, year: "2025", sources: [], status: "rejected", discoveredAt: "2026-11-12T01:00:00.000Z", discoveredVia: "tmdb-discover", createdAt: 1 } } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "ok");
  const seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:999002"]);
  assert.equal(seen["movie:999002"].status, "rejected");
  const st = await stateOf(kv);
  assert.equal(st.totals.discovered, 1);
});

// R6: manual candidates (no discoveredAt) are never healed and never
// counted — the reconciler only touches discovery-filed candidates.
test("R6 manual candidates are not healed or counted", async () => {
  const kv = makeKV({ "ext:pending": { "p-man1": { id: "p-man1", title: "Hand Added", type: "movie", tmdb: 999003, year: "2026", sources: [], status: "pending", discoveredVia: "manual", createdAt: 1 } } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "ok");
  const seen = await kvObj(kv, "ext:discovery:seen");
  assert.equal(Object.keys(seen).length, 0);
  const st = await stateOf(kv);
  assert.equal(st.totals.discovered, 0);
});
