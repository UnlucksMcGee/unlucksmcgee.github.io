// ddnet_rank.html: one player's finished maps by rank percentile (fixtures/player_rank.json)
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { rank_player, load_page, tick, cell_texts } = require("./helpers")

const w = load_page("ddnet_rank.html", { saved_usernames: [rank_player.player, "Eyesore"] })
const doc = w.document
const data_rows = () => [...doc.querySelectorAll(".map_section tr")].filter(tr => tr.querySelector("td"))

test("radio defaults and saved name", () => {
    const checked = [...doc.querySelectorAll("input[name=sorting_list]")].filter(i => i.checked).map(i => i.id)
    assert.deepEqual(checked, ["sorting_percentile"])
    assert.equal(doc.getElementById("sorting_percentile").value, "percentile")
    assert.equal(doc.getElementById("text_player1").value, rank_player.player)
})

test("search renders finished maps sorted by percentile", async () => {
    w.search()
    await tick()
    assert.deepEqual(w.alerts, [])
    assert.equal(doc.querySelector("#player_results_div a").textContent, "FixturePlayer (5846pts)")

    let finished = 0
    for (const type in rank_player.types) {
        for (const map in rank_player.types[type].maps) {
            if (rank_player.types[type].maps[map].finishes > 0) finished++
        }
    }
    assert.equal(finished, 5)
    assert.equal(data_rows().length, finished)

    // Brutal has only unfinished maps and Solo has none, so no sections for them
    assert.deepEqual([...doc.querySelectorAll(".map_section")].map(s => s.id), ["Novice", "Moderate"])
    assert.deepEqual([...doc.querySelectorAll(".map_section h3")].map(h => h.textContent), ["Novice (3)", "Moderate (2)"])
    assert.equal(doc.getElementById("sort_description").textContent, "Your weakest ranks first: the best maps to improve on")
    assert.deepEqual(cell_texts([...doc.querySelectorAll("#Novice tr")].slice(1)), [
        ["Beta", "2", "251/501", "50.0", "01:08:20 / 01:06:40 / ?"],
        ["Diversity", "5", "13603/61453", "77.8", "12:59 / 25:33 / 01:25"],
        ["Alpha", "1", "1/100", "100.0", "00:50 / 01:40 / 00:50"],
    ])
    assert.deepEqual(cell_texts([...doc.querySelectorAll("#Moderate tr")].slice(1)), [
        ["Bloom", "11", "4541/4541", "0.0", "01:01:40 / ? / ?"],
        ["<b>x</b>", "9", "4/10", "66.6", "00:05 / 00:10 / 00:05"],
    ])
    assert.equal(doc.querySelectorAll(".map_section b").length, 0)

    // Percentile column ascending within each section, values in [0, 100]
    for (const section of doc.querySelectorAll(".map_section")) {
        const percentiles = [...section.querySelectorAll("tr td:nth-child(4)")].map(td => parseFloat(td.textContent))
        for (let i = 1; i < percentiles.length; i++) assert.ok(percentiles[i] >= percentiles[i - 1], section.id)
        assert.ok(percentiles.every(p => p >= 0 && p <= 100))
    }
    assert.deepEqual(JSON.parse(w.localStorage.getItem("usernames")), [rank_player.player])
})

test("re-sorting by name", () => {
    w.display_results("sorting_name")
    assert.deepEqual([...doc.querySelectorAll("#Novice tr td:first-child")].map(td => td.textContent), ["Alpha", "Beta", "Diversity"])
    assert.ok(doc.getElementById("sorting_name").checked)
    assert.ok(!doc.getElementById("sorting_percentile").checked)
})

test("not-found message", async () => {
    doc.getElementById("text_player1").value = "zzqx no such"
    w.alerts.length = 0
    w.search()
    await tick()
    assert.deepEqual(w.alerts, ['Player not found: "zzqx no such" (names are case-sensitive)'])
    assert.equal(doc.getElementById("results_section_div").style.display, "none")
})

test("Search button is disabled while searching and re-enabled after", async () => {
    const button = doc.getElementById("search_button")
    doc.getElementById("text_player1").value = rank_player.player
    w.alerts.length = 0
    w.search()
    assert.ok(button.disabled)
    await tick()
    assert.ok(!button.disabled)
    assert.deepEqual(w.alerts, [])

    doc.getElementById("text_player1").value = "NetFail"
    w.search()
    assert.ok(button.disabled)
    await tick()
    assert.ok(!button.disabled)
    assert.equal(w.alerts.length, 1)
    assert.match(w.alerts[0], /Network error while loading "NetFail"/)
})

test("no uncaught page script errors", () => {
    assert.deepEqual(w.jsdom_errors, [])
})

test("works with no map_data at all", async () => {
    const bare = load_page("ddnet_rank.html", { saved_usernames: [rank_player.player], map_data: null })
    assert.equal(bare.document.getElementById("map_data_last_updated_p").textContent, "Map times last updated: ?")
    bare.search()
    await tick()
    assert.deepEqual(bare.alerts, [])
    const alpha = [...bare.document.querySelectorAll("#Novice tr")].find(tr => tr.children[0].textContent == "Alpha")
    assert.equal(alpha.children[4].textContent, "00:50 / ? / ?")
    assert.deepEqual(bare.jsdom_errors, [])
})
