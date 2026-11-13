// Tests for the Phase 2a hardening: editable pending sources (T1–T11),
// flag-cleanup regression tests, lastSuccess recording, overlap guard,
// and partial-write recovery (R1–R3b, R5–R10: failed reads, failed
// writes, retries, strict-read aborts, reconciler failure signaling),
// and the discovery config race (R11–R15: finish() merging onto fresh
// state, config-endpoint lock, failed-run preservation, strict
// bookkeeping reads), the G1+G2 strict-read remediation (R25–R29:
// failed reads in the four wipe-capable admin write paths abort with
// HTTP 500 and leave KV byte-identical; a failed dedupe-phase read fails
// the discovery run instead of running blind), and the dup-check
// correction (R30–R32: strict catalogue reads in the two duplicate
// checks, exercised through the real listMovies(); approve initial queue
// read strict; generic catch messages with no KV internals).
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
function makeDO({ kv, tmdbKey = "FAKEKEY", live = null, slowKey = false, realList = false } = {}) {
  const env = { DATA_KV: kv, TMDB_KEY: undefined, DISCOVERY_CRON_SECRET: "cronsecret", S3_ACCESS_KEY: "x", S3_SECRET_KEY: "y" };
  const state = { storage: {
    get: async (k) => {
      if (slowKey) await new Promise((r) => setTimeout(r, 5));
      return k === "tmdb_key" ? tmdbKey : k === "admin_pw" ? "pw123" : null;
    },
    put: async () => {},
  } };
  const d = new TunnelDO(state, env);
  // realList: keep the production listMovies() (bucket listing via a stubbed
  // s3fetch + ext entries via the real KV read) — the `live` fixture would
  // bypass the catalogue-read path under test (R30–R32).
  if (!realList) d.listMovies = async () => live || [{ id: "emv", title: "Iron Man", tmdb: 1726, year: "2008", type: "movie" }];
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
  // SUPERSEDED 2026-11-13 (review item 1): a failed state read used to
  // fail open to defaults and the run returned "ok" — that let finish()
  // save defaults over the real config. Now the run aborts as "failed"
  // with no writes at all; the flag-reset property is unchanged.
  assert.equal(run1.status, "failed");
  assert.equal(kv._map.get("ext:discovery:state"), undefined, "no defaults written over the real state");
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
function makeFailingKV(initial = {}, failPut = null, failGet = null) {
  const kv = makeKV(initial);
  const perKey = {};
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v) => {
    perKey[k] = (perKey[k] || 0) + 1;
    if (failPut && failPut(k, perKey[k])) throw new Error("kv put boom: " + k);
    return origPut(k, v);
  };
  const origGet = kv.get.bind(kv);
  const perKeyGet = {};
  kv.get = async (k, fmt) => {
    perKeyGet[k] = (perKeyGet[k] || 0) + 1;
    if (failGet && failGet(k, perKeyGet[k])) throw new Error("kv get boom: " + k);
    return origGet(k, fmt);
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

// ---- Strict recovery reads (review 2026-11-13 item 1) ----
// getSeen/getDiscoveryState swallow KV errors and return fallbacks.
// Recovery must NOT treat those fallbacks as data: saving a {} seen-map
// would erase existing entries, and saving default state would reset
// the discovery configuration. The reconciler reads everything strict
// BEFORE any write, so a failed read aborts with zero writes.
const emptyListsFetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });

// R7: a failed seen-map read cannot erase existing entries.
test("R7 seen read fails: recovery writes nothing, existing entries survive", async () => {
  const kv = makeFailingKV({
    "ext:pending": { "p-new1": { id: "p-new1", title: "New Film", type: "movie", tmdb: 1003, year: "2026", sources: [], status: "pending", discoveredAt: "2026-11-13T01:00:00.000Z", discoveredVia: "tmdb-discover", createdAt: 1 } },
    "ext:discovery:seen": {
      "movie:1001": { type: "movie", tmdb: 1001, title: "Approved One", firstSeen: "2026-11-12", lastSeen: "2026-11-12", status: "approved" },
      "movie:1002": { type: "movie", tmdb: 1002, title: "Dup One", firstSeen: "2026-11-12", lastSeen: "2026-11-12", status: "live-dup" },
    },
  }, null, (k) => k === "ext:discovery:seen");
  globalThis.fetch = emptyListsFetch;
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "failed", "a run that cannot read the seen-map must fail without writing");
  assert.ok(String(run.error || "").includes("kv get boom"), "failure names the unreadable read");
  const seen = await kvObj(kv, "ext:discovery:seen");
  assert.deepEqual(Object.keys(seen).sort(), ["movie:1001", "movie:1002"], "seen-map untouched");
  assert.equal(seen["movie:1001"].status, "approved");
  assert.equal(seen["movie:1002"].status, "live-dup");
  assert.equal(seen["movie:1003"], undefined, "no heal entry written after a failed read");
  const pend = await kvObj(kv, "ext:pending");
  assert.deepEqual(Object.keys(pend), ["p-new1"], "queue untouched — the failed batch wrote nothing");
  assert.equal(pend["p-new1"].tmdb, 1003);
  assert.equal(pend["p-new1"].status, "pending");
  const st = await stateOf(kv);
  assert.equal(st.totals.discovered, 0, "totals untouched");
  assert.equal(st.lastRun.status, "failed", "the failed run itself is recorded");
});

