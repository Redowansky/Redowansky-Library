import { EmailMessage } from "cloudflare:email";
// Sia Lab — file browser for the Sia storage backend (s3d).
// A Durable Object holds the single reverse-tunnel WebSocket (the s3d host
// dials OUT to /__tunnel); all requests route through it so any edge
// isolate reaches the same socket.

const REGION = "us-east-1";
const SERVICE = "s3";
const te = new TextEncoder();

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
  return env.ADMIN_PW || "library2026";
}
async function checkPw(url, env, state) {
  return url.searchParams.get("pw") === await adminPw(env, state);
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
<nav><a class="on" data-f="movie">Movies</a><a data-f="song">Video Songs</a></nav>
<div class="search"><input id="q" placeholder="Search titles..." oninput="doSearch(this.value)"></div><div id="authbox"><a href="/auth/login" style="color:#00e676;text-decoration:none">Sign in with Google</a></div></header>
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
  const pool=[...ALL].filter(m=>m.type!=='song').sort((a,b)=>(b.vote||0)-(a.vote||0)).slice(0,6);
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
      else{box.innerHTML='<a href="/auth/login" style="color:#00e676;text-decoration:none">Sign in with Google</a>';}
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
      var p=poster?'<img loading="lazy" src="'+poster+'" alt="" style="width:110px;height:165px;object-fit:cover;border-radius:8px">':'<div style="width:110px;height:165px;display:flex;align-items:center;justify-content:center;font-size:2rem;background:#0a120c;border-radius:8px">🎬</div>';
      return '<a href="'+link+'?start='+Math.floor(e.pos)+'" style="text-decoration:none;color:inherit;flex:0 0 110px">'+p+'<div style="padding:6px 2px"><b style="font-size:.8rem;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+e.title+'</b><span style="font-size:.72rem;color:#7a9a85">'+(e.done?'✓ Watched':fmtLeft(e.dur-e.pos))+'</span><div style="height:4px;background:#1e3a2a;border-radius:2px;margin-top:4px"><div style="height:4px;width:'+pct+'%;background:#00e676;border-radius:2px"></div></div></div></a>';
    }).join('');
    if(recent)html+='<section class="row"><h2>⏱ Recently Played</h2><div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:10px">'+recent+'</div></section>';
    if(html){
      var main=$('main');
      main.innerHTML=html+main.innerHTML;
    }
  }catch(e){}
}
function card(m){
  const p=m.poster?'<img loading="lazy" src="'+(m.poster.startsWith('http')?m.poster:IMG+m.poster)+'" alt="">':'<div class="noposter">'+(m.type==='song'?'🎵':'🎬')+'</div>';
  const js=JSON.stringify(m).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  return '<div class="card" onclick="openModal('+js+')">'+p+'<div class="cinfo"><b>'+m.title+'</b><span>'+(m.year||'')+' '+(m.vote?'★ '+m.vote:'')+'</span></div></div>';
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
  else main.innerHTML=mk(filter==='movie'?'🎬 Movies':'🎵 Video Songs',list);
  main.style.paddingTop=$('hero').style.display==='none'?'90px':'20px';
}
function doSearch(q){const f=document.querySelector('nav a.on').dataset.f;render(f,q);}
document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>{document.querySelectorAll('nav a').forEach(x=>x.classList.remove('on'));a.classList.add('on');$('q').value='';render(a.dataset.f,'');});
function openModal(m){
  $('mhero').style.backgroundImage=m.backdrop?'url('+BG+m.backdrop+')':(m.poster&&m.poster.startsWith('http')?'url('+m.poster+')':'none');
  var genres=(m.genres||[]).map(function(g){return '<span>'+g+'</span>';}).join('');
  var vurl=m.external?'/view/ext/'+m.id:'/view/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/');
  var durl=m.external?'/gate/ext/'+m.id:'/dl/'+encodeURIComponent(m.bucket)+'/'+m.key.split('/').map(encodeURIComponent).join('/');
  $('minfo').innerHTML='<h2>'+m.title+'</h2><div class="mmeta"><span class="rate">★ '+(m.vote||'—')+'</span><span>'+(m.year||'')+'</span><span>'+(m.type==='song'?'Video Song':'Movie')+'</span></div><p>'+(m.overview||'No overview available.')+'</p><div class="genres">'+genres+'</div><div class="hero-btns"><a class="btn btn-play" href="'+vurl+'">▶ Play</a><a class="btn btn-info" href="'+durl+'">⭳ Download</a></div>';
  $('modal').classList.add('open');
}
function closeModal(){$('modal').classList.remove('open');}
$('modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
load();loadSync();
</script><div style="text-align:center;padding:16px 12px"><script async="async" data-cfasync="false" src="https://bancadeltempoidea.org/21/c35f8b781378782fafde0559fab8e6cd"></script><div id="container-c35f8b781378782fafde0559fab8e6cd"></div></div><footer style="text-align:center;padding:28px 12px 36px;color:#5f7a68;font-size:.85rem">👀 __VIEWS_TODAY__ viewers today</footer><script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script></body></html>`;

// ---- TMDB helpers ----
function toDirectUrlSrv(u){
  u = (u || "").trim();
  const i = u.indexOf("drive.google.com/file/d/");
  if (i >= 0) { const id = u.slice(i + 24).split("/")[0].split("?")[0]; if (id) return "https://drive.google.com/uc?export=download&id=" + id; }
  if (u.indexOf("drive.google.com") >= 0) { const p = u.split("id="); if (p.length > 1) { const id2 = p[1].split("&")[0]; if (id2) return "https://drive.google.com/uc?export=download&id=" + id2; } }
  if (u.indexOf("dropbox.com") >= 0 && u.indexOf("dl=0") >= 0) return u.split("?dl=0")[0] + "?raw=1";
  return u;
}
async function getExtMovies(env){
  try { return await env.DATA_KV.get("ext:movies", "json") || {}; } catch(e) { return {}; }
}
async function saveExtMovies(env, obj){
  await env.DATA_KV.put("ext:movies", JSON.stringify(obj));
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
.gaugebox{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.gauge{position:relative;width:150px;height:150px;flex-shrink:0}
.gauge svg{transform:rotate(-90deg)}
.gauge .pct{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.gauge .pct b{font-size:1.5rem;color:var(--grn)}
.gauge .pct span{font-size:.72rem;color:var(--mut)}
.ginfo{font-size:.9rem;line-height:1.9}
.ginfo b{color:var(--grn)}
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
<button data-s="movies">🎬 <span>Movies</span></button>
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
<div class="card"><div class="v" id="st-buckets">…</div><div class="l">Shelves</div></div>
<div class="card"><div class="v" id="st-files">…</div><div class="l">Files</div></div>
<div class="card"><div class="v" id="st-viewers">…</div><div class="l">👀 Visits today · GoatCounter</div></div>
<div class="card"><div class="v" id="st-visits">…</div><div class="l">Visits today</div></div>
<div class="card"><div class="v" id="st-total">…</div><div class="l">Total visits</div></div>
</div>
<div class="gaugebox">
<div class="gauge"><svg width="150" height="150"><circle cx="75" cy="75" r="64" fill="none" stroke="#1e3a2a" stroke-width="12"/><circle id="gring" cx="75" cy="75" r="64" fill="none" stroke="#00e676" stroke-width="12" stroke-linecap="round" stroke-dasharray="402" stroke-dashoffset="402"/></svg>
<div class="pct"><b id="gpct">…</b><span>used</span></div></div>
<div class="ginfo"><div>Used: <b id="gused">…</b></div><div>Free: <b id="gfree">…</b></div><div>Total: <b id="gtotal">…</b></div></div>
</div></div>
<!-- UPLOAD -->
<!-- MOVIES (TMDB matching) -->
<div class="sec" id="s-movies">
<h1>🎬 Movies & Songs</h1><p class="desc">Add movies and video songs by link, or upload a raw file for processing. They appear on the site instantly.</p>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<h4 style="margin-bottom:10px">📥 Upload raw movie to R2 (for processing)</h4>
<p style="color:#7a9a85;font-size:.85rem;margin-bottom:10px">Upload the raw file (any size, MKV is fine). It lands in R2 <b>incoming/</b> — Pepper downloads it fast, keeps the right audio track, adds it to the library, then deletes the raw. <b>Progress is saved as it uploads:</b> if this tab or the browser crashes, reopen this page, pick the same file, and press Upload again — it continues where it stopped instead of starting from zero.</p>
<input type="file" id="incFile" onchange="r2ResumeHint()" style="width:100%;color:#b8d8c0;margin-bottom:10px">
<div style="display:flex;gap:10px;align-items:center">
<button class="btn" id="incBtn" onclick="startR2Upload()">⬆️ Upload to R2</button>
<button class="btn danger" id="incAbort" style="display:none" onclick="abortR2Upload()">Cancel</button>
</div>
<div style="background:#060906;border-radius:6px;height:10px;margin-top:12px;overflow:hidden"><div id="incBar" style="background:#00e676;height:100%;width:0%"></div></div>
<div id="incStats" style="font-size:.85rem;margin-top:6px;color:#7a9a85;font-variant-numeric:tabular-nums"></div>
<div id="incStatus" style="font-size:.85rem;margin-top:8px;color:#b8d8c0"></div>
<h4 style="margin:16px 0 4px">🗂 Waiting in incoming/</h4>
<div id="incList"></div>
</div>
<h3>🎬 Movie Info (TMDB)</h3>
<p style="color:#7a9a85;font-size:.9rem;margin-bottom:14px">Match your video files to TMDB for posters & info. Get a free API key at <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color:#00e676">themoviedb.org/settings/api</a></p>
<div style="display:flex;gap:10px;margin-bottom:16px">
<input id="tmdbKey" type="password" placeholder="TMDB API key" style="flex:1;background:#0a120c;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<button class="btn" onclick="saveTmdbKey()">Save Key</button>
</div>
<div id="tmdbStatus" style="font-size:.85rem;margin-bottom:16px"></div>
<div style="background:#0a120c;border:1px solid #1e3a2a;border-radius:12px;padding:14px;margin-bottom:16px">
<h4 style="margin-bottom:10px">🔗 Add external link (movie or video song)</h4>
<p style="color:#7a9a85;font-size:.85rem;margin-bottom:10px">For files hosted elsewhere (Pixeldrain, Google Drive, Dropbox…). Paste the link, write the title, and tick 🎵 Video song if it's a song.</p>
<div id="extVers">
<div class="extver" style="display:flex;gap:6px;margin-bottom:6px">
<input class="extvlabel" placeholder="Label" value="Hindi" style="width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<input class="extvurl" placeholder="Paste share link or direct URL…" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px" oninput="convLink(this)">
</div>
</div>
<button class="btn" onclick="addVerRow()" style="font-size:.8rem;margin-bottom:8px">+ Add version (e.g. English)</button>
<div id="convMsg" style="font-size:.8rem;color:#7a9a85;margin:-4px 0 8px"></div>
<details style="font-size:.82rem;color:#7a9a85;margin-bottom:10px"><summary style="cursor:pointer;color:#b8d8c0">Recommended free hosts</summary>
<div style="margin-top:8px;line-height:1.7">
<b style="color:#e8f5e9">Google Drive</b> — 15GB free, best for big movies. Share links auto-convert.<br>
<b style="color:#e8f5e9">Dropbox</b> — 2GB free, share links auto-convert (?raw=1).<br>
<b style="color:#e8f5e9">Pixeldrain</b> — free, no account, direct links work.<br>
<b style="color:#e8f5e9">GoFile</b> — free and fast uploads, but direct links need Premium, so its links do NOT play on the site.<br>
<b style="color:#e8f5e9">MediaFire</b> — 10GB free, use the direct download link.<br>
<span style="color:#ff9a9a">MEGA not supported</span> — its links need decryption, browsers can't stream them directly.
</div></details>
<input id="extTitle" placeholder="Title (for video songs, type the song name)" style="width:100%;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<input id="extCover" placeholder="Cover (optional): paste the YouTube link or an image URL" style="width:100%;margin-top:8px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px">
<div style="display:flex;gap:10px;align-items:center;margin-top:10px">
<label style="font-size:.9rem;color:#b8d8c0;cursor:pointer"><input type="checkbox" id="extSong" style="accent-color:#1e5a34"> 🎵 Video song</label>
<button class="btn" onclick="addExternal()" style="margin-left:auto;padding:10px 26px">Add</button>
</div>
<div id="extMsg" style="font-size:.85rem;margin-top:8px"></div>
<h4 style="margin:16px 0 8px">📚 Your linked movies & songs</h4>
<div id="extList" style="margin-top:10px"></div>
</div>
<div id="movieList"></div>
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
function fmtDur(s){if(!isFinite(s)||s<0)return "—";s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return (h>0?h+":"+("0"+m).slice(-2):m)+":"+("0"+ss).slice(-2);}
function fmtSpd(b){if(!isFinite(b)||b<=0)return "—";if(b>=1048576)return (b/1048576).toFixed(1)+" MB/s";if(b>=1024)return Math.round(b/1024)+" KB/s";return Math.round(b)+" B/s";}
function safeName(n){const d=n.lastIndexOf(".");const e=d>0?n.slice(d):"";let b=d>0?n.slice(0,d):n;
b=b.normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"file";return b+e;}
// ---- R2 incoming uploader ----
let r2up=null;
async function loadIncoming(){
  const box=$("incList"); if(!box)return;
  try{
    const r=await (await api("/api/admin/r2/incoming?pw="+encodeURIComponent(pw()))).json();
    if(!r.ok){box.innerHTML="";return;}
    window._incItems=r.items;
    if(!r.items.length){box.innerHTML="<p style='color:#7a9a85;font-size:.85rem'>Nothing waiting in incoming/ right now.</p>";return;}
    box.innerHTML=r.items.map(function(it,i){
      const name=it.key.slice("incoming/".length);
      return "<div style='display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #12271a'>"
        +"<span style='flex:1;word-break:break-all'>📄 "+name+"</span>"
        +"<span style='color:#7a9a85;font-size:.82rem'>"+fmt(it.size)+"</span>"
        +"<button class='btn danger' style='padding:5px 10px;font-size:.78rem' onclick='delIncomingIdx("+i+")'>Delete</button></div>";
    }).join("");
  }catch(e){box.innerHTML="";}
}
async function delIncomingIdx(i){
  const it=(window._incItems||[])[i]; if(!it)return;
  if(!confirm("Delete "+it.key+" from incoming/?"))return;
  await api("/api/admin/r2/incoming?key="+encodeURIComponent(it.key)+"&pw="+encodeURIComponent(pw()),{method:"DELETE"});
  loadIncoming();
}
function upSig(file){ return file.name+"|"+file.size+"|"+(file.lastModified||0); }
function upSave(){
  if(!r2up) return;
  try{ localStorage.setItem("ls_r2up_v1", JSON.stringify({sig:r2up.sig,key:r2up.key,uploadId:r2up.uploadId,parts:r2up.parts,fileName:r2up.fileName,fileSize:r2up.fileSize,updatedAt:Date.now()})); }catch(e){}
}
function upLoad(){ try{ const s=localStorage.getItem("ls_r2up_v1"); return s?JSON.parse(s):null; }catch(e){ return null; } }
function upClear(){ try{ localStorage.removeItem("ls_r2up_v1"); }catch(e){} }
function r2ResumeHint(){
  if(r2up) return;
  const saved=upLoad(), st=$("incStatus"), ab=$("incAbort"), inp=$("incFile");
  if(!saved){ ab.style.display="none"; return; }
  const file=inp.files&&inp.files[0];
  if(file&&saved.sig===upSig(file)){
    st.textContent="💾 Saved progress found for "+saved.fileName+" — "+saved.parts.length+" parts are already in R2. Press Upload to continue where it stopped, no restart from zero.";
    ab.style.display="";
  }else if(!file){
    st.textContent="💾 A partial upload of "+saved.fileName+" is saved ("+saved.parts.length+" parts). Pick that same file to continue it, or press Cancel to discard it.";
    ab.style.display="";
  }
}
async function abortR2Upload(){
  if(r2up){ r2up.cancelled=true; return; }
  const saved=upLoad();
  if(saved){
    if(!confirm("Discard the saved partial upload of "+saved.fileName+" ("+saved.parts.length+" parts)? Those parts will be removed from R2."))return;
    try{ await api("/api/admin/r2/abort?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:saved.key,uploadId:saved.uploadId})}); }catch(e){}
    upClear(); $("incStatus").textContent="Saved upload discarded."; $("incBar").style.width="0%"; $("incAbort").style.display="none";
  }
}
async function startR2Upload(){
  const inp=$("incFile"),st=$("incStatus"),bar=$("incBar");
  const file=inp.files&&inp.files[0];
  if(!file){st.textContent="Pick a file first.";return;}
  if(r2up){st.textContent="An upload is already running.";return;}
  const key="incoming/"+safeName(file.name);
  const PART=25*1024*1024;
  const nparts=Math.max(1,Math.ceil(file.size/PART));
  const btn=$("incBtn"); btn.disabled=true; $("incAbort").style.display="";
  let wake=null; try{ wake=await navigator.wakeLock.request("screen"); }catch(e){}
  let upTimer=null;
  let pausedMsg=null;
  try{
    const saved=upLoad();
    if(saved&&saved.sig===upSig(file)&&saved.key===key&&saved.uploadId){
      r2up={key:key,uploadId:saved.uploadId,parts:saved.parts||[],cancelled:false,sig:saved.sig,fileName:file.name,fileSize:file.size};
      st.textContent="↩️ Resuming "+file.name+" — "+r2up.parts.length+" of "+nparts+" parts already uploaded…";
    }else{
      st.textContent="Starting upload of "+file.name+" ("+fmt(file.size)+", "+nparts+" parts)…";
      const init=await (await api("/api/admin/r2/init?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,contentType:file.type||"application/octet-stream"})})).json();
      if(!init.uploadId) throw new Error(init.error||"init failed");
      r2up={key:key,uploadId:init.uploadId,parts:[],cancelled:false,sig:upSig(file),fileName:file.name,fileSize:file.size};
      upSave();
    }
    const doneNums={}; r2up.parts.forEach(function(p){ doneNums[p.partNumber]=true; });
    let sent=0;
    let upBase=0; for(let j=1;j<=nparts;j++){ if(doneNums[j]) upBase+=Math.min(file.size,j*PART)-(j-1)*PART; }
    const upT0=Date.now(); let upPrevT=upT0, upPrevB=0, upCur=0;
    function renderStats(){
      const el=$("incStats"); if(!el)return;
      const elap=(Date.now()-upT0)/1000, sess=sent-upBase;
      const avg=elap>0.5?sess/elap:0, spd=upCur>0?upCur:avg, rem=file.size-sent;
      el.textContent=fmtSpd(spd)+" · avg "+fmtSpd(avg)+" · ETA "+(spd>0?fmtDur(rem/spd):"—")+" · Elapsed "+fmtDur(elap);
    }
    function sampleStats(){
      const now=Date.now(), sess=sent-upBase, dt=(now-upPrevT)/1000;
      if(dt>=1){ const inst=(sess-upPrevB)/dt; if(inst>0) upCur=upCur>0?upCur*0.5+inst*0.5:inst; upPrevT=now; upPrevB=sess; }
      renderStats();
    }
    upTimer=setInterval(renderStats,1000);
    renderStats();
    sent=upBase;
    const todoParts=[];
    for(let i=1;i<=nparts;i++){ if(!doneNums[i]) todoParts.push(i); }
    let nextIdx=0, failMsg=null;
    async function upWorker(){
      while(!failMsg && !r2up.cancelled){
        const idx=nextIdx++; if(idx>=todoParts.length) return;
        const i=todoParts[idx];
        const blob=file.slice((i-1)*PART,Math.min(file.size,i*PART));
        let part=null,lastErr=null;
        for(let attempt=0;attempt<3&&!part;attempt++){
          try{
            const r=await (await api("/api/admin/r2/part?key="+encodeURIComponent(key)+"&uploadId="+encodeURIComponent(r2up.uploadId)+"&part="+i+"&pw="+encodeURIComponent(pw()),{method:"PUT",body:blob})).json();
            if(r.ok) part=r; else lastErr=new Error(r.error||"part failed");
          }catch(e){ lastErr=e; }
        }
        if(!part){ failMsg="part "+i+" would not go through ("+(lastErr?lastErr.message:"network error")+")"; return; }
        r2up.parts.push({partNumber:part.partNumber,etag:part.etag});
        r2up.parts.sort(function(a,b){return a.partNumber-b.partNumber;});
        upSave();
        sent+=blob.size;
        const pct=Math.round(sent/file.size*100);
        bar.style.width=pct+"%";
        sampleStats();
        st.textContent="Uploading… "+pct+"% ("+r2up.parts.length+"/"+nparts+" parts, "+fmt(sent)+" of "+fmt(file.size)+"). Progress is saved — a crash won't restart you from zero.";
      }
    }
    const CONC=Math.min(4,todoParts.length);
    const workers=[];
    for(let w=0;w<CONC;w++) workers.push(upWorker());
    await Promise.all(workers);
    if(failMsg){ pausedMsg=failMsg; throw new Error("__paused__"); }
    if(r2up.cancelled) throw new Error("cancelled");
    r2up.parts.sort(function(a,b){return a.partNumber-b.partNumber;});
    const done=await (await api("/api/admin/r2/complete?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,uploadId:r2up.uploadId,parts:r2up.parts})})).json();
    if(!done.ok){
      let landed=false;
      try{ const q=await (await api("/api/admin/r2/incoming?pw="+encodeURIComponent(pw()))).json(); (q.items||[]).forEach(function(it){ if(it.key===key&&it.size===file.size) landed=true; }); }catch(e){}
      if(!landed){ pausedMsg="the final step failed ("+(done.error||"unknown error")+") — all parts are uploaded, press Upload again to finish"; throw new Error("__paused__"); }
    }
    upClear();
    st.textContent="✅ Uploaded to R2 as "+key+" ("+fmt(file.size)+"). Pepper will process it into the library — the raw file is deleted afterwards.";
    bar.style.width="100%";
    inp.value="";
    loadIncoming();
  }catch(e){
    if(e.message==="cancelled"){
      st.textContent="Upload cancelled.";
      $("incStats").textContent="";
      if(r2up&&r2up.uploadId){ try{ await api("/api/admin/r2/abort?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,uploadId:r2up.uploadId})}); }catch(_){}}
      upClear(); bar.style.width="0%";
    }else if(e.message==="__paused__"){
      const pct2=r2up?Math.min(99,Math.round(r2up.parts.length*PART/Math.max(1,file.size)*100)):0;
      st.textContent="⏸ Upload paused: "+pausedMsg+". Progress is saved at part "+(r2up?r2up.parts.length:0)+"/"+nparts+" (~"+pct2+"%). Pick the same file and press Upload to continue — no restart from zero.";
      bar.style.width=pct2+"%";
    }else{
      st.textContent="❌ Upload stopped: "+e.message+". Any parts already sent are saved — pick the same file and press Upload to continue.";
    }
  }finally{
    if(upTimer){ clearInterval(upTimer); upTimer=null; }
    r2up=null; btn.disabled=false;
    $("incAbort").style.display=upLoad()?"":"none";
    if(wake) try{ wake.release(); }catch(e){}
  }
}
// nav
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{if(!authed)return;
document.querySelectorAll("nav button").forEach(x=>x.classList.remove("on"));b.classList.add("on");
document.querySelectorAll(".sec").forEach(s=>s.classList.remove("on"));$("s-"+b.dataset.s).classList.add("on");
if(b.dataset.s==="dash")loadDash();if(b.dataset.s==="files")loadFiles();if(b.dataset.s==="movies"){loadMovies();loadIncoming();r2ResumeHint();}});
async function saveTmdbKey(){
  const k=document.getElementById("tmdbKey").value.trim();
  if(!k)return;
  const r=await api("/api/admin/tmdb/key?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k})});
  document.getElementById("tmdbStatus").innerHTML=r.ok?'<span class="ok">✓ API key saved</span>':'<span class="bad">✗ failed</span>';
  if(r.ok)loadMovies();
}
async function loadMovies(){
  const box=document.getElementById("movieList");
  const ks=await api("/api/admin/tmdb/key?pw="+encodeURIComponent(pw()));
  const kd=await ks.json();
  document.getElementById("tmdbStatus").innerHTML=kd.has?'<span class="ok">✓ API key set</span>':'<span class="bad">No API key — add one above</span>';
  loadExtList();
  if(!kd.has){box.innerHTML="";return;}
  box.innerHTML="<p style='color:#7a9a85'>loading files…</p>";
  const br=await (await api("/api/buckets?pw="+encodeURIComponent(pw()))).json().catch(()=>({buckets:[]}));
  // Use public buckets endpoint instead
  const pb=await (await fetch("/api/buckets")).json().catch(()=>({buckets:[]}));
  let html="";
  for(const b of (pb.buckets||[])){
    const lr=await (await fetch("/api/list?bucket="+encodeURIComponent(b))).json().catch(()=>({objects:[]}));
    const vids=(lr.objects||[]).filter(o=>["mp4","webm","mkv","avi","mov"].includes(o.key.split(".").pop().toLowerCase()));
    if(!vids.length)continue;
    html+="<h4 style='margin:16px 0 8px'>📦 "+b+"</h4>";
    for(const v of vids){
      const name=v.key.split("/").pop();
      html+="<div style='display:flex;align-items:center;gap:10px;padding:8px;background:#0a120c;border-radius:8px;margin-bottom:6px'><span style='flex:1;font-size:.9rem'>"+name+"</span><button class='btn' style='padding:6px 14px;font-size:.8rem' data-b='"+b+"' data-k='"+v.key.replace(/'/g,"&#39;")+"' onclick='autoMatch(this)'>🔍 Auto-match</button><button class='btn' style='padding:6px 14px;font-size:.8rem' data-b='"+b+"' data-k='"+v.key.replace(/'/g,"&#39;")+"' onclick='markSong(this)'>🎵 Song</button></div>";
    }
  }
  box.innerHTML=html||"<p style='color:#7a9a85'>No video files found.</p>";
}
async function autoMatch(btn){
  const bucket=btn.dataset.b, key=btn.dataset.k;
  btn.disabled=true;btn.textContent="…";
  try{
    const r=await api("/api/admin/automatch?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bucket,key})});
    const d=await r.json();
    btn.textContent=r.ok?("✓ "+d.title):("✗ "+(d.error||"failed"));
  }catch(e){btn.textContent="✗ error";}
}
async function markSong(btn){
  const bucket=btn.dataset.b, key=btn.dataset.k;
  btn.disabled=true;btn.textContent="…";
  try{
    const r=await api("/api/admin/setsong?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bucket,key})});
    const d=await r.json();
    btn.textContent=r.ok?("✓ "+d.title):("✗ "+(d.error||"failed"));
  }catch(e){btn.textContent="✗ error";}
}
function ytCover(u){
  u=(u||"").trim();
  if(!u)return null;
  var id=null;
  var i=u.indexOf("youtu.be/"); if(i>=0)id=u.slice(i+9).split(/[/?#]/)[0];
  if(!id){i=u.indexOf("v="); if(i>=0)id=u.slice(i+2).split(/[&#]/)[0];}
  if(!id){i=u.indexOf("/shorts/"); if(i>=0)id=u.slice(i+8).split(/[/?#]/)[0];}
  if(id&&id.length>=6)return "https://img.youtube.com/vi/"+id+"/hqdefault.jpg";
  if(u.indexOf("http")===0&&(u.indexOf(".jpg")>0||u.indexOf(".png")>0||u.indexOf(".webp")>0))return u;
  return null;
}
function toDirectUrl(u){
  u=(u||"").trim();
  var i=u.indexOf("drive.google.com/file/d/");
  if(i>=0){var rest=u.slice(i+24);var id=rest.split("/")[0].split("?")[0];if(id)return "https://drive.google.com/uc?export=download&id="+id;}
  if(u.indexOf("drive.google.com")>=0){var m2=u.split("id=");if(m2.length>1){var id2=m2[1].split("&")[0];if(id2)return "https://drive.google.com/uc?export=download&id="+id2;}}
  if(u.indexOf("dropbox.com")>=0){return u.split("?dl=0")[0]+"?raw=1";}
  return u;
}
function convLink(el){
  var inp=el||document.querySelector(".extvurl");
  if(!inp)return;
  var v=inp.value.trim();
  var pd=v.indexOf("pixeldrain.com/u/");
  if(pd>=0){var pid=v.slice(pd+17).split("/")[0].split("?")[0];if(pid)v="https://pixeldrain.com/api/file/"+pid;}
  var d=toDirectUrl(v);
  var msg=document.getElementById("convMsg");
  if(d!==inp.value.trim()&&d){inp.value=d;msg.textContent="✓ converted to direct link";}
  else msg.textContent="";
}
function addVerRow(){
  var div=document.createElement("div");
  div.className="extver";div.style.cssText="display:flex;gap:6px;margin-bottom:6px";
  div.innerHTML='<input class="extvlabel" placeholder="Label" style="width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px"><input class="extvurl" placeholder="Paste share link or direct URL…" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px" oninput="convLink(this)">';
  document.getElementById("extVers").appendChild(div);
}
async function addExternal(){
  const rows=[...document.querySelectorAll("#extVers .extver")];
  const sources=rows.map(r=>({label:(r.querySelector(".extvlabel").value.trim()||"Video").slice(0,30),url:r.querySelector(".extvurl").value.trim()})).filter(s=>s.url);
  const msg=document.getElementById("extMsg");
  if(!sources.length){msg.innerHTML='<span class="bad">Paste at least one video URL</span>';return;}
  const url=sources[0].url;
  const title=document.getElementById("extTitle").value.trim()||url;
  const isSong=document.getElementById("extSong").checked;
  msg.textContent="adding…";
  let tmdb_id=null, type="movie";
  if(isSong){type="song";}
  else if(title){
    const s=await api("/api/admin/tmdb/search?q="+encodeURIComponent(title)+"&pw="+encodeURIComponent(pw()));
    const d=await s.json().catch(()=>({}));
    if(d.results&&d.results.length){tmdb_id=d.results[0].id;type=d.results[0].type||"movie";}
  }
  const r=await api("/api/admin/external?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({video_url:url,tmdb_id,type,title,sources,poster:ytCover(document.getElementById("extCover").value)})});
  const d=await r.json().catch(()=>({}));
  msg.innerHTML=r.ok?'<span class="ok">✓ added: '+d.title+'</span>':'<span class="bad">✗ '+(d.error||"failed")+'</span>';
  if(r.ok){document.getElementById("extSong").checked=false;document.getElementById("extVers").innerHTML='<div class="extver" style="display:flex;gap:6px;margin-bottom:6px"><input class="extvlabel" placeholder="Label" value="Hindi" style="width:80px;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px"><input class="extvurl" placeholder="Paste share link or direct URL…" style="flex:1;background:#060906;border:1px solid #1e3a2a;color:#fff;border-radius:8px;padding:10px" oninput="convLink(this)"></div>';document.getElementById("extTitle").value="";document.getElementById("extCover").value="";loadExtList();}
}
async function loadExtList(){
  const box=document.getElementById("extList");
  if(!box)return;
  const r=await (await fetch("/api/movies")).json().catch(()=>({movies:[]}));
  const ext=(r.movies||[]).filter(m=>m.external);
  box.innerHTML=ext.length?ext.map(m=>"<div style='display:flex;align-items:center;gap:10px;padding:8px;background:#060906;border-radius:8px;margin-bottom:6px'><span style='flex:1;font-size:.9rem'>🔗 "+m.title+"</span><button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='"+m.id+"' onclick='ytInfo(this)'>🎬 Video Info</button><button class='btn' style='padding:6px 14px;font-size:.8rem' data-id='"+m.id+"' onclick='delExternal(this)'>Delete</button></div>").join(""):"<p style='color:#7a9a85;font-size:.85rem'>No external links yet.</p>";
}
async function ytInfo(btn){
  const link=prompt("Paste the YouTube link for this video — title and cover will be filled automatically:");
  if(!link)return;
  btn.disabled=true;btn.textContent="…";
  const r=await api("/api/admin/ytinfo?pw="+encodeURIComponent(pw()),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:btn.dataset.id,url:link})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){btn.textContent="✓ "+(d.title||"done");setTimeout(loadExtList,1000);}
  else{btn.textContent="✗ failed";alert(d.error||"Could not fetch video info from YouTube.");}
}
async function delExternal(btn){
  const id=btn.dataset.id;
  await api("/api/admin/external?id="+encodeURIComponent(id)+"&pw="+encodeURIComponent(pw()),{method:"DELETE"});
  loadExtList();
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
$("st-buckets").textContent=d.buckets;$("st-files").textContent=d.files;
if(d.views){$("st-viewers").textContent=d.views.viewersToday;$("st-visits").textContent=d.views.hitsToday;$("st-total").textContent=d.views.totalHits;}
try{const dk2=function(off){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Dhaka",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()+off*864e5));};const gj=await(await fetch("https://redowansky.goatcounter.com/counter/TOTAL.json?start="+dk2(0)+"&end="+dk2(1))).json();if(gj&&gj.count!=null)$("st-viewers").textContent=String(gj.count).replace(/,/g,"");}catch(e){}
const pct=d.total?Math.min(100,d.used/d.total*100):0;
$("gring").style.strokeDashoffset=402-(402*pct/100);$("gpct").textContent=pct.toFixed(1)+"%";
$("gused").textContent=fmt(d.used);$("gfree").textContent=fmt(d.total-d.used);$("gtotal").textContent=fmt(d.total);}
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
</script><script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script></body></html>`;
const EXT_VIEW_PAGE = (m) => {
  const sources = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
  const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const seoLang = (sources[0] && sources[0].label && sources[0].label !== "Default" && sources[0].label !== "Video") ? sources[0].label : "";
  const seoYear = m.year ? String(m.year) : "";
  const seoTitleText = (m.title || "Untitled") + (seoYear ? " (" + seoYear + ")" : "") + (seoLang && m.type !== "song" ? " " + seoLang : "");
  const seoTitle = seoTitleText + " — Redowansky's Library";
  const seoDesc = m.overview ? String(m.overview).replace(/\s+/g, " ").trim().slice(0, 155) : ("Watch " + seoTitleText + " on Redowansky's Library — free streaming.");
  const seoCanon = "https://redowansky.bond/view/ext/" + m.id;
  const seoPoster = m.poster ? (String(m.poster).startsWith("http") ? m.poster : "https://image.tmdb.org/t/p/w500" + m.poster) : "";
  const seoMetaLine = [seoYear, seoLang, (m.genres || []).join(" · "), m.type === "song" ? "Video Song" : "Movie", m.vote ? "★ " + m.vote : ""].filter(Boolean).join(" · ");
  const seoSchema = { "@context": "https://schema.org", "@type": m.type === "song" ? "VideoObject" : "Movie", name: m.title || "", description: seoDesc, url: seoCanon, ...(seoYear ? { datePublished: seoYear + "-01-01" } : {}), ...(m.genres && m.genres.length ? { genre: m.genres } : {}), ...(seoPoster ? { image: seoPoster } : {}), ...(m.vote ? { aggregateRating: { "@type": "AggregateRating", ratingValue: String(m.vote), bestRating: "10" } } : {}) };
  const isDrive = (u) => u.indexOf("google.com") >= 0 && /[?&]id=([a-zA-Z0-9_-]+)/.test(u);
  const driveId = (u) => { const x = u.match(/[?&]id=([a-zA-Z0-9_-]+)/); return x ? x[1] : null; };
  const playerFor = (u) => isDrive(u)
    ? `<iframe src="https://drive.google.com/file/d/${driveId(u)}/preview" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>`
    : `<video controls controlsList="nodownload" preload="metadata" playsinline src="${u}" style="width:100%;max-height:70vh;background:#000"></video>`;
  const switcher = sources.length > 1
    ? `<div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px;flex-wrap:wrap">` +
      sources.map((s, i) => `<button onclick="setSrc(${i})" id="srcbtn${i}" style="padding:8px 18px;border-radius:20px;border:1px solid #2a5a3a;background:${i === 0 ? "#00e676" : "#122a1c"};color:${i === 0 ? "#06130b" : "#e8f5e9"};font-weight:600;cursor:pointer;font-size:.85rem">${s.label}</button>`).join("") +
      `</div>
      <script>
      const SRCS = ${JSON.stringify(sources.map(s => s.url))};
      function setSrc(i){
        const stage = document.getElementById("extstage");
        const db = document.getElementById("dlbtn");
        if (db) db.href = "/gate/ext/${m.id}?src=" + i;
        const u = SRCS[i];
        const isD = u.indexOf("google.com") >= 0 && /[?&]id=/.test(u);
        if (isD) {
          const idm = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
          stage.innerHTML = '<iframe src="https://drive.google.com/file/d/' + idm[1] + '/preview" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>';
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
  const player = `<div id="extstage">${playerFor(sources[0].url)}</div>`;
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
<script type="application/ld+json">${JSON.stringify(seoSchema)}</script>
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
${(m.overview || seoMetaLine) ? `<div style="width:100%;max-width:900px;margin-top:16px;color:#b8d8c0;font-size:.95rem;line-height:1.5">${m.overview ? `<p>${escHtml(m.overview)}</p>` : ""}${seoMetaLine ? `<div style="color:#7a9a85;font-size:.85rem;margin-top:8px">${escHtml(seoMetaLine)}</div>` : ""}</div>` : ""}
<div style="margin-top:16px;text-align:center"><a id="dlbtn" href="/gate/ext/${m.id}" style="display:inline-block;background:linear-gradient(90deg,#00c853,#69f0ae);color:#fff;text-decoration:none;font-weight:700;font-size:1rem;padding:13px 38px;border-radius:14px;box-shadow:0 8px 26px rgba(0,230,118,.35)">⭳ Download</a></div>
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
  window.initPlayGate();
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
</script><script data-cfasync="false" src="https://bancadeltempoidea.org/14/ba7702e94bb4deeb1322aa2d0369e347"></script></body></html>`;
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
const GATE_PAGE = (title, sub, desc, labels, src0) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<script async src="https://ss.mrmnd.com/banner.js"></script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download ${title} — Redowansky's Library</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060906;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
.card{background:linear-gradient(180deg,#101b14,#0c1410);border:1px solid #1e3a2a;border-radius:20px;padding:36px 32px;max-width:480px;width:100%}
.ico{font-size:3rem;margin-bottom:12px}
h1{font-size:1.25rem;margin-bottom:6px;word-break:break-word}
.meta{color:#7a9a85;font-size:.85rem;margin-bottom:20px}
.adslot{background:#0a120c;border:1px dashed #1e3a2a;border-radius:12px;min-height:120px;display:flex;align-items:center;justify-content:center;color:#55556a;font-size:.8rem;margin-bottom:20px;padding:16px;overflow:hidden}
.srcs{display:flex;gap:8px;justify-content:center;margin-bottom:18px;flex-wrap:wrap}
.srcs button{padding:8px 18px;border-radius:20px;border:1px solid #2a5a3a;background:#122a1c;color:#e8f5e9;font-weight:600;cursor:pointer;font-size:.85rem}
.srcs button.on{background:#00e676;color:#06130b}
.cd{font-size:2rem;font-weight:800;color:#69f0ae;margin-bottom:6px}
.status{color:#7a9a85;font-size:.88rem;min-height:1.2em;margin-bottom:16px}
.tswrap{display:flex;justify-content:center;margin-bottom:18px;min-height:65px}
.btn{display:inline-block;background:linear-gradient(90deg,#00c853,#69f0ae);color:#fff;border:none;text-decoration:none;font-weight:700;font-size:1.05rem;padding:15px 44px;border-radius:14px;box-shadow:0 8px 26px rgba(0,230,118,.35);cursor:pointer}
.btn[disabled]{background:#1c2b21;color:#5f7a68;box-shadow:none;cursor:not-allowed}
.wall{display:none;background:#2a1215;border:1px solid #6e2a30;color:#ffb3ba;border-radius:12px;padding:18px;font-size:.92rem;line-height:1.5}
.back{display:inline-block;margin-top:18px;color:#00e676;text-decoration:none;font-size:.9rem}
</style></head><body>
<div class="card">
<div class="ico">📥</div>
<h1>${title}</h1>
<div class="meta">${sub}</div>
<div class="adslot" id="adslot"><div data-mndbanid="b03e1301-6a18-445b-8cfe-9150397c75dd"></div></div>
<div id="gateMain">
<div class="srcs" id="srcs"></div>
<div class="cd" id="cd">10</div>
<div class="status" id="status">Preparing your download…</div>
<div class="tswrap"><div class="cf-turnstile" data-sitekey="${TS_SITEKEY}" data-callback="tsOk"></div></div>
<button class="btn" id="go" disabled>⭳ Download</button><br>
<a class="back" href="/">← back to library</a>
</div>
<div class="wall" id="wall">🚫 <b>Adblock detected.</b><br>Downloads are free because ads pay for the library.<br>Please disable your adblocker for this site and refresh the page.</div>
</div>
<div id="bait" class="ad adsbox ad-banner pub_300x250" style="height:1px;font-size:1px;line-height:1px">&nbsp;</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
var DESC=${JSON.stringify(desc)};
var LABELS=${JSON.stringify(labels)};
var curSrc=${src0 || 0},left=10,cdDone=false,tsToken=null,blocked=false,busy=false;
var goBtn=document.getElementById("go"),st=document.getElementById("status"),cdEl=document.getElementById("cd");
var srcsEl=document.getElementById("srcs");
if(LABELS.length>1){LABELS.forEach(function(l,i){var b=document.createElement("button");b.textContent=l;if(i===curSrc)b.className="on";b.onclick=function(){curSrc=i;var bs=srcsEl.querySelectorAll("button");for(var j=0;j<bs.length;j++)bs[j].className=(j===i?"on":"");};srcsEl.appendChild(b);});}
function tsOk(t){tsToken=t;tryEnable();}
function tryEnable(){
  if(blocked)return;
  if(cdDone&&tsToken){goBtn.disabled=false;st.textContent="Ready — your link expires 5 minutes after you click.";}
  else if(cdDone){st.textContent="Complete the human check above to unlock the download.";}
}
setTimeout(function(){
  var bait=document.getElementById("bait");
  var hidden=!bait||bait.offsetHeight===0||bait.offsetParent===null;
  if(!hidden){var cs=getComputedStyle(bait);if(cs.display==="none"||cs.visibility==="hidden")hidden=true;}
  if(hidden){blocked=true;document.getElementById("gateMain").style.display="none";document.getElementById("wall").style.display="block";}
},1500);
var timer=setInterval(function(){
  left--;if(left<=0){left=0;clearInterval(timer);cdDone=true;cdEl.textContent="✓";tryEnable();}
  else cdEl.textContent=left;
},1000);
goBtn.onclick=function(){
  if(busy||goBtn.disabled)return;busy=true;goBtn.textContent="Checking…";
  fetch("/api/gate/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({desc:DESC,src:curSrc,token:tsToken})})
  .then(function(r){return r.json();})
  .then(function(j){if(j&&j.go){location.href=j.go;}else{busy=false;goBtn.textContent="⭳ Download";st.textContent="❌ "+((j&&j.error)||"verification failed — refresh and try again.");}})
  .catch(function(){busy=false;goBtn.textContent="⭳ Download";st.textContent="❌ Network error — refresh and try again.";});
};
</script>
<div style="text-align:center;padding:14px;color:#5f7a68;font-size:.82rem">👀 __VIEWS_TODAY__ viewers today</div>
</body></html>`;
function fmtSize(n){if(!n)return "—";const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return n.toFixed(1)+" "+u[i];}

export class TunnelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // NOTE: no this.ws field anymore — see tunnelWs() (Hibernation API).
    this.pending = new Map();
    this.expectBodyFor = null;
    this._views = null;
    this._viewsTotal = null;
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
  async listMovies(env) {
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
    // External movies (linked, not hosted) - from KV (survives deploys)
    try {
      const extObj = await getExtMovies(env);
      for (const id in extObj) movies.push({ ...extObj[id], external: true });
    } catch (e) {}
    return movies;
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
    if (path === "/auth/logout" && request.method === "GET") {
      const s = await sessionFromRequest(env, request);
      if (s) await env.DATA_KV.delete("session:" + s.id);
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "lb_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" } });
    }
    if (path === "/auth/me" && request.method === "GET") {
      const s = await sessionFromRequest(env, request);
      if (!s) return json({ signedIn: false });
      return json({ signedIn: true, name: s.name || "", email: s.email || "" });
    }
    if (path === "/api/progress" && request.method === "GET") {
      const s = await sessionFromRequest(env, request);
      if (!s) return json({ signedIn: false, entries: [] });
      try {
        const list = await env.DATA_KV.list({ prefix: "progress:" + s.sub + ":" });
        const entries = [];
        for (const k of list.keys) {
          const v = await env.DATA_KV.get(k.name, "json");
          if (v) entries.push(v);
        }
        entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return json({ signedIn: true, name: s.name || "", entries });
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
            const ext = await getExtMovies(env);
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
        return new Response(ADMIN_PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });
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
      // Public: list all movies with metadata
      if (path === "/api/movies" && request.method === "GET") {
        return json({ movies: await this.listMovies(env) });
      }
      // Public: robots.txt — standard crawler lines + sitemap pointer.
      // Note: if Cloudflare's own AI-signal robots.txt takes precedence at
      // the edge, that is a dashboard setting, not this Worker — verify live.
      if (path === "/robots.txt" && request.method === "GET") {
        return new Response("User-agent: *\nAllow: /\n\nSitemap: https://redowansky.bond/sitemap.xml\n", { headers: { "content-type": "text/plain;charset=utf-8", "cache-control": "public, max-age=3600" } });
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
            if (s && s.url) srcList.push({ label: (s.label || "Version " + (srcList.length + 1)).slice(0, 30), url: toDirectUrlSrv(s.url) });
          }
        }
        if (!video_url && srcList.length) video_url = srcList[0].url;
        if (!video_url) return json({ error: "need video_url" }, 400);
        video_url = toDirectUrlSrv(video_url);
        if (!srcList.length) srcList = [{ label: "Default", url: video_url }];
        const apiKey = (env.TMDB_KEY || await this.state.storage.get("tmdb_key"));
        let meta = { title: title || video_url, year: null, overview: null, poster: (poster && poster.startsWith("http")) ? poster : null, backdrop: null, vote: null, genres: [], type: type || "movie", tmdb: null };
        if (tmdb_id && apiKey) {
          const d = await tmdbGet("/" + (type || "movie") + "/" + tmdb_id, apiKey);
          if (d) meta = { title: d.title || d.name, year: (d.release_date || d.first_air_date || "").slice(0, 4), overview: d.overview, poster: d.poster_path, backdrop: d.backdrop_path, vote: d.vote_average?.toFixed(1), genres: (d.genres || []).map(x => x.name), type: type || "movie", tmdb: tmdb_id };
        }
        const id = "e" + Date.now().toString(36);
        const extObj = await getExtMovies(env);
        extObj[id] = { id, url: video_url, sources: srcList, ...meta };
        await saveExtMovies(env, extObj);
        return json({ ok: true, id, title: meta.title });
      }
      // Admin: set poster on an external entry
      if (path === "/api/admin/extposter" && request.method === "POST") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { id, poster } = await request.json();
        const extObj = await getExtMovies(env);
        if (!extObj[id]) return json({ error: "not found" }, 404);
        extObj[id].poster = (poster && poster.startsWith("http")) ? poster : null;
        await saveExtMovies(env, extObj);
        return json({ ok: true });
      }
      // Admin: pull title + thumbnail from YouTube for an external entry
      if (path === "/api/admin/ytinfo" && request.method === "POST") {        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const { id, url: yturl } = await request.json();
        const extObj = await getExtMovies(env);
        if (!extObj[id]) return json({ error: "not found" }, 404);
        const u = yturl || "";
        let vid = null, i = -1;
        i = u.indexOf("youtu.be/"); if (i >= 0) vid = u.slice(i + 9).split(/[/?#]/)[0];
        if (!vid) { i = u.indexOf("v="); if (i >= 0) vid = u.slice(i + 2).split(/[&#]/)[0]; }
        if (!vid) { i = u.indexOf("/shorts/"); if (i >= 0) vid = u.slice(i + 8).split(/[/?#]/)[0]; }
        if (!vid) return json({ error: "not a YouTube link" }, 400);
        const oe = await fetch("https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + vid) + "&format=json");
        if (!oe.ok) return json({ error: "YouTube lookup failed" }, 502);
        const info = await oe.json().catch(() => ({}));
        if (info.title) extObj[id].title = info.title;
        extObj[id].poster = "https://img.youtube.com/vi/" + vid + "/hqdefault.jpg";
        await saveExtMovies(env, extObj);
        return json({ ok: true, title: extObj[id].title, poster: extObj[id].poster });
      }
      // Admin: delete external movie link
      if (path === "/api/admin/external" && request.method === "DELETE") {
        if (!(await checkPw(url, env, this.state))) return json({ error: "wrong password" }, 403);
        const id = url.searchParams.get("id");
        const extObj = await getExtMovies(env);
        delete extObj[id];
        await saveExtMovies(env, extObj);
        return json({ ok: true });
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
        const br = await this.s3fetch("GET", "/");
        let buckets = [], files = 0, used = 0;
        if (br.status < 400) {
          buckets = parseBuckets(bufToText(br.body));
          for (const b of buckets) {
            const lr = await this.s3fetch("GET", "/" + b, { query: "list-type=2&max-keys=1000" });
            if (lr.status < 400) {
              const xml = bufToText(lr.body);
              for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) used += parseInt(m[1]);
              files += (xml.match(/<Key>/g) || []).length;
            }
          }
        }
        return json({ tunnel: this.tunnelWs() ? "up" : "down", buckets: buckets.length, files, used, total: 53687091200, views: await this.viewsSnapshot() });
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
        const extObj = await getExtMovies(env);
        const m = extObj[id];
        if (!m) return new Response("not found", { status: 404 });
        return this.pageResp(EXT_VIEW_PAGE(m), request);
      }
      if (path.startsWith("/view/") && request.method === "GET") {
        const [, , bucket, ...keyParts] = path.split("/");
        const key = keyParts.map(decodeURIComponent).join("/");
        return this.pageResp(VIEW_PAGE(bucket, key, mediaKind(key)), request);
      }
      if (path.startsWith("/gate/ext/") && request.method === "GET") {
        const id = decodeURIComponent(path.split("/")[3] || "");
        const extObj = await getExtMovies(env);
        const m = extObj[id];
        if (!m) return new Response("not found", { status: 404 });
        const srcs = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
        const labels = srcs.map((s) => s.label || "Download");
        let src0 = parseInt(url.searchParams.get("src") || "0", 10);
        if (!(src0 >= 0 && src0 < srcs.length)) src0 = 0;
        const sub = [m.year, m.type === "song" ? "Video Song" : "Movie"].filter(Boolean).join(" · ");
        return this.pageResp(GATE_PAGE(m.title || "Download", sub, { kind: "ext", id }, labels, src0), request);
      }
      if (path.startsWith("/gate/file/") && request.method === "GET") {
        const [, , , bucket, ...keyParts] = path.split("/");
        const key = keyParts.map(decodeURIComponent).join("/");
        if (!bucket || !key) return new Response("not found", { status: 404 });
        return this.pageResp(GATE_PAGE(key.split("/").pop(), "from the " + bucket + " shelf", { kind: "file", bucket, key }, ["Download"], 0), request);
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
          const extObj = await getExtMovies(env);
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
          const extObj = await getExtMovies(env);
          const m = extObj[t.id];
          if (!m) return new Response("not found", { status: 404 });
          const srcs = (m.sources && m.sources.length) ? m.sources : [{ label: "Default", url: m.url }];
          const s = srcs[t.src || 0] || srcs[0];
          return Response.redirect(s.url, 302);
        }
        if (t.kind === "file") {
          return Response.redirect("/d/" + encodeURIComponent(t.bucket) + "/" + t.key.split("/").map(encodeURIComponent).join("/"), 302);
        }
        return new Response("bad link", { status: 400 });
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
};
