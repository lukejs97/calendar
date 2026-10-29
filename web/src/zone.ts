// Time zone arithmetic. The desktop app uses the computer's own zone; the
// server runs in UTC, so the browser sends its zone and these helpers do
// "midnight", "today" and wall-clock times in it. Dates are "YYYY-MM-DD".

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, f);
  }
  return f;
}

/** The zone if it's a real IANA zone, otherwise UTC. */
export function validZone(zone: string | null): string {
  if (!zone) return "UTC";
  try {
    format(zone);
    return zone;
  } catch {
    return "UTC";
  }
}

/** Wall-clock parts of an instant in `zone`. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallClock(instant: Date, zone: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of format(zone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Wall-clock time as milliseconds, as if it were UTC (for plain arithmetic). */
export const wallMs = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

export function wallFromMs(ms: number): Wall {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** The instant a wall-clock time happens in `zone`. Times a clock change skips move forward. */
export function wallToInstant(wall: Wall, zone: string): Date {
  const target = wallMs(wall);
  // Guess with the zone's offset at that moment, then correct once (DST).
  let instant = target - offsetMs(new Date(target), zone);
  const corrected = target - offsetMs(new Date(instant), zone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** How far `zone` is ahead of UTC at `instant`. */
function offsetMs(instant: Date, zone: string): number {
  const whole = new Date(Math.floor(instant.getTime() / 1000) * 1000);
  return wallMs(wallClock(whole, zone)) - whole.getTime();
}

export function parseDay(s: string): Wall | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0, second: 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");

export const dayString = (w: Wall) => `${w.year}-${pad(w.month)}-${pad(w.day)}`;

/** Local midnight at the start of `day`. */
export function midnight(day: string, zone: string): Date {
  const wall = parseDay(day);
  if (!wall) throw new Error(`not a date: ${day}`);
  return wallToInstant(wall, zone);
}

/** The local day an instant falls on. */
export const dayOf = (instant: Date, zone: string) => dayString(wallClock(instant, zone));

export const today = (zone: string) => dayOf(new Date(), zone);

export function addDays(day: string, n: number): string {
  const wall = parseDay(day)!;
  return dayString(wallFromMs(wallMs(wall) + n * 86_400_000));
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((wallMs(parseDay(b)!) - wallMs(parseDay(a)!)) / 86_400_000);
}
