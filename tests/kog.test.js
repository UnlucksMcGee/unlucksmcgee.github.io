// kog.html (KoG Map Finder) and js/kog_bookmarklet.js
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { JSDOM } = require("jsdom")
const { REPO, XSS_PLAYER, load_page, tick, cell_texts } = require("./helpers")

const PLAYER_HTML = fs.readFileSync(path.join(__dirname, "fixtures", "kog_player.html"), "utf8")
const BOOKMARKLET_JS = fs.readFileSync(path.join(REPO, "js", "kog_bookmarklet.js"), "utf8")
const TARGET = "https://unlucksmcgee.github.io/kog.html"

const EXPECTED_TESTER = {
    "v": 1, "player": "Tester", "rank": 5207, "points": 261,
    "finished": [["Easy1", 470, 1], ["Main1", 4484, 3], ["<b>x</b>", 9, 12]],
}

// ---------- Bookmarklet (runs on kog.tw) ----------

// A kog.tw tab: url's hash picks the page, body is what kog.tw's #content shows
function kog_tab(url, body = "") {
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="content">${body}</div></body>`, { url, runScripts: "outside-only" })
    const w = dom.window
    w.alerts = []
    w.alert = message => w.alerts.push(message)
    w.prompts = []
    w.prompt_answer = null
    w.prompt = (message, default_value) => { w.prompts.push([message, default_value]); return w.prompt_answer }
    w.fetch_log = []
    w.fetch_reply = { ok: true, status: 200, text: PLAYER_HTML }
    w.fetch = url => {
        w.fetch_log.push(String(url))
        const reply = w.fetch_reply
        return reply instanceof Error ? Promise.reject(reply) :
            Promise.resolve({ ok: reply.ok, status: reply.status, text: async () => reply.text })
    }
    w.eval(BOOKMARKLET_JS)
    w.sent = []
    w.run = () => w.kog_bookmarklet(TARGET, url => w.sent.push(url))
    return w
}

function sent_data(url) {
    assert.ok(url.startsWith(TARGET + "#kog_import="), url)
    return JSON.parse(decodeURIComponent(url.split("#kog_import=")[1]))
}

test("bookmarklet on a player page reads it without fetching or asking", () => {
    const w = kog_tab("https://kog.tw/#p=players&player=Tester", PLAYER_HTML)
    w.run()
    assert.equal(w.sent.length, 1)
    assert.deepEqual(sent_data(w.sent[0]), EXPECTED_TESTER)
    assert.deepEqual(w.fetch_log, [])
    assert.deepEqual(w.prompts, [])
})

test("bookmarklet elsewhere on kog.tw asks for a name and loads that player's page", async () => {
    const w = kog_tab("https://kog.tw/#p=index")
    w.prompt_answer = "  Tester "
    w.run()
    assert.equal(w.prompts.length, 1)
    assert.ok(w.document.body.textContent.includes("Loading Tester"))
    await tick()
    assert.deepEqual(w.fetch_log, ["/get.php?p=players&p=players&player=Tester"])
    assert.deepEqual(sent_data(w.sent[0]), EXPECTED_TESTER)
})

test("bookmarklet suggests the shown player's name when their page hasn't loaded yet", () => {
    const w = kog_tab("https://kog.tw/#p=players&player=Some%20One")
    w.run() // prompt cancelled
    assert.deepEqual(w.prompts[0][1], "Some One")
    assert.deepEqual(w.fetch_log, [])
    assert.deepEqual(w.sent, [])
})

test("bookmarklet reports timeouts, HTTP errors, network errors and unknown players", async () => {
    const cases = [
        [{ ok: false, status: 524, text: "error code: 524" }, /took too long/],
        [{ ok: false, status: 500, text: "" }, /HTTP 500/],
        [new TypeError("Failed to fetch"), /Failed to fetch/],
        [{ ok: true, status: 200, text: "" }, /No KoG player called "Nobody"/],
    ]
    for (const [reply, message] of cases) {
        const w = kog_tab("https://kog.tw/#p=index")
        w.prompt_answer = "Nobody"
        w.fetch_reply = reply
        w.run()
        await tick()
        assert.deepEqual(w.sent, [])
        assert.equal(w.alerts.length, 1)
        assert.match(w.alerts[0], message)
        assert.ok(!w.document.body.textContent.includes("Loading"), "banner removed")
    }
})

test("bookmarklet only works on kog.tw", () => {
    const w = kog_tab("https://example.com/#p=players&player=Tester", PLAYER_HTML)
    w.run()
    assert.deepEqual(w.sent, [])
    assert.match(w.alerts[0], /kog\.tw/)
})

// ---------- The page ----------

const import_hash = data => "#kog_import=" + encodeURIComponent(JSON.stringify(data))
const map_rows = d => cell_texts([...d.querySelectorAll("#kog_maps tbody tr")])
const map_names = d => map_rows(d).map(row => row[0])
const saved_players = w => JSON.parse(w.localStorage.getItem("kog_players"))
const player = (name, finished) => ({ name, rank: 1, points: 10, updated: "2026-11-01T00:00:00.000Z", finished })
const finished = (...maps) => Object.fromEntries(maps.map(map => [map, { time: 100, finishes: 1 }]))

test("with no players every map is listed, easiest first, with the how-to open", () => {
    const w = load_page("kog.html")
    const d = w.document
    assert.deepEqual(w.jsdom_errors, [])
    assert.equal(d.querySelector("#kog_maps h3").textContent, "All maps (6)")
    assert.deepEqual(map_rows(d), [
        ["<b>x</b>", "Main", "★☆☆☆☆", "1", "00:05", "00:10 (#3)"],
        ["Easy2", "Easy", "★☆☆☆☆", "2", "00:20", "01:00 (#12)"],
        ["Easy1", "Easy", "★☆☆☆☆", "2", "00:30", "01:30"],
        ["Main1", "Main", "★★☆☆☆", "6", "01:19", "06:40"],
        ["Hard1", "Hard", "★★★★☆", "20", "03:20", "01:01:40"],
        ["Empty", "Solo / Unknown", "★★★★★", "40", "?", "no finishes"],
    ])
    assert.equal(d.querySelectorAll("#kog_maps b").length, 0, "map names are text, not HTML")
    assert.equal(d.querySelector("#kog_maps a").href, "https://kog.tw/#p=maps&map=%3Cb%3Ex%3C%2Fb%3E")
    assert.ok(d.getElementById("kog_add_player").open)
    assert.ok(!d.getElementById("kog_no_players").hidden)
    assert.equal(d.getElementById("map_data_last_updated_p").textContent, "Map times last updated: 4 November 2026")
    assert.ok(d.getElementById("sorting_easiest").checked)
})

test("the bookmark link carries the bookmarklet and this page's address, and clicking it here only explains", () => {
    const w = load_page("kog.html")
    const link = w.document.getElementById("kog_bookmarklet_link")
    const href = link.getAttribute("href")
    assert.ok(href.startsWith("javascript:"))
    const code = decodeURIComponent(href.slice("javascript:".length))
    assert.ok(code.startsWith("(function kog_bookmarklet(target_url, navigate)"))
    assert.ok(code.endsWith(')("https://unlucksmcgee.github.io/kog.html")'))
    link.click()
    assert.equal(w.alerts.length, 1)
})

test("step 2 opens the typed player's page on kog.tw, prefilled with the first saved player", () => {
    const storage = { kog_players: JSON.stringify([player("Some One", {}), player("B", {})]) }
    const w = load_page("kog.html", { storage })
    const d = w.document
    const opened = []
    w.open = (...args) => opened.push(args)
    const input = d.getElementById("kog_open_player_input")
    const submit = () => d.querySelector(".kog_open_player button").click()
    assert.equal(input.value, "Some One")
    submit()
    input.value = "  "
    submit()
    input.value = XSS_PLAYER
    submit()
    assert.deepEqual(opened, [
        ["https://kog.tw/#p=players&player=Some%20One", "_blank", "noopener"],
        ["https://kog.tw/#p=players&player=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E", "_blank", "noopener"],
    ])
    assert.equal(load_page("kog.html").document.getElementById("kog_open_player_input").value, "")
    assert.match(d.getElementById("kog_add_player").textContent, /\(names are case-sensitive\)/)
})

test("an import link from the bookmark adds the player, hides their finished maps and leaves the URL clean", () => {
    const w = load_page("kog.html", { query: import_hash(EXPECTED_TESTER) })
    const d = w.document
    assert.deepEqual(w.jsdom_errors, [])
    assert.equal(w.location.hash, "")
    assert.equal(d.querySelector("#kog_maps h3").textContent, "Unfinished by Tester (3)")
    assert.deepEqual(map_names(d), ["Easy2", "Hard1", "Empty"])
    const saved = saved_players(w)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, "Tester")
    assert.deepEqual(saved[0].finished["Main1"], { time: 4484, finishes: 3 })
    assert.match(d.getElementById("search_notice_text").textContent, /Added Tester: 3 finished maps/)
    assert.match(d.querySelector(".kog_player_details").textContent, /261 pts · #5207 · 3 finished/)
    assert.ok(d.getElementById("kog_no_players").hidden)
})

test("importing a saved player again replaces them in place", () => {
    const storage = { kog_players: JSON.stringify([player("Tester", finished("Easy2")), player("Other", {})]) }
    const w = load_page("kog.html", { storage, query: import_hash(EXPECTED_TESTER) })
    const saved = saved_players(w)
    assert.deepEqual(saved.map(p => p.name), ["Tester", "Other"])
    assert.deepEqual(Object.keys(saved[0].finished), ["Easy1", "Main1", "<b>x</b>"])
    assert.match(w.document.getElementById("search_notice_text").textContent, /Updated Tester/)
})

test("several players: only maps none of them finished; removing a player updates the list", () => {
    const storage = { kog_players: JSON.stringify([player("A", finished("Easy1", "Main1")), player(XSS_PLAYER, finished("Easy2"))]) }
    const w = load_page("kog.html", { storage })
    const d = w.document
    assert.equal(d.querySelector("#kog_maps h3").textContent, "Unfinished by all 2 players (3)")
    assert.deepEqual(map_names(d), ["<b>x</b>", "Hard1", "Empty"])
    assert.equal(d.querySelectorAll("#kog_player_list img").length, 0, "player names are text, not HTML")
    assert.equal(d.querySelectorAll("#kog_player_list input, #kog_player_list .kog_share").length, 0, "no tick boxes or share buttons")

    d.querySelectorAll("#kog_player_list .btn_remove")[0].click()
    assert.deepEqual(saved_players(w).map(p => p.name), [XSS_PLAYER])
    assert.equal(d.querySelector("#kog_maps h3").textContent, "Unfinished by " + XSS_PLAYER + " (5)")
    d.querySelectorAll("#kog_player_list .btn_remove")[0].click()
    assert.equal(d.querySelector("#kog_maps h3").textContent, "All maps (6)")
    assert.ok(!d.getElementById("kog_no_players").hidden)
})

test("every map finished says so", () => {
    const storage = { kog_players: JSON.stringify([player("A", finished("Easy1", "Easy2", "Main1", "Hard1", "Empty", "<b>x</b>"))]) }
    const w = load_page("kog.html", { storage })
    assert.match(w.document.getElementById("map_results_div").textContent, /every map in these categories is finished/)
})

test("category checkboxes filter the list and are remembered", () => {
    const w = load_page("kog.html")
    const d = w.document
    const boxes = () => [...d.querySelectorAll("#kog_category_filter input")]
    assert.deepEqual(boxes().map(b => b.value), ["Easy", "Main", "Hard", "Unknown"])
    assert.equal(d.querySelectorAll("#kog_category_filter label")[3].textContent, " Solo / Unknown")
    boxes()[1].click() // hide Main
    assert.deepEqual(map_names(d), ["Easy2", "Easy1", "Hard1", "Empty"])
    assert.equal(w.localStorage.getItem("kog_hidden_categories"), '["Main"]')

    const again = load_page("kog.html", { storage: { kog_hidden_categories: '["Main","Easy"]' } })
    assert.deepEqual(map_names(again.document), ["Hard1", "Empty"])
    assert.deepEqual([...again.document.querySelectorAll("#kog_category_filter input")].map(b => b.checked), [false, false, true, true])
})

test("sort options", () => {
    const w = load_page("kog.html")
    const d = w.document
    const order = id => { d.getElementById(id).click(); return map_names(d) }
    assert.deepEqual(order("sorting_last_time"), ["<b>x</b>", "Easy2", "Easy1", "Main1", "Hard1", "Empty"])
    assert.deepEqual(order("sorting_top_time"), ["<b>x</b>", "Easy2", "Easy1", "Main1", "Hard1", "Empty"])
    assert.deepEqual(order("sorting_points"), ["<b>x</b>", "Easy1", "Easy2", "Main1", "Hard1", "Empty"])
    assert.deepEqual(order("sorting_newest"), ["Easy2", "<b>x</b>", "Main1", "Easy1", "Empty", "Hard1"])
    assert.deepEqual(order("sorting_name"), ["<b>x</b>", "Easy1", "Easy2", "Empty", "Hard1", "Main1"])
    assert.equal(d.getElementById("sort_description").textContent, "Alphabetical by map name")
})

test("broken saved data is ignored", () => {
    const w = load_page("kog.html", { storage: { kog_players: "{nope", kog_hidden_categories: "7" } })
    assert.deepEqual(w.jsdom_errors, [])
    assert.equal(w.document.querySelector("#kog_maps h3").textContent, "All maps (6)")
})

test("missing map data shows a message instead of an empty table", () => {
    const w = load_page("kog.html", { kog_map_data: null })
    assert.deepEqual(w.jsdom_errors, [])
    assert.match(w.document.getElementById("map_results_div").textContent, /couldn't be loaded/)
    assert.equal(w.document.getElementById("map_data_last_updated_p").textContent, "Map times last updated: ?")
})
