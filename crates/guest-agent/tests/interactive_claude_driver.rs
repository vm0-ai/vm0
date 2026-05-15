//! Interactive Claude driver coverage lives in its own test binary because
//! guest_agent::env caches environment variables with process-wide LazyLocks.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn interactive_claude_driver_replays_mock_transcript()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "printf 'interactive-ok'", 3, 1)?;
        std::env::set_var("VM0_CLAUDE_DRIVER", "interactive");
    }

    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());

    let http = HttpClient::for_current_env()?;
    let masker = Arc::new(SecretMasker::from_raw(""));
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        guest_agent::cli::execute_cli(&masker, common::spawn_dummy_heartbeat(), http),
    )
    .await
    .expect("interactive execute_cli should return promptly")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, None);
    assert!(result.claude_result.is_some());

    let session_history_path =
        std::fs::read_to_string(guest_agent::paths::session_history_path_file())?;
    let session_history = std::fs::read_to_string(session_history_path.trim())?;
    assert!(session_history.contains("sessionId"));
    assert!(session_history.contains("interactive-ok"));

    let agent_log = std::fs::read_to_string(guest_agent::paths::agent_log_file())?;
    assert!(agent_log.contains("interactive-ok"));
    assert!(agent_log.contains("\"type\":\"result\""));
    Ok(())
}
