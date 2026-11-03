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
const notice = () => doc.getElementById("search_notice")
const notice_items = () => [...doc.querySelectorAll("#search_notice_list li")].map(li => li.textContent)
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

test("Global region by default: no server option, chip says Global", () => {
    assert.equal(doc.body.getAttribute("data-region"), "global")
    assert.equal(doc.getElementById("region_button_label").textContent, "Global")
    assert.ok(doc.getElementById("server_loader_toggle").classList.contains("country_only"))
    assert.ok(doc.getElementById("server_names_div").hidden)
    assert.equal(doc.querySelectorAll('script[src*="zaf"]').length, 0)
})

test("region chip menu lists Global plus countries from the master list, XSS-safe", async () => {
    const page = load_page("ddnet.html")
    const d = page.document
    page.fetch_log.length = 0
    d.getElementById("region_button").click()
    assert.ok(!d.getElementById("region_menu").hidden)
    assert.equal(d.getElementById("region_button").getAttribute("aria-expanded"), "true")
    assert.match(d.getElementById("region_menu_list").textContent, /Loading countries/)
    await tick()
    assert.deepEqual(page.fetch_log, ["https://master1.ddnet.org/ddnet/15/servers.json"])
    const options = [...d.querySelectorAll(".region_option")]
    // most players online first: South Africa (70) before Germany (1)
    assert.deepEqual(options.map(o => o.getAttribute("data-region")), ["global", "za", "de"])
    assert.equal(options[1].textContent, "South Africa70 online")
    assert.equal(options[0].getAttribute("aria-pressed"), "true")
    assert.equal(d.querySelectorAll("#region_menu img").length, 0)

    // picking a country: saved, in the URL, shows the server option, closes the menu
    options[1].click()
    assert.ok(d.getElementById("region_menu").hidden)
    assert.equal(d.body.getAttribute("data-region"), "country")
    assert.equal(d.getElementById("region_button_label").textContent, "South Africa")
    assert.equal(page.location.search, "?region=za")
    assert.equal(page.localStorage.getItem("ddnet_region"), "za")

    // the list is fetched only once per page; Escape and outside clicks close the menu
    d.getElementById("region_button").click()
    await tick()
    assert.equal(page.fetch_log.length, 1)
    assert.equal(d.querySelector('.region_option[aria-pressed="true"]').getAttribute("data-region"), "za")
    d.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape" }))
    assert.ok(d.getElementById("region_menu").hidden)
    d.getElementById("region_button").click()
    d.getElementById("search_button").parentElement.dispatchEvent(new page.MouseEvent("click", { bubbles: true }))
    assert.ok(d.getElementById("region_menu").hidden)

    // back to Global: removed from the URL, saved
    page.set_region("global")
    assert.equal(page.location.search, "")
    assert.equal(page.localStorage.getItem("ddnet_region"), "global")
    assert.deepEqual(page.jsdom_errors, [])
})

test("region comes from the URL first, then storage; mode and region share the URL", () => {
    const saved = load_page("ddnet.html", { saved_region: "de" })
    assert.equal(saved.document.getElementById("region_button_label").textContent, "Germany")
    assert.equal(saved.location.search, "?region=de")

    const linked = load_page("ddnet.html", { saved_region: "de", query: "?region=ZA" })
    assert.equal(linked.document.getElementById("region_button_label").textContent, "South Africa")
    assert.equal(linked.localStorage.getItem("ddnet_region"), "de") // a link applies to that visit, it doesn't overwrite the saved choice
    linked.set_mode("rank")
    assert.equal(linked.location.search, "?region=za&mode=rank")

    const junk = load_page("ddnet.html", { saved_region: "<b>", query: "?region=nowhere" })
    assert.equal(junk.document.body.getAttribute("data-region"), "global")
    assert.equal(junk.location.search, "")
    for (const page of [saved, linked, junk]) assert.deepEqual(page.jsdom_errors, [])
})

test("server option lists only the chosen country's servers", async () => {
    const page = load_page("ddnet.html", { query: "?region=de" })
    const d = page.document
    d.getElementById("server_loader_toggle").click()
    assert.ok(!d.getElementById("server_names_div").hidden)
    assert.equal(d.getElementById("server_panel_title").textContent, "Players on a server in Germany")
    await tick()
    const select = d.getElementById("server_selection_dropdown")
    assert.deepEqual([...select.options].map(o => o.textContent), ["Select server", "DE(1): q"])

    // an older load that fails after a newer one succeeded doesn't overwrite it
    let fail_first
    page.fetch = url => url.startsWith("https://master1.") && !fail_first
        ? new Promise((resolve, reject) => { fail_first = () => reject(new Error("late failure")) })
        : page.mock_fetch(url)
    page.loadServerNames() // will fail later
    page.loadServerNames() // succeeds now
    await tick()
    fail_first()
    await tick()
    assert.deepEqual([...select.options].map(o => o.textContent), ["Select server", "DE(1): q"])
    page.fetch = page.mock_fetch

    // no players online in the country
    page.set_region("fr")
    assert.ok(d.getElementById("server_names_div").hidden) // changing country closes the panel
    d.getElementById("server_loader_toggle").click()
    await tick()
    assert.deepEqual([...select.options].map(o => o.textContent), ["No players online in France right now"])
    assert.deepEqual(page.jsdom_errors, [])
})

