"""Fetch eepro.com results pages with a simple on-disk cache.

Result pages are effectively immutable once an event is over, so past-year
pages get a long TTL; current-year pages a short one (events post results
incrementally over a weekend).
"""

import re
import time
from datetime import date
from pathlib import Path

import httpx

BASE_URL = "https://eepro.com/results"
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"

SHORT_TTL = 60 * 30  # 30 min, current-year pages
LONG_TTL = 60 * 60 * 24 * 30  # 30 days, past-year pages


class FetchError(Exception):
    pass


def _cache_path(url_path: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", url_path.strip("/"))
    return CACHE_DIR / f"{safe}.html"


def fetch(url_path: str, year: int) -> str:
    """Fetch a path relative to BASE_URL, e.g. "2026/" or "asdc2026/jjfinals.html"."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = _cache_path(url_path)
    ttl = SHORT_TTL if year >= date.today().year else LONG_TTL
    if cached.exists() and (time.time() - cached.stat().st_mtime) < ttl:
        return cached.read_text(encoding="utf-8", errors="replace")

    url = f"{BASE_URL}/{url_path}"
    try:
        resp = httpx.get(url, timeout=20, follow_redirects=True)
    except httpx.HTTPError as e:
        if cached.exists():  # stale cache beats a network error
            return cached.read_text(encoding="utf-8", errors="replace")
        raise FetchError(f"Could not reach {url}: {e}") from e
    if resp.status_code != 200:
        raise FetchError(f"{url} returned HTTP {resp.status_code}")
    cached.write_text(resp.text, encoding="utf-8")
    return resp.text
