// Pop-up alerts before events start, at the reminder times set on each event
// in Google Calendar (or its calendar's defaults). They come from the app, so
// only while it's open. Desktop only: on iPhone the plugin isn't included and
// alerts quietly stay off.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getAgenda, type AgendaItem } from "./api";
import { addDays, MS_PER_MINUTE, startOfDay, timeFormat, toDateString } from "./time";

const CHECK_EVERY_MS = 30 * 1000;
const RELOAD_EVERY_MS = 5 * MS_PER_MINUTE;
/**
 * Alerts more than this late are skipped, so waking a laptop that slept
 * through the morning doesn't deliver a pile of them at once.
 */
const LATEST_MS = 2 * MS_PER_MINUTE;

let timer: number | undefined;
/** Today's and tomorrow's items. */
let upcoming: AgendaItem[] = [];
let loadedAt = 0;
let lastCheck = 0;
/** Alerts already shown: item, its start, and minutes before. */
const sent = new Set<string>();

/** Starts checking for due alerts, asking for permission the first time. */
export async function startAlerts(): Promise<void> {
  if (timer !== undefined) return;
  try {
    if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
  } catch {
    return; // no notification plugin: the iPhone app, or the browser preview
  }
  lastCheck = Date.now();
  timer = window.setInterval(check, CHECK_EVERY_MS);
  void check();
}

export function stopAlerts(): void {
  window.clearInterval(timer);
  timer = undefined;
  upcoming = [];
  loadedAt = 0;
}

/** Reloads before the next check, e.g. after adding or moving an event. */
export function refreshAlerts(): void {
  loadedAt = 0;
}

async function check(): Promise<void> {
  const now = Date.now();
  if (now - loadedAt > RELOAD_EVERY_MS) {
    try {
      const today = startOfDay(new Date());
      upcoming = (await getAgenda(toDateString(today), toDateString(addDays(today, 2)))).items;
      loadedAt = now;
    } catch {
      // Keep the last list; try again next time.
    }
  }
  const from = Math.max(lastCheck, now - LATEST_MS);
  lastCheck = now;

  for (const item of upcoming) {
    if (item.allDay || item.kind !== "event") continue;
    const start = new Date(item.start);
    for (const minutes of item.reminders) {
      const at = start.getTime() - minutes * MS_PER_MINUTE;
      const key = `${item.id}|${item.start}|${minutes}`;
      if (at <= from || at > now || sent.has(key)) continue;
      sent.add(key);
      sendNotification({ title: item.title, body: alertText(item, start, minutes) });
    }
  }
}

/** "In 10 min · 2:00 PM · Room 4", or "Now · 2:00 PM". */
function alertText(item: AgendaItem, start: Date, minutes: number): string {
  const when = minutes === 0 ? "Now" : minutes < 60 ? `In ${minutes} min` : `In ${formatHours(minutes)}`;
  return [when, timeFormat.format(start), item.location].filter(Boolean).join(" · ");
}

function formatHours(minutes: number): string {
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? "1 day" : `${minutes / (24 * 60)} days`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h${rest ? ` ${rest} min` : ""}`;
}
