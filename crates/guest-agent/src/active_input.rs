//! Guest-agent local active-input state shared by CLI follow-up sinks.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Deserializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::active_input_receipts::ActiveInputReceiptRuntime;
use crate::error::AgentError;
use crate::http::HttpClient;

const ACTIVE_INPUT_TYPE: &str = "active-input";
const ACTIVE_INPUT_QUEUE_CAPACITY: usize = 8;
const ACTIVE_INPUT_DELIVERY_ID_CAPACITY: usize =
    guest_contracts::active_input_receipts::MAX_ACTIVE_INPUT_RECEIPT_IDS;

/// Accepted follow-up user input waiting for the CLI follow-up sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveInputFrame {
    /// Deterministic vm0 frame UUID assigned to this active input.
    pub uuid: String,
    /// Follow-up user text to deliver to the running CLI process.
    pub text: String,
    delivery_id: Option<String>,
}

impl ActiveInputFrame {
    /// Return the durable delivery identity when this is a new-protocol frame.
    pub fn delivery_id(&self) -> Option<&str> {
        self.delivery_id.as_deref()
    }
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
enum DurableDeliveryState {
    Queued,
    Writing,
    Accepted,
    Failed,
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
struct DurableDelivery {
    text_digest: Option<[u8; 32]>,
    state: DurableDeliveryState,
}

#[derive(Debug)]
struct ActiveInputState {
    lifecycle: Lifecycle,
    initial_prompt_replay_seen: bool,
    observed_result: bool,
    next_input_sequence: u64,
    pending_uuid_order: VecDeque<String>,
    pending_by_uuid: HashMap<String, PendingInput>,
    durable_by_id: HashMap<String, DurableDelivery>,
    accepted_delivery_ids: Vec<String>,
}

impl Default for ActiveInputState {
    fn default() -> Self {
        Self {
            lifecycle: Lifecycle::Open,
            initial_prompt_replay_seen: false,
            observed_result: false,
            next_input_sequence: 0,
            pending_uuid_order: VecDeque::new(),
            pending_by_uuid: HashMap::new(),
            durable_by_id: HashMap::new(),
            accepted_delivery_ids: Vec::new(),
        }
    }
}

impl ActiveInputState {
    fn allocate_active_input_uuid(&mut self, run_id: &str) -> String {
        let sequence = self.next_input_sequence;
        self.next_input_sequence = self.next_input_sequence.saturating_add(1);
        claude_active_input_uuid(run_id, sequence)
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

    fn mark_pending_written(&mut self, uuid: &str) {
        let should_remove = match self.pending_by_uuid.get_mut(uuid) {
            Some(input) if matches!(input.state, PendingState::WritingWithUuidlessReplay) => true,
            Some(input) => {
                input.state = PendingState::Written;
                false
            }
            None => false,
        };
        if should_remove {
            self.remove_pending_by_uuid(uuid);
        }
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
    durable_in_flight_tx: watch::Sender<bool>,
    receipts: Option<ActiveInputReceiptRuntime>,
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
    // Optional until #26060 switches every Runner sender to identified delivery.
    #[serde(
        default,
        rename = "deliveryId",
        deserialize_with = "deserialize_delivery_id"
    )]
    delivery_id: Option<String>,
    text: String,
}

fn deserialize_delivery_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

/// Derives the deterministic Claude user-frame UUID for the run's initial prompt.
///
/// Claude stream-JSON stdin writers use this UUID when sending the initial
/// prompt, and replay filtering uses the same derivation to identify that
/// echoed prompt in CLI stdout. Callers that need to produce or recognize the
/// initial prompt frame should use this helper instead of duplicating the UUID
/// derivation.
pub fn claude_initial_prompt_uuid(run_id: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:{run_id}:claude-initial-prompt").as_bytes(),
    )
    .to_string()
}

fn claude_active_input_uuid(run_id: &str, sequence: u64) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:{run_id}:claude-active-input:{sequence}").as_bytes(),
    )
    .to_string()
}

