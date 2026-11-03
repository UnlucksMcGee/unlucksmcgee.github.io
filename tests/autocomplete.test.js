// js/autocomplete.js: the array and function (remote) sources on a minimal page with a fake clock,
// plus the opt-out attributes on ddnet.html's name boxes
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { JSDOM, VirtualConsole } = require("jsdom")
const { load_page, REPO } = require("./helpers")

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
    load_page("ddnet.html", { query: "?mode=rank" }).document.querySelectorAll(".username_text_input").forEach(check)
})

// ---- minimal page with only js/autocomplete.js ----

const AUTOCOMPLETE_JS = fs.readFileSync(path.join(REPO, "js", "autocomplete.js"), "utf8")
const flush = () => new Promise(resolve => setImmediate(resolve)) // lets promise chains settle

// A source whose calls are logged and settled by the test: calls[i].resolve(results) / .reject(err)
function make_source() {
    const calls = []
    const source = (query, signal) => new Promise((resolve, reject) => calls.push({ query, signal, resolve, reject }))
    return { calls, source }
}

function load_widget(source) {
    const errors = []
    const virtual_console = new VirtualConsole()
    virtual_console.on("jsdomError", err => errors.push(err))
    const dom = new JSDOM(`<!DOCTYPE html><body><form><div class="autocomplete"><input id="name" type="text"></div></form><p id="outside">x</p></body>`, {
        runScripts: "dangerously",
        virtualConsole: virtual_console,
    })
    const w = dom.window
    // deterministic clock for the debounce
    let now = 0, next_id = 0, timers = []
    w.setTimeout = (fn, ms = 0) => { timers.push({ id: ++next_id, at: now + ms, fn }); return next_id }
    w.clearTimeout = id => { timers = timers.filter(t => t.id !== id) }
    const advance = ms => {
        now += ms
        for (;;) {
            const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0]
            if (!due) break
            timers = timers.filter(t => t !== due)
            due.fn()
        }
    }
    w.HTMLElement.prototype.scrollIntoView = function () {}
    const script = w.document.createElement("script")
    script.textContent = AUTOCOMPLETE_JS
    w.document.body.appendChild(script)
    const doc = w.document
    const input = doc.getElementById("name")
    w.autocomplete(input, source)
    const debounce = w.eval("AUTOCOMPLETE_REMOTE_DEBOUNCE_MS")
    return {
        w, doc, input, advance, errors, debounce,
        type: value => { input.value = value; input.dispatchEvent(new w.Event("input")) },
        key: k => input.dispatchEvent(new w.KeyboardEvent("keydown", { key: k })),
        items: () => [...doc.querySelectorAll(".autocomplete-items > div")],
        names: () => [...doc.querySelectorAll(".autocomplete-items .autocomplete-name")].map(n => n.textContent),
        lists: () => doc.querySelectorAll(".autocomplete-items").length,
    }
}

