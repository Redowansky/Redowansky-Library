#!/usr/bin/env python3
"""Phase 2a build: automated discovery (TMDB) into worker.js.

Edits (all anchored on exact strings; aborts if an anchor is missing or
appears more than once):
 1. Discovery state/seen helpers + candidate builder after savePending.
 2. runDiscovery() DO method after listMovies().
 3. Internal + admin discovery routes before the password route.
 4. Seen-status updates in approve (both paths), reject, delete.
 5. Admin nav button + s-discovery section + nav handler.
 6. Admin discovery JS (load/save/run/render) + renderPend detail extras.
 7. TMDB attribution in the home footer.
 8. scheduled() handler in the outer export (cron entry point).
"""
import sys

P = "/home/hatch/workspace/sia-lab/worker.js"
src = open(P, encoding="utf-8").read()

def rep(old, new, count=1):
    global src
    n = src.count(old)
    assert n == count, f"anchor count {n} (want {count}): {old[:90]!r}"
    src = src.replace(old, new)

# ---------------------------------------------------------------- 1. helpers
rep('''async function savePending(env, obj){
  await env.DATA_KV.put("ext:pending", JSON.stringify(obj));
}''', '''async function savePending(env, obj){
  await env.DATA_KV.put("ext:pending", JSON.stringify(obj));
}
// ---- Automated discovery (Phase 2a) ----
// Two new DATA_KV keys, both additive — no migration, no existing key
// changes shape:
//  * "ext:discovery:state" — config + last-run record + totals.
//  * "ext:discovery:seen"  — map "type:tmdbId" -> {type, tmdb, title,
//    firstSeen, lastSeen, status}. Stops the same title being filed
//    again on every run. Statuses: pending | approved | rejected |
//    live-dup | skipped. Entries in a terminal status older than 180
//    days are pruned (TMDB terms forbid caching its data longer).
function defaultDiscoveryState(){
  return { enabled: false, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null };
}
async function getDiscoveryState(env){
  try {
    const s = await env.DATA_KV.get("ext:discovery:state", "json");
    if (s && typeof s === "object") {
      const d = defaultDiscoveryState();
      return { ...d, ...s, sources: { ...d.sources, ...(s.sources || {}) }, budget: { ...d.budget, ...(s.budget || {}) }, totals: { ...d.totals, ...(s.totals || {}) } };
    }
  } catch (e) {}
  return defaultDiscoveryState();
}
async function saveDiscoveryState(env, obj){
  await env.DATA_KV.put("ext:discovery:state", JSON.stringify(obj));
}
async function getSeen(env){
  try { return await env.DATA_KV.get("ext:discovery:seen", "json") || {}; } catch (e) { return {}; }
}
async function saveSeen(env, obj){
  await env.DATA_KV.put("ext:discovery:seen", JSON.stringify(obj));
}
function nextRunAtFor(freq, fromMs){
  const days = freq === "weekly" ? 7 : freq === "every2days" ? 2 : 1;
  return new Date(fromMs + days * 864e5).toISOString();
}
function pruneSeen(seen, nowMs){
  const cutoff = nowMs - 180 * 864e5;
  for (const k in seen) {
    const e = seen[k];
    const terminal = e && (e.status === "live-dup" || e.status === "skipped" || e.status === "rejected" || e.status === "approved");
    const first = e && e.firstSeen ? Date.parse(e.firstSeen + "T00:00:00Z") : NaN;
    if (terminal && !isNaN(first) && first < cutoff) delete seen[k];
  }
}
// Record a candidate's fate in the seen-map. Never throws — a seen
// bookkeeping failure must never fail an approve/reject/delete.
async function markSeen(env, cand, status){
  try {
    if (!cand || cand.tmdb == null) return;
    const seen = await getSeen(env);
    const k = (cand.type || "movie") + ":" + cand.tmdb;
    const prev = seen[k] || { type: cand.type || "movie", tmdb: cand.tmdb, title: cand.title || "", firstSeen: new Date().toISOString().slice(0, 10) };
    prev.status = status;
    prev.lastSeen = new Date().toISOString().slice(0, 10);
    if (cand.title) prev.title = cand.title;
    seen[k] = prev;
    await saveSeen(env, seen);
  } catch (e) {}
}
async function bumpDiscoveryTotal(env, field){
  try {
    const s = await getDiscoveryState(env);
    s.totals[field] = (s.totals[field] || 0) + 1;
    await saveDiscoveryState(env, s);
  } catch (e) {}
}
// Compact watch-provider data (BD + US, flatrate only, top 3 each).
// Links only — never playback. A missing/failed lookup yields null.
function providersCompact(results){
  const out = {};
  for (const region of ["BD", "US"]) {
    const r = results[region];
    if (!r || !Array.isArray(r.flatrate)) continue;
    const names = r.flatrate.slice(0, 3).map(function(p){ return p.provider_name; }).filter(Boolean);
    if (names.length) out[region] = names;
  }
  return Object.keys(out).length ? out : null;
}
// Build a queue candidate from a TMDB detail response. Metadata only:
// sources stay empty and needsSource stays true until a playback source
// is attached — approval still requires >= 1 source (Phase 1 rule).
function discoveryCandidateFromTmdb(w, d, runAt, providers){
  const isMovie = w.type === "movie";
  const title = ((isMovie ? d.title : d.name) || "").toString().trim();
  if (!title) return null;
  const date = (isMovie ? d.release_date : d.first_air_date) || "";
  return {
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title.slice(0, 200), type: w.type, tmdb: w.tmdb, sources: [],
    discoveredVia: w.via, discoveredAt: runAt, discoveryRun: runAt,
    needsSource: true,
    note: "Auto-discovered via TMDB (" + w.via + "). No playback source attached yet.",
    status: "pending", createdAt: Date.now(),
    year: date ? date.slice(0, 4) : null,
    overview: d.overview || null,
    poster: cleanImgUrl(d.poster_path), backdrop: cleanImgUrl(d.backdrop_path),
    vote: d.vote_average != null ? Number(d.vote_average).toFixed(1) : null,
    genres: Array.isArray(d.genres) ? d.genres.map(function(g){ return g.name; }).slice(0, 10) : [],
    providers: providers || null
  };
}''')

