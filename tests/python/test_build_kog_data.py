"""Tests for scripts/build_kog_data.py, run against trimmed real kog.tw pages (no network).

Run from the repo root: python -m unittest discover -s tests/python -v
"""

import contextlib
import datetime as dt
import io
import json
import re
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "build_kog_data.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "kog"
sys.path.insert(0, str(SCRIPT.parent))

import build_kog_data as b  # noqa: E402


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


NO_TIMES = {"top_time": None, "last_time": None, "last_rank": None}

# Map list fixture: 001, ActionHallas, Fly_to_the_Mix, ColdNight_twisted, Aip-Gores
PAGES = {
    "001": "map_full.html",  # 99 finishers
    "ActionHallas": "map_partial.html",  # 21 finishers
    "Fly_to_the_Mix": "map_empty.html",  # no finishers
    "ColdNight_twisted": "map_full.html",
    "Aip-Gores": "map_partial.html",
}


def map_url(name: str) -> str:
    return b.MAP_URL.format(urllib.parse.quote(name, safe=""))


class FakeSession:
    """Serves fixtures by URL; URLs in `broken` always fail like a hung request."""

    def __init__(self, broken=()):
        self.pages = {b.MAP_LIST_URL: fixture("maps.html")}
        self.pages.update({map_url(n): fixture(f) for n, f in PAGES.items()})
        self.broken = {map_url(n) for n in broken}
        self.requests = []
        self.resets = 0

    def get(self, url):
        self.requests.append(url)
        if url in self.broken:
            raise TimeoutError("timed out")
        return self.pages[url]

    def reset(self):
        self.resets += 1


class ParseMapListTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.maps = b.parse_map_list(fixture("maps.html"))

    def test_all_cards_are_parsed(self):
        self.assertEqual(
            list(self.maps), ["001", "ActionHallas", "Fly_to_the_Mix", "ColdNight_twisted", "Aip-Gores"]
        )

    def test_card_fields(self):
        self.assertEqual(self.maps["001"], {
            "category": "Main", "stars": 1, "points": 6, "mapper": "Beautemps", "released": "2023-07-19",
        })

    def test_stars_count_filled_icons(self):
        self.assertEqual(self.maps["Fly_to_the_Mix"]["stars"], 5)
        self.assertEqual(self.maps["ActionHallas"]["stars"], 3)

    def test_category_and_zero_points(self):
        self.assertEqual(self.maps["Fly_to_the_Mix"]["category"], "Unknown")
        self.assertEqual(self.maps["Aip-Gores"]["category"], "Easy")
        self.assertEqual(self.maps["ColdNight_twisted"]["points"], 0)

    def test_mapper_with_ampersand(self):
        self.assertEqual(self.maps["ActionHallas"]["mapper"], "Action & Hallas")

    def test_unknown_release_date_is_null(self):
        # The footer says "Released during a sunset" for maps without a date
        self.assertIsNone(self.maps["ActionHallas"]["released"])

    def test_page_without_cards_is_an_error(self):
        with self.assertRaises(b.ParseError):
            b.parse_map_list("<html></html>")


class ParseMapPageTest(unittest.TestCase):
    def test_full_board_spans_three_tables(self):
        self.assertEqual(b.parse_map_page(fixture("map_full.html")),
                         {"top_time": 79.7, "last_time": 100.92, "last_rank": 99})

    def test_partial_board_gives_finisher_count(self):
        self.assertEqual(b.parse_map_page(fixture("map_partial.html")),
                         {"top_time": 58.0, "last_time": 701.46, "last_rank": 21})

    def test_empty_board_is_null(self):
        self.assertEqual(b.parse_map_page(fixture("map_empty.html")), NO_TIMES)

    def test_missing_or_truncated_board_is_an_error(self):
        with self.assertRaises(b.ParseError):
            b.parse_map_page(fixture("map_not_found.html"))
        with self.assertRaises(b.ParseError):
            b.parse_map_page("")
        full = fixture("map_full.html")
        with self.assertRaises(b.ParseError):
            b.parse_map_page(full[: full.rfind("</table>")])

    def test_times_are_rounded(self):
        page = fixture("map_partial.html").replace("<td>58</td>", "<td>57.996</td>")
        self.assertEqual(b.parse_map_page(page)["top_time"], 58.0)

    def test_parse_time_formats(self):
        self.assertEqual(b.parse_time("79.7"), 79.7)
        self.assertEqual(b.parse_time("1:19.5"), 79.5)
        self.assertEqual(b.parse_time("1:00:00"), 3600.0)