fn active_input_text_digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
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
    /// Creates a runtime whose controller rejects active-input control payloads.
    ///
    /// The paired writer still exists so the CLI execution path can use the
    /// same ownership and shutdown flow as enabled runs, but no follow-up frames
    /// will be accepted from the process-control side.
    pub fn new_disabled(run_id: &str) -> Self {
        Self::new_with_initial_prompt(run_id, false, "")
    }

    /// Creates the controller/writer pair for one guest-agent run.
    ///
    /// When `enabled` is `false`, control payloads are rejected while the writer
    /// can still be closed through the normal CLI lifecycle. When `enabled` is
    /// `true`, accepted active-input frames are queued for the single writer.
    /// `initial_prompt_text` is retained for replay filtering when CLI stdout
    /// emits a prompt-like user event without the expected initial-prompt UUID.
    pub fn new_with_initial_prompt(run_id: &str, enabled: bool, initial_prompt_text: &str) -> Self {
        Self::new_internal(run_id, enabled, initial_prompt_text, None, Vec::new())
    }

    /// Create an active-input runtime with durable acceptance receipts.
    pub fn new_with_receipts(
        run_id: &str,
        enabled: bool,
        initial_prompt_text: &str,
        receipt_journal_path: impl AsRef<Path>,
        http: HttpClient,
    ) -> io::Result<Self> {
        let (receipts, recovered_delivery_ids) =
            ActiveInputReceiptRuntime::start(run_id, receipt_journal_path, http)?;
        Ok(Self::new_internal(
            run_id,
            enabled,
            initial_prompt_text,
            Some(receipts),
            recovered_delivery_ids,
        ))
    }

    fn new_internal(
        run_id: &str,
        enabled: bool,
        initial_prompt_text: &str,
        receipts: Option<ActiveInputReceiptRuntime>,
        recovered_delivery_ids: Vec<String>,
    ) -> Self {
        let (tx, rx) = mpsc::channel(ACTIVE_INPUT_QUEUE_CAPACITY);
        let (close_tx, close_rx) = watch::channel(false);
        let (durable_in_flight_tx, _) = watch::channel(false);
        let mut state = ActiveInputState::default();
        for delivery_id in recovered_delivery_ids {
            state.durable_by_id.insert(
                delivery_id.clone(),
                DurableDelivery {
                    text_digest: None,
                    state: DurableDeliveryState::Accepted,
                },
            );
            state.accepted_delivery_ids.push(delivery_id);
        }
        let controller = ActiveInputController {
            inner: Arc::new(ActiveInputInner {
                enabled,
                run_id: run_id.to_owned(),
                initial_prompt_uuid: claude_initial_prompt_uuid(run_id),
                initial_prompt_text: initial_prompt_text.to_owned(),
                tx,
                close_tx,
                durable_in_flight_tx,
                receipts,
                state: Mutex::new(state),
            }),
        };
        let writer = ActiveInputWriter {
            controller: controller.clone(),
            rx,
            close_rx,
        };
        Self { controller, writer }
    }

    /// Returns a cloneable control-plane handle for this runtime.
    ///
    /// Controllers may be cloned for process-control and event-filtering paths;
    /// they all coordinate with the same single writer owned by this runtime.
    pub fn controller(&self) -> ActiveInputController {
        self.controller.clone()
    }

    /// Transfers the single active-input writer to the CLI execution path.
    ///
    /// The writer is intentionally single-consumer. After this call, the
    /// runtime is consumed and only cloned controllers can continue to handle
    /// control payloads or classify replayed user events.
    pub fn into_writer(self) -> ActiveInputWriter {
        self.writer
    }
}

impl ActiveInputController {
    /// Returns whether this run was configured to support active input.
    ///
    /// Disabled runs keep the same controller/writer lifecycle shape, but
    /// [`ActiveInputController::handle_control_payload`] rejects follow-up
    /// input instead of queueing frames. Enabled runs may still reject payloads
    /// later if active input has closed or the bounded backlog is full.
    pub fn is_enabled(&self) -> bool {
        self.inner.enabled
    }

