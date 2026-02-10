//! CLI command building and execution for Claude Code / Codex.

use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::masker::SecretMasker;
use crate::paths;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Build the CLI command + args based on `CLI_AGENT_TYPE`.
pub fn build_cli_command() -> Result<Vec<String>, AgentError> {
    let use_mock = env::use_mock_claude();

    if env::cli_agent_type() == "codex" {
        if use_mock {
            return Err(AgentError::Execution(
                "Mock mode not supported for Codex".into(),
            ));
        }
        Ok(build_codex_command())
    } else {
        Ok(build_claude_command(use_mock))
    }
}

fn build_claude_command(use_mock: bool) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    let resume = env::resume_session_id();
    if !resume.is_empty() {
        log_info!(LOG_TAG, "Resuming session: {resume}");
        args.push("--resume".to_string());
        args.push(resume.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new session");
    }

    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-claude for testing");
        "/usr/local/bin/vm0-agent/mock-claude.mjs".to_string()
    } else {
        "claude".to_string()
    };

    args.push(env::prompt().to_string());

    let mut cmd = vec![bin];
    cmd.append(&mut args);
    cmd
}

fn build_codex_command() -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--dangerously-bypass-approvals-and-sandbox".to_string(),
        "--skip-git-repo-check".to_string(),
        "-C".to_string(),
        env::working_dir().to_string(),
    ];

    let model = env::openai_model();
    if !model.is_empty() {
        args.push("-m".to_string());
        args.push(model.to_string());
    }

    let resume = env::resume_session_id();
    if !resume.is_empty() {
        log_info!(LOG_TAG, "Resuming session: {resume}");
        args.push("resume".to_string());
        args.push(resume.to_string());
        args.push(env::prompt().to_string());
    } else {
        log_info!(LOG_TAG, "Starting new session");
        args.push(env::prompt().to_string());
    }

    let mut cmd = vec!["codex".to_string()];
    cmd.append(&mut args);
    cmd
}

/// Set up Codex: create home dir, login with API key.
pub fn setup_codex() -> Result<(), AgentError> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let codex_home = format!("{home}/.codex");
    std::fs::create_dir_all(&codex_home)?;
    log_info!(LOG_TAG, "Codex home directory: {codex_home}");

    let login_start = std::time::Instant::now();
    let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        let msg = "OPENAI_API_KEY not set";
        log_error!(LOG_TAG, "{msg}");
        record_sandbox_op("codex_login", login_start.elapsed(), false, Some(msg));
        return Err(AgentError::Execution(msg.into()));
    }
    let output = std::process::Command::new("codex")
        .args(["login", "--with-api-key"])
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(api_key.as_bytes());
            }
            child.wait_with_output()
        });

    let success = match &output {
        Ok(o) if o.status.success() => {
            log_info!(LOG_TAG, "Codex authenticated with API key");
            true
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            log_error!(LOG_TAG, "Codex login failed: {stderr}");
            false
        }
        Err(e) => {
            log_error!(LOG_TAG, "Codex login failed: {e}");
            false
        }
    };
    record_sandbox_op("codex_login", login_start.elapsed(), success, None);

    Ok(())
}

/// Execute the CLI process, streaming JSONL events and racing against heartbeat.
///
/// Returns `(exit_code, stderr_lines)`.
pub async fn execute_cli(
    masker: &SecretMasker,
    mut heartbeat_handle: tokio::task::JoinHandle<Result<(), AgentError>>,
) -> Result<(i32, Vec<String>), AgentError> {
    log_info!(LOG_TAG, "Starting {} execution...", env::cli_agent_type());

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

    // Pass CODEX_HOME via Command::env instead of global set_var
    if env::cli_agent_type() == "codex" {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
        cmd.env("CODEX_HOME", format!("{home}/.codex"));
    }

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

    // Stream stdout JSONL, racing against heartbeat
    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let mut seq = 0u32;

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
                            // Print result to stdout if applicable
                            if event.get("type").and_then(|v| v.as_str()) == Some("result")
                                && let Some(result) = event.get("result").and_then(|v| v.as_str())
                            {
                                println!("{result}");
                            }
                            if let Err(e) = events::send_event(&mut event, seq, masker).await {
                                log_warn!(LOG_TAG, "Event send failed: {e}");
                            }
                            seq += 1;
                        }
                    }
                    Ok(None) => break Ok(()), // EOF
                    Err(e) => break Err(AgentError::Io(e)),
                }
            }
            hb_result = &mut heartbeat_handle => {
                match hb_result {
                    Ok(Err(e)) => {
                        // Heartbeat failed — kill process group
                        if let Some(pid) = child.id() {
                            unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
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

    let status = child.wait().await?;
    let exit_code = match status.code() {
        Some(code) => code,
        None => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = status.signal() {
                    log_warn!(LOG_TAG, "Process killed by signal {sig}");
                }
            }
            1
        }
    };

    let stderr_lines = stderr_handle.await.unwrap_or_default();

    // If event loop had an error, propagate it
    event_result?;

    Ok((exit_code, stderr_lines))
}
