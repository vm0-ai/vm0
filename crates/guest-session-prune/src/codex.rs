use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};

use serde_json::{Map, Value};
use uuid::Uuid;

use super::{
    BoundedRecord, READ_BUFFER_BYTES, SelectionLimits, read_bounded_record, strip_jsonl_line_ending,
};

/// Maximum decoded size of an accepted Codex compact generation.
pub const CODEX_COMPACT_GENERATION_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum size of one Codex JSONL record inspected by the selector.
pub const CODEX_JSONL_RECORD_MAX_BYTES: usize = 16 * 1024 * 1024;

const PRODUCTION_LIMITS: SelectionLimits = SelectionLimits {
    candidate_max_bytes: CODEX_COMPACT_GENERATION_MAX_BYTES,
    record_max_bytes: CODEX_JSONL_RECORD_MAX_BYTES,
};

/// Result of attempting to select a bounded Codex compact generation.
#[derive(Debug, PartialEq, Eq)]
#[must_use]
pub enum CodexHistorySelection {
    /// A structurally valid raw compact generation was selected.
    Candidate(CodexHistoryCandidate),
    /// The source did not have an eligible compact generation.
    Ineligible(CodexHistoryIneligibleReason),
}

/// Raw Codex compact-generation bytes selected for checkpointing.
#[derive(Debug, PartialEq, Eq)]
pub struct CodexHistoryCandidate {
    bytes: Vec<u8>,
    source_size: u64,
}

impl CodexHistoryCandidate {
    /// Return the complete decoded source size observed during selection.
    #[must_use]
    pub const fn source_size(&self) -> u64 {
        self.source_size
    }

    /// Return the selected raw generation size.
    #[must_use]
    pub fn candidate_size(&self) -> u64 {
        self.bytes.len() as u64
    }

    /// Consume the candidate and return its exact raw JSONL bytes.
    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Content-free reason that a Codex history was not eligible for pruning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexHistoryIneligibleReason {
    /// The complete source is already within the retained-generation guard.
    SourceWithinGuard,
    /// The canonical first record was missing or malformed.
    InvalidCanonicalMetadata,
    /// The canonical thread identity did not match the checkpoint identity.
    ThreadIdMismatch,
    /// The canonical history mode was not legacy.
    UnsupportedHistoryMode,
    /// No compacted record was found in the only retained window that can fit.
    NoCompactBoundary,
    /// A retained JSONL record was malformed, incomplete, or unsupported.
    InvalidRecord,
    /// A retained JSONL record exceeded the individual-record limit.
    RecordTooLarge,
    /// The newest compacted record did not contain usable replacement history.
    InvalidCompactBoundary,
    /// The selected compacting or later turn was unbounded or inconsistent.
    InvalidTurn,
    /// The selected compacting or later turn did not retain compatible context.
    MissingTurnContext,
    /// A rollback followed the selected compacted record.
    RollbackAfterCompact,
    /// The selected candidate exceeded its decoded-size limit.
    CandidateTooLarge,
    /// The source EOF changed while the candidate was selected.
    SourceChanged,
}

impl CodexHistoryIneligibleReason {
    /// Return a stable content-free diagnostic label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceWithinGuard => "source_within_guard",
            Self::InvalidCanonicalMetadata => "invalid_canonical_metadata",
            Self::ThreadIdMismatch => "thread_id_mismatch",
            Self::UnsupportedHistoryMode => "unsupported_history_mode",
            Self::NoCompactBoundary => "no_compact_boundary",
            Self::InvalidRecord => "invalid_record",
            Self::RecordTooLarge => "record_too_large",
            Self::InvalidCompactBoundary => "invalid_compact_boundary",
            Self::InvalidTurn => "invalid_turn",
            Self::MissingTurnContext => "missing_turn_context",
            Self::RollbackAfterCompact => "rollback_after_compact",
            Self::CandidateTooLarge => "candidate_too_large",
            Self::SourceChanged => "source_changed",
        }
    }
}

