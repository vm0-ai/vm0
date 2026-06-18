//! Guest-agent local active-input state for Claude stream-json stdin.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const ACTIVE_INPUT_TYPE: &str = "active-input";
const ACTIVE_INPUT_QUEUE_CAPACITY: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveInputFrame {
    pub message_id: String,
    pub uuid: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActiveInputControlOutcome {
    Accepted,
    Rejected { diagnostic: &'static str },
    Error { diagnostic: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayUserEventAction {
    External,
    InternalInitialPrompt,
    InternalActiveInput,
    UnknownPromptUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Open,
    Closing,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingState {
    Accepted,
    Written,
}

#[derive(Debug)]
struct PendingInput {
    state: PendingState,
}

#[derive(Debug)]
struct ActiveInputState {
    lifecycle: Lifecycle,
    seen_message_ids: HashSet<String>,
    pending_by_uuid: HashMap<String, PendingInput>,
}

impl Default for ActiveInputState {
    fn default() -> Self {
        Self {
            lifecycle: Lifecycle::Open,
            seen_message_ids: HashSet::new(),
            pending_by_uuid: HashMap::new(),
        }
    }
}

#[derive(Debug)]
struct ActiveInputInner {
    enabled: bool,
    run_id: String,
    initial_prompt_uuid: String,
    tx: mpsc::Sender<ActiveInputFrame>,
    close_tx: watch::Sender<bool>,
    state: Mutex<ActiveInputState>,
}

#[derive(Debug, Clone)]
pub struct ActiveInputController {
    inner: Arc<ActiveInputInner>,
}

#[derive(Debug)]
pub struct ActiveInputWriter {
    controller: ActiveInputController,
    rx: mpsc::Receiver<ActiveInputFrame>,
    close_rx: watch::Receiver<bool>,
}

pub struct ActiveInputRuntime {
    controller: ActiveInputController,
    writer: ActiveInputWriter,
}

#[derive(Deserialize)]
struct ActiveInputPayload {
    #[serde(rename = "type")]
    payload_type: String,
    text: String,
}

pub fn claude_initial_prompt_uuid(run_id: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:{run_id}:claude-initial-prompt").as_bytes(),
    )
    .to_string()
}

fn claude_active_input_uuid(run_id: &str, message_id: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:{run_id}:claude-active-input:{message_id}").as_bytes(),
    )
    .to_string()
}

fn is_prompt_like_user_content(event: &Value) -> bool {
    let Some(content) = event.pointer("/message/content") else {
        return false;
    };
    if content.as_str().is_some() {
        return true;
    }
    let Some(items) = content.as_array() else {
        return false;
    };

    !items.is_empty()
        && items
            .iter()
            .all(|item| item.get("type").and_then(Value::as_str) != Some("tool_result"))
}

impl ActiveInputRuntime {
    pub fn new(run_id: &str, enabled: bool) -> Self {
        let (tx, rx) = mpsc::channel(ACTIVE_INPUT_QUEUE_CAPACITY);
        let (close_tx, close_rx) = watch::channel(false);
        let controller = ActiveInputController {
            inner: Arc::new(ActiveInputInner {
                enabled,
                run_id: run_id.to_owned(),
                initial_prompt_uuid: claude_initial_prompt_uuid(run_id),
                tx,
                close_tx,
                state: Mutex::new(ActiveInputState::default()),
            }),
        };
        let writer = ActiveInputWriter {
            controller: controller.clone(),
            rx,
            close_rx,
        };
        Self { controller, writer }
    }

    pub fn controller(&self) -> ActiveInputController {
        self.controller.clone()
    }

    pub fn into_writer(self) -> ActiveInputWriter {
        self.writer
    }
}

impl ActiveInputController {
    pub fn is_enabled(&self) -> bool {
        self.inner.enabled
    }

    pub fn handle_control_payload(
        &self,
        message_id: &str,
        payload: &[u8],
    ) -> ActiveInputControlOutcome {
        if !self.inner.enabled {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input is not supported for this agent",
            };
        }
        if message_id.is_empty() {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input message id is empty",
            };
        }

        let payload = match serde_json::from_slice::<ActiveInputPayload>(payload) {
            Ok(payload) => payload,
            Err(_) => {
                return ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input payload is invalid",
                };
            }
        };
        if payload.payload_type != ACTIVE_INPUT_TYPE {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input payload type is unsupported",
            };
        }
        if payload.text.is_empty() {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input text is empty",
            };
        }

        let uuid = claude_active_input_uuid(&self.inner.run_id, message_id);
        let frame = ActiveInputFrame {
            message_id: message_id.to_owned(),
            uuid: uuid.clone(),
            text: payload.text,
        };

        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.lifecycle != Lifecycle::Open {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input is closed",
            };
        }
        if state.seen_message_ids.contains(message_id) {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input message id is duplicate",
            };
        }
        if state.pending_by_uuid.len() >= ACTIVE_INPUT_QUEUE_CAPACITY {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input queue is full",
            };
        }

        state.seen_message_ids.insert(message_id.to_owned());
        state.pending_by_uuid.insert(
            uuid.clone(),
            PendingInput {
                state: PendingState::Accepted,
            },
        );

        match self.inner.tx.try_send(frame) {
            Ok(()) => ActiveInputControlOutcome::Accepted,
            Err(mpsc::error::TrySendError::Full(frame)) => {
                state.seen_message_ids.remove(&frame.message_id);
                state.pending_by_uuid.remove(&frame.uuid);
                ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input queue is full",
                }
            }
            Err(mpsc::error::TrySendError::Closed(frame)) => {
                state.seen_message_ids.remove(&frame.message_id);
                state.pending_by_uuid.remove(&frame.uuid);
                state.lifecycle = Lifecycle::Closed;
                ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input is closed",
                }
            }
        }
    }

    pub fn mark_written(&self, uuid: &str) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(input) = state.pending_by_uuid.get_mut(uuid) {
            input.state = PendingState::Written;
        }
    }

    pub fn close_for_result_if_idle(&self) -> bool {
        if !self.inner.enabled {
            return true;
        }

        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.pending_by_uuid.is_empty() {
            return false;
        }
        match state.lifecycle {
            Lifecycle::Open => {
                state.lifecycle = Lifecycle::Closing;
                let _ = self.inner.close_tx.send(true);
                true
            }
            Lifecycle::Closing | Lifecycle::Closed => false,
        }
    }

    pub fn close_terminal(&self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.lifecycle = Lifecycle::Closed;
        let _ = self.inner.close_tx.send(true);
    }

    pub fn replay_user_event_action(&self, event: &Value) -> ReplayUserEventAction {
        if event.get("type").and_then(Value::as_str) != Some("user") {
            return ReplayUserEventAction::External;
        }

        if let Some(uuid) = event.get("uuid").and_then(Value::as_str) {
            if uuid == self.inner.initial_prompt_uuid {
                return ReplayUserEventAction::InternalInitialPrompt;
            }

            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.pending_by_uuid.remove(uuid).is_some() {
                return ReplayUserEventAction::InternalActiveInput;
            }
        }

        if is_prompt_like_user_content(event) {
            return ReplayUserEventAction::UnknownPromptUser;
        }

        ReplayUserEventAction::External
    }
}

