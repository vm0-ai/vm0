//! CLI command building and execution for Claude Code.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::masker::SecretMasker;
use crate::paths;
use crate::timing;
use guest_common::{log_info, log_warn};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Build the CLI command + args.
pub fn build_cli_command() -> Result<Vec<String>, AgentError> {
    Ok(build_claude_command(env::use_mock_claude()))
}

/// Build the argument list from explicit parameters (testable).
fn build_claude_args(
    resume_id: &str,
    append_system_prompt: &str,
    disallowed_tools: &str,
    tools: &str,
    settings: &str,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    if !resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming session: {resume_id}");
        args.push("--resume".to_string());
        args.push(resume_id.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new session");
    }

    if !append_system_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(append_system_prompt.to_string());
    }

    if !disallowed_tools.is_empty() {
        args.push("--disallowed-tools".to_string());
        for tool in disallowed_tools.split(',') {
            let tool = tool.trim();
            if !tool.is_empty() {
                args.push(tool.to_string());
            }
        }
    }

    if !tools.is_empty() {
        args.push("--tools".to_string());
        for tool in tools.split(',') {
            let tool = tool.trim();
            if !tool.is_empty() {
                args.push(tool.to_string());
            }
        }
    }

    if !settings.is_empty() {
        args.push("--settings".to_string());
        args.push(settings.to_string());
    }

    // "--" terminates option parsing so Commander.js variadic options
    // (--disallowed-tools, --tools) do not consume the prompt.
    args.push("--".to_string());
    args.push(prompt.to_string());
    args
}

fn build_claude_command(use_mock: bool) -> Vec<String> {
    let args = build_claude_args(
        env::resume_session_id(),
        env::append_system_prompt(),
        env::disallowed_tools(),
        env::tools(),
        env::settings(),
        env::prompt(),
    );

    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-claude for testing");
        "/usr/local/bin/guest-mock-claude".to_string()
    } else {
        "claude".to_string()
    };

    let mut cmd = vec![bin];
    cmd.extend(args);
    cmd
}