# ------------------------------------------------------- 2. runDiscovery
rep('''    for (const id in extObj) { if (extObj[id].unlisted) continue; movies.push({ ...extObj[id], external: true }); }
    } catch (e) {}
    return movies;
  }''', '''    for (const id in extObj) { if (extObj[id].unlisted) continue; movies.push({ ...extObj[id], external: true }); }
    } catch (e) {}
    return movies;
  }

  // ---- Automated discovery (Phase 2a) ----
  // One run: fetch TMDB list endpoints (date-windowed discover + trending),
  // drop anything already seen or already live/pending/rejected, fetch full
  // metadata for the genuinely new titles (budget-capped), and batch-write
  // the new candidates into ext:pending. Never publishes, never deletes,
  // never touches ext:movies or R2. Every step is idempotent: running twice
  // files nothing twice. Each list/detail call is individually try/caught —
  // one dead endpoint counts as failed, never aborts the run.
  // Budgets keep one invocation inside the free tier's 50-subrequest cap:
  // ~5 list calls + <= maxDetailCalls detail/provider calls.
  async runDiscovery(env, trigger) {
    const started = Date.now();
    const runAt = new Date(started).toISOString();
    const counts = { fetched: 0, newCandidates: 0, duplicates: 0, skipped: 0, failed: 0 };
    const state = await getDiscoveryState(env);
    const finish = async (status, error) => {
      state.lastRun = { at: runAt, trigger, status, counts, durationMs: Date.now() - started, error: error || null };
      state.nextRunAt = nextRunAtFor(state.frequency, started);
      await saveDiscoveryState(env, state);
      return state.lastRun;
    };
    if (this._discoveryRunning) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "a run is already in progress" };
    if (trigger === "cron") {
      if (!state.enabled) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "discovery disabled" };
      if (state.nextRunAt && started < Date.parse(state.nextRunAt)) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "not due yet" };
    }
    const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
    if (!apiKey) return finish("failed", "no TMDB key");
    this._discoveryRunning = true;
    try {
      const ymd = (d) => d.toISOString().slice(0, 10);
      const lastDate = state.lastRun && state.lastRun.at ? state.lastRun.at.slice(0, 10) : ymd(new Date(started - 7 * 864e5));
      const from = ymd(new Date(Date.parse(lastDate + "T00:00:00Z") - 864e5));
      const to = ymd(new Date(started));
      const lists = [];
      if (state.sources.tmdb) {
        lists.push({ via: "tmdb-discover", type: "movie", path: "/discover/movie?primary_release_date.gte=" + from + "&primary_release_date.lte=" + to + "&sort_by=primary_release_date.desc&page=1" });
        lists.push({ via: "tmdb-discover", type: "tv", path: "/discover/tv?first_air_date.gte=" + from + "&first_air_date.lte=" + to + "&sort_by=first_air_date.desc&page=1" });
      }
      if (state.sources.trending) {
        lists.push({ via: "tmdb-trending", type: "movie", path: "/trending/movie/week?page=1" });
        lists.push({ via: "tmdb-trending", type: "tv", path: "/trending/tv/week?page=1" });
      }
      if (state.sources.upcoming) lists.push({ via: "tmdb-upcoming", type: "movie", path: "/movie/upcoming?page=1" });
      const seen = await getSeen(env);
      const pend = await getPending(env);
      const liveList = await this.listMovies(env);
      const wanted = new Map();
      for (const L of lists) {
        let data = null;
        try { data = await tmdbGet(L.path, apiKey); } catch (e) { data = null; }
        if (!data || !Array.isArray(data.results)) { counts.failed++; continue; }
        for (const r of data.results) {
          counts.fetched++;
          const tmdb = r.id;
          if (tmdb == null) { counts.skipped++; continue; }
          const key = L.type + ":" + tmdb;
          if (wanted.has(key)) continue;
          const s = seen[key];
          if (s && (s.status === "pending" || s.status === "approved" || s.status === "rejected" || s.status === "live-dup" || s.status === "skipped")) { counts.duplicates++; continue; }
          wanted.set(key, { tmdb, type: L.type, via: L.via });
        }
      }
      // Second pass: duplicate check against live + queue (covers titles
      // the seen-map does not know yet, e.g. manually added entries).
      // The probe carries the TMDB id, so the id match is what matters.
      const fresh = [];
      const liveDup = [];
      for (const w of wanted.values()) {
        const dup = findDuplicate({ title: "", tmdb: w.tmdb, year: "" }, liveList, pend, null);
        if (dup) { counts.duplicates++; liveDup.push({ type: w.type, tmdb: w.tmdb, title: dup.title || "" }); continue; }
        fresh.push(w);
      }
      const budget = Math.max(1, Math.min(30, state.budget.maxNewPerRun || 15));
      const detailBudget = Math.max(budget, Math.min(40, state.budget.maxDetailCalls || 30));
      const toFile = fresh.slice(0, budget);
      const newCands = [];
      let detailCalls = 0;
      for (const w of toFile) {
        if (detailCalls >= detailBudget) break;
        let d = null;
        try { detailCalls++; d = await tmdbGet("/" + w.type + "/" + w.tmdb, apiKey); } catch (e) { d = null; }
        if (!d) { counts.failed++; continue; }
        let providers = null;
        try {
          detailCalls++;
          const wp = await tmdbGet("/" + w.type + "/" + w.tmdb + "/watch/providers", apiKey);
          if (wp && wp.results) providers = providersCompact(wp.results);
        } catch (e) {}
        const cand = discoveryCandidateFromTmdb(w, d, runAt, providers);
        if (!cand) { counts.skipped++; continue; }
        newCands.push(cand);
      }
      // Titles beyond the budget are NOT marked seen, so the next run
      // finds them again — nothing is lost, the queue just stays reviewable.
      counts.newCandidates = newCands.length;
      counts.skipped += Math.max(0, fresh.length - toFile.length);
      // Batch writes inside the admin lock so a concurrent admin action
      // cannot clobber the queue update. Seen is re-read inside the lock
      // (an approve/reject mid-run must not be overwritten).
      await this._withAdminLock(async () => {
        const pendNow = await getPending(env);
        for (const c of newCands) pendNow[c.id] = c;
        await savePending(env, pendNow);
        const seenNow = await getSeen(env);
        for (const c of newCands) { const k = c.type + ":" + c.tmdb; seenNow[k] = { type: c.type, tmdb: c.tmdb, title: c.title, firstSeen: runAt.slice(0, 10), lastSeen: runAt.slice(0, 10), status: "pending" }; }
        for (const ld of liveDup) { const k = ld.type + ":" + ld.tmdb; const prev = seenNow[k] || { type: ld.type, tmdb: ld.tmdb, title: ld.title, firstSeen: runAt.slice(0, 10) }; prev.status = "live-dup"; prev.lastSeen = runAt.slice(0, 10); if (ld.title) prev.title = ld.title; seenNow[k] = prev; }
        pruneSeen(seenNow, started);
        await saveSeen(env, seenNow);
        state.totals.discovered = (state.totals.discovered || 0) + newCands.length;
      });
      return finish("ok", null);
    } catch (e) {
      return finish("failed", String((e && e.message) || e));
    } finally {
      this._discoveryRunning = false;
    }
  }''')

