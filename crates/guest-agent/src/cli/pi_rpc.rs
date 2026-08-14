//! Official Pi RPC command lifecycle and public-event projection.

use std::time::Instant;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::active_input::{ActiveInputFrame, ActiveInputWriter};
use crate::error::AgentError;

const PI_RPC_ABORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) struct PiRpcProjection {
    run_id: String,
    session_id: String,
    started_at: Instant,
    emitted_session_init: bool,
    final_assistant: Option<Value>,
    terminal_error: bool,
}

impl PiRpcProjection {
    pub(super) fn new(run_id: &str, session_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            started_at: Instant::now(),
            emitted_session_init: false,
            final_assistant: None,
            terminal_error: false,
        }
    }

    /// Project one official Pi RPC record into the existing public event stream.
    pub(super) fn project(
        &mut self,
        record: Value,
        responses: &mpsc::UnboundedSender<Value>,
    ) -> Result<Option<Value>, AgentError> {
        if self.terminal_error {
            return Ok(None);
        }
        match record.get("type").and_then(Value::as_str) {
            Some("response") => self.project_response(record, responses),
            Some("message_end") => self.project_message_end(record),
            Some("agent_settled") => Ok(Some(self.project_agent_settled())),
            Some("extension_error") => {
                self.terminal_error = true;
                Err(AgentError::Execution(format!(
                    "Pi RPC extension failed: {}",
                    record
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown extension error")
                )))
            }
            _ => Ok(None),
        }
    }

    fn project_response(
        &mut self,
        response: Value,
        responses: &mpsc::UnboundedSender<Value>,
    ) -> Result<Option<Value>, AgentError> {
        let command = response.get("command").and_then(Value::as_str);
        let projected = if command == Some("get_state")
            && response.get("success").and_then(Value::as_bool) == Some(true)
            && !self.emitted_session_init
        {
            let session_id = response
                .pointer("/data/sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Pi RPC get_state response omitted the session id".to_string(),
                    )
                })?;
            if session_id != self.session_id {
                return Err(AgentError::Execution(
                    "Pi RPC reported an unexpected session id".to_string(),
                ));
            }
            self.emitted_session_init = true;
            Some(json!({
                "type": "system",
                "subtype": "init",
                "session_id": session_id,
            }))
        } else {
            None
        };
        let _ = responses.send(response);
        Ok(projected)
    }

    fn project_message_end(&mut self, event: Value) -> Result<Option<Value>, AgentError> {
        let Some(message) = event.get("message") else {
            return Err(AgentError::Execution(
                "Pi RPC message_end omitted its message".to_string(),
            ));
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            return Ok(None);
        }
        self.final_assistant = Some(message.clone());
        let text = assistant_text(message);
        if text.is_empty() {
            return Ok(None);
        }
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let id = message
            .get("responseId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{}:{timestamp}:{model}", self.run_id));
        Ok(Some(json!({
            "type": "assistant",
            "message": {
                "id": id,
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
                "model": model,
                "usage": {
                    "input_tokens": message.pointer("/usage/input").and_then(Value::as_u64).unwrap_or(0),
                    "output_tokens": message.pointer("/usage/output").and_then(Value::as_u64).unwrap_or(0),
                    "cache_read_input_tokens": message.pointer("/usage/cacheRead").and_then(Value::as_u64).unwrap_or(0),
                    "cache_creation_input_tokens": message.pointer("/usage/cacheWrite").and_then(Value::as_u64).unwrap_or(0),
                },
            },
        })))
    }

    fn project_agent_settled(&mut self) -> Value {
        let assistant = self.final_assistant.take();
        let stop_reason = assistant
            .as_ref()
            .and_then(|message| message.get("stopReason"))
            .and_then(Value::as_str);
        let failed = matches!(stop_reason, Some("error" | "aborted"));
        let result = assistant
            .as_ref()
            .and_then(|message| message.get("errorMessage"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| assistant.as_ref().map(assistant_text))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| {
                stop_reason.map_or_else(String::new, |reason| format!("Pi model turn {reason}"))
            });
        json!({
            "type": "result",
            "subtype": if failed { "error_during_execution" } else { "success" },
            "is_error": failed,
            "result": result,
            "session_id": self.session_id,
            "duration_ms": self.started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        })
    }
}

