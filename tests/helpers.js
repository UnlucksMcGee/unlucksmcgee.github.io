// Shared test setup: loads a site page into jsdom with a stand-in map_data, a fully mocked fetch
// (no network access) and a silenced console.
const fs = require("node:fs")
const path = require("node:path")
const { JSDOM, VirtualConsole } = require("jsdom")

const REPO = path.resolve(__dirname, "..")

// Stand-in for js/map_data.js (which is regenerated monthly), in the same format
const STAND_IN_MAP_DATA = `const map_data_last_updated = "3 November 2026";
const map_data = {
    "Alpha": {"median_time": 100, "top_time": 50},
    "Beta": {"median_time": 4000, "top_time": null},
    "Gamma": {"median_time": null, "top_time": 3700},
    "<b>x</b>": {"median_time": 10, "top_time": 5},
    "Diversity": {"median_time": 1533.1, "top_time": 85.44}
};`

const XSS_PLAYER = "<img src=x onerror=alert(1)>"

function make_player(types, points = 42) {
    const out = { player: "x", points: { points }, types: {} }
    for (const [type, maps] of Object.entries(types)) {
        out.types[type] = { maps: { ...maps } }
    }
    return out
}

const unfinished = (points, total_finishes) => ({ points, total_finishes, finishes: 0 })

const rank_player = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "player_rank.json"), "utf8"))

const players = {
    "A": make_player({
        "Novice": { "Alpha": unfinished(1, 100), "Beta": unfinished(1, 500), "Gamma": unfinished(5, 10), "Zeta": unfinished(0, 1), "Done": { points: 1, total_finishes: 1, finishes: 3 } },
        "Brutal": { "Hard": unfinished(30, 3) },
    }),
    "B": make_player({
        "Novice": { "Alpha": unfinished(1, 100), "Beta": unfinished(1, 500), "Gamma": unfinished(5, 10), "Zeta": { points: 0, total_finishes: 1, finishes: 2 } },
        // no Brutal type
        "Solo": { "SoloMap": unfinished(2, 9) }, // a type the first player lacks
    }),
    [XSS_PLAYER]: make_player({
        "Novice": { "Alpha": unfinished(1, 100), "Beta": unfinished(1, 500), "Gamma": unfinished(5, 10), "<b>x</b>": unfinished(9, 9) },
        "Brutal": { "Hard": unfinished(30, 3) },
    }),
    [rank_player.player]: rank_player,
}

const servers_json = {
    servers: [
        { location: "af:za", info: { name: "<img src=y onerror=alert(2)>ZA", game_type: "DDraceNetwork", clients: Array.from({ length: 70 }, (_, i) => ({ name: i == 0 ? "<script>alert(3)</script>" : "p" + i })) } },
        { location: "eu:de", info: { name: "DE", game_type: "DDraceNetwork", clients: [{ name: "q" }] } },
        { location: "af:za", info: { name: "Empty", game_type: "DDraceNetwork", clients: [] } },
    ],
}

// What the mocked ddnet.org player search (?query=) can return
const search_results = [
    { name: "UnlucksMcGee", points: 5846 },
    { name: XSS_PLAYER, points: 1 },
    { name: "NoPoints", points: "?" },
]

const ok = body => Promise.resolve({ ok: true, status: 200, json: async () => body })

// Mock for window.fetch. Every URL is logged; anything unexpected throws so a test can't silently hit the network.
function make_mock_fetch(log) {
    return function mock_fetch(url) {
        url = String(url)
        log.push(url)
        if (url.startsWith("https://master1.ddnet.org/")) return ok(servers_json)
        if (url.startsWith("https://ddnet.org/players/?query=")) {
            const query = decodeURIComponent(url.split("?query=")[1]).toLowerCase()
            return ok(search_results.filter(result => result.name.toLowerCase().includes(query)))
        }
        if (!url.startsWith("https://ddnet.org/players/?json2=")) return Promise.reject(new Error("unexpected fetch in test: " + url))
        const name = decodeURIComponent(url.split("?json2=")[1])
        if (name == "NetFail") return Promise.reject(new TypeError("Failed to fetch"))
        if (name == "Http500") return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
        return ok(players[name] || {}) // ddnet.org returns {} for unknown players
    }
}

function silent_console(window_errors) {
    const virtual_console = new VirtualConsole()
    // Page console.log/error output (expected errors from failure tests) is dropped.
    // jsdom's own errors (uncaught exceptions in page scripts) are collected so tests can assert none happened.
    virtual_console.on("jsdomError", err => window_errors.push(err))
    return virtual_console
}

// Loads a page (query e.g. "?mode=rank" is added to its URL) with its local js/ scripts inlined (js/map_data.js replaced by the stand-in, or dropped
// when map_data is null) and the Google Analytics snippet removed.
function load_page(file, { saved_usernames = null, saved_region = null, map_data = STAND_IN_MAP_DATA, query = "" } = {}) {
    let html = fs.readFileSync(path.join(REPO, file), "utf8")
    const scripts = []
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (all, attrs, body) => {
        const src = /src="([^"]+)"/.exec(attrs)
        if (src && src[1] == "js/map_data.js") {
            if (map_data !== null) scripts.push(map_data)
        } else if (src && src[1].startsWith("js/")) {
            scripts.push(fs.readFileSync(path.join(REPO, src[1]), "utf8"))
        } else if (!src && !body.includes("gtag")) {
            scripts.push(body)
        }
        return ""
    })
    const errors = []
    const dom = new JSDOM(html, {
        runScripts: "dangerously",
        url: "https://unlucksmcgee.github.io/" + file + query,
        virtualConsole: silent_console(errors),
    })
    const w = dom.window
    w.jsdom_errors = errors
    w.alerts = []
    w.alert = message => w.alerts.push(message)
    w.fetch_log = []
    w.mock_fetch = make_mock_fetch(w.fetch_log)
    w.fetch = w.mock_fetch
    w.HTMLElement.prototype.scrollIntoView = function () {}
    if (saved_usernames) w.localStorage.setItem("usernames", JSON.stringify(saved_usernames))
    if (saved_region) w.localStorage.setItem("ddnet_region", saved_region)
    for (const source of scripts) {
        const element = w.document.createElement("script")
        element.textContent = source
        w.document.body.appendChild(element)
    }
    return w
}

// Lets the mocked fetches and the page's promise chains settle
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

const cell_texts = rows => rows.map(tr => [...tr.children].map(td => td.textContent))

module.exports = { REPO, STAND_IN_MAP_DATA, XSS_PLAYER, players, search_results, rank_player, load_page, tick, cell_texts }
