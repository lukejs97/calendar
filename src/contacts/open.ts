// Opens Contacts from anywhere in Minuteman (the toolbar, an event's guests),
// and the calendar from Contacts: in the desktop app their own windows; on a
// phone or the website, their pages.
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { showContacts, showMain } from "../api";
import { toDateString } from "../time";

/** Tells the calendar's window to show a day (see `GO_TO_DAY` in main.ts). */
export const GO_TO_DAY = "calendar-go-to-day";

const isPhone = () => /iPhone|iPad|Android/.test(navigator.userAgent);

/** Shows Contacts, with `query` (a name or email address) in its box if given. */
export function openContacts(query: string | null = null): void {
  if (isTauri() && !isPhone()) {
    void showContacts(query);
    return;
  }
  const url = new URL("contacts.html", location.href);
  url.search = query ? new URLSearchParams({ q: query }).toString() : "";
  location.assign(url.toString());
}

/** Shows the calendar, on `day` (in Day view) if given, e.g. someone's birthday. */
export function openCalendar(day: Date | null = null): void {
  if (isTauri() && !isPhone()) {
    void showMain().then(() => day && emit(GO_TO_DAY, toDateString(day)));
    return;
  }
  const url = new URL("./", location.href);
  url.search = day ? new URLSearchParams({ date: toDateString(day) }).toString() : "";
  location.assign(url.toString());
}
