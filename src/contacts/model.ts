// Helpers for contacts: names, initials, finding people by what you type,
// labels in words, and birthdays. No page code here, so the sentence reader
// (parse.ts) can use it too.
import type { Birthday, Contact, Labeled } from "../api";

/** What to call someone: their name, else their company, email or phone. */
export function displayName(contact: Contact): string {
  return (
    contact.name ||
    [contact.givenName, contact.familyName].filter(Boolean).join(" ") ||
    contact.organization ||
    contact.emails[0]?.value ||
    contact.phones[0]?.value ||
    "No name"
  );
}

/** Up to two letters for the round picture of someone without a photo. */
export function initials(contact: Contact): string {
  const words = displayName(contact)
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return letters.map((w) => [...w][0]).join("").toUpperCase() || "?";
}

/** "Designer at Acme", "Acme", "Designer", or "". */
export function workLine(contact: Contact): string {
  const { jobTitle, organization } = contact;
  if (jobTitle && organization) return `${jobTitle} at ${organization}`;
  return jobTitle ?? organization ?? "";
}

/** The letter a contact is listed under: A–Z, or # for anything else. */
export function indexLetter(contact: Contact): string {
  const first = displayName(contact)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")[0]
    ?.toUpperCase();
  return first && /[A-Z]/.test(first) ? first : "#";
}

const LABELS: Record<string, string> = {
  home: "Home",
  work: "Work",
  other: "Other",
  mobile: "Mobile",
  main: "Main",
  homeFax: "Home fax",
  workFax: "Work fax",
  otherFax: "Fax",
  pager: "Pager",
  workMobile: "Work mobile",
  workPager: "Work pager",
  googleVoice: "Google Voice",
  homePage: "Home page",
  blog: "Blog",
  profile: "Profile",
  appInstallPage: "App",
  ftp: "FTP",
  reservations: "Reservations",
};

/** A label in words: "Mobile", "Work", or your own as you wrote it. */
export function labelText(label: string | null, fallback: string): string {
  if (!label) return fallback;
  return LABELS[label] ?? label;
}

/** Digits (and a leading +) only, for tel: and sms: links. */
export const dialable = (phone: string) => phone.replace(/(?!^\+)[^\d]/g, "");

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** The words a contact can be found by. */
function nameWords(contact: Contact): string[] {
  const names = [contact.name, contact.givenName, contact.familyName, contact.nickname].filter(Boolean).join(" ");
  return fold(names).split(/[\s.,'’-]+/).filter(Boolean);
}

/**
 * How well `query` matches a contact: 0 for not at all. Every word typed has
 * to start a word of their name, nickname, company or job, or be part of an
 * email address; digits can match part of a phone number.
 */
export function matchScore(contact: Contact, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const names = nameWords(contact);
  const full = fold(displayName(contact));
  const q = words.join(" ");
  if (full === q) return 100;

  const others = fold([contact.organization, contact.jobTitle].filter(Boolean).join(" ")).split(/\s+/);
  const emails = contact.emails.map((e) => fold(e.value));
  const phones = contact.phones.map((p) => dialable(p.value));
  let score = 0;
  let onlyNames = true;
  for (const word of words) {
    if (names.some((n) => n.startsWith(word))) continue;
    onlyNames = false;
    const digits = word.replace(/\D/g, "");
    if (others.some((o) => o.startsWith(word))) continue;
    if (emails.some((e) => e.includes(word))) continue;
    if (digits.length >= 3 && digits.length === word.replace(/[\s()+.-]/g, "").length && phones.some((p) => p.includes(digits))) {
      continue;
    }
    return 0;
  }
  if (onlyNames) score = full.startsWith(q) ? 80 : 60;
  else score = 30;
  return score + (contact.starred ? 5 : 0);
}

/** The contacts matching `query`, best first (A–Z among equals). */
export function search(contacts: Contact[], query: string): Contact[] {
  const scored = contacts.map((contact) => ({ contact, score: matchScore(contact, query) })).filter((s) => s.score > 0);
  return scored.sort((a, b) => b.score - a.score).map((s) => s.contact);
}

// ---------- Birthdays ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A month's number (1–12) from its name or first three letters; 0 if it isn't one. */
export function monthNumber(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  return w.length < 3 ? 0 : MONTHS.findIndex((m) => m.startsWith(w)) + 1;
}

/** "March 4, 1990" or "March 4" (in your language's order). */
export function describeBirthday(birthday: Birthday): string {
  const date = new Date(birthday.year ?? 2000, birthday.month - 1, birthday.day);
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(birthday.year ? { year: "numeric" } : {}),
  });
}

/** The next birthday on or after `today` (Feb 29 falls on Mar 1 in other years). */
export function nextBirthday(birthday: Birthday, today: Date): Date {
  const on = (year: number) => new Date(year, birthday.month - 1, birthday.day);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const thisYear = on(start.getFullYear());
  return thisYear >= start ? thisYear : on(start.getFullYear() + 1);
}

/** Days until the next birthday: 0 today, 1 tomorrow… */
export function daysUntilBirthday(birthday: Birthday, today: Date): number {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((nextBirthday(birthday, today).getTime() - start.getTime()) / 86_400_000);
}

/** How old they'll be on their next birthday, if the year is known. */
export function turning(birthday: Birthday, today: Date): number | null {
  return birthday.year ? nextBirthday(birthday, today).getFullYear() - birthday.year : null;
}

/** "Today", "Tomorrow", "In 5 days", "Mon, Nov 3". */
export function whenBirthday(birthday: Birthday, today: Date): string {
  const days = daysUntilBirthday(birthday, today);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return nextBirthday(birthday, today).toLocaleDateString(undefined, { weekday: "long" });
  return nextBirthday(birthday, today).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** People whose birthday is within `days` of today, soonest first. */
export function upcomingBirthdays(contacts: Contact[], today: Date, days: number): Contact[] {
  return contacts
    .filter((c) => c.birthday && daysUntilBirthday(c.birthday, today) < days)
    .sort((a, b) => daysUntilBirthday(a.birthday!, today) - daysUntilBirthday(b.birthday!, today));
}

/** Labeled values that differ from `existing` (case-insensitive; phones by digits). */
export function newValues(values: Labeled[], existing: Labeled[], kind: "email" | "phone" | "other"): Labeled[] {
  const key = (v: string) => (kind === "phone" ? dialable(v) : v.trim().toLowerCase());
  const have = new Set(existing.map((e) => key(e.value)));
  return values.filter((v) => !have.has(key(v.value)));
}
