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
import { createHash } from "node:crypto";
import { TunnelDO } from "./worker.mjs";

function makeKV(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async get(k, fmt) { const v = m.get(k); if (v == null) return null; return fmt === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    _map: m,
  };
}
function makeDO({ kv, tmdbKey = "FAKEKEY", live = null, slowKey = false, realList = false, catalogue = null, failStoreGet = null, failStorePut = null, commitThrowPut = null, slowStorePut = null, slowStorePutMs = 100 } = {}) {
  const env = { DATA_KV: kv, TMDB_KEY: undefined, DISCOVERY_CRON_SECRET: "cronsecret", S3_ACCESS_KEY: "x", S3_SECRET_KEY: "y" };
  // DO storage stub: a real backing Map (the freeze flag and, after F1,
  // the catalogue live here). Seeded with the two keys the worker reads
  // directly (tmdb_key, admin_pw); the `catalogue` option seeds
  // "ext:movies" (a legitimately empty catalogue is {} — an absent key
  // means unseeded and the strict read throws CATALOGUE_NOT_SEEDED).
  // _map exposes the store for assertions (frozen flag, catalogue).
  // failStoreGet / failStorePut throw on a matching (key, call#);
  // commitThrowPut commits the put and THEN throws (an ambiguous
  // write: the value landed but the caller saw a failure) — R51d.
  // slowStorePut delays a matching put by slowStorePutMs — R64 holds
  // a catalogue writer in flight to prove the freeze endpoint waits
  // for it before returning.
  // The stub clones on get and put, like real DO storage (which returns
  // a fresh deserialized copy): the worker's in-place mutation of a
  // fetched object must not leak into the store unless the put lands.
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const store = new Map([["tmdb_key", tmdbKey], ["admin_pw", "pw123"]]);
  if (catalogue != null) store.set("ext:movies", clone(catalogue));
  const perKeyGet = {};
  const perKeyPut = {};
  const state = { storage: {
    get: async (k) => {
      if (slowKey) await new Promise((r) => setTimeout(r, 5));
      perKeyGet[k] = (perKeyGet[k] || 0) + 1;
      if (failStoreGet && failStoreGet(k, perKeyGet[k])) throw new Error("store get boom: " + k);
      return store.has(k) ? clone(store.get(k)) : null;
    },
    put: async (k, v) => {
      perKeyPut[k] = (perKeyPut[k] || 0) + 1;
      if (slowStorePut && slowStorePut(k, perKeyPut[k])) await new Promise((r) => setTimeout(r, slowStorePutMs));
      if (commitThrowPut && commitThrowPut(k, perKeyPut[k])) { store.set(k, clone(v)); throw new Error("store put boom: " + k); }
      if (failStorePut && failStorePut(k, perKeyPut[k])) throw new Error("store put boom: " + k);
      store.set(k, clone(v));
    },
    delete: async (k) => { store.delete(k); },
    _map: store,
  } };
  const d = new TunnelDO(state, env);
  // realList: keep the production listMovies() (bucket listing via a stubbed
  // s3fetch + ext entries via the real KV read) — the `live` fixture would
  // bypass the catalogue-read path under test (R30–R32).
  if (!realList) d.listMovies = async () => live || [{ id: "emv", title: "Iron Man", tmdb: 1726, year: "2008", type: "movie" }];
  return d;
}
async function kvObj(kv, key) { return JSON.parse(kv._map.get(key) || "{}"); }
// Catalogue helpers (F1: the catalogue lives in DO storage, not KV).
// catOf returns the stored object (or undefined if unseeded); catJSON
// snapshots it as a string for byte-identical assertions.
function catOf(d) { return d.state.storage._map.get("ext:movies"); }
function catJSON(d) { const c = d.state.storage._map.get("ext:movies"); return c === undefined ? undefined : JSON.stringify(c); }
const PW = "?pw=pw123";
async function call(d, path, body) {
  const res = await d.fetch(new Request("https://internal" + path + PW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function callGet(d, path) {
  const res = await d.fetch(new Request("https://internal" + path + PW, { method: "GET" }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function callNoPw(d, path, body, method = "POST") {
  const res = await d.fetch(new Request("https://internal" + path, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body || {}) }));
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
  const d = makeDO({ kv, catalogue: {} });
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
  const d = makeDO({ kv, catalogue: {} });
  const r = await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/film.mp4" }] });
  assert.equal(r.status, 200);
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 200);
  const ext = catOf(d);
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
  const d = makeDO({ kv, catalogue: {} });
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 400);
  assert.match(ap.body.error, /source URL invalid/);
  const ext = catOf(d);
  assert.equal(Object.keys(ext).length, 0);
});

// T8: duplicate handling unchanged (409, then force publishes)
test("T8 duplicate still 409, force still publishes", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand({ tmdb: 1726, title: "Iron Man" }) } });
  const d = makeDO({ kv, catalogue: {} });
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
  });
  const d = makeDO({ kv, catalogue: { "e-live1": { id: "e-live1", pendingId: "p-test1", title: "Test Candidate", url: "https://example.com/film.mp4" } } });
  await call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/film.mp4" }] });
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-test1" });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.already, true);
  const ext = catOf(d);
  assert.equal(Object.keys(ext).length, 1); // no second live entry
  const pend = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend).length, 0);
});

// T10: concurrent edit + approve -> at most one live entry, no lost update
test("T10 concurrent edit + approve serializes safely", async () => {
  const kv = makeKV({ "ext:pending": { "p-test1": seedCand() } });
  const d = makeDO({ kv, catalogue: {} });
  const [edit, ap] = await Promise.all([
    call(d, "/api/admin/pending/sources", { id: "p-test1", sources: [{ label: "Main", url: "https://example.com/film.mp4" }] }),
    call(d, "/api/admin/pending/approve", { id: "p-test1" }),
  ]);
  const ext = catOf(d);
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
  }, null, (k) => k === "ext:discovery:seen" || k === "ext:discovery:state");
  const d = makeDO({ kv, catalogue: {} });
  const res = await call(d, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(res.status, 200, "approve succeeds even when bookkeeping reads fail");
  const live = catOf(d);
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
// R25–R28 — a failed catalogue read (DO storage, F1) in the wipe-capable
// admin write paths must abort with HTTP 500 and leave the stored
// contents byte-identical. R28 is re-targeted at the converted external
// POST (pending-submission): its dup check reads the catalogue through
// the real listMovies().
// R29 — a failed dedupe-phase read must fail the discovery run through the
// existing failure-recording path, with nothing filed.
function seedLive11() {
  const o = {};
  for (let i = 1; i <= 11; i++) o["emv" + i] = { id: "emv" + i, title: "Live Movie " + i, type: "movie", tmdb: 1000 + i, year: "2020", url: "https://example.com/" + i };
  return o;
}
function liveListOf(live11) { return Object.values(live11).map((e) => ({ id: e.id, title: e.title, tmdb: e.tmdb, year: e.year, type: e.type })); }

test("R25 approve with failing catalogue read: 500, catalogue byte-identical", async () => {
  const live11 = seedLive11();
  const kv = makeFailingKV({
    "ext:pending": { "p-1": { id: "p-1", title: "New Film", type: "movie", tmdb: 2001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/2001" }], status: "pending", createdAt: 1 } },
    "ext:discovery:seen": {},
    "ext:discovery:state": {},
  });
  const d = makeDO({ kv, live: liveListOf(live11), catalogue: live11, failStoreGet: (k, n) => k === "ext:movies" && n === 2 }); // publish-step read (self-heal scan is #1)
  const beforeMovies = catJSON(d);
  const beforePend = kv._map.get("ext:pending");
  const r = await call(d, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(r.status, 500, "a failed catalogue read must abort the approve, not publish");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(r.body.error || "").includes("store get boom"), "raw storage error text is not exposed to clients");
  assert.equal(catJSON(d), beforeMovies, "catalogue byte-identical — no wipe to 1 entry");
  assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical — candidate not deleted");
  assert.equal(Object.keys(catOf(d)).length, 11);
});

test("R26 pending add with failing ext:pending read: 500, queue byte-identical", async () => {
  const seed = {};
  for (let i = 1; i <= 45; i++) seed["p-" + i] = { id: "p-" + i, title: "Queued " + i, type: "movie", tmdb: 3000 + i, status: "pending", createdAt: i };
  const live11 = seedLive11();
  const kv = makeFailingKV({ "ext:pending": seed }, null, (k, n) => k === "ext:pending" && n === 2); // save-step read (dup check is #1)
  const d = makeDO({ kv, live: liveListOf(live11) });
  const beforePend = kv._map.get("ext:pending");
  const r = await call(d, "/api/admin/pending", { title: "Brand New", type: "movie" });
  assert.equal(r.status, 500, "a failed queue read must abort the add, not save a fallback");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(r.body.error || "").includes("kv get boom"), "raw KV error text is not exposed to clients");
  assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical — no wipe to 1 candidate");
  assert.equal(Object.keys(await kvObj(kv, "ext:pending")).length, 45);
});

test("R27 DELETE external with failing catalogue read: 500, catalogue byte-identical", async () => {
  const live11 = seedLive11();
  const kv = makeFailingKV({});
  const d = makeDO({ kv, catalogue: live11, failStoreGet: (k, n) => k === "ext:movies" && n === 1 });
  const before = catJSON(d);
  const res = await d.fetch(new Request("https://internal/api/admin/external?pw=pw123&id=emv3", { method: "DELETE" }));
  assert.equal(res.status, 500, "a failed catalogue read must abort the delete, not save {}");
  const body = await res.json().catch(() => ({}));
  assert.equal(body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(body.error || "").includes("store get boom"), "raw storage error text is not exposed to clients");
  assert.equal(catJSON(d), before, "catalogue byte-identical — no wipe to empty");
  assert.equal(Object.keys(catOf(d)).length, 11);
});

test("R28 converted external POST with failing catalogue read: 500, catalogue + queue byte-identical", async () => {
  const live11 = seedLive11();
  const kv = makeFailingKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: live11, realList: true, failStoreGet: (k, n) => k === "ext:movies" && n === 1 });
  stubS3(d);
  const before = catJSON(d);
  const beforePend = kv._map.get("ext:pending");
  const r = await call(d, "/api/admin/external", { video_url: "https://example.com/v.mp4", title: "Direct Film", type: "movie" });
  assert.equal(r.status, 500, "a failed catalogue read during the dup check must abort the submission, not queue blind");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again", "read failure gets the generic message");
  assert.ok(!String(r.body.error || "").includes("store get boom"), "raw storage error text is not exposed to clients");
  assert.equal(catJSON(d), before, "catalogue byte-identical — nothing published");
  assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical — nothing queued");
  assert.equal(Object.keys(catOf(d)).length, 11);
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
  const kvBase = { "ext:pending": {} };
  // Control: healthy reads -> the dup check sees the live ext entry (409).
  const kvC = makeKV(JSON.parse(JSON.stringify(kvBase)));
  const dC = makeDO({ kv: kvC, tmdbKey: null, realList: true, catalogue: JSON.parse(JSON.stringify(ironLive)) });
  stubS3(dC);
  const rC = await call(dC, "/api/admin/pending", { title: "Iron Man", type: "movie", tmdb: 1726 });
  assert.equal(rC.status, 409, "control: dup check must see the live ext entry via real listMovies");
  assert.equal(rC.body.error, "duplicate");
  assert.equal(Object.keys(await kvObj(kvC, "ext:pending")).length, 0, "control: duplicate not queued");
  // Failing catalogue read during dup detection (1st ext:movies get).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(kvBase)));
  const dF = makeDO({ kv: kvF, tmdbKey: null, realList: true, catalogue: JSON.parse(JSON.stringify(ironLive)), failStoreGet: (k, n) => k === "ext:movies" && n === 1 });
  stubS3(dF);
  const beforePend = kvF._map.get("ext:pending");
  const beforeMovies = catJSON(dF);
  const rF = await call(dF, "/api/admin/pending", { title: "Iron Man", type: "movie", tmdb: 1726 });
  assert.equal(rF.status, 500, "unreadable catalogue must abort the add, not queue a duplicate");
  assert.equal(rF.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(rF.body.error || "").includes("store get boom"), "no raw storage error text to clients");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical");
  assert.equal(catJSON(dF), beforeMovies, "catalogue byte-identical");
});

