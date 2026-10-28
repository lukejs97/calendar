import { isTauri } from "@tauri-apps/api/core";
import {
  authStatus,
  errorMessage,
  getAgenda,
  getSavedAgenda,
  eventRef,
  isNotSignedIn,
  setEventTimes,
  setTaskCompleted,
  setTaskDue,
  signIn,
  type Agenda,
  type AgendaItem,
} from "./api";
import { openDetails } from "./details";
import { el } from "./dom";
import { openEdit, openNew } from "./event-form";
import { openSearch } from "./search";
import { announceChange, onChangeElsewhere } from "./sync";
import { openAccountsSettings, openTodoistSettings } from "./settings";
import { itemEnd, itemStart, localTimeZone, overlaps, startOfDay, timeFormat, toDateString, toLocalIso } from "./time";
import { VIEW_ORDER, VIEWS, type ViewName } from "./views";

const REFRESH_EVERY_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 24;
const VIEW_STORAGE_KEY = "calendar.view";

const app = document.querySelector<HTMLElement>("#app")!;
const banner = document.querySelector<HTMLElement>("#banner")!;
const title = document.querySelector<HTMLElement>("#title")!;
const account = document.querySelector<HTMLElement>("#account")!;
const actions = document.querySelector<HTMLElement>("#actions")!;
const toolbar = document.querySelector<HTMLElement>("#toolbar")!;
const viewSwitcher = document.querySelector<HTMLElement>("#view-switcher")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;

const state = { view: savedView(), anchor: startOfDay(new Date()) };

/** Recently loaded ranges, so going back and forth shows something instantly. */
const cache = new Map<string, Agenda>();
/** Tasks ticked off or back on in this session, by id. */
const toggledTasks = new Map<string, AgendaItem>();
/** What's on screen, so auto-refresh and resizing can redraw it in place. */
let shown: { view: ViewName; range: string; agenda: Agenda } | undefined;
let latestRequest = 0;
/** A just-added event's start, to scroll into view on the next draw. */
let reveal: Date | undefined;
let refreshTimer: number | undefined;

function savedView(): ViewName {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved && saved in VIEWS) return saved as ViewName;
  } catch {
    // Storage unavailable; use the default.
  }
  // A whole week is cramped on a phone; start with the list there.
  return window.matchMedia("(max-width: 640px)").matches ? "agenda" : "week";
}

function saveView(view: ViewName): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Not important enough to report.
  }
}

function currentRange() {
  const { from, to } = VIEWS[state.view].range(state.anchor);
  return { from, to, key: `${toDateString(from)}/${toDateString(to)}` };
}

/**
 * Loaded items, with this session's task check-offs applied. Todoist stops
 * returning a task once it's done, so done tasks are kept here and stay
 * visible (struck through) until the app restarts.
 */
function itemsToShow(agenda: Agenda, from: Date, to: Date): AgendaItem[] {
  const loaded = new Set(agenda.items.map((item) => item.id));
  const doneElsewhere = [...toggledTasks.values()].filter(
    (task) => !loaded.has(task.id) && overlaps(task, from, to),
  );
  return [...agenda.items.map((item) => toggledTasks.get(item.id) ?? item), ...doneElsewhere];
}

function render(agenda: Agenda): void {
  const { from, to, key } = currentRange();
  const revealNow = reveal;
  reveal = undefined;
  account.textContent = agenda.accounts.join(", ");
  banner.replaceChildren(...agenda.warnings.map((w) => el("p", "warning", `Couldn't load ${w}`)));
  if (agenda.offlineSince) banner.prepend(el("p", "warning", offlineNote(agenda.offlineSince)));
  VIEWS[state.view].render(app, {
    items: itemsToShow(agenda, from, to),
    from,
    to,
    anchor: state.anchor,
    now: new Date(),
    preserveScroll: shown?.view === state.view && shown.range === key,
    reveal: revealNow,
    goTo,
    toggleTask,
    openItem: showDetails,
    moveItem,
  });
  shown = { view: state.view, range: key, agenda };
}

function rerender(): void {
  if (shown) render(shown.agenda);
}

/** Ticks a task off (or back on) right away, then tells Todoist. */
async function toggleTask(item: AgendaItem): Promise<void> {
  const completed = !item.completed;
  toggledTasks.set(item.id, { ...item, completed });
  rerender();
  try {
    await setTaskCompleted(item.id, completed);
    announceChange();
    if (!completed) {
      // Reopened: Todoist lists it again, so fetch it fresh.
      toggledTasks.delete(item.id);
      cache.clear();
      await load();
    }
  } catch (e) {
    if (item.completed) toggledTasks.set(item.id, item);
    else toggledTasks.delete(item.id);
    rerender();
    banner.replaceChildren(el("p", "error", `Couldn't update "${item.title}": ${errorMessage(e)}`));
  }
}

