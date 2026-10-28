import type { AgendaItem } from "./api";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Colors an element (via the --item-color CSS variable) with its item's calendar color. */
export function setItemColor(node: HTMLElement, item: AgendaItem): void {
  node.style.setProperty("--item-color", item.color ?? "var(--accent)");
}

/**
 * Sets up a task's look: its checkbox (inserted first in `node`), struck
 * through when done, and an "overdue" style. Does nothing for events.
 */
export function decorateTask(node: HTMLElement, item: AgendaItem, onToggle: (item: AgendaItem) => void): void {
  if (item.kind !== "task") return;
  node.classList.add("task");
  if (item.completed) node.classList.add("completed");
  if (item.overdue) node.classList.add("overdue");

  const check = el("button", "task-check");
  check.role = "checkbox";
  check.setAttribute("aria-checked", String(item.completed));
  check.setAttribute("aria-label", item.completed ? `Mark "${item.title}" not done` : `Complete "${item.title}"`);
  check.title = item.completed ? "Mark as not done" : "Complete";
  if (item.priority) check.dataset.priority = String(item.priority);
  check.addEventListener("click", (e) => {
    e.stopPropagation(); // don't also open the task in Todoist
    onToggle(item);
  });
  node.prepend(check);
}

/** Shows the item's details (`open`) on click or Enter. */
export function makeOpenable(node: HTMLElement, item: AgendaItem, open: (item: AgendaItem) => void): void {
  node.title = item.title;
  node.tabIndex = 0;
  node.role = "button";
  node.addEventListener("click", (e) => {
    e.stopPropagation();
    // The click that ends dragging an event isn't a request to open it.
    if (!node.classList.contains("dragging")) open(item);
  });
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") open(item);
  });
}