class FetchTest(unittest.TestCase):
    def test_retries_with_fresh_session_then_succeeds(self):
        session = FakeSession()
        calls = iter([TimeoutError("hung"), b.FetchError("empty response"), "page"])

        def get(url):
            result = next(calls)
            if isinstance(result, Exception):
                raise result
            return result

        session.get = get
        sleeps = []
        result = b.fetch_with_retries(session, "u", str.upper, retry_delays=(1, 2, 3),
                                      sleep=sleeps.append)
        self.assertEqual(result, "PAGE")
        self.assertEqual(sleeps, [1, 2])
        self.assertEqual(session.resets, 2)

    def test_gives_up_after_retries(self):
        session = FakeSession(broken=["001"])
        sleeps = []
        with self.assertRaises(b.FetchError):
            b.fetch_with_retries(session, map_url("001"), b.parse_map_page,
                                 retry_delays=(1, 2), sleep=sleeps.append)
        self.assertEqual(len(session.requests), 3)
        self.assertEqual(sleeps, [1, 2])

    def test_parse_errors_are_retried(self):
        session = FakeSession()
        session.pages[map_url("001")] = fixture("map_not_found.html")
        with self.assertRaises(b.FetchError):
            b.fetch_with_retries(session, map_url("001"), b.parse_map_page,
                                 retry_delays=(0,), sleep=lambda s: None)
        self.assertEqual(len(session.requests), 2)


def run_build(session, previous=None, limit=None):
    fetch = lambda url, parse: b.fetch_with_retries(  # noqa: E731
        session, url, parse, retry_delays=(0,), sleep=lambda s: None)
    with contextlib.redirect_stderr(io.StringIO()):
        return b.build(fetch, previous, limit=limit, delay=0, sleep=lambda s: None)


class BuildTest(unittest.TestCase):
    def test_build_combines_list_and_pages(self):
        map_data, failed = run_build(FakeSession())
        self.assertEqual(failed, [])
        self.assertEqual(map_data["001"], {
            "category": "Main", "stars": 1, "points": 6, "mapper": "Beautemps", "released": "2023-07-19",
            "top_time": 79.7, "last_time": 100.92, "last_rank": 99,
        })
        self.assertEqual(map_data["ActionHallas"]["last_rank"], 21)
        self.assertEqual({k: map_data["Fly_to_the_Mix"][k] for k in NO_TIMES}, NO_TIMES)

    def test_failed_page_reuses_previous_times(self):
        previous = {"001": {"top_time": 1.0, "last_time": 2.0, "last_rank": 3, "category": "Old"}}
        map_data, failed = run_build(FakeSession(broken=["001", "Aip-Gores"]), previous)
        self.assertEqual(failed, ["001", "Aip-Gores"])
        # times come from the previous file, map info from the fresh map list
        self.assertEqual(map_data["001"]["top_time"], 1.0)
        self.assertEqual(map_data["001"]["last_rank"], 3)
        self.assertEqual(map_data["001"]["category"], "Main")
        # no previous value: times stay null
        self.assertIsNone(map_data["Aip-Gores"]["top_time"])

    def test_limit_fetches_only_first_maps_and_keeps_previous_times(self):
        session = FakeSession()
        previous = {"Fly_to_the_Mix": {"top_time": 5.0, "last_time": 6.0, "last_rank": 7}}
        map_data, failed = run_build(session, previous, limit=2)
        self.assertEqual(session.requests, [b.MAP_LIST_URL, map_url("001"), map_url("ActionHallas")])
        self.assertEqual(map_data["Fly_to_the_Mix"]["top_time"], 5.0)
        self.assertEqual(len(map_data), 5)


class OutputTest(unittest.TestCase):
    def test_output_format_and_round_trip(self):
        map_data, _ = run_build(FakeSession())
        map_data["Ünïcode \"q\""] = dict(map_data["001"])
        with tempfile.TemporaryDirectory() as out, contextlib.redirect_stderr(io.StringIO()):
            b.write_output(Path(out), map_data, dt.date(2026, 11, 4))
            js = (Path(out) / b.OUT_NAME).read_text(encoding="utf-8")
            lines = js.split("\n")
            self.assertEqual(len(lines), 3)  # two lines plus the trailing newline
            self.assertEqual(lines[0], 'const kog_map_data_last_updated = "4 November 2026";')
            self.assertTrue(lines[1].startswith('const kog_map_data = {"001":{"category":"Main",'))
            self.assertIn('"Ünïcode \\"q\\""', lines[1])
            data = json.loads(re.match(r"const kog_map_data = (.*);$", lines[1]).group(1))
            self.assertEqual(list(data), sorted(data))
            self.assertEqual(b.read_previous(Path(out)), (map_data, dt.date(2026, 11, 4)))


