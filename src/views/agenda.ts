// Agenda: a list of days with their items, like the original Phase 1 screen.
import type { AgendaItem } from "../api";
import { decorateTask, el, makeOpenable, setItemColor } from "../dom";
import { weatherBadge, weatherOn } from "../weather";
import {
  addDays,
  compareForDay,
  daysBetween,
  itemEnd,
  itemStart,
  startOfDay,
  timeFormat,
} from "../time";
import type { ViewContext } from "./types";

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

interface Day {
  date: Date;
  items: AgendaItem[];
}

/**
 * Buckets items into the days of the range. Multi-day all-day events appear on
 * each of their days; timed events that started before the range (still in
 * progress) appear on its first day.
 */
function groupByDay(items: AgendaItem[], from: Date, days: number): Day[] {
  const buckets: Day[] = Array.from({ length: days }, (_, i) => ({ date: addDays(from, i), items: [] }));

  for (const item of items) {
    const first = Math.max(0, daysBetween(from, itemStart(item)));
    // All-day end is exclusive; timed events are listed on their start day only.
    const last = item.allDay ? daysBetween(from, itemEnd(item)) - 1 : first;
    for (let i = first; i <= Math.min(last, days - 1); i++) buckets[i].items.push(item);
  }

  for (const day of buckets) day.items.sort(compareForDay);
  return buckets.filter((day) => day.items.length > 0);
}

function dayLabel(date: Date, today: Date): string {
  const offset = daysBetween(today, date);
  const name = dayFormat.format(date);
  if (offset === 0) return `Today · ${name}`;
  if (offset === 1) return `Tomorrow · ${name}`;
  if (offset === -1) return `Yesterday · ${name}`;
  return name;
}

function timeLabel(item: AgendaItem, day: Date): HTMLElement {
  const time = el("div", "item-time");
  const start = itemStart(item);
  const end = itemEnd(item);
  if (item.overdue) {
    time.textContent = "Overdue";
  } else if (item.allDay) {
    // A task due "today" has no time; "All day" would read oddly.
    time.textContent = item.kind === "task" ? "" : "All day";
  } else if (start < day) {
    time.textContent = `until ${timeFormat.format(end)}`;
  } else {
    time.append(el("span", undefined, timeFormat.format(start)));
    if (end > start) time.append(el("span", "item-end", timeFormat.format(end)));
  }
  return time;
}

function renderItem(item: AgendaItem, day: Date, ctx: ViewContext): HTMLElement {
  const li = el("li", "item");
  setItemColor(li, item);
  // Tasks stay at full strength until done, even once their time has passed.
  if (item.kind === "event" && itemEnd(item) <= ctx.now) li.classList.add("past");

  const body = el("div", "item-body");
  body.append(el("div", "item-title", item.title));
  const meta = [item.location, item.listName].filter(Boolean).join(" · ");
  body.append(el("div", "item-meta", meta));

  // Events get a color bar; tasks get a checkbox in the same spot.
  if (item.kind === "event") li.append(el("span", "item-bar"));
  li.append(timeLabel(item, day), body);
  decorateTask(li, item, ctx.toggleTask);
  makeOpenable(li, item, ctx.openItem);
  return li;
}

export function renderAgenda(root: HTMLElement, ctx: ViewContext): void {
  const days = daysBetween(ctx.from, ctx.to);
  const today = startOfDay(ctx.now);
  const list = el("div", "agenda");

  const grouped = groupByDay(ctx.items, ctx.from, days);
  if (grouped.length === 0) {
    list.append(el("p", "empty", `Nothing on your calendars in these ${days} days.`));
  }

  for (const day of grouped) {
    const section = el("section", "day");
    if (daysBetween(today, day.date) === 0) section.classList.add("today");
    const label = el("h2", "day-label", dayLabel(day.date, today));
    const weather = weatherOn(day.date);
    if (weather) label.append(weatherBadge(weather, true));
    section.append(label);
    const items = el("ul", "items");
    for (const item of day.items) items.append(renderItem(item, day.date, ctx));
    section.append(items);
    list.append(section);
  }

  root.replaceChildren(list);
}
