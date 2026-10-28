// Keeps the main window and the menu bar window in step: when one changes an
// event or task, the other reloads.
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const CHANGED = "agenda-changed";

const thisWindow = () => getCurrentWebviewWindow().label;

/** Tells the other window that events or tasks changed here. */
export function announceChange(): void {
  if (isTauri()) void emit(CHANGED, thisWindow());
}

/** Runs `reload` when events or tasks change in the other window. */
export function onChangeElsewhere(reload: () => void): void {
  if (!isTauri()) return;
  void listen<string>(CHANGED, (event) => {
    if (event.payload !== thisWindow()) reload();
  });
}
