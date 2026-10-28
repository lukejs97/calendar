//! Desktop only: pop-up alerts before events start, at the reminder times set
//! on each event in Google Calendar (or its calendar's defaults). They come
//! from this side, not the web page, so they keep coming while the app sits in
//! the menu bar with its window closed.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Local, TimeDelta};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::AppState;
use crate::agenda::{self, AgendaItem, ItemKind};
use crate::cache::AgendaCache;

const CHECK_EVERY: Duration = Duration::from_secs(30);
const RELOAD_EVERY: TimeDelta = TimeDelta::minutes(5);
/// Alerts more than this late are skipped, so waking a laptop that slept
/// through the morning doesn't deliver a pile of them at once.
const LATEST: TimeDelta = TimeDelta::minutes(2);

/// Set when events change in the app, to reload before the next check.
static STALE: AtomicBool = AtomicBool::new(false);

/// Reloads before the next check, e.g. after adding or moving an event.
pub fn refresh() {
    STALE.store(true, Ordering::Relaxed);
}

/// Checks for due alerts every 30 seconds for as long as the app runs.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Today's and tomorrow's items.
        let mut upcoming: Vec<AgendaItem> = Vec::new();
        let mut loaded_at: Option<DateTime<Local>> = None;
        let mut last_check = Local::now();
        // Alerts already shown: item, its start, and minutes before.
        let mut sent = HashSet::new();
        loop {
            let now = Local::now();
            let stale = STALE.swap(false, Ordering::Relaxed);
            if (stale || loaded_at.is_none_or(|at| now - at > RELOAD_EVERY))
                && let Some(items) = load(&app).await
            {
                upcoming = items;
                loaded_at = Some(now);
            }
            let from = last_check.max(now - LATEST);
            last_check = now;
            for (key, title, body) in due(&upcoming, from, now) {
                if sent.insert(key) {
                    let _ = app.notification().builder().title(title).body(body).show();
                }
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Today's and tomorrow's items: fetched if possible (and saved for offline
/// use), otherwise as saved last time. `None` if neither works, e.g. signed out.
async fn load(app: &AppHandle) -> Option<Vec<AgendaItem>> {
    let (state, cache) = (app.state::<AppState>(), app.state::<AgendaCache>());
    let today = Local::now().date_naive();
    let to = today + TimeDelta::days(2);
    match agenda::load(&state.http, &state.google_auth, today, to).await {
        Ok(agenda) => {
            cache.store(today, to, &agenda.loaded, &agenda.items);
            Some(agenda.items)
        }
        Err(_) => cache.between(today, to).map(|(items, _)| items),
    }
}

/// The alerts due after `from`, up to and including `now`: a key to show each
/// once, the title, and the text.
fn due(items: &[AgendaItem], from: DateTime<Local>, now: DateTime<Local>) -> Vec<(String, String, String)> {
    let mut alerts = Vec::new();
    for item in items {
        if item.all_day || item.kind != ItemKind::Event {
            continue;
        }
        let Ok(start) = DateTime::parse_from_rfc3339(&item.start) else { continue };
        let start = start.with_timezone(&Local);
        for &minutes in &item.reminders {
            let at = start - TimeDelta::minutes(minutes.into());
            if at > from && at <= now {
                let key = format!("{}|{}|{minutes}", item.id, item.start);
                alerts.push((key, item.title.clone(), alert_text(item, start, minutes)));
            }
        }
    }
    alerts
}

/// "In 10 min · 2:00 PM · Room 4", or "Now · 2:00 PM".
fn alert_text(item: &AgendaItem, start: DateTime<Local>, minutes: u32) -> String {
    let when = match minutes {
        0 => "Now".to_string(),
        1..60 => format!("In {minutes} min"),
        _ => format!("In {}", format_hours(minutes)),
    };
    let time = start.format("%-I:%M %p").to_string();
    [Some(when), Some(time), item.location.clone()].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

fn format_hours(minutes: u32) -> String {
    const DAY: u32 = 24 * 60;
    if minutes.is_multiple_of(DAY) {
        return if minutes == DAY { "1 day".into() } else { format!("{} days", minutes / DAY) };
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 { format!("{hours} h") } else { format!("{hours} h {rest} min") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenda::Source;

    fn event(start: DateTime<Local>, reminders: Vec<u32>) -> AgendaItem {
        AgendaItem {
            id: "google:cal:1".into(),
            source: Source::Google,
            kind: ItemKind::Event,
            title: "Standup".into(),
            start: start.to_rfc3339(),
            end: None,
            all_day: false,
            location: Some("Room 4".into()),
            color: None,
            list_name: "Work".into(),
            url: None,
            completed: false,
            overdue: false,
            priority: None,
            account: None,
            list_id: None,
            source_id: None,
            series_id: None,
            editable: false,
            recurring: false,
            description: None,
            attendees: Vec::new(),
            conference_url: None,
            reminders,
        }
    }

    #[test]
    fn alerts_fall_due_once_in_their_window() {
        let now = Local::now();
        let items = [event(now + TimeDelta::minutes(10), vec![10, 30, 0])];
        let alerts = due(&items, now - TimeDelta::seconds(30), now);
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].2.starts_with("In 10 min · "));
        assert!(alerts[0].2.ends_with(" · Room 4"));
        // The 30-minute one was due 20 minutes ago, before this window.
        assert!(due(&items, now, now + TimeDelta::seconds(30)).is_empty());
    }

    #[test]
    fn longer_alerts_read_in_hours_and_days() {
        assert_eq!(format_hours(60), "1 h");
        assert_eq!(format_hours(90), "1 h 30 min");
        assert_eq!(format_hours(24 * 60), "1 day");
        assert_eq!(format_hours(2 * 24 * 60), "2 days");
    }
}
