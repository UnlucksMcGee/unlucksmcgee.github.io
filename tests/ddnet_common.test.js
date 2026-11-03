// Pure helpers from js/ddnet_common.js (loaded through ddnet.html)
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { JSDOM, VirtualConsole } = require("jsdom")
const { REPO, load_page } = require("./helpers")

const w = load_page("ddnet.html")

test("slugify: known ddnet.org map/player URL pairs", () => {
    const pairs = [
        ["#wontfix", "-35-wontfix"],
        ["(wasntme)", "-40-wasntme-41-"],
        ["~AuTuMn~", "~AuTuMn~"],
        [".Background'", "-46-Background-39-"],
        ["-Ikarus-", "-45-Ikarus-45-"],
        ["-273", "-45-273"],
        ["å", "-229-"], // non-ASCII BMP char
        ["a\u{1F600}b", "a-128512-b"], // astral char: one code point like Python ord(), not two surrogates
    ]
    for (const [name, slug] of pairs) {
        assert.equal(w.ddnet_slugify(name), slug, name)
    }
    assert.equal(w.ddnet_map_url("Spüli"), "https://ddnet.org/maps/Sp-252-li")
    assert.equal(w.ddnet_player_url("Unlucks McGee"), "https://ddnet.org/players/Unlucks-32-McGee")
})

test("format_time", () => {
    const f = w.format_time
    assert.deepEqual([0, 85.44, 3599.9, 3600, 3686.14, 90000, null, undefined, NaN, -1].map(t => f(t)),
        ["00:00", "01:25", "59:59", "01:00:00", "01:01:26", "25:00:00", "?", "?", "?", "?"])
    // Matches the old toISOString implementation below 24h
    for (const t of [1, 59.5, 61, 1533.1, 3599, 3600, 7322.7, 86399]) {
        const iso = new Date(t * 1000).toISOString()
        assert.equal(f(t), t < 3600 ? iso.substring(14, 19) : iso.substring(11, 19), String(t))
    }
})

test("rank_percentile and format_percentile", () => {
    const p = w.rank_percentile
    assert.equal(p(1, 1), 100)
    assert.equal(p(1, 10), 100)
    assert.equal(p(10, 10), 0)
    assert.equal(p(5, 9), 50)
    assert.equal(p(null, 10), null)
    assert.equal(p(1, 0), null)
    assert.equal(w.format_percentile(p(2, 3)), "50.0")
    assert.equal(w.format_percentile(null), "?")
})

test("map_data lookups handle missing, null and prototype names", () => {
    assert.equal(w.get_median_time("Alpha"), 100)
    assert.equal(w.get_top_time("Beta"), null)
    assert.equal(w.get_median_time("Nope"), null)
    assert.equal(w.get_median_time("hasOwnProperty"), null)
    assert.equal(w.get_median_time("__proto__"), null)
    assert.equal(w.get_median_time("constructor"), null)
    assert.equal(w.get_map_data_last_updated(), "3 November 2026")
})

test("comparators", () => {
    const d = { a: { points: 1, total_finishes: 5 }, b: { points: 1, total_finishes: 50 }, c: { points: 0, total_finishes: 1 }, e: { points: null, total_finishes: null } }
    const sorted = (names, id) => names.slice().sort(w.get_map_comparator(id, d))
    assert.deepEqual(sorted(["a", "b", "c", "e"], "sorting_easiest"), ["c", "b", "a", "e"])
    assert.deepEqual(sorted(["a", "b", "c", "e"], "sorting_most_finishes"), ["b", "a", "c", "e"])
    // "Nope" (not in map_data) and "Gamma" (null median) sort last, keeping their order
    assert.deepEqual(sorted(["Nope", "Gamma", "Beta", "Alpha"], "sorting_median_time"), ["Alpha", "Beta", "Nope", "Gamma"])
    assert.deepEqual(sorted(["map10", "map2"], "sorting_name"), ["map2", "map10"])
    assert.throws(() => w.get_map_comparator("bogus", d))
})

test("saved usernames: round trip and invalid storage", () => {
    w.save_usernames(["a", "b"])
    assert.deepEqual([...w.load_saved_usernames()], ["a", "b"]) // spread: the array comes from the jsdom realm
    w.localStorage.setItem("usernames", "not json")
    assert.equal(w.load_saved_usernames(), null)
    w.localStorage.setItem("usernames", JSON.stringify(["ok", 5, null]))
    assert.deepEqual([...w.load_saved_usernames()], ["ok"]) // spread: the array comes from the jsdom realm
    w.localStorage.removeItem("usernames")
    assert.equal(w.load_saved_usernames(), null)
})

test("no uncaught page script errors", () => {
    assert.deepEqual(w.jsdom_errors, [])
})

test("ddnet_common.js works with no map_data at all", () => {
    const dom = new JSDOM("<!doctype html><p id=map_data_last_updated_p></p>", { runScripts: "outside-only", virtualConsole: new VirtualConsole() })
    const ww = dom.window
    // Top-level const isn't visible as a window property under eval, so use var to inspect the helpers
    ww.eval(fs.readFileSync(path.join(REPO, "js/ddnet_common.js"), "utf8").replace(/^const /gm, "var "))
    assert.equal(ww.get_median_time("Alpha"), null)
    assert.equal(ww.get_top_time("Alpha"), null)
    assert.equal(ww.get_map_data_last_updated(), "?")
    ww.show_map_data_last_updated()
    assert.equal(ww.document.getElementById("map_data_last_updated_p").textContent, "Map times last updated: ?")
})
