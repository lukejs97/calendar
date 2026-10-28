/// <reference types="vite/client" />

interface Window {
  /** Set in the menu bar window (see src-tauri/src/desktop.rs). */
  __MINUTEMAN_FLYOUT__?: boolean;
}
