// js/autocomplete.js (exercised through ddnet.html's first textbox)
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { load_page } = require("./helpers")

test("autocomplete: substring match, bolds the matched range, caps at 50, keyboard nav, XSS-safe", () => {
    const w = load_page("ddnet.html")
    const doc = w.document
    w.zaf_players.length = 0
    w.zaf_players.push("SomeGee", "<i>geez</i>", "nope", ...Array.from({ length: 80 }, (_, i) => "xGEEx" + i))
    const input = doc.querySelector(".username_text_input")
    const type = value => { input.value = value; input.dispatchEvent(new w.Event("input")) }
    const key = k => input.dispatchEvent(new w.KeyboardEvent("keydown", { key: k }))

    type("gee")
    const items = [...doc.querySelectorAll(".autocomplete-items > div")]
    assert.equal(items.length, 50)
    assert.equal(items[0].textContent, "SomeGee")
    assert.equal(items[0].querySelector("strong").textContent, "Gee") // original case of the matched range
    assert.equal(items[1].textContent, "<i>geez</i>")
    assert.equal(items[1].querySelector("strong").textContent, "gee")
    assert.equal(doc.querySelectorAll(".autocomplete-items i, .autocomplete-items input").length, 0)

    key("ArrowDown"); key("ArrowDown")
    assert.ok(items[1].classList.contains("autocomplete-active"))
    key("ArrowUp"); key("ArrowUp")
    assert.ok(items[49].classList.contains("autocomplete-active")) // wraps around
    key("ArrowDown"); key("ArrowDown"); key("Enter")
    assert.equal(input.value, "<i>geez</i>")
    assert.equal(doc.querySelectorAll(".autocomplete-items").length, 0)

    type("(") // regex metacharacters are not special
    assert.equal(doc.querySelectorAll(".autocomplete-items").length, 0)
    type("")
    assert.equal(doc.querySelectorAll(".autocomplete-items").length, 0)
    assert.deepEqual(w.jsdom_errors, [])
})

test("autocomplete: every name box opts out of browser autofill and password managers", () => {
    const check = input => {
        assert.equal(input.getAttribute("autocomplete"), "off")
        assert.ok(input.hasAttribute("data-1p-ignore"))
        assert.equal(input.getAttribute("data-lpignore"), "true")
        assert.equal(input.getAttribute("data-bwignore"), "true")
        assert.equal(input.getAttribute("data-form-type"), "other")
    }
    const w = load_page("ddnet.html")
    w.add_textbox() // boxes added later get it too
    const inputs = [...w.document.querySelectorAll(".username_text_input")]
    assert.equal(inputs.length, 3)
    inputs.forEach(check)
    check(load_page("ddnet_rank.html").document.getElementById("text_player1"))
})
