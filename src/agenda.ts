// Renders an Agenda as a list of days. Kept free of app state so the future
// tray flyout can reuse it for "today only".
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Agenda, AgendaItem } from "./api";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parses "YYYY-MM-DD" as local midnight (`new Date("2026-10-27")` would be UTC). */
function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

const startOf = (item: AgendaItem) => (item.allDay ? parseDate(item.start) : new Date(item.start));

function endOf(item: AgendaItem): Date {
  if (item.end) return item.allDay ? parseDate(item.end) : new Date(item.end);
  return item.allDay ? addDays(startOf(item), 1) : startOf(item);
}

interface Day {
  date: Date;
  items: AgendaItem[];
}

/**
 * Buckets items into days from `today` to `today + days`. Multi-day all-day
 * events appear on each of their days; timed events that started before today
 * (still in progress) appear under today.
 */
function groupByDay(items: AgendaItem[], today: Date, days: number): Day[] {
  const buckets: Day[] = Array.from({ length: days }, (_, i) => ({ date: addDays(today, i), items: [] }));
  const indexOf = (d: Date) => Math.round((startOfDay(d).getTime() - today.getTime()) / MS_PER_DAY);

  for (const item of items) {
    const first = Math.max(0, indexOf(startOf(item)));
    // All-day end is exclusive; timed events are listed on their start day only.
    const last = item.allDay ? indexOf(endOf(item)) - 1 : first;
    for (let i = first; i <= Math.min(last, days - 1); i++) buckets[i].items.push(item);
  }

  for (const day of buckets) {
    day.items.sort(
      (a, b) => Number(b.allDay) - Number(a.allDay) || startOf(a).getTime() - startOf(b).getTime(),
    );
  }
  return buckets.filter((day) => day.items.length > 0);
}

function dayLabel(date: Date, today: Date): string {
  const offset = Math.round((date.getTime() - today.getTime()) / MS_PER_DAY);
  const name = dayFormat.format(date);
  if (offset === 0) return `Today · ${name}`;
  if (offset === 1) return `Tomorrow · ${name}`;
  return name;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderItem(item: AgendaItem, day: Date, now: Date): HTMLElement {
  const li = el("li", "item");
  li.style.setProperty("--item-color", item.color ?? "var(--accent)");
  if (endOf(item) <= now) li.classList.add("past");

  const time = el("div", "item-time");
  if (item.allDay) {
    time.textContent = "All day";
  } else if (startOf(item) < day) {
    time.textContent = `until ${timeFormat.format(endOf(item))}`;
  } else {
    time.append(el("span", undefined, timeFormat.format(startOf(item))));
    if (item.end) time.append(el("span", "item-end", timeFormat.format(endOf(item))));
  }

  const body = el("div", "item-body");
  body.append(el("div", "item-title", item.title));
  const meta = [item.location, item.listName].filter(Boolean).join(" · ");
  body.append(el("div", "item-meta", meta));

  li.append(el("span", "item-bar"), time, body);

  if (item.url) {
    const url = item.url;
    li.tabIndex = 0;
    li.role = "link";
    li.title = "Open in Google Calendar";
    li.addEventListener("click", () => openUrl(url));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openUrl(url);
    });
  }
  return li;
}

export function renderAgenda(root: HTMLElement, agenda: Agenda, days: number): void {
  const now = new Date();
  const today = startOfDay(now);
  const fragment = document.createDocumentFragment();

  for (const warning of agenda.warnings) {
    fragment.append(el("p", "warning", `Couldn't load ${warning}`));
  }

  const grouped = groupByDay(agenda.items, today, days);
  if (grouped.length === 0) {
    fragment.append(el("p", "empty", `Nothing on your calendars for the next ${days} days.`));
  }

  for (const day of grouped) {
    const section = el("section", "day");
    section.append(el("h2", "day-label", dayLabel(day.date, today)));
    const list = el("ul", "items");
    for (const item of day.items) list.append(renderItem(item, day.date, now));
    section.append(list);
    fragment.append(section);
  }

  root.replaceChildren(fragment);
}
