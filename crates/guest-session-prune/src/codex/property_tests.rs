use std::fmt::Display;
use std::io::{self, Write};

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};
use serde_json::{Value, json};
use tempfile::NamedTempFile;

use super::*;

const THREAD_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN_IDS: [&str; 6] = [
    "turn-older",
    "turn-compact",
    "turn-later-1",
    "turn-later-2",
    "turn-later-3",
    "turn-other",
];

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xC0DE_2537_3000_0001;
const GENERATED_LIMITS: SelectionLimits = SelectionLimits {
    candidate_max_bytes: 8 * 1024,
    record_max_bytes: 1024,
};

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn line(record_type: &str, payload: Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&json!({
        "timestamp": "2026-08-06T00:00:00Z",
        "type": record_type,
        "payload": payload,
    }))
    .expect("JSON values must serialize");
    bytes.push(b'\n');
    bytes
}

fn canonical() -> Vec<u8> {
    line(
        "session_meta",
        json!({
            "id": THREAD_ID,
            "session_id": THREAD_ID,
            "timestamp": "2026-08-06T00:00:00Z",
            "cwd": "/workspace",
            "originator": "codex",
            "cli_version": "0.145.0",
            "source": "cli",
            "history_mode": "legacy",
        }),
    )
}

fn event(event_type: &str, extra: Value) -> Vec<u8> {
    let mut payload = json!({"type": event_type});
    payload
        .as_object_mut()
        .expect("event payload must be an object")
        .extend(
            extra
                .as_object()
                .expect("event fields must be an object")
                .clone(),
        );
    line("event_msg", payload)
}

fn turn_started(turn_id: &str) -> Vec<u8> {
    event("task_started", json!({"turn_id": turn_id}))
}

fn user_message() -> Vec<u8> {
    event("user_message", json!({"message": "continue"}))
}

fn turn_context(turn_id: Option<&str>) -> Vec<u8> {
    let mut payload = json!({
        "cwd": "/workspace",
        "approval_policy": "never",
        "sandbox_policy": {"type": "read_only", "network_access": false},
        "model": "gpt-test",
        "summary": "auto",
    });
    if let Some(turn_id) = turn_id {
        payload["turn_id"] = json!(turn_id);
    }
    line("turn_context", payload)
}

fn compacted(message: &str, valid: bool) -> Vec<u8> {
    let replacement_history = if valid {
        json!([{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": message}],
        }])
    } else {
        json!([])
    };
    line(
        "compacted",
        json!({
            "message": message,
            "replacement_history": replacement_history,
            "window_number": 2,
            "window_id": "019c0000-0000-7000-8000-000000000003",
        }),
    )
}

fn turn_complete(turn_id: &str) -> Vec<u8> {
    event("task_complete", json!({"turn_id": turn_id}))
}

fn neutral_record(padding: usize) -> Vec<u8> {
    event("warning", json!({"message": "x".repeat(padding)}))
}

fn valid_turn(
    turn_id: &str,
    compact_message: Option<&str>,
    context_without_id: bool,
    context_first: bool,
    neutral_records: u8,
    complete: bool,
) -> Vec<Vec<u8>> {
    let mut records = vec![turn_started(turn_id)];
    let context = turn_context((!context_without_id).then_some(turn_id));
    if context_first {
        records.push(context);
        records.push(user_message());
    } else {
        records.push(user_message());
        records.push(context);
    }
    records.extend((0..neutral_records).map(|index| neutral_record(usize::from(index))));
    if let Some(message) = compact_message {
        records.push(compacted(message, true));
    }
    if complete {
        records.push(turn_complete(turn_id));
    }
    records
}

#[derive(Clone, Debug)]
struct ValidScenario {
    older_compaction: bool,
    context_without_id: bool,
    context_first: bool,
    delimiter_by_next_start: bool,
    additional_later_turns: u8,
    neutral_records: u8,
}

fn valid_scenario_strategy() -> impl Strategy<Value = ValidScenario> {
    (
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        0_u8..=2,
        0_u8..=2,
    )
        .prop_map(
            |(
                older_compaction,
                context_without_id,
                context_first,
                delimiter_by_next_start,
                additional_later_turns,
                neutral_records,
            )| ValidScenario {
                older_compaction,
                context_without_id,
                context_first,
                delimiter_by_next_start,
                additional_later_turns,
                neutral_records,
            },
        )
}

