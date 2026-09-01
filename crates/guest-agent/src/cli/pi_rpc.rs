//! Official Pi RPC command lifecycle and public-event projection.
//!
//! ## Ownership and data flow
//!
//! The sandbox TypeScript host resolves the API-first handoff, restores the
//! validated ownership-transfer session file, writes one private startup
//! record to stdout, and then enters Pi's official `runRpcMode`. The guest owns the
//! other side of that boundary. Its stdout loop in `cli/mod.rs` admits the
//! boundary before any official RPC record, starts the shared event pipeline
//! from the installed sequence, and then applies this module's projection.
//!
//! There are two coupled JSONL paths after startup:
//!
//! - The guest writer owns child stdin. It sends `get_state`, waits until the
//!   private startup record is installed, sends the initial `prompt`, and then
//!   delivers accepted active-input frames. The stdout loop routes `response`
//!   records into the writer's response channel.
//! - The stdout loop owns child stdout. It retains each ordinary raw record in
//!   the best-effort local agent transcript, projects supported records into
//!   the existing public event shape, and passes projected events through
//!   normalization, secret masking, sequencing, bounded FIFO delivery, and the
//!   HTTP event worker. The startup control is the exception: it is consumed
//!   before the transcript and public pipeline and is never delivered.
//!
//! The public event pipeline is deliberately created only after boundary
//! installation. `CliEventIngestor` and `EventDeliveryRuntime` receive the same
//! installed first sequence, so the first public event and the delivery
//! acknowledgement watermark cannot start from different boundaries.
//!
//! ## API-first startup boundary
//!
//! Legacy manifest V1/V2 handoffs emit this private control before official RPC
//! output:
//!
//! ```json
//! {
//!   "type": "vm0_pi_api_first_turn_boundary",
//!   "schemaVersion": 1,
//!   "sandboxEventSequenceStart": 4
//! }
//! ```
//!
//! The host maps both legacy manifest versions to implicit
//! `pending-tool-continuation`. Manifest V3 instead emits boundary schema V2
//! with one explicit `ownershipTransferMode`: `sandbox-first`,
//! `pending-tool-continuation`, or `settled-session-continuation`. The private
//! boundary schema is independent of the public manifest schema. Rust accepts a
//! boundary only when its type and schema version are exact, all fields are
//! known, the mode is valid for that schema, and the sequence is in
//! `1..=i32::MAX` (`1..=2,147,483,647`).
//!
//! `PiRpcStartupBoundary` is a fail-closed one-time gate:
//!
//! - Before installation, a non-control JSON record fails with
//!   `PI_HANDOFF_BOUNDARY_MISSING`. A malformed control, invalid schema, zero,
//!   overflowing, or otherwise invalid sequence fails with
//!   `PI_HANDOFF_BOUNDARY_INVALID`.
//! - The first valid control installs the boundary. A second control before an
//!   official record is a duplicate; a different value is a conflict; and a
//!   control after an official record is late. Each is terminal and rejects
//!   the stream.
//! - After a rejection, `discard_remaining` makes all later records
//!   non-projecting. Invalid non-JSON input is also fatal while the boundary is
//!   still required, or when the raw line resembles the control type.
//! - `cli/mod.rs` consumes the installed control before projection. It is not
//!   written to the agent transcript, assigned a public sequence, sent to the
//!   webhook, or rendered as an agent/Chat event.
//!
//! This ordering is the API-first reader contract: no official RPC record may
//! reach projection, masking, sequencing, or delivery until the boundary that
//! authorized the restored H1 session has been installed.
//!
//! ## Command and acknowledgement lifecycle
//!
//! `write_commands` has one serialized command flow. It first writes
//! `get_state` with ID `<run-id>:pi:get-state` and waits for a response with
//! the exact ID, command name, and `success: true`. The successful response is
//! sent to the response channel and is also used by the projection to emit
//! `system/init` after validating the configured session ID, returned
//! `data.sessionId`, and required `data.sessionFile`.
//!
//! After `get_state`, the writer waits for the stdout loop to install the
//! startup boundary. It then sends the original initial `prompt` with ID
//! `<run-id>:pi:initial-prompt`; the TypeScript host interprets that official
//! command according to the installed mode. Sandbox-first executes it normally,
//! pending-tool continuation substitutes pending-tool execution, and settled
//! continuation acknowledges it without a model request. This preserves the
//! official RPC acknowledgement while preventing original-prompt replay.
//!
//! Once the initial acknowledgement arrives, accepted active input keeps the
//! existing `steer` command for sandbox-first and pending-tool continuation. A
//! settled transfer has no active model turn, so its newly owned continuation
//! uses `prompt`. In both cases the command ID is the delivery UUID, and the
//! matching successful response is required before
//! `mark_backend_accepted_without_replay` records ownership. A failed or
//! interrupted command marks the delivery failed and enters the abort/error
//! path.
//!
//! Normal response waits reject an unexpected ID, unexpected command,
//! unsuccessful response, or a closed response channel. Abort is different in
//! one respect: it ignores unrelated response IDs while waiting for its own
//! acknowledgement. It writes ID `<run-id>:pi:abort`, requires the matching
//! successful `abort` response, and has a ten-second timeout covering the write
//! and acknowledgement wait.
//!
//! The guest keeps child stdin owned by this writer after the initial prompt.
//! The host's official RPC loop therefore remains alive while the guest waits
//! for active input and while stdout drains through `agent_settled`. After a
//! projected terminal result, Pi active input closes when no follow-up frame is
//! pending; final guest cleanup closes it in all remaining cases, allowing the
//! host to observe stdin EOF.
//!
//! User cancellation closes active-input state and cancels the Pi writer. When
//! cancellation wins while the writer is waiting for a command response, the
//! writer sends the bounded `abort` command. If cancellation wins inside the
//! cancellable stdin write itself, that write returns an interruption error
//! before an abort can be written; this is a distinct early-write failure path.
//! The final guest control result records `Run cancelled by user` and the
//! `UserCancellation` termination reason. Current Pi tool-result events do not
//! carry a `vm0_user_cancelled` field: that marker was removed with Chat Tool
//! Activity in #30215. Claude-only replay filtering is enabled outside this
//! module; Pi does not set `replay_user_messages`.
//!
//! ## Record admission and projection
//!
//! `PiRpcProjection::project` receives only official records admitted after the
//! startup boundary. The common loop records the raw JSONL line locally even
//! when the record has no public projection. The routing contract is:
//!
//! - `response`: every response is routed to the command channel. Only the
//!   first successful `get_state` response emits `system/init`; prompt, steer,
//!   abort, and other responses are acknowledgement records only. The raw
//!   response remains in the local transcript.
//! - `message_end` with an assistant message: the latest assistant terminal
//!   state is cached. Supported content is emitted as an `assistant` event;
//!   empty content, unknown content blocks, and assistant messages with no
//!   supported content emit no public event, but their raw records remain local.
//! - `message_end` with a `toolResult` message: required tool-result fields are
//!   validated and one public `user` event containing one `tool_result` block is
//!   emitted. The raw record remains local. Other message roles are ignored
//!   publicly and retained locally.
//! - `agent_settled`: this is the sole Pi owner of the public terminal
//!   `result` event. It consumes the cached assistant terminal state. Neither
//!   `message_end` nor `agent_end` owns the public terminal result.
//! - `extension_error`: no public event is emitted. Projection becomes
//!   terminal and returns an execution error; later records are discarded from
//!   public projection while the stdout loop continues its controlled failure
//!   and local-transcript handling.
//! - Unsupported official records, including `agent_end`, emit no public
//!   event and are retained locally unless the projection is already terminal.
//!
//! After projection, assistant and user events with multiple content blocks
//! are split by `provider_event_normalization` into one independently
//! sequenced public event per block. The source order is retained, and common
//! masking and bounded delivery happen after that normalization.
//!
//! ## Public event shapes
//!
//! A successful `get_state` projects to:
//!
//! ```json
//! {
//!   "type": "system",
//!   "subtype": "init",
//!   "session_id": "<configured-session-id>",
//!   "session_file": "<returned-session-file>"
//! }
//! ```
//!
//! An assistant `message_end` projects to an `assistant` envelope whose
//! message contains `id`, `role: "assistant"`, ordered `content`, `model`, and
//! `usage`. The ID is `responseId` when supplied, otherwise
//! `<run-id>:<timestamp>:<model>`. Usage maps `input`, `output`, `cacheRead`,
//! and `cacheWrite` to `input_tokens`, `output_tokens`,
//! `cache_read_input_tokens`, and `cache_creation_input_tokens`.
//!
//! Text blocks are trimmed and empty text is omitted. A `toolCall` requires a
//! non-empty `id` and `name` plus an object `arguments`, and becomes a
//! `{type: "tool_use", id, name, input}` block. Unknown assistant content
//! types are omitted. A tool-only assistant message still produces an
//! assistant event because its `toolCall` block is supported.
//!
//! A `toolResult` message requires a non-empty `toolCallId`, an array
//! `content`, and a boolean `isError`. It becomes:
//!
//! ```json
//! {
//!   "type": "user",
//!   "session_id": "<configured-session-id>",
//!   "message": {
//!     "role": "user",
//!     "content": [{
//!       "type": "tool_result",
//!       "tool_use_id": "<toolCallId>",
//!       "content": [],
//!       "is_error": false
//!     }]
//!   }
//! }
//! ```
//!
//! Tool-result text blocks retain their text. Image blocks become base64 image
//! sources with `mimeType` mapped to `media_type` and `data` mapped to
//! `data`; unsupported result content blocks are omitted. The resulting `user`
//! event is a tool result, not a replayable prompt, and has no
//! `vm0_user_cancelled` field.
//!
//! ## Terminal result and failure ownership
//!
//! Each assistant `message_end` updates `PiAssistantTerminal`; it does not
//! itself close the public run. `stopReason` values `error` and `aborted` set
//! the cached failure flag. The result text uses `errorMessage` when present,
//! otherwise the joined non-empty assistant text. If both are empty, it falls
//! back to `Pi model turn <stopReason>` when a stop reason exists.
//!
//! When `agent_settled` arrives, the cached state is consumed and the public
//! result contains `type: "result"`, `subtype: "error_during_execution"` and
//! `is_error: true` for a cached failure, or `subtype: "success"` and
//! `is_error: false` otherwise. It also contains the selected `result` text,
//! configured `session_id`, and elapsed `duration_ms`. With no cached assistant
//! message, the default terminal state is successful with an empty result.
//!
//! The common guest loop treats this projected result as the terminal JSONL
//! event: it masks the printed result, closes idle Pi active input, and drains
//! successful delivery or aborts unsent delivery on a control/error path. A
//! user cancellation can subsequently override the final guest control
//! diagnostic, but it does not mutate the public tool-result shape.

