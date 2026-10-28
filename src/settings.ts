// Settings, and the "Google accounts" and "Todoist" dialogs it opens.
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  errorMessage,
  googleAccounts,
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
}

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
