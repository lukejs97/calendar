//! Todoist (API v1): reads active tasks that have a due date, and completes or
//! reopens them. Authenticates with the user's personal API token (Todoist →
//! Settings → Integrations → Developer), kept in the OS keychain.

use std::collections::HashMap;

use chrono::{DateTime, Days, Local, NaiveDate, NaiveDateTime, TimeDelta};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use url::Url;

use crate::agenda::{AgendaItem, ItemKind, Source};
use crate::error::{AppError, Result};

const API: &str = "https://api.todoist.com/api/v1";
/// The most items Todoist returns per page.
const PAGE_SIZE: &str = "200";

#[derive(Deserialize)]
struct Page<T> {
    #[serde(default = "Vec::new")]
    results: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Project {
    id: String,
    name: String,
    color: Option<String>,
}

#[derive(Deserialize)]
struct Task {
    id: String,
    content: String,
    #[serde(default)]
    description: String,
    project_id: String,
    due: Option<Due>,
    duration: Option<Duration>,
    /// 4 = most urgent ("P1" in the app) … 1 = normal ("P4").
    priority: u8,
    #[serde(default)]
    checked: bool,
}

/// `date` is "YYYY-MM-DD" for a due day, or a date and time: with a trailing
/// "Z" (fixed time, in UTC) or without (a "floating" time that follows you
/// across time zones).
#[derive(Deserialize)]
struct Due {
    date: String,
    datetime: Option<String>,
}

#[derive(Deserialize)]
struct Duration {
    amount: u32,
    /// "minute" or "day"
    unit: String,
}

enum DueAt {
    Day(NaiveDate),
    Time(DateTime<Local>),
}

fn parse_due(due: &Due) -> Option<DueAt> {
    let s = due.datetime.as_deref().unwrap_or(&due.date);
    if let Ok(day) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(DueAt::Day(day));
    }
    if let Ok(time) = DateTime::parse_from_rfc3339(s) {
        return Some(DueAt::Time(time.with_timezone(&Local)));
    }
    let floating = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    floating.and_local_timezone(Local).earliest().map(DueAt::Time)
}

/// Todoist's named project colors.
fn color_hex(name: &str) -> Option<&'static str> {
    Some(match name {
        "berry_red" => "#b8255f",
        "red" => "#db4035",
        "orange" => "#ff9933",
        "yellow" => "#fad000",
        "olive_green" => "#afb83b",
        "lime_green" => "#7ecc49",
        "green" => "#299438",
        "mint_green" => "#6accbc",
        "teal" => "#158fad",
        "sky_blue" => "#14aaf5",
        "light_blue" => "#96c3eb",
        "blue" => "#4073ff",
        "grape" => "#884dff",
        "violet" => "#af38eb",
        "lavender" => "#eb96eb",
        "magenta" => "#e05194",
        "salmon" => "#ff8d85",
        "charcoal" => "#808080",
        "grey" => "#b8b8b8",
        "taupe" => "#ccac93",
        _ => return None,
    })
}

fn api_url(segments: &[&str]) -> Url {
    let mut url = Url::parse(API).expect("valid URL");
    // Escapes anything unusual in IDs, so they can't change the path.
    url.path_segments_mut().expect("base URL").extend(segments);
    url
}

async fn check(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = match status.as_u16() {
        401 | 403 => "Todoist rejected the API token. Reconnect Todoist with a current token.".to_string(),
        _ => response.text().await.unwrap_or_default(),
    };
    Err(AppError::Api { status: status.as_u16(), message })
}

/// Fetches every page of a list endpoint ("tasks", "projects").
async fn get_all<T: DeserializeOwned>(http: &reqwest::Client, token: &str, resource: &str) -> Result<Vec<T>> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut url = api_url(&[resource]);
        url.query_pairs_mut().append_pair("limit", PAGE_SIZE);
        if let Some(c) = &cursor {
            url.query_pairs_mut().append_pair("cursor", c);
        }
        let response = check(http.get(url).bearer_auth(token).send().await?).await?;
        let page: Page<T> = response.json().await?;
        all.extend(page.results);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(all),
        }
    }
}

