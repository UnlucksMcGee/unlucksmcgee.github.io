#!/usr/bin/env python3
"""Build the DDNet data files used by ddnet.html / ddnet_rank.html.

Reads the official DDNet sqlite dump (https://ddnet.org/stats/ddnet.sqlite.zip)
and writes:

  <out>/map_data.js     const map_data_last_updated = "1 March 2025";
                        const map_data = {"Map": {"median_time": .., "top_time": ..}, ...};
  <out>/zaf_players.js  var zaf_players = [...];

median_time: median over players of each player's best time on the map.
top_time:    fastest of the best race time and the best team race time.
Both are null when the map has no finishes.

Everything is computed from the dump in a single pass over the (unindexed)
race table, plus a small pass over teamrace. Stdlib only, Python 3.11+.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ZAF_SERVER = "ZAF"
ZAF_MIN_MAPS = 10  # players need finishes on MORE than this many distinct maps

# Sanity limits against the previously published files (see check_sanity)
MIN_MAP_RATIO = 0.98  # maps are rarely removed, so the map count shouldn't drop much
MAX_EXTRA_NULL_FRACTION = 0.01  # share of maps that may newly lose their times
MIN_ZAF_RATIO = 0.8


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def format_date(d: dt.date) -> str:
    return f"{d.day} {d.strftime('%B')} {d.year}"


def parse_date(s: str) -> dt.date:
    return dt.date.fromisoformat(s.strip()[:10])


def r2(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


def build(db_path: Path, updated_date: dt.date | None):
    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    t0 = time.perf_counter()

    maps = [row[0] for row in con.execute("SELECT Map FROM maps")]
    log(f"{len(maps)} maps in maps table")

    # Single full scan of race: one row per (map, player) with that player's
    # best time, latest finish timestamp and whether they finished on ZAF.
    # The GROUP BY output is ordered by Map, so medians are computed map by map
    # without holding every (map, player) pair in memory.
    t = time.perf_counter()
    log("Scanning race table (this is the slow part)...")
    median: dict[str, float] = {}
    race_top: dict[str, float] = {}
    zaf_maps: defaultdict[str, int] = defaultdict(int)
    latest_ts = ""
    groups = 0
    cur_map: str | None = None
    best: list[float] = []

    def flush() -> None:
        if cur_map is not None and best:
            median[cur_map] = statistics.median(best)
            race_top[cur_map] = min(best)

    query = (
        "SELECT Map, Name, MIN(Time), MAX(Timestamp), MAX(Server = ?) "
        "FROM race GROUP BY Map, Name"
    )
    for map_name, name, best_time, ts, on_zaf in con.execute(query, (ZAF_SERVER,)):
        if map_name != cur_map:
            flush()
            if map_name in median:  # GROUP BY output is sorted; guard anyway
                raise RuntimeError(f"race rows for {map_name!r} were not contiguous")
            cur_map, best = map_name, []
        best.append(best_time)
        if ts and ts > latest_ts:
            latest_ts = ts
        if on_zaf:
            zaf_maps[name] += 1
        groups += 1
        if groups % 2_000_000 == 0:
            log(f"  {groups:,} map/player pairs ({time.perf_counter() - t:.0f}s)")
    flush()
    log(f"  {groups:,} map/player pairs on {len(median)} maps in {time.perf_counter() - t:.1f}s")

    t = time.perf_counter()
    team_top = dict(con.execute("SELECT Map, MIN(Time) FROM teamrace GROUP BY Map"))
    log(f"Scanned teamrace ({len(team_top)} maps) in {time.perf_counter() - t:.1f}s")
    con.close()

    map_data = {}
    for m in maps:
        tops = [x for x in (race_top.get(m), team_top.get(m)) if x is not None]
        map_data[m] = {
            "median_time": r2(median.get(m)),
            "top_time": r2(min(tops)) if tops else None,
        }

    zaf_players = [
        name
        for name, count in sorted(zaf_maps.items(), key=lambda kv: (-kv[1], kv[0]))
        if count > ZAF_MIN_MAPS
    ]

    if updated_date is None:
        if not latest_ts:
            raise SystemExit("No race timestamps found; pass --updated-date")
        updated_date = parse_date(latest_ts)
        log(f"Latest race timestamp: {latest_ts}")

    log(f"Total build time {time.perf_counter() - t0:.1f}s")
    return map_data, zaf_players, updated_date


def read_previous(out_dir: Path):
    """Return (map_data, zaf_players, updated_date) from existing output files, or None."""
    map_path, zaf_path = out_dir / "map_data.js", out_dir / "zaf_players.js"
    if not (map_path.is_file() and zaf_path.is_file()):
        return None
    map_js = map_path.read_text(encoding="utf-8")
    date_match = re.search(r'^const map_data_last_updated = (".*?");$', map_js, re.M)
    data_match = re.search(r"^const map_data = (\{.*\});$", map_js, re.M)
    zaf_match = re.search(r"^var zaf_players = (\[.*\]);?$", zaf_path.read_text(encoding="utf-8"), re.M)
    if not (date_match and data_match and zaf_match):
        raise SystemExit(f"Could not parse the existing files in {out_dir}; pass --skip-checks")
    updated = dt.datetime.strptime(json.loads(date_match.group(1)), "%d %B %Y").date()
    return json.loads(data_match.group(1)), json.loads(zaf_match.group(1)), updated


def check_sanity(previous, map_data, zaf_players, updated_date: dt.date) -> list[str]:
    """Compare new output against the previous files. Returns a list of problems (empty if OK)."""
    old_maps, old_zaf, old_date = previous
    problems = []
    if updated_date < old_date:
        problems.append(f"dump date {updated_date} is older than the current data ({old_date})")
    if len(map_data) < len(old_maps) * MIN_MAP_RATIO:
        problems.append(f"map count dropped from {len(old_maps)} to {len(map_data)}")

    def nulls(data):
        return sum(1 for v in data.values() if v["median_time"] is None)

    allowed_nulls = nulls(old_maps) + max(1, int(len(map_data) * MAX_EXTRA_NULL_FRACTION))
    if nulls(map_data) > allowed_nulls:
        problems.append(
            f"{nulls(map_data)} maps have no times (was {nulls(old_maps)}, allowed {allowed_nulls})"
        )
    if len(zaf_players) < len(old_zaf) * MIN_ZAF_RATIO:
        problems.append(f"ZAF player count dropped from {len(old_zaf)} to {len(zaf_players)}")
    return problems


def write_outputs(out_dir: Path, map_data, zaf_players, updated_date: dt.date) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    compact = dict(ensure_ascii=False, separators=(",", ":"))

    map_js = (
        f"const map_data_last_updated = {json.dumps(format_date(updated_date))};\n"
        f"const map_data = {json.dumps(map_data, sort_keys=True, **compact)};\n"
    )
    (out_dir / "map_data.js").write_text(map_js, encoding="utf-8", newline="\n")

    zaf_js = f"var zaf_players = {json.dumps(zaf_players, **compact)};\n"
    (out_dir / "zaf_players.js").write_text(zaf_js, encoding="utf-8", newline="\n")

    with_median = sum(1 for v in map_data.values() if v["median_time"] is not None)
    log(
        f"Wrote {out_dir / 'map_data.js'} ({len(map_data)} maps, {with_median} with finishes, "
        f"updated {format_date(updated_date)})"
    )
    log(f"Wrote {out_dir / 'zaf_players.js'} ({len(zaf_players)} players)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("sqlite", type=Path, help="path to ddnet.sqlite (unzipped dump)")
    p.add_argument(
        "-o", "--out-dir", type=Path, default=REPO_ROOT / "js",
        help="output directory (default: repo js/)",
    )
    p.add_argument(
        "--updated-date", type=parse_date, default=None,
        help="YYYY-MM-DD shown as the 'last updated' date "
             "(default: latest race timestamp in the dump)",
    )
    p.add_argument(
        "--skip-checks", action="store_true",
        help="write the output even if it fails the sanity checks against the existing files",
    )
    args = p.parse_args()

    if not args.sqlite.is_file():
        p.error(f"sqlite file not found: {args.sqlite}")

    map_data, zaf_players, updated = build(args.sqlite, args.updated_date)

    previous = None if args.skip_checks else read_previous(args.out_dir)
    if previous is not None:
        problems = check_sanity(previous, map_data, zaf_players, updated)
        if problems:
            log("Sanity checks failed, nothing written:")
            for problem in problems:
                log(f"  - {problem}")
            sys.exit(1)
        log("Sanity checks passed")

    write_outputs(args.out_dir, map_data, zaf_players, updated)


if __name__ == "__main__":
    main()
