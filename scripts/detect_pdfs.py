#!/usr/bin/env python3
"""Detect new PDF resources published on configured domains.

The script searches each configured domain for PDFs (default provider: Exa),
diffs the results against a manifest, and records any newly discovered files as
well as files whose content changed on a stable URL (detected via HTTP
ETag/Last-Modified/Content-Length validators, or an optional content hash). It
then regenerates a human-readable index (RESOURCES.md) whose links point
directly at the official source CDN -- nothing binary is stored.

Titles for hash-named PDFs (where the search engine gives no real title) are
resolved from the PDF itself using the `pdftitle` library (largest-font text on
page 1), with pypdf metadata and a URL-stem fallback.

In CI the manifest lives as an asset on a rolling GitHub Release (downloaded
before the run, re-uploaded after), so the git repo stays code-only. Downloading
the PDFs locally is opt-in via config "download.enabled".

Run locally:

    EXA_API_KEY=... python scripts/detect_pdfs.py

Environment variables:
    EXA_API_KEY        API key for the Exa search provider.
    GOOGLE_API_KEY     API key for the Google Programmable Search provider.
    GOOGLE_CSE_ID      Programmable Search Engine id (cx) for that provider.
    SEARCH_PROVIDER    Overrides config "providers" (comma-separated list).
    CONFIG_PATH        Path to the JSON config (default: config.json).
    MANIFEST_PATH      Overrides config "manifest_path".
    INDEX_PATH         Overrides config "index_path".
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Iterable

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "pdf-watcher/1.0 (+https://github.com/pjarvis2502/agent)"
EXA_SEARCH_URL = "https://api.exa.ai/search"
GOOGLE_CSE_URL = "https://www.googleapis.com/customsearch/v1"


def log(message: str) -> None:
    print(message, flush=True)


def load_config() -> dict:
    config_path = REPO_ROOT / os.environ.get("CONFIG_PATH", "config.json")
    with open(config_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else {}


def save_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True, ensure_ascii=False)
        handle.write("\n")


def normalize_url(url: str) -> str:
    """Canonical link for a PDF: drop query/fragment (tracking params like
    ?hsLang=en) so the same asset maps to a single manifest key."""
    parsed = urllib.parse.urlsplit(url.strip())
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, "", "")
    )


def dedup_key(url: str) -> tuple[str, str]:
    """Stricter identity that also collapses percent-encoding differences
    (e.g. %2C vs a literal comma) so encoding variants are not double-counted."""
    parsed = urllib.parse.urlsplit(url)
    return parsed.netloc.lower(), urllib.parse.unquote(parsed.path).lower()


def is_pdf_url(url: str) -> bool:
    path = urllib.parse.urlsplit(url).path.lower()
    return path.endswith(".pdf")


def slugify(value: str, max_length: int = 80) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-_")
    return value[:max_length] or "document"


def filename_for(url: str, title: str | None) -> str:
    """Build a human-friendly, collision-resistant filename for a PDF URL."""
    path = urllib.parse.urlsplit(url).path
    base = os.path.basename(path)
    stem, ext = os.path.splitext(base)
    if ext.lower() != ".pdf":
        ext = ".pdf"
    # Anthropic's CDN serves many PDFs as a bare hex hash with no descriptive
    # name; prefer the search-result title in that case so files are readable.
    looks_like_hash = bool(re.fullmatch(r"[0-9a-fA-F]{16,}", stem))
    if (not stem or looks_like_hash) and title:
        stem = slugify(title)
    else:
        stem = slugify(stem)
    url_hash = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]
    return f"{stem}-{url_hash}{ext}"


# --------------------------------------------------------------------------- #
# Search providers
# --------------------------------------------------------------------------- #
def search_exa(domain: str, queries: Iterable[str], config: dict) -> dict[str, str]:
    """Return {url: title} for a domain across queries and Exa search types.

    Exa caps results per request (~10 on keyword search), so coverage comes
    from unioning several queries and both search types.
    """
    api_key = os.environ.get("EXA_API_KEY")
    if not api_key:
        raise SystemExit(
            "EXA_API_KEY is not set. Add it as a repo secret (Settings > "
            "Secrets and variables > Actions) or export it locally."
        )
    exa_cfg = config.get("exa", {})
    passes = exa_cfg.get("passes")
    if not passes:
        # Backward-compatible fallback to the older types/type + num_results form.
        types = exa_cfg.get("types") or [exa_cfg.get("type", "neural")]
        num_results = exa_cfg.get("num_results", 25)
        passes = [{"type": t, "num_results": num_results} for t in types]
    session = requests.Session()
    session.headers.update({"x-api-key": api_key, "Content-Type": "application/json"})
    found: dict[str, str] = {}
    for spec in passes:
        for query in queries:
            payload = {
                "query": query,
                "type": spec.get("type", "neural"),
                "includeDomains": [domain],
                "numResults": spec.get("num_results", 25),
            }
            # `category: "pdf"` lifts Exa's ~10-result cap on neural search,
            # so a single neural+pdf pass returns far more PDFs per query.
            if spec.get("category"):
                payload["category"] = spec["category"]
            resp = session.post(EXA_SEARCH_URL, json=payload, timeout=90)
            resp.raise_for_status()
            for result in resp.json().get("results", []):
                url = result.get("url")
                if not url:
                    continue
                found.setdefault(url, result.get("title") or "")
    return found


def search_google_cse(domain: str, queries: Iterable[str], config: dict) -> dict[str, str]:
    """Faithful `site:<domain> filetype:pdf` Google dork via Programmable Search.

    Paginates up to 100 results (10 per page). Requires GOOGLE_API_KEY and
    GOOGLE_CSE_ID. The `queries` are ignored beyond `filetype:pdf` because the
    site+filetype operators already enumerate the domain's PDFs.
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    cse_id = os.environ.get("GOOGLE_CSE_ID")
    if not api_key or not cse_id:
        raise SystemExit(
            "GOOGLE_API_KEY and GOOGLE_CSE_ID must both be set for the "
            "google_cse provider."
        )
    max_results = config.get("google_cse", {}).get("max_results", 100)
    session = requests.Session()
    found: dict[str, str] = {}
    start = 1
    while start <= min(max_results, 100):
        params = {
            "key": api_key,
            "cx": cse_id,
            "q": "filetype:pdf",
            "siteSearch": domain,
            "siteSearchFilter": "i",
            "num": 10,
            "start": start,
        }
        resp = session.get(GOOGLE_CSE_URL, params=params, timeout=60)
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if not items:
            break
        for item in items:
            url = item.get("link")
            if url:
                found.setdefault(url, item.get("title") or "")
        start += 10
    return found


