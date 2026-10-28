//! Google Calendar API v3: the user's calendar list, the events on each
//! calendar within a time range, and adding events.

use chrono::{DateTime, Local, NaiveDate};
use futures::future::join_all;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::agenda::{AgendaItem, Attendee as Guest, ItemKind, Source};
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
    /// "owner", "writer", "reader" or "freeBusyReader".
    access_role: Option<String>,
    #[serde(default)]
    primary: bool,
    /// The calendar's reminders for events that don't set their own.
    #[serde(default)]
    default_reminders: Vec<Reminder>,
}

impl CalendarListEntry {
    fn name(&self) -> String {
        self.summary_override.clone().or_else(|| self.summary.clone()).unwrap_or_else(|| self.id.clone())
    }

    fn can_write(&self) -> bool {
        matches!(self.access_role.as_deref(), Some("owner" | "writer"))
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
    description: Option<String>,
    /// Google Meet link, on older events.
    hangout_link: Option<String>,
    conference_data: Option<ConferenceData>,
    reminders: Option<Reminders>,
    organizer: Option<Organizer>,
    #[serde(default)]
    guests_can_modify: bool,
    /// Set on each occurrence of a repeating event.
    recurring_event_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConferenceData {
    #[serde(default)]
    entry_points: Vec<EntryPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryPoint {
    /// "video", "phone", "sip" or "more".
    entry_point_type: Option<String>,
    uri: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reminders {
    #[serde(default)]
    use_default: bool,
    #[serde(default)]
    overrides: Vec<Reminder>,
}

#[derive(Deserialize)]
struct Reminder {
    /// "popup" or "email".
    method: Option<String>,
    minutes: Option<u32>,
}

#[derive(Deserialize)]
struct Organizer {
    #[serde(rename = "self", default)]
    is_self: bool,
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
    email: Option<String>,
    display_name: Option<String>,
    #[serde(default)]
    organizer: bool,
    /// Rooms and other resources, not people.
    #[serde(default)]
    resource: bool,
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
    pub items: Vec<AgendaItem>,
    /// Calendars that failed to load; the rest are still shown.
    pub warnings: Vec<String>,
}

/// Events from every calendar in `account`'s list between `from` and `to`.
/// `can_edit`: whether the account allowed the app to change events.
pub async fn events_between(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    can_edit: bool,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> Result<CalendarEvents> {
    find_events(http, token, account, can_edit, from, to, None).await
}

/// Events matching `query` (Google searches titles, notes, places and
/// guests) between `from` and `to`, on all of `account`'s calendars.
pub async fn search(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    can_edit: bool,
    query: &str,
    from: DateTime<Local>,
    to: DateTime<Local>,
) -> Result<CalendarEvents> {
    find_events(http, token, account, can_edit, from, to, Some(query)).await
}

async fn find_events(
    http: &reqwest::Client,
    token: &str,
    account: &str,
    can_edit: bool,
    from: DateTime<Local>,
    to: DateTime<Local>,
    query: Option<&str>,
) -> Result<CalendarEvents> {
    let calendars = list_calendars(http, token).await?;

    // Fetch all calendars at the same time rather than one after another.
    let results =
        join_all(calendars.iter().map(|cal| list_events(http, token, &cal.id, from, to, query))).await;

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for (calendar, result) in calendars.iter().zip(results) {
        match result {
            Ok(events) => {
                items.extend(events.into_iter().filter_map(|e| to_agenda_item(account, can_edit, calendar, e)))
            }
            Err(e) => warnings.push(format!("{}: {e}", calendar.name())),
        }
    }
    Ok(CalendarEvents { items, warnings })
}

/// The signed-in account's email address, which is its primary calendar's ID.
pub async fn primary_email(http: &reqwest::Client, token: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Calendar {
        id: String,
    }
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", "primary"]);
    let calendar: Calendar = get_json(http, token, url).await?;
    Ok(calendar.id)
}

/// A calendar you can add events to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub primary: bool,
}

/// The calendars you can add events to, your main ("primary") one first.
pub async fn editable_calendars(http: &reqwest::Client, token: &str) -> Result<Vec<EventCalendar>> {
    let mut calendars: Vec<EventCalendar> = list_calendars(http, token)
        .await?
        .into_iter()
        .filter(CalendarListEntry::can_write)
        .map(|cal| EventCalendar { name: cal.name(), id: cal.id, color: cal.background_color, primary: cal.primary })
        .collect();
    calendars.sort_by_key(|cal| !cal.primary);
    Ok(calendars)
}

/// When an event happens: whole days, or times.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTimes {
    /// "YYYY-MM-DD" when `all_day`, otherwise an RFC 3339 timestamp.
    pub start: String,
    /// Same format as `start`. For all-day events, the day after the last day.
    pub end: String,
    pub all_day: bool,
    /// IANA time zone, e.g. "Europe/London". Google needs it for timed events
    /// that repeat; for others it only labels the event.
    pub time_zone: Option<String>,
}

impl EventTimes {
    /// The `start` and `end` Google expects, after checking them.
    fn to_json(&self) -> Result<(Value, Value)> {
        if self.all_day {
            if parse_day(&self.end)? <= parse_day(&self.start)? {
                return Err(AppError::InvalidInput("the event must end after its first day".into()));
            }
            return Ok((json!({ "date": self.start }), json!({ "date": self.end })));
        }
        if parse_time(&self.end)? < parse_time(&self.start)? {
            return Err(AppError::InvalidInput("the event must end after it starts".into()));
        }
        let at = |time: &str| match &self.time_zone {
            Some(zone) => json!({ "dateTime": time, "timeZone": zone }),
            None => json!({ "dateTime": time }),
        };
        Ok((at(&self.start), at(&self.end)))
    }
}

/// Someone to invite.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDraft {
    pub email: String,
    /// Kept for people already invited, so editing doesn't reset their reply.
    pub response: Option<String>,
}

/// An event's alerts: its calendar's defaults, or its own.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "minutes")]
pub enum Alerts {
    Default,
    /// Minutes before the start; empty for no alerts.
    Custom(Vec<u32>),
}

/// An event as the New or Edit form filled it in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub title: String,
    #[serde(flatten)]
    pub times: EventTimes,
    pub location: Option<String>,
    pub description: Option<String>,
    /// Repeat rules, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO". `None` leaves an
    /// existing event's repeat as it is.
    pub recurrence: Option<Vec<String>>,
    /// `None` leaves an existing event's alerts as they are.
    pub alerts: Option<Alerts>,
    /// `None` leaves an existing event's guests as they are.
    pub guests: Option<Vec<GuestDraft>>,
}

impl EventDraft {
    fn to_json(&self) -> Result<Value> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(AppError::InvalidInput("the event needs a title".into()));
        }
        let (start, end) = self.times.to_json()?;
        let text = |s: &Option<String>| s.as_deref().map(str::trim).unwrap_or("").to_string();
        // An empty string clears a field when editing.
        let mut body = json!({
            "summary": title,
            "start": start,
            "end": end,
            "location": text(&self.location),
            "description": text(&self.description),
        });
        match &self.alerts {
            Some(Alerts::Default) => body["reminders"] = json!({ "useDefault": true }),
            Some(Alerts::Custom(minutes)) => {
                body["reminders"] = json!({
                    "useDefault": false,
                    "overrides": minutes.iter().map(|m| json!({ "method": "popup", "minutes": m })).collect::<Vec<_>>(),
                })
            }
            None => {}
        }
        if let Some(rules) = &self.recurrence {
            body["recurrence"] = json!(rules);
        }
        if let Some(guests) = &self.guests {
            body["attendees"] = guests
                .iter()
                .map(|g| match &g.response {
                    Some(response) => json!({ "email": g.email.trim(), "responseStatus": response }),
                    None => json!({ "email": g.email.trim() }),
                })
                .collect();
        }
        Ok(body)
    }

    fn has_guests(&self) -> bool {
        self.guests.as_ref().is_some_and(|g| !g.is_empty())
    }
}

