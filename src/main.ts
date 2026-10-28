import { isTauri } from "@tauri-apps/api/core";
import {
  authStatus,
  errorMessage,
  getAgenda,
  isNotSignedIn,
  setTaskCompleted,
  signIn,
  signOut,
  type Agenda,
  type AgendaItem,
} from "./api";
import { el } from "./dom";
import { openTodoistSettings } from "./settings";
import { overlaps, startOfDay, toDateString } from "./time";
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
const signOutButton = document.querySelector<HTMLButtonElement>("#sign-out")!;

const state = { view: savedView(), anchor: startOfDay(new Date()) };

/** Recently loaded ranges, so going back and forth shows something instantly. */
const cache = new Map<string, Agenda>();
/** Tasks ticked off or back on in this session, by id. */
const toggledTasks = new Map<string, AgendaItem>();
/** What's on screen, so auto-refresh and resizing can redraw it in place. */
let shown: { view: ViewName; range: string; agenda: Agenda } | undefined;
let latestRequest = 0;
let refreshTimer: number | undefined;

function savedView(): ViewName {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved && saved in VIEWS) return saved as ViewName;
  } catch {
    // Storage unavailable; use the default.
  }
  return "week";
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
  account.textContent = agenda.account ?? "";
  banner.replaceChildren(...agenda.warnings.map((w) => el("p", "warning", `Couldn't load ${w}`)));
  VIEWS[state.view].render(app, {
    items: itemsToShow(agenda, from, to),
    from,
    to,
    anchor: state.anchor,
    now: new Date(),
    preserveScroll: shown?.view === state.view && shown.range === key,
    goTo,
    toggleTask,
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

function updateToolbar(): void {
  title.textContent = VIEWS[state.view].title(state.anchor);
  for (const button of viewSwitcher.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
}

/** Shows the current view: from the cache right away if possible, then fresh from Google. */
async function load(): Promise<void> {
  const { from, to, key } = currentRange();
  updateToolbar();

  const cached = cache.get(key);
  if (cached) render(cached);
  else app.classList.add("loading");

  const request = ++latestRequest;
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
  title.textContent = "Calendar";
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
  document.querySelector("#todoist")!.addEventListener("click", () =>
    openTodoistSettings(() => {
      cache.clear();
      void load();
    }),
  );
  signOutButton.addEventListener("click", async () => {
    await signOut().catch(() => {});
    showSignedOut();
  });

  document.addEventListener("keydown", (e) => {
    if (toolbar.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const key = e.key.toLowerCase();
    const view = VIEW_ORDER.find((name) => VIEWS[name].key === key);
    if (view) goTo(view, state.anchor);
    else if (key === "t") goTo(state.view, new Date());
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else return;
    e.preventDefault();
  });

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

  setUpControls();
  try {
    if (await authStatus()) showCalendar();
    else showSignedOut();
  } catch (e) {
    showSignedOut(errorMessage(e));
  }
}

void start();
