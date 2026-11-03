# unlucksmcgee.github.io

## DDNet data

The DDNet page (`ddnet.html`, with an "Unfinished maps" mode and a "Rankings" mode at `ddnet.html?mode=rank`; the old `ddnet_rank.html` now redirects there) reads two generated files:

- `js/map_data.js`: median and top time for every map, plus the date of the dump
- `js/zaf_players.js`: South African players (finishes on more than 10 distinct maps on the ZAF servers), used for autocomplete

Both are built by `scripts/build_ddnet_data.py` from the official DDNet database dump
(https://ddnet.org/stats/ddnet.sqlite.zip). It needs only the Python 3.11+ standard library and
makes no HTTP requests.

The GitHub Action `.github/workflows/update-ddnet-data.yml` runs on the 2nd of every month (and can
be started by hand from the Actions tab). It downloads the dump, rebuilds both files and commits
them if anything changed.

To run it locally:

```sh
curl -fLO https://ddnet.org/stats/ddnet.sqlite.zip   # ~3 GB, unzips to ~7 GB
unzip ddnet.sqlite.zip
python scripts/build_ddnet_data.py ddnet.sqlite       # writes js/map_data.js and js/zaf_players.js
```

Use `--out-dir` to write somewhere else and `--updated-date YYYY-MM-DD` to override the
"last updated" date (it defaults to the latest finish in the dump). A run takes about a minute.

Before writing, the script compares its output with the existing files and refuses to write
anything (exit code 1) if the dump is older than the current data, the map count drops by more
than 2%, more than 1% of maps newly have no times, or the ZAF player list shrinks by more than
20%. In the Action this fails the run, so a broken or truncated dump never reaches the site and
GitHub emails you. Pass `--skip-checks` to override it.

`median_time` is the median of each player's best time on a map. ddnet.org's own median counts
every finish, repeats included, so the two differ, most of all on maps people grind.

## Tests

```sh
python -m unittest discover -s tests/python -v   # build script, against a tiny generated dump
cd tests && npm ci && npm test                    # DDNet pages, in jsdom with fetch mocked
```

Both run in GitHub Actions (`.github/workflows/test.yml`) on pushes and pull requests that touch
the DDNet pages, `js/`, `scripts/` or `tests/`.
