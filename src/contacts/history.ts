// Your history with people: the Recent list, and each card's History, from
// what's logged (src-tauri/src/interactions.rs) and your past events with them.
import type { Contact, Interaction, InteractionKind } from "../api";

/** How each kind of interaction reads in a card's History and the Recent list. */
export const KIND_WORDS: Record<InteractionKind, string> = {
  call: "Called",
  message: "Messaged",
  email: "Emailed",
  facetime: "FaceTimed",
  meeting: "Set up a meeting",
  met: "Met",
  note: "Note",
  added: "Added to Contacts",
};

/** How many people the Recent list shows. */
export const RECENT_COUNT = 6;

/** Each contact's latest interaction, by contact ID. */
export function latestByContact(log: Interaction[]): Map<string, Interaction> {
  const latest = new Map<string, Interaction>();
  for (const entry of log) {
    const seen = latest.get(entry.contactId);
    if (!seen || entry.at >= seen.at) latest.set(entry.contactId, entry);
  }
  return latest;
}

/** The people you've been in touch with most recently, latest first. */
export function recentContacts(contacts: Contact[], log: Interaction[], count = RECENT_COUNT): Contact[] {
  const latest = latestByContact(log);
  return contacts
    .filter((c) => latest.has(c.id))
    .sort((a, b) => time(latest.get(b.id)!.at) - time(latest.get(a.id)!.at))
    .slice(0, count);
}

/** Someone's interactions, latest first. */
export function historyOf(contact: Contact, log: Interaction[]): Interaction[] {
  return log.filter((e) => e.contactId === contact.id).sort((a, b) => time(b.at) - time(a.at));
}

const time = (iso: string) => new Date(iso).getTime();

/** "Just now", "5 min ago", "3 hr ago", "Yesterday", "4 days ago", "Oct 12", "Oct 12, 2025". */
export function relativeTime(when: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - when.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (when >= midnight) return `${Math.round(minutes / 60)} hr ago`;
  const days = Math.ceil((midnight.getTime() - when.getTime()) / 86_400_000);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** "Called · 2 days ago", for the Recent list. */
export function describeLatest(entry: Interaction, now: Date): string {
  return `${KIND_WORDS[entry.kind]} · ${relativeTime(new Date(entry.at), now)}`;
}
