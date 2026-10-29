// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export type Source = "google" | "todoist" | "apple";
export type ItemKind = "event" | "task";

/** Someone invited to an event. Mirrors `Attendee` in src-tauri/src/agenda.rs. */
export interface Attendee {
  name: string | null;
  email: string | null;
  /** "accepted", "declined", "tentative" or "needsAction". */
  response: string | null;
  organizer: boolean;
  isSelf: boolean;
}

/** Mirrors `AgendaItem` in src-tauri/src/agenda.rs. */
export interface AgendaItem {
  id: string;
  source: Source;
  kind: ItemKind;
  title: string;
  /** "YYYY-MM-DD" when allDay, otherwise an ISO timestamp. */
  start: string;
  /** For all-day items, the day after the last day. */
  end: string | null;
  allDay: boolean;
  location: string | null;
  color: string | null;
  listName: string;
  url: string | null;
  /** Tasks only. */
  completed: boolean;
  /** Tasks only: due before today, and shown on today instead. */
  overdue: boolean;
  /** Tasks only: 1 (most urgent) to 4, as numbered in the Todoist app. */
  priority: number | null;
  /** Google events: the account they're in. */
  account: string | null;
  /** The Google calendar, or Todoist project, it's in. */
  listId: string | null;
  /** Its ID in its own service: the Google event, or Todoist task. */
  sourceId: string | null;
  /** For one occurrence of a repeating Google event, the whole series' ID. */
  seriesId: string | null;
  /** Items the app may change (see AgendaItem.editable in agenda.rs). */
  editable: boolean;
  /** One occurrence of a repeating event, or a repeating task. */
  recurring: boolean;
  /** Notes. Google's may contain simple HTML. */
  description: string | null;
  attendees: Attendee[];
  /** Video call link: Google Meet, Zoom, Teams and the like. */
  conferenceUrl: string | null;
  /** When to alert, in minutes before the start. */
  reminders: number[];
}

export interface Agenda {
  /** The Google accounts' email addresses. */
  accounts: string[];
  items: AgendaItem[];
  warnings: string[];
  /** Set when there's no internet and these are saved items: when they were fetched. */
  offlineSince: string | null;
}

/** A calendar you can add events to. Mirrors `EventCalendar` in google/calendar.rs. */
export interface EventCalendar {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
}

export interface AccountCalendars {
  email: string;
  /** False until an account added before the app could add events is added again. */
  canEdit: boolean;
  calendars: EventCalendar[];
  /** Why the calendars couldn't be listed, if they couldn't. */
  error: string | null;
}

/** When an event happens. Mirrors `EventTimes` in google/calendar.rs. */
export interface EventTimes {
  /** "YYYY-MM-DD" when allDay, otherwise an ISO timestamp with offset. */
  start: string;
  /** For all-day events, the day after the last day. */
  end: string;
  allDay: boolean;
  /** IANA time zone, e.g. "Europe/London". */
  timeZone: string | null;
}

/** An event's alerts: its calendar's defaults, or its own (minutes before; empty for none). */
export type Alerts = { kind: "default" } | { kind: "custom"; minutes: number[] };

/** An event as the New or Edit form filled it in. Mirrors `EventDraft` in google/calendar.rs. */
export interface EventDraft extends EventTimes {
  title: string;
  location: string | null;
  description: string | null;
  /** Repeat rules ("RRULE:…"); null leaves an existing event's repeat as it is. */
  recurrence: string[] | null;
  /** Null leaves an existing event's alerts as they are. */
  alerts: Alerts | null;
  /** Null leaves an existing event's guests as they are. `response` keeps someone's reply. */
  guests: { email: string; response: string | null }[] | null;
}

/** Which Google event. For a repeating event, use `seriesId` to mean every occurrence. */
export interface EventRef {
  email: string;
  calendarId: string;
  eventId: string;
}

export function eventRef(item: AgendaItem, wholeSeries = false): EventRef {
  return {
    email: item.account!,
    calendarId: item.listId!,
    eventId: (wholeSeries && item.seriesId) || item.sourceId!,
  };
}

/** Mirrors `SearchResults` in src-tauri/src/search.rs. */
export interface SearchResults {
  /** Soonest first. */
  upcoming: AgendaItem[];
  /** Most recent first. */
  past: AgendaItem[];
  /** True when nothing could be reached and saved items were searched. */
  offline: boolean;
  warnings: string[];
}

/** A Todoist project. Mirrors `ProjectInfo` in src-tauri/src/todoist.rs. */
export interface TodoistProject {
  id: string;
  name: string;
  color: string | null;
  inbox: boolean;
}

/** A task's due date: none; a day ("YYYY-MM-DD") or ISO time; or words Todoist reads ("every Monday"). */
export type TaskDue = { kind: "none" } | { kind: "at"; at: string } | { kind: "words"; at: string };

/** A task as the New or Edit form filled it in. Mirrors `TaskDraft` in todoist.rs. */
export interface TaskDraft {
  content: string;
  description: string | null;
  /** Null: the Inbox when adding; when editing, leaves it where it is. */
  projectId: string | null;
  /** Null leaves an existing task's due date as it is (and adds none). */
  due: TaskDue | null;
  /** 1 (most urgent) to 4, as in the Todoist app. */
  priority: number | null;
}

