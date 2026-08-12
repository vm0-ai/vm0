//! Guest-owned bridge for the internal `okou __agent-loop --standby` process.
//!
//! The Okou child owns Pi model/tool execution but never receives the sandbox
//! API token. Guest-agent proxies transcript reads and exact Pi event writes
//! over a local JSONL protocol, preserving the native Pi message payload
//! without passing it through the legacy CLI secret masker.
//!
//! See [`crate::pi_standby`] for the public lifecycle and protocol contract.

use super::{
    CliCompletionDisposition, CliExecutionControls, CliExecutionResult, HeartbeatMonitor,
    HeartbeatStatus, PiStandbyReleaseReason, child_env, cli_exit_summary_from_status, diagnostics,
    exec_boundary, line_reader, process_group::ChildProcessGroup, set_cli_current_dir,
};
use crate::env::GuestConfig;
use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths::{self, GuestPaths};
use crate::pi_standby::PiStandbySignal;
use guest_common::{log_info, log_warn};
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const CLI_PACKAGE_URL_ENV: &str = "CLI_PKG_URL";
const PI_CHILD_EXIT_GRACE: Duration = Duration::from_secs(10);
const PI_CHILD_TERMINATION_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum PiOutputFrame {
    #[serde(rename = "pi-ready")]
    Ready {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "systemPromptDigest")]
        system_prompt_digest: String,
        #[serde(rename = "skillSnapshotDigest")]
        skill_snapshot_digest: String,
    },
    #[serde(rename = "pi-transcript-read")]
    TranscriptRead {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "afterOrdinal")]
        after_ordinal: u32,
    },
    #[serde(rename = "pi-message")]
    Message { event: Value },
    #[serde(rename = "pi-complete")]
    Complete {
        #[serde(rename = "exitCode")]
        exit_code: i32,
        error: Option<String>,
        #[serde(rename = "lastEventSequence")]
        last_event_sequence: Option<u32>,
        #[serde(rename = "systemPromptDigest")]
        system_prompt_digest: String,
        #[serde(rename = "skillSnapshotDigest")]
        skill_snapshot_digest: String,
    },
    #[serde(rename = "pi-released")]
    Released { reason: String },
    #[serde(rename = "pi-error")]
    Error { message: String },
}

enum PiProtocolOutcome {
    Complete {
        exit_code: i32,
        error: Option<String>,
        last_event_sequence: Option<u32>,
    },
    Released(PiStandbyReleaseReason),
}

struct PiProtocolState {
    ready: bool,
    last_acknowledged_sequence: Option<u32>,
    expected_system_prompt_digest: String,
    expected_skill_snapshot_digest: String,
}

pub(super) fn is_pi_standby_config(config: &GuestConfig) -> Result<bool, AgentError> {
    let present = [
        !config.pi_system_prompt.is_empty(),
        !config.pi_model_config.is_empty(),
        !config.run_skill_snapshot.is_empty(),
    ];
    if present.iter().all(|value| !value) {
        return Ok(false);
    }
    if present.iter().all(|value| *value) {
        return Ok(true);
    }
    Err(AgentError::Execution(
        "Pi standby requires system prompt, model config, and Skill snapshot together".to_string(),
    ))
}