test("search_ddnet_players: encoded URL, keeps name and numeric points only", async () => {
    w.fetch_log.length = 0
    const results = await w.search_ddnet_players("<img")
    assert.deepEqual(w.fetch_log, ["https://ddnet.org/players/?query=%3Cimg"])
    assert.deepEqual(JSON.parse(JSON.stringify(results)), [{ name: XSS_PLAYER, points: 1 }])
    const no_points = await w.search_ddnet_players("NoPoints")
    assert.equal(no_points[0].points, null)
    const real_fetch = w.fetch
    w.fetch = () => Promise.resolve({ ok: false, status: 503, json: async () => [] })
    try {
        await assert.rejects(w.search_ddnet_players("x"), /HTTP 503/)
    } finally {
        w.fetch = real_fetch
    }
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

test("players that can't be loaded are skipped and flagged; results show for the rest", async () => {
    set_names(["A", "NoSuchPlayer", "Http500", "", "NetFail", "B"])
    w.alerts.length = 0
    w.search()
    await tick()
    assert.deepEqual(w.alerts, [])
    assert.equal(doc.getElementById("results_section_div").style.display, "block")
    // A and B loaded: their common unfinished maps are shown
    assert.deepEqual([...doc.querySelectorAll("#player_results_div a")].map(a => a.textContent), ["A (42pts)", "B (42pts)"])
    assert.deepEqual([...doc.querySelectorAll(".map_section")].map(s => s.id), ["Novice"])

    assert.ok(!notice().hidden)
    assert.ok(notice().classList.contains("notice_warning"))
    assert.equal(doc.getElementById("search_notice_text").textContent, "Skipped 3 of 5 players, showing results for the rest:")
    const items = notice_items()
    assert.equal(items.length, 3)
    assert.match(items[0], /^NoSuchPlayer: not found on ddnet\.org/)
    assert.equal(items[1], "Http500: ddnet.org error (HTTP 500)")
    assert.equal(items[2], "NetFail: couldn't reach ddnet.org")
    const flagged = () => inputs().filter(i => i.classList.contains("input_error")).map(i => i.value)
    assert.deepEqual(flagged(), ["NoSuchPlayer", "Http500", "NetFail"])
    assert.equal(inputs()[1].getAttribute("aria-invalid"), "true")
    // the empty box was skipped and isn't saved
    assert.deepEqual(JSON.parse(w.localStorage.getItem("usernames")), ["A", "NoSuchPlayer", "Http500", "NetFail", "B"])

    // editing a flagged name unflags it
    inputs()[2].value = "Http5000"
    inputs()[2].dispatchEvent(new w.Event("input", { bubbles: true }))
    assert.deepEqual(flagged(), ["NoSuchPlayer", "NetFail"])

    // one click removes the remaining flagged rows
    assert.ok(!doc.getElementById("remove_skipped_button").hidden)
    doc.getElementById("remove_skipped_button").click()
    assert.deepEqual(inputs().map(i => i.value), ["A", "Http5000", "", "B"])
    assert.ok(notice().hidden)
    assert.deepEqual(JSON.parse(w.localStorage.getItem("usernames")), ["A", "Http5000", "B"])
})

test("when nobody can be loaded, or no names are entered, a message replaces the results", async () => {
    set_names(["NoSuchPlayer", "NoSuchPlayer"])
    w.search()
    await tick()
    assert.deepEqual(w.alerts, [])
    assert.equal(doc.getElementById("results_section_div").style.display, "none")
    assert.ok(notice().classList.contains("notice_error"))
    assert.equal(doc.getElementById("search_notice_text").textContent, "None of the players could be loaded:")
    assert.equal(notice_items().length, 1) // the duplicate is listed once

    set_names(["", " "])
    w.search()
    assert.deepEqual(w.alerts, [])
    assert.equal(doc.getElementById("search_notice_text").textContent, "Enter at least one player name to search.")
    assert.equal(notice_items().length, 0)
    assert.ok(doc.getElementById("remove_skipped_button").hidden)

    // a successful search clears the notice
    set_names(["A"])
    w.search()
    await tick()
    assert.ok(notice().hidden)
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

    set_names(["NoSuchPlayer", "NoSuchPlayer"])
    w.search()
    assert.ok(button.disabled)
    await tick()
    assert.ok(!button.disabled)
    assert.ok(!notice().hidden)
    assert.deepEqual(w.alerts, [])
})

test("server dropdown is XSS-safe; 70 names are capped at 64 without hanging", { timeout: 5000 }, async () => {
    w.set_region("za")
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