/// `calendars/{calendar_id}/events[/{event_id}]`, with Google told whether to
/// email guests about the change.
fn events_url(calendar_id: &str, event_id: Option<&str>, notify_guests: bool) -> Url {
    let mut url = Url::parse(API).expect("valid URL");
    {
        let mut path = url.path_segments_mut().expect("base URL");
        path.extend(["calendars", calendar_id, "events"]);
        if let Some(id) = event_id {
            path.push(id);
        }
    }
    url.query_pairs_mut().append_pair("sendUpdates", if notify_guests { "all" } else { "none" });
    url
}

/// Adds an event to the calendar `calendar_id`, inviting its guests.
pub async fn create_event(http: &reqwest::Client, token: &str, calendar_id: &str, draft: &EventDraft) -> Result<()> {
    let url = events_url(calendar_id, None, draft.has_guests());
    let _created: Value = send(http.post(url).bearer_auth(token).json(&draft.to_json()?)).await?;
    Ok(())
}

/// Saves an edited event. For one occurrence of a repeating event, only that
/// occurrence changes. `notify_guests` emails them about the change.
pub async fn update_event(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    draft: &EventDraft,
    notify_guests: bool,
) -> Result<()> {
    let url = events_url(calendar_id, Some(event_id), notify_guests);
    let _updated: Value = send(http.patch(url).bearer_auth(token).json(&draft.to_json()?)).await?;
    Ok(())
}

