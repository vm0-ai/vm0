//! Subscribe to an Ably channel using an API key.
//!
//! Set `ABLY_API_KEY` with a secret manager or hidden shell prompt; do not put
//! the value in the command itself.
//!
//! ```sh
//! cargo run -p ably-subscriber --example subscribe -- <CHANNEL> [HOST]
//! ```
//!
//! `ABLY_API_KEY` format: `keyName:keySecret` (from your Ably dashboard).
//! Message JSON is printed to stdout, while tracing and status diagnostics are
//! printed to stderr, so stdout can be piped directly to `jq` for formatting.

use ably_subscriber::{Event, SubscribeConfig, subscribe};

mod common;

fn make_tracing_subscriber<W>(writer: W) -> impl tracing::Subscriber + Send + Sync + 'static
where
    W: for<'writer> tracing_subscriber::fmt::writer::MakeWriter<'writer> + Send + Sync + 'static,
{
    tracing_subscriber::fmt().with_writer(writer).finish()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing::subscriber::set_global_default(make_tracing_subscriber(std::io::stderr))?;

    const USAGE: &str = "usage: subscribe <CHANNEL> [HOST] (set ABLY_API_KEY; API keys are not accepted as arguments)";
    let api_key = std::env::var("ABLY_API_KEY").map_err(
        |_| "ABLY_API_KEY must be set to keyName:keySecret; API keys are not accepted as arguments",
    )?;
    let mut args = std::env::args().skip(1);
    let channel = args.next().ok_or(USAGE)?;
    let host = args.next();
    if args.next().is_some() {
        return Err(USAGE.into());
    }

    let (key_name, key_secret) = api_key
        .split_once(':')
        .ok_or("ABLY_API_KEY must be in format keyName:keySecret")?;

    let key_name = key_name.to_string();
    let key_secret = key_secret.to_string();

    eprintln!("subscribing to '{channel}' ...");

    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let kn = key_name.clone();
            let ks = key_secret.clone();
            Box::pin(async move { common::create_token_request(&kn, &ks, common::ONE_HOUR_TTL_MS) })
        }),
        channel,
    );
    config.host = host;
    let mut sub = subscribe(config).await?;

    while let Some(event) = sub.next().await {
        match &event {
            Event::Message(msg) => {
                eprintln!(
                    "[message] name={} id={} ts={}",
                    msg.name.as_deref().unwrap_or("-"),
                    msg.id.as_deref().unwrap_or("-"),
                    msg.timestamp
                        .map_or_else(|| "-".to_string(), |t| t.to_string()),
                );
                println!("{}", msg.data);
            }
            Event::Connected => eprintln!("[connected]"),
            Event::Disconnected { reason } => {
                eprintln!("[disconnected] {}", reason.as_deref().unwrap_or("-"));
            }
            Event::Error { code, message } => {
                eprintln!("[error] code={code} {message}");
                break;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

    use super::make_tracing_subscriber;

    #[derive(Clone)]
    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .expect("test writer mutex poisoned")
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn tracing_diagnostics_are_separate_from_json_message_output() {
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let subscriber = make_tracing_subscriber({
            let stderr = Arc::clone(&stderr);
            move || SharedWriter(Arc::clone(&stderr))
        });

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("diagnostic");
        });

        let stdout = serde_json::json!({"message": "ok"}).to_string();
        assert!(serde_json::from_str::<serde_json::Value>(&stdout).is_ok());
        assert!(!stdout.contains("diagnostic"));

        let stderr = String::from_utf8(stderr.lock().expect("test writer mutex poisoned").clone())
            .expect("tracing output should be UTF-8");
        assert!(stderr.contains("diagnostic"));
    }
}