use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::active_input::{ActiveInputFrame, ActiveInputWriter};
use crate::error::AgentError;

const PI_RPC_ABORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE: &str = "vm0_pi_api_first_turn_boundary";
const MAX_EVENT_SEQUENCE_NUMBER: u32 = i32::MAX as u32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum PiRpcOwnershipTransferMode {
    SandboxFirst,
    PendingToolContinuation,
    SettledSessionContinuation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiApiFirstTurnBoundaryControlV1 {
    #[serde(rename = "type")]
    record_type: String,
    schema_version: u32,
    sandbox_event_sequence_start: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiApiFirstTurnBoundaryControlV2 {
    #[serde(rename = "type")]
    record_type: String,
    schema_version: u32,
    sandbox_event_sequence_start: u64,
    ownership_transfer_mode: PiRpcOwnershipTransferMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PiRpcStartup {
    pub(super) sandbox_event_sequence_start: u32,
    pub(super) ownership_transfer_mode: PiRpcOwnershipTransferMode,
}

pub(super) enum PiRpcRecordAdmission {
    InstallBoundary(PiRpcStartup),
    Project,
    Discard,
}

#[derive(Default)]
pub(super) struct PiRpcStartupBoundary {
    installed: Option<PiRpcStartup>,
    official_record_seen: bool,
    terminal_error: bool,
}

impl PiRpcStartupBoundary {
    pub(super) fn admit(&mut self, record: &Value) -> Result<PiRpcRecordAdmission, AgentError> {
        if self.terminal_error {
            return Ok(PiRpcRecordAdmission::Discard);
        }
        let is_control = record.get("type").and_then(Value::as_str)
            == Some(PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE);
        if !is_control {
            if self.installed.is_none() {
                return self.reject(Self::missing_error());
            }
            self.official_record_seen = true;
            return Ok(PiRpcRecordAdmission::Project);
        }

        let candidate = match parse_boundary_control(record) {
            Ok(candidate) => candidate,
            Err(error) => return self.reject(error),
        };
        let Some(installed) = self.installed else {
            self.installed = Some(candidate);
            return Ok(PiRpcRecordAdmission::InstallBoundary(candidate));
        };
        if candidate != installed {
            return self.reject(boundary_error(
                "PI_HANDOFF_BOUNDARY_CONFLICT",
                "Pi API first-turn handoff boundary conflicts with the installed boundary",
            ));
        }
        if self.official_record_seen {
            return self.reject(boundary_error(
                "PI_HANDOFF_BOUNDARY_LATE",
                "Pi API first-turn handoff boundary arrived after RPC startup",
            ));
        }
        self.reject(boundary_error(
            "PI_HANDOFF_BOUNDARY_INVALID",
            "Pi API first-turn handoff boundary was duplicated",
        ))
    }

    pub(super) fn requires_boundary(&self) -> bool {
        self.installed.is_none() && !self.terminal_error
    }

    pub(super) fn missing_error() -> AgentError {
        boundary_error(
            "PI_HANDOFF_BOUNDARY_MISSING",
            "Pi API first-turn handoff boundary is required before RPC startup",
        )
    }

    pub(super) fn malformed_record_error() -> AgentError {
        boundary_error(
            "PI_HANDOFF_BOUNDARY_INVALID",
            "Pi API first-turn handoff boundary is malformed",
        )
    }

    pub(super) fn looks_like_control(raw: &str) -> bool {
        raw.contains(PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE)
    }

    pub(super) fn discard_remaining(&mut self) {
        self.terminal_error = true;
    }

    fn reject(&mut self, error: AgentError) -> Result<PiRpcRecordAdmission, AgentError> {
        self.terminal_error = true;
        Err(error)
    }
}

fn validated_boundary_sequence(sequence: u64) -> Result<u32, AgentError> {
    let sequence =
        u32::try_from(sequence).map_err(|_| PiRpcStartupBoundary::malformed_record_error())?;
    if sequence == 0 || sequence > MAX_EVENT_SEQUENCE_NUMBER {
        return Err(PiRpcStartupBoundary::malformed_record_error());
    }
    Ok(sequence)
}

fn parse_boundary_control(record: &Value) -> Result<PiRpcStartup, AgentError> {
    match record.get("schemaVersion").and_then(Value::as_u64) {
        Some(1) => {
            let control: PiApiFirstTurnBoundaryControlV1 =
                serde_json::from_value(record.clone())
                    .map_err(|_| PiRpcStartupBoundary::malformed_record_error())?;
            if control.record_type != PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE
                || control.schema_version != 1
            {
                return Err(PiRpcStartupBoundary::malformed_record_error());
            }
            Ok(PiRpcStartup {
                sandbox_event_sequence_start: validated_boundary_sequence(
                    control.sandbox_event_sequence_start,
                )?,
                ownership_transfer_mode: PiRpcOwnershipTransferMode::PendingToolContinuation,
            })
        }
        Some(2) => {
            let control: PiApiFirstTurnBoundaryControlV2 =
                serde_json::from_value(record.clone())
                    .map_err(|_| PiRpcStartupBoundary::malformed_record_error())?;
            if control.record_type != PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE
                || control.schema_version != 2
            {
                return Err(PiRpcStartupBoundary::malformed_record_error());
            }
            Ok(PiRpcStartup {
                sandbox_event_sequence_start: validated_boundary_sequence(
                    control.sandbox_event_sequence_start,
                )?,
                ownership_transfer_mode: control.ownership_transfer_mode,
            })
        }
        _ => Err(PiRpcStartupBoundary::malformed_record_error()),
    }
}

fn boundary_error(code: &str, message: &str) -> AgentError {
    AgentError::Execution(format!("[{code}] {message}"))
}

#[derive(Default)]
struct PiAssistantTerminal {
    failed: bool,
    result: String,
}

impl PiAssistantTerminal {
    fn from_message(message: &Value) -> Self {
        let stop_reason = message.get("stopReason").and_then(Value::as_str);
        let failed = matches!(stop_reason, Some("error" | "aborted"));
        let result = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .map_or_else(|| assistant_text(message), ToString::to_string);
        let result = if result.is_empty() {
            stop_reason.map_or_else(String::new, |reason| format!("Pi model turn {reason}"))
        } else {
            result
        };
        Self { failed, result }
    }
}

pub(super) struct PiRpcProjection {
    run_id: String,
    session_id: String,
    started_at: Instant,
    emitted_session_init: bool,
    assistant_terminal: Option<PiAssistantTerminal>,
    terminal_error: bool,
}

impl PiRpcProjection {
    pub(super) fn new(run_id: &str, session_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            started_at: Instant::now(),
            emitted_session_init: false,
            assistant_terminal: None,
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
            let session_file = response
                .pointer("/data/sessionFile")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Pi RPC get_state response omitted the session file".to_string(),
                    )
                })?;
            self.emitted_session_init = true;
            Some(json!({
                "type": "system",
                "subtype": "init",
                "session_id": session_id,
                "session_file": session_file,
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
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => self.project_assistant_message(message),
            Some("toolResult") => self.project_tool_result_message(message).map(Some),
            _ => Ok(None),
        }
    }

    fn project_assistant_message(&mut self, message: &Value) -> Result<Option<Value>, AgentError> {
        self.assistant_terminal = Some(PiAssistantTerminal::from_message(message));
        let content = assistant_content(message)?;
        if content.is_empty() {
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
                "content": content,
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

    fn project_tool_result_message(&self, message: &Value) -> Result<Value, AgentError> {
        let tool_use_id = message
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|tool_use_id| !tool_use_id.is_empty())
            .ok_or_else(|| {
                AgentError::Execution(
                    "Pi RPC toolResult message omitted its tool call id".to_string(),
                )
            })?;
        let content = message
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AgentError::Execution("Pi RPC toolResult message omitted its content".to_string())
            })?
            .iter()
            .map(project_tool_result_content)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let is_error = message
            .get("isError")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                AgentError::Execution(
                    "Pi RPC toolResult message omitted its error status".to_string(),
                )
            })?;
        Ok(json!({
            "type": "user",
            "session_id": self.session_id,
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                    "is_error": is_error,
                }],
            },
        }))
    }

    fn project_agent_settled(&mut self) -> Value {
        let assistant = self.assistant_terminal.take().unwrap_or_default();
        json!({
            "type": "result",
            "subtype": if assistant.failed { "error_during_execution" } else { "success" },
            "is_error": assistant.failed,
            "result": assistant.result,
            "session_id": self.session_id,
            "duration_ms": self.started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        })
    }
}

