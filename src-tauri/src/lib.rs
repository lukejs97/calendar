mod agenda;
mod cache;
mod error;
mod google;
mod search;
mod secrets;
mod todoist;

use std::time::Duration;

use chrono::NaiveDate;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use agenda::Agenda;
use cache::AgendaCache;
use error::{AppError, Result};
use google::auth::GoogleAuth;
use google::calendar::{EventCalendar, EventDraft, EventTimes};

struct AppState {
    http: reqwest::Client,
    google_auth: GoogleAuth,
}

// Commands: Rust functions the TypeScript frontend calls with `invoke(...)`.
// All network access and tokens stay on this side; the web view only ever
// sees agenda data.

#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> Result<bool> {
    state.google_auth.is_signed_in()
}

/// Adds a Google account (or renews one already added); returns its email.
#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    state.google_auth.sign_in(&app).await
}

#[tauri::command]
async fn google_accounts(state: State<'_, AppState>) -> Result<Vec<String>> {
    state.google_auth.accounts().await
}

#[tauri::command]
async fn remove_google_account(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    email: String,
) -> Result<()> {
    state.google_auth.remove_account(&email).await?;
    cache.forget(&email);
    Ok(())
}

/// `from` and `to` are local dates as "YYYY-MM-DD"; `to` is exclusive.
/// Without internet, falls back to the items saved last time (see cache.rs).
#[tauri::command]
async fn get_agenda(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    from: String,
    to: String,
) -> Result<Agenda> {
    let (from, to) = (parse_date(&from)?, parse_date(&to)?);
    match agenda::load(&state.http, &state.google_auth, from, to).await {
        Ok(agenda) => {
            cache.store(from, to, &agenda.loaded, &agenda.items);
            Ok(agenda)
        }
        // No internet (or Google unreachable): show what was saved.
        Err(e @ AppError::Http(_)) => saved_agenda(&state, &cache, from, to).await?.ok_or(e),
        Err(e) => Err(e),
    }
}

/// The items saved last time, straight away and without the network, so the
/// app can show something while it fetches. `None` if nothing is saved.
#[tauri::command]
async fn get_saved_agenda(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    from: String,
    to: String,
) -> Result<Option<Agenda>> {
    let agenda = saved_agenda(&state, &cache, parse_date(&from)?, parse_date(&to)?).await?;
    Ok(agenda.map(|agenda| Agenda { offline_since: None, ..agenda }))
}

async fn saved_agenda(
    state: &AppState,
    cache: &AgendaCache,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Option<Agenda>> {
    let Some((mut items, saved_at)) = cache.between(from, to) else {
        return Ok(None);
    };
    // Only accounts still signed in, in case one was removed meanwhile.
    let accounts = state.google_auth.accounts().await.unwrap_or_default();
    items.retain(|item| item.account.as_ref().is_none_or(|a| accounts.contains(a)));
    Ok(Some(Agenda { accounts, items, warnings: Vec::new(), offline_since: Some(saved_at), loaded: Vec::new() }))
}

/// Events and tasks from a year back to a year ahead matching `query`.
#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    cache: State<'_, AgendaCache>,
    query: String,
) -> Result<search::SearchResults> {
    search::search(&state.http, &state.google_auth, &cache, &query).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountCalendars {
    email: String,
    /// False for accounts added before the app could add events. Adding the
    /// account again (Accounts → Add account) asks Google for permission.
    can_edit: bool,
    calendars: Vec<EventCalendar>,
    /// Why the calendars couldn't be listed, if they couldn't.
    error: Option<String>,
}

/// The calendars you can add events to, for each Google account.
#[tauri::command]
async fn event_calendars(state: State<'_, AppState>) -> Result<Vec<AccountCalendars>> {
    let (auth, http) = (&state.google_auth, &state.http);
    let accounts = auth.accounts().await?;
    let lists = join_all(accounts.iter().map(|email| async move {
        if !auth.can_edit_events(email).await? {
            return Ok((false, Vec::new()));
        }
        let token = auth.access_token(email).await?;
        Ok((true, google::calendar::editable_calendars(http, &token).await?))
    }))
    .await;
    Ok(accounts
        .into_iter()
        .zip(lists)
        .map(|(email, list): (String, Result<_>)| match list {
            Ok((can_edit, calendars)) => AccountCalendars { email, can_edit, calendars, error: None },
            Err(e) => AccountCalendars { email, can_edit: false, calendars: Vec::new(), error: Some(e.to_string()) },
        })
        .collect())
}

/// Adds an event to `calendar_id`, one of `email`'s calendars, inviting its guests.
#[tauri::command]
async fn create_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event: EventDraft,
) -> Result<()> {
    let token = state.google_auth.access_token(&email).await?;
    google::calendar::create_event(&state.http, &token, &calendar_id, &event).await
}

/// Which Google event: its account, calendar and ID. For a repeating event,
/// one occurrence's ID affects that occurrence; the series' ID, all of them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventRef {
    email: String,
    calendar_id: String,
    event_id: String,
}

