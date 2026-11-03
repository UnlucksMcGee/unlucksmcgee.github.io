// Shared helpers for ddnet.html and ddnet_rank.html.
// Plain global functions (classic <script>, no modules). Load after js/map_data.js.
// Never put untrusted strings (usernames, map names, server/player names) into innerHTML:
// everything here builds DOM nodes and uses textContent.

const DDNET_PLAYER_JSON_URL = "https://ddnet.org/players/?json2="
const DDNET_MAX_CONCURRENT_FETCHES = 8
const DDNET_SAVED_USERNAMES_KEY = "usernames"

// ---------- URLs ----------

// Same slug encoding as ddnet.org: every char outside [0-9A-Za-z~] becomes -<codepoint>- (decimal).
// Iterates by code point so astral chars give one -<codepoint>- like Python's ord().
// '~' is kept as-is: ddnet.org's own map links do this (e.g. "~AuTuMn~" -> /maps/~AuTuMn~).
function ddnet_slugify(name) {
    let result = ""
    for (const char of String(name)) {
        const code_point = char.codePointAt(0)
        if ((code_point >= 48 && code_point <= 57) || // 0-9
            (code_point >= 65 && code_point <= 90) || // A-Z
            (code_point >= 97 && code_point <= 122) || // a-z
            code_point === 126) { // ~
            result += char
        } else {
            result += "-" + code_point + "-"
        }
    }
    return result
}

function ddnet_map_url(map_name) {
    return "https://ddnet.org/maps/" + ddnet_slugify(map_name)
}

function ddnet_player_url(username) {
    return "https://ddnet.org/players/" + ddnet_slugify(username)
}

// ---------- Formatting ----------

function is_valid_number(value) {
    return typeof value === "number" && isFinite(value)
}

// Seconds -> "mm:ss" under an hour, else "hh:mm:ss". Fractions are truncated. null/invalid -> "?"
function format_time(seconds) {
    if (!is_valid_number(seconds) || seconds < 0) {
        return "?"
    }
    const total_seconds = Math.floor(seconds)
    const hours = Math.floor(total_seconds / 3600)
    const minutes = Math.floor((total_seconds % 3600) / 60)
    const secs = total_seconds % 60
    const mm_ss = String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0")
    if (hours === 0) {
        return mm_ss
    }
    return String(hours).padStart(2, "0") + ":" + mm_ss
}

function format_value(value) {
    return (value === null || value === undefined) ? "?" : String(value)
}

// Percentile where rank 1 = 100 and last place = 0. A single finisher is 100.
function rank_percentile(rank, total_finishes) {
    if (!is_valid_number(rank) || !is_valid_number(total_finishes) || total_finishes < 1) {
        return null
    }
    if (total_finishes <= 1) {
        return 100
    }
    return (total_finishes - rank) / (total_finishes - 1) * 100
}

function format_percentile(percentile) {
    if (!is_valid_number(percentile)) {
        return "?"
    }
    return (Math.floor(percentile * 10) / 10).toFixed(1)
}

// ---------- map_data lookups (js/map_data.js) ----------

function get_map_data_entry(map_name) {
    if (typeof map_data !== "object" || map_data === null) {
        return null
    }
    if (!Object.prototype.hasOwnProperty.call(map_data, map_name)) {
        return null
    }
    return map_data[map_name] || null
}

function get_map_data_value(map_name, key) {
    const entry = get_map_data_entry(map_name)
    if (entry === null || !is_valid_number(entry[key])) {
        return null
    }
    return entry[key]
}

function get_median_time(map_name) {
    return get_map_data_value(map_name, "median_time")
}

function get_top_time(map_name) {
    return get_map_data_value(map_name, "top_time")
}

function get_map_data_last_updated() {
    return (typeof map_data_last_updated === "string") ? map_data_last_updated : "?"
}

// ---------- Fetching player data ----------

// Resolves to the player's json2 object, or rejects with an Error whose message names the player
// and says what went wrong (network, HTTP status, bad JSON, or not found).
async function fetch_player_json(username) {
    let response
    try {
        response = await fetch(DDNET_PLAYER_JSON_URL + encodeURIComponent(username))
    } catch (err) {
        throw new Error("Network error while loading \"" + username + "\" (ddnet.org unreachable or blocked)")
    }
    if (!response.ok) {
        throw new Error("ddnet.org returned HTTP " + response.status + " for \"" + username + "\"")
    }
    let player_json
    try {
        player_json = await response.json()
    } catch (err) {
        throw new Error("ddnet.org sent invalid data for \"" + username + "\"")
    }
    // ddnet.org returns an empty object (HTTP 200) for unknown players
    if (player_json === null || typeof player_json !== "object" || Object.keys(player_json).length === 0) {
        throw new Error("Player not found: \"" + username + "\" (names are case-sensitive)")
    }
    if (typeof player_json["types"] !== "object" || player_json["types"] === null) {
        throw new Error("Unexpected data format from ddnet.org for \"" + username + "\"")
    }
    return player_json
}

// Fetches all players, at most DDNET_MAX_CONCURRENT_FETCHES at a time.
// Never rejects: resolves to [{username, json, error}] in input order (error is null on success).
async function fetch_all_players_json(usernames) {
    // Fetch each distinct name only once, then map the results back to input order
    const unique_usernames = [...new Set(usernames)]
    const unique_results = new Array(unique_usernames.length)
    let next_index = 0
    async function worker() {
        while (next_index < unique_usernames.length) {
            const index = next_index++
            const username = unique_usernames[index]
            try {
                unique_results[index] = { "username": username, "json": await fetch_player_json(username), "error": null }
            } catch (err) {
                unique_results[index] = { "username": username, "json": null, "error": err }
            }
        }
    }
    const worker_count = Math.min(DDNET_MAX_CONCURRENT_FETCHES, unique_usernames.length)
    const workers = []
    for (let i = 0; i < worker_count; i++) {
        workers.push(worker())
    }
    await Promise.all(workers)
    return usernames.map(username => unique_results[unique_usernames.indexOf(username)])
}