struct ValidHistory {
    records: Vec<Vec<u8>>,
    retained_start: usize,
}

fn build_valid_history(scenario: &ValidScenario) -> ValidHistory {
    let mut records = Vec::new();
    if scenario.older_compaction {
        records.extend(valid_turn(
            TURN_IDS[0],
            Some("older summary"),
            false,
            false,
            scenario.neutral_records,
            true,
        ));
    }

    let retained_start = records.len();
    records.extend(valid_turn(
        TURN_IDS[1],
        Some("latest summary"),
        scenario.context_without_id,
        scenario.context_first,
        scenario.neutral_records,
        !scenario.delimiter_by_next_start,
    ));

    let later_turns = scenario.additional_later_turns + u8::from(scenario.delimiter_by_next_start);
    for index in 0..later_turns {
        records.extend(valid_turn(
            TURN_IDS[usize::from(index) + 2],
            None,
            false,
            index % 2 == 0,
            scenario.neutral_records,
            true,
        ));
    }

    ValidHistory {
        records,
        retained_start,
    }
}

#[derive(Clone, Copy, Debug)]
enum InvalidMutation {
    WrongContextId,
    ContextWithoutTurn,
    WrongCompletionId,
    CompletionWithoutTurn,
    TurnAborted,
    Rollback,
    MissingUser,
    MissingContext,
    MissingDelimiter,
    CompactWithoutTurn,
    InvalidNewestCompact,
    MalformedRecord,
    PartialRecord,
}

impl InvalidMutation {
    const ALL: [Self; 13] = [
        Self::WrongContextId,
        Self::ContextWithoutTurn,
        Self::WrongCompletionId,
        Self::CompletionWithoutTurn,
        Self::TurnAborted,
        Self::Rollback,
        Self::MissingUser,
        Self::MissingContext,
        Self::MissingDelimiter,
        Self::CompactWithoutTurn,
        Self::InvalidNewestCompact,
        Self::MalformedRecord,
        Self::PartialRecord,
    ];
}

fn build_invalid_history(mutation: InvalidMutation, neutral_records: u8) -> Vec<Vec<u8>> {
    let mut records = valid_turn(
        TURN_IDS[0],
        Some("older summary"),
        false,
        false,
        neutral_records,
        true,
    );

    if matches!(mutation, InvalidMutation::CompactWithoutTurn) {
        records.push(compacted("latest summary", true));
        return records;
    }

    records.push(turn_started(TURN_IDS[1]));
    if !matches!(mutation, InvalidMutation::MissingUser) {
        records.push(user_message());
    }
    if !matches!(mutation, InvalidMutation::MissingContext) {
        let context_id = if matches!(mutation, InvalidMutation::WrongContextId) {
            TURN_IDS[5]
        } else {
            TURN_IDS[1]
        };
        records.push(turn_context(Some(context_id)));
    }
    records.extend((0..neutral_records).map(|index| neutral_record(usize::from(index))));
    records.push(compacted(
        "latest summary",
        !matches!(mutation, InvalidMutation::InvalidNewestCompact),
    ));

    match mutation {
        InvalidMutation::WrongCompletionId => records.push(turn_complete(TURN_IDS[5])),
        InvalidMutation::CompletionWithoutTurn => {
            records.push(turn_complete(TURN_IDS[1]));
            records.push(turn_complete(TURN_IDS[1]));
        }
        InvalidMutation::ContextWithoutTurn => {
            records.push(turn_complete(TURN_IDS[1]));
            records.push(turn_context(Some(TURN_IDS[1])));
        }
        InvalidMutation::TurnAborted => {
            records.push(turn_complete(TURN_IDS[1]));
            records.push(event("turn_aborted", json!({})));
        }
        InvalidMutation::Rollback => {
            records.push(turn_complete(TURN_IDS[1]));
            records.push(event("thread_rolled_back", json!({"num_turns": 1})));
        }
        InvalidMutation::MissingDelimiter => {}
        InvalidMutation::MalformedRecord => {
            records.push(b"{not-json}\n".to_vec());
            records.push(turn_complete(TURN_IDS[1]));
        }
        InvalidMutation::PartialRecord => {
            records.push(b"{\"timestamp\":\"partial\"}".to_vec());
            records.push(turn_complete(TURN_IDS[1]));
        }
        InvalidMutation::WrongContextId
        | InvalidMutation::MissingUser
        | InvalidMutation::MissingContext
        | InvalidMutation::InvalidNewestCompact => {
            records.push(turn_complete(TURN_IDS[1]));
        }
        InvalidMutation::CompactWithoutTurn => {}
    }

    records
}

