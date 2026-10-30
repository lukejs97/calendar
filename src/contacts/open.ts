// Opens Contacts from anywhere in Minuteman (the toolbar, an event's guests):
// in the desktop app its own window; on a phone or the website, its page.
import { isTauri } from "@tauri-apps/api/core";
import { showContacts } from "../api";

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
