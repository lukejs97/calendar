//! Desktop only: pop-up alerts before events start, at the reminder times set
//! on each event in Google Calendar (or its calendar's defaults). They come
//! from this side, not the web page, so they keep coming while the app sits in
//! the menu bar with its window closed. The same loop keeps the next event's
//! name beside the menu bar icon up to date.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Local, TimeDelta};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

use crate::AppState;
use crate::agenda::{self, AgendaItem, ItemKind};
use crate::cache::AgendaCache;
use crate::{desktop, prefs};

const CHECK_EVERY: Duration = Duration::from_secs(30);
const RELOAD_EVERY: TimeDelta = TimeDelta::minutes(5);
/// Alerts more than this late are skipped, so waking a laptop that slept
/// through the morning doesn't deliver a pile of them at once.
const LATEST: TimeDelta = TimeDelta::minutes(2);

/// Set when events change in the app, to reload before the next check.
static STALE: AtomicBool = AtomicBool::new(false);
/// Wakes the loop early, e.g. after a settings change.
static WAKE: OnceLock<Notify> = OnceLock::new();

fn wake() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// Reloads and checks again now, e.g. after adding or moving an event.
pub fn refresh() {
    STALE.store(true, Ordering::Relaxed);
    wake().notify_one();
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
        // Driving times, by event: minutes (if known) and when asked.
        let mut travel: HashMap<String, (Option<u32>, DateTime<Local>)> = HashMap::new();
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
            let prefs = prefs::get();
            if prefs.time_to_leave {
                time_to_leave(&app, &upcoming, now, &mut travel, &mut sent).await;
            }
            let next = if prefs.menu_bar_next { menu_bar_text(&upcoming, now) } else { None };
            desktop::set_menu_bar_text(&app, next);
            tokio::select! {
                _ = tokio::time::sleep(CHECK_EVERY) => {}
                _ = wake().notified() => {}
            }
        }
    });
}

/// Time to leave: for events in the next 3 hours at a real place, an alert
/// when it's time to set off (the driving time from here, plus 5 minutes).
/// Mac only: it needs the Mac's location and Apple Maps (travel.rs).
#[cfg(target_os = "macos")]
async fn time_to_leave(
    app: &AppHandle,
    items: &[AgendaItem],
    now: DateTime<Local>,
    travel: &mut HashMap<String, (Option<u32>, DateTime<Local>)>,
    sent: &mut HashSet<String>,
) {
    use crate::travel;
    const LOOK_AHEAD: TimeDelta = TimeDelta::hours(3);
    const SPARE: TimeDelta = TimeDelta::minutes(5);
    const ASK_AGAIN: TimeDelta = TimeDelta::minutes(10);

    travel.retain(|_, (_, asked)| now - *asked < TimeDelta::hours(6));
    for item in items.iter().filter(|item| item.kind == ItemKind::Event && !item.all_day) {
        let Some(place) = item.location.as_deref().filter(|place| travel::is_physical(place)) else { continue };
        let Ok(start) = DateTime::parse_from_rfc3339(&item.start) else { continue };
        let start = start.with_timezone(&Local);
        if start <= now || start - now > LOOK_AHEAD {
            continue;
        }
        let key = format!("leave|{}|{}", item.id, item.start);
        if sent.contains(&key) {
            continue;
        }
        let minutes = match travel.get(&key) {
            Some((minutes, asked)) if now - *asked < ASK_AGAIN => *minutes,
            _ => {
                let minutes = travel::driving_minutes(app, place.to_string(), start).await;
                travel.insert(key.clone(), (minutes, now));
                minutes
            }
        };
        // Unknown, or you're as good as there already.
        let Some(minutes) = minutes.filter(|m| *m >= 3) else { continue };
        if start - TimeDelta::minutes(minutes.into()) - SPARE <= now {
            sent.insert(key);
            let body = format!("{minutes} min drive · starts {} · {place}", start.format("%-I:%M %p"));
            let _ = app.notification().builder().title(format!("Time to leave for {}", item.title)).body(body).show();
        }
    }
}

