# unlucksmcgee.github.io

## DDNet data

The DDNet page (`ddnet.html`) has an "Unfinished maps" mode and a "Rankings" mode (`ddnet.html?mode=rank`;
the old `ddnet_rank.html` redirects there). Player names are suggested by ddnet.org's own player
search (`https://ddnet.org/players/?query=`) as you type.

A region chip in the header ("Global" by default) lists the countries that have DDNet servers,
taken from the live master server list (`https://master1.ddnet.org/ddnet/15/servers.json`).
Choosing a country is remembered and kept in the URL as `?region=<country code>` (e.g.
`ddnet.html?region=za`), and adds an "+ Add from a server" option that fills in the players
currently on one of that country's servers.

The page reads one generated file, `js/map_data.js`: the median and top time for every map, plus
the date of the dump. It is built by `scripts/build_ddnet_data.py` from the official DDNet database
dump (https://ddnet.org/stats/ddnet.sqlite.zip). The script needs only the Python 3.11+ standard
library and makes no HTTP requests.

The GitHub Action `.github/workflows/update-ddnet-data.yml` runs on the 2nd of every month (and can
be started by hand from the Actions tab). It downloads the dump, rebuilds the file and commits it
if anything changed.

To run it locally:

```sh
curl -fLO https://ddnet.org/stats/ddnet.sqlite.zip   # ~3 GB, unzips to ~7 GB
unzip ddnet.sqlite.zip
python scripts/build_ddnet_data.py ddnet.sqlite       # writes js/map_data.js
```

Use `--out-dir` to write somewhere else and `--updated-date YYYY-MM-DD` to override the
"last updated" date (it defaults to the latest finish in the dump). A run takes about a minute.

Before writing, the script compares its output with the existing `js/map_data.js` and refuses to
write anything (exit code 1) if the dump is older than the current data, the map count drops by
more than 2%, or more than 1% of maps newly have no times. In the Action this fails the run, so a broken or truncated dump never reaches the site and
GitHub emails you. Pass `--skip-checks` to override it.

`median_time` is the median of each player's best time on a map. ddnet.org's own median counts
every finish, repeats included, so the two differ, most of all on maps people grind.

## KoG page

`kog.html` lists the KoG (King of Gores, https://kog.tw) maps that none of the saved players has
finished, with each map's category, stars, points, top time and 99th place time. KoG has no API
and doesn't allow other sites to read its pages (no CORS), so the data arrives in two ways:

- **Maps** come from `js/kog_map_data.js`, built by `scripts/build_kog_data.py` from kog.tw's map
  list and each map's top-99 page (see below).
- **Players** are added with a bookmarklet (`js/kog_bookmarklet.js`, turned into a `javascript:`
  link on the page). On kog.tw it reads the player page you're on, or loads one by name, and comes
  back to `kog.html#kog_import=<JSON>` with that player's finished maps. Players are kept in
  localStorage (`kog_players`).

There's no median on KoG, so the "99th place" column takes its place. It is the last row of a
map's top-99 list, and has a "(#N)" after it when fewer than 99 players have finished the map.

The page shows KoG's "Unknown" category as "Solo / Unknown". kog.tw's map list labels its Solo maps
"Unknown". Its player pages count 37 Solo maps, but 41 maps are "Unknown", and nothing says which
4 of those aren't Solo.

`scripts/build_kog_data.py` (standard library only) fetches kog.tw's map list, then every map's page
one at a time with a 1 s pause (about 25 minutes for ~1100 maps). kog.tw is slow and sometimes times out, so each page is retried
with a fresh session, and a map whose page still fails keeps its times from the existing file. The
same kind of sanity checks as the DDNet script stop a bad run from being written. The GitHub
Action `.github/workflows/update-kog-data.yml` runs it on the 3rd of every month (or by hand).

```sh
python scripts/build_kog_data.py              # writes js/kog_map_data.js
python scripts/build_kog_data.py --limit 20   # quick test: only the first 20 map pages
```

## Tests

```sh
python -m unittest discover -s tests/python -v   # build scripts, against a tiny dump / saved kog.tw pages
cd tests && npm ci && npm test                    # DDNet and KoG pages, in jsdom with fetch mocked
```

Both run in GitHub Actions (`.github/workflows/test.yml`) on pushes and pull requests that touch
the DDNet or KoG pages, `js/`, `scripts/` or `tests/`.