PROVIDERS = {"exa": search_exa, "google_cse": search_google_cse}


def configured_providers(config: dict) -> list[str]:
    override = os.environ.get("SEARCH_PROVIDER")
    if override:
        names = [p.strip().lower() for p in override.split(",") if p.strip()]
    else:
        names = config.get("providers") or [config.get("provider", "exa")]
    return [n.lower() for n in names]


def discover_pdfs(domain: str, queries, config: dict) -> dict[str, str]:
    """Union PDF candidates across every configured provider."""
    found: dict[str, str] = {}
    seen: set[tuple[str, str]] = set()
    for name in configured_providers(config):
        search_fn = PROVIDERS.get(name)
        if search_fn is None:
            raise SystemExit(f"Unknown search provider: {name!r}")
        raw = search_fn(domain, queries, config)
        for url, title in raw.items():
            if not is_pdf_url(url):
                continue
            clean = normalize_url(url)
            key = dedup_key(clean)
            if key in seen:
                continue
            seen.add(key)
            found[clean] = title
    return found


# --------------------------------------------------------------------------- #
# Link verification + change detection
# --------------------------------------------------------------------------- #
VALIDATOR_FIELDS = ("etag", "last_modified", "content_length")


def fetch_pdf_bytes(url: str, timeout: int, max_bytes: int) -> bytes | None:
    """Fetch a PDF into memory (never written to disk), capped at max_bytes.

    Returns the raw bytes, or None if the response is HTML, too large, or the
    request fails. Used for both title resolution and content hashing.
    """
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"}
    try:
        with requests.get(url, headers=headers, stream=True, timeout=timeout) as resp:
            resp.raise_for_status()
            if "html" in resp.headers.get("Content-Type", "").lower():
                return None
            length = resp.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > max_bytes:
                return None
            buf = io.BytesIO()
            for chunk in resp.iter_content(chunk_size=65536):
                buf.write(chunk)
                if buf.tell() > max_bytes:
                    return None
            return buf.getvalue()
    except requests.RequestException:
        return None


