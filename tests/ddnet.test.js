// ddnet.html: common unfinished maps between several players
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { XSS_PLAYER, players, load_page, tick, cell_texts } = require("./helpers")

const w = load_page("ddnet.html", { saved_usernames: ["A", "B", XSS_PLAYER] })
const doc = w.document
const inputs = () => [...doc.querySelectorAll(".username_text_input")]
const set_names = names => {
    while (inputs().length < names.length) w.add_textbox()
    while (inputs().length > names.length) w.remove_textbox()
    names.forEach((name, i) => { inputs()[i].value = name })
}
const first_column = section => [...doc.querySelectorAll("#" + section + " tr td:first-child")].map(td => td.textContent)

test("loads saved names, last-updated text and one default sort radio", () => {
    assert.deepEqual(inputs().map(i => i.value), ["A", "B", XSS_PLAYER])
    assert.equal(doc.getElementById("map_data_last_updated_p").textContent, "Map times last updated: 3 November 2026")
    assert.equal(doc.querySelectorAll("input[name=sorting_list][checked]").length, 1)
})

test("defaults to unfinished-maps mode", () => {
    assert.equal(doc.getElementById("ddnet_main").getAttribute("data-mode"), "unfinished")
    assert.ok(doc.getElementById("sorting_easiest").checked)
    assert.equal(w.location.search, "")
})

test("removing the last player row clears it instead", () => {
    const page = load_page("ddnet.html", { saved_usernames: ["Solo"] })
    const button = page.document.querySelector(".btn_remove")
    button.click()
    const boxes = page.document.querySelectorAll(".username_text_input")
    assert.equal(boxes.length, 1)
    assert.equal(boxes[0].value, "")
})

test("falls back to default names when nothing is saved", () => {
    const fresh = load_page("ddnet.html")
    assert.deepEqual([...fresh.document.querySelectorAll(".username_text_input")].map(i => i.value), ["UnlucksMcGee", "Eyesore"])
})

test("intersect_unfinished_maps", () => {
    const S = (...names) => new w.Set(names)
    const result = w.intersect_unfinished_maps([
        { Novice: S("a", "b", "c"), Brutal: S("x"), Solo: S("s") },
        { Novice: S("b", "c", "d"), Solo: S("s") },
        { Novice: S("c", "b"), Solo: S() },
    ])
    assert.deepEqual(Object.keys(result), ["Novice", "Brutal", "Solo"])
    assert.deepEqual([...result.Novice].sort(), ["b", "c"])
    assert.equal(result.Brutal.size, 0) // missing for the second player
    assert.equal(result.Solo.size, 0)
    assert.equal(Object.keys(w.intersect_unfinished_maps([])).length, 0)
})

test("search: intersection, XSS-safe rendering, encoded fetch URL, saved names", async () => {
    w.fetch_log.length = 0
    w.search()
    await tick()
    assert.deepEqual(w.alerts, [])
    assert.ok(w.fetch_log.includes("https://ddnet.org/players/?json2=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"), w.fetch_log.join())
    // Brutal is missing for B -> empty, Solo is missing for A -> not shown
    assert.deepEqual([...doc.querySelectorAll(".map_section")].map(s => s.id), ["Novice"])
    // Default sort is easiest: fewest points, then most finishes
    assert.deepEqual(cell_texts([...doc.querySelectorAll("#Novice tr")].slice(1)), [
        ["Beta", "1", "500", "01:06:40 / ?"],
        ["Alpha", "1", "100", "01:40 / 00:50"],
        ["Gamma", "5", "10", "? / 01:01:40"],
    ])
    assert.equal(doc.querySelectorAll("img").length, 0)
    const links = [...doc.querySelectorAll("#player_results_div a")]
    assert.equal(links.length, 3)
    assert.equal(links[2].textContent, XSS_PLAYER + " (42pts)")
    assert.equal(links[2].href, "https://ddnet.org/players/-60-img-32-src-61-x-32-onerror-61-alert-40-1-41--62-")
    assert.equal(doc.querySelector("#Novice a").href, "https://ddnet.org/maps/Beta")
    assert.equal(doc.querySelector("#Novice h3").textContent, "Novice (3)")
    assert.equal(doc.getElementById("sort_description").textContent, "Fewest points first, then most finishes")
    assert.deepEqual(JSON.parse(w.localStorage.getItem("usernames")), ["A", "B", XSS_PLAYER])
})

test("re-sorting by median time, name and most finishes (missing/null last)", () => {
    w.display_results("sorting_median_time")
    assert.deepEqual(first_column("Novice"), ["Alpha", "Beta", "Gamma"])
    assert.equal(doc.getElementById("sort_description").textContent, "Shortest median finish time first")
    assert.ok(doc.getElementById("sorting_median_time").checked)
    assert.ok(!doc.getElementById("sorting_easiest").checked)
    w.display_results("sorting_name")
    assert.deepEqual(first_column("Novice"), ["Alpha", "Beta", "Gamma"])
    w.display_results("sorting_most_finishes")
    assert.deepEqual(first_column("Novice"), ["Beta", "Alpha", "Gamma"])
})

