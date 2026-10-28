import { authStatus, errorMessage, getAgenda, isNotSignedIn, signIn, signOut } from "./api";
import { renderAgenda } from "./agenda";

const DAYS = 14;
const REFRESH_EVERY_MS = 5 * 60 * 1000;

const app = document.querySelector<HTMLElement>("#app")!;
const actions = document.querySelector<HTMLElement>("#actions")!;
const account = document.querySelector<HTMLElement>("#account")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const signOutButton = document.querySelector<HTMLButtonElement>("#sign-out")!;

let refreshTimer: number | undefined;

function message(className: string, text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function showSignedOut(error?: string): void {
  window.clearInterval(refreshTimer);
  actions.hidden = true;
  account.textContent = "";

  const view = document.createElement("div");
  view.className = "sign-in";
  view.append(message("sign-in-text", "Connect your Google account to see your upcoming events."));
  if (error) view.append(message("error", error));

  const button = document.createElement("button");
  button.className = "primary-button";
  button.textContent = "Sign in with Google";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Continue in your browser…";
    try {
      await signIn();
      await showAgenda();
    } catch (e) {
      showSignedOut(errorMessage(e));
    }
  });
  view.append(button);
  app.replaceChildren(view);
}

async function loadAgenda(): Promise<void> {
  refreshButton.disabled = true;
  try {
    const agenda = await getAgenda(DAYS);
    account.textContent = agenda.account ?? "";
    renderAgenda(app, agenda, DAYS);
  } catch (e) {
    if (isNotSignedIn(e)) {
      showSignedOut("Your Google session ended. Please sign in again.");
    } else {
      app.replaceChildren(message("error", errorMessage(e)));
    }
  } finally {
    refreshButton.disabled = false;
  }
}

async function showAgenda(): Promise<void> {
  actions.hidden = false;
  app.replaceChildren(message("empty", "Loading…"));
  await loadAgenda();
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(loadAgenda, REFRESH_EVERY_MS);
}

refreshButton.addEventListener("click", loadAgenda);
signOutButton.addEventListener("click", async () => {
  await signOut().catch(() => {});
  showSignedOut();
});

authStatus()
  .then((signedIn) => (signedIn ? showAgenda() : showSignedOut()))
  .catch((e) => showSignedOut(errorMessage(e)));