// R8: a failed state read cannot reset discovery settings — and no
// seen write happens either, because all reads precede all writes.
test("R8 state read fails: config and history survive, recovery writes nothing", async () => {
  const kv = makeFailingKV({
    "ext:pending": { "p-new1": { id: "p-new1", title: "New Film", type: "movie", tmdb: 1003, year: "2026", sources: [], status: "pending", discoveredAt: "2026-11-13T01:00:00.000Z", discoveredVia: "tmdb-discover", createdAt: 1 } },
    "ext:discovery:seen": {},
    "ext:discovery:state": {
      enabled: true, frequency: "weekly",
      sources: { tmdb: true, trending: true, upcoming: true, tvmaze: false },
      budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
      lastRun: { at: "2026-11-13T01:00:00.000Z", trigger: "manual", status: "ok", counts: { fetched: 80, newCandidates: 15, duplicates: 1, skipped: 64, failed: 0 }, durationMs: 100 },
      lastSuccess: { at: "2026-11-13T01:00:00.000Z", trigger: "manual", counts: {}, durationMs: 100 },
      totals: { discovered: 5, approved: 1, rejected: 0 },
      nextRunAt: "2026-11-20T01:00:00.000Z",
    },
  }, null, (k) => k === "ext:discovery:state");
  globalThis.fetch = emptyListsFetch;
  const d = makeDO({ kv });
  const run = await d.runDiscovery(d.env, "manual");
  assert.equal(run.status, "failed", "a run that cannot read its own state must abort without writing");
  assert.ok(String(run.error || "").includes("discovery state unreadable"), "failure names the unreadable state");
  const seen = await kvObj(kv, "ext:discovery:seen");
  assert.equal(Object.keys(seen).length, 0, "no heal write before the failed read");
  const pend = await kvObj(kv, "ext:pending");
  assert.deepEqual(Object.keys(pend), ["p-new1"], "queue untouched — the aborted run wrote nothing");
  assert.equal(pend["p-new1"].tmdb, 1003);
  const st = await stateOf(kv);
  assert.equal(st.enabled, true);
  assert.equal(st.frequency, "weekly");
  assert.equal(st.totals.discovered, 5);
  assert.equal(st.totals.approved, 1);
  assert.equal(st.lastRun.status, "ok", "last run record intact");
  assert.ok(st.lastSuccess, "last success intact");
});

// ---- Recovery accounting (review 2026-11-13 item 2) ----
// R9: seen heal ok + state save fails: the reconciler THROWS (round 7)
// and the run aborts instead of continuing on possibly-stale state.
// The healed seen entries are recorded (seen is authoritative) while
// totals.discovered is not bumped — a documented residual: a retry
// cannot detect or fix it (no gap remains), so totals stays stale
// rather than silently misleading.
test("R9 seen heal ok + state save fails: run aborts, seen authoritative, totals stale (documented)", async () => {
  const kv = makeFailingKV({
    "ext:pending": { "p-new1": { id: "p-new1", title: "New Film", type: "movie", tmdb: 1003, year: "2026", sources: [], status: "pending", discoveredAt: "2026-11-13T01:00:00.000Z", discoveredVia: "tmdb-discover", createdAt: 1 } },
    "ext:discovery:seen": {},
  }, (k, n) => k === "ext:discovery:state" && n === 1);
  globalThis.fetch = emptyListsFetch;
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed", "recovery failing aborts the run instead of continuing stale");
  let seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:1003"], "healed entry landed in the seen-map");
  assert.equal(seen["movie:1003"].status, "pending");
  let st = await stateOf(kv);
  assert.equal(st.totals.discovered, 0, "totals bump lost with the state save");
  assert.equal(st.lastRun.status, "failed", "the abort itself is recorded on freshly-read state");
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok");
  seen = await kvObj(kv, "ext:discovery:seen");
  assert.equal(Object.keys(seen).length, 1, "no duplicate heal on retry");
  st = await stateOf(kv);
  assert.equal(st.totals.discovered, 0, "totals stays stale after retry — documented, not hidden");
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "queue candidate intact");
});

