//! Read access to Google Calendar API v3: the user's calendar list, and the
//! events on each calendar within a time range.

use chrono::{DateTime, Local};
use futures::future::join_all;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use url::Url;

use crate::agenda::{AgendaItem, ItemKind, Source};
use crate::error::{AppError, Result};

const API: &str = "https://www.googleapis.com/calendar/v3";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListEntry {
    id: String,
    summary: Option<String>,
    /// The name the user gave a calendar someone else shares with them.
    summary_override: Option<String>,
    background_color: Option<String>,
    #[serde(default)]
    primary: bool,
}

impl CalendarListEntry {
    fn name(&self) -> String {
        self.summary_override.clone().or_else(|| self.summary.clone()).unwrap_or_else(|| self.id.clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    status: Option<String>,
    summary: Option<String>,
    location: Option<String>,
    html_link: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    #[serde(default)]
    attendees: Vec<Attendee>,
    event_type: Option<String>,
}

/// Exactly one of these is set: `date` ("2026-10-27") for all-day events,
/// `date_time` (RFC 3339, "2026-10-27T09:00:00-07:00") for timed ones.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventTime {
    date: Option<String>,
    date_time: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attendee {
    #[serde(rename = "self", default)]
    is_self: bool,
    response_status: Option<String>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: ApiErrorDetail,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: String,
}

pub struct CalendarEvents {
    /// The primary calendar's ID, which is the account's email address.
    pub account: Option<String>,
    pub items: Vec<AgendaItem>,
    /// Calendars that failed to load; the rest are still shown.
    pub warnings: Vec<String>,
}

/// Events from every calendar in the user's list between `from` and `to`.
pub async fn events_between(
    http: &reqwest::Client,
    token: &str,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> Result<CalendarEvents> {
    let calendars = list_calendars(http, token).await?;
    let account = calendars.iter().find(|c| c.primary).map(|c| c.id.clone());

    // Fetch all calendars at the same time rather than one after another.
    let results =
        join_all(calendars.iter().map(|cal| list_events(http, token, &cal.id, from, to))).await;

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for (calendar, result) in calendars.iter().zip(results) {
        match result {
            Ok(events) => items.extend(events.into_iter().filter_map(|e| to_agenda_item(calendar, e))),
            Err(e) => warnings.push(format!("{}: {e}", calendar.name())),
        }
    }
    Ok(CalendarEvents { account, items, warnings })
}

async fn list_calendars(http: &reqwest::Client, token: &str) -> Result<Vec<CalendarListEntry>> {
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["users", "me", "calendarList"]);
    get_all_pages(http, token, url).await
}

async fn list_events(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> Result<Vec<Event>> {
    let mut url = Url::parse(API).expect("valid URL");
    // Calendar IDs contain characters like '#' that must be escaped in a URL path.
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events"]);
    url.query_pairs_mut()
        .append_pair("timeMin", &from.to_rfc3339())
        .append_pair("timeMax", &to.to_rfc3339())
        // Expand recurring events into their individual occurrences.
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", "250");
    get_all_pages(http, token, url).await
}

/// Google returns long lists in pages; keep asking for the next page until
/// there isn't one.
async fn get_all_pages<T: DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    url: Url,
) -> Result<Vec<T>> {
    let mut all = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut page_url = url.clone();
        if let Some(t) = &page_token {
            page_url.query_pairs_mut().append_pair("pageToken", t);
        }
        let page: Page<T> = get_json(http, token, page_url).await?;
        all.extend(page.items);
        match page.next_page_token {
            Some(next) => page_token = Some(next),
            None => return Ok(all),
        }
    }
}

async fn get_json<T: DeserializeOwned>(http: &reqwest::Client, token: &str, url: Url) -> Result<T> {
    let response = http.get(url).bearer_auth(token).send().await?;
    let status = response.status();
    if status.is_success() {
        return Ok(response.json().await?);
    }
    let message = match response.json::<ApiErrorBody>().await {
        Ok(body) => body.error.message,
        Err(_) => status.canonical_reason().unwrap_or("unknown error").to_string(),
    };
    Err(AppError::Api { status: status.as_u16(), message })
}

fn to_agenda_item(calendar: &CalendarListEntry, event: Event) -> Option<AgendaItem> {
    if event.status.as_deref() == Some("cancelled") {
        return None;
    }
    // "Working from home/office" markers clutter an agenda.
    if event.event_type.as_deref() == Some("workingLocation") {
        return None;
    }
    let declined = event
        .attendees
        .iter()
        .any(|a| a.is_self && a.response_status.as_deref() == Some("declined"));
    if declined {
        return None;
    }

    let start = event.start?;
    let (start, all_day) = match (start.date_time, start.date) {
        (Some(date_time), _) => (date_time, false),
        (None, Some(date)) => (date, true),
        (None, None) => return None,
    };
    let end = event.end.and_then(|e| e.date_time.or(e.date));

    Some(AgendaItem {
        id: format!("google:{}:{}", calendar.id, event.id),
        source: Source::Google,
        kind: ItemKind::Event,
        title: event.summary.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "(No title)".into()),
        start,
        end,
        all_day,
        location: event.location.filter(|s| !s.trim().is_empty()),
        color: calendar.background_color.clone(),
        list_name: calendar.name(),
        url: event.html_link,
        completed: false,
        overdue: false,
        priority: None,
    })
}
