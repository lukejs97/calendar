//! The Contacts window's people: every Google account's contacts in one
//! list, and a copy saved in the app's cache folder (contacts.json beside
//! agenda.json), so the window opens at once and works without internet.

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;
use futures::future::join_all;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::google::auth::GoogleAuth;
use crate::google::contacts::{self, Contact};

/// How an account's contacts loaded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactsAccount {
    pub email: String,
    /// False for accounts added before the app could use contacts. Adding
    /// the account again (Settings → Google accounts → Add account) asks Google.
    pub can_use: bool,
    /// Why its contacts couldn't be loaded, if they couldn't.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactList {
    pub accounts: Vec<ContactsAccount>,
    /// Sorted by name.
    pub contacts: Vec<Contact>,
    /// Set when there's no internet and these are saved contacts: when they were fetched.
    pub offline_since: Option<String>,
}

/// Every account's contacts. Accounts that loaded replace their saved
/// contacts; without internet, the saved ones are returned instead.
pub async fn load(http: &reqwest::Client, auth: &GoogleAuth, cache: &ContactsCache) -> Result<ContactList> {
    let accounts = auth.accounts().await?;
    let lists = join_all(accounts.iter().map(|email| async move {
        if !auth.can_use_contacts(email).await? {
            return Ok(None);
        }
        let token = auth.access_token(email).await?;
        contacts::all_contacts(http, &token, email).await.map(Some)
    }))
    .await;

    let offline = !lists.is_empty() && lists.iter().all(|list| matches!(list, Err(AppError::Http(_))));
    if offline {
        return saved(auth, cache).await?.ok_or_else(|| lists.into_iter().find_map(Result::err).expect("all failed"));
    }

    let mut loaded = Vec::new();
    let mut all = Vec::new();
    let mut statuses = Vec::new();
    for (email, list) in accounts.into_iter().zip(lists) {
        match list {
            Ok(Some(contacts)) => {
                loaded.push(email.clone());
                all.extend(contacts);
                statuses.push(ContactsAccount { email, can_use: true, error: None });
            }
            Ok(None) => statuses.push(ContactsAccount { email, can_use: false, error: None }),
            Err(AppError::NotSignedIn) => {} // forgotten meanwhile (see GoogleAuth::access_token)
            Err(e) => {
                // Show what was saved for it, rather than nothing.
                all.extend(cache.of(&email));
                statuses.push(ContactsAccount { email, can_use: true, error: Some(e.to_string()) });
            }
        }
    }
    cache.store(&loaded, &all);
    sort(&mut all);
    Ok(ContactList { accounts: statuses, contacts: all, offline_since: None })
}

/// What was saved last time, without the network; `None` if nothing is.
pub async fn saved(auth: &GoogleAuth, cache: &ContactsCache) -> Result<Option<ContactList>> {
    let Some((mut contacts, saved_at)) = cache.all() else { return Ok(None) };
    // Only accounts still signed in, in case one was removed meanwhile.
    let accounts = auth.accounts().await.unwrap_or_default();
    contacts.retain(|c| accounts.contains(&c.account));
    sort(&mut contacts);
    let accounts = accounts.into_iter().map(|email| ContactsAccount { email, can_use: true, error: None }).collect();
    Ok(Some(ContactList { accounts, contacts, offline_since: Some(saved_at) }))
}

/// By name, as an address book is; people without one go last.
fn sort(contacts: &mut [Contact]) {
    let key = |c: &Contact| {
        let organization = c.organization.as_deref().unwrap_or_default();
        let name = [c.name.as_str(), organization, c.emails.first().map_or("", |e| &e.value)]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or_default()
            .to_lowercase();
        (c.name.is_empty(), name)
    };
    contacts.sort_by_cached_key(key);
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    /// When they were fetched (RFC 3339).
    saved_at: Option<String>,
    contacts: Vec<Contact>,
}

pub struct ContactsCache {
    path: Option<PathBuf>,
    saved: Mutex<Saved>,
}

impl ContactsCache {
    /// Reads the file at `path`. A missing or unreadable file means an empty cache.
    pub fn load(path: Option<PathBuf>) -> Self {
        let saved = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        ContactsCache { path, saved: Mutex::new(saved) }
    }

    /// Replaces the saved contacts of each account in `accounts` with theirs in `contacts`.
    fn store(&self, accounts: &[String], contacts: &[Contact]) {
        if accounts.is_empty() {
            return;
        }
        let mut saved = self.saved.lock().expect("not poisoned");
        saved.contacts.retain(|c| !accounts.contains(&c.account));
        saved.contacts.extend(contacts.iter().filter(|c| accounts.contains(&c.account)).cloned());
        saved.saved_at = Some(Local::now().to_rfc3339());
        self.write(&saved);
    }

    /// Adds or replaces one contact (just saved here), so it's there before the next fetch.
    pub fn put(&self, contact: &Contact) {
        let mut saved = self.saved.lock().expect("not poisoned");
        saved.contacts.retain(|c| c.id != contact.id);
        saved.contacts.push(contact.clone());
        self.write(&saved);
    }

    /// Drops one contact (just deleted here).
    pub fn remove(&self, id: &str) {
        let mut saved = self.saved.lock().expect("not poisoned");
        saved.contacts.retain(|c| c.id != id);
        self.write(&saved);
    }

    fn of(&self, account: &str) -> Vec<Contact> {
        let saved = self.saved.lock().expect("not poisoned");
        saved.contacts.iter().filter(|c| c.account == account).cloned().collect()
    }

    fn all(&self) -> Option<(Vec<Contact>, String)> {
        let saved = self.saved.lock().expect("not poisoned");
        Some((saved.contacts.clone(), saved.saved_at.clone()?))
    }

    /// Forgets a removed account's contacts.
    pub fn forget(&self, account: &str) {
        let mut saved = self.saved.lock().expect("not poisoned");
        saved.contacts.retain(|c| c.account != account);
        if saved.contacts.is_empty() {
            saved.saved_at = None;
        }
        self.write(&saved);
    }

    /// Best effort, as in cache.rs: a failed write is ignored.
    fn write(&self, saved: &Saved) {
        let Some(path) = &self.path else { return };
        let Ok(json) = serde_json::to_vec(saved) else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, json).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
}