# ------------------------------------------------------------- 3. routes
rep('''      // Admin: change password (stored in DO storage, survives deploys)''', '''      // Internal: cron entry point for automated discovery. NOT an admin
      // route — the Cron Trigger calls it with a shared secret header.
      // No secret configured = discovery disabled, fail closed.
      if (path === "/api/internal/discovery/run" && request.method === "POST") {
        const secret = env.DISCOVERY_CRON_SECRET;
        if (!secret || request.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);
        const run = await this.runDiscovery(env, "cron");
        return json({ ok: true, run });
      }
      // Admin: discovery state (config + last run + totals).
      if (path === "/api/admin/discovery/state" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        return json({ ok: true, state: await getDiscoveryState(env) });
      }
      // Admin: run discovery now. Manual runs ignore the enabled flag and
      // the frequency schedule (it is an explicit admin action) but respect
      // the same per-run budget as a cron run.
      if (path === "/api/admin/discovery/run" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const run = await this.runDiscovery(env, "manual");
        return json({ ok: run.status === "ok", run });
      }
      // Admin: discovery config. Values are validated and clamped;
      // unknown keys are ignored.
      if (path === "/api/admin/discovery/config" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const cur = await getDiscoveryState(env);
        if (typeof body.enabled === "boolean") cur.enabled = body.enabled;
        if (["daily", "every2days", "weekly"].includes(body.frequency)) cur.frequency = body.frequency;
        if (body.sources && typeof body.sources === "object") {
          for (const k of ["tmdb", "trending", "upcoming", "tvmaze"]) if (typeof body.sources[k] === "boolean") cur.sources[k] = body.sources[k];
        }
        if (body.budget && typeof body.budget === "object") {
          if (Number.isFinite(+body.budget.maxNewPerRun)) cur.budget.maxNewPerRun = Math.max(1, Math.min(30, Math.round(+body.budget.maxNewPerRun)));
          if (Number.isFinite(+body.budget.maxDetailCalls)) cur.budget.maxDetailCalls = Math.max(1, Math.min(40, Math.round(+body.budget.maxDetailCalls)));
        }
        if (cur.enabled && !cur.nextRunAt) cur.nextRunAt = new Date(Date.now()).toISOString();
        await saveDiscoveryState(env, cur);
        return json({ ok: true, state: cur });
      }
      // Admin: change password (stored in DO storage, survives deploys)''')

