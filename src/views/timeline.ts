// Day and week views: a column per day with hours down the side. Timed
// events are blocks sized by duration; all-day and multi-day items are bars in
// a strip above the hours.
//
// Week view draws six weeks but shows seven days at a time. They slide
// sideways under the trackpad, settling on a day, as in Apple's Calendar; the
// view is told which day is first, and draws a new six weeks around it when
// it gets near either end.
import type { AgendaItem } from "../api";
import { decorateTask, el, makeOpenable, setItemColor } from "../dom";
import {
  hourHeight as savedHourHeight,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
  setHourHeight,
} from "../preferences";
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
import { dayButton, enableCreate } from "./create";
import { enableDayDrag } from "./drag";
import type { ViewContext } from "./types";

const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** px per hour. Pinching changes it (see `enablePinch`); it's kept per device. */
let hourHeight = savedHourHeight();
const MIN_EVENT_HEIGHT = 18; // px, so short events stay clickable and readable
const minEventMs = () => (MIN_EVENT_HEIGHT / hourHeight) * MS_PER_HOUR;

/**
 * A vertical position or length for `ms` of time, in CSS that follows
 * --hour-height, so a pinch can stretch the whole view without redrawing it.
 */
const timeLength = (ms: number) => `calc(var(--hour-height) * ${ms / MS_PER_HOUR})`;
/** Dragged events move and resize in steps of this many minutes. */
const SNAP_MINUTES = 15;
/** px at the bottom of an event that resize it instead of moving it. */
const RESIZE_HANDLE = 7;
/** px the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

/** The part of a timed event that falls on one day, and where it sits. */
interface Segment {
  item: AgendaItem;
  start: number;
  end: number;
  /** Side by side with events that start at about the same time. */
  column: number;
  columns: number;
  /** Drawn over events it starts well after, this many steps in from the left. */
  indent: number;
}

/** px each step of `Segment.indent` moves an event in. */
const INDENT = 14;
/** At most this many steps in, so a busy day stays readable. */
const MAX_INDENT = 4;
/**
 * An event starting at least this many px (a line) below another that's
 * still on leaves the other's title showing, so it's drawn on top
 * (indented), as in Apple's Calendar, rather than both squeezed side by side.
 */
const ROOM_FOR_TITLE = 20;

/**
 * Lays out the day's timed events. One that starts well after an event
 * that's still on goes on top of it, a step in from the left; ones starting
 * at about the same time share the width side by side, in a group.
 */
function layoutColumns(segments: Segment[]): void {
  segments.sort((a, b) => a.start - b.start || b.end - a.end);
  // Use the drawn height, so tiny events that look overlapping are treated so.
  const visualEnd = (seg: Segment) => Math.max(seg.end, seg.start + minEventMs());
  const titleRoom = Math.max((ROOM_FOR_TITLE / hourHeight) * MS_PER_HOUR, 15 * MS_PER_MINUTE);
  const groupOf = new Map<Segment, { columnEnds: number[]; members: Segment[] }>();
  const placed: Segment[] = [];

  for (const seg of segments) {
    const under = placed.filter((p) => p.start < visualEnd(seg) && visualEnd(p) > seg.start);
    const close = under.find((p) => seg.start - p.start < titleRoom);
    if (close) {
      // Starts with `close`: side by side with its group.
      const group = groupOf.get(close)!;
      seg.indent = close.indent;
      let column = group.columnEnds.findIndex((end) => end <= seg.start);
      if (column === -1) column = group.columnEnds.push(0) - 1;
      group.columnEnds[column] = visualEnd(seg);
      seg.column = column;
      group.members.push(seg);
      groupOf.set(seg, group);
    } else {
      // Starts on its own, or well after everything still on: on top of them.
      seg.indent = under.length ? Math.min(MAX_INDENT, Math.max(...under.map((p) => p.indent)) + 1) : 0;
      seg.column = 0;
      groupOf.set(seg, { columnEnds: [visualEnd(seg)], members: [seg] });
    }
    placed.push(seg);
  }
  for (const seg of segments) seg.columns = groupOf.get(seg)!.columnEnds.length;
}

