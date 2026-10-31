// Settings kept on this device (in the web view's local storage), such as how
// many days the multi-day view shows, and which map app opens a place. A
// phone and a Mac can differ.

const DAYS_KEY = "calendar.multiDayCount";
/** How many days the multi-day view can show at once. */
export const DAY_COUNTS = [2, 3, 4, 5, 6, 7];
const DEFAULT_DAYS = 3;

/** How many days the multi-day view shows. */
export function multiDayCount(): number {
  try {
    const saved = Number(localStorage.getItem(DAYS_KEY));
    if (DAY_COUNTS.includes(saved)) return saved;
  } catch {
    // Storage unavailable; use the default.
  }
  return DEFAULT_DAYS;
}

export function setMultiDayCount(days: number): void {
  try {
    localStorage.setItem(DAYS_KEY, String(days));
  } catch {
    // Then it lasts until the app closes, via the view on screen.
  }
}

const HOUR_HEIGHT_KEY = "calendar.hourHeight";
/** px per hour in the day, multi-day and week views; pinching changes it. */
export const MIN_HOUR_HEIGHT = 20;
export const MAX_HOUR_HEIGHT = 240;
const DEFAULT_HOUR_HEIGHT = 48;

export function hourHeight(): number {
  try {
    const saved = Number(localStorage.getItem(HOUR_HEIGHT_KEY));
    if (saved >= MIN_HOUR_HEIGHT && saved <= MAX_HOUR_HEIGHT) return saved;
  } catch {
    // Storage unavailable; use the default.
  }
  return DEFAULT_HOUR_HEIGHT;
}

export function setHourHeight(px: number): void {
  try {
    localStorage.setItem(HOUR_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // Then it lasts until the view is redrawn.
  }
}

const MAP_PROVIDER_KEY = "calendar.mapProvider";
/** Which app opens a place. Absent means Apple Maps on a phone, Google Maps on a computer. */
export type MapProvider = "apple" | "google";

/** The map app chosen in Settings, or null to follow this device. */
export function savedMapProvider(): MapProvider | null {
  try {
    const saved = localStorage.getItem(MAP_PROVIDER_KEY);
    if (saved === "apple" || saved === "google") return saved;
  } catch {
    // Storage unavailable; follow the device.
  }
  return null;
}

export function setMapProvider(provider: MapProvider | null): void {
  try {
    if (provider === null) localStorage.removeItem(MAP_PROVIDER_KEY);
    else localStorage.setItem(MAP_PROVIDER_KEY, provider);
  } catch {
    // Then the choice lasts until the app closes.
  }
}