# ------------------------------------------- 4. seen updates on fate
rep('''            delete pend[id];
            let cleanupOk = true;
            try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
            return json({ ok: true, id: k, title: extObjPre[k].title, already: true, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });''', '''            delete pend[id];
            let cleanupOk = true;
            try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
            await markSeen(env, cand, "approved");
            await bumpDiscoveryTotal(env, "approved");
            return json({ ok: true, id: k, title: extObjPre[k].title, already: true, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });''')
rep('''          await saveExtMovies(env, extObj);
          delete pend[id];
          let cleanupOk = true;
          try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
          return json({ ok: true, id: liveId, title: cand.title, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });''', '''          await saveExtMovies(env, extObj);
          delete pend[id];
          let cleanupOk = true;
          try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
          await markSeen(env, cand, "approved");
          await bumpDiscoveryTotal(env, "approved");
          return json({ ok: true, id: liveId, title: cand.title, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });''')
rep('''          cand.status = "rejected";
          cand.rejectedAt = Date.now();
          await savePending(env, pend);
          return json({ ok: true, id, status: "rejected" });''', '''          cand.status = "rejected";
          cand.rejectedAt = Date.now();
          await savePending(env, pend);
          await markSeen(env, cand, "rejected");
          await bumpDiscoveryTotal(env, "rejected");
          return json({ ok: true, id, status: "rejected" });''')
