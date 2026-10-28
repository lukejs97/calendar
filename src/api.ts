// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export type Source = "google" | "todoist";
export type ItemKind = "event" | "task";

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
}

export interface Agenda {
  /** The Google accounts' email addresses. */
  accounts: string[];
  items: AgendaItem[];
  warnings: string[];
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
/** Items from local date `from` up to (not including) `to`, both "YYYY-MM-DD". */
export const getAgenda = (from: string, to: string) => invoke<Agenda>("get_agenda", { from, to });

export const todoistStatus = () => invoke<boolean>("todoist_status");
export const todoistConnect = (token: string) => invoke<void>("todoist_connect", { token });
export const todoistDisconnect = () => invoke<void>("todoist_disconnect");
export const setTaskCompleted = (id: string, completed: boolean) =>
  invoke<void>("set_task_completed", { id, completed });

function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const isNotSignedIn = (e: unknown) => isAppError(e) && e.kind === "notSignedIn";

export const errorMessage = (e: unknown) => (isAppError(e) ? e.message : String(e));