/** Swaps in a changed copy of an item in what's on screen, and redraws. */
function replaceShown(item: AgendaItem): void {
  if (!shown) return;
  const agenda = { ...shown.agenda, items: shown.agenda.items.map((i) => (i.id === item.id ? item : i)) };
  cache.set(shown.range, agenda);
  shown = { ...shown, agenda };
  rerender();
}

/** Whether an event has guests besides you, who'd be emailed about changes. */
const hasGuests = (item: AgendaItem) => item.attendees.some((a) => !a.isSelf);

/** Moves an event or task right away on screen (after dragging it), then saves it. */
async function moveItem(item: AgendaItem, start: Date, end: Date): Promise<void> {
  if (start.getTime() === itemStart(item).getTime() && end.getTime() === itemEnd(item).getTime()) {
    rerender(); // dropped where it was
    return;
  }
  const format = (d: Date) => (item.allDay ? toDateString(d) : toLocalIso(d));
  replaceShown({ ...item, start: format(start), end: format(end), overdue: false });
  try {
    if (item.source === "todoist") {
      await setTaskDue(item.sourceId!, { kind: "at", at: format(start) });
    } else {
      const times = { start: format(start), end: format(end), allDay: item.allDay, timeZone: localTimeZone() };
      await setEventTimes(eventRef(item), times, hasGuests(item));
    }
    announceChange();
    // Other cached ranges may show it too; fetch them fresh when visited.
    for (const key of cache.keys()) if (key !== shown?.range) cache.delete(key);
  } catch (e) {
    replaceShown(item);
    banner.replaceChildren(el("p", "error", `Couldn't move "${item.title}": ${errorMessage(e)}`));
  }
}

function updateToolbar(): void {
  title.textContent = VIEWS[state.view].title(state.anchor);
  for (const button of viewSwitcher.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
}

/** "No internet. Showing events saved at 3:42 PM." */
function offlineNote(savedAt: string): string {
  const saved = new Date(savedAt);
  const when = Number.isNaN(saved.getTime())
    ? ""
    : startOfDay(saved).getTime() === startOfDay(new Date()).getTime()
      ? ` at ${timeFormat.format(saved)}`
      : ` on ${saved.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${timeFormat.format(saved)}`;
  return `No internet. Showing events saved${when}.`;
}

/**
 * Shows the current view right away (from memory, or else from what was
 * saved on disk last time), then fresh from Google and Todoist.
 */
async function load(): Promise<void> {
  const { from, to, key } = currentRange();
  updateToolbar();

  const request = ++latestRequest;
  let cached = cache.get(key);
  if (cached) render(cached);
  else {
    app.classList.add("loading");
    void getSavedAgenda(toDateString(from), toDateString(to))
      .then((saved) => {
        // Only if the fresh answer hasn't arrived first.
        if (saved && request === latestRequest && !cache.has(key)) {
          cached = saved;
          render(saved);
          app.classList.remove("loading");
        }
      })
      .catch(() => {});
  }

  refreshButton.disabled = true;
  try {
    const agenda = await getAgenda(toDateString(from), toDateString(to));
    cache.delete(key);
    cache.set(key, agenda);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    if (request === latestRequest) render(agenda);
  } catch (e) {
    if (request !== latestRequest) return;
    if (isNotSignedIn(e)) {
      showSignedOut("Your Google session ended. Please sign in again.");
      return;
    }
    if (cached) banner.replaceChildren(el("p", "error", errorMessage(e)));
    else app.replaceChildren(el("p", "error", errorMessage(e)));
  } finally {
    if (request === latestRequest) {
      refreshButton.disabled = false;
      app.classList.remove("loading");
    }
  }
}

function goTo(view: ViewName, date: Date): void {
  state.view = view;
  state.anchor = startOfDay(date);
  saveView(view);
  void load();
}

function step(direction: 1 | -1): void {
  goTo(state.view, VIEWS[state.view].step(state.anchor, direction));
}

function showCalendar(): void {
  actions.hidden = false;
  toolbar.hidden = false;
  app.replaceChildren(el("p", "empty", "Loading…"));
  void load();
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(load, REFRESH_EVERY_MS);
}

function showSignedOut(error?: string): void {
  window.clearInterval(refreshTimer);
  latestRequest++; // ignore any request still in flight
  cache.clear();
  toggledTasks.clear();
  shown = undefined;
  actions.hidden = true;
  toolbar.hidden = true;
  title.textContent = "Minuteman";
  account.textContent = "";
  banner.replaceChildren();
  app.classList.remove("loading");

  const view = el("div", "sign-in");
  view.append(el("p", "sign-in-text", "Connect your Google account to see your calendars."));
  if (error) view.append(el("p", "error", error));

  const button = el("button", "primary-button", "Sign in with Google");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Continue in your browser…";
    try {
      await signIn();
      showCalendar();
    } catch (e) {
      showSignedOut(errorMessage(e));
    }
  });
  view.append(button);
  app.replaceChildren(view);
}