/// Moves an event to another of the same account's calendars.
pub async fn move_to_calendar(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    destination: &str,
) -> Result<()> {
    let mut url = Url::parse(API).expect("valid URL");
    url.path_segments_mut().expect("base URL").extend(["calendars", calendar_id, "events", event_id, "move"]);
    url.query_pairs_mut().append_pair("destination", destination);
    let _moved: Value = send(http.post(url).bearer_auth(token)).await?;
    Ok(())
}

/// Changes only when an event happens (dragging it). For one occurrence of a
/// repeating event, only that occurrence changes.
pub async fn set_event_times(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    times: &EventTimes,
    notify_guests: bool,
) -> Result<()> {
    let (start, end) = times.to_json()?;
    let url = events_url(calendar_id, Some(event_id), notify_guests);
    let _updated: Value = send(http.patch(url).bearer_auth(token).json(&json!({ "start": start, "end": end }))).await?;
    Ok(())
}

/// Deletes an event. Given a repeating event's own ID (`series_id`), deletes
/// every occurrence; given one occurrence's ID, just that one.
pub async fn delete_event(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    notify_guests: bool,
) -> Result<()> {
    let url = events_url(calendar_id, Some(event_id), notify_guests);
    let response = http.delete(url).bearer_auth(token).send().await?;
    let status = response.status();
    // 410 Gone: it was already deleted, which is what we wanted.
    if status.is_success() || status.as_u16() == 410 {
        return Ok(());
    }
    Err(api_error(response).await)
}

fn parse_day(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::InvalidInput(format!("not a YYYY-MM-DD date: {s:?}")))
}

fn parse_time(s: &str) -> Result<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(s).map_err(|_| AppError::InvalidInput(format!("not an RFC 3339 time: {s:?}")))
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
    query: Option<&str>,
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
    if let Some(q) = query {
        url.query_pairs_mut().append_pair("q", q);
    }
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
    send(http.get(url).bearer_auth(token)).await
}

/// Sends a request and reads the JSON reply, or Google's error message.
async fn send<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    let response = request.send().await?;
    if response.status().is_success() {
        return Ok(response.json().await?);
    }
    Err(api_error(response).await)
}

async fn api_error(response: reqwest::Response) -> AppError {
    let status = response.status();
    let message = match response.json::<ApiErrorBody>().await {
        Ok(body) => body.error.message,
        Err(_) => status.canonical_reason().unwrap_or("unknown error").to_string(),
    };
    AppError::Api { status: status.as_u16(), message }
}

