#!/usr/bin/env python3
"""Apply the v0.6.27 server-side app version gate to worker.js.
Same contract: every replacement must match exactly once in
validation, or nothing is written. DEPLOY ONLY AFTER app 0.6.27
(code 39) is live on R2, or older builds lose their update path
(the banner would offer 0.6.26, which the gate also refuses)."""
import sys

BASE = "/home/hatch/workspace/sia-lab"

EDITS = {
    "worker.js": [
        ('''const te = new TextEncoder();''',
         '''const te = new TextEncoder();

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
const LATEST_APP_VERSION = 39;
const APP_UPDATE_MESSAGE = "⚠️ current version of the app is not working anymore please update to the latest version to keep watching ⚠️";
function appVersionBlocked(request) {
  const ua = request.headers.get("User-Agent") || "";
  if (!ua.startsWith("RedowanskyLibraryApp")) return false;
  const v = parseInt(request.headers.get("X-App-Version") || "", 10);
  return !(v >= LATEST_APP_VERSION);
}
function appVersionRefused() {
  return json({ blocked: true, message: APP_UPDATE_MESSAGE }, 426);
}'''),
        ('''    if (path === "/api/progress" && request.method === "GET") {''',
         '''    // v0.6.27 gate: one line covers GET/POST/DELETE below.
    if (path === "/api/progress" && appVersionBlocked(request)) return appVersionRefused();
    if (path === "/api/progress" && request.method === "GET") {'''),
        ('''      // Public: list all movies with metadata
      if (path === "/api/movies" && request.method === "GET") {''',
         '''      // Pre-play version check (app 0.6.27+): the server decides
      // whether this build may still play. 200 = allowed, 426 =
      // refused with the update warning message.
      if (path === "/api/version-check" && request.method === "GET") {
        if (appVersionBlocked(request)) return appVersionRefused();
        return json({ ok: true, latest: LATEST_APP_VERSION });
      }
      // Public: list all movies with metadata
      if (path === "/api/movies" && request.method === "GET" && appVersionBlocked(request)) return appVersionRefused();
      if (path === "/api/movies" && request.method === "GET") {'''),
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
