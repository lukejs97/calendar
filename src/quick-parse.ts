// Turns a sentence like "Lunch with Sam tomorrow 1pm at Cafe Roma" into an
// event: title, start and end, all-day or not, location, and also a repeat
// ("every Monday"), an alert ("remind me 30 min before") and guests (email
// addresses). Runs locally; chrono-node finds the date and time.
import * as chrono from "chrono-node/en";
import { addDays, MS_PER_MINUTE, startOfDay } from "./time";

export type Repeat = "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly";

/** Google Calendar's repeat rules. A weekly repeat falls on the start's weekday. */
export const REPEAT_RULES: Record<Repeat, string> = {
  daily: "RRULE:FREQ=DAILY",
  weekdays: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "RRULE:FREQ=WEEKLY",
  biweekly: "RRULE:FREQ=WEEKLY;INTERVAL=2",
  monthly: "RRULE:FREQ=MONTHLY",
  yearly: "RRULE:FREQ=YEARLY",
};

export interface ParsedEvent {
  title: string;
  start: Date;
  /** For all-day events, midnight after the last day. */
  end: Date;
  allDay: boolean;
  location: string | null;
  /** False when the text named no date or time (then it's all day today). */
  dated: boolean;
  repeat: Repeat | null;
  /** Minutes before the start; "none" for no alert; null if not mentioned. */
  alert: number | "none" | null;
  /** Email addresses to invite. */
  guests: string[];
  /** The words that gave the date and time, e.g. "tomorrow 1pm". */
  dateText: string | null;
}

export interface ParsedTask {
  title: string;
  /** Null when no date was given, or when it repeats. */
  due: { start: Date; allDay: boolean } | null;
  /** A repeat in Todoist's own words, e.g. "every Monday at 7am"; Todoist reads it. */
  repeat: string | null;
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

/** "every Monday", "every other Friday": a weekly repeat on that day. */
const EVERY_WEEKDAY = /\bevery\s+(other\s+)?((?:mon|tues|wednes|thurs|fri|satur|sun)day)s?\b/i;

const REPEATS: [RegExp, Repeat][] = [
  [/\b(?:every\s+weekday|on\s+weekdays|weekdays)\b/i, "weekdays"],
  [/\b(?:every\s+day|each\s+day|daily)\b/i, "daily"],
  [/\b(?:every\s+(?:other|2|two)\s+weeks?|biweekly|fortnightly)\b/i, "biweekly"],
  [/\b(?:every\s+week|weekly)\b/i, "weekly"],
  [/\b(?:every\s+month|monthly)\b/i, "monthly"],
  [/\b(?:every\s+year|yearly|annually)\b/i, "yearly"],
];

const TODOIST_REPEATS: Record<Repeat, string> = {
  daily: "every day",
  weekdays: "every weekday",
  weekly: "every week",
  biweekly: "every other week",
  monthly: "every month",
  yearly: "every year",
};

/** "on the 1st", "the 15th": the next such day of the month. */
const DAY_OF_MONTH = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i;

/** "remind me 30 min before", "alert 1 hour before", "reminder 2 days early". */
const ALERT =
  /\b(?:remind\s+me|reminder|alert(?:\s+me)?|notify\s+me)\s+(\d+(?:\.\d+)?|an?|one)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*(?:before|early|earlier|ahead|prior)?\b/i;
const ALERT_AT_START = /\b(?:remind\s+me|alert(?:\s+me)?|notify\s+me)\s+(?:at|when\s+it)\s+(?:the\s+)?starts?\b/i;
const NO_ALERT = /\bno\s+(?:alerts?|reminders?|notifications?)\b/i;

const EMAIL = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}";
/** "with sam@x.com and jo@y.com", or just the addresses. */
const GUESTS = new RegExp(`(?:\\bwith\\s+)?${EMAIL}(?:\\s*(?:,|and|&)\\s*${EMAIL})*`, "i");

/** Words left dangling where the date was: "Dinner on" → "Dinner". */
const DANGLING = /(?:\s+(?:on|at|from|by|until|till|to|for|this|next|in|-|–|,))+$/i;

/**
 * Reads a task: like an event, but a place stays part of the name ("Buy milk
 * at Tesco"), there may be no date, and "p1"–"p4" sets the priority.
 */
