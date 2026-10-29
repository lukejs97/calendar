// Settings, and the "Google accounts" and "Todoist" dialogs it opens.
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  appleCalendars,
  appleRequestAccess,
  appleStatus,
  errorMessage,
  getPreferences,
  googleAccounts,
  googleCalendars,
  openAtLogin,
  setOpenAtLogin,
  locationAccess,
  setPreferences,
  type Access,
  type AppleStatus,
  type Preferences,
  removeGoogleAccount,
  setGoogleCalendarShown,
  signIn,
  todoistConnect,
  todoistDisconnect,
  todoistStatus,
} from "./api";
import { el } from "./dom";
import { DAY_COUNTS, multiDayCount, setMultiDayCount } from "./preferences";
import { locate, type Place, searchPlaces, setWeatherSettings, type Unit, weatherSettings } from "./weather";

const TOKEN_PAGE = "https://app.todoist.com/app/settings/integrations/developer";

export interface SettingsActions {
  /** After adding or removing a Google account; whether any is left. */
  accountsChanged(signedIn: boolean): void;
  /** After connecting or disconnecting Todoist. */
  todoistChanged(): void;
  /** After choosing how many days the multi-day view shows. */
  daysChanged(): void;
  /** After turning Apple Calendar or Reminders on or off, or choosing which calendars to show. */
  sourcesChanged(): void;
  /** After choosing the weather's place or unit, or turning it off. */
  weatherChanged(): void;
}

const isPhone = () => /iPhone|iPad|Android/.test(navigator.userAgent);
const isMac = () => /Macintosh|Mac OS X/.test(navigator.userAgent) && !isPhone();

