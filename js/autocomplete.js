/* Based on https://www.w3schools.com/howto/howto_js_autocomplete.asp */
/* Builds the list with DOM nodes/textContent only (names are untrusted). */

const AUTOCOMPLETE_MAX_ITEMS = 50
const AUTOCOMPLETE_REMOTE_DEBOUNCE_MS = 150
const AUTOCOMPLETE_REMOTE_MIN_CHARS = 2
const AUTOCOMPLETE_REMOTE_CACHE_SIZE = 100

function autocomplete(inp, arr) {
  /*the autocomplete function takes two arguments,
  the text field element and either an array of possible autocompleted values
  or an async function source(query, signal) resolving to [{name, points}, ...]:*/
  var currentFocus = -1;
  var currentList = null;
  var remote = typeof arr === "function";
  var cache = new Map();      // query -> results (remote source only)
  var debounceTimer = null;
  var controller = null;      // AbortController of the in-flight request

  /*these are DDNet names, not logins: turn off the browser's own suggestions
  and tell password managers to ignore the field*/
  inp.setAttribute("autocomplete", "off");
  inp.setAttribute("data-1p-ignore", "");             // 1Password
  inp.setAttribute("data-lpignore", "true");          // LastPass
  inp.setAttribute("data-bwignore", "true");          // Bitwarden
  inp.setAttribute("data-form-type", "other");        // Dashlane
  inp.setAttribute("spellcheck", "false");
  inp.setAttribute("autocapitalize", "off");

  /*execute a function when someone writes in the text field:*/
  inp.addEventListener("input", function () {
    if (remote) { return remoteInput(); }
    var val = this.value;
    /*close any already open lists of autocompleted values*/
    closeAllLists();
    if (!val) { return false; }
    currentFocus = -1;
    var needle = val.toLowerCase();
    /*create a DIV element that will contain the items (values):*/
    var list = document.createElement("DIV");
    list.setAttribute("class", "autocomplete-items");
    var shown = 0;
    for (var i = 0; i < arr.length && shown < AUTOCOMPLETE_MAX_ITEMS; i++) {
      var name = arr[i];
      var lower_name = name.toLowerCase();
      /*match the text field value anywhere in the name (case-insensitive):*/
      var match_index = lower_name.indexOf(needle);
      if (match_index === -1) { continue; }
      list.appendChild(createItem(name, lower_name, match_index, needle.length));
      shown++;
    }
    if (shown === 0) { return false; }
    currentList = list;
    /*append the DIV element as a child of the autocomplete container:*/
    this.parentNode.appendChild(list);
  });

  /*remote source: debounce, abort the previous request, cache per query*/
  function remoteInput() {
    closeAllLists(); // also cancels any pending/in-flight request
    var query = inp.value.trim();
    if (query.length < AUTOCOMPLETE_REMOTE_MIN_CHARS) { return; }
    if (cache.has(query)) {
      renderRemote(query, cache.get(query));
      return;
    }
    /*meanwhile show the cached results of the longest shorter prefix, filtered locally*/
    var preview = cachedPrefixResults(query);
    if (preview.length > 0) { renderRemote(query, preview); }
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      controller = ctrl;
      var request;
      try {
        request = arr(query, ctrl ? ctrl.signal : undefined);
      } catch (e) {
        if (controller === ctrl) { controller = null; }
        return; /*a source that throws synchronously: show nothing*/
      }
      Promise.resolve(request)
        .then(function (results) {
          if (ctrl && ctrl.signal.aborted) { return; }
          if (controller === ctrl) { controller = null; }
          if (!Array.isArray(results)) { return; }
          cache.set(query, results);
          if (cache.size > AUTOCOMPLETE_REMOTE_CACHE_SIZE) {
            cache.delete(cache.keys().next().value); // drop the oldest entry
          }
          /*ignore stale responses*/
          if (!inp.isConnected || inp.value.trim() !== query) { return; }
          renderRemote(query, results);
        })
        .catch(function () { /*network errors, aborts, bad data: show nothing*/ });
    }, AUTOCOMPLETE_REMOTE_DEBOUNCE_MS);
  }

  function cachedPrefixResults(query) {
    var lower_query = query.toLowerCase();
    var best = null;
    cache.forEach(function (results, key) {
      var lower_key = key.toLowerCase();
      if (lower_key.length < lower_query.length && lower_query.indexOf(lower_key) === 0 &&
          (best === null || key.length > best.key.length)) {
        best = { key: key, results: results };
      }
    });
    if (best === null) { return []; }
    return best.results.filter(function (result) {
      return result && typeof result.name === "string" && result.name.toLowerCase().indexOf(lower_query) !== -1;
    });
  }

  function renderRemote(query, results) {
    closeAllLists();
    currentFocus = -1;
    var needle = query.toLowerCase();
    var list = document.createElement("DIV");
    list.setAttribute("class", "autocomplete-items");
    var shown = 0;
    for (var i = 0; i < results.length && shown < AUTOCOMPLETE_MAX_ITEMS; i++) {
      var result = results[i];
      if (!result || typeof result.name !== "string") { continue; }
      var name = result.name;
      var lower_name = name.toLowerCase();
      list.appendChild(createItem(name, lower_name, lower_name.indexOf(needle), needle.length, true, result.points));
      shown++;
    }
    if (shown === 0) { return; }
    currentList = list;
    inp.parentNode.appendChild(list);
  }

  function cancelPending() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (controller) {
      var ctrl = controller;
      controller = null;
      ctrl.abort();
    }
  }

  function createItem(name, lower_name, match_index, match_length, with_points, points) {
    var item = document.createElement("DIV");
    var label = item;
    if (with_points) {
      /*remote items: name and points side by side*/
      item.setAttribute("class", "autocomplete-row");
      label = document.createElement("span");
      label.setAttribute("class", "autocomplete-name");
      item.appendChild(label);
    }
    if (match_index !== -1 && lower_name.length === name.length) {
      /*make the matched letters bold:*/
      var strong = document.createElement("strong");
      strong.textContent = name.substring(match_index, match_index + match_length);
      label.appendChild(document.createTextNode(name.substring(0, match_index)));
      label.appendChild(strong);
      label.appendChild(document.createTextNode(name.substring(match_index + match_length)));
    } else {
      /*no match in the name, or lowercasing changed the length (rare Unicode case)
      so indexes don't line up: no bold*/
      label.textContent = name;
    }
    if (with_points && typeof points === "number" && isFinite(points)) {
      var points_span = document.createElement("span");
      points_span.setAttribute("class", "autocomplete-points");
      points_span.textContent = points + " pts";
      item.appendChild(points_span);
    }
    /*execute a function when someone clicks on the item value (DIV element):*/
    item.addEventListener("click", function () {
      /*insert the value (kept in this closure) into the text field:*/
      inp.value = name;
      closeAllLists();
    });
    return item;
  }

  /*execute a function presses a key on the keyboard:*/
  inp.addEventListener("keydown", function (e) {
    var x = currentList && currentList.isConnected ? currentList.getElementsByTagName("div") : null;
    if (e.key === "ArrowDown") {
      currentFocus++;
      addActive(x);
    } else if (e.key === "ArrowUp") {
      currentFocus--;
      addActive(x);
    } else if (e.key === "Enter") {
      /*If the ENTER key is pressed, prevent the form from being submitted,*/
      e.preventDefault();
      if (x && currentFocus > -1 && currentFocus < x.length) {
        /*and simulate a click on the "active" item:*/
        x[currentFocus].click();
      }
    } else if (e.key === "Escape") {
      closeAllLists();
    }
  });

  function addActive(x) {
    /*a function to classify an item as "active":*/
    if (!x || x.length === 0) return false;
    removeActive(x);
    if (currentFocus >= x.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = (x.length - 1);
    x[currentFocus].classList.add("autocomplete-active");
    x[currentFocus].scrollIntoView({ block: "nearest" });
  }

  function removeActive(x) {
    /*a function to remove the "active" class from all autocomplete items:*/
    for (var i = 0; i < x.length; i++) {
      x[i].classList.remove("autocomplete-active");
    }
  }

  function closeAllLists(elmnt) {
    /*close all autocomplete lists in the document,
    except the one passed as an argument:*/
    if (remote && elmnt !== inp) { cancelPending(); }
    var x = document.getElementsByClassName("autocomplete-items");
    for (var i = x.length - 1; i >= 0; i--) {
      if (elmnt != x[i] && elmnt != inp) {
        x[i].parentNode.removeChild(x[i]);
      }
    }
    if (!currentList || !currentList.isConnected) {
      currentList = null;
      currentFocus = -1;
    }
  }

  /*execute a function when someone clicks in the document:*/
  document.addEventListener("click", function (e) {
    closeAllLists(e.target);
  });
}