/// Saves an edited event, first moving it to `move_to` (another calendar in
/// the same account) if given. `notify_guests` emails them about the change.
#[tauri::command]
async fn update_event(
    state: State<'_, AppState>,
    target: EventRef,
    event: EventDraft,
    move_to: Option<String>,
    notify_guests: bool,
) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    let mut calendar_id = target.calendar_id;
    if let Some(destination) = move_to.filter(|d| *d != calendar_id) {
        google::calendar::move_to_calendar(&state.http, &token, &calendar_id, &target.event_id, &destination).await?;
        calendar_id = destination;
    }
    google::calendar::update_event(&state.http, &token, &calendar_id, &target.event_id, &event, notify_guests).await
}

/// Moves or resizes an event (dragging it).
#[tauri::command]
async fn set_event_times(
    state: State<'_, AppState>,
    target: EventRef,
    times: EventTimes,
    notify_guests: bool,
) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::set_event_times(&state.http, &token, &target.calendar_id, &target.event_id, &times, notify_guests)
        .await
}

#[tauri::command]
async fn delete_event(state: State<'_, AppState>, target: EventRef, notify_guests: bool) -> Result<()> {
    let token = state.google_auth.access_token(&target.email).await?;
    google::calendar::delete_event(&state.http, &token, &target.calendar_id, &target.event_id, notify_guests).await
}

fn parse_date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::InvalidInput(format!("not a YYYY-MM-DD date: {s:?}")))
}

#[tauri::command]
fn todoist_status() -> Result<bool> {
    Ok(secrets::get(secrets::TODOIST_TOKEN)?.is_some())
}

/// Checks the personal API token with Todoist, then saves it in the keychain.
#[tauri::command]
async fn todoist_connect(state: State<'_, AppState>, token: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::InvalidInput("paste your Todoist API token first".into()));
    }
    todoist::verify_token(&state.http, token).await?;
    secrets::set(secrets::TODOIST_TOKEN, token)
}

/// Todoist projects to add tasks to, Inbox first.
#[tauri::command]
async fn todoist_projects(state: State<'_, AppState>) -> Result<Vec<todoist::ProjectInfo>> {
    todoist::projects(&state.http, &todoist_token()?).await
}

#[tauri::command]
async fn create_task(state: State<'_, AppState>, task: todoist::TaskDraft) -> Result<()> {
    todoist::create_task(&state.http, &todoist_token()?, &task).await
}

/// `id` is the task's own Todoist ID.
#[tauri::command]
async fn update_task(state: State<'_, AppState>, id: String, task: todoist::TaskDraft) -> Result<()> {
    todoist::update_task(&state.http, &todoist_token()?, &id, &task).await
}

/// Reschedules a task (dragging it).
#[tauri::command]
async fn set_task_due(state: State<'_, AppState>, id: String, due: todoist::TaskDue) -> Result<()> {
    todoist::set_task_due(&state.http, &todoist_token()?, &id, &due).await
}

#[tauri::command]
async fn delete_task(state: State<'_, AppState>, id: String) -> Result<()> {
    todoist::delete_task(&state.http, &todoist_token()?, &id).await
}

fn todoist_token() -> Result<String> {
    secrets::get(secrets::TODOIST_TOKEN)?.ok_or_else(|| AppError::Config("Todoist isn't connected".into()))
}

#[tauri::command]
fn todoist_disconnect(cache: State<'_, AgendaCache>) -> Result<()> {
    secrets::delete(secrets::TODOIST_TOKEN)?;
    cache.forget("todoist");
    Ok(())
}

/// `id` is the task's `AgendaItem` id ("todoist:…").
#[tauri::command]
async fn set_task_completed(state: State<'_, AppState>, id: String, completed: bool) -> Result<()> {
    todoist::set_completed(&state.http, &todoist_token()?, &id, completed).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("calendar/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client");

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_notification::init());

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
        .setup(|app| {
            let path = app.path().app_cache_dir().ok().map(|dir| dir.join("agenda.json"));
            app.manage(AgendaCache::load(path));
            #[cfg(mobile)]
            listen_for_sign_in_redirects(app);
            Ok(())
        })
        .manage(AppState { google_auth: GoogleAuth::new(http.clone()), http })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            sign_in,
            google_accounts,
            remove_google_account,
            get_agenda,
            get_saved_agenda,
            search,
            event_calendars,
            create_event,
            update_event,
            set_event_times,
            delete_event,
            todoist_status,
            todoist_connect,
            todoist_disconnect,
            todoist_projects,
            create_task,
            update_task,
            set_task_due,
            delete_task,
            set_task_completed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// iOS: Google's sign-in redirect comes back as a deep link (a custom URL
/// scheme that opens this app); pass it to the waiting sign-in.
#[cfg(mobile)]
fn listen_for_sign_in_redirects(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        let state = handle.state::<AppState>();
        for url in event.urls() {
            state.google_auth.handle_redirect_url(&url);
        }
    });
}
