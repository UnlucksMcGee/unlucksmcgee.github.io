// Bookmarklet for kog.html. kog.html turns this one function into a "javascript:" link
// (see kog_bookmarklet_href in js/kog.js), so it must stay self-contained: no outside names.
//
// It runs on kog.tw, where it can read KoG player pages (kog.tw has no API and no CORS, so
// unlucksmcgee.github.io can't). On a player page it reads that page; anywhere else on kog.tw it
// asks for a name and loads that player's page itself (this can take a couple of minutes).
// Then it opens target_url#kog_import=<JSON> with the player's finished maps:
//   {"v": 1, "player": "name", "rank": 195, "points": 15502, "finished": [["map", seconds, finishes], ...]}
// navigate is only passed by tests.
function kog_bookmarklet(target_url, navigate) {
    navigate = navigate || function (url) { window.location.href = url }

    function text(node) {
        return node ? node.textContent.replace(/\s+/g, " ").trim() : ""
    }

    // "01:02:03" -> 3723; null if it isn't h:mm:ss / mm:ss
    function seconds(value) {
        if (!/^\d+(:\d+){1,2}$/.test(value)) {
            return null
        }
        return value.split(":").reduce(function (total, part) { return total * 60 + parseInt(part, 10) }, 0)
    }

    function int_or_null(value) {
        const number = parseInt(String(value).replace(/[^\d]/g, ""), 10)
        return isFinite(number) ? number : null
    }

    // root: a document or element holding a KoG player page. null if it isn't one.
    function parse(root) {
        const finished_pane = root.querySelector("#pills-finished")
        if (!finished_pane) {
            return null
        }
        let rank = null
        let points = null
        const items = root.querySelectorAll("li")
        for (let i = 0; i < items.length; i++) {
            const match = /^Rank (\d+)\. with (\d+) points/.exec(text(items[i]))
            if (match) {
                rank = parseInt(match[1], 10)
                points = parseInt(match[2], 10)
                break
            }
        }
        const finished = []
        const rows = finished_pane.querySelectorAll("tbody tr")
        for (let i = 0; i < rows.length; i++) {
            const map = text(rows[i].querySelector("th"))
            const cells = rows[i].querySelectorAll("td")
            if (map && cells.length >= 2) {
                finished.push([map, seconds(text(cells[0])), int_or_null(text(cells[1]))])
            }
        }
        return { "v": 1, "player": text(root.querySelector("h2")), "rank": rank, "points": points, "finished": finished }
    }

    function send(data, fallback_name) {
        data.player = data.player || fallback_name
        navigate(target_url + "#kog_import=" + encodeURIComponent(JSON.stringify(data)))
    }

    if (!/(^|\.)kog\.tw$/.test(window.location.hostname)) {
        alert("Use this bookmark on kog.tw: open your KoG player page, then click it.")
        return
    }

    const params = new URLSearchParams(window.location.hash.slice(1))
    const shown_player = params.get("p") === "players" ? params.get("player") : null
    const on_page = parse(document)
    if (on_page && shown_player) {
        send(on_page, shown_player)
        return
    }

    const name = (prompt("KoG player name (case-sensitive):", shown_player || "") || "").trim()
    if (!name) {
        return
    }
    const banner = document.createElement("div")
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;padding:12px;text-align:center;" +
        "font:16px sans-serif;background:#1d4ed8;color:#fff"
    banner.textContent = "Loading " + name + " from kog.tw for the Map Finder... KoG can take a couple of minutes."
    document.body.appendChild(banner)

    fetch("/get.php?p=players&p=players&player=" + encodeURIComponent(name), { credentials: "same-origin" })
        .then(function (response) {
            if (!response.ok) {
                throw new Error(response.status === 524 ?
                    "kog.tw took too long to answer (HTTP 524). Try again, or open the player page and use the bookmark there." :
                    "kog.tw returned HTTP " + response.status + ".")
            }
            return response.text()
        })
        .then(function (html) {
            const data = parse(new DOMParser().parseFromString(html, "text/html"))
            if (!data) {
                throw new Error("No KoG player called \"" + name + "\" (names are case-sensitive).")
            }
            send(data, name)
        })
        .catch(function (err) {
            banner.remove()
            alert("Couldn't load " + name + ": " + err.message)
        })
}
