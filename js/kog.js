// Helpers for kog.html (KoG Map Finder). Plain global functions (classic <script>, no modules).
// Load after js/kog_map_data.js, js/ddnet_common.js (format_time, compare_nullable_numbers, ...)
// and js/kog_bookmarklet.js.
// Player names and map names are untrusted: build DOM nodes and use textContent, never innerHTML.

const KOG_SITE_URL = "https://kog.tw/"
const KOG_SAVED_PLAYERS_KEY = "kog_players"
const KOG_HIDDEN_CATEGORIES_KEY = "kog_hidden_categories"
const KOG_IMPORT_HASH_KEY = "kog_import"
// Categories in this order first; any others (e.g. ones KoG adds later) follow alphabetically
const KOG_CATEGORY_ORDER = ["Easy", "Main", "Hard", "Insane", "Extreme", "Mod", "Unknown"]
// Display names for KoG's categories. kog.tw's map list calls its Solo maps (and a few others) "Unknown";
// its player pages count 37 "Sol" maps against 41 "Unknown" ones, and nothing says which 4 aren't Solo.
const KOG_CATEGORY_LABELS = { "Unknown": "Solo / Unknown" }
// KoG map pages list the top 99 finishers
const KOG_LEADERBOARD_SIZE = 99

// ---------- URLs ----------

function kog_map_url(map_name) {
    return KOG_SITE_URL + "#p=maps&map=" + encodeURIComponent(map_name)
}

function kog_player_url(player_name) {
    return KOG_SITE_URL + "#p=players&player=" + encodeURIComponent(player_name)
}

// "javascript:" URL for the bookmarklet, sending players back to target_url (this page)
function kog_bookmarklet_href(target_url) {
    return "javascript:" + encodeURIComponent("(" + kog_bookmarklet.toString() + ")(" + JSON.stringify(target_url) + ")")
}

// ---------- kog_map_data (js/kog_map_data.js) ----------

function get_kog_maps() {
    return (typeof kog_map_data === "object" && kog_map_data !== null) ? kog_map_data : {}
}

function get_kog_map(map_name) {
    const maps = get_kog_maps()
    return Object.prototype.hasOwnProperty.call(maps, map_name) ? maps[map_name] : null
}

function get_kog_map_data_last_updated() {
    return (typeof kog_map_data_last_updated === "string") ? kog_map_data_last_updated : "?"
}

// Categories present in the map data, in KOG_CATEGORY_ORDER then alphabetically
function kog_categories() {
    const found = new Set(Object.values(get_kog_maps()).map(map => map && map["category"]).filter(c => typeof c === "string"))
    const known = KOG_CATEGORY_ORDER.filter(c => found.has(c))
    const others = [...found].filter(c => !KOG_CATEGORY_ORDER.includes(c)).sort((a, b) => a.localeCompare(b))
    return known.concat(others)
}

function kog_category_label(category) {
    return Object.prototype.hasOwnProperty.call(KOG_CATEGORY_LABELS, category) ? KOG_CATEGORY_LABELS[category] : format_value(category)
}

// ---------- Importing players (from the bookmarklet) ----------

// Reads what the bookmarklet sends: "#kog_import=<JSON>" (or the whole link, or just the JSON).
// Returns {name, rank, points, finished: {map: {time, finishes}}}; throws an Error with a readable message.
function parse_kog_import(text) {
    let json_text = String(text || "").trim()
    const hash_index = json_text.indexOf(KOG_IMPORT_HASH_KEY + "=")
    if (hash_index !== -1) {
        try {
            json_text = decodeURIComponent(json_text.slice(hash_index + KOG_IMPORT_HASH_KEY.length + 1))
        } catch (err) {
            throw new Error("The import link is damaged (it may have been cut short).")
        }
    }
    let data
    try {
        data = JSON.parse(json_text)
    } catch (err) {
        throw new Error("That isn't an import link from the bookmark.")
    }
    if (!data || typeof data !== "object" || typeof data["player"] !== "string" || !data["player"] || !Array.isArray(data["finished"])) {
        throw new Error("That import link has no player data.")
    }
    const finished = {}
    for (const entry of data["finished"]) {
        if (Array.isArray(entry) && typeof entry[0] === "string") {
            finished[entry[0]] = {
                "time": is_valid_number(entry[1]) ? entry[1] : null,
                "finishes": is_valid_number(entry[2]) ? entry[2] : null,
            }
        }
    }
    return {
        "name": data["player"],
        "rank": is_valid_number(data["rank"]) ? data["rank"] : null,
        "points": is_valid_number(data["points"]) ? data["points"] : null,
        "finished": finished,
    }
}

