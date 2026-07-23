mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use guest_agent::cli::codex_app_server::CodexAppServerConfig;
use guest_agent::codex_thread_path::{
    CodexThreadPathLookupError, resolve_codex_thread_path_with_config,
};
use guest_contracts::codex_thread_id::CodexThreadId;
use guest_contracts::codex_thread_path::CODEX_THREAD_PATH_LOOKUP_EXIT_INVALID_ARGS;
use guest_contracts::codex_thread_path::CodexThreadPathLookupReport;
use tempfile::TempDir;

const THREAD_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";
const EXPECTED_PATH: &str = "/home/user/.codex/sessions/2026/07/23/rollout-2026-07-23T04-01-04-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

static MOCK_CODEX_BUILD: OnceLock<Result<PathBuf, String>> = OnceLock::new();

#[test]
fn helper_rejects_missing_malformed_or_extra_thread_ids() {
    for args in [
        Vec::new(),
        vec!["not-a-thread-id"],
        vec![THREAD_ID, "extra"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_guest-agent"))
            .arg("resolve-codex-rollout-path")
            .args(args)
            .output()
            .unwrap();

        assert_eq!(
            output.status.code(),
            Some(CODEX_THREAD_PATH_LOOKUP_EXIT_INVALID_ARGS)
        );
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}

#[tokio::test]
async fn resolves_path_from_codex_thread_read() -> Result<(), String> {
    let (report, _codex_home) = resolve(None, LOOKUP_TIMEOUT).await?;

    assert_eq!(
        report,
        CodexThreadPathLookupReport::Found {
            path: EXPECTED_PATH.to_string()
        }
    );
    Ok(())
}

#[tokio::test]
async fn maps_only_codex_thread_not_found_to_not_found_report() -> Result<(), String> {
    let (report, _codex_home) = resolve(Some("thread-read-not-found"), LOOKUP_TIMEOUT).await?;

    assert_eq!(report, CodexThreadPathLookupReport::NotFound {});
    Ok(())
}

#[tokio::test]
async fn rejects_wrong_thread_and_missing_or_malformed_paths() -> Result<(), String> {
    for (scenario, expected) in [
        ("thread-read-wrong-thread", "different thread"),
        ("thread-read-null-path", "without a rollout path"),
        ("thread-read-malformed-result", "app-server lookup failed"),
    ] {
        let error = resolve_error(scenario, LOOKUP_TIMEOUT).await?;

        assert!(
            error.to_string().contains(expected),
            "scenario {scenario} returned {error}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn rejects_other_codex_rpc_errors() -> Result<(), String> {
    for scenario in ["thread-read-rpc-error", "thread-read-wrong-error-code"] {
        let error = resolve_error(scenario, LOOKUP_TIMEOUT).await?;

        assert!(matches!(error, CodexThreadPathLookupError::AppServer(_)));
        assert_eq!(error.to_string(), "Codex app-server lookup failed");
    }
    Ok(())
}

#[tokio::test]
async fn times_out_and_terminates_hung_thread_read() -> Result<(), String> {
    let error = resolve_error("hang-on-thread-read", Duration::from_millis(50)).await?;

    assert!(matches!(error, CodexThreadPathLookupError::Timeout));
    Ok(())
}

async fn resolve(
    scenario: Option<&str>,
    timeout: Duration,
) -> Result<(CodexThreadPathLookupReport, TempDir), String> {
    let codex_home = TempDir::new().map_err(|error| format!("create Codex home: {error}"))?;
    let config = config(codex_home.path(), scenario)?;
    let thread_id = CodexThreadId::parse(THREAD_ID)
        .ok_or_else(|| "test thread ID should be valid".to_string())?;
    let report = resolve_codex_thread_path_with_config(&thread_id, config, timeout)
        .await
        .map_err(|error| error.to_string())?;
    Ok((report, codex_home))
}

async fn resolve_error(
    scenario: &str,
    timeout: Duration,
) -> Result<CodexThreadPathLookupError, String> {
    let codex_home = TempDir::new().map_err(|error| format!("create Codex home: {error}"))?;
    let config = config(codex_home.path(), Some(scenario))?;
    let thread_id = CodexThreadId::parse(THREAD_ID)
        .ok_or_else(|| "test thread ID should be valid".to_string())?;
    match resolve_codex_thread_path_with_config(&thread_id, config, timeout).await {
        Ok(report) => Err(format!("lookup unexpectedly succeeded: {report:?}")),
        Err(error) => Ok(error),
    }
}

fn config(
    codex_home: &std::path::Path,
    scenario: Option<&str>,
) -> Result<CodexAppServerConfig, String> {
    let binary = MOCK_CODEX_BUILD
        .get_or_init(common::build_and_locate_mock_codex)
        .clone()?;
    let mut config = CodexAppServerConfig::new(binary, codex_home).with_child_env(
        codex_home.to_string_lossy(),
        &HashMap::new(),
        "http://127.0.0.1:1",
    );
    if let Some(scenario) = scenario {
        config = config.with_env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
    }
    Ok(config)
}
