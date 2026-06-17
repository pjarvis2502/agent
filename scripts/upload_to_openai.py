#!/usr/bin/env python3
"""Optional: upload downloaded PDFs into an OpenAI vector store.

This lets you query the documents with the OpenAI API (Assistants / Responses
"file_search" tool) — the closest official, automatable equivalent to "import
into ChatGPT". NotebookLM has no public upload API, so for NotebookLM you still
upload the `downloads/` folder manually.

Only PDFs recorded in the manifest are considered. Files already uploaded (by
sha256) are skipped, so this is safe to run after every detection run.

Environment variables:
    OPENAI_API_KEY            Required.
    OPENAI_VECTOR_STORE_ID    Existing vector store id. If unset, a new store
                              named OPENAI_VECTOR_STORE_NAME is created and its
                              id is printed.
    OPENAI_VECTOR_STORE_NAME  Name for a new store (default: "official-ai-docs").
    UPLOAD_STATE_PATH         Tracks uploaded sha256s (default: openai_uploads.json).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
API_BASE = "https://api.openai.com/v1"


def _headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def load_json(path: Path, default):
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


def ensure_vector_store(api_key: str) -> str:
    store_id = os.environ.get("OPENAI_VECTOR_STORE_ID")
    if store_id:
        return store_id
    name = os.environ.get("OPENAI_VECTOR_STORE_NAME", "official-ai-docs")
    resp = requests.post(
        f"{API_BASE}/vector_stores",
        headers={**_headers(api_key), "Content-Type": "application/json"},
        json={"name": name},
        timeout=60,
    )
    resp.raise_for_status()
    store_id = resp.json()["id"]
    print(f"Created vector store {store_id} (name={name!r}).")
    print(f"Set OPENAI_VECTOR_STORE_ID={store_id} to reuse it next time.")
    return store_id


def upload_file(api_key: str, path: Path) -> str:
    with open(path, "rb") as handle:
        resp = requests.post(
            f"{API_BASE}/files",
            headers=_headers(api_key),
            data={"purpose": "assistants"},
            files={"file": (path.name, handle, "application/pdf")},
            timeout=120,
        )
    resp.raise_for_status()
    return resp.json()["id"]


def attach_to_store(api_key: str, store_id: str, file_id: str) -> None:
    resp = requests.post(
        f"{API_BASE}/vector_stores/{store_id}/files",
        headers={**_headers(api_key), "Content-Type": "application/json"},
        json={"file_id": file_id},
        timeout=60,
    )
    resp.raise_for_status()


def _manifest_path() -> Path:
    """Resolve the manifest location from config.json (defaults to repo root)."""
    cfg = load_json(REPO_ROOT / "config.json", {})
    raw = cfg.get("manifest_path", "manifest.json")
    path = Path(raw)
    return path if path.is_absolute() else REPO_ROOT / path


def main() -> int:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set.")

    manifest = load_json(_manifest_path(), {})
    state_path = REPO_ROOT / os.environ.get(
        "UPLOAD_STATE_PATH", "openai_uploads.json"
    )
    uploaded = set(load_json(state_path, []))

    store_id = ensure_vector_store(api_key)
    new_count = 0
    for entry in manifest.values():
        sha256 = entry.get("content_sha256")
        rel_path = entry.get("path")
        if not sha256 or not rel_path or sha256 in uploaded:
            continue
        path = REPO_ROOT / rel_path
        if not path.exists():
            continue
        print(f"Uploading {rel_path} ...")
        file_id = upload_file(api_key, path)
        attach_to_store(api_key, store_id, file_id)
        uploaded.add(sha256)
        new_count += 1

    save_json(state_path, sorted(uploaded))
    print(f"Uploaded {new_count} new file(s) to vector store {store_id}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
