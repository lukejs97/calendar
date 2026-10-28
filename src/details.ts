// The details popup for an event or task: when and where, a button to join
// the video call, guests, and notes. Opens on click instead of the browser.
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgendaItem, Attendee } from "./api";
import { el, setItemColor } from "./dom";
import { describeTimes, itemEnd, itemStart } from "./time";

const RESPONSES: Record<string, string> = {
  accepted: "Going",
  declined: "Not going",
  tentative: "Maybe",
  needsAction: "Hasn't replied",
};

/** Opens the popup. `toggleTask` completes a task, or un-completes it. */
export function openDetails(item: AgendaItem, toggleTask: (item: AgendaItem) => void): void {
  const dialog = el("dialog", "dialog details");
  dialog.setAttribute("aria-labelledby", "details-title");
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  // Clicking the dimmed area outside closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  const title = el("h2", "details-title", item.title);
  title.id = "details-title";
  setItemColor(title, item);
  if (item.completed) title.classList.add("completed");

  const rows = el("div", "details-rows");
  let when = describeTimes(itemStart(item), itemEnd(item), item.allDay);
  if (item.kind === "task") when = item.overdue ? `Overdue · shown on ${when}` : `Due ${when}`;
  if (item.recurring) when += " · Repeats";
  rows.append(row("When", when));

  if (item.conferenceUrl) {
    const url = item.conferenceUrl;
    const join = el("button", "primary-button join-button", `Join ${callService(url)}`);
    join.addEventListener("click", () => openUrl(url));
    rows.append(row("Call", join));
  }
  if (item.location) {
    const place = el("span", undefined, item.location);
    const map = linkButton(isWebLink(item.location) ? "Open" : "Map", () =>
      openUrl(
        isWebLink(item.location!)
          ? item.location!
          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location!)}`,
      ),
    );
    const where = el("span");
    where.append(place, " ", map);
    rows.append(row("Where", where));
  }
  if (item.kind === "task") {
    const project = item.priority && item.priority < 4 ? `${item.listName} · P${item.priority}` : item.listName;
    rows.append(row("Project", project));
  } else {
    rows.append(row("Calendar", item.account ? `${item.listName} (${item.account})` : item.listName));
  }
  if (item.attendees.length > 0) rows.append(row("Guests", guestList(item.attendees)));
  if (item.description) {
    const notes = el("div", "details-notes");
    notes.append(...notesToNodes(item.description));
    rows.append(row("Notes", notes));
  }

  const buttons = el("div", "dialog-buttons");
  if (item.kind === "task") {
    const toggle = el("button", "text-button", item.completed ? "Mark not done" : "Complete");
    toggle.addEventListener("click", () => {
      dialog.close();
      toggleTask(item);
    });
    buttons.append(toggle);
  }
  if (item.url) {
    const url = item.url;
    const open = el("button", "text-button", item.source === "todoist" ? "Open in Todoist" : "Open in Google Calendar");
    open.addEventListener("click", () => openUrl(url));
    buttons.append(open);
  }
  const close = el("button", "primary-button", "Close");
  close.addEventListener("click", () => dialog.close());
  buttons.append(close);

  dialog.append(title, rows, buttons);
  dialog.showModal();
  close.focus();
}

function row(label: string, content: string | Node): HTMLElement {
  const node = el("div", "details-row");
  const value = el("div", "details-value");
  value.append(content);
  node.append(el("div", "details-label", label), value);
  return node;
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "link-button", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

const isWebLink = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

function callService(url: string): string {
  if (url.includes("meet.google.com")) return "Google Meet";
  if (url.includes("zoom.us")) return "Zoom";
  if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return "Teams";
  if (url.includes("webex.com")) return "Webex";
  return "call";
}

function guestList(attendees: Attendee[]): HTMLElement {
  const list = el("ul", "guest-list");
  // Organizer first, then everyone else in Google's order.
  const sorted = [...attendees].sort((a, b) => Number(b.organizer) - Number(a.organizer));
  for (const guest of sorted) {
    const name = guest.name ?? guest.email ?? "Unknown";
    const notes = [guest.isSelf ? "you" : "", guest.organizer ? "organizer" : ""].filter(Boolean);
    const li = el("li");
    li.append(el("span", undefined, notes.length ? `${name} (${notes.join(", ")})` : name));
    const response = guest.response ? RESPONSES[guest.response] : undefined;
    if (response) li.append(el("span", `guest-response ${guest.response}`, response));
    list.append(li);
  }
  return list;
}

/**
 * Turns notes into text and link buttons. Google's notes can be HTML; it's
 * parsed into a detached document (where nothing runs or loads) and only its
 * text and link addresses are kept, so no HTML from an event reaches the page.
 */
function notesToNodes(notes: string): Node[] {
  if (!/<[a-z][\s\S]*>/i.test(notes)) return linkify(notes);
  const doc = new DOMParser().parseFromString(notes, "text/html");
  const out: Node[] = [];
  const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "TR", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(...linkify(node.textContent ?? ""));
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      out.push(document.createTextNode("\n"));
      return;
    }
    const href = node.tagName === "A" ? node.getAttribute("href") : null;
    if (href && isWebLink(href)) {
      out.push(linkButton(node.textContent?.trim() || href, () => openUrl(href)));
      return;
    }
    if (BLOCKS.has(node.tagName)) out.push(document.createTextNode("\n"));
    node.childNodes.forEach(walk);
    if (BLOCKS.has(node.tagName)) out.push(document.createTextNode("\n"));
  };
  doc.body.childNodes.forEach(walk);
  return tidyLines(out);
}

/** Joins neighbouring text and drops the extra blank lines HTML leaves. */
function tidyLines(nodes: Node[]): Node[] {
  const merged: Node[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node instanceof Text && last instanceof Text) last.textContent += node.textContent ?? "";
    else merged.push(node);
  }
  merged.forEach((node, i) => {
    if (!(node instanceof Text)) return;
    let text = (node.textContent ?? "").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (i === 0) text = text.trimStart();
    if (i === merged.length - 1) text = text.trimEnd();
    node.textContent = text;
  });
  return merged;
}

/** Plain text, with web addresses turned into link buttons. */
function linkify(text: string): Node[] {
  return text
    .split(/(https?:\/\/[^\s<>"]+)/)
    .filter((part) => part !== "")
    .flatMap((part) => {
      if (!/^https?:\/\//.test(part)) return [document.createTextNode(part)];
      // "See https://example.com." – the full stop isn't part of the address.
      const url = part.replace(/[.,;:!?)]+$/, "");
      return [linkButton(url, () => openUrl(url)), document.createTextNode(part.slice(url.length))];
    });
}