rep('''          const pend = await getPending(env);
          if (!pend[id]) return json({ error: "not found" }, 404);
          delete pend[id];
          await savePending(env, pend);
          return json({ ok: true, id });''', '''          const pend = await getPending(env);
          if (!pend[id]) return json({ error: "not found" }, 404);
          const gone = pend[id];
          delete pend[id];
          await savePending(env, pend);
          // Deleted candidates are marked "skipped" in the seen-map so
          // discovery does not re-file them; a manual re-add still works
          // (the add form checks live + queue only, not the seen-map).
          await markSeen(env, gone, "skipped");
          return json({ ok: true, id });''')

# ------------------------------------------------------- 5. admin nav
rep('''<button data-s="pending">⏳ <span>Approval Queue</span></button>''', '''<button data-s="pending">⏳ <span>Approval Queue</span></button>
<button data-s="discovery">🔭 <span>Discovery</span></button>''')

# ------------------------------------------------- 5b. discovery section
rep('''<!-- SETTINGS -->''', '''<!-- DISCOVERY -->
<div class="sec" id="s-discovery">
<h1>🔭 Discovery</h1><p class="desc">Automated discovery finds new movies and TV on TMDB and files them into the Approval Queue. Nothing ever publishes on its own — every candidate still waits for your approval.</p>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<label style="display:flex;gap:10px;align-items:center;font-size:1rem;cursor:pointer"><input type="checkbox" id="discEnabled" style="accent-color:#1e5a34;width:18px;height:18px"> Enable automated discovery</label>
<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
<select id="discFreq" style="background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px"><option value="daily">Daily</option><option value="every2days">Every 2 days</option><option value="weekly">Weekly</option></select>
<input id="discBudget" type="number" min="1" max="30" value="15" style="width:110px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px" title="Max new candidates per run">
</div>
<div style="margin-top:12px;line-height:2">
<label style="cursor:pointer"><input type="checkbox" id="discSrcTmdb" checked style="accent-color:#1e5a34"> New releases</label><br>
<label style="cursor:pointer"><input type="checkbox" id="discSrcTrending" checked style="accent-color:#1e5a34"> Trending / popular</label><br>
<label style="cursor:pointer"><input type="checkbox" id="discSrcUpcoming" style="accent-color:#1e5a34"> Upcoming movies (unreleased)</label><br>
<label style="cursor:pointer"><input type="checkbox" id="discSrcTvmaze" disabled style="accent-color:#1e5a34"> TVMaze episode data (Phase 2b — not yet)</label>
</div>
<div style="display:flex;gap:10px;align-items:center;margin-top:12px">
<button class="btn" onclick="saveDiscovery()">Save settings</button>
<button class="btn" onclick="runDiscoveryNow()">▶ Run now</button>
<span id="discMsg" style="font-size:.85rem"></span>
</div>
</div>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<h4 style="margin-bottom:8px">🕐 Last run</h4>
<div id="discLast" style="font-size:.9rem;line-height:1.7;color:#b8d8c0">No runs yet.</div>
<div id="discTotals" style="font-size:.85rem;color:#7a9a85;margin-top:8px"></div>
</div>
</div>
<!-- SETTINGS -->''')

