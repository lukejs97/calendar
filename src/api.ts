// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export type Source = "google";
export type ItemKind = "event";

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
}

export interface Agenda {
  account: string | null;
  items: AgendaItem[];
  warnings: string[];
}

/** Shape of every error a command rejects with (see src-tauri/src/error.rs). */
export interface AppError {
  kind: "notSignedIn" | "config" | "auth" | "api" | "network" | "keychain" | "io";
  message: string;
}

export const authStatus = () => invoke<boolean>("auth_status");
export const signIn = () => invoke<void>("sign_in");
export const signOut = () => invoke<void>("sign_out");
export const getAgenda = (days: number) => invoke<Agenda>("get_agenda", { days });

function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const isNotSignedIn = (e: unknown) => isAppError(e) && e.kind === "notSignedIn";

export const errorMessage = (e: unknown) => (isAppError(e) ? e.message : String(e));