test("R31 approve, dup-check catalogue read fails: 500, nothing published", async () => {
  const cand = { id: "p-1", title: "Iron Man", type: "movie", tmdb: 1726, year: "2008", sources: [{ label: "S1", url: "https://example.com/play" }], status: "pending", createdAt: 1 };
  const kvBase = { "ext:pending": { "p-1": cand }, "ext:discovery:seen": {}, "ext:discovery:state": {} };
  // Control: healthy reads -> the dup check sees the live ext entry (409).
  const kvC = makeKV(JSON.parse(JSON.stringify(kvBase)));
  const dC = makeDO({ kv: kvC, realList: true, catalogue: JSON.parse(JSON.stringify(ironLive)) });
  stubS3(dC);
  const rC = await call(dC, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rC.status, 409, "control: dup check must see the live ext entry via real listMovies");
  assert.equal(rC.body.error, "duplicate");
  assert.equal(Object.keys(catOf(dC)).length, 1, "control: duplicate not published");
  assert.ok((await kvObj(kvC, "ext:pending"))["p-1"], "control: candidate still queued");
  // Failing catalogue read during dup detection (2nd ext:movies get: self-heal scan is #1).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(kvBase)));
  const dF = makeDO({ kv: kvF, realList: true, catalogue: JSON.parse(JSON.stringify(ironLive)), failStoreGet: (k, n) => k === "ext:movies" && n === 2 });
  stubS3(dF);
  const beforePend = kvF._map.get("ext:pending");
  const beforeMovies = catJSON(dF);
  const rF = await call(dF, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rF.status, 500, "unreadable catalogue must abort the approve, not publish a duplicate");
  assert.equal(rF.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(rF.body.error || "").includes("store get boom"), "no raw storage error text to clients");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical");
  assert.equal(catJSON(dF), beforeMovies, "catalogue byte-identical");
});