#[derive(Clone, Debug)]
enum GeneratedRecord {
    TurnStarted(u8),
    UserMessage,
    TurnContext(Option<u8>),
    Compacted(bool),
    TurnComplete(u8),
    TurnAborted,
    Rollback,
    Neutral(u8),
    Malformed,
    Partial,
    Oversized,
}

fn generated_record_strategy() -> impl Strategy<Value = GeneratedRecord> {
    let context_id = prop_oneof![Just(None), (0_u8..3).prop_map(Some)];
    prop_oneof![
        3 => (0_u8..3).prop_map(GeneratedRecord::TurnStarted),
        3 => Just(GeneratedRecord::UserMessage),
        3 => context_id.prop_map(GeneratedRecord::TurnContext),
        2 => any::<bool>().prop_map(GeneratedRecord::Compacted),
        3 => (0_u8..3).prop_map(GeneratedRecord::TurnComplete),
        1 => Just(GeneratedRecord::TurnAborted),
        1 => Just(GeneratedRecord::Rollback),
        2 => (0_u8..64).prop_map(GeneratedRecord::Neutral),
        1 => Just(GeneratedRecord::Malformed),
        1 => Just(GeneratedRecord::Partial),
        1 => Just(GeneratedRecord::Oversized),
    ]
}

fn generated_records_strategy() -> impl Strategy<Value = Vec<GeneratedRecord>> {
    proptest::collection::vec(generated_record_strategy(), 0..=18)
}

fn encode_generated_record(record: &GeneratedRecord) -> Vec<u8> {
    match record {
        GeneratedRecord::TurnStarted(id) => turn_started(TURN_IDS[usize::from(*id)]),
        GeneratedRecord::UserMessage => user_message(),
        GeneratedRecord::TurnContext(id) => turn_context(id.map(|id| TURN_IDS[usize::from(id)])),
        GeneratedRecord::Compacted(valid) => compacted("generated summary", *valid),
        GeneratedRecord::TurnComplete(id) => turn_complete(TURN_IDS[usize::from(*id)]),
        GeneratedRecord::TurnAborted => event("turn_aborted", json!({})),
        GeneratedRecord::Rollback => event("thread_rolled_back", json!({"num_turns": 1})),
        GeneratedRecord::Neutral(padding) => neutral_record(usize::from(*padding)),
        GeneratedRecord::Malformed => b"{not-json}\n".to_vec(),
        GeneratedRecord::Partial => b"{\"timestamp\":\"partial\"}".to_vec(),
        GeneratedRecord::Oversized => neutral_record(GENERATED_LIMITS.record_max_bytes + 128),
    }
}

struct TestSource {
    file: NamedTempFile,
    bytes: Vec<u8>,
    canonical: Vec<u8>,
    retained_offset: usize,
}

fn write_source(records: &[Vec<u8>], limits: SelectionLimits) -> io::Result<TestSource> {
    let canonical = canonical();
    let filler_length = usize::try_from(limits.candidate_max_bytes)
        .expect("test candidate limit must fit usize")
        .saturating_add(256);
    let filler = line(
        "response_item",
        json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "f".repeat(filler_length)}],
        }),
    );
    let retained_offset = canonical.len() + filler.len();
    let mut bytes =
        Vec::with_capacity(retained_offset + records.iter().map(Vec::len).sum::<usize>());
    bytes.extend_from_slice(&canonical);
    bytes.extend_from_slice(&filler);
    for record in records {
        bytes.extend_from_slice(record);
    }

    let mut file = NamedTempFile::new()?;
    file.write_all(&bytes)?;
    file.flush()?;

    Ok(TestSource {
        file,
        bytes,
        canonical,
        retained_offset,
    })
}

fn select(source: &TestSource, limits: SelectionLimits) -> io::Result<CodexHistorySelection> {
    let mut file = source.file.reopen()?;
    select_with_limits_and_hook(&mut file, THREAD_ID, limits, || {})
}

