use ably_subscriber::{SubscribeConfig, TimingConfig};

use super::now_ms;

pub(crate) fn test_config(ws_port: u16, http_port: u16, channel: &str) -> SubscribeConfig {
    test_config_with_key_name(ws_port, http_port, channel, "testKey.testId")
}

pub(crate) fn test_config_with_key_name(
    ws_port: u16,
    http_port: u16,
    channel: &str,
    key_name: &str,
) -> SubscribeConfig {
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{http_port}");
    let channel = channel.to_string();
    let key_name = key_name.to_string();
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let key_name = key_name.clone();
            Box::pin(async {
                Ok(ably_subscriber::TokenRequest {
                    key_name,
                    timestamp: now_ms(),
                    nonce: "nonce-1".into(),
                    mac: "fake-mac".into(),
                    capability: r#"{"*":["subscribe"]}"#.into(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        channel,
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
    config
}

pub(crate) fn test_config_with_timing(
    ws_port: u16,
    http_port: u16,
    channel: &str,
    timing: TimingConfig,
) -> SubscribeConfig {
    let mut config = test_config(ws_port, http_port, channel);
    config.timing = Some(timing);
    config
}

pub(crate) fn test_config_with_pending_renewal(
    ws_port: u16,
    http_port: u16,
    channel: &str,
    renewal_started: tokio::sync::oneshot::Sender<()>,
) -> SubscribeConfig {
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{http_port}");
    let call_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let renewal_started = std::sync::Arc::new(std::sync::Mutex::new(Some(renewal_started)));
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let n = call_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let renewal_started = renewal_started.clone();
            Box::pin(async move {
                if n > 0 {
                    let tx = match renewal_started.lock() {
                        Ok(mut guard) => guard.take(),
                        Err(poisoned) => poisoned.into_inner().take(),
                    };
                    if let Some(tx) = tx {
                        let _ = tx.send(());
                    }
                    return std::future::pending::<
                        Result<ably_subscriber::TokenRequest, ably_subscriber::BoxError>,
                    >()
                    .await;
                }
                Ok(ably_subscriber::TokenRequest {
                    key_name: "testKey.testId".into(),
                    timestamp: now_ms(),
                    nonce: "nonce-1".into(),
                    mac: "fake-mac".into(),
                    capability: r#"{"*":["subscribe"]}"#.into(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        channel.to_string(),
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
    config
}