#[cfg(not(target_os = "macos"))]
async fn time_to_leave(
    _app: &AppHandle,
    _items: &[AgendaItem],
    _now: DateTime<Local>,
    _travel: &mut HashMap<String, (Option<u32>, DateTime<Local>)>,
    _sent: &mut HashSet<String>,
) {
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

/// Beside the menu bar icon: what's next ("Standup in 12 min", "Lunch at
/// 1:00 PM", "○ Pay rent in 5 min" for a task), or, while an event is on and
/// nothing else starts before it ends, that one ("Work until 5:00 PM").
/// `None` when nothing's on or coming up in the next 12 hours.
///
/// What starts next wins over what's on: you know you're at work, but not
/// that a call's coming up during it.
fn menu_bar_text(items: &[AgendaItem], now: DateTime<Local>) -> Option<String> {
    let times = |item: &AgendaItem| {
        let start = DateTime::parse_from_rfc3339(&item.start).ok()?.with_timezone(&Local);
        let end = item.end.as_deref().and_then(|end| DateTime::parse_from_rfc3339(end).ok());
        Some((start, end.map_or(start, |end| end.with_timezone(&Local))))
    };
    // Events and tasks at a time of day (not all-day ones, or tasks done).
    let timed = items
        .iter()
        .filter(|item| !item.all_day && !item.completed)
        .filter_map(|item| Some((item, times(item)?)));
    let next = timed
        .clone()
        .filter(|(_, (start, _))| *start > now && *start - now <= TimeDelta::hours(12))
        .min_by_key(|(_, (start, _))| *start);
    let ongoing = timed
        .filter(|(item, (start, end))| item.kind == ItemKind::Event && *start <= now && *end > now)
        .min_by_key(|(_, (_, end))| *end);

    let clock = |t: DateTime<Local>| t.format("%-I:%M %p").to_string();
    let name = |item: &AgendaItem| match item.kind {
        ItemKind::Task => format!("○ {}", short(&item.title)),
        ItemKind::Event => short(&item.title),
    };
    match (next, ongoing) {
        // On now, and nothing else starts before it ends: this one.
        (next, Some((item, (_, end)))) if next.is_none_or(|(_, (start, _))| start >= end) => {
            Some(format!("{} until {}", name(item), clock(end)))
        }
        (Some((item, (start, _))), _) => {
            // Rounded up: "in 1 min" until it starts, never "in 0 min".
            let minutes = ((start - now).num_seconds() + 59) / 60;
            Some(match minutes {
                0 => format!("{} now", name(item)),
                1..60 => format!("{} in {minutes} min", name(item)),
                _ => format!("{} at {}", name(item), clock(start)),
            })
        }
        _ => None,
    }
}

/// A title short enough for the menu bar.
fn short(title: &str) -> String {
    const MAX: usize = 22;
    let title = title.trim();
    if title.chars().count() <= MAX {
        return title.to_string();
    }
    let cut: String = title.chars().take(MAX - 1).collect();
    format!("{}…", cut.trim_end())
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
    fn the_menu_bar_shows_whats_next_or_on_now() {
        let now = Local::now();
        let at = |minutes: i64| now + TimeDelta::minutes(minutes);
        let event = |title: &str, start: i64, end: i64| AgendaItem {
            title: title.into(),
            end: Some(at(end).to_rfc3339()),
            ..event(at(start), vec![])
        };
        assert_eq!(menu_bar_text(&[event("Standup", 12, 27)], now).unwrap(), "Standup in 12 min");
        assert!(menu_bar_text(&[event("Lunch", 90, 150)], now).unwrap().starts_with("Lunch at "));
        // On now, and the next one starts after it ends: the one that's on.
        let busy = [event("Workshop", -30, 60), event("Lunch", 90, 150)];
        assert!(menu_bar_text(&busy, now).unwrap().starts_with("Workshop until "));
        // ...but one starting before it ends takes over.
        let soon = [event("Workshop", -30, 60), event("Call with a very long name indeed", 10, 40)];
        assert_eq!(menu_bar_text(&soon, now).unwrap(), "Call with a very long… in 10 min");
        // Tasks at a time count too, marked as tasks; done ones don't.
        let task = |title: &str, start: i64, completed: bool| AgendaItem {
            kind: ItemKind::Task,
            end: None,
            completed,
            ..event(title, start, start)
        };
        let work = [event("Work", -60, 480), task("Test", 120, false)];
        assert!(menu_bar_text(&work, now).unwrap().starts_with("○ Test at "));
        let done = [event("Work", -60, 480), task("Test", 120, true)];
        assert!(menu_bar_text(&done, now).unwrap().starts_with("Work until "));
        assert!(menu_bar_text(&[event("Tomorrow", 60 * 20, 60 * 21)], now).is_none());
    }

    #[test]
    fn longer_alerts_read_in_hours_and_days() {
        assert_eq!(format_hours(60), "1 h");
        assert_eq!(format_hours(90), "1 h 30 min");
        assert_eq!(format_hours(24 * 60), "1 day");
        assert_eq!(format_hours(2 * 24 * 60), "2 days");
    }
}
