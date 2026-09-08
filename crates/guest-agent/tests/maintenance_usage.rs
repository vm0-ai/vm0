//! Integration coverage for the private Pi maintenance usage boundary.

use std::path::{Path, PathBuf};
use std::time::Duration;

use api_contracts::generated::types::webhooks::agent::pi_memory_phase2::usage::{
    Request, RequestAttempt, RequestAttemptUsage,
};
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use httpmock::Mock;
use httpmock::prelude::*;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const RUN_ID: &str = "maintenance-usage-integration";
const USAGE_PATH: &str = "/api/webhooks/agent/pi-memory-phase2/usage";

fn write_run_payload(runtime_dir: &Path) -> TestResult<PathBuf> {
    let path = runtime_dir
        .join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
        .join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let payload = guest_contracts::env::RunPayload {
        pi_launch_config: r#"{"schemaVersion":2,"maintenance":{}}"#.to_string(),
        ..guest_contracts::env::RunPayload::default()
    };
    guest_contracts::runtime_paths::write_private(&path, serde_json::to_vec(&payload)?)?;
    Ok(path)
}

fn test_runtime(root: &Path, server: &MockServer) -> TestResult<GuestRuntime> {
    let runtime_dir = root.join("runtime");
    let run_payload_file = write_run_payload(&runtime_dir)?;
    let config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: RUN_ID.to_string(),
        api_url: server.base_url(),
        api_token: "test-token".to_string(),
        cli_agent_type: "pi".to_string(),
        home: Some(root.join("home").to_string_lossy().into_owned()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir.clone()),
        ..GuestConfigRaw::default()
    })?;
    let http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?;
    Ok(GuestRuntime {
        config,
        paths: GuestPaths::from_runtime_dir(runtime_dir),
        http,
        workload_containment: None,
        process_control_endpoint: None,
    })
}

fn usage_path(runtime: &GuestRuntime) -> PathBuf {
    Path::new(runtime.paths.pi_launch_payload_file()).with_file_name("maintenance-usage.json")
}

fn usage_request() -> Request {
    Request {
        schema_version: 1,
        run_id: RUN_ID.to_string(),
        memory_storage_id: "01234567-89ab-cdef-0123-456789abcdef".to_string(),
        lease_token: "11111111-2222-4333-8444-555555555555".to_string(),
        claimed_revision: 7,
        claimed_base_version_id: "base-version".to_string(),
        selection_digest: "a".repeat(64),
        attempts: vec![RequestAttempt {
            response_id: "response-1".to_string(),
            usage: RequestAttemptUsage {
                input: 11,
                output: 12,
                cache_read: 13,
                cache_write: 14,
                reasoning: 15,
            },
        }],
    }
}

fn usage_mock<'a>(server: &'a MockServer) -> Mock<'a> {
    server.mock(|when, then| {
        when.method(POST).path(USAGE_PATH);
        then.status(200);
    })
}

async fn assert_invalid_without_post(runtime: &GuestRuntime, usage: &Mock<'_>) -> TestResult {
    let error = match guest_agent::maintenance_usage::report_for_runtime(runtime).await {
        Ok(()) => return Err("unsafe maintenance usage was accepted".into()),
        Err(error) => error,
    };

    assert_eq!(
        error.to_string(),
        "execution: Invalid private maintenance usage"
    );
    usage.assert_calls(0);
    Ok(())
}

#[tokio::test]
async fn valid_private_journal_is_posted() -> TestResult {
    let server = MockServer::start();
    let temp = tempfile::tempdir()?;
    let runtime = test_runtime(temp.path(), &server)?;
    let request = usage_request();
    guest_contracts::runtime_paths::write_private(
        usage_path(&runtime),
        serde_json::to_vec(&request)?,
    )?;
    let expected = serde_json::to_value(&request)?;
    let usage = server.mock(|when, then| {
        when.method(POST)
            .path(USAGE_PATH)
            .header("Authorization", "Bearer test-token")
            .header("Content-Type", "application/json")
            .json_body(expected);
        then.status(200);
    });

    guest_agent::maintenance_usage::report_for_runtime(&runtime).await?;

    usage.assert_calls(1);
    Ok(())
}

#[tokio::test]
async fn missing_journal_preserves_compatibility_without_posting() -> TestResult {
    let server = MockServer::start();
    let temp = tempfile::tempdir()?;
    let runtime = test_runtime(temp.path(), &server)?;
    let usage = usage_mock(&server);

    guest_agent::maintenance_usage::report_for_runtime(&runtime).await?;

    usage.assert_calls(0);
    Ok(())
}

#[tokio::test]
async fn oversized_private_journal_is_rejected_without_posting() -> TestResult {
    let server = MockServer::start();
    let temp = tempfile::tempdir()?;
    let runtime = test_runtime(temp.path(), &server)?;
    guest_contracts::runtime_paths::write_private(
        usage_path(&runtime),
        vec![b'x'; 256 * 1024 + 1],
    )?;
    let usage = usage_mock(&server);

    assert_invalid_without_post(&runtime, &usage).await
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_journal_is_rejected_without_reading_target() -> TestResult {
    use std::os::unix::fs::symlink;

    let server = MockServer::start();
    let temp = tempfile::tempdir()?;
    let runtime = test_runtime(temp.path(), &server)?;
    let target = temp.path().join("outside-usage.json");
    let target_bytes = serde_json::to_vec(&usage_request())?;
    std::fs::write(&target, &target_bytes)?;
    guest_contracts::runtime_paths::ensure_parent_dir(usage_path(&runtime))?;
    symlink(&target, usage_path(&runtime))?;
    let usage = usage_mock(&server);

    assert_invalid_without_post(&runtime, &usage).await?;

    assert_eq!(std::fs::read(target)?, target_bytes);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn permissive_journal_is_rejected_without_posting() -> TestResult {
    use std::os::unix::fs::PermissionsExt;

    let server = MockServer::start();
    let temp = tempfile::tempdir()?;
    let runtime = test_runtime(temp.path(), &server)?;
    let path = usage_path(&runtime);
    guest_contracts::runtime_paths::write_private(&path, serde_json::to_vec(&usage_request())?)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
    let usage = usage_mock(&server);

    assert_invalid_without_post(&runtime, &usage).await
}
