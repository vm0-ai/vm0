//! Guest-agent local active-input state for Claude stream-json stdin.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const ACTIVE_INPUT_TYPE: &str = "active-input";
const ACTIVE_INPUT_QUEUE_CAPACITY: usize = 8;
const ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY: usize = 1024;

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
    Writing,
    WritingWithUuidlessReplay,
    Written,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayEventUuid<'a> {
    Missing,
    String(&'a str),
    NonString,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PromptUserContent {
    Text(String),
    ToolResult,
    Unknown,
}

#[derive(Debug)]
struct PendingInput {
    state: PendingState,
    text: String,
}

#[derive(Debug)]
struct ActiveInputState {
    lifecycle: Lifecycle,
    initial_prompt_replay_seen: bool,
    observed_result: bool,
    next_input_sequence: u64,
    seen_message_ids: HashSet<String>,
    seen_message_id_order: VecDeque<String>,
    pending_uuid_order: VecDeque<String>,
    pending_by_uuid: HashMap<String, PendingInput>,
}

impl Default for ActiveInputState {
    fn default() -> Self {
        Self {
            lifecycle: Lifecycle::Open,
            initial_prompt_replay_seen: false,
            observed_result: false,
            next_input_sequence: 0,
            seen_message_ids: HashSet::new(),
            seen_message_id_order: VecDeque::new(),
            pending_uuid_order: VecDeque::new(),
            pending_by_uuid: HashMap::new(),
        }
    }
}

impl ActiveInputState {
    fn has_seen_message_id(&self, message_id: &str) -> bool {
        self.seen_message_ids.contains(message_id)
    }

    fn remember_message_id(&mut self, message_id: String) {
        if !self.seen_message_ids.insert(message_id.clone()) {
            return;
        }
        self.seen_message_id_order.push_back(message_id);
        while self.seen_message_ids.len() > ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY {
            let Some(oldest) = self.seen_message_id_order.pop_front() else {
                break;
            };
            self.seen_message_ids.remove(&oldest);
        }
    }

    fn forget_message_id(&mut self, message_id: &str) {
        if !self.seen_message_ids.remove(message_id) {
            return;
        }
        if let Some(index) = self
            .seen_message_id_order
            .iter()
            .position(|seen| seen == message_id)
        {
            self.seen_message_id_order.remove(index);
        }
    }

    fn allocate_active_input_uuid(&mut self, run_id: &str, message_id: &str) -> String {
        let sequence = self.next_input_sequence;
        self.next_input_sequence = self.next_input_sequence.saturating_add(1);
        claude_active_input_uuid(run_id, sequence, message_id)
    }

    fn insert_pending(&mut self, uuid: String, input: PendingInput) {
        self.pending_uuid_order.push_back(uuid.clone());
        self.pending_by_uuid.insert(uuid, input);
    }

    fn remove_pending_by_uuid(&mut self, uuid: &str) -> bool {
        if self.pending_by_uuid.remove(uuid).is_none() {
            return false;
        }
        if let Some(index) = self
            .pending_uuid_order
            .iter()
            .position(|pending_uuid| pending_uuid == uuid)
        {
            self.pending_uuid_order.remove(index);
        }
        true
    }

    fn remove_replayable_pending_by_uuid(&mut self, uuid: &str) -> bool {
        let Some(input) = self.pending_by_uuid.get(uuid) else {
            return false;
        };
        if matches!(input.state, PendingState::Accepted) {
            return false;
        }
        self.remove_pending_by_uuid(uuid)
    }

    fn remove_replayable_pending_by_text(&mut self, text: &str) -> bool {
        if !self.initial_prompt_replay_seen && !self.observed_result {
            return false;
        }

        let uuid = self
            .pending_uuid_order
            .iter()
            .find(|uuid| {
                self.pending_by_uuid.get(*uuid).is_some_and(|input| {
                    matches!(
                        input.state,
                        PendingState::Writing
                            | PendingState::WritingWithUuidlessReplay
                            | PendingState::Written
                    ) && input.text == text
                })
            })
            .cloned();
        let Some(uuid) = uuid else {
            return false;
        };

        let Some(input) = self.pending_by_uuid.get_mut(&uuid) else {
            return false;
        };
        match input.state {
            PendingState::Writing => {
                input.state = PendingState::WritingWithUuidlessReplay;
                true
            }
            PendingState::WritingWithUuidlessReplay => true,
            PendingState::Written => self.remove_pending_by_uuid(&uuid),
            PendingState::Accepted => false,
        }
    }

    fn remove_oldest_pending_if_delivered(&mut self) -> bool {
        while let Some(uuid) = self.pending_uuid_order.front().cloned() {
            match self.pending_by_uuid.get(&uuid) {
                Some(input)
                    if matches!(
                        input.state,
                        PendingState::WritingWithUuidlessReplay | PendingState::Written
                    ) =>
                {
                    return self.remove_pending_by_uuid(&uuid);
                }
                Some(_) => return false,
                None => {
                    self.pending_uuid_order.pop_front();
                }
            }
        }
        false
    }
}

#[derive(Debug)]
struct ActiveInputInner {
    enabled: bool,
    run_id: String,
    initial_prompt_uuid: String,
    initial_prompt_text: String,
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

fn claude_active_input_uuid(run_id: &str, sequence: u64, message_id: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:{run_id}:claude-active-input:{sequence}:{message_id}").as_bytes(),
    )
    .to_string()
}

fn user_message_role_allows_replay(event: &Value) -> bool {
    match event.pointer("/message/role") {
        Some(Value::String(role)) => role == "user",
        Some(_) => false,
        None => true,
    }
}

fn parent_tool_use_allows_replay(event: &Value) -> bool {
    matches!(event.get("parent_tool_use_id"), Some(Value::Null) | None)
}

fn replay_event_uuid(event: &Value) -> ReplayEventUuid<'_> {
    match event.get("uuid") {
        Some(Value::String(uuid)) => ReplayEventUuid::String(uuid),
        Some(_) => ReplayEventUuid::NonString,
        None => ReplayEventUuid::Missing,
    }
}

