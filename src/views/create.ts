// Adding where you point: double-click an empty spot for New event, or
// right-click it for a menu (New Event, New Task), at that day and, in the
// day and week views, that time. On a touch screen, press and hold.
import { onLongPress, showMenu } from "../dom";
import type { ViewContext } from "./types";

/** What's under the pointer: a day, and a time unless it's all day. */
export interface Spot {
  start: Date;
  allDay: boolean;
}

/** Things that do something else when clicked: items, checkboxes, buttons. */
const TAKEN = ".tl-event, .tl-allday-item, .month-bar, .month-event, .month-more, .task-check, button, a";

/** Longest gap between the clicks of a double-click (macOS's default is ~0.5 s; most people are quicker). */
const DOUBLE_CLICK_MS = 250;

/**
 * A day's header (or date number): a click opens that day, a double-click
 * adds an all-day event on it, a right-click offers New Event / New Task.
 * The click waits a moment, in case it's the first of a double-click.
 */
export function dayButton(button: HTMLElement, ctx: ViewContext, day: Date): void {
  let pending: number | undefined;
  button.addEventListener("click", (e) => {
    window.clearTimeout(pending);
    // From the keyboard (no clicks counted): right away.
    if (e.detail === 0) ctx.goTo("day", day);
    else if (e.detail === 1) pending = window.setTimeout(() => ctx.goTo("day", day), DOUBLE_CLICK_MS);
  });
  const create = ctx.create;
  if (!create) return;
  button.addEventListener("dblclick", (e) => {
    window.clearTimeout(pending);
    e.preventDefault();
    e.stopPropagation();
    create(day, true, "event");
  });
  button.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, [
      ["New Event", () => create(day, true, "event")],
      ["New Task", () => create(day, true, "task")],
    ]);
  });
  // A finger: press and hold for a new event that day.
  onLongPress(button, () => create(day, true, "event"));
}

/** Lets `node` add an item at the spot `at` finds (null where there's none). */
export function enableCreate(node: HTMLElement, ctx: ViewContext, at: (e: MouseEvent) => Spot | null): void {
  const create = ctx.create;
  if (!create) return;
  const spot = (e: MouseEvent) => ((e.target as Element).closest(TAKEN) ? null : at(e));
  node.addEventListener("dblclick", (e) => {
    const found = spot(e);
    if (!found) return;
    e.preventDefault();
    create(found.start, found.allDay, "event");
  });
  node.addEventListener("contextmenu", (e) => {
    const found = spot(e);
    if (!found) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      ["New Event", () => create(found.start, found.allDay, "event")],
      ["New Task", () => create(found.start, found.allDay, "task")],
    ]);
  });
  // A finger: press and hold an empty spot for a new event there, at the
  // time under the finger.
  onLongPress(node, (press) => {
    const found = spot(press);
    if (found) create(found.start, found.allDay, "event");
  });
}