/// Makes one small request to confirm the token works before saving it.
pub async fn verify_token(http: &reqwest::Client, token: &str) -> Result<()> {
    let mut url = api_url(&["projects"]);
    url.query_pairs_mut().append_pair("limit", "1");
    check(http.get(url).bearer_auth(token).send().await?).await?;
    Ok(())
}

/// Active tasks due between `from` and `to` (exclusive). Overdue tasks are
/// placed on today, when today is in range, so they can't be missed.
pub async fn tasks_between(
    http: &reqwest::Client,
    token: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<AgendaItem>> {
    // Todoist has no "due between" listing, so fetch all active tasks (a few
    // pages at most) and filter here.
    let (projects, tasks) = tokio::try_join!(
        get_all::<Project>(http, token, "projects"),
        get_all::<Task>(http, token, "tasks"),
    )?;
    let projects: HashMap<&str, &Project> = projects.iter().map(|p| (p.id.as_str(), p)).collect();
    let today = Local::now().date_naive();

    Ok(tasks
        .into_iter()
        .filter_map(|task| to_agenda_item(task, &projects, from, to, today))
        .collect())
}

fn to_agenda_item(
    task: Task,
    projects: &HashMap<&str, &Project>,
    from: NaiveDate,
    to: NaiveDate,
    today: NaiveDate,
) -> Option<AgendaItem> {
    if task.checked {
        return None;
    }
    let due = parse_due(task.due.as_ref()?)?;
    let due_day = match &due {
        DueAt::Day(day) => *day,
        DueAt::Time(time) => time.date_naive(),
    };
    let overdue = due_day < today;
    let shown_day = if overdue { today } else { due_day };
    if shown_day < from || shown_day >= to {
        return None;
    }

    let (start, end, all_day) = match due {
        // Shown as an all-day item on today, whenever it was due.
        _ if overdue => (today.to_string(), (today + Days::new(1)).to_string(), true),
        DueAt::Day(day) => {
            let days = match &task.duration {
                Some(d) if d.unit == "day" => d.amount.max(1),
                _ => 1,
            };
            (day.to_string(), (day + Days::new(days.into())).to_string(), true)
        }
        DueAt::Time(time) => {
            let minutes = match &task.duration {
                Some(d) if d.unit == "minute" => d.amount,
                _ => 0,
            };
            let end = time + TimeDelta::minutes(minutes.into());
            (time.to_rfc3339(), end.to_rfc3339(), false)
        }
    };

    let project = projects.get(task.project_id.as_str());
    Some(AgendaItem {
        url: Some(format!("https://app.todoist.com/app/task/{}", task.id)),
        id: format!("todoist:{}", task.id),
        source: Source::Todoist,
        kind: ItemKind::Task,
        title: task.content,
        start,
        end: Some(end),
        all_day,
        location: None,
        color: project.and_then(|p| p.color.as_deref()).and_then(color_hex).map(String::from),
        list_name: project.map_or_else(|| "Todoist".to_string(), |p| p.name.clone()),
        completed: false,
        overdue,
        // Flip to Todoist's on-screen numbering: 1 = P1 (most urgent).
        priority: Some(5 - task.priority.clamp(1, 4)),
        account: None,
        calendar_id: None,
        event_id: None,
        editable: false,
        recurring: false,
        description: Some(task.description).filter(|d| !d.trim().is_empty()),
        attendees: Vec::new(),
        conference_url: None,
        reminders: Vec::new(),
    })
}

/// Completes (closes) or reopens a task. `item_id` is an `AgendaItem` id,
/// "todoist:<task id>".
pub async fn set_completed(http: &reqwest::Client, token: &str, item_id: &str, completed: bool) -> Result<()> {
    let task_id = item_id
        .strip_prefix("todoist:")
        .ok_or_else(|| AppError::InvalidInput(format!("not a Todoist task: {item_id:?}")))?;
    let action = if completed { "close" } else { "reopen" };
    check(http.post(api_url(&["tasks", task_id, action])).bearer_auth(token).send().await?).await?;
    Ok(())
}
