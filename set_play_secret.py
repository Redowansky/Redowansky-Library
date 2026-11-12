#!/usr/bin/env python3
"""Set the PLAY_TOKEN_SECRET Worker secret (random, never printed).
Uses the same Cloudflare API auth as deploy_worker.py."""
import json
import secrets
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "676d7eaee0bab349422d3c91c9690679"

secret = secrets.token_hex(32)
body = json.dumps({
    "name": "PLAY_TOKEN_SECRET",
    "text": secret,
    "type": "secret_text",
}).encode()
req = urllib.request.Request(
    BASE + f"/accounts/{ACCT}/workers/scripts/sia-lab/secrets",
    data=body, method="PUT",
)
req.add_header("Content-Type", "application/json")
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = read_json_response(resp)
        print("secret set:", d.get("success"), "result:", d.get("result"))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:500])
    sys.exit(1)