# ------------------------------------------------------- 5c. nav handler
rep('''if(b.dataset.s==="pending")loadPending();});''', '''if(b.dataset.s==="pending")loadPending();if(b.dataset.s==="discovery")loadDiscovery();});''')

# ---------------------------------------------------------- 6. admin JS
rep('''async function deletePending(btn){const id=btn.dataset.id;
  if(!confirm("Delete this candidate permanently?"))return;
  const r=await api("/api/admin/pending/delete?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  if(r.ok)loadPending();else alert("✗ failed");
}
// login''', '''async function deletePending(btn){const id=btn.dataset.id;
  if(!confirm("Delete this candidate permanently?"))return;
  const r=await api("/api/admin/pending/delete?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  if(r.ok)loadPending();else alert("✗ failed");
}
// ---- Automated discovery (Phase 2a) ----
function provLine(p){var parts=[];for(var r in p){parts.push(pendEsc(r)+": "+p[r].map(function(n){return pendEsc(n);}).join(", "));}return parts.length?"<b>Where to watch:</b> "+parts.join(" · "):"";}
async function loadDiscovery(){
  const last=document.getElementById("discLast"); if(!last)return;
  const r=await api("/api/admin/discovery/state?pw="+encodeURIComponent(pw()));
  const d=await r.json().catch(()=>({}));
  if(!r.ok){last.textContent="Could not load discovery state.";return;}
  const s=d.state||{};
  document.getElementById("discEnabled").checked=!!s.enabled;
  document.getElementById("discFreq").value=s.frequency||"daily";
  document.getElementById("discBudget").value=(s.budget&&s.budget.maxNewPerRun)||15;
  document.getElementById("discSrcTmdb").checked=!!(s.sources&&s.sources.tmdb);
  document.getElementById("discSrcTrending").checked=!!(s.sources&&s.sources.trending);
  document.getElementById("discSrcUpcoming").checked=!!(s.sources&&s.sources.upcoming);
  renderDiscovery(s);
}
function renderDiscovery(s){
  const last=s.lastRun;
  const box=document.getElementById("discLast");
  if(!last){box.textContent="No runs yet.";}
  else{
    const c=last.counts||{};
    box.innerHTML="<div><b>"+pendEsc(last.status||"")+"</b> · "+new Date(last.at||0).toLocaleString()+" · via "+pendEsc(last.trigger||"")+"</div>"
      +"<div>Fetched "+(c.fetched||0)+" · new candidates "+(c.newCandidates||0)+" · duplicates "+(c.duplicates||0)+" · skipped "+(c.skipped||0)+" · failed "+(c.failed||0)+" · "+(last.durationMs||0)+"ms</div>"
      +(last.error?"<div style='color:#ff9a9a'>"+pendEsc(last.error)+"</div>":"");
  }
  const t=s.totals||{};
  document.getElementById("discTotals").textContent="Totals — discovered "+(t.discovered||0)+" · approved "+(t.approved||0)+" · rejected "+(t.rejected||0)+(s.nextRunAt?" · next run "+new Date(s.nextRunAt).toLocaleString():"");
}
async function saveDiscovery(){
  const msg=document.getElementById("discMsg");
  const body={enabled:document.getElementById("discEnabled").checked,frequency:document.getElementById("discFreq").value,sources:{tmdb:document.getElementById("discSrcTmdb").checked,trending:document.getElementById("discSrcTrending").checked,upcoming:document.getElementById("discSrcUpcoming").checked,tvmaze:false},budget:{maxNewPerRun:parseInt(document.getElementById("discBudget").value,10)||15}};
  msg.textContent="saving…";
  const r=await api("/api/admin/discovery/config?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(r.ok){msg.innerHTML='<span class="ok">✓ saved</span>';renderDiscovery(d.state||{});}
  else msg.innerHTML='<span class="bad">✗ '+(d.error||"failed")+'</span>';
}
async function runDiscoveryNow(){
  const msg=document.getElementById("discMsg");
  msg.textContent="running discovery…";
  const r=await api("/api/admin/discovery/run?pw="+encodeURIComponent(pw()),{method:"POST"});
  const d=await r.json().catch(()=>({}));
  if(r.ok||d.run){msg.innerHTML='<span class="ok">✓ run finished: '+(d.run&&d.run.counts?d.run.counts.newCandidates:0)+' new candidates</span>';loadDiscovery();loadPending();}
  else msg.innerHTML='<span class="bad">✗ '+(d.error||"failed")+'</span>';
}
// login''')