// ---- Reconciler must signal failure, not swallow it (round 7) ----
// R10: the initial discovery-state read succeeds but the reconciler's
// own state read fails. The reconciler must THROW (not return 0) so
// the run aborts instead of continuing on its older in-memory state
// and saving it over a newer config. A retry works once reads recover.
test("R10 reconciler state read fails after a good initial load: run aborts, config survives, retry heals", async () => {
  const seedState = {
    enabled: true, frequency: "weekly",
    sources: { tmdb: true, trending: true, upcoming: true, tvmaze: false },
    budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
    lastRun: { at: "2026-11-13T01:00:00.000Z", trigger: "manual", status: "ok", counts: { fetched: 80, newCandidates: 15, duplicates: 1, skipped: 64, failed: 0 }, durationMs: 100 },
    lastSuccess: { at: "2026-11-13T01:00:00.000Z", trigger: "manual", counts: {}, durationMs: 100 },
    totals: { discovered: 5, approved: 1, rejected: 0 },
    nextRunAt: "2026-11-20T01:00:00.000Z",
  };
  const kv = makeFailingKV({
    "ext:pending": { "p-new1": { id: "p-new1", title: "New Film", type: "movie", tmdb: 1003, year: "2026", sources: [], status: "pending", discoveredAt: "2026-11-13T01:00:00.000Z", discoveredVia: "tmdb-discover", createdAt: 1 } },
    "ext:discovery:seen": {},
    "ext:discovery:state": seedState,
  }, null, (k, n) => k === "ext:discovery:state" && n === 2);
  globalThis.fetch = emptyListsFetch;
  const d = makeDO({ kv });
  const run1 = await d.runDiscovery(d.env, "manual");
  assert.equal(run1.status, "failed", "reconciler read failure aborts the run");
  assert.ok(String(run1.error || "").includes("kv get boom"), "failure names the unreadable read");
  let seen = await kvObj(kv, "ext:discovery:seen");
  assert.equal(Object.keys(seen).length, 0, "no recovery writes after the failed read");
  let pend = await kvObj(kv, "ext:pending");
  assert.deepEqual(Object.keys(pend), ["p-new1"], "queue untouched");
  let st = await stateOf(kv);
  assert.equal(st.enabled, true, "config not reset");
  assert.equal(st.frequency, "weekly");
  assert.deepEqual(st.budget, { maxNewPerRun: 15, maxDetailCalls: 30 });
  assert.equal(st.totals.discovered, 5, "totals not reset");
  assert.equal(st.totals.approved, 1);
  assert.equal(st.lastRun.status, "failed", "the abort is recorded");
  assert.ok(st.lastSuccess, "last success preserved");
  assert.equal(st.lastSuccess.at, "2026-11-13T01:00:00.000Z");
  // Retry once KV reads recover: the reconciler heals, the run succeeds.
  const run2 = await d.runDiscovery(d.env, "manual");
  assert.equal(run2.status, "ok");
  seen = await kvObj(kv, "ext:discovery:seen");
  assert.ok(seen["movie:1003"], "retry healed the gap");
  assert.equal(seen["movie:1003"].status, "pending");
  st = await stateOf(kv);
  assert.equal(st.totals.discovered, 6, "totals bumped exactly once by the retry");
  assert.equal(st.lastRun.status, "ok");
  pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "queue candidate intact, not duplicated");
});