    /// Validates and queues one process-control active-input payload.
    ///
    /// `payload` must be a JSON object with the required string fields `type`
    /// and `text`. `type` must equal `active-input`, and `text` must be non-empty.
    /// A canonical UUID `deliveryId` opts into durable deduplication and
    /// backend-acceptance receipts:
    ///
    /// ```json
    /// {"type":"active-input","deliveryId":"b1e2ad6d-930a-4d51-aa40-7952d54f978b","text":"follow-up prompt"}
    /// ```
    ///
    /// The method returns [`ActiveInputControlOutcome::Accepted`] only after the
    /// follow-up frame has been queued for the paired writer, or a known
    /// delivery ID has already been queued or accepted. Unsupported, invalid,
    /// disabled, or closed inputs are rejected. A bounded backlog returns
    /// [`ActiveInputControlOutcome::QueueFull`] so callers can distinguish
    /// backpressure from validation rejection. Callers should branch on the
    /// outcome variant rather than treating diagnostic text as a stable protocol.
    pub fn handle_control_payload(&self, payload: &[u8]) -> ActiveInputControlOutcome {
        if !self.inner.enabled {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input is not supported for this agent",
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
        let delivery = match payload.delivery_id {
            Some(delivery_id) => {
                let Ok(parsed) = Uuid::parse_str(&delivery_id) else {
                    return ActiveInputControlOutcome::Rejected {
                        diagnostic: "active input delivery id is invalid",
                    };
                };
                let canonical_delivery_id = parsed.hyphenated().to_string();
                if canonical_delivery_id != delivery_id {
                    return ActiveInputControlOutcome::Rejected {
                        diagnostic: "active input delivery id is not canonical",
                    };
                }
                if self.inner.receipts.is_none() {
                    return ActiveInputControlOutcome::Rejected {
                        diagnostic: "active input receipt persistence is unavailable",
                    };
                }
                Some((canonical_delivery_id, active_input_text_digest(&text)))
            }
            None => None,
        };

        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((delivery_id, text_digest)) = &delivery
            && let Some(existing) = state.durable_by_id.get(delivery_id)
        {
            if existing
                .text_digest
                .is_some_and(|existing_digest| existing_digest != *text_digest)
            {
                return ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input delivery id was reused with different text",
                };
            }
            return match existing.state {
                DurableDeliveryState::Queued
                | DurableDeliveryState::Writing
                | DurableDeliveryState::Accepted => ActiveInputControlOutcome::Accepted,
                DurableDeliveryState::Failed => ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input delivery previously failed",
                },
            };
        }
        if state.lifecycle != Lifecycle::Open {
            return ActiveInputControlOutcome::Rejected {
                diagnostic: "active input is closed",
            };
        }
        if delivery.is_some() && state.durable_by_id.len() >= ACTIVE_INPUT_DELIVERY_ID_CAPACITY {
            return ActiveInputControlOutcome::QueueFull {
                diagnostic: "active input delivery backlog is full",
            };
        }
        if state.pending_by_uuid.len() >= ACTIVE_INPUT_QUEUE_CAPACITY {
            return ActiveInputControlOutcome::QueueFull {
                diagnostic: "active input queue is full",
            };
        }

        let uuid = delivery.as_ref().map_or_else(
            || state.allocate_active_input_uuid(&self.inner.run_id),
            |value| value.0.clone(),
        );
        let frame = ActiveInputFrame {
            uuid: uuid.clone(),
            text: text.clone(),
            delivery_id: delivery.as_ref().map(|value| value.0.clone()),
        };
        state.insert_pending(
            uuid.clone(),
            PendingInput {
                state: PendingState::Accepted,
                text,
            },
        );
        if let Some((delivery_id, text_digest)) = delivery {
            state.durable_by_id.insert(
                delivery_id,
                DurableDelivery {
                    text_digest: Some(text_digest),
                    state: DurableDeliveryState::Queued,
                },
            );
        }

