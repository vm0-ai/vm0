//! Ordinary Codex resumes must not remain alive after emitting only the
//! synthetic `thread.started` startup record.

mod common;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::masker::SecretMasker;
use guest_agent::run_context::GuestRuntime;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::path::{Path, PathBuf};
use std::time::Duration;

const RESUME_THREAD_ID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const FIXTURE_READY: &str = "codex-resume-fixture-ready";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[tokio::test]
async fn resumed_codex_without_real_lifecycle_is_reaped_without_retry() -> TestResult {
    let root = tempfile::tempdir()?;
    common::ensure_canonical_workspace_for_test()?;
    let mock = executable_script(root.path(), "stalled-codex", &stalled_script())?;
    let runtime = build_runtime(root.path(), &mock, "stalled-resume", true)?;
    let agent_log = runtime.paths.agent_log_file().to_string();
    let execution = spawn_execution(runtime);

    common::wait_for_file_contains(Path::new(&agent_log), FIXTURE_READY, Duration::from_secs(5))
        .await?;

    tokio::time::pause();
    advance_until_finished(&execution, 70).await;
    tokio::time::resume();

    let result = await_execution(execution).await?;
    let error = result
        .control_error
        .as_ref()
        .ok_or("stalled Codex resume should return a control error")?;
    assert!(
        error.to_string().contains(
            "Codex resume startup timeout: no turn lifecycle event received within 60 seconds after thread.started"
        ),
        "unexpected control error: {error}"
    );

    let termination = result
        .cli_termination
        .ok_or("stalled Codex resume should record controlled termination")?;
    assert_eq!(
        termination.reason,
        CliTerminationReason::CodexResumeStartupTimeout
    );
    assert!(matches!(
        termination.signal_sent,
        Some(CliTerminationSignal::Sigterm | CliTerminationSignal::Sigkill)
    ));

    let invocations = std::fs::read_to_string(root.path().join("invocations"))?;
    assert_eq!(
        invocations.lines().count(),
        1,
        "the stalled turn must fail without starting a retry"
    );
    Ok(())
}

#[tokio::test]
async fn resumed_codex_real_lifecycle_disarms_startup_timeout() -> TestResult {
    for (name, lifecycle_event) in [
        ("turn-started", r#"{"type":"turn.started"}"#),
        ("item-started", r#"{"type":"item.started"}"#),
    ] {
        let root = tempfile::tempdir()?;
        common::ensure_canonical_workspace_for_test()?;
        let mock = executable_script(
            root.path(),
            "healthy-codex",
            &waiting_script(Some(lifecycle_event)),
        )?;
        let runtime = build_runtime(root.path(), &mock, name, true)?;
        let agent_log = runtime.paths.agent_log_file().to_string();
        let execution = spawn_execution(runtime);

        common::wait_for_file_contains(
            Path::new(&agent_log),
            FIXTURE_READY,
            Duration::from_secs(5),
        )
        .await?;

        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        assert!(
            !execution.is_finished(),
            "real lifecycle event {name} should permanently disarm the startup timeout"
        );
        std::fs::write(root.path().join("release"), "")?;
        tokio::time::resume();

        let result = await_execution(execution).await?;
        assert_eq!(result.exit_code, common::CLEAN_EXIT);
        assert!(result.control_error.is_none());
        assert!(result.cli_termination.is_none());
    }
    Ok(())
}

#[tokio::test]
async fn fresh_codex_does_not_arm_resume_startup_timeout() -> TestResult {
    let root = tempfile::tempdir()?;
    common::ensure_canonical_workspace_for_test()?;
    let mock = executable_script(root.path(), "fresh-codex", &waiting_script(None))?;
    let runtime = build_runtime(root.path(), &mock, "fresh-codex", false)?;
    let agent_log = runtime.paths.agent_log_file().to_string();
    let execution = spawn_execution(runtime);

    common::wait_for_file_contains(Path::new(&agent_log), FIXTURE_READY, Duration::from_secs(5))
        .await?;

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::task::yield_now().await;
    assert!(
        !execution.is_finished(),
        "fresh Codex executions must not use the resume-only startup timeout"
    );
    std::fs::write(root.path().join("release"), "")?;
    tokio::time::resume();

    let result = await_execution(execution).await?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(result.cli_termination.is_none());
    Ok(())
}

fn build_runtime(
    root: &Path,
    mock_path: &Path,
    run_id: &str,
    resume: bool,
) -> TestResult<GuestRuntime> {
    let home = root.join("home");
    let runtime_dir = home.join("runtime");
    std::fs::create_dir_all(&home)?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "test prompt".to_string(),
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
    std::fs::create_dir_all(
        Path::new(paths.agent_log_file())
            .parent()
            .ok_or("agent log path should have a parent")?,
    )?;
    let http = guest_agent::http::HttpClient::for_config(&config)?;
    Ok(GuestRuntime {
        config,
        paths,
        http,
    })
}

fn spawn_execution(
    runtime: GuestRuntime,
) -> tokio::task::JoinHandle<
    Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError>,
> {
    tokio::spawn(async move {
        let active_input = ActiveInputRuntime::new_with_initial_prompt(
            &runtime.config.run_id,
            false,
            &runtime.config.prompt,
        );
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        )
        .await
    })
}

async fn advance_until_finished<T>(execution: &tokio::task::JoinHandle<T>, seconds: u64) {
    for _ in 0..seconds {
        if execution.is_finished() {
            return;
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
}

async fn await_execution(
    execution: tokio::task::JoinHandle<
        Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError>,
    >,
) -> TestResult<guest_agent::cli::CliExecutionResult> {
    let joined = tokio::time::timeout(Duration::from_secs(10), execution)
        .await
        .map_err(|_| std::io::Error::other("ordinary Codex fixture did not exit"))?;
    let executed = joined.map_err(std::io::Error::other)?;
    Ok(executed?)
}

fn stalled_script() -> String {
    let mut script = script_prelude();
    script.push_str("printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"0199a213-81c0-7800-8aa1-bbab2a035a53\"}'\n");
    script.push_str(&format!("printf '%s\\n' '{FIXTURE_READY}'\n"));
    script.push_str("while :; do sleep 1; done\n");
    script
}

fn waiting_script(lifecycle_event: Option<&str>) -> String {
    let mut script = script_prelude();
    script.push_str("printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"0199a213-81c0-7800-8aa1-bbab2a035a53\"}'\n");
    if let Some(lifecycle_event) = lifecycle_event {
        script.push_str(&format!("printf '%s\\n' '{lifecycle_event}'\n"));
    }
    script.push_str(&format!("printf '%s\\n' '{FIXTURE_READY}'\n"));
    script.push_str("while [ ! -f \"$script_dir/release\" ]; do sleep 0.05; done\n");
    script
}

fn script_prelude() -> String {
    "#!/bin/sh\nset -eu\nscript_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nprintf '%s\\n' \"$$\" >> \"$script_dir/invocations\"\n".to_string()
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
