# Disaster kit — redowansky.bond library (snapshot 2026-10-21)

If Cloudflare / the registrar / Google takes the site down, rebuild from here.

## What's in this folder
- `catalog.json` — full public catalog as served by /api/movies (titles, posters, R2 URLs, shelf data as the Worker merges it). 4 entries at snapshot time.
- `kv-dump.json` — the entire DATA_KV namespace (single key `ext:movies`: all external-link movies/songs).

## What lives elsewhere (verified 2026-10-21)
- Worker source: `~/workspace/sia-lab/worker.js` + GitHub backup repo `sia-lab-worker`.
- ALL media has local copies (R2 is NOT the only copy):
  - Dhoom 3 → `~/workspace/dhoom3/Dhoom3-2013-faststart.mp4`
  - Iron Man (English) → `~/workspace/ironman/Iron Man 2008 English.mp4`
  - Genius → `~/workspace/r2/genius-2018.mp4`
  - Kalyani → `~/workspace/r2/kalyani.mp4`
- R2 layout: movies/hindi/dhoom3-hindi.mp4, movies/hindi/genius-2018.mp4,
  movies/english/iron-man-2008-english.mp4, music-videos/kalyani.mp4.
- Secrets NOT in any backup (by design): admin password, TMDB key, UPLOAD_KEY — all are Worker secrets on the account; re-set them on the new account (`cf.py set-secret`).

## Rebuild sketch (new Cloudflare account)
1. Register/point any domain at the new account (or reuse redowansky.bond if only the account died — move the zone).
2. Create KV namespace + R2 bucket `media` + Durable Object; update bindings to match worker.js (DATA_KV, MEDIA, S/TUNNEL_DO).
3. Deploy worker.js (`cf.py deploy --keep-bindings`).
4. Re-upload the 4 media files to the same R2 keys (~/workspace/r2/upload_r2.py).
5. Restore KV: PUT `ext:movies` from kv-dump.json.
6. Rebuild shelves in the admin panel using catalog.json as the map.
7. Set secrets; request AdSense review again on the new domain (approval does NOT transfer).

## Gotchas
- LockShield shares this domain (lockshield.redowansky.bond) and this CF account. If the domain/account dies, LockShield phones stop verifying contact and self-lock after their grace (default 24h) — restore the Worker on ANY domain fast, or lengthen grace from the panel BEFORE an incident if one is expected.
- This VM is the single home of the media masters + LockShield signing key. A cold copy of the 4 media files (e.g. Google Drive) removes that single point of failure.