#[derive(Debug)]
enum EventRecord<'a> {
    TurnStarted(&'a str),
    UserMessage,
    TurnComplete(&'a str),
    TurnAborted,
    ThreadRolledBack,
    Other,
}

#[derive(Debug)]
enum RolloutRecord<'a> {
    Compacted(Result<(), CodexHistoryIneligibleReason>),
    Event(EventRecord<'a>),
    TurnContext(Option<&'a str>),
    Other,
}

struct TurnState {
    id: String,
    bytes: Vec<u8>,
    saw_user_message: bool,
    saw_compatible_context: bool,
    invalid: Option<CodexHistoryIneligibleReason>,
}

impl TurnState {
    fn new(id: &str, raw_record: &[u8], body_max_bytes: usize) -> Self {
        let mut state = Self {
            id: id.to_string(),
            bytes: Vec::new(),
            saw_user_message: false,
            saw_compatible_context: false,
            invalid: None,
        };
        state.push(raw_record, body_max_bytes);
        state
    }

    fn push(&mut self, raw_record: &[u8], body_max_bytes: usize) {
        if self.invalid.is_some() {
            return;
        }
        let Some(next_size) = self.bytes.len().checked_add(raw_record.len()) else {
            self.invalidate(CodexHistoryIneligibleReason::CandidateTooLarge);
            return;
        };
        if next_size > body_max_bytes {
            self.invalidate(CodexHistoryIneligibleReason::CandidateTooLarge);
            return;
        }
        self.bytes.extend_from_slice(raw_record);
    }

    fn invalidate(&mut self, reason: CodexHistoryIneligibleReason) {
        if self.invalid.is_none() {
            self.invalid = Some(reason);
            self.bytes.clear();
        }
    }

    fn validate_segment(&self) -> Result<(), CodexHistoryIneligibleReason> {
        if let Some(reason) = self.invalid {
            return Err(reason);
        }
        if !self.saw_user_message {
            return Err(CodexHistoryIneligibleReason::InvalidTurn);
        }
        if !self.saw_compatible_context {
            return Err(CodexHistoryIneligibleReason::MissingTurnContext);
        }
        Ok(())
    }
}

struct CandidateState {
    bytes: Vec<u8>,
    selected_turn_id: String,
    selected_turn_delimited: bool,
    invalid: Option<CodexHistoryIneligibleReason>,
}

impl CandidateState {
    fn from_compacting_turn(
        turn: &TurnState,
        compact_validation: Result<(), CodexHistoryIneligibleReason>,
    ) -> Self {
        let invalid = turn.invalid.or_else(|| compact_validation.err());
        Self {
            bytes: turn.bytes.clone(),
            selected_turn_id: turn.id.clone(),
            selected_turn_delimited: false,
            invalid,
        }
    }

    fn push(&mut self, raw_record: &[u8], body_max_bytes: usize) {
        if self.invalid.is_some() {
            return;
        }
        let Some(next_size) = self.bytes.len().checked_add(raw_record.len()) else {
            self.invalidate(CodexHistoryIneligibleReason::CandidateTooLarge);
            return;
        };
        if next_size > body_max_bytes {
            self.invalidate(CodexHistoryIneligibleReason::CandidateTooLarge);
            return;
        }
        self.bytes.extend_from_slice(raw_record);
    }

    fn invalidate(&mut self, reason: CodexHistoryIneligibleReason) {
        if self.invalid.is_none() {
            self.invalid = Some(reason);
            self.bytes.clear();
        }
    }
}

/// Select Codex's latest self-contained raw native compact generation.
///
/// The source handle must refer to the canonical plain legacy rollout. The
/// source is never modified. Files at or below 64 MiB are left unchanged. For
/// larger files, selection reads only the canonical first record and the final
/// bounded window that can still produce an accepted candidate.
pub fn select_codex_compact_generation(
    source: &mut File,
    expected_thread_id: &str,
) -> io::Result<CodexHistorySelection> {
    select_with_limits_and_hook(source, expected_thread_id, PRODUCTION_LIMITS, || {})
}

fn select_with_limits_and_hook(
    source: &mut File,
    expected_thread_id: &str,
    limits: SelectionLimits,
    before_final_check: impl FnOnce(),
) -> io::Result<CodexHistorySelection> {
    let source_size = source.metadata()?.len();
    if source_size <= limits.candidate_max_bytes {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::SourceWithinGuard,
        ));
    }

    source.seek(SeekFrom::Start(0))?;
    let canonical_record = {
        let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, &mut *source);
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Record(record) if record.ends_with(b"\n") => record,
            BoundedRecord::Oversized => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::RecordTooLarge,
                ));
            }
            BoundedRecord::Eof | BoundedRecord::Record(_) => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::InvalidCanonicalMetadata,
                ));
            }
        }
    };

    let canonical_value =
        match serde_json::from_slice::<Value>(strip_jsonl_line_ending(&canonical_record)) {
            Ok(value) => value,
            Err(_) => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::InvalidCanonicalMetadata,
                ));
            }
        };
    if let Err(reason) = validate_canonical_metadata(&canonical_value, expected_thread_id) {
        return Ok(CodexHistorySelection::Ineligible(reason));
    }

    let Some(body_max_bytes) = usize::try_from(limits.candidate_max_bytes)
        .ok()
        .and_then(|max| max.checked_sub(canonical_record.len()))
    else {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::CandidateTooLarge,
        ));
    };
    if body_max_bytes == 0 {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::CandidateTooLarge,
        ));
    }

    let body_window = body_max_bytes as u64;
    let tail_start = source_size.saturating_sub(body_window);
    if tail_start == 0 {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::NoCompactBoundary,
        ));
    }
    source.seek(SeekFrom::Start(tail_start - 1))?;
    let mut preceding_byte = [0_u8; 1];
    source.read_exact(&mut preceding_byte)?;
    source.seek(SeekFrom::Start(tail_start))?;

    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, &mut *source);
    if preceding_byte != *b"\n" {
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Eof => {
                return Ok(CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::NoCompactBoundary,
                ));
            }
            BoundedRecord::Record(_) | BoundedRecord::Oversized => {}
        }
    }

    let mut current_turn: Option<TurnState> = None;
    let mut candidate: Option<CandidateState> = None;
    loop {
        match read_bounded_record(&mut reader, limits.record_max_bytes)? {
            BoundedRecord::Eof => break,
            BoundedRecord::Oversized => {
                invalidate_retained_state(
                    &mut current_turn,
                    &mut candidate,
                    CodexHistoryIneligibleReason::RecordTooLarge,
                );
            }
            BoundedRecord::Record(raw_record) if !raw_record.ends_with(b"\n") => {
                invalidate_retained_state(
                    &mut current_turn,
                    &mut candidate,
                    CodexHistoryIneligibleReason::InvalidRecord,
                );
            }
            BoundedRecord::Record(raw_record) => {
                process_record(
                    &raw_record,
                    body_max_bytes,
                    &mut current_turn,
                    &mut candidate,
                );
            }
        }
    }

    let observed_eof = reader.stream_position()?;
    before_final_check();
    let final_size = reader.get_ref().metadata()?.len();
    if observed_eof != source_size || final_size != source_size {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::SourceChanged,
        ));
    }

    let Some(mut candidate) = candidate else {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::NoCompactBoundary,
        ));
    };
    if current_turn.is_some() {
        candidate.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
    }
    if !candidate.selected_turn_delimited {
        candidate.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
    }
    if let Some(reason) = candidate.invalid {
        return Ok(CodexHistorySelection::Ineligible(reason));
    }

    let mut bytes = canonical_record;
    bytes.extend_from_slice(&candidate.bytes);
    if bytes.len() as u64 > limits.candidate_max_bytes {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::CandidateTooLarge,
        ));
    }
    if bytes.len() as u64 >= source_size {
        return Ok(CodexHistorySelection::Ineligible(
            CodexHistoryIneligibleReason::NoCompactBoundary,
        ));
    }

    Ok(CodexHistorySelection::Candidate(CodexHistoryCandidate {
        bytes,
        source_size,
    }))
}