/** Shape of every error a command rejects with (see src-tauri/src/error.rs). */
export interface AppError {
  kind: "notSignedIn" | "config" | "auth" | "input" | "api" | "network" | "keychain" | "io";
  message: string;
}

export const authStatus = () => invoke<boolean>("auth_status");
/** Adds a Google account (or renews one already added); resolves to its email. */
export const signIn = () => invoke<string>("sign_in");
export const googleAccounts = () => invoke<string[]>("google_accounts");
export const removeGoogleAccount = (email: string) => invoke<void>("remove_google_account", { email });
/** Events and tasks from a year back to a year ahead matching `query`. */
export const search = (query: string) => invoke<SearchResults>("search", { query });
export const eventCalendars = () => invoke<AccountCalendars[]>("event_calendars");
export const createEvent = (email: string, calendarId: string, event: EventDraft) =>
  invoke<void>("create_event", { email, calendarId, event });
/**
 * `moveTo`: another calendar in the same account, or null. `notifyGuests`
 * emails them. `occurrence`: when editing every event in a repeating series
 * from one of them, that one's times before the edit (and `target` is the series).
 */
export const updateEvent = (
  target: EventRef,
  event: EventDraft,
  moveTo: string | null,
  notifyGuests: boolean,
  occurrence: EventTimes | null = null,
) => invoke<void>("update_event", { target, event, moveTo, notifyGuests, occurrence });
/** Moves or resizes an event (dragging it). */
export const setEventTimes = (target: EventRef, times: EventTimes, notifyGuests: boolean) =>
  invoke<void>("set_event_times", { target, times, notifyGuests });
export const deleteEvent = (target: EventRef, notifyGuests: boolean) =>
  invoke<void>("delete_event", { target, notifyGuests });
/** Items from local date `from` up to (not including) `to`, both "YYYY-MM-DD". */
export const getAgenda = (from: string, to: string) => invoke<Agenda>("get_agenda", { from, to });
/** What was saved last time for that range, without the network; null if nothing. */
export const getSavedAgenda = (from: string, to: string) => invoke<Agenda | null>("get_saved_agenda", { from, to });

export const todoistStatus = () => invoke<boolean>("todoist_status");
export const todoistConnect = (token: string) => invoke<void>("todoist_connect", { token });
export const todoistDisconnect = () => invoke<void>("todoist_disconnect");
export const todoistProjects = () => invoke<TodoistProject[]>("todoist_projects");
export const createTask = (task: TaskDraft) => invoke<void>("create_task", { task });
/** `id` is the task's own Todoist ID (`AgendaItem.sourceId`). */
export const updateTask = (id: string, task: TaskDraft) => invoke<void>("update_task", { id, task });
export const setTaskDue = (id: string, due: TaskDue) => invoke<void>("set_task_due", { id, due });
export const deleteTask = (id: string) => invoke<void>("delete_task", { id });
export const setTaskCompleted = (id: string, completed: boolean) =>
  invoke<void>("set_task_completed", { id, completed });

/** Brings up the main window (from the menu bar window). */
export const showMain = () => invoke<void>("show_main");
/** Detaches the menu bar window into a window of its own, or puts it back. */
export const setFlyoutDetached = (detached: boolean) => invoke<void>("set_flyout_detached", { detached });

/** Settings the Rust side keeps (mirrors `Prefs` in src-tauri/src/prefs.rs). */
export interface Preferences {
  menuBarNext: boolean;
  timeToLeave: boolean;
  appleCalendar: boolean;
  appleReminders: boolean;
  /** Apple calendars and reminder lists shown or left out, where chosen. */
  appleCalendarsShown: Record<string, boolean>;
}

/** Whether macOS lets Minuteman use something (calendars, location). */
export type Access = "notAsked" | "granted" | "denied";

export interface AppleStatus {
  calendar: Access;
  reminders: Access;
}

/** A calendar from the Mac's Calendar app, or a list from Reminders. */
export interface AppleCalendar {
  id: string;
  title: string;
  /** Its account: "iCloud", "On My Mac", an email address… */
  account: string;
  color: string;
  reminders: boolean;
  shown: boolean;
}

export const getPreferences = () => invoke<Preferences>("get_preferences");
export const setPreferences = (preferences: Preferences) => invoke<void>("set_preferences", { preferences });
/** Mac only; null elsewhere. */
export const appleStatus = () => invoke<AppleStatus | null>("apple_status");
/** Shows macOS's permission prompt the first time; resolves once answered. */
export const appleRequestAccess = (kind: "calendar" | "reminders") =>
  invoke<Access>("apple_request_access", { kind });
export const appleCalendars = () => invoke<AppleCalendar[]>("apple_calendars");
/** Mac only; null elsewhere. */
export const locationAccess = () => invoke<Access | null>("location_access");

function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const isNotSignedIn = (e: unknown) => isAppError(e) && e.kind === "notSignedIn";

export const errorMessage = (e: unknown) => (isAppError(e) ? e.message : String(e));
