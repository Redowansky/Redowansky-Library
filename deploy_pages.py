#!/usr/bin/env python3
"""Deploy static files to Cloudflare Pages via direct-upload REST API (no wrangler)."""
import base64
import hashlib
import json
import mimetypes
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

import blake3

ACCT = "676d7eaee0bab349422d3c91c9690679"
PROJECT = "sia-lab"
BASE = "https://api.cloudflare.com/client/v4"
CRED = "custom.cloudflare"
HOSTS = ["api.cloudflare.com"]

SITE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")


def cf_hash(data: bytes, rel_path: str) -> str:
    ext = os.path.splitext(rel_path)[1][1:]
    b64 = base64.b64encode(data)
    return blake3.blake3(b64 + ext.encode("ascii")).hexdigest()[:32]


def api_request(method, path, body=None, content_type="application/json",
                bearer=None, timeout=90):
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if content_type and data:
        req.add_header("Content-Type", content_type)
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    else:
        add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} on {method} {path}:\n{raw[:1500]}", file=sys.stderr)
        sys.exit(1)


def main():
    files = {}
    for root, _, names in os.walk(SITE_DIR):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, SITE_DIR).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = f.read()
            files["/" + rel] = (data, mimetypes.guess_type(n)[0] or "application/octet-stream")
    print(f"{len(files)} file(s) to deploy")

    manifest = {}
    for path, (data, ctype) in files.items():
        manifest[path] = (cf_hash(data, path), data, ctype)

    # 1. upload token (JWT)
    t = api_request("GET", f"/accounts/{ACCT}/pages/projects/{PROJECT}/upload-token")
    jwt = t["result"]["jwt"]
    print("got upload JWT")

    # 2. upload assets (JWT auth, no /accounts prefix)
    payload = [
        {"base64": True, "key": h,
         "metadata": {"contentType": ctype},
         "value": base64.b64encode(data).decode()}
        for h, data, ctype in manifest.values()
    ]
    u = api_request("POST", "/pages/assets/upload", body=payload, bearer=jwt)
    print("assets upload success:", u.get("success"))

    # 3. upsert hashes (JWT auth)
    s = api_request("POST", "/pages/assets/upsert-hashes",
                    body={"hashes": [h for h, _, _ in manifest.values()]},
                    bearer=jwt)
    print("upsert-hashes success:", s.get("success"))

    # 4. create deployment (API token auth, multipart)
    boundary = uuid.uuid4().hex
    body_manifest = json.dumps({p: h for p, (h, _, _) in manifest.items()},
                               separators=(",", ":"))
    parts = [
        ("--" + boundary).encode(),
        b'Content-Disposition: form-data; name="manifest"',
        b"Content-Type: application/json",
        b"",
        body_manifest.encode(),
        ("--" + boundary).encode(),
        b'Content-Disposition: form-data; name="branch"',
        b"",
        b"main",
        ("--" + boundary + "--").encode(),
        b"",
    ]
    d = api_request(
        "POST", f"/accounts/{ACCT}/pages/projects/{PROJECT}/deployments",
        body=b"\r\n".join(parts),
        content_type=f"multipart/form-data; boundary={boundary}")
    dep = d["result"]
    dep_id = dep["id"]
    print("deployment:", dep_id)

    # poll until file_count > 0
    for _ in range(20):
        g = api_request("GET", f"/accounts/{ACCT}/pages/projects/{PROJECT}/deployments/{dep_id}")
        r = g["result"]
        fc = r.get("file_count")
        stage = (r.get("latest_stage") or {}).get("name")
        status = (r.get("latest_stage") or {}).get("status")
        print(f"poll: file_count={fc} stage={stage} status={status}")
        if fc and fc > 0 and status in ("success", "idle", "active"):
            break
        time.sleep(5)
    print("url:", r.get("url"))
    print("DONE")


if __name__ == "__main__":
    main()