fn process_record(
    raw_record: &[u8],
    body_max_bytes: usize,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
) {
    let parsed = serde_json::from_slice::<Value>(strip_jsonl_line_ending(raw_record))
        .map_err(|_| CodexHistoryIneligibleReason::InvalidRecord)
        .and_then(|value| {
            validate_rollout_record(&value)?;
            Ok(value)
        });
    let value = match parsed {
        Ok(value) => value,
        Err(reason) => {
            append_to_retained_state(raw_record, body_max_bytes, current_turn, candidate);
            invalidate_retained_state(current_turn, candidate, reason);
            return;
        }
    };
    let record = match classify_rollout_record(&value) {
        Ok(record) => record,
        Err(reason) => {
            append_to_retained_state(raw_record, body_max_bytes, current_turn, candidate);
            invalidate_retained_state(current_turn, candidate, reason);
            return;
        }
    };

    match record {
        RolloutRecord::Event(EventRecord::TurnStarted(turn_id)) => {
            finish_current_turn(current_turn, candidate);
            if let Some(existing) = candidate.as_mut() {
                existing.push(raw_record, body_max_bytes);
            }
            *current_turn = Some(TurnState::new(turn_id, raw_record, body_max_bytes));
        }
        record => {
            append_to_retained_state(raw_record, body_max_bytes, current_turn, candidate);
            match record {
                RolloutRecord::Compacted(validation) => {
                    *candidate = current_turn
                        .as_ref()
                        .map(|turn| CandidateState::from_compacting_turn(turn, validation))
                        .or_else(|| {
                            Some(CandidateState {
                                bytes: Vec::new(),
                                selected_turn_id: String::new(),
                                selected_turn_delimited: false,
                                invalid: Some(CodexHistoryIneligibleReason::InvalidTurn),
                            })
                        });
                }
                RolloutRecord::Event(EventRecord::UserMessage) => {
                    if let Some(turn) = current_turn.as_mut() {
                        turn.saw_user_message = true;
                    } else if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                }
                RolloutRecord::TurnContext(turn_id) => {
                    if let Some(turn) = current_turn.as_mut() {
                        if turn_id.is_none_or(|turn_id| turn_id == turn.id) {
                            turn.saw_compatible_context = true;
                        } else {
                            turn.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                        }
                    } else if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                }
                RolloutRecord::Event(EventRecord::TurnComplete(turn_id)) => {
                    complete_turn(turn_id, current_turn, candidate);
                }
                RolloutRecord::Event(EventRecord::TurnAborted) => {
                    if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                    *current_turn = None;
                }
                RolloutRecord::Event(EventRecord::ThreadRolledBack) => {
                    if let Some(existing) = candidate.as_mut() {
                        existing.invalidate(CodexHistoryIneligibleReason::RollbackAfterCompact);
                    }
                    if let Some(turn) = current_turn.as_mut() {
                        turn.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
                    }
                }
                RolloutRecord::Event(EventRecord::TurnStarted(_)) => {}
                RolloutRecord::Event(EventRecord::Other) | RolloutRecord::Other => {}
            }
        }
    }
}

