#!/usr/bin/env python3
"""Apply the v0.6.28 signed-stream work to worker.js (deploy #1:
LATEST_APP_VERSION stays 39 — the LATEST bump ships as deploy #2
only AFTER app 0.6.28 is live, or 0.6.27 users lose their update
path). Same contract: every replacement must match exactly once
in validation, or nothing is written."""
import sys

BASE = "/home/hatch/workspace/sia-lab"

EDITS = {
    "worker.js": [
        ('''function appVersionRefused() {
  return json({ blocked: true, message: APP_UPDATE_MESSAGE }, 426);
}''',
         '''function appVersionRefused() {
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
  return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
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
}'''),
        ('''      // Pre-play version check (app 0.6.27+): the server decides''',
         '''      // Stream token mint (app 0.6.28+ / site player): a current
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
        const m = rangeHdr.match(/bytes=(\\d*)-(\\d*)/);
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
      // Pre-play version check (app 0.6.27+): the server decides'''),
        ('''const EXT_VIEW_PAGE = (m) => {''',
         '''const EXT_VIEW_PAGE = async (m, env) => {'''),
        ('''  const playerFor = (u) => isDrive(u)
    ? `<iframe src="https://drive.google.com/file/d/${driveId(u)}/preview" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>`
    : isEmbed(u)
    ? `<iframe src="${u}" scrolling="no" frameborder="0" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"></iframe>`
    : `<video controls controlsList="nodownload" preload="metadata" playsinline src="${u}" style="width:100%;max-height:70vh;background:#000"></video>`;''',
         '''  const playerFor = async (u) => isDrive(u)
    ? `<iframe src="https://drive.google.com/file/d/${driveId(u)}/preview" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen></iframe>`
    : isEmbed(u)
    ? `<iframe src="${u}" scrolling="no" frameborder="0" style="width:100%;height:70vh;border:none;background:#000" allow="autoplay; fullscreen" allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"></iframe>`
    : `<video controls controlsList="nodownload" preload="metadata" playsinline src="${await streamUrlFor(env, u)}" style="width:100%;max-height:70vh;background:#000"></video>`;'''),
        ('''  const switcher = sources.length > 1''',
         '''  // v0.6.28: R2 sources play through signed stream URLs (the public
  // R2 URL is dead once the bucket's r2.dev domain is off). Drive
  // and embed sources pass through unchanged (streamUrlFor no-ops).
  const srcUrls = [];
  for (const s of sources) srcUrls.push(await streamUrlFor(env, s.url));
  const switcher = sources.length > 1'''),
        ('''      const SRCS = ${JSON.stringify(sources.map(s => s.url))};''',
         '''      const SRCS = ${JSON.stringify(srcUrls)};'''),
        ('''  const player = `<div id="extstage">${playerFor(sources[0].url)}</div>`;''',
         '''  const player = `<div id="extstage">${await playerFor(sources[0].url)}</div>`;'''),
        ('''        return this.pageResp(EXT_VIEW_PAGE(m), request);''',
         '''        return this.pageResp(await EXT_VIEW_PAGE(m, env), request);'''),
        ('''          const s = srcs[t.src || 0] || srcs[0];
          return Response.redirect(s.url, 302);''',
         '''          const s = srcs[t.src || 0] || srcs[0];
          // v0.6.28: R2 sources download through the signed stream
          // (the public R2 URL is dead once the bucket's r2.dev
          // domain is off); other hosts redirect as before.
          const dk = r2KeyOf(s.url);
          if (dk) {
            const tok = await mintStreamToken(env, dk);
            return Response.redirect("/stream/" + dk.split("/").map(encodeURIComponent).join("/") + "?t=" + tok + "&download=1", 302);
          }
          return Response.redirect(s.url, 302);'''),
    ],
}

texts = {}
failed = False
for rel, pairs in EDITS.items():
    path = f"{BASE}/{rel}"
    with open(path, encoding="utf-8") as f:
        texts[rel] = f.read()
    for old, new in pairs:
        n = texts[rel].count(old)
        if n != 1:
            print(f"FAIL {rel}: match count {n} for: {old[:70]!r}")
            failed = True
if failed:
    print("ABORTED: validation failed; no files written.")
    sys.exit(1)
for rel, pairs in EDITS.items():
    text = texts[rel]
    for old, new in pairs:
        text = text.replace(old, new)
        print(f"ok {rel}: {old[:60]!r}")
    with open(f"{BASE}/{rel}", "w", encoding="utf-8") as f:
        f.write(text)
print("ALL EDITS APPLIED")