// ---------- Saved players (localStorage) ----------

// [{name, rank, points, updated (ISO date), finished}] in the order they were added
function load_kog_players() {
    try {
        const saved = JSON.parse(localStorage.getItem(KOG_SAVED_PLAYERS_KEY))
        if (!Array.isArray(saved)) {
            return []
        }
        return saved.filter(p => p && typeof p["name"] === "string" && p["finished"] && typeof p["finished"] === "object")
    } catch (err) {
        return []
    }
}

function save_kog_players(players) {
    try {
        localStorage.setItem(KOG_SAVED_PLAYERS_KEY, JSON.stringify(players))
        return true
    } catch (err) {
        console.log("Could not save players", err)
        return false
    }
}

// Adds an imported player, or replaces the saved one with the same name (keeping its place)
function upsert_kog_player(players, imported, now) {
    const entry = { ...imported, "updated": now.toISOString() }
    const index = players.findIndex(p => p["name"] === imported["name"])
    if (index === -1) {
        return players.concat([entry])
    }
    const copy = players.slice()
    copy[index] = entry
    return copy
}

function load_hidden_categories() {
    try {
        const saved = JSON.parse(localStorage.getItem(KOG_HIDDEN_CATEGORIES_KEY))
        return Array.isArray(saved) ? saved.filter(c => typeof c === "string") : []
    } catch (err) {
        return []
    }
}

function save_hidden_categories(categories) {
    try {
        localStorage.setItem(KOG_HIDDEN_CATEGORIES_KEY, JSON.stringify(categories))
    } catch (err) {
        console.log("Could not save categories", err)
    }
}

// ---------- Finding maps ----------

// Names of maps in kog_map_data that none of the players has finished, in categories not hidden
function find_kog_unfinished_maps(players, hidden_categories) {
    const hidden = new Set(hidden_categories)
    return Object.keys(get_kog_maps()).filter(map_name => {
        const map = get_kog_map(map_name)
        if (!map || hidden.has(map["category"])) {
            return false
        }
        return players.every(player => !Object.prototype.hasOwnProperty.call(player["finished"], map_name))
    })
}

function get_kog_comparator(sort_id) {
    const value = (map_name, key) => {
        const map = get_kog_map(map_name)
        return map ? map[key] : null
    }
    const by = key => (a, b) => compare_nullable_numbers(value(a, key), value(b, key))
    const by_name = (a, b) => a.localeCompare(b, undefined, { numeric: true })
    switch (sort_id) {
        case "sorting_easiest":
            return (a, b) => by("stars")(a, b) || by("points")(a, b) || by("last_time")(a, b) || by_name(a, b)
        case "sorting_last_time":
            return (a, b) => by("last_time")(a, b) || by_name(a, b)
        case "sorting_top_time":
            return (a, b) => by("top_time")(a, b) || by_name(a, b)
        case "sorting_points":
            return (a, b) => by("points")(a, b) || by_name(a, b)
        case "sorting_name":
            return by_name
        case "sorting_newest":
            // ISO dates compare as strings; maps without a date go last
            return (a, b) => {
                const da = value(a, "released") || ""
                const db = value(b, "released") || ""
                return (da === db) ? by_name(a, b) : (da && db ? db.localeCompare(da) : (da ? -1 : 1))
            }
        default:
            throw new Error("Unknown sort option: " + sort_id)
    }
}

// ---------- Formatting ----------

function format_stars(stars) {
    if (!is_valid_number(stars)) {
        return "?"
    }
    const filled = Math.max(0, Math.min(5, Math.round(stars)))
    return "★".repeat(filled) + "☆".repeat(5 - filled)
}

// The 99th place time, or the slowest listed time with its place when fewer than 99 have finished
function format_last_place(map) {
    if (!map || !is_valid_number(map["last_time"])) {
        return "no finishes"
    }
    const time = format_time(map["last_time"])
    if (is_valid_number(map["last_rank"]) && map["last_rank"] < KOG_LEADERBOARD_SIZE) {
        return time + " (#" + map["last_rank"] + ")"
    }
    return time
}

// "2026-11-04T10:00:00.000Z" -> "4 Nov 2026"
function format_short_date(iso) {
    const date = new Date(iso)
    if (isNaN(date.getTime())) {
        return "?"
    }
    return date.getDate() + " " + date.toLocaleString("en", { month: "short" }) + " " + date.getFullYear()
}

function create_kog_link(href, text, title) {
    const link = document.createElement("a")
    link.href = href
    link.target = "_blank"
    link.rel = "noopener"
    link.textContent = text
    if (title) {
        link.title = title
    }
    return link
}
