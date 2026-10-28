mod agenda;
mod error;
mod google;
mod secrets;

use std::time::Duration;

use tauri::{AppHandle, State};

use agenda::Agenda;
use error::Result;
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

#[tauri::command]
async fn get_agenda(state: State<'_, AppState>, days: u32) -> Result<Agenda> {
    agenda::load(&state.http, &state.google_auth, days.clamp(1, 90)).await
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
        .invoke_handler(tauri::generate_handler![auth_status, sign_in, sign_out, get_agenda])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
