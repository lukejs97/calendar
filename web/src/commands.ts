// The commands the website calls at /api/<name>: the same names and
// arguments as the desktop app's Rust commands (src-tauri/src/lib.rs), so
// the shared screens work unchanged.
import type { EventDraft, EventRef, EventTimes, TaskDraft, TaskDue } from "../../src/api";
import * as agenda from "./agenda";
import type { Context } from "./env";
import { configError, invalidInput } from "./errors";
import * as google from "./google";
import { readAccounts, readTodoistToken, removeAccount, setCalendarShown, writeTodoistToken } from "./store";
import * as todoist from "./todoist";

type Args = Record<string, unknown>;
type Command = (ctx: Context, args: Args) => Promise<unknown>;

const text = (args: Args, name: string): string => {
  const value = args[name];
  if (typeof value !== "string") throw invalidInput(`${name} must be text`);
  return value;
};
const flag = (args: Args, name: string) => args[name] === true;
const value = <T>(args: Args, name: string): T => {
  if (!(name in args)) throw invalidInput(`${name} is missing`);
  return args[name] as T;
};

async function todoistToken(ctx: Context): Promise<string> {
  const token = await readTodoistToken(ctx.env);
  if (!token) throw configError("Todoist isn't connected");
  return token;
}

async function tokenFor(ctx: Context, email: string): Promise<string> {
  return google.accessToken(ctx.env, await google.findAccount(ctx.env, email));
}

export const commands: Record<string, Command> = {
  // Accounts
  async google_accounts(ctx) {
    return (await readAccounts(ctx.env)).map((a) => a.email);
  },
  async remove_google_account(ctx, args) {
    const removed = await removeAccount(ctx.env, text(args, "email"));
    if (removed) {
      google.forgetAccessToken(removed.email);
      await google.revoke(removed.refreshToken);
    }
    return null;
  },

  // Reading
  async get_agenda(ctx, args) {
    return agenda.load(ctx, text(args, "from"), text(args, "to"));
  },
  // Nothing is saved on the server for offline use; the site always fetches.
  async get_saved_agenda() {
    return null;
  },
  async search(ctx, args) {
    return agenda.search(ctx, text(args, "query"));
  },
  async event_calendars(ctx) {
    return google.eventCalendars(ctx.env);
  },
  async google_calendars(ctx) {
    return google.allCalendars(ctx.env);
  },
  async set_google_calendar_shown(ctx, args) {
    await setCalendarShown(ctx.env, text(args, "email"), text(args, "calendarId"), flag(args, "shown"));
    return null;
  },

  // Events
  async create_event(ctx, args) {
    const token = await tokenFor(ctx, text(args, "email"));
    await google.createEvent(token, text(args, "calendarId"), value<EventDraft>(args, "event"));
    return null;
  },
  async update_event(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    let calendarId = target.calendarId;
    const moveTo = args.moveTo as string | null;
    if (moveTo && moveTo !== calendarId) {
      await google.moveToCalendar(token, calendarId, target.eventId, moveTo);
      calendarId = moveTo;
    }
    const event = value<EventDraft>(args, "event");
    const occurrence = (args.occurrence ?? null) as EventTimes | null;
    const notify = flag(args, "notifyGuests");
    if (occurrence) await google.updateSeries(token, ctx.zone, calendarId, target.eventId, occurrence, event, notify);
    else await google.updateEvent(token, calendarId, target.eventId, event, notify);
    return null;
  },
  async set_event_times(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    await google.setEventTimes(token, target.calendarId, target.eventId, value<EventTimes>(args, "times"), flag(args, "notifyGuests"));
    return null;
  },
  async delete_event(ctx, args) {
    const target = value<EventRef>(args, "target");
    const token = await tokenFor(ctx, target.email);
    await google.deleteEvent(token, target.calendarId, target.eventId, flag(args, "notifyGuests"));
    return null;
  },

  // Todoist
  async todoist_status(ctx) {
    return (await readTodoistToken(ctx.env)) !== null;
  },
  /** Checks the API token with Todoist, then stores it (encrypted). */
  async todoist_connect(ctx, args) {
    const token = text(args, "token").trim();
    if (!token) throw invalidInput("paste your Todoist API token first");
    await todoist.verifyToken(token);
    await writeTodoistToken(ctx.env, token);
    return null;
  },
  async todoist_disconnect(ctx) {
    await writeTodoistToken(ctx.env, null);
    return null;
  },
  async todoist_projects(ctx) {
    return todoist.projects(await todoistToken(ctx));
  },
  async create_task(ctx, args) {
    await todoist.createTask(await todoistToken(ctx), value<TaskDraft>(args, "task"));
    return null;
  },
  async update_task(ctx, args) {
    await todoist.updateTask(await todoistToken(ctx), text(args, "id"), value<TaskDraft>(args, "task"));
    return null;
  },
  async set_task_due(ctx, args) {
    await todoist.setTaskDue(await todoistToken(ctx), text(args, "id"), value<TaskDue>(args, "due"));
    return null;
  },
  async delete_task(ctx, args) {
    await todoist.deleteTask(await todoistToken(ctx), text(args, "id"));
    return null;
  },
  async set_task_completed(ctx, args) {
    await todoist.setCompleted(await todoistToken(ctx), text(args, "id"), flag(args, "completed"));
    return null;
  },

  // Desktop-only windows have nothing to do on the web.
  async show_main() {
    return null;
  },
};