# --------------------------------------- 6b. renderPend detail extras
rep('''+"<div><b>TMDB:</b> "+pendEsc(c.tmdb||"—")+" · <b>Type:</b> "+pendEsc(c.type)+" · <b>Found via:</b> "+pendEsc(c.discoveredVia||"—")+" · "+new Date(c.createdAt||0).toLocaleString()+"</div>"''', '''+"<div><b>TMDB:</b> "+pendEsc(c.tmdb||"—")+" · <b>Type:</b> "+pendEsc(c.type)+" · <b>Found via:</b> "+pendEsc(c.discoveredVia||"—")+" · "+new Date(c.createdAt||0).toLocaleString()+(c.discoveredAt?" · discovered "+new Date(c.discoveredAt).toLocaleString():"")+"</div>"
      +(c.providers?"<div style='margin-top:6px'>"+provLine(c.providers)+"</div>":"")''')
rep('''+" · "+(c.sources||[]).length+" source"+((c.sources||[]).length===1?"":"s")+"</span></span>''', '''+" · "+(c.sources||[]).length+" source"+((c.sources||[]).length===1?"":"s")+(c.needsSource?" · <span style='color:#ffb74d'>needs a playback source</span>":"")+"</span></span>''')

# ------------------------------------------------- 7. TMDB attribution
rep('''<footer style="text-align:center;padding:28px 12px 36px;color:#5f7a68;font-size:.85rem">👀 __VIEWS_TODAY__ viewers today</footer>''', '''<footer style="text-align:center;padding:28px 12px 36px;color:#5f7a68;font-size:.85rem">👀 __VIEWS_TODAY__ viewers today<br><span style="font-size:.75rem">Movie &amp; TV data by <a href="https://www.themoviedb.org/" target="_blank" rel="noopener" style="color:#5f7a68">TMDB</a> <img src="https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg" alt="TMDB" style="height:12px;vertical-align:-2px"> — This product uses the TMDB API but is not endorsed or certified by TMDB.</span></footer>''')

# ------------------------------------------------ 8. scheduled handler
rep('''export default {
  async fetch(req, env) {
    // DO NOT rename the string below. idFromName() maps each unique name to a
    // FRESH, EMPTY Durable Object — renaming wipes admin_pw, tmdb_key, meta:*
    // on every deploy. This name is frozen; all settings now survive updates.
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName("main-v35"));
    return stub.fetch(req);
  },
};''', '''export default {
  async fetch(req, env) {
    // DO NOT rename the string below. idFromName() maps each unique name to a
    // FRESH, EMPTY Durable Object — renaming wipes admin_pw, tmdb_key, meta:*
    // on every deploy. This name is frozen; all settings now survive updates.
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName("main-v35"));
    return stub.fetch(req);
  },
  // Cron Trigger entry point for automated discovery (Phase 2a). The
  // trigger itself is the auth — scheduled() is never reachable by HTTP.
  // The TMDB key lives in DO storage, so the handler forwards to the DO
  // internal route with the shared cron secret; the DO rejects the call
  // unless the secret matches env.DISCOVERY_CRON_SECRET (unset = disabled).
  async scheduled(event, env, ctx) {
    const secret = env.DISCOVERY_CRON_SECRET;
    if (!secret) return;
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName("main-v35"));
    ctx.waitUntil(stub.fetch(new Request("https://internal/api/internal/discovery/run", { method: "POST", headers: { "x-cron-secret": secret } })).then(async (r) => { await r.text(); }).catch(() => {}));
  },
};''')

open(P, "w", encoding="utf-8").write(src)
print("edits applied OK, new size:", len(src))
