#!/usr/bin/env python3
"""Chunked upload of a local file to R2 through the sia-lab worker's multipart endpoints.
Resumable: progress is kept in a state file next to this script."""
import sys, os, json, time, urllib.request, urllib.parse

BASE = "https://redowansky.bond"
PART = 50 * 1024 * 1024
UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"

key = open("/home/hatch/workspace/r2/.upload_key").read().strip()

def call(method, path, body=None, headers=None, timeout=300):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header("x-upload-key", key)
    req.add_header("User-Agent", UA)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

def main(path, r2key, content_type):
    size = os.path.getsize(path)
    nparts = (size + PART - 1) // PART
    state_path = f"/home/hatch/workspace/r2/state_{r2key.replace('/', '_')}.json"
    state = {"uploadId": None, "parts": []}
    if os.path.exists(state_path):
        state = json.load(open(state_path))
        print(f"resuming {r2key}: {len(state['parts'])}/{nparts} parts already up", flush=True)
    if not state["uploadId"]:
        init = None
        for attempt in range(6):
            try:
                init = call("POST", "/api/admin/r2/init", json.dumps({"key": r2key, "contentType": content_type}).encode(), {"Content-Type": "application/json"})
                break
            except Exception as e:
                print(f"init attempt {attempt+1} failed: {e}; retrying", flush=True)
                time.sleep(5 * (attempt + 1))
        if not init:
            print("INIT FAILED", flush=True)
            sys.exit(1)
        state["uploadId"] = init["uploadId"]
        json.dump(state, open(state_path, "w"))
        print(f"uploading {path} ({size} bytes) as {r2key} in {nparts} parts; uploadId {state['uploadId'][:16]}...", flush=True)
    done_nums = {p["partNumber"] for p in state["parts"]}
    with open(path, "rb") as f:
        for i in range(1, nparts + 1):
            if i in done_nums:
                continue
            f.seek((i - 1) * PART)
            chunk = f.read(PART)
            ok = False
            for attempt in range(6):
                try:
                    r = call("PUT", f"/api/admin/r2/part?key={urllib.parse.quote(r2key)}&uploadId={state['uploadId']}&part={i}", chunk, {"Content-Type": "application/octet-stream"}, timeout=600)
                    state["parts"].append({"partNumber": r["partNumber"], "etag": r["etag"]})
                    state["parts"].sort(key=lambda p: p["partNumber"])
                    json.dump(state, open(state_path, "w"))
                    print(f"part {i}/{nparts} ok ({len(chunk)} bytes)", flush=True)
                    ok = True
                    break
                except Exception as e:
                    print(f"part {i} attempt {attempt+1} failed: {e}; retrying", flush=True)
                    time.sleep(5 * (attempt + 1))
            if not ok:
                print("FAILED at part", i, "— state saved, rerun to resume", flush=True)
                sys.exit(1)
    done = None
    for attempt in range(6):
        try:
            done = call("POST", "/api/admin/r2/complete", json.dumps({"key": r2key, "uploadId": state["uploadId"], "parts": state["parts"]}).encode(), {"Content-Type": "application/json"}, timeout=120)
            break
        except Exception as e:
            print(f"complete attempt {attempt+1} failed: {e}; retrying", flush=True)
            time.sleep(5 * (attempt + 1))
    if not done:
        print("COMPLETE FAILED — state saved, rerun to retry", flush=True)
        sys.exit(1)
    print("COMPLETE:", done, flush=True)
    os.remove(state_path)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "video/mp4")