fn assistant_text(message: &Value) -> String {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn write_command(
    stdin: &mut tokio::process::ChildStdin,
    command: &Value,
) -> Result<(), AgentError> {
    let mut line = serde_json::to_vec(command)?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

async fn wait_for_response(
    responses: &mut mpsc::UnboundedReceiver<Value>,
    expected_id: &str,
    expected_command: &str,
    allow_unmatched: bool,
) -> Result<(), AgentError> {
    while let Some(response) = responses.recv().await {
        let response_id = response.get("id").and_then(Value::as_str);
        if response_id != Some(expected_id) {
            if allow_unmatched {
                continue;
            }
            return Err(AgentError::Execution(
                "Pi RPC returned an unexpected response id".to_string(),
            ));
        }
        if response.get("command").and_then(Value::as_str) != Some(expected_command) {
            return Err(AgentError::Execution(format!(
                "Pi RPC response {expected_id} named an unexpected command"
            )));
        }
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown RPC failure");
            return Err(AgentError::Execution(format!(
                "Pi RPC {expected_command} failed: {message}"
            )));
        }
        return Ok(());
    }
    Err(AgentError::Execution(
        "Pi RPC stdout closed before the command was acknowledged".to_string(),
    ))
}

async fn abort(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::UnboundedReceiver<Value>,
    run_id: &str,
) -> Result<(), AgentError> {
    let id = format!("{run_id}:pi:abort");
    write_command(stdin, &json!({ "id": id, "type": "abort" })).await?;
    tokio::time::timeout(
        PI_RPC_ABORT_TIMEOUT,
        wait_for_response(responses, &id, "abort", true),
    )
    .await
    .map_err(|_| AgentError::Execution("Pi RPC abort acknowledgement timed out".to_string()))?
}

async fn request_prompt(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::UnboundedReceiver<Value>,
    id: &str,
    message: &str,
    streaming_behavior: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    let command = streaming_behavior.map_or_else(
        || {
            json!({
                "id": id,
                "type": "prompt",
                "message": message,
            })
        },
        |streaming_behavior| {
            json!({
                "id": id,
                "type": "prompt",
                "message": message,
                "streamingBehavior": streaming_behavior,
            })
        },
    );
    write_command(stdin, &command).await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(false),
        response = wait_for_response(responses, id, "prompt", false) => {
            response?;
            Ok(true)
        }
    }
}

async fn deliver_active_input(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::UnboundedReceiver<Value>,
    active_input: &ActiveInputWriter,
    frame: &ActiveInputFrame,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    active_input.mark_writing(&frame.uuid);
    match request_prompt(
        stdin,
        responses,
        &frame.uuid,
        &frame.text,
        Some("steer"),
        cancellation,
    )
    .await
    {
        Ok(true) => {
            active_input.mark_backend_accepted_without_replay(frame)?;
            Ok(true)
        }
        Ok(false) => {
            active_input.mark_backend_failed(frame);
            Ok(false)
        }
        Err(error) => {
            active_input.mark_backend_failed(frame);
            Err(error)
        }
    }
}

