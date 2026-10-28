// Day and week views: a column per day with hours down the side. Timed
// events are blocks sized by duration; all-day and multi-day items are bars in
// a strip above the hours.
import type { AgendaItem } from "../api";
import { decorateTask, el, makeOpenable, setItemColor } from "../dom";
import {
  addDays,
  compareForDay,
  daysBetween,
  isAllDayLike,
  isSameDay,
  itemEnd,
  itemStart,
  MS_PER_MINUTE,
  overlaps,
  timeFormat,
} from "../time";
import type { ViewContext } from "./types";

const HOUR_HEIGHT = 48; // px
const PX_PER_MS = HOUR_HEIGHT / (60 * MS_PER_MINUTE);
const MIN_EVENT_HEIGHT = 18; // px, so short events stay clickable and readable
const MIN_EVENT_MS = MIN_EVENT_HEIGHT / PX_PER_MS;
/** Dragged events move and resize in steps of this many minutes. */
const SNAP_MINUTES = 15;
/** px at the bottom of an event that resize it instead of moving it. */
const RESIZE_HANDLE = 7;
/** px the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

/** The part of a timed event that falls on one day, and where it sits side by side. */
interface Segment {
  item: AgendaItem;
  start: number;
  end: number;
  column: number;
  columns: number;
}

/**
 * Places overlapping events side by side. Events are grouped into clusters of
 * ones that (transitively) overlap; each takes the first free column in its
 * cluster, and everything in a cluster shares its width equally.
 */
function layoutColumns(segments: Segment[]): void {
  segments.sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: Segment[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    for (const seg of cluster) seg.columns = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };

  for (const seg of segments) {
    // Use the drawn height, so tiny events that look overlapping are treated so.
    const visualEnd = Math.max(seg.end, seg.start + MIN_EVENT_MS);
    if (seg.start >= clusterEnd) closeCluster();
    let column = columnEnds.findIndex((end) => end <= seg.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(visualEnd);
    } else {
      columnEnds[column] = visualEnd;
    }
    seg.column = column;
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, visualEnd);
  }
  closeCluster();
}

function positionNowLine(line: HTMLElement): void {
  line.style.top = `${(Date.now() - Number(line.dataset.dayStart)) * PX_PER_MS}px`;
}

// Keep the red "now" line moving without re-drawing the view.
setInterval(() => document.querySelectorAll<HTMLElement>(".tl-now").forEach(positionNowLine), MS_PER_MINUTE);

function headerRow(ctx: ViewContext, days: Date[]): HTMLElement {
  const row = el("div", "tl-row tl-header");
  row.append(el("div", "tl-gutter"));
  for (const day of days) {
    const cell = el("button", "tl-day-header");
    if (isSameDay(day, ctx.now)) cell.classList.add("today");
    cell.append(el("span", "tl-weekday", weekdayFormat.format(day)), el("span", "tl-date", String(day.getDate())));
    cell.title = "Show this day";
    cell.addEventListener("click", () => ctx.goTo("day", day));
    row.append(cell);
  }
  return row;
}

/** Bars for all-day and multi-day items, stacked into lanes so they don't overlap. */
function allDayRow(ctx: ViewContext, days: Date[]): HTMLElement {
  const row = el("div", "tl-row tl-allday");
  const label = el("div", "tl-gutter tl-allday-label", "all-day");
  row.append(label);

  const rangeStart = days[0];
  const rangeEnd = addDays(days[days.length - 1], 1);
  const items = ctx.items
    .filter((item) => isAllDayLike(item) && overlaps(item, rangeStart, rangeEnd))
    .sort(compareForDay);

  const laneEnds: number[] = [];
  for (const item of items) {
    const first = Math.max(0, daysBetween(rangeStart, itemStart(item)));
    const last = Math.min(days.length - 1, daysBetween(rangeStart, new Date(itemEnd(item).getTime() - 1)));
    let lane = laneEnds.findIndex((end) => end < first);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(last);
    } else {
      laneEnds[lane] = last;
    }

    const bar = el("div", "tl-allday-item", item.title);
    setItemColor(bar, item);
    bar.style.gridColumn = `${first + 2} / ${last + 3}`; // +1 for the gutter, +1 because grid lines start at 1
    bar.style.gridRow = String(lane + 1);
    if (itemStart(item) < rangeStart) bar.classList.add("cont-left");
    if (itemEnd(item) > rangeEnd) bar.classList.add("cont-right");
    if (item.kind === "event" && itemEnd(item) <= ctx.now) bar.classList.add("past");
    decorateTask(bar, item, ctx.toggleTask);
    makeOpenable(bar, item, ctx.openItem);
    row.append(bar);
  }
  label.style.gridRow = `1 / span ${Math.max(1, laneEnds.length)}`;
  return row;
}

