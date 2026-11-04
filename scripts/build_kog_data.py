#!/usr/bin/env python3
"""Build the KoG (King of Gores) map data file used by kog.html.

Scrapes https://kog.tw (a PHP app with no API) and writes:

  <out>/kog_map_data.js  const kog_map_data_last_updated = "4 November 2026";
                         const kog_map_data = {"Map": {"category": .., "stars": .., ...}, ...};

Per map: category, stars (0-5), points, mapper and released (YYYY-MM-DD or null)
from the map list, plus top_time (rank 1), last_time and last_rank (the last row
of the map's "Top 99" table, so last_rank < 99 is the total number of finishers).
The three time fields are null when the map has no finishers.

kog.tw only answers get.php requests that carry the PHPSESSID cookie set by its
front page (otherwise it returns an empty 200), and PHP session locking means a
hung request blocks the session, so every failure starts a fresh session.
Requests are made one at a time with a delay in between. If a map page cannot
be fetched, that map's times are reused from the existing output file.

Stdlib only, Python 3.11+.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import http.client
import http.cookiejar
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_NAME = "kog_map_data.js"

BASE_URL = "https://kog.tw/"
MAP_LIST_URL = BASE_URL + "get.php?p=maps&p=maps"
MAP_URL = BASE_URL + "get.php?p=maps&p=maps&map={}"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
TIMEOUT = 150  # seconds; kog.tw sometimes takes minutes (Cloudflare gives up at ~125 s)
RETRY_DELAYS = (10, 30, 90)  # seconds to wait before each retry

# Sanity limits against the previously published file (see check_sanity)
MIN_MAP_RATIO = 0.98  # maps are rarely removed, so the map count shouldn't drop much
MAX_FAILED_FRACTION = 0.05  # share of map pages that may fail to fetch
MAX_LOST_TIMES_FRACTION = 0.01  # share of maps that may newly lose their times

TIME_FIELDS = ("top_time", "last_time", "last_rank")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def format_date(d: dt.date) -> str:
    return f"{d.day} {d.strftime('%B')} {d.year}"


def parse_date(s: str) -> dt.date:
    return dt.date.fromisoformat(s.strip()[:10])


# ---------------------------------------------------------------- parsing (pure)

class ParseError(ValueError):
    pass


CARD_SPLIT = '<div class="card mb-4 box-shadow">'
CARD_NAME_RE = re.compile(r"<h4[^>]*>(.*?)</h4", re.S)
CARD_ITEM_RE = re.compile(r'<li class="list-group-item">(.*?)</li>', re.S)
CARD_FOOTER_RE = re.compile(r'<div class="card-footer[^"]*">(.*?)</div>', re.S)
RELEASED_RE = re.compile(r"Released at (\d{4}-\d{2}-\d{2})")
POINTS_RE = re.compile(r"^(\d+) points?$")


def _text(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]*>", "", fragment)).strip()


def parse_card(card: str) -> tuple[str, dict]:
    """Parse one map card from the map list (or the header of a map page)."""
    card = re.sub(r"<!--.*?-->", "", card, flags=re.S)
    name_match = CARD_NAME_RE.search(card)
    if not name_match:
        raise ParseError("map card without a name")
    name = _text(name_match.group(1))
    items = CARD_ITEM_RE.findall(card)
    if len(items) < 4:
        raise ParseError(f"map card {name!r} has {len(items)} list items, expected 4")
    stars_html, category, points, mapper = items[:4]
    points_match = POINTS_RE.match(_text(points))
    if not points_match:
        raise ParseError(f"map card {name!r}: unexpected points {points!r}")
    footer = CARD_FOOTER_RE.search(card)
    released = RELEASED_RE.search(footer.group(1)) if footer else None
    if released:
        try:
            released = dt.date.fromisoformat(released.group(1)).isoformat()
        except ValueError:
            released = None
    return name, {
        "category": _text(category),
        "stars": stars_html.count("bi-star-fill"),
        "points": int(points_match.group(1)),
        "mapper": _text(mapper),
        "released": released,
    }


def parse_map_list(page: str) -> dict[str, dict]:
    """Map name -> map info, from get.php?p=maps."""
    maps = {}
    for card in page.split(CARD_SPLIT)[1:]:
        name, info = parse_card(card)
        if name in maps:
            raise ParseError(f"map {name!r} listed twice")
        maps[name] = info
    if not maps:
        raise ParseError("no map cards found in the map list")
    return maps


# The Top 99 is rendered as three side-by-side tables (ranks 1-33, 34-66, 67-99);
# header rows use <th scope="col"> and so don't match ROW_RE.
TOP_HEADING = "Top 99 fastest finishers"
ROW_RE = re.compile(r"<tr>\s*<th>\s*(\d+)\s*</th>\s*<td>\s*([^<]*?)\s*</td>", re.S)


def parse_time(s: str) -> float:
    """'79.7' -> 79.7; also accepts 'M:SS.ss' and 'H:MM:SS.ss' just in case."""
    seconds = 0.0
    for part in s.strip().split(":"):
        seconds = seconds * 60 + float(part)
    return seconds


def parse_map_page(page: str) -> dict:
    """top_time/last_time/last_rank from a map page's Top 99 table (all None if empty)."""
    start = page.find(TOP_HEADING)
    if start < 0:
        raise ParseError("no Top 99 table on the map page")
    if page.count("</table>", start) != page.count("<table", start):
        raise ParseError("map page looks truncated")
    rows = ROW_RE.findall(page, start)
    if not rows:
        return dict.fromkeys(TIME_FIELDS)
    try:
        times = sorted((int(rank), parse_time(t)) for rank, t in rows)
    except ValueError as e:
        raise ParseError(f"bad time in Top 99 table: {e}") from None
    return {
        "top_time": round(times[0][1], 2),
        "last_time": round(times[-1][1], 2),
        "last_rank": times[-1][0],
    }