fn prompt_user_content(event: &Value) -> PromptUserContent {
    let Some(content) = event.pointer("/message/content") else {
        return PromptUserContent::Unknown;
    };
    if let Some(text) = content.as_str() {
        return PromptUserContent::Text(text.to_owned());
    }
    let Some(items) = content.as_array() else {
        return PromptUserContent::Unknown;
    };
    if items.is_empty() {
        return PromptUserContent::Unknown;
    }

    let mut text = String::new();
    let mut saw_text = false;
    let mut saw_tool_result = false;
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("tool_result") => {
                saw_tool_result = true;
            }
            Some("text") => {
                let Some(part) = item.get("text").and_then(Value::as_str) else {
                    return PromptUserContent::Unknown;
                };
                saw_text = true;
                text.push_str(part);
            }
            _ => return PromptUserContent::Unknown,
        }
    }

    match (saw_text, saw_tool_result) {
        (true, false) => PromptUserContent::Text(text),
        (false, true) => PromptUserContent::ToolResult,
        _ => PromptUserContent::Unknown,
    }
}

impl ActiveInputRuntime {
    pub fn new_disabled(run_id: &str) -> Self {
        Self::new_with_initial_prompt(run_id, false, "")
    }

    pub fn new_with_initial_prompt(run_id: &str, enabled: bool, initial_prompt_text: &str) -> Self {
        let (tx, rx) = mpsc::channel(ACTIVE_INPUT_QUEUE_CAPACITY);
        let (close_tx, close_rx) = watch::channel(false);
        let controller = ActiveInputController {
            inner: Arc::new(ActiveInputInner {
                enabled,
                run_id: run_id.to_owned(),
                initial_prompt_uuid: claude_initial_prompt_uuid(run_id),
                initial_prompt_text: initial_prompt_text.to_owned(),
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

        let text = payload.text;

        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.lifecycle != Lifecycle::Open {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input is closed",
            };
        }
        if state.has_seen_message_id(message_id) {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input message id is duplicate",
            };
        }
        if state.pending_by_uuid.len() >= ACTIVE_INPUT_QUEUE_CAPACITY {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input queue is full",
            };
        }

        let uuid = state.allocate_active_input_uuid(&self.inner.run_id, message_id);
        let frame = ActiveInputFrame {
            message_id: message_id.to_owned(),
            uuid: uuid.clone(),
            text: text.clone(),
        };
        state.remember_message_id(message_id.to_owned());
        state.insert_pending(
            uuid.clone(),
            PendingInput {
                state: PendingState::Accepted,
                text,
            },
        );

        match self.inner.tx.try_send(frame) {
            Ok(()) => ActiveInputControlOutcome::Accepted,
            Err(mpsc::error::TrySendError::Full(frame)) => {
                state.forget_message_id(&frame.message_id);
                state.remove_pending_by_uuid(&frame.uuid);
                ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input queue is full",
                }
            }
            Err(mpsc::error::TrySendError::Closed(frame)) => {
                state.forget_message_id(&frame.message_id);
                state.remove_pending_by_uuid(&frame.uuid);
                state.lifecycle = Lifecycle::Closed;
                ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input is closed",
                }
            }
        }
    }

    pub fn mark_written(&self, uuid: &str) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let should_remove = match state.pending_by_uuid.get_mut(uuid) {
            Some(input) if matches!(input.state, PendingState::WritingWithUuidlessReplay) => true,
            Some(input) => {
                input.state = PendingState::Written;
                false
            }
            None => false,
        };
        if should_remove {
            state.remove_pending_by_uuid(uuid);
        }
    }

    pub fn mark_writing(&self, uuid: &str) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(input) = state.pending_by_uuid.get_mut(uuid)
            && matches!(input.state, PendingState::Accepted)
        {
            input.state = PendingState::Writing;
        }
    }

    pub fn close_for_result_if_idle(&self) -> bool {
        if !self.inner.enabled {
            return true;
        }

        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let had_observed_result = state.observed_result;
        state.observed_result = true;
        if !state.pending_by_uuid.is_empty() {
            if !had_observed_result {
                return false;
            }
            // Claude should replay stdin user frames before the follow-up
            // result. If replay is missing, a later result can prove progress
            // for the oldest writer-owned input, not for every queued follow-up.
            if !state.remove_oldest_pending_if_delivered() {
                return false;
            }
            if !state.pending_by_uuid.is_empty() {
                return false;
            }
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
        if !user_message_role_allows_replay(event) {
            return ReplayUserEventAction::External;
        }
        if !parent_tool_use_allows_replay(event) {
            return ReplayUserEventAction::External;
        }

        let event_uuid = replay_event_uuid(event);
        if let ReplayEventUuid::String(uuid) = event_uuid {
            if uuid == self.inner.initial_prompt_uuid {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                state.initial_prompt_replay_seen = true;
                return ReplayUserEventAction::InternalInitialPrompt;
            }

            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.remove_replayable_pending_by_uuid(uuid) {
                return ReplayUserEventAction::InternalActiveInput;
            }
        }

        match prompt_user_content(event) {
            PromptUserContent::Text(text) => {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                if event_uuid == ReplayEventUuid::Missing {
                    if state.remove_replayable_pending_by_text(&text) {
                        return ReplayUserEventAction::InternalActiveInput;
                    }
                    if !state.observed_result && text == self.inner.initial_prompt_text {
                        state.initial_prompt_replay_seen = true;
                    }
                }
                ReplayUserEventAction::UnknownPromptUser
            }
            PromptUserContent::ToolResult => ReplayUserEventAction::External,
            PromptUserContent::Unknown => ReplayUserEventAction::UnknownPromptUser,
        }
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

    pub fn mark_writing(&self, uuid: &str) {
        self.controller.mark_writing(uuid);
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
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
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
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
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
        let disabled = ActiveInputRuntime::new_disabled("run-1");
        assert!(matches!(
            disabled
                .controller()
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic }
                if diagnostic == "active input is not supported for this agent"
        ));

        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert!(controller.close_for_result_if_idle());
        assert!(matches!(
            controller.handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
        ));
    }

    #[test]
    fn active_input_capacity_counts_pending_inputs() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
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

    #[tokio::test]
    async fn active_input_bounds_seen_message_id_cache() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        let mut writer = runtime.into_writer();
        let mut first_message_uuid = None;

        for index in 0..=ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY {
            let message_id = format!("msg-{index}");
            let text = format!("follow-up-{index}");
            let payload = serde_json::to_vec(&json!({
                "type": ACTIVE_INPUT_TYPE,
                "text": &text,
            }))
            .expect("active input payload should serialize");
            assert_eq!(
                controller.handle_control_payload(&message_id, &payload),
                ActiveInputControlOutcome::Accepted
            );
            let frame = writer
                .next_frame()
                .await
                .expect("active input frame should be queued");
            assert_eq!(frame.message_id, message_id);
            if index == 0 {
                first_message_uuid = Some(frame.uuid.clone());
            }
            controller.mark_written(&frame.uuid);

            let active = json!({
                "type": "user",
                "uuid": frame.uuid,
                "message": {"role": "user", "content": text}
            });
            assert_eq!(
                controller.replay_user_event_action(&active),
                ReplayUserEventAction::InternalActiveInput
            );
        }

        {
            let state = controller
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert_eq!(
                state.seen_message_ids.len(),
                ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY
            );
            assert!(!state.has_seen_message_id("msg-0"));
            assert!(
                state
                    .has_seen_message_id(&format!("msg-{}", ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY))
            );
        }

        assert!(matches!(
            controller.handle_control_payload(
                &format!("msg-{}", ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY),
                br#"{"type":"active-input","text":"duplicate"}"#
            ),
            ActiveInputControlOutcome::Rejected { diagnostic }
                if diagnostic == "active input message id is duplicate"
        ));
        assert_eq!(
            controller.handle_control_payload("msg-0", br#"{"type":"active-input","text":"old"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let frame = writer
            .next_frame()
            .await
            .expect("reused active input frame should be queued");
        assert_eq!(frame.message_id, "msg-0");
        assert_ne!(
            frame.uuid,
            first_message_uuid.expect("first active input uuid should be captured")
        );
    }

    #[test]
    fn replay_filter_consumes_initial_and_active_input_user_events() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");

        let initial = json!({
            "type": "user",
            "uuid": claude_initial_prompt_uuid("run-1"),
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::InternalInitialPrompt
        );
        controller.mark_written(&active_uuid);

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
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
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
    fn replay_filter_keeps_multi_tool_result_user_events_external() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tool-1"},
                    {"type": "tool_result", "tool_use_id": "tool-2"}
                ]
            }
        });

        assert_eq!(
            runtime.controller().replay_user_event_action(&event),
            ReplayUserEventAction::External
        );
    }

    #[test]
    fn replay_filter_filters_mixed_text_and_tool_result_user_events() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "prompt-like text"},
                    {"type": "tool_result", "tool_use_id": "tool-1"}
                ]
            }
        });

        assert_eq!(
            runtime.controller().replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
    }

    #[test]
    fn replay_filter_consumes_matching_uuid_even_with_non_string_content() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
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
        controller.mark_written(&claude_active_input_uuid("run-1", 0, "msg-1"));

        let active = json!({
            "type": "user",
            "uuid": claude_active_input_uuid("run-1", 0, "msg-1"),
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
    fn replay_filter_does_not_consume_accepted_uuid_before_writer_owns_input() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        let stale = json!({
            "type": "user",
            "uuid": active_uuid,
            "message": {"role": "user", "content": "follow-up"}
        });

        assert_eq!(
            controller.replay_user_event_action(&stale),
            ReplayUserEventAction::UnknownPromptUser
        );
        assert!(!controller.close_for_result_if_idle());

        controller.mark_writing(&claude_active_input_uuid("run-1", 0, "msg-1"));
        let replay = json!({
            "type": "user",
            "uuid": claude_active_input_uuid("run-1", 0, "msg-1"),
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&replay),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_treats_text_block_user_events_without_uuid_as_unknown_prompt() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
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

    #[test]
    fn replay_filter_consumes_uuidless_active_input_replay_by_text() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);
        assert!(!controller.close_for_result_if_idle());

        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_consumes_oldest_uuidless_text_match() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();

        for message_id in ["msg-1", "msg-2"] {
            assert_eq!(
                controller.handle_control_payload(
                    message_id,
                    br#"{"type":"active-input","text":"same-text"}"#
                ),
                ActiveInputControlOutcome::Accepted
            );
        }
        let first_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        let second_uuid = claude_active_input_uuid("run-1", 1, "msg-2");
        controller.mark_written(&first_uuid);
        controller.mark_written(&second_uuid);
        assert!(!controller.close_for_result_if_idle());

        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "same-text"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        {
            let state = controller
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(!state.pending_by_uuid.contains_key(&first_uuid));
            assert!(state.pending_by_uuid.contains_key(&second_uuid));
        }

        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_defers_uuidless_text_match_while_writing_until_written() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_writing(&active_uuid);
        assert!(!controller.close_for_result_if_idle());

        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        {
            let state = controller
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(state.pending_by_uuid.contains_key(&active_uuid));
        }

        controller.mark_written(&active_uuid);
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_clears_multiple_uuidless_writing_replays_after_writes() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();

        for (message_id, text) in [("msg-1", "first"), ("msg-2", "second")] {
            let payload = serde_json::to_vec(&json!({
                "type": ACTIVE_INPUT_TYPE,
                "text": text,
            }))
            .expect("active input payload should serialize");
            assert_eq!(
                controller.handle_control_payload(message_id, &payload),
                ActiveInputControlOutcome::Accepted
            );
        }
        let first_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        let second_uuid = claude_active_input_uuid("run-1", 1, "msg-2");
        assert!(!controller.close_for_result_if_idle());

        for (uuid, text) in [(&first_uuid, "first"), (&second_uuid, "second")] {
            controller.mark_writing(uuid);
            let event = json!({
                "type": "user",
                "message": {"role": "user", "content": text}
            });
            assert_eq!(
                controller.replay_user_event_action(&event),
                ReplayUserEventAction::InternalActiveInput
            );
            controller.mark_written(uuid);
        }

        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn followup_result_can_close_after_uuidless_replay_before_mark_written() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        assert!(!controller.close_for_result_if_idle());

        controller.mark_writing(&active_uuid);
        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );

        assert!(controller.close_for_result_if_idle());
        controller.mark_written(&active_uuid);
        assert!(matches!(
            controller.handle_control_payload("msg-2", br#"{"type":"active-input","text":"late"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
        ));
    }

    #[test]
    fn mark_writing_does_not_regress_replay_observed_pending_input() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        assert!(!controller.close_for_result_if_idle());

        controller.mark_writing(&active_uuid);
        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );

        controller.mark_writing(&active_uuid);
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_consume_unwritten_uuidless_text_match() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"same-text"}"#),
            ActiveInputControlOutcome::Accepted
        );

        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "same-text"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
        assert!(!controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_consume_uuidless_text_match_before_first_result() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"same-text"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": "same-text"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
        assert!(!controller.close_for_result_if_idle());
    }

    #[test]
    fn followup_result_closes_writer_owned_pending_input_without_replay() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        assert!(!controller.close_for_result_if_idle());
        assert!(controller.close_for_result_if_idle());
        assert!(matches!(
            controller.handle_control_payload("msg-2", br#"{"type":"active-input","text":"late"}"#),
            ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
        ));
    }

    #[test]
    fn followup_result_without_replay_completes_one_written_pending_input_at_a_time() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();

        for message_id in ["msg-1", "msg-2"] {
            assert_eq!(
                controller.handle_control_payload(
                    message_id,
                    br#"{"type":"active-input","text":"follow-up"}"#
                ),
                ActiveInputControlOutcome::Accepted
            );
        }
        let first_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        let second_uuid = claude_active_input_uuid("run-1", 1, "msg-2");
        controller.mark_written(&first_uuid);
        controller.mark_written(&second_uuid);

        assert!(!controller.close_for_result_if_idle());
        assert!(!controller.close_for_result_if_idle());
        {
            let state = controller
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(!state.pending_by_uuid.contains_key(&first_uuid));
            assert!(state.pending_by_uuid.contains_key(&second_uuid));
        }
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn followup_result_without_replay_keeps_later_unwritten_pending_input_open() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();

        for message_id in ["msg-1", "msg-2"] {
            assert_eq!(
                controller.handle_control_payload(
                    message_id,
                    br#"{"type":"active-input","text":"follow-up"}"#
                ),
                ActiveInputControlOutcome::Accepted
            );
        }
        let first_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        let second_uuid = claude_active_input_uuid("run-1", 1, "msg-2");
        controller.mark_written(&first_uuid);

        assert!(!controller.close_for_result_if_idle());
        assert!(!controller.close_for_result_if_idle());
        {
            let state = controller
                .inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(!state.pending_by_uuid.contains_key(&first_uuid));
            assert!(state.pending_by_uuid.contains_key(&second_uuid));
        }
        assert!(!controller.close_for_result_if_idle());

        controller.mark_written(&second_uuid);
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn followup_result_keeps_writing_pending_input_open_without_replay() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_writing(&active_uuid);

        assert!(!controller.close_for_result_if_idle());
        assert!(!controller.close_for_result_if_idle());
        controller.mark_written(&active_uuid);
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn followup_result_keeps_unwritten_pending_input_open_without_replay() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );

        assert!(!controller.close_for_result_if_idle());
        assert!(!controller.close_for_result_if_idle());
        assert_eq!(
            controller
                .handle_control_payload("msg-2", br#"{"type":"active-input","text":"still-open"}"#),
            ActiveInputControlOutcome::Accepted
        );
    }

    #[test]
    fn replay_filter_consumes_uuidless_text_match_after_initial_replay_before_first_result() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_consume_text_match_with_unknown_uuid() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);
        assert!(!controller.close_for_result_if_idle());

        let unknown_uuid = json!({
            "type": "user",
            "uuid": "not-vm0-active-input",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&unknown_uuid),
            ReplayUserEventAction::UnknownPromptUser
        );

        let uuidless = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&uuidless),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_consume_text_match_with_non_string_uuid() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);
        assert!(!controller.close_for_result_if_idle());

        for uuid in [json!(123), Value::Null] {
            let event = json!({
                "type": "user",
                "uuid": uuid,
                "message": {"role": "user", "content": "follow-up"}
            });
            assert_eq!(
                controller.replay_user_event_action(&event),
                ReplayUserEventAction::UnknownPromptUser
            );
        }

        let uuidless = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&uuidless),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_unlock_initial_prompt_from_unknown_uuid() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let unknown_uuid_initial_text = json!({
            "type": "user",
            "uuid": "not-vm0-initial-prompt",
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&unknown_uuid_initial_text),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active_before_initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active_before_initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let initial = json!({
            "type": "user",
            "uuid": claude_initial_prompt_uuid("run-1"),
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::InternalInitialPrompt
        );

        let active_after_initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active_after_initial),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_unlock_initial_prompt_from_non_string_uuid() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let malformed_initial = json!({
            "type": "user",
            "uuid": 123,
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&malformed_initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active_before_initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active_before_initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active_after_initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active_after_initial),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_waits_for_second_uuidless_same_text_before_first_result() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "same-text");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"same-text"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "same-text"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active = json!({
            "type": "user",
            "message": {"role": "user", "content": "same-text"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_consumes_uuidless_text_block_active_input_replay() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);
        assert!(!controller.close_for_result_if_idle());

        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "follow-up"}]
            }
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_filters_unknown_user_content_blocks() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");

        for content in [
            json!([{"type": "image", "source": "future-schema"}]),
            json!({"type": "future-schema"}),
            json!([]),
        ] {
            let event = json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": content
                }
            });

            assert_eq!(
                runtime.controller().replay_user_event_action(&event),
                ReplayUserEventAction::UnknownPromptUser
            );
        }
    }

    #[test]
    fn replay_filter_keeps_non_user_role_events_external_without_advancing_prompt_replay() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "follow-up");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let malformed = json!({
            "type": "user",
            "message": {"role": "assistant", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&malformed),
            ReplayUserEventAction::External
        );

        let first_valid_prompt_like = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&first_valid_prompt_like),
            ReplayUserEventAction::UnknownPromptUser
        );

        let second_valid_prompt_like = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&second_valid_prompt_like),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_keeps_non_user_role_uuid_matches_external() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let malformed = json!({
            "type": "user",
            "uuid": active_uuid,
            "message": {"role": "assistant", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&malformed),
            ReplayUserEventAction::External
        );

        let replay = json!({
            "type": "user",
            "uuid": claude_active_input_uuid("run-1", 0, "msg-1"),
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&replay),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_keeps_non_string_role_events_external() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let malformed = json!({
            "type": "user",
            "uuid": active_uuid,
            "message": {"role": 123, "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&malformed),
            ReplayUserEventAction::External
        );

        let replay = json!({
            "type": "user",
            "uuid": claude_active_input_uuid("run-1", 0, "msg-1"),
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&replay),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_keeps_child_user_events_external() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let child = json!({
            "type": "user",
            "uuid": active_uuid,
            "parent_tool_use_id": "tool-1",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&child),
            ReplayUserEventAction::External
        );

        let replay = json!({
            "type": "user",
            "uuid": claude_active_input_uuid("run-1", 0, "msg-1"),
            "parent_tool_use_id": null,
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&replay),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }

    #[test]
    fn replay_filter_does_not_unlock_uuidless_match_from_non_initial_prompt_like_event() {
        let runtime = ActiveInputRuntime::new_with_initial_prompt("run-1", true, "initial");
        let controller = runtime.controller();
        assert_eq!(
            controller
                .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let active_uuid = claude_active_input_uuid("run-1", 0, "msg-1");
        controller.mark_written(&active_uuid);

        let historical = json!({
            "type": "user",
            "message": {"role": "user", "content": "historical"}
        });
        assert_eq!(
            controller.replay_user_event_action(&historical),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active_before_initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active_before_initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "initial"}
        });
        assert_eq!(
            controller.replay_user_event_action(&initial),
            ReplayUserEventAction::UnknownPromptUser
        );

        let active_after_initial = json!({
            "type": "user",
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&active_after_initial),
            ReplayUserEventAction::InternalActiveInput
        );
        assert!(controller.close_for_result_if_idle());
    }
}