export function parseTask(text: string, now: Date): ParsedTask | null {
  const priority = PRIORITY.exec(text);
  let rest = priority ? cut(text, priority.index, priority[0].length) : text;

  // A repeat goes to Todoist in its own words, with any day or time:
  // "every month on the 1st", "every weekday at 9am".
  let repeat: string | null = null;
  const weekday = EVERY_WEEKDAY.exec(rest);
  if (weekday) {
    repeat = weekday[0];
    rest = cut(rest, weekday.index, weekday[0].length);
  } else {
    for (const [pattern, kind] of REPEATS) {
      const match = pattern.exec(rest);
      if (match) {
        repeat = TODOIST_REPEATS[kind];
        rest = cut(rest, match.index, match[0].length);
        break;
      }
    }
  }

  const parsed = parseEvent(rest, now, { forTask: true });
  if (!parsed) return null;
  if (repeat && parsed.dateText) {
    const when = parsed.dateText.replace(/^(?:at|on)\s+/i, "");
    repeat = `${repeat} ${parsed.allDay ? "on" : "at"} ${when}`;
  }
  return {
    title: parsed.title,
    due: !repeat && parsed.dated ? { start: parsed.start, allDay: parsed.allDay } : null,
    repeat,
    priority: priority ? Number(priority[1]) : null,
  };
}

/**
 * Reads `text` relative to `now`. Returns null if there's no title.
 * `forTask`: leave places, repeats, alerts and guests in the name, since a
 * task has none of those here.
 */
export function parseEvent(text: string, now: Date, { forTask = false } = {}): ParsedEvent | null {
  let rest = text.trim();

  // These go first: their numbers ("every 2 weeks", "30 min before") would
  // otherwise be read as dates or lengths.
  let repeat: Repeat | null = null;
  let alert: number | "none" | null = null;
  const guests: string[] = [];
  if (!forTask) {
    const weekday = EVERY_WEEKDAY.exec(rest);
    if (weekday) {
      repeat = weekday[1] ? "biweekly" : "weekly";
      // Keep the day's name, so the event starts on the next one.
      rest = `${rest.slice(0, weekday.index)}${weekday[2]}${rest.slice(weekday.index + weekday[0].length)}`;
    } else {
      for (const [pattern, kind] of REPEATS) {
        const match = pattern.exec(rest);
        if (match) {
          repeat = kind;
          rest = cut(rest, match.index, match[0].length);
          break;
        }
      }
    }

    const minutesBefore = ALERT.exec(rest);
    const atStart = ALERT_AT_START.exec(rest);
    const none = NO_ALERT.exec(rest);
    const said = minutesBefore ?? atStart ?? none;
    if (said) {
      alert = minutesBefore ? alertMinutes(minutesBefore[1], minutesBefore[2]) : atStart ? 0 : "none";
      rest = cut(rest, said.index, said[0].length);
    }

    for (let match = GUESTS.exec(rest); match; match = GUESTS.exec(rest)) {
      guests.push(...(match[0].match(new RegExp(EMAIL, "gi")) ?? []).map((e) => e.toLowerCase()));
      rest = cut(rest, match.index, match[0].length);
    }
  }

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
  const dayOfMonth = found ? null : DAY_OF_MONTH.exec(rest);
  if (dayOfMonth) {
    start = nextDayOfMonth(now, Number(dayOfMonth[1]));
    end = addDays(start, 1);
    allDay = true;
    rest = cut(rest, dayOfMonth.index, dayOfMonth[0].length);
  } else if (!found) {
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
  const place = forTask ? null : LOCATION.exec(rest);
  if (place) {
    location = (place[1] ?? place[2]).trim();
    rest = rest.slice(0, place.index);
  }

  const title = tidy(rest);
  if (!title) return null;
  return {
    title,
    start,
    end,
    allDay,
    location: location || null,
    dated: Boolean(found || dayOfMonth),
    repeat,
    alert,
    guests,
    dateText: found?.text ?? dayOfMonth?.[0] ?? null,
  };
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

/** The next date (from today) falling on day `day` of a month. */
function nextDayOfMonth(now: Date, day: number): Date {
  for (let monthsAhead = 0; monthsAhead < 13; monthsAhead++) {
    const date = new Date(now.getFullYear(), now.getMonth() + monthsAhead, day);
    // Skip months without that day (e.g. the 31st in November).
    if (date.getDate() === day && date >= startOfDay(now)) return date;
  }
  return startOfDay(now);
}

function alertMinutes(amount: string, unit: string): number {
  const count = /^(?:an?|one)$/i.test(amount) ? 1 : Number(amount);
  const u = unit.toLowerCase();
  return Math.round(count * (u.startsWith("d") ? 24 * 60 : u.startsWith("h") ? 60 : 1));
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
