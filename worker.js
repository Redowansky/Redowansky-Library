import { EmailMessage } from "cloudflare:email";
// Sia Lab — file browser for the Sia storage backend (s3d).
// A Durable Object holds the single reverse-tunnel WebSocket (the s3d host
// dials OUT to /__tunnel); all requests route through it so any edge
// isolate reaches the same socket.

const REGION = "us-east-1";
const SERVICE = "s3";
const te = new TextEncoder();

// ---------- App minimum-version gate (v0.6.27, server-side forced updates) ----------
// The app marks its requests with User-Agent "RedowanskyLibraryApp/...";
// the website uses browser UAs, so the gate only ever touches app
// traffic. App builds since 0.6.27 also send X-App-Version (their
// versionCode); older builds send none and count as version 0.
// Bump LATEST_APP_VERSION on every app release: any app build below
// it gets 426 + the warning below instead of data, and the app shows
// that message inside the player screen. The update path itself
// (version.json on R2, /apk) is NOT gated, so a refused app can
// still update.
const LATEST_APP_VERSION = 41;
const APP_UPDATE_MESSAGE = "⚠️ current version of the app is not working anymore please update to the latest version to keep watching ⚠️";
function appVersionBlocked(request) {
  const ua = request.headers.get("User-Agent") || "";
  if (!ua.startsWith("RedowanskyLibraryApp")) return false;
  const v = parseInt(request.headers.get("X-App-Version") || "", 10);
  return !(v >= LATEST_APP_VERSION);
}
function appVersionRefused() {
  return json({ blocked: true, message: APP_UPDATE_MESSAGE }, 426);
}

// ---------- Signed stream URLs (v0.6.28, YouTube-style complete refusal) ----------
// Video bytes no longer flow from public R2 URLs: the app and the site
// play through /stream/<key>?t=<token>, and the token can only be
// minted by a current-version app (or the site itself). An old app
// cannot mint, cannot guess (HMAC-SHA256 with a Worker secret), and
// its stored direct R2 URLs go dead when the media bucket's public
// r2.dev domain is off — so old builds cannot play anything at all.
// Tokens live 24h (covers a full movie and slow downloads); rotating
// PLAY_TOKEN_SECRET invalidates every outstanding token at once.
const R2_PUBLIC_PREFIX = "https://pub-88baf9e209354ab5b4edee733305154f.r2.dev/";
const STREAM_TOKEN_TTL = 86400;
function r2KeyOf(u) {
  if (!u || !u.startsWith(R2_PUBLIC_PREFIX)) return null;
  const k = u.slice(R2_PUBLIC_PREFIX.length).split("?")[0];
  if (!k || k.split("/").includes("..")) return null;
  return k;
}
function streamB64Encode(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function streamB64Decode(s) {
  return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
}
async function mintStreamToken(env, key) {
  const exp = Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL;
  const payload = streamB64Encode(JSON.stringify({ k: key, exp }));
  const sig = await hmacHex(env.PLAY_TOKEN_SECRET || "", payload);
  return payload + "." + sig;
}
async function verifyStreamToken(env, key, token) {
  if (!env.PLAY_TOKEN_SECRET) return false;
  const dot = (token || "").lastIndexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const want = await hmacHex(env.PLAY_TOKEN_SECRET, payload);
  if (sig !== want) return false;
  let t;
  try { t = JSON.parse(streamB64Decode(payload)); } catch (e) { return false; }
  return t.k === key && t.exp && t.exp > Math.floor(Date.now() / 1000);
}
async function streamUrlFor(env, u) {
  const k = r2KeyOf(u);
  if (!k) return u;
  const tok = await mintStreamToken(env, k);
  return "/stream/" + k.split("/").map(encodeURIComponent).join("/") + "?t=" + tok;
}

// ---------- AdBlock wall (home + view + ext-view) ----------
// Strict wall: if an ad blocker is detected, a full-screen overlay blocks
// the page until the visitor really disables it. The "I've disabled it"
// button re-runs the same checks; if still blocked, the wall stays (loop).
// Detection uses two signals: a bait element that content blockers hide
// via cosmetic filtering, and a no-cors fetch probe to the ad domain
// (network-level blockers reject it). A probe timeout counts as
// inconclusive, not blocked, so a slow network alone never walls anyone.
// DISABLED 2026-11-12 (his call, "for now"): flip the flag back to
// true to re-enable the wall — the code stays in place.
const ADBLOCK_WALL_ENABLED = false;
const ADBLOCK_WALL = ADBLOCK_WALL_ENABLED ? `<div id="adblock-bait" class="ads adsbygoogle ad-banner adsbox" style="width:10px;height:10px;position:absolute;left:0;top:0;"></div>
<div id="adblock-wall" style="display:none;position:fixed;inset:0;z-index:999999;background:#0b120e;color:#e8f0ea;text-align:center;padding:24px;overflow:auto;">
<div style="max-width:440px;margin:18vh auto 0;">
<div style="font-size:48px;">🛡️</div>
<h2 style="margin:12px 0 8px;">Looks like you're using an AdBlocker</h2>
<p style="color:#9db5a4;line-height:1.5;">Ads keep Redowansky Library free. Please disable your ad blocker for this site to continue.</p>
<button id="adblock-check" style="margin-top:16px;padding:14px 28px;font-size:1.05rem;border:0;border-radius:10px;background:#2fbf71;color:#06130b;font-weight:700;cursor:pointer;">I've disabled it</button>
<p style="color:#7d9484;font-size:.85rem;margin-top:14px;">After disabling, tap the button and we'll check again.</p>
</div>
</div>
<script>
(function(){
  function baitBlocked(){
    var b=document.getElementById('adblock-bait');
    if(!b) return false;
    try{
      var cs=window.getComputedStyle(b);
      if(cs.display==='none'||cs.visibility==='hidden') return true;
    }catch(e){}
    return b.offsetHeight===0;
  }
  function probeBlocked(cb){
    var done=false;
    function fin(v){ if(!done){done=true;cb(v);} }
    try{
      var c=new AbortController();
      var t=setTimeout(function(){ c.abort(); fin(false); },3000);
      fetch('https://aarems.org/1/8a50be483ddba782392f8d2b164694b9',{mode:'no-cors',signal:c.signal})
        .then(function(){ clearTimeout(t); fin(false); })
        .catch(function(){ clearTimeout(t); fin(true); });
    }catch(e){ fin(false); }
  }
  function showWall(){
    var w=document.getElementById('adblock-wall');
    if(w) w.style.display='block';
    document.body.style.overflow='hidden';
  }
  function hideWall(){
    var w=document.getElementById('adblock-wall');
    if(w) w.style.display='none';
    document.body.style.overflow='';
  }
  function recheck(btn){
    if(btn) btn.textContent='Checking…';
    if(baitBlocked()){ if(btn) btn.textContent="I've disabled it"; return; }
    probeBlocked(function(blocked){
      if(blocked){ if(btn) btn.textContent="I've disabled it"; return; }
      hideWall();
      location.reload();
    });
  }
  var btn=document.getElementById('adblock-check');
  if(btn) btn.onclick=function(){ recheck(btn); };
  window.addEventListener('load',function(){
    setTimeout(function(){
      if(baitBlocked()){ showWall(); return; }
      probeBlocked(function(blocked){ if(blocked) showWall(); });
    },600);
  });
})();
</script>` : '';

// ---------- SigV4 ----------
async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(key, data) {
  const ck = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", ck, data));
}
async function getSigningKey(secret, dateStamp) {
  const kDate = await hmac(te.encode("AWS4" + secret), te.encode(dateStamp));
  const kRegion = await hmac(kDate, te.encode(REGION));
  const kService = await hmac(kRegion, te.encode(SERVICE));
  return hmac(kService, te.encode("aws4_request"));
}
async function signRequest(method, path, query, headers, bodyHash, secret, accessKey) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = bodyHash;
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]).trim();
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map(h => h + ":" + lower[h] + "\n").join("");
  const params = [...new URLSearchParams(query).entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const canonicalQS = params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  const canonicalRequest = [method, path, canonicalQS, canonicalHeaders, signedHeaders.join(";"), bodyHash].join("\n");
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(te.encode(canonicalRequest))].join("\n");
  const signingKey = await getSigningKey(secret, dateStamp);
  const sig = [...await hmac(signingKey, te.encode(stringToSign))].map(b => b.toString(16).padStart(2, "0")).join("");
  headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${sig}`;
  return headers;
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}
function xmlAll(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(m => m[1]);
}
const parseBuckets = (xml) => xmlAll(xml, "Bucket").map(b => xmlTag(b, "Name")).filter(Boolean);
function parseList(xml) {
  const contents = xmlAll(xml, "Contents").map(c => ({
    key: xmlTag(c, "Key"),
    size: parseInt(xmlTag(c, "Size") || "0", 10),
    modified: xmlTag(c, "LastModified"),
  }));
  const prefixes = xmlAll(xml, "CommonPrefixes").map(p => xmlTag(p, "Prefix"));
  return { objects: contents, prefixes };
}
async function adminPw(env, state) {
  try {
    const stored = state && state.storage ? await state.storage.get("admin_pw") : null;
    if (stored) return stored;
  } catch (e) {}
  // No fallback password: if nothing is stored and no ADMIN_PW secret is
  // set, admin access is denied (a hardcoded fallback used to live here).
  return env.ADMIN_PW || null;
}
async function checkPw(url, env, state) {
  const pw = await adminPw(env, state);
  return !!pw && url.searchParams.get("pw") === pw;
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const bufToText = (buf) => new TextDecoder().decode(buf);

// ---- Google sync (site sign-in + cross-device watch progress) ----
// Same Google OAuth project as the app: redowansky-library. The app
// already requests ID tokens for this Web client; the site uses the
// standard OAuth code flow with redirect https://redowansky.bond/auth/callback
// (that URI must be registered on the Web client in Google Cloud Console).
// Progress is keyed ONLY by the Google subject id (sub), never by email,
// in DATA_KV: progress:<sub>:<movieId> and sessions in session:<id>.
// Site browsing stays open: sign-in is optional, only for personal history.
const GOOGLE_CLIENT_ID = "401417620222-de0ve4jhi8vcqedihpo1n3gpsi7md4hi.apps.googleusercontent.com";
const GOOGLE_REDIRECT_URI = "https://redowansky.bond/auth/callback";
// ---- Amazon sign-in (Login with Amazon, mirrors Google above) ----
// Same shape: site uses the OAuth code flow with redirect
// https://redowansky.bond/auth/amazon/callback (must be a registered
// Allowed Return URL on the LWA security profile's Web Settings);
// the app sends its LWA SDK access token as a Bearer header and the
// Worker verifies it via Amazon's tokeninfo + profile endpoints.
// Progress is keyed by "amzn:<amazon user_id>", namespaced away from
// Google subs. Client secret lives in the AMAZON_CLIENT_SECRET Worker
// secret; the client ID is public (it travels in the authorize URL)
// and is filled in once the security profile exists. Until both are
// set, /auth/amazon/login answers 503, exactly like Google's guard.
const AMAZON_CLIENT_ID = "AMAZON_CLIENT_ID_NOT_SET";
const AMAZON_REDIRECT_URI = "https://redowansky.bond/auth/amazon/callback";
function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}
async function verifyAmazonAccessToken(token) {
  if (!token || !AMAZON_CLIENT_ID || AMAZON_CLIENT_ID.startsWith("AMAZON_")) return null;
  try {
    const r = await fetch("https://api.amazon.com/auth/o2/tokeninfo?access_token=" + encodeURIComponent(token));
    if (!r.ok) return null;
    const t = await r.json();
    if (t.aud !== AMAZON_CLIENT_ID) return null;
    if (t.exp && Number(t.exp) * 1000 < Date.now()) return null;
    const p = await fetch("https://api.amazon.com/user/profile", { headers: { Authorization: "Bearer " + token } });
    if (!p.ok) return null;
    const prof = await p.json();
    if (!prof.user_id) return null;
    return { sub: "amzn:" + String(prof.user_id), email: prof.email || "", name: prof.name || "" };
  } catch { return null; }
}
function b64urlDecode(s) {
  try {
    const b = s.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  } catch { return ""; }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function verifyGoogleIdToken(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!r.ok) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID) return null;
    if (t.exp && Number(t.exp) * 1000 < Date.now()) return null;
    if (t.iss !== "https://accounts.google.com" && t.iss !== "accounts.google.com") return null;
    if (!t.sub) return null;
    return { sub: String(t.sub), email: t.email || "", name: t.name || "", picture: t.picture || "" };
  } catch { return null; }
}
async function sessionFromRequest(env, req) {
  try {
    const id = parseCookies(req).lb_session;
    if (!id || !/^[A-Za-z0-9_-]{20,80}$/.test(id)) return null;
    const s = await env.DATA_KV.get("session:" + id, "json");
    if (!s || !s.sub || !s.exp || s.exp < Date.now()) return null;
    return { id, ...s };
  } catch { return null; }
}
function sessionCookie(id, maxAge) {
  return "lb_session=" + id + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + maxAge;
}
function progressId(raw) {
  return String(raw || "").trim().slice(0, 120);
}

// ---- PAGE (public read-only library) ----
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="mnd-ver" content="gjfr65hhptrjchm0g4gugw" /><script async src="https://ss.mrmnd.com/static/f53498a9-9861-49d1-b571-67c892585b0a.js"></script><script async src="https://ss.mrmnd.com/banner.js"></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Redowansky's Library — free movie and video song streaming: Hollywood and Bollywood films with Continue Watching and resume across devices.">
<link rel="canonical" href="https://redowansky.bond/">
<title>Redowansky's Library — Hollywood &amp; Bollywood Movies &amp; Songs</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--grn:#00e676;--bg:#060906}
body{background:var(--bg);color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
header{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;gap:20px;padding:14px 28px;background:linear-gradient(180deg,rgba(6,9,6,.95),transparent);transition:.3s}
header.scrolled{background:rgba(6,9,6,.97);box-shadow:0 2px 20px rgba(0,0,0,.5)}
.logo{font-size:1.4rem;font-weight:800;background:linear-gradient(90deg,#00e676,#69f0ae);-webkit-background-clip:text;background-clip:text;color:transparent;cursor:pointer;white-space:nowrap}
nav{display:flex;gap:18px}
nav a{color:#b8d8c0;text-decoration:none;font-size:.9rem;cursor:pointer}
nav a:hover,nav a.on{color:#fff}
.search{margin-left:auto;display:flex;align-items:center;background:#0c1410;border:1px solid #1e3a2a;border-radius:8px;padding:6px 12px}
.search input{background:none;border:none;color:#fff;outline:none;width:160px;font-size:.9rem}
.hero{position:relative;height:62vh;min-height:380px;display:flex;align-items:flex-end;overflow:hidden}
.hero-bg{position:absolute;inset:0;background-size:cover;background-position:center top}
.hero-grad{position:absolute;inset:0;background:linear-gradient(180deg,transparent 20%,rgba(6,9,6,.7) 60%,var(--bg) 100%),linear-gradient(90deg,rgba(6,9,6,.8),transparent 60%)}
.hero-info{position:relative;z-index:2;padding:0 28px 60px;max-width:640px}
.hslide{position:absolute;inset:0;display:flex;align-items:flex-end;opacity:0;transition:opacity .8s ease;pointer-events:none}
.hslide.on{opacity:1;pointer-events:auto}
.hslide .hero-bg{transition:transform 6s ease}
.hslide.on .hero-bg{transform:scale(1.04)}
.hero-prog{position:absolute;left:0;bottom:0;height:3px;background:#00e676;z-index:3;width:0;animation:hprog 5s linear forwards}
@keyframes hprog{from{width:0}to{width:100%}}
.hero-info h1{font-size:3rem;font-weight:800;margin-bottom:12px;text-shadow:0 2px 20px rgba(0,0,0,.8)}
.hero-meta{display:flex;gap:12px;align-items:center;margin-bottom:14px;font-size:.9rem;color:#b8d8c0}
.hero-meta .rate{color:var(--grn);font-weight:700}
.hero-info p{color:#c8e0d0;line-height:1.6;margin-bottom:22px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hero-btns{display:flex;gap:12px}
.btn{padding:12px 32px;border-radius:8px;font-weight:700;font-size:1rem;cursor:pointer;border:none;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.btn-play{background:#fff;color:#000}
.btn-play:hover{background:#e0e0e0}
.btn-info{background:rgba(100,100,100,.5);color:#fff}
.btn-info:hover{background:rgba(100,100,100,.7)}
section.row{padding:0 28px;margin-bottom:36px}
section.row h2{font-size:1.3rem;margin-bottom:14px;font-weight:700;border-left:3px solid #00e676;padding-left:10px}
#authbox{margin-left:auto;white-space:nowrap;font-size:.85rem;background:#12291c;border:1px solid #1e3a2a;border-radius:999px;padding:7px 12px}
.cards{display:flex;gap:12px;overflow-x:auto;padding-bottom:10px;scrollbar-width:thin}
.cards::-webkit-scrollbar{height:8px}
.cards::-webkit-scrollbar-thumb{background:#1e3a2a;border-radius:4px}
.card{flex:0 0 160px;cursor:pointer;transition:.2s;border-radius:12px;overflow:hidden;background:#0c1410;border:1px solid #1e3a2a;box-shadow:0 4px 18px rgba(0,0,0,.35)}
.card:hover{transform:scale(1.05);box-shadow:0 8px 30px rgba(0,230,118,.25);z-index:5}
.card img{width:160px;height:240px;object-fit:cover;display:block;background:#0a120c}
.card .cinfo{padding:8px 10px}
.card .cinfo b{font-size:.85rem;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .cinfo span{font-size:.75rem;color:#7a9a85}
.card .noposter{width:160px;height:240px;display:flex;align-items:center;justify-content:center;font-size:3rem;background:#0a120c;color:#1e3a2a}
.modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;padding:20px}
.modal.open{display:flex}
.modal-box{background:#0c1410;border:1px solid #1e3a2a;border-radius:16px;max-width:800px;width:100%;max-height:90vh;overflow-y:auto;position:relative}
.modal-hero{height:300px;background-size:cover;background-position:center top;position:relative;border-radius:16px 16px 0 0}
.modal-hero .mg{position:absolute;inset:0;background:linear-gradient(180deg,transparent,rgba(12,20,16,.9));border-radius:16px 16px 0 0}
.modal-x{position:absolute;top:16px;right:16px;background:#000;color:#fff;border:none;width:36px;height:36px;border-radius:50%;font-size:1.2rem;cursor:pointer;z-index:3}
.modal-info{padding:24px 28px}
.modal-info h2{font-size:1.8rem;margin-bottom:8px}
.modal-info .mmeta{display:flex;gap:14px;color:#7a9a85;font-size:.9rem;margin-bottom:14px;flex-wrap:wrap}
.modal-info .mmeta .rate{color:var(--grn);font-weight:700}
.modal-info p{line-height:1.7;color:#c8e0d0;margin-bottom:20px}
.genres{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.genres span{background:#1e3a2a;padding:4px 12px;border-radius:999px;font-size:.8rem}
.empty{text-align:center;color:#55556a;padding:80px 20px}
@media(max-width:640px){
.hero-info h1{font-size:1.8rem}
.card{flex:0 0 110px}.card img,.card .noposter{width:110px;height:165px}
header{padding:10px 12px;gap:8px;flex-wrap:wrap}
.logo{font-size:1.1rem}
nav{gap:12px;order:3;width:100%}
nav a{font-size:.8rem}
.search{margin-left:0;flex:1 1 100px;min-width:0}
.search input{width:100%;min-width:0}
#authbox{font-size:.78rem;padding:5px 9px}
section.row{padding:0 12px}
.hero-info{padding:0 16px 40px}
.hero{height:55vh;min-height:320px}
.hero-btns{flex-wrap:wrap}
.btn{padding:10px 20px;font-size:.9rem}
.modal-box{margin:10px}
}
</style><script data-cfasync="false" src="https://aarems.org/1/8a50be483ddba782392f8d2b164694b9"></script></head><body>
<header id="hdr"><div class="logo" onclick="location.href='/'">🎬 Redowansky</div>
<nav><a class="on" data-f="movie">Movies</a><a data-f="series">TV Series</a></nav>
<div class="search"><input id="q" placeholder="Search titles..." oninput="doSearch(this.value)"></div><div id="authbox"><a href="/auth/login" style="color:#00e676;text-decoration:none">Sign in with Google</a> · <a href="/auth/amazon/login" style="color:#00e676;text-decoration:none">Sign in with Amazon</a></div></header>
<div class="hero" id="hero" style="display:none"><div id="hslides" style="position:absolute;inset:0"></div>
<div class="hero-prog" id="hprog"></div></div>
<div class="browse-ad" style="display:flex;justify-content:center;padding:18px 10px 2px"><div data-mndbanid="e7f1fcbf-d6f7-4ef5-afe1-b2005cc6e66c"></div></div>
<main id="main" style="padding-top:20px"></main>
<div class="modal" id="modal"><div class="modal-box"><button class="modal-x" onclick="closeModal()">✕</button>
<div class="modal-hero" id="mhero"><div class="mg"></div></div><div class="modal-info" id="minfo"></div></div></div>
<script>
let ALL=[];
const $=id=>document.getElementById(id);
const IMG='https://image.tmdb.org/t/p/w500', BG='https://image.tmdb.org/t/p/original';
function setStatus(m,ok){const s=$('status');if(!s)return;s.textContent=m;s.className=ok||'';}
window.onscroll=()=>$('hdr').classList.toggle('scrolled',scrollY>50);
async function load(){
  try{
    const d=await (await fetch('/api/movies')).json();
    ALL=d.movies||[];
    if(!ALL.length){$('main').innerHTML='<div class="empty">No movies yet.</div>';setStatus('empty');return;}
    render('movie','');
    buildHero();
  }catch(e){setStatus('● offline','bad');}
}
let SLIDES=[],HI=0,HTIMER=null;
function playUrl(m){return m.external?'/view/ext/'+m.id:'/view/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/');}
function bgUrl(m){if(m.backdrop)return BG+m.backdrop;if(m.poster)return m.poster.startsWith('http')?m.poster:IMG+m.poster;return '';}
function buildHero(){
  const pool=[...ALL].filter(m=>m.type!=='song'&&m.type!=='series').sort((a,b)=>(b.vote||0)-(a.vote||0)).slice(0,6);
  SLIDES=pool;HI=0;
  if(!pool.length){$('hero').style.display='none';return;}
  $('hero').style.display='flex';
  $('hslides').innerHTML=pool.map((m,i)=>{
    return '<div class="hslide'+(i===0?' on':'')+'"><div class="hero-bg" style="background-image:url('+bgUrl(m)+')"></div><div class="hero-grad"></div><div class="hero-info"><h1>'+m.title+'</h1><div class="hero-meta"><span class="rate">★ '+(m.vote||'—')+'</span><span>'+(m.year||'')+'</span><span>'+(m.genres||[]).join(' · ')+'</span></div><p>'+(m.overview||'')+'</p><div class="hero-btns"><a class="btn btn-play" href="'+playUrl(m)+'">▶ Play</a><button class="btn btn-info" onclick="openModal(SLIDES['+i+'])">ⓘ More Info</button></div></div></div>';
  }).join('');
  $('hprog').style.display=pool.length>1?'':'none';
  startAuto();
}
function showSlide(i){
  HI=i;
  document.querySelectorAll('.hslide').forEach((s,j)=>s.classList.toggle('on',j===i));
  const p=$('hprog');
  if(p){p.style.animation='none';void p.offsetWidth;p.style.animation='';}
}
function goSlide(i){showSlide(i);startAuto();}
function startAuto(){stopAuto();if(SLIDES.length>1)HTIMER=setInterval(()=>showSlide((HI+1)%SLIDES.length),5000);}
function stopAuto(){if(HTIMER){clearInterval(HTIMER);HTIMER=null;}}
$('hero').addEventListener('mouseenter',stopAuto);
$('hero').addEventListener('mouseleave',startAuto);
$('hero').addEventListener('touchstart',stopAuto,{passive:true});
$('hero').addEventListener('touchend',startAuto);
function fmtLeft(sec){sec=Math.max(0,Math.round(sec));if(sec>=3600)return Math.floor(sec/3600)+'h '+Math.floor(sec%3600/60)+'m left';if(sec>=60)return Math.floor(sec/60)+' min left';return sec+' sec left';}
function fmtClock(sec){sec=Math.max(0,Math.floor(sec));var h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return h>0?h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0');}
async function loadSync(){
  try{
    // Wait for the catalog (load()) so resume links can join by movie id.
    for(var i=0;i<20&&!ALL.length;i++){await new Promise(function(r){setTimeout(r,200);});}
    var me=await (await fetch('/auth/me')).json();
    var box=$('authbox');
    if(box){
      if(me.signedIn){box.innerHTML='<span style="color:#e8f5e9">'+(me.name||'Signed in')+'</span> · <a href="/auth/logout" style="color:#7a9a85;text-decoration:none">Sign out</a>';}
      else{box.innerHTML='<a href="/auth/login" style="color:#00e676;text-decoration:none">Sign in with Google</a> · <a href="/auth/amazon/login" style="color:#00e676;text-decoration:none">Sign in with Amazon</a>';}
    }
    if(!me.signedIn)return;
    var d=await (await fetch('/api/progress')).json();
    var entries=(d.entries||[]).filter(function(e){return e.pos>10&&e.dur>0;});
    if(!entries.length)return;
    var byId={};ALL.forEach(function(m){if(m.id)byId[m.id]=m;});
    var unfinished=entries.filter(function(e){return !e.done;});
    var html='';
    if(unfinished.length){
      var e=unfinished[0];
      var m=byId[e.id];
      var link=e.viewUrl||(m?(m.external?'/view/ext/'+m.id:'/view/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/')):null);
      if(link){
        var pct=Math.min(100,Math.round(e.pos/e.dur*100));
        html+='<section class="row"><h2>▶ Continue Watching</h2><div style="background:#0c1410;border:1px solid #1e3a2a;border-radius:14px;padding:14px 16px;display:flex;gap:14px;align-items:center"><div style="flex:1;min-width:0"><b style="font-size:1.05rem">'+e.title+'</b><div style="color:#7a9a85;font-size:.85rem;margin-top:2px">'+fmtLeft(e.dur-e.pos)+' · resume at '+fmtClock(e.pos)+'</div><div style="height:5px;background:#1e3a2a;border-radius:3px;margin-top:8px"><div style="height:5px;width:'+pct+'%;background:#00e676;border-radius:3px"></div></div></div><a class="btn btn-play" href="'+link+'?start='+Math.floor(e.pos)+'">▶ Resume</a></div></section>';
      }
    }
    var recent=entries.slice(0,12).map(function(e){
      var m=byId[e.id];
      var link=e.viewUrl||(m?(m.external?'/view/ext/'+m.id:'/view/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/')):null);
      if(!link)return '';
      var pct=Math.min(100,Math.round(e.pos/e.dur*100));
      var poster=e.poster?(e.poster.startsWith('http')?e.poster:IMG+e.poster):(m&&m.poster?(m.poster.startsWith('http')?m.poster:IMG+m.poster):'');
      var p=poster?'<img loading="lazy" src="'+escH(poster)+'" alt="" style="width:110px;height:165px;object-fit:cover;border-radius:8px">':'<div style="width:110px;height:165px;display:flex;align-items:center;justify-content:center;font-size:2rem;background:#0a120c;border-radius:8px">🎬</div>';
      return '<a href="'+link+'?start='+Math.floor(e.pos)+'" style="text-decoration:none;color:inherit;flex:0 0 110px">'+p+'<div style="padding:6px 2px"><b style="font-size:.8rem;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escH(e.title)+'</b><span style="font-size:.72rem;color:#7a9a85">'+(e.done?'✓ Watched':fmtLeft(e.dur-e.pos))+'</span><div style="height:4px;background:#1e3a2a;border-radius:2px;margin-top:4px"><div style="height:4px;width:'+pct+'%;background:#00e676;border-radius:2px"></div></div></div></a>';
    }).join('');
    if(recent)html+='<section class="row"><h2>⏱ Recently Played</h2><div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:10px">'+recent+'</div></section>';
    if(html){
      var main=$('main');
      main.innerHTML=html+main.innerHTML;
    }
  }catch(e){}
}
function escH(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function card(m){
  const p=m.poster?'<img loading="lazy" src="'+escH(m.poster.startsWith('http')?m.poster:IMG+m.poster)+'" alt="">':'<div class="noposter">'+(m.type==='song'?'🎵':'🎬')+'</div>';
  const js=JSON.stringify(m).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  return '<div class="card" onclick="openModal('+js+')">'+p+'<div class="cinfo"><b>'+escH(m.title)+'</b><span>'+(m.year||'')+' '+(m.vote?'★ '+m.vote:'')+'</span></div></div>';
}
function render(filter,q){
  q=(q||'').toLowerCase();
  $('hero').style.display=(filter==='song'||!SLIDES.length)?'none':'flex';
  let list=ALL.filter(m=>(filter==='all'||m.type===filter)&&(!q||m.title.toLowerCase().includes(q)));
  const main=$('main');main.innerHTML='';
  if(!list.length){main.innerHTML='<div class="empty">Nothing found.</div>';return;}
  const movies=list.filter(m=>m.type!=='song'), songs=list.filter(m=>m.type==='song');
  const mk=(t,arr)=>{if(!arr.length)return '';return '<section class="row"><h2>'+t+'</h2><div class="cards">'+arr.map(card).join('')+'</div></section>';};
  if(filter==='all'){main.innerHTML=mk('🎬 Movies',movies)+mk('🎵 Video Songs',songs);}
  else main.innerHTML=mk(filter==='movie'?'🎬 Movies':filter==='series'?'📺 TV Series':'🎵 Video Songs',list);
  main.style.paddingTop=$('hero').style.display==='none'?'90px':'20px';
}
function doSearch(q){const f=document.querySelector('nav a.on').dataset.f;render(f,q);}
document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>{document.querySelectorAll('nav a').forEach(x=>x.classList.remove('on'));a.classList.add('on');$('q').value='';render(a.dataset.f,'');});
function openModal(m){
  $('mhero').style.backgroundImage=m.backdrop?'url('+BG+m.backdrop+')':(m.poster&&m.poster.startsWith('http')?'url('+m.poster+')':'none');
  var genres=(m.genres||[]).map(function(g){return '<span>'+escH(g)+'</span>';}).join('');
  var vurl=m.external?'/view/ext/'+m.id:'/view/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/');
  var durl=m.external?'/download/ext/'+m.id:'/dl/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/');
  $('minfo').innerHTML='<h2>'+escH(m.title)+'</h2><div class="mmeta"><span class="rate">★ '+(m.vote||'—')+'</span><span>'+(m.year||'')+'</span><span>'+(m.type==='song'?'Video Song':m.type==='series'?'TV Series':'Movie')+'</span>'+(m.episodes&&m.episodes.length?'<span>'+m.episodes.length+' Episodes</span>':'')+'</div><p>'+escH(m.overview||'No overview available.')+'</p><div class="genres">'+genres+'</div><div class="hero-btns"><a class="btn btn-play" href="'+vurl+'">▶ Play</a>'+(m.type==='series'?'':'<a class="btn btn-info" href="'+durl+'">⭳ Download</a>')+'</div>';
  $('modal').classList.add('open');
}
function closeModal(){$('modal').classList.remove('open');}
$('modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
load();loadSync();
(function(){try{var pid=null;try{pid=localStorage.getItem("presence-id");}catch(e){}if(!pid){pid=(crypto.randomUUID?crypto.randomUUID():("v-"+Date.now()+"-"+Math.random().toString(36).slice(2)));try{localStorage.setItem("presence-id",pid);}catch(e){}}function beat(){try{fetch("/api/presence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:pid,kind:"browsing"})}).catch(function(){});}catch(e){}}beat();setInterval(beat,30000);}catch(e){}})();
</script><footer style="text-align:center;padding:28px 12px 36px;color:#5f7a68;font-size:.85rem">👀 __VIEWS_TODAY__ viewers today<br><span style="font-size:.75rem">Movie &amp; TV data by <a href="https://www.themoviedb.org/" target="_blank" rel="noopener" style="color:#5f7a68">TMDB</a> <img src="https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg" alt="TMDB" style="height:12px;vertical-align:-2px"></span><br><span style="font-size:.62rem;color:#3d4a3a">This product uses the TMDB API but is not endorsed or certified by TMDB.</span></footer><script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script>${ADBLOCK_WALL}</body></html>`;

