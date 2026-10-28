// The "Todoist" dialog: connect with a personal API token, or disconnect.
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, todoistConnect, todoistDisconnect, todoistStatus } from "./api";
import { el } from "./dom";

const TOKEN_PAGE = "https://app.todoist.com/app/settings/integrations/developer";

/** Opens the dialog. `onChange` runs after connecting or disconnecting. */
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