def probe_url(url: str, timeout: int, max_bytes: int, want_hash: bool) -> dict | None:
    """Confirm the URL serves a real (non-HTML) PDF and capture HTTP validators.

    Returns a dict with etag/last_modified/content_length (and content_sha256
    when want_hash is set), or None if the URL is dead/garbled/HTML. These
    validators let us detect when a stable URL serves *updated* content.
    """
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"}
    try:
        resp = requests.head(url, headers=headers, allow_redirects=True, timeout=timeout)
        if resp.status_code >= 400:
            # Some CDNs reject HEAD; confirm with a 1-byte ranged GET.
            resp = requests.get(
                url,
                headers={**headers, "Range": "bytes=0-0"},
                stream=True,
                timeout=timeout,
            )
            resp.close()
        if resp.status_code >= 400:
            return None
        if "html" in resp.headers.get("Content-Type", "").lower():
            return None
        meta = {
            "etag": (resp.headers.get("ETag") or "").strip().strip('"'),
            "last_modified": (resp.headers.get("Last-Modified") or "").strip(),
            "content_length": (resp.headers.get("Content-Length") or "").strip(),
        }
    except requests.RequestException:
        return None
    if want_hash:
        data = fetch_pdf_bytes(url, timeout, max_bytes)
        if data is not None:
            meta["content_sha256"] = hashlib.sha256(data).hexdigest()
    return meta


def probe_all(urls: list[str], timeout: int, workers: int,
              max_bytes: int, want_hash: bool) -> dict[str, dict]:
    """Concurrently probe every URL; return {url: validators} for live PDFs."""
    if not urls:
        return {}
    live: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(probe_url, u, timeout, max_bytes, want_hash): u for u in urls
        }
        for future in concurrent.futures.as_completed(futures):
            meta = future.result()
            if meta is not None:
                live[futures[future]] = meta
    return live


def validators_changed(old: dict, meta: dict) -> bool:
    """True if a previously-seen URL now serves different content.

    Prefers a content hash when both sides have one (strongest signal); else
    compares HTTP validators (ETag / Last-Modified / Content-Length). Missing
    fields are ignored so we never raise a false 'updated' on the first run
    that backfills these values.
    """
    old_sha = old.get("content_sha256")
    new_sha = meta.get("content_sha256")
    if old_sha and new_sha:
        return old_sha != new_sha
    for field in VALIDATOR_FIELDS:
        prev = (old.get(field) or "").strip()
        curr = (meta.get(field) or "").strip()
        if prev and curr and prev != curr:
            return True
    return False


# --------------------------------------------------------------------------- #
# Title resolution
# --------------------------------------------------------------------------- #
def title_is_weak(title: str, url: str) -> bool:
    """True when the search-result title is missing or just a hash/filename,
    so it's worth reading the real title from the PDF itself. Judges the raw
    title (not clean_title's fabricated placeholder)."""
    text = (title or "").strip()
    text = re.sub(r"^\[PDF\]\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\.(pdf|docx?|pptx?)$", "", text, flags=re.IGNORECASE).strip()
    if not text:
        return True
    # Search engines truncate long titles with an ellipsis; resolve the full
    # title from the PDF instead of storing the cut-off version.
    if text.endswith("...") or text.endswith("\u2026"):
        return True
    # A bare hash (the title is just the file's hex stem) is weak.
    if re.fullmatch(r"[0-9a-fA-F]{16,}", text.replace(" ", "")):
        return True
    # Search engines sometimes dump extracted body text into the title field;
    # anything this long is not a real title.
    if len(text) > 180:
        return True
    # A bare generic section heading ("Acknowledgements", "Abstract") is not a
    # real title -> worth resolving from the PDF / URL stem instead.
    if text.lower().strip(":") in GENERIC_HEADINGS:
        return True
    # No real word (e.g. "3", numeric ids) -> weak.
    return not re.search(r"[A-Za-z]{3,}", text)


