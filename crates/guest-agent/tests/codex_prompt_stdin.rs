//! Ordinary Codex prompts must cross the child-process boundary through stdin.

mod common;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use shell_quote::quote_shell_arg;
use std::path::{Path, PathBuf};
use std::time::Duration;

const PRODUCTION_PROMPT_BYTES: usize = 140_421;
const RESUME_THREAD_ID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const CODEX_FIXED_STARTUP_CONFIGS: [&str; 3] = [
    "analytics.enabled=false",
    "features.plugins=false",
    "features.apps=false",
];

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[tokio::test]
async fn fresh_and_resumed_codex_prompts_cross_size_boundaries_through_stdin() -> TestResult {
    let mock = common::build_and_locate_mock_codex()?;
    let root = tempfile::tempdir()?;
    common::ensure_canonical_workspace_for_test()?;
    let sizes = [
        guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES - 1,
        guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES,
        guest_contracts::exec_limits::EXECVE_STRING_MAX_BYTES + 1,
        PRODUCTION_PROMPT_BYTES,
    ];

    for resume in [false, true] {
        for size in sizes {
            let prompt = sized_prompt(size);
            let run_id = format!(
                "codex-stdin-{}-{size}",
                if resume { "resume" } else { "fresh" }
            );
            let runtime = build_runtime(root.path(), &mock, &run_id, &prompt, resume)?;

            let events = execute_and_read_session(&runtime).await?;

            assert_eq!(events[1]["item"]["text"], prompt);
        }
    }

    Ok(())
}

#[tokio::test]
async fn fresh_and_resumed_codex_stdin_preserve_prompt_text_exactly() -> TestResult {
    let mock = common::build_and_locate_mock_codex()?;
    let root = tempfile::tempdir()?;
    common::ensure_canonical_workspace_for_test()?;
    let prompt = " \n--option-looking user text\n中文 and emoji 🚀\nliteral dash: -\n ";

    for resume in [false, true] {
        let run_id = format!(
            "codex-stdin-text-{}",
            if resume { "resume" } else { "fresh" }
        );
        let runtime = build_runtime(root.path(), &mock, &run_id, prompt, resume)?;

        let events = execute_and_read_session(&runtime).await?;

        assert_eq!(events[1]["item"]["text"], prompt);
    }

    Ok(())
}

#[tokio::test]
async fn fresh_and_resumed_codex_apply_fixed_startup_policy() -> TestResult {
    let mock = common::build_and_locate_mock_codex()?;
    let root = tempfile::tempdir()?;
    let argv_path = root.path().join("codex-argv");
    let recording_mock = recording_codex(root.path(), &mock, &argv_path)?;
    common::ensure_canonical_workspace_for_test()?;

    for resume in [false, true] {
        let run_id = format!(
            "codex-startup-policy-{}",
            if resume { "resume" } else { "fresh" }
        );
        let runtime = build_runtime(root.path(), &recording_mock, &run_id, "hello", resume)?;

        let result = execute_with_timeout(&runtime).await?;

        assert_eq!(result.exit_code, common::CLEAN_EXIT);
        assert_fixed_startup_policy(&argv_path)?;
    }

    Ok(())
}

#[tokio::test]
async fn codex_exit_before_reading_stdin_preserves_exit_and_stderr() -> TestResult {
    let root = tempfile::tempdir()?;
    common::ensure_canonical_workspace_for_test()?;
    let mock = executable_script(
        root.path(),
        "codex-early-exit",
        "#!/bin/sh\necho 'codex auth failed before stdin' >&2\nexit 7\n",
    )?;
    let prompt = "x".repeat(PRODUCTION_PROMPT_BYTES);
    let runtime = build_runtime(root.path(), &mock, "codex-stdin-early-exit", &prompt, false)?;

    let result = execute_with_timeout(&runtime).await?;

    assert_eq!(result.exit_code, 7);
    assert_eq!(result.stderr_lines, vec!["codex auth failed before stdin"]);
    assert!(result.control_error.is_none());
    Ok(())
}

#[tokio::test]
async fn codex_can_exit_successfully_without_reading_stdin() -> TestResult {
    let root = tempfile::tempdir()?;
    common::ensure_canonical_workspace_for_test()?;
    let mock = executable_script(root.path(), "codex-ignore-stdin", "#!/bin/sh\nexit 0\n")?;
    let prompt = "x".repeat(PRODUCTION_PROMPT_BYTES);
    let runtime = build_runtime(root.path(), &mock, "codex-stdin-unread", &prompt, false)?;

    let result = execute_with_timeout(&runtime).await?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.stderr_lines.is_empty());
    assert!(result.control_error.is_none());
    Ok(())
}

fn sized_prompt(size: usize) -> String {
    let prefix = "stdin-boundary\n--option-looking-prefix\n";
    let suffix = "\nend";
    assert!(size >= prefix.len() + suffix.len());
    let mut prompt = String::with_capacity(size);
    prompt.push_str(prefix);
    prompt.push_str(&"x".repeat(size - prefix.len() - suffix.len()));
    prompt.push_str(suffix);
    assert_eq!(prompt.len(), size);
    prompt
}

fn build_runtime(
    root: &Path,
    mock_path: &Path,
    run_id: &str,
    prompt: &str,
    resume: bool,
) -> TestResult<GuestRuntime> {
    let home = root.join(format!("home-{run_id}"));
    let runtime_dir = home.join("runtime");
    std::fs::create_dir_all(&home)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: prompt.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: run_id.to_string(),
        api_url: "http://127.0.0.1:1".to_string(),
        api_token: String::new(),
        sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
        sandbox_reuse_result: "reused".to_string(),
        resume_session_id: if resume {
            RESUME_THREAD_ID.to_string()
        } else {
            String::new()
        },
        use_mock_codex: "true".to_string(),
        mock_codex_path: Some(mock_path.to_string_lossy().into_owned()),
        cli_agent_type: "codex".to_string(),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
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

async fn execute_and_read_session(runtime: &GuestRuntime) -> TestResult<Vec<serde_json::Value>> {
    let result = execute_with_timeout(runtime).await?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    common::read_codex_session_history_events_for_paths(&runtime.paths)
}

async fn execute_with_timeout(
    runtime: &GuestRuntime,
) -> TestResult<guest_agent::cli::CliExecutionResult> {
    let masker = SecretMasker::from_raw("");
    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &masker,
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .map_err(|_| std::io::Error::other("ordinary Codex execution timed out"))??;
    Ok(result)
}

fn executable_script(root: &Path, name: &str, contents: &str) -> TestResult<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let path = root.join(name);
    std::fs::write(&path, contents)?;
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&path, permissions)?;
    Ok(path)
}

fn recording_codex(root: &Path, mock: &Path, argv_path: &Path) -> TestResult<PathBuf> {
    executable_script(
        root,
        "recording-codex",
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nexec {} \"$@\"\n",
            quote_shell_arg(&argv_path.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        ),
    )
}

fn assert_fixed_startup_policy(argv_path: &Path) -> TestResult {
    let args = std::fs::read_to_string(argv_path)?
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    for expected in CODEX_FIXED_STARTUP_CONFIGS {
        assert!(
            args.windows(2)
                .any(|window| matches!(window, [flag, value] if flag == "-c" && value == expected)),
            "Codex argv should include fixed startup config {expected:?}: {args:?}"
        );
    }
    Ok(())
}
