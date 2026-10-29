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
  locationAccess,
  setPreferences,
  type Access,
  type AppleStatus,
  type Preferences,
  removeGoogleAccount,
  signIn,
  todoistConnect,
  todoistDisconnect,
  todoistStatus,
} from "./api";
import { el } from "./dom";
import { DAY_COUNTS, multiDayCount, setMultiDayCount } from "./preferences";

const TOKEN_PAGE = "https://app.todoist.com/app/settings/integrations/developer";

export interface SettingsActions {
  /** After adding or removing a Google account; whether any is left. */
  accountsChanged(signedIn: boolean): void;
  /** After connecting or disconnecting Todoist. */
  todoistChanged(): void;
  /** After choosing how many days the multi-day view shows. */
  daysChanged(): void;
  /** After turning Apple Calendar or Reminders on or off, or choosing calendars. */
  sourcesChanged(): void;
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

  // Google accounts and Todoist open their own dialogs, in place of this one.
  const accountsNote = el("span", "settings-note", "…");
  const accounts = el("button", "pill-button", "Manage…");
  accounts.addEventListener("click", () => {
    dialog.close();
    void openAccountsSettings(actions.accountsChanged);
  });
  const todoistNote = el("span", "settings-note", "…");
  const todoist = el("button", "pill-button", "Set up…");
  todoist.addEventListener("click", () => {
    dialog.close();
    void openTodoistSettings(actions.todoistChanged);
  });

  const days = el("select", "text-input settings-select");
  days.setAttribute("aria-label", "Days in the multi-day view");
  days.append(...DAY_COUNTS.map((n) => new Option(`${n} days`, String(n))));
  days.value = String(multiDayCount());
  days.addEventListener("change", () => {
    setMultiDayCount(Number(days.value));
    actions.daysChanged();
  });

  const rows = el("div", "settings-rows");
  rows.append(
    settingsRow("Google accounts", accountsNote, accounts),
    settingsRow("Todoist", todoistNote, todoist),
    settingsRow("Multi-day view", el("span", "settings-note", "Days shown at once"), days),
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
  if ((isTauri() || desktopPreview) && !isPhone()) void addDesktopRows(rows, actions);

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
async function addDesktopRows(rows: HTMLElement, actions: SettingsActions): Promise<void> {
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
  choose.addEventListener("click", () => void openAppleCalendars(actions));
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

/** Choose which of the Calendar app's calendars and Reminders' lists to show. */
async function openAppleCalendars(actions: SettingsActions): Promise<void> {
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
  dialog.append(title, help, list, buttonRow(close));
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
export async function openAccountsSettings(onChange: (signedIn: boolean) => void): Promise<void> {
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
export async function openTodoistSettings(onChange: () => void): Promise<void> {
  const dialog = el("dialog", "dialog");
  dialog.setAttribute("aria-labelledby", "todoist-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const close = el("button", "text-button", "Close");
  close.type = "button"; // not "submit", which a button inside the form would be
  close.addEventListener("click", () => dialog.close());

  const title = el("h2", undefined, "Todoist");
  title.id = "todoist-title";

  if (await todoistStatus()) {
    const disconnect = el("button", "text-button danger", "Disconnect");
    disconnect.addEventListener("click", async () => {
      await todoistDisconnect();
      dialog.close();
      onChange();
    });
    dialog.append(
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
    dialog.append(title, help, form);
  }

  dialog.showModal();
}

function buttonRow(...buttons: HTMLElement[]): HTMLElement {
  const row = el("div", "dialog-buttons");
  row.append(...buttons);
  return row;
}