/** Opens Settings: Google accounts, Todoist, and the multi-day view's days. */
export async function openSettings(actions: SettingsActions): Promise<void> {
  const dialog = el("dialog", "dialog settings");
  dialog.setAttribute("aria-labelledby", "settings-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  const title = el("h2", undefined, "Settings");
  title.id = "settings-title";
  /** Opens one of Settings' own screens in place of this one; it can come back here. */
  const openScreen = (open: (back: () => void) => unknown) => {
    // The new one first, so the dimmed background never drops in between.
    void open(() => void openSettings(actions));
    dialog.close();
  };

  // Google accounts and Todoist open their own dialogs, in place of this one.
  const accountsNote = el("span", "settings-note", "…");
  const accounts = el("button", "pill-button", "Manage…");
  accounts.addEventListener("click", () => {
    openScreen((back) => openAccountsSettings(actions.accountsChanged, back));
  });
  const calendars = el("button", "pill-button", "Choose…");
  calendars.addEventListener("click", () => {
    openScreen((back) => openGoogleCalendars(actions, back));
  });
  const todoistNote = el("span", "settings-note", "…");
  const todoist = el("button", "pill-button", "Set up…");
  todoist.addEventListener("click", () => {
    openScreen((back) => openTodoistSettings(actions.todoistChanged, back));
  });

  const days = el("select", "text-input settings-select");
  days.setAttribute("aria-label", "Days in the multi-day view");
  days.append(...DAY_COUNTS.map((n) => new Option(`${n} days`, String(n))));
  days.value = String(multiDayCount());
  days.addEventListener("change", () => {
    setMultiDayCount(Number(days.value));
    actions.daysChanged();
  });

  const weather = weatherSettings();
  const weatherButton = el("button", "pill-button", weather.place ? "Change…" : "Set up…");
  weatherButton.addEventListener("click", () => {
    openScreen((back) => openWeatherSettings(actions, back));
  });
  const weatherNote = el("span", "settings-note", weather.place ? weather.place.name : "Off");

  const rows = el("div", "settings-rows");
  rows.append(
    settingsRow("Google accounts", accountsNote, accounts),
    settingsRow("Calendars", el("span", "settings-note", "Which Google calendars to show"), calendars),
    settingsRow("Todoist", todoistNote, todoist),
    settingsRow("Multi-day view", el("span", "settings-note", "Days shown at once"), days),
    settingsRow("Weather", weatherNote, weatherButton),
  );
  // The website (web/): removing an account removes it for every device, so
  // there's also a sign-out that only affects this browser.
  if (!isTauri() && !import.meta.env.DEV) {
    const signOut = el("button", "pill-button", "Sign out");
    signOut.addEventListener("click", async () => (await import("./web-bridge")).signOutHere());
    rows.append(settingsRow("This browser", el("span", "settings-note", "Other devices stay signed in"), signOut));
  }

  // The desktop app: the menu bar, and on a Mac, Apple's apps and location.
  // (To preview them in a browser during `npm run dev`, add ?desktop.)
  const desktopPreview = import.meta.env.DEV && new URLSearchParams(location.search).has("desktop");
  if ((isTauri() || desktopPreview) && !isPhone()) void addDesktopRows(rows, actions, openScreen);

  const close = el("button", "primary-button", "Done");
  close.addEventListener("click", () => dialog.close());
  dialog.append(title, rows, buttonRow(close));
  dialog.showModal();

  const [emails, connected] = await Promise.all([
    googleAccounts().catch(() => null),
    todoistStatus().catch(() => null),
  ]);
  accountsNote.textContent =
    emails === null ? "" : emails.length === 1 ? emails[0] : `${emails.length} accounts`;
  todoistNote.textContent = connected === null ? "" : connected ? "Connected" : "Not connected";
  todoist.textContent = connected ? "Manage…" : "Set up…";
}

/** The desktop app's own rows, once its settings have loaded. */
async function addDesktopRows(
  rows: HTMLElement,
  actions: SettingsActions,
  openScreen: (open: (back: () => void) => unknown) => void,
): Promise<void> {
  let prefs: Preferences;
  try {
    prefs = await getPreferences();
  } catch {
    return; // an older Rust side: nothing to show
  }
  const save = async (change: Partial<Preferences>) => {
    prefs = { ...prefs, ...change };
    await setPreferences(prefs);
  };

  // Opening at login: it starts in the menu bar, its window closed.
  const atLogin = await openAtLogin().catch(() => null);
  if (atLogin !== null) {
    const loginNote = el("span", "settings-note", isMac() ? "Starts in the menu bar" : "Starts in the notification area");
    const login = toggle("Open at login", atLogin, async (on, box) => {
      try {
        await setOpenAtLogin(on);
      } catch (e) {
        box.checked = !on;
        loginNote.textContent = errorMessage(e);
      }
    });
    rows.append(settingsRow("Open at login", loginNote, login));
  }

  const menuBar = toggle("Show the next event in the menu bar", prefs.menuBarNext, (on) => save({ menuBarNext: on }));
  rows.append(
    settingsRow(
      "Menu bar",
      el("span", "settings-note", isMac() ? "Next event beside the icon" : "Next event in the icon's tooltip"),
      menuBar,
    ),
  );
  if (!isMac()) return;

  // Time to leave: needs the Mac's location.
  const leaveNote = el("span", "settings-note", "Alerts with Apple Maps driving time");
  const showLocation = (access: Access | null) => {
    if (access === "denied") leaveNote.textContent = "Allow location in System Settings → Privacy & Security";
  };
  const leave = toggle("Time to leave alerts", prefs.timeToLeave, async (on) => {
    await save({ timeToLeave: on });
    // macOS asks about location now; look again once you've answered.
    if (on) window.setTimeout(async () => showLocation(await locationAccess().catch(() => null)), 4000);
  });
  if (prefs.timeToLeave) showLocation(await locationAccess().catch(() => null));
  rows.append(settingsRow("Time to leave", leaveNote, leave));

  // Apple Calendar and Reminders.
  const status: AppleStatus | null = await appleStatus().catch(() => null);
  if (!status) return;
  const choose = el("button", "link-button", "Choose calendars…");
  choose.addEventListener("click", () => openScreen((back) => openAppleCalendars(actions, back)));
  const updateChoose = () => {
    choose.hidden = !(prefs.appleCalendar || prefs.appleReminders);
  };
  updateChoose();

  const appleRow = (name: string, kind: "calendar" | "reminders", key: "appleCalendar" | "appleReminders") => {
    const note = el("span", "settings-note", kind === "calendar" ? "Events from the Calendar app" : "Lists from the Reminders app");
    const denied = () => {
      note.textContent = `Allow ${kind === "calendar" ? "Calendars" : "Reminders"} in System Settings → Privacy & Security`;
    };
    if (status[kind] === "denied" && prefs[key]) denied();
    const control = toggle(name, prefs[key], async (on, box) => {
      if (on && status[kind] !== "granted") {
        status[kind] = await appleRequestAccess(kind).catch(() => "denied" as const);
        if (status[kind] !== "granted") {
          box.checked = false;
          return denied();
        }
      }
      await save({ [key]: on });
      updateChoose();
      actions.sourcesChanged();
    });
    return settingsRow(name, note, control);
  };
  rows.append(appleRow("Apple Calendar", "calendar", "appleCalendar"), appleRow("Apple Reminders", "reminders", "appleReminders"));
  const chooseRow = el("div", "settings-row settings-sub");
  chooseRow.append(choose);
  rows.append(chooseRow);
}

/** A switch (checkbox) that runs `changed` when flipped. */
function toggle(
  label: string,
  on: boolean,
  changed: (on: boolean, box: HTMLInputElement) => unknown,
): HTMLInputElement {
  const box = el("input", "settings-switch");
  box.type = "checkbox";
  box.checked = on;
  box.setAttribute("aria-label", label);
  box.addEventListener("change", () => void changed(box.checked, box));
  return box;
}

/** Choose the place to show the weather for (or turn it off), and °F or °C. */
function openWeatherSettings(actions: SettingsActions, back?: () => void): void {
  const dialog = el("dialog", "dialog settings");
  dialog.setAttribute("aria-labelledby", "weather-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  const title = el("h2", undefined, "Weather");
  title.id = "weather-title";
  let settings = weatherSettings();
  const save = (change: Partial<typeof settings>) => {
    settings = { ...settings, ...change };
    setWeatherSettings(settings);
    actions.weatherChanged();
    showCurrent();
  };

  const current = el("p");
  const off = el("button", "text-button danger", "Turn off");
  off.addEventListener("click", () => save({ place: null }));
  const showCurrent = () => {
    current.textContent = settings.place?.current
      ? "Showing the weather where you are."
      : settings.place
      ? `Showing the weather for ${settings.place.name}${settings.place.detail ? `, ${settings.place.detail}` : ""}.`
      : "Choose a place to show its weather on each day (from Open-Meteo).";
    off.hidden = !settings.place;
  };
  showCurrent();

  const unit = el("select", "text-input settings-select");
  unit.setAttribute("aria-label", "Temperature unit");
  unit.append(new Option("°F", "fahrenheit"), new Option("°C", "celsius"));
  unit.value = settings.unit;
  unit.addEventListener("change", () => save({ unit: unit.value as Unit }));

  const here = el("button", "pill-button weather-here", "Use current location");
  here.addEventListener("click", async () => {
    here.disabled = true;
    results.replaceChildren(el("p", "settings-note", "Finding where you are…"));
    try {
      save({ place: await locate() });
      results.replaceChildren();
    } catch (err) {
      results.replaceChildren(el("p", "error", errorMessage(err)));
    } finally {
      here.disabled = false;
    }
  });

  const search = el("input", "text-input");
  search.type = "search";
  search.placeholder = "Or a town or city";
  search.setAttribute("aria-label", "Town or city");
  const results = el("div", "settings-rows weather-places");
  const form = el("form", "weather-search");
  const find = el("button", "pill-button", "Search");
  form.append(search, find);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = search.value.trim();
    if (!name) return;
    find.disabled = true;
    results.replaceChildren(el("p", "settings-note", "Searching…"));
    try {
      const places = await searchPlaces(name);
      results.replaceChildren(...places.map((place) => placeRow(place)));
      if (places.length === 0) results.append(el("p", "settings-note", "No places found by that name."));
    } catch (err) {
      results.replaceChildren(el("p", "error", errorMessage(err)));
    } finally {
      find.disabled = false;
    }
  });
  const placeRow = (place: Place) => {
    const row = el("button", "settings-row weather-place");
    const text = el("div", "settings-text");
    text.append(el("span", "settings-name", place.name), el("span", "settings-note", place.detail));
    row.append(text);
    row.addEventListener("click", () => {
      save({ place });
      results.replaceChildren();
      search.value = "";
    });
    return row;
  };

  const close = el("button", "primary-button", "Done");
  close.addEventListener("click", () => dialog.close());
  const unitRow = el("div", "settings-rows");
  unitRow.append(settingsRow("Temperature", el("span", "settings-note", "Fahrenheit or Celsius"), unit));
  dialog.append(...backTo(dialog, back), title, current, here, form, results, unitRow, buttonRow(off, close));
  dialog.showModal();
  search.focus();
}

