# sia-lab Worker

Cloudflare Worker powering **redowansky.bond** — "Redowansky's Library", a personal media library site.

## What it does
- Serves the public library UI (Netflix-style movie browser, file shelves, video/image/audio preview with Range seeking)
- Password-gated admin dashboard (`/admin`): uploads, file management, shelves, settings, external movie links
- Backed by a Durable Object (`TUNNEL_DO`) + KV namespace for metadata that survives deploys
- External movie links: Google Drive / Dropbox / Pixeldrain URLs auto-converted to streamable sources, multi-version (e.g. Hindi/English audio) per movie

## Deploy
```bash
python3 deploy_worker.py   # needs CLOUDFLARE_API_TOKEN env
```

## ⚠️ Critical
The Durable Object name is frozen at `main-v35` (see comment in worker.js). **Never rename it** — each unique DO name creates a fresh empty database, wiping all stored settings on every deploy. This was the root cause of the "everything resets on update" saga.
Admin password + TMDB key live as Cloudflare Worker secrets (`ADMIN_PW`, `TMDB_KEY`), not in this repo.