GENERIC_HEADINGS = {
    "acknowledgements",
    "acknowledgments",
    "abstract",
    "contents",
    "table of contents",
    "introduction",
    "executive summary",
    "appendix",
    "references",
    "authors",
    "author",
    "description",
    "overview",
    "methods",
    "methodology",
    "published",
    "draft",
    "date",
}


def _looks_like_namelist(text: str) -> bool:
    """Detect an author byline like 'Jared Kaplan, Holden Karnofsky, ...' so it
    isn't mistaken for the document title (we'd rather use the URL stem)."""
    if "," not in text:
        return False
    words = re.findall(r"[A-Za-z]+", text)
    if len(words) < 2:
        return False
    caps = sum(1 for w in words if w[:1].isupper())
    return caps / len(words) >= 0.7


def _looks_garbled(text: str) -> bool:
    """Detect letter-spaced extraction artifacts like 'D e s cri ption' or
    'int erac tions with' where words are broken into short fragments."""
    tokens = re.findall(r"[A-Za-z]+", text)
    if len(tokens) < 2:
        return False
    singles = sum(1 for t in tokens if len(t) == 1)
    if singles / len(tokens) > 0.4:
        return True
    # A run of 3+ consecutive very short tokens is the signature of words
    # broken into fragments ("effe c ti v e"), which normal titles don't have.
    run = longest = 0
    for token in tokens:
        run = run + 1 if len(token) <= 2 else 0
        longest = max(longest, run)
    return longest >= 3


_MONTHS = (
    r"january|february|march|april|may|june|july|august|september|october|"
    r"november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
)


def _looks_like_date(text: str) -> bool:
    """Detect a bare date label like 'January 21, 2026' or '2026-01-21' that a
    cover page renders in large type but which is never the real title."""
    if len(text.split()) > 4:
        return False
    if re.search(rf"\b({_MONTHS})\b", text, re.IGNORECASE) and re.search(
        r"\b\d{4}\b", text
    ):
        return True
    # Purely numeric/punctuation date forms (2026-01-21, 01/21/2026, ...).
    return bool(re.fullmatch(r"[\d]{1,4}[\d\s./,-]*\d", text))


def _valid_title(text: str | None) -> str | None:
    """Return a cleaned title if `text` looks like a real document title, else
    None. Rejects empty/word-less strings, dumped body text (too long), generic
    section headings, author bylines, date labels, and garbled letter-spaced
    extractions."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text or len(text) > 180:
        return None
    if not re.search(r"[A-Za-z]{3,}", text):
        return None
    if text.lower().strip(":") in GENERIC_HEADINGS:
        return None
    if _looks_like_date(text):
        return None
    if _looks_like_namelist(text):
        return None
    if _looks_garbled(text):
        return None
    return text[:200]


def _title_via_pdftitle(data: bytes) -> str | None:
    """Pick the title by largest-font text on page 1 (pdftitle library)."""
    try:
        import pdftitle
        from pdftitle import GetTitleParameters
    except ImportError:
        return None
    try:
        title = pdftitle.get_title_from_io(
            io.BytesIO(data), GetTitleParameters(algorithm="original")
        )
    except Exception:  # noqa: BLE001 - best-effort
        return None
    return _valid_title(title)


def _title_via_pypdf(data: bytes) -> str | None:
    """Fall back to the embedded /Title document metadata."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    try:
        reader = PdfReader(io.BytesIO(data))
        meta_title = (reader.metadata.title or "").strip() if reader.metadata else ""
        return _valid_title(meta_title)
    except Exception:  # noqa: BLE001 - best-effort
        return None