fn property_result<T, E: Display>(result: Result<T, E>, context: &str) -> Result<T, TestCaseError> {
    result.map_err(|error| TestCaseError::fail(format!("{context}: {error}")))
}

struct CandidateView {
    bytes: Vec<u8>,
    source_size: u64,
    candidate_size: u64,
}

fn expect_candidate(selection: CodexHistorySelection) -> Result<CandidateView, TestCaseError> {
    match selection {
        CodexHistorySelection::Candidate(candidate) => Ok(CandidateView {
            source_size: candidate.source_size(),
            candidate_size: candidate.candidate_size(),
            bytes: candidate.into_bytes(),
        }),
        CodexHistorySelection::Ineligible(reason) => Err(TestCaseError::fail(format!(
            "expected candidate, got {reason:?}"
        ))),
    }
}

fn assert_ineligible(selection: CodexHistorySelection) -> TestCaseResult {
    prop_assert!(
        matches!(selection, CodexHistorySelection::Ineligible(_)),
        "expected fail-closed selection, got {selection:?}",
    );
    Ok(())
}

fn record_value(raw_record: &[u8]) -> Result<Value, TestCaseError> {
    if !raw_record.ends_with(b"\n") {
        return Err(TestCaseError::fail(
            "accepted candidate contained a partial JSONL record",
        ));
    }
    let json_bytes = raw_record
        .strip_suffix(b"\n")
        .and_then(|record| record.strip_suffix(b"\r").or(Some(record)))
        .ok_or_else(|| TestCaseError::fail("accepted record had no JSON bytes"))?;
    serde_json::from_slice(json_bytes)
        .map_err(|error| TestCaseError::fail(format!("accepted record was invalid JSON: {error}")))
}

fn record_type_and_payload(
    value: &Value,
) -> Result<(&str, &serde_json::Map<String, Value>), TestCaseError> {
    let object = value
        .as_object()
        .ok_or_else(|| TestCaseError::fail("accepted record was not an object"))?;
    let record_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| TestCaseError::fail("accepted record had no type"))?;
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| TestCaseError::fail("accepted record had no payload object"))?;
    Ok((record_type, payload))
}

fn event_type_and_turn_id(
    payload: &serde_json::Map<String, Value>,
) -> (Option<&str>, Option<&str>) {
    (
        payload.get("type").and_then(Value::as_str),
        payload.get("turn_id").and_then(Value::as_str),
    )
}

fn newest_compacting_turn_offset(source: &TestSource) -> Result<Option<usize>, TestCaseError> {
    let retained = source
        .bytes
        .get(source.retained_offset..)
        .ok_or_else(|| TestCaseError::fail("retained source offset exceeded source bytes"))?;
    let mut relative_offset = 0;
    let mut active_turn_start = None;
    let mut newest_compacting_turn_start = None;

    for raw_record in retained.split_inclusive(|byte| *byte == b'\n') {
        let value = match record_value(raw_record) {
            Ok(value) => value,
            Err(_) => {
                relative_offset += raw_record.len();
                continue;
            }
        };
        let (record_type, payload) = match record_type_and_payload(&value) {
            Ok(parts) => parts,
            Err(_) => {
                relative_offset += raw_record.len();
                continue;
            }
        };
        if record_type == "event_msg" {
            match event_type_and_turn_id(payload).0 {
                Some("task_started" | "turn_started") => {
                    active_turn_start = Some(source.retained_offset + relative_offset);
                }
                Some("task_complete" | "turn_complete" | "turn_aborted") => {
                    active_turn_start = None;
                }
                _ => {}
            }
        } else if record_type == "compacted" {
            newest_compacting_turn_start = active_turn_start;
        }
        relative_offset += raw_record.len();
    }

    Ok(newest_compacting_turn_start)
}

struct OracleTurn {
    id: String,
    saw_user_message: bool,
    saw_compatible_context: bool,
}

fn finish_oracle_turn(turn: OracleTurn) -> TestCaseResult {
    prop_assert!(
        turn.saw_user_message,
        "accepted turn {} had no user boundary",
        turn.id,
    );
    prop_assert!(
        turn.saw_compatible_context,
        "accepted turn {} had no compatible context",
        turn.id,
    );
    Ok(())
}

