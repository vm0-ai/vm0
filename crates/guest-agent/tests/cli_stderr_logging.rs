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
    let mut stderr_payload = (0..(common::CLI_STDERR_RESULT_MAX_LINES + 1))
        .map(|i| {
            if i == 42 {
                String::new()
            } else {
                format!("line-{i}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let exact_limit_line = format!(
        "exact-limit-{}",
        "x".repeat(common::CLI_STDERR_RESULT_MAX_LINE_BYTES - "exact-limit-".len())
    );
    let exact_limit_crlf_line = format!(
        "exact-crlf-{}",
        "x".repeat(common::CLI_STDERR_RESULT_MAX_LINE_BYTES - "exact-crlf-".len())
    );
    let overlong_secret_line = format!(
        "overlong-secret-prefix-{secret}-{}",
        "x".repeat(common::CLI_STDERR_RESULT_MAX_LINE_BYTES)
    );
    assert_eq!(
        exact_limit_line.len(),
        common::CLI_STDERR_RESULT_MAX_LINE_BYTES
    );
    assert_eq!(
        exact_limit_crlf_line.len(),
        common::CLI_STDERR_RESULT_MAX_LINE_BYTES
    );

    stderr_payload.push_str(&format!("\n{exact_limit_crlf_line}\r"));
    stderr_payload.push_str(&format!("\n{exact_limit_line}"));
    stderr_payload.push_str(&format!("\ncodex stderr includes {secret}"));
    stderr_payload.push_str(&format!("\n{overlong_secret_line}"));
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
    assert_eq!(
        cli_result.stderr_lines.len(),
        common::CLI_STDERR_RESULT_MAX_LINES
    );
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
        cli_result.stderr_lines.iter().any(String::is_empty),
        "stderr result should preserve empty stderr lines, got: {stderr}"
    );
    assert!(
        cli_result
            .stderr_lines
            .iter()
            .any(|line| line == &exact_limit_crlf_line),
        "stderr result should strip trailing carriage returns, got: {stderr}"
    );
    assert!(
        !cli_result
            .stderr_lines
            .iter()
            .any(|line| line == &format!("{exact_limit_crlf_line}\r")),
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
        stderr.contains(common::CLI_STDERR_OMITTED_LONG_LINE),
        "stderr result should omit overlong lines, got: {stderr}"
    );
    assert!(
        !stderr.contains("overlong-secret-prefix"),
        "stderr result should not expose omitted overlong line content, got: {stderr}"
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
