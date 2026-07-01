//! Production runtime bootstrap should fail fast when API auth is incomplete.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide once cells.

mod common;

#[test]
fn runtime_bootstrap_requires_api_url_when_api_token_is_set() {
    let tmp = tempfile::tempdir().unwrap();

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(
            guest_contracts::env::RUN_ID_ENV,
            "guest-runtime-missing-api-url",
        );
        std::env::set_var("HOME", tmp.path().join("home"));
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            tmp.path().join("runtime"),
        );
        std::env::set_var(guest_contracts::env::API_TOKEN_ENV, "test-token");
        std::env::set_var(guest_contracts::env::API_URL_ENV, "");
        std::env::remove_var(guest_contracts::env::USER_ENV_FILE_ENV);
    }

    let error = match guest_agent::run_context::GuestRuntime::from_process_env() {
        Ok(_) => panic!("missing API URL should fail fast"),
        Err(error) => error,
    };

    assert!(
        error.contains(guest_contracts::env::API_URL_ENV),
        "error should identify {}, got: {error}",
        guest_contracts::env::API_URL_ENV
    );
}