// ---- TMDB helpers ----
function toDirectUrlSrv(u){
  u = (u || "").trim();
  const i = u.indexOf("drive.google.com/file/d/");
  if (i >= 0) { const id = u.slice(i + 24).split("/")[0].split("?")[0]; if (id) return "https://drive.google.com/uc?export=download&id=" + id; }
  if (u.indexOf("drive.google.com") >= 0) { const p = u.split("id="); if (p.length > 1) { const id2 = p[1].split("&")[0]; if (id2) return "https://drive.google.com/uc?export=download&id=" + id2; } }
  if (u.indexOf("dropbox.com") >= 0 && u.indexOf("dl=0") >= 0) return u.split("?dl=0")[0] + "?raw=1";
  return u;
}
async function getExtMovies(store){
  try { return await store.get("ext:movies") || {}; } catch(e) { return {}; }
}
async function saveExtMovies(store, obj){
  await store.put("ext:movies", obj);
}
// ---- Approval queue (Phase 1) ----
// Pending discoveries live in DATA_KV key "ext:pending" — a SEPARATE key
// from the live catalogue ("ext:movies"). No public route reads it:
// /api/movies, the homepage, /sitemap.xml and the app feed all read
// listMovies(), which only merges R2 buckets + ext:movies — so pending
// and rejected candidates are invisible to visitors by construction.
// Approval is the only path into the live catalogue.
async function getPending(env){
  try { return await env.DATA_KV.get("ext:pending", "json") || {}; } catch(e) { return {}; }
}
async function savePending(env, obj){
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
  return { enabled: false, frequency: "daily", sources: { tmdb: true, trending: true, upcoming: false, tvmaze: false }, budget: { maxNewPerRun: 15, maxDetailCalls: 30 }, lastRun: null, lastSuccess: null, totals: { discovered: 0, approved: 0, rejected: 0 }, nextRunAt: null };
}
function mergeDiscoveryState(s){
  const d = defaultDiscoveryState();
  if (s && typeof s === "object") return { ...d, ...s, sources: { ...d.sources, ...(s.sources || {}) }, budget: { ...d.budget, ...(s.budget || {}) }, totals: { ...d.totals, ...(s.totals || {}) } };
  return d;
}
async function getDiscoveryState(env){
  try { return mergeDiscoveryState(await env.DATA_KV.get("ext:discovery:state", "json")); } catch (e) { return defaultDiscoveryState(); }
}
// Strict reads — recovery and admin writes. Unlike getPending/getSeen/
// getDiscoveryState/getExtMovies (which swallow KV errors and return
// fallbacks), these throw, so a failed read aborts instead of writing
// a fallback over real data. A fallback {} or defaults must never be
// treated as genuine data: saving it would erase the real seen-map,
// reset the real discovery configuration, or wipe the live catalogue
// / approval queue (G1, 2026-11-13).
async function getPendingStrict(env){
  try { return await env.DATA_KV.get("ext:pending", "json") || {}; }
  catch (e) { e.code = "KV_READ_FAILED"; throw e; }
}
async function getSeenStrict(env){
  try { return await env.DATA_KV.get("ext:discovery:seen", "json") || {}; }
  catch (e) { e.code = "KV_READ_FAILED"; throw e; }
}
async function getExtMoviesStrict(store){
  let v;
  try { v = await store.get("ext:movies"); }
  catch (e) { e.code = "STORE_READ_FAILED"; throw e; }
  // Fail closed: a missing catalogue key is NOT an empty catalogue.
  // A legitimately empty catalogue is stored as {} (present). A
  // missing key means the migration has not seeded DO storage yet,
  // and every catalogue write must refuse rather than start from {}.
  if (v == null) { const e = new Error("catalogue not seeded"); e.code = "CATALOGUE_NOT_SEEDED"; throw e; }
  return v;
}
// KV source read for the migration endpoint only. The catalogue no
// longer lives in KV; this helper reads the pre-migration KV value so
// the migration endpoint can copy it into DO storage.
async function getExtMoviesKVStrict(env){
  let v;
  try { v = await env.DATA_KV.get("ext:movies", "json"); }
  catch (e) { e.code = "KV_READ_FAILED"; throw e; }
  // Fail closed (correction pass 2026-11-14): a missing KV source is
  // NOT an empty catalogue — the old `|| {}` let migration seed an
  // empty DO catalogue from nothing. A missing key, or a present value
  // that is not a catalogue object, is a hard migration failure. The
  // ONLY empty source that may migrate is an explicitly stored {} (a
  // present value); the Rev 4.1 backup reconciliation still has to
  // agree with it before any production run.
  if (v == null) { const e = new Error("migration source missing"); e.code = "KV_SOURCE_MISSING"; throw e; }
  if (typeof v !== "object" || Array.isArray(v)) { const e = new Error("migration source malformed"); e.code = "KV_SOURCE_MALFORMED"; throw e; }
  return v;
}
// True for every catalogue-read failure the routes treat as "stored
// data temporarily unreadable": a KV read failure (migration endpoint,
// discovery config), a DO-storage read failure, or a catalogue that
// has not been seeded into DO storage yet.
function isStoreReadFailure(e){
  return !!e && (e.code === "KV_READ_FAILED" || e.code === "STORE_READ_FAILED" || e.code === "CATALOGUE_NOT_SEEDED");
}
async function getDiscoveryStateStrict(env){
  try { return mergeDiscoveryState(await env.DATA_KV.get("ext:discovery:state", "json")); }
  catch (e) { e.code = "KV_READ_FAILED"; throw e; }
}
async function saveDiscoveryState(env, obj){
  await env.DATA_KV.put("ext:discovery:state", JSON.stringify(obj));
}

