//! Subscribe to an Ably channel using an API key.
//!
//! ```sh
//! cargo run -p ably-subscriber --example subscribe -- <API_KEY> <CHANNEL> [HOST]
//! ```
//!
//! Or pass the API key via environment variable:
//! ```sh
//! ABLY_API_KEY=keyName:keySecret cargo run -p ably-subscriber --example subscribe \
//!     -- <CHANNEL> [HOST]
//! ```
//!
//! `API_KEY` format: `keyName:keySecret` (from your Ably dashboard).
//! Message data is printed to stdout (pipe to `jq` for formatting).

use ably_subscriber::{Event, SubscribeConfig, subscribe};

mod common;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let env_key = std::env::var("ABLY_API_KEY").ok();

    let (api_key, channel, host) = if let Some(ref key) = env_key {
        let channel = args.first().ok_or("usage: subscribe <CHANNEL> [HOST]")?;
        (key.as_str(), channel.as_str(), args.get(1).cloned())
    } else {
        let api_key = args
            .first()
            .ok_or("usage: subscribe <API_KEY> <CHANNEL> [HOST]")?;
        let channel = args
            .get(1)
            .ok_or("usage: subscribe <API_KEY> <CHANNEL> [HOST]")?;
        (api_key.as_str(), channel.as_str(), args.get(2).cloned())
    };

    let (key_name, key_secret) = api_key
        .split_once(':')
        .ok_or("API_KEY must be in format keyName:keySecret")?;

    let key_name = key_name.to_string();
    let key_secret = key_secret.to_string();

    eprintln!("subscribing to '{channel}' ...");

    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let kn = key_name.clone();
            let ks = key_secret.clone();
            Box::pin(async move { common::create_token_request(&kn, &ks, common::ONE_HOUR_TTL_MS) })
        }),
        channel.to_string(),
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