def resolve_pdf_title(data: bytes) -> str | None:
    """Resolve a real title from already-fetched PDF bytes (never stored).

    Primary: `pdftitle` (largest-font text on page 1) -- more reliable than the
    embedded metadata, which for many CDN PDFs is a section heading. Falls back
    to the pypdf /Title metadata. When neither yields a real title (e.g. the
    PDF's biggest text is a date or a section heading), the caller uses the URL
    stem instead."""
    return _title_via_pdftitle(data) or _title_via_pypdf(data)


# --------------------------------------------------------------------------- #
# Download
# --------------------------------------------------------------------------- #
def download_pdf(url: str, dest: Path, max_bytes: int, timeout: int) -> tuple[int, str]:
    """Download a PDF to dest, returning (size_bytes, sha256)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    size = 0
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"}
    with requests.get(url, headers=headers, stream=True, timeout=timeout) as resp:
        resp.raise_for_status()
        ctype = resp.headers.get("Content-Type", "").lower()
        if "html" in ctype:
            raise ValueError(f"expected a PDF but got Content-Type {ctype!r}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as handle:
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                size += len(chunk)
                if size > max_bytes:
                    handle.close()
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f"file exceeds max_bytes ({max_bytes})")
                sha.update(chunk)
                handle.write(chunk)
        tmp.replace(dest)
    return size, sha.hexdigest()


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def clean_title(title: str, url: str) -> str:
    """Tidy a search-result title for display in the index table."""
    text = (title or "").strip()
    text = re.sub(r"^\[PDF\]\s*", "", text, flags=re.IGNORECASE)
    # Drop trailing site suffixes like "| OpenAI" or "- Anthropic".
    text = re.sub(r"\s*[|\u2013\u2014-]\s*(OpenAI|Anthropic)\s*$", "", text,
                  flags=re.IGNORECASE)
    text = text.replace("\u00b7", "'")  # middot used in place of an apostrophe
    text = re.sub(r"\.(pdf|docx?|pptx?)$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    if not text or re.fullmatch(r"[0-9a-fA-F]{16,}", text.replace(" ", "")):
        stem = os.path.splitext(os.path.basename(urllib.parse.urlsplit(url).path))[0]
        if re.fullmatch(r"[0-9a-fA-F]{16,}", stem):
            text = f"Untitled PDF ({stem[:8]})"
        else:
            text = stem.replace("-", " ").replace("_", " ").strip() or "Untitled PDF"
    return text


def write_index(manifest: dict, index_path: Path) -> None:
    """Render RESOURCES.md: one table per source of click-to-download links."""
    by_source: dict[str, list[dict]] = {}
    for entry in manifest.values():
        by_source.setdefault(entry.get("source", entry.get("domain", "other")), []).append(entry)

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# AI documentation resources",
        "",
        "Click a title to download the PDF directly from the official source "
        "(openai.com / anthropic.com). Nothing is stored in this repo.",
        "",
        f"_Last updated: {now} \u00b7 {len(manifest)} PDFs across "
        f"{len(by_source)} source(s)._",
        "",
    ]
    for source in sorted(by_source):
        entries = by_source[source]
        domain = entries[0].get("domain", "")
        lines.append(f"## {source} \u2014 {domain} ({len(entries)})")
        lines.append("")
        lines.append("| # | Title | Download |")
        lines.append("|--:|-------|----------|")
        ordered = sorted(entries, key=lambda e: clean_title(e.get("title", ""), e["url"]).lower())
        for i, entry in enumerate(ordered, start=1):
            title = clean_title(entry.get("title", ""), entry["url"]).replace("|", "\\|")
            lines.append(f"| {i} | {title} | [Download]({entry['url']}) |")
        lines.append("")
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text("\n".join(lines), encoding="utf-8")
    log(f"Wrote index {index_path} ({len(manifest)} entries)")


def _group_by_source(entries: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for entry in entries:
        grouped.setdefault(entry.get("source", entry.get("domain", "other")), []).append(entry)
    return grouped


def _changelog_section(heading: str, entries: list[dict]) -> list[str]:
    lines = [heading, ""]
    for source, items in sorted(_group_by_source(entries).items()):
        lines.append(f"#### {source} ({len(items)})")
        for entry in sorted(items, key=lambda e: clean_title(e.get("title", ""), e["url"]).lower()):
            title = clean_title(entry.get("title", ""), entry["url"])
            lines.append(f"- [{title}]({entry['url']})")
        lines.append("")
    return lines


def write_release_notes(new_entries: list[dict], updated_entries: list[dict],
                        total: int, notes_path: Path) -> None:
    """Changelog body for a release: the PDFs new *and* updated since the last
    release (the delta between the previous release and this one)."""
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"### {len(new_entries)} new \u00b7 {len(updated_entries)} updated "
        "since the previous release",
        "",
        f"_Detected {now} \u00b7 {total} total tracked. "
        "Each link downloads directly from the official source._",
        "",
    ]
    if new_entries:
        lines += _changelog_section("### New", new_entries)
    if updated_entries:
        lines += _changelog_section("### Updated (same URL, changed content)", updated_entries)
    lines.append("See the attached `RESOURCES.md` for the full clickable index.")
    notes_path.parent.mkdir(parents=True, exist_ok=True)
    notes_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"Wrote release notes {notes_path} "
        f"({len(new_entries)} new, {len(updated_entries)} updated)")


def write_summary(new_entries: list[dict], updated_entries: list[dict]) -> None:
    lines = []
    if new_entries or updated_entries:
        lines.append(
            f"## {len(new_entries)} new \u00b7 {len(updated_entries)} updated PDF(s)\n"
        )
        for label, entries in (("new", new_entries), ("updated", updated_entries)):
            for entry in entries:
                title = clean_title(entry.get("title", ""), entry["url"])
                lines.append(f"- _{label}_ **{entry['source']}** — [{title}]({entry['url']})")
    else:
        lines.append("## No new or updated PDFs detected")
    text = "\n".join(lines) + "\n"
    log(text)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(text)
    out_path = os.environ.get("GITHUB_OUTPUT")
    if out_path:
        with open(out_path, "a", encoding="utf-8") as handle:
            handle.write(f"new_count={len(new_entries)}\n")
            handle.write(f"updated_count={len(updated_entries)}\n")
            handle.write(f"change_count={len(new_entries) + len(updated_entries)}\n")


def resolve_path(env_name: str, value: str) -> Path:
    raw = os.environ.get(env_name) or value
    path = Path(raw)
    return path if path.is_absolute() else REPO_ROOT / path


def main() -> int:
    config = load_config()
    manifest_path = resolve_path("MANIFEST_PATH", config.get("manifest_path", "manifest.json"))
    index_path = resolve_path("INDEX_PATH", config.get("index_path", "RESOURCES.md"))
    notes_path = resolve_path("NOTES_PATH", config.get("notes_path", "release_notes.md"))
    manifest = load_manifest(manifest_path)
    download_cfg = config.get("download", {})
    download_enabled = download_cfg.get("enabled", False)
    download_dir = REPO_ROOT / download_cfg.get("dir", "downloads")
    max_bytes = download_cfg.get("max_bytes", 100 * 1024 * 1024)
    timeout = download_cfg.get("timeout_seconds", 60)
    # Cap downloads per run (0 = unlimited) so the very first run doesn't commit
    # one massive blob; remaining new PDFs are picked up on subsequent runs.
    max_new = download_cfg.get("max_new_per_run", 0)
    queries = config.get("queries", ["PDF"])

    verify_links = config.get("verify_links", True)
    resolve_titles = config.get("resolve_titles", True)
    net_timeout = config.get("verify_timeout_seconds", 20)
    workers = config.get("verify_workers", 16)
    title_max_bytes = config.get("title_max_bytes", 25 * 1024 * 1024)
    # Hash every PDF's bytes each run for the strongest change signal (heavier:
    # downloads all files). Off by default -> rely on ETag/Last-Modified/size.
    hash_all = config.get("hash_all", False)

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    new_entries: list[dict] = []
    updated_entries: list[dict] = []

    def resolve_title(url: str, raw_title: str, data: bytes | None) -> tuple[str, bytes | None]:
        """Return (title, fetched_bytes). Resolves weak titles from the PDF."""
        if not (resolve_titles and title_is_weak(raw_title, url)):
            return raw_title, data
        if data is None:
            data = fetch_pdf_bytes(url, net_timeout, title_max_bytes)
        better = resolve_pdf_title(data) if data else None
        if better:
            log(f"  resolved title for {url} -> {better!r}")
            return better, data
        # No usable title in the PDF; blank it so clean_title falls back to the
        # readable URL stem instead of dumped body text.
        return "", data

    for source in config.get("sources", []):
        name = source["name"]
        domain = source["domain"]
        log(f"Searching {domain} ...")
        candidates = discover_pdfs(domain, queries, config)
        log(f"  {len(candidates)} PDF candidate(s) found on {domain}")

        # Probe every candidate (new + known) so we can both drop dead links and
        # capture HTTP validators for change detection on stable URLs.
        if verify_links:
            metas = probe_all(sorted(candidates), net_timeout, workers,
                              title_max_bytes, hash_all)
            dropped = len(candidates) - len(metas)
            if dropped:
                log(f"  dropped {dropped} unreachable/garbled link(s)")
        else:
            metas = {u: {} for u in candidates}

        for url in sorted(candidates):
            meta = metas.get(url)
            if meta is None:
                continue  # unreachable / not a real PDF
            existing = manifest.get(url)
            is_new = existing is None
            is_updated = bool(existing) and validators_changed(existing, meta)

            if not is_new and not is_updated:
                # Unchanged: refresh stored validators (backfills them the first
                # run after this feature ships) and keep the entry as-is.
                existing.update({k: meta[k] for k in meta})
                continue

            if max_new and is_new and len(new_entries) >= max_new:
                log(f"  reached max_new_per_run ({max_new}); deferring the rest")
                break

            raw_title = candidates[url]
            # For an update, re-resolve from the new content; keep a good old
            # title if discovery only gives a weak one and resolution fails.
            data = None
            title, data = resolve_title(url, raw_title, data)
            if is_updated and not title:
                title = existing.get("title", "")

            entry = {
                "url": url,
                "source": name,
                "domain": domain,
                "title": title,
                "first_seen": existing.get("first_seen", now) if existing else now,
                "last_seen": now,
            }
            for field in VALIDATOR_FIELDS:
                if meta.get(field):
                    entry[field] = meta[field]
            # Persist a content hash when we have one (from hash_all probing or
            # the bytes already fetched for title resolution).
            sha = meta.get("content_sha256")
            if not sha and data is not None:
                sha = hashlib.sha256(data).hexdigest()
            if sha:
                entry["content_sha256"] = sha
            if is_updated:
                entry["updated_at"] = now

            if download_enabled:
                filename = filename_for(url, title)
                dest = download_dir / name / filename
                try:
                    size, file_sha = download_pdf(url, dest, max_bytes, timeout)
                except Exception as exc:  # noqa: BLE001 - report and keep going
                    log(f"  ! failed to download {url}: {exc}")
                    continue
                entry.update(
                    {
                        "filename": filename,
                        "path": str(dest.relative_to(REPO_ROOT)),
                        "size_bytes": size,
                        "content_sha256": file_sha,
                    }
                )
                log(f"  + downloaded {entry['path']} ({size} bytes)")

            manifest[url] = entry
            if is_new:
                new_entries.append(entry)
            else:
                log(f"  ~ updated content for {url}")
                updated_entries.append(entry)

    save_manifest(manifest_path, manifest)
    write_index(manifest, index_path)
    write_release_notes(new_entries, updated_entries, len(manifest), notes_path)
    write_summary(new_entries, updated_entries)
    return 0


if __name__ == "__main__":
    sys.exit(main())