/** Reloads everything after an event or task was edited or deleted. */
function changed(): void {
  cache.clear();
  announceChange();
  void load();
}

function showDetails(item: AgendaItem): void {
  openDetails(item, {
    toggleTask,
    edit: (it) => openEdit(it, changed),
    deleted: changed,
  });
}

/** Opens "New event" (or task); once it's added, shows the day it's on. */
function newEvent(): void {
  openNew(({ start, allDay }) => {
    cache.clear();
    announceChange();
    if (!start) return void load(); // a task without a date isn't on the calendar
    if (!allDay) reveal = start;
    goTo(state.view, start);
  });
}

/** Opens search; a chosen result shows its day, then its details. */
function searchEvents(): void {
  openSearch((item) => {
    goTo("day", itemStart(item));
    showDetails(item);
  });
}

function setUpControls(): void {
  for (const name of VIEW_ORDER) {
    const spec = VIEWS[name];
    const button = el("button", undefined, spec.label);
    button.dataset.view = name;
    button.title = `${spec.label} (${spec.key.toUpperCase()})`;
    button.addEventListener("click", () => goTo(name, state.anchor));
    viewSwitcher.append(button);
  }

  document.querySelector("#today")!.addEventListener("click", () => goTo(state.view, new Date()));
  document.querySelector("#prev")!.addEventListener("click", () => step(-1));
  document.querySelector("#next")!.addEventListener("click", () => step(1));
  refreshButton.addEventListener("click", load);
  document.querySelector("#new-event")!.addEventListener("click", newEvent);
  document.querySelector("#search")!.addEventListener("click", searchEvents);
  document.querySelector("#todoist")!.addEventListener("click", () =>
    openTodoistSettings(() => {
      cache.clear();
      void load();
    }),
  );
  document.querySelector("#accounts")!.addEventListener("click", () =>
    openAccountsSettings((signedIn) => {
      if (!signedIn) return showSignedOut();
      cache.clear();
      void load();
    }),
  );

  document.addEventListener("keydown", (e) => {
    if (toolbar.hidden || document.querySelector("dialog[open]")) return;
    // Cmd+F (Ctrl+F on Windows) searches, as in most apps.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchEvents();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const key = e.key.toLowerCase();
    const view = VIEW_ORDER.find((name) => VIEWS[name].key === key);
    if (view) goTo(view, state.anchor);
    else if (key === "t") goTo(state.view, new Date());
    else if (key === "n") newEvent();
    else if (key === "/") searchEvents();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else return;
    e.preventDefault();
  });

  // Swipe left/right (touch screens) to go to the next/previous day, week, etc.
  let swipe: { x: number; y: number; time: number } | undefined;
  app.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      swipe = e.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, time: Date.now() } : undefined;
    },
    { passive: true },
  );
  app.addEventListener(
    "touchend",
    (e) => {
      if (!swipe) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      const quick = Date.now() - swipe.time < 600;
      swipe = undefined;
      // Mostly sideways and far enough, so vertical scrolling never flips pages.
      if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );

  // Month and year views size themselves to the window, so redraw them on resize.
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if ((state.view === "month" || state.view === "year") && shown) render(shown.agenda);
    }, 150);
  });
}

async function start(): Promise<void> {
  // In a plain browser (`npm run dev`) there's no Rust side; use sample data.
  if (import.meta.env.DEV && !isTauri()) (await import("./dev-mock")).install();

  // The menu bar window loads this same page (or, to preview it in a browser, add ?flyout).
  const flyoutPreview = import.meta.env.DEV && new URLSearchParams(location.search).has("flyout");
  if (window.__MINUTEMAN_FLYOUT__ || flyoutPreview) return (await import("./flyout")).startFlyout();

  setUpControls();
  // Changed in the menu bar window: show it here too.
  onChangeElsewhere(() => {
    if (toolbar.hidden) return;
    cache.clear();
    void load();
  });
  try {
    if (await authStatus()) showCalendar();
    else showSignedOut();
  } catch (e) {
    showSignedOut(errorMessage(e));
  }
}

void start();