fn assistant_content(message: &Value) -> Result<Vec<Value>, AgentError> {
    let mut content = Vec::new();
    for block in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    content.push(json!({ "type": "text", "text": text }));
                }
            }
            Some("toolCall") => content.push(project_tool_call(block)?),
            _ => {}
        }
    }
    Ok(content)
}

fn project_tool_call(block: &Value) -> Result<Value, AgentError> {
    let id = block
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            AgentError::Execution("Pi RPC toolCall content omitted its id".to_string())
        })?;
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            AgentError::Execution("Pi RPC toolCall content omitted its name".to_string())
        })?;
    let arguments = block
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AgentError::Execution("Pi RPC toolCall content omitted its arguments".to_string())
        })?;
    Ok(json!({
        "type": "tool_use",
        "id": id,
        "name": name,
        "input": arguments,
    }))
}

fn project_tool_result_content(block: &Value) -> Result<Option<Value>, AgentError> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => Ok(Some(json!({
            "type": "text",
            "text": block
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| AgentError::Execution(
                    "Pi RPC toolResult text content omitted its text".to_string()
                ))?,
        }))),
        Some("image") => Ok(Some(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": block
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AgentError::Execution(
                        "Pi RPC toolResult image content omitted its media type".to_string()
                    ))?,
                "data": block
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AgentError::Execution(
                        "Pi RPC toolResult image content omitted its data".to_string()
                    ))?,
            },
        }))),
        _ => Ok(None),
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

