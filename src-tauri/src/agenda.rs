//! The agenda: one sorted list of things happening, whatever service they came
//! from. Google Calendar events today; Todoist tasks join in Phase 2 as
//! `ItemKind::Task` items from `Source::Todoist`, so the UI (main window and
//! the future tray flyout) only ever deals with `AgendaItem`.

use chrono::{DateTime, Days, Local, NaiveDate};
use serde::Serialize;

use crate::error::Result;
use crate::google::{self, auth::GoogleAuth};

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Google,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Event,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaItem {
    /// Unique across sources, e.g. "google:<calendarId>:<eventId>".
    pub id: String,
    pub source: Source,
    pub kind: ItemKind,
    pub title: String,
    /// "YYYY-MM-DD" when `all_day`, otherwise an RFC 3339 timestamp.
    pub start: String,
    /// Same format as `start`. For all-day items this is the day *after* the
    /// last day (Google's convention).
    pub end: Option<String>,
    pub all_day: bool,
    pub location: Option<String>,
    /// CSS color, e.g. the calendar's color.
    pub color: Option<String>,
    /// Calendar name (or, later, Todoist project name).
    pub list_name: String,
    /// Where to open the item in its own web app.
    pub url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    pub account: Option<String>,
    pub items: Vec<AgendaItem>,
    pub warnings: Vec<String>,
}

/// Everything from the start of today through the next `days` days.
pub async fn load(http: &reqwest::Client, google_auth: &GoogleAuth, days: u32) -> Result<Agenda> {
    let today = Local::now().date_naive();
    let from = local_midnight(today);
    let to = local_midnight(today + Days::new(days.into()));

    let token = google_auth.access_token().await?;
    let google = google::calendar::upcoming(http, &token, from, to).await?;
    // Phase 2: fetch Todoist tasks for the same range and append them here.

    let mut items = google.items;
    items.sort_by_cached_key(|item| (start_timestamp(item), !item.all_day, item.title.clone()));
    Ok(Agenda { account: google.account, items, warnings: google.warnings })
}

/// Start time as a Unix timestamp; all-day items count as starting at local
/// midnight, and sort before timed items that start at the same moment.
fn start_timestamp(item: &AgendaItem) -> i64 {
    let parsed = if item.all_day {
        NaiveDate::parse_from_str(&item.start, "%Y-%m-%d").ok().map(|d| local_midnight(d).timestamp())
    } else {
        DateTime::parse_from_rfc3339(&item.start).ok().map(|d| d.timestamp())
    };
    parsed.unwrap_or(i64::MAX)
}

fn local_midnight(date: NaiveDate) -> DateTime<Local> {
    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    // `earliest` handles the rare zones where a DST change skips/repeats midnight.
    midnight
        .and_local_timezone(Local)
        .earliest()
        .unwrap_or_else(|| midnight.and_utc().with_timezone(&Local))
}
