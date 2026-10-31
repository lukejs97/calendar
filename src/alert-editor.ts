// The notification rows on the New / Edit event form, laid out like Google
// Calendar's: a type, a number, a unit, and a button to remove the row, then
// "Add notification" underneath.
import type { AgendaItem, Alerts, EventAlert } from "./api";
import { el } from "./dom";
import { toDateString, toLocalIso } from "./time";

/** Google Calendar stores at most this many reminder overrides. */
const GOOGLE_MAX_OVERRIDES = 5;
/** Google Calendar's longest reminder, in minutes (4 weeks). */
const GOOGLE_MAX_MINUTES = 40_320;

const WEEK = 7 * 24 * 60;
const DAY = 24 * 60;

type Unit = "minutes" | "hours" | "days" | "weeks" | "at" | "leave";
type Method = "popup" | "email";

interface Row {
  method: Method;
  unit: Unit;
  /** The number, as typed. */
  amount: string;
  /** For an exact time: "YYYY-MM-DD" and "HH:MM". */
  date: string;
  time: string;
  /** The live controls, so saving reads what's on screen. */
  els?: {
    method: HTMLSelectElement;
    amount: HTMLInputElement;
    date: HTMLInputElement;
    time: HTMLInputElement;
    unit: HTMLSelectElement;
  };
}

const UNITS: [Unit, string][] = [
  ["minutes", "minutes"],
  ["hours", "hours"],
  ["days", "days"],
  ["weeks", "weeks"],
  ["at", "specific time"],
  ["leave", "before leaving"],
];

const MULTIPLIER: Record<Exclude<Unit, "at" | "leave">, number> = {
  minutes: 1,
  hours: 60,
  days: DAY,
  weeks: WEEK,
};