test("R32 approve with failing initial queue read: 500, nothing published", async () => {
  const cand = { id: "p-1", title: "New Film", type: "movie", tmdb: 2001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/2001" }], status: "pending", createdAt: 1 };
  const kvBase = { "ext:pending": { "p-1": cand }, "ext:discovery:seen": {}, "ext:discovery:state": {} };
  // Control: healthy reads -> approve succeeds and publishes.
  const kvC = makeKV(JSON.parse(JSON.stringify(kvBase)));
  const dC = makeDO({ kv: kvC, realList: true, catalogue: seedLive11() });
  stubS3(dC);
  const rC = await call(dC, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rC.status, 200, "control: healthy approve must succeed");
  assert.equal(Object.keys(catOf(dC)).length, 12, "control: entry published");
  assert.equal((await kvObj(kvC, "ext:pending"))["p-1"], undefined, "control: candidate removed from queue");
  // Failing initial queue read (1st ext:pending get).
  const kvF = makeFailingKV(JSON.parse(JSON.stringify(kvBase)), null, (k, n) => k === "ext:pending" && n === 1);
  const dF = makeDO({ kv: kvF, realList: true, catalogue: seedLive11() });
  stubS3(dF);
  const beforePend = kvF._map.get("ext:pending");
  const beforeMovies = catJSON(dF);
  const rF = await call(dF, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(rF.status, 500, "unreadable queue must abort the approve, not 404");
  assert.equal(rF.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(rF.body.error || "").includes("kv get boom"), "no raw KV error text to clients");
  assert.equal(kvF._map.get("ext:pending"), beforePend, "queue byte-identical");
  assert.equal(catJSON(dF), beforeMovies, "catalogue byte-identical");
});

// ---- Catalogue freeze (F1 migration prerequisite, Rev 4.1 §3) ----
// FZ1–FZ3: the freeze flag blocks the catalogue-write routes with 503
// and no write (F1: extposter is gone — 404 — and ytinfo is read-only,
// so neither is a freeze-blocked write any more); clearing the flag
// restores normal writes; the flag endpoints round-trip and are
// password-gated. FZ4: the one-time migration endpoint (Phase 1 report
// §5.3) is protected and verified.
const FROZEN_MSG = "catalogue frozen for migration — try again later";

test("FZ1 freeze blocks the catalogue-write routes with 503, no write (extposter gone: 404)", async () => {
  const live11 = seedLive11();
  const kv = makeKV({
    "ext:pending": { "p-1": { id: "p-1", title: "New Film", type: "movie", tmdb: 2001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/2001" }], status: "pending", createdAt: 1 } },
    "ext:discovery:seen": {},
    "ext:discovery:state": {},
  });
  const d = makeDO({ kv, live: liveListOf(live11), catalogue: live11 });
  const beforeMovies = catJSON(d);
  const beforePend = kv._map.get("ext:pending");
  const set = await call(d, "/api/admin/catalogue-freeze", { frozen: true });
  assert.equal(set.status, 200, "setting the freeze must succeed");
  assert.equal(set.body.frozen, true);
  const get = await callGet(d, "/api/admin/catalogue-freeze");
  assert.equal(get.status, 200);
  assert.equal(get.body.frozen, true, "the flag reads back as set");
  // 1. pending submission (F1: the external POST no longer publishes, but
  // the freeze check still guards its lock callback).
  const r1 = await call(d, "/api/admin/external", { video_url: "https://example.com/v.mp4", title: "Direct Film", type: "movie" });
  assert.equal(r1.status, 503, "external POST must be blocked while frozen");
  assert.equal(r1.body.error, FROZEN_MSG);
  // 2. extposter is gone in F1 (route removed): 404, not 503.
  const r2 = await call(d, "/api/admin/extposter", { id: "emv1", poster: "https://example.com/p.jpg" });
  assert.equal(r2.status, 404, "extposter must be gone (F1 removed the route)");
  // 3. publish/unpublish flip.
  const r3 = await call(d, "/api/admin/extpublish", { id: "emv1", unlisted: true });
  assert.equal(r3.status, 503, "extpublish must be blocked while frozen");
  assert.equal(r3.body.error, FROZEN_MSG);
  // 4. delete.
  const res5 = await d.fetch(new Request("https://internal/api/admin/external?pw=pw123&id=emv3", { method: "DELETE" }));
  assert.equal(res5.status, 503, "DELETE external must be blocked while frozen");
  assert.equal((await res5.json().catch(() => ({}))).error, FROZEN_MSG);
  // 5. approve.
  const r6 = await call(d, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(r6.status, 503, "approve must be blocked while frozen");
  assert.equal(r6.body.error, FROZEN_MSG);
  // (ytinfo is read-only in F1 and carries no freeze check; R46 covers it.)
  // Nothing was written anywhere.
  assert.equal(catJSON(d), beforeMovies, "catalogue byte-identical while frozen");
  assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical while frozen");
  assert.equal(Object.keys(catOf(d)).length, 11);
  assert.equal(Object.keys(await kvObj(kv, "ext:pending")).length, 1);
});

test("FZ2 flag clear restores normal catalogue writes", async () => {
  const live11 = seedLive11();
  const kv = makeKV({ "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} });
  const d = makeDO({ kv, live: liveListOf(live11), catalogue: live11 });
  const set = await call(d, "/api/admin/catalogue-freeze", { frozen: true });
  assert.equal(set.status, 200);
  const blocked = await call(d, "/api/admin/extpublish", { id: "emv1", unlisted: true });
  assert.equal(blocked.status, 503, "frozen: extpublish blocked");
  const clear = await call(d, "/api/admin/catalogue-freeze", { frozen: false });
  assert.equal(clear.status, 200, "clearing the freeze must succeed");
  assert.equal(clear.body.frozen, false);
  const get = await callGet(d, "/api/admin/catalogue-freeze");
  assert.equal(get.body.frozen, false, "the flag reads back as clear");
  const ok = await call(d, "/api/admin/extpublish", { id: "emv1", unlisted: true });
  assert.equal(ok.status, 200, "unfrozen: extpublish works again");
  const ext = catOf(d);
  assert.equal(ext["emv1"].unlisted, true, "the write landed after the flag cleared");
});

test("FZ3 freeze endpoints round-trip and are password-gated", async () => {
  const kv = makeKV({ "ext:movies": {}, "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} });
  const d = makeDO({ kv });
  const noPwGet = await callNoPw(d, "/api/admin/catalogue-freeze", null, "GET");
  assert.equal(noPwGet.status, 403, "GET freeze without a password must be 403");
  const noPwPost = await callNoPw(d, "/api/admin/catalogue-freeze", { frozen: true });
  assert.equal(noPwPost.status, 403, "POST freeze without a password must be 403");
  const set = await call(d, "/api/admin/catalogue-freeze", { frozen: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.frozen, true);
  const get1 = await callGet(d, "/api/admin/catalogue-freeze");
  assert.equal(get1.body.frozen, true, "set true round-trips");
  const clear = await call(d, "/api/admin/catalogue-freeze", { frozen: false });
  assert.equal(clear.body.frozen, false);
  const get2 = await callGet(d, "/api/admin/catalogue-freeze");
  assert.equal(get2.body.frozen, false, "set false round-trips");
  // A body without frozen:true clears the flag (frozen === true check).
  await call(d, "/api/admin/catalogue-freeze", { frozen: true });
  const noField = await call(d, "/api/admin/catalogue-freeze", {});
  assert.equal(noField.body.frozen, false, "a body without frozen:true clears the flag");
});

test("FZ4 migration endpoint is protected and verifies the seed", async () => {
  const live11 = seedLive11();
  const kv = makeKV({ "ext:movies": live11, "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} });
  const d = makeDO({ kv, live: liveListOf(live11) });
  const beforeMovies = kv._map.get("ext:movies");
  // (a) Not frozen yet: refused.
  const notFrozen = await call(d, "/api/admin/catalogue-migrate", {});
  assert.equal(notFrozen.status, 400, "migration without the freeze must be refused");
  assert.equal(notFrozen.body.error, "catalogue must be frozen before migration");
  assert.equal(d.state.storage._map.get("ext:movies"), undefined, "nothing seeded on the refused call");
  // (b) No password: 403.
  const noPw = await callNoPw(d, "/api/admin/catalogue-migrate", {});
  assert.equal(noPw.status, 403, "migration without a password must be 403");
  // (c) Frozen: the seed runs and verifies.
  const set = await call(d, "/api/admin/catalogue-freeze", { frozen: true });
  assert.equal(set.status, 200);
  const expectedHash = createHash("sha256").update(JSON.stringify(live11)).digest("hex");
  const mig = await call(d, "/api/admin/catalogue-migrate", {});
  assert.equal(mig.status, 200, "a frozen, unseeded migration must succeed");
  assert.equal(mig.body.ok, true);
  assert.equal(mig.body.count, 11);
  assert.equal(mig.body.sha256, expectedHash, "the returned hash matches the KV source");
  assert.equal(mig.body.verified, true);
  assert.deepEqual(d.state.storage._map.get("ext:movies"), live11, "DO storage now holds the catalogue");
  assert.equal(kv._map.get("ext:movies"), beforeMovies, "the KV source is left in place as a backup");
  // (d) Already seeded: refused (one-time only).
  const again = await call(d, "/api/admin/catalogue-migrate", {});
  assert.equal(again.status, 409, "a second migration must be refused");
  assert.equal(again.body.error, "catalogue already migrated");
  assert.deepEqual(d.state.storage._map.get("ext:movies"), live11, "the second call changed nothing");
});

// ---- F1 approval-first (Rev 2 / Rev 2.1 / addendum / readiness) ----
// R38–R52: provenance, metadata lifecycle, duplicate handling,
// validation, recovery and partial-write behaviour.
// R53–R57: the authenticated entries lookup.
// R58–R60: stale-read protection, concurrent changes, isolation.
function seedLiveEntry(over = {}) {
  return { id: "emv1", title: "Live Movie One", type: "movie", tmdb: 1001, year: "2020", url: "https://example.com/1", poster: "https://example.com/p1.jpg", ...over };
}
function seedMeta(over = {}) {
  return { id: "pm-test1", kind: "meta", targetId: "emv1", targetTitle: "Live Movie One", changes: { title: "Renamed Movie One" }, expected: { title: "Live Movie One" }, status: "pending", createdAt: 1, ...over };
}
// GET with a query string already in the path (callGet appends ?pw=,
// which would corrupt it). Returns { status, body }.
async function callGetQ(d, path) {
  const res = await d.fetch(new Request("https://internal" + path + "&pw=pw123", { method: "GET" }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
// Raw GET (for response headers, e.g. Cache-Control). Appends the pw
// with the right separator for the path.
async function callGetRaw(d, path) {
  const sep = path.includes("?") ? "&" : "?";
  return d.fetch(new Request("https://internal" + path + sep + "pw=pw123", { method: "GET" }));
}

test("R38 forged pendingId via direct POST is ignored: queued, never published", async () => {
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: {}, realList: true });
  stubS3(d);
  const r = await call(d, "/api/admin/external", { video_url: "https://example.com/v.mp4", title: "Direct Film", type: "movie", pendingId: "p-forged123", id: "e-forged" });
  assert.equal(r.status, 200, "the submission is accepted as a queue candidate");
  assert.equal(r.body.queued, true);
  assert.ok(r.body.id && r.body.id.startsWith("p"), "the id is server-generated");
  assert.notEqual(r.body.id, "e-forged", "the caller's id is ignored");
  const pend = await kvObj(kv, "ext:pending");
  const cand = pend[r.body.id];
  assert.ok(cand, "candidate queued");
  assert.equal(cand.pendingId, undefined, "no pendingId on a queued candidate");
  assert.deepEqual(catOf(d), {}, "catalogue untouched — nothing published");
  const movies = await d.listMovies(d.env, {});
  assert.ok(!movies.some((m) => m.title === "Direct Film"), "the candidate is not in the public feed");
});

test("R39 forged id/pendingId via pending add is ignored", async () => {
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: {} });
  const r = await call(d, "/api/admin/pending", { id: "p-forged123", pendingId: "p-forged456", title: "Queued Film", type: "movie" });
  assert.equal(r.status, 200);
  assert.ok(r.body.id && r.body.id.startsWith("p"), "server-generated id");
  assert.notEqual(r.body.id, "p-forged123", "the caller's id is ignored");
  const pend = await kvObj(kv, "ext:pending");
  const cand = pend[r.body.id];
  assert.ok(cand);
  assert.equal(cand.pendingId, undefined, "no pendingId on a queued candidate");
  assert.equal(pend["p-forged123"], undefined, "the forged id was not used as a key");
});

test("R40 forged pendingId via legacy routes cannot grant provenance", async () => {
  const live = { "emv1": seedLiveEntry() };
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: JSON.parse(JSON.stringify(live)) });
  // extposter is gone (404) — it cannot set anything.
  const rPoster = await call(d, "/api/admin/extposter", { id: "emv1", poster: "https://example.com/p2.jpg", pendingId: "p-forged123" });
  assert.equal(rPoster.status, 404, "extposter is gone");
  // ytinfo is read-only — it cannot set a pendingId.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ title: "YT Title" }) });
  const rYt = await call(d, "/api/admin/ytinfo", { id: "emv1", url: "https://www.youtube.com/watch?v=abc123", pendingId: "p-forged123" });
  assert.equal(rYt.status, 200);
  assert.equal(rYt.body.title, "YT Title");
  // extpublish with a forged pendingId in the body cannot list the entry.
  const rPub = await call(d, "/api/admin/extpublish", { id: "emv1", unlisted: false, pendingId: "p-forged123" });
  assert.equal(rPub.status, 400, "a legacy entry with no server-assigned pendingId cannot be listed");
  assert.equal(rPub.body.error, "not approved — re-approve via the queue");
  const ext = catOf(d);
  assert.equal(ext["emv1"].pendingId, undefined, "no pendingId was forged onto the entry");
  assert.equal(ext["emv1"].poster, "https://example.com/p1.jpg", "the poster is unchanged (ytinfo is read-only)");
  assert.equal(ext["emv1"].title, "Live Movie One", "the title is unchanged (ytinfo is read-only)");
});

test("R41 approve of an unknown id is 404, catalogue unchanged", async () => {
  const live11 = seedLive11();
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: live11 });
  const before = catJSON(d);
  const r = await call(d, "/api/admin/pending/approve", { id: "p-nope123" });
  assert.equal(r.status, 404);
  assert.equal(catJSON(d), before, "catalogue byte-identical");
});

test("R42 legacy listing guard: malformed pendingId values cannot list, bounds hold", async () => {
  const badValues = ["", "p", "p123", "forged", "P12345678", 0, 123, null, {}, ["p12345678"], "e12345678", "p123456789012345", "p".padEnd(200, "x")];
  const entries = {};
  const ids = [];
  badValues.forEach((v, i) => {
    const id = "emv-bad" + i;
    entries[id] = { id, title: "Bad " + i, type: "movie", tmdb: 2000 + i, url: "https://example.com/" + i, unlisted: true, pendingId: v };
    ids.push(id);
  });
  entries["emv-9"] = { id: "emv-9", title: "Nine", type: "movie", tmdb: 3009, url: "https://example.com/9", unlisted: true, pendingId: "p12345678" };
  entries["emv-14"] = { id: "emv-14", title: "Fourteen", type: "movie", tmdb: 3014, url: "https://example.com/14", unlisted: true, pendingId: "p1234567890123" };
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: entries });
  for (const id of ids) {
    const r = await call(d, "/api/admin/extpublish", { id, unlisted: false });
    assert.equal(r.status, 400, "pendingId " + JSON.stringify(entries[id].pendingId) + " must not list");
    assert.equal(r.body.error, "not approved — re-approve via the queue");
    assert.equal(catOf(d)[id].unlisted, true, "the entry stays unlisted");
  }
  // Boundary: the shortest accepted sanity-check value (9 chars) and the
  // longest (14 chars) list. Neither is necessarily a real generated id.
  const r9 = await call(d, "/api/admin/extpublish", { id: "emv-9", unlisted: false });
  assert.equal(r9.status, 200, "a 9-char pendingId passes the sanity check");
  assert.equal(catOf(d)["emv-9"].unlisted, false);
  const r14 = await call(d, "/api/admin/extpublish", { id: "emv-14", unlisted: false });
  assert.equal(r14.status, 200, "a 14-char pendingId passes the sanity check");
  assert.equal(catOf(d)["emv-14"].unlisted, false);
  // Unlisting works for every value (the safe direction is never blocked).
  for (const id of [...ids, "emv-9", "emv-14"]) {
    const r = await call(d, "/api/admin/extpublish", { id, unlisted: true });
    assert.equal(r.status, 200, "hiding must work for any pendingId value");
    assert.equal(catOf(d)[id].unlisted, true);
  }
  // A genuine pendingId from a real approve lists. The candidate is
  // filed through the pending-add route so its id is a real
  // server-generated base36 id (not a hand-picked string with a hyphen,
  // which the provenance regex rightly rejects).
  const kv2 = makeKV({ "ext:pending": {} });
  const d2 = makeDO({ kv: kv2, catalogue: {} });
  const addReal = await call(d2, "/api/admin/pending", { title: "Real Film", type: "movie", tmdb: 4001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/4001" }] });
  assert.equal(addReal.status, 200, "filing the real candidate must succeed");
  const realCandId = addReal.body.id;
  assert.ok(/^p[0-9a-z]{8,13}$/.test(realCandId), "the generated candidate id is a base36 id");
  const ap = await call(d2, "/api/admin/pending/approve", { id: realCandId });
  assert.equal(ap.status, 200);
  const liveId = ap.body.id;
  assert.ok(catOf(d2)[liveId].pendingId, "a real approve assigns a pendingId");
  const hide = await call(d2, "/api/admin/extpublish", { id: liveId, unlisted: true });
  assert.equal(hide.status, 200);
  const show = await call(d2, "/api/admin/extpublish", { id: liveId, unlisted: false });
  assert.equal(show.status, 200, "a genuine pendingId lists");
  assert.equal(catOf(d2)[liveId].unlisted, false);
});

test("R43 legacy entry: extposter 404, ytinfo read-only, unlisted lookup works", async () => {
  const wallE = { id: "emvsu47s4", title: "WALL·E", type: "movie", tmdb: 10681, url: "https://example.com/walle", poster: "https://example.com/walle.jpg", unlisted: true };
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emvsu47s4": JSON.parse(JSON.stringify(wallE)) } });
  const rPoster = await call(d, "/api/admin/extposter", { id: "emvsu47s4", poster: "https://example.com/new.jpg" });
  assert.equal(rPoster.status, 404);
  assert.equal(catOf(d)["emvsu47s4"].poster, "https://example.com/walle.jpg", "the poster is unchanged");
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ title: "WALL·E (YT)" }) });
  const rYt = await call(d, "/api/admin/ytinfo", { id: "emvsu47s4", url: "https://www.youtube.com/watch?v=abc123" });
  assert.equal(rYt.status, 200);
  assert.equal(rYt.body.title, "WALL·E (YT)");
  assert.equal(catOf(d)["emvsu47s4"].title, "WALL·E", "ytinfo wrote nothing");
  assert.equal(catOf(d)["emvsu47s4"].poster, "https://example.com/walle.jpg", "ytinfo wrote nothing");
  const look = await callGetQ(d, "/api/admin/entries?q=WALL");
  assert.equal(look.status, 200);
  assert.equal(look.body.entries.length, 1);
  const e = look.body.entries[0];
  assert.equal(e.id, "emvsu47s4");
  assert.equal(e.unlisted, true);
  assert.equal(e.sources, undefined, "the lookup never returns sources");
  assert.equal(e.url, undefined, "the lookup never returns playback URLs");
  const noPw = await callNoPw(d, "/api/admin/entries?q=WALL", null, "GET");
  assert.equal(noPw.status, 403);
  const d2 = makeDO({ kv: makeKV({ "ext:pending": {} }), catalogue: { "emvsu47s4": JSON.parse(JSON.stringify(wallE)) }, realList: true });
  stubS3(d2);
  const movies = await d2.listMovies(d2.env, {});
  assert.ok(!movies.some((m) => m.id === "emvsu47s4"), "unlisted entries stay out of the feed");
  const prop = await call(d, "/api/admin/pending/meta", { targetId: "emvsu47s4", changes: { title: "WALL·E (2008)" } });
  assert.equal(prop.status, 200);
  assert.equal(prop.body.targetTitle, "WALL·E", "the propose response echoes the current title");
  const ap = await call(d, "/api/admin/pending/approve", { id: prop.body.id });
  assert.equal(ap.status, 200);
  const after = catOf(d)["emvsu47s4"];
  assert.equal(after.title, "WALL·E (2008)");
  assert.ok(after.metaUpdatedAt, "metaUpdatedAt is set");
  assert.equal(after.pendingId, undefined, "a meta-approve grants no provenance");
  assert.equal(after.unlisted, true, "the entry stays unlisted");
});

test("R44 meta lifecycle: propose, approve, reject, missing target", async () => {
  const entry = seedLiveEntry();
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emv1": JSON.parse(JSON.stringify(entry)) } });
  const prop = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "New Title", poster: "https://example.com/p2.jpg" } });
  assert.equal(prop.status, 200);
  const pid = prop.body.id;
  assert.ok(pid.startsWith("pm"), "meta proposal ids start with pm");
  assert.equal(catOf(d)["emv1"].title, "Live Movie One", "proposing changes nothing");
  assert.equal(catOf(d)["emv1"].poster, "https://example.com/p1.jpg");
  const ap = await call(d, "/api/admin/pending/approve", { id: pid });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.title, "New Title");
  const after = catOf(d)["emv1"];
  assert.equal(after.title, "New Title");
  assert.equal(after.poster, "https://example.com/p2.jpg");
  assert.ok(after.metaUpdatedAt, "metaUpdatedAt is set");
  assert.equal((await kvObj(kv, "ext:pending"))[pid], undefined, "the proposal is gone from the queue");
  const prop2 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Another Title" } });
  assert.equal(prop2.status, 200);
  const rej = await call(d, "/api/admin/pending/reject", { id: prop2.body.id });
  assert.equal(rej.status, 200);
  const apRej = await call(d, "/api/admin/pending/approve", { id: prop2.body.id });
  assert.equal(apRej.status, 400, "a rejected proposal cannot be approved");
  const prop3 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Third Title" } });
  assert.equal(prop3.status, 200);
  const del = await d.fetch(new Request("https://internal/api/admin/external?pw=pw123&id=emv1", { method: "DELETE" }));
  assert.equal(del.status, 200);
  assert.equal(catOf(d)["emv1"], undefined, "the entry is deleted");
  const apMissing = await call(d, "/api/admin/pending/approve", { id: prop3.body.id });
  assert.equal(apMissing.status, 404, "a missing target is 404");
  assert.ok((await kvObj(kv, "ext:pending"))[prop3.body.id], "the proposal stays queued");
});

