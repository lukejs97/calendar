//! Search across events and tasks. Google searches each account's calendars
//! itself (titles, notes, places and guests); Todoist tasks are matched here.
//! Without internet, the items saved for offline use are searched instead.

use std::collections::HashSet;

use chrono::{Days, Local};
use futures::future::join_all;
use serde::Serialize;

use crate::agenda::{AgendaItem, item_span, local_midnight};
use crate::cache::AgendaCache;
use crate::error::{AppError, Result};
use crate::google::{self, auth::GoogleAuth};
use crate::{secrets, todoist};

/// How far back and ahead to look.
const DAYS_AROUND: u64 = 365;
/// The most results to return on each side of now.
const MAX_EACH: usize = 50;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Soonest first.
    pub upcoming: Vec<AgendaItem>,
    /// Most recent first.
    pub past: Vec<AgendaItem>,
    /// True when nothing could be reached and saved items were searched.
    pub offline: bool,
    pub warnings: Vec<String>,
}

pub async fn search(
    http: &reqwest::Client,
    google_auth: &GoogleAuth,
    cache: &AgendaCache,
    query: &str,
) -> Result<SearchResults> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResults::default());
    }
    let today = Local::now().date_naive();
    let (from, to) = (today - Days::new(DAYS_AROUND), today + Days::new(DAYS_AROUND + 1));

    let accounts = google_auth.accounts().await?;
    let google = join_all(accounts.iter().map(|email| async move {
        let token = google_auth.access_token(email).await?;
        let can_edit = google_auth.can_edit_events(email).await?;
        google::calendar::search(http, &token, email, can_edit, query, local_midnight(from), local_midnight(to))
            .await
    }));
    let todoist_token = secrets::get(secrets::TODOIST_TOKEN)?;
    let tasks = async {
        match &todoist_token {
            Some(token) => Some(todoist::tasks_between(http, token, from, to).await),
            None => None,
        }
    };
    let (google, tasks) = tokio::join!(google, tasks);

    let mut items = Vec::new();
    let mut warnings = Vec::new();
    let mut sources = 0;
    let mut unreachable = 0;
    let mut note = |name: &str, e: AppError, warnings: &mut Vec<String>| match e {
        AppError::Http(_) => unreachable += 1,
        e => warnings.push(format!("{name}: {e}")),
    };
    for (email, result) in accounts.iter().zip(google) {
        sources += 1;
        match result {
            Ok(events) => items.extend(events.items),
            Err(e) => note(email, e, &mut warnings),
        }
    }
    if let Some(result) = tasks {
        sources += 1;
        match result {
            Ok(tasks) => items.extend(tasks.into_iter().filter(|task| matches(task, query))),
            Err(e) => note("Todoist", e, &mut warnings),
        }
    }

    let offline = sources > 0 && unreachable == sources;
    if offline {
        items = cache.all().into_iter().filter(|item| matches(item, query)).collect();
    }

    // A calendar shared between two accounts is searched twice.
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item.id.clone()));

    let now = Local::now().timestamp();
    let (mut upcoming, mut past): (Vec<_>, Vec<_>) = items.into_iter().partition(|item| item_span(item).1 > now);
    upcoming.sort_by_key(|item| item_span(item).0);
    past.sort_by_key(|item| std::cmp::Reverse(item_span(item).0));
    upcoming.truncate(MAX_EACH);
    past.truncate(MAX_EACH);
    Ok(SearchResults { upcoming, past, offline, warnings })
}

/// Whether every word of `query` appears in the item's title, place, notes or
/// list name, ignoring case.
fn matches(item: &AgendaItem, query: &str) -> bool {
    let text = [Some(&item.title), item.location.as_ref(), item.description.as_ref(), Some(&item.list_name)]
        .into_iter()
        .flatten()
        .map(|s| s.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    query.to_lowercase().split_whitespace().all(|word| text.contains(word))
}
