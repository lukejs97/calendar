//! Google sign-in (OAuth 2.0 authorization code + PKCE).
//!
//! 1. Open Google's consent page in the browser, telling Google where to send
//!    the browser back to afterwards (the "redirect URI").
//! 2. Google redirects there with a one-time `code`; the app picks it up:
//!    - desktop ("Desktop app" client): a tiny web server on 127.0.0.1
//!      (see `loopback.rs`);
//!    - iPhone ("iOS" client): a custom URL scheme only this app answers to,
//!      which iOS hands to the app as a deep link (`handle_redirect_url`).
//! 3. Swap the code (plus the PKCE verifier) for tokens.
//!
//! Several Google accounts can be signed in at once. Each one's long-lived
//! refresh token goes to the OS keychain; the short-lived access tokens
//! (about an hour) only ever live in memory.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use url::Url;

use super::calendar;
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
    /// the app, so Google does not treat it as a real secret for this client
    /// type. iOS clients have none.
    secret: Option<&'static str>,
}

#[cfg(desktop)]
fn oauth_client() -> Result<OAuthClient> {
    match (option_env!("GOOGLE_CLIENT_ID"), option_env!("GOOGLE_CLIENT_SECRET")) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => {
            Ok(OAuthClient { id, secret: Some(secret) })
        }
        _ => Err(AppError::Config(
            "The Google OAuth client isn't configured. Copy src-tauri/.env.example to \
             src-tauri/.env, fill in your client ID and secret, then restart `npm run tauri dev`."
                .into(),
        )),
    }
}

#[cfg(mobile)]
fn oauth_client() -> Result<OAuthClient> {
    match option_env!("GOOGLE_IOS_CLIENT_ID") {
        Some(id) if !id.is_empty() => Ok(OAuthClient { id, secret: None }),
        _ => Err(AppError::Config(
            "The Google iOS client isn't configured. Add GOOGLE_IOS_CLIENT_ID to \
             src-tauri/.env and rebuild."
                .into(),
        )),
    }
}

/// Where Google sends an iOS app back to: the client ID reversed, as a URL
/// scheme ("1234-abc.apps.googleusercontent.com" becomes
/// "com.googleusercontent.apps.1234-abc:/oauth2redirect"). The same scheme is
/// registered for the app in tauri.conf.json (plugins → deep-link).
#[cfg(mobile)]
fn ios_redirect_uri(client_id: &str) -> String {
    let scheme: Vec<&str> = client_id.split('.').rev().collect();
    format!("{}:/oauth2redirect", scheme.join("."))
}

/// Reads Google's reply (the URL it redirected to). Returns `None` if the URL
/// isn't a reply at all, e.g. a browser asking for /favicon.ico.
pub(super) fn code_from_redirect(url: &Url, expected_state: &str) -> Option<Result<String>> {
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(error) = params.get("error") {
        // "access_denied" means the user clicked Cancel.
        return Some(Err(AppError::Auth(format!("Google returned \"{error}\""))));
    }
    let code = params.get("code")?;
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Some(Err(AppError::Auth("the sign-in response didn't match this request".into())));
    }
    Some(Ok(code.clone()))
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

/// A signed-in Google account, as saved in the keychain.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    email: String,
    refresh_token: String,
}

fn read_accounts() -> Result<Vec<Account>> {
    match secrets::get(secrets::GOOGLE_ACCOUNTS)? {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| AppError::Config(format!("the saved Google accounts couldn't be read: {e}"))),
        None => Ok(Vec::new()),
    }
}

fn write_accounts(accounts: &[Account]) -> Result<()> {
    if accounts.is_empty() {
        return secrets::delete(secrets::GOOGLE_ACCOUNTS);
    }
    secrets::set(secrets::GOOGLE_ACCOUNTS, &serde_json::to_string(accounts).expect("serializable"))
}

/// Owns the Google sessions: adds accounts, hands out a valid access token
/// for each on request (refreshing it when needed), and removes them.
pub struct GoogleAuth {
    http: reqwest::Client,
    /// By account email.
    access_tokens: Mutex<HashMap<String, AccessToken>>,
    /// Held while changing the saved account list, so two changes at once
    /// can't undo each other. Never taken while holding `access_tokens`.
    store: Mutex<()>,
    /// iOS: while a sign-in is waiting, where to deliver Google's redirect.
    #[cfg(mobile)]
    pending_redirect: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Url>>>,
}

