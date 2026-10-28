// Dragging an item onto another day: in month view's cells, and in the
// all-day row of the day and week views. A copy of the item follows the
// pointer; dropping it moves the item by that many days, keeping its time.
// Mouse and trackpad only, as for timed events (a finger drag scrolls).
import type { AgendaItem } from "../api";
import { daysBetween, itemEnd, itemStart } from "../time";
import type { ViewContext } from "./types";

/** px the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

/** Same local time of day, `days` later. Safe across DST changes. */
export function shiftDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes());
}

/**
 * Lets `node`, which shows `item` on day `shownOn`, be dragged to another
 * day. `dayAt` says which day is under the pointer (null if none);
 * `highlight` marks it while dragging (null to clear).
 */
export function enableDayDrag(
  node: HTMLElement,
  item: AgendaItem,
  ctx: ViewContext,
  shownOn: Date,
  dayAt: (x: number, y: number) => Date | null,
  highlight: (day: Date | null) => void,
): void {
  if (!item.editable) return;
  node.classList.add("movable");
  node.addEventListener("pointerdown", (down) => {
    if (down.pointerType !== "mouse" || down.button !== 0) return;
    if ((down.target as Element).closest(".task-check")) return;
    const rect = node.getBoundingClientRect();
    let ghost: HTMLElement | null = null;
    let target: Date | null = shownOn;

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (!ghost) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
        ghost = node.cloneNode(true) as HTMLElement;
        ghost.classList.add("drag-ghost");
        ghost.style.width = `${rect.width}px`;
        document.body.append(ghost);
        node.classList.add("dragging");
      }
      ghost.style.left = `${rect.left + e.clientX - down.clientX}px`;
      ghost.style.top = `${rect.top + e.clientY - down.clientY}px`;
      target = dayAt(e.clientX, e.clientY);
      highlight(target);
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!ghost) return;
      ghost.remove();
      highlight(null);
      const days = target && e.type !== "pointercancel" ? daysBetween(shownOn, target) : 0;
      // Wait for the click that follows, so it doesn't open the details.
      window.setTimeout(() => {
        node.classList.remove("dragging");
        ctx.moveItem(item, shiftDays(itemStart(item), days), shiftDays(itemEnd(item), days));
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}
