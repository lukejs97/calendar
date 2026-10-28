//! Google sign-in for a "Desktop app" OAuth client.
//!
//! Flow (OAuth 2.0 authorization code + PKCE, loopback redirect):
//! 1. Start a tiny one-shot web server on 127.0.0.1 at a random free port.
//! 2. Open Google's consent page in the user's browser, asking Google to send
//!    the browser back to that local address afterwards.
//! 3. Google redirects to `http://127.0.0.1:<port>/?code=...`; we read the code.
//! 4. Swap the code (plus the PKCE verifier) for tokens.
//!
//! The long-lived refresh token goes to the OS keychain. The short-lived
//! access token (about an hour) only ever lives in memory.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, mpsc};
use url::Url;

use crate::error::{AppError, Result};
use crate::secrets;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

/// Read-only for Phase 1. Creating events (Phase 3) needs
/// "https://www.googleapis.com/auth/calendar.events" added here; the user then
/// signs in once more to grant it.
const SCOPES: &[&str] = &["https://www.googleapis.com/auth/calendar.readonly"];

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh a little before Google's stated expiry so a request never races it.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

struct OAuthClient {
    id: &'static str,
    /// Google requires this for Desktop clients even with PKCE. It ships inside
    /// the app, so Google does not treat it as a real secret for this client type.
    secret: &'static str,
}