fn append_to_retained_state(
    raw_record: &[u8],
    body_max_bytes: usize,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
) {
    if let Some(turn) = current_turn.as_mut() {
        turn.push(raw_record, body_max_bytes);
    }
    if let Some(existing) = candidate.as_mut() {
        existing.push(raw_record, body_max_bytes);
    }
}

fn invalidate_retained_state(
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
    reason: CodexHistoryIneligibleReason,
) {
    if let Some(turn) = current_turn.as_mut() {
        turn.invalidate(reason);
    }
    if let Some(existing) = candidate.as_mut() {
        existing.invalidate(reason);
    }
}

fn complete_turn(
    turn_id: &str,
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
) {
    let Some(turn) = current_turn.take() else {
        if let Some(existing) = candidate.as_mut() {
            existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
        }
        return;
    };
    if turn.id != turn_id {
        if let Some(existing) = candidate.as_mut() {
            existing.invalidate(CodexHistoryIneligibleReason::InvalidTurn);
        }
        return;
    }
    finish_turn(turn, candidate);
}

fn finish_current_turn(
    current_turn: &mut Option<TurnState>,
    candidate: &mut Option<CandidateState>,
) {
    let Some(turn) = current_turn.take() else {
        return;
    };
    finish_turn(turn, candidate);
}

fn finish_turn(turn: TurnState, candidate: &mut Option<CandidateState>) {
    let validation = turn.validate_segment();
    if let Some(existing) = candidate.as_mut() {
        if existing.selected_turn_id == turn.id {
            existing.selected_turn_delimited = true;
        }
        if let Err(reason) = validation {
            existing.invalidate(reason);
        }
    }
}

