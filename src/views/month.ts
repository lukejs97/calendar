// Month view: six weeks of day cells, each listing as many items as fit and
// "+N more" for the rest.
import type { AgendaItem } from "../api";
import { decorateTask, el, makeOpenable, setItemColor } from "../dom";
import {
  addDays,
  firstDayOfWeek,
  isAllDayLike,
  isSameDay,
  itemEnd,
  itemStart,
  itemsOnDay,
  timeFormat,
} from "../time";
import type { ViewContext } from "./types";

/** Height of one item line in px. Must match --month-line in styles.css. */
const LINE_HEIGHT = 20;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

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
  }

  node.setAttribute("aria-label", item.title);
  setItemColor(node, item);
  if (item.kind === "event" && itemEnd(item) <= ctx.now) node.classList.add("past");
  decorateTask(node, item, ctx.toggleTask);
  makeOpenable(node, item, ctx.openItem);
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
    if (day.getMonth() !== month) cell.classList.add("other-month");
    if (isSameDay(day, ctx.now)) cell.classList.add("today");

    const date = el("button", "month-date", String(day.getDate()));
    date.title = "Show this day";
    date.addEventListener("click", () => ctx.goTo("day", day));
    const list = el("div", "month-items");
    cell.append(date, list);
    grid.append(cell);
    cells.push({ day, list });
  }

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
