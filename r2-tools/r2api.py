#!/usr/bin/env python3
"""Cloudflare R2 admin helper using the stored custom.cloudflare credential."""
import sys, json, urllib.request, urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "676d7eaee0bab349422d3c91c9690679"

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {raw[:800]}")
        sys.exit(1)

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "buckets":
        d = api("GET", f"/accounts/{ACCT}/r2/buckets")
        print(json.dumps(d.get("result", {}), indent=2)[:1000])
    elif cmd == "create-bucket":
        d = api("POST", f"/accounts/{ACCT}/r2/buckets", {"name": sys.argv[2]})
        print(json.dumps(d.get("result", {}), indent=2)[:500])
    elif cmd == "r2dev":
        bucket = sys.argv[2]
        enable = sys.argv[3] == "on" if len(sys.argv) > 3 else True
        d = api("PUT", f"/accounts/{ACCT}/r2/buckets/{bucket}/domains/r2dev", {"enabled": enable})
        print(json.dumps(d.get("result", {}), indent=2)[:500])
    elif cmd == "domains":
        bucket = sys.argv[2]
        d = api("GET", f"/accounts/{ACCT}/r2/buckets/{bucket}/domains")
        print(json.dumps(d.get("result", {}), indent=2)[:1000])
    elif cmd == "create-token":
        # R2 S3 token: Object Read & Write on all buckets
        body = {
            "name": "r2-media-s3",
            "policies": [{
                "effect": "allow",
                "resources": {f"com.cloudflare.api.account.{ACCT}": "*"},
                "permission_groups": [{"id": "r2"}],
            }],
        }
        # permission_groups by name is not supported; use the dedicated endpoint below instead
        d = api("POST", f"/accounts/{ACCT}/r2/tokens", {
            "name": "r2-media-s3",
            "permissions": ["Object Read & Write"],
        })
        print(json.dumps(d.get("result", {}), indent=2)[:1200])
