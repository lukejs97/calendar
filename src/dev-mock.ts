// Sample data for previewing the UI in a normal browser (`npm run dev`, then
// open http://localhost:1420), where the Rust side isn't available. Only
// loaded in development, never in the built app.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Agenda, AgendaItem, NewEvent } from "./api";
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
    calendarId: "personal",
    eventId: null,
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
      calendarId: null,
      editable: false,
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
    if (weekday === 1) timed(day, "Planning", WORK, 10, 60);
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
        const items = [
          ...sampleItems(range.from, range.to),
          ...created.filter((item) => overlaps(item, range.from, range.to)),
        ].filter((item) => (item.kind === "task" ? todoistConnected && !completedTasks.has(item.id) : true));
        const agenda: Agenda = { accounts, items, warnings: [] };
        return agenda;
      }
      case "event_calendars":
        return accounts.map((email, i) => ({
          email,
          canEdit: i === 0,
          calendars: i === 0 ? calendars.map(({ id, name, color, primary }) => ({ id, name, color, primary })) : [],
          error: null,
        }));
      case "create_event": {
        const { calendarId, event } = args as { calendarId: string; event: NewEvent };
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
          calendarId,
          eventId: id,
          editable: true,
          recurring: false,
          description: null,
          attendees: [],
          conferenceUrl: null,
          reminders: [10],
        });
        return null;
      }
      case "move_event": {
        const { start, end } = args as { start: string; end: string };
        const event = created.find((item) => (args as { eventId: string }).eventId === item.id);
        if (event) Object.assign(event, { start, end });
        return null;
      }
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
