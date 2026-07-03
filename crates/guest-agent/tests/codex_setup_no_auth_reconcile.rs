//! Codex setup should remove stale auth.json when no auth is configured.
//!
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

    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "codex-setup-no-auth".to_string(),
        cli_agent_type: "codex".to_string(),
        user_env_file: user_env_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        home: Some(tmp.path().to_string_lossy().into_owned()),
        ..Default::default()
    })?;

    let masker = SecretMasker::from_raw("");
    tokio::time::timeout(
        Duration::from_secs(2),
        guest_agent::cli::setup_codex_for_config(&masker, &config),
    )
    .await
    .expect("codex auth setup should return promptly")?;

    let err = std::fs::symlink_metadata(&auth_path).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);

    Ok(())
}
