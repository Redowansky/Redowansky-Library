#!/usr/bin/env python3
"""Build the approved Phase 2a hardening plan (2026-11-13).

- POST /api/admin/pending/sources: edit a pending candidate's playback
  sources (all-or-nothing, same validation as intake/approve).
- runDiscovery: record popularity on filed candidates + per-source fetched
  counts (bySource); record lastSuccess; overlap flag set synchronously
  before the first await; batch lock re-checks seen/queue before filing.
- Admin UI: Sources editor in the Inspect panel, Approve disabled while
  a candidate has no sources, last-run card shows bySource + lastSuccess.
Each anchor is asserted to occur exactly once.
"""
P = "/home/hatch/workspace/sia-lab/worker.js"
src = open(P, encoding="utf-8").read()

def rep(old, new, count=1):
    global src
    n = src.count(old)
    assert n == count, f"anchor count {n} (want {count}): {old[:100]!r}"
    src = src.replace(old, new)

# --- 1. defaultDiscoveryState: lastSuccess field ---
rep('budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null };',
    'budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null };')

# --- 2. candidate carries the popularity score that ordered it ---
rep('title: title.slice(0, 200), type: w.type, tmdb: w.tmdb, sources: [],',
    'title: title.slice(0, 200), type: w.type, tmdb: w.tmdb, popularity: w.popularity || 0, sources: [],')

# --- 3a. counts gains bySource ---
rep('const counts = { fetched: 0, newCandidates: 0, duplicates: 0, skipped: 0, failed: 0 };',
    'const counts = { fetched: 0, newCandidates: 0, duplicates: 0, skipped: 0, failed: 0, bySource: {} };')

# --- 3b. flag set synchronously before the first await + lastSuccess in finish ---
rep('''    const state = await getDiscoveryState(env);
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
    this._discoveryRunning = true;''',
'''    // Overlap guard (hardening 2026-11-13): the flag is set synchronously
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
    if (!apiKey) { const r = await finish("failed", "no TMDB key"); this._discoveryRunning = false; return r; }''')

# --- 3c. per-source fetched counts ---
rep('''        if (!data || !Array.isArray(data.results)) { counts.failed++; continue; }''',
'''        if (!data || !Array.isArray(data.results)) { counts.failed++; continue; }
        counts.bySource[L.via] = (counts.bySource[L.via] || 0) + data.results.length;''')

# --- 3d. batch lock re-checks seen/queue before filing ---
rep('''      // Titles beyond the budget are NOT marked seen, so the next run
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
        for (const ld of liveDup) { const k = ld.type + ":" + ld.tmdb; const prev = seenNow[k] || { type: ld.type, tmdb: ld.tmdb, title: ld.title, firstSeen: runAt.slice(0, 10) }; prev.status = ld.status || "live-dup"; prev.lastSeen = runAt.slice(0, 10); if (ld.title) prev.title = ld.title; seenNow[k] = prev; }
        pruneSeen(seenNow, started);
        await saveSeen(env, seenNow);
        state.totals.discovered = (state.totals.discovered || 0) + newCands.length;
      });''',
'''      // Titles beyond the budget are NOT marked seen, so the next run
      // finds them again — nothing is lost, the queue just stays reviewable.
      counts.skipped += Math.max(0, fresh.length - toFile.length);
      // Batch writes inside the admin lock so a concurrent admin action
      // cannot clobber the queue update. Seen and queue are re-read
      // inside the lock (an approve/reject mid-run must not be
      // overwritten), and each candidate is re-checked against them
      // before inserting — a second run that slipped past the overlap
      // guard cannot double-file the same title (hardening 2026-11-13).
      await this._withAdminLock(async () => {
        const pendNow = await getPending(env);
        const seenNow = await getSeen(env);
        const filed = [];
        for (const c of newCands) {
          const k = c.type + ":" + c.tmdb;
          const inPend = Object.values(pendNow).some((p) => p && p.type === c.type && String(p.tmdb) === String(c.tmdb));
          const s = seenNow[k];
          if (inPend || (s && (s.status === "pending" || s.status === "approved" || s.status === "rejected" || s.status === "live-dup" || s.status === "skipped"))) { counts.duplicates++; continue; }
          filed.push(c);
        }
        for (const c of filed) pendNow[c.id] = c;
        await savePending(env, pendNow);
        for (const c of filed) { const k = c.type + ":" + c.tmdb; seenNow[k] = { type: c.type, tmdb: c.tmdb, title: c.title, firstSeen: runAt.slice(0, 10), lastSeen: runAt.slice(0, 10), status: "pending" }; }
        for (const ld of liveDup) { const k = ld.type + ":" + ld.tmdb; const prev = seenNow[k] || { type: ld.type, tmdb: ld.tmdb, title: ld.title, firstSeen: runAt.slice(0, 10) }; prev.status = ld.status || "live-dup"; prev.lastSeen = runAt.slice(0, 10); if (ld.title) prev.title = ld.title; seenNow[k] = prev; }
        pruneSeen(seenNow, started);
        await saveSeen(env, seenNow);
        counts.newCandidates = filed.length;
        counts.skipped += (newCands.length - filed.length);
        state.totals.discovered = (state.totals.discovered || 0) + filed.length;
      });''')

