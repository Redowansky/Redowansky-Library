#!/usr/bin/env node
// Phase 2a verification harness (kept under ~/workspace/sia-lab/, NOT the repo):
//  1. Extracts the ADMIN_PAGE + PAGE template literals from worker.js,
//     evaluates them (interpolations blanked), extracts <script> blocks and
//     node --check's each — node --check worker.js alone does NOT cover
//     JS inside template literals (2026-11-13 lesson).
//  2. Functionally runs the admin-page script in node with a stub DOM and
//     exercises the new discovery JS (provLine, renderDiscovery,
//     renderPend with a needsSource + providers candidate).
const fs = require("fs");
const { execSync } = require("child_process");

const src = fs.readFileSync("/home/hatch/workspace/sia-lab/worker.js", "utf8");

function extractTemplate(name) {
  const anchor = "const " + name + " = `";
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error("template not found: " + name);
  let i = start + anchor.length, out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { out += ch + src[i + 1]; i += 2; continue; }
    if (ch === "`") return out;
    out += ch; i++;
  }
  throw new Error("unterminated template: " + name);
}

function checkScripts(pageName, body) {
  // Evaluate the template literal EXACTLY as the browser receives it:
  // escapes (\\', \\s, etc.) collapse during evaluation. Checking the raw
  // source text gives false syntax errors (and can hide real ones).
  const interp = [...body.matchAll(/\$\{[^}]*\}/g)].map(m => m[0]);
  const served = new Function("return `" + body.replace(/\$\{[^}]*\}/g, "") + "`")();
  const scripts = [...served.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  console.log(pageName + ": " + scripts.length + " <script> block(s), interpolations blanked: " + JSON.stringify([...new Set(interp)]));
  scripts.forEach((s, idx) => {
    const f = "/home/hatch/workspace/sia-lab/.phase2a-test/" + pageName + "-script" + idx + ".js";
    fs.mkdirSync("/home/hatch/workspace/sia-lab/.phase2a-test", { recursive: true });
    fs.writeFileSync(f, s);
    execSync("node --check " + f, { stdio: "inherit" });
    console.log("  script " + idx + " node --check OK (" + s.length + " chars)");
  });
  return served;
}

const adminPage = checkScripts("ADMIN_PAGE", extractTemplate("ADMIN_PAGE"));
const homePage = checkScripts("PAGE", extractTemplate("PAGE"));

// Footer attribution present on the home page?
if (!homePage.includes("This product uses the TMDB API but is not endorsed or certified by TMDB."))
  throw new Error("TMDB attribution missing from home footer");
if (!homePage.includes("blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"))
  throw new Error("TMDB logo URL missing from home footer");
console.log("home footer: TMDB attribution + logo present");

