// Turns a sentence like "Lunch with Sam tomorrow 1pm at Cafe Roma" into an
// event: title, start and end, all-day or not, and location. Runs locally;
// chrono-node finds the date and time.
import * as chrono from "chrono-node/en";
import { addDays, MS_PER_MINUTE, startOfDay } from "./time";

export interface ParsedEvent {
  title: string;
  start: Date;
  /** For all-day events, midnight after the last day. */
  end: Date;
  allDay: boolean;
  location: string | null;
  /** False when the text named no date or time (then it's all day today). */
  dated: boolean;
}

export interface ParsedTask {
  title: string;
  /** Null when no date was given. */
  due: { start: Date; allDay: boolean } | null;
  /** 1 (most urgent) to 4, from "p1"–"p4" as in Todoist; null if not given. */
  priority: number | null;
}

/** "p1"–"p4", as in Todoist. */
const PRIORITY = /(?:^|\s)p([1-4])(?=\s|$)/i;

const DEFAULT_MINUTES = 60;

/** "for 2 hours", "for 45 min", "for an hour", "for half an hour", "for 1.5h". */
const DURATION = /\bfor\s+(half\s+an?|an?|one|\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;

/**
 * " at Cafe Roma", " in Berlin" or " @ the park" at the end of what's left
 * once the date is removed. After "at" and "in", only a capitalised word or a
 * number counts, so "Look at the house" stays a title.
 */
const LOCATION = /(?:^|\s)(?:@\s*(\S.*)|(?:at|in)\s+([A-Z0-9].*))$/;

/** A word that introduces the date: "on Friday", "from Nov 12". */
const BEFORE_DATE = /(?:^|\s)(?:on|at|from|by|until|till|starting)\s*$/i;

/** Words left dangling where the date was: "Dinner on" → "Dinner". */
const DANGLING = /(?:\s+(?:on|at|from|by|until|till|to|for|this|next|in|-|–|,))+$/i;

/**
 * Reads a task: like an event, but a place stays part of the name ("Buy milk
 * at Tesco"), there may be no date, and "p1"–"p4" sets the priority.
 */
export function parseTask(text: string, now: Date): ParsedTask | null {
  const priority = PRIORITY.exec(text);
  const rest = priority ? cut(text, priority.index, priority[0].length) : text;
  const parsed = parseEvent(rest, now, false);
  if (!parsed) return null;
  return {
    title: parsed.title,
    due: parsed.dated ? { start: parsed.start, allDay: parsed.allDay } : null,
    priority: priority ? Number(priority[1]) : null,
  };
}

/**
 * Reads `text` relative to `now`. Returns null if there's no title.
 * `findPlace`: take " at …", " in …" or " @ …" at the end as the location.
 */
export function parseEvent(text: string, now: Date, findPlace = true): ParsedEvent | null {
  let rest = text.trim();

  let minutes = DEFAULT_MINUTES;
  const duration = DURATION.exec(rest);
  if (duration) {
    minutes = durationMinutes(duration[1], duration[2]);
    rest = cut(rest, duration.index, duration[0].length);
  }

  // forwardDate: "Friday" or "9am" means the next one, not one in the past.
  const found = chrono.casual.parse(rest, now, { forwardDate: true })[0];
  let start: Date;
  let end: Date;
  let allDay: boolean;
  if (!found) {
    start = startOfDay(now);
    end = addDays(start, 1);
    allDay = true;
  } else {
    const before = rest.slice(0, found.index).replace(BEFORE_DATE, "");
    rest = cut(before + rest.slice(found.index), before.length, found.text.length);
    allDay = !found.start.isCertain("hour");
    if (allDay) {
      start = startOfDay(found.start.date());
      // "Oct 12-14": all-day end is the midnight after the last day.
      end = addDays(found.end ? startOfDay(found.end.date()) : start, 1);
      if (end <= start) end = addDays(start, 1);
    } else {
      start = found.start.date();
      const hour = found.start.get("hour") ?? 0;
      if (!found.start.isCertain("meridiem") && hour >= 1 && hour <= 7) {
        start = evening(start, now, found.start.isCertain("day") || found.start.isCertain("weekday"));
      }
      end = found.end?.isCertain("hour") ? found.end.date() : new Date(start.getTime() + minutes * MS_PER_MINUTE);
      // "10pm-1am": the end is on the next day.
      while (end < start) end = addDays(end, 1);
    }
  }

  let location: string | null = null;
  const place = findPlace ? LOCATION.exec(rest) : null;
  if (place) {
    location = (place[1] ?? place[2]).trim();
    rest = rest.slice(0, place.index);
  }

  const title = tidy(rest);
  if (!title) return null;
  return { title, start, end, allDay, location: location || null, dated: Boolean(found) };
}

/**
 * "Call mum at 6" almost always means 6pm, as in Fantastical: a bare hour from
 * 1 to 7 is read as afternoon or evening. Without a day, it's the next one.
 */
function evening(morning: Date, now: Date, dayGiven: boolean): Date {
  const base = dayGiven ? morning : now;
  const pm = new Date(base.getFullYear(), base.getMonth(), base.getDate(), morning.getHours() + 12, morning.getMinutes());
  return dayGiven || pm > now ? pm : addDays(pm, 1);
}

function durationMinutes(amount: string, unit: string): number {
  const a = amount.toLowerCase().replace(/\s+/g, " ");
  const count = a.startsWith("half") ? 0.5 : a === "a" || a === "an" || a === "one" ? 1 : Number(a);
  return Math.round(count * (unit.toLowerCase().startsWith("h") ? 60 : 1));
}

/** Removes `length` characters at `index`, keeping one space between the parts. */
function cut(s: string, index: number, length: number): string {
  return `${s.slice(0, index)} ${s.slice(index + length)}`.replace(/\s+/g, " ").trim();
}

function tidy(s: string): string {
  let title = s.replace(/\s+/g, " ").trim();
  let previous;
  do {
    previous = title;
    title = title.replace(DANGLING, "").replace(/^(?:on|at)\s+/i, "").trim();
  } while (title !== previous);
  return title;
}
