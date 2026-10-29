//! Settings the Rust side needs while no window is open (the menu bar's next
//! event, time-to-leave alerts, Apple Calendar and Reminders), kept in
//! `preferences.json` in the app's config folder. The window's own settings
//! (e.g. the multi-day view's days) stay in its local storage.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Show the next event's name and time beside the menu bar icon (macOS).
    pub menu_bar_next: bool,
    /// Alert when it's time to leave for events with a place (macOS).
    pub time_to_leave: bool,
    /// Show events from the Mac's Calendar app (EventKit).
    pub apple_calendar: bool,
    /// Show reminders from the Mac's Reminders app (EventKit).
    pub apple_reminders: bool,
    /// Apple calendars and reminder lists shown (true) or left out (false),
    /// by identifier, where chosen in Settings. Others follow apple.rs's
    /// default: shown, unless they look like a Google account's (already
    /// shown from Google directly).
    pub apple_calendars_shown: BTreeMap<String, bool>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            menu_bar_next: true,
            time_to_leave: false,
            apple_calendar: false,
            apple_reminders: false,
            apple_calendars_shown: BTreeMap::new(),
        }
    }
}

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static PREFS: Mutex<Option<Prefs>> = Mutex::new(None);

/// Reads the file at `path` once at startup; missing or unreadable means defaults.
pub fn init(path: Option<PathBuf>) {
    let prefs = path
        .as_ref()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    *PREFS.lock().expect("not poisoned") = Some(prefs);
    let _ = PATH.set(path);
}

pub fn get() -> Prefs {
    PREFS.lock().expect("not poisoned").clone().unwrap_or_default()
}

/// Saves `prefs` (best effort: if the file can't be written, they last until quit).
pub fn set(prefs: Prefs) {
    if let Some(Some(path)) = PATH.get()
        && let Ok(json) = serde_json::to_vec_pretty(&prefs)
    {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, json).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
    *PREFS.lock().expect("not poisoned") = Some(prefs);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_take_their_defaults() {
        let prefs: Prefs = serde_json::from_str(r#"{"timeToLeave": true}"#).unwrap();
        assert!(prefs.time_to_leave);
        assert!(prefs.menu_bar_next);
        assert!(!prefs.apple_calendar);
    }
}
