#!/usr/bin/env python3
"""Set the DISCOVERY_CRON_SECRET Worker secret (Phase 2a).

The value is generated here, sent to Cloudflare, and NEVER printed or
written to disk — the Worker reads it from env; nothing else needs it.
"""
import json
import secrets
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "676d7eaee0bab349422d3c91c9690679"

value = secrets.token_hex(32)
body = json.dumps({"name": "DISCOVERY_CRON_SECRET", "text": value, "type": "secret_text"}).encode()
req = urllib.request.Request(
    BASE + "/accounts/%s/workers/scripts/sia-lab/secrets" % ACCT,
    data=body, method="PUT")
req.add_header("Content-Type", "application/json")
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = read_json_response(resp)
        print("secret set OK:", d.get("success"), d.get("result", {}).get("name"))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:500])
    sys.exit(1)
