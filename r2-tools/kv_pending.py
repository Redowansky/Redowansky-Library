#!/usr/bin/env python3
"""Read/write the sia-lab KV key ext:pending (approval queue) using the
stored custom.cloudflare credential. Modelled on kv_movies.py."""
import sys, json, urllib.request, urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "676d7eaee0bab349422d3c91c9690679"
NS = "1d03652f9f5f4dceb8f276abbb95d4a2"
KEY = "ext:pending"

def api(method, path, body=None, raw=False):
    if raw:
        data = body
    else:
        data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if raw:
        req.add_header("Content-Type", "application/octet-stream")
    elif data:
        req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as e:
        raw_body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {raw_body[:800]}")
        sys.exit(1)

def get_value():
    d = api("GET", f"/accounts/{ACCT}/storage/kv/namespaces/{NS}/values/{KEY}", raw=True)
    return d if isinstance(d, dict) else json.loads(d)

def put_value(text):
    return api("PUT", f"/accounts/{ACCT}/storage/kv/namespaces/{NS}/values/{KEY}", body=text.encode(), raw=True)

if __name__ == "__main__":
    if sys.argv[1] == "list":
        v = get_value()
        print(f"{len(v)} entries")
        for k, e in v.items():
            print(k, "|", e.get("status"), "|", e.get("title"), "|", e.get("year"), "|", e.get("type"), "| tmdb:", e.get("tmdb"), "| sources:", len(e.get("sources") or []))
    elif sys.argv[1] == "get":
        v = get_value()
        print(json.dumps(v.get(sys.argv[2]), indent=2))
    elif sys.argv[1] == "put":
        # put <json-file> : replace whole ext:pending value with file contents
        put_value(open(sys.argv[2]).read())
        print("ext:pending replaced")
    elif sys.argv[1] == "add":
        # add <json-candidate> : insert one candidate (must carry its own id)
        cand = json.loads(sys.argv[2])
        v = get_value()
        v[cand["id"]] = cand
        put_value(json.dumps(v))
        print("added", cand["id"])
    elif sys.argv[1] == "delete":
        v = get_value()
        if sys.argv[2] in v:
            del v[sys.argv[2]]
            put_value(json.dumps(v))
            print("deleted", sys.argv[2])
        else:
            print("not found", sys.argv[2])
    elif sys.argv[1] == "clear":
        put_value("{}")
        print("ext:pending cleared")
