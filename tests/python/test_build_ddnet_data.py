"""Tests for scripts/build_ddnet_data.py, run against a tiny hand-made sqlite dump.

Run from the repo root: python -m unittest discover -s tests/python -v
"""

import datetime as dt
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "build_ddnet_data.py"
sys.path.insert(0, str(SCRIPT.parent))

import build_ddnet_data as b  # noqa: E402

SCHEMA = """
CREATE TABLE maps (Map varchar(128) NOT NULL, Server varchar(32) NOT NULL, Points integer NOT NULL DEFAULT 0,
                   Stars integer NOT NULL DEFAULT 0, Mapper varchar(128) NOT NULL, Timestamp timestamp NOT NULL);
CREATE TABLE race (Map varchar(128) NOT NULL, Name varchar(16) NOT NULL, Time float NOT NULL DEFAULT 0,
                   Timestamp timestamp NOT NULL, Server char(4) NOT NULL DEFAULT '');
CREATE TABLE teamrace (Map varchar(128) NOT NULL, Name varchar(16) NOT NULL, Time float NOT NULL DEFAULT 0,
                       ID varbinary(16) NOT NULL, Timestamp timestamp NOT NULL);
"""

TS = "2025-01-01 00:00:00"


def make_dump(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    maps = ["Odd", "Even", "Empty", "#weird 'name\""]
    con.executemany(
        "INSERT INTO maps VALUES (?, 'Novice', 1, 1, 'mapper', ?)", [(m, TS) for m in maps]
    )
    race = [
        # Odd: best times 10 (p1 repeats 12 and 50), 20, 30 -> median 20; race top 10
        ("Odd", "p1", 12.0, TS, "GER"),
        ("Odd", "p1", 10.0, TS, "GER"),
        ("Odd", "p1", 50.0, TS, "GER"),
        ("Odd", "p2", 20.0, TS, "GER"),
        ("Odd", "p3", 30.0, TS, "GER"),
        # Even: best times 10.004 and 20 -> median 15.002 -> 15.0 after rounding
        ("Even", "p1", 10.004, TS, "GER"),
        ("Even", "p2", 20.0, "2025-03-01 03:27:32", "GER"),  # latest finish in the dump
        ("#weird 'name\"", "p1", 5.0, TS, "GER"),
    ]
    con.executemany("INSERT INTO race VALUES (?, ?, ?, ?, ?)", race)
    con.executemany(
        "INSERT INTO teamrace VALUES (?, ?, ?, ?, ?)",
        [("Odd", "p1", 8.0, b"t1", TS), ("Odd", "p2", 8.0, b"t1", TS), ("Even", "p1", 99.0, b"t2", TS)],
    )
    con.commit()
    con.close()


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tmp.name) / "ddnet.sqlite"
        make_dump(cls.db)
        cls.map_data, cls.updated =b.build(cls.db, None)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_median_uses_each_players_best_time(self):
        self.assertEqual(self.map_data["Odd"]["median_time"], 20.0)

    def test_even_median_is_averaged_and_rounded(self):
        self.assertEqual(self.map_data["Even"]["median_time"], 15.0)

    def test_top_time_is_min_of_race_and_teamrace(self):
        self.assertEqual(self.map_data["Odd"]["top_time"], 8.0)  # team record beats race
        self.assertEqual(self.map_data["Even"]["top_time"], 10.0)  # race record beats team

    def test_map_without_finishes_is_null(self):
        self.assertEqual(self.map_data["Empty"], {"median_time": None, "top_time": None})

    def test_every_map_in_maps_table_is_present(self):
        self.assertEqual(len(self.map_data), 4)

    def test_updated_date_is_latest_finish(self):
        self.assertEqual(self.updated, dt.date(2025, 3, 1))
        self.assertEqual(b.format_date(self.updated), "1 March 2025")

    def test_output_round_trips_and_escapes_names(self):
        with tempfile.TemporaryDirectory() as out:
            b.write_outputs(Path(out), self.map_data, self.updated)
            map_js = (Path(out) / "map_data.js").read_text(encoding="utf-8")
            self.assertTrue(map_js.startswith('const map_data_last_updated = "1 March 2025";\n'))
            self.assertEqual(b.read_previous(Path(out)), (self.map_data, self.updated))


class SanityTest(unittest.TestCase):
    def setUp(self):
        self.maps = {f"m{i}": {"median_time": 1.0, "top_time": 1.0} for i in range(200)}
        self.date = dt.date(2026, 11, 1)
        self.previous = (self.maps, self.date)

    def test_identical_data_passes(self):
        self.assertEqual(b.check_sanity(self.previous, self.maps,self.date), [])

    def test_older_dump_fails(self):
        problems = b.check_sanity(self.previous, self.maps,dt.date(2026, 10, 1))
        self.assertIn("older", problems[0])

    def test_small_map_drop_passes_large_drop_fails(self):
        few_removed = dict(list(self.maps.items())[:197])
        self.assertEqual(b.check_sanity(self.previous, few_removed,self.date), [])
        many_removed = dict(list(self.maps.items())[:150])
        self.assertIn("map count", b.check_sanity(self.previous, many_removed,self.date)[0])

    def test_many_maps_losing_times_fails(self):
        broken = {k: ({"median_time": None, "top_time": None} if i < 10 else v)
                  for i, (k, v) in enumerate(self.maps.items())}
        self.assertIn("no times", b.check_sanity(self.previous, broken,self.date)[0])


class CommandLineTest(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def test_failed_sanity_check_writes_nothing_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            make_dump(tmp / "ddnet.sqlite")
            out = tmp / "out"
            # Previous output claims 1000 maps and a newer date, so the tiny dump must be rejected
            out.mkdir()
            old_map_js = ('const map_data_last_updated = "1 January 2030";\n'
                          'const map_data = ' + json.dumps({f"m{i}": {"median_time": 1, "top_time": 1}
                                                            for i in range(1000)}) + ';\n')
            (out / "map_data.js").write_text(old_map_js, encoding="utf-8")

            result = self.run_script(str(tmp / "ddnet.sqlite"), "-o", str(out))
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("Sanity checks failed", result.stderr)
            self.assertEqual((out / "map_data.js").read_text(encoding="utf-8"), old_map_js)

            result = self.run_script(str(tmp / "ddnet.sqlite"), "-o", str(out), "--skip-checks")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"1 March 2025"', (out / "map_data.js").read_text(encoding="utf-8"))

    def test_first_run_without_previous_files_writes_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            make_dump(tmp / "ddnet.sqlite")
            result = self.run_script(str(tmp / "ddnet.sqlite"), "-o", str(tmp / "out"))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((tmp / "out" / "map_data.js").is_file())


if __name__ == "__main__":
    unittest.main()