impl GoogleAuth {
    pub fn new(http: reqwest::Client) -> Self {
        GoogleAuth {
            http,
            access_tokens: Mutex::new(HashMap::new()),
            store: Mutex::new(()),
            #[cfg(mobile)]
            pending_redirect: std::sync::Mutex::new(None),
        }
    }

    /// iOS: called with every URL the app is opened with (deep links). Passes
    /// Google's sign-in redirect to the waiting `sign_in`.
    #[cfg(mobile)]
    pub fn handle_redirect_url(&self, url: &Url) {
        if !url.path().ends_with("oauth2redirect") {
            return;
        }
        if let Some(waiting) = self.pending_redirect.lock().expect("not poisoned").take() {
            let _ = waiting.send(url.clone());
        }
    }

    /// True if any account is saved in the keychain. Doesn't touch the network.
    pub fn is_signed_in(&self) -> Result<bool> {
        Ok(!read_accounts()?.is_empty()
            || secrets::get(secrets::LEGACY_GOOGLE_REFRESH_TOKEN)?.is_some())
    }

    /// The signed-in accounts' email addresses, in the order they were added.
    pub async fn accounts(&self) -> Result<Vec<String>> {
        self.migrate_legacy_account().await?;
        Ok(read_accounts()?.into_iter().map(|account| account.email).collect())
    }

    /// Returns an access token for `email`'s account to put in API requests,
    /// refreshing it first if it's missing or about to expire.
    pub async fn access_token(&self, email: &str) -> Result<String> {
        let mut cached = self.access_tokens.lock().await;
        if let Some(token) = cached.get(email)
            && token.expires_at > Instant::now() + EXPIRY_MARGIN
        {
            return Ok(token.value.clone());
        }

        let account = read_accounts()?
            .into_iter()
            .find(|account| account.email == email)
            .ok_or(AppError::NotSignedIn)?;
        match self.refresh(&account.refresh_token).await? {
            Some(tokens) => {
                let token = AccessToken::from_response(&tokens);
                let value = token.value.clone();
                cached.insert(email.to_string(), token);
                Ok(value)
            }
            // Forget the account so the UI asks to add it again.
            None => {
                cached.remove(email);
                drop(cached);
                self.take_account(email).await?;
                Err(AppError::NotSignedIn)
            }
        }
    }

