//! No-API mode is used by local/reap tests and skips all webhook calls.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide `LazyLock`s.

use guest_agent::error::AgentError;
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn no_api_mode_drains_background_webhook_users_without_network_client()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let run_id = format!("no-api-mode-{}", std::process::id());
    unsafe {
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_RUN_ID", &run_id);
        std::env::set_var("VM0_WORKING_DIR", tmp.path());
        std::env::set_var("VM0_PROMPT", "no api mode");
        std::env::set_var("HOME", tmp.path());
    }

    let http = HttpClient::for_current_env()?;

    let disabled = http
        .post_json("http://127.0.0.1:1/should-not-send", &json!({}), 1)
        .await;
    let Err(AgentError::Http(message)) = disabled else {
        return Err("direct HTTP use should fail when no API token is configured".into());
    };
    assert!(message.contains("HTTP client is disabled"));

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(Arc::clone(&masker), http.clone());
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await?;
    telemetry.shutdown().await;

    let shutdown = CancellationToken::new();
    let heartbeat = tokio::spawn(guest_agent::heartbeat::heartbeat_loop(
        http.clone(),
        shutdown.clone(),
    ));
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(1), heartbeat)
        .await
        .expect("heartbeat should exit promptly after shutdown in no-API mode")
        .expect("heartbeat task should not panic")?;

    let mut event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "session-no-api",
        "cwd": tmp.path().to_string_lossy(),
    });
    guest_agent::events::send_event(&http, &mut event, 1, &masker).await?;
    assert_eq!(
        std::fs::read_to_string(guest_agent::paths::session_id_file())?,
        "session-no-api"
    );

    guest_agent::complete::report_success(&http, "sandbox-no-api", "reused", Some(1)).await;

    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
    Ok(())
}
