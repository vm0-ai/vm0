//! Codex setup should remove stale auth.json when no auth is configured.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

use guest_agent::masker::SecretMasker;
use std::time::Duration;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn codex_setup_no_auth_removes_stale_auth_json() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let user_env_dir = runtime_dir.join("user-env");
    let user_env_path = user_env_dir.join("env.json");
    let codex_home = tmp.path().join(".codex");
    let auth_path = codex_home.join("auth.json");

    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::write(&user_env_path, "{}")?;
    std::fs::create_dir_all(&codex_home)?;
    std::fs::write(
        &auth_path,
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"stale"}"#,
    )?;

    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, "codex-setup-no-auth");
        std::env::set_var(guest_contracts::env::USER_ENV_FILE_ENV, &user_env_path);
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        );
        std::env::set_var("HOME", tmp.path());
    }

    let masker = SecretMasker::from_raw("");
    tokio::time::timeout(
        Duration::from_secs(2),
        guest_agent::cli::setup_codex(&masker),
    )
    .await
    .expect("codex auth setup should return promptly")?;

    let err = std::fs::symlink_metadata(&auth_path).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);

    Ok(())
}
