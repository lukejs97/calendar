// The "New event" dialog: describe the event in a sentence, check the
// preview, and add it to one of your Google calendars.
import { createEvent, errorMessage, eventCalendars, type NewEvent } from "./api";
import { el } from "./dom";
import { parseEvent, type ParsedEvent } from "./quick-parse";
import { addDays, isSameDay, timeFormat, toDateString } from "./time";

const CALENDAR_STORAGE_KEY = "calendar.newEventCalendar";

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayWithYearFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

interface Choice {
  email: string;
  calendarId: string;
}

/** Opens the dialog. `onCreated` runs with the new event's start once it's added. */
export function openQuickAdd(onCreated: (start: Date, allDay: boolean) => void): void {
  const dialog = el("dialog", "dialog");
  dialog.setAttribute("aria-labelledby", "quick-add-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const title = el("h2", undefined, "New event");
  title.id = "quick-add-title";

  const input = el("input", "text-input");
  input.placeholder = "Lunch with Sam tomorrow 1pm at Cafe Roma";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Describe the event");

  const preview = el("div", "quick-preview");
  preview.setAttribute("aria-live", "polite");

  const select = el("select", "text-input");
  select.id = "quick-add-calendar";
  select.disabled = true;
  select.append(new Option("Loading calendars…"));
  const selectLabel = el("label", "field-label", "Calendar");
  selectLabel.htmlFor = select.id;
  const notes = el("div");
  const error = el("p", "error");

  const cancel = el("button", "text-button", "Cancel");
  cancel.type = "button"; // not "submit", which a button inside the form would be
  cancel.addEventListener("click", () => dialog.close());
  const add = el("button", "primary-button", "Add");
  add.disabled = true;

  let choices: Choice[] = [];
  let parsed: ParsedEvent | null = null;

  function update(): void {
    parsed = parseEvent(input.value, new Date());
    showPreview(preview, input.value, parsed);
    add.disabled = !parsed || select.disabled;
  }
  input.addEventListener("input", update);

  select.addEventListener("change", () => saveChoice(choices[Number(select.value)]));

  const form = el("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Read it again, so "in 2 hours" counts from now, not from the last keystroke.
    const event = parseEvent(input.value, new Date());
    const choice = choices[Number(select.value)];
    if (!event || !choice) return;
    add.disabled = true;
    add.textContent = "Adding…";
    error.textContent = "";
    try {
      await createEvent(choice.email, choice.calendarId, toNewEvent(event));
      saveChoice(choice);
      dialog.close();
      onCreated(event.start, event.allDay);
    } catch (err) {
      error.textContent = errorMessage(err);
      add.disabled = false;
      add.textContent = "Add";
    }
  });

  const buttons = el("div", "dialog-buttons");
  buttons.append(cancel, add);
  form.append(input, preview, selectLabel, select, notes, error, buttons);
  dialog.append(title, form);
  dialog.showModal();
  input.focus();
  update();

  void (async () => {
    try {
      const accounts = await eventCalendars();
      const saved = savedChoice();
      select.replaceChildren();
      choices = [];
      let defaultIndex = -1;
      const notesText: string[] = [];
      for (const account of accounts) {
        if (account.error) notesText.push(`Couldn't load ${account.email}'s calendars: ${account.error}`);
        else if (!account.canEdit) {
          notesText.push(
            `To add events to ${account.email}, add it again under Accounts so Google can ask for permission.`,
          );
        }
        if (account.calendars.length === 0) continue;
        const group = document.createElement("optgroup");
        group.label = account.email;
        for (const calendar of account.calendars) {
          const index = choices.push({ email: account.email, calendarId: calendar.id }) - 1;
          group.append(new Option(calendar.name, String(index)));
          if (saved?.email === account.email && saved.calendarId === calendar.id) defaultIndex = index;
          if (defaultIndex < 0 && calendar.primary) defaultIndex = index;
        }
        select.append(group);
      }
      notes.replaceChildren(...notesText.map((text) => el("p", undefined, text)));
      if (choices.length === 0) {
        select.append(new Option("No calendars to add to"));
        return;
      }
      select.value = String(Math.max(defaultIndex, 0));
      select.disabled = false;
      update();
    } catch (err) {
      select.replaceChildren(new Option("Couldn't load calendars"));
      error.textContent = errorMessage(err);
    }
  })();
}

function showPreview(preview: HTMLElement, text: string, event: ParsedEvent | null): void {
  if (!text.trim()) {
    preview.replaceChildren(el("p", undefined, "Say what, and when and where if you like."));
    return;
  }
  if (!event) {
    preview.replaceChildren(el("p", undefined, "Add a title, like “Lunch”."));
    return;
  }
  const rows = [el("strong", undefined, event.title), el("p", undefined, describeWhen(event))];
  if (event.location) rows.push(el("p", undefined, event.location));
  preview.replaceChildren(...rows);
}

/** "Thu, 29 Oct, 1:00 PM – 2:00 PM", or "Thu, 12 Nov – Sat, 14 Nov · All day". */
function describeWhen(event: ParsedEvent): string {
  const now = new Date();
  const day = (d: Date) => (d.getFullYear() === now.getFullYear() ? dayFormat : dayWithYearFormat).format(d);
  if (event.allDay) {
    const last = addDays(event.end, -1);
    return `${isSameDay(event.start, last) ? day(event.start) : `${day(event.start)} – ${day(last)}`} · All day`;
  }
  const from = `${day(event.start)}, ${timeFormat.format(event.start)}`;
  const to = isSameDay(event.start, event.end)
    ? timeFormat.format(event.end)
    : `${day(event.end)}, ${timeFormat.format(event.end)}`;
  return `${from} – ${to}`;
}

function toNewEvent(event: ParsedEvent): NewEvent {
  return {
    title: event.title,
    start: event.allDay ? toDateString(event.start) : toLocalIso(event.start),
    end: event.allDay ? toDateString(event.end) : toLocalIso(event.end),
    allDay: event.allDay,
    location: event.location,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
  };
}

/** "2026-10-29T13:00:00+01:00": local time with its UTC offset. */
function toLocalIso(d: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${toDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function savedChoice(): Choice | undefined {
  try {
    const saved = localStorage.getItem(CALENDAR_STORAGE_KEY);
    return saved ? (JSON.parse(saved) as Choice) : undefined;
  } catch {
    return undefined;
  }
}

function saveChoice(choice: Choice | undefined): void {
  if (!choice) return;
  try {
    localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Not important enough to report.
  }
}