test("R45 meta validation: no changes, unknown target, sources, dup title, stale", async () => {
  const entries = {
    "emv1": seedLiveEntry(),
    "emv2": seedLiveEntry({ id: "emv2", title: "Second Movie", tmdb: 1002, url: "https://example.com/2" }),
  };
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: JSON.parse(JSON.stringify(entries)) });
  // No changes.
  const noCh = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: {} });
  assert.equal(noCh.status, 400);
  // Unknown target.
  const noTgt = await call(d, "/api/admin/pending/meta", { targetId: "emv-nope", changes: { title: "X" } });
  assert.equal(noTgt.status, 404);
  // Sources in the proposal body.
  const srcBody = await call(d, "/api/admin/pending/meta", { targetId: "emv1", sources: [{ label: "S", url: "https://example.com/s.mp4" }], changes: { title: "X" } });
  assert.equal(srcBody.status, 400);
  // Sources inside changes.
  const srcCh = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "X", sources: [] } });
  assert.equal(srcCh.status, 400);
  // A forged `expected` in the body is ignored (the server captures it).
  const forged = await call(d, "/api/admin/pending/meta", { targetId: "emv1", expected: { title: "Forged Old" }, changes: { title: "Forged New" } });
  assert.equal(forged.status, 200);
  const stored = (await kvObj(kv, "ext:pending"))[forged.body.id];
  assert.equal(stored.expected.title, "Live Movie One", "expected comes from the fresh server-side read, not the body");
  // Sources route on a meta proposal: 400.
  const srcRoute = await call(d, "/api/admin/pending/sources", { id: forged.body.id, sources: [{ label: "S", url: "https://example.com/s.mp4" }] });
  assert.equal(srcRoute.status, 400);
  // Duplicate title at approve (another live entry already has it).
  const dupProp = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Second Movie" } });
  assert.equal(dupProp.status, 200);
  const dupAp = await call(d, "/api/admin/pending/approve", { id: dupProp.body.id });
  assert.equal(dupAp.status, 409, "a title that duplicates another live entry is refused");
  assert.equal(dupAp.body.error, "duplicate");
  assert.equal(catOf(d)["emv1"].title, "Live Movie One", "the duplicate title was not applied");
  // Concurrent same-field different values: P2 is stale after P1 lands.
  const p1 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "First Wins" } });
  const p2 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Second Loses" } });
  assert.equal(p1.status, 200);
  assert.equal(p2.status, 200);
  const ap1 = await call(d, "/api/admin/pending/approve", { id: p1.body.id });
  assert.equal(ap1.status, 200);
  const ap2 = await call(d, "/api/admin/pending/approve", { id: p2.body.id });
  assert.equal(ap2.status, 409, "the second proposal is stale once the first lands");
  assert.equal(ap2.body.error, "stale proposal");
  assert.equal(ap2.body.field, "title");
  assert.ok((await kvObj(kv, "ext:pending"))[p2.body.id], "the stale proposal stays queued");
  assert.equal(catOf(d)["emv1"].title, "First Wins");
  // Same value as the current title: already applied (self-heal).
  const p3 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "First Wins" } });
  assert.equal(p3.status, 200);
  const ap3 = await call(d, "/api/admin/pending/approve", { id: p3.body.id });
  assert.equal(ap3.status, 200);
  assert.equal(ap3.body.already, true, "proposing the value the entry already has is a no-op self-heal");
  // Different fields: both apply, each touches only its own field.
  const p4 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Field A" } });
  const p5 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { poster: "https://example.com/p9.jpg" } });
  assert.equal(p4.status, 200);
  assert.equal(p5.status, 200);
  const ap4 = await call(d, "/api/admin/pending/approve", { id: p4.body.id });
  assert.equal(ap4.status, 200);
  const ap5 = await call(d, "/api/admin/pending/approve", { id: p5.body.id });
  assert.equal(ap5.status, 200);
  const fin = catOf(d)["emv1"];
  assert.equal(fin.title, "Field A", "the title proposal applied");
  assert.equal(fin.poster, "https://example.com/p9.jpg", "the poster proposal applied");
});