// ---- functional admin-script test --------------------------------------
const adminScript = [...adminPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
// Minimal DOM stub.
const els = {};
function makeEl(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", checked: false,
    className: "", style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){} },
    addEventListener(){}, appendChild(){}, setAttribute(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
  };
}
const documentStub = {
  addEventListener() {},
  getElementById(id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
  querySelector(sel) { if (sel === ".sec") return null; return makeEl("q"); },
  querySelectorAll() { return []; },
  createElement() { return makeEl("new"); },
};
let lastApiCall = null;
async function apiStub(path, opts) {
  lastApiCall = { path, opts };
  return { ok: true, status: 200, json: async () => ({ ok: true, state: {
    enabled: true, frequency: "daily",
    sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false },
    budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
    lastRun: { at: "2026-11-13T06:30:00.000Z", trigger: "manual", status: "ok",
      counts: { fetched: 42, newCandidates: 3, duplicates: 5, skipped: 1, failed: 0 }, durationMs: 1234, error: null },
    totals: { discovered: 3, approved: 0, rejected: 0 },
    nextRunAt: "2026-11-14T02:00:00.000Z",
  } }) };
}
const sandbox = {
  document: documentStub,
  window: {}, sessionStorage: { getItem: () => null, setItem() {} },
  localStorage: { getItem: () => null, setItem() {} },
  api: apiStub, pw: () => "pw123", $: (id) => documentStub.getElementById(id),
  alert: (m) => { sandbox._alert = m; }, confirm: () => true,
  // NOTE: the admin script defines its own api()/pw() (shadowing the
  // sandbox ones), built on fetch — so route canned responses by URL here.
  fetch: async (url) => {
    const u = String(url);
    if (u.includes("/api/admin/discovery/state")) return { ok: true, status: 200, json: async () => ({ ok: true, state: {
      enabled: true, frequency: "daily",
      sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false },
      budget: { maxNewPerRun: 15, maxDetailCalls: 30 },
      lastRun: { at: "2026-11-13T06:30:00.000Z", trigger: "manual", status: "ok",
        counts: { fetched: 42, newCandidates: 3, duplicates: 5, skipped: 1, failed: 0 }, durationMs: 1234, error: null },
      totals: { discovered: 3, approved: 0, rejected: 0 },
      nextRunAt: "2026-11-14T02:00:00.000Z",
    } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  },
  console,
};
sandbox.globalThis = sandbox;
const vm = require("vm");
vm.createContext(sandbox);
vm.runInContext(adminScript, sandbox, { filename: "admin-page.js" });
console.log("admin script evaluated in stub DOM OK");

// provLine
const pl = vm.runInContext("provLine({BD:['Netflix','Prime Video'],US:['Hulu']})", sandbox);
console.log("provLine:", pl);
if (!pl.includes("BD: Netflix, Prime Video") || !pl.includes("US: Hulu")) throw new Error("provLine wrong");

// loadDiscovery -> renderDiscovery
(async () => {
  await vm.runInContext("loadDiscovery()", sandbox);
  const last = els["discLast"].innerHTML;
  const totals = els["discTotals"].textContent;
  console.log("discLast:", last.replace(/\s+/g, " ").slice(0, 220));
  console.log("discTotals:", totals);
  if (!last.includes("Fetched 42") || !last.includes("new candidates 3")) throw new Error("renderDiscovery counts wrong");
  if (!totals.includes("discovered 3")) throw new Error("renderDiscovery totals wrong");
  if (els["discEnabled"].checked !== true) throw new Error("discEnabled not set from state");
  if (els["discFreq"].value !== "daily") throw new Error("discFreq not set from state");

  // renderPend with a discovered, sourceless candidate
  vm.runInContext("pendCache={pending:[{id:'p1',title:'Test Movie',type:'movie',tmdb:123,year:'2026',discoveredVia:'tmdb-discover',discoveredAt:'2026-11-13T06:00:00.000Z',needsSource:true,sources:[],providers:{BD:['Netflix']},overview:'A test.',poster:'/abc.jpg',createdAt:1763000000000}],rejected:[]};pendTabCur='pending';renderPend()", sandbox);
  const html = els["pendList"].innerHTML;
  console.log("renderPend snippet:", html.replace(/\s+/g, " ").slice(0, 400));
  if (!html.includes("needs a playback source")) throw new Error("needsSource marker missing in renderPend");
  if (!html.includes("Where to watch:") || !html.includes("BD: Netflix")) throw new Error("providers line missing in renderPend");
  if (!html.includes("discovered ")) throw new Error("discoveredAt missing in renderPend");
  if (!html.includes("Playback sources") || !html.includes("savePendSources")) throw new Error("sources editor missing in renderPend");
  if (!html.includes("disabled") || !html.includes("Add a playback source first")) throw new Error("Approve not disabled for sourceless candidate");
  // same candidate with a source attached: editor pre-filled, Approve enabled
  vm.runInContext("pendCache.pending[0].sources=[{label:'Main',url:'https://example.com/f.mp4'}];pendCache.pending[0].needsSource=false;renderPend()", sandbox);
  const html2 = els["pendList"].innerHTML;
  if (!html2.includes("https://example.com/f.mp4")) throw new Error("saved source not shown in editor");
  if (html2.includes("disabled")) throw new Error("Approve wrongly disabled for sourced candidate");
  console.log("ALL TEMPLATE + ADMIN-JS CHECKS PASSED");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