pub(super) async fn execute_pi_standby(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    controls: CliExecutionControls<'_>,
    config: &GuestConfig,
    guest_paths: &GuestPaths,
    execution_started_at: Instant,
) -> Result<CliExecutionResult, AgentError> {
    let package_url = config
        .user_env
        .get(CLI_PACKAGE_URL_ENV)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentError::Execution(format!("{CLI_PACKAGE_URL_ENV} is required for Pi standby"))
        })?;
    let args = [
        "--yes".to_string(),
        format!("--package={package_url}"),
        "okou".to_string(),
        "__agent-loop".to_string(),
        "--standby".to_string(),
    ];
    let mut child_env_values =
        child_env::values_with_inputs(&config.home_dir, &config.user_env, &config.api_url);
    child_env_values.retain(|(key, _)| {
        key != guest_contracts::env::API_TOKEN_ENV
            && key != guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV
    });
    child_env_values.extend([
        (
            guest_contracts::env::RUN_ID_ENV.to_string(),
            config.run_id.clone(),
        ),
        (
            guest_contracts::env::PI_SYSTEM_PROMPT_ENV.to_string(),
            config.pi_system_prompt.clone(),
        ),
        (
            guest_contracts::env::PI_MODEL_CONFIG_ENV.to_string(),
            config.pi_model_config.clone(),
        ),
        (
            guest_contracts::env::RUN_SKILL_SNAPSHOT_ENV.to_string(),
            config.run_skill_snapshot.clone(),
        ),
    ]);
    let child_env_values = child_env::normalize_values(child_env_values);
    exec_boundary::validate_process_argv_env(
        "Pi standby child argv/env too large",
        "npx",
        args.iter().map(String::as_str),
        &child_env_values,
    )
    .map_err(AgentError::Execution)?;

    let mut command = tokio::process::Command::new("npx");
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    child_env::apply_values_to_tokio_command(&mut command, &child_env_values);
    set_cli_current_dir(&mut command, paths::CANONICAL_WORKING_DIR)?;

    let log_file = guest_contracts::runtime_paths::create_private(guest_paths.agent_log_file())?;
    let mut log_file = tokio::fs::File::from_std(log_file);
    let mut child = command.spawn()?;
    let process_group = ChildProcessGroup::from_group_leader_child(&child);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AgentError::Execution("Pi standby child has no stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Execution("Pi standby child has no stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::Execution("Pi standby child has no stderr".to_string()))?;

    let (frame_tx, frame_rx) = mpsc::channel::<Value>(16);
    let stdin_task = tokio::spawn(write_input_frames(stdin, frame_rx));
    let CliExecutionControls {
        active_input,
        mut pi_standby,
        user_cancellation,
        codex_startup: _,
    } = controls;
    active_input.close_terminal();
    let control_frame_tx = frame_tx.clone();
    let control_task = tokio::spawn(async move {
        while let Some(signal) = pi_standby.recv().await {
            let frame = match signal {
                PiStandbySignal::Handoff => json!({ "type": "pi-handoff" }),
                PiStandbySignal::Release => json!({ "type": "pi-standby-release" }),
            };
            if control_frame_tx.send(frame).await.is_err() {
                return;
            }
        }
    });
    let mut stderr_task =
        tokio::spawn(async move { diagnostics::collect_stderr_result_tail(stderr).await });
    let mut stdout = BufReader::new(stdout);
    let mut partial_line = Vec::new();
    let expected_system_prompt_digest = sha256_digest(&config.pi_system_prompt);
    let expected_skill_snapshot_digest = skill_snapshot_digest(&config.run_skill_snapshot)?;
    let mut state = PiProtocolState {
        ready: false,
        last_acknowledged_sequence: None,
        expected_system_prompt_digest,
        expected_skill_snapshot_digest,
    };

    log_info!(LOG_TAG, "Starting Pi standby agent loop");
    let protocol_result = run_protocol(
        &mut stdout,
        &mut partial_line,
        &mut log_file,
        &frame_tx,
        &http,
        config,
        &mut state,
        &mut heartbeat_monitor,
        &user_cancellation,
        execution_started_at,
    )
    .await;
    let _ = log_file.flush().await;

    control_task.abort();
    let _ = control_task.await;
    drop(frame_tx);

    let outcome = match protocol_result {
        Ok(outcome) => outcome,
        Err(error) => {
            terminate_child(&mut child, process_group).await;
            stdin_task.abort();
            let _ = stdin_task.await;
            stderr_task.abort();
            let _ = stderr_task.await;
            return Err(error);
        }
    };

    let status = match tokio::time::timeout(PI_CHILD_EXIT_GRACE, child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            terminate_child(&mut child, process_group).await;
            return Err(AgentError::Execution(
                "Pi standby child did not exit after its terminal frame".to_string(),
            ));
        }
    };
    stdin_task.abort();
    let _ = stdin_task.await;
    let stderr_lines = match tokio::time::timeout(PI_CHILD_EXIT_GRACE, &mut stderr_task).await {
        Ok(Ok(lines)) => masker.mask_diagnostic_lines(lines),
        Ok(Err(error)) => {
            log_warn!(LOG_TAG, "Pi standby stderr collector failed: {error}");
            Vec::new()
        }
        Err(_) => {
            stderr_task.abort();
            let _ = stderr_task.await;
            Vec::new()
        }
    };
    let (_, cli_observed_exit) = cli_exit_summary_from_status(&status);
    if !status.success() {
        return Err(AgentError::Execution(format!(
            "Pi standby child exited before a clean protocol shutdown: {status}"
        )));
    }

    let (exit_code, error, last_event_sequence, completion_disposition) = match outcome {
        PiProtocolOutcome::Complete {
            exit_code,
            error,
            last_event_sequence,
        } => (
            exit_code,
            error,
            last_event_sequence,
            CliCompletionDisposition::PiCompleted,
        ),
        PiProtocolOutcome::Released(reason) => (
            0,
            None,
            state.last_acknowledged_sequence,
            CliCompletionDisposition::PiStandbyReleased(reason),
        ),
    };
    let mut stderr_lines = stderr_lines;
    if let Some(error) = error {
        stderr_lines.push(masker.mask_string(&error));
    }
    Ok(CliExecutionResult {
        exit_code,
        cli_observed_exit,
        stderr_lines,
        last_event_sequence,
        event_delivery: None,
        claude_result: None,
        post_result_cleanup_result: None,
        failure_diagnostic: None,
        control_error: None,
        cli_termination: None,
        completion_disposition,
        active_input_delivery_ids: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_protocol(
    stdout: &mut BufReader<tokio::process::ChildStdout>,
    partial_line: &mut Vec<u8>,
    log_file: &mut tokio::fs::File,
    frame_tx: &mpsc::Sender<Value>,
    http: &HttpClient,
    config: &GuestConfig,
    state: &mut PiProtocolState,
    heartbeat_monitor: &mut HeartbeatMonitor,
    user_cancellation: &CancellationToken,
    execution_started_at: Instant,
) -> Result<PiProtocolOutcome, AgentError> {
    let execution_deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(execution_deadline);
    let mut deadline_armed = false;
    if let Some(timeout) = config.agent_execution_timeout {
        let deadline = execution_started_at.checked_add(timeout).ok_or_else(|| {
            AgentError::Execution("Pi standby execution deadline overflowed".to_string())
        })?;
        execution_deadline
            .as_mut()
            .reset(tokio::time::Instant::from_std(deadline));
        deadline_armed = true;
    }

    loop {
        let line = tokio::select! {
            biased;
            () = user_cancellation.cancelled() => {
                return Err(AgentError::Execution("Pi standby cancelled by user".to_string()));
            }
            heartbeat = receive_heartbeat(heartbeat_monitor) => {
                return Err(heartbeat_error(heartbeat));
            }
            () = &mut execution_deadline, if deadline_armed => {
                return Err(AgentError::Execution("Pi standby execution timed out".to_string()));
            }
            line = line_reader::read_bounded_utf8_line(
                stdout,
                partial_line,
                ORDINARY_CLI_STDOUT_MAX_LINE_BYTES,
            ) => line.map_err(|error| {
                AgentError::Execution(format!("invalid Pi standby stdout: {error:?}"))
            })?,
        };
        let line = line.ok_or_else(|| {
            AgentError::Execution("Pi standby stdout closed before a terminal frame".to_string())
        })?;
        log_file.write_all(line.as_bytes()).await?;
        log_file.write_all(b"\n").await?;
        let frame: PiOutputFrame = serde_json::from_str(&line).map_err(|error| {
            AgentError::Execution(format!("invalid Pi standby protocol frame: {error}"))
        })?;
        if let Some(outcome) = handle_frame(frame_tx, http, config, state, frame).await? {
            return Ok(outcome);
        }
    }
}

async fn handle_frame(
    frame_tx: &mpsc::Sender<Value>,
    http: &HttpClient,
    config: &GuestConfig,
    state: &mut PiProtocolState,
    frame: PiOutputFrame,
) -> Result<Option<PiProtocolOutcome>, AgentError> {
    match frame {
        PiOutputFrame::Ready {
            run_id,
            system_prompt_digest,
            skill_snapshot_digest,
        } => {
            if state.ready {
                return Err(protocol_error("Pi standby emitted pi-ready twice"));
            }
            if run_id != config.run_id
                || system_prompt_digest != state.expected_system_prompt_digest
                || skill_snapshot_digest != state.expected_skill_snapshot_digest
            {
                return Err(protocol_error(
                    "Pi standby ready identity does not match fixed run inputs",
                ));
            }
            state.ready = true;
            log_info!(LOG_TAG, "Pi standby ready");
        }
        PiOutputFrame::TranscriptRead {
            request_id,
            after_ordinal,
        } => {
            require_ready(state)?;
            let transcript = http
                .get_pi_transcript(&config.run_id, after_ordinal, 1)
                .await?;
            send_frame(
                frame_tx,
                json!({
                    "type": "pi-transcript",
                    "requestId": request_id,
                    "transcript": transcript,
                }),
            )
            .await?;
        }
        PiOutputFrame::Message { event } => {
            require_ready(state)?;
            let (sequence, message_id) = pi_event_identity(&config.run_id, &event)?;
            let payload = exact_pi_event_payload(&config.run_id, event);
            http.post_json(http.events_url()?, &payload, 1).await?;
            if state
                .last_acknowledged_sequence
                .is_some_and(|last| sequence <= last)
            {
                return Err(protocol_error(
                    "Pi standby acknowledged event sequence did not advance",
                ));
            }
            state.last_acknowledged_sequence = Some(sequence);
            send_frame(
                frame_tx,
                json!({
                "type": "pi-message-ack",
                "messageId": message_id,
                "status": 200,
                }),
            )
            .await?;
        }
        PiOutputFrame::Complete {
            exit_code,
            error,
            last_event_sequence,
            system_prompt_digest,
            skill_snapshot_digest,
        } => {
            require_ready(state)?;
            if system_prompt_digest != state.expected_system_prompt_digest
                || skill_snapshot_digest != state.expected_skill_snapshot_digest
            {
                return Err(protocol_error(
                    "Pi standby completion identity changed after handoff",
                ));
            }
            if last_event_sequence != state.last_acknowledged_sequence {
                return Err(protocol_error(
                    "Pi standby completed before its final message acknowledgement",
                ));
            }
            if !matches!(exit_code, 0 | 1) {
                return Err(protocol_error("Pi standby returned an invalid exit code"));
            }
            return Ok(Some(PiProtocolOutcome::Complete {
                exit_code,
                error,
                last_event_sequence,
            }));
        }
        PiOutputFrame::Released { reason } => {
            require_ready(state)?;
            let reason = match reason.as_str() {
                "api-complete" => PiStandbyReleaseReason::ApiComplete,
                _ => {
                    return Err(protocol_error(format!(
                        "Pi standby returned an unknown release reason: {reason}"
                    )));
                }
            };
            return Ok(Some(PiProtocolOutcome::Released(reason)));
        }
        PiOutputFrame::Error { message } => {
            return Err(protocol_error(format!("Pi standby failed: {message}")));
        }
    }
    Ok(None)
}

fn require_ready(state: &PiProtocolState) -> Result<(), AgentError> {
    if state.ready {
        Ok(())
    } else {
        Err(protocol_error(
            "Pi standby emitted work before its ready frame",
        ))
    }
}

fn pi_event_identity(run_id: &str, event: &Value) -> Result<(u32, String), AgentError> {
    if event.get("type").and_then(Value::as_str) != Some("pi.message.completed") {
        return Err(protocol_error(
            "Pi standby attempted to post a non-Pi message event",
        ));
    }
    let sequence = event
        .get("sequenceNumber")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| protocol_error("Pi standby event has an invalid sequenceNumber"))?;
    let message_id = event
        .get("messageId")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error("Pi standby event has no messageId"))?;
    if message_id != format!("{run_id}/{sequence}") {
        return Err(protocol_error(
            "Pi standby event messageId does not match its run sequence",
        ));
    }
    Ok((sequence, message_id.to_string()))
}

