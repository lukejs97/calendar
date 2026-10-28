// The search window: events and tasks from a year back to a year ahead,
// upcoming ones first. Choosing a result shows its day and its details.
import { errorMessage, search, type AgendaItem } from "./api";
import { el, setItemColor } from "./dom";
import { describeTimes, itemEnd, itemStart } from "./time";

/** Wait this long after typing stops before searching. */
const DEBOUNCE_MS = 300;

/** Opens the window. `open` runs with the chosen result. */
export function openSearch(open: (item: AgendaItem) => void): void {
  const dialog = el("dialog", "dialog search");
  dialog.setAttribute("aria-label", "Search");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const input = el("input", "text-input");
  input.type = "search";
  input.placeholder = "Search events and tasks";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Search events and tasks");
  const status = el("p", "search-status");
  status.setAttribute("aria-live", "polite");
  const results = el("div", "search-results");

  let timer: number | undefined;
  let latest = 0;
  let first: AgendaItem | undefined;

  const choose = (item: AgendaItem) => {
    dialog.close();
    open(item);
  };

  async function run(query: string): Promise<void> {
    const request = ++latest;
    if (!query.trim()) {
      status.textContent = "";
      results.replaceChildren();
      first = undefined;
      return;
    }
    status.textContent = "Searching…";
    try {
      const found = await search(query);
      if (request !== latest) return;
      first = found.upcoming[0] ?? found.past[0];
      const notes = [...found.warnings.map((w) => `Couldn't search ${w}`)];
      if (found.offline) notes.unshift("No internet: searched the events saved on this device.");
      if (!first) notes.push("No matches from a year ago to a year ahead.");
      status.textContent = notes.join(" ");
      results.replaceChildren(
        ...section("Upcoming", found.upcoming, choose),
        ...section("Past", found.past, choose),
      );
    } catch (e) {
      if (request === latest) status.textContent = errorMessage(e);
    }
  }

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(input.value), DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    // Enter opens the top result. preventDefault, or the same key press
    // would also "click" the details popup's focused Close button.
    if (e.key === "Enter" && first) {
      e.preventDefault();
      choose(first);
    }
  });

  dialog.append(input, status, results);
  dialog.showModal();
  input.focus();
}

function section(title: string, items: AgendaItem[], choose: (item: AgendaItem) => void): HTMLElement[] {
  if (items.length === 0) return [];
  const list = el("ul", "search-list");
  for (const item of items) {
    const button = el("button", "search-result");
    setItemColor(button, item);
    button.append(
      el("span", "search-title", item.title),
      el("span", "search-when", `${describeTimes(itemStart(item), itemEnd(item), item.allDay)} · ${item.listName}`),
    );
    button.addEventListener("click", () => choose(item));
    const li = el("li");
    li.append(button);
    list.append(li);
  }
  return [el("h3", "search-heading", title), list];
}
