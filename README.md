# agent — PDF resource watcher

A scheduled GitHub Action that detects **new PDF resources** published on
`anthropic.com` and `openai.com` (the equivalent of the Google dorks
`site:anthropic.com filetype:pdf` / `site:openai.com filetype:pdf`) and
publishes them as a clickable index you can feed into ChatGPT or NotebookLM.

**No PDFs are stored in git.** Each link in the index points directly at the
official `cdn.openai.com` / `www-cdn.anthropic.com` source, so clicking
downloads straight from OpenAI/Anthropic. The repo stays code-only.

## How it works

```
.github/workflows/detect-pdfs.yml  (cron: daily 23:00 UTC)
   │
   1. gh release download manifest.json   ← previous state, from the LATEST release
   2. python scripts/detect_pdfs.py
        • search each domain for PDFs via the Exa API (includeDomains)
        • keep only *.pdf URLs (incl. CDN hosts), dedupe
        • probe every URL: drop dead links AND capture HTTP validators
          (ETag / Last-Modified / Content-Length)
        • resolve real titles for hash-named PDFs from the PDF itself (pdftitle)
        • diff against manifest.json  →  NEW PDFs + UPDATED PDFs
          (same URL whose content validators changed)
        • write manifest.json (cumulative state), RESOURCES.md (full table),
          release_notes.md (changelog: only what's new/updated this run)
   3. if change_count > 0:  gh release create resources-YYYY.MM.DD-HHMMSS
        --notes = release_notes.md (the changelog)
        --assets = manifest.json + RESOURCES.md
      (if nothing new/updated → no release that day, no empty tags)
```

So **previous release vs. current release = exactly the new/updated resources**,
shown in the changelog. `manifest.json` (an asset on the latest release) is the
sync/state file that makes "new/changed since last time" reliable across runs.

### Title resolution for hash-named PDFs

Anthropic serves many PDFs as `www-cdn.anthropic.com/<hash>.pdf` with no useful
title. For those (and any weak/empty/ellipsis-truncated title), the script
fetches the PDF **in memory** (never saved, capped at ~25 MB) and resolves the
real title with the [`pdftitle`](https://pypi.org/project/pdftitle/) library,
which picks the **largest-font text on page 1** — more reliable than the
embedded `/Title` metadata, which for many CDN PDFs is just a section heading.
It falls back to the pypdf `/Title` metadata. Section headings, author bylines,
date labels, and garbled letter-spaced extractions are rejected; if nothing
usable is found it falls back to the readable URL stem.

### Detecting updated content on a stable URL

OpenAI/Anthropic sometimes overwrite a PDF in place (the "hard link" stays the
same but the bytes change). URL-only diffing would miss this, so on every run
the link probe records each file's `ETag`, `Last-Modified`, and `Content-Length`
in the manifest. A known URL whose validators differ from the stored values is
flagged **Updated** (CDNs change the ETag whenever the bytes change, so this is
reliable and needs no download). Set `"hash_all": true` to additionally store a
`content_sha256` of every file for byte-exact certainty (heavier — it downloads
all files each run). The changelog then has two sections: **New** and
**Updated**. The first run simply backfills validators (no false "updated").

## Setup

1. **Add the search API key as a repo secret.**
   GitHub repo → *Settings → Secrets and variables → Actions → New repository
   secret*:
   - `EXA_API_KEY` — from https://dashboard.exa.ai/

2. The workflow runs **daily at 23:00 UTC**. Change the `cron:` line in
   `.github/workflows/detect-pdfs.yml` to adjust (see https://crontab.guru/),
   or trigger it any time from the **Actions** tab via *Run workflow*.

That's the whole setup — no other secrets are required for the default path.

## Run locally

```bash
pip install -r requirements.txt
EXA_API_KEY=your_key python scripts/detect_pdfs.py
```

This writes `manifest.json`, `RESOURCES.md`, and `release_notes.md` to the
working directory (all git-ignored). Open `RESOURCES.md` to see the table.

## Configuration (`config.json`)

| Key                       | Meaning                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `providers`               | Search providers to union. `["exa"]` by default; add `"google_cse"`.    |
| `sources`                 | List of `{name, domain}` to watch.                                      |
| `queries`                 | Search phrases run per domain (more phrases = broader coverage).         |
| `exa.passes`              | Exa search passes that are unioned. See below.                          |
| `verify_links`            | Drop URLs that don't resolve to a real PDF, and capture validators (`true`). |
| `resolve_titles`          | Resolve hash/weak titles from the PDF itself via pdftitle (`true`).     |
| `hash_all`                | Also store a `content_sha256` of every file for byte-exact change detection (`false`). |
| `verify_timeout_seconds`  | Per-request network timeout for link/title checks.                      |
| `verify_workers`          | Concurrency for the link probe.                                         |
| `title_max_bytes`         | Max bytes fetched in-memory for title resolution (~25 MB).              |
| `download.enabled`        | Download PDFs locally (`false`). Off by default — links are direct.     |
| `manifest_path`           | State file (default `manifest.json`).                                    |
| `index_path`              | Clickable table (default `RESOURCES.md`).                               |
| `notes_path`              | Release changelog body (default `release_notes.md`).                     |

### Exa coverage (`exa.passes`)

Exa keyword search caps at ~10 results per query, but **`type: "neural"` +
`category: "pdf"`** lifts that cap. The default unions two passes per query for
maximum coverage:

```json
"exa": {
  "passes": [
    { "type": "neural",  "category": "pdf", "num_results": 100 },
    { "type": "keyword",                    "num_results": 25  }
  ]
}
```

Add another company by appending to `sources`, e.g.
`{ "name": "deepmind", "domain": "deepmind.google" }`.

### Optional: the literal Google dork (`google_cse`)

To run the faithful `site:<domain> filetype:pdf` dork (paginates all results up
to 100, ignores keywords), add `"google_cse"` to `providers` and set two
secrets: `GOOGLE_API_KEY` and `GOOGLE_CSE_ID` (a Programmable Search Engine id).
Results are unioned with Exa.

## Feeding the PDFs into ChatGPT / NotebookLM

- **NotebookLM** has *no public upload API* — open `RESOURCES.md`, click the
  PDFs you want, and add them as sources manually.
- **ChatGPT (consumer)** has no import API either. The official, automatable
  path is the **OpenAI API**: `scripts/upload_to_openai.py` uploads PDFs into a
  vector store you can attach to an Assistant / Responses `file_search` tool.
  This requires the files on disk, so set `download.enabled: true` and run:

  ```bash
  OPENAI_API_KEY=... python scripts/upload_to_openai.py
  ```

## Notes

- The git repo contains **code only** — no manifest, no binaries. State and the
  index live as assets on the GitHub Releases.
- Manifest keys are normalized URLs (query/fragment stripped, encoding
  collapsed), so re-runs won't re-report files already seen.