fn exact_pi_event_payload(run_id: &str, event: Value) -> Value {
    events::event_payload_for_run_id(vec![event], run_id)
}

fn sha256_digest(value: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value.as_bytes())))
}

fn skill_snapshot_digest(snapshot: &str) -> Result<String, AgentError> {
    serde_json::from_str::<Value>(snapshot)?
        .get("digest")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| protocol_error("Pi Skill snapshot has no digest"))
}

async fn write_input_frames(
    mut stdin: tokio::process::ChildStdin,
    mut frames: mpsc::Receiver<Value>,
) -> Result<(), AgentError> {
    while let Some(frame) = frames.recv().await {
        let mut line = serde_json::to_vec(&frame)?;
        line.push(b'\n');
        stdin.write_all(&line).await?;
        stdin.flush().await?;
    }
    Ok(())
}

async fn send_frame(frame_tx: &mpsc::Sender<Value>, frame: Value) -> Result<(), AgentError> {
    frame_tx
        .send(frame)
        .await
        .map_err(|_| protocol_error("Pi standby input closed"))
}

async fn receive_heartbeat(
    heartbeat_monitor: &mut HeartbeatMonitor,
) -> Result<HeartbeatStatus, tokio::sync::oneshot::error::RecvError> {
    match heartbeat_monitor {
        Some(receiver) => receiver.await,
        None => std::future::pending().await,
    }
}

