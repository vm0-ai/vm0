//! CLI stderr logging must preserve diagnostics without leaking secrets.
//!
//! This test lives in its own binary because `guest_agent::env` and
//! `guest_agent::paths` cache values in process-wide `LazyLock`s.

mod common;

use base64::Engine;
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_stderr_is_masked_in_result() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let secret = "super-secret-value";
    let mut stderr_payload = (0..201)
        .map(|i| format!("line-{i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let exact_limit_line = format!(
        "exact-limit-{}",
        "x".repeat(16 * 1024 - "exact-limit-".len())
    );
    assert_eq!(exact_limit_line.len(), 16 * 1024);

    stderr_payload.push_str("\ncrlf-line\r");
    stderr_payload.push_str(&format!("\n{exact_limit_line}"));
    stderr_payload.push_str(&format!("\ncodex stderr includes {secret}"));
    stderr_payload.push_str(&format!("\n{}", "x".repeat(16 * 1024 + 1)));
    stderr_payload.push_str("\nafter-overlong-line");

    unsafe {
        common::setup_env(&mock, tmp.path(), &format!("@fail:{stderr_payload}"), 3, 1)?;
    }

    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = SecretMasker::from_raw(&encoded_secret);
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, 1);
    assert_eq!(cli_result.stderr_lines.len(), 200);
    let stderr = cli_result.stderr_lines.join("\n");
    assert_eq!(
        cli_result.stderr_lines.first().map(String::as_str),
        Some("line-6")
    );
    assert!(
        !cli_result.stderr_lines.iter().any(|line| line == "line-5"),
        "stderr result should drop old lines from the bounded tail, got: {stderr}"
    );
    assert!(
        cli_result
            .stderr_lines
            .iter()
            .any(|line| line == "crlf-line"),
        "stderr result should strip trailing carriage returns, got: {stderr}"
    );
    assert!(
        !cli_result
            .stderr_lines
            .iter()
            .any(|line| line == "crlf-line\r"),
        "stderr result should not keep trailing carriage returns, got: {stderr}"
    );
    assert!(
        stderr.contains("codex stderr includes ***"),
        "stderr result should keep masked diagnostic, got: {stderr}"
    );
    assert!(
        cli_result
            .stderr_lines
            .iter()
            .any(|line| line == &exact_limit_line),
        "stderr result should keep lines at the exact size limit, got: {stderr}"
    );
    assert!(
        stderr.contains("[stderr line omitted: exceeded diagnostic size limit]"),
        "stderr result should omit overlong lines, got: {stderr}"
    );
    assert!(
        stderr.contains("after-overlong-line"),
        "stderr result should recover after overlong lines, got: {stderr}"
    );
    assert!(
        !stderr.contains(secret),
        "stderr result leaked secret: {stderr}"
    );

    Ok(())
}