function eventBlock(seg: Segment, dayStart: number, ctx: ViewContext): HTMLElement {
  const { item } = seg;
  const block = el("div", "tl-event");
  setItemColor(block, item);
  if (item.kind === "event" && itemEnd(item) <= ctx.now) block.classList.add("past");

  const height = Math.max(MIN_EVENT_HEIGHT, (seg.end - seg.start) * PX_PER_MS);
  block.style.top = `${(seg.start - dayStart) * PX_PER_MS}px`;
  block.style.height = `${height}px`;
  block.style.left = `${(seg.column / seg.columns) * 100}%`;
  block.style.width = `calc(${100 / seg.columns}% - 2px)`;

  const start = timeFormat.format(itemStart(item));
  if (height < 34) {
    // Too short for two lines: "9:30 AM Standup".
    block.classList.add("compact");
    block.append(el("span", "tl-event-time", start), " ", el("span", "tl-event-title", item.title));
  } else {
    // Tasks often have a due time but no duration: show just the time.
    const range = seg.end > seg.start ? `${start} – ${timeFormat.format(itemEnd(item))}` : start;
    block.append(el("div", "tl-event-title", item.title), el("div", "tl-event-time", range));
    if (item.location && height >= 56) block.append(el("div", "tl-event-time", item.location));
  }
  decorateTask(block, item, ctx.toggleTask);
  makeOpenable(block, item, ctx.openItem);
  if (item.editable && item.kind === "event") enableDrag(block, item, ctx);
  return block;
}

/** Same local time of day, `days` later, plus `minutes`. Safe across DST changes. */
function shift(d: Date, days: number, minutes: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes() + minutes);
}

/**
 * Lets an event be dragged to another time (or day, in week view), or made
 * longer or shorter by dragging its bottom edge. Mouse and trackpad only: on
 * touch screens a finger drag scrolls the view.
 */
