//! Thin wrapper over the OS keychain (Windows Credential Manager, macOS
//! Keychain). Each secret is stored under this app's service name plus a key.

use keyring::Entry;

use crate::error::Result;

/// The app's original identifier. Kept after the app ID changed to
/// com.lukesassa.calendar so existing sign-ins stay where they are.
const SERVICE: &str = "com.mycalendar.app";

pub const GOOGLE_REFRESH_TOKEN: &str = "google-refresh-token";
pub const TODOIST_TOKEN: &str = "todoist-token";

pub fn get(key: &str) -> Result<Option<String>> {
    match Entry::new(SERVICE, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set(key: &str, value: &str) -> Result<()> {
    Entry::new(SERVICE, key)?.set_password(value)?;
    Ok(())
}

pub fn delete(key: &str) -> Result<()> {
    match Entry::new(SERVICE, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
