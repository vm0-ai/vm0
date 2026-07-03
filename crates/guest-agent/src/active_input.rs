//! Guest-agent local active-input state shared by CLI follow-up sinks.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const ACTIVE_INPUT_TYPE: &str = "active-input";
const ACTIVE_INPUT_QUEUE_CAPACITY: usize = 8;
const ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY: usize = 1024;

/// Accepted follow-up user input waiting for the CLI follow-up sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveInputFrame {
    /// Control-plane message id used for duplicate detection and diagnostics.
    pub message_id: String,
    /// Deterministic vm0 frame UUID assigned to this active input.
    pub uuid: String,
    /// Follow-up user text to deliver to the running CLI process.
    pub text: String,
}

/// Result returned to the process-control caller for an active-input payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActiveInputControlOutcome {
    /// The payload was accepted and queued for the CLI follow-up sink.
    Accepted,
    /// The payload was rejected without being queued.
    Rejected { diagnostic: &'static str },
    /// The payload could not be queued because the active-input backlog is full.
    QueueFull { diagnostic: &'static str },
    /// The payload failed with a control-path error.
    Error { diagnostic: &'static str },
}

/// Classification of a CLI stdout user event during active-input replay filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayUserEventAction {
    /// A normal external user event that should continue through event delivery.
    External,
    /// The CLI replayed the run's initial prompt frame.
    InternalInitialPrompt,
    /// The CLI replayed an accepted active-input follow-up frame.
    InternalActiveInput,
    /// A prompt-like user event could not be attributed to known run input.
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

/// Cloneable control-plane side of active input for one guest-agent run.
///
/// The process-control task uses this handle to accept or reject follow-up user
/// input while CLI execution uses the paired [`ActiveInputWriter`] to consume
/// accepted frames. The controller also classifies CLI stdout user events so
/// internally replayed input can be kept out of outbound event delivery.
#[derive(Debug, Clone)]
pub struct ActiveInputController {
    inner: Arc<ActiveInputInner>,
}

/// Single-consumer CLI follow-up side of active input for one guest-agent run.
///
/// `execute_cli_with_active_input` consumes this writer for the lifetime of one
/// CLI execution. It yields accepted follow-up input frames and observes the
/// same terminal close signal as the paired [`ActiveInputController`].
#[derive(Debug)]
pub struct ActiveInputWriter {
    controller: ActiveInputController,
    rx: mpsc::Receiver<ActiveInputFrame>,
    close_rx: watch::Receiver<bool>,
}

/// Paired active-input state for one guest-agent run.
///
/// The runtime creates a cloneable [`ActiveInputController`] for control-plane
/// requests and a single [`ActiveInputWriter`] for CLI follow-up delivery. Consuming
/// the runtime with [`ActiveInputRuntime::into_writer`] transfers the writer to
/// the CLI execution path.
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
            return ActiveInputControlOutcome::QueueFull {
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
                ActiveInputControlOutcome::QueueFull {
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

    /// Mark a writer-owned frame delivered by a sink that will not emit a
    /// replayed user event back through CLI stdout.
    fn mark_written_without_replay(&self, uuid: &str) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.remove_pending_by_uuid(uuid);
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

    pub(crate) fn try_next_frame(&mut self) -> Option<ActiveInputFrame> {
        if *self.close_rx.borrow() {
            return None;
        }
        self.rx.try_recv().ok()
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

    pub(crate) fn mark_written_without_replay(&self, uuid: &str) {
        self.controller.mark_written_without_replay(uuid);
    }

    pub fn mark_writing(&self, uuid: &str) {
        self.controller.mark_writing(uuid);
    }

    pub fn close_terminal(&self) {
        self.controller.close_terminal();
    }
}

#[cfg(test)]
mod tests;