async fn write_command_with_cancellation(
    stdin: &mut tokio::process::ChildStdin,
    command: &Value,
    cancellation: &CancellationToken,
) -> Result<(), AgentError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(AgentError::Execution(
            "Pi RPC command write was interrupted by cancellation".to_string(),
        )),
        result = write_command(stdin, command) => result,
    }
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
    tokio::time::timeout(PI_RPC_ABORT_TIMEOUT, async {
        write_command(stdin, &json!({ "id": id, "type": "abort" })).await?;
        wait_for_response(responses, &id, "abort", true).await
    })
    .await
    .map_err(|_| AgentError::Execution("Pi RPC abort timed out".to_string()))?
}

async fn request_prompt(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::UnboundedReceiver<Value>,
    id: &str,
    message: &str,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    write_command_with_cancellation(
        stdin,
        &json!({
            "id": id,
            "type": "prompt",
            "message": message,
        }),
        cancellation,
    )
    .await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(false),
        response = wait_for_response(responses, id, "prompt", false) => {
            response?;
            Ok(true)
        }
    }
}

async fn request_steer(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::UnboundedReceiver<Value>,
    id: &str,
    message: &str,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    write_command_with_cancellation(
        stdin,
        &json!({
            "id": id,
            "type": "steer",
            "message": message,
        }),
        cancellation,
    )
    .await?;
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(false),
        response = wait_for_response(responses, id, "steer", false) => {
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
    ownership_transfer_mode: PiRpcOwnershipTransferMode,
    cancellation: &CancellationToken,
) -> Result<bool, AgentError> {
    active_input.mark_writing(&frame.uuid);
    let request = match ownership_transfer_mode {
        PiRpcOwnershipTransferMode::SettledSessionContinuation => {
            request_prompt(stdin, responses, &frame.uuid, &frame.text, cancellation).await
        }
        PiRpcOwnershipTransferMode::SandboxFirst
        | PiRpcOwnershipTransferMode::PendingToolContinuation => {
            request_steer(stdin, responses, &frame.uuid, &frame.text, cancellation).await
        }
    };
    match request {
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
    ownership_transfer_mode: tokio::sync::oneshot::Receiver<PiRpcOwnershipTransferMode>,
    cancellation: CancellationToken,
) -> Result<(), AgentError> {
    let state_id = format!("{run_id}:pi:get-state");
    write_command_with_cancellation(
        &mut stdin,
        &json!({ "id": state_id, "type": "get_state" }),
        &cancellation,
    )
    .await?;
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

    let ownership_transfer_mode = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            abort(&mut stdin, &mut responses, run_id).await?;
            return Ok(());
        }
        mode = ownership_transfer_mode => mode.map_err(|_| AgentError::Execution(
            "Pi RPC startup boundary closed before ownership was installed".to_string(),
        ))?,
    };

    let prompt_id = format!("{run_id}:pi:initial-prompt");
    if !request_prompt(
        &mut stdin,
        &mut responses,
        &prompt_id,
        prompt,
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
                    ownership_transfer_mode,
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
    fn boundary_v1_maps_to_pending_tool_continuation() {
        let startup = parse_boundary_control(&json!({
            "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
            "schemaVersion": 1,
            "sandboxEventSequenceStart": 4,
        }))
        .expect("legacy boundary should remain readable");

        assert_eq!(startup.sandbox_event_sequence_start, 4);
        assert_eq!(
            startup.ownership_transfer_mode,
            PiRpcOwnershipTransferMode::PendingToolContinuation
        );
    }

    #[test]
    fn boundary_v2_accepts_each_explicit_ownership_mode() {
        for (wire_mode, expected) in [
            ("sandbox-first", PiRpcOwnershipTransferMode::SandboxFirst),
            (
                "pending-tool-continuation",
                PiRpcOwnershipTransferMode::PendingToolContinuation,
            ),
            (
                "settled-session-continuation",
                PiRpcOwnershipTransferMode::SettledSessionContinuation,
            ),
        ] {
            let startup = parse_boundary_control(&json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 2,
                "sandboxEventSequenceStart": 7,
                "ownershipTransferMode": wire_mode,
            }))
            .expect("V2 boundary mode should be readable");

            assert_eq!(startup.sandbox_event_sequence_start, 7);
            assert_eq!(startup.ownership_transfer_mode, expected);
        }
    }

    #[test]
    fn boundary_modes_fail_closed_across_schema_versions() {
        for record in [
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 1,
                "sandboxEventSequenceStart": 4,
                "ownershipTransferMode": "sandbox-first",
            }),
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 2,
                "sandboxEventSequenceStart": 4,
            }),
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 2,
                "sandboxEventSequenceStart": 4,
                "ownershipTransferMode": "future-mode",
            }),
            json!({
                "type": PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
                "schemaVersion": 3,
                "sandboxEventSequenceStart": 4,
                "ownershipTransferMode": "pending-tool-continuation",
            }),
        ] {
            assert!(
                parse_boundary_control(&record)
                    .expect_err("unsupported boundary should fail closed")
                    .to_string()
                    .contains("PI_HANDOFF_BOUNDARY_INVALID")
            );
        }
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
                    "data": {
                        "sessionId": "session",
                        "sessionFile": "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl",
                    },
                }),
                &responses,
            )
            .expect("state should project")
            .expect("state should emit init");
        assert_eq!(event["session_id"], "session");
        assert_eq!(
            event["session_file"],
            "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl"
        );
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
                    "error": "forced extension failure",
                }),
                &responses,
            )
            .expect_err("checkpoint failure should terminate projection");
        assert!(error.to_string().contains("forced extension failure"));

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

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn writer_uses_official_steer_ack_for_active_input_receipts() {
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
        let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(write_commands(
            stdin,
            "run",
            "initial prompt",
            active_input.into_writer(),
            response_rx,
            startup_rx,
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
                "data": {
                    "sessionId": "session",
                    "sessionFile": "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl",
                },
            }))
            .expect("state response should route");
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                next_command(&mut stdout)
            )
            .await
            .is_err(),
            "initial prompt must wait for boundary installation"
        );
        startup_tx
            .send(PiRpcOwnershipTransferMode::PendingToolContinuation)
            .expect("startup mode should route");

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
        assert_eq!(steer["type"], "steer");
        assert_eq!(steer["message"], "steer this turn");
        assert!(steer.get("streamingBehavior").is_none());
        response_tx
            .send(json!({
                "id": delivery_id,
                "type": "response",
                "command": "steer",
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn settled_writer_uses_prompt_ack_for_newly_owned_input() {
        let mut child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("cat should spawn");
        let stdin = child.stdin.take().expect("cat stdin should exist");
        let stdout = child.stdout.take().expect("cat stdout should exist");
        let mut stdout = BufReader::new(stdout);
        let active_input = ActiveInputRuntime::new_for_test("run", "original prompt");
        let controller = active_input.controller();
        let delivery_id = "22222222-2222-4222-8222-222222222222";
        let payload = json!({
            "type": "active-input",
            "deliveryId": delivery_id,
            "text": "newly owned continuation",
        });
        assert_eq!(
            controller.handle_control_payload(&serde_json::to_vec(&payload).expect("payload")),
            ActiveInputControlOutcome::Accepted
        );
        let (response_tx, response_rx) = mpsc::unbounded_channel();
        let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(write_commands(
            stdin,
            "run",
            "original prompt",
            active_input.into_writer(),
            response_rx,
            startup_rx,
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
            }))
            .expect("state response should route");
        startup_tx
            .send(PiRpcOwnershipTransferMode::SettledSessionContinuation)
            .expect("startup mode should route");

        let initial = next_command(&mut stdout).await;
        assert_eq!(initial["type"], "prompt");
        assert_eq!(initial["message"], "original prompt");
        response_tx
            .send(json!({
                "id": initial["id"],
                "type": "response",
                "command": "prompt",
                "success": true,
            }))
            .expect("startup acknowledgement should route");

        let continuation = next_command(&mut stdout).await;
        assert_eq!(continuation["id"], delivery_id);
        assert_eq!(continuation["type"], "prompt");
        assert_eq!(continuation["message"], "newly owned continuation");
        response_tx
            .send(json!({
                "id": delivery_id,
                "type": "response",
                "command": "prompt",
                "success": true,
            }))
            .expect("continuation acknowledgement should route");
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
