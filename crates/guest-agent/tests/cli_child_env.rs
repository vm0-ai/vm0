//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::cli;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

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
    let rejected_config_dir = tmp.path().join("rejected-claude-config");

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var("VM0_SECRET_VALUES", "runner-secret-values");
        std::env::set_var(
            process_control_ipc::BOOTSTRAP_ENV,
            "runner-control-endpoint",
        );
        std::env::set_var(
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            "runner-control-endpoint",
        );
        std::env::set_var("VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true");
        std::env::set_var("NODE_EXTRA_CA_CERTS", "/rootfs/vm0-proxy-ca.crt");
        std::env::set_var("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("CARGO_HTTP_CAINFO", "/etc/ssl/certs/ca-certificates.crt");
        std::env::set_var("NPM_CONFIG_UPDATE_NOTIFIER", "false");
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("VM0_APPEND_SYSTEM_PROMPT", "runner append prompt");
        std::env::set_var("VM0_FEATURE_FLAGS", r#"{"flag":true}"#);
        std::env::set_var(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV, "60");
    }

    let run_id = std::env::var(guest_contracts::env::RUN_ID_ENV)?;
    let runtime_dir = guest_contracts::runtime_paths::run_dir_from_env(&run_id)?;
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&serde_json::json!({
            "CUSTOM_USER_ENV": "visible-to-cli",
            "BASH_ENV": "/tmp/user-bash-env",
            "VM0_API_BACKEND_URL": "https://user-env.example.invalid",
            "OPENAI_API_KEY": "sk-user",
            "HOME": user_home_str,
            "CLAUDE_CONFIG_DIR": rejected_config_dir,
            "NODE_EXTRA_CA_CERTS": "/tmp/user-ca.pem",
        }))?,
    )?;
    unsafe {
        std::env::set_var("VM0_USER_ENV_FILE", &user_env_path);
    }

    let runtime = GuestRuntime::from_process_env()?;
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());
    assert_eq!(runtime.config.home_dir, user_home_str);
    assert_eq!(
        runtime.config.claude_config_dir,
        tmp.path().join(".claude").to_string_lossy()
    );
    assert_eq!(
        runtime
            .config
            .user_env
            .get("CLAUDE_CONFIG_DIR")
            .map(String::as_str),
        rejected_config_dir.to_str()
    );

    unsafe {
        std::env::set_var("VM0_PROMPT", "stale prompt after runtime construction");
        std::env::set_var("VM0_API_BACKEND_URL", "https://stale-api.example.invalid");
        std::env::set_var("HOME", tmp.path().join("stale-home"));
    }

    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    let result = cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
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
        cli_env.get("VM0_API_BACKEND_URL").map(String::as_str),
        Some("http://127.0.0.1:1")
    );
    assert_eq!(
        cli_env.get("HOME").map(String::as_str),
        Some(user_home_str.as_str())
    );
    assert_eq!(
        cli_env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some(runtime.config.claude_config_dir.as_str())
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
    assert!(!cli_env.contains_key(guest_contracts::env::RUN_ID_ENV));
    assert!(!cli_env.contains_key("VM0_RUN_ID"));
    for key in [
        guest_contracts::env::PI_SESSION_ID_ENV,
        guest_contracts::env::PI_LAUNCH_CONFIG_ENV,
        guest_contracts::env::PI_LAUNCH_PAYLOAD_FILE_ENV,
        guest_contracts::env::PI_MODEL_CONFIG_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }
    assert!(!cli_env.contains_key("VM0_PROMPT"));
    assert!(!cli_env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    assert!(!cli_env.contains_key("VM0_SANDBOX_ID"));
    assert!(!cli_env.contains_key("VM0_SANDBOX_REUSE_RESULT"));
    assert!(!cli_env.contains_key("VM0_FEATURE_FLAGS"));
    assert!(!cli_env.contains_key(guest_contracts::env::AGENT_EXECUTION_TIMEOUT_SECS_ENV));
    assert!(!cli_env.contains_key("CLI_AGENT_TYPE"));
    for key in [
        process_control_ipc::BOOTSTRAP_ENV,
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }
    assert!(!cli_env.contains_key("VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL"));
    for key in [
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
    ] {
        assert!(
            !cli_env.contains_key(key),
            "Claude child env contains {key}"
        );
    }

    let session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let canonical_history = Path::new(&runtime.config.claude_config_dir)
        .join("projects/-home-user-workspace")
        .join(format!("{}.jsonl", session_id.trim()));
    assert!(canonical_history.exists());
    assert!(!common::claude_history_path_for_home(&user_home, session_id.trim()).exists());
    assert!(
        !rejected_config_dir
            .join("projects/-home-user-workspace")
            .join(format!("{}.jsonl", session_id.trim()))
            .exists()
    );

    assert_home_value_reaches_claude(
        &mock,
        &tmp.path().join("relative-home-case"),
        "relative-home",
    )
    .await?;
    assert_home_value_reaches_claude(&mock, &tmp.path().join("empty-home-case"), "").await?;

    Ok(())
}

async fn assert_home_value_reaches_claude(
    mock: &Path,
    workdir: &Path,
    home: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let claude_config_dir = workdir.join(".claude");
    let rejected_config_dir = workdir.join("rejected-claude-config");
    let instructions_path = claude_config_dir.join("CLAUDE.md");
    let skill_path = claude_config_dir.join("skills/test-skill/SKILL.md");
    let memory_path = claude_config_dir
        .join("projects/-home-user-workspace/memory")
        .join("MEMORY.md");
    for path in [&instructions_path, &skill_path, &memory_path] {
        std::fs::create_dir_all(path.parent().ok_or("managed file must have a parent")?)?;
        std::fs::write(path, "managed")?;
    }

    let observed_home = workdir.join("observed-home");
    let observed_config_dir = workdir.join("observed-claude-config-dir");
    let prompt = format!(
        "test -f \"$CLAUDE_CONFIG_DIR/CLAUDE.md\" && test -f \"$CLAUDE_CONFIG_DIR/skills/test-skill/SKILL.md\" && test -f \"$CLAUDE_CONFIG_DIR/projects/-home-user-workspace/memory/MEMORY.md\" && printf '%s' \"$HOME\" > {} && printf '%s' \"$CLAUDE_CONFIG_DIR\" > {}",
        observed_home.display(),
        observed_config_dir.display(),
    );

    unsafe {
        common::setup_env(mock, workdir, &prompt, 3, 1)?;
    }
    let run_id = std::env::var(guest_contracts::env::RUN_ID_ENV)?;
    let runtime_dir = guest_contracts::runtime_paths::run_dir_from_env(&run_id)?;
    let user_env = HashMap::from([
        ("HOME".to_string(), home.to_string()),
        (
            "CLAUDE_CONFIG_DIR".to_string(),
            rejected_config_dir.to_string_lossy().into_owned(),
        ),
    ]);
    unsafe {
        common::set_user_env_file_env_for_test(&runtime_dir, &user_env)?;
    }

    let runtime = GuestRuntime::from_process_env()?;
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    let result = cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
    )
    .await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(std::fs::read_to_string(observed_home)?, home);
    assert_eq!(
        std::fs::read_to_string(observed_config_dir)?,
        claude_config_dir.to_string_lossy()
    );

    let session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let history_path = claude_config_dir
        .join("projects/-home-user-workspace")
        .join(format!("{}.jsonl", session_id.trim()));
    assert!(history_path.exists());
    assert!(
        !rejected_config_dir
            .join("projects/-home-user-workspace")
            .join(format!("{}.jsonl", session_id.trim()))
            .exists()
    );
    Ok(())
}
