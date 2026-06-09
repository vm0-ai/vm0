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
    let user_home = tmp.path().join("user-home");
    let user_home_str = user_home
        .to_str()
        .ok_or("test user HOME path must be UTF-8")?
        .to_string();

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var("VM0_SECRET_VALUES", "runner-secret-values");
        std::env::set_var(
            process_control_ipc::BOOTSTRAP_ENV,
            "runner-control-endpoint",
        );
        std::env::set_var("NODE_EXTRA_CA_CERTS", "/rootfs/vm0-proxy-ca.crt");
        std::env::set_var("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("CARGO_HTTP_CAINFO", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("NPM_CONFIG_UPDATE_NOTIFIER", "false");
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("VM0_APPEND_SYSTEM_PROMPT", "runner append prompt");
        std::env::set_var("VM0_FEATURE_FLAGS", r#"{"flag":true}"#);
    }

    let run_id = std::env::var("VM0_RUN_ID")?;
    let runtime_dir = guest_runtime_paths::run_dir_from_env(&run_id)?;
    let user_env_dir = runtime_dir.join("user-env");
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join("env.json");
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "CUSTOM_USER_ENV": "visible-to-cli",
            "BASH_ENV": "/tmp/user-bash-env",
            "VM0_API_URL": "https://user-env.example.invalid",
            "OPENAI_API_KEY": "sk-user",
            "HOME": user_home_str,
            "NODE_EXTRA_CA_CERTS": "/tmp/user-ca.pem",
        }))?,
    )?;
    unsafe {
        std::env::set_var("VM0_USER_ENV_FILE", &user_env_path);
    }

    guest_agent::env::init_user_env()?;
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());
    assert_eq!(guest_agent::env::home_dir(), user_home_str);

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
    assert_eq!(
        cli_env.get("VM0_API_URL").map(String::as_str),
        Some("http://127.0.0.1:1")
    );
    assert_eq!(
        cli_env.get("HOME").map(String::as_str),
        Some(user_home_str.as_str())
    );
    assert_eq!(
        cli_env.get("NODE_EXTRA_CA_CERTS").map(String::as_str),
        Some("/tmp/user-ca.pem")
    );
    assert_eq!(
        cli_env.get("SSL_CERT_FILE").map(String::as_str),
        Some("/etc/ssl/certs/ca-certificates.crt")
    );
    assert_eq!(
        cli_env.get("REQUESTS_CA_BUNDLE").map(String::as_str),
        Some("/etc/ssl/certs/ca-certificates.crt")
    );
    assert_eq!(
        cli_env.get("CARGO_HTTP_CAINFO").map(String::as_str),
        Some("/etc/ssl/certs/ca-certificates.crt")
    );
    assert_eq!(
        cli_env
            .get("NPM_CONFIG_UPDATE_NOTIFIER")
            .map(String::as_str),
        Some("false")
    );
    assert!(cli_env.contains_key("PATH"));

    assert!(!cli_env.contains_key("VM0_SECRET_VALUES"));
    assert!(!cli_env.contains_key("VM0_USER_ENV_FILE"));
    assert!(!cli_env.contains_key("VM0_RUN_ID"));
    assert!(!cli_env.contains_key("VM0_PROMPT"));
    assert!(!cli_env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    assert!(!cli_env.contains_key("VM0_SANDBOX_ID"));
    assert!(!cli_env.contains_key("VM0_SANDBOX_REUSE_RESULT"));
    assert!(!cli_env.contains_key("VM0_FEATURE_FLAGS"));
    assert!(!cli_env.contains_key("CLI_AGENT_TYPE"));
    assert!(!cli_env.contains_key(process_control_ipc::BOOTSTRAP_ENV));

    Ok(())
}