fn heartbeat_error(
    result: Result<HeartbeatStatus, tokio::sync::oneshot::error::RecvError>,
) -> AgentError {
    match result {
        Ok(HeartbeatStatus::Failed(error)) => error,
        Ok(HeartbeatStatus::Stopped) => {
            protocol_error("heartbeat stopped while Pi standby was running")
        }
        Ok(HeartbeatStatus::TaskFailed(message)) => {
            protocol_error(format!("heartbeat task failed: {message}"))
        }
        Err(error) => protocol_error(format!(
            "heartbeat stopped before reporting Pi standby status: {error}"
        )),
    }
}

async fn terminate_child(
    child: &mut tokio::process::Child,
    process_group: Option<ChildProcessGroup>,
) {
    if let Some(process_group) = process_group {
        process_group.sigterm();
    } else {
        let _ = child.start_kill();
    }
    if tokio::time::timeout(PI_CHILD_TERMINATION_GRACE, child.wait())
        .await
        .is_ok()
    {
        return;
    }
    if let Some(process_group) = process_group {
        process_group.sigkill();
    } else {
        let _ = child.start_kill();
    }
    let _ = child.wait().await;
}

fn protocol_error(message: impl Into<String>) -> AgentError {
    AgentError::Execution(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_fixed_prompt_and_snapshot_digests() {
        assert_eq!(
            sha256_digest("fixed prompt"),
            "sha256:e2760cba06354f227757ddb1ab77a2ce872fa40982a9ef49fffc461107a845e4"
        );
        assert_eq!(
            skill_snapshot_digest(r#"{"digest":"sha256:snapshot"}"#).unwrap(),
            "sha256:snapshot"
        );
    }

    #[test]
    fn accepts_only_stable_pi_message_identity() {
        let event = json!({
            "type": "pi.message.completed",
            "sequenceNumber": 3,
            "messageId": "run-1/3",
            "message": { "role": "toolResult", "content": [] },
        });
        assert_eq!(
            pi_event_identity("run-1", &event).unwrap(),
            (3, "run-1/3".to_string())
        );
        assert!(pi_event_identity("run-2", &event).is_err());
    }

    #[test]
    fn pi_message_payload_bypasses_legacy_secret_masking() {
        let event = json!({
            "type": "pi.message.completed",
            "sequenceNumber": 2,
            "messageId": "run-1/2",
            "message": {
                "role": "toolResult",
                "toolCallId": "read_1",
                "content": [{ "type": "text", "text": "exact-secret-shaped-bytes" }]
            }
        });

        let payload = exact_pi_event_payload("run-1", event.clone());

        assert_eq!(payload["runId"], "run-1");
        assert_eq!(payload["events"][0], event);
    }
}
