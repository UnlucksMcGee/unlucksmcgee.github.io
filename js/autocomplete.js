/* Based on https://www.w3schools.com/howto/howto_js_autocomplete.asp */
/* Builds the list with DOM nodes/textContent only (names are untrusted). */

const AUTOCOMPLETE_MAX_ITEMS = 50

function autocomplete(inp, arr) {
  /*the autocomplete function takes two arguments,
  the text field element and an array of possible autocompleted values:*/
  var currentFocus = -1;
  var currentList = null;

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

  function createItem(name, lower_name, match_index, match_length) {
    var item = document.createElement("DIV");
    if (lower_name.length === name.length) {
      /*make the matched letters bold:*/
      var strong = document.createElement("strong");
      strong.textContent = name.substring(match_index, match_index + match_length);
      item.appendChild(document.createTextNode(name.substring(0, match_index)));
      item.appendChild(strong);
      item.appendChild(document.createTextNode(name.substring(match_index + match_length)));
    } else {
      /*lowercasing changed the length (rare Unicode case), so indexes don't line up: no bold*/
      item.textContent = name;
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