        match self.inner.tx.try_send(frame) {
            Ok(()) => ActiveInputControlOutcome::Accepted,
            Err(mpsc::error::TrySendError::Full(frame)) => {
                state.remove_pending_by_uuid(&frame.uuid);
                if let Some(delivery_id) = frame.delivery_id() {
                    state.durable_by_id.remove(delivery_id);
                }
                ActiveInputControlOutcome::QueueFull {
                    diagnostic: "active input queue is full",
                }
            }
            Err(mpsc::error::TrySendError::Closed(frame)) => {
                state.remove_pending_by_uuid(&frame.uuid);
                if let Some(delivery_id) = frame.delivery_id() {
                    state.durable_by_id.remove(delivery_id);
                }
                state.lifecycle = Lifecycle::Closed;
                ActiveInputControlOutcome::Rejected {
                    diagnostic: "active input is closed",
                }
            }
        }
    }

    /// Marks a writer-owned frame as delivered to its follow-up sink.
    ///
    /// Writers should call this after successfully writing the frame to stdin
    /// or an equivalent transport. The mark lets replay filtering later match
    /// the CLI's echoed user event, or finish cleanup if a uuidless replay was
    /// already observed. Unknown UUIDs are ignored.
    pub fn mark_written(&self, uuid: &str) {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mark_pending_written(uuid);
    }

    /// Mark a writer-owned frame delivered by a sink that will not emit a
    /// replayed user event back through CLI stdout.
    fn mark_written_without_replay(&self, uuid: &str) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.remove_pending_by_uuid(uuid);
    }

    fn mark_backend_accepted(
        &self,
        frame: &ActiveInputFrame,
        expects_replay: bool,
    ) -> Result<(), AgentError> {
        let Some(delivery_id) = frame.delivery_id() else {
            if expects_replay {
                self.mark_written(&frame.uuid);
            } else {
                self.mark_written_without_replay(&frame.uuid);
            }
            return Ok(());
        };
        let Some(receipts) = self.inner.receipts.as_ref() else {
            self.mark_backend_failed(frame);
            return Err(AgentError::Execution(
                "active-input receipt persistence is unavailable".to_string(),
            ));
        };
        if let Err(error) = receipts.persist_acceptance(delivery_id) {
            self.mark_backend_failed(frame);
            return Err(AgentError::Io(error));
        }

        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let delivery = state.durable_by_id.get_mut(delivery_id).ok_or_else(|| {
            AgentError::Execution(
                "accepted active-input delivery is missing from live state".to_string(),
            )
        })?;
        delivery.state = DurableDeliveryState::Accepted;
        if !state
            .accepted_delivery_ids
            .iter()
            .any(|accepted_id| accepted_id == delivery_id)
        {
            state.accepted_delivery_ids.push(delivery_id.to_owned());
        }
        if expects_replay {
            state.mark_pending_written(&frame.uuid);
        } else {
            state.remove_pending_by_uuid(&frame.uuid);
        }
        drop(state);
        self.inner.durable_in_flight_tx.send_replace(false);
        Ok(())
    }

    fn mark_backend_failed(&self, frame: &ActiveInputFrame) {
        let Some(delivery_id) = frame.delivery_id() else {
            return;
        };
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(delivery) = state.durable_by_id.get_mut(delivery_id) {
            delivery.state = DurableDeliveryState::Failed;
        }
        state.remove_pending_by_uuid(&frame.uuid);
        drop(state);
        self.inner.durable_in_flight_tx.send_replace(false);
    }

    /// Marks a writer-owned frame as actively being delivered.
    ///
    /// Writers should call this immediately before starting delivery to stdin
    /// or another follow-up sink. Replay filtering only treats writer-owned
    /// input as internally replayable, which prevents stale events from
    /// consuming accepted frames that have not reached the CLI. Unknown UUIDs
    /// are ignored.
    pub fn mark_writing(&self, uuid: &str) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(input) = state.pending_by_uuid.get_mut(uuid)
            && matches!(input.state, PendingState::Accepted)
        {
            input.state = PendingState::Writing;
        }
        let durable_writing = if let Some(delivery) = state.durable_by_id.get_mut(uuid) {
            delivery.state = DurableDeliveryState::Writing;
            true
        } else {
            false
        };
        drop(state);
        if durable_writing {
            self.inner.durable_in_flight_tx.send_replace(true);
        }
    }

    /// Return whether any delivery-identified input participated in this run.
    pub fn has_durable_activity(&self) -> bool {
        !self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .durable_by_id
            .is_empty()
    }

    /// Return whether a delivery-identified sink operation is in flight.
    pub fn durable_sink_in_flight(&self) -> bool {
        *self.inner.durable_in_flight_tx.borrow()
    }

    /// Wait until the current delivery-identified sink operation settles.
    pub async fn wait_for_durable_sink_idle(&self) -> Result<(), AgentError> {
        let mut receiver = self.inner.durable_in_flight_tx.subscribe();
        while *receiver.borrow() {
            receiver.changed().await.map_err(|_| {
                AgentError::Execution(
                    "active-input sink progress channel closed unexpectedly".to_string(),
                )
            })?;
        }
        Ok(())
    }

    /// Stop direct receipt delivery and return every backend-accepted ID.
    pub async fn finalize_receipts(&self) -> Result<Vec<String>, AgentError> {
        let sink_in_flight = self.durable_sink_in_flight();
        if let Some(receipts) = self.inner.receipts.as_ref() {
            receipts.finalize().await;
        }
        if sink_in_flight {
            return Err(AgentError::Execution(
                "active-input sink did not reach quiescence".to_string(),
            ));
        }
        Ok(self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .accepted_delivery_ids
            .clone())
    }

    /// Attempts to close active input after a CLI result event.
    ///
    /// A `true` return means the caller can treat active input as idle for this
    /// result. For enabled runs, this also signals the writer to close when the
    /// runtime is still open. A `false` return means there is still pending
    /// input to observe or clear, or the runtime was already closing or closed.
    ///
    /// This is a result-time idle check, not an unconditional terminal close.
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

    /// Closes active input terminally for this run.
    ///
    /// This wakes the paired writer, causes future [`ActiveInputWriter::next_frame`]
    /// calls to resolve with `None`, and makes subsequent enabled control
    /// payloads reject as closed.
    pub fn close_terminal(&self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.lifecycle = Lifecycle::Closed;
        let _ = self.inner.close_tx.send(true);
    }

    /// Classifies a CLI stdout user event for replay filtering.
    ///
    /// [`ReplayUserEventAction::External`] means the event is external Claude
    /// Code output and should continue through event delivery.
    /// [`ReplayUserEventAction::InternalInitialPrompt`] and
    /// [`ReplayUserEventAction::InternalActiveInput`] mean the event is an
    /// internal echo of input vm0 already delivered and should be filtered.
    /// [`ReplayUserEventAction::UnknownPromptUser`] means the event looks like a
    /// prompt-style user event but cannot be attributed to known input, so
    /// callers should handle it conservatively.
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
    /// Returns the controller paired with this writer.
    ///
    /// The returned controller clone observes and mutates the same run-scoped
    /// active-input state as this writer.
    pub fn controller(&self) -> ActiveInputController {
        self.controller.clone()
    }

    pub(crate) fn try_next_frame(&mut self) -> Option<ActiveInputFrame> {
        if *self.close_rx.borrow() {
            return None;
        }
        self.rx.try_recv().ok()
    }

    /// Waits for the next accepted follow-up frame.
    ///
    /// This writer is the single consumer of frames accepted by the paired
    /// controller. The method returns `None` when active input has been closed
    /// or when no further frames can be received.
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

    /// Returns whether the paired controller was configured to support active input.
    pub fn is_enabled(&self) -> bool {
        self.controller.is_enabled()
    }

    /// Marks a writer-owned frame as delivered.
    ///
    /// This delegates to [`ActiveInputController::mark_written`] and should be
    /// called after the writer sink has successfully delivered the frame.
    pub fn mark_written(&self, uuid: &str) {
        self.controller.mark_written(uuid);
    }

    /// Persist backend acceptance for a sink whose user frame is replayed.
    pub fn mark_backend_accepted_with_replay(
        &self,
        frame: &ActiveInputFrame,
    ) -> Result<(), AgentError> {
        self.controller.mark_backend_accepted(frame, true)
    }

    /// Persist backend acceptance for a sink without user-frame replay.
    pub fn mark_backend_accepted_without_replay(
        &self,
        frame: &ActiveInputFrame,
    ) -> Result<(), AgentError> {
        self.controller.mark_backend_accepted(frame, false)
    }

    /// Mark a delivery-identified sink operation as failed.
    pub fn mark_backend_failed(&self, frame: &ActiveInputFrame) {
        self.controller.mark_backend_failed(frame);
    }

    #[cfg(test)]
    pub(crate) fn mark_written_without_replay(&self, uuid: &str) {
        self.controller.mark_written_without_replay(uuid);
    }

    /// Marks a writer-owned frame as actively being delivered by this writer.
    ///
    /// This delegates to [`ActiveInputController::mark_writing`] and should be
    /// paired with [`ActiveInputWriter::mark_written`] after delivery succeeds.
    pub fn mark_writing(&self, uuid: &str) {
        self.controller.mark_writing(uuid);
    }

    /// Closes active input terminally through the paired controller.
    pub fn close_terminal(&self) {
        self.controller.close_terminal();
    }
}

#[cfg(test)]
mod tests;
