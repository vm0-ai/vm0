//! Child-env snapshot coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_child_env_uses_runtime_snapshot()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let run_id = "codex-app-server-backend-child-env-test";
    let prompt = "runtime child env prompt";

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id,
                prompt,
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
    }

    let runtime_dir = guest_contracts::runtime_paths::run_dir_from_env(run_id)?;
    let user_env_dir = runtime_dir.join("user-env");
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join("env.json");
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&json!({
            "CUSTOM_USER_ENV": "visible-to-app-server",
            "OPENAI_MODEL": "gpt-runtime-model",
            "VM0_API_URL": "https://user-env.example.invalid"
        }))?,
    )?;
    unsafe {
        std::env::set_var("VM0_USER_ENV_FILE", &user_env_path);
    }

    let runtime = GuestRuntime::from_process_env()?;
    assert!(!user_env_path.exists());
    assert!(!user_env_dir.exists());

    unsafe {
        std::env::set_var("HOME", tmp.path().join("stale-home"));
        std::env::set_var("VM0_API_URL", "https://stale-api.example.invalid");
        std::env::set_var("VM0_PROMPT", "stale prompt after runtime construction");
        std::env::set_var("CUSTOM_USER_ENV", "stale-process-user-env");
    }

    let active_input = guest_agent::active_input::ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &SecretMasker::from_config(&runtime.config),
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;
    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    let stored_session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert!(!stored_session_id.trim().is_empty());
    assert!(Path::new(runtime.paths.session_history_path_file()).exists());
    let stale_paths = guest_agent::paths::GuestPaths::from_home(
        tmp.path().join("stale-home"),
        &runtime.config.run_id,
    )?;
    assert!(!Path::new(stale_paths.session_id_file()).exists());
    assert!(!Path::new(stale_paths.session_history_path_file()).exists());

    let input_event = find_mock_input_event(&Path::new(&runtime.config.home_dir).join(".codex"))?;
    assert_eq!(
        input_event.get("text").and_then(Value::as_str),
        Some(prompt)
    );
    assert_eq!(
        input_event.get("child_env_home").and_then(Value::as_str),
        Some(runtime.config.home_dir.as_str())
    );
    assert_eq!(
        input_event.get("child_env_api_url").and_then(Value::as_str),
        Some(runtime.config.api_url.as_str())
    );
    assert_eq!(
        input_event
            .get("child_env_custom_user_env")
            .and_then(Value::as_str),
        Some("visible-to-app-server")
    );
    assert_eq!(
        input_event
            .get("child_env_openai_model")
            .and_then(Value::as_str),
        Some("gpt-runtime-model")
    );

    Ok(())
}

fn find_mock_input_event(codex_home: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    for path in session_jsonl_files(&codex_home.join("sessions"))? {
        let decoded = std::fs::read_to_string(path)?;
        for line in decoded.lines().filter(|line| !line.is_empty()) {
            let event: Value = serde_json::from_str(line)?;
            if event.get("type").and_then(Value::as_str) == Some("mock.app_server.input") {
                return Ok(event);
            }
        }
    }
    Err("missing mock app-server input event".into())
}

fn session_jsonl_files(root: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension() == Some(OsStr::new("jsonl")) {
                files.push(path);
            }
        }
    }
    Ok(files)
}