test("autocomplete: substring match, bolds the matched range, caps at 50, keyboard nav, XSS-safe", () => {
    const names = ["SomeGee", "<i>geez</i>", "nope", ...Array.from({ length: 80 }, (_, i) => "xGEEx" + i)]
    const { doc, input, type, key, errors } = load_widget(names)

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
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): nothing under 2 characters, debounced to the final value", async () => {
    const { calls, source } = make_source()
    const { input, type, advance, debounce, lists, errors } = load_widget(source)
    assert.equal(debounce, 150)
    assert.equal(input.getAttribute("autocomplete"), "off")

    type("u"); advance(1000)
    type("  u "); advance(1000) // the trimmed length counts
    assert.equal(calls.length, 0)

    type("un"); advance(debounce - 50)
    type("unl"); advance(debounce - 50)
    type("unlu"); advance(debounce - 1)
    assert.equal(calls.length, 0)
    advance(1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].query, "unlu")

    calls[0].resolve([{ name: "UnlucksMcGee", points: 5846 }])
    await flush()
    assert.equal(lists(), 1)

    type("u") // under the minimum closes the list
    assert.equal(lists(), 0)
    type("")
    advance(1000)
    assert.equal(calls.length, 1)
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): points shown, name bolded, only the name is inserted on pick", async () => {
    const { calls, source } = make_source()
    const { input, type, key, advance, debounce, items, lists, errors } = load_widget(source)
    type("gee"); advance(debounce)
    calls[0].resolve([
        { name: "UnlucksMcGee", points: 5846 },
        { name: "GeeWhiz", points: 0 },
        { name: "NoMatch", points: null }, // no match in the name, no points
    ])
    await flush()
    const list = items()
    assert.equal(list.length, 3)
    assert.equal(list[0].querySelector(".autocomplete-name").textContent, "UnlucksMcGee")
    assert.equal(list[0].querySelector("strong").textContent, "Gee")
    assert.equal(list[0].querySelector(".autocomplete-points").textContent, "5846 pts")
    assert.equal(list[1].querySelector(".autocomplete-points").textContent, "0 pts")
    assert.equal(list[2].querySelector(".autocomplete-points"), null)
    assert.equal(list[2].querySelector("strong"), null)
    assert.equal(list[2].textContent, "NoMatch")

    key("ArrowUp") // wraps to the last item
    assert.ok(list[2].classList.contains("autocomplete-active"))
    key("ArrowDown"); key("Enter")
    assert.equal(input.value, "UnlucksMcGee")
    assert.equal(lists(), 0)

    type("whiz"); advance(debounce)
    calls[1].resolve([{ name: "GeeWhiz", points: 12 }])
    await flush()
    items()[0].querySelector(".autocomplete-points").click() // clicking on the points still picks just the name
    assert.equal(input.value, "GeeWhiz")
    assert.equal(lists(), 0)
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): previous request aborted, stale responses ignored", async () => {
    const { calls, source } = make_source()
    const { doc, type, key, advance, debounce, names, lists, errors } = load_widget(source)
    type("ab"); advance(debounce)
    assert.equal(calls[0].signal.aborted, false)
    type("abc"); advance(debounce)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].signal.aborted, true) // the new request aborted the old one
    assert.equal(calls[1].signal.aborted, false)

    calls[0].resolve([{ name: "ab_old", points: 1 }]) // a source that ignores the signal
    await flush()
    assert.equal(lists(), 0)
    calls[1].resolve([{ name: "abc_new", points: 2 }])
    await flush()
    assert.deepEqual(names(), ["abc_new"])

    // value changed while the request was in flight: aborted at once, its late answer not rendered
    type("xy"); advance(debounce)
    type("xyz")
    assert.equal(calls[2].signal.aborted, true)
    calls[2].resolve([{ name: "xy1", points: 1 }])
    await flush()
    assert.equal(lists(), 0)
    advance(debounce)

    // a response for a query that no longer matches the value is dropped even if not aborted
    // (value changed by a script, without an input event)
    doc.getElementById("name").value = "other"
    calls[3].resolve([{ name: "xyz1", points: 1 }])
    await flush()
    assert.equal(lists(), 0)
    assert.equal(calls[3].signal.aborted, false)

    // Escape, clearing the value and outside clicks abort too
    type("qwe"); advance(debounce)
    key("Escape")
    assert.equal(calls[4].signal.aborted, true)
    type("qwer"); advance(debounce)
    type("")
    assert.equal(calls[5].signal.aborted, true)
    type("qwert"); advance(debounce)
    doc.getElementById("outside").click()
    assert.equal(calls[6].signal.aborted, true)
    calls[6].resolve([{ name: "qwert1", points: 1 }])
    await flush()
    assert.equal(lists(), 0)

    // a pending debounce is cancelled by Escape: no request at all
    type("zzz"); key("Escape"); advance(1000)
    assert.equal(calls.length, 7)

    // the input left the document: no render
    type("rem"); advance(debounce)
    const input = doc.getElementById("name")
    const parent = input.parentNode
    input.remove()
    calls[7].resolve([{ name: "rem1", points: 1 }])
    await flush()
    assert.equal(parent.querySelectorAll(".autocomplete-items").length, 0)
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): cached queries render immediately without a request", async () => {
    const { calls, source } = make_source()
    const { type, advance, debounce, names, errors } = load_widget(source)
    type("mcgee"); advance(debounce)
    calls[0].resolve([{ name: "UnlucksMcGee", points: 5846 }])
    await flush()
    type("mcge"); advance(debounce)
    calls[1].resolve([{ name: "McGeeFan", points: 3 }])
    await flush()

    type("mcgee") // no debounce, no request
    assert.deepEqual(names(), ["UnlucksMcGee"])
    advance(1000)
    assert.equal(calls.length, 2)
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): cached shorter prefix previews filtered results until the real answer", async () => {
    const { calls, source } = make_source()
    const { type, advance, debounce, names, lists, items, errors } = load_widget(source)
    type("un"); advance(debounce)
    calls[0].resolve([{ name: "Unicorn", points: 1 }, { name: "UnlucksMcGee", points: 5846 }, { name: "Fun", points: 2 }])
    await flush()
    type("unl"); advance(debounce)
    calls[1].resolve([{ name: "UNLUCKY", points: 7 }, { name: "Unlimited", points: 8 }])
    await flush()

    // "unlu": the longest cached prefix ("unl") wins, filtered case-insensitively, shown before any request
    type("unlu")
    assert.equal(calls.length, 2)
    assert.deepEqual(names(), ["UNLUCKY"])
    assert.equal(items()[0].querySelector("strong").textContent, "UNLU")
    assert.equal(items()[0].querySelector(".autocomplete-points").textContent, "7 pts")
    advance(debounce)
    assert.equal(calls.length, 3)
    assert.equal(calls[2].query, "unlu")
    assert.deepEqual(names(), ["UNLUCKY"]) // still the preview while the request is in flight
    calls[2].resolve([{ name: "UnlucksMcGee", points: 5846 }, { name: "Unlucky", points: 9 }])
    await flush()
    assert.deepEqual(names(), ["UnlucksMcGee", "Unlucky"]) // replaced by the real answer

    // the filter leaves nothing: no preview list
    type("unq")
    assert.equal(lists(), 0)
    advance(debounce)
    calls[3].resolve([])
    await flush()
    assert.equal(lists(), 0)

    // stale-response rules unchanged: the preview stays when the answer is for an older value
    type("unlim")
    assert.deepEqual(names(), ["Unlimited"])
    advance(debounce)
    const late = calls[4]
    assert.equal(late.query, "unlim")
    type("unlimi") // preview from "unlim"? not cached yet, so from "unl"
    assert.deepEqual(names(), ["Unlimited"])
    late.resolve([{ name: "Unlimited", points: 8 }, { name: "UNLIMITED2", points: 1 }]) // aborted: ignored
    await flush()
    assert.deepEqual(names(), ["Unlimited"])
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): untrusted names render as text", async () => {
    const { calls, source } = make_source()
    const { w, doc, type, advance, debounce, items, errors } = load_widget(source)
    w.alert = () => { throw new Error("alert called") }
    const xss = "<img src=x onerror=alert(1)>"
    type("img"); advance(debounce)
    calls[0].resolve([{ name: xss, points: 1 }, { name: "<b>img</b>", points: "<i>9</i>" }, { name: 42 }, null])
    await flush()
    const list = items()
    assert.equal(list.length, 2) // non-string names are skipped
    assert.equal(list[0].querySelector(".autocomplete-name").textContent, xss)
    assert.equal(list[1].querySelector(".autocomplete-points"), null) // non-number points are not shown
    assert.equal(doc.querySelectorAll(".autocomplete-items img, .autocomplete-items b, .autocomplete-items i").length, 0)
    list[0].click()
    assert.equal(doc.getElementById("name").value, xss)
    assert.deepEqual(errors, [])
})

test("autocomplete (function source): rejections and bad results are swallowed", async () => {
    const { calls, source } = make_source()
    const { type, advance, debounce, lists, errors } = load_widget(source)
    type("net"); advance(debounce)
    calls[0].reject(new TypeError("Failed to fetch"))
    await flush()
    assert.equal(lists(), 0)

    type("neta"); advance(debounce)
    const abort = new Error("aborted"); abort.name = "AbortError"
    calls[1].reject(abort)
    await flush()
    assert.equal(lists(), 0)

    type("netb"); advance(debounce)
    calls[2].resolve({ not: "an array" })
    await flush()
    assert.equal(lists(), 0)
    type("net") // failed queries are not cached: asked again
    advance(debounce)
    assert.equal(calls.length, 4)

    // a source that throws synchronously
    const thrower = load_widget(() => { throw new Error("sync boom") })
    thrower.type("boom"); thrower.advance(thrower.debounce)
    await flush()
    assert.equal(thrower.lists(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(thrower.errors, [])
})
