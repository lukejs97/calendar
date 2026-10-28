// Sample data for previewing the UI in a normal browser (`npm run dev`, then
// open http://localhost:1420), where the Rust side isn't available. Only
// loaded in development, never in the built app.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Agenda, AgendaItem, EventDraft, EventTimes, TaskDraft, TaskDue } from "./api";
import { addDays, isSameDay, overlaps, parseDate, startOfDay, toDateString } from "./time";

const PERSONAL = { name: "Personal", color: "#7986cb" };
const WORK = { name: "Work", color: "#33b679" };
const FAMILY = { name: "Family", color: "#f6bf26" };
const HOLIDAYS = { name: "Holidays", color: "#e67c73" };
// Todoist projects
const INBOX = { name: "Inbox", color: "#808080" };
const HOME = { name: "Home", color: "#7ecc49" };
const WORK_TASKS = { name: "Work", color: "#4073ff" };
const PERSONAL_TASKS = { name: "Personal", color: "#af38eb" };

type Calendar = typeof PERSONAL;

function sampleItems(from: Date, to: Date): AgendaItem[] {
  const items: AgendaItem[] = [];
  const base: Omit<AgendaItem, "id" | "title" | "start" | "end" | "allDay" | "location" | "color" | "listName"> = {
    source: "google",
    kind: "event",
    url: "https://calendar.google.com/",
    completed: false,
    overdue: false,
    priority: null,
    account: "preview@example.com",
    listId: "personal",
    sourceId: null,
    seriesId: null,
    editable: true,
    recurring: false,
    description: null,
    attendees: [],
    conferenceUrl: null,
    reminders: [10],
  };
  const today = startOfDay(new Date());

  const task = (day: Date, title: string, priority: number, project: Calendar, hour?: number, overdue = false) => {
    const start = hour === undefined ? null : new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
    items.push({
      ...base,
      source: "todoist",
      kind: "task",
      url: "https://app.todoist.com/",
      account: null,
      listId: "inbox",
      editable: true,
      reminders: [],
      id: `todoist:${title}:${toDateString(day)}`,
      title,
      start: start ? start.toISOString() : toDateString(day),
      end: start ? start.toISOString() : toDateString(addDays(day, 1)),
      allDay: !start,
      location: null,
      color: project.color,
      listName: project.name,
      overdue,
      priority,
    });
  };

  const timed = (
    day: Date,
    title: string,
    cal: Calendar,
    hour: number,
    minutes: number,
    location?: string,
    extra: Partial<AgendaItem> = {},
  ) => {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(hour), (hour % 1) * 60);
    items.push({
      ...base,
      ...extra,
      id: `mock:${title}:${toDateString(day)}`,
      title,
      start: start.toISOString(),
      end: new Date(start.getTime() + minutes * 60_000).toISOString(),
      allDay: false,
      location: location ?? null,
      color: cal.color,
      listName: cal.name,
    });
  };
  const allDay = (day: Date, title: string, cal: Calendar, days = 1) =>
    items.push({
      ...base,
      id: `mock:${title}:${toDateString(day)}`,
      title,
      start: toDateString(day),
      end: toDateString(addDays(day, days)),
      allDay: true,
      location: null,
      color: cal.color,
      listName: cal.name,
    });

  for (let day = from; day < to; day = addDays(day, 1)) {
    const weekday = day.getDay();
    const date = day.getDate();
    if (weekday >= 1 && weekday <= 5) {
      timed(day, "Standup", WORK, 9.5, 15, undefined, {
        recurring: true,
        conferenceUrl: "https://meet.google.com/abc-defg-hij",
        attendees: [
          { name: "Alex Kim", email: "alex@example.com", response: "accepted", organizer: true, isSelf: false },
          { name: null, email: "preview@example.com", response: "accepted", organizer: false, isSelf: true },
          { name: "Sam Lee", email: "sam@example.com", response: "tentative", organizer: false, isSelf: false },
        ],
        description:
          "<p>Daily check-in. Agenda: <a href=\"https://docs.example.com/standup\">standup notes</a></p><p>Three things:<br>yesterday, today, blockers.</p>",
      });
    }
    if (weekday === 1 || weekday === 4) task(day, "Review inbox", 4, INBOX);
    if (weekday === 3) task(day, "Call the plumber", 2, HOME, 13);
    if (weekday === 5) task(day, "Submit expenses", 1, WORK_TASKS);
    if (isSameDay(day, today)) {
      task(day, "Renew passport", 1, PERSONAL_TASKS, undefined, true);
      task(day, "Buy groceries", 3, HOME);
    }
    if (weekday === 1) timed(day, "Planning", WORK, 10, 60, undefined, { recurring: true, seriesId: "planning" });
    if (weekday === 2) {
      timed(day, "Design review", WORK, 11, 60, "Room 4");
      timed(day, "Lunch with Sam", PERSONAL, 11.5, 60, "Cafe Roma");
      timed(day, "Quick sync", WORK, 11.75, 30);
    }
    if (weekday === 3) timed(day, "Dentist", PERSONAL, 14, 60, "123 Main St");
    if (weekday === 4) timed(day, "1:1 with Alex", WORK, 15, 30);
    if (weekday === 5) timed(day, "Drinks", PERSONAL, 18, 120);
    if (weekday === 6) timed(day, "Late show", PERSONAL, 22, 180); // runs past midnight
    if (weekday === 0) timed(day, "Family dinner", FAMILY, 18.5, 90);
    if (date === 1) allDay(day, "Pay rent", PERSONAL);
    if (date === 12) allDay(day, "Conference", WORK, 3);
    if (date === 20) allDay(day, "Grandma's birthday", FAMILY);
    if (date === 25 && day.getMonth() === 11) allDay(day, "Christmas Day", HOLIDAYS);
  }
  return items;
}

