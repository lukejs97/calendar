//! Desktop: receives Google's sign-in reply on a tiny one-shot web server at
//! 127.0.0.1 (a "loopback redirect"). Google's Desktop app clients accept any
//! local port.

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use url::Url;

use super::auth::code_from_redirect;
use crate::error::Result;

pub struct Loopback {
    listener: TcpListener,
    pub redirect_uri: String,
}

impl Loopback {
    /// Starts listening on a free port (port 0 = "any free port").
    pub async fn bind() -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        Ok(Loopback { listener, redirect_uri })
    }

    /// Serves requests until the browser arrives with Google's redirect, and
    /// returns the authorization code from it.
    pub async fn wait_for_code(self, expected_state: String) -> Result<String> {
        let (results, mut received) = mpsc::channel(1);
        loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted?;
                    let results = results.clone();
                    let expected_state = expected_state.clone();
                    // One task per connection: browsers sometimes open idle
                    // "preconnect" sockets that would otherwise block the real one.
                    tauri::async_runtime::spawn(async move {
                        if let Some(result) = handle_request(stream, &expected_state).await {
                            let _ = results.send(result).await;
                        }
                    });
                }
                Some(result) = received.recv() => return result,
            }
        }
    }
}

/// Handles one browser request. Returns `None` for requests that aren't the
/// redirect (e.g. /favicon.ico).
async fn handle_request(stream: TcpStream, expected_state: &str) -> Option<Result<String>> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await.ok()?;
    let mut stream = reader.into_inner();

    // e.g. "GET /?state=...&code=...&scope=... HTTP/1.1"
    let target = request_line.split_whitespace().nth(1)?;
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let Some(result) = code_from_redirect(&url, expected_state) else {
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
