#!/usr/bin/env python3
"""Deploy the sia-lab Worker (with Durable Object binding) via the API.
Deploy log:
  2026-10-23 TunnelDO migrated to the WebSocket Hibernation API
  (state.acceptWebSocket) so the DO stops billing duration while idle —
  DO idFromName("main-v35"), TUNNEL_DO/DATA_KV/MEDIA bindings confirmed unchanged.
"""
import json
import sys
import urllib.request
import urllib.error
import uuid
import os

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "676d7eaee0bab349422d3c91c9690679"
HERE = os.path.dirname(os.path.abspath(__file__))

script = open(os.path.join(HERE, "worker.js"), "rb").read()
metadata = {
    "main_module": "worker.js",
    "compatibility_date": "2025-10-01",
    "bindings": [
        {"type": "durable_object_namespace", "name": "TUNNEL_DO", "class_name": "TunnelDO"},
        {"type": "kv_namespace", "name": "DATA_KV", "namespace_id": "1d03652f9f5f4dceb8f276abbb95d4a2"},
        {"type": "r2_bucket", "name": "MEDIA", "bucket_name": "media"},
    ],
    # migrations only needed once (class already created); omit on updates
}
boundary = uuid.uuid4().hex
body = b""
body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n".encode()
body += json.dumps(metadata).encode() + b"\r\n"
body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
body += script + b"\r\n" + f"--{boundary}--\r\n".encode()

req = urllib.request.Request(BASE + f"/accounts/{ACCT}/workers/scripts/sia-lab", data=body, method="PUT")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = read_json_response(resp)
        print("deployed:", d["result"]["id"])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:800])
    sys.exit(1)