function get_player_points(player_json) {
    const points = player_json && player_json["points"]
    return (points && is_valid_number(points["points"])) ? points["points"] : null
}

// ---------- Sorting ----------

// Ascending numeric compare with null/undefined/NaN always last.
function compare_nullable_numbers(a, b) {
    const a_valid = is_valid_number(a)
    const b_valid = is_valid_number(b)
    if (!a_valid && !b_valid) return 0
    if (!a_valid) return 1
    if (!b_valid) return -1
    return a - b
}

// Returns a comparator over map names. details maps map name -> {points, total_finishes, rank_percentile?}
function get_map_comparator(sort_id, details) {
    const detail = (map_name, key) => (details[map_name] ? details[map_name][key] : null)
    const descending = (a, b) => (is_valid_number(a) && is_valid_number(b)) ? b - a : compare_nullable_numbers(a, b)
    switch (sort_id) {
        case "sorting_easiest":
            // Least points first, then most finishes
            return (a, b) => compare_nullable_numbers(detail(a, "points"), detail(b, "points")) ||
                descending(detail(a, "total_finishes"), detail(b, "total_finishes"))
        case "sorting_name":
            return (a, b) => a.localeCompare(b, undefined, { numeric: true })
        case "sorting_most_finishes":
            return (a, b) => descending(detail(a, "total_finishes"), detail(b, "total_finishes"))
        case "sorting_median_time":
            return (a, b) => compare_nullable_numbers(get_median_time(a), get_median_time(b))
        case "sorting_percentile":
            return (a, b) => compare_nullable_numbers(detail(a, "rank_percentile"), detail(b, "rank_percentile"))
        default:
            throw new Error("Unknown sort option: " + sort_id)
    }
}

// ---------- Rendering ----------

function clear_element(element) {
    element.replaceChildren()
}

function show_loading_spinner(element) {
    const spinner = document.createElement("div")
    spinner.className = "loading-spinner"
    element.replaceChildren(spinner)
}

// Checks the chosen sort option and shows its data-description under the options
function select_sorting_radio(radio_button_id) {
    let description = ""
    for (const radio_button of document.getElementsByName("sorting_list")) {
        radio_button.checked = (radio_button.id === radio_button_id)
        if (radio_button.checked) {
            description = radio_button.getAttribute("data-description") || ""
        }
    }
    const description_element = document.getElementById("sort_description")
    if (description_element) {
        description_element.textContent = description
    }
}

function create_player_link(username, points) {
    const link = document.createElement("a")
    link.href = ddnet_player_url(username)
    link.target = "_blank"
    link.rel = "noopener"
    link.title = "Open player page on ddnet.org"
    link.className = "player_link"
    link.textContent = username + " (" + format_value(points) + "pts)"
    return link
}

function create_map_link(map_name) {
    const link = document.createElement("a")
    link.href = ddnet_map_url(map_name)
    link.target = "_blank"
    link.rel = "noopener"
    link.textContent = map_name
    return link
}

// rows: array of arrays of cells; a cell is a Node or a value shown as text.
function create_map_section(server_type, header_titles, rows) {
    const section_div = document.createElement("div")
    section_div.className = "map_section"
    section_div.id = server_type

    const header = document.createElement("h3")
    header.textContent = server_type + " (" + rows.length + ")"

    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const header_row = document.createElement("tr")
    for (const header_title of header_titles) {
        const th = document.createElement("th")
        th.scope = "col"
        th.textContent = header_title
        header_row.appendChild(th)
    }
    thead.appendChild(header_row)
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const row of rows) {
        const tr = document.createElement("tr")
        for (const cell of row) {
            const td = document.createElement("td")
            if (cell instanceof Node) {
                td.appendChild(cell)
            } else {
                td.textContent = format_value(cell)
            }
            tr.appendChild(td)
        }
        tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    // Only the table scrolls, so the title and (sticky) column headers stay visible
    const table_scroll = document.createElement("div")
    table_scroll.className = "table_scroll"
    table_scroll.appendChild(table)

    section_div.appendChild(header)
    section_div.appendChild(table_scroll)
    return section_div
}

function show_map_data_last_updated() {
    const paragraph = document.getElementById("map_data_last_updated_p")
    if (paragraph) {
        paragraph.textContent = "Map times last updated: " + get_map_data_last_updated()
    }
}

// ---------- Saved usernames (localStorage key shared by both pages) ----------

// Returns an array of strings, or null if nothing (valid) is saved.
function load_saved_usernames() {
    try {
        const saved = JSON.parse(localStorage.getItem(DDNET_SAVED_USERNAMES_KEY))
        if (!Array.isArray(saved)) {
            return null
        }
        return saved.filter(name => typeof name === "string")
    } catch (err) {
        return null
    }
}

function save_usernames(usernames) {
    try {
        localStorage.setItem(DDNET_SAVED_USERNAMES_KEY, JSON.stringify(usernames))
    } catch (err) {
        console.log("Could not save usernames", err)
    }
}

function format_fetch_errors(failed_results) {
    return failed_results.map(result => result.error.message).join("\n")
}