/// Drive official Pi RPC commands and keep stdin open through `agent_settled`.
pub(super) async fn write_commands(
    mut stdin: tokio::process::ChildStdin,
    run_id: &str,
    prompt: &str,
    mut active_input: ActiveInputWriter,
    mut responses: mpsc::UnboundedReceiver<Value>,
    cancellation: CancellationToken,
) -> Result<(), AgentError> {
    let state_id = format!("{run_id}:pi:get-state");
    write_command(&mut stdin, &json!({ "id": state_id, "type": "get_state" })).await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            abort(&mut stdin, &mut responses, run_id).await?;
            return Ok(());
        }
        response = wait_for_response(&mut responses, &state_id, "get_state", false) => {
            response?;
        }
    }

    let prompt_id = format!("{run_id}:pi:initial-prompt");
    if !request_prompt(
        &mut stdin,
        &mut responses,
        &prompt_id,
        prompt,
        None,
        &cancellation,
    )
    .await?
    {
        abort(&mut stdin, &mut responses, run_id).await?;
        return Ok(());
    }

    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                abort(&mut stdin, &mut responses, run_id).await?;
                return Ok(());
            }
            frame = active_input.next_frame() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                if !deliver_active_input(
                    &mut stdin,
                    &mut responses,
                    &active_input,
                    &frame,
                    &cancellation,
                ).await? {
                    abort(&mut stdin, &mut responses, run_id).await?;
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use tokio::io::{AsyncBufReadExt, BufReader};

    use crate::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};

    use super::*;

    async fn next_command(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("mock Pi stdout should be readable");
        serde_json::from_str(&line).expect("Pi command should be JSON")
    }

    #[test]
    fn projection_uses_agent_settled_as_the_terminal_event() {
        let (responses, _rx) = mpsc::unbounded_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        assert!(
            projection
                .project(
                    json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "done" }],
                            "model": "model",
                            "timestamp": 1,
                            "usage": {},
                            "stopReason": "stop",
                        }
                    }),
                    &responses,
                )
                .expect("message should project")
                .is_some()
        );
        assert!(
            projection
                .project(json!({ "type": "agent_end", "messages": [] }), &responses)
                .expect("agent_end should be ignored")
                .is_none()
        );
        let result = projection
            .project(json!({ "type": "agent_settled" }), &responses)
            .expect("agent_settled should project")
            .expect("agent_settled should emit result");
        assert_eq!(result["type"], "result");
        assert_eq!(result["result"], "done");
    }

    #[test]
    fn projection_validates_get_state_session_identity() {
        let (responses, mut rx) = mpsc::unbounded_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let event = projection
            .project(
                json!({
                    "id": "state",
                    "type": "response",
                    "command": "get_state",
                    "success": true,
                    "data": { "sessionId": "session" },
                }),
                &responses,
            )
            .expect("state should project")
            .expect("state should emit init");
        assert_eq!(event["session_id"], "session");
        assert_eq!(
            rx.try_recv().expect("response should be routed")["id"],
            "state"
        );
    }

    #[test]
    fn projection_discards_buffered_records_after_extension_failure() {
        let (responses, _rx) = mpsc::unbounded_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        let error = projection
            .project(
                json!({
                    "type": "extension_error",
                    "event": "message_end",
                    "error": "forced SQLite checkpoint failure",
                }),
                &responses,
            )
            .expect_err("checkpoint failure should terminate projection");
        assert!(
            error
                .to_string()
                .contains("forced SQLite checkpoint failure")
        );

        assert!(
            projection
                .project(
                    json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "must not project" }],
                            "model": "model",
                            "timestamp": 1,
                            "usage": {},
                            "stopReason": "stop",
                        }
                    }),
                    &responses,
                )
                .expect("buffered message should be discarded")
                .is_none()
        );
        assert!(
            projection
                .project(json!({ "type": "agent_settled" }), &responses)
                .expect("buffered terminal event should be discarded")
                .is_none()
        );
    }

    #[tokio::test]
    async fn writer_uses_official_prompt_ack_for_active_input_receipts() {
        let mut child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("cat should spawn");
        let stdin = child.stdin.take().expect("cat stdin should exist");
        let stdout = child.stdout.take().expect("cat stdout should exist");
        let mut stdout = BufReader::new(stdout);
        let active_input = ActiveInputRuntime::new_for_test("run", "initial prompt");
        let controller = active_input.controller();
        let delivery_id = "11111111-1111-4111-8111-111111111111";
        let payload = json!({
            "type": "active-input",
            "deliveryId": delivery_id,
            "text": "steer this turn",
        });
        assert_eq!(
            controller.handle_control_payload(&serde_json::to_vec(&payload).expect("payload")),
            ActiveInputControlOutcome::Accepted
        );
        let (response_tx, response_rx) = mpsc::unbounded_channel();
        let writer = tokio::spawn(write_commands(
            stdin,
            "run",
            "initial prompt",
            active_input.into_writer(),
            response_rx,
            CancellationToken::new(),
        ));

        let state = next_command(&mut stdout).await;
        assert_eq!(state["type"], "get_state");
        response_tx
            .send(json!({
                "id": state["id"],
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": { "sessionId": "session" },
            }))
            .expect("state response should route");

        let initial = next_command(&mut stdout).await;
        assert_eq!(initial["type"], "prompt");
        assert_eq!(initial["message"], "initial prompt");
        assert!(initial.get("streamingBehavior").is_none());
        response_tx
            .send(json!({
                "id": initial["id"],
                "type": "response",
                "command": "prompt",
                "success": true,
            }))
            .expect("initial prompt response should route");

        let steer = next_command(&mut stdout).await;
        assert_eq!(steer["id"], delivery_id);
        assert_eq!(steer["type"], "prompt");
        assert_eq!(steer["message"], "steer this turn");
        assert_eq!(steer["streamingBehavior"], "steer");
        response_tx
            .send(json!({
                "id": delivery_id,
                "type": "response",
                "command": "prompt",
                "success": true,
            }))
            .expect("steer response should route");
        controller.close_terminal();

        writer
            .await
            .expect("writer task should join")
            .expect("writer should succeed");
        assert_eq!(
            controller
                .finalize_receipts()
                .await
                .expect("receipts should finalize"),
            vec![delivery_id.to_string()]
        );
        child.wait().await.expect("cat should exit");
    }
}
