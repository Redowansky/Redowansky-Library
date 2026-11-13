#!/usr/bin/env python3
"""Remove the Movies & Songs admin section (his call, 2026-11-13).

Removes from ADMIN_PAGE + admin script:
  * nav button data-s="movies"
  * the whole s-movies HTML section (upload-to-R2, TMDB key input,
    add-external-link form, ext list, movie list)
  * the nav-handler movies branch
  * the movies-only JS: R2 incoming uploader block, saveTmdbKey,
    loadMovies, autoMatch, markSong, ytCover, toDirectUrl, convLink,
    addVerRow, addExternal, loadExtList, ytInfo, delExternal,
    fmtDur + fmtSpd (uploader-only)
KEPT on purpose:
  * fmt + safeName (used by the Files section: rename, file info)
  * pendEsc (used by renderPend)
  * ALL server routes (/api/admin/external, /api/admin/upload,
    /api/admin/tmdb/*, automatch, setsong, ytinfo, r2/*) — unlinked
    from the UI but intact; the TMDB key stays in DO storage and
    discovery keeps using it. The extpublish flip for the unlisted
    WALL-E test entry still works via its route.
Each anchor is asserted to occur exactly once.
"""
import sys

P = "/home/hatch/workspace/sia-lab/worker.js"
src = open(P, encoding="utf-8").read()

def rep(old, new, count=1):
    global src
    n = src.count(old)
    assert n == count, f"anchor count {n} (want {count}): {old[:90]!r}"
    src = src.replace(old, new)

def cut(start_marker, end_marker, keep_end=False):
    global src
    si = src.find(start_marker)
    assert si >= 0, f"start marker not found: {start_marker[:60]!r}"
    assert src.count(start_marker) == 1, f"start marker x{src.count(start_marker)}: {start_marker[:60]!r}"
    ei = src.find(end_marker, si)
    assert ei >= 0, f"end marker not found: {end_marker[:60]!r}"
    end = ei if keep_end else ei + len(end_marker)
    src = src[:si] + src[end:]

# 1. nav button
rep('<button data-s="movies">🎬 <span>Movies</span></button>\n', '')

# 2. s-movies HTML section (from its header comments to its closing div)
cut('<!-- UPLOAD -->\n<!-- MOVIES (TMDB matching) -->\n<div class="sec" id="s-movies">',
    '<div id="movieList"></div>\n</div>\n')

# 3. nav-handler movies branch
rep('if(b.dataset.s==="movies"){loadMovies();loadIncoming();r2ResumeHint();}', '')

# 4. uploader-only helpers (fmt + safeName stay — Files section uses them)
rep('function fmtDur(s){if(!isFinite(s)||s<0)return "—";s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return (h>0?h+":"+("0"+m).slice(-2):m)+":"+("0"+ss).slice(-2);}\n', '')
rep('function fmtSpd(b){if(!isFinite(b)||b<=0)return "—";if(b>=1048576)return (b/1048576).toFixed(1)+" MB/s";if(b>=1024)return Math.round(b/1024)+" KB/s";return Math.round(b)+" B/s";}\n', '')

# 5. R2 incoming uploader JS block (up to, not including, the nav handler)
cut('// ---- R2 incoming uploader ----\n', '// nav\n', keep_end=True)

# 6. saveTmdbKey .. delExternal (up to, not including, the Approval queue JS)
cut('async function saveTmdbKey(){', '// ---- Approval queue ----\n', keep_end=True)

open(P, "w", encoding="utf-8").write(src)
print("removal applied OK, new size:", len(src))
