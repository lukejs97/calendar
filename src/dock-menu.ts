// The phones' ☰ menu, in the floating buttons at the bottom of the calendar
// and of Contacts: a list of choices that opens upwards from the button.

/** Makes one line of the menu; a view can be ticked (`checked`) when it's on screen. */
export type MenuLine = (label: string, run: () => void, checked?: boolean) => HTMLButtonElement;

/**
 * Sets up `button` to open `menu` with what `lines` gives each time (so it
 * can tick what's on screen). A tap anywhere else, or Escape, closes it.
 * Returns a function that closes it.
 */
export function setUpDockMenu(
  button: HTMLButtonElement,
  menu: HTMLElement,
  lines: (line: MenuLine) => Node[],
): () => void {
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  const line: MenuLine = (label, run, checked) => {
    const item = document.createElement("button");
    item.className = "menu-item";
    item.setAttribute("role", checked === undefined ? "menuitem" : "menuitemradio");
    if (checked !== undefined) item.setAttribute("aria-checked", String(checked));
    const check = document.createElement("span");
    check.className = "menu-check";
    check.textContent = checked ? "✓" : "";
    const text = document.createElement("span");
    text.textContent = label;
    item.append(check, text);
    item.addEventListener("click", () => {
      close();
      run();
    });
    return item;
  };
  const open = () => {
    menu.replaceChildren(...lines(line));
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (menu.querySelector<HTMLButtonElement>("[aria-checked=true]") ?? menu.querySelector("button"))?.focus();
  };

  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !(e.target instanceof Node && menu.parentElement!.contains(e.target))) close();
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      close();
      button.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    } else return;
    e.preventDefault();
    e.stopPropagation(); // not the page's own arrow keys
  });
  return close;
}