    /// Trades a refresh token for a new access token. `None` means Google no
    /// longer accepts the refresh token: it was revoked or expired (e.g. the
    /// app is still in "Testing" and 7 days passed).
    async fn refresh(&self, refresh_token: &str) -> Result<Option<TokenResponse>> {
        let client = oauth_client()?;
        match self
            .post_token(&client, &[("refresh_token", refresh_token), ("grant_type", "refresh_token")])
            .await?
        {
            Ok(tokens) => Ok(Some(tokens)),
            Err(e) if e.error == "invalid_grant" => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Versions that supported only one account kept its refresh token on its
    /// own. Moves it into the account list as the first account, which needs
    /// the network once to learn its email address.
    async fn migrate_legacy_account(&self) -> Result<()> {
        let _store = self.store.lock().await;
        let Some(refresh_token) = secrets::get(secrets::LEGACY_GOOGLE_REFRESH_TOKEN)? else {
            return Ok(());
        };
        if let Some(tokens) = self.refresh(&refresh_token).await? {
            let email = calendar::primary_email(&self.http, &tokens.access_token).await?;
            let mut accounts = read_accounts()?;
            if !accounts.iter().any(|account| account.email == email) {
                accounts.insert(0, Account { email: email.clone(), refresh_token });
                write_accounts(&accounts)?;
            }
            self.access_tokens.lock().await.insert(email, AccessToken::from_response(&tokens));
        }
        secrets::delete(secrets::LEGACY_GOOGLE_REFRESH_TOKEN)
    }

    /// Signs in to a Google account in the browser and adds it (or renews it,
    /// if it's already added). Returns its email address.
    pub async fn sign_in(&self, app: &AppHandle) -> Result<String> {
        let client = oauth_client()?;

        // PKCE ("pixie"): we keep a random `verifier` and send Google only its
        // SHA-256 hash (the `challenge`). When we later trade the code for
        // tokens we reveal the verifier, proving we're the app that started
        // this sign-in, so a code intercepted by another program is useless.
        let verifier = random_urlsafe(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        // Echoed back by Google; guards against a forged redirect.
        let state = random_urlsafe(16);

        #[cfg(desktop)]
        let loopback = super::loopback::Loopback::bind().await?;
        #[cfg(desktop)]
        let redirect_uri = loopback.redirect_uri.clone();
        #[cfg(mobile)]
        let redirect_uri = ios_redirect_uri(client.id);

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
            // return one even if this account approved the app before;
            // "select_account" lets you pick which account to add, rather than
            // Google assuming the one the browser is signed in to.
            .append_pair("access_type", "offline")
            .append_pair("prompt", "select_account consent");

        #[cfg(mobile)]
        let redirect = {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            *self.pending_redirect.lock().expect("not poisoned") = Some(sender);
            receiver
        };

        app.opener()
            .open_url(auth_url.as_str(), None::<&str>)
            .map_err(|e| AppError::Auth(format!("couldn't open the browser: {e}")))?;

        #[cfg(desktop)]
        let waiting = loopback.wait_for_code(state);
        #[cfg(mobile)]
        let waiting = async {
            let url = redirect.await.map_err(|_| AppError::Auth("sign-in was interrupted".into()))?;
            code_from_redirect(&url, &state)
                .unwrap_or_else(|| Err(AppError::Auth("Google's reply had no sign-in code".into())))
        };
        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, waiting)
            .await
            .map_err(|_| AppError::Auth("timed out waiting for the browser".into()))??;

        let tokens = self
            .post_token(
                &client,
                &[
                    ("code", code.as_str()),
                    ("code_verifier", verifier.as_str()),
                    ("grant_type", "authorization_code"),
                    ("redirect_uri", redirect_uri.as_str()),
                ],
            )
            .await??;

        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or_else(|| AppError::Auth("Google didn't return a refresh token".into()))?;
        let email = calendar::primary_email(&self.http, &tokens.access_token).await?;
        {
            let _store = self.store.lock().await;
            let mut accounts = read_accounts()?;
            let account = Account { email: email.clone(), refresh_token };
            match accounts.iter_mut().find(|existing| existing.email == email) {
                Some(existing) => *existing = account,
                None => accounts.push(account),
            }
            write_accounts(&accounts)?;
        }
        self.access_tokens.lock().await.insert(email.clone(), AccessToken::from_response(&tokens));

        // The browser has focus now; bring the app back to the front. (On iOS,
        // following the redirect already switched back to the app.)
        #[cfg(desktop)]
        if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        Ok(email)
    }

    /// Signs `email`'s account out of the app.
    pub async fn remove_account(&self, email: &str) -> Result<()> {
        self.access_tokens.lock().await.remove(email);
        if let Some(account) = self.take_account(email).await? {
            // Ask Google to invalidate the token too. Best effort: still
            // remove it locally when offline.
            let _ = self.http.post(REVOKE_URL).form(&[("token", account.refresh_token)]).send().await;
        }
        Ok(())
    }

    /// Deletes `email`'s account from the keychain and returns it.
    async fn take_account(&self, email: &str) -> Result<Option<Account>> {
        let _store = self.store.lock().await;
        let mut accounts = read_accounts()?;
        let Some(index) = accounts.iter().position(|account| account.email == email) else {
            return Ok(None);
        };
        let account = accounts.remove(index);
        write_accounts(&accounts)?;
        Ok(Some(account))
    }

    /// POSTs to Google's token endpoint, adding the client's ID (and secret,
    /// if it has one). The outer `Result` is for transport failures; the inner
    /// one is Google's answer.
    async fn post_token(
        &self,
        client: &OAuthClient,
        form: &[(&str, &str)],
    ) -> Result<std::result::Result<TokenResponse, TokenError>> {
        let mut fields = vec![("client_id", client.id)];
        if let Some(secret) = client.secret {
            fields.push(("client_secret", secret));
        }
        fields.extend_from_slice(form);

        let response = self.http.post(TOKEN_URL).form(&fields).send().await?;
        if response.status().is_success() {
            Ok(Ok(response.json().await?))
        } else {
            Ok(Err(response.json().await?))
        }
    }
}

fn random_urlsafe(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
