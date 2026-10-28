//! The agenda: one sorted list of things happening, whatever service they came
//! from: Google Calendar events and Todoist tasks. The UI (main window and the
//! future tray flyout) only ever deals with `AgendaItem`.

use chrono::{DateTime, Local, NaiveDate};
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::google::{self, auth::GoogleAuth};
use crate::{secrets, todoist};

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Google,
    Todoist,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Event,
    Task,
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
    /// Calendar name, or Todoist project name.
    pub list_name: String,
    /// Where to open the item in its own web app.
    pub url: Option<String>,
    /// Tasks only.
    pub completed: bool,
    /// Tasks only: due before today, and shown on today instead.
    pub overdue: bool,
    /// Tasks only: 1 (most urgent) to 4, as numbered in the Todoist app.
    pub priority: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    pub account: Option<String>,
    pub items: Vec<AgendaItem>,
    pub warnings: Vec<String>,
}

/// Longest range one request may cover. A year view needs 366 days.
const MAX_RANGE_DAYS: i64 = 400;

/// Everything from local midnight on `from` up to (not including) local
/// midnight on `to`.
pub async fn load(
    http: &reqwest::Client,
    google_auth: &GoogleAuth,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Agenda> {
    let days = (to - from).num_days();
    if !(1..=MAX_RANGE_DAYS).contains(&days) {
        return Err(AppError::InvalidInput(format!(
            "date range must be 1 to {MAX_RANGE_DAYS} days long, got {days}"
        )));
    }

    let todoist_token = secrets::get(secrets::TODOIST_TOKEN)?;

    // Fetch from Google and Todoist at the same time.
    let google = async {
        let token = google_auth.access_token().await?;
        google::calendar::events_between(http, &token, local_midnight(from), local_midnight(to)).await
    };
    let tasks = async {
        match &todoist_token {
            Some(token) => Some(todoist::tasks_between(http, token, from, to).await),
            None => None,
        }
    };
    let (google, tasks) = tokio::join!(google, tasks);
    let google = google?;

    let mut items = google.items;
    let mut warnings = google.warnings;
    match tasks {
        Some(Ok(tasks)) => items.extend(tasks),
        // A Todoist problem shouldn't hide your calendar; show it as a warning.
        Some(Err(e)) => warnings.push(format!("Todoist: {e}")),
        None => {}
    }

    items.sort_by_cached_key(|item| (start_timestamp(item), !item.all_day, item.title.clone()));
    Ok(Agenda { account: google.account, items, warnings })
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
