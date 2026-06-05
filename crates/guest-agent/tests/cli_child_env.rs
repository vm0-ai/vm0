//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide `LazyLock`s.

mod common;

use guest_agent::cli;
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::collections::BTreeMap;

#[tokio::test]
async fn execute_cli_injects_user_env_without_runner_owned_bootstrap_env()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let cli_env_path = tmp.path().join("cli-env.json");
    let prompt = format!("@write-env-json:{}", cli_env_path.display());

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var("VM0_SECRET_VALUES", "runner-secret-values");
        std::env::set_var(
            process_control_ipc::BOOTSTRAP_ENV,
            "runner-control-endpoint",
        );
    }

    let user_env_dir = tmp.path().join("vm0-user-env-test");
    std::fs::create_dir(&user_env_dir)?;
    let user_env_path = user_env_dir.join("env.json");
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "CUSTOM_USER_ENV": "visible-to-cli",
            "BASH_ENV": "/tmp/user-bash-env",
            "OPENAI_API_KEY": "sk-user",
        }))?,
    )?;
    unsafe {
        std::env::set_var("VM0_USER_ENV_FILE", &user_env_path);
    }

    guest_agent::env::init_user_env()?;
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());

    let result = cli::execute_cli(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        HttpClient::for_current_env()?,
    )
    .await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    let cli_env: BTreeMap<String, String> = serde_json::from_slice(&std::fs::read(&cli_env_path)?)?;

    assert_eq!(
        cli_env.get("CUSTOM_USER_ENV").map(String::as_str),
        Some("visible-to-cli")
    );
    assert_eq!(
        cli_env.get("BASH_ENV").map(String::as_str),
        Some("/tmp/user-bash-env")
    );
    assert_eq!(
        cli_env.get("OPENAI_API_KEY").map(String::as_str),
        Some("sk-user")
    );
    assert_eq!(cli_env.get("HOME").map(String::as_str), tmp.path().to_str());
    assert!(cli_env.contains_key("PATH"));

    assert!(!cli_env.contains_key("VM0_SECRET_VALUES"));
    assert!(!cli_env.contains_key("VM0_USER_ENV_FILE"));
    assert!(!cli_env.contains_key(process_control_ipc::BOOTSTRAP_ENV));

    Ok(())
}
