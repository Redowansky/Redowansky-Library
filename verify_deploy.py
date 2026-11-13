#!/usr/bin/env python3
"""Verify the deployed sia-lab script matches local worker.js byte-for-byte.

The Cloudflare GET wraps the script in multipart framing (3 header lines +
trailing boundary) — strip it before diffing (learned 2026-11-13).
Also: GET + PUT the cron schedule ("0 2 * * *" daily) when called with
--set-schedule, and print the current schedules with --show-schedule.
"""
import hashlib
import json
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "676d7eaee0bab349422d3c91c9690679"
HERE = "/home/hatch/workspace/sia-lab"

def api(method, path, body=None, headers=None):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:500])
        sys.exit(1)

if "--set-schedule" in sys.argv:
    body = json.dumps([{"cron": "0 2 * * *"}]).encode()
    out = api("PUT", "/accounts/%s/workers/scripts/sia-lab/schedules" % ACCT,
              body, {"Content-Type": "application/json"})
    print("schedule set:", out.decode()[:400])

if "--show-schedule" in sys.argv:
    out = api("GET", "/accounts/%s/workers/scripts/sia-lab/schedules" % ACCT)
    print("schedules:", out.decode()[:600])

raw = api("GET", "/accounts/%s/workers/scripts/sia-lab" % ACCT)
# Strip multipart framing: everything up to the first blank line after the
# part headers, and the trailing boundary line.
text = raw.decode("utf-8", "replace")
head_end = text.find("\r\n\r\n")
assert head_end > 0, "no multipart header found"
script = text[head_end + 4:]
tail = script.rfind("\r\n--")
if tail > 0:
    script = script[:tail]
local = open(HERE + "/worker.js", "rb").read()
print("deployed sha256:", hashlib.sha256(script.encode()).hexdigest()[:16])
print("local    sha256:", hashlib.sha256(local).hexdigest()[:16])
print("MATCH" if script.encode() == local else "MISMATCH")
sys.exit(0 if script.encode() == local else 1)