fn assert_structurally_complete(body: &[u8]) -> TestCaseResult {
    let mut current_turn: Option<OracleTurn> = None;
    let mut saw_compact = false;
    let mut saw_record = false;

    for raw_record in body.split_inclusive(|byte| *byte == b'\n') {
        let value = record_value(raw_record)?;
        let (record_type, payload) = record_type_and_payload(&value)?;
        if !saw_record {
            let (event_type, _) = event_type_and_turn_id(payload);
            prop_assert!(
                record_type == "event_msg"
                    && matches!(event_type, Some("task_started" | "turn_started")),
                "accepted retained suffix did not start at a native turn boundary",
            );
            saw_record = true;
        }

        match record_type {
            "event_msg" => {
                let (event_type, turn_id) = event_type_and_turn_id(payload);
                match event_type {
                    Some("task_started" | "turn_started") => {
                        if let Some(turn) = current_turn.take() {
                            finish_oracle_turn(turn)?;
                        }
                        let turn_id = turn_id.ok_or_else(|| {
                            TestCaseError::fail("accepted turn start had no turn ID")
                        })?;
                        current_turn = Some(OracleTurn {
                            id: turn_id.to_string(),
                            saw_user_message: false,
                            saw_compatible_context: false,
                        });
                    }
                    Some("user_message") => {
                        let turn = current_turn.as_mut().ok_or_else(|| {
                            TestCaseError::fail("accepted user message had no active turn")
                        })?;
                        turn.saw_user_message = true;
                    }
                    Some("task_complete" | "turn_complete") => {
                        let turn = current_turn.take().ok_or_else(|| {
                            TestCaseError::fail("accepted completion had no active turn")
                        })?;
                        let completed_id = turn_id.ok_or_else(|| {
                            TestCaseError::fail("accepted completion had no turn ID")
                        })?;
                        prop_assert_eq!(completed_id, turn.id.as_str());
                        finish_oracle_turn(turn)?;
                    }
                    Some("turn_aborted" | "thread_rolled_back") => {
                        return Err(TestCaseError::fail(
                            "accepted candidate contained an abort or rollback",
                        ));
                    }
                    _ => {}
                }
            }
            "turn_context" => {
                let turn = current_turn
                    .as_mut()
                    .ok_or_else(|| TestCaseError::fail("accepted context had no active turn"))?;
                if let Some(context_id) = payload.get("turn_id").and_then(Value::as_str) {
                    prop_assert_eq!(context_id, turn.id.as_str());
                }
                turn.saw_compatible_context = true;
            }
            "compacted" => {
                prop_assert!(
                    current_turn.is_some(),
                    "accepted compact boundary had no active turn",
                );
                prop_assert!(payload.get("message").is_some_and(Value::is_string));
                prop_assert!(
                    payload
                        .get("replacement_history")
                        .and_then(Value::as_array)
                        .is_some_and(|history| !history.is_empty()),
                );
                saw_compact = true;
            }
            _ => {}
        }
    }

    prop_assert!(saw_record, "accepted candidate had an empty retained body");
    prop_assert!(saw_compact, "accepted candidate had no compact boundary");
    prop_assert!(
        current_turn.is_none(),
        "accepted candidate ended with an incomplete turn",
    );
    Ok(())
}

fn assert_candidate_invariants(
    candidate: CandidateView,
    source: &TestSource,
    limits: SelectionLimits,
) -> TestCaseResult {
    prop_assert_eq!(candidate.source_size, source.bytes.len() as u64);
    prop_assert_eq!(candidate.candidate_size, candidate.bytes.len() as u64);
    prop_assert!(candidate.candidate_size <= limits.candidate_max_bytes);
    prop_assert!(candidate.candidate_size < candidate.source_size);
    prop_assert!(candidate.bytes.starts_with(&source.canonical));

    let body = candidate
        .bytes
        .get(source.canonical.len()..)
        .ok_or_else(|| TestCaseError::fail("candidate was shorter than canonical metadata"))?;
    let expected_offset = newest_compacting_turn_offset(source)?
        .ok_or_else(|| TestCaseError::fail("candidate source had no active compacting turn"))?;
    let expected_body = source
        .bytes
        .get(expected_offset..)
        .ok_or_else(|| TestCaseError::fail("newest compacting turn offset exceeded source"))?;
    prop_assert_eq!(body, expected_body);
    assert_structurally_complete(body)
}