fn to_agenda_item(account: &str, can_edit: bool, calendar: &CalendarListEntry, event: Event) -> Option<AgendaItem> {
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

    let conference_url = event
        .conference_data
        .iter()
        .flat_map(|data| &data.entry_points)
        .find(|entry| entry.entry_point_type.as_deref() == Some("video"))
        .and_then(|entry| entry.uri.clone())
        .or(event.hangout_link)
        .or_else(|| event.location.as_deref().and_then(find_meeting_link))
        .or_else(|| event.description.as_deref().and_then(find_meeting_link));
    let reminders = if all_day {
        Vec::new()
    } else {
        match &event.reminders {
            Some(r) if !r.use_default => popup_minutes(&r.overrides),
            _ => popup_minutes(&calendar.default_reminders),
        }
    };
    let organized_by_you = event.organizer.as_ref().is_none_or(|o| o.is_self);
    let attendees = event
        .attendees
        .into_iter()
        .filter(|a| !a.resource)
        .map(|a| Guest {
            name: a.display_name,
            email: a.email,
            response: a.response_status,
            organizer: a.organizer,
            is_self: a.is_self,
        })
        .collect();

    Some(AgendaItem {
        account: Some(account.to_string()),
        list_id: Some(calendar.id.clone()),
        source_id: Some(event.id.clone()),
        editable: can_edit && calendar.can_write() && (organized_by_you || event.guests_can_modify),
        recurring: event.recurring_event_id.is_some(),
        series_id: event.recurring_event_id,
        description: event.description.filter(|s| !s.trim().is_empty()),
        attendees,
        conference_url,
        reminders,
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

fn popup_minutes(reminders: &[Reminder]) -> Vec<u32> {
    reminders.iter().filter(|r| r.method.as_deref() == Some("popup")).filter_map(|r| r.minutes).collect()
}

/// The first video-call link in `text` (a location or notes, possibly HTML).
fn find_meeting_link(text: &str) -> Option<String> {
    const HOSTS: &[&str] = &[
        "zoom.us/",
        "meet.google.com/",
        "teams.microsoft.com/",
        "teams.live.com/",
        "webex.com/",
        "whereby.com/",
        "gotomeeting.com/",
        "chime.aws/",
    ];
    text.replace("&amp;", "&")
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '(' | ')'))
        .filter(|word| word.starts_with("https://"))
        .find(|word| HOSTS.iter().any(|host| word.contains(host)))
        .map(|word| word.trim_end_matches(['.', ',', ';']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(json: Value) -> EventDraft {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_new_repeating_event_with_an_alert_and_a_guest() {
        let body = draft(json!({
            "title": " Standup ",
            "start": "2026-11-02T09:00:00+00:00",
            "end": "2026-11-02T09:15:00+00:00",
            "allDay": false,
            "timeZone": "Europe/London",
            "location": null,
            "description": "Daily",
            "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
            "alerts": { "kind": "custom", "minutes": [10] },
            "guests": [{ "email": "sam@example.com", "response": null }],
        }))
        .to_json()
        .unwrap();
        assert_eq!(body["summary"], "Standup");
        assert_eq!(body["start"], json!({ "dateTime": "2026-11-02T09:00:00+00:00", "timeZone": "Europe/London" }));
        assert_eq!(body["location"], "");
        assert_eq!(body["recurrence"], json!(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]));
        assert_eq!(body["reminders"], json!({ "useDefault": false, "overrides": [{ "method": "popup", "minutes": 10 }] }));
        assert_eq!(body["attendees"], json!([{ "email": "sam@example.com" }]));
    }

    #[test]
    fn editing_leaves_repeat_and_guests_alone_unless_given() {
        let body = draft(json!({
            "title": "Holiday",
            "start": "2026-12-24",
            "end": "2026-12-27",
            "allDay": true,
            "timeZone": null,
            "location": "Home",
            "description": null,
            "recurrence": null,
            "alerts": { "kind": "default" },
            "guests": null,
        }))
        .to_json()
        .unwrap();
        assert_eq!(body["start"], json!({ "date": "2026-12-24" }));
        assert_eq!(body["reminders"], json!({ "useDefault": true }));
        assert!(body.get("recurrence").is_none());
        assert!(body.get("attendees").is_none());
    }

    #[test]
    fn an_event_must_end_after_it_starts() {
        let times = EventTimes {
            start: "2026-11-02".into(),
            end: "2026-11-02".into(),
            all_day: true,
            time_zone: None,
        };
        assert!(times.to_json().is_err());
    }
}