// ---- Config race: finish() must not overwrite newer admin settings (round 8) ----
// R11: a config change made while a run is executing survives the run.
// The run files its candidate (its work is preserved) but the stored state
// keeps the NEW config — finish() merges onto a fresh read instead of saving
// the stale run-start snapshot.
test("R11 config change during an active run survives finish()", async () => {
  const kv = makeKV({
    "ext:pending": {},
    "ext:discovery:seen": {},
    "ext:discovery:state": { enabled: true, frequency: "daily",
      sources: { tmdb: true, trending: true, upcoming: true, tvmaze: false },
      budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
      lastRun: { at: "2026-11-13T01:00:00.000Z", trigger: "manual", status: "ok", counts: {}, durationMs: 100 },
      lastSuccess: { at: "2026-11-13T01:00:00.000Z", trigger: "manual", counts: {}, durationMs: 100 },
      totals: { discovered: 45, approved: 0, rejected: 0 }, nextRunAt: "2026-11-14T02:00:00.000Z" },
  });
  let release; const gate = new Promise((r) => { release = r; });
  let listFetchStarted; const listStarted = new Promise((r) => { listFetchStarted = r; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) { listFetchStarted(); await gate; return ok({ results: [{ id: 1001, popularity: 5 }] }); }
    if (u.includes("/discover/tv") || u.includes("/trending/") || u.includes("/movie/upcoming")) return ok({ results: [] });
    if (u.includes("/watch/providers")) return ok({ results: { BD: { flatrate: [{ provider_name: "Netflix" }] } } });
    if (u.match(/\/movie\/1001\?/)) return ok({ id: 1001, title: "New Film", release_date: "2026-11-12", overview: "One.", poster_path: "/p1.jpg", backdrop_path: null, vote_average: 7.8, genres: [{ name: "Action" }] });
    return ok({});
  };
  const d = makeDO({ kv });
  const runP = d.runDiscovery(d.env, "manual");
  await listStarted;
  const cfg = await call(d, "/api/admin/discovery/config", { enabled: false, frequency: "weekly", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 5 } });
  assert.equal(cfg.status, 200, "config change lands mid-run");
  release();
  const run = await runP;
  assert.equal(run.status, "ok");
  assert.equal(run.counts.newCandidates, 1, "the run's work is preserved");
  const st = await stateOf(kv);
  assert.equal(st.enabled, false, "new config survives finish()");
  assert.equal(st.frequency, "weekly");
  assert.equal(st.budget.maxNewPerRun, 5);
  assert.equal(st.sources.upcoming, false);
  assert.equal(st.totals.discovered, 46, "filed candidate counted exactly once");
  assert.equal(st.lastRun.status, "ok", "the run's own record is kept");
  assert.equal((Date.parse(st.nextRunAt) - Date.parse(run.at)) / 864e5, 7, "nextRunAt follows the NEW weekly frequency");
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 1, "candidate filed");
});

