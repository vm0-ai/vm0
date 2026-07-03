//! Production runtime bootstrap should install explicit guest-common paths.
//!
//! This test lives in its own binary to isolate process env captured by
//! `GuestRuntime::from_process_env`.

mod common;

use std::time::Duration;

#[test]
fn runtime_bootstrap_installs_system_log_and_sandbox_ops_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("runtime");

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(
            guest_contracts::env::RUN_ID_ENV,
            "guest-runtime-process-env",
        );
        std::env::set_var("HOME", tmp.path().join("home"));
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
        std::env::set_var(guest_contracts::env::API_TOKEN_ENV, "");
        std::env::remove_var(guest_contracts::env::USER_ENV_FILE_ENV);
    }

    let missing_payload_error = match guest_agent::run_context::GuestRuntime::from_process_env() {
        Ok(_) => panic!("missing run payload file should fail fast"),
        Err(error) => error,
    };
    assert!(
        missing_payload_error.contains(guest_contracts::env::RUN_PAYLOAD_FILE_ENV),
        "error should identify {}, got: {missing_payload_error}",
        guest_contracts::env::RUN_PAYLOAD_FILE_ENV
    );

    unsafe {
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "runtime process env prompt".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )
        .unwrap();
    }
    guest_common::log::clear_system_log_file();
    guest_common::telemetry::clear_sandbox_ops_log_file();

    let runtime = guest_agent::run_context::GuestRuntime::from_process_env().unwrap();

    assert_eq!(runtime.paths.runtime_dir(), runtime_dir.as_path());

    guest_common::log_info!(
        "sandbox:guest-agent-test",
        "runtime bootstrap system log marker"
    );
    guest_common::telemetry::record_sandbox_op(
        "runtime_bootstrap_sandbox_op",
        Duration::from_millis(7),
        true,
        None,
    );

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file()).unwrap();
    assert!(system_log.contains("runtime bootstrap system log marker"));

    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap();
    assert!(sandbox_ops.contains("runtime_bootstrap_sandbox_op"));
}