function positionNowLine(line: HTMLElement): void {
  line.style.top = timeLength(Date.now() - Number(line.dataset.dayStart));
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
    dayButton(cell, ctx, day);
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
    // Drag along the row to another day; the day headers say which.
    const dayAt = (x: number) => {
      const headers = [...row.parentElement!.querySelectorAll<HTMLElement>(".tl-day-header")];
      const index = headers.findIndex((h) => {
        const r = h.getBoundingClientRect();
        return x >= r.left && x < r.right;
      });
      return index >= 0 ? days[index] : null;
    };
    const highlight = (day: Date | null) => {
      row.parentElement!.querySelectorAll<HTMLElement>(".tl-day-header").forEach((h, i) =>
        h.classList.toggle("drop-target", day !== null && isSameDay(days[i], day)),
      );
    };
    enableDayDrag(bar, item, ctx, days[first], dayAt, highlight);
    row.append(bar);
  }
  label.style.gridRow = `1 / span ${Math.max(1, laneEnds.length)}`;
  enableAllDayScroll(row, laneEnds.length);
  // Double-click or right-click under a day for an all-day item on it.
  enableCreate(row, ctx, (e) => {
    const headers = [...row.parentElement!.querySelectorAll<HTMLElement>(".tl-day-header")];
    const index = headers.findIndex((h) => {
      const r = h.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right;
    });
    return index >= 0 ? { start: days[index], allDay: true } : null;
  });
  return row;
}

/** A lane of all-day bars: 22px tall plus a 2px gap; keep in sync with .tl-allday. */
const ALL_DAY_LANE = 24;

/**
 * More lanes of all-day items than fit (3½ on a phone, 7½ in a wider
 * window): the row shows that many, and the rest scrolls into view (wheel
 * or finger), every day's column together. Not a real scroller, so its
 * "all-day" label still stays put as the days slide.
 */
function enableAllDayScroll(row: HTMLElement, lanes: number): void {
  const shown = window.matchMedia("(max-width: 640px)").matches ? 3.5 : 7.5;
  if (lanes <= Math.floor(shown)) return;
  row.classList.add("overflowing");
  row.style.setProperty("--all-day-lanes", String(shown));
  let offset = 0;
  const scrollBy = (dy: number): boolean => {
    const padding = 6; // .tl-allday's, top and bottom
    const max = Math.max(0, lanes * ALL_DAY_LANE - 2 + padding - row.clientHeight);
    const next = Math.min(Math.max(offset + dy, 0), max);
    if (next === offset) return false;
    offset = next;
    row.style.setProperty("--all-day-offset", `${-offset}px`);
    return true;
  };

  // At either end, the wheel goes on to scroll the hours as usual.
  row.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (scrollBy(e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY)) e.preventDefault();
    },
    { passive: false },
  );
  // Fingers: up and down here (CSS leaves sideways to the browser, to slide the days).
  let lastY: number | null = null;
  row.addEventListener("touchstart", (e) => (lastY = e.touches.length === 1 ? e.touches[0].clientY : null), {
    passive: true,
  });
  row.addEventListener(
    "touchmove",
    (e) => {
      if (lastY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      scrollBy(lastY - y);
      lastY = y;
    },
    { passive: true },
  );
  row.addEventListener("touchend", () => (lastY = null));
}

function eventBlock(seg: Segment, dayStart: number, ctx: ViewContext): HTMLElement {
  const { item } = seg;
  const block = el("div", "tl-event");
  setItemColor(block, item);
  if (item.kind === "event" && itemEnd(item) <= ctx.now) block.classList.add("past");

  // Height now, to choose a layout; the block itself follows --hour-height.
  const height = Math.max(MIN_EVENT_HEIGHT, ((seg.end - seg.start) / MS_PER_HOUR) * hourHeight);
  block.style.top = timeLength(seg.start - dayStart);
  block.style.height = `max(${MIN_EVENT_HEIGHT}px, ${timeLength(seg.end - seg.start)})`;
  const inset = seg.indent * INDENT;
  block.style.left = `calc(${inset}px + (100% - ${inset}px) * ${seg.column / seg.columns})`;
  block.style.width = `calc((100% - ${inset}px) / ${seg.columns} - 2px)`;

  const start = timeFormat.format(itemStart(item));
  if (height < 34) {
    // Too short for two lines: "9:30 AM Standup".
    block.classList.add("compact");
    block.append(el("span", "tl-event-time", start), " ", el("span", "tl-event-title", item.title));
  } else {
    // Tasks often have a due time but no duration: show just the time.
    const range = seg.end > seg.start ? `${start} – ${timeFormat.format(itemEnd(item))}` : start;
    block.append(el("div", "tl-event-title", item.title), el("div", "tl-event-time", range));
    // From an hour long (at the usual size) there's room for the place too.
    if (item.location && height >= 44) block.append(el("div", "tl-event-time tl-event-place", item.location));
  }
  decorateTask(block, item, ctx.toggleTask);
  makeOpenable(block, item, ctx.openItem);
  if (item.editable) enableDrag(block, item, ctx);
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
  // Events can also be stretched; tasks only moved (their length is optional).
  const resizable = item.kind === "event";
  block.classList.add(resizable ? "editable" : "movable");
  block.addEventListener("pointerdown", (down) => {
    if (down.pointerType !== "mouse" || down.button !== 0) return;
    if ((down.target as Element).closest(".task-check")) return;
    const resizing = resizable && down.clientY > block.getBoundingClientRect().bottom - RESIZE_HANDLE;
    const columns = [...(block.closest(".tl-grid")?.querySelectorAll<HTMLElement>(".tl-col") ?? [])];
    const homeColumn = columns.indexOf(block.parentElement as HTMLElement);
    const start = itemStart(item);
    const end = itemEnd(item);
    const top = block.offsetTop;
    const height = block.offsetHeight;
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
      minutes = Math.round(dy / hourHeight * 60 / SNAP_MINUTES) * SNAP_MINUTES;
      if (resizing) {
        // At least one step long.
        minutes = Math.max(minutes, SNAP_MINUTES - Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE));
        block.style.height = `${Math.max(MIN_EVENT_HEIGHT, height + minutes * hourHeight / 60)}px`;
      } else {
        const over = columns.findIndex((column) => {
          const rect = column.getBoundingClientRect();
          return e.clientX >= rect.left && e.clientX < rect.right;
        });
        if (over >= 0 && over - homeColumn !== days) {
          days = over - homeColumn;
          columns[over].append(block);
        }
        block.style.top = `${top + minutes * hourHeight / 60}px`;
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
      indent: 0,
    }));
  layoutColumns(segments);
  for (const seg of segments) column.append(eventBlock(seg, dayStart, ctx));
  // Double-click or right-click an empty spot for an item then (15-minute steps).
  enableCreate(column, ctx, (e) => {
    const y = e.clientY - column.getBoundingClientRect().top;
    const minutes = Math.floor(((y / hourHeight) * 60) / SNAP_MINUTES) * SNAP_MINUTES;
    const clamped = Math.min(Math.max(minutes, 0), 24 * 60 - SNAP_MINUTES);
    return { start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, clamped), allDay: false };
  });
  return column;
}