export function install(): void {
  let accounts = ["preview@example.com"];
  let todoistConnected = true;
  const completedTasks = new Set<string>();
  const created: AgendaItem[] = [];
  // Changes to sample items, which are made afresh for every request.
  const edits = new Map<string, Partial<AgendaItem>>();
  const deleted = new Set<string>();
  const edit = (id: string, changes: Partial<AgendaItem>) => edits.set(id, { ...edits.get(id), ...changes });
  const dueFields = (due: TaskDue): Partial<AgendaItem> => {
    if (due.kind !== "at") return {};
    const allDay = due.at.length === 10;
    return { start: due.at, end: allDay ? toDateString(addDays(parseDate(due.at), 1)) : due.at, allDay, overdue: false };
  };
  const calendars = [
    { id: "personal", ...PERSONAL, primary: true },
    { id: "work", ...WORK, primary: false },
  ];

  mockIPC((cmd, args) => {
    switch (cmd) {
      case "auth_status":
        return accounts.length > 0;
      case "sign_in": {
        const email = accounts.length === 0 ? "preview@example.com" : `work${accounts.length}@example.com`;
        accounts.push(email);
        return email;
      }
      case "google_accounts":
        return accounts;
      case "remove_google_account": {
        const { email } = args as { email: string };
        accounts = accounts.filter((a) => a !== email);
        return null;
      }
      case "get_agenda": {
        const { from, to } = args as { from: string; to: string };
        // Like the real API: done tasks aren't returned, nor any tasks without Todoist.
        const range = { from: parseDate(from), to: parseDate(to) };
        const items = [...sampleItems(range.from, range.to), ...created]
          .filter((item) => !deleted.has(item.id))
          .map((item) => ({ ...item, ...edits.get(item.id), sourceId: item.id }))
          .filter((item) => overlaps(item, range.from, range.to))
          .filter((item) => (item.kind === "task" ? todoistConnected && !completedTasks.has(item.id) : true));
        const agenda: Agenda = { accounts, items, warnings: [], offlineSince: null };
        return agenda;
      }
      case "search": {
        const query = (args as { query: string }).query.toLowerCase();
        const today = startOfDay(new Date());
        const found = sampleItems(addDays(today, -14), addDays(today, 15)).filter((item) =>
          item.title.toLowerCase().includes(query),
        );
        const now = Date.now();
        const end = (item: AgendaItem) => new Date(item.end ?? item.start).getTime();
        return {
          upcoming: found.filter((item) => end(item) > now).slice(0, 50),
          past: found.filter((item) => end(item) <= now).reverse().slice(0, 50),
          offline: false,
          warnings: [],
        };
      }
      case "todoist_projects":
        return [
          { id: "inbox", name: "Inbox", color: INBOX.color, inbox: true },
          { id: "home", name: "Home", color: HOME.color, inbox: false },
        ];
      case "create_task": {
        const { task } = args as { task: TaskDraft };
        if (task.due?.kind === "at") {
          const due = task.due.at;
          const allDay = due.length === 10;
          created.push({
            id: `mock:task:${created.length}`,
            source: "todoist",
            kind: "task",
            title: task.content,
            start: due,
            end: allDay ? toDateString(addDays(parseDate(due), 1)) : due,
            allDay,
            location: null,
            color: INBOX.color,
            listName: "Inbox",
            url: "https://app.todoist.com/",
            completed: false,
            overdue: false,
            priority: task.priority ?? 4,
            account: null,
            listId: "inbox",
            sourceId: `mock:task:${created.length}`,
            seriesId: null,
            editable: true,
            recurring: false,
            description: null,
            attendees: [],
            conferenceUrl: null,
            reminders: [],
          });
        }
        return null;
      }
      case "get_saved_agenda":
        return null;
      case "event_calendars":
        return accounts.map((email, i) => ({
          email,
          canEdit: i === 0,
          calendars: i === 0 ? calendars.map(({ id, name, color, primary }) => ({ id, name, color, primary })) : [],
          error: null,
        }));
      case "create_event": {
        const { calendarId, event } = args as { calendarId: string; event: EventDraft };
        const calendar = calendars.find((c) => c.id === calendarId)!;
        const id = `mock:created:${created.length}`;
        created.push({
          id,
          source: "google",
          kind: "event",
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          location: event.location,
          color: calendar.color,
          listName: calendar.name,
          url: "https://calendar.google.com/",
          completed: false,
          overdue: false,
          priority: null,
          account: "preview@example.com",
          listId: calendarId,
          sourceId: id,
          seriesId: null,
          editable: true,
          recurring: false,
          description: null,
          attendees: [],
          conferenceUrl: null,
          reminders: [10],
        });
        return null;
      }
      case "update_event": {
        const { target, event, occurrence } = args as {
          target: { eventId: string };
          event: EventDraft;
          occurrence: unknown;
        };
        if (occurrence) console.info("mock IPC: update_event for the whole series", target, event, occurrence);
        const { title, start, end, allDay, location, description } = event;
        edit(target.eventId, { title, start, end, allDay, location, description });
        return null;
      }
      case "set_event_times": {
        const { target, times } = args as { target: { eventId: string }; times: EventTimes };
        edit(target.eventId, { start: times.start, end: times.end, allDay: times.allDay });
        return null;
      }
      case "delete_event":
        deleted.add((args as { target: { eventId: string } }).target.eventId);
        return null;
      case "update_task": {
        const { id, task } = args as { id: string; task: TaskDraft };
        edit(id, { title: task.content, ...(task.description !== null ? { description: task.description } : {}) });
        if (task.due) edit(id, dueFields(task.due));
        if (task.priority) edit(id, { priority: task.priority });
        return null;
      }
      case "set_task_due": {
        const { id, due } = args as { id: string; due: TaskDue };
        edit(id, dueFields(due));
        return null;
      }
      case "delete_task":
        deleted.add((args as { id: string }).id);
        return null;
      case "todoist_status":
        return todoistConnected;
      case "todoist_connect":
        if (!(args as { token: string }).token.trim()) throw { kind: "input", message: "Invalid request: paste your Todoist API token first" };
        todoistConnected = true;
        return null;
      case "todoist_disconnect":
        todoistConnected = false;
        return null;
      case "set_task_completed": {
        const { id, completed } = args as { id: string; completed: boolean };
        if (completed) completedTasks.add(id);
        else completedTasks.delete(id);
        return null;
      }
      default:
        console.info("mock IPC:", cmd, args);
        return null;
    }
  });
}
