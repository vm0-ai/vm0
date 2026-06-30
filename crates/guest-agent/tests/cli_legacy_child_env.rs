//! Legacy child-env coverage for callers that still use process-env facades.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::collections::BTreeMap;

#[tokio::test]
async fn legacy_execute_cli_reads_runner_visible_api_url_from_process_env()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let cli_env_path = tmp.path().join("legacy-cli-env.json");
    let prompt = format!("@write-env-json:{}", cli_env_path.display());

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
    }

    assert_eq!(guest_agent::env::api_url(), "http://127.0.0.1:1");
    unsafe {
        std::env::set_var("VM0_API_URL", "https://late-api.example.invalid");
    }

    let result = guest_agent::cli::execute_cli(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        HttpClient::new()?,
    )
    .await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    let cli_env: BTreeMap<String, String> = serde_json::from_slice(&std::fs::read(cli_env_path)?)?;
    assert_eq!(
        cli_env.get("VM0_API_URL").map(String::as_str),
        Some("https://late-api.example.invalid")
    );

    Ok(())
}
