// A repeating event's rules (RFC 5545 RRULE lines, as Google keeps them) in
// plain words, and the same rules ended after a given occurrence.

const DAY_NAMES: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];
const ORDINALS: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth", "-1": "last" };
const untilFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const monthDayFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });

/** The RRULE's parts, e.g. { FREQ: "WEEKLY", BYDAY: "MO,WE" }. */
function parts(rule: string): Record<string, string> {
  const body = rule.replace(/^RRULE:/i, "");
  return Object.fromEntries(
    body.split(";").map((part) => {
      const [key, value = ""] = part.split("=");
      return [key.toUpperCase(), value.toUpperCase()];
    }),
  );
}

/** "Monday", "Monday and Wednesday", "Monday, Wednesday and Friday". */
function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** 1 → "1st", 22 → "22nd", -1 → "last". */
function ordinalDay(n: number): string {
  if (n === -1) return "last day";
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** An RRULE's UNTIL (20270305 or 20270305T235959Z) as a date. */
function untilDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", s = "0", z] = m.slice(1);
  return z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
    : new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

/**
 * The rules in words: "Every Monday", "Every 2 weeks on Tuesday and
 * Thursday", "Monthly on the second Tuesday", "Every day, 10 times",
 * "Every week, until Mar 5, 2027". `start` is the series' (or this
 * occurrence's) start, for rules that leave the day to it. Null if there's
 * no RRULE.
 */
export function describeRecurrence(rules: string[], start: Date): string | null {
  const rule = rules.find((r) => /^RRULE:/i.test(r));
  if (!rule) return null;
  const p = parts(rule);
  const interval = Math.max(1, Number(p.INTERVAL || 1));
  const days = (p.BYDAY ?? "").split(",").filter(Boolean);
  let words: string;

  switch (p.FREQ) {
    case "DAILY":
      words = interval === 1 ? "Every day" : `Every ${interval} days`;
      break;
    case "WEEKLY": {
      const plain = days.filter((d) => d in DAY_NAMES);
      const isWeekdays = plain.length === 5 && WEEKDAYS.every((d) => plain.includes(d));
      if (interval === 1 && isWeekdays) words = "Every weekday";
      else if (interval === 1 && plain.length) words = `Every ${list(plain.map((d) => DAY_NAMES[d]))}`;
      else if (plain.length) words = `Every ${interval} weeks on ${list(plain.map((d) => DAY_NAMES[d]))}`;
      else words = interval === 1 ? "Every week" : `Every ${interval} weeks`;
      break;
    }
    case "MONTHLY": {
      const every = interval === 1 ? "Monthly" : `Every ${interval} months`;
      // "2TU", or "TU" with BYSETPOS=2: the second Tuesday.
      const nth = /^(-?\d)([A-Z]{2})$/.exec(days[0] ?? "");
      if (nth && ORDINALS[nth[1]] && DAY_NAMES[nth[2]]) words = `${every} on the ${ORDINALS[nth[1]]} ${DAY_NAMES[nth[2]]}`;
      else if (days.length === 1 && DAY_NAMES[days[0]] && ORDINALS[p.BYSETPOS ?? ""])
        words = `${every} on the ${ORDINALS[p.BYSETPOS]} ${DAY_NAMES[days[0]]}`;
      else if (p.BYMONTHDAY) words = `${every} on the ${ordinalDay(Number(p.BYMONTHDAY.split(",")[0]))}`;
      else words = `${every} on the ${ordinalDay(start.getDate())}`;
      break;
    }
    case "YEARLY":
      words = `${interval === 1 ? "Every year" : `Every ${interval} years`} on ${monthDayFormat.format(start)}`;
      break;
    default:
      return "Repeats";
  }

  if (p.COUNT) words += `, ${p.COUNT} times`;
  const until = p.UNTIL ? untilDate(p.UNTIL) : null;
  if (until) words += `, until ${untilFormat.format(until)}`;
  return words;
}

/**
 * The same rules, ending with the occurrence at `start` (it's the last one;
 * the ones before it stay). Other lines (EXDATE and so on) are kept.
 */
export function endAfter(rules: string[], start: Date, allDay: boolean): string[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const until = allDay
    ? `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`
    : `${start.getUTCFullYear()}${pad(start.getUTCMonth() + 1)}${pad(start.getUTCDate())}T${pad(start.getUTCHours())}${pad(start.getUTCMinutes())}${pad(start.getUTCSeconds())}Z`;
  return rules.map((rule) => {
    if (!/^RRULE:/i.test(rule)) return rule;
    const kept = rule
      .replace(/^RRULE:/i, "")
      .split(";")
      .filter((part) => !/^(UNTIL|COUNT)=/i.test(part));
    return `RRULE:${[...kept, `UNTIL=${until}`].join(";")}`;
  });
}
