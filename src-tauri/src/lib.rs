mod agenda;
mod error;
mod google;
mod secrets;
mod todoist;

use std::time::Duration;

use chrono::NaiveDate;
use futures::future::join_all;
use serde::Serialize;
use tauri::{AppHandle, State};

use agenda::Agenda;
use error::{AppError, Result};
use google::auth::GoogleAuth;
use google::calendar::{EventCalendar, NewEvent};

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
async fn remove_google_account(state: State<'_, AppState>, email: String) -> Result<()> {
    state.google_auth.remove_account(&email).await
}

/// `from` and `to` are local dates as "YYYY-MM-DD"; `to` is exclusive.
#[tauri::command]
async fn get_agenda(state: State<'_, AppState>, from: String, to: String) -> Result<Agenda> {
    agenda::load(&state.http, &state.google_auth, parse_date(&from)?, parse_date(&to)?).await
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

/// Adds an event to `calendar_id`, one of `email`'s calendars.
#[tauri::command]
async fn create_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event: NewEvent,
) -> Result<()> {
    let token = state.google_auth.access_token(&email).await?;
    google::calendar::create_event(&state.http, &token, &calendar_id, &event).await
}

/// Moves (or resizes) a timed Google event. `start` and `end` are RFC 3339.
#[tauri::command]
async fn move_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event_id: String,
    start: String,
    end: String,
    time_zone: Option<String>,
) -> Result<()> {
    let token = state.google_auth.access_token(&email).await?;
    google::calendar::move_event(&state.http, &token, &calendar_id, &event_id, &start, &end, time_zone.as_deref())
        .await
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

#[tauri::command]
fn todoist_disconnect() -> Result<()> {
    secrets::delete(secrets::TODOIST_TOKEN)
}

/// `id` is the task's `AgendaItem` id ("todoist:…").
#[tauri::command]
async fn set_task_completed(state: State<'_, AppState>, id: String, completed: bool) -> Result<()> {
    let token = secrets::get(secrets::TODOIST_TOKEN)?
        .ok_or_else(|| AppError::Config("Todoist isn't connected".into()))?;
    todoist::set_completed(&state.http, &token, &id, completed).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("calendar/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client");

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // iOS: Google's sign-in redirect comes back as a deep link (a custom URL
    // scheme that opens this app); pass it to the waiting sign-in.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init()).setup(|app| {
        use tauri::Manager;
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let state = handle.state::<AppState>();
            for url in event.urls() {
                state.google_auth.handle_redirect_url(&url);
            }
        });
        Ok(())
    });

    builder
        .manage(AppState { google_auth: GoogleAuth::new(http.clone()), http })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            sign_in,
            google_accounts,
            remove_google_account,
            get_agenda,
            event_calendars,
            create_event,
            move_event,
            todoist_status,
            todoist_connect,
            todoist_disconnect,
            set_task_completed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
