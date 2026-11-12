<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"/>
  <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript"/>
</p>

<h1 align="center">🎬 Redowansky Library</h1>

<p align="center"><i>The engine behind <b>redowansky.bond</b> — Redowansky Library, a personal Netflix-style movie &amp; TV library.</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Live-brightgreen?style=flat-square" alt="Live"/>
  <img src="https://img.shields.io/badge/Storage-Durable_Objects_+_KV_+_R2-orange?style=flat-square" alt="DO + KV + R2"/>
  <img src="https://img.shields.io/badge/Domain-redowansky.bond-blue?style=flat-square" alt="redowansky.bond"/>
</p>

> **Name note:** the site is **Redowansky Library** (redowansky.bond). `sia-lab` is only the old codename of this Cloudflare Worker — kept in the repo/filenames for history. The matching Android app is the **Redowansky Library** app (`app.pepper.library`).

---

## ✨ What it does

- 🎬 **Movies + TV Series** — hero carousel, poster grid, search, filters, Continue Watching, season/episode pages (e.g. Monarch S1)
- 🖼️ **TMDB auto-match** — posters and metadata pulled automatically for every title
- 📦 **R2 media** — movies in `movies/hindi/` and `movies/english/` (one audio track per title: Hindi for Indian titles, English for Hollywood), plus external embeds (e.g. Lulustream) for series
- 🔒 **Signed streams** — video bytes only flow through `/stream/<key>?t=<token>` (24h HMAC tokens minted by a current app/site session). Public R2 URLs are off, so old app builds can't play anything at all
- 🚫 **Server-side version gate** — the app is refused with 426 below the minimum version, while the update path (`/apk`, `version.json`) always stays open
- 👤 **Sign-in + sync** — Google and Amazon sign-in (`/auth/*`), cross-device watch progress (`/api/progress`), Ask for a Movie (`/api/request` → emailed to the developer)
- 🛠️ **Admin panel (`/admin`)** — resumable chunked R2 uploader to `incoming/`, TMDB matching, external entries, stats, and a Users Online Now counter (presence heartbeat)
- ⬇️ **Download gate** — `/gate` with Turnstile + HMAC-signed `/go/` links (5 min expiry), a full download page, and a signed `/px/` proxy that forces attachment downloads for external files
- 📢 **Ads** — Mondiad (gate banner, player push, interstitial) + Adsterra (Social Bar, popunder). The site-wide AdBlock wall is in the code but currently **disabled** via flag (Nov 12, 2026 — flip `ADBLOCK_WALL_ENABLED` to re-enable)
- 🔍 **SEO + policy** — `/sitemap.xml`, `robots.txt`, `/privacy`, `/app-ads.txt`, `/apk` redirect to the latest APK

## 🧱 How it's built

One Cloudflare Worker (`sia-lab`) serves everything:

- **TunnelDO** — a Durable Object holding the single reverse-tunnel WebSocket to the `s3d` storage host (it dials out to `/__tunnel`), so every edge isolate reaches the same socket. Migrated to the WebSocket Hibernation API, so the DO sleeps while idle instead of burning the free duration budget.
- **DATA_KV** — catalog metadata, watch progress, sessions, requests, admin settings.
- **MEDIA** — R2 bucket `media` (main account; an overflow account holds a second copy of the bucket).
- **Email** — `send_email` binding for Ask-for-a-Movie forwarding.

## 🚀 Deploy

```bash
python3 deploy_worker.py   # Cloudflare API via the credential helper — never put tokens in this repo
```

No wrangler, no server — Cloudflare free tier only.

## 📁 Layout

| File | What it is |
| --- | --- |
| `worker.js` | The whole Worker: pages, API, admin, gate, streaming, ads |
| `deploy_worker.py` | Deploys `worker.js` with its DO/KV/R2 bindings via the Cloudflare API |
| `deploy_pages.py` | Deploys static files to Cloudflare Pages (direct-upload REST API) |
| `apply_0627_gate.py` | One-off patch script: v0.6.27 app version gate |
| `apply_0628_stream.py` | One-off patch script: v0.6.28 signed-stream URLs |
| `set_play_secret.py` | Generates + sets the `PLAY_TOKEN_SECRET` Worker secret (random, never printed) |
| `DOWNLOAD_PAGE_NEW.txt`, `GATE_PAGE_NEW.txt` | Download/gate page templates used by the patch scripts |
| `disaster-kit/` | Catalog + KV snapshot with rebuild steps (takedown scenario) |
| `r2-tools/` | R2 admin helpers (chunked/resumable uploads through the Worker's multipart endpoints) |
| `fix-admin-auth.patch` | Historical patch, kept for reference |

## ⚠️ Critical — read before touching

> [!CAUTION]
> The Durable Object name is **frozen at `main-v35`** (see the comment in `worker.js`). **Never rename it.** Every unique DO name creates a fresh, empty database — renaming wipes all stored settings on every deploy. This was the root cause of the *"everything resets on update"* saga.

> [!NOTE]
> Secrets live as Cloudflare Worker secrets — **never in this repo**: `ADMIN_PW`, `TMDB_KEY`, `PLAY_TOKEN_SECRET`, `GOOGLE_CLIENT_SECRET`, `AMAZON_CLIENT_SECRET`, `UPLOAD_KEY`. (The Google OAuth client ID in `worker.js` is public by design — it travels in authorize URLs.)
>
> Admin uploads go through the chunked/resumable R2 endpoints — never a single big request (Cloudflare caps a single Worker request at 100 MB).
>
> Rotating `PLAY_TOKEN_SECRET` invalidates every outstanding stream token at once.
