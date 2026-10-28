mod agenda;
mod error;
mod google;
mod secrets;
mod todoist;

use std::time::Duration;

use chrono::NaiveDate;
use tauri::{AppHandle, State};

use agenda::Agenda;
use error::{AppError, Result};
use google::auth::GoogleAuth;

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

#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.google_auth.sign_in(&app).await
}

#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> Result<()> {
    state.google_auth.sign_out().await
}

/// `from` and `to` are local dates as "YYYY-MM-DD"; `to` is exclusive.
#[tauri::command]
async fn get_agenda(state: State<'_, AppState>, from: String, to: String) -> Result<Agenda> {
    agenda::load(&state.http, &state.google_auth, parse_date(&from)?, parse_date(&to)?).await
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { google_auth: GoogleAuth::new(http.clone()), http })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            sign_in,
            sign_out,
            get_agenda,
            todoist_status,
            todoist_connect,
            todoist_disconnect,
            set_task_completed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