test("R46 ytinfo is a read-only lookup (stubbed oEmbed)", async () => {
  const entry = seedLiveEntry();
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emv1": JSON.parse(JSON.stringify(entry)) } });
  const before = catJSON(d);
  const beforePend = kv._map.get("ext:pending");
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("oembed"), "ytinfo fetches the oEmbed endpoint");
    return { ok: true, json: async () => ({ title: "YouTube Title" }) };
  };
  const r = await call(d, "/api/admin/ytinfo", { url: "https://www.youtube.com/watch?v=abc123" });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, "YouTube Title");
  assert.equal(r.body.poster, "https://img.youtube.com/vi/abc123/hqdefault.jpg");
  assert.equal(catJSON(d), before, "the catalogue is byte-identical — ytinfo wrote nothing");
  assert.equal(kv._map.get("ext:pending"), beforePend, "the queue is byte-identical");
  // A non-YouTube URL is 400; a failed oEmbed is 502.
  const bad = await call(d, "/api/admin/ytinfo", { url: "https://example.com/not-youtube" });
  assert.equal(bad.status, 400);
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const fail = await call(d, "/api/admin/ytinfo", { url: "https://youtu.be/abc123" });
  assert.equal(fail.status, 502);
});

test("R47 extposter is gone (404), poster unchanged", async () => {
  const entry = seedLiveEntry();
  // The KV catalogue is seeded too, so that on the pre-F1 code the
  // extposter route would find the entry and answer 200 (the negative
  // control): the 404 here must come from the route being gone, not
  // from the entry being absent.
  const kv = makeKV({ "ext:pending": {}, "ext:movies": { "emv1": JSON.parse(JSON.stringify(entry)) } });
  const d = makeDO({ kv, catalogue: { "emv1": JSON.parse(JSON.stringify(entry)) } });
  const before = catJSON(d);
  const r = await call(d, "/api/admin/extposter", { id: "emv1", poster: "https://example.com/new.jpg" });
  assert.equal(r.status, 404, "the removed route answers 404");
  assert.equal(catJSON(d), before, "the catalogue is byte-identical");
  assert.equal(catOf(d)["emv1"].poster, "https://example.com/p1.jpg");
});