// R12: two concurrent config saves both apply (the endpoint takes the lock).
test("R12 two concurrent config saves both apply", async () => {
  const kv = makeKV({
    "ext:pending": {}, "ext:discovery:seen": {},
    "ext:discovery:state": { enabled: true, frequency: "daily",
      sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false },
      budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
      lastRun: null, lastSuccess: null,
      totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null },
  });
  const d = makeDO({ kv });
  const [r1, r2] = await Promise.all([
    call(d, "/api/admin/discovery/config", { budget: { maxNewPerRun: 5 } }),
    call(d, "/api/admin/discovery/config", { frequency: "weekly" }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const st = await stateOf(kv);
  assert.equal(st.budget.maxNewPerRun, 5, "first save's change survives");
  assert.equal(st.frequency, "weekly", "second save's change survives");
});

// R13: a run that fails mid-way still preserves a config change made
// while it was executing (finish("failed") merges onto fresh state too).
test("R13 failed run preserves a mid-run config change", async () => {
  const kv = makeFailingKV({
    "ext:pending": {}, "ext:discovery:seen": {},
    "ext:discovery:state": { enabled: true, frequency: "daily",
      sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false },
      budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
      lastRun: null, lastSuccess: null,
      totals: { discovered: 45, approved: 0, rejected: 0 }, nextRunAt: "2026-11-14T02:00:00.000Z" },
  }, (k, n) => k === "ext:pending" && n === 1);
  let release; const gate = new Promise((r) => { release = r; });
  let listFetchStarted; const listStarted = new Promise((r) => { listFetchStarted = r; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie")) { listFetchStarted(); await gate; return ok({ results: [{ id: 1001, popularity: 5 }] }); }
    if (u.includes("/discover/tv") || u.includes("/trending/") || u.includes("/movie/upcoming")) return ok({ results: [] });
    if (u.includes("/watch/providers")) return ok({ results: {} });
    if (u.match(/\/movie\/1001\?/)) return ok({ id: 1001, title: "New Film", release_date: "2026-11-12", overview: "One.", poster_path: "/p1.jpg", backdrop_path: null, vote_average: 7.8, genres: [{ name: "Action" }] });
    return ok({});
  };
  const d = makeDO({ kv });
  const runP = d.runDiscovery(d.env, "manual");
  await listStarted;
  const cfg = await call(d, "/api/admin/discovery/config", { enabled: false, frequency: "weekly" });
  assert.equal(cfg.status, 200);
  release();
  const run = await runP;
  assert.equal(run.status, "failed", "batch save failure fails the run");
  const st = await stateOf(kv);
  assert.equal(st.enabled, false, "config change survives the failed run");
  assert.equal(st.frequency, "weekly");
  assert.equal(st.lastRun.status, "failed", "the failure is recorded");
  assert.equal(st.totals.discovered, 45, "no phantom totals bump");
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 0, "nothing filed");
});

// R14: a config POST whose state read fails answers 500 and saves nothing
// (previously the swallowing read would have saved defaults over the config).
test("R14 config POST with a failing state read answers 500 and saves nothing", async () => {
  const kv = makeFailingKV({
    "ext:pending": {}, "ext:discovery:seen": {},
    "ext:discovery:state": { enabled: true, frequency: "daily",
      sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false },
      budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
      lastRun: null, lastSuccess: null,
      totals: { discovered: 45, approved: 0, rejected: 0 }, nextRunAt: "2026-11-14T02:00:00.000Z" },
  }, null, (k) => k === "ext:discovery:state");
  const d = makeDO({ kv });
  const res = await call(d, "/api/admin/discovery/config", { enabled: false });
  assert.equal(res.status, 500, "unreadable state is a 500, not a silent reset");
  const st = await stateOf(kv);
  assert.equal(st.enabled, true, "stored config untouched");
  assert.equal(st.frequency, "daily");
  assert.equal(st.totals.discovered, 45);
});

// R15: approve with failing bookkeeping reads still succeeds, and the failed
// reads erase nothing — markSeen/bumpDiscoveryTotal skip instead of saving
// {} / defaults (the round-5 pattern, applied to the approval path).
test("R15 approve with failing bookkeeping reads: approve succeeds, seen/config intact", async () => {
  const kv = makeFailingKV({
    "ext:pending": { "p-1": { id: "p-1", title: "New Film", type: "movie", tmdb: 1003, year: "2026", sources: [{ label: "Source 1", url: "https://example.com/play/1003" }], status: "pending", discoveredAt: "2026-11-13T01:00:00.000Z", discoveredVia: "manual", createdAt: 1 } },
    "ext:discovery:seen": { "movie:1001": { type: "movie", tmdb: 1001, title: "Old One", firstSeen: "2026-11-12", lastSeen: "2026-11-12", status: "approved" }, "movie:1002": { type: "movie", tmdb: 1002, title: "Old Two", firstSeen: "2026-11-12", lastSeen: "2026-11-12", status: "rejected" } },
    "ext:discovery:state": { enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 45, approved: 0, rejected: 0 }, nextRunAt: "2026-11-14T02:00:00.000Z" },
    "ext:movies": {},
  }, null, (k) => k === "ext:discovery:seen" || k === "ext:discovery:state");
  const d = makeDO({ kv });
  const res = await call(d, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(res.status, 200, "approve succeeds even when bookkeeping reads fail");
  const live = await kvObj(kv, "ext:movies");
  assert.equal(Object.keys(live).length, 1, "candidate published");
  const seen = await kvObj(kv, "ext:discovery:seen");
  assert.deepEqual(Object.keys(seen).sort(), ["movie:1001", "movie:1002"], "seen-map not erased by the failed bookkeeping read");
  const st = await stateOf(kv);
  assert.equal(st.enabled, true, "config not reset by the failed totals read");
  assert.equal(st.frequency, "daily");
  assert.equal(st.totals.discovered, 45);
  assert.equal(st.totals.approved, 0, "totals bump skipped (best-effort), not applied on a stale snapshot");
});