#[test]
fn every_named_transition_mutation_fails_closed_without_older_fallback() {
    for mutation in InvalidMutation::ALL {
        for neutral_records in 0..=2 {
            let records = build_invalid_history(mutation, neutral_records);
            let source = write_source(&records, GENERATED_LIMITS)
                .expect("generated invalid source must be writable");
            let selection = select(&source, GENERATED_LIMITS)
                .expect("generated invalid source must be selectable");

            assert!(
                matches!(selection, CodexHistorySelection::Ineligible(_)),
                "mutation {mutation:?} with {neutral_records} neutral records selected {selection:?}",
            );
        }
    }
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_valid_histories_select_the_exact_newest_generation(
        scenario in valid_scenario_strategy(),
    ) {
        let history = build_valid_history(&scenario);
        let source = property_result(
            write_source(&history.records, GENERATED_LIMITS),
            "write generated valid source",
        )?;
        let selection = property_result(
            select(&source, GENERATED_LIMITS),
            "select generated valid source",
        )?;
        let candidate = expect_candidate(selection)?;
        let expected = source
            .canonical
            .iter()
            .copied()
            .chain(
                history.records[history.retained_start..]
                    .iter()
                    .flatten()
                    .copied(),
            )
            .collect::<Vec<_>>();

        prop_assert_eq!(&candidate.bytes, &expected);
        assert_candidate_invariants(candidate, &source, GENERATED_LIMITS)?;
    }

    #[test]
    fn arbitrary_bounded_transition_sequences_never_panic_and_preserve_candidate_invariants(
        generated in generated_records_strategy(),
    ) {
        let records = generated
            .iter()
            .map(encode_generated_record)
            .collect::<Vec<_>>();
        let source = property_result(
            write_source(&records, GENERATED_LIMITS),
            "write arbitrary transition source",
        )?;
        let selection = property_result(
            select(&source, GENERATED_LIMITS),
            "select arbitrary transition source",
        )?;

        if let CodexHistorySelection::Candidate(candidate) = selection {
            let view = CandidateView {
                source_size: candidate.source_size(),
                candidate_size: candidate.candidate_size(),
                bytes: candidate.into_bytes(),
            };
            assert_candidate_invariants(view, &source, GENERATED_LIMITS)?;
        }
    }

    #[test]
    fn generated_sizes_enforce_exact_candidate_and_record_boundaries(
        padding in 0_usize..=256,
    ) {
        let mut records = valid_turn(
            TURN_IDS[1],
            Some("boundary summary"),
            false,
            false,
            0,
            false,
        );
        records.push(neutral_record(padding));
        records.push(turn_complete(TURN_IDS[1]));

        let canonical = canonical();
        let candidate_size = canonical.len() + records.iter().map(Vec::len).sum::<usize>();
        let record_size = std::iter::once(canonical.len())
            .chain(records.iter().map(Vec::len))
            .max()
            .expect("generated history must have records");
        let exact_limits = SelectionLimits {
            candidate_max_bytes: candidate_size as u64,
            record_max_bytes: record_size,
        };
        let source = property_result(
            write_source(&records, exact_limits),
            "write generated boundary source",
        )?;

        let exact = property_result(
            select(&source, exact_limits),
            "select exact boundary source",
        )?;
        let exact_candidate = expect_candidate(exact)?;
        prop_assert_eq!(exact_candidate.candidate_size, candidate_size as u64);
        assert_candidate_invariants(exact_candidate, &source, exact_limits)?;

        let candidate_over_limit = SelectionLimits {
            candidate_max_bytes: candidate_size.saturating_sub(1) as u64,
            ..exact_limits
        };
        let selection = property_result(
            select(&source, candidate_over_limit),
            "select one-byte-over candidate source",
        )?;
        assert_ineligible(selection)?;

        let record_over_limit = SelectionLimits {
            record_max_bytes: record_size.saturating_sub(1),
            ..exact_limits
        };
        let selection = property_result(
            select(&source, record_over_limit),
            "select one-byte-over record source",
        )?;
        assert_ineligible(selection)?;
    }
}
