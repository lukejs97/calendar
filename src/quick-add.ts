// The "New" dialog: describe an event or a task in a sentence, check the
// preview, and add it to one of your Google calendars or Todoist projects.
import {
  createEvent,
  createTask,
  errorMessage,
  eventCalendars,
  todoistProjects,
  todoistStatus,
  type NewEvent,
} from "./api";
import { el } from "./dom";
import { parseEvent, parseTask, type ParsedEvent, type ParsedTask } from "./quick-parse";
import { addDays, describeTimes, localTimeZone, toDateString, toLocalIso } from "./time";

export type Mode = "event" | "task";

const CALENDAR_STORAGE_KEY = "calendar.newEventCalendar";
const PROJECT_STORAGE_KEY = "calendar.newTaskProject";

const TEXT: Record<Mode, { title: string; placeholder: string; label: string; picker: string }> = {
  event: {
    title: "New event",
    placeholder: "Lunch with Sam tomorrow 1pm at Cafe Roma",
    label: "Describe the event",
    picker: "Calendar",
  },
  task: {
    title: "New task",
    placeholder: "Submit expenses Friday p1",
    label: "Describe the task",
    picker: "Todoist project",
  },
};

interface CalendarChoice {
  email: string;
  calendarId: string;
}

/** A dropdown that fills itself once its options have loaded. */
interface Picker {
  select: HTMLSelectElement;
  notes: HTMLElement;
  /** False while loading, or if there's nothing to pick. */
  ready: boolean;
}

/**
 * Opens the dialog. `onCreated` runs once the event or task is added, with
 * when it is (null for a task without a date).
 */
export function openQuickAdd(onCreated: (start: Date | null, allDay: boolean) => void, mode: Mode = "event"): void {
  const dialog = el("dialog", "dialog");
  dialog.setAttribute("aria-labelledby", "quick-add-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const title = el("h2");
  title.id = "quick-add-title";
  const switcher = el("div", "segmented");
  switcher.role = "group";
  switcher.setAttribute("aria-label", "Add an event or a task");
  const modeButtons = (["event", "task"] as const).map((m) => {
    const button = el("button", undefined, m === "event" ? "Event" : "Task");
    button.type = "button";
    button.addEventListener("click", () => setMode(m));
    switcher.append(button);
    return [m, button] as const;
  });
  const header = el("div", "quick-header");
  header.append(title, switcher);

  const input = el("input", "text-input");
  input.autocomplete = "off";
  const preview = el("div", "quick-preview");
  preview.setAttribute("aria-live", "polite");

  const pickerLabel = el("label", "field-label");
  const calendars: Picker = { select: el("select", "text-input"), notes: el("div"), ready: false };
  const projects: Picker = { select: el("select", "text-input"), notes: el("div"), ready: false };
  calendars.select.id = "quick-add-calendar";
  projects.select.id = "quick-add-project";
  let calendarChoices: CalendarChoice[] = [];
  let projectsRequested = false;
  const error = el("p", "error");

  const cancel = el("button", "text-button", "Cancel");
  cancel.type = "button"; // not "submit", which a button inside the form would be
  cancel.addEventListener("click", () => dialog.close());
  const add = el("button", "primary-button", "Add");

  const picker = () => (mode === "event" ? calendars : projects);
  const parse = (): ParsedEvent | ParsedTask | null =>
    mode === "event" ? parseEvent(input.value, new Date()) : parseTask(input.value, new Date());

  function update(): void {
    const parsed = parse();
    if (mode === "event") showEventPreview(preview, input.value, parsed as ParsedEvent | null);
    else showTaskPreview(preview, input.value, parsed as ParsedTask | null);
    add.disabled = !parsed || !picker().ready;
  }

  function setMode(next: Mode): void {
    mode = next;
    const text = TEXT[mode];
    title.textContent = text.title;
    input.placeholder = text.placeholder;
    input.setAttribute("aria-label", text.label);
    pickerLabel.textContent = text.picker;
    pickerLabel.htmlFor = picker().select.id;
    for (const [m, button] of modeButtons) button.setAttribute("aria-pressed", String(m === mode));
    calendars.select.hidden = calendars.notes.hidden = mode !== "event";
    projects.select.hidden = projects.notes.hidden = mode !== "task";
    if (mode === "task" && !projectsRequested) {
      projectsRequested = true;
      void loadProjects(projects, update);
    }
    error.textContent = "";
    update();
    input.focus();
  }

  input.addEventListener("input", update);
  calendars.select.addEventListener("change", () =>
    save(CALENDAR_STORAGE_KEY, calendarChoices[Number(calendars.select.value)]),
  );
  projects.select.addEventListener("change", () => save(PROJECT_STORAGE_KEY, projects.select.value));

  const form = el("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Read it again, so "in 2 hours" counts from now, not from the last keystroke.
    const parsed = parse();
    if (!parsed || !picker().ready) return;
    add.disabled = true;
    add.textContent = "Adding…";
    error.textContent = "";
    try {
      if (mode === "event") {
        const event = parsed as ParsedEvent;
        const choice = calendarChoices[Number(calendars.select.value)];
        await createEvent(choice.email, choice.calendarId, toNewEvent(event));
        save(CALENDAR_STORAGE_KEY, choice);
        dialog.close();
        onCreated(event.start, event.allDay);
      } else {
        const task = parsed as ParsedTask;
        await createTask({
          content: task.title,
          projectId: projects.select.value || null,
          due: task.due ? (task.due.allDay ? toDateString(task.due.start) : toLocalIso(task.due.start)) : null,
          priority: task.priority,
        });
        save(PROJECT_STORAGE_KEY, projects.select.value);
        dialog.close();
        onCreated(task.due?.start ?? null, task.due?.allDay ?? true);
      }
    } catch (err) {
      error.textContent = errorMessage(err);
      add.disabled = false;
      add.textContent = "Add";
    }
  });

  const buttons = el("div", "dialog-buttons");
  buttons.append(cancel, add);
  form.append(
    input,
    preview,
    pickerLabel,
    calendars.select,
    projects.select,
    calendars.notes,
    projects.notes,
    error,
    buttons,
  );
  dialog.append(header, form);
  dialog.showModal();

  void loadCalendars(calendars, (choices) => {
    calendarChoices = choices;
    update();
  });
  setMode(mode);
}