# ---------------------------------------------------------------- fetching

class FetchError(Exception):
    pass


class Session:
    """A kog.tw PHP session: cookie jar primed by fetching the front page."""

    def __init__(self, timeout: float = TIMEOUT):
        self.timeout = timeout
        self.opener = None

    def reset(self) -> None:
        self.opener = None

    def _open(self, url: str) -> str:
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": BASE_URL,
        })
        with self.opener.open(req, timeout=self.timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")

    def get(self, url: str) -> str:
        if self.opener is None:
            jar = http.cookiejar.CookieJar()
            self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            self._open(BASE_URL)
            if not any(c.name == "PHPSESSID" for c in jar):
                self.reset()
                raise FetchError("front page did not set a PHPSESSID cookie")
        body = self._open(url)
        if not body.strip():
            raise FetchError("empty response (session not accepted)")
        return body


def fetch_with_retries(session: Session, url: str, parse: Callable[[str], object],
                       retry_delays=None, sleep=None):
    """Fetch and parse url, retrying with a fresh session on any failure."""
    retry_delays = RETRY_DELAYS if retry_delays is None else retry_delays
    sleep = sleep or time.sleep
    for attempt in range(len(retry_delays) + 1):
        try:
            return parse(session.get(url))
        except (OSError, http.client.HTTPException, FetchError, ParseError) as e:
            detail = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else repr(e)
            session.reset()  # a hung request locks the PHP session; start over
            if attempt == len(retry_delays):
                raise FetchError(f"{url}: {detail}") from None
            delay = retry_delays[attempt]
            log(f"  {url}: {detail}; retrying in {delay}s")
            sleep(delay)


# ---------------------------------------------------------------- building

def build(fetch: Callable[[str, Callable], object], previous_maps: dict | None,
          limit: int | None = None, delay: float = 1.0, sleep=None):
    """Return (map_data, failed_map_names).

    fetch(url, parse) returns parse(body) or raises FetchError.
    """
    sleep = sleep or time.sleep
    t0 = time.perf_counter()
    previous_maps = previous_maps or {}
    log("Fetching map list...")
    maps = fetch(MAP_LIST_URL, parse_map_list)
    log(f"{len(maps)} maps in the map list")

    names = sorted(maps)
    to_fetch = names if limit is None else names[:limit]
    failed = []
    map_data = {}
    for i, name in enumerate(names):
        if i < len(to_fetch):
            if i:
                sleep(delay)
            try:
                times = fetch(MAP_URL.format(urllib.parse.quote(name, safe="")), parse_map_page)
            except FetchError as e:
                log(f"  FAILED {name}: {e}")
                failed.append(name)
                times = None
            if (i + 1) % 50 == 0 or i + 1 == len(to_fetch):
                log(f"  {i + 1}/{len(to_fetch)} map pages ({time.perf_counter() - t0:.0f}s, "
                    f"{len(failed)} failed)")
        else:
            times = None  # beyond --limit: keep previous times
        if times is None:
            old = previous_maps.get(name, {})
            times = {k: old.get(k) for k in TIME_FIELDS}
        map_data[name] = {**maps[name], **times}

    log(f"Total build time {time.perf_counter() - t0:.1f}s")
    return map_data, failed


def read_previous(out_dir: Path):
    """Return (map_data, updated_date) from the existing output file, or None."""
    path = out_dir / OUT_NAME
    if not path.is_file():
        return None
    js = path.read_text(encoding="utf-8")
    date_match = re.search(r'^const kog_map_data_last_updated = (".*?");$', js, re.M)
    data_match = re.search(r"^const kog_map_data = (\{.*\});$", js, re.M)
    if not (date_match and data_match):
        raise ValueError(f"could not parse the existing {path}")
    updated = dt.datetime.strptime(json.loads(date_match.group(1)), "%d %B %Y").date()
    return json.loads(data_match.group(1)), updated


def has_times(entry: dict | None) -> bool:
    return bool(entry) and entry.get("top_time") is not None


def check_sanity(previous_maps: dict, map_data: dict, failed: list[str],
                 fetched_count: int) -> list[str]:
    """Compare new output against the previous file. Returns a list of problems (empty if OK)."""
    problems = []
    if len(map_data) < len(previous_maps) * MIN_MAP_RATIO:
        problems.append(f"map count dropped from {len(previous_maps)} to {len(map_data)}")
    allowed_failed = int(fetched_count * MAX_FAILED_FRACTION)
    if len(failed) > allowed_failed:
        problems.append(
            f"{len(failed)} of {fetched_count} map pages failed to fetch (allowed {allowed_failed})"
        )
    lost = [m for m, v in map_data.items() if not has_times(v) and has_times(previous_maps.get(m))]
    allowed_lost = max(1, int(len(map_data) * MAX_LOST_TIMES_FRACTION))
    if len(lost) > allowed_lost:
        problems.append(
            f"{len(lost)} maps lost their times (allowed {allowed_lost}), e.g. {', '.join(lost[:5])}"
        )
    return problems


def write_output(out_dir: Path, map_data: dict, updated_date: dt.date) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    data = {name: map_data[name] for name in sorted(map_data)}
    js = (
        f"const kog_map_data_last_updated = {json.dumps(format_date(updated_date))};\n"
        f"const kog_map_data = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n"
    )
    (out_dir / OUT_NAME).write_text(js, encoding="utf-8", newline="\n")
    finished = sum(1 for v in map_data.values() if has_times(v))
    log(f"Wrote {out_dir / OUT_NAME} ({len(map_data)} maps, {finished} with finishers, "
        f"updated {format_date(updated_date)})")


def main(argv=None, session_factory=Session) -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "-o", "--out-dir", type=Path, default=REPO_ROOT / "js",
        help="output directory (default: repo js/)",
    )
    p.add_argument(
        "--updated-date", type=parse_date, default=None,
        help="YYYY-MM-DD shown as the 'last updated' date (default: today, UTC)",
    )
    p.add_argument(
        "--limit", type=int, default=None, metavar="N",
        help="only fetch the first N map pages (by name); other maps keep their previous times",
    )
    p.add_argument(
        "--delay", type=float, default=1.0,
        help="seconds to wait between map page requests (default: 1)",
    )
    p.add_argument(
        "--skip-checks", action="store_true",
        help="write the output even if it fails the sanity checks against the existing file",
    )
    args = p.parse_args(argv)

    try:
        previous = read_previous(args.out_dir)
    except ValueError as e:
        if not args.skip_checks:
            raise SystemExit(f"{e}; pass --skip-checks")
        log(f"Ignoring unreadable previous file: {e}")
        previous = None
    previous_maps = previous[0] if previous else None

    session = session_factory()
    try:
        map_data, failed = build(
            lambda url, parse: fetch_with_retries(session, url, parse),
            previous_maps, limit=args.limit, delay=args.delay,
        )
    except FetchError as e:
        log(f"Could not fetch the map list: {e}")
        sys.exit(1)

    if failed:
        log(f"{len(failed)} map pages failed: {', '.join(failed)}")
    fetched = len(map_data) if args.limit is None else min(args.limit, len(map_data))
    if not args.skip_checks:
        problems = check_sanity(previous_maps or {}, map_data, failed, fetched)
        if problems:
            log("Sanity checks failed, nothing written:")
            for problem in problems:
                log(f"  - {problem}")
            sys.exit(1)
        log("Sanity checks passed")

    updated = args.updated_date or dt.datetime.now(dt.timezone.utc).date()
    write_output(args.out_dir, map_data, updated)


if __name__ == "__main__":
    main()