test("R48 safe hiding works for any entry, leaves the feed", async () => {
  const kv = makeKV({ "ext:pending": { "p-1": { id: "p-1", title: "Real Film", type: "movie", tmdb: 4001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/4001" }], status: "pending", createdAt: 1 } } });
  const d = makeDO({ kv, catalogue: {}, realList: true });
  stubS3(d);
  const ap = await call(d, "/api/admin/pending/approve", { id: "p-1" });
  assert.equal(ap.status, 200);
  const liveId = ap.body.id;
  const hide = await call(d, "/api/admin/extpublish", { id: liveId, unlisted: true });
  assert.equal(hide.status, 200);
  assert.equal(catOf(d)[liveId].unlisted, true);
  const movies = await d.listMovies(d.env, {});
  assert.ok(!movies.some((m) => m.id === liveId), "a hidden entry leaves the feed");
  const legacy = seedLiveEntry({ id: "emv-leg", title: "Legacy", tmdb: 1009 });
  const d2 = makeDO({ kv: makeKV({ "ext:pending": {} }), catalogue: { "emv-leg": JSON.parse(JSON.stringify(legacy)) } });
  const hideLeg = await call(d2, "/api/admin/extpublish", { id: "emv-leg", unlisted: true });
  assert.equal(hideLeg.status, 200, "hiding a legacy entry (no pendingId) always works");
});

test("R49 safe deletion removes the entry, queue unchanged", async () => {
  const entry = seedLiveEntry();
  const kv = makeKV({ "ext:pending": { "p-keep": seedCand() } });
  const d = makeDO({ kv, catalogue: { "emv1": JSON.parse(JSON.stringify(entry)) } });
  const beforePend = kv._map.get("ext:pending");
  const del = await d.fetch(new Request("https://internal/api/admin/external?pw=pw123&id=emv1", { method: "DELETE" }));
  assert.equal(del.status, 200);
  assert.equal(catOf(d)["emv1"], undefined, "the entry is gone");
  assert.equal(kv._map.get("ext:pending"), beforePend, "the queue is byte-identical");
});

test("R50 duplicate submissions: live dup 409, force queues, meta title rules", async () => {
  const entry = seedLiveEntry();
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emv1": JSON.parse(JSON.stringify(entry)) }, realList: true });
  stubS3(d);
  // Converted POST duplicating a live entry: 409.
  const dup = await call(d, "/api/admin/external", { video_url: "https://example.com/v.mp4", title: "Live Movie One", type: "movie", tmdb: 1001 });
  assert.equal(dup.status, 409, "a submission duplicating a live entry is refused");
  assert.equal(dup.body.error, "duplicate");
  assert.deepEqual(catOf(d), { "emv1": entry }, "the catalogue is untouched");
  // With force: queued, not published.
  const forced = await call(d, "/api/admin/external", { video_url: "https://example.com/v.mp4", title: "Live Movie One", type: "movie", tmdb: 1001, force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.queued, true, "a forced duplicate is queued, never published");
  assert.equal(Object.keys(catOf(d)).length, 1, "still only the one live entry");
  // A meta title duplicating another live entry: 409 at approve.
  const d2 = makeDO({ kv: makeKV({ "ext:pending": {} }), catalogue: {
    "emv1": seedLiveEntry(),
    "emv2": seedLiveEntry({ id: "emv2", title: "Second Movie", tmdb: 1002, url: "https://example.com/2" }),
  } });
  const mp = await call(d2, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Second Movie" } });
  assert.equal(mp.status, 200, "proposing is allowed; the duplicate is caught at approve");
  const ap = await call(d2, "/api/admin/pending/approve", { id: mp.body.id });
  assert.equal(ap.status, 409);
  // A meta title matching only a queued candidate: allowed.
  const d3 = makeDO({ kv: makeKV({ "ext:pending": { "p-q": { id: "p-q", title: "Queued Only", type: "movie", tmdb: 5001, sources: [{ label: "S", url: "https://example.com/q.mp4" }], status: "pending", createdAt: 1 } } }), catalogue: { "emv1": seedLiveEntry() } });
  const mp3 = await call(d3, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Queued Only" } });
  assert.equal(mp3.status, 200);
  const ap3 = await call(d3, "/api/admin/pending/approve", { id: mp3.body.id });
  assert.equal(ap3.status, 200, "a title that only matches a queued candidate is not a duplicate");
  assert.equal(catOf(d3)["emv1"].title, "Queued Only");
});

test("R51 strict read failures + partial-write recovery in the meta flow", async () => {
  // (a) Meta-propose with a failing catalogue read: 500, byte-identical.
  {
    const kv = makeKV({ "ext:pending": {} });
    const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() }, failStoreGet: (k, n) => k === "ext:movies" && n === 1 });
    const before = catJSON(d);
    const beforePend = kv._map.get("ext:pending");
    const r = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "New" } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "stored data temporarily unreadable — try again");
    assert.equal(catJSON(d), before, "catalogue byte-identical");
    assert.equal(kv._map.get("ext:pending"), beforePend, "queue byte-identical");
  }
  // (b) Meta-approve with failing queue read, then failing catalogue read.
  {
    const kv = makeFailingKV({ "ext:pending": { "pm-1": seedMeta() } }, null, (k, n) => k === "ext:pending" && n === 1);
    const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
    const rQ = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(rQ.status, 500, "a failing queue read aborts the meta-approve");
    assert.equal(rQ.body.error, "stored data temporarily unreadable — try again");
    const kv2 = makeKV({ "ext:pending": { "pm-1": seedMeta() } });
    const d2 = makeDO({ kv: kv2, catalogue: { "emv1": seedLiveEntry() }, failStoreGet: (k, n) => k === "ext:movies" && n === 1 });
    const before2 = catJSON(d2);
    const rC = await call(d2, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(rC.status, 500, "a failing catalogue read aborts the meta-approve");
    assert.equal(rC.body.error, "stored data temporarily unreadable — try again");
    assert.equal(catJSON(d2), before2, "catalogue byte-identical");
    assert.ok((await kvObj(kv2, "ext:pending"))["pm-1"], "the proposal stays queued");
  }
  // (c) Catalogue save fails pre-commit: 500, proposal pending, retry works.
  {
    const kv = makeKV({ "ext:pending": { "pm-1": seedMeta() } });
    const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() }, failStorePut: (k, n) => k === "ext:movies" && n === 1 });
    const r1 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r1.status, 500, "a failed catalogue save aborts with 500");
    assert.equal(catOf(d)["emv1"].title, "Live Movie One", "nothing was applied");
    assert.ok((await kvObj(kv, "ext:pending"))["pm-1"], "the proposal stays queued");
    const d2 = makeDO({ kv, catalogue: catOf(d) });
    const r2 = await call(d2, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r2.status, 200, "retry with a healthy store succeeds");
    assert.equal(catOf(d2)["emv1"].title, "Renamed Movie One");
  }
  // (d) Commit-then-throw: the put lands, the caller sees 500, the retry
  // self-heals with already:true and does NOT refresh metaUpdatedAt.
  {
    const kv = makeKV({ "ext:pending": { "pm-1": seedMeta() } });
    const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() }, commitThrowPut: (k, n) => k === "ext:movies" && n === 1 });
    const r1 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r1.status, 500, "a put that throws after committing still reads as a failure to the caller");
    assert.equal(catOf(d)["emv1"].title, "Renamed Movie One", "the change DID land (ambiguous write)");
    assert.ok((await kvObj(kv, "ext:pending"))["pm-1"], "the proposal is still queued");
    const committedAt = catOf(d)["emv1"].metaUpdatedAt;
    assert.ok(committedAt, "metaUpdatedAt was set by the committed write");
    const r2 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.already, true, "the retry recognises the change is already applied");
    assert.equal(catOf(d)["emv1"].metaUpdatedAt, committedAt, "metaUpdatedAt is NOT refreshed on the self-heal");
    assert.equal((await kvObj(kv, "ext:pending"))["pm-1"], undefined, "the proposal is removed");
    assert.equal(catOf(d)["emv1"].title, "Renamed Movie One", "the entry is byte-identical to the committed state");
  }
  // (e) Queue save fails after the catalogue save: 200 + pendingCleanup,
  // change applied, proposal queued; retry clears it with already:true.
  {
    const kv = makeFailingKV({ "ext:pending": { "pm-1": seedMeta() } }, (k, n) => k === "ext:pending" && n === 1);
    const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
    const r1 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r1.status, 200, "the catalogue save succeeded, so the approve is 200");
    assert.equal(r1.body.pendingCleanup, "failed", "the queue cleanup failure is reported, not hidden");
    assert.equal(catOf(d)["emv1"].title, "Renamed Movie One", "the change applied");
    assert.ok((await kvObj(kv, "ext:pending"))["pm-1"], "the proposal is still queued");
    const r2 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.already, true);
    assert.equal((await kvObj(kv, "ext:pending"))["pm-1"], undefined, "the retry removed the proposal");
  }
  // (f) The retry's queue removal also fails: 200 + pendingCleanup again,
  // applied exactly once.
  {
    const kv = makeFailingKV({ "ext:pending": { "pm-1": seedMeta() } }, (k, n) => k === "ext:pending");
    const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
    const r1 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.pendingCleanup, "failed");
    const r2 = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.already, true, "the retry still self-heals");
    assert.equal(r2.body.pendingCleanup, "failed", "the retry reports the cleanup failure again");
    assert.equal(catOf(d)["emv1"].title, "Renamed Movie One", "applied exactly once");
    assert.ok((await kvObj(kv, "ext:pending"))["pm-1"], "the proposal is still queued after the failed cleanup");
  }
});

test("R52 meta records are excluded from discovery counts + publication totals", async () => {
  const kv = makeKV({
    "ext:pending": {},
    "ext:discovery:seen": {},
    "ext:discovery:state": { enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 45, approved: 0, rejected: 0 }, nextRunAt: null },
  });
  const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
  const beforeState = JSON.stringify(await stateOf(kv));
  // Queue a meta proposal: the publication count and totals do not move.
  const prop = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Counted? No" } });
  assert.equal(prop.status, 200);
  assert.equal(JSON.stringify(await stateOf(kv)), beforeState, "queueing a meta proposal touches no totals");
  const pend1 = await kvObj(kv, "ext:pending");
  assert.equal(Object.keys(pend1).filter((k) => !pend1[k].kind || pend1[k].kind === "entry").length, 0, "no publication candidate was created");
  // Approve it: totals still byte-identical.
  const ap = await call(d, "/api/admin/pending/approve", { id: prop.body.id });
  assert.equal(ap.status, 200);
  assert.equal(JSON.stringify(await stateOf(kv)), beforeState, "approving a meta proposal touches no totals");
  assert.deepEqual(await kvObj(kv, "ext:discovery:seen"), {}, "the seen-map is untouched by a meta approve");
  // Reject a meta proposal: totals still byte-identical.
  const prop2 = await call(d, "/api/admin/pending/meta", { targetId: "emv1", changes: { title: "Rejected Edit" } });
  assert.equal(prop2.status, 200);
  const rej = await call(d, "/api/admin/pending/reject", { id: prop2.body.id });
  assert.equal(rej.status, 200);
  assert.equal(JSON.stringify(await stateOf(kv)), beforeState, "rejecting a meta proposal touches no totals");
  assert.deepEqual(await kvObj(kv, "ext:discovery:seen"), {}, "the seen-map is untouched by a meta reject");
  // The full pre-existing suite stays green (checked by the runner).
});

test("R53 entries lookup is authenticated (403 without / wrong password)", async () => {
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
  const noPw = await callNoPw(d, "/api/admin/entries?q=Live", null, "GET");
  assert.equal(noPw.status, 403, "no password: 403");
  const wrong = await d.fetch(new Request("https://internal/api/admin/entries?q=Live&pw=wrong", { method: "GET" }));
  assert.equal(wrong.status, 403, "wrong password: 403");
  const ok = await callGetQ(d, "/api/admin/entries?q=Live");
  assert.equal(ok.status, 200, "correct password: 200");
  assert.equal(ok.body.entries.length, 1);
});

