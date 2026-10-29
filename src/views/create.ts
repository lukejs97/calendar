// Adding where you point: double-click an empty spot for New event, or
// right-click it for a menu (New Event, New Task), at that day and, in the
// day and week views, that time.
import { showMenu } from "../dom";
import type { ViewContext } from "./types";

/** What's under the pointer: a day, and a time unless it's all day. */
export interface Spot {
  start: Date;
  allDay: boolean;
}

/** Things that do something else when clicked: items, checkboxes, buttons. */
const TAKEN = ".tl-event, .tl-allday-item, .month-bar, .month-event, .month-more, .task-check, button, a";

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
}
