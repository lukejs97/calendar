// Settings kept on this device (in the web view's local storage), such as how
// many days the multi-day view shows. A phone and a Mac can differ.

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