impl ActiveInputWriter {
    pub fn controller(&self) -> ActiveInputController {
        self.controller.clone()
    }

    pub async fn next_frame(&mut self) -> Option<ActiveInputFrame> {
        loop {
            if *self.close_rx.borrow() {
                return None;
            }
            tokio::select! {
                biased;
                close = self.close_rx.changed() => {
                    if close.is_err() || *self.close_rx.borrow() {
                        return None;
                    }
                }
                frame = self.rx.recv() => return frame,
            }
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.controller.is_enabled()
    }

    pub fn mark_written(&self, uuid: &str) {
        self.controller.mark_written(uuid);
    }

    pub fn close_terminal(&self) {
        self.controller.close_terminal();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn active_input_accepts_valid_payload_once() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let controller = runtime.controller();

        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Accepted
        );
        assert!(matches!(
            controller.handle_control_payload(
                "msg-1",
                br#"{"type":"active-input","text":"hello again"}"#
            ),
            ActiveInputControlOutcome::Rejected { diagnostic }
                if diagnostic == "active input message id is duplicate"
        ));
    }

    #[test]
    fn active_input_rejects_invalid_payloads() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let controller = runtime.controller();

        for (message_id, payload) in [
            ("bad-json", br#"{"type":"active-input""#.as_slice()),
            ("bad-type", br#"{"type":"other","text":"hello"}"#.as_slice()),
            ("empty", br#"{"type":"active-input","text":""}"#.as_slice()),
        ] {
            assert!(
                matches!(
                    controller.handle_control_payload(message_id, payload),
                    ActiveInputControlOutcome::Rejected { .. }
                ),
                "payload should reject: {message_id}"
            );
        }
    }

    #[test]
    fn active_input_rejects_when_disabled_or_closed() {
        let disabled = ActiveInputRuntime::new("run-1", false);
        assert!(matches!(
            disabled
                .controller()
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic }
                if diagnostic == "active input is not supported for this agent"
        ));

        let runtime = ActiveInputRuntime::new("run-1", true);
        let controller = runtime.controller();
        assert!(controller.close_for_result_if_idle());
        assert!(matches!(
            controller.handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
        ));
    }

    #[test]
    fn active_input_capacity_counts_pending_inputs() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let controller = runtime.controller();

        for index in 0..ACTIVE_INPUT_QUEUE_CAPACITY {
            let message_id = format!("msg-{index}");
            assert_eq!(
                controller.handle_control_payload(
                    &message_id,
                    br#"{"type":"active-input","text":"hello"}"#
                ),
                ActiveInputControlOutcome::Accepted
            );
        }

        assert!(matches!(
            controller.handle_control_payload("overflow", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input queue is full"
        ));
    }

    #[test]
    fn replay_filter_consumes_initial_and_active_input_user_events() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", "msg-1");

        let initial = json!({
            "type": "user",
            "uuid": claude_initial_prompt_uuid("run-1"),
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::InternalInitialPrompt
        );

        let active = json!({
            "type": "user",
            "uuid": active_uuid,
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_keeps_tool_result_user_events_external() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "tool-1"}]
            }
        });

        assert_eq!(
            runtime.controller().replay_user_event_action(&event),
            ReplayUserEventAction::External
        );
    }

    #[test]
    fn replay_filter_consumes_matching_uuid_even_with_non_string_content() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Accepted
        );

        let initial = json!({
            "type": "user",
            "uuid": claude_initial_prompt_uuid("run-1"),
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "initial"}]
            }
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::InternalInitialPrompt
        );

        let active = json!({
            "type": "user",
            "uuid": claude_active_input_uuid("run-1", "msg-1"),
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "follow-up"}]
            }
        });
        assert_eq!(
            controller.replay_user_event_action(&active),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_treats_text_block_user_events_without_uuid_as_unknown_prompt() {
        let runtime = ActiveInputRuntime::new("run-1", true);
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "follow-up"}]
            }
        });

        assert_eq!(
            runtime.controller().replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
    }
}