fn oauth_client() -> Result<OAuthClient> {
    match (option_env!("GOOGLE_CLIENT_ID"), option_env!("GOOGLE_CLIENT_SECRET")) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => {
            Ok(OAuthClient { id, secret })
        }
        _ => Err(AppError::Config(
            "The Google OAuth client isn't configured. Copy src-tauri/.env.example to \
             src-tauri/.env, fill in your client ID and secret, then restart `npm run tauri dev`."
                .into(),
        )),
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

impl From<TokenError> for AppError {
    fn from(e: TokenError) -> Self {
        AppError::Auth(match e.error_description {
            Some(description) => format!("{} ({description})", e.error),
            None => e.error,
        })
    }
}

struct AccessToken {
    value: String,
    expires_at: Instant,
}

impl AccessToken {
    fn from_response(tokens: &TokenResponse) -> Self {
        AccessToken {
            value: tokens.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(tokens.expires_in),
        }
    }
}

/// Owns the Google session: signs in, hands out a valid access token on
/// request (refreshing it when needed), and signs out.
pub struct GoogleAuth {
    http: reqwest::Client,
    access_token: Mutex<Option<AccessToken>>,
}

impl GoogleAuth {
    pub fn new(http: reqwest::Client) -> Self {
        GoogleAuth { http, access_token: Mutex::new(None) }
    }

    /// True if a refresh token is in the keychain. Doesn't touch the network.
    pub fn is_signed_in(&self) -> Result<bool> {
        Ok(secrets::get(secrets::GOOGLE_REFRESH_TOKEN)?.is_some())
    }

    /// Returns an access token to put in API requests, refreshing it first if
    /// it's missing or about to expire.
    pub async fn access_token(&self) -> Result<String> {
        let mut cached = self.access_token.lock().await;
        if let Some(token) = cached.as_ref()
            && token.expires_at > Instant::now() + EXPIRY_MARGIN
        {
            return Ok(token.value.clone());
        }

        let refresh_token =
            secrets::get(secrets::GOOGLE_REFRESH_TOKEN)?.ok_or(AppError::NotSignedIn)?;
        let client = oauth_client()?;
        let tokens = match self
            .post_token(&[
                ("client_id", client.id),
                ("client_secret", client.secret),
                ("refresh_token", refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .await?
        {
            Ok(tokens) => tokens,
            // The refresh token was revoked or expired (e.g. the app is still in
            // "Testing" and 7 days passed). Forget it so the UI asks to sign in.
            Err(e) if e.error == "invalid_grant" => {
                secrets::delete(secrets::GOOGLE_REFRESH_TOKEN)?;
                return Err(AppError::NotSignedIn);
            }
            Err(e) => return Err(e.into()),
        };

        let token = AccessToken::from_response(&tokens);
        let value = token.value.clone();
        *cached = Some(token);
        Ok(value)
    }

    pub async fn sign_in(&self, app: &AppHandle) -> Result<()> {
        let client = oauth_client()?;

        // PKCE ("pixie"): we keep a random `verifier` and send Google only its
        // SHA-256 hash (the `challenge`). When we later trade the code for
        // tokens we reveal the verifier, proving we're the app that started
        // this sign-in, so a code intercepted by another program is useless.
        let verifier = random_urlsafe(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        // Echoed back by Google; guards against a forged redirect.
        let state = random_urlsafe(16);

        // Port 0 = "any free port". Desktop clients accept any loopback port.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr()?.port());

        let mut auth_url = Url::parse(AUTH_URL).expect("valid URL");
        auth_url
            .query_pairs_mut()
            .append_pair("client_id", client.id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &SCOPES.join(" "))
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            // "offline" = also give us a refresh token; "consent" makes Google
            // return one even if this account approved the app before.
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");

        app.opener()
            .open_url(auth_url.as_str(), None::<&str>)
            .map_err(|e| AppError::Auth(format!("couldn't open the browser: {e}")))?;

        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_redirect(listener, state))
            .await
            .map_err(|_| AppError::Auth("timed out waiting for the browser".into()))??;

        let tokens = self
            .post_token(&[
                ("client_id", client.id),
                ("client_secret", client.secret),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("grant_type", "authorization_code"),
                ("redirect_uri", redirect_uri.as_str()),
            ])
            .await??;

        let refresh_token = tokens
            .refresh_token
            .as_deref()
            .ok_or_else(|| AppError::Auth("Google didn't return a refresh token".into()))?;
        secrets::set(secrets::GOOGLE_REFRESH_TOKEN, refresh_token)?;
        *self.access_token.lock().await = Some(AccessToken::from_response(&tokens));

        // The browser has focus now; bring the app back to the front.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        Ok(())
    }

    pub async fn sign_out(&self) -> Result<()> {
        if let Some(refresh_token) = secrets::get(secrets::GOOGLE_REFRESH_TOKEN)? {
            // Ask Google to invalidate it too. Best effort: still sign out locally
            // when offline.
            let _ = self.http.post(REVOKE_URL).form(&[("token", refresh_token)]).send().await;
        }
        secrets::delete(secrets::GOOGLE_REFRESH_TOKEN)?;
        *self.access_token.lock().await = None;
        Ok(())
    }

    /// POSTs to Google's token endpoint. The outer `Result` is for transport
    /// failures; the inner one is Google's answer.
    async fn post_token(
        &self,
        form: &[(&str, &str)],
    ) -> Result<std::result::Result<TokenResponse, TokenError>> {
        let response = self.http.post(TOKEN_URL).form(form).send().await?;
        if response.status().is_success() {
            Ok(Ok(response.json().await?))
        } else {
            Ok(Err(response.json().await?))
        }
    }
}

/// Serves the loopback address until the browser arrives with Google's
/// redirect, and returns the authorization code from it.
async fn wait_for_redirect(listener: TcpListener, expected_state: String) -> Result<String> {
    let (results, mut received) = mpsc::channel(1);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let results = results.clone();
                let expected_state = expected_state.clone();
                // One task per connection: browsers sometimes open idle
                // "preconnect" sockets that would otherwise block the real one.
                tauri::async_runtime::spawn(async move {
                    if let Some(result) = handle_redirect(stream, &expected_state).await {
                        let _ = results.send(result).await;
                    }
                });
            }
            Some(result) = received.recv() => return result,
        }
    }
}

/// Handles one browser request. Returns `None` for requests that aren't the
/// redirect (e.g. /favicon.ico).
async fn handle_redirect(stream: TcpStream, expected_state: &str) -> Option<Result<String>> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await.ok()?;
    let mut stream = reader.into_inner();

    // e.g. "GET /?state=...&code=...&scope=... HTTP/1.1"
    let target = request_line.split_whitespace().nth(1)?;
    let params: HashMap<String, String> = Url::parse(&format!("http://127.0.0.1{target}"))
        .ok()?
        .query_pairs()
        .into_owned()
        .collect();

    let result = if let Some(error) = params.get("error") {
        // "access_denied" means the user clicked Cancel.
        Err(AppError::Auth(format!("Google returned \"{error}\"")))
    } else if let Some(code) = params.get("code") {
        if params.get("state").map(String::as_str) == Some(expected_state) {
            Ok(code.clone())
        } else {
            Err(AppError::Auth("the sign-in response didn't match this request".into()))
        }
    } else {
        let _ = respond(&mut stream, "404 Not Found", "").await;
        return None;
    };

    let message = match &result {
        Ok(_) => "<h2>You're signed in.</h2><p>You can close this tab and return to Calendar.</p>",
        Err(_) => "<h2>Sign-in didn't complete.</h2><p>Return to Calendar and try again.</p>",
    };
    let _ = respond(&mut stream, "200 OK", message).await;
    Some(result)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Calendar</title></head>\
         <body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem\">\
         {body}</body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn random_urlsafe(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