test("R54 lookup with a failing catalogue read is 500, not an empty list", async () => {
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() }, failStoreGet: (k, n) => k === "ext:movies" && n === 1 });
  const r = await callGetQ(d, "/api/admin/entries?q=Live");
  assert.equal(r.status, 500, "an unreadable catalogue is a 500, never a 200 with an empty list");
  assert.equal(r.body.error, "stored data temporarily unreadable — try again");
  assert.ok(!String(r.body.error || "").includes("store get boom"), "no raw storage error text to clients");
});

test("R55 lookup responses carry Cache-Control: no-store", async () => {
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
  const res = await callGetRaw(d, "/api/admin/entries?q=Live");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store", "the lookup must never be cached");
  const empty = await callGetRaw(d, "/api/admin/entries");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("Cache-Control"), "no-store");
});

test("R56 lookup sees unlisted entries; the public feed does not", async () => {
  const entries = {
    "emv1": seedLiveEntry(),
    "emv2": seedLiveEntry({ id: "emv2", title: "Hidden Gem", tmdb: 1002, url: "https://example.com/2", unlisted: true }),
  };
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: JSON.parse(JSON.stringify(entries)), realList: true });
  stubS3(d);
  const lookHidden = await callGetQ(d, "/api/admin/entries?q=Hidden");
  assert.equal(lookHidden.status, 200);
  assert.equal(lookHidden.body.entries.length, 1, "a query matching only the unlisted entry returns exactly it");
  assert.equal(lookHidden.body.entries[0].id, "emv2");
  assert.equal(lookHidden.body.entries[0].unlisted, true);
  const lookAll = await callGetQ(d, "/api/admin/entries?q=");
  assert.equal(lookAll.body.entries.length, 2, "an empty query returns all entries, listed and unlisted");
  const movies = await d.listMovies(d.env, {});
  assert.ok(movies.some((m) => m.id === "emv1"), "the listed entry is in the feed");
  assert.ok(!movies.some((m) => m.id === "emv2"), "the unlisted entry is absent from the feed");
});

test("R57 lookup field restrictions: exactly 7 fields, long query 400, 100 cap", async () => {
  const entries = {};
  for (let i = 1; i <= 105; i++) entries["emv" + i] = { id: "emv" + i, title: "Common Movie " + i, type: "movie", tmdb: 5000 + i, year: "2020", url: "https://example.com/" + i, poster: "https://example.com/p" + i + ".jpg", sources: [{ label: "S", url: "https://example.com/s" + i + ".mp4" }], unlisted: i % 2 === 0 };
  const kv = makeKV({ "ext:pending": {} });
  const d = makeDO({ kv, catalogue: entries });
  const r = await callGetQ(d, "/api/admin/entries?q=Common");
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 100, "at most 100 results even when 105 match");
  for (const e of r.body.entries) {
    assert.deepEqual(Object.keys(e).sort(), ["hasPendingId", "id", "poster", "title", "tmdb", "type", "unlisted"], "exactly the 7 allowed fields");
    assert.equal(e.sources, undefined, "no sources");
    assert.equal(e.url, undefined, "no playback URL");
    assert.equal(e.pendingId, undefined, "the raw pendingId is never returned");
  }
  const longQ = await callGetQ(d, "/api/admin/entries?q=" + "x".repeat(101));
  assert.equal(longQ.status, 400, "a query over 100 chars is 400");
  const exactQ = await callGetQ(d, "/api/admin/entries?q=" + "x".repeat(100));
  assert.equal(exactQ.status, 200, "a query of exactly 100 chars is allowed");
});

test("R58 stale-read protection: a meta-approve never loses an unrelated newer field", async () => {
  // The authoritative DO-storage catalogue holds entry E with overview
  // "New" (a newer unrelated field). A stale KV snapshot with overview
  // "Old" exists to prove the code no longer reads the catalogue from
  // KV: if any code path still read KV, the stale value would win.
  const authoritative = { "emv1": { ...seedLiveEntry(), overview: "New" } };
  const staleKv = { "emv1": { ...seedLiveEntry(), overview: "Old" } };
  const kv = makeKV({
    "ext:movies": staleKv,
    "ext:pending": { "pm-1": seedMeta() },
  });
  const d = makeDO({ kv, catalogue: JSON.parse(JSON.stringify(authoritative)) });
  const ap = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
  assert.equal(ap.status, 200);
  const after = catOf(d)["emv1"];
  assert.equal(after.title, "Renamed Movie One", "the proposed title applied");
  assert.equal(after.overview, "New", "the newer unrelated field survived — no stale write-back");
  assert.ok(after.metaUpdatedAt, "metaUpdatedAt is set");
  assert.equal((await kvObj(kv, "ext:pending"))["pm-1"], undefined, "the proposal is removed");
  assert.deepEqual(await kvObj(kv, "ext:movies"), staleKv, "the stale KV snapshot was never touched (it is not read)");
});

test("R59 concurrent same-entry change: only the proposed field changes", async () => {
  const kv = makeKV({ "ext:pending": { "pm-1": seedMeta() } });
  const d = makeDO({ kv, catalogue: { "emv1": seedLiveEntry() } });
  // Between propose and approve, the poster changes (a newer value).
  catOf(d)["emv1"].poster = "https://example.com/p-newer.jpg";
  const ap = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
  assert.equal(ap.status, 200, "a change to a different field does not stale the proposal");
  const after = catOf(d)["emv1"];
  assert.equal(after.title, "Renamed Movie One", "the proposed title applied");
  assert.equal(after.poster, "https://example.com/p-newer.jpg", "the newer poster survived untouched");
});

test("R60 cross-entry isolation: a meta-approve leaves other entries byte-identical", async () => {
  const entries = {
    "emv1": seedLiveEntry(),
    "emv2": seedLiveEntry({ id: "emv2", title: "Second Movie", tmdb: 1002, url: "https://example.com/2", poster: "https://example.com/p2.jpg", overview: "Second overview" }),
  };
  const kv = makeKV({ "ext:pending": { "pm-1": seedMeta() } });
  const d = makeDO({ kv, catalogue: JSON.parse(JSON.stringify(entries)) });
  const beforeB = JSON.stringify(catOf(d)["emv2"]);
  const ap = await call(d, "/api/admin/pending/approve", { id: "pm-1" });
  assert.equal(ap.status, 200);
  assert.equal(JSON.stringify(catOf(d)["emv2"]), beforeB, "entry B is byte-identical");
  assert.equal(catOf(d)["emv1"].title, "Renamed Movie One", "entry A changed as proposed");
});

// ---- Correction pass (2026-11-14, Redowan's independent review) ----
// R61–R63: the public catalogue read path fails closed (listMovies is
// strict in every path now — a missing or unreadable DO catalogue is a
// hard 500, never a silently R2-only feed). R64: freeze activation is
// serialized with the catalogue writers through _withAdminLock.
// R65–R67: a missing or malformed KV migration source hard-fails.

test("R61 public feed fails closed on a missing DO catalogue key (control: stored {} lists R2-only)", async () => {
  // Control: an explicitly stored {} is a legitimate empty catalogue.
  const kvC = makeKV({ "ext:pending": {} });
  const dC = makeDO({ kv: kvC, realList: true, catalogue: {} });
  stubS3(dC);
  const okMovies = await callGet(dC, "/api/movies");
  assert.equal(okMovies.status, 200, "control: a stored {} catalogue must list");
  assert.equal(okMovies.body.movies.length, 1, "control: R2-only feed has the one stubbed movie");
  assert.equal(okMovies.body.movies[0].title, "iron-man-2008-english");
  const okSite = await dC.fetch(new Request("https://internal/sitemap.xml", { method: "GET" }));
  assert.equal(okSite.status, 200, "control: sitemap lists with a stored {} catalogue");
  assert.ok((await okSite.text()).includes("iron-man-2008-english"), "control: sitemap contains the R2 movie");
  // Missing key: no catalogue seeded at all.
  const kvF = makeKV({ "ext:pending": {} });
  const dF = makeDO({ kv: kvF, realList: true }); // no `catalogue` option: unseeded
  stubS3(dF);
  const badMovies = await callGet(dF, "/api/movies");
  assert.equal(badMovies.status, 500, "an unseeded catalogue must fail /api/movies, not return an R2-only list");
  assert.equal(badMovies.body.movies, undefined, "no partial movies list on failure");
  const badSite = await dF.fetch(new Request("https://internal/sitemap.xml", { method: "GET" }));
  assert.equal(badSite.status, 500, "an unseeded catalogue must fail /sitemap.xml too");
  assert.equal(dF.state.storage._map.get("ext:movies"), undefined, "nothing was auto-seeded by the failed reads");
});

