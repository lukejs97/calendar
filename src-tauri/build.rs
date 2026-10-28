const OAUTH_KEYS: [&str; 3] = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_IOS_CLIENT_ID"];

fn main() {
    load_dotenv();
    tauri_build::build()
}

/// Makes the Google client IDs and secret from `src-tauri/.env` available
/// to the app at compile time (read with `option_env!`). Real environment
/// variables take precedence, which is handy for CI builds.
fn load_dotenv() {
    println!("cargo:rerun-if-changed=.env");
    for key in OAUTH_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let Ok(contents) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        if OAUTH_KEYS.contains(&key) && std::env::var_os(key).is_none() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}