/** Choose which of each Google account's calendars to show. */
async function openGoogleCalendars(actions: SettingsActions, back?: () => void): Promise<void> {
  const dialog = el("dialog", "dialog settings");
  dialog.setAttribute("aria-labelledby", "google-calendars-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  const title = el("h2", undefined, "Calendars");
  title.id = "google-calendars-title";
  const help = el("p", undefined, "Hidden calendars' events don't appear, in views, search, alerts or the menu bar.");
  const list = el("div", "settings-rows");
  list.append(el("p", "settings-note", "Loading…"));
  const close = el("button", "primary-button", "Done");
  close.addEventListener("click", () => dialog.close());
  dialog.append(...backTo(dialog, back), title, help, list, buttonRow(close));
  dialog.showModal();

  try {
    const accounts = await googleCalendars();
    list.replaceChildren();
    for (const account of accounts) {
      list.append(el("h3", "settings-group", account.email));
      if (account.error) list.append(el("p", "error", account.error));
      for (const calendar of account.calendars) {
        const box = toggle(calendar.name, calendar.shown, async (on, input) => {
          try {
            await setGoogleCalendarShown(account.email, calendar.id, on);
            actions.sourcesChanged();
          } catch (e) {
            input.checked = !on;
            list.prepend(el("p", "error", errorMessage(e)));
          }
        });
        const name = el("span", "settings-name settings-calendar", calendar.name);
        if (calendar.color) name.style.setProperty("--item-color", calendar.color);
        const text = el("div", "settings-text");
        text.append(name);
        if (calendar.primary) text.append(el("span", "settings-note", "Main calendar"));
        const row = el("label", "settings-row");
        row.append(text, box);
        list.append(row);
      }
    }
    if (accounts.length === 0) list.append(el("p", "settings-note", "No Google accounts."));
  } catch (e) {
    list.replaceChildren(el("p", "error", errorMessage(e)));
  }
}

/** Choose which of the Calendar app's calendars and Reminders' lists to show. */
async function openAppleCalendars(actions: SettingsActions, back?: () => void): Promise<void> {
  const dialog = el("dialog", "dialog settings");
  dialog.setAttribute("aria-labelledby", "apple-calendars-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  const title = el("h2", undefined, "Apple calendars");
  title.id = "apple-calendars-title";
  const help = el(
    "p",
    undefined,
    "Calendars from your Google accounts start switched off here, as Minuteman already shows them from Google.",
  );
  const list = el("div", "settings-rows");
  const close = el("button", "primary-button", "Done");
  close.addEventListener("click", () => dialog.close());
  dialog.append(...backTo(dialog, back), title, help, list, buttonRow(close));
  dialog.showModal();

  try {
    const [calendars, prefs] = await Promise.all([appleCalendars(), getPreferences()]);
    for (const reminders of [false, true]) {
      const group = calendars.filter((c) => c.reminders === reminders);
      if (group.length === 0) continue;
      list.append(el("h3", "settings-group", reminders ? "Reminder lists" : "Calendars"));
      for (const calendar of group) {
        const box = toggle(calendar.title, calendar.shown, async (on) => {
          prefs.appleCalendarsShown[calendar.id] = on;
          await setPreferences(prefs);
          actions.sourcesChanged();
        });
        const name = el("span", "settings-name settings-calendar", calendar.title);
        name.style.setProperty("--item-color", calendar.color);
        const text = el("div", "settings-text");
        text.append(name, el("span", "settings-note", calendar.account));
        const row = el("label", "settings-row");
        row.append(text, box);
        list.append(row);
      }
    }
    if (calendars.length === 0) list.append(el("p", "settings-note", "No calendars: is access allowed in System Settings?"));
  } catch (e) {
    list.append(el("p", "error", errorMessage(e)));
  }
}

/** "‹ Settings", back to Settings from one of its screens (if opened from there). */
function backTo(dialog: HTMLDialogElement, back?: () => void): HTMLElement[] {
  if (!back) return [];
  const button = el("button", "text-button settings-back", "‹ Settings");
  button.addEventListener("click", () => {
    back(); // first, so the dimmed background stays
    dialog.close();
  });
  return [button];
}

function settingsRow(name: string, note: HTMLElement, control: HTMLElement): HTMLElement {
  const row = el("div", "settings-row");
  const text = el("div", "settings-text");
  text.append(el("span", "settings-name", name), note);
  row.append(text, control);
  return row;
}

/**
 * Opens the Google accounts dialog: add another account, or remove one.
 * `onChange` runs after either, saying whether any account is left.
 */
export async function openAccountsSettings(onChange: (signedIn: boolean) => void, back?: () => void): Promise<void> {
  const dialog = el("dialog", "dialog");
  dialog.setAttribute("aria-labelledby", "accounts-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const title = el("h2", undefined, "Google accounts");
  title.id = "accounts-title";
  const list = el("ul", "account-list");
  const error = el("p", "error");

  /** Lists the accounts; resolves to how many there are. */
  async function showAccounts(): Promise<number> {
    const accounts = await googleAccounts();
    list.replaceChildren(
      ...accounts.map((email) => {
        const remove = el("button", "text-button danger", "Remove");
        remove.setAttribute("aria-label", `Remove ${email}`);
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          error.textContent = "";
          try {
            await removeGoogleAccount(email);
            const left = await showAccounts();
            if (left === 0) dialog.close();
            onChange(left > 0);
          } catch (err) {
            error.textContent = errorMessage(err);
            remove.disabled = false;
          }
        });
        const row = el("li");
        row.append(el("span", "account-email", email), remove);
        return row;
      }),
    );
    return accounts.length;
  }

  const close = el("button", "text-button", "Close");
  close.addEventListener("click", () => dialog.close());

  const add = el("button", "primary-button", "Add account");
  add.addEventListener("click", async () => {
    add.disabled = true;
    add.textContent = "Continue in your browser…";
    error.textContent = "";
    try {
      await signIn();
      await showAccounts();
      onChange(true);
    } catch (err) {
      error.textContent = errorMessage(err);
    } finally {
      add.disabled = false;
      add.textContent = "Add account";
    }
  });

  dialog.append(
    ...backTo(dialog, back),
    title,
    el("p", undefined, "Events from all your accounts appear together. To add one, sign in to it in your browser."),
    list,
    error,
    buttonRow(close, add),
  );
  dialog.showModal();
  try {
    await showAccounts();
  } catch (err) {
    error.textContent = errorMessage(err);
  }
}

/**
 * Opens the Todoist dialog: connect with a personal API token, or disconnect.
 * `onChange` runs after either.
 */
export async function openTodoistSettings(onChange: () => void, back?: () => void): Promise<void> {
  const dialog = el("dialog", "dialog");
  dialog.setAttribute("aria-labelledby", "todoist-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const close = el("button", "text-button", "Close");
  close.type = "button"; // not "submit", which a button inside the form would be
  close.addEventListener("click", () => dialog.close());

  const title = el("h2", undefined, "Todoist");
  title.id = "todoist-title";

  // Open right away (filled in a moment), so the dimmed background doesn't drop.
  dialog.showModal();
  if (await todoistStatus()) {
    const disconnect = el("button", "text-button danger", "Disconnect");
    disconnect.addEventListener("click", async () => {
      await todoistDisconnect();
      dialog.close();
      onChange();
    });
    dialog.append(
      ...backTo(dialog, back),
      title,
      el("p", undefined, "Connected. Tasks with a due date appear in your calendar, and you can tick them off here."),
      buttonRow(disconnect, close),
    );
  } else {
    const help = el("p");
    const link = el("button", "link-button", "Settings → Integrations → Developer");
    link.addEventListener("click", () => openUrl(TOKEN_PAGE));
    help.append("Show your Todoist tasks alongside your events. Copy your API token from Todoist's ", link, " and paste it here. It's stored in your system's keychain.");

    const input = el("input", "text-input");
    input.type = "password";
    input.placeholder = "API token";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Todoist API token");

    const error = el("p", "error");
    const connect = el("button", "primary-button", "Connect");
    const form = el("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      connect.disabled = true;
      connect.textContent = "Checking…";
      error.textContent = "";
      try {
        await todoistConnect(input.value);
        dialog.close();
        onChange();
      } catch (err) {
        error.textContent = errorMessage(err);
        connect.disabled = false;
        connect.textContent = "Connect";
      }
    });
    form.append(input, error, buttonRow(close, connect));
    dialog.append(...backTo(dialog, back), title, help, form);
  }
}

function buttonRow(...buttons: HTMLElement[]): HTMLElement {
  const row = el("div", "dialog-buttons");
  row.append(...buttons);
  return row;
}
