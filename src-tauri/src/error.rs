use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Every error a command can return. It reaches the frontend as
/// `{ kind, message }`, so the UI can react to `kind` (e.g. show the
/// sign-in screen on "notSignedIn") and display `message`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not signed in to Google")]
    NotSignedIn,
    #[error("{0}")]
    Config(String),
    #[error("Sign-in failed: {0}")]
    Auth(String),
    #[error("Google API error ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Keychain error: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::NotSignedIn => "notSignedIn",
            AppError::Config(_) => "config",
            AppError::Auth(_) => "auth",
            AppError::Api { .. } => "api",
            AppError::Http(_) => "network",
            AppError::Keychain(_) => "keychain",
            AppError::Io(_) => "io",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;