/// Execute the CLI process, streaming JSONL events and racing against heartbeat.
///
/// Returns `(exit_code, stderr_lines)`.
pub async fn execute_cli(
    masker: &SecretMasker,
    mut heartbeat_handle: tokio::task::JoinHandle<Result<(), AgentError>>,
) -> Result<(i32, Vec<String>), AgentError> {
    log_info!(LOG_TAG, "Starting claude-code execution...");

    let cmd = build_cli_command()?;
    let (bin, args) = cmd
        .split_first()
        .ok_or_else(|| AgentError::Execution("empty command".into()))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);

    // Suppress Claude CLI features that are unnecessary or harmful in a
    // sandbox: startup network calls (statsig, Datadog, Segment, GCS
    // update check, GitHub) add ~2s latency, telemetry has no receiver,
    // and the CLI version is baked into the rootfs image.
    cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    cmd.env("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1");
    cmd.env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1");
    cmd.env("DISABLE_AUTOUPDATER", "1");
    cmd.env("DISABLE_ERROR_REPORTING", "1");
    cmd.env("DISABLE_INSTALLATION_CHECKS", "1");
    cmd.env("DISABLE_TELEMETRY", "1");

    let mut child = cmd.spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Execution("no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::Execution("no stderr".into()))?;

    // Stderr collector
    let stderr_handle = tokio::spawn(async move {
        let mut lines = Vec::new();
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            lines.push(line);
        }
        lines
    });

    // Open agent log file
    let mut log_file = tokio::fs::File::create(paths::agent_log_file()).await?;

    // Stream stdout JSONL, racing against heartbeat and process exit.
    //
    // Event sending is decoupled from stdout reading via an mpsc channel
    // to prevent a deadlock: Bun (Claude CLI runtime) uses blocking stdout
    // writes, so if the agent's HTTP POSTs are slow and the pipe buffer
    // fills, the CLI's entire event loop blocks — including TCP I/O.
    // See: https://github.com/vm0-ai/vm0/issues/3645
    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let mut seq = 0u32;

    // Capture the process group ID before wait() reaps the child, since
    // child.id() returns None after the process has been reaped.
    let pgid = child.id().map(|pid| pid as i32);

    let mut cli_status: Option<std::process::ExitStatus> = None;

    // Stuck-tool watchdog: workaround for Claude Code bug where
    // WebSearch/WebFetch hang indefinitely. Track all in-flight tool calls;
    // if a network tool exceeds STUCK_TOOL_TIMEOUT_SECS without producing
    // a tool_result, kill the process. Keyed by tool_use_id to handle
    // parallel tool calls correctly.
    // See: https://github.com/anthropics/claude-code/issues/11650
    let mut stuck_tool_tracker: HashMap<String, (String, Instant)> = HashMap::new();
    let stuck_tool_interval = Duration::from_secs(constants::STUCK_TOOL_CHECK_INTERVAL_SECS);
    let mut stuck_tool_check = tokio::time::interval_at(
        tokio::time::Instant::now() + stuck_tool_interval,
        stuck_tool_interval,
    );
    // MAINTENANCE: update if Claude Code adds new network tools that can hang.
    const STUCK_TOOL_NAMES: &[&str] = &["WebSearch", "WebFetch"];

    // Background event sender: HTTP POSTs happen here, never in the
    // stdout reading loop.  Unbounded channel because events are small
    // and CLI lifetime is bounded by JOB_TIMEOUT.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let event_sender = tokio::spawn(async move {
        while let Some(payload) = event_rx.recv().await {
            if let Err(e) = events::post_event(&payload).await {
                log_warn!(LOG_TAG, "Event send failed: {e}");
            }
        }
    });

    let event_result: Result<(), AgentError> = loop {
        tokio::select! {
            line_result = reader.next_line() => {
                match line_result {
                    Ok(Some(line)) => {
                        // Write to log
                        let _ = log_file.write_all(line.as_bytes()).await;
                        let _ = log_file.write_all(b"\n").await;

                        let stripped = line.trim();
                        if stripped.is_empty() {
                            continue;
                        }

                        if let Ok(mut event) = serde_json::from_str::<serde_json::Value>(stripped) {
                            // First event is the CLI init (system/init or thread.started)
                            if seq == 0 {
                                timing::record_e2e_from_api("api_to_cli_init");
                            }
                            // Print result to stdout if applicable
                            if event.get("type").and_then(|v| v.as_str()) == Some("result")
                                && let Some(result) = event.get("result").and_then(|v| v.as_str())
                            {
                                println!("{result}");
                            }
                            // Extract tool info BEFORE masking (masker may replace tool names)
                            for tool_event in events::extract_claude_tool_info(&event) {
                                match tool_event {
                                    events::ClaudeToolEvent::Use { id, name } => {
                                        stuck_tool_tracker.insert(id.to_string(), (name.to_string(), Instant::now()));
                                    }
                                    events::ClaudeToolEvent::Result { tool_use_id } => {
                                        stuck_tool_tracker.remove(tool_use_id);
                                    }
                                }
                            }
                            // Prepare event (fast: mask secrets, add seq) and enqueue
                            // for background sending.  Never blocks the reading loop.
                            if let Some(payload) = events::prepare_event(&mut event, seq, masker)
                                && event_tx.send(payload).is_err()
                            {
                                log_warn!(LOG_TAG, "Event channel closed, dropping event seq={seq}");
                            }
                            seq += 1;
                        }
                    }
                    Ok(None) => break Ok(()), // EOF — pipe closed normally
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            status = child.wait(), if cli_status.is_none() => {
                match status {
                    Ok(s) => {
                        log_info!(LOG_TAG, "CLI process exited (status: {s}), draining stdout");
                        cli_status = Some(s);
                    }
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            _ = stuck_tool_check.tick() => {
                let timeout_secs = env::stuck_tool_timeout_secs();
                // Find the oldest network tool that has exceeded the timeout.
                let stuck = stuck_tool_tracker
                    .values()
                    .filter(|(name, started)| {
                        started.elapsed().as_secs() >= timeout_secs
                            && STUCK_TOOL_NAMES.contains(&name.as_str())
                    })
                    .min_by_key(|(_, started)| *started)
                    .map(|(name, started)| (name.clone(), started.elapsed().as_secs()));
                if let Some((name, elapsed)) = stuck {
                    log_warn!(
                        LOG_TAG,
                        "Tool timeout: {name} stuck for {elapsed}s, killing process"
                    );
                    if let Some(pid) = pgid {
                        unsafe { libc::kill(-pid, libc::SIGTERM); }
                    }
                    break Err(AgentError::Execution(format!(
                        "Tool timeout: {name} exceeded {timeout_secs}s without returning a result"
                    )));
                }
            }
            hb_result = &mut heartbeat_handle => {
                match hb_result {
                    Ok(Err(e)) => {
                        // Heartbeat failed — kill process group
                        if let Some(pid) = pgid {
                            unsafe { libc::kill(-pid, libc::SIGTERM); }
                        }
                        break Err(e);
                    }
                    Ok(Ok(())) => {
                        // Heartbeat shutdown (should not happen before CLI exits)
                        break Ok(());
                    }
                    Err(e) => {
                        break Err(AgentError::Execution(format!("heartbeat task panicked: {e}")));
                    }
                }
            }
        }
    };

    // Close the channel so the background sender can finish.
    // On error (e.g. heartbeat failure) the server is likely unreachable,
    // so we drop unsent events to avoid stalling on retries.
    drop(event_tx);
    if event_result.is_ok() {
        if let Err(e) = event_sender.await {
            log_warn!(LOG_TAG, "Event sender task failed: {e}");
        }
    } else {
        event_sender.abort();
    }

    let status = match cli_status {
        Some(s) => s,
        None => child.wait().await?,
    };
    let exit_code = match status.code() {
        Some(code) => code,
        None => {
            let mut code = 1;
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = status.signal() {
                    log_warn!(LOG_TAG, "Process killed by signal {sig}");
                    // Map signal to 128+signal (same convention as bash/vsock-guest)
                    // so the runner can detect OOM kills (SIGKILL=9 → exit 137).
                    code = 128 + sig;
                }
            }
            code
        }
    };

    let stderr_lines = stderr_handle.await.unwrap_or_default();

    // If event loop had an error, propagate it
    event_result?;

    Ok((exit_code, stderr_lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assert prompt is last and preceded by "--" separator.
    fn assert_prompt_with_separator(args: &[String], expected_prompt: &str) {
        let len = args.len();
        assert!(len >= 2, "args too short: {args:?}");
        assert_eq!(
            args[len - 2],
            "--",
            "second-to-last arg must be '--': {args:?}"
        );
        assert_eq!(args[len - 1], expected_prompt);
    }

    #[test]
    fn build_claude_args_basic() {
        let args = build_claude_args("", "", "", "", "", "hello world");
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert_prompt_with_separator(&args, "hello world");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_claude_args_with_append_system_prompt() {
        let args = build_claude_args("", "Your name is Aria.", "", "", "", "analyze this");
        let asp_idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[asp_idx + 1], "Your name is Aria.");
        assert_prompt_with_separator(&args, "analyze this");
    }

    #[test]
    fn build_claude_args_empty_append_system_prompt_omitted() {
        let args = build_claude_args("", "", "", "", "", "test");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume_and_append() {
        let args = build_claude_args("sess-123", "Be helpful.", "", "", "", "prompt");
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert_prompt_with_separator(&args, "prompt");
    }

    #[test]
    fn build_claude_command_uses_claude_binary() {
        let cmd = build_claude_command(false);
        assert_eq!(cmd[0], "claude");
    }

    #[test]
    fn build_claude_command_uses_mock_binary() {
        let cmd = build_claude_command(true);
        assert_eq!(cmd[0], "/usr/local/bin/guest-mock-claude");
    }

    #[test]
    fn build_claude_args_with_disallowed_tools() {
        let args = build_claude_args("", "", "CronCreate,CronDelete,CronList", "", "", "hello");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        assert_eq!(args[dt_idx + 1], "CronCreate");
        assert_eq!(args[dt_idx + 2], "CronDelete");
        assert_eq!(args[dt_idx + 3], "CronList");
        // "--" must separate variadic tools from the prompt
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_disallowed_tools_omitted() {
        let args = build_claude_args("", "", "", "", "", "test");
        assert!(!args.contains(&"--disallowed-tools".to_string()));
    }

    #[test]
    fn build_claude_args_with_tools() {
        let args = build_claude_args("", "", "", "Bash,Edit,Read", "", "hello");
        let t_idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[t_idx + 1], "Bash");
        assert_eq!(args[t_idx + 2], "Edit");
        assert_eq!(args[t_idx + 3], "Read");
        // "--" must separate variadic tools from the prompt
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_tools_omitted() {
        let args = build_claude_args("", "", "", "", "", "test");
        assert!(!args.contains(&"--tools".to_string()));
    }

    #[test]
    fn build_claude_args_with_settings() {
        let args = build_claude_args("", "", "", "", r#"{"hooks":{}}"#, "hello");
        let s_idx = args.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(args[s_idx + 1], r#"{"hooks":{}}"#);
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_settings_omitted() {
        let args = build_claude_args("", "", "", "", "", "test");
        assert!(!args.contains(&"--settings".to_string()));
    }

    #[test]
    fn build_claude_args_all_options_combined() {
        let args = build_claude_args(
            "sess-abc",
            "Be concise.",
            "CronCreate,CronDelete",
            "Bash,Read",
            r#"{"hooks":{}}"#,
            "do something",
        );
        for expected in [
            "--resume",
            "sess-abc",
            "--append-system-prompt",
            "Be concise.",
            "--disallowed-tools",
            "CronCreate",
            "CronDelete",
            "--tools",
            "Bash",
            "Read",
            "--settings",
            r#"{"hooks":{}}"#,
        ] {
            assert!(args.iter().any(|a| a == expected), "missing: {expected}");
        }
        assert_prompt_with_separator(&args, "do something");
    }

    #[test]
    fn build_claude_args_disallowed_tools_whitespace_trimmed() {
        let args = build_claude_args("", "", " CronCreate , CronDelete ", "", "", "test");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        assert_eq!(args[dt_idx + 1], "CronCreate");
        assert_eq!(args[dt_idx + 2], "CronDelete");
    }

    #[test]
    fn build_claude_args_tools_whitespace_trimmed() {
        let args = build_claude_args("", "", "", " Bash , Read ", "", "test");
        let t_idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[t_idx + 1], "Bash");
        assert_eq!(args[t_idx + 2], "Read");
    }

    #[test]
    fn build_claude_args_disallowed_tools_empty_items_skipped() {
        // Trailing comma produces an empty token that should be skipped
        let args = build_claude_args("", "", "CronCreate,,CronDelete,", "", "", "test");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        // Only non-empty tools should be present
        let tool_args: Vec<&str> = args[dt_idx + 1..]
            .iter()
            .take_while(|a| a.as_str() != "--" && !a.starts_with("--"))
            .map(|s| s.as_str())
            .collect();
        assert_eq!(tool_args, vec!["CronCreate", "CronDelete"]);
    }

    #[test]
    fn build_claude_args_prompt_always_last() {
        let args = build_claude_args("", "", "", "", "", "my prompt");
        assert_eq!(args.last().unwrap(), "my prompt");
    }
}