test("map names are rendered as text", async () => {
    set_names([XSS_PLAYER, XSS_PLAYER, XSS_PLAYER])
    w.search()
    await tick()
    assert.ok(first_column("Novice").includes("<b>x</b>"))
    assert.equal(doc.querySelectorAll("#Novice b, img").length, 0)
})

test("partial failures produce one alert with specific messages", async () => {
    set_names(["A", "NoSuchPlayer", "Http500", "NetFail"])
    w.alerts.length = 0
    w.search()
    await tick()
    assert.equal(w.alerts.length, 1)
    const message = w.alerts[0]
    assert.match(message, /3 of 4/)
    assert.match(message, /not found: "NoSuchPlayer"/)
    assert.match(message, /HTTP 500 for "Http500"/)
    assert.match(message, /Network error while loading "NetFail"/)
    assert.equal(doc.getElementById("results_section_div").style.display, "none")
})

test("fetches at most 8 players at once", async () => {
    let active = 0
    let max_active = 0
    w.fetch = () => {
        active++
        max_active = Math.max(max_active, active)
        return new Promise(resolve => setTimeout(() => {
            active--
            resolve({ ok: true, status: 200, json: async () => players.A })
        }, 5))
    }
    try {
        const results = await w.fetch_all_players_json(Array.from({ length: 30 }, (_, i) => "P" + i))
        assert.equal(results.length, 30)
        assert.ok(results.every(r => r.error === null))
        assert.equal(max_active, 8)
    } finally {
        w.fetch = w.mock_fetch
    }
})

test("duplicate names are fetched once and results keep input order", async () => {
    const urls = []
    w.fetch = url => {
        urls.push(url)
        return Promise.resolve({ ok: true, status: 200, json: async () => players.A })
    }
    try {
        const results = await w.fetch_all_players_json(["A", "B", "A", "A", "B"])
        assert.equal(urls.length, 2)
        assert.deepEqual(results.map(r => r.username), ["A", "B", "A", "A", "B"])
    } finally {
        w.fetch = w.mock_fetch
    }
})

test("Search button is disabled while searching and re-enabled after (success and failure)", async () => {
    const button = doc.getElementById("search_button")
    set_names(["A", "B", "A"])
    w.alerts.length = 0
    w.search()
    assert.ok(button.disabled)
    await tick()
    assert.ok(!button.disabled)
    assert.deepEqual(w.alerts, [])

    set_names(["A", "NoSuchPlayer", "A"])
    w.search()
    assert.ok(button.disabled)
    await tick()
    assert.ok(!button.disabled)
    assert.equal(w.alerts.length, 1)
})

test("server dropdown is XSS-safe; 70 names are capped at 64 without hanging", { timeout: 5000 }, async () => {
    w.fetch_log.length = 0
    w.loadServerNames()
    await tick()
    assert.deepEqual(w.fetch_log, ["https://master1.ddnet.org/ddnet/15/servers.json"])
    const select = doc.getElementById("server_selection_dropdown")
    assert.equal(select.options.length, 2) // placeholder + the only non-empty af:za DDraceNetwork server
    assert.ok(select.options[1].textContent.startsWith("<img src=y onerror=alert(2)>ZA(70): <script>alert(3)</script>, p1"))
    assert.ok(select.options[1].textContent.endsWith("..."))
    assert.equal(doc.querySelectorAll("img, select script").length, 0)
    assert.ok(!doc.getElementById("server_names_refresh_button").disabled)

    select.selectedIndex = 1
    w.alerts.length = 0
    w.loadNamesFromSelectedServer()
    assert.equal(inputs().length, 64)
    assert.equal(inputs()[0].value, "<script>alert(3)</script>")
    assert.equal(inputs()[63].value, "p63")
    assert.deepEqual(w.alerts, [])
    assert.equal(w.add_textbox(), false)
    assert.deepEqual(w.alerts, ["Max 64 players allowed."])
})

test("no uncaught page script errors", () => {
    assert.deepEqual(w.jsdom_errors, [])
})

test("works with no map_data at all", async () => {
    const bare = load_page("ddnet.html", { saved_usernames: ["A", "B"], map_data: null })
    assert.equal(bare.document.getElementById("map_data_last_updated_p").textContent, "Map times last updated: ?")
    bare.search()
    await tick()
    assert.deepEqual(bare.alerts, [])
    const times = cell_texts([...bare.document.querySelectorAll("#Novice tr")].slice(1)).map(row => row[3])
    assert.deepEqual(times, ["? / ?", "? / ?", "? / ?"])
    bare.display_results("sorting_median_time")
    assert.deepEqual(bare.jsdom_errors, [])
})
