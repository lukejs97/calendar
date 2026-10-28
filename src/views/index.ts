// Each view says which dates it shows, how Previous/Next move, what the title
// is, and how to draw itself.
import { addDays, addMonths, startOfWeek } from "../time";
import { renderAgenda } from "./agenda";
import { renderMonth } from "./month";
import { renderTimeline } from "./timeline";
import type { ViewContext, ViewName } from "./types";
import { renderYear } from "./year";

export type { ViewContext, ViewName } from "./types";

interface ViewSpec {
  label: string;
  /** Keyboard shortcut. */
  key: string;
  range(anchor: Date): { from: Date; to: Date };
  step(anchor: Date, direction: 1 | -1): Date;
  title(anchor: Date): string;
  render(root: HTMLElement, ctx: ViewContext): void;
}

const AGENDA_DAYS = 14;

const dayTitle = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const rangeTitle = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

const daysFrom = (from: Date, count: number) => Array.from({ length: count }, (_, i) => addDays(from, i));

export const VIEW_ORDER: ViewName[] = ["day", "week", "month", "year", "agenda"];

export const VIEWS: Record<ViewName, ViewSpec> = {
  day: {
    label: "Day",
    key: "d",
    range: (anchor) => ({ from: anchor, to: addDays(anchor, 1) }),
    step: (anchor, dir) => addDays(anchor, dir),
    title: (anchor) => dayTitle.format(anchor),
    render: (root, ctx) => renderTimeline(root, ctx, [ctx.from]),
  },
  week: {
    label: "Week",
    key: "w",
    range: (anchor) => {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7) };
    },
    step: (anchor, dir) => addDays(anchor, 7 * dir),
    title: (anchor) => {
      const from = startOfWeek(anchor);
      return rangeTitle.formatRange(from, addDays(from, 6));
    },
    render: (root, ctx) => renderTimeline(root, ctx, daysFrom(ctx.from, 7)),
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
    title: (anchor) => rangeTitle.formatRange(anchor, addDays(anchor, AGENDA_DAYS - 1)),
    render: renderAgenda,
  },
};
