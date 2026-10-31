// Month view: six weeks of day cells, each listing as many items as fit and
// "+N more" for the rest.
import type { AgendaItem } from "../api";
import { decorateTask, el, makeOpenable, setItemColor } from "../dom";
import { leaveLabel } from "../leave";
import { weatherBadge, weatherOn } from "../weather";
import { enableDayDrag } from "./drag";
import {
  addDays,
  firstDayOfWeek,
  isAllDayLike,
  isSameDay,
  itemEnd,
  itemStart,
  itemsOnDay,
  parseDate,
  timeFormat,
  toDateString,
} from "../time";
import { dayButton, enableCreate } from "./create";
import type { ViewContext } from "./types";

/** Height of one item line in px. Must match --month-line in styles.css. */
const LINE_HEIGHT = 20;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** The day cell under the pointer, for dragging items between days. */
function dayAt(x: number, y: number): Date | null {
  const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>(".month-cell");
  return cell?.dataset.date ? parseDate(cell.dataset.date) : null;
}

function highlight(day: Date | null): void {
  const date = day ? toDateString(day) : "";
  for (const cell of document.querySelectorAll<HTMLElement>(".month-cell")) {
    cell.classList.toggle("drop-target", cell.dataset.date === date);
  }
}

function monthEntry(item: AgendaItem, day: Date, ctx: ViewContext): HTMLElement {
  let node: HTMLElement;
  const startsToday = itemStart(item) >= day;

  if (isAllDayLike(item)) {
    // Multi-day items get a bar segment in each cell. The title shows on the
    // first day and at the start of each week row; other segments stay blank
    // so the bar reads as one continuous strip.
    node = el("div", "month-bar");
    const showTitle = startsToday || day.getDay() === firstDayOfWeek;
    node.textContent = showTitle ? item.title : " ";
    if (!startsToday) node.classList.add("cont-left");
    if (itemEnd(item) > addDays(day, 1)) node.classList.add("cont-right");
  } else {
    node = el("div", "month-event");
    // Tasks get a checkbox here instead of the dot.
    if (item.kind === "event") node.append(el("span", "month-dot"));
    if (startsToday) node.append(el("span", "month-time", timeFormat.format(itemStart(item))));
    node.append(el("span", "month-title", item.title));
    const leave = leaveLabel(item, "month-leave");
    if (leave) node.append(leave);
  }

  node.setAttribute("aria-label", item.title);
  setItemColor(node, item);
  if (item.kind === "event" && itemEnd(item) <= ctx.now) node.classList.add("past");
  decorateTask(node, item, ctx.toggleTask);
  makeOpenable(node, item, ctx.openItem);
  enableDayDrag(node, item, ctx, day, dayAt, highlight);
  return node;
}

export function renderMonth(root: HTMLElement, ctx: ViewContext): void {
  const month = ctx.anchor.getMonth();
  const view = el("div", "month");

  const weekdays = el("div", "month-weekdays");
  for (let i = 0; i < 7; i++) weekdays.append(el("div", "month-weekday", weekdayFormat.format(addDays(ctx.from, i))));

  const grid = el("div", "month-grid");
  const cells: { day: Date; list: HTMLElement }[] = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(ctx.from, i);
    const cell = el("div", "month-cell");
    cell.dataset.date = toDateString(day);
    if (day.getMonth() !== month) cell.classList.add("other-month");
    if (isSameDay(day, ctx.now)) cell.classList.add("today");

    const date = el("button", "month-date", String(day.getDate()));
    date.title = "Show this day";
    dayButton(date, ctx, day);
    const list = el("div", "month-items");
    const head = el("div", "month-head");
    const weather = weatherOn(day);
    if (weather) head.append(weatherBadge(weather));
    head.append(date);
    cell.append(head, list);
    grid.append(cell);
    cells.push({ day, list });
  }

  // Double-click or right-click a day for New event or task on it.
  enableCreate(grid, ctx, (e) => {
    const date = (e.target as Element).closest<HTMLElement>(".month-cell")?.dataset.date;
    return date ? { start: parseDate(date), allDay: true } : null;
  });

  view.append(weekdays, grid);
  root.replaceChildren(view);

  // Now that the grid is on screen, see how many lines fit in a cell.
  const capacity = Math.max(1, Math.floor(cells[0].list.clientHeight / LINE_HEIGHT));
  for (const { day, list } of cells) {
    const items = itemsOnDay(ctx.items, day);
    const shown = items.length > capacity ? capacity - 1 : items.length;
    for (const item of items.slice(0, shown)) list.append(monthEntry(item, day, ctx));
    if (items.length > shown) {
      const more = el("button", "month-more", `+${items.length - shown} more`);
      more.addEventListener("click", () => ctx.goTo("day", day));
      list.append(more);
    }
  }
}
