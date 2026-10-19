<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"/>
  <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript"/>
</p>

<h1 align="center">📚 sia-lab</h1>

<p align="center"><i>The engine behind <b>redowansky.bond</b> — a personal Netflix-style media library.</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Live-brightgreen?style=flat-square" alt="Live"/>
  <img src="https://img.shields.io/badge/Storage-Durable_Objects_+_KV-orange?style=flat-square" alt="DO + KV"/>
  <img src="https://img.shields.io/badge/Domain-redowansky.bond-blue?style=flat-square" alt="redowansky.bond"/>
</p>

---

## ✨ Features

- 🎬 **Netflix-style UI** — hero banner, poster rows, search, detail modals, movie/TV filter
- 🖼️ **TMDB auto-match** — posters and metadata pulled automatically for every title
- 🔗 **External movie links** — paste Google Drive / Dropbox / Pixeldrain URLs; auto-converted to streamable sources
- 🎞️ **Multi-version movies** — e.g. Hindi 🇮🇳 / English 🇬🇧 audio tracks with an in-player switcher
- 🔐 **Password-gated admin** (`/admin`) — uploads with progress bars, file manager, shelves, settings
- 📡 **Range-request video** — seeking works on big files; Drive links play via preview embed

## 🚀 Deploy

```bash
python3 deploy_worker.py   # needs CLOUDFLARE_API_TOKEN in env
```

Worker `sia-lab` + Durable Object `TUNNEL_DO` + KV namespace — all on Cloudflare's free tier. No server needed.

## ⚠️ Critical — read before touching

> [!CAUTION]
> The Durable Object name is **frozen at `main-v35`** (see the comment in `worker.js`). **Never rename it.** Every unique DO name creates a fresh, empty database — renaming wipes all stored settings on every deploy. This was the root cause of the infamous *"everything resets on update"* saga.

> [!NOTE]
> Admin password + TMDB key live as Cloudflare Worker secrets (`ADMIN_PW`, `TMDB_KEY`) — never in this repo. External movies live in KV, so they survive deploys.
>
> Admin uploads are capped by Cloudflare's hard **100 MB** free-tier limit — big files go through external links instead.
