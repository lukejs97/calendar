// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export type Source = "google" | "todoist";
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
  /** Google events: the account and calendar they're on, and their ID there. */
  account: string | null;
  calendarId: string | null;
  eventId: string | null;
  /** Google events the app may move or resize. */
  editable: boolean;
  /** One occurrence of a repeating event. */
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

/** Mirrors `NewEvent` in google/calendar.rs. */
export interface NewEvent {
  title: string;
  /** "YYYY-MM-DD" when allDay, otherwise an ISO timestamp with offset. */
  start: string;
  /** For all-day events, the day after the last day. */
  end: string;
  allDay: boolean;
  location: string | null;
  /** IANA time zone, e.g. "Europe/London". */
  timeZone: string | null;
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

/** Mirrors `NewTask` in src-tauri/src/todoist.rs. */
export interface NewTask {
  content: string;
  /** Null for the Inbox. */
  projectId: string | null;
  /** "YYYY-MM-DD", an ISO time with offset, or null for no due date. */
  due: string | null;
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
export const createEvent = (email: string, calendarId: string, event: NewEvent) =>
  invoke<void>("create_event", { email, calendarId, event });
/** Moves or resizes a timed Google event; `start` and `end` are ISO timestamps with offset. */
export const moveEvent = (item: AgendaItem, start: string, end: string, timeZone: string | null) =>
  invoke<void>("move_event", {
    email: item.account,
    calendarId: item.calendarId,
    eventId: item.eventId,
    start,
    end,
    timeZone,
  });
/** Items from local date `from` up to (not including) `to`, both "YYYY-MM-DD". */
export const getAgenda = (from: string, to: string) => invoke<Agenda>("get_agenda", { from, to });
/** What was saved last time for that range, without the network; null if nothing. */
export const getSavedAgenda = (from: string, to: string) => invoke<Agenda | null>("get_saved_agenda", { from, to });

export const todoistStatus = () => invoke<boolean>("todoist_status");
export const todoistConnect = (token: string) => invoke<void>("todoist_connect", { token });
export const todoistDisconnect = () => invoke<void>("todoist_disconnect");
export const todoistProjects = () => invoke<TodoistProject[]>("todoist_projects");
export const createTask = (task: NewTask) => invoke<void>("create_task", { task });
export const setTaskCompleted = (id: string, completed: boolean) =>
  invoke<void>("set_task_completed", { id, completed });

function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const isNotSignedIn = (e: unknown) => isAppError(e) && e.kind === "notSignedIn";

export const errorMessage = (e: unknown) => (isAppError(e) ? e.message : String(e));
