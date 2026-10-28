import type { AgendaItem } from "../api";

export type ViewName = "day" | "week" | "month" | "year" | "agenda";

/** Everything a view needs to draw itself. */
export interface ViewContext {
  items: AgendaItem[];
  /** First day shown (local midnight). */
  from: Date;
  /** Day after the last day shown. */
  to: Date;
  /** The date the user navigated to; views center on it. */
  anchor: Date;
  now: Date;
  /** True when re-drawing the same range (e.g. auto-refresh): keep the scroll position. */
  preserveScroll: boolean;
  /** A time to scroll into view instead, e.g. a just-added event's start. */
  reveal?: Date;
  goTo(view: ViewName, date: Date): void;
  /** Completes a task, or un-completes it. */
  toggleTask(item: AgendaItem): void;
}