test("R62 public feed fails closed on a transient DO storage read failure", async () => {
  const live11 = seedLive11();
  // Control: healthy reads list R2 + all 11 ext entries.
  const kvC = makeKV({ "ext:pending": {} });
  const dC = makeDO({ kv: kvC, realList: true, catalogue: JSON.parse(JSON.stringify(live11)) });
  stubS3(dC);
  const ok = await callGet(dC, "/api/movies");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.movies.length, 12, "control: 1 R2 movie + 11 ext entries");
  // Every ext:movies read fails (the R2 meta: get is a different key
  // and is unaffected, so the failure under test is the catalogue read).
  const kvF = makeKV({ "ext:pending": {} });
  const dF = makeDO({ kv: kvF, realList: true, catalogue: JSON.parse(JSON.stringify(live11)), failStoreGet: (k) => k === "ext:movies" });
  stubS3(dF);
  const before = catJSON(dF);
  const bad = await callGet(dF, "/api/movies");
  assert.equal(bad.status, 500, "a transient catalogue read failure must fail /api/movies, not return an R2-only list");
  assert.equal(bad.body.movies, undefined, "no partial movies list on failure");
  const badSite = await dF.fetch(new Request("https://internal/sitemap.xml", { method: "GET" }));
  assert.equal(badSite.status, 500, "a transient catalogue read failure must fail /sitemap.xml too");
  assert.equal(catJSON(dF), before, "catalogue byte-identical after the failed reads");
});

test("R63 discovery run fails closed on a transient catalogue read failure", async () => {
  const base = {
    "ext:pending": {},
    "ext:discovery:seen": {},
    "ext:discovery:state": { enabled: true, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null },
  };
  globalThis.fetch = oneMovieFetch();
  // Control: healthy reads -> the one fresh title (1001, not live:
  // the catalogue here holds only Iron Man, tmdb 1726) is filed.
  const kvC = makeKV(JSON.parse(JSON.stringify(base)));
  const dC = makeDO({ kv: kvC, realList: true, catalogue: JSON.parse(JSON.stringify(ironLive)) });
  stubS3(dC);
  const runC = await dC.runDiscovery(dC.env, "manual");
  assert.equal(runC.status, "ok", "control run must succeed with these seeds");
  assert.equal(runC.counts.newCandidates, 1, "control: the fresh title is filed");
  // Failing catalogue read in the dedupe phase: the run must fail,
  // not dedupe blind against R2-only.
  const kvF = makeKV(JSON.parse(JSON.stringify(base)));
  const dF = makeDO({ kv: kvF, realList: true, catalogue: JSON.parse(JSON.stringify(ironLive)), failStoreGet: (k) => k === "ext:movies" });
  stubS3(dF);
  const runF = await dF.runDiscovery(dF.env, "manual");
  assert.equal(runF.status, "failed", "a run that cannot read the catalogue must fail, not run blind");
  assert.equal(runF.counts.newCandidates, 0, "nothing filed after a failed catalogue read");
  assert.equal(Object.keys(await kvObj(kvF, "ext:pending")).length, 0, "queue byte-identical — nothing filed");
  const st = await stateOf(kvF);
  assert.equal(st.lastRun.status, "failed", "failure recorded in lastRun");
});

test("R64 freeze waits for an in-flight catalogue writer: no write slips past the barrier", async () => {
  const live11 = seedLive11();
  const kv = makeKV({
    "ext:pending": { "p-1": { id: "p-1", title: "New Film", type: "movie", tmdb: 2001, year: "2026", sources: [{ label: "S1", url: "https://example.com/play/2001" }], status: "pending", createdAt: 1 } },
    "ext:discovery:seen": {},
    "ext:discovery:state": {},
  });
  // Hold the approve's catalogue put in flight for 100ms.
  const d = makeDO({ kv, live: liveListOf(live11), catalogue: live11, slowStorePut: (k) => k === "ext:movies", slowStorePutMs: 100 });
  const order = [];
  const approveP = call(d, "/api/admin/pending/approve", { id: "p-1" }).then((r) => { order.push("approve"); return r; });
  const freezeP = call(d, "/api/admin/catalogue-freeze", { frozen: true }).then((r) => { order.push("freeze"); return r; });
  let freezeDone = false;
  freezeP.then(() => { freezeDone = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(freezeDone, false, "the freeze must not return while a catalogue writer is still in flight");
  const approveR = await approveP;
  const freezeR = await freezeP;
  assert.deepEqual(order, ["approve", "freeze"], "the writer completes before freeze activation returns");
  assert.equal(approveR.status, 200, "the in-flight approve completes");
  assert.equal(freezeR.status, 200, "the freeze then succeeds");
  assert.equal(freezeR.body.frozen, true);
  assert.equal(Object.keys(catOf(d)).length, 12, "the writer's entry landed before the freeze");
  const published = Object.values(catOf(d)).find((e) => e.pendingId === "p-1");
  assert.ok(published, "the writer's entry is in the catalogue");
  assert.equal(published.title, "New Film");
  assert.equal(approveR.body.id, published.id, "approve returned the new live id");
  const get = await callGet(d, "/api/admin/catalogue-freeze");
  assert.equal(get.body.frozen, true, "the flag reads back as set");
  // A later writer is blocked by the barrier.
  const blocked = await call(d, "/api/admin/extpublish", { id: "emv1", unlisted: true });
  assert.equal(blocked.status, 503, "a catalogue write after the freeze must be blocked");
  assert.equal(blocked.body.error, FROZEN_MSG);
  assert.equal(Object.keys(catOf(d)).length, 12, "the blocked write changed nothing");
});

test("R65 migration with a missing KV source hard-fails: 500, nothing seeded", async () => {
  const kv = makeKV({ "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} }); // no "ext:movies" key at all
  const d = makeDO({ kv });
  const set = await call(d, "/api/admin/catalogue-freeze", { frozen: true });
  assert.equal(set.status, 200);
  const mig = await call(d, "/api/admin/catalogue-migrate", {});
  assert.equal(mig.status, 500, "a missing migration source must hard-fail, not seed an empty catalogue");
  assert.equal(mig.body.error, "migration source missing — KV ext:movies not found");
  assert.equal(d.state.storage._map.get("ext:movies"), undefined, "nothing seeded on a missing source");
});

test("R66 migration with a malformed KV source hard-fails: 500, nothing seeded", async () => {
  async function tryMigrate(source, raw) {
    const kv = makeKV({ "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} });
    if (raw !== undefined) kv._map.set("ext:movies", raw);
    else if (source !== undefined) kv._map.set("ext:movies", JSON.stringify(source));
    const d = makeDO({ kv });
    await call(d, "/api/admin/catalogue-freeze", { frozen: true });
    const mig = await call(d, "/api/admin/catalogue-migrate", {});
    return { mig, d };
  }
  // (a) Invalid JSON: the KV json read itself throws.
  const bad = await tryMigrate(undefined, "{not valid json");
  assert.equal(bad.mig.status, 500, "an invalid-JSON source must hard-fail");
  assert.equal(bad.mig.body.error, "stored data temporarily unreadable — try again", "an unreadable source gets the generic message");
  assert.equal(bad.d.state.storage._map.get("ext:movies"), undefined, "nothing seeded on invalid JSON");
  // (b) Valid JSON, wrong shape: an array is not a catalogue object.
  const arr = await tryMigrate([1, 2, 3]);
  assert.equal(arr.mig.status, 500, "an array source must hard-fail");
  assert.equal(arr.mig.body.error, "migration source malformed — KV ext:movies is not a catalogue object");
  assert.equal(arr.d.state.storage._map.get("ext:movies"), undefined, "nothing seeded on an array source");
  // (c) Valid JSON, wrong shape: a string is not a catalogue object.
  const str = await tryMigrate("hello");
  assert.equal(str.mig.status, 500, "a string source must hard-fail");
  assert.equal(str.mig.body.error, "migration source malformed — KV ext:movies is not a catalogue object");
  assert.equal(str.d.state.storage._map.get("ext:movies"), undefined, "nothing seeded on a string source");
});

test("R67 valid KV sources still migrate: 11 entries and an explicitly stored empty catalogue", async () => {
  // (a) The normal case: 11 entries.
  const live11 = seedLive11();
  const kvA = makeKV({ "ext:movies": live11, "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} });
  const dA = makeDO({ kv: kvA });
  await call(dA, "/api/admin/catalogue-freeze", { frozen: true });
  const expectedHash = createHash("sha256").update(JSON.stringify(live11)).digest("hex");
  const migA = await call(dA, "/api/admin/catalogue-migrate", {});
  assert.equal(migA.status, 200, "a valid source must still migrate");
  assert.equal(migA.body.count, 11);
  assert.equal(migA.body.sha256, expectedHash);
  assert.equal(migA.body.verified, true);
  assert.deepEqual(dA.state.storage._map.get("ext:movies"), live11);
  // (b) The boundary case: an explicitly stored {} is a present value
  // and migrates as an empty catalogue (count 0) — distinct from a
  // missing key, which hard-fails (R65).
  const kvB = makeKV({ "ext:movies": {}, "ext:pending": {}, "ext:discovery:seen": {}, "ext:discovery:state": {} });
  const dB = makeDO({ kv: kvB });
  await call(dB, "/api/admin/catalogue-freeze", { frozen: true });
  const migB = await call(dB, "/api/admin/catalogue-migrate", {});
  assert.equal(migB.status, 200, "an explicitly stored empty catalogue must migrate");
  assert.equal(migB.body.count, 0);
  assert.equal(migB.body.verified, true);
  assert.deepEqual(dB.state.storage._map.get("ext:movies"), {});
});
