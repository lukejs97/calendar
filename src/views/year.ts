// Year view: twelve small months. Days are shaded by how busy they are;
// clicking a day opens it, clicking a month name opens the month.
import type { AgendaItem } from "../api";
import { el } from "../dom";
import {
  addDays,
  daysBetween,
  isSameDay,
  itemEnd,
  itemStart,
  startOfDay,
  startOfWeek,
  toDateString,
} from "../time";
import type { ViewContext } from "./types";

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });

/** Number of items touching each day, keyed by "YYYY-MM-DD". */
function countPerDay(items: AgendaItem[], from: Date, to: Date): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const end = itemEnd(item);
    let day = startOfDay(itemStart(item));
    if (day < from) day = from;
    do {
      const key = toDateString(day);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      day = addDays(day, 1);
    } while (day < end && day < to);
  }
  return counts;
}

function busyLevel(count: number): number {
  if (count >= 5) return 3;
  if (count >= 3) return 2;
  return 1;
}

function miniMonth(ctx: ViewContext, first: Date, counts: Map<string, number>): HTMLElement {
  const section = el("section", "mini-month");
  const title = el("button", "mini-title", monthFormat.format(first));
  title.title = "Show this month";
  title.addEventListener("click", () => ctx.goTo("month", first));

  const grid = el("div", "mini-grid");
  const weekStart = startOfWeek(first);
  for (let i = 0; i < 7; i++) grid.append(el("span", "mini-weekday", weekdayFormat.format(addDays(weekStart, i))));
  for (let i = daysBetween(weekStart, first); i > 0; i--) grid.append(el("span"));

  const leading = daysBetween(weekStart, first);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(first.getFullYear(), first.getMonth(), d);
    const button = el("button", "mini-day", String(d));
    const count = counts.get(toDateString(day)) ?? 0;
    if (count > 0) {
      button.classList.add(`busy-${busyLevel(count)}`);
      button.title = `${count} item${count === 1 ? "" : "s"}`;
    }
    if (isSameDay(day, ctx.now)) button.classList.add("today");
    button.addEventListener("click", () => ctx.goTo("day", day));
    grid.append(button);
  }
  // Always six week rows, so every month is the same height.
  for (let i = leading + daysInMonth; i < 42; i++) grid.append(el("span"));

  section.append(title, grid);
  return section;
}

// Keep these in sync with .year / .mini-* in styles.css.
const MONTH_GAP = 16; // px around and between months
const DAY_GAP = 2; // px between days
const MONTH_HEADER = 44; // px: month name (26) + weekday initials (18)
const MIN_DAY = 20; // px: below this, scroll instead of shrinking further
const MAX_DAY = 72;

/**
 * Picks the grid of months (6×2, 4×3, 3×4…) that lets the days be biggest
 * in the available space, and the day size that fills it.
 */
function fitLayout(width: number, height: number): { columns: number; day: number } {
  let best = { columns: 0, day: 0 };
  for (const columns of [12, 6, 4, 3, 2, 1]) {
    const rows = 12 / columns;
    const cellWidth = (width - MONTH_GAP * (columns + 1)) / columns;
    const cellHeight = (height - MONTH_GAP * (rows + 1)) / rows;
    const day = Math.min((cellWidth - 6 * DAY_GAP) / 7, (cellHeight - MONTH_HEADER - 6 * DAY_GAP) / 6);
    if (day > best.day) best = { columns, day };
  }
  return { columns: best.columns, day: Math.floor(Math.min(best.day, MAX_DAY)) };
}

export function renderYear(root: HTMLElement, ctx: ViewContext): void {
  const year = ctx.anchor.getFullYear();
  const counts = countPerDay(ctx.items, ctx.from, ctx.to);
  const view = el("div", "year");
  for (let m = 0; m < 12; m++) view.append(miniMonth(ctx, new Date(year, m, 1), counts));

  const { columns, day } = fitLayout(root.clientWidth, root.clientHeight);
  if (day >= MIN_DAY) {
    view.classList.add("fit");
    view.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    view.style.gridTemplateRows = `repeat(${12 / columns}, minmax(0, 1fr))`;
    view.style.setProperty("--day", `${day}px`);
  }
  // Otherwise the window is too small to fit a whole year: the CSS default
  // wraps months at a readable size and the view scrolls.
  root.replaceChildren(view);
}
