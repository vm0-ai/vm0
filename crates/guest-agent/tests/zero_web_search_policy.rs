//! Zero runs must use managed web search instead of framework-native search.

mod common;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[tokio::test]
async fn zero_marker_disables_builtin_web_search_for_claude_and_codex() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;
    let root = tempfile::tempdir()?;
    let claude_mock = common::build_and_locate_mock()?;
    let codex_mock = common::build_and_locate_mock_codex()?;

    for (framework, real_mock) in [
        ("claude-code", claude_mock.as_path()),
        ("codex", codex_mock.as_path()),
    ] {
        let case_root = root.path().join(framework);
        std::fs::create_dir_all(&case_root)?;
        let args_path = case_root.join("args.txt");
        let wrapper_path = write_recording_wrapper(&case_root)?;
        let runtime = build_runtime(&case_root, framework, &wrapper_path, real_mock, &args_path)?;

        let result = execute(&runtime).await?;
        assert_eq!(result.exit_code, common::CLEAN_EXIT);

        let args = read_args(&args_path)?;
        if framework == "claude-code" {
            let disallowed_tools_index = args
                .iter()
                .position(|arg| arg == "--disallowed-tools")
                .ok_or("Claude command omitted --disallowed-tools")?;
            assert_eq!(
                &args[disallowed_tools_index + 1..disallowed_tools_index + 3],
                ["CronCreate", "WebSearch"]
            );
        } else {
            assert!(
                args.windows(2)
                    .any(|window| { window[0] == "-c" && window[1] == r#"web_search="disabled""# }),
                "Codex command omitted the disabled web-search config: {args:?}"
            );
        }
    }

    Ok(())
}

fn build_runtime(
    root: &Path,
    framework: &str,
    wrapper_path: &Path,
    real_mock: &Path,
    args_path: &Path,
) -> TestResult<GuestRuntime> {
    let run_id = format!("zero-web-search-{framework}");
    let home = root.join("home");
    let runtime_dir = root.join("runtime");
    std::fs::create_dir_all(&home)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "true".to_string(),
            disallowed_tools: "CronCreate".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let user_env_file = write_user_env_file(
        &runtime_dir,
        &HashMap::from([
            ("ZERO_AGENT_ID", "agent-zero-web-search"),
            (
                "TEST_ARGS_PATH",
                args_path.to_str().ok_or("args path must be valid UTF-8")?,
            ),
            (
                "TEST_REAL_MOCK",
                real_mock.to_str().ok_or("mock path must be valid UTF-8")?,
            ),
        ]),
    )?;
    let is_claude = framework == "claude-code";
    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id,
        api_url: "http://127.0.0.1:1".to_string(),
        sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
        sandbox_reuse_result: "reused".to_string(),
        use_mock_claude: is_claude.to_string(),
        mock_claude_path: is_claude.then(|| wrapper_path.to_string_lossy().into_owned()),
        cli_agent_type: framework.to_string(),
        user_env_file: user_env_file.to_string_lossy().into_owned(),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
        use_mock_codex: (!is_claude).to_string(),
        mock_codex_path: (!is_claude).then(|| wrapper_path.to_string_lossy().into_owned()),
        home: Some(home.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir.clone()),
        ..guest_agent::env::GuestConfigRaw::default()
    })
    .map_err(std::io::Error::other)?;
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let http = guest_agent::http::HttpClient::for_config(&config)?;

    Ok(GuestRuntime {
        config,
        paths,
        http,
    })
}

fn write_user_env_file(runtime_dir: &Path, user_env: &HashMap<&str, &str>) -> TestResult<PathBuf> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(&path, serde_json::to_vec(user_env)?)?;
    Ok(path)
}

fn write_recording_wrapper(root: &Path) -> TestResult<PathBuf> {
    let path = root.join("record-args");
    std::fs::write(
        &path,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TEST_ARGS_PATH\"\nexec \"$TEST_REAL_MOCK\" \"$@\"\n",
    )?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}

fn read_args(path: &Path) -> TestResult<Vec<String>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .map(str::to_string)
        .collect())
}

async fn execute(runtime: &GuestRuntime) -> TestResult<guest_agent::cli::CliExecutionResult> {
    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    Ok(guest_agent::cli::execute_cli_with_active_input_for_config(
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        active_input.into_writer(),
        &runtime.config,
        &runtime.paths,
    )
    .await?)
}