// G1+G2 strict-read remediation (audit addendum, 2026-11-13):
// R25–R28 — a failed KV read in the four wipe-capable admin write paths
// must abort with HTTP 500 and leave the stored contents byte-identical.
// R29 — a failed dedupe-phase read must fail the discovery run through the
// existing failure-recording path, with nothing filed.
function seedLive11() {
  const o = {};
  for (let i = 1; i <= 11; i++) o["emv" + i] = { id: "emv" + i, title: "Live Movie " + i, type: "movie", tmdb: 1000 + i, year: "2020", url: "https://example.com/" + i };
  return o;
}
function liveListOf(live11) { return Object.values(live11).map((e) => ({ id: e.id, title: e.title, tmdb: e.tmdb, year: e.year, type: e.type })); }

test("R25 approve with failing ext:movies read: 500, catalogue byte-identical", async () => {
  const live11 = seedLive11();
  const kv = makeFailingKV({
    "ext:movies": live11,
    "ext:pending": { "p-1": { id: "p-1", title: "New Film", type: "movie", tmdb: 2001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/2001" }], status: "pending", createdAt: 1 } },
    "ext:discovery:seen": {},
    "ext:discovery:state": {},
  }, null, (k, n) => k === "ext:movies" && n === 2); // publish-step read (self-heal scan is #1)
  const d = makeDO({ kv, live: liveListOf(live11) });
  const beforeMovies = kv._map.get("ext:movies");
  const beforePend = kv._map.get("ext:pending");
  const r = await call(d, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(r.status, 500, "a failed catalogue read must abort the approve, not publish");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(r.body.error || "").includes("kv get boom"), "raw KV error text is not exposed to clients");
  assert.equal(kv._map.get("ext:movies"), beforeMovies, "catalogue byte-identical — no wipe to 1 entry");
  assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical — candidate not deleted");
  assert.equal(Object.keys(await kvObj(kv, "ext:movies")).length, 11);
});

test("R26 pending add with failing ext:pending read: 500, queue byte-identical", async () => {
  const seed = {};
  for (let i = 1; i <= 45; i++) seed["p-" + i] = { id: "p-" + i, title: "Queued " + i, type: "movie", tmdb: 3000 + i, status: "pending", createdAt: i };
  const live11 = seedLive11();
  const kv = makeFailingKV({ "ext:movies": live11, "ext:pending": seed }, null, (k, n) => k === "ext:pending" && n === 2); // save-step read (dup check is #1)
  const d = makeDO({ kv, live: liveListOf(live11) });
  const beforePend = kv._map.get("ext:pending");
  const r = await call(d, "/api/admin/pending", { title: "Brand New", type: "movie" });
  assert.equal(r.status, 500, "a failed queue read must abort the add, not save a fallback");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(r.body.error || "").includes("kv get boom"), "raw KV error text is not exposed to clients");
  assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical — no wipe to 1 candidate");
  assert.equal(Object.keys(await kvObj(kv, "ext:pending")).length, 45);
});

test("R27 DELETE external with failing ext:movies read: 500, catalogue byte-identical", async () => {
  const live11 = seedLive11();
  const kv = makeFailingKV({ "ext:movies": live11 }, null, (k, n) => k === "ext:movies" && n === 1);
  const d = makeDO({ kv });
  const before = kv._map.get("ext:movies");
  const res = await d.fetch(new Request("https://internal/api/admin/external?pw=pw123&id=emv3", { method: "DELETE" }));
  assert.equal(res.status, 500, "a failed catalogue read must abort the delete, not save {}");
  const body = await res.json().catch(() => ({}));
  assert.equal(body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(body.error || "").includes("kv get boom"), "raw KV error text is not exposed to clients");
  assert.equal(kv._map.get("ext:movies"), before, "catalogue byte-identical — no wipe to empty");
  assert.equal(Object.keys(await kvObj(kv, "ext:movies")).length, 11);
});

test("R28 external POST with failing ext:movies read: 500, catalogue byte-identical", async () => {
  const live11 = seedLive11();
  const kv = makeFailingKV({ "ext:movies": live11 }, null, (k, n) => k === "ext:movies" && n === 1);
  const d = makeDO({ kv });
  const before = kv._map.get("ext:movies");
  const r = await call(d, "/api/admin/external", { video_url: "https://example.com/v.mp4", title: "Direct Film", type: "movie" });
  assert.equal(r.status, 500, "a failed catalogue read must abort the publish, not save a fallback");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(r.body.error || "").includes("kv get boom"), "raw KV error text is not exposed to clients");
  assert.equal(kv._map.get("ext:movies"), before, "catalogue byte-identical — no wipe to 1 entry");
  assert.equal(Object.keys(await kvObj(kv, "ext:movies")).length, 11);
});

