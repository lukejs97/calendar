// Each view says which dates it shows, how Previous/Next move, what the title
// is, and how to draw itself.
import { multiDayCount } from "../preferences";
import { addDays, addMonths, isSameDay, startOfWeek } from "../time";
import { renderAgenda } from "./agenda";
import { renderMonth } from "./month";
import { renderTimeline } from "./timeline";
import type { ViewContext, ViewName } from "./types";
import { renderYear } from "./year";

export type { ViewContext, ViewName } from "./types";
export { slideTimeline } from "./timeline";

interface ViewSpec {
  label: string | (() => string);
  /** Keyboard shortcut. */
  key: string;
  range(anchor: Date): { from: Date; to: Date };
  step(anchor: Date, direction: 1 | -1): Date;
  title(anchor: Date): string;
  render(root: HTMLElement, ctx: ViewContext): void;
}

const AGENDA_DAYS = 14;
const WEEK_DRAWN_DAYS = 6 * 7;

const monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/**
 * The title for `count` days from `first`: the month most of them fall in,
 * e.g. "October 2026" (on a tie, the earlier month).
 */
function monthInView(first: Date, count: number): string {
  const tally = new Map<string, { day: Date; days: number }>();
  for (let i = 0; i < count; i++) {
    const day = addDays(first, i);
    const key = `${day.getFullYear()}-${day.getMonth()}`;
    const entry = tally.get(key) ?? { day, days: 0 };
    entry.days++;
    tally.set(key, entry);
  }
  let most = tally.values().next().value!;
  for (const entry of tally.values()) if (entry.days > most.days) most = entry;
  return monthTitle.format(most.day);
}

const daysFrom = (from: Date, count: number) => Array.from({ length: count }, (_, i) => addDays(from, i));

export const VIEW_ORDER: ViewName[] = ["day", "days", "week", "month", "year", "agenda"];

/** The days drawn by the views that slide sideways (week, multi-day): six weeks. */
const slidingRange = (anchor: Date) => {
  const from = addDays(startOfWeek(anchor), -2 * 7);
  return { from, to: addDays(from, WEEK_DRAWN_DAYS) };
};

/** Views whose days slide sideways, and how many of them are shown at once. */
export function slidingDays(view: ViewName): number | null {
  if (view === "week") return 7;
  if (view === "days") return multiDayCount();
  return null;
}

export const viewLabel = (view: ViewName) => {
  const { label } = VIEWS[view];
  return typeof label === "string" ? label : label();
};

export const VIEWS: Record<ViewName, ViewSpec> = {
  day: {
    label: "Day",
    key: "d",
    range: (anchor) => ({ from: anchor, to: addDays(anchor, 1) }),
    step: (anchor, dir) => addDays(anchor, dir),
    title: (anchor) => monthTitle.format(anchor),
    render: (root, ctx) => renderTimeline(root, ctx, [ctx.from]),
  },
  // A few days at a time (Settings says how many), sliding like the week.
  days: {
    label: () => `${multiDayCount()} Days`,
    key: "x",
    range: slidingRange,
    step: (anchor, dir) => addDays(anchor, multiDayCount() * dir),
    title: (anchor) => monthInView(anchor, multiDayCount()),
    render: (root, ctx) => renderTimeline(root, ctx, daysFrom(ctx.from, WEEK_DRAWN_DAYS), multiDayCount()),
  },
  week: {
    label: "Week",
    key: "w",
    // The anchor is the first day shown; it's a week's first day until the
    // days are slid. Six weeks around it are drawn, to slide through.
    range: slidingRange,
    step: (anchor, dir) => {
      const weekStart = startOfWeek(anchor);
      // From part way through a week: back to its start, or on to the next.
      if (dir < 0 && !isSameDay(anchor, weekStart)) return weekStart;
      return addDays(weekStart, 7 * dir);
    },
    title: (anchor) => monthInView(anchor, 7),
    render: (root, ctx) => renderTimeline(root, ctx, daysFrom(ctx.from, WEEK_DRAWN_DAYS), 7),
  },
  month: {
    label: "Month",
    key: "m",
    // Six full weeks, so the grid never changes height between months.
    range: (anchor) => {
      const from = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
      return { from, to: addDays(from, 42) };
    },
    step: (anchor, dir) => addMonths(anchor, dir),
    title: (anchor) => monthTitle.format(anchor),
    render: renderMonth,
  },
  year: {
    label: "Year",
    key: "y",
    range: (anchor) => ({
      from: new Date(anchor.getFullYear(), 0, 1),
      to: new Date(anchor.getFullYear() + 1, 0, 1),
    }),
    step: (anchor, dir) => addMonths(anchor, 12 * dir),
    title: (anchor) => String(anchor.getFullYear()),
    render: renderYear,
  },
  agenda: {
    label: "Agenda",
    key: "a",
    range: (anchor) => ({ from: anchor, to: addDays(anchor, AGENDA_DAYS) }),
    step: (anchor, dir) => addDays(anchor, AGENDA_DAYS * dir),
    title: (anchor) => monthInView(anchor, AGENDA_DAYS),
    render: renderAgenda,
  },
};