fn validate_canonical_metadata(
    value: &Value,
    expected_thread_id: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    let object = rollout_object(value)?;
    if object.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err(CodexHistoryIneligibleReason::InvalidCanonicalMetadata);
    }
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
    for field in ["timestamp", "cwd", "originator", "cli_version"] {
        require_string(payload, field)
            .map_err(|_| CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
    }
    let expected = Uuid::parse_str(expected_thread_id)
        .map_err(|_| CodexHistoryIneligibleReason::ThreadIdMismatch)?;
    let id = uuid_field(payload, "id")
        .map_err(|_| CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
    if id != expected {
        return Err(CodexHistoryIneligibleReason::ThreadIdMismatch);
    }
    if let Some(session_id) = payload.get("session_id") {
        let session_id = session_id
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or(CodexHistoryIneligibleReason::InvalidCanonicalMetadata)?;
        if session_id != expected {
            return Err(CodexHistoryIneligibleReason::ThreadIdMismatch);
        }
    }
    match payload.get("history_mode") {
        None => Ok(()),
        Some(Value::String(mode)) if mode == "legacy" => Ok(()),
        Some(Value::String(_)) => Err(CodexHistoryIneligibleReason::UnsupportedHistoryMode),
        Some(_) => Err(CodexHistoryIneligibleReason::InvalidCanonicalMetadata),
    }
}

fn validate_rollout_record(value: &Value) -> Result<(), CodexHistoryIneligibleReason> {
    let object = rollout_object(value)?;
    let record_type = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;

    match record_type {
        // A legacy rollout has exactly one canonical metadata record. Seeing
        // another one in the retained suffix makes the thread identity
        // ambiguous, so only the separately validated first record is allowed.
        "session_meta" => Err(CodexHistoryIneligibleReason::InvalidRecord),
        "response_item" => validate_response_item_value(
            object
                .get("payload")
                .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?,
        ),
        "inter_agent_communication" => validate_inter_agent_communication(payload),
        "inter_agent_communication_metadata" => require_bool(payload, "trigger_turn"),
        "compacted" => Ok(()),
        "turn_context" => validate_turn_context_payload(payload),
        "world_state" => validate_world_state_payload(payload),
        "event_msg" => require_nonempty_string(payload, "type").map(|_| ()),
        _ => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn classify_rollout_record(
    value: &Value,
) -> Result<RolloutRecord<'_>, CodexHistoryIneligibleReason> {
    let object = rollout_object(value)?;
    let record_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    match record_type {
        "compacted" => Ok(RolloutRecord::Compacted(validate_compacted(payload))),
        "turn_context" => Ok(RolloutRecord::TurnContext(optional_nonempty_string(
            payload, "turn_id",
        )?)),
        "event_msg" => classify_event(payload).map(RolloutRecord::Event),
        _ => Ok(RolloutRecord::Other),
    }
}

fn classify_event(
    payload: &Map<String, Value>,
) -> Result<EventRecord<'_>, CodexHistoryIneligibleReason> {
    match require_nonempty_string(payload, "type")? {
        "task_started" | "turn_started" => {
            require_nonempty_string(payload, "turn_id").map(EventRecord::TurnStarted)
        }
        "user_message" => Ok(EventRecord::UserMessage),
        "task_complete" | "turn_complete" => {
            require_nonempty_string(payload, "turn_id").map(EventRecord::TurnComplete)
        }
        "turn_aborted" => Ok(EventRecord::TurnAborted),
        "thread_rolled_back" => Ok(EventRecord::ThreadRolledBack),
        _ => Ok(EventRecord::Other),
    }
}

fn validate_compacted(payload: &Map<String, Value>) -> Result<(), CodexHistoryIneligibleReason> {
    require_string(payload, "message")
        .map_err(|_| CodexHistoryIneligibleReason::InvalidCompactBoundary)?;
    let replacement_history = payload
        .get("replacement_history")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or(CodexHistoryIneligibleReason::InvalidCompactBoundary)?;
    for item in replacement_history {
        validate_response_item_value(item)
            .map_err(|_| CodexHistoryIneligibleReason::InvalidCompactBoundary)?;
    }
    if payload
        .get("window_number")
        .is_some_and(|value| value.as_u64().is_none())
    {
        return Err(CodexHistoryIneligibleReason::InvalidCompactBoundary);
    }
    for field in ["first_window_id", "previous_window_id", "window_id"] {
        if let Some(value) = payload.get(field)
            && !value.is_null()
            && value
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .is_none()
        {
            return Err(CodexHistoryIneligibleReason::InvalidCompactBoundary);
        }
    }
    Ok(())
}

fn validate_response_item_value(value: &Value) -> Result<(), CodexHistoryIneligibleReason> {
    let object = value
        .as_object()
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    let item_type = require_nonempty_string(object, "type")?;
    match item_type {
        "additional_tools" => {
            require_nonempty_string(object, "role")?;
            require_array(object, "tools")
        }
        "message" => {
            require_nonempty_string(object, "role")?;
            require_array(object, "content")
        }
        "agent_message" => {
            require_nonempty_string(object, "author")?;
            require_nonempty_string(object, "recipient")?;
            require_array(object, "content")
        }
        "reasoning" => {
            require_array(object, "summary")?;
            require_optional_string(object, "encrypted_content")
        }
        "local_shell_call" => {
            require_optional_string(object, "call_id")?;
            require_nonempty_string(object, "status")?;
            require_object(object, "action")
        }
        "function_call" => {
            require_nonempty_string(object, "name")?;
            require_string(object, "arguments")?;
            require_nonempty_string(object, "call_id").map(|_| ())
        }
        "tool_search_call" => {
            require_optional_string(object, "call_id")?;
            require_nonempty_string(object, "execution")?;
            object
                .contains_key("arguments")
                .then_some(())
                .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
        }
        "function_call_output" | "custom_tool_call_output" => {
            require_nonempty_string(object, "call_id")?;
            validate_output(object.get("output"))
        }
        "custom_tool_call" => {
            require_nonempty_string(object, "call_id")?;
            require_nonempty_string(object, "name")?;
            require_string(object, "input").map(|_| ())
        }
        "tool_search_output" => {
            require_optional_string(object, "call_id")?;
            require_nonempty_string(object, "status")?;
            require_nonempty_string(object, "execution")?;
            require_array(object, "tools")
        }
        "web_search_call" => Ok(()),
        "image_generation_call" => {
            require_nonempty_string(object, "status")?;
            require_string(object, "result").map(|_| ())
        }
        "compaction" | "compaction_summary" => {
            require_nonempty_string(object, "encrypted_content").map(|_| ())
        }
        "compaction_trigger" => Ok(()),
        "context_compaction" => require_optional_string(object, "encrypted_content"),
        _ => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn validate_output(value: Option<&Value>) -> Result<(), CodexHistoryIneligibleReason> {
    match value {
        Some(Value::String(_)) | Some(Value::Array(_)) => Ok(()),
        Some(_) | None => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn validate_inter_agent_communication(
    payload: &Map<String, Value>,
) -> Result<(), CodexHistoryIneligibleReason> {
    require_nonempty_string(payload, "author")?;
    require_nonempty_string(payload, "recipient")?;
    require_string(payload, "content")?;
    require_bool(payload, "trigger_turn")
}

fn validate_turn_context_payload(
    payload: &Map<String, Value>,
) -> Result<(), CodexHistoryIneligibleReason> {
    optional_nonempty_string(payload, "turn_id")?;
    require_nonempty_string(payload, "cwd")?;
    require_nonempty_string(payload, "model")?;
    require_nonempty_string_or_object(payload, "approval_policy")?;
    require_object(payload, "sandbox_policy")?;
    require_nonempty_string(payload, "summary").map(|_| ())
}

fn validate_world_state_payload(
    payload: &Map<String, Value>,
) -> Result<(), CodexHistoryIneligibleReason> {
    require_bool(payload, "full")?;
    payload
        .contains_key("state")
        .then_some(())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn rollout_object(value: &Value) -> Result<&Map<String, Value>, CodexHistoryIneligibleReason> {
    let object = value
        .as_object()
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)?;
    require_nonempty_string(object, "timestamp")?;
    if object
        .get("ordinal")
        .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
    {
        return Err(CodexHistoryIneligibleReason::InvalidRecord);
    }
    Ok(object)
}

fn uuid_field(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Uuid, CodexHistoryIneligibleReason> {
    require_nonempty_string(object, field)?
        .parse()
        .map_err(|_| CodexHistoryIneligibleReason::InvalidRecord)
}

fn require_nonempty_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CodexHistoryIneligibleReason> {
    let value = require_string(object, field)?;
    if value.is_empty() {
        return Err(CodexHistoryIneligibleReason::InvalidRecord);
    }
    Ok(value)
}

fn require_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn optional_nonempty_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, CodexHistoryIneligibleReason> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        Some(_) => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn require_optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    match object.get(field) {
        None | Some(Value::Null | Value::String(_)) => Ok(()),
        Some(_) => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn require_array(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_array)
        .map(|_| ())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn require_object(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_object)
        .map(|_| ())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

fn require_nonempty_string_or_object(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    match object.get(field) {
        Some(Value::String(value)) if !value.is_empty() => Ok(()),
        Some(Value::Object(value)) if !value.is_empty() => Ok(()),
        Some(_) | None => Err(CodexHistoryIneligibleReason::InvalidRecord),
    }
}

fn require_bool(
    object: &Map<String, Value>,
    field: &str,
) -> Result<(), CodexHistoryIneligibleReason> {
    object
        .get(field)
        .and_then(Value::as_bool)
        .map(|_| ())
        .ok_or(CodexHistoryIneligibleReason::InvalidRecord)
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use serde_json::json;
    use tempfile::NamedTempFile;

    use super::*;

    const THREAD_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TURN_ID: &str = "turn-1";
    const TEST_LIMITS: SelectionLimits = SelectionLimits {
        candidate_max_bytes: 8 * 1024,
        record_max_bytes: 2 * 1024,
    };

    fn line(record_type: &str, payload: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&json!({
            "timestamp": "2026-07-26T00:00:00Z",
            "type": record_type,
            "payload": payload,
        }))
        .unwrap();
        bytes.push(b'\n');
        bytes
    }

    fn canonical(history_mode: Option<&str>) -> Vec<u8> {
        let mut payload = json!({
            "id": THREAD_ID,
            "session_id": THREAD_ID,
            "timestamp": "2026-07-26T00:00:00Z",
            "cwd": "/workspace",
            "originator": "codex",
            "cli_version": "0.144.6",
            "source": "cli",
        });
        if let Some(history_mode) = history_mode {
            payload["history_mode"] = json!(history_mode);
        }
        line("session_meta", payload)
    }

    fn event(event_type: &str, extra: Value) -> Vec<u8> {
        let mut payload = json!({"type": event_type});
        payload.as_object_mut().unwrap().extend(
            extra
                .as_object()
                .expect("event extra must be an object")
                .clone(),
        );
        line("event_msg", payload)
    }

    fn turn_started(turn_id: &str) -> Vec<u8> {
        event("task_started", json!({"turn_id": turn_id}))
    }

    fn user_message() -> Vec<u8> {
        event("user_message", json!({"message": "hello"}))
    }

    fn turn_context(turn_id: &str) -> Vec<u8> {
        line(
            "turn_context",
            json!({
                "turn_id": turn_id,
                "cwd": "/workspace",
                "approval_policy": "never",
                "sandbox_policy": {"type": "read_only", "network_access": false},
                "model": "gpt-test",
                "summary": "auto",
            }),
        )
    }

    fn compacted(message: &str) -> Vec<u8> {
        line(
            "compacted",
            json!({
                "message": message,
                "replacement_history": [{
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": message}],
                }],
                "window_number": 2,
                "first_window_id": "019c0000-0000-7000-8000-000000000001",
                "previous_window_id": "019c0000-0000-7000-8000-000000000002",
                "window_id": "019c0000-0000-7000-8000-000000000003",
            }),
        )
    }

    fn turn_complete(turn_id: &str) -> Vec<u8> {
        event("task_complete", json!({"turn_id": turn_id}))
    }

    fn source(records: &[Vec<u8>]) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(&canonical(Some("legacy"))).unwrap();
        let retained_len: usize = records.iter().map(Vec::len).sum();
        let filler_len = TEST_LIMITS
            .candidate_max_bytes
            .saturating_sub(retained_len as u64)
            .saturating_add(512) as usize;
        file.write_all(&line(
            "response_item",
            json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "x".repeat(filler_len)}],
            }),
        ))
        .unwrap();
        for record in records {
            file.write_all(record).unwrap();
        }
        file.flush().unwrap();
        file
    }

    fn complete_generation(summary: &str) -> Vec<Vec<u8>> {
        vec![
            turn_started(TURN_ID),
            user_message(),
            turn_context(TURN_ID),
            compacted(summary),
            turn_complete(TURN_ID),
        ]
    }

    fn select(file: &NamedTempFile) -> io::Result<CodexHistorySelection> {
        let mut source = file.reopen()?;
        select_with_limits_and_hook(&mut source, THREAD_ID, TEST_LIMITS, || {})
    }

    fn candidate_bytes(selection: CodexHistorySelection) -> Vec<u8> {
        match selection {
            CodexHistorySelection::Candidate(candidate) => candidate.into_bytes(),
            CodexHistorySelection::Ineligible(reason) => {
                panic!("expected candidate, got {reason:?}")
            }
        }
    }

    #[test]
    fn preserves_canonical_metadata_and_complete_compacting_turn_exactly() {
        let generation = complete_generation("latest summary");
        let file = source(&generation);

        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(canonical(Some("legacy")))
            .chain(generation)
            .flatten()
            .collect::<Vec<_>>();

        assert_eq!(selected, expected);
    }

    #[test]
    fn latest_invalid_compaction_supersedes_an_older_generation() {
        let mut records = complete_generation("older");
        records.extend([
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
            line(
                "compacted",
                json!({"message": "latest", "replacement_history": []}),
            ),
            turn_complete("turn-2"),
        ]);
        let file = source(&records);

        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidCompactBoundary)
        );
    }

    #[test]
    fn retains_complete_later_turns_after_the_selected_compaction() {
        let mut records = complete_generation("summary");
        let later = [
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
            line(
                "response_item",
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                }),
            ),
            turn_complete("turn-2"),
        ];
        records.extend(later.clone());
        let file = source(&records);

        let selected = candidate_bytes(select(&file).unwrap());

        assert!(selected.ends_with(&later.concat()));
    }

    #[test]
    fn accepts_compacting_turn_delimited_by_the_next_turn_start() {
        let records = [
            turn_started(TURN_ID),
            user_message(),
            turn_context(TURN_ID),
            compacted("summary"),
            turn_started("turn-2"),
            turn_context("turn-2"),
            user_message(),
            line(
                "response_item",
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                }),
            ),
            turn_complete("turn-2"),
        ];
        let file = source(&records);

        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(canonical(Some("legacy")))
            .chain(records)
            .flatten()
            .collect::<Vec<_>>();

        assert_eq!(selected, expected);
    }

    #[test]
    fn rejects_missing_context_incomplete_turn_and_rollback() {
        let missing_context = [
            turn_started(TURN_ID),
            user_message(),
            compacted("summary"),
            turn_complete(TURN_ID),
        ];
        let file = source(&missing_context);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::MissingTurnContext)
        );

        let incomplete = [
            turn_started(TURN_ID),
            user_message(),
            turn_context(TURN_ID),
            compacted("summary"),
        ];
        let file = source(&incomplete);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidTurn)
        );

        let mut rolled_back = complete_generation("summary");
        rolled_back.push(event("thread_rolled_back", json!({"num_turns": 1})));
        let file = source(&rolled_back);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::RollbackAfterCompact)
        );

        let mut incomplete_later = complete_generation("summary");
        incomplete_later.extend([
            turn_started("turn-2"),
            user_message(),
            turn_context("turn-2"),
        ]);
        let file = source(&incomplete_later);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidTurn)
        );
    }

    #[test]
    fn accepts_omitted_mode_and_rejects_unsupported_modes_and_wrong_thread_id() {
        let generation = complete_generation("summary");
        let mut file = source(&generation);
        file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        file.as_file_mut().write_all(&canonical(None)).unwrap();
        file.as_file_mut().flush().unwrap();
        let selected = candidate_bytes(select(&file).unwrap());
        let expected = std::iter::once(canonical(None))
            .chain(generation)
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(selected, expected);

        for mode in ["paginated", "future"] {
            let mut file = source(&complete_generation("summary"));
            file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
            file.as_file_mut()
                .write_all(&canonical(Some(mode)))
                .unwrap();
            file.as_file_mut().flush().unwrap();
            assert_eq!(
                select(&file).unwrap(),
                CodexHistorySelection::Ineligible(
                    CodexHistoryIneligibleReason::UnsupportedHistoryMode
                )
            );
        }

        let file = source(&complete_generation("summary"));
        let mut source_file = file.reopen().unwrap();
        assert_eq!(
            select_with_limits_and_hook(
                &mut source_file,
                "99999999-9999-4999-8999-999999999999",
                TEST_LIMITS,
                || {},
            )
            .unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::ThreadIdMismatch)
        );

        let mut file = source(&complete_generation("summary"));
        file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        file.as_file_mut()
            .write_all(&line(
                "session_meta",
                json!({"id": THREAD_ID, "session_id": THREAD_ID}),
            ))
            .unwrap();
        file.as_file_mut().flush().unwrap();
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(
                CodexHistoryIneligibleReason::InvalidCanonicalMetadata
            )
        );
    }

    #[test]
    fn rejects_malformed_oversized_and_unknown_retained_records() {
        for bad_record in [
            b"{not-json}\n".to_vec(),
            vec![0xff, b'\n'],
            line("future_record", json!({})),
            canonical(Some("legacy")),
            line(
                "response_item",
                json!({"type": "future_response_item", "value": "unknown"}),
            ),
            line("world_state", json!({"full": "yes", "state": {}})),
        ] {
            let mut records = complete_generation("summary");
            records.insert(records.len() - 1, bad_record);
            let file = source(&records);
            assert_eq!(
                select(&file).unwrap(),
                CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
            );
        }

        let mut records = complete_generation("summary");
        records.insert(
            records.len() - 1,
            line(
                "event_msg",
                json!({"type": "warning", "message": "x".repeat(4096)}),
            ),
        );
        let file = source(&records);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::RecordTooLarge)
        );

        let mut records = complete_generation("summary");
        records.push(b"{\"timestamp\":\"partial\"}".to_vec());
        let file = source(&records);
        assert_eq!(
            select(&file).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::InvalidRecord)
        );
    }

    #[test]
    fn detects_source_growth_before_acceptance() {
        let mut file = source(&complete_generation("summary"));
        let path = file.path().to_owned();
        let mut source = file.reopen().unwrap();

        let selection = select_with_limits_and_hook(&mut source, THREAD_ID, TEST_LIMITS, || {
            file.as_file_mut().seek(SeekFrom::End(0)).unwrap();
            file.as_file_mut().write_all(b"changed\n").unwrap();
            file.as_file_mut().flush().unwrap();
        })
        .unwrap();

        assert_eq!(
            selection,
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::SourceChanged)
        );
        assert!(path.exists());
    }

    #[test]
    fn source_within_guard_is_not_scanned() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"not json").unwrap();
        let mut source = file.reopen().unwrap();

        assert_eq!(
            select_with_limits_and_hook(&mut source, THREAD_ID, TEST_LIMITS, || {}).unwrap(),
            CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::SourceWithinGuard)
        );
    }
}