/** The sliding strip of each week view on screen, for `slideTimeline`. */
const sliders = new WeakMap<HTMLElement, { days: Date[]; column: () => number }>();

/**
 * Draws `days`, `visible` of them across the window at a time (all of them
 * unless sliding), starting at `ctx.anchor`.
 */
export function renderTimeline(root: HTMLElement, ctx: ViewContext, days: Date[], visible = days.length): void {
  const timeline = el("div", "timeline");
  timeline.style.setProperty("--columns", String(days.length));
  timeline.style.setProperty("--hour-height", `${hourHeight}px`);
  if (days.length === 1) timeline.classList.add("single-day");

  // One box scrolls both ways; the day headers stay at the top and the hours
  // at the left (CSS position: sticky).
  const scroller = el("div", "tl-scroll");
  const sliding = days.length > visible;
  if (sliding) scroller.classList.add("sliding");
  const top = el("div", "tl-top");
  top.append(headerRow(ctx, days), allDayRow(ctx, days));
  const grid = el("div", "tl-row tl-grid");
  const hours = el("div", "tl-gutter tl-hours");
  for (let h = 1; h < 24; h++) {
    const label = el("span", "tl-hour", hourFormat.format(new Date(2000, 0, 1, h)));
    label.style.top = timeLength(h * MS_PER_HOUR);
    hours.append(label);
  }
  grid.append(hours, ...days.map((day) => dayColumn(ctx, day)));
  scroller.append(top, grid);
  timeline.append(scroller);

  const previousScroll = ctx.preserveScroll ? root.querySelector(".tl-scroll")?.scrollTop : undefined;
  root.replaceChildren(timeline);

  // Columns are a seventh (or all) of the width beside the hours.
  let first = Math.min(Math.max(0, daysBetween(days[0], ctx.anchor)), days.length - visible);
  let column = 0;
  const size = () => {
    const gutter = parseFloat(getComputedStyle(timeline).getPropertyValue("--gutter")) || 56;
    column = Math.max(1, (scroller.clientWidth - gutter) / visible);
    timeline.style.setProperty("--column", `${column}px`);
    timeline.classList.toggle("narrow", column < 80);
    scroller.scrollLeft = first * column;
  };
  size();
  const resized = new ResizeObserver(() => {
    if (!scroller.isConnected) return resized.disconnect();
    size();
  });
  resized.observe(scroller);

  if (sliding) {
    sliders.set(root, { days, column: () => column });
    let settle: number | undefined;
    scroller.addEventListener(
      "scroll",
      () => {
        // A replaced view's box reports scrolling back to 0 as it goes.
        if (!scroller.isConnected) return;
        const index = Math.round(scroller.scrollLeft / column);
        if (index !== first) {
          first = index;
          ctx.slid?.(days[first], false);
        }
        window.clearTimeout(settle);
        settle = window.setTimeout(() => {
          if (scroller.isConnected) ctx.slid?.(days[first], true);
        }, 200);
      },
      { passive: true },
    );
  }

  if (ctx.reveal) {
    scroller.scrollTop = Math.max(0, ctx.reveal.getHours() - 1) * hourHeight;
  } else if (previousScroll !== undefined) {
    scroller.scrollTop = previousScroll;
  } else {
    // Start at 7 AM, or a couple of hours before now when today is shown.
    const shown = days.slice(first, first + visible);
    const showsToday = shown.some((day) => isSameDay(day, ctx.now));
    scroller.scrollTop = (showsToday ? Math.max(0, ctx.now.getHours() - 2) : 7) * hourHeight;
  }

  // After a pinch, draw again at the new size (short events change layout),
  // keeping the days and hours on screen where they are.
  enablePinch(scroller, timeline, () =>
    renderTimeline(root, { ...ctx, anchor: days[first], preserveScroll: true, reveal: undefined }, days, visible),
  );
}