# --- 4. new endpoint: POST /api/admin/pending/sources ---
rep('''      // Internal: cron entry point for automated discovery. NOT an admin''',
'''      // Edit a pending candidate's playback sources (Phase 2a hardening).
      // Re-validates every URL with the same rules as intake/approve
      // (cleanSrcUrl, then toDirectUrlSrv, then clean again);
      // all-or-nothing — one bad row fails the whole save, nothing is
      // written. Empty list allowed (clears sources); approve still
      // requires at least one. Rejected candidates are not editable.
      // Never touches ext:movies or the seen-map.
      if (path === "/api/admin/pending/sources" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const id = (body.id || "").toString();
        if (!Array.isArray(body.sources)) return json({ error: "sources must be a list" }, 400);
        if (body.sources.length > 5) return json({ error: "at most 5 sources" }, 400);
        return this._withAdminLock(async () => {
          const pend = await getPending(env);
          const cand = pend[id];
          if (!cand) return json({ error: "not found" }, 404);
          if (cand.status !== "pending") return json({ error: "not pending (status: " + cand.status + ")" }, 400);
          const clean = [];
          for (let i = 0; i < body.sources.length; i++) {
            const s = body.sources[i] || {};
            const u0 = s.url != null ? String(s.url).trim() : "";
            if (!u0) continue;
            let u = cleanSrcUrl(u0);
            if (!u) return json({ error: "source " + (i + 1) + ": URL not allowed" }, 400);
            u = toDirectUrlSrv(u);
            u = cleanSrcUrl(u);
            if (!u) return json({ error: "source " + (i + 1) + ": URL not allowed" }, 400);
            const label = (s.label != null ? String(s.label).trim() : "") || ("Source " + (clean.length + 1));
            if (clean.some((c) => c.url === u)) continue;
            clean.push({ label: label.slice(0, 30), url: u });
          }
          cand.sources = clean;
          cand.needsSource = clean.length === 0;
          await savePending(env, pend);
          return json({ ok: true, id, sources: clean });
        });
      }
      // Internal: cron entry point for automated discovery. NOT an admin''')

# --- 5a. renderPend: sources editor rows (built before det) ---
rep('''    const srcs=(c.sources||[]).map(function(s){return "<div style='font-size:.82rem;color:#7a9a85'>🔗 "+pendEsc(s.label||"Source")+" — "+pendEsc(s.url)+"</div>";}).join("");''',
'''    const srcs=(c.sources||[]).map(function(s){return "<div style='font-size:.82rem;color:#7a9a85'>🔗 "+pendEsc(s.label||"Source")+" — "+pendEsc(s.url)+"</div>";}).join("");
    const srcRows=(c.sources||[]).map(function(s){return "<div class='psrow' style='display:flex;gap:6px;margin-bottom:6px'><input class='pslabel' placeholder='Label' value='"+pendEsc(s.label||"")+"' style='width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px'><input class='psurl' placeholder='Paste playback URL…' value='"+pendEsc(s.url||"")+"' style='flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px'><button class='btn danger' style='padding:6px 10px;font-size:.8rem' onclick='delPendSrcRow(this)'>✕</button></div>";}).join("");''')

# --- 5b. renderPend: editor block inside the Inspect panel ---
rep('''      +(srcs||"<div style='color:#7a9a85'>No playback source attached yet — approval needs one.</div>")''',
'''      +(srcs||"<div style='color:#7a9a85'>No playback source attached yet — approval needs one.</div>")
      +(pendTabCur==="pending"?"<div style='margin-top:10px'><b>Playback sources</b> <span style='color:#7a9a85'>(edit, then Save — the server re-checks every URL)</span><div id='ps-"+c.id+"' style='margin-top:6px'>"+srcRows+"</div><button class='btn' style='padding:6px 12px;font-size:.8rem;margin-top:4px' data-id='"+c.id+"' onclick='addPendSrcRow(this)'>+ Add source</button> <button class='btn' style='padding:6px 12px;font-size:.8rem;margin-top:4px' data-id='"+c.id+"' onclick='savePendSources(this)'>Save sources</button> <span id='psmsg-"+c.id+"' style='font-size:.82rem'></span></div>":"")''')

