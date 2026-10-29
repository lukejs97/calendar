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

/**
 * A small menu at (x, y), e.g. on right-click: one button per item. It closes
 * when one is chosen, or on a click elsewhere, Esc, scrolling or resizing.
 */
export function showMenu(x: number, y: number, items: [string, () => void][]): void {
  document.querySelector(".context-menu")?.remove();
  const menu = el("div", "context-menu");
  menu.role = "menu";
  const close = () => {
    menu.remove();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("keydown", escape, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("scroll", close, true);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  for (const [label, run] of items) {
    const item = el("button", "context-menu-item", label);
    item.role = "menuitem";
    item.addEventListener("click", () => {
      close();
      run();
    });
    menu.append(item);
  }
  document.body.append(menu);
  // Keep it on screen.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
  menu.querySelector<HTMLButtonElement>("button")?.focus();
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("keydown", escape, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  document.addEventListener("scroll", close, true);
}
