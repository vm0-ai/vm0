//! Codex app-server setup must replace inherited API URL aliases.
//!
//! This test lives in its own binary to isolate process environment and working
//! directory mutations performed by `setup_codex_app_server_env`.

mod common;

const INHERITED_LEGACY_API_URL: &str = "https://inherited.example.invalid";

#[test]
fn codex_app_server_setup_clears_inherited_legacy_api_url() -> Result<(), Box<dyn std::error::Error>>
{
    let tmp = tempfile::tempdir()?;
    unsafe {
        std::env::set_var(guest_contracts::env::API_URL_ENV, INHERITED_LEGACY_API_URL);
        common::setup_codex_app_server_env(
            &tmp.path().join("unused-mock-codex"),
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-env-isolation-test",
                prompt: "verify isolated app-server setup",
                scenario: None,
                resume_session_id: None,
            },
        )?;
    }

    assert!(
        std::env::var_os(guest_contracts::env::API_URL_ENV).is_none(),
        "Codex app-server setup retained the inherited legacy API URL"
    );
    let installed_api_url = std::env::var(guest_contracts::env::CANONICAL_API_URL_ENV)?;
    let runtime = common::guest_runtime_from_process_env()?;
    assert_eq!(runtime.config.api_url, installed_api_url);
    assert_ne!(runtime.config.api_url, INHERITED_LEGACY_API_URL);

    Ok(())
}
