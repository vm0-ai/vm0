//! The guest-agent process receives the process-control bootstrap endpoint, but
//! the child CLI must not inherit it.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use std::process::Command;
use std::time::Duration;

#[test]
fn process_control_endpoint_without_workload_capability_fails_closed() {
    let output = Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env(process_control_ipc::BOOTSTRAP_ENV, "missing-capability")
        .env_remove(guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV)
        .env_remove("VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL")
        .output()
        .expect("spawn guest-agent");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV),
        "stderr: {stderr}"
    );
    assert!(stderr.contains("is required with"), "stderr: {stderr}");
}

#[test]
fn workload_capability_is_received_over_scm_rights_and_validated() {
    let nonce = *b"workload-fd-test";
    let endpoint = format!(
        "{}-workload-placement",
        process_control_ipc::endpoint_name(std::process::id(), &nonce)
    );
    let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
    let broker = std::thread::spawn(move || {
        use std::os::fd::AsFd;

        let stream = process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(5))
            .expect("guest-agent should connect to workload capability broker");
        let invalid_placement = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/null")
            .unwrap();
        process_control_ipc::send_workload_placement(&stream, invalid_placement.as_fd()).unwrap();
    });

    let output = Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env(
            process_control_ipc::BOOTSTRAP_ENV,
            "process-control-present",
        )
        .env(
            guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
            endpoint,
        )
        .env_remove("VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL")
        .output()
        .expect("spawn guest-agent");
    broker.join().unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("workload placement fd is not on cgroup v2"),
        "stderr: {stderr}"
    );
}

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
        std::env::set_var("VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true");
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
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