class SanityTest(unittest.TestCase):
    def setUp(self):
        self.maps = {f"m{i:03}": {"top_time": 1.0, "last_time": 2.0, "last_rank": 99} for i in range(200)}

    def test_identical_data_passes(self):
        self.assertEqual(b.check_sanity(self.maps, self.maps, [], 200), [])

    def test_first_run_only_checks_failures(self):
        self.assertEqual(b.check_sanity({}, self.maps, ["m000"] * 10, 200), [])
        self.assertIn("failed to fetch", b.check_sanity({}, self.maps, ["m000"] * 11, 200)[0])

    def test_small_map_drop_passes_large_drop_fails(self):
        few_removed = dict(list(self.maps.items())[:197])
        self.assertEqual(b.check_sanity(self.maps, few_removed, [], 197), [])
        many_removed = dict(list(self.maps.items())[:150])
        self.assertIn("map count", b.check_sanity(self.maps, many_removed, [], 150)[0])

    def test_too_many_failed_fetches_fails(self):
        self.assertEqual(b.check_sanity(self.maps, self.maps, [f"m{i:03}" for i in range(10)], 200), [])
        problems = b.check_sanity(self.maps, self.maps, [f"m{i:03}" for i in range(11)], 200)
        self.assertIn("failed to fetch", problems[0])

    def test_many_maps_losing_times_fails(self):
        def lose(n):
            return {k: ({**v, **NO_TIMES} if i < n else v) for i, (k, v) in enumerate(self.maps.items())}
        self.assertEqual(b.check_sanity(self.maps, lose(2), [], 200), [])
        self.assertIn("lost their times", b.check_sanity(self.maps, lose(3), [], 200)[0])

    def test_maps_that_never_had_times_dont_count(self):
        previous = {k: {**v, **NO_TIMES} for k, v in self.maps.items()}
        self.assertEqual(b.check_sanity(previous, previous, [], 200), [])


class CommandLineTest(unittest.TestCase):
    def run_main(self, out, *args, broken=()):
        stderr = io.StringIO()
        code = 0
        with contextlib.redirect_stderr(stderr), \
                mock.patch.object(b, "RETRY_DELAYS", (0,)):
            try:
                b.main(["-o", str(out), "--delay", "0", "--updated-date", "2026-11-04", *args],
                       session_factory=lambda: FakeSession(broken))
            except SystemExit as e:
                code = e.code
        return code, stderr.getvalue()

    def test_first_run_without_previous_file_writes_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, err = self.run_main(tmp)
            self.assertEqual(code, 0, err)
            js = (Path(tmp) / b.OUT_NAME).read_text(encoding="utf-8")
            self.assertTrue(js.startswith('const kog_map_data_last_updated = "4 November 2026";\n'))

    def test_failed_sanity_check_writes_nothing_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = ('const kog_map_data_last_updated = "1 October 2026";\n'
                   'const kog_map_data = ' + json.dumps({f"m{i}": {"top_time": 1} for i in range(1000)})
                   + ';\n')
            (Path(tmp) / b.OUT_NAME).write_text(old, encoding="utf-8")

            code, err = self.run_main(tmp)
            self.assertEqual(code, 1, err)
            self.assertIn("Sanity checks failed", err)
            self.assertEqual((Path(tmp) / b.OUT_NAME).read_text(encoding="utf-8"), old)

            code, err = self.run_main(tmp, "--skip-checks")
            self.assertEqual(code, 0, err)
            self.assertIn('"001":{', (Path(tmp) / b.OUT_NAME).read_text(encoding="utf-8"))

    def test_rerun_with_a_failed_page_reuses_cached_times(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_main(tmp)[0], 0)
            first = (Path(tmp) / b.OUT_NAME).read_text(encoding="utf-8")
            # One of five pages failing is over the 5% limit...
            code, err = self.run_main(tmp, broken=["001"])
            self.assertEqual(code, 1, err)
            self.assertIn("failed to fetch", err)
            # ...but with --skip-checks the cached times are kept
            code, err = self.run_main(tmp, "--skip-checks", broken=["001"])
            self.assertEqual(code, 0, err)
            self.assertEqual((Path(tmp) / b.OUT_NAME).read_text(encoding="utf-8"), first)

    def test_unreachable_map_list_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), mock.patch.object(b, "RETRY_DELAYS", (0,)), \
                    self.assertRaises(SystemExit) as cm:
                session = FakeSession()
                session.pages[b.MAP_LIST_URL] = ""
                b.main(["-o", tmp, "--delay", "0"], session_factory=lambda: session)
            self.assertEqual(cm.exception.code, 1)
            self.assertFalse((Path(tmp) / b.OUT_NAME).exists())


if __name__ == "__main__":
    unittest.main()