function enableDrag(block: HTMLElement, item: AgendaItem, ctx: ViewContext): void {
  block.classList.add("editable");
  block.addEventListener("pointerdown", (down) => {
    if (down.pointerType !== "mouse" || down.button !== 0) return;
    const resizing = down.clientY > block.getBoundingClientRect().bottom - RESIZE_HANDLE;
    const columns = [...(block.closest(".tl-grid")?.querySelectorAll<HTMLElement>(".tl-col") ?? [])];
    const homeColumn = columns.indexOf(block.parentElement as HTMLElement);
    const start = itemStart(item);
    const end = itemEnd(item);
    const top = parseFloat(block.style.top);
    const height = parseFloat(block.style.height);
    const label = block.querySelector<HTMLElement>(".tl-event-time");
    let minutes = 0;
    let days = 0;
    let dragging = false;

    const times = (): [Date, Date] =>
      resizing ? [start, shift(end, 0, minutes)] : [shift(start, days, minutes), shift(end, days, minutes)];

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      const dy = e.clientY - down.clientY;
      if (!dragging) {
        if (Math.hypot(e.clientX - down.clientX, dy) < DRAG_THRESHOLD) return;
        dragging = true;
        block.classList.add("dragging");
      }
      minutes = Math.round(dy / HOUR_HEIGHT * 60 / SNAP_MINUTES) * SNAP_MINUTES;
      if (resizing) {
        // At least one step long.
        minutes = Math.max(minutes, SNAP_MINUTES - Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE));
        block.style.height = `${Math.max(MIN_EVENT_HEIGHT, height + minutes * HOUR_HEIGHT / 60)}px`;
      } else {
        const over = columns.findIndex((column) => {
          const rect = column.getBoundingClientRect();
          return e.clientX >= rect.left && e.clientX < rect.right;
        });
        if (over >= 0 && over - homeColumn !== days) {
          days = over - homeColumn;
          columns[over].append(block);
        }
        block.style.top = `${top + minutes * HOUR_HEIGHT / 60}px`;
      }
      const [newStart, newEnd] = times();
      if (label) label.textContent = `${timeFormat.format(newStart)} – ${timeFormat.format(newEnd)}`;
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (e.type === "pointercancel") minutes = days = 0;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!dragging) return;
      // Wait for the click that follows, so it doesn't open the details.
      window.setTimeout(() => {
        const [newStart, newEnd] = times();
        if (newStart.getTime() === start.getTime() && newEnd.getTime() === end.getTime()) {
          block.classList.remove("dragging");
          ctx.moveItem(item, start, end); // puts it back where it was
        } else {
          ctx.moveItem(item, newStart, newEnd);
        }
      });
    };

    // On the window, not the block: moving the block to another day's column
    // would end pointer capture and lose the rest of the drag.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

function dayColumn(ctx: ViewContext, day: Date): HTMLElement {
  const column = el("div", "tl-col");
  const next = addDays(day, 1);
  const dayStart = day.getTime();

  if (isSameDay(day, ctx.now)) {
    column.classList.add("today");
    const line = el("div", "tl-now");
    line.dataset.dayStart = String(dayStart);
    positionNowLine(line);
    column.append(line);
  }

  const segments: Segment[] = ctx.items
    .filter((item) => !isAllDayLike(item) && overlaps(item, day, next))
    .map((item) => ({
      item,
      // Events crossing midnight are cut at the day's edges.
      start: Math.max(itemStart(item).getTime(), dayStart),
      end: Math.min(itemEnd(item).getTime(), next.getTime()),
      column: 0,
      columns: 1,
    }));
  layoutColumns(segments);
  for (const seg of segments) column.append(eventBlock(seg, dayStart, ctx));
  return column;
}

export function renderTimeline(root: HTMLElement, ctx: ViewContext, days: Date[]): void {
  const timeline = el("div", "timeline");
  timeline.style.setProperty("--columns", String(days.length));
  timeline.style.setProperty("--hour-height", `${HOUR_HEIGHT}px`);
  if (days.length === 1) timeline.classList.add("single-day");

  const body = el("div", "tl-body");
  const grid = el("div", "tl-row tl-grid");
  const hours = el("div", "tl-gutter tl-hours");
  for (let h = 1; h < 24; h++) {
    const label = el("span", "tl-hour", hourFormat.format(new Date(2000, 0, 1, h)));
    label.style.top = `${h * HOUR_HEIGHT}px`;
    hours.append(label);
  }
  grid.append(hours, ...days.map((day) => dayColumn(ctx, day)));
  body.append(grid);

  timeline.append(headerRow(ctx, days), allDayRow(ctx, days), body);

  const previousScroll = ctx.preserveScroll ? root.querySelector(".tl-body")?.scrollTop : undefined;
  root.replaceChildren(timeline);
  if (ctx.reveal) {
    body.scrollTop = Math.max(0, ctx.reveal.getHours() - 1) * HOUR_HEIGHT;
  } else if (previousScroll !== undefined) {
    body.scrollTop = previousScroll;
  } else {
    // Start at 7 AM, or a couple of hours before now when today is shown.
    const showsToday = days.some((day) => isSameDay(day, ctx.now));
    body.scrollTop = (showsToday ? Math.max(0, ctx.now.getHours() - 2) : 7) * HOUR_HEIGHT;
  }
}