# --- 5c. renderPend: Approve disabled while sourceless ---
rep('''    const btns=pendTabCur==="pending"
      ?"<button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='" + c.id + "' onclick='approvePending(this)'>✓ Approve</button><button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='" + c.id + "' onclick='rejectPending(this)'>✖ Reject</button>"
      :"";''',
'''    const noSrc=!(c.sources||[]).length;
    const btns=pendTabCur==="pending"
      ?"<button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='" + c.id + "' onclick='approvePending(this)'"+(noSrc?" disabled title='Add a playback source first'":"")+">✓ Approve</button><button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='" + c.id + "' onclick='rejectPending(this)'>✖ Reject</button>"
      :"";''')

# --- 5d. sources-editor JS (after deletePending, before the discovery section) ---
rep('''async function deletePending(btn){const id=btn.dataset.id;
  if(!confirm("Delete this candidate permanently?"))return;
  const r=await api("/api/admin/pending/delete?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  if(r.ok)loadPending();else alert("✗ failed");
}''',
'''async function deletePending(btn){const id=btn.dataset.id;
  if(!confirm("Delete this candidate permanently?"))return;
  const r=await api("/api/admin/pending/delete?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  if(r.ok)loadPending();else alert("✗ failed");
}
function addPendSrcRow(btn){var box=document.getElementById("ps-"+btn.dataset.id);if(!box)return;var div=document.createElement("div");div.className="psrow";div.style.cssText="display:flex;gap:6px;margin-bottom:6px";div.innerHTML='<input class="pslabel" placeholder="Label" style="width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px"><input class="psurl" placeholder="Paste playback URL…" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px"><button class="btn danger" style="padding:6px 10px;font-size:.8rem" onclick="delPendSrcRow(this)">✕</button>';box.appendChild(div);}
function delPendSrcRow(btn){var r=btn.closest(".psrow");if(r)r.remove();}
async function savePendSources(btn){const id=btn.dataset.id;var box=document.getElementById("ps-"+id);var msg=document.getElementById("psmsg-"+id);var rows=box?box.querySelectorAll(".psrow"):[];var sources=[];for(var i=0;i<rows.length;i++){var u=rows[i].querySelector(".psurl").value.trim();if(!u)continue;sources.push({label:rows[i].querySelector(".pslabel").value.trim()||("Source "+(sources.length+1)),url:u});}if(msg)msg.textContent="saving…";const r=await api("/api/admin/pending/sources?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,sources})});const d=await r.json().catch(()=>({}));if(r.ok){if(msg)msg.innerHTML='<span class="ok">✓ saved '+(d.sources||[]).length+' source(s) — review them, then Approve.</span>';loadPending();return;}if(msg)msg.innerHTML='<span class="bad">✗ '+(d.error||"failed")+'</span>';}''')

# --- 6. renderDiscovery: bySource + lastSuccess on the last-run card ---
rep('''      +"<div>Fetched "+(c.fetched||0)+" · new candidates "+(c.newCandidates||0)+" · duplicates "+(c.duplicates||0)+" · skipped "+(c.skipped||0)+" · failed "+(c.failed||0)+" · "+(last.durationMs||0)+"ms</div>"
      +(last.error?"<div style='color:#ff9a9a'>"+pendEsc(last.error)+"</div>":"");''',
'''      +"<div>Fetched "+(c.fetched||0)+(c.bySource?" ("+Object.keys(c.bySource).map(function(k){return pendEsc(k)+" "+c.bySource[k];}).join(" · ")+")":"")+" · new candidates "+(c.newCandidates||0)+" · duplicates "+(c.duplicates||0)+" · skipped "+(c.skipped||0)+" · failed "+(c.failed||0)+" · "+(last.durationMs||0)+"ms</div>"
      +(last.error?"<div style='color:#ff9a9a'>"+pendEsc(last.error)+"</div>":"")
      +(s.lastSuccess?"<div style='color:#7a9a85'>Last successful run: "+new Date(s.lastSuccess.at||0).toLocaleString()+" · via "+pendEsc(s.lastSuccess.trigger||"")+"</div>":"");''')

open(P, "w", encoding="utf-8").write(src)
print("hardening build applied OK, new size:", len(src))