/** The largest unit that divides `minutes` evenly, so 120 is "2 hours". */
export function minutesToParts(minutes: number): { amount: number; unit: Exclude<Unit, "at"> } {
  if (minutes > 0 && minutes % WEEK === 0) return { amount: minutes / WEEK, unit: "weeks" };
  if (minutes > 0 && minutes % DAY === 0) return { amount: minutes / DAY, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

function timeString(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function combine(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [h, m] = (time || "00:00").split(":").map(Number);
  const when = new Date(year, month - 1, day, h, m);
  // Date maps years 0–99 onto the 1900s. Keep the year that was typed.
  if (!Number.isNaN(year)) when.setFullYear(year);
  return when;
}

/**
 * `new Date` only accepts a four-digit year. A date field can hold a longer
 * one (22021-10-31T09:30:00+00:00), which would otherwise come back blank.
 */
function parseInstant(at: string): Date | null {
  const parsed = new Date(at);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const match = /^([+-]?\d+)-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(at.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const zone = match[7] ?? "Z";
  let offset = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const [zh, zm] = zone.slice(1).split(":").map(Number);
    offset = sign * (zh * 60 + zm);
  }
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  utc.setUTCFullYear(year);
  utc.setTime(utc.getTime() - offset * 60_000);
  return Number.isNaN(utc.getTime()) ? null : utc;
}

function bell(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("alert-bell");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    "M12 22a2 2 0 0 0 2-1.6H10A2 2 0 0 0 12 22zm7-6V11a7 7 0 0 0-5-6.7V4a2 2 0 1 0-4 0v.3A7 7 0 0 0 5 11v5l-1.8 1.8A1 1 0 0 0 4 20h16a1 1 0 0 0 .8-1.6L19 16z",
  );
  svg.append(path);
  return svg;
}

function option(value: string, text: string): HTMLOptionElement {
  return new Option(text, value);
}

/**
 * The list of notifications. `onChange` runs when the person edits it (not
 * when it's filled in from an event or a sentence). `when` is the event's
 * start, used to suggest a date for an exact-time alert.
 */
export class AlertEditor {
  readonly root = el("div", "alert-list");
  private rows: Row[] = [];
  /** False until a sentence or the person sets notifications of their own. */
  private customized = false;
  /** The rows as filled in, so an edit that puts them back saves nothing. */
  private initial = "[]";
  private note = el("p", "form-notes");

  constructor(
    private onChange: () => void,
    private when: () => Date | null,
  ) {
    this.render();
  }

  /** A new event: the calendar's own notifications, until some are added. */
  setDefault(): void {
    this.customized = false;
    this.rows = [];
    this.render();
    this.initial = this.snapshot();
  }

  /** What the event already alerts on. Saving without a further edit leaves it. */
  setFromItem(item: AgendaItem): void {
    this.customized = true;
    this.rows = [
      ...item.reminders.map((minutes) => this.relative("popup", minutes)),
      ...(item.emailReminders ?? []).map((minutes) => this.relative("email", minutes)),
      ...(item.alertAt ?? []).map((at) => this.absolute(at)),
      ...(item.leaveAlerts ?? []).map((buffer) => this.leave(buffer)),
    ];
    this.render();
    this.initial = this.snapshot();
  }

  /**
   * From the sentence box. `null` means it didn't mention an alert, so a new
   * event goes back to the calendar's notifications.
   */
  setFromSentence(alert: number | "none" | null): void {
    if (alert === null) {
      this.setDefault();
      return;
    }
    this.customized = true;
    this.rows = alert === "none" ? [] : [this.relative("popup", alert)];
    this.render();
    this.initial = this.snapshot();
  }

  /** The controls no longer match what was filled in (a sentence, or the event). */
  diverged(): boolean {
    for (const row of this.rows) this.read(row);
    return this.snapshot() !== this.initial;
  }

  /** What to save. Throws if a row is only half filled in. */
  toDraft(): Alerts {
    for (const row of this.rows) this.read(row);
    if (!this.customized) return { kind: "default" };
    const alerts: EventAlert[] = this.rows.map((row) => {
      if (row.unit === "at") {
        const when = row.date && row.time ? combine(row.date, row.time) : null;
        if (!when || Number.isNaN(when.getTime())) throw new Error("Choose a date and time for each notification.");
        const year = when.getFullYear();
        if (year < 1 || year > 9999) throw new Error("Choose a year from 1 to 9999 for each notification.");
        return { kind: "absolute", at: toLocalIso(when) };
      }
      if (!/^\d+$/.test(row.amount.trim())) throw new Error("Enter a whole number for each notification.");
      if (row.unit === "leave") {
        const buffer = Number(row.amount);
        if (buffer > 7 * 24 * 60) throw new Error("A leave alert can't be more than a week before you need to leave.");
        return { kind: "leave", bufferMinutes: buffer };
      }
      const minutes = Number(row.amount) * MULTIPLIER[row.unit];
      if (!Number.isSafeInteger(minutes) || minutes > 0xffff_ffff) throw new Error("That notification is too far ahead.");
      return { kind: "relative", minutes, method: row.method };
    });
    return { kind: "custom", alerts };
  }

  private relative(method: Method, minutes: number): Row {
    const parts = minutesToParts(minutes);
    return { method, unit: parts.unit, amount: String(parts.amount), date: "", time: "" };
  }

  private leave(buffer: number): Row {
    return { method: "popup", unit: "leave", amount: String(buffer), date: "", time: "" };
  }

  private absolute(at: string): Row {
    const date = parseInstant(at);
    if (!date) return { method: "popup", unit: "at", amount: "30", date: "", time: "" };
    return { method: "popup", unit: "at", amount: "30", date: toDateString(date), time: timeString(date) };
  }

  private blank(): Row {
    return { method: "popup", unit: "minutes", amount: "30", date: "", time: "" };
  }

  private suggestExact(row: Row): void {
    if (row.date && row.time) return;
    const start = this.when() ?? new Date();
    row.date = toDateString(start);
    row.time = timeString(start);
  }

  private snapshot(): string {
    return JSON.stringify(this.rows.map((row) => [row.method, row.unit, row.amount, row.date, row.time]));
  }

  /** Copies the controls into the row. A date picker fires `change`, not only `input`. */
  private read(row: Row): void {
    const els = row.els;
    if (!els) return;
    row.unit = els.unit.value as Unit;
    row.amount = els.amount.value;
    row.date = els.date.value;
    row.time = els.time.value;
    if (row.unit !== "at") row.method = els.method.value === "email" ? "email" : "popup";
  }

  private edited(): void {
    this.customized = true;
    this.onChange();
    this.note.textContent = this.noteText();
  }

  /** True when something in the list won't be one of Google's reminder overrides. */
  private exceedsGoogle(): boolean {
    let syncable = 0;
    for (const row of this.rows) {
      // A leave alert has its own note. It never becomes a Google reminder.
      if (row.unit === "leave") continue;
      if (row.unit === "at") return true;
      const amount = Number(row.amount);
      if (!Number.isInteger(amount) || amount < 0) continue;
      const minutes = amount * MULTIPLIER[row.unit];
      if (minutes > GOOGLE_MAX_MINUTES) return true;
      syncable += 1;
      if (syncable > GOOGLE_MAX_OVERRIDES) return true;
    }
    return false;
  }

  private noteText(): string {
    if (!this.customized && this.rows.length === 0) {
      return "Uses the calendar's notifications until you add your own.";
    }
    const bits: string[] = [];
    if (this.rows.some((row) => row.unit === "leave")) {
      bits.push(
        "“Before leaving” uses live traffic and alerts that many minutes before you need to leave (0 means at the leave-by time). Google Calendar won't send it.",
      );
    }
    if (this.exceedsGoogle()) {
      bits.push(
        "Exact times, and notifications past Google's limit of 5 (or 4 weeks), stay on the event for Minuteman to alert you. Google Calendar won't send those.",
      );
    }
    return bits.join(" ");
  }

  private render(): void {
    const rows = el("div", "alert-rows");
    for (const row of this.rows) rows.append(this.rowView(row));
    const add = el("button", "alert-add", "Add notification");
    add.type = "button";
    add.addEventListener("click", () => {
      const added = this.blank();
      this.rows.push(added);
      this.edited();
      this.render();
      const amount = this.root.querySelector<HTMLInputElement>(".alert-row:last-of-type .alert-amount");
      amount?.focus();
      amount?.select();
    });
    this.note.textContent = this.noteText();
    this.root.replaceChildren(rows, add, this.note);
  }

  private rowView(row: Row): HTMLElement {
    const line = el("div", "alert-row");
    const method = el("select", "text-input alert-method");
    method.append(option("popup", "Notification"), option("email", "Email"));
    const timed = row.unit === "at" || row.unit === "leave";
    method.value = timed ? "popup" : row.method;
    method.disabled = timed;
    method.setAttribute("aria-label", "Notification type");
    method.addEventListener("change", () => {
      row.method = method.value === "email" ? "email" : "popup";
      this.edited();
    });

    const amount = el("input", "text-input alert-amount");
    amount.type = "number";
    amount.min = "0";
    amount.step = "1";
    amount.inputMode = "numeric";
    amount.value = row.amount;
    amount.hidden = row.unit === "at";
    amount.setAttribute("aria-label", row.unit === "leave" ? "Minutes before you leave" : "How long before");
    const onAmount = () => {
      row.amount = amount.value;
      this.edited();
    };
    amount.addEventListener("input", onAmount);
    amount.addEventListener("change", onAmount);

    const date = el("input", "text-input alert-date");
    date.type = "date";
    date.value = row.date;
    date.hidden = row.unit !== "at";
    date.setAttribute("aria-label", "Notification date");
    const onDate = () => {
      row.date = date.value;
      this.edited();
    };
    date.addEventListener("input", onDate);
    date.addEventListener("change", onDate);

    const time = el("input", "text-input alert-time");
    time.type = "time";
    time.value = row.time;
    time.hidden = row.unit !== "at";
    time.setAttribute("aria-label", "Notification time");
    const onTime = () => {
      row.time = time.value;
      this.edited();
    };
    time.addEventListener("input", onTime);
    time.addEventListener("change", onTime);

    const unit = el("select", "text-input alert-unit");
    unit.append(...UNITS.map(([value, text]) => option(value, text)));
    unit.value = row.unit;
    unit.setAttribute("aria-label", "Notification unit");
    unit.addEventListener("change", () => {
      const next = unit.value as Unit;
      const shape = (u: Unit) => (u === "at" ? "at" : u === "leave" ? "leave" : "lead");
      const was = shape(row.unit);
      row.unit = next;
      if (next === "at") this.suggestExact(row);
      if (next === "leave" && (row.amount === "" || row.amount === "30")) row.amount = "10";
      this.edited();
      if (was !== shape(next)) this.render();
    });

    const remove = el("button", "alert-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove notification");
    remove.addEventListener("click", () => {
      this.rows = this.rows.filter((r) => r !== row);
      this.edited();
      this.render();
    });

    row.els = { method, amount, date, time, unit };
    line.append(bell(), method, amount, date, time, unit, remove);
    return line;
  }
}
