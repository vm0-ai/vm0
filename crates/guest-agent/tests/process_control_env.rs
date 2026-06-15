//! The guest-agent process receives the process-control bootstrap endpoint, but
//! the child CLI must not inherit it.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide `LazyLock`s.

mod common;

use std::time::Duration;

#[tokio::test]
async fn process_control_endpoint_is_not_inherited_by_cli_child()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            r#"if [ -n "${VM0_PROCESS_CONTROL_ENDPOINT:-}" ]; then echo "process control endpoint leaked" >&2; exit 42; fi"#,
            3,
            1,
        )?;
        std::env::set_var(
            process_control_ipc::BOOTSTRAP_ENV,
            "stale-process-control-endpoint",
        );
    }

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(15),
        guest_agent::cli::execute_cli(
            &masker,
            heartbeat,
            guest_agent::http::HttpClient::new().unwrap(),
        ),
    )
    .await
    .expect("execute_cli did not return within 15s");

    let result = result.expect("execute_cli returned Err");
    assert_eq!(
        result.exit_code,
        common::CLEAN_EXIT,
        "CLI child inherited {}",
        process_control_ipc::BOOTSTRAP_ENV
    );
    Ok(())
}