test("R29 discovery dedupe-phase read fails: run recorded failed, nothing filed", async () => {
  const base = {
    "ext:pending": {},
    "ext:discovery:seen": { "movie:1001": { type: "movie", tmdb: 1001, title: "Already Seen", firstSeen: "2026-11-12", lastSeen: "2026-11-12", status: "pending" } },
    "ext:discovery:state": { enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null },
  };
  const oneTitleFetch = async (url) => {
    const u = String(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/discover/movie") || u.includes("/discover/tv") || u.includes("/trending/") || u.includes("/movie/upcoming")) return ok({ results: [{ id: 1001, popularity: 9 }] });
    if (u.includes("/watch/providers")) return ok({ results: {} });
    if (u.match(/\/movie\/1001\?/)) return ok({ id: 1001, title: "Already Seen", release_date: "2026-11-12", overview: "x", poster_path: "/p.jpg", backdrop_path: null, vote_average: 7, genres: [] });
    return ok({});
  };
  globalThis.fetch = oneTitleFetch;
  // Control: healthy reads -> the already-seen title is recognised, run ok, 0 filed.
  const kvC = makeKV(JSON.parse(JSON.stringify(base)));
  const dC = makeDO({ kv: kvC });
  const runC = await dC.runDiscovery(dC.env, "manual");
  assert.equal(runC.status, "ok", "control run must succeed with these seeds");
  assert.equal(runC.counts.newCandidates, 0, "already-seen title is not re-filed");
  assert.equal(Object.keys(await kvObj(kvC, "ext:pending")).length, 0);
  // Failing dedupe-phase read only (2nd get on ext:discovery:seen: reconciler=1st, batch=3rd).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(base)), null, (k, n) => k === "ext:discovery:seen" && n === 2);
  const dF = makeDO({ kv: kvF });
  const beforeSeen = kvF._map.get("ext:discovery:seen");
  const beforePend = kvF._map.get("ext:pending");
  const runF = await dF.runDiscovery(dF.env, "manual");
  assert.equal(runF.status, "failed", "a run that cannot read dedupe state must fail, not run blind");
  assert.ok(String(runF.error || "").includes("kv get boom"), "failure names the unreadable read");
  assert.equal(runF.counts.newCandidates, 0, "nothing filed after a failed dedupe read");
  assert.equal(kvF._map.get("ext:discovery:seen"), beforeSeen, "seen-map byte-identical");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical — nothing filed");
  const st = await stateOf(kvF);
  assert.equal(st.lastRun.status, "failed", "failure recorded in lastRun");
  assert.equal(st.lastSuccess, null, "no success recorded for a failed run");
});

// Dup-check correction (round 9 follow-up, 2026-11-13):
// R30–R31 — the two duplicate checks now read the catalogue through the
// real listMovies({ strictExt: true }). These tests exercise that path
// (bucket listing via a stubbed s3fetch + ext entries via the real KV
// read) — no `live:` fixture, which would bypass the read under test.
// R32 — approve's initial queue read is now strict.
function stubS3(d) {
  d.s3fetch = async (method, path) => {
    const enc = (s) => new TextEncoder().encode(s);
    if (path === "/") return { status: 200, body: enc("<ListAllMyBucketsResult><Buckets><Bucket><Name>media</Name></Bucket></Buckets></ListAllMyBucketsResult>") };
    if (path === "/media") return { status: 200, body: enc("<ListBucketResult><Contents><Key>movies/english/iron-man-2008-english.mp4</Key></Contents></ListBucketResult>") };
    return { status: 404, body: enc("") };
  };
}
const ironLive = { "emv-iron": { id: "emv-iron", title: "Iron Man", type: "movie", tmdb: 1726, year: "2008", url: "https://example.com/iron" } };

test("R30 pending add, dup-check catalogue read fails: 500, nothing queued", async () => {
  const kvBase = { "ext:movies": ironLive, "ext:pending": {} };
  // Control: healthy reads -> the dup check sees the live ext entry (409).
  const kvC = makeKV(JSON.parse(JSON.stringify(kvBase)));
  const dC = makeDO({ kv: kvC, tmdbKey: null, realList: true });
  stubS3(dC);
  const rC = await call(dC, "/api/admin/pending", { title: "Iron Man", type: "movie", tmdb: 1726 });
  assert.equal(rC.status, 409, "control: dup check must see the live ext entry via real listMovies");
  assert.equal(rC.body.error, "duplicate");
  assert.equal(Object.keys(await kvObj(kvC, "ext:pending")).length, 0, "control: duplicate not queued");
  // Failing catalogue read during dup detection (1st ext:movies get).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(kvBase)), null, (k, n) => k === "ext:movies" && n === 1);
  const dF = makeDO({ kv: kvF, tmdbKey: null, realList: true });
  stubS3(dF);
  const beforePend = kvF._map.get("ext:pending");
  const beforeMovies = kvF._map.get("ext:movies");
  const rF = await call(dF, "/api/admin/pending", { title: "Iron Man", type: "movie", tmdb: 1726 });
  assert.equal(rF.status, 500, "unreadable catalogue must abort the add, not queue a duplicate");
  assert.equal(rF.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(rF.body.error || "").includes("kv get boom"), "no raw KV error text to clients");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical");
  assert.equal(kvF._map.get("ext:movies"), beforeMovies, "catalogue byte-identical");
});

test("R31 approve, dup-check catalogue read fails: 500, nothing published", async () => {
  const cand = { id: "p-1", title: "Iron Man", type: "movie", tmdb: 1726, year: "2008", sources: [{ label: "S1", url: "https://example.com/play" }], status: "pending", createdAt: 1 };
  const kvBase = { "ext:movies": ironLive, "ext:pending": { "p-1": cand }, "ext:discovery:seen": {}, "ext:discovery:state": {} };
  // Control: healthy reads -> the dup check sees the live ext entry (409).
  const kvC = makeKV(JSON.parse(JSON.stringify(kvBase)));
  const dC = makeDO({ kv: kvC, realList: true });
  stubS3(dC);
  const rC = await call(dC, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rC.status, 409, "control: dup check must see the live ext entry via real listMovies");
  assert.equal(rC.body.error, "duplicate");
  assert.equal(Object.keys(await kvObj(kvC, "ext:movies")).length, 1, "control: duplicate not published");
  assert.ok((await kvObj(kvC, "ext:pending"))["p-1"], "control: candidate still queued");
  // Failing catalogue read during dup detection (2nd ext:movies get: self-heal scan is #1).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(kvBase)), null, (k, n) => k === "ext:movies" && n === 2);
  const dF = makeDO({ kv: kvF, realList: true });
  stubS3(dF);
  const beforePend = kvF._map.get("ext:pending");
  const beforeMovies = kvF._map.get("ext:movies");
  const rF = await call(dF, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rF.status, 500, "unreadable catalogue must abort the approve, not publish a duplicate");
  assert.equal(rF.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(rF.body.error || "").includes("kv get boom"), "no raw KV error text to clients");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical");
  assert.equal(kvF._map.get("ext:movies"), beforeMovies, "catalogue byte-identical");
});

test("R32 approve with failing initial queue read: 500, nothing published", async () => {
  const cand = { id: "p-1", title: "New Film", type: "movie", tmdb: 2001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/2001" }], status: "pending", createdAt: 1 };
  const kvBase = { "ext:movies": seedLive11(), "ext:pending": { "p-1": cand }, "ext:discovery:seen": {}, "ext:discovery:state": {} };
  // Control: healthy reads -> approve succeeds and publishes.
  const kvC = makeKV(JSON.parse(JSON.stringify(kvBase)));
  const dC = makeDO({ kv: kvC, realList: true });
  stubS3(dC);
  const rC = await call(dC, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rC.status, 200, "control: healthy approve must succeed");
  assert.equal(Object.keys(await kvObj(kvC, "ext:movies")).length, 12, "control: entry published");
  assert.equal((await kvObj(kvC, "ext:pending"))["p-1"], undefined, "control: candidate removed from queue");
  // Failing initial queue read (1st ext:pending get).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(kvBase)), null, (k, n) => k === "ext:pending" && n === 1);
  const dF = makeDO({ kv: kvF, realList: true });
  stubS3(dF);
  const beforePend = kvF._map.get("ext:pending");
  const beforeMovies = kvF._map.get("ext:movies");
  const rF = await call(dF, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rF.status, 500, "unreadable queue must abort the approve, not 404");
  assert.equal(rF.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(rF.body.error || "").includes("kv get boom"), "no raw KV error text to clients");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical");
  assert.equal(kvF._map.get("ext:movies"), beforeMovies, "catalogue byte-identical");
});