/**
 * Pinching up and down shows more or fewer hours: two fingers on a touch
 * screen, or a trackpad pinch (which browsers report as ctrl + mouse wheel,
 * and Safari as "gesture" events). Only the vertical spread of the fingers
 * counts. The time under the fingers stays where it is. Once the pinch ends,
 * the size is saved and `redraw` runs.
 */
function enablePinch(scroller: HTMLElement, timeline: HTMLElement, redraw: () => void): void {
  let settle: number | undefined;
  /** Where the hours start inside the scrolling content, in px. */
  const gridTop = () => {
    const grid = scroller.querySelector<HTMLElement>(".tl-grid")!;
    return grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  };

  /** Sets the hour height, keeping the time at `clientY` (a screen position) in place. */
  const zoomTo = (height: number, clientY: number) => {
    height = Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, height));
    if (Math.abs(height - hourHeight) < 0.1) return;
    const offset = clientY - scroller.getBoundingClientRect().top;
    const top = gridTop();
    const hoursAtPoint = (scroller.scrollTop + offset - top) / hourHeight;
    hourHeight = height;
    timeline.style.setProperty("--hour-height", `${height}px`);
    scroller.scrollTop = top + hoursAtPoint * height - offset;
  };

  const finish = () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => {
      setHourHeight(hourHeight);
      if (scroller.isConnected) redraw();
    }, 250);
  };

  // Trackpad pinch (and ctrl + mouse wheel). Not passive: it stops the
  // browser zooming the whole page instead.
  scroller.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Trackpads send many small steps; a mouse wheel notch is one big one
      // (or a few "lines"), so cap each step at about a 28% change.
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      const step = Math.max(-25, Math.min(25, delta));
      zoomTo(hourHeight * Math.exp(-step * 0.01), e.clientY);
      finish();
    },
    { passive: false },
  );

  // Two fingers on a touch screen.
  let pinch: { gap: number; height: number } | null = null;
  const verticalGap = (touches: TouchList) => Math.max(30, Math.abs(touches[0].clientY - touches[1].clientY));
  const middle = (touches: TouchList) => (touches[0].clientY + touches[1].clientY) / 2;
  scroller.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) pinch = { gap: verticalGap(e.touches), height: hourHeight };
    },
    { passive: true },
  );
  scroller.addEventListener(
    "touchmove",
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault(); // no page zoom
      zoomTo(pinch.height * (verticalGap(e.touches) / pinch.gap), middle(e.touches));
    },
    { passive: false },
  );
  const touchEnd = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      finish();
    }
  };
  scroller.addEventListener("touchend", touchEnd);
  scroller.addEventListener("touchcancel", touchEnd);

  // Safari on a Mac trackpad sends "gesture" events, not ctrl + wheel. On
  // touch screens the touch handlers above do the work; these only stop
  // Safari zooming the page.
  type GestureEvent = UIEvent & { scale: number; clientY: number };
  let gestureStart = hourHeight;
  scroller.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStart = hourHeight;
  });
  scroller.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (pinch) return;
    const g = e as GestureEvent;
    zoomTo(gestureStart * g.scale, g.clientY);
  });
  scroller.addEventListener("gestureend", (e) => {
    e.preventDefault();
    if (!pinch) finish();
  });
}

/**
 * Slides the week view in `root` until `day` is first, smoothly. False if
 * `day` isn't among the days drawn (then draw them afresh instead).
 */
export function slideTimeline(root: HTMLElement, day: Date, visible = 7): boolean {
  const slider = sliders.get(root);
  const scroller = root.querySelector<HTMLElement>(".tl-scroll.sliding");
  if (!slider || !scroller) return false;
  const index = daysBetween(slider.days[0], day);
  if (index < 0 || index > slider.days.length - visible) return false;
  scroller.scrollTo({ left: index * slider.column(), behavior: "smooth" });
  return true;
}