// ---- Catalogue freeze (F1 migration prerequisite) ----
// The flag lives in DO storage (same pattern as admin_pw/tmdb_key),
// NOT in KV. While set, every catalogue write route returns 503.
// Reads are unaffected. Returns the 503 Response if frozen, null
// otherwise. THROWS if the flag itself cannot be read (fail-closed:
// a storage failure must abort the write with 500, never proceed).
async function freezeBlock(state){
  const frozen = state && state.storage ? await state.storage.get("catalogue_frozen") : false;
  return frozen ? json({ error: "catalogue frozen for migration — try again later" }, 503) : null;
}
// Idempotent recovery for partial-write failures (review 2026-11-13).
// A discovery run persists three separate KV keys (queue, seen, state),
// not a transaction. If the queue write lands but the seen write fails,
// candidates sit in ext:pending with no seen entry (and the totals bump
// is lost). Heal that gap from the queue itself: every queued discovery
// candidate (has discoveredAt — manual candidates do not) missing from
// seen gets a seen entry in its own status (pending/rejected), and
// totals.discovered is bumped by the healed count. Safe to run any time:
// re-running finds no gaps and writes nothing.
// READ-BEFORE-WRITE (review 2026-11-13 item 1): all three reads use
// the strict variants and happen BEFORE any write. If any read fails,
// recovery aborts and writes nothing — a failed seen read must never
// erase existing entries, and a failed state read must never reset
// discovery settings. `state` is the caller's in-memory state
// object — it is kept in sync so a later finish() cannot overwrite
// the bump with a stale value; the state is re-read fresh (inside the
// lock) before saving so a concurrent admin config change is not
// clobbered.
// THROWS ON FAILURE (review 2026-11-13 round 7): this used to catch
// all errors and return 0, so a failed required read was silently
// swallowed and the run continued on its older in-memory state —
// which finish() would then save over any newer discovery config.
// Now a failed read (or write) THROWS, and both call sites let it
// propagate to runDiscovery's outer catch, which re-reads state
// fresh and records the failure there instead of saving stale state.
// Return value is the healed count: 0 is a successful no-op (reads
// fine, nothing missing) and is the ONLY non-throwing zero.
// RESIDUAL (item 2): if the seen save lands but the state save fails,
// the healed entries are recorded (seen is authoritative) but
// totals.discovered is not bumped — it undercounts by the healed
// count, and a later run cannot detect or fix that (no gap remains).
// Totals is a best-effort display counter; queue + seen are
// authoritative. No KV transaction or atomicity is claimed anywhere.
async function reconcileDiscoveryState(env, state){
  const pend = await getPendingStrict(env);
  const seen = await getSeenStrict(env);
  const fresh = await getDiscoveryStateStrict(env);
  const today = new Date().toISOString().slice(0, 10);
  let healed = 0;
  for (const c of Object.values(pend)) {
    // F1: metadata-edit proposals are not discovery candidates.
    if (c && c.kind === "meta") continue;
    if (!c || !c.tmdb || !c.discoveredAt) continue;
    const k = c.type + ":" + c.tmdb;
    if (seen[k]) continue;
    seen[k] = { type: c.type, tmdb: c.tmdb, title: c.title, firstSeen: (c.discoveredAt || "").slice(0, 10) || today, lastSeen: today, status: c.status === "rejected" ? "rejected" : "pending" };
    healed++;
  }
  if (!healed) return 0;
  await saveSeen(env, seen);
  fresh.totals.discovered = (fresh.totals.discovered || 0) + healed;
  await saveDiscoveryState(env, fresh);
  if (state) state.totals.discovered = fresh.totals.discovered;
  return healed;
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
    const seen = await getSeenStrict(env);
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
    const s = await getDiscoveryStateStrict(env);
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
    title: title.slice(0, 200), type: w.type, tmdb: w.tmdb, popularity: w.popularity || 0, sources: [],
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
}
// URL hygiene for catalogue images/sources (Phase 1 test-pass review):
// poster/backdrop must be an http(s) URL or a TMDB path — no quotes,
// angle brackets or whitespace — so they can never break out of an HTML
// attribute at any render site. Source URLs must not carry a dangerous
// scheme (javascript:/data:/vbscript:/file:); scheme-less paths (R2 keys)
// and http(s) URLs pass through.
function cleanImgUrl(u){
  if (u == null) return null;
  const s = String(u).trim();
  if (!s || /[\s"'<>]/.test(s)) return null;
  if (s[0] === "/") return s;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}
function cleanSrcUrl(u){
  if (u == null) return null;
  const s = String(u).trim();
  if (!s || /[\s"'<>]/.test(s)) return null;
  const m = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (m && !/^https?$/i.test(m[1])) return null;
  return s;
}
function normTitle(t){
  return (t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
// Duplicate check: TMDB id first, then normalized title (+ year when both
// sides know it). liveList = array from listMovies() (R2 buckets + ext);
// pendObj = pending map; excludeId skips one pending id (the candidate
// itself, on approve). Returns {where, id, title, tmdb} or null.
function findDuplicate(cand, liveList, pendObj, excludeId){
  const tmdb = cand.tmdb != null && String(cand.tmdb).trim() !== "" ? String(cand.tmdb) : null;
  const nt = normTitle(cand.title);
  const yr = cand.year ? String(cand.year) : "";
  const matchEntry = (m) => {
    if (tmdb && m.tmdb != null && String(m.tmdb) === tmdb) return true;
    if (nt && m.title && normTitle(m.title) === nt) {
      const my = m.year ? String(m.year) : "";
      if (!yr || !my || yr === my) return true;
    }
    return false;
  };
  for (const m of liveList || []) if (matchEntry(m)) return { where: "live", id: m.id || null, title: m.title, tmdb: m.tmdb != null ? m.tmdb : null };
  for (const id in (pendObj || {})) {
    if (id === excludeId) continue;
    const m = pendObj[id];
    // F1: metadata-edit proposals are not publication candidates.
    if (m && m.kind === "meta") continue;
    if (matchEntry(m)) return { where: "pending", id, title: m.title, tmdb: m.tmdb != null ? m.tmdb : null };
  }
  return null;
}
async function tmdbGet(path, apiKey){
  const r = await fetch("https://api.themoviedb.org/3"+path+(path.includes("?")?"&":"?")+"api_key="+apiKey);
  return r.ok ? await r.json() : null;
}
function cleanTitle(filename){
  // "Movie.Name.2024.1080p.WEB-DL.mp4" -> "Movie Name"
  let n = filename.split("/").pop().replace(/\.[^.]+$/,"");
  n = n.replace(/[._-]+/g," ");
  n = n.replace(/\b(1080p|720p|480p|2160p|4k|web[ -]?dl|bluray|hdts|hdtc|hdcam|dvdrip|x264|x265|hevc|aac|esub|dual.audio|hindi|bangla|english)\b/gi,"");
  n = n.replace(/\b(19|20)\d{2}\b/,"").replace(/\s+/g," ").trim();
  return n;
}

// ---- Admin upload page (private, password via ?pw= or prompt) ----
const ADMIN_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — Redowansky's Library</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060906;--card:#0c1410;--card2:#101b14;--line:#1e3a2a;--grn:#00e676;--grn2:#00c853;--txt:#e8f5e9;--mut:#7a9a85;--red:#ff7b7b}
body{background:var(--bg);color:var(--txt);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
.wrap{display:flex;min-height:100vh}
nav{width:210px;background:var(--card);border-right:1px solid var(--line);padding:22px 14px;flex-shrink:0;position:sticky;top:0;height:100vh}
nav h2{font-size:1rem;padding:0 10px 18px;color:var(--grn)}
nav button{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;color:var(--mut);padding:12px 10px;border-radius:10px;font-size:.92rem;cursor:pointer;text-align:left}
nav button:hover{background:var(--card2);color:var(--txt)}
nav button.on{background:var(--card2);color:var(--grn)}
main{flex:1;padding:28px;max-width:860px}
.sec{display:none}.sec.on{display:block}
.sec h1{font-size:1.5rem;margin-bottom:4px}
.sec .desc{color:var(--mut);font-size:.88rem;margin-bottom:22px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.card .v{font-size:1.6rem;font-weight:800;color:var(--grn)}
.card .l{color:var(--mut);font-size:.8rem;margin-top:4px}
input,select{background:var(--bg);border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:11px 14px;font-size:.92rem;width:100%}
label{display:block;color:var(--mut);font-size:.82rem;margin:14px 0 6px}
.btn{background:var(--grn2);border:none;color:#fff;border-radius:10px;padding:11px 22px;font-weight:700;cursor:pointer;font-size:.92rem}
.btn:hover{filter:brightness(1.1)}
.btn.ghost{background:var(--card2);border:1px solid var(--line);color:var(--txt)}
.btn.danger{background:none;border:1px solid var(--red);color:var(--red)}
.row{display:flex;gap:10px;align-items:center}
#drop{border:2px dashed var(--line);border-radius:14px;padding:40px 20px;text-align:center;color:var(--mut);margin-top:14px;cursor:pointer}
#drop.over{border-color:var(--grn);color:var(--txt)}
.prog{height:6px;background:var(--bg);border-radius:3px;margin-top:10px;overflow:hidden;display:none}
.prog div{height:100%;background:var(--grn);width:0%}
#ulog{margin-top:14px;font-size:.85rem}
#ulog div{padding:6px 0;border-bottom:1px solid var(--line)}
.ok{color:var(--grn)}.bad{color:var(--red)}
.shelfrow,.filerow{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 16px;margin-bottom:8px}
.shelfrow .nm,.filerow .nm{flex:1;font-size:.93rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filerow .sz{color:var(--mut);font-size:.78rem;white-space:nowrap}
.filerow .fold{color:var(--mut);font-size:.78rem}
.iconbtn{background:none;border:none;color:var(--mut);cursor:pointer;font-size:1.1rem;padding:6px}
.iconbtn:hover{color:var(--grn)}
.menu{position:absolute;background:var(--card2);border:1px solid var(--line);border-radius:12px;min-width:170px;z-index:50;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden}
.menu button{display:block;width:100%;background:none;border:none;color:var(--txt);padding:11px 16px;font-size:.88rem;cursor:pointer;text-align:left}
.menu button:hover{background:var(--line)}
.menu button.red{color:var(--red)}
.foldhead{color:var(--grn);font-size:.85rem;font-weight:700;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.5px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:100;padding:20px}
.modal.on{display:flex}
.modal .box{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px;width:100%;max-width:420px}
.modal h3{margin-bottom:6px}
.modal .desc{color:var(--mut);font-size:.85rem;margin-bottom:14px}
.pwbar{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:22px}
.pwbar .row input{flex:1}
@media(max-width:700px){nav{width:60px;padding:16px 8px}nav h2{display:none}nav button span{display:none}nav button{justify-content:center}main{padding:18px}}
</style></head><body>
<div class="wrap">
<nav>
<h2>◈ Library Admin</h2>
<button data-s="dash" class="on">📊 <span>Dashboard</span></button>
<button data-s="pending">⏳ <span>Approval Queue</span></button>
<button data-s="discovery">🔭 <span>Discovery</span></button>
<button data-s="settings">⚙️ <span>Settings</span></button>
</nav>
<main>
<!-- LOGIN -->
<div class="sec on" id="s-login">
<h1>🔐 Admin Login</h1><p class="desc">Enter your admin password to continue.</p>
<div class="pwbar"><div class="row"><input type="password" id="pw" placeholder="admin password" autocomplete="off"><button class="btn" id="loginBtn">Unlock</button></div>
<div id="loginMsg" style="margin-top:10px;font-size:.85rem"></div></div>
</div>
<!-- DASHBOARD -->
<div class="sec" id="s-dash">
<h1>📊 Dashboard</h1><p class="desc">System status and storage overview.</p>
<div class="cards">
<div class="card"><div class="v" id="st-tunnel">…</div><div class="l">Tunnel</div></div>
<div class="card"><div class="v" id="st-viewers">…</div><div class="l">👀 Visits today · GoatCounter</div></div>
<div class="card"><div class="v" id="st-visits">…</div><div class="l">Visits today</div></div>
<div class="card"><div class="v" id="st-total">…</div><div class="l">Total visits</div></div>
</div>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<h3 style="margin-bottom:8px">👥 Users Online Now: <span id="st-online">…</span></h3>
<div id="st-online-split" style="color:#7a9a85;font-size:.85rem;margin-bottom:8px"></div>
<div id="st-watching" style="font-size:.9rem;line-height:1.6"></div>
</div>
</div>
<!-- APPROVAL QUEUE -->
<div class="sec" id="s-pending">
<h1>⏳ Approval Queue</h1><p class="desc">Discovered titles wait here until you approve them. Pending and rejected entries never appear on the site, in the app feed, or in the sitemap — only approved ones join the live catalogue.</p>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<h4 style="margin-bottom:10px">➕ Add a candidate</h4>
<input id="pendTitle" placeholder="Title *" style="width:100%;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<div style="display:flex;gap:8px;margin-top:8px">
<input id="pendYear" placeholder="Year" style="width:90px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<select id="pendType" style="background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px"><option value="movie">Movie</option><option value="series">TV Series</option></select>
<input id="pendTmdb" placeholder="TMDB ID (optional — fills poster & info)" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
</div>
<input id="pendPoster" placeholder="Poster URL (optional)" style="width:100%;margin-top:8px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<textarea id="pendOverview" placeholder="Overview (optional)" rows="2" style="width:100%;margin-top:8px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px"></textarea>
<div style="display:flex;gap:8px;margin-top:8px">
<input id="pendSrcLabel" placeholder="Source label" value="Source 1" style="width:110px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<input id="pendSrcUrl" placeholder="Playback source URL (optional)" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
</div>
<div style="display:flex;gap:10px;align-items:center;margin-top:10px">
<button class="btn" onclick="addPending()">Add to queue</button>
<span id="pendMsg" style="font-size:.85rem"></span>
</div>
</div>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<h4 style="margin-bottom:10px">✏️ Propose a metadata edit</h4>
<p class="desc" style="margin-bottom:10px">Change the title or poster of a live entry. Nothing changes until you approve the proposal below — the entry stays exactly as it is until then.</p>
<div style="display:flex;gap:8px">
<input id="metaQ" placeholder="Search live entries by title or id…" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<button class="btn" onclick="metaSearch()">Search</button>
</div>
<div id="metaResults" style="margin-top:8px"></div>
<input id="metaTargetId" placeholder="Entry id (or pick from search above)" style="width:100%;margin-top:8px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<div id="metaCurrent" style="margin-top:8px;font-size:.85rem;color:#7a9a85"></div>
<input id="metaTitle" placeholder="New title (leave blank to keep)" style="width:100%;margin-top:8px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<input id="metaPoster" placeholder="New poster URL (leave blank to keep)" style="width:100%;margin-top:8px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<div style="display:flex;gap:10px;align-items:center;margin-top:10px">
<button class="btn" onclick="proposeMeta()">Propose edit</button>
<span id="metaMsg" style="font-size:.85rem"></span>
</div>
</div>
<div style="display:flex;gap:8px;margin-bottom:12px">
<button class="btn" id="pendTabP" onclick="pendTab('pending')">⏳ Pending (<span id="pendCountP">0</span>)</button>
<button class="btn ghost" id="pendTabM" onclick="pendTab('meta')">✏️ Metadata edits (<span id="pendCountM">0</span>)</button>
<button class="btn ghost" id="pendTabR" onclick="pendTab('rejected')">✖ Rejected (<span id="pendCountR">0</span>)</button>
</div>
<div id="pendList"></div>
</div>
<!-- DISCOVERY -->
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
<!-- SETTINGS -->
<div class="sec" id="s-settings">
<h1>⚙️ Settings</h1><p class="desc">Admin panel preferences.</p>
<div class="pwbar">
<p style="color:#7a9a85;font-size:.9rem">Password is managed securely — ask Pepper to change it.</p>
</div>
<div class="pwbar"><button class="btn danger" id="lockBtn">🔒 Lock Panel</button></div>
</div>
</main></div>
<!-- modal -->
<div class="modal" id="modal"><div class="box"><h3 id="mTitle"></h3><p class="desc" id="mDesc"></p><div id="mBody"></div>
<div class="row" style="margin-top:18px;justify-content:flex-end"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">OK</button></div></div></div>
<script>
const $=id=>document.getElementById(id);
let authed=false;
function api(p,o={}){return fetch(p,o);}
function fmt(n){if(!n&&n!==0)return "—";const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return n.toFixed(n<10&&i>0?1:0)+" "+u[i];}
function safeName(n){const d=n.lastIndexOf(".");const e=d>0?n.slice(d):"";let b=d>0?n.slice(0,d):n;
b=b.normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"file";return b+e;}
// nav
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{if(!authed)return;
document.querySelectorAll("nav button").forEach(x=>x.classList.remove("on"));b.classList.add("on");
document.querySelectorAll(".sec").forEach(s=>s.classList.remove("on"));$("s-"+b.dataset.s).classList.add("on");
if(b.dataset.s==="dash")loadDash();if(b.dataset.s==="files")loadFiles();if(b.dataset.s==="pending")loadPending();if(b.dataset.s==="discovery")loadDiscovery();});
// ---- Approval queue ----
let pendTabCur="pending", pendCache={pending:[],meta:[],rejected:[]};
function pendEsc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
function pendImgUrl(p){if(!p)return "";var s=String(p);if(/[\\s"'<>]/.test(s))return "";if(s.indexOf("http")===0)return s;if(s.charAt(0)==="/")return "https://image.tmdb.org/t/p/w185"+s;return "";}
async function loadPending(){
  const box=document.getElementById("pendList"); if(!box)return;
  box.innerHTML="<p style='color:#7a9a85'>loading queue…</p>";
  const r=await api("/api/admin/pending?pw="+encodeURIComponent(pw()));
  const d=await r.json().catch(()=>({}));
  if(!r.ok){box.innerHTML="<p style='color:#ff9a9a'>Could not load the queue.</p>";return;}
  const all=(d.pending||[]).concat(d.rejected||[]);
  const pubs=all.filter(function(c){return c.kind!=="meta";});
  const metas=all.filter(function(c){return c.kind==="meta";});
  pendCache={pending:pubs.filter(function(c){return c.status==="pending";}),meta:metas.filter(function(c){return c.status==="pending";}),rejected:pubs.filter(function(c){return c.status==="rejected";}).concat(metas.filter(function(c){return c.status==="rejected";}))};
  document.getElementById("pendCountP").textContent=pendCache.pending.length;
  document.getElementById("pendCountM").textContent=pendCache.meta.length;
  document.getElementById("pendCountR").textContent=pendCache.rejected.length;
  renderPend();
}
function pendTab(t){pendTabCur=t;document.getElementById("pendTabP").className=t==="pending"?"btn":"btn ghost";document.getElementById("pendTabM").className=t==="meta"?"btn":"btn ghost";document.getElementById("pendTabR").className=t==="rejected"?"btn":"btn ghost";renderPend();}
function renderPend(){
  const box=document.getElementById("pendList"); if(!box)return;
  const list=pendCache[pendTabCur]||[];
  if(!list.length){box.innerHTML="<p style='color:#7a9a85;font-size:.85rem'>"+(pendTabCur==="pending"?"Nothing waiting for approval.":pendTabCur==="meta"?"No metadata edits waiting for approval.":"No rejected candidates.")+"</p>";return;}
  box.innerHTML=list.map(function(c){
    if(c.kind==="meta"){
      const ch=c.changes||{};
      const exp=c.expected||{};
      const oldT=(exp.title!=null?exp.title:(c.targetTitle||""));
      const newT=ch.title!=null?ch.title:"";
      const oldP=(exp.poster!=null?exp.poster:"");
      const newP=ch.poster!=null?ch.poster:"";
      const oldPu=pendImgUrl(oldP);const newPu=pendImgUrl(newP);
      const oldImg=oldPu?("<img src='"+pendEsc(oldPu)+"' style='width:46px;border-radius:6px' onerror='this.remove()'>"):"<span style='color:#7a9a85'>(none)</span>";
      const newImg=newPu?("<img src='"+pendEsc(newPu)+"' style='width:46px;border-radius:6px' onerror='this.remove()'>"):"<span style='color:#7a9a85'>(none)</span>";
      const fieldList=[ch.title!=null?"Title":null,ch.poster!=null?"Poster":null].filter(Boolean).join(" + ");
      const det="<div id='pd-"+c.id+"' style='display:none;margin-top:8px;padding:10px;background:#060906;border-radius:8px;font-size:.85rem;line-height:1.6'>"
        +"<div><b>Target:</b> "+pendEsc(c.targetId||"")+" — "+pendEsc(c.targetTitle||"")+" · "+new Date(c.createdAt||0).toLocaleString()+"</div>"
        +(ch.title!=null?"<div style='margin-top:6px'><b>Title:</b> "+pendEsc(oldT)+" → <b>"+pendEsc(newT)+"</b></div>":"")
        +(ch.poster!=null?"<div style='margin-top:6px'><b>Poster:</b><div style='display:flex;gap:12px;align-items:center;margin-top:4px'><span>Current<br>"+oldImg+"</span><span>Proposed<br>"+newImg+"</span></div></div>":"")
        +"</div>";
      const btns=pendTabCur==="meta"
        ?"<button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='"+c.id+"' onclick='approvePending(this)'>✓ Approve edit</button><button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='"+c.id+"' onclick='rejectPending(this)'>✖ Reject</button>"
        :"";
      return "<div style='padding:10px;background:#0a120c;border:1px solid #1e3a2a;border-radius:10px;margin-bottom:8px'><div style='display:flex;gap:10px;align-items:center;flex-wrap:wrap'><span style='font-size:.95rem'>✏️ <b>Metadata edit</b></span><span style='flex:1;font-size:.85rem;color:#7a9a85;min-width:140px'>"+pendEsc(fieldList)+" · "+pendEsc(c.targetTitle||"")+"</span><button class='btn ghost' style='padding:6px 12px;font-size:.8rem' data-id='"+c.id+"' onclick='togglePend(this)'>Inspect</button>"+btns+"<button class='btn danger' style='padding:6px 12px;font-size:.8rem' data-id='"+c.id+"' onclick='deletePending(this)'>Delete</button></div>"+det+"</div>";
    }
    const pu=pendImgUrl(c.poster);const poster=pu?("<img src='"+pendEsc(pu)+"' style='width:46px;border-radius:6px' onerror='this.remove()'>"):"";
    const srcs=(c.sources||[]).map(function(s){return "<div style='font-size:.82rem;color:#7a9a85'>🔗 "+pendEsc(s.label||"Source")+" — "+pendEsc(s.url)+"</div>";}).join("");
    const srcRows=(c.sources||[]).map(function(s){return "<div class='psrow' style='display:flex;gap:6px;margin-bottom:6px'><input class='pslabel' placeholder='Label' value='"+pendEsc(s.label||"")+"' style='width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px'><input class='psurl' placeholder='Paste playback URL…' value='"+pendEsc(s.url||"")+"' style='flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px'><button class='btn danger' style='padding:6px 10px;font-size:.8rem' onclick='delPendSrcRow(this)'>✕</button></div>";}).join("");
    const det="<div id='pd-"+c.id+"' style='display:none;margin-top:8px;padding:10px;background:#060906;border-radius:8px;font-size:.85rem;line-height:1.6'>"
      +"<div><b>TMDB:</b> "+pendEsc(c.tmdb||"—")+" · <b>Type:</b> "+pendEsc(c.type)+" · <b>Found via:</b> "+pendEsc(c.discoveredVia||"—")+" · "+new Date(c.createdAt||0).toLocaleString()+(c.discoveredAt?" · discovered "+new Date(c.discoveredAt).toLocaleString():"")+"</div>"
      +(c.providers?"<div style='margin-top:6px'>"+provLine(c.providers)+"</div>":"")
      +(c.overview?"<div style='margin-top:6px'>"+pendEsc(c.overview)+"</div>":"")
      +(srcs||"<div style='color:#7a9a85'>No playback source attached yet — approval needs one.</div>")
      +(pendTabCur==="pending"?"<div style='margin-top:10px'><b>Playback sources</b> <span style='color:#7a9a85'>(edit, then Save — the server re-checks every URL)</span><div id='ps-"+c.id+"' style='margin-top:6px'>"+srcRows+"</div><button class='btn' style='padding:6px 12px;font-size:.8rem;margin-top:4px' data-id='"+c.id+"' onclick='addPendSrcRow(this)'>+ Add source</button> <button class='btn' style='padding:6px 12px;font-size:.8rem;margin-top:4px' data-id='"+c.id+"' onclick='savePendSources(this)'>Save sources</button> <span id='psmsg-"+c.id+"' style='font-size:.82rem'></span></div>":"")
      +(c.note?"<div style='margin-top:6px;color:#7a9a85'>Note: "+pendEsc(c.note)+"</div>":"")
      +"</div>";
    const noSrc=!(c.sources||[]).length;
    const btns=pendTabCur==="pending"
      ?"<button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='" + c.id + "' onclick='approvePending(this)'"+(noSrc?" disabled title='Add a playback source first'":"")+">✓ Approve</button><button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='" + c.id + "' onclick='rejectPending(this)'>✖ Reject</button>"
      :"";
    return "<div style='padding:10px;background:#0a120c;border:1px solid #1e3a2a;border-radius:10px;margin-bottom:8px'><div style='display:flex;gap:10px;align-items:center;flex-wrap:wrap'>"+poster+"<span style='flex:1;font-size:.95rem;min-width:140px'><b>"+pendEsc(c.title)+"</b> <span style='color:#7a9a85'>"+pendEsc(c.year||"")+" · "+pendEsc(c.type)+(c.tmdb?" · TMDB "+pendEsc(c.tmdb):"")+" · "+(c.sources||[]).length+" source"+((c.sources||[]).length===1?"":"s")+(c.needsSource?" · <span style='color:#ffb74d'>needs a playback source</span>":"")+"</span></span><button class='btn ghost' style='padding:6px 12px;font-size:.8rem' data-id='" + c.id + "' onclick='togglePend(this)'>Inspect</button>"+btns+"<button class='btn danger' style='padding:6px 12px;font-size:.8rem' data-id='" + c.id + "' onclick='deletePending(this)'>Delete</button></div>"+det+"</div>";
  }).join("");
}
function togglePend(btn){var e=document.getElementById("pd-"+btn.dataset.id);if(e)e.style.display=e.style.display==="none"?"block":"none";}
async function addPending(force){
  const msg=document.getElementById("pendMsg");
  const title=document.getElementById("pendTitle").value.trim();
  if(!title){msg.innerHTML='<span class="bad">Title is required</span>';return;}
  const srcUrl=document.getElementById("pendSrcUrl").value.trim();
  const body={title,year:document.getElementById("pendYear").value.trim()||null,type:document.getElementById("pendType").value,tmdb:document.getElementById("pendTmdb").value.trim()||null,poster:document.getElementById("pendPoster").value.trim()||null,overview:document.getElementById("pendOverview").value.trim()||null,sources:srcUrl?[{label:document.getElementById("pendSrcLabel").value.trim()||"Source 1",url:srcUrl}]:[]};
  if(force)body.force=true;
  msg.textContent="adding…";
  const r=await api("/api/admin/pending?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(r.ok){msg.innerHTML='<span class="ok">✓ queued: '+pendEsc(d.title)+'</span>';document.getElementById("pendTitle").value="";document.getElementById("pendYear").value="";document.getElementById("pendTmdb").value="";document.getElementById("pendPoster").value="";document.getElementById("pendOverview").value="";document.getElementById("pendSrcUrl").value="";loadPending();return;}
  if(r.status===409&&d.duplicate){msg.innerHTML='<span class="bad">⚠ Duplicate of '+pendEsc(d.duplicate.title)+' ('+pendEsc(d.duplicate.where)+')</span> <button class="btn" style="padding:4px 12px;font-size:.8rem" onclick="addPending(true)">Add anyway</button>';return;}
  msg.innerHTML='<span class="bad">✗ '+(d.error||"failed")+'</span>';
}
async function approvePending(btn){const id=btn.dataset.id;
  const cand=(pendCache.meta||[]).concat(pendCache.rejected||[]).find(function(c){return c.id===id;});
  const isMeta=!!(cand&&cand.kind==="meta");
  const r=await api("/api/admin/pending/approve?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){
    if(isMeta){alert("✓ Updated: "+(d.title||"")+" — metadata changed on the existing entry"+(d.already?" (already applied)":"")+(d.pendingCleanup?" — note: the queue entry could not be removed, tap Approve again to clear it":""));}
    else{alert("✓ Published: "+(d.title||"")+(d.already?" (was already live)":"")+(d.pendingCleanup?" — note: the queue entry could not be removed, tap Approve again to clear it":"")+" — now live at /view/ext/"+d.id);}
    loadPending();return;
  }
  if(r.status===409&&d.error==="stale proposal"){alert("This edit is out of date — the entry changed since the proposal was made. Delete it and propose again.");loadPending();return;}
  if(r.status===409&&d.duplicate){if(confirm("Duplicate of "+(d.duplicate.title||"an existing entry")+" ("+(d.duplicate.where||"")+") — approve anyway?")){const r2=await api("/api/admin/pending/approve?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,force:true})});const d2=await r2.json().catch(()=>({}));if(r2.ok){if(isMeta){alert("✓ Updated: "+(d2.title||"")+" — metadata changed on the existing entry");}else{alert("✓ Published: "+(d2.title||"")+" — now live at /view/ext/"+d2.id);}loadPending();}else alert("✗ "+(d2.error||"failed"));}return;}
  alert("✗ "+(d.error||"failed"));
}
async function metaSearch(){
  const q=document.getElementById("metaQ").value.trim();
  const box=document.getElementById("metaResults");
  box.innerHTML="<span style='color:#7a9a85'>searching…</span>";
  const r=await api("/api/admin/entries?q="+encodeURIComponent(q)+"&pw="+encodeURIComponent(pw()));
  const d=await r.json().catch(()=>({}));
  if(!r.ok){box.innerHTML="<span style='color:#ff9a9a'>✗ "+(d.error||"failed")+"</span>";return;}
  const list=d.entries||[];
  if(!list.length){box.innerHTML="<span style='color:#7a9a85'>No matching entries.</span>";return;}
  box.innerHTML=list.map(function(e){
    return "<div style='padding:8px;background:#060906;border:1px solid #1e3a2a;border-radius:8px;margin-bottom:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap'><span style='flex:1;font-size:.9rem'><b>"+pendEsc(e.title)+"</b> <span style='color:#7a9a85'>"+pendEsc(e.id)+" · "+pendEsc(e.type)+(e.unlisted?" · unlisted":"")+"</span></span><button class='btn' style='padding:4px 12px;font-size:.8rem' data-id='"+pendEsc(e.id)+"' data-title='"+pendEsc(e.title)+"' onclick='metaPick(this)'>Use this entry</button></div>";
  }).join("");
}
function metaPick(btn){
  document.getElementById("metaTargetId").value=btn.dataset.id;
  document.getElementById("metaCurrent").textContent="Editing: "+btn.dataset.title+" ("+btn.dataset.id+")";
  document.getElementById("metaTitle").value="";
  document.getElementById("metaPoster").value="";
}
async function proposeMeta(){
  const msg=document.getElementById("metaMsg");
  const targetId=document.getElementById("metaTargetId").value.trim();
  if(!targetId){msg.innerHTML='<span class="bad">Pick an entry first (search above, or paste its id)</span>';return;}
  const changes={};
  const t=document.getElementById("metaTitle").value.trim();
  const p=document.getElementById("metaPoster").value.trim();
  if(t)changes.title=t;
  if(p)changes.poster=p;
  if(!Object.keys(changes).length){msg.innerHTML='<span class="bad">Change the title or the poster (or both)</span>';return;}
  msg.textContent="proposing…";
  const r=await api("/api/admin/pending/meta?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetId,changes})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){msg.innerHTML='<span class="ok">✓ proposed — review it under Metadata edits below</span>';document.getElementById("metaTargetId").value="";document.getElementById("metaCurrent").textContent="";document.getElementById("metaTitle").value="";document.getElementById("metaPoster").value="";document.getElementById("metaResults").innerHTML="";loadPending();return;}
  msg.innerHTML='<span class="bad">✗ '+(d.error||"failed")+'</span>';
}
async function rejectPending(btn){const id=btn.dataset.id;
  if(!confirm("Reject this candidate? It stays in the Rejected list and never appears publicly."))return;
  const r=await api("/api/admin/pending/reject?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  if(r.ok)loadPending();else alert("✗ failed");
}
async function deletePending(btn){const id=btn.dataset.id;
  if(!confirm("Delete this candidate permanently?"))return;
  const r=await api("/api/admin/pending/delete?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
  if(r.ok)loadPending();else alert("✗ failed");
}
function addPendSrcRow(btn){var box=document.getElementById("ps-"+btn.dataset.id);if(!box)return;var div=document.createElement("div");div.className="psrow";div.style.cssText="display:flex;gap:6px;margin-bottom:6px";div.innerHTML='<input class="pslabel" placeholder="Label" style="width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px"><input class="psurl" placeholder="Paste playback URL…" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:8px"><button class="btn danger" style="padding:6px 10px;font-size:.8rem" onclick="delPendSrcRow(this)">✕</button>';box.appendChild(div);}
function delPendSrcRow(btn){var r=btn.closest(".psrow");if(r)r.remove();}
async function savePendSources(btn){const id=btn.dataset.id;var box=document.getElementById("ps-"+id);var msg=document.getElementById("psmsg-"+id);var rows=box?box.querySelectorAll(".psrow"):[];var sources=[];for(var i=0;i<rows.length;i++){var u=rows[i].querySelector(".psurl").value.trim();if(!u)continue;sources.push({label:rows[i].querySelector(".pslabel").value.trim()||("Source "+(sources.length+1)),url:u});}if(msg)msg.textContent="saving…";const r=await api("/api/admin/pending/sources?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,sources})});const d=await r.json().catch(()=>({}));if(r.ok){if(msg)msg.innerHTML='<span class="ok">✓ saved '+(d.sources||[]).length+' source(s) — review them, then Approve.</span>';loadPending();return;}if(msg)msg.innerHTML='<span class="bad">✗ '+(d.error||"failed")+'</span>';}
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
      +"<div>Fetched "+(c.fetched||0)+(c.bySource?" ("+Object.keys(c.bySource).map(function(k){return pendEsc(k)+" "+c.bySource[k];}).join(" · ")+")":"")+" · new candidates "+(c.newCandidates||0)+" · duplicates "+(c.duplicates||0)+" · skipped "+(c.skipped||0)+" · failed "+(c.failed||0)+" · "+(last.durationMs||0)+"ms</div>"
      +(last.error?"<div style='color:#ff9a9a'>"+pendEsc(last.error)+"</div>":"")
      +(s.lastSuccess?"<div style='color:#7a9a85'>Last successful run: "+new Date(s.lastSuccess.at||0).toLocaleString()+" · via "+pendEsc(s.lastSuccess.trigger||"")+"</div>":"");
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
// login
async function login(){const pw=$("pw").value;if(!pw)return;
const r=await api("/api/admin/stats?pw="+encodeURIComponent(pw));
if(r.ok){authed=true;sessionStorage.setItem("apw",pw);
document.querySelectorAll(".sec").forEach(s=>s.classList.remove("on"));$("s-dash").classList.add("on");
document.querySelector('nav button[data-s="dash"]').classList.add("on");loadDash();}
else $("loginMsg").innerHTML='<span class="bad">✗ wrong password</span>';}
$("loginBtn").onclick=login;$("pw").onkeydown=e=>{if(e.key==="Enter")login();};
if(sessionStorage.getItem("apw")){$("pw").value=sessionStorage.getItem("apw");login();}
$("lockBtn").onclick=()=>{authed=false;sessionStorage.removeItem("apw");location.reload();};
function pw(){return sessionStorage.getItem("apw")||"";}
// dashboard
async function loadDash(){const r=await api("/api/admin/stats?pw="+encodeURIComponent(pw()));if(!r.ok)return;
const d=await r.json();
$("st-tunnel").textContent=d.tunnel==="up"?"● UP":"● DOWN";$("st-tunnel").style.color=d.tunnel==="up"?"var(--grn)":"var(--red)";

if(d.views){$("st-viewers").textContent=d.views.viewersToday;$("st-visits").textContent=d.views.hitsToday;$("st-total").textContent=d.views.totalHits;}
try{const dk2=function(off){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Dhaka",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()+off*864e5));};const gj=await(await fetch("https://redowansky.goatcounter.com/counter/TOTAL.json?start="+dk2(0)+"&end="+dk2(1))).json();if(gj&&gj.count!=null)$("st-viewers").textContent=String(gj.count).replace(/,/g,"");}catch(e){}
loadPresence();if(!window._presInt){window._presInt=setInterval(function(){if(document.getElementById("s-dash").classList.contains("on"))loadPresence();},20000);}}
async function loadPresence(){try{const r=await api("/api/admin/presence?pw="+encodeURIComponent(pw()));if(!r.ok)return;const d=await r.json();$("st-online").textContent=d.online;$("st-online-split").textContent=d.browsing+" browsing · "+d.watching+" watching";$("st-watching").innerHTML=d.titles.length?d.titles.map(function(t){return "<div>▶ "+presEsc(t.title)+" · "+t.count+"</div>";}).join(""):"<div style='color:#7a9a85'>Nobody watching right now.</div>";}catch(e){}}
function presEsc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
// upload
async function loadUpBuckets(){const el=$("upBucket");if(!el)return;const d=await (await api("/api/buckets")).json();el.innerHTML=d.buckets.map(b=>"<option>"+b+"</option>").join("");}
function ulog(m,cls){const d=document.createElement("div");if(cls)d.className=cls;d.textContent=m;const u=$("ulog");if(u)u.prepend(d);}
function uput(url,file,onp){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open("PUT",url);
x.upload.onprogress=e=>{if(e.lengthComputable)onp(e.loaded/e.total);};
x.onload=()=>res(x);x.onerror=()=>rej(new Error("network"));x.send(file);});}
async function upload(files){const bucket=$("upBucket").value;if(!bucket){ulog("create a shelf first","bad");return;}
const box=$("ulog");
for(const f of files){const sn=safeName(f.name);
const row=document.createElement("div");row.innerHTML='<div style="display:flex;justify-content:space-between;font-size:.85rem"><span>'+sn+'</span><span class="pct" style="color:var(--grn)">0%</span></div><div class="prog" style="display:block"><div></div></div>';
box.prepend(row);const fill=row.querySelector(".prog div");const pct=row.querySelector(".pct");
const url="/api/admin/upload?bucket="+encodeURIComponent(bucket)+"&key="+encodeURIComponent(sn)+"&pw="+encodeURIComponent(pw());
try{const x=await uput(url,f,p=>{const pc=Math.round(p*100);fill.style.width=pc+"%";pct.textContent=pc+"%";});
if(x.status>=200&&x.status<300){pct.textContent="✓ done";pct.className="pct ok";}
else{pct.textContent="✗ "+x.status;pct.className="pct bad";ulog("✗ "+sn+": "+x.responseText.slice(0,80),"bad");}}
catch(e){pct.textContent="✗ network";pct.className="pct bad";}}}
// files
let menuEl=null;
function closeMenu(){if(menuEl){menuEl.remove();menuEl=null;}}
document.addEventListener("click",e=>{if(menuEl&&!menuEl.contains(e.target))closeMenu();});
function showMenu(x,y,items){closeMenu();menuEl=document.createElement("div");menuEl.className="menu";menuEl.style.left=x+"px";menuEl.style.top=y+"px";
items.forEach(it=>{const b=document.createElement("button");b.textContent=it[0];if(it[2])b.classList.add("red");b.onclick=()=>{closeMenu();it[1]();};menuEl.appendChild(b);});
document.body.appendChild(menuEl);}
async function loadFiles(){const box=$("filetree");box.innerHTML="loading…";
const d=await (await api("/api/buckets")).json();
box.innerHTML="";
for(const b of d.buckets){const h=document.createElement("div");h.className="foldhead";h.textContent="📦 "+b;box.appendChild(h);
const l=await (await api("/api/list?bucket="+encodeURIComponent(b))).json();
const items=[...l.prefixes.map(p=>({folder:1,key:p})),...l.objects];
if(!items.length){box.innerHTML+='<div style="color:var(--mut);font-size:.85rem;padding:4px 0 8px">empty</div>';continue;}
for(const it of items){if(it.folder)continue;
const nm=it.key.split("/").pop();
const row=document.createElement("div");row.className="filerow";
row.innerHTML='<span class="nm">📄 '+nm+'</span><span class="sz">'+fmt(it.size)+'</span>';
const mb=document.createElement("button");mb.className="iconbtn";mb.textContent="⋮";
mb.onclick=e=>{e.stopPropagation();const r=mb.getBoundingClientRect();showMenu(r.left-140,r.bottom+4,[
["ℹ️ File info",()=>fileInfo(b,it.key)],
["✏️ Rename",()=>askName("Rename file","New name",nm,v=>doRename(b,it.key,v))],
["⧉ Copy to…",()=>askShelf("Copy to shelf",nb=>doCopy(b,it.key,nb,nm))],
["➡️ Move to…",()=>askShelf("Move to shelf",nb=>doMove(b,it.key,nb,nm))],
["🗑 Delete",()=>{if(confirm("Delete "+nm+"?"))doDelete(b,it.key);},1]]);};
row.appendChild(mb);box.appendChild(row);}}}
async function fileInfo(b,key){const r=await api("/api/admin/fileinfo?bucket="+encodeURIComponent(b)+"&key="+encodeURIComponent(key)+"&pw="+encodeURIComponent(pw()));
const d=await r.json();modal("File info",nm(key),'<div style="font-size:.88rem;line-height:2">Name: <b>'+key+'</b><br>Size: <b>'+fmt(d.size)+'</b><br>Modified: <b>'+new Date(d.modified).toLocaleString()+'</b><br>Shelf: <b>'+b+'</b></div>',null);}
function nm(k){return k.split("/").pop();}
function modal(title,desc,bodyHtml,onOk){$("mTitle").textContent=title;$("mDesc").textContent=desc||"";
$("mBody").innerHTML=bodyHtml||"";$("modal").classList.add("on");
$("mOk").onclick=()=>{$("modal").classList.remove("on");if(onOk)onOk($("mBody").querySelector("input,select").value);};
$("mCancel").onclick=()=>$("modal").classList.remove("on");}
function askName(t,d,cur,cb){modal(t,d,'<input id="mIn" value="'+cur.replace(/"/g,"&quot;")+'">',v=>cb(v));}
function askShelf(t,cb){api("/api/buckets").then(r=>r.json()).then(d=>{modal(t,"",'<select id="mIn">'+d.buckets.map(b=>"<option>"+b+"</option>").join("")+"</select>",v=>cb(v));});}
async function doDelete(b,key){const r=await api("/api/admin/object?bucket="+encodeURIComponent(b)+"&key="+encodeURIComponent(key)+"&pw="+encodeURIComponent(pw()),{method:"DELETE"});
if(r.ok)loadFiles();}
async function doRename(b,key,nn){const nb=safeName(nn);const r=await api("/api/admin/rename?bucket="+encodeURIComponent(b)+"&key="+encodeURIComponent(key)+"&new="+encodeURIComponent(nb)+"&pw="+encodeURIComponent(pw()),{method:"POST"});
if(r.ok)loadFiles();}
async function doCopy(b,key,nb,nm2){const r=await api("/api/admin/copy?bucket="+encodeURIComponent(b)+"&key="+encodeURIComponent(key)+"&dest="+encodeURIComponent(nb)+"&pw="+encodeURIComponent(pw()),{method:"POST"});
if(r.ok)loadFiles();}
async function doMove(b,key,nb,nm2){const r=await api("/api/admin/move?bucket="+encodeURIComponent(b)+"&key="+encodeURIComponent(key)+"&dest="+encodeURIComponent(nb)+"&pw="+encodeURIComponent(pw()),{method:"POST"});
if(r.ok)loadFiles();}
// settings
$("pwChange").onclick=async()=>{const c=$("pwCur").value,n=$("pwNew").value,n2=$("pwNew2").value;
if(n!==n2){$("pwMsg").innerHTML='<span class="bad">new passwords don\\'t match</span>';return;}
if(n.length<4){$("pwMsg").innerHTML='<span class="bad">too short (min 4)</span>';return;}
const r=await api("/api/admin/password?pw="+encodeURIComponent(c),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({new_pw:n})});
if(r.ok){$("pwMsg").innerHTML='<span class="ok">✓ password changed</span>';sessionStorage.setItem("apw",n);$("pwCur").value=$("pwNew").value=$("pwNew2").value="";}
else $("pwMsg").innerHTML='<span class="bad">✗ '+(await r.text())+'</span>';};
// init
</script></body></html>`;
function mimeType(name){const e=name.split(".").pop().toLowerCase();const m={
mp4:"video/mp4",webm:"video/webm",mkv:"video/x-matroska",avi:"video/x-msvideo",mov:"video/quicktime",m4v:"video/x-m4v",
jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",bmp:"image/bmp",svg:"image/svg+xml",
mp3:"audio/mpeg",ogg:"audio/ogg",wav:"audio/wav",m4a:"audio/mp4",flac:"audio/flac",
pdf:"application/pdf",txt:"text/plain",json:"application/json",zip:"application/zip"};return m[e]||"application/octet-stream";}

// ---- Media viewer page ----
const VIEW_PAGE = (bucket, key, kind) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<script async src="https://ss.mrmnd.com/banner.js"></script><script async src="https://ss.mrmnd.com/static/f53498a9-9861-49d1-b571-67c892585b0a.js"></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${key.split("/").pop()} — Redowansky's Library</title>
<meta name="description" content="Watch ${key.split("/").pop()} on Redowansky's Library.">
<link rel="canonical" href="https://redowansky.bond/view/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060906;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px}
.top{width:100%;max-width:900px;display:flex;align-items:center;gap:12px;margin-bottom:16px}
.top a{color:#00e676;text-decoration:none;font-size:.9rem}
.top h1{font-size:1rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.stage{width:100%;max-width:900px;background:#0c1410;border:1px solid #1e3a2a;border-radius:16px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:300px}
.stage video{width:100%;max-height:70vh;background:#000}
.stage img{max-width:100%;max-height:70vh;display:block}
.stage audio{width:100%;padding:30px}
.bar{width:100%;max-width:900px;display:flex;gap:10px;margin-top:16px;justify-content:center}
.btn{display:inline-block;background:#00c853;color:#fff;text-decoration:none;font-weight:700;padding:12px 32px;border-radius:12px}
.btn.ghost{background:#0c1410;border:1px solid #1e3a2a;color:#e8f5e9}
.adslot{width:100%;max-width:900px;background:#0a120c;border:1px dashed #1e3a2a;border-radius:12px;min-height:90px;display:flex;align-items:center;justify-content:center;color:#2a4a35;font-size:.8rem;margin-top:16px}
.playgate{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#000;cursor:pointer}
.pgbtn{font-size:4rem;color:#00e676;text-shadow:0 2px 20px rgba(0,230,118,.5)}
.pgtxt{font-size:.9rem;color:#e8f5e9}
.adgate{position:fixed;inset:0;z-index:999;display:none;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px;background:#000;padding:60px 16px 24px;overflow-y:auto;text-align:center}
.adclose{position:fixed;top:14px;right:16px;z-index:10000;width:44px;height:44px;border-radius:50%;background:#1e3a2a;color:#fff;font-size:1.4rem;border:none;cursor:pointer}
.adlabel{font-size:.85rem;color:#7a9a85;letter-spacing:.08em}
.adbtn{background:#00c853;color:#fff;border:none;font-weight:700;font-size:1rem;padding:12px 32px;border-radius:12px;cursor:pointer}
.adbtn:disabled{opacity:.5;cursor:default}
</style><script data-cfasync="false" src="https://aarems.org/1/8a50be483ddba782392f8d2b164694b9"></script></head><body>
<div class="top"><a href="/">← Library</a><h1>${key.split("/").pop()}</h1></div>
<div class="stage">${kind === "video" ? `
<video controls controlsList="nodownload" preload="metadata" playsinline style="width:100%;max-height:70vh;background:#000" src="/d/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}"></video>
<style>
.vp{position:relative;width:100%;background:#000;overflow:hidden;user-select:none;-webkit-user-select:none}
.vp video{width:100%;max-height:70vh;display:block;background:#000}
.vbig{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:4rem;color:#00e676;cursor:pointer;text-shadow:0 2px 20px rgba(0,230,118,.5);transition:opacity .3s;background:rgba(0,0,0,.3)}
.vspin{position:absolute;top:50%;left:50%;width:44px;height:44px;margin:-22px;border:4px solid #1e3a2a;border-top-color:#00e676;border-radius:50%;animation:sp 0.8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.vctl{position:absolute;left:0;right:0;bottom:0;padding:10px 12px 8px;background:linear-gradient(transparent,rgba(0,0,0,.85));transition:opacity .3s}
.vseek{position:relative;height:20px;cursor:pointer;touch-action:none}
.vseek::before{content:"";position:absolute;top:8px;left:0;right:0;height:4px;background:#2a3a2e;border-radius:2px}
.vbuf{position:absolute;top:8px;left:0;height:4px;background:#4a5a4e;border-radius:2px;width:0}
.vfill{position:absolute;top:8px;left:0;height:4px;background:#00e676;border-radius:2px;width:0}
.vdot{position:absolute;top:4px;width:12px;height:12px;margin-left:-6px;background:#00e676;border-radius:50%;left:0;box-shadow:0 0 8px rgba(0,230,118,.8)}
.vrow{display:flex;align-items:center;gap:6px;margin-top:2px}
.vb{background:none;border:none;color:#e8f5e9;font-size:1.05rem;cursor:pointer;padding:6px 8px;border-radius:8px;min-width:40px}
.vb:active{background:#1e3a2a}
.vt{font-size:.8rem;color:#a8c8b0;font-variant-numeric:tabular-nums}
#vspd{font-size:.85rem;font-weight:700}
</style>`
: kind === "image" ? `<img src="/d/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}" alt="">`
: kind === "audio" ? `<audio controls preload="metadata" src="/d/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}"></audio>`
: `<p style="padding:40px;color:#7a9a85">Preview not available for this file type.</p>`}</div>
<div class="adslot"><!-- AdSense ad unit goes here --></div>
<div class="bar"><a class="btn" href="/gate/file/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")} ">⭳ Download</a><a class="btn ghost" href="/dl/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")} ">Details</a></div>
<div style="text-align:center;padding:14px;color:#5f7a68;font-size:.82rem">👀 __VIEWS_TODAY__ viewers today</div>
<div data-mndbanid="b03e1301-6a18-445b-8cfe-9150397c75dd"></div>
<script>
(function(){
  var vid=document.querySelector('.stage video');
  if(!vid)return;
  /* Play-click ad gate, VISIBLE Mondiad version: ▶ click = Ad 1
     screen, Continue = Ad 2 screen, Continue = play. The ad screen
     shows the page's own Mondiad banner (moved in from below the
     player, so it is already filled by Mondiad) with a Continue
     button — no hidden popunder, no ad message on the play button.
     Native controls are hidden until the gate passes, so only the
     overlay ▶ is visible at first. After playback starts both
     overlays stay hidden, so pause/resume is not re-gated. */
  var stage=document.querySelector('.stage');
  if(stage){
    stage.style.position='relative';
    vid.removeAttribute('controls');
    var gate=document.createElement('div');
    gate.className='playgate';
    gate.innerHTML='<div class="pgbtn">▶</div><div class="pgtxt">Click to play</div>';
    stage.appendChild(gate);

    var ban=document.querySelector('[data-mndbanid]');
    var banParent=ban?ban.parentNode:null, banNext=ban?ban.nextSibling:null;
    /* Interstitial gate, no ad words: Play click loads a fresh
       interstitial script and shows a blank black fullscreen screen
       (no ad label, no explanatory text). If Mondiad fires
       an interstitial it covers this screen with its own close
       button; if not, Continue unlocks after a 5s countdown. */
    var adBox=document.createElement('div');
    adBox.className='adgate';
    adBox.innerHTML='<button class="adbtn" id="adbtn" disabled>Continue in 10…</button>';
    document.body.appendChild(adBox);
    gate.addEventListener('click',function(){
      gate.style.display='none'; adBox.style.display='flex';
      var s=document.createElement('script');
      s.async=true; s.src='https://ss.mrmnd.com/interstitial.js';
      s.setAttribute('data-mndintid','206f947f-813c-4f71-aedc-ffd005412447');
      document.head.appendChild(s);
      var left=10, btn=document.getElementById('adbtn');
      var timer=setInterval(function(){left--;
        if(left<=0){clearInterval(timer);btn.disabled=false;btn.textContent='Continue ▶';}
        else{btn.textContent='Continue in '+left+'…';}},1000);
    });
    document.getElementById('adbtn').addEventListener('click',function(){
      adBox.style.display='none';
      vid.setAttribute('controls','');
      try{vid.play();}catch(e){}
    });
    vid.addEventListener('play',function(){gate.style.display='none';adBox.style.display='none';vid.setAttribute('controls','');});
  }
  var start=parseInt(new URLSearchParams(location.search).get('start')||'0',10);
  if(start>10){
    vid.addEventListener('loadedmetadata',function(){try{vid.currentTime=start;}catch(e){}});
    if(vid.readyState>=1){try{vid.currentTime=start;}catch(e){}}
  }
  var lastSent=0;
  function send(force){
    if(!vid.duration||vid.currentTime<10)return;
    var now=Date.now();
    if(!force&&now-lastSent<30000)return;
    lastSent=now;
    fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'file:${bucket}/${key}',title:${JSON.stringify(key.split("/").pop())},poster:'',type:'movie',url:vid.currentSrc||vid.src,viewUrl:location.pathname,pos:vid.currentTime,dur:vid.duration,updatedAt:Date.now()})}).catch(function(){});
  }
  vid.addEventListener('timeupdate',function(){send(false);});
  vid.addEventListener('pause',function(){send(true);});
  window.addEventListener('beforeunload',function(){send(true);});
})();
(function(){try{var pid=null;try{pid=localStorage.getItem("presence-id");}catch(e){}if(!pid){pid=(crypto.randomUUID?crypto.randomUUID():("v-"+Date.now()+"-"+Math.random().toString(36).slice(2)));try{localStorage.setItem("presence-id",pid);}catch(e){}}function beat(){try{fetch("/api/presence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:pid,kind:"watching",title:${JSON.stringify(key.split("/").pop())}})}).catch(function(){});}catch(e){}}beat();setInterval(beat,30000);}catch(e){}})();
</script><script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script>${ADBLOCK_WALL}</body></html>`;
const EXT_VIEW_PAGE = async (m, env) => {
  const sources = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
  const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const seoLang = (sources[0] && sources[0].label && sources[0].label !== "Default" && sources[0].label !== "Video") ? sources[0].label : "";
  const seoYear = m.year ? String(m.year) : "";
  const seoTitleText = (m.title || "Untitled") + (seoYear ? " (" + seoYear + ")" : "") + (seoLang && m.type !== "song" ? " " + seoLang : "");
  const seoTitle = seoTitleText + " — Redowansky's Library";
  const seoDesc = m.overview ? String(m.overview).replace(/\s+/g, " ").trim().slice(0, 155) : ("Watch " + seoTitleText + " on Redowansky's Library — free streaming.");
  const seoCanon = "https://redowansky.bond/view/ext/" + m.id;
  const seoPoster = m.poster ? (String(m.poster).startsWith("http") ? m.poster : "https://image.tmdb.org/t/p/w500" + m.poster) : "";
  const seoMetaLine = [seoYear, seoLang, (m.genres || []).join(" · "), m.type === "song" ? "Video Song" : m.type === "series" ? "TV Series" : "Movie", m.vote ? "★ " + m.vote : ""].filter(Boolean).join(" · ");
  // Schema fix 2026-10-28: no aggregateRating — the catalog stores only a
  // rating average, never a ratingCount/reviewCount, and inventing a count
  // would be fake data. No VideoObject for songs either — the catalog stores
  // no uploadDate, and VideoObject requires it (plus thumbnailUrl/contentUrl).
  // Movies keep a plain Movie schema; songs get no schema script at all.
  const seoSchema = m.type === "song" ? null : { "@context": "https://schema.org", "@type": m.type === "series" ? "TVSeries" : "Movie", name: m.title || "", description: seoDesc, url: seoCanon, ...(seoYear ? { datePublished: seoYear + "-01-01" } : {}), ...(m.genres && m.genres.length ? { genre: m.genres } : {}), ...(seoPoster ? { image: seoPoster } : {}) };
  const isDrive = (u) => u.indexOf("google.com") >= 0 && /[?&]id=([a-zA-Z0-9_-]+)/.test(u);
  const driveId = (u) => { const x = u.match(/[?&]id=([a-zA-Z0-9_-]+)/); return x ? x[1] : null; };
  // Embed players (Lulustream): an /e/ URL is the provider's own player
  // iframe, not a file — the site renders it as an iframe instead of
  // <video>. The existing play gate already handles iframes (overlay
  // covers the stage; only VIDEO gets play()/controls handling), and
  // progress tracking safely no-ops (it returns early without a video).
  // NOTE 2026-10-31: sandboxing the embed iframe was tried and REVERTED
  // the same evening — it blocked all in-video popup tabs, but
  // Lulustream's player detects the sandbox and refuses to stream
  // ("Streaming Blocked ... ensure the page is not sandboxed"). Do NOT
  // re-add sandbox to embed iframes without a new workaround.
  const isEmbed = (u) => /luluvido\.com\/e\/|lulustream\.com\/e\//.test(u || "");
  const playerFor = async (u) => isDrive(u)
    ? `<iframe src="https://drive.google.com/file/d/${driveId(u)}/preview" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>`
    : isEmbed(u)
    ? `<iframe src="${u}" scrolling="no" frameborder="0" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"></iframe>`
    : `<video controls controlsList="nodownload" preload="metadata" playsinline src="${await streamUrlFor(env, u)}" style="width:100%;max-height:70vh;background:#000"></video>`;
  // v0.6.28: R2 sources play through signed stream URLs (the public
  // R2 URL is dead once the bucket's r2.dev domain is off). Drive
  // and embed sources pass through unchanged (streamUrlFor no-ops).
  const srcUrls = [];
  for (const s of sources) srcUrls.push(await streamUrlFor(env, s.url));
  const isSeries = m.type === "series" && Array.isArray(m.episodes) && m.episodes.length > 0;
  const epList = !isSeries ? "" : `<div style="width:100%;max-width:900px;margin:0 auto 16px">` +
    `<div style="font-size:1.05rem;font-weight:700;margin-bottom:10px">📺 Episodes · ${m.episodes.length}</div>` +
    m.episodes.map((ep, i) => `<div class="eprow" id="eprow${i}" onclick="setEp(${i})" style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;border-radius:12px;cursor:pointer;border:1px solid ${i === 0 ? "#00e676" : "#1e3a2a"};background:${i === 0 ? "#122a1c" : "#0c1410"}">` +
      `<span style="font-weight:700;color:#00e676;min-width:28px">${ep.n}.</span>` +
      `<span style="flex:1;font-weight:600">${escHtml(ep.title)}</span>` +
      (ep.dur ? `<span style="color:#7a9a85;font-size:.85rem">${ep.dur} min</span>` : "") +
      `<span style="color:#00e676">▶</span></div>`).join("") +
    `</div>
    <script>
    const EPS = ${JSON.stringify(m.episodes.map(e => e.url))};
    function setEp(i){
      const stage = document.getElementById("extstage");
      const u = EPS[i];
      stage.innerHTML = '<iframe src="' + u + '" scrolling="no" frameborder="0" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"></iframe>';
      EPS.forEach((_, j) => {
        const r = document.getElementById("eprow" + j);
        const on = j === i;
        r.style.borderColor = on ? "#00e676" : "#1e3a2a";
        r.style.background = on ? "#122a1c" : "#0c1410";
      });
    }
    </script>`;
  const switcher = (!isSeries && sources.length > 1)
    ? `<div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px;flex-wrap:wrap">` +
      sources.map((s, i) => `<button onclick="setSrc(${i})" id="srcbtn${i}" style="padding:8px 18px;border-radius:20px;border:1px solid #2a5a3a;background:${i === 0 ? "#00e676" : "#122a1c"};color:${i === 0 ? "#06130b" : "#e8f5e9"};font-weight:600;cursor:pointer;font-size:.85rem">${s.label}</button>`).join("") +
      `</div>
      <script>
      const SRCS = ${JSON.stringify(srcUrls)};
      function setSrc(i){
        const stage = document.getElementById("extstage");
        const db = document.getElementById("dlbtn");
        if (db) db.href = "/download/ext/${m.id}?src=" + i;
        const u = SRCS[i];
        const isD = u.indexOf("google.com") >= 0 && /[?&]id=/.test(u);
        const isE = /luluvido\.com\/e\/|lulustream\.com\/e\//.test(u);
        if (isD) {
          const idm = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
          stage.innerHTML = '<iframe src="https://drive.google.com/file/d/' + idm[1] + '/preview" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>';
        } else if (isE) {
          stage.innerHTML = '<iframe src="' + u + '" scrolling="no" frameborder="0" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>';
        } else {
          stage.innerHTML = '<video controls controlsList="nodownload" preload="metadata" playsinline autoplay src="' + u + '" style="width:100%;max-height:70vh;background:#000"></video>';
        }
        if(window.initPlayGate)window.initPlayGate();
        SRCS.forEach((_, j) => {
          const b = document.getElementById("srcbtn" + j);
          const on = j === i;
          b.style.background = on ? "#00e676" : "#122a1c";
          b.style.color = on ? "#06130b" : "#e8f5e9";
        });
      }
      </script>`
    : "";
  const player = `<div id="extstage">${await playerFor(sources[0].url)}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<script async src="https://ss.mrmnd.com/banner.js"></script><script async src="https://ss.mrmnd.com/static/f53498a9-9861-49d1-b571-67c892585b0a.js"></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(seoTitle)}</title>
<meta name="description" content="${escHtml(seoDesc)}">
<link rel="canonical" href="${seoCanon}">
<meta property="og:title" content="${escHtml(seoTitle)}">
<meta property="og:description" content="${escHtml(seoDesc)}">
<meta property="og:type" content="video.other">
<meta property="og:url" content="${seoCanon}">
${seoPoster ? `<meta property="og:image" content="${escHtml(seoPoster)}">` : ""}
${seoSchema ? `<script type="application/ld+json">${JSON.stringify(seoSchema)}</script>` : ""}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060906;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px}
.top{width:100%;max-width:900px;display:flex;align-items:center;gap:12px;margin-bottom:16px}
.top a{color:#00e676;text-decoration:none;font-size:.9rem}
.top h1{font-size:1rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.stage{width:100%;max-width:900px;background:#0c1410;border:1px solid #1e3a2a;border-radius:16px;overflow:hidden}
.stage video{width:100%;max-height:70vh;background:#000}
.note{width:100%;max-width:900px;color:#7a9a85;font-size:.85rem;margin-top:12px;text-align:center}
.playgate{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#000;cursor:pointer}
.pgbtn{font-size:4rem;color:#00e676;text-shadow:0 2px 20px rgba(0,230,118,.5)}
.pgtxt{font-size:.9rem;color:#e8f5e9}
.adgate{position:fixed;inset:0;z-index:999;display:none;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px;background:#000;padding:60px 16px 24px;overflow-y:auto;text-align:center}
.adclose{position:fixed;top:14px;right:16px;z-index:10000;width:44px;height:44px;border-radius:50%;background:#1e3a2a;color:#fff;font-size:1.4rem;border:none;cursor:pointer}
.adlabel{font-size:.85rem;color:#7a9a85;letter-spacing:.08em}
.adbtn{background:#00c853;color:#fff;border:none;font-weight:700;font-size:1rem;padding:12px 32px;border-radius:12px;cursor:pointer}
.adbtn:disabled{opacity:.5;cursor:default}
</style><script data-cfasync="false" src="https://aarems.org/1/8a50be483ddba782392f8d2b164694b9"></script></head><body>
<div class="top"><a href="/">← Library</a><h1>${m.title}</h1></div>
${switcher}
<div class="stage">${player}</div>
${epList}
${(m.overview || seoMetaLine) ? `<div style="width:100%;max-width:900px;margin-top:16px;color:#b8d8c0;font-size:.95rem;line-height:1.5">${m.overview ? `<p>${escHtml(m.overview)}</p>` : ""}${seoMetaLine ? `<div style="color:#7a9a85;font-size:.85rem;margin-top:8px">${escHtml(seoMetaLine)}</div>` : ""}</div>` : ""}
${isEmbed(sources[0].url) ? "" : `<div style="margin-top:16px;text-align:center"><a id="dlbtn" href="/download/ext/${m.id}" style="display:inline-block;background:linear-gradient(90deg,#00c853,#69f0ae);color:#fff;text-decoration:none;font-weight:700;font-size:1rem;padding:13px 38px;border-radius:14px;box-shadow:0 8px 26px rgba(0,230,118,.35)">⭳ Download</a></div>`}
<p class="note">🔗 streamed from external host</p>
<div style="text-align:center;padding:14px;color:#5f7a68;font-size:.82rem">👀 __VIEWS_TODAY__ viewers today</div>
<div data-mndbanid="b03e1301-6a18-445b-8cfe-9150397c75dd"></div>
<script>
(function(){
  /* Play-click ad gate, VISIBLE Mondiad version: ▶ click = Ad 1
     screen, Continue = Ad 2 screen, Continue = play / reveals the
     player. The ad screen shows the page's own Mondiad banner
     (moved in from below the player, so it is already filled) with
     a Continue button — no hidden popunder. Native video controls
     are hidden until the gate passes, so only the overlay ▶ is
     visible at first (the opaque overlay also hides Drive iframe
     controls). Re-runnable so source-switching (setSrc) re-gates
     the new player; re-gating restores the banner to its place. */
  window.initPlayGate=function(){
    var stage=document.getElementById('extstage');
    if(!stage||!stage.parentNode)return;
    var old=stage.parentNode.querySelector('.playgate');
    if(old)old.remove();
    var oldAd=document.querySelector('.adgate');
    if(oldAd)oldAd.remove();
    var ban=document.querySelector('[data-mndbanid]');
    var media=stage.querySelector('video,iframe');
    if(!media)return;
    if(media.tagName==='VIDEO')media.removeAttribute('controls');
    var wrap=stage.parentNode;
    wrap.style.position='relative';
    var gate=document.createElement('div');
    gate.className='playgate';
    gate.innerHTML='<div class="pgbtn">▶</div><div class="pgtxt">Click to play</div>';
    wrap.appendChild(gate);

    var banParent=ban?ban.parentNode:null, banNext=ban?ban.nextSibling:null;
    var adBox=document.createElement('div');
    adBox.className='adgate';
    adBox.innerHTML='<button class="adbtn" disabled>Continue in 10…</button>';
    document.body.appendChild(adBox);
    gate.addEventListener('click',function(){
      gate.style.display='none'; adBox.style.display='flex';
      var s=document.createElement('script');
      s.async=true; s.src='https://ss.mrmnd.com/interstitial.js';
      s.setAttribute('data-mndintid','206f947f-813c-4f71-aedc-ffd005412447');
      document.head.appendChild(s);
      var left=10, btn=adBox.querySelector('.adbtn');
      var timer=setInterval(function(){left--;
        if(left<=0){clearInterval(timer);btn.disabled=false;btn.textContent='Continue ▶';}
        else{btn.textContent='Continue in '+left+'…';}},1000);
    });
    adBox.querySelector('.adbtn').addEventListener('click',function(){
      adBox.style.display='none';
      if(media.tagName==='VIDEO'){media.setAttribute('controls','');try{media.play();}catch(e){}}
    });
    if(media.tagName==='VIDEO')media.addEventListener('play',function(){gate.style.display='none';adBox.style.display='none';media.setAttribute('controls','');});
  };
  if(!${isSeries})window.initPlayGate();
  var vid=document.querySelector('#extstage video');
  if(!vid)return;
  var start=parseInt(new URLSearchParams(location.search).get('start')||'0',10);
  if(start>10){
    vid.addEventListener('loadedmetadata',function(){try{vid.currentTime=start;}catch(e){}});
    if(vid.readyState>=1){try{vid.currentTime=start;}catch(e){}}
  }
  var lastSent=0;
  function send(force){
    if(!vid.duration||vid.currentTime<10)return;
    var now=Date.now();
    if(!force&&now-lastSent<30000)return;
    lastSent=now;
    fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'${m.id}',title:${JSON.stringify(m.title)},poster:${JSON.stringify(m.poster||"")},type:${JSON.stringify(m.type||"movie")},url:vid.currentSrc||vid.src,viewUrl:location.pathname,pos:vid.currentTime,dur:vid.duration,updatedAt:Date.now()})}).catch(function(){});
  }
  vid.addEventListener('timeupdate',function(){send(false);});
  vid.addEventListener('pause',function(){send(true);});
  window.addEventListener('beforeunload',function(){send(true);});
})();
(function(){try{var pid=null;try{pid=localStorage.getItem("presence-id");}catch(e){}if(!pid){pid=(crypto.randomUUID?crypto.randomUUID():("v-"+Date.now()+"-"+Math.random().toString(36).slice(2)));try{localStorage.setItem("presence-id",pid);}catch(e){}}function beat(){try{fetch("/api/presence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:pid,kind:"watching",title:${JSON.stringify(m.title)}})}).catch(function(){});}catch(e){}}beat();setInterval(beat,30000);}catch(e){}})();
</script><script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script>${ADBLOCK_WALL}</body></html>`;
};
function mediaKind(name){const e=name.split(".").pop().toLowerCase();
if(["mp4","webm","mkv","avi","mov","m4v"].includes(e))return "video";
if(["jpg","jpeg","png","gif","webp","bmp","svg"].includes(e))return "image";
if(["mp3","ogg","wav","m4a","flac"].includes(e))return "audio";return "other";}

// ---- Download interstitial (ad slot lives here) ----
const DL_PAGE = (bucket, key, size) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download ${key.split("/").pop()} — Redowansky's Library</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060906;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
.card{background:linear-gradient(180deg,#101b14,#0c1410);border:1px solid #1e3a2a;border-radius:20px;padding:40px 36px;max-width:480px;width:100%}
.ico{font-size:3rem;margin-bottom:14px}
h1{font-size:1.3rem;margin-bottom:6px;word-break:break-all}
.meta{color:#7a9a85;font-size:.85rem;margin-bottom:22px}
.adslot{background:#0a120c;border:1px dashed #1e3a2a;border-radius:12px;min-height:120px;display:flex;align-items:center;justify-content:center;color:#55556a;font-size:.8rem;margin-bottom:22px;padding:16px}
/* Paste your AdSense ad unit code inside the .adslot div above */
.btn{display:inline-block;background:linear-gradient(90deg,#00c853,#69f0ae);color:#fff;text-decoration:none;font-weight:700;font-size:1.05rem;padding:15px 44px;border-radius:14px;box-shadow:0 8px 26px rgba(0,230,118,.35)}
.btn:hover{transform:translateY(-2px)}
.back{display:inline-block;margin-top:18px;color:#00e676;text-decoration:none;font-size:.9rem}
</style></head><body>
<div class="card">
<div class="ico">📄</div>
<h1>${key.split("/").pop()}</h1>
<div class="meta">${fmtSize(size)} · from the ${bucket} shelf</div>
<div class="adslot" id="adslot"><!-- AdSense ad unit goes here --></div>
<a class="btn" href="/gate/file/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}">⭳ Download</a><br>
<a class="back" href="/">← back to library</a>
</div>
<script>
function fmtSize(n){if(!n)return "—";const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return n.toFixed(1)+" "+u[i];}</script>
<div style="text-align:center;padding:14px;color:#5f7a68;font-size:.82rem">👀 __VIEWS_TODAY__ viewers today</div>
</body></html>`;
const TS_SITEKEY = "0x4AAAAAAFiP8oF_-Hz8Ev93";
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const DOWNLOAD_PAGE = (m, srcInfos, viewUrl, src0) => {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const poster = m.poster ? (String(m.poster).startsWith("http") ? m.poster : "https://image.tmdb.org/t/p/w500" + m.poster) : "";
  const metaLine = [m.year, m.type === "series" ? "TV Series" : m.type === "song" ? "Video Song" : "Movie", (m.genres || []).join(" · "), m.vote ? "★ " + m.vote : ""].filter(Boolean).join(" · ");
  const infos = (srcInfos && srcInfos.length) ? srcInfos : [{ label: "Download", fmt: null, size: null, date: null }];
  const hot = src0 || 0;
  const blocks = infos.map((s, i) => {
    const meta = [s.fmt, s.size, s.date].filter(Boolean).join(" · ");
    return '<div class="srcblock' + (i === hot ? ' hot' : '') + '">'
      + '<div class="srclabel">' + esc(s.label) + '</div>'
      + (meta ? '<div class="srcmeta">' + esc(meta) + '</div>' : '')
      + '<button class="dlbtn" data-src="' + i + '" disabled>⭳ Download — ' + esc(s.label) + '</button>'
      + '</div>';
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download ${esc(m.title)} — Redowansky's Library</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060906;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:24px}
.head{display:flex;gap:20px;margin-bottom:24px;flex-wrap:wrap}
.head img{width:180px;border-radius:14px;border:1px solid #1e3a2a;align-self:flex-start}
.head h1{font-size:1.5rem;margin-bottom:8px;word-break:break-word}
.meta{color:#7a9a85;font-size:.9rem;margin-bottom:10px}
.ov{color:#c8ddd0;font-size:.95rem;line-height:1.6}
.note{color:#7a9a85;font-size:.9rem;margin-bottom:16px;line-height:1.5}
.srcblock{border:1px solid #1e3a2a;border-radius:14px;padding:16px;margin-bottom:14px;background:#0c1410}
.srcblock.hot{border-color:#00e676}
.srclabel{font-weight:700;margin-bottom:4px}
.srcmeta{color:#7a9a85;font-size:.85rem;margin-bottom:12px}
.dlbtn{display:block;width:100%;background:linear-gradient(90deg,#00c853,#69f0ae);color:#fff;border:none;font-weight:700;font-size:1.02rem;padding:14px 20px;border-radius:12px;box-shadow:0 8px 26px rgba(0,230,118,.35);cursor:pointer}
.dlbtn[disabled]{background:#1c2b21;color:#5f7a68;box-shadow:none;cursor:not-allowed}
.status{color:#7a9a85;font-size:.9rem;min-height:1.2em;margin:16px 0;text-align:center}
.tswrap{display:flex;justify-content:center;margin-bottom:18px;min-height:65px}
.stream{display:block;text-align:center;margin-top:14px;background:#122a1c;border:1px solid #2a5a3a;color:#e8f5e9;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 20px;border-radius:12px}
.back{display:inline-block;margin-top:18px;color:#00e676;text-decoration:none;font-size:.9rem}
.wall{display:none;background:#2a1215;border:1px solid #6e2a30;color:#ffb3ba;border-radius:12px;padding:18px;font-size:.92rem;line-height:1.5;margin-bottom:20px}
</style></head><body>
<div class="wrap">
<div class="head">
${poster ? `<img src="${esc(poster)}" alt="">` : ""}
<div style="flex:1;min-width:240px">
<h1>${esc(m.title)}</h1>
<div class="meta">${esc(metaLine)}</div>
${m.overview ? `<div class="ov">${esc(m.overview)}</div>` : ""}
</div>
</div>
<div id="dlMain">
<div class="note">Downloads are free because ads pay for the library — each download takes 3 clicks: 2 ads, then your file.</div>
${blocks}
<div class="status" id="status">Complete the human check below to unlock the downloads.</div>
<div class="tswrap"><div class="cf-turnstile" data-sitekey="${TS_SITEKEY}" data-callback="tsOk"></div></div>
<a class="stream" href="${viewUrl}">▶ Stream Online</a>
<a class="back" href="/">← back to library</a>
</div>
<div class="wall" id="wall">🚫 <b>Adblock detected.</b><br>Downloads are free because ads pay for the library.<br>Please disable your adblocker for this site and refresh the page.</div>
</div>
<div id="bait" class="ad adsbox ad-banner pub_300x250" style="height:1px;font-size:1px;line-height:1px">&nbsp;</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
var DESC=${JSON.stringify({ kind: "ext", id: m.id })};
var tsToken=null,blocked=false,busy=false,clicks=0;
var st=document.getElementById("status");
var btns=document.querySelectorAll(".dlbtn");
function tsOk(t){tsToken=t;if(blocked)return;btns.forEach(function(b){b.disabled=false;});st.textContent="Ready — each download takes 3 clicks: 2 ads, then your file.";}
setTimeout(function(){
  var bait=document.getElementById("bait");
  var hidden=!bait||bait.offsetHeight===0||bait.offsetParent===null;
  if(!hidden){var cs=getComputedStyle(bait);if(cs.display==="none"||cs.visibility==="hidden")hidden=true;}
  if(hidden){blocked=true;document.getElementById("dlMain").style.display="none";document.getElementById("wall").style.display="block";}
},1500);
btns.forEach(function(b){b.onclick=function(){
  if(busy||b.disabled)return;
  clicks++;
  if(clicks<=2){
    st.textContent="Ad "+clicks+" of 2 — click any Download button again to continue.";
    return;
  }
  busy=true;var old=b.textContent;b.textContent="Checking…";
  fetch("/api/gate/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({desc:DESC,src:parseInt(b.getAttribute("data-src"),10)||0,token:tsToken})})
  .then(function(r){return r.json();})
  .then(function(j){
    if(j&&j.go){location.href=j.go;return;}
    busy=false;clicks=0;tsToken=null;b.textContent=old;
    btns.forEach(function(x){x.disabled=true;});
    st.textContent="❌ "+((j&&j.error)||"verification failed — refresh and try again.")+" Complete the human check again.";
    if(window.turnstile)turnstile.reset();
  })
  .catch(function(){busy=false;b.textContent=old;st.textContent="❌ Network error — refresh and try again.";});
};});
</script>
<div style="text-align:center;padding:14px;color:#5f7a68;font-size:.82rem">👀 __VIEWS_TODAY__ viewers today</div>
<script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script><script data-cfasync="false" src="https://aarems.org/1/8a50be483ddba782392f8d2b164694b9"></script></body></html>`;
};

const GATE_PAGE = (title, sub, desc, srcInfos, viewUrl, src0) => {
  var infos = (srcInfos && srcInfos.length) ? srcInfos : [{ label: "Download", fmt: null, size: null, date: null }];
  var hot = src0 || 0;
  function esc(s){ return String(s == null ? "" : s); }
  var blocks = infos.map(function(s, i){
    var meta = [esc(s.fmt), esc(s.size), esc(s.date)].filter(function(x){ return x; }).join(" · ");
    return '<div class="srcblock' + (i === hot ? ' hot' : '') + '">'
      + '<div class="srclabel">' + esc(s.label) + '</div>'
      + (meta ? '<div class="srcmeta">' + meta + '</div>' : '')
      + '<button class="dlbtn" data-src="' + i + '" disabled>⭳ Download — ' + esc(s.label) + '</button>'
      + '</div>';
  }).join("");
  var streamBtn = viewUrl ? '<a class="stream" href="' + viewUrl + '">▶ Stream Online</a>' : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<script async src="https://ss.mrmnd.com/banner.js"></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download ${title} — Redowansky's Library</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060906;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
.card{background:linear-gradient(180deg,#101b14,#0c1410);border:1px solid #1e3a2a;border-radius:20px;padding:36px 32px;max-width:520px;width:100%}
.ico{font-size:3rem;margin-bottom:12px}
h1{font-size:1.25rem;margin-bottom:6px;word-break:break-word}
.meta{color:#7a9a85;font-size:.85rem;margin-bottom:20px}
.adslot{background:#0a120c;border:1px dashed #1e3a2a;border-radius:12px;min-height:120px;display:flex;align-items:center;justify-content:center;color:#55556a;font-size:.8rem;margin-bottom:20px;padding:16px;overflow:hidden}
.srcblock{border:1px solid #1e3a2a;border-radius:14px;padding:16px;margin-bottom:14px;background:#0a120c}
.srcblock.hot{border-color:#00e676}
.srclabel{font-weight:700;margin-bottom:4px}
.srcmeta{color:#7a9a85;font-size:.85rem;margin-bottom:12px}
.note{color:#7a9a85;font-size:.85rem;margin-bottom:16px;line-height:1.5}
.status{color:#7a9a85;font-size:.88rem;min-height:1.2em;margin-bottom:16px}
.tswrap{display:flex;justify-content:center;margin-bottom:18px;min-height:65px}
.dlbtn{display:block;width:100%;background:linear-gradient(90deg,#00c853,#69f0ae);color:#fff;border:none;text-decoration:none;font-weight:700;font-size:1.02rem;padding:14px 20px;border-radius:12px;box-shadow:0 8px 26px rgba(0,230,118,.35);cursor:pointer}
.dlbtn[disabled]{background:#1c2b21;color:#5f7a68;box-shadow:none;cursor:not-allowed}
.stream{display:block;margin-top:14px;background:#122a1c;border:1px solid #2a5a3a;color:#e8f5e9;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 20px;border-radius:12px}
.wall{display:none;background:#2a1215;border:1px solid #6e2a30;color:#ffb3ba;border-radius:12px;padding:18px;font-size:.92rem;line-height:1.5}
.back{display:inline-block;margin-top:18px;color:#00e676;text-decoration:none;font-size:.9rem}
</style></head><body>
<div class="card">
<div class="ico">📥</div>
<h1>${title}</h1>
<div class="meta">${sub}</div>
<div class="adslot" id="adslot"><div data-mndbanid="b03e1301-6a18-445b-8cfe-9150397c75dd"></div></div>
<div id="gateMain">
<div class="note">Downloads are free because ads pay for the library — each download takes 3 clicks: 2 ads, then your file.</div>
${blocks}
<div class="status" id="status">Complete the human check below to unlock the downloads.</div>
<div class="tswrap"><div class="cf-turnstile" data-sitekey="${TS_SITEKEY}" data-callback="tsOk"></div></div>
${streamBtn}
<a class="back" href="/">← back to library</a>
</div>
<div class="wall" id="wall">🚫 <b>Adblock detected.</b><br>Downloads are free because ads pay for the library.<br>Please disable your adblocker for this site and refresh the page.</div>
</div>
<div id="bait" class="ad adsbox ad-banner pub_300x250" style="height:1px;font-size:1px;line-height:1px">&nbsp;</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
var DESC=${JSON.stringify(desc)};
var tsToken=null,blocked=false,busy=false,clicks=0;
var st=document.getElementById("status");
var btns=document.querySelectorAll(".dlbtn");
function tsOk(t){tsToken=t;if(blocked)return;btns.forEach(function(b){b.disabled=false;});st.textContent="Ready — each download takes 3 clicks: 2 ads, then your file.";}
setTimeout(function(){
  var bait=document.getElementById("bait");
  var hidden=!bait||bait.offsetHeight===0||bait.offsetParent===null;
  if(!hidden){var cs=getComputedStyle(bait);if(cs.display==="none"||cs.visibility==="hidden")hidden=true;}
  if(hidden){blocked=true;document.getElementById("gateMain").style.display="none";document.getElementById("wall").style.display="block";}
},1500);
function showAd(){
  var s=document.createElement("script");
  s.async=true;s.src="https://ss.mrmnd.com/interstitial.js";
  s.setAttribute("data-mndintid","206f947f-813c-4f71-aedc-ffd005412447");
  document.head.appendChild(s);
}
btns.forEach(function(b){b.onclick=function(){
  if(busy||b.disabled)return;
  clicks++;
  if(clicks<=2){showAd();st.textContent="Ad "+clicks+" of 2 shown — click any Download button again to continue.";return;}
  busy=true;var old=b.textContent;b.textContent="Checking…";
  fetch("/api/gate/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({desc:DESC,src:parseInt(b.getAttribute("data-src"),10)||0,token:tsToken})})
  .then(function(r){return r.json();})
  .then(function(j){
    if(j&&j.go){location.href=j.go;return;}
    busy=false;clicks=0;tsToken=null;b.textContent=old;
    btns.forEach(function(x){x.disabled=true;});
    st.textContent="❌ "+((j&&j.error)||"verification failed — refresh and try again.")+" Complete the human check again.";
    if(window.turnstile)turnstile.reset();
  })
  .catch(function(){busy=false;b.textContent=old;st.textContent="❌ Network error — refresh and try again.";});
};});
</script>
<div style="text-align:center;padding:14px;color:#5f7a68;font-size:.82rem">👀 __VIEWS_TODAY__ viewers today</div>
</body></html>`;
};
function fmtSize(n){if(!n)return "—";const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return n.toFixed(1)+" "+u[i];}

function fmtDate(d){try{const x=new Date(d);if(isNaN(x.getTime()))return null;return x.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});}catch(e){return null;}}

// Presence helpers (Users Online Now): a visitor counts as online
// while a heartbeat arrived within the last 90s (3x the 30s beat,
// tolerates two missed beats).
const PRESENCE_TTL_MS = 90000;
const PRESENCE_MAX = 5000;
function prunePresence(map, now) {
  for (const [id, v] of map) if (now - v.lastSeen > PRESENCE_TTL_MS) map.delete(id);
  if (map.size > PRESENCE_MAX) {
    const over = map.size - PRESENCE_MAX;
    const ids = [...map.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, over).map(e => e[0]);
    for (const id of ids) map.delete(id);
  }
}
function presenceSummary(map, now) {
  prunePresence(map, now);
  let browsing = 0, watching = 0;
  const byTitle = new Map();
  for (const v of map.values()) {
    if (v.kind === "watching") { watching++; if (v.title) byTitle.set(v.title, (byTitle.get(v.title) || 0) + 1); }
    else browsing++;
  }
  const titles = [...byTitle.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  return { online: map.size, browsing, watching, titles };
}
export class TunnelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // NOTE: no this.ws field anymore — see tunnelWs() (Hibernation API).
    this.pending = new Map();
    this.expectBodyFor = null;
    this._views = null;
    this._viewsTotal = null;
    // Live presence (Users Online Now): in-memory ONLY, by design —
    // a heartbeat every 30s per visitor must not burn storage writes.
    // Wiped if the DO hibernates/evicts; heartbeats rebuild it
    // within 30s. Map: id -> {kind, title, lastSeen}. No IPs stored:
    // the client id is a random per-browser token, and only
    // aggregates ever leave the server (see presenceSummary).
    this._presence = new Map();
  }

  // --- WebSocket Hibernation API (migrated 2026-10-23, Redowan's call) ---
  // The s3d tunnel socket is accepted via state.acceptWebSocket(), so this
  // DO can HIBERNATE while the tunnel stays connected — no duration billing
  // while idle. The old plain server.accept() billed duration for the
  // socket's ENTIRE connected life (~10,800 GB-s/day against a 13,000/day
  // free budget — the 2026-10-23 account-wide DO limit incident). The
  // socket is never kept in a field (in-memory state is wiped on
  // hibernation); it is recovered from state.getWebSockets("tunnel").
  // WS messages/closes arrive via webSocketMessage/webSocketClose below,
  // which also wake the DO after a hibernation. In-flight s3fetch state
  // (this.pending / this.expectBodyFor) only exists while a fetch handler
  // is actively awaiting, and the DO does not hibernate mid-request, so it
  // never needs to survive a wake.
  tunnelWs() {
    try {
      const socks = this.state.getWebSockets("tunnel");
      return socks.length ? socks[socks.length - 1] : null;
    } catch (e) { return null; }
  }

  async webSocketMessage(ws, message) {
    this.onWsMessage({ data: message });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // If a replacement tunnel socket is already live, the pending map
    // belongs to the new connection — leave it alone.
    let others = [];
    try { others = this.state.getWebSockets("tunnel").filter((s) => s !== ws); } catch (e) {}
    if (!others.length) {
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error("tunnel closed")); }
      this.expectBodyFor = null;
    }
    try { ws.close(code || 1000, reason || ""); } catch (e) {}
  }

  async webSocketError(ws, err) {
    let others = [];
    try { others = this.state.getWebSockets("tunnel").filter((s) => s !== ws); } catch (e) {}
    if (!others.length) {
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error("tunnel error")); }
      this.expectBodyFor = null;
    }
  }

  dhakaDay() {
    const d = new Date(Date.now() + 6 * 3600 * 1000);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }

  async bumpViews(request) {
    const day = this.dhakaDay();
    let v = this._views;
    if (!v || v.day !== day) {
      const s = await this.state.storage.get("views:" + day);
      v = { day, hits: (s && s.hits) || 0, viewers: (s && s.viewers) || 0 };
      this._views = v;
    }
    v.hits++;
    const ua = (request.headers.get("User-Agent") || "").toLowerCase();
    const isBot = !ua || /bot|crawl|spider|slurp|mediapartners|adsbot|facebookexternalhit|telegrambot|headless|curl|wget|python|go-http-client|java\/|libwww|scrapy|aiohttp|node-fetch|axios/.test(ua);
    const cookie = request.headers.get("Cookie") || "";
    const seen = cookie.split(";").some((c) => c.trim() === "lv=" + day);
    let setCookie = null;
    if (!seen && !isBot) { v.viewers++; setCookie = "lv=" + day + "; Path=/; Max-Age=90000; SameSite=Lax"; }
    if (this._viewsTotal == null) this._viewsTotal = (await this.state.storage.get("views:total")) || 0;
    this._viewsTotal++;
    await this.state.storage.put("views:" + day, { hits: v.hits, viewers: v.viewers });
    await this.state.storage.put("views:total", this._viewsTotal);
    return { viewersToday: v.viewers, hitsToday: v.hits, total: this._viewsTotal, setCookie };
  }

  async pageResp(html, request) {
    const s = await this.bumpViews(request);
    let out = html.split("👀 __VIEWS_TODAY__ viewers today").join('👀 <span class="gcN">–</span> visits today').split("__VIEWS_TOTAL__").join(String(s.total));
    const gc = '<script data-goatcounter="https://redowansky.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>'
      + '<script>(function(){function dk(off){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Dhaka",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()+off*864e5));}fetch("https://redowansky.goatcounter.com/counter/TOTAL.json?start="+dk(0)+"&end="+dk(1)).then(function(r){return r.json();}).then(function(j){if(j&&j.count!=null){var n=String(j.count).replace(/,/g,"");var es=document.querySelectorAll(".gcN");for(var i=0;i<es.length;i++){es[i].textContent=n;}}}).catch(function(){});})();</script>';
    if (out.indexOf("</body>") >= 0) out = out.replace("</body>", gc + "</body>"); else out += gc;
    const headers = { "content-type": "text/html;charset=utf-8" };
    if (s.setCookie) headers["Set-Cookie"] = s.setCookie;
    return new Response(out, { headers });
  }

  async viewsSnapshot() {
    const day = this.dhakaDay();
    let v = this._views;
    if (!v || v.day !== day) v = await this.state.storage.get("views:" + day);
    const total = this._viewsTotal != null ? this._viewsTotal : (await this.state.storage.get("views:total")) || 0;
    return { viewersToday: (v && v.viewers) || 0, hitsToday: (v && v.hits) || 0, totalHits: total };
  }

  onWsMessage(event) {
    const data = event.data;
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.t === "res" && this.pending.has(msg.id)) {
          this.pending.get(msg.id).meta = msg;
          this.expectBodyFor = msg.id;
        } else if (msg.t === "hello") {
          for (const [, p] of this.pending) p.reject(new Error("tunnel reconnected"));
          this.pending.clear();
        }
      } catch {}
    } else {
      const id = this.expectBodyFor;
      this.expectBodyFor = null;
      const p = id && this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.resolve({ status: p.meta.status, headers: p.meta.headers || {}, body: data });
      }
    }
  }

  async s3fetch(method, path, { query = "", headers = {}, body = null, unsignedPayload = false } = {}) {
    const ws = this.tunnelWs();
    if (!ws) {
      const e = new Error("storage gateway is offline (tunnel down)");
      e.code = 502;
      throw e;
    }
    let bodyBytes = null;
    if (body) bodyBytes = new Uint8Array(await new Response(body).arrayBuffer());
    const bodyHash = bodyBytes ? await sha256Hex(bodyBytes)
      : (unsignedPayload ? "UNSIGNED-PAYLOAD" : await sha256Hex(te.encode("")));
    const h = { host: this.env.S3D_HOST || "127.0.0.1:18000", ...headers };
    await signRequest(method, path, query, h, bodyHash, this.env.S3_SECRET_KEY, this.env.S3_ACCESS_KEY);
    const id = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, meta: null });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("tunnel request timed out")); }
      }, 180000);
    });
    try {
      ws.send(JSON.stringify({ t: "req", id, method, path: path + (query ? "?" + query : ""), headers: h }));
      ws.send(bodyBytes || new Uint8Array(0));
    } catch (e) {
      this.pending.delete(id);
      throw e;
    }
    return promise;
  }

  // Shared catalog listing used by /api/movies and /sitemap.xml (live data only).
  async listMovies(env, opts = {}) {
    const br = await this.s3fetch("GET", "/");
    let movies = [];
    if (br.status < 400) {
      const buckets = parseBuckets(bufToText(br.body));
      for (const b of buckets) {
        const lr = await this.s3fetch("GET", "/" + b, { query: "list-type=2&max-keys=1000" });
        if (lr.status < 400) {
          const xml = bufToText(lr.body);
          for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
            const key = m[1];
            const ext = key.split(".").pop().toLowerCase();
            if (!["mp4","webm","mkv","avi","mov","m4v"].includes(ext)) continue;
            const meta = await this.state.storage.get("meta:"+b+":"+key);
            movies.push({
              bucket: b, key,
              title: meta?.title || key.split("/").pop().replace(/\.[^.]+$/,""),
              year: meta?.year || null,
              overview: meta?.overview || null,
              poster: meta?.poster || null,
              backdrop: meta?.backdrop || null,
              vote: meta?.vote || null,
              genres: meta?.genres || [],
              type: meta?.type || "movie",
              tmdb: meta?.tmdb || null,
            });
          }
        }
      }
    }
    // External movies (linked, not hosted) - from DO storage (strongly
    // consistent; survives deploys). The read is STRICT in every
    // listMovies path — public feed, sitemap, admin dup checks alike:
    // a missing or unreadable catalogue is a hard failure, never an
    // empty list (correction pass 2026-11-14: the old swallowing read
    // silently dropped the whole external catalogue on a transient
    // storage failure, and the catch only rethrew CATALOGUE_NOT_SEEDED).
    // A legitimately empty catalogue is stored as {} (present) and
    // still lists as empty. opts.strictExt is retained for the existing
    // admin callers but no longer changes behaviour.
    const extObj = await getExtMoviesStrict(this.state.storage);
    // unlisted entries stay reachable via their direct /view/ext/<id>
    // URL (used to verify embed players) but are kept out of the home
    // catalog and the app feed until explicitly published.
    for (const id in extObj) { if (extObj[id].unlisted) continue; movies.push({ ...extObj[id], external: true }); }
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
    const counts = { fetched: 0, newCandidates: 0, duplicates: 0, skipped: 0, failed: 0, bySource: {} };
    // Overlap guard (hardening 2026-11-13, flag cleanup fixed 2026-11-13):
    // the flag is set synchronously BEFORE the first await, so two
    // invocations arriving together cannot both pass the check. The
    // try/finally below guarantees the flag is always reset, even if
    // the state read or the TMDB-key read throws.
    if (this._discoveryRunning) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "a run is already in progress" };
    this._discoveryRunning = true;
    try {
    // Strict state load (review 2026-11-13 item 1): the swallowing
    // getDiscoveryState() returns defaults on a KV read failure, and
    // finish() would then SAVE those defaults over the real config.
    // If the state cannot be read, abort the run before any write.
    let state;
    try { state = await getDiscoveryStateStrict(env); }
    catch (e) { return { at: runAt, trigger, status: "failed", counts, durationMs: Date.now() - started, error: "discovery state unreadable: " + String((e && e.message) || e) }; }
    const finish = async (status, error) => {
      // Save-point merge (config-race fix, 2026-11-13): the in-memory
      // `state` is a snapshot from run start. An admin config change made
      // while the run was executing must not be overwritten by saving
      // that snapshot. Re-read fresh inside the admin lock, apply only
      // this run's own record, and save that. The lock closes the window
      // between the fresh read and the save (the config endpoint also
      // takes the lock now), so no config change can slip in between.
      // Never called from inside a _withAdminLock callback (no deadlock).
      // If the fresh read throws, finish() throws and the outer catch
      // records the failure inline with no writes — the round-7 fail-safe.
      const runRecord = { at: runAt, trigger, status, counts, durationMs: Date.now() - started, error: error || null };
      const cur = await this._withAdminLock(async () => {
        const fresh = await getDiscoveryStateStrict(env);
        fresh.lastRun = runRecord;
        if (status === "ok") fresh.lastSuccess = { at: runAt, trigger, counts: { ...counts }, durationMs: Date.now() - started };
        fresh.nextRunAt = nextRunAtFor(fresh.frequency, started);
        // Totals: the run's own filed candidates are counts.newCandidates
        // (set by the batch block; 0 if the batch never ran or failed).
        // The reconciler's healed bump is already in `fresh` (it saved
        // it), so add only the batch delta — never the in-memory total,
        // which is stale.
        fresh.totals.discovered = (fresh.totals.discovered || 0) + (counts.newCandidates || 0);
        await saveDiscoveryState(env, fresh);
        return fresh;
      });
      // Keep the in-memory object in sync for any later use in this run.
      state.lastRun = cur.lastRun;
      state.lastSuccess = cur.lastSuccess;
      state.nextRunAt = cur.nextRunAt;
      state.totals = cur.totals;
      return state.lastRun;
    };
    if (trigger === "cron") {
      if (!state.enabled) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "discovery disabled" };
      if (state.nextRunAt && started < Date.parse(state.nextRunAt)) return { at: runAt, trigger, status: "skipped", counts, durationMs: 0, error: "not due yet" };
    }
    const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
    if (!apiKey) return await finish("failed", "no TMDB key");
    // Heal any seen-map gap left by an earlier partial-write failure
    // before this run dedupes (idempotent; no-op when nothing is missing).
    // Throws on a failed required read/write (round 7): the throw
    // propagates to the outer catch, which re-reads state fresh and
    // records the failure there — the run must NOT continue on its
    // older in-memory state and save it over a newer config.
    await this._withAdminLock(() => reconcileDiscoveryState(env, state));
    try {
      const ymd = (d) => d.toISOString().slice(0, 10);
      const lastDate = state.lastRun && state.lastRun.at ? state.lastRun.at.slice(0, 10) : ymd(new Date(started - 7 * 864e5));
      const from = ymd(new Date(Date.parse(lastDate + "T00:00:00Z") - 864e5));
      const to = ymd(new Date(started));
      const lists = [];
      if (state.sources.tmdb) {
        // Sorted by popularity INSIDE the date window (2026-11-13 fix):
        // date-desc filled the budget with the most recently ADDED TMDB
        // entries — mostly obscure docs/indie — while the titles anyone
        // would actually want sat in the overflow. Popularity-desc picks
        // the notable recent titles first.
        lists.push({ via: "tmdb-discover", type: "movie", path: "/discover/movie?primary_release_date.gte=" + from + "&primary_release_date.lte=" + to + "&sort_by=popularity.desc&page=1" });
        lists.push({ via: "tmdb-discover", type: "tv", path: "/discover/tv?first_air_date.gte=" + from + "&first_air_date.lte=" + to + "&sort_by=popularity.desc&page=1" });
      }
      if (state.sources.trending) {
        lists.push({ via: "tmdb-trending", type: "movie", path: "/trending/movie/week?page=1" });
        lists.push({ via: "tmdb-trending", type: "tv", path: "/trending/tv/week?page=1" });
      }
      if (state.sources.upcoming) lists.push({ via: "tmdb-upcoming", type: "movie", path: "/movie/upcoming?page=1" });
      // Strict reads (G2): the swallowing getSeen()/getPending() return {}
      // on a KV read failure, and the run would then spend its detail
      // budget on already-seen titles and report "ok" with 0 filed. A
      // failed read must fail the run through the existing failure-
      // recording path instead of continuing with blind dedupe state.
      const seen = await getSeenStrict(env);
      const pend = await getPendingStrict(env);
      const liveList = await this.listMovies(env);
      const wanted = new Map();
      for (const L of lists) {
        let data = null;
        try { data = await tmdbGet(L.path, apiKey); } catch (e) { data = null; }
        if (!data || !Array.isArray(data.results)) { counts.failed++; continue; }
        counts.bySource[L.via] = (counts.bySource[L.via] || 0) + data.results.length;
        for (const r of data.results) {
          counts.fetched++;
          const tmdb = r.id;
          if (tmdb == null) { counts.skipped++; continue; }
          const key = L.type + ":" + tmdb;
          if (wanted.has(key)) continue;
          const s = seen[key];
          if (s && (s.status === "pending" || s.status === "approved" || s.status === "rejected" || s.status === "live-dup" || s.status === "skipped")) { counts.duplicates++; continue; }
          wanted.set(key, { tmdb, type: L.type, via: L.via, popularity: r.popularity || 0 });
        }
      }
      // Second pass: duplicate check against live + queue (covers titles
      // the seen-map does not know yet, e.g. manually added entries).
      // The probe carries the TMDB id, so the id match is what matters.
      const fresh = [];
      const liveDup = [];
      for (const w of wanted.values()) {
        const dup = findDuplicate({ title: "", tmdb: w.tmdb, year: "" }, liveList, pend, null);
        if (dup) { counts.duplicates++; liveDup.push({ type: w.type, tmdb: w.tmdb, title: dup.title || "", status: dup.where === "live" ? "live-dup" : ((pend[dup.id] && pend[dup.id].status) || "pending") }); continue; }
        fresh.push(w);
      }
      const budget = Math.max(1, Math.min(30, state.budget.maxNewPerRun || 15));
      const detailBudget = Math.max(budget, Math.min(40, state.budget.maxDetailCalls || 30));
      // Popularity-first across ALL lists (2026-11-13 fix): the budget
      // takes the most popular fresh titles first, whatever list found
      // them — a trending hit outranks an obscure new release.
      fresh.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
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
      counts.skipped += Math.max(0, fresh.length - toFile.length);
      // Batch writes inside the admin lock so a concurrent admin action
      // cannot clobber the queue update. Seen and queue are re-read
      // inside the lock (an approve/reject mid-run must not be
      // overwritten), and each candidate is re-checked against them
      // before inserting — a second run that slipped past the overlap
      // guard cannot double-file the same title (hardening 2026-11-13).
      await this._withAdminLock(async () => {
        // Strict reads (review 2026-11-13 item 1): the swallowing
        // getPending()/getSeen() return {} on a KV read failure, and
        // the unconditional saves below would then ERASE the queue /
        // seen-map. A failed read must fail the run, never a write.
        const pendNow = await getPendingStrict(env);
        const seenNow = await getSeenStrict(env);
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
      });
      return await finish("ok", null);
    } catch (e) {
      // Heal any partial write from the run that just failed, so the
      // failed run itself leaves queue/seen consistent. If the
      // reconciler itself fails it throws (round 7) and propagates to
      // the outer catch, which records the failure on freshly-read
      // state — the original error text is then replaced by the
      // reconciler's, but the run stays failed and no stale state
      // is saved.
      await this._withAdminLock(() => reconcileDiscoveryState(env, state));
      return await finish("failed", String((e && e.message) || e));
    }
    } catch (e) {
      // Setup failure (state read / TMDB-key read threw, or finish()
      // threw while saving): record a failed run if state is reachable,
      // otherwise return the failure inline. Queue/seen/totals untouched.
      // Strict re-read (item 1): the swallowing getDiscoveryState()
      // would return defaults on failure and the save below would then
      // reset the real config — unreachable state must stay untouched.
      try {
        // Lock the failure record too (config-race fix): the fresh re-read
        // is content-safe, but a config save between the read and the save
        // would still be clobbered without the lock. Narrow window, failure
        // path only — closed the same way as finish().
        const s2 = await this._withAdminLock(async () => {
          const s = await getDiscoveryStateStrict(env);
          s.lastRun = { at: runAt, trigger, status: "failed", counts, durationMs: Date.now() - started, error: String((e && e.message) || e) };
          s.nextRunAt = nextRunAtFor(s.frequency, started);
          await saveDiscoveryState(env, s);
          return s;
        });
        return s2.lastRun;
      } catch (e2) {
        return { at: runAt, trigger, status: "failed", counts, durationMs: Date.now() - started, error: String((e && e.message) || e) };
      }
    } finally {
      this._discoveryRunning = false;
    }
  }

  // Promise-chain mutex serializing admin KV read-modify-write sequences
  // (ext:movies + ext:pending). KV puts are last-write-wins with no CAS,
  // so two near-simultaneous admin calls (e.g. two quick Approve taps)
  // could otherwise lose each other's update; every admin writer below
  // runs inside this lock. The chain survives rejections.
  _withAdminLock(fn){
    const prev = this._adminLock || Promise.resolve();
    const next = prev.then(() => fn());
    this._adminLock = next.catch(() => {});
    return next;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const env = this.env;

    if (path === "/__tunnel") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation API: state.acceptWebSocket(), NOT server.accept() —
      // plain accept() pins the DO in memory and bills duration for the
      // connection's whole life. Message/close handling lives in the
      // webSocketMessage/webSocketClose class methods above.
      const old = this.tunnelWs();
      if (old) { try { old.close(1012, "replaced"); } catch {} }
      for (const [, p] of this.pending) p.reject(new Error("tunnel replaced"));
      this.pending.clear();
      this.expectBodyFor = null;
      this.state.acceptWebSocket(server, ["tunnel"]);
      server.send(JSON.stringify({ t: "hello" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/__health") {
      return json({ tunnel: this.tunnelWs() ? "up" : "down" });
    }

    // ---- Direct APK link (2026-10-28): permanent download link for
    // the latest app build, usable when the in-app updater can't run
    // (e.g. the app crashes on launch). 302, not 301, so the target
    // can move later without browsers caching a stale redirect.
    if (path === "/apk") {
      return Response.redirect("https://pub-89e47025e7844f1eaf672a00cfdbba12.r2.dev/app/RedowanskyLibrary.apk", 302);
    }

    // AdMob provider test APK (2026-10-28): separate package, does not
    // touch the library app. Same /apk pattern, separate route.
    if (path === "/apk-test") {
      return Response.redirect("https://pub-89e47025e7844f1eaf672a00cfdbba12.r2.dev/app/AdMobTest.apk", 302);
    }

    // ---- Google sync: auth + progress (before the S3 gate below) ----
    if (path === "/auth/login" && request.method === "GET") {
      if (!env.GOOGLE_CLIENT_SECRET) return new Response("Google sign-in is not configured yet (client secret missing)", { status: 503 });
      const state = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
      await env.DATA_KV.put("oauth-state:" + state, "1", { expirationTtl: 600 });
      const q = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: "code", scope: "openid email profile", state, prompt: "select_account",
      });
      return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q.toString(), 302);
    }
    if (path === "/auth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state) return new Response("missing code/state", { status: 400 });
      const ok = await env.DATA_KV.get("oauth-state:" + state);
      if (!ok) return new Response("expired or invalid sign-in — try again", { status: 400 });
      await env.DATA_KV.delete("oauth-state:" + state);
      if (!env.GOOGLE_CLIENT_SECRET) return new Response("Google sign-in is not configured yet", { status: 503 });
      try {
        const form = new URLSearchParams({
          code, client_id: GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code",
        });
        const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: form });
        const tj = await tr.json();
        if (!tj.id_token) return new Response("Google sign-in failed", { status: 502 });
        const user = await verifyGoogleIdToken(tj.id_token);
        if (!user) return new Response("Google sign-in verification failed", { status: 502 });
        const sid = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
        const exp = Date.now() + 30 * 24 * 3600 * 1000;
        await env.DATA_KV.put("session:" + sid, JSON.stringify({ sub: user.sub, name: user.name, email: user.email, exp }), { expirationTtl: 30 * 24 * 3600 });
        return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": sessionCookie(sid, 30 * 24 * 3600) } });
      } catch (e) { return new Response("Google sign-in error: " + String(e.message || e).slice(0, 200), { status: 502 }); }
    }
    // ---- Amazon sign-in (Login with Amazon, mirrors Google above) ----
    if (path === "/auth/amazon/login" && request.method === "GET") {
      if (!env.AMAZON_CLIENT_SECRET || !AMAZON_CLIENT_ID || AMAZON_CLIENT_ID.startsWith("AMAZON_")) return new Response("Amazon sign-in is not configured yet (security profile missing)", { status: 503 });
      const state = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
      const pkce = await pkcePair();
      await env.DATA_KV.put("oauth-amzn-state:" + state, pkce.verifier, { expirationTtl: 600 });
      const q = new URLSearchParams({
        client_id: AMAZON_CLIENT_ID, redirect_uri: AMAZON_REDIRECT_URI,
        response_type: "code", scope: "profile", state,
        code_challenge: pkce.challenge, code_challenge_method: "S256",
      });
      return Response.redirect("https://www.amazon.com/ap/oa?" + q.toString(), 302);
    }
    if (path === "/auth/amazon/callback" && request.method === "GET") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state) return new Response("missing code/state", { status: 400 });
      const verifier = await env.DATA_KV.get("oauth-amzn-state:" + state);
      if (!verifier) return new Response("expired or invalid sign-in — try again", { status: 400 });
      await env.DATA_KV.delete("oauth-amzn-state:" + state);
      if (!env.AMAZON_CLIENT_SECRET || !AMAZON_CLIENT_ID || AMAZON_CLIENT_ID.startsWith("AMAZON_")) return new Response("Amazon sign-in is not configured yet", { status: 503 });
      try {
        const form = new URLSearchParams({
          grant_type: "authorization_code", code, redirect_uri: AMAZON_REDIRECT_URI,
          client_id: AMAZON_CLIENT_ID, client_secret: env.AMAZON_CLIENT_SECRET,
          code_verifier: verifier,
        });
        const tr = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", body: form });
        const tj = await tr.json();
        if (!tj.access_token) return new Response("Amazon sign-in failed", { status: 502 });
        const user = await verifyAmazonAccessToken(tj.access_token);
        if (!user) return new Response("Amazon sign-in verification failed", { status: 502 });
        const sid = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
        const exp = Date.now() + 30 * 24 * 3600 * 1000;
        await env.DATA_KV.put("session:" + sid, JSON.stringify({ sub: user.sub, name: user.name, email: user.email, provider: "amazon", exp }), { expirationTtl: 30 * 24 * 3600 });
        return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": sessionCookie(sid, 30 * 24 * 3600) } });
      } catch (e) { return new Response("Amazon sign-in error: " + String(e.message || e).slice(0, 200), { status: 502 }); }
    }
    if (path === "/auth/logout" && request.method === "GET") {
      const s = await sessionFromRequest(env, request);
      if (s) await env.DATA_KV.delete("session:" + s.id);
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "lb_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" } });
    }
    if (path === "/auth/me" && request.method === "GET") {
      const s = await sessionFromRequest(env, request);
      if (!s) return json({ signedIn: false });
      return json({ signedIn: true, name: s.name || "", email: s.email || "", provider: s.provider || "google" });
    }
    // v0.6.27 gate: one line covers GET/POST/DELETE below.
    if (path === "/api/progress" && appVersionBlocked(request)) return appVersionRefused();
    if (path === "/api/progress" && request.method === "GET") {
      // Caller is either the site (session cookie) or the app (Bearer ID token) — same auth as POST.
      let sub = null, name = "";
      const sess = await sessionFromRequest(env, request);
      if (sess) { sub = sess.sub; name = sess.name || ""; }
      if (!sub) {
        const auth = request.headers.get("Authorization") || "";
        const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const user = await verifyGoogleIdToken(tok);
        if (user) { sub = user.sub; name = user.name || ""; }
      }
      if (!sub) {
        const auth = request.headers.get("Authorization") || "";
        const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const auser = await verifyAmazonAccessToken(tok);
        if (auser) { sub = auser.sub; name = auser.name || ""; }
      }
      if (!sub) return json({ signedIn: false, entries: [] });
      try {
        const list = await env.DATA_KV.list({ prefix: "progress:" + sub + ":" });
        const entries = [];
        for (const k of list.keys) {
          const v = await env.DATA_KV.get(k.name, "json");
          if (v) entries.push(v);
        }
        entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return json({ signedIn: true, name, entries });
      } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (path === "/api/progress" && request.method === "POST") {
      // Caller is either the site (session cookie) or the app (Bearer ID token).
      let sub = null, who = null;
      const sess = await sessionFromRequest(env, request);
      if (sess) { sub = sess.sub; who = "session"; }
      if (!sub) {
        const auth = request.headers.get("Authorization") || "";
        const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const user = await verifyGoogleIdToken(tok);
        if (user) { sub = user.sub; who = "token"; }
      }
      if (!sub) {
        const auth = request.headers.get("Authorization") || "";
        const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const auser = await verifyAmazonAccessToken(tok);
        if (auser) { sub = auser.sub; who = "amazon-token"; }
      }
      if (!sub) return json({ error: "not signed in" }, 401);
      let b = {};
      try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const items = Array.isArray(b.entries) ? b.entries : [b];
      const saved = [];
      for (const it of items) {
        const id = progressId(it.id);
        if (!id) continue;
        const pos = Number(it.pos || 0), dur = Number(it.dur || 0);
        if (!(pos >= 0) || !(dur > 0)) continue;
        const updatedAt = Number(it.updatedAt || it.ts || 0) || Date.now();
        // Last-write-wins: never let an older write clobber a newer one.
        const key = "progress:" + sub + ":" + id;
        const old = await env.DATA_KV.get(key, "json");
        if (old && (old.updatedAt || 0) > updatedAt) { saved.push({ id, kept: "existing" }); continue; }
        const rec = {
          id, title: String(it.title || "").slice(0, 200), poster: String(it.poster || "").slice(0, 500),
          type: String(it.type || "movie").slice(0, 20), url: String(it.url || "").slice(0, 1000),
          viewUrl: String(it.viewUrl || "").slice(0, 500), pos, dur, done: pos >= dur - 45,
          updatedAt,
        };
        // Resolve a site resume link for app entries that only carry a catalog id.
        if (!rec.viewUrl && id) {
          try {
            const ext = await getExtMovies(this.state.storage);
            if (ext[id]) rec.viewUrl = "/view/ext/" + id;
          } catch {}
        }
        await env.DATA_KV.put(key, JSON.stringify(rec));
        saved.push({ id, kept: "saved" });
      }
      return json({ ok: true, via: who, saved });
    }
    if (path === "/api/progress" && request.method === "DELETE") {
      const s = await sessionFromRequest(env, request);
      if (!s) return json({ error: "not signed in" }, 401);
      const id = progressId(url.searchParams.get("id"));
      if (!id) return json({ error: "id required" }, 400);
      await env.DATA_KV.delete("progress:" + s.sub + ":" + id);
      return json({ ok: true });
    }

    // App feature: "Ask for a movie". Requests land in DATA_KV as
    // requests:<ts>:<rand> JSON {title,name,email,ts,ip}. The mailbox
    // these get forwarded to lives only in this Worker, never in the app.
    if (path === "/api/request" && request.method === "POST") {
      let b = {};
      try { b = await request.json(); } catch {}
      const title = String(b.title || "").trim().slice(0, 200);
      if (!title) return json({ ok: false, error: "title required" }, 400);
      const rec = {
        title,
        name: String(b.name || "Guest").slice(0, 100),
        email: String(b.email || "").slice(0, 120),
        ts: Date.now(),
        ip: request.headers.get("CF-Connecting-IP") || "",
      };
      const key = "requests:" + rec.ts + ":" + Math.random().toString(36).slice(2, 8);
      // Forward to the library mailbox via the MAILER send_email binding
      // (destination verified in Cloudflare Email Routing). The outcome is
      // stored on the record itself, so delivery is auditable from KV.
      if (env.MAILER) {
        try {
          const when = new Date(rec.ts).toISOString();
          const raw =
            "From: Redowansky Library <requests@redowansky.bond>\r\n" +
            "To: hi@redowansky.cyou\r\n" +
            "Subject: " + ("[Library] Movie request: " + rec.title).replace(/[\r\n]+/g, " ") + "\r\n" +
            "Date: " + new Date(rec.ts).toUTCString() + "\r\n" +
            "Message-ID: <" + rec.ts + "." + Math.random().toString(36).slice(2, 10) + "@redowansky.bond>\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
            "New movie request from the Redowansky Library app.\n\n" +
            "Movie: " + rec.title + "\n" +
            "Requested by: " + rec.name + (rec.email ? " <" + rec.email + ">" : "") + "\n" +
            "When: " + when + "\n";
          await env.MAILER.send(new EmailMessage("requests@redowansky.bond", "hi@redowansky.cyou", raw));
          rec.mail = "sent";
        } catch (e) {
          rec.mailError = String(e && e.message || e).slice(0, 200);
        }
      }
      await env.DATA_KV.put(key, JSON.stringify(rec));
      return json({ ok: true });
    }


    if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
      return new Response("storage backend not configured", { status: 500 });

    try {
      if (path === "/" || path === "/index.html")
        return this.pageResp(PAGE, request);
      if (path === "/admin" || path === "/admin.html")
        return new Response(ADMIN_PAGE, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
      if (path === "/api/admin/upload" && request.method === "PUT") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const bucket = url.searchParams.get("bucket"), key = url.searchParams.get("key");
        if (!bucket || !key) return json({ error: "missing bucket/key" }, 400);
        const ct = request.headers.get("content-type") || "application/octet-stream";
        const r = await this.s3fetch("PUT", "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/"),
          { headers: { "content-type": ct }, body: request.body, unsignedPayload: true });
        if (![200, 201, 204].includes(r.status)) return new Response(bufToText(r.body), { status: r.status });
        return json({ ok: true });
      }
      if (path === "/api/admin/buckets" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { name } = await request.json();
        if (!/^[a-z0-9-]{3,63}$/.test(name || "")) return json({ error: "bad shelf name (a-z, 0-9, -)" }, 400);
        const r = await this.s3fetch("PUT", "/" + name);
        if (![200, 201, 204].includes(r.status)) return new Response(bufToText(r.body), { status: r.status });
        return json({ ok: true });
      }
      if (path === "/api/admin/buckets" && request.method === "DELETE") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const name = url.searchParams.get("name");
        if (!name) return json({ error: "missing name" }, 400);
        // delete all objects first, then the bucket
        const lr = await this.s3fetch("GET", "/" + name, { query: "list-type=2&max-keys=1000" });
        if (lr.status < 400) {
          const keys = [...bufToText(lr.body).matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(m => m[1]);
          for (const k of keys) await this.s3fetch("DELETE", "/" + name + "/" + k.split("/").map(encodeURIComponent).join("/"));
        }
        const r = await this.s3fetch("DELETE", "/" + name);
        if (![200, 201, 204, 404].includes(r.status)) return new Response(bufToText(r.body), { status: r.status });
        return json({ ok: true });
      }
      // Stream token mint (app 0.6.28+ / site player): a current
      // app build (or any browser) gets a 24h token for one R2 key.
      // Old app builds are refused, same as the catalog gate.
      if (path === "/api/play-token" && request.method === "GET") {
        const key = url.searchParams.get("key") || "";
        if (!key || key.split("/").includes("..")) return json({ error: "key required" }, 400);
        if (appVersionBlocked(request)) return appVersionRefused();
        if (!env.PLAY_TOKEN_SECRET) return json({ error: "streaming not configured" }, 500);
        const tok = await mintStreamToken(env, key);
        return json({ token: tok, stream: "/stream/" + key.split("/").map(encodeURIComponent).join("/") + "?t=" + tok });
      }
      // Signed stream (app 0.6.28+ / site player): serves one R2
      // object from the MEDIA binding, Range-aware, only with a
      // valid token. No token = no bytes, for any client.
      if (path.startsWith("/stream/") && (request.method === "GET" || request.method === "HEAD")) {
        const key = path.slice(8).split("/").map(decodeURIComponent).join("/");
        if (!key || key.split("/").includes("..")) return json({ error: "bad key" }, 400);
        const tok = url.searchParams.get("t") || "";
        if (!await verifyStreamToken(env, key, tok)) return appVersionRefused();
        const dl = url.searchParams.get("download") === "1";
        const head = await env.MEDIA.head(key);
        if (!head) return json({ error: "not found" }, 404);
        const size = head.size;
        const ctype = (head.httpMetadata && head.httpMetadata.contentType) || mimeType(key);
        const baseHeaders = { "accept-ranges": "bytes", "cache-control": "no-store, private", "content-type": ctype };
        if (dl) baseHeaders["content-disposition"] = 'attachment; filename="' + key.split("/").pop().replace(/"/g, "") + '"';
        if (request.method === "HEAD") return new Response(null, { headers: { ...baseHeaders, "content-length": String(size) } });
        const rangeHdr = request.headers.get("range");
        if (!rangeHdr) {
          const obj = await env.MEDIA.get(key);
          if (!obj) return json({ error: "not found" }, 404);
          return new Response(obj.body, { headers: { ...baseHeaders, "content-length": String(size) } });
        }
        const m = rangeHdr.match(/bytes=(\d*)-(\d*)/);
        if (!m) return new Response(null, { status: 416, headers: { ...baseHeaders, "content-range": "bytes */" + size } });
        let start, end;
        if (m[1] === "" && m[2] !== "") {
          const n = parseInt(m[2], 10);
          start = Math.max(0, size - n); end = size - 1;
        } else {
          start = parseInt(m[1] || "0", 10);
          end = m[2] !== "" ? parseInt(m[2], 10) : size - 1;
        }
        if (isNaN(start) || isNaN(end) || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { ...baseHeaders, "content-range": "bytes */" + size } });
        }
        end = Math.min(end, size - 1);
        const len = end - start + 1;
        const obj = await env.MEDIA.get(key, { range: { offset: start, length: len } });
        if (!obj) return json({ error: "not found" }, 404);
        return new Response(obj.body, { status: 206, headers: { ...baseHeaders, "content-length": String(len), "content-range": "bytes " + start + "-" + end + "/" + size } });
      }
      // Pre-play version check (app 0.6.27+): the server decides
      // whether this build may still play. 200 = allowed, 426 =
      // refused with the update warning message.
      if (path === "/api/version-check" && request.method === "GET") {
        if (appVersionBlocked(request)) return appVersionRefused();
        return json({ ok: true, latest: LATEST_APP_VERSION });
      }
      // Public: list all movies with metadata
      if (path === "/api/movies" && request.method === "GET" && appVersionBlocked(request)) return appVersionRefused();
      if (path === "/api/movies" && request.method === "GET") {
        return json({ movies: await this.listMovies(env) });
      }
      // Public: robots.txt — standard crawler lines + sitemap pointer.
      // Note: if Cloudflare's own AI-signal robots.txt takes precedence at
      // the edge, that is a dashboard setting, not this Worker — verify live.
      if (path === "/robots.txt" && request.method === "GET") {
        return new Response("User-agent: *\nAllow: /\n\nSitemap: https://redowansky.bond/sitemap.xml\n", { headers: { "content-type": "text/plain;charset=utf-8", "cache-control": "public, max-age=3600" } });
      }
      // Public: app-ads.txt — AdMob app verification for the unlisted
      // "Redowansky Library" app (ca-app-pub-1642095506798662). AdMob
      // crawls this when the app is submitted for verification.
      if (path === "/app-ads.txt" && request.method === "GET") {
        return new Response("google.com, pub-1642095506798662, DIRECT, f08c47fec0942fa0\n", { headers: { "content-type": "text/plain;charset=utf-8", "cache-control": "public, max-age=3600" } });
      }
      // Public: privacy policy for the Redowansky Library app + site.
      // Linked from the Amazon Appstore listing (apps that collect
      // personal information must provide a policy URL).
      if (path === "/privacy" && request.method === "GET") {
        const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
          + "<title>Privacy Policy — Redowansky Library</title>"
          + "<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:24px}h2{font-size:18px;margin-top:28px}a{color:#0a6}</style></head><body>"
          + "<h1>Privacy Policy — Redowansky Library</h1><p>Effective: October 30, 2026. This policy covers the Redowansky Library Android app and the redowansky.bond website.</p>"
          + "<h2>Information we collect</h2><ul>"
          + "<li><b>Account information (only if you sign in):</b> when you sign in with Google or Amazon, we receive your name and email address (and profile photo from Google) from that provider. This runs your account and syncs your watch progress across devices.</li>"
          + "<li><b>Watch progress and preferences:</b> what you watched, where you stopped, and your download list, so Continue Watching and sync work.</li>"
          + "<li><b>Movie requests:</b> if you use “Ask for a Movie”, your message is stored and emailed to the developer so the request can be handled.</li>"
          + "<li><b>Push notification token (only if you allow notifications):</b> a device token used to send notifications. No notification content is stored.</li>"
          + "<li><b>Advertising identifiers:</b> the app shows ads from Google AdMob and Mondiad. Those ad partners may collect device information and advertising identifiers to serve ads, under their own privacy policies.</li>"
          + "</ul><p>We do not collect payment information — there are no purchases inside the app.</p>"
          + "<h2>How information is used</h2><p>To run the app, sync your progress, respond to your requests, send notifications you allowed, and show ads that keep the service free.</p>"
          + "<h2>Sharing</h2><p>We do not sell your personal information. It is shared only with the service providers needed to run the app: Google or Amazon (sign-in and sync) and the ad partners named above.</p>"
          + "<h2>Your choices</h2><p>You can use the app without signing in — your progress then stays on your device only. You can ask us to delete your synced account data at any time by contacting us at the address below.</p>"
          + "<h2>Children</h2><p>The app is not directed at children under 13, and we do not knowingly collect information from them.</p>"
          + "<h2>Changes</h2><p>This policy may be updated from time to time; the current version is always published on this page.</p>"
          + "<h2>Contact</h2><p>Questions or deletion requests: <a href='mailto:hi@redowansky.cyou'>hi@redowansky.cyou</a>.</p>"
          + "</body></html>";
        return new Response(html, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "public, max-age=3600" } });
      }
      // Public: sitemap generated from the live catalog (home + one view page per title)
      if (path === "/sitemap.xml" && request.method === "GET") {
        const movies = await this.listMovies(env);
        const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const urls = ["https://redowansky.bond/"];
        for (const m of movies) {
          urls.push(m.external
            ? "https://redowansky.bond/view/ext/" + m.id
            : "https://redowansky.bond/view/" + encodeURIComponent(m.bucket) + "/" + m.key.split("/").map(encodeURIComponent).join("/"));
        }
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
          + urls.map(u => "  <url><loc>" + esc(u) + "</loc></url>").join("\n") + "\n</urlset>";
        return new Response(xml, { headers: { "content-type": "application/xml;charset=utf-8", "cache-control": "public, max-age=3600" } });
      }
      // Admin: add external movie link
      if (path === "/api/admin/external" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = await request.json();
        let { video_url, tmdb_id, type, title, sources, poster } = body;
        // Multi-source: [{label, url}] for audio/language versions
        let srcList = [];
        if (Array.isArray(sources)) {
          for (const s of sources) {
            const u = s && s.url ? cleanSrcUrl(s.url) : null;
            if (u) srcList.push({ label: (s.label || "Version " + (srcList.length + 1)).slice(0, 30), url: toDirectUrlSrv(u) });
          }
        }
        if (!video_url && srcList.length) video_url = srcList[0].url;
        if (!video_url) return json({ error: "need video_url" }, 400);
        video_url = toDirectUrlSrv(video_url);
        video_url = cleanSrcUrl(video_url);
        if (!video_url) return json({ error: "invalid video URL" }, 400);
        if (!srcList.length) srcList = [{ label: "Default", url: video_url }];
        const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        let meta = { title: title || video_url, year: null, overview: null, poster: cleanImgUrl(poster), backdrop: null, vote: null, genres: [], type: type || "movie", tmdb: null };
        if (tmdb_id && apiKey) {
          const d = await tmdbGet("/" + (type || "movie") + "/" + tmdb_id, apiKey);
          if (d) meta = { title: d.title || d.name, year: (d.release_date || d.first_air_date || "").slice(0, 4), overview: d.overview, poster: d.poster_path, backdrop: d.backdrop_path, vote: d.vote_average?.toFixed(1), genres: (d.genres || []).map(x => x.name), type: type || "movie", tmdb: tmdb_id };
        }
        try {
          return await this._withAdminLock(async () => {
          const fb = await freezeBlock(this.state); if (fb) return fb;
          // F1: this route no longer publishes. It is a pending-submission
          // alias of POST /api/admin/pending -- it validates like a
          // submission, writes a candidate to ext:pending, and returns
          // the pending id. Publication still requires a separate
          // approve. Nothing is written to ext:movies here, and the
          // candidate never carries a pendingId.
          const cand = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sources: srcList, discoveredVia: "manual", note: "", status: "pending", createdAt: Date.now(), ...meta };
          const dup = findDuplicate(cand, await this.listMovies(env, { strictExt: true }), await getPendingStrict(env), null);
          if (dup && !body.force) return json({ error: "duplicate", duplicate: dup }, 409);
          const pend = await getPendingStrict(env);
          pend[cand.id] = cand;
          await savePending(env, pend);
          return json({ ok: true, id: cand.id, title: cand.title, duplicate: dup || null, queued: true });
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Admin: publish/unpublish an external entry (flip unlisted).
      // Lets an embed entry into the home catalog + app feed (listed)
      // or back to direct-URL-only (unlisted). Inert until called.
      if (path === "/api/admin/extpublish" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { id, unlisted } = await request.json();
        try {
          return await this._withAdminLock(async () => {
          const fb = await freezeBlock(this.state); if (fb) return fb;
          const extObj = await getExtMoviesStrict(this.state.storage);
          if (!extObj[id]) return json({ error: "not found" }, 404);
          // F1 provenance guard (listing branch only): an entry may be
          // made public only if it carries a pendingId assigned by the
          // successful server-side approval path. The regex is a format
          // sanity check only -- it is not proof of provenance. Hiding
          // (unlisted: true) is the safe direction and is never blocked.
          if (!unlisted) {
            const pid = extObj[id].pendingId;
            if (!(typeof pid === "string" && /^p[0-9a-z]{8,13}$/.test(pid))) return json({ error: "not approved — re-approve via the queue" }, 400);
          }
          extObj[id].unlisted = !!unlisted;
          await saveExtMovies(this.state.storage, extObj);
          return json({ ok: true, id, unlisted: extObj[id].unlisted });
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Admin: YouTube title + thumbnail lookup (F1: read-only). Given a
      // YouTube URL, returns { title, poster } from oEmbed. Writes
      // nothing -- the admin uses the returned values to submit a metadata
      // proposal (POST /api/admin/pending/meta) if they want them.
      if (path === "/api/admin/ytinfo" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const u = (body.url || body.video_url || "");
        let vid = null, i = -1;
        i = u.indexOf("youtu.be/"); if (i >= 0) vid = u.slice(i + 9).split(/[/?#]/)[0];
        if (!vid) { i = u.indexOf("v="); if (i >= 0) vid = u.slice(i + 2).split(/[&#]/)[0]; }
        if (!vid) { i = u.indexOf("/shorts/"); if (i >= 0) vid = u.slice(i + 8).split(/[/?#]/)[0]; }
        if (!vid) return json({ error: "not a YouTube link" }, 400);
        const oe = await fetch("https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + vid) + "&format=json");
        if (!oe.ok) return json({ error: "YouTube lookup failed" }, 502);
        const info = await oe.json().catch(() => ({}));
        return json({ ok: true, title: info.title || null, poster: "https://img.youtube.com/vi/" + vid + "/hqdefault.jpg" });
      }
      // Admin: delete external movie link
      if (path === "/api/admin/external" && request.method === "DELETE") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const id = url.searchParams.get("id");
        try {
          return await this._withAdminLock(async () => {
          const fb = await freezeBlock(this.state); if (fb) return fb;
          const extObj = await getExtMoviesStrict(this.state.storage);
          delete extObj[id];
          await saveExtMovies(this.state.storage, extObj);
          return json({ ok: true });
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // ---- Approval queue (Phase 1) ----
      // List pending + rejected candidates (admin only; nothing here is
      // reachable from any public route).
      if (path === "/api/admin/pending" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const pend = await getPending(env);
        const all = Object.values(pend).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return json({ ok: true, pending: all.filter(c => c.status === "pending"), rejected: all.filter(c => c.status === "rejected") });
      }
      // Admin: look up catalogue entries by id prefix or title substring.
      // F1: used by the admin UI to find a target for a metadata proposal.
      // Includes unlisted entries (the public feed does not). Authentication
      // protected, strict read only (an unreadable catalogue is a 500, not
      // an empty list), no-store, at most 100 results, exactly 7 fields
      // per entry -- the raw pendingId is never returned.
      if (path === "/api/admin/entries" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const q = (url.searchParams.get("q") || "");
        if (q.length > 100) return json({ error: "query too long (max 100 chars)" }, 400);
        try {
          const extObj = await getExtMoviesStrict(this.state.storage);
          const needle = q.trim().toLowerCase();
          const out = [];
          for (const e of Object.values(extObj)) {
            if (!e || !e.id) continue;
            if (needle) {
              const idHit = String(e.id).toLowerCase().startsWith(needle);
              const titleHit = e.title && String(e.title).toLowerCase().indexOf(needle) >= 0;
              if (!idHit && !titleHit) continue;
            }
            out.push({ id: e.id, title: e.title || "", type: e.type || "movie", tmdb: e.tmdb != null ? e.tmdb : null, unlisted: !!e.unlisted, hasPendingId: typeof e.pendingId === "string" && e.pendingId.length > 0, poster: e.poster || null });
            if (out.length >= 100) break;
          }
          return new Response(JSON.stringify({ ok: true, entries: out }), { status: 200, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Add a candidate to the queue. Duplicate (TMDB id, else title+year)
      // against the live catalogue AND the queue -> 409 unless force:true.
      if (path === "/api/admin/pending" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const title = (body.title || "").toString().trim();
        if (!title) return json({ error: "need title" }, 400);
        const type = body.type === "series" ? "series" : "movie";
        const tmdb = body.tmdb != null && String(body.tmdb).trim() !== "" ? body.tmdb : null;
        // Sources are metadata only ({label, url}) — no video is fetched,
        // downloaded, or stored by the queue.
        let srcList = [];
        if (Array.isArray(body.sources)) for (const s of body.sources) { const u = s && s.url ? cleanSrcUrl(s.url) : null; if (u) srcList.push({ label: (s.label || "Source " + (srcList.length + 1)).slice(0, 30), url: toDirectUrlSrv(u) }); }
        const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        let meta = { year: body.year ? String(body.year).slice(0, 4) : null, overview: body.overview || null, poster: cleanImgUrl(body.poster), backdrop: cleanImgUrl(body.backdrop), vote: body.vote != null ? body.vote : null, genres: Array.isArray(body.genres) ? body.genres.slice(0, 10) : [] };
        if (tmdb && apiKey) {
          const d = await tmdbGet("/" + type + "/" + tmdb, apiKey);
          if (d) meta = { year: (d.release_date || d.first_air_date || "").slice(0, 4) || meta.year, overview: d.overview || meta.overview, poster: d.poster_path || meta.poster, backdrop: d.backdrop_path || meta.backdrop, vote: d.vote_average != null ? d.vote_average.toFixed(1) : meta.vote, genres: (d.genres || []).map(x => x.name) };
        }
        const cand = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, type, tmdb, sources: srcList, discoveredVia: (body.discoveredVia || "manual").toString().slice(0, 40), note: (body.note || "").toString().slice(0, 500), status: "pending", createdAt: Date.now(), ...meta };
        try {
          return await this._withAdminLock(async () => {
          const dup = findDuplicate(cand, await this.listMovies(env, { strictExt: true }), await getPendingStrict(env), null);
          if (dup && !body.force) return json({ error: "duplicate", duplicate: dup }, 409);
          const pend = await getPendingStrict(env);
          pend[cand.id] = cand;
          await savePending(env, pend);
          return json({ ok: true, id: cand.id, title: cand.title, duplicate: dup || null });
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Propose a metadata change (title and/or poster) for a live entry.
      // F1: the change is a proposal in the existing queue -- it is NOT
      // applied until POST /api/admin/pending/approve approves it. The
      // `expected` values are captured server-side from a strict read
      // inside the lock; any `expected` in the request body is ignored.
      // Sources are never editable through this mechanism.
      if (path === "/api/admin/pending/meta" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const targetId = (body.targetId || "").toString();
        if (!targetId) return json({ error: "need targetId" }, 400);
        if (body.sources != null) return json({ error: "sources are not editable via a metadata proposal" }, 400);
        const rawChanges = body.changes && typeof body.changes === "object" ? body.changes : {};
        if (rawChanges.sources != null) return json({ error: "sources are not editable via a metadata proposal" }, 400);
        const changes = {};
        if (rawChanges.title != null) {
          const t = String(rawChanges.title).trim();
          if (!t) return json({ error: "title must not be empty" }, 400);
          if (t.length > 200) return json({ error: "title too long (max 200 chars)" }, 400);
          changes.title = t;
        }
        if (rawChanges.poster != null) {
          const p = cleanImgUrl(rawChanges.poster);
          if (!p) return json({ error: "invalid poster URL" }, 400);
          changes.poster = p;
        }
        if (!Object.keys(changes).length) return json({ error: "no changes" }, 400);
        try {
          return await this._withAdminLock(async () => {
          const extObj = await getExtMoviesStrict(this.state.storage);
          const target = extObj[targetId];
          if (!target) return json({ error: "target entry not found" }, 404);
          const expected = {};
          if (changes.title != null) expected.title = target.title || "";
          if (changes.poster != null) expected.poster = target.poster || null;
          const proposal = { id: "pm" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: "meta", targetId, targetTitle: target.title || "", changes, expected, status: "pending", createdAt: Date.now() };
          const pend = await getPendingStrict(env);
          pend[proposal.id] = proposal;
          await savePending(env, pend);
          return json({ ok: true, id: proposal.id, targetId, targetTitle: proposal.targetTitle, changes });
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Approve a candidate: publish it into the live catalogue through
      // the existing ext-entry shape (same fields the legacy external
      // route used to write, listed immediately — no unlisted flag).
      // Idempotent: if this candidate was already published, the
      // existing live entry is returned and nothing is duplicated.
      // Requires >= 1 source, so an approved entry always has the same
      // shape as today's live entries (metadata-only catalogue entries
      // are a later phase — the app has no empty-player state for them
      // yet). F1: also approves metadata-edit proposals (kind "meta"),
      // which change an existing entry in place and never publish.
      if (path === "/api/admin/pending/approve" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const id = (body.id || "").toString();
        try {
          return await this._withAdminLock(async () => {
          const fb = await freezeBlock(this.state); if (fb) return fb;
          const pend = await getPendingStrict(env);
          const cand = pend[id];
          if (!cand) {
            const extObj0 = await getExtMoviesStrict(this.state.storage);
            for (const k in extObj0) if (extObj0[k].pendingId === id) return json({ ok: true, id: k, title: extObj0[k].title, already: true });
            return json({ error: "not found" }, 404);
          }
          // F1: metadata-edit proposals branch here, before the entry
          // flow. A meta proposal never publishes, never touches the
          // seen-map or the discovery totals, and never grants
          // publication provenance (no pendingId is assigned).
          if (cand.kind === "meta") {
            if (cand.status !== "pending") return json({ error: "not pending (status: " + cand.status + ")" }, 400);
            const extObj = await getExtMoviesStrict(this.state.storage);
            const target = extObj[cand.targetId];
            if (!target) return json({ error: "target entry not found" }, 404);
            const changes = cand.changes || {};
            const expected = cand.expected || {};
            const fields = Object.keys(changes);
            if (!fields.length) return json({ error: "no changes" }, 400);
            if (changes.title != null) {
              const t = String(changes.title).trim();
              if (!t) return json({ error: "title must not be empty" }, 400);
              if (t.length > 200) return json({ error: "title too long (max 200 chars)" }, 400);
            }
            if (changes.poster != null && !cleanImgUrl(changes.poster)) return json({ error: "invalid poster URL" }, 400);
            if (changes.title != null) {
              const nt = normTitle(changes.title);
              for (const k in extObj) {
                if (k === cand.targetId) continue;
                const m = extObj[k];
                if (m && m.title && normTitle(m.title) === nt) return json({ error: "duplicate", duplicate: { where: "live", id: m.id || k, title: m.title, tmdb: m.tmdb != null ? m.tmdb : null } }, 409);
              }
            }
            let allApplied = true;
            let conflict = null;
            const toApply = {};
            for (const f of fields) {
              const cur = target[f];
              const exp = expected[f];
              const prop = changes[f];
              if (cur === prop) { /* already at the proposed value; leave it */ }
              else if (cur === exp) { toApply[f] = prop; allApplied = false; }
              else { conflict = { field: f, current: cur }; break; }
            }
            if (conflict) return json({ error: "stale proposal", field: conflict.field, current: conflict.current }, 409);
            if (allApplied) {
              delete pend[id];
              let cleanupOk = true;
              try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
              return json({ ok: true, id: cand.targetId, title: target.title, already: true, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });
            }
            for (const f in toApply) target[f] = toApply[f];
            target.metaUpdatedAt = Date.now();
            await saveExtMovies(this.state.storage, extObj);
            delete pend[id];
            let cleanupOk = true;
            try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
            return json({ ok: true, id: cand.targetId, title: target.title, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });
          }
          if (cand.kind && cand.kind !== "entry") return json({ error: "unknown proposal kind" }, 400);
          // Partial-failure self-heal: a previous approve may have saved
          // the live entry but died before deleting the candidate. The
          // duplicate check below would 409 on the entry we just
          // published (same TMDB/title) — detect it first, drop the stale
          // queue entry, and report the existing live entry instead of
          // duplicating it.
          const extObjPre = await getExtMoviesStrict(this.state.storage);
          for (const k in extObjPre) if (extObjPre[k].pendingId === id) {
            delete pend[id];
            let cleanupOk = true;
            try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
            await markSeen(env, cand, "approved");
            await bumpDiscoveryTotal(env, "approved");
            return json({ ok: true, id: k, title: extObjPre[k].title, already: true, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });
          }
          if (cand.status !== "pending") return json({ error: "not pending (status: " + cand.status + ")" }, 400);
          if (!cand.sources || !cand.sources.length) return json({ error: "need at least one playback source to approve" }, 400);
          const cleanSources = cand.sources.map(s => ({ label: s.label, url: cleanSrcUrl(s.url) })).filter(s => s.url);
          if (!cleanSources.length) return json({ error: "playback source URL invalid" }, 400);
          const dup = findDuplicate(cand, await this.listMovies(env, { strictExt: true }), pend, id);
          if (dup && !body.force) return json({ error: "duplicate", duplicate: dup }, 409);
          const liveId = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
          const extObj = await getExtMoviesStrict(this.state.storage);
          extObj[liveId] = { id: liveId, pendingId: id, url: cleanSources[0].url, sources: cleanSources, title: cand.title, year: cand.year || null, overview: cand.overview || null, poster: cleanImgUrl(cand.poster), backdrop: cleanImgUrl(cand.backdrop), vote: cand.vote || null, genres: cand.genres || [], type: cand.type || "movie", tmdb: cand.tmdb || null };
          await saveExtMovies(this.state.storage, extObj);
          delete pend[id];
          let cleanupOk = true;
          try { await savePending(env, pend); } catch (e) { cleanupOk = false; }
          await markSeen(env, cand, "approved");
          await bumpDiscoveryTotal(env, "approved");
          return json({ ok: true, id: liveId, title: cand.title, ...(cleanupOk ? {} : { pendingCleanup: "failed" }) });
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Reject a candidate: stays in the queue under "rejected", never
      // appears publicly. Rejected entries can be approved no more —
      // delete them, or re-add them as a new candidate.
      if (path === "/api/admin/pending/reject" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const id = (body.id || "").toString();
        return this._withAdminLock(async () => {
          const pend = await getPending(env);
          const cand = pend[id];
          if (!cand) return json({ error: "not found" }, 404);
          if (cand.status === "rejected") return json({ ok: true, id, status: "rejected", already: true });
          cand.status = "rejected";
          cand.rejectedAt = Date.now();
          await savePending(env, pend);
          // F1: metadata-edit proposals are not discovery candidates, so
          // rejecting one must not touch the seen-map or the totals.
          if (cand.kind !== "meta") {
            await markSeen(env, cand, "rejected");
            await bumpDiscoveryTotal(env, "rejected");
          }
          return json({ ok: true, id, status: "rejected" });
        });
      }
      // Delete a candidate permanently (pending or rejected).
      if (path === "/api/admin/pending/delete" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const id = (body.id || "").toString();
        return this._withAdminLock(async () => {
          const pend = await getPending(env);
          if (!pend[id]) return json({ error: "not found" }, 404);
          const gone = pend[id];
          delete pend[id];
          await savePending(env, pend);
          // Deleted candidates are marked "skipped" in the seen-map so
          // discovery does not re-file them; a manual re-add still works
          // (the add form checks live + queue only, not the seen-map).
          // F1: a metadata-edit proposal is not a discovery candidate.
          if (gone.kind !== "meta") await markSeen(env, gone, "skipped");
          return json({ ok: true, id });
        });
      }
      // Edit a pending candidate's playback sources (Phase 2a hardening).
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
          if (cand.kind === "meta") return json({ error: "meta proposals have no sources" }, 400);
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
      // Internal: cron entry point for automated discovery. NOT an admin
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
        // Lock + strict read (config-race fix): without the lock this
        // endpoint's read-modify-write can clobber a concurrent run's
        // finish() (and vice versa), and without the strict read a KV
        // failure would save defaults over the real config. On an
        // unreadable state the endpoint answers 500 and saves nothing.
        try {
          return await this._withAdminLock(async () => {
            const cur = await getDiscoveryStateStrict(env);
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
          });
        } catch (e) {
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Admin: catalogue freeze (F1 migration prerequisite). The flag
      // lives in DO storage (same pattern as admin_pw/tmdb_key). While
      // set, every catalogue write route returns 503. Reads are
      // unaffected. The flag is a PERMANENT feature (it also gates the
      // one-time migration endpoint below).
      if (path === "/api/admin/catalogue-freeze" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let frozen = false;
        try { frozen = !!(await this.state.storage.get("catalogue_frozen")); } catch (e) { return json({ error: "stored data temporarily unreadable — try again" }, 500); }
        return json({ ok: true, frozen });
      }
      if (path === "/api/admin/catalogue-freeze" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const frozen = body.frozen === true;
        // Serialized through the same _withAdminLock as the catalogue
        // writers (correction pass 2026-11-14): the old direct put let
        // a writer pass its freeze check and still be mid-write when
        // the freeze returned, so the response guaranteed no barrier.
        // Now an in-flight writer completes before this put runs, and
        // every later writer observes the flag in its freeze check.
        // This route is never called from inside a lock callback, so
        // there is no deadlock.
        try { return await this._withAdminLock(async () => { await this.state.storage.put("catalogue_frozen", frozen); return json({ ok: true, frozen }); }); } catch (e) { return json({ error: "operation failed — try again" }, 500); }
      }
      // Admin: one-time catalogue migration (KV -> DO storage).
      // PROTECTED and UNEXECUTED until separately approved: it requires
      // the catalogue to be frozen (so the KV source is stable) and
      // refuses if DO storage already holds a catalogue (one-time only).
      // It reads the KV catalogue strictly, copies it into DO storage,
      // reads it back, and verifies entry count + SHA-256. It does NOT
      // switch any read path (the F1 code reads DO storage; this
      // endpoint only seeds it). The KV key is left in place as a backup.
      if (path === "/api/admin/catalogue-migrate" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        try {
          return await this._withAdminLock(async () => {
          const frozen = await this.state.storage.get("catalogue_frozen");
          if (!frozen) return json({ error: "catalogue must be frozen before migration" }, 400);
          const existing = await this.state.storage.get("ext:movies");
          if (existing != null) return json({ error: "catalogue already migrated" }, 409);
          const kvCat = await getExtMoviesKVStrict(env);
          const count = Object.keys(kvCat).length;
          const hash = await sha256Hex(te.encode(JSON.stringify(kvCat)));
          await this.state.storage.put("ext:movies", kvCat);
          const back = await this.state.storage.get("ext:movies");
          const backCount = back ? Object.keys(back).length : -1;
          const backHash = back ? await sha256Hex(te.encode(JSON.stringify(back))) : "";
          if (backCount !== count || backHash !== hash) return json({ error: "migration verification failed", count, sha256: hash, backCount, backHash }, 500);
          return json({ ok: true, count, sha256: hash, verified: true });
          });
        } catch (e) {
          // Missing / malformed source is a hard migration failure with
          // an admin-facing message (this endpoint is checkPw-gated);
          // it is NOT a transient read failure, so it gets its own
          // message rather than "temporarily unreadable — try again".
          if (e && e.code === "KV_SOURCE_MISSING") return json({ error: "migration source missing — KV ext:movies not found" }, 500);
          if (e && e.code === "KV_SOURCE_MALFORMED") return json({ error: "migration source malformed — KV ext:movies is not a catalogue object" }, 500);
          if (e && isStoreReadFailure(e)) return json({ error: "stored data temporarily unreadable — try again" }, 500);
          return json({ error: "operation failed — try again" }, 500);
        }
      }
      // Admin: change password (stored in DO storage, survives deploys)
      if (path === "/api/admin/password" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const n = (body.new_pw || "").toString();
        if (n.length < 4) return json({ error: "password too short (min 4 chars)" }, 400);
        await this.state.storage.put("admin_pw", n);
        return json({ ok: true });
      }
      // Admin: TMDB API key get/set
      if (path === "/api/admin/tmdb/key" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const k = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        return json({ has: !!k });
      }
      if (path === "/api/admin/tmdb/key" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { key } = await request.json();
        await this.state.storage.put("tmdb_key", key);
        return json({ ok: true });
      }
      // Admin: search TMDB
      if (path === "/api/admin/tmdb/search" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        if (!apiKey) return json({ error: "no API key" }, 400);
        let q = url.searchParams.get("q") || "", type = url.searchParams.get("type") || "movie";
        let year = "";
        const ym = q.match(/\b(19|20)\d{2}\b/);
        if (ym) { year = ym[0]; q = q.replace(ym[0], "").trim(); }
        let sp = "/search/"+type+"?query="+encodeURIComponent(q);
        if (year) sp += "&year="+year;
        const data = await tmdbGet(sp, apiKey);
        if (!data) return json({ error: "tmdb failed" }, 502);
        return json({ results: (data.results||[]).slice(0,10).map(r=>({
          id: r.id, title: r.title||r.name, year: (r.release_date||r.first_air_date||"").slice(0,4),
          overview: r.overview, poster: r.poster_path, backdrop: r.backdrop_path,
          vote: r.vote_average?.toFixed(1), type,
        }))});
      }
      // Admin: attach TMDB metadata to file
      if (path === "/api/admin/match" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { bucket, key, tmdb_id, type } = await request.json();
        const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        if (!apiKey) return json({ error: "no API key" }, 400);
        const d = await tmdbGet("/"+type+"/"+tmdb_id, apiKey);
        if (!d) return json({ error: "tmdb failed" }, 502);
        const g = await tmdbGet("/genre/"+type+"/list", apiKey);
        const gmap = {};
        (g?.genres||[]).forEach(x=>gmap[x.id]=x.name);
        await this.state.storage.put("meta:"+bucket+":"+key, {
          title: d.title||d.name, year: (d.release_date||d.first_air_date||"").slice(0,4),
          overview: d.overview, poster: d.poster_path, backdrop: d.backdrop_path,
          vote: d.vote_average?.toFixed(1), genres: (d.genres||[]).map(x=>x.name||gmap[x.id]).filter(Boolean),
          type, tmdb: tmdb_id,
        });
        return json({ ok: true });
      }
      // Admin: mark a file as a video song (no TMDB)
      if (path === "/api/admin/setsong" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { bucket, key } = await request.json();
        const title = key.split("/").pop().replace(/\.[^.]+$/, "").replace(/[._-]+/g, " ").trim();
        await this.state.storage.put("meta:"+bucket+":"+key, {
          title: title || key, year: null, overview: null, poster: null, backdrop: null,
          vote: null, genres: [], type: "song", tmdb: null,
        });
        return json({ ok: true, title });
      }
      // Admin: auto-match by filename
      if (path === "/api/admin/automatch" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { bucket, key } = await request.json();
        const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        if (!apiKey) return json({ error: "no API key" }, 400);
        const q = cleanTitle(key);
        if (!q) return json({ error: "cannot parse title" }, 400);
        const data = await tmdbGet("/search/movie?query="+encodeURIComponent(q), apiKey);
        const r = data?.results?.[0];
        if (!r) return json({ error: "not found", query: q }, 404);
        const d = await tmdbGet("/movie/"+r.id, apiKey);
        await this.state.storage.put("meta:"+bucket+":"+key, {
          title: d.title, year: (d.release_date||"").slice(0,4),
          overview: d.overview, poster: d.poster_path, backdrop: d.backdrop_path,
          vote: d.vote_average?.toFixed(1), genres: (d.genres||[]).map(x=>x.name),
          type: "movie", tmdb: r.id,
        });
        return json({ ok: true, title: d.title });
      }

      // Admin: R2 multipart upload (auth: admin pw OR x-upload-key header matching UPLOAD_KEY secret)
      const r2ok = async () => (await checkPw(url, env, this.state)) || (!!env.UPLOAD_KEY && request.headers.get("x-upload-key") === env.UPLOAD_KEY);
      if (path === "/api/admin/r2/init" && request.method === "POST") {
        if (!(await r2ok())) return json({ error: "wrong password" }, 403);
        const body = await request.json().catch(() => ({}));
        if (!body.key) return json({ error: "need key" }, 400);
        const up = await env.MEDIA.createMultipartUpload(body.key, { httpMetadata: { contentType: body.contentType || "application/octet-stream" } });
        return json({ ok: true, uploadId: up.uploadId });
      }
      if (path === "/api/admin/r2/part" && request.method === "PUT") {
        if (!(await r2ok())) return json({ error: "wrong password" }, 403);
        const key = url.searchParams.get("key"), uploadId = url.searchParams.get("uploadId"), partNumber = parseInt(url.searchParams.get("part") || "0");
        if (!key || !uploadId || !partNumber) return json({ error: "bad params" }, 400);
        const up = env.MEDIA.resumeMultipartUpload(key, uploadId);
        const part = await up.uploadPart(partNumber, await request.arrayBuffer());
        return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
      }
      if (path === "/api/admin/r2/complete" && request.method === "POST") {
        if (!(await r2ok())) return json({ error: "wrong password" }, 403);
        const body = await request.json().catch(() => ({}));
        const up = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
        const obj = await up.complete(body.parts || []);
        return json({ ok: true, key: obj.key, size: obj.size });
      }
      if (path === "/api/admin/r2/abort" && request.method === "POST") {
        if (!(await r2ok())) return json({ error: "wrong password" }, 403);
        const body = await request.json().catch(() => ({}));
        const up = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
        await up.abort();
        return json({ ok: true });
      }
      // Admin: list/delete raw files waiting in R2 incoming/ (the processing queue)
      if (path === "/api/admin/r2/incoming" && request.method === "GET") {
        if (!(await r2ok())) return json({ error: "wrong password" }, 403);
        const items = [];
        let cursor;
        do {
          const page = await env.MEDIA.list({ prefix: "incoming/", limit: 500, cursor });
          for (const o of page.objects) items.push({ key: o.key, size: o.size, uploaded: o.uploaded });
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor && items.length < 2000);
        return json({ ok: true, items });
      }
      if (path === "/api/admin/r2/incoming" && request.method === "DELETE") {
        if (!(await r2ok())) return json({ error: "wrong password" }, 403);
        const key = url.searchParams.get("key") || "";
        if (!key.startsWith("incoming/")) return json({ error: "only incoming/ files" }, 400);
        await env.MEDIA.delete(key);
        return json({ ok: true });
      }
      if (path === "/api/admin/stats" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        return json({ tunnel: this.tunnelWs() ? "up" : "down", views: await this.viewsSnapshot() });
      }
      // Users Online Now: heartbeat ingestion (public) + admin read.
      if (path === "/api/presence" && request.method === "POST") {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
        const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json({ error: "bad id" }, 400);
        const kind = body.kind === "watching" ? "watching" : "browsing";
        const title = kind === "watching" && typeof body.title === "string" ? body.title.slice(0, 200) : "";
        if (!this._presence) this._presence = new Map();
        prunePresence(this._presence, Date.now());
        this._presence.set(id, { kind, title, lastSeen: Date.now() });
        return json({ ok: true });
      }
      if (path === "/api/admin/presence" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        if (!this._presence) this._presence = new Map();
        return json(presenceSummary(this._presence, Date.now()));
      }
      if (path === "/api/admin/object" && request.method === "DELETE") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const bucket = url.searchParams.get("bucket"), key = url.searchParams.get("key");
        const r = await this.s3fetch("DELETE", "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/"));
        if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
        return json({ ok: true });
      }
      if (path === "/api/admin/fileinfo" && request.method === "GET") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const bucket = url.searchParams.get("bucket"), key = url.searchParams.get("key");
        const r = await this.s3fetch("HEAD", "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/"));
        if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
        return json({ size: parseInt(r.headers["content-length"] || "0"), modified: r.headers["last-modified"] || "", etag: r.headers["etag"] || "" });
      }
      if (path === "/api/admin/copy" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const bucket = url.searchParams.get("bucket"), key = url.searchParams.get("key"), dest = url.searchParams.get("dest");
        const srcPath = "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
        const dstPath = "/" + dest + "/" + key.split("/").pop().split("/").map(encodeURIComponent).join("/");
        const r = await this.s3fetch("PUT", dstPath, { headers: { "x-amz-copy-source": srcPath } });
        if (![200, 201, 204].includes(r.status)) return new Response(bufToText(r.body), { status: r.status });
        return json({ ok: true });
      }
      if (path === "/api/admin/move" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const bucket = url.searchParams.get("bucket"), key = url.searchParams.get("key"), dest = url.searchParams.get("dest");
        const srcPath = "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
        const dstPath = "/" + dest + "/" + key.split("/").pop().split("/").map(encodeURIComponent).join("/");
        const cr = await this.s3fetch("PUT", dstPath, { headers: { "x-amz-copy-source": srcPath } });
        if (![200, 201, 204].includes(cr.status)) return new Response(bufToText(cr.body), { status: cr.status });
        await this.s3fetch("DELETE", srcPath);
        return json({ ok: true });
      }
      if (path === "/api/admin/rename" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const bucket = url.searchParams.get("bucket"), key = url.searchParams.get("key"), nn = url.searchParams.get("new");
        const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
        const srcPath = "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
        const dstPath = "/" + bucket + "/" + (dir + nn).split("/").map(encodeURIComponent).join("/");
        const cr = await this.s3fetch("PUT", dstPath, { headers: { "x-amz-copy-source": srcPath } });
        if (![200, 201, 204].includes(cr.status)) return new Response(bufToText(cr.body), { status: cr.status });
        await this.s3fetch("DELETE", srcPath);
        return json({ ok: true });
      }
      if (path === "/api/buckets" && request.method === "GET") {
        const r = await this.s3fetch("GET", "/");
        if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
        return json({ buckets: parseBuckets(bufToText(r.body)) });
      }
      if (path === "/api/buckets" && request.method === "POST")
        return json({ error: "read-only" }, 403);
      if (path === "/api/list" && request.method === "GET") {
        const bucket = url.searchParams.get("bucket"), prefix = url.searchParams.get("prefix") || "";
        const q = `list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=${encodeURIComponent("/")}&max-keys=1000`;
        const r = await this.s3fetch("GET", "/" + bucket, { query: q });
        if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
        return json(parseList(bufToText(r.body)));
      }
      if (path === "/api/upload" && request.method === "PUT")
        return json({ error: "read-only" }, 403);
      if (path === "/api/object" && request.method === "DELETE")
        return json({ error: "read-only" }, 403);
      if (path.startsWith("/view/ext/") && request.method === "GET") {
        const id = decodeURIComponent(path.split("/")[3] || "");
        const extObj = await getExtMovies(this.state.storage);
        const m = extObj[id];
        if (!m) return new Response("not found", { status: 404 });
        return this.pageResp(await EXT_VIEW_PAGE(m, env), request);
      }
      if (path.startsWith("/view/") && request.method === "GET") {
        const [, , bucket, ...keyParts] = path.split("/");
        const key = keyParts.map(decodeURIComponent).join("/");
        return this.pageResp(VIEW_PAGE(bucket, key, mediaKind(key)), request);
      }
      if (path.startsWith("/download/ext/") && request.method === "GET") {
        const id = decodeURIComponent(path.split("/")[3] || "");
        const extObj = await getExtMovies(this.state.storage);
        const m = extObj[id];
        if (!m) return new Response("not found", { status: 404 });
        const srcs = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
        const srcInfos = [];
        for (const s of srcs) {
          let fmt = null, size = null, date = null;
          try {
            const u = s.url || "";
            const em = u.split("?")[0].match(/\.([A-Za-z0-9]{2,5})$/);
            if (em) fmt = em[1].toUpperCase();
            const isEmb = /luluvido\.com\/e\/|lulustream\.com\/e\//.test(u);
            if (!isEmb) {
              const dk2 = r2KeyOf(u);
              if (dk2) {
                const h = await env.MEDIA.head(dk2);
                if (h) { if (h.size) size = fmtSize(h.size); if (h.uploaded) date = fmtDate(h.uploaded); }
              } else if (/^https?:\/\//i.test(u)) {
                try {
                  const ctl = new AbortController();
                  const to = setTimeout(() => ctl.abort(), 5000);
                  const hr = await fetch(u, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
                  clearTimeout(to);
                  const cl = hr.headers.get("content-length");
                  if (cl) size = fmtSize(parseInt(cl, 10));
                  const lm = hr.headers.get("last-modified");
                  if (lm) date = fmtDate(lm);
                } catch (e) {}
              }
            }
          } catch (e) {}
          srcInfos.push({ label: s.label || "Download", fmt, size, date });
        }
        let src0 = parseInt(url.searchParams.get("src") || "0", 10);
        if (!(src0 >= 0 && src0 < srcs.length)) src0 = 0;
        return this.pageResp(DOWNLOAD_PAGE(m, srcInfos, "/view/ext/" + id, src0), request);
      }
      if (path.startsWith("/gate/ext/") && request.method === "GET") {
        const id = decodeURIComponent(path.split("/")[3] || "");
        const q = url.searchParams.get("src");
        return Response.redirect(url.origin + "/download/ext/" + encodeURIComponent(id) + (q ? "?src=" + encodeURIComponent(q) : ""), 302);
      }
      if (path.startsWith("/gate/file/") && request.method === "GET") {
        const [, , , bucket, ...keyParts] = path.split("/");
        const key = keyParts.map(decodeURIComponent).join("/");
        if (!bucket || !key) return new Response("not found", { status: 404 });
        const fExt = key.split("?")[0].match(/\.([A-Za-z0-9]{2,5})$/);
        return this.pageResp(GATE_PAGE(key.split("/").pop(), "from the " + bucket + " shelf", { kind: "file", bucket, key }, [{ label: "Download", fmt: fExt ? fExt[1].toUpperCase() : null, size: null, date: null }], null, 0), request);
      }
      if (path === "/api/gate/verify" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
        const desc = body.desc || {};
        const src = parseInt(body.src || "0", 10) || 0;
        if (!env.TURNSTILE_SECRET) return json({ error: "gate is not configured yet" }, 503);
        if (!body.token) return json({ error: "human check missing — wait for it and try again" }, 400);
        const form = new URLSearchParams();
        form.set("secret", env.TURNSTILE_SECRET);
        form.set("response", String(body.token));
        const rip = request.headers.get("CF-Connecting-IP");
        if (rip) form.set("remoteip", rip);
        let tv;
        try {
          const tr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
          tv = await tr.json();
        } catch (e) { return json({ error: "human check unreachable — try again" }, 502); }
        if (!tv || !tv.success) return json({ error: "human check failed — refresh and try again" }, 403);
        let target = null;
        if (desc.kind === "ext") {
          const extObj = await getExtMovies(this.state.storage);
          const m = extObj[desc.id];
          if (!m) return json({ error: "not found" }, 404);
          const srcs = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
          if (!(src >= 0 && src < srcs.length)) return json({ error: "bad source" }, 400);
          target = { kind: "ext", id: desc.id, src };
        } else if (desc.kind === "file") {
          if (!desc.bucket || !desc.key) return json({ error: "bad target" }, 400);
          target = { kind: "file", bucket: desc.bucket, key: desc.key, src: 0 };
        } else return json({ error: "bad target" }, 400);
        target.exp = Math.floor(Date.now() / 1000) + 300;
        const payload = btoa(unescape(encodeURIComponent(JSON.stringify(target)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const sig = await hmacHex(env.UPLOAD_KEY || "", payload);
        return json({ go: "/go/" + payload + "." + sig });
      }
      if (path.startsWith("/go/") && request.method === "GET") {
        const seg = path.slice(4);
        const dot = seg.lastIndexOf(".");
        if (dot < 1) return new Response("bad link", { status: 400 });
        const payload = seg.slice(0, dot), sig = seg.slice(dot + 1);
        const want = await hmacHex(env.UPLOAD_KEY || "", payload);
        if (sig !== want) return new Response("invalid link", { status: 403 });
        let t;
        try { t = JSON.parse(decodeURIComponent(escape(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))))); } catch (e) { return new Response("bad link", { status: 400 }); }
        if (!t.exp || t.exp < Math.floor(Date.now() / 1000)) return new Response("link expired — go back and click download again", { status: 410 });
        if (t.kind === "ext") {
          const extObj = await getExtMovies(this.state.storage);
          const m = extObj[t.id];
          if (!m) return new Response("not found", { status: 404 });
          const srcs = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
          const s = srcs[t.src || 0] || srcs[0];
          // v0.6.28: R2 sources download through the signed stream
          // (the public R2 URL is dead once the bucket's r2.dev
          // domain is off). Other hosts go through the signed /px/
          // proxy below, which re-serves them as a download so
          // Chrome saves instead of opening its player.
          const dk = r2KeyOf(s.url);
          if (dk) {
            const tok = await mintStreamToken(env, dk);
            return Response.redirect(url.origin + "/stream/" + dk.split("/").map(encodeURIComponent).join("/") + "?t=" + tok + "&download=1", 302);
          }
          return Response.redirect(url.origin + "/px/" + payload + "." + sig, 302);
        }
        if (t.kind === "file") {
          return Response.redirect(url.origin + "/d/" + encodeURIComponent(t.bucket) + "/" + t.key.split("/").map(encodeURIComponent).join("/"), 302);
        }
        return new Response("bad link", { status: 400 });
      }
      // Signed download proxy (2026-11-03): re-serves a catalog
      // source as a real download. The URL comes from our own
      // catalog entry, never from the request, so this cannot be
      // used as an open proxy. Same signed payload as /go/.
      if (path.startsWith("/px/") && (request.method === "GET" || request.method === "HEAD")) {
        const seg = path.slice(4);
        const dot = seg.lastIndexOf(".");
        if (dot < 1) return new Response("bad link", { status: 400 });
        const payload = seg.slice(0, dot), sig = seg.slice(dot + 1);
        const want = await hmacHex(env.UPLOAD_KEY || "", payload);
        if (sig !== want) return new Response("invalid link", { status: 403 });
        let t;
        try { t = JSON.parse(decodeURIComponent(escape(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))))); } catch (e) { return new Response("bad link", { status: 400 }); }
        if (!t.exp || t.exp < Math.floor(Date.now() / 1000)) return new Response("link expired — go back and click download again", { status: 410 });
        if (t.kind !== "ext") return new Response("bad link", { status: 400 });
        const extObj = await getExtMovies(this.state.storage);
        const m = extObj[t.id];
        if (!m) return new Response("not found", { status: 404 });
        const srcs = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
        const s = srcs[t.src || 0] || srcs[0];
        // Main-bucket sources keep the tokenized stream path.
        const dk = r2KeyOf(s.url);
        if (dk) {
          const tok = await mintStreamToken(env, dk);
          return Response.redirect(url.origin + "/stream/" + dk.split("/").map(encodeURIComponent).join("/") + "?t=" + tok + "&download=1", 302);
        }
        // Other hosts: stream the file back with an attachment
        // disposition so Chrome downloads instead of playing it.
        let up;
        try {
          const fwd = {};
          const range = request.headers.get("range");
          if (range) fwd.range = range;
          up = await fetch(s.url, { method: request.method, headers: fwd });
        } catch (e) { return new Response("download source unreachable", { status: 502 }); }
        if (up.status >= 400) return new Response("download source returned " + up.status, { status: up.status });
        const base = s.url.split("?")[0].split("/").pop() || "download";
        const fname = decodeURIComponent(base).replace(/"/g, "");
        const h = {
          "content-type": up.headers.get("content-type") || mimeType(fname),
          "content-disposition": 'attachment; filename="' + fname + '"',
          "accept-ranges": "bytes",
          "cache-control": "no-store, private",
        };
        const clen = up.headers.get("content-length");
        if (clen) h["content-length"] = clen;
        const cr = up.headers.get("content-range");
        if (cr) h["content-range"] = cr;
        if (request.method === "HEAD") return new Response(null, { status: up.status, headers: h });
        return new Response(up.body, { status: up.status, headers: h });
      }
      if (path.startsWith("/dl/") && request.method === "GET") {
        const [, , bucket, ...keyParts] = path.split("/");
        const key = keyParts.map(decodeURIComponent).join("/");
        // get size via HEAD-like list
        const lr = await this.s3fetch("GET", "/" + bucket, { query: "list-type=2&prefix=" + key.split("/").map(encodeURIComponent).join("/") + "&max-keys=1" });
        let size = 0;
        if (lr.status < 400) { const m = bufToText(lr.body).match(/<Size>(\d+)<\/Size>/); if (m) size = parseInt(m[1]); }
        return this.pageResp(DL_PAGE(bucket, key, size), request);
      }
      if (path.startsWith("/d/") && request.method === "GET") {
        const [, , bucket, ...keyParts] = path.split("/");
        const key = keyParts.map(decodeURIComponent).join("/");
        const s3path = "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
        const range = request.headers.get("range");
        const isMedia = mediaKind(key) !== "other";
        // For media with Range (video seeking), bypass cache and proxy the range
        if (range && isMedia) {
          const r = await this.s3fetch("GET", s3path, { headers: { range } });
          if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
          const h = { "content-type": mimeType(key), "accept-ranges": "bytes" };
          // Copy content-range (check all casings) or construct it
          let cr = r.headers["content-range"] || r.headers["Content-Range"];
          const clen = r.headers["content-length"] || r.headers["Content-Length"];
          if (clen) h["content-length"] = clen;
          if (!cr && clen) {
            // Construct from range header: "bytes=0-" or "bytes=0-100"
            const m = range.match(/bytes=(\d+)-(\d*)/);
            if (m) {
              const start = parseInt(m[1]);
              const bodyLen = r.body ? r.body.byteLength : parseInt(clen);
              const end = m[2] ? parseInt(m[2]) : start + bodyLen - 1;
              // We don't know total, use * if needed, but try to get it
              cr = `bytes ${start}-${end}/*`;
            }
          }
          if (cr) h["content-range"] = cr;
          return new Response(r.body, { status: r.status, headers: h });
        }
        // For media without Range: get file size first via HEAD
        // Small files (<2MB): serve fully with 200. Large: first 2MB with 206 for fast start.
        if (isMedia && !range) {
          let totalSize = 0;
          try {
            const hr = await this.s3fetch("HEAD", s3path);
            totalSize = parseInt(hr.headers["content-length"] || hr.headers["Content-Length"] || "0");
          } catch(e) {}
          if (totalSize > 0 && totalSize <= 2097152) {
            // Small file: serve whole thing
            const r = await this.s3fetch("GET", s3path);
            if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
            return new Response(r.body, { headers: { "content-type": mimeType(key), "accept-ranges": "bytes", "content-length": String(totalSize) } });
          }
          // Large file: first 2MB
          const r = await this.s3fetch("GET", s3path, { headers: { range: "bytes=0-2097151" } });
          if (r.status >= 400 && r.status !== 206) return new Response(bufToText(r.body), { status: r.status });
          const h = { "content-type": mimeType(key), "accept-ranges": "bytes" };
          const cr = r.headers["content-range"] || r.headers["Content-Range"];
          if (cr) h["content-range"] = cr;
          if (r.headers["content-length"]) h["content-length"] = r.headers["content-length"];
          return new Response(r.body, { status: 206, headers: h });
        }
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), { method: "GET" });
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const r = await this.s3fetch("GET", s3path);
          if (r.status >= 400) return new Response(bufToText(r.body), { status: r.status });
          const disp = `attachment; filename="${key.split("/").pop()}"`;
          resp = new Response(r.body, {
            headers: {
              "content-type": mimeType(key),
              "content-disposition": disp,
              "cache-control": "public, max-age=31536000",
              "accept-ranges": "bytes",
            },
          });
          this.state.waitUntil(cache.put(cacheKey, resp.clone()));
        }
        return resp;
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, e.code === 502 ? 502 : 500);
    }
  }
}

export default {
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
};