/** Fills the calendar picker: calendars you can edit, by account. */
async function loadCalendars(picker: Picker, done: (choices: CalendarChoice[]) => void): Promise<void> {
  const { select, notes } = picker;
  select.replaceChildren(new Option("Loading calendars…"));
  select.disabled = true;
  try {
    const accounts = await eventCalendars();
    const saved = load<CalendarChoice>(CALENDAR_STORAGE_KEY);
    const choices: CalendarChoice[] = [];
    let defaultIndex = -1;
    const notesText: string[] = [];
    select.replaceChildren();
    for (const account of accounts) {
      if (account.error) notesText.push(`Couldn't load ${account.email}'s calendars: ${account.error}`);
      else if (!account.canEdit) {
        notesText.push(`To add events to ${account.email}, add it again under Accounts so Google can ask for permission.`);
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
    if (choices.length === 0) select.append(new Option("No calendars to add to"));
    else {
      select.value = String(Math.max(defaultIndex, 0));
      select.disabled = false;
      picker.ready = true;
    }
    done(choices);
  } catch (err) {
    select.replaceChildren(new Option("Couldn't load calendars"));
    notes.replaceChildren(el("p", "error", errorMessage(err)));
  }
}

/** Fills the project picker, Inbox first. */
async function loadProjects(picker: Picker, done: () => void): Promise<void> {
  const { select, notes } = picker;
  select.replaceChildren(new Option("Loading projects…"));
  select.disabled = true;
  try {
    if (!(await todoistStatus())) {
      select.replaceChildren(new Option("Todoist isn't connected"));
      notes.replaceChildren(el("p", undefined, "Connect Todoist first: click Todoist in the top bar."));
      done();
      return;
    }
    const projects = await todoistProjects();
    const saved = load<string>(PROJECT_STORAGE_KEY);
    select.replaceChildren(...projects.map((p) => new Option(p.name, p.id)));
    if (saved && projects.some((p) => p.id === saved)) select.value = saved;
    select.disabled = false;
    picker.ready = true;
  } catch (err) {
    select.replaceChildren(new Option("Couldn't load projects"));
    notes.replaceChildren(el("p", "error", errorMessage(err)));
  }
  done();
}

function showEventPreview(preview: HTMLElement, text: string, event: ParsedEvent | null): void {
  if (!text.trim()) {
    preview.replaceChildren(el("p", undefined, "Say what, and when and where if you like."));
    return;
  }
  if (!event) {
    preview.replaceChildren(el("p", undefined, "Add a title, like “Lunch”."));
    return;
  }
  const rows = [
    el("strong", undefined, event.title),
    el("p", undefined, describeTimes(event.start, event.end, event.allDay)),
  ];
  if (event.location) rows.push(el("p", undefined, event.location));
  preview.replaceChildren(...rows);
}

function showTaskPreview(preview: HTMLElement, text: string, task: ParsedTask | null): void {
  if (!text.trim()) {
    preview.replaceChildren(el("p", undefined, "Say what, and when if it's due. Add p1–p4 for priority."));
    return;
  }
  if (!task) {
    preview.replaceChildren(el("p", undefined, "Add a name, like “Buy milk”."));
    return;
  }
  let due = "No due date";
  if (task.due?.allDay) {
    due = `Due ${describeTimes(task.due.start, addDays(task.due.start, 1), true).replace(" · All day", "")}`;
  } else if (task.due) {
    due = `Due ${describeTimes(task.due.start, task.due.start, false)}`; // just the start
  }
  const rows = [el("strong", undefined, task.title), el("p", undefined, due)];
  if (task.priority) rows.push(el("p", undefined, `Priority ${task.priority}`));
  preview.replaceChildren(...rows);
}

function toNewEvent(event: ParsedEvent): NewEvent {
  return {
    title: event.title,
    start: event.allDay ? toDateString(event.start) : toLocalIso(event.start),
    end: event.allDay ? toDateString(event.end) : toLocalIso(event.end),
    allDay: event.allDay,
    location: event.location,
    timeZone: localTimeZone(),
  };
}

function load<T>(key: string): T | undefined {
  try {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T) : undefined;
  } catch {
    return undefined;
  }
}

function save(key: string, value: unknown): void {
  if (value === undefined) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not important enough to report.
  }
}
