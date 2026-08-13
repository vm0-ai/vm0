use std::collections::HashSet;
use std::fmt::Display;
use std::io::{self, Write};

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};
use serde_json::{Map, Value, json};
use tempfile::NamedTempFile;
use uuid::Uuid;

use super::*;

const SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SESSION_ID: &str = "99999999-9999-4999-8999-999999999999";
const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xC1A0_DE26_7690_0001;
const GENERATED_LIMITS: SelectionLimits = SelectionLimits {
    candidate_max_bytes: 16 * 1024,
    record_max_bytes: 2 * 1024,
};

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

#[derive(Clone, Copy, Debug)]
enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    fn from_crlf(crlf: bool) -> Self {
        if crlf { Self::Crlf } else { Self::Lf }
    }

    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::Crlf => b"\r\n",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum TailAlignment {
    RecordBoundary,
    MiddleOfRecord,
}

impl TailAlignment {
    fn from_boundary(aligned: bool) -> Self {
        if aligned {
            Self::RecordBoundary
        } else {
            Self::MiddleOfRecord
        }
    }
}

fn native_uuid(index: u128) -> String {
    Uuid::from_u128(0x1000_0000_0000_4000_8000_0000_0000_0000 + index).to_string()
}

fn json_record(value: Value, line_ending: LineEnding) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&value).expect("JSON values must serialize");
    bytes.extend_from_slice(line_ending.bytes());
    bytes
}

fn compact_boundary(session_id: &str, uuid: &str, line_ending: LineEnding) -> Vec<u8> {
    json_record(
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "sessionId": session_id,
            "uuid": uuid,
            "parentUuid": null,
            "logicalParentUuid": native_uuid(900),
            "isSidechain": false,
            "version": "2.1.220"
        }),
        line_ending,
    )
}

fn compact_summary(
    session_id: &str,
    boundary_uuid: &str,
    uuid: &str,
    line_ending: LineEnding,
) -> Vec<u8> {
    json_record(
        json!({
            "type": "user",
            "sessionId": session_id,
            "uuid": uuid,
            "parentUuid": boundary_uuid,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }),
        line_ending,
    )
}

fn message_record(
    record_type: &str,
    parent_uuid: &str,
    uuid: &str,
    include_session_id: bool,
    content: Value,
    line_ending: LineEnding,
) -> Vec<u8> {
    let mut value = json!({
        "type": record_type,
        "uuid": uuid,
        "parentUuid": parent_uuid,
        "message": {"role": record_type, "content": content}
    });
    if include_session_id {
        value["sessionId"] = json!(SESSION_ID);
    }
    json_record(value, line_ending)
}

fn neutral_record(padding: usize, line_ending: LineEnding) -> Vec<u8> {
    json_record(
        json!({"type": "metadata", "value": "n".repeat(padding)}),
        line_ending,
    )
}

fn tool_use_record(
    parent_uuid: &str,
    uuid: &str,
    tool_id: &str,
    include_session_id: bool,
    line_ending: LineEnding,
) -> Vec<u8> {
    message_record(
        "assistant",
        parent_uuid,
        uuid,
        include_session_id,
        json!([{"type": "tool_use", "id": tool_id, "name": "Read", "input": {}}]),
        line_ending,
    )
}

fn tool_result_record(
    parent_uuid: &str,
    uuid: &str,
    tool_id: &str,
    include_session_id: bool,
    line_ending: LineEnding,
) -> Vec<u8> {
    message_record(
        "user",
        parent_uuid,
        uuid,
        include_session_id,
        json!([{"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}]),
        line_ending,
    )
}

fn remove_final_line_ending(records: &mut [Vec<u8>], line_ending: LineEnding) {
    let final_record = records
        .last_mut()
        .expect("a generated compact generation must have records");
    let new_length = final_record
        .len()
        .checked_sub(line_ending.bytes().len())
        .expect("a generated record must contain its line ending");
    final_record.truncate(new_length);
}

fn concatenate(records: &[Vec<u8>]) -> Vec<u8> {
    records.iter().flatten().copied().collect()
}

#[derive(Clone, Debug)]
struct ValidScenario {
    older_generation: bool,
    line_ending: LineEnding,
    tail_alignment: TailAlignment,
    unterminated_final_record: bool,
    body_records: u8,
    parent_choices: [u8; 8],
    include_session_ids: [bool; 8],
    tool_pairs: u8,
    neutral_records: u8,
}

fn valid_scenario_strategy() -> impl Strategy<Value = ValidScenario> {
    (
        (any::<bool>(), any::<bool>(), any::<bool>(), any::<bool>()),
        (
            0_u8..=4,
            proptest::array::uniform8(any::<u8>()),
            proptest::array::uniform8(any::<bool>()),
            0_u8..=2,
            0_u8..=2,
        ),
    )
        .prop_map(
            |(
                (older_generation, crlf, aligned, unterminated_final_record),
                (body_records, parent_choices, include_session_ids, tool_pairs, neutral_records),
            )| ValidScenario {
                older_generation,
                line_ending: LineEnding::from_crlf(crlf),
                tail_alignment: TailAlignment::from_boundary(aligned),
                unterminated_final_record,
                body_records,
                parent_choices,
                include_session_ids,
                tool_pairs,
                neutral_records,
            },
        )
}

struct ValidHistory {
    retained_records: Vec<Vec<u8>>,
    newest_record_index: usize,
}

fn build_valid_history(scenario: &ValidScenario) -> ValidHistory {
    let mut retained_records = Vec::new();
    if scenario.older_generation {
        let older_boundary = native_uuid(10);
        let older_summary = native_uuid(11);
        retained_records.push(compact_boundary(
            SESSION_ID,
            &older_boundary,
            scenario.line_ending,
        ));
        retained_records.push(compact_summary(
            SESSION_ID,
            &older_boundary,
            &older_summary,
            scenario.line_ending,
        ));
    }

    let newest_record_index = retained_records.len();
    let boundary_uuid = native_uuid(100);
    let summary_uuid = native_uuid(101);
    retained_records.push(compact_boundary(
        SESSION_ID,
        &boundary_uuid,
        scenario.line_ending,
    ));
    retained_records.push(compact_summary(
        SESSION_ID,
        &boundary_uuid,
        &summary_uuid,
        scenario.line_ending,
    ));

    let mut seen_uuids = vec![boundary_uuid, summary_uuid];
    for index in 0..usize::from(scenario.body_records) {
        let parent_index = usize::from(scenario.parent_choices[index]) % seen_uuids.len();
        let parent_uuid = &seen_uuids[parent_index];
        let uuid = native_uuid(200 + index as u128);
        let record_type = if index % 2 == 0 { "user" } else { "assistant" };
        retained_records.push(message_record(
            record_type,
            parent_uuid,
            &uuid,
            scenario.include_session_ids[index],
            json!(format!("body-{index}")),
            scenario.line_ending,
        ));
        seen_uuids.push(uuid);
    }

    for index in 0..scenario.neutral_records {
        retained_records.push(neutral_record(usize::from(index) * 7, scenario.line_ending));
    }

    for index in 0..usize::from(scenario.tool_pairs) {
        let choice_index = (usize::from(scenario.body_records) + index) % 8;
        let parent_index = usize::from(scenario.parent_choices[choice_index]) % seen_uuids.len();
        let use_uuid = native_uuid(300 + (index as u128 * 2));
        let result_uuid = native_uuid(301 + (index as u128 * 2));
        let tool_id = format!("tool-{index}");
        retained_records.push(tool_use_record(
            &seen_uuids[parent_index],
            &use_uuid,
            &tool_id,
            scenario.include_session_ids[choice_index],
            scenario.line_ending,
        ));
        seen_uuids.push(use_uuid.clone());
        retained_records.push(tool_result_record(
            &use_uuid,
            &result_uuid,
            &tool_id,
            scenario.include_session_ids[(choice_index + 1) % 8],
            scenario.line_ending,
        ));
        seen_uuids.push(result_uuid);
    }

    if scenario.unterminated_final_record {
        remove_final_line_ending(&mut retained_records, scenario.line_ending);
    }

    ValidHistory {
        retained_records,
        newest_record_index,
    }
}

struct TestSource {
    file: NamedTempFile,
    bytes: Vec<u8>,
    newest_boundary_offset: usize,
}

fn write_valid_source(
    history: &ValidHistory,
    limits: SelectionLimits,
    alignment: TailAlignment,
) -> io::Result<TestSource> {
    let retained = concatenate(&history.retained_records);
    let newest_relative_offset = history.retained_records[..history.newest_record_index]
        .iter()
        .map(Vec::len)
        .sum::<usize>();
    let candidate_length = retained.len().saturating_sub(newest_relative_offset);
    let limit =
        usize::try_from(limits.candidate_max_bytes).expect("test candidate limit must fit usize");
    assert!(candidate_length <= limit);
    assert!(retained.len() + 256 < limit);

    let (bytes, newest_boundary_offset) = match alignment {
        TailAlignment::RecordBoundary => {
            let outside = b"outside-tail-window\n";
            let window_filler_length = limit - retained.len();
            let mut bytes = Vec::with_capacity(outside.len() + limit);
            bytes.extend_from_slice(outside);
            if window_filler_length > 0 {
                bytes.extend(std::iter::repeat_n(b'x', window_filler_length - 1));
                bytes.push(b'\n');
            }
            let newest_boundary_offset = bytes.len() + newest_relative_offset;
            bytes.extend_from_slice(&retained);
            (bytes, newest_boundary_offset)
        }
        TailAlignment::MiddleOfRecord => {
            let prefix_length = limit + 128;
            let mut bytes = Vec::with_capacity(prefix_length + 1 + retained.len());
            bytes.extend(std::iter::repeat_n(b'x', prefix_length));
            bytes.push(b'\n');
            let newest_boundary_offset = bytes.len() + newest_relative_offset;
            bytes.extend_from_slice(&retained);
            (bytes, newest_boundary_offset)
        }
    };

    let mut file = NamedTempFile::new()?;
    file.write_all(&bytes)?;
    file.flush()?;

    Ok(TestSource {
        file,
        bytes,
        newest_boundary_offset,
    })
}

fn write_raw_source(records: &[Vec<u8>], limits: SelectionLimits) -> io::Result<TestSource> {
    let retained = concatenate(records);
    let limit =
        usize::try_from(limits.candidate_max_bytes).expect("test candidate limit must fit usize");
    let prefix_length = limit + 128;
    let mut bytes = Vec::with_capacity(prefix_length + 1 + retained.len());
    bytes.extend(std::iter::repeat_n(b'x', prefix_length));
    bytes.push(b'\n');
    let retained_offset = bytes.len();
    bytes.extend_from_slice(&retained);

    let mut file = NamedTempFile::new()?;
    file.write_all(&bytes)?;
    file.flush()?;

    Ok(TestSource {
        file,
        bytes,
        newest_boundary_offset: retained_offset,
    })
}

fn select(source: &TestSource, limits: SelectionLimits) -> io::Result<ClaudeHistorySelection> {
    select_with_limits_and_hook(source.file.path(), SESSION_ID, limits, || {})
}

fn property_result<T, E: Display>(result: Result<T, E>, context: &str) -> Result<T, TestCaseError> {
    result.map_err(|error| TestCaseError::fail(format!("{context}: {error}")))
}

struct CandidateView {
    bytes: Vec<u8>,
    source_size: u64,
    candidate_size: u64,
}

fn expect_candidate(selection: ClaudeHistorySelection) -> Result<CandidateView, TestCaseError> {
    match selection {
        ClaudeHistorySelection::Candidate(candidate) => Ok(CandidateView {
            source_size: candidate.source_size(),
            candidate_size: candidate.candidate_size(),
            bytes: candidate.into_bytes(),
        }),
        ClaudeHistorySelection::Ineligible(reason) => Err(TestCaseError::fail(format!(
            "expected candidate, got {reason:?}"
        ))),
    }
}

fn assert_ineligible(selection: ClaudeHistorySelection) -> TestCaseResult {
    prop_assert!(
        matches!(selection, ClaudeHistorySelection::Ineligible(_)),
        "expected fail-closed selection, got {selection:?}",
    );
    Ok(())
}

struct RawRecord<'a> {
    offset: usize,
    bytes: &'a [u8],
}

fn raw_records(bytes: &[u8], base_offset: usize) -> Vec<RawRecord<'_>> {
    let mut records = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        let end = bytes[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |position| start + position + 1);
        records.push(RawRecord {
            offset: base_offset + start,
            bytes: &bytes[start..end],
        });
        start = end;
    }
    records
}

fn record_json(record: &[u8]) -> Result<Value, TestCaseError> {
    let json_bytes = record.strip_suffix(b"\n").unwrap_or(record);
    let json_bytes = json_bytes.strip_suffix(b"\r").unwrap_or(json_bytes);
    serde_json::from_slice(json_bytes)
        .map_err(|error| TestCaseError::fail(format!("accepted record was invalid JSON: {error}")))
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, TestCaseError> {
    value
        .as_object()
        .ok_or_else(|| TestCaseError::fail(format!("{context} was not an object")))
}

fn string_field<'a>(
    value: &'a Value,
    field: &str,
    context: &str,
) -> Result<&'a str, TestCaseError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| TestCaseError::fail(format!("{context} had no string {field}")))
}

fn oracle_uuid(value: &Value, field: &str, context: &str) -> Result<Uuid, TestCaseError> {
    let raw = string_field(value, field, context)?;
    Uuid::parse_str(raw)
        .map_err(|error| TestCaseError::fail(format!("{context} had invalid {field}: {error}")))
}

fn oracle_session_id(value: &Value, required: bool, context: &str) -> TestCaseResult {
    match value.get("sessionId") {
        Some(Value::String(session_id)) => {
            prop_assert_eq!(
                session_id,
                SESSION_ID,
                "{} changed session identity",
                context,
            );
        }
        None if !required => {}
        None | Some(_) => {
            return Err(TestCaseError::fail(format!(
                "{context} had no valid session identity"
            )));
        }
    }
    Ok(())
}

fn oracle_message_shape(value: &Value, record_type: &str) -> TestCaseResult {
    let message = value
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| TestCaseError::fail("accepted message record had no message object"))?;
    prop_assert_eq!(
        message.get("role").and_then(Value::as_str),
        Some(record_type),
        "accepted message role did not match record type",
    );
    match message.get("content") {
        Some(Value::String(_)) => {}
        Some(Value::Array(blocks)) => {
            prop_assert!(
                blocks.iter().all(|block| {
                    block
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|block_type| !block_type.trim().is_empty())
                }),
                "accepted message contained an untyped content block",
            );
        }
        _ => return Err(TestCaseError::fail("accepted message had invalid content")),
    }
    Ok(())
}

fn oracle_ancestry(
    value: &Value,
    required: bool,
    seen_uuids: &mut HashSet<Uuid>,
    context: &str,
) -> TestCaseResult {
    match (value.get("uuid"), value.get("parentUuid")) {
        (None, None) if !required => Ok(()),
        (Some(_), Some(_)) => {
            let uuid = oracle_uuid(value, "uuid", context)?;
            let parent_uuid = oracle_uuid(value, "parentUuid", context)?;
            prop_assert!(
                seen_uuids.contains(&parent_uuid),
                "{} parent did not refer to an earlier retained record",
                context,
            );
            prop_assert!(
                seen_uuids.insert(uuid),
                "{} reused a retained UUID",
                context,
            );
            Ok(())
        }
        _ => Err(TestCaseError::fail(format!(
            "{context} had incomplete ancestry"
        ))),
    }
}

fn oracle_tool_blocks(
    value: &Value,
    record_type: &str,
    tool_uses: &mut HashSet<String>,
    tool_results: &mut HashSet<String>,
) -> TestCaseResult {
    let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };

    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                prop_assert_eq!(record_type, "assistant");
                let id = string_field(block, "id", "accepted tool use")?;
                prop_assert!(!id.is_empty(), "accepted tool use had an empty ID");
                prop_assert!(
                    tool_uses.insert(id.to_owned()),
                    "accepted candidate reused tool-use ID {id}",
                );
            }
            Some("tool_result") => {
                prop_assert_eq!(record_type, "user");
                let id = string_field(block, "tool_use_id", "accepted tool result")?;
                prop_assert!(!id.is_empty(), "accepted tool result had an empty ID");
                prop_assert!(
                    tool_uses.contains(id),
                    "accepted tool result {id} preceded its use",
                );
                prop_assert!(
                    tool_results.insert(id.to_owned()),
                    "accepted candidate reused tool-result ID {id}",
                );
            }
            Some(_) | None => {}
        }
    }
    Ok(())
}

fn newest_recognized_boundary_offset(
    source: &[u8],
    limits: SelectionLimits,
) -> Result<Option<usize>, TestCaseError> {
    let limit = usize::try_from(limits.candidate_max_bytes).map_err(|error| {
        TestCaseError::fail(format!("candidate limit did not fit usize: {error}"))
    })?;
    if source.len() <= limit {
        return Ok(None);
    }
    let tail_start = source.len() - limit;
    let scan_start = if source.get(tail_start.wrapping_sub(1)) == Some(&b'\n') {
        tail_start
    } else {
        source[tail_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(source.len(), |position| tail_start + position + 1)
    };

    let mut newest = None;
    for record in raw_records(&source[scan_start..], scan_start) {
        if record.bytes.len() > limits.record_max_bytes {
            continue;
        }
        let Ok(value) = record_json(record.bytes) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("system")
            && value.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
        {
            newest = Some(record.offset);
        }
    }
    Ok(newest)
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

    let candidate_start = source
        .bytes
        .len()
        .checked_sub(candidate.bytes.len())
        .ok_or_else(|| TestCaseError::fail("candidate exceeded source length"))?;
    prop_assert_eq!(
        candidate.bytes.as_slice(),
        &source.bytes[candidate_start..],
        "candidate rewrote source bytes",
    );
    prop_assert_eq!(
        newest_recognized_boundary_offset(&source.bytes, limits)?,
        Some(candidate_start),
        "candidate did not start at the newest recognized boundary",
    );

    let records = raw_records(&candidate.bytes, candidate_start);
    prop_assert!(records.len() >= 2, "candidate had no boundary and summary");
    prop_assert!(
        records
            .iter()
            .all(|record| record.bytes.len() <= limits.record_max_bytes),
        "candidate contained an over-limit record",
    );

    let boundary = record_json(records[0].bytes)?;
    let boundary_object = object(&boundary, "accepted compact boundary")?;
    prop_assert_eq!(
        boundary_object.get("type").and_then(Value::as_str),
        Some("system"),
    );
    prop_assert_eq!(
        boundary_object.get("subtype").and_then(Value::as_str),
        Some("compact_boundary"),
    );
    prop_assert_eq!(boundary_object.get("parentUuid"), Some(&Value::Null));
    prop_assert_eq!(
        boundary_object.get("isSidechain").and_then(Value::as_bool),
        Some(false),
    );
    prop_assert!(
        boundary_object
            .get("version")
            .and_then(Value::as_str)
            .is_some_and(|version| !version.is_empty()),
        "accepted boundary had no version",
    );
    oracle_session_id(&boundary, true, "accepted compact boundary")?;
    oracle_uuid(&boundary, "logicalParentUuid", "accepted compact boundary")?;
    let boundary_uuid = oracle_uuid(&boundary, "uuid", "accepted compact boundary")?;

    let summary = record_json(records[1].bytes)?;
    prop_assert_eq!(summary.get("type").and_then(Value::as_str), Some("user"));
    prop_assert_eq!(
        summary.get("isCompactSummary").and_then(Value::as_bool),
        Some(true),
    );
    let summary_message = summary
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| TestCaseError::fail("accepted summary had no message"))?;
    prop_assert_eq!(
        summary_message.get("role").and_then(Value::as_str),
        Some("user"),
    );
    prop_assert!(
        summary_message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|content| !content.trim().is_empty()),
        "accepted summary was empty",
    );
    oracle_session_id(&summary, true, "accepted compact summary")?;
    prop_assert_eq!(
        oracle_uuid(&summary, "parentUuid", "accepted compact summary")?,
        boundary_uuid,
        "accepted summary was not linked to its boundary",
    );
    let summary_uuid = oracle_uuid(&summary, "uuid", "accepted compact summary")?;
    prop_assert_ne!(summary_uuid, boundary_uuid);

    let mut seen_uuids = HashSet::from([boundary_uuid, summary_uuid]);
    let mut tool_uses = HashSet::new();
    let mut tool_results = HashSet::new();

    for (index, record) in records.iter().enumerate().skip(2) {
        let value = record_json(record.bytes)?;
        let record_type = string_field(&value, "type", "accepted body record")?;
        prop_assert!(
            !record_type.trim().is_empty(),
            "accepted body record had an empty type",
        );
        oracle_session_id(&value, false, "accepted body record")?;
        if matches!(record_type, "assistant" | "user") {
            oracle_message_shape(&value, record_type)?;
        }
        oracle_ancestry(
            &value,
            matches!(record_type, "assistant" | "attachment" | "system" | "user"),
            &mut seen_uuids,
            &format!("accepted body record {index}"),
        )?;
        oracle_tool_blocks(&value, record_type, &mut tool_uses, &mut tool_results)?;
    }

    prop_assert_eq!(
        tool_uses,
        tool_results,
        "accepted candidate had incomplete tool pairs",
    );
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum InvalidMutation {
    BoundaryWrongSession,
    BoundaryMissingVersion,
    BoundaryNonNullParent,
    BoundaryInvalidUuid,
    BoundaryInvalidLogicalParent,
    BoundarySidechain,
    MissingSummary,
    SummaryWrongSession,
    SummaryWrongParent,
    SummaryEmpty,
    SummaryWrongRole,
    SummaryDuplicateUuid,
    BodyWrongSession,
    BodyBrokenParent,
    BodyDuplicateUuid,
    BodyWrongRole,
    BodyMissingContent,
    MissingToolResult,
    ResultBeforeUse,
    DuplicateToolUse,
    DuplicateToolResult,
    ToolUseOnUser,
    ToolResultOnAssistant,
    MalformedRecord,
    OversizedRecord,
}

impl InvalidMutation {
    const ALL: [Self; 25] = [
        Self::BoundaryWrongSession,
        Self::BoundaryMissingVersion,
        Self::BoundaryNonNullParent,
        Self::BoundaryInvalidUuid,
        Self::BoundaryInvalidLogicalParent,
        Self::BoundarySidechain,
        Self::MissingSummary,
        Self::SummaryWrongSession,
        Self::SummaryWrongParent,
        Self::SummaryEmpty,
        Self::SummaryWrongRole,
        Self::SummaryDuplicateUuid,
        Self::BodyWrongSession,
        Self::BodyBrokenParent,
        Self::BodyDuplicateUuid,
        Self::BodyWrongRole,
        Self::BodyMissingContent,
        Self::MissingToolResult,
        Self::ResultBeforeUse,
        Self::DuplicateToolUse,
        Self::DuplicateToolResult,
        Self::ToolUseOnUser,
        Self::ToolResultOnAssistant,
        Self::MalformedRecord,
        Self::OversizedRecord,
    ];
}

fn invalid_history(mutation: InvalidMutation, line_ending: LineEnding) -> Vec<Vec<u8>> {
    let older_boundary = native_uuid(10);
    let older_summary = native_uuid(11);
    let boundary_uuid = native_uuid(100);
    let summary_uuid = native_uuid(101);
    let body_uuid = native_uuid(102);
    let use_uuid = native_uuid(103);
    let result_uuid = native_uuid(104);
    let mut records = vec![
        compact_boundary(SESSION_ID, &older_boundary, line_ending),
        compact_summary(SESSION_ID, &older_boundary, &older_summary, line_ending),
    ];

    let mut boundary = json!({
        "type": "system",
        "subtype": "compact_boundary",
        "sessionId": SESSION_ID,
        "uuid": boundary_uuid,
        "parentUuid": null,
        "logicalParentUuid": native_uuid(900),
        "isSidechain": false,
        "version": "2.1.220"
    });
    match mutation {
        InvalidMutation::BoundaryWrongSession => boundary["sessionId"] = json!(OTHER_SESSION_ID),
        InvalidMutation::BoundaryMissingVersion => {
            boundary
                .as_object_mut()
                .expect("boundary fixture must be an object")
                .remove("version");
        }
        InvalidMutation::BoundaryNonNullParent => {
            boundary["parentUuid"] = json!(native_uuid(899));
        }
        InvalidMutation::BoundaryInvalidUuid => boundary["uuid"] = json!("not-a-uuid"),
        InvalidMutation::BoundaryInvalidLogicalParent => {
            boundary["logicalParentUuid"] = json!("not-a-uuid");
        }
        InvalidMutation::BoundarySidechain => boundary["isSidechain"] = json!(true),
        _ => {}
    }
    records.push(json_record(boundary, line_ending));

    if matches!(mutation, InvalidMutation::MissingSummary) {
        return records;
    }

    let mut summary = json!({
        "type": "user",
        "sessionId": SESSION_ID,
        "uuid": summary_uuid,
        "parentUuid": boundary_uuid,
        "isCompactSummary": true,
        "message": {"role": "user", "content": "newest summary"}
    });
    match mutation {
        InvalidMutation::SummaryWrongSession => summary["sessionId"] = json!(OTHER_SESSION_ID),
        InvalidMutation::SummaryWrongParent => summary["parentUuid"] = json!(native_uuid(899)),
        InvalidMutation::SummaryEmpty => summary["message"]["content"] = json!(" "),
        InvalidMutation::SummaryWrongRole => summary["message"]["role"] = json!("assistant"),
        InvalidMutation::SummaryDuplicateUuid => summary["uuid"] = json!(boundary_uuid),
        _ => {}
    }
    records.push(json_record(summary, line_ending));

    match mutation {
        InvalidMutation::BodyWrongSession => records.push(json_record(
            json!({
                "type": "user",
                "sessionId": OTHER_SESSION_ID,
                "uuid": body_uuid,
                "parentUuid": summary_uuid,
                "message": {"role": "user", "content": "later"}
            }),
            line_ending,
        )),
        InvalidMutation::BodyBrokenParent => records.push(message_record(
            "user",
            &native_uuid(899),
            &body_uuid,
            true,
            json!("later"),
            line_ending,
        )),
        InvalidMutation::BodyDuplicateUuid => records.push(message_record(
            "user",
            &summary_uuid,
            &summary_uuid,
            true,
            json!("later"),
            line_ending,
        )),
        InvalidMutation::BodyWrongRole => records.push(json_record(
            json!({
                "type": "assistant",
                "sessionId": SESSION_ID,
                "uuid": body_uuid,
                "parentUuid": summary_uuid,
                "message": {"role": "user", "content": "later"}
            }),
            line_ending,
        )),
        InvalidMutation::BodyMissingContent => records.push(json_record(
            json!({
                "type": "user",
                "sessionId": SESSION_ID,
                "uuid": body_uuid,
                "parentUuid": summary_uuid,
                "message": {"role": "user"}
            }),
            line_ending,
        )),
        InvalidMutation::MissingToolResult => records.push(tool_use_record(
            &summary_uuid,
            &use_uuid,
            "tool-1",
            true,
            line_ending,
        )),
        InvalidMutation::ResultBeforeUse => {
            records.push(tool_result_record(
                &summary_uuid,
                &result_uuid,
                "tool-1",
                true,
                line_ending,
            ));
            records.push(tool_use_record(
                &result_uuid,
                &use_uuid,
                "tool-1",
                true,
                line_ending,
            ));
        }
        InvalidMutation::DuplicateToolUse => {
            records.push(tool_use_record(
                &summary_uuid,
                &use_uuid,
                "tool-1",
                true,
                line_ending,
            ));
            records.push(tool_result_record(
                &body_uuid,
                &result_uuid,
                "tool-1",
                true,
                line_ending,
            ));
            records.push(tool_use_record(
                &use_uuid,
                &body_uuid,
                "tool-1",
                true,
                line_ending,
            ));
        }
        InvalidMutation::DuplicateToolResult => {
            records.push(tool_use_record(
                &summary_uuid,
                &use_uuid,
                "tool-1",
                true,
                line_ending,
            ));
            records.push(tool_result_record(
                &use_uuid,
                &result_uuid,
                "tool-1",
                true,
                line_ending,
            ));
            records.push(tool_result_record(
                &result_uuid,
                &body_uuid,
                "tool-1",
                true,
                line_ending,
            ));
        }
        InvalidMutation::ToolUseOnUser => {
            records.push(message_record(
                "user",
                &summary_uuid,
                &body_uuid,
                true,
                json!([{"type": "tool_use", "id": "tool-1"}]),
                line_ending,
            ));
            records.push(tool_result_record(
                &body_uuid,
                &result_uuid,
                "tool-1",
                true,
                line_ending,
            ));
        }
        InvalidMutation::ToolResultOnAssistant => {
            records.push(tool_use_record(
                &summary_uuid,
                &use_uuid,
                "tool-1",
                true,
                line_ending,
            ));
            records.push(message_record(
                "assistant",
                &use_uuid,
                &body_uuid,
                true,
                json!([{"type": "tool_result", "tool_use_id": "tool-1"}]),
                line_ending,
            ));
        }
        InvalidMutation::MalformedRecord => records.push(b"{not-json}\n".to_vec()),
        InvalidMutation::OversizedRecord => records.push(neutral_record(
            GENERATED_LIMITS.record_max_bytes + 128,
            line_ending,
        )),
        InvalidMutation::BoundaryWrongSession
        | InvalidMutation::BoundaryMissingVersion
        | InvalidMutation::BoundaryNonNullParent
        | InvalidMutation::BoundaryInvalidUuid
        | InvalidMutation::BoundaryInvalidLogicalParent
        | InvalidMutation::BoundarySidechain
        | InvalidMutation::SummaryWrongSession
        | InvalidMutation::SummaryWrongParent
        | InvalidMutation::SummaryEmpty
        | InvalidMutation::SummaryWrongRole
        | InvalidMutation::SummaryDuplicateUuid
        | InvalidMutation::MissingSummary => {}
    }
    records
}

#[derive(Clone, Debug)]
enum GeneratedRecord {
    Boundary(u8),
    Summary(u8),
    User(u8),
    Assistant(u8),
    ToolUse(u8),
    ToolResult(u8),
    Neutral(u8),
    Malformed,
    Oversized,
}

#[derive(Clone, Debug)]
struct GeneratedLine {
    record: GeneratedRecord,
    line_ending: LineEnding,
    terminated: bool,
}

fn generated_record_strategy() -> impl Strategy<Value = GeneratedRecord> {
    prop_oneof![
        3 => (0_u8..4).prop_map(GeneratedRecord::Boundary),
        3 => (0_u8..5).prop_map(GeneratedRecord::Summary),
        3 => (0_u8..6).prop_map(GeneratedRecord::User),
        3 => (0_u8..5).prop_map(GeneratedRecord::Assistant),
        2 => (0_u8..4).prop_map(GeneratedRecord::ToolUse),
        2 => (0_u8..4).prop_map(GeneratedRecord::ToolResult),
        2 => (0_u8..64).prop_map(GeneratedRecord::Neutral),
        1 => Just(GeneratedRecord::Malformed),
        1 => Just(GeneratedRecord::Oversized),
    ]
}

fn generated_line_strategy() -> impl Strategy<Value = GeneratedLine> {
    (generated_record_strategy(), any::<bool>(), any::<bool>()).prop_map(
        |(record, crlf, terminated)| GeneratedLine {
            record,
            line_ending: LineEnding::from_crlf(crlf),
            terminated,
        },
    )
}

fn generated_lines_strategy() -> impl Strategy<Value = Vec<GeneratedLine>> {
    proptest::collection::vec(generated_line_strategy(), 0..=18)
}

fn generated_json(line: &GeneratedLine) -> Value {
    match line.record {
        GeneratedRecord::Boundary(mode) => {
            let boundary_id = if mode == 1 {
                native_uuid(2)
            } else {
                native_uuid(0)
            };
            let mut value = json!({
                "type": "system",
                "subtype": "compact_boundary",
                "sessionId": SESSION_ID,
                "uuid": boundary_id,
                "parentUuid": null,
                "logicalParentUuid": native_uuid(900),
                "isSidechain": false,
                "version": "2.1.220"
            });
            if mode == 2 {
                value["sessionId"] = json!(OTHER_SESSION_ID);
            } else if mode == 3 {
                value["uuid"] = json!("bad-uuid");
            }
            value
        }
        GeneratedRecord::Summary(mode) => {
            let (boundary_id, summary_id) = if mode == 1 {
                (native_uuid(2), native_uuid(3))
            } else {
                (native_uuid(0), native_uuid(1))
            };
            let mut value = json!({
                "type": "user",
                "sessionId": SESSION_ID,
                "uuid": summary_id,
                "parentUuid": boundary_id,
                "isCompactSummary": true,
                "message": {"role": "user", "content": "generated summary"}
            });
            if mode == 2 {
                value["sessionId"] = json!(OTHER_SESSION_ID);
            } else if mode == 3 {
                value["parentUuid"] = json!(native_uuid(9));
            } else if mode == 4 {
                value["message"]["content"] = json!(" ");
            }
            value
        }
        GeneratedRecord::User(mode) => {
            let mut value = json!({
                "type": "user",
                "sessionId": SESSION_ID,
                "uuid": native_uuid(4),
                "parentUuid": native_uuid(1),
                "message": {"role": "user", "content": "generated user"}
            });
            match mode {
                1 => {
                    value
                        .as_object_mut()
                        .expect("generated user must be an object")
                        .remove("sessionId");
                }
                2 => value["sessionId"] = json!(OTHER_SESSION_ID),
                3 => value["parentUuid"] = json!(native_uuid(9)),
                4 => value["uuid"] = json!(native_uuid(1)),
                5 => value["message"]["role"] = json!("assistant"),
                _ => {}
            }
            value
        }
        GeneratedRecord::Assistant(mode) => {
            let mut value = json!({
                "type": "assistant",
                "sessionId": SESSION_ID,
                "uuid": native_uuid(5),
                "parentUuid": native_uuid(1),
                "message": {"role": "assistant", "content": "generated assistant"}
            });
            match mode {
                1 => {
                    value
                        .as_object_mut()
                        .expect("generated assistant must be an object")
                        .remove("sessionId");
                }
                2 => value["sessionId"] = json!(OTHER_SESSION_ID),
                3 => value["parentUuid"] = json!(native_uuid(9)),
                4 => value["message"]["role"] = json!("user"),
                _ => {}
            }
            value
        }
        GeneratedRecord::ToolUse(mode) => {
            let mut value = json!({
                "type": "assistant",
                "sessionId": SESSION_ID,
                "uuid": native_uuid(6),
                "parentUuid": native_uuid(1),
                "message": {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "tool-1"}]
                }
            });
            if mode == 1 {
                value["message"]["content"][0]["id"] = json!("");
            } else if mode == 2 {
                value["type"] = json!("user");
                value["message"]["role"] = json!("user");
            } else if mode == 3 {
                value["uuid"] = json!(native_uuid(1));
            }
            value
        }
        GeneratedRecord::ToolResult(mode) => {
            let mut value = json!({
                "type": "user",
                "sessionId": SESSION_ID,
                "uuid": native_uuid(7),
                "parentUuid": native_uuid(6),
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "tool-1"}]
                }
            });
            if mode == 1 {
                value["message"]["content"][0]["tool_use_id"] = json!("tool-2");
            } else if mode == 2 {
                value["type"] = json!("assistant");
                value["message"]["role"] = json!("assistant");
            } else if mode == 3 {
                value["parentUuid"] = json!(native_uuid(1));
            }
            value
        }
        GeneratedRecord::Neutral(padding) => {
            json!({"type": "metadata", "value": "n".repeat(usize::from(padding))})
        }
        GeneratedRecord::Malformed | GeneratedRecord::Oversized => Value::Null,
    }
}

fn encode_generated_line(line: &GeneratedLine) -> Vec<u8> {
    let mut bytes = match line.record {
        GeneratedRecord::Malformed => b"{not-json".to_vec(),
        GeneratedRecord::Oversized => serde_json::to_vec(&json!({
            "type": "metadata",
            "value": "x".repeat(GENERATED_LIMITS.record_max_bytes + 128)
        }))
        .expect("generated oversized JSON must serialize"),
        _ => serde_json::to_vec(&generated_json(line))
            .expect("generated arbitrary JSON must serialize"),
    };
    if line.terminated {
        bytes.extend_from_slice(line.line_ending.bytes());
    }
    bytes
}

#[test]
fn every_named_newest_generation_mutation_fails_closed() {
    for mutation in InvalidMutation::ALL {
        for line_ending in [LineEnding::Lf, LineEnding::Crlf] {
            let records = invalid_history(mutation, line_ending);
            let source = write_raw_source(&records, GENERATED_LIMITS)
                .expect("invalid generated history must be writable");
            let selection = select(&source, GENERATED_LIMITS)
                .expect("invalid generated history must be selectable");

            assert!(
                matches!(selection, ClaudeHistorySelection::Ineligible(_)),
                "mutation {mutation:?} with {line_ending:?} selected {selection:?}",
            );
        }
    }
}

#[test]
fn line_endings_tail_alignment_and_unterminated_eof_preserve_exact_bytes() {
    for line_ending in [LineEnding::Lf, LineEnding::Crlf] {
        for tail_alignment in [TailAlignment::RecordBoundary, TailAlignment::MiddleOfRecord] {
            for unterminated_final_record in [false, true] {
                let scenario = ValidScenario {
                    older_generation: true,
                    line_ending,
                    tail_alignment,
                    unterminated_final_record,
                    body_records: 1,
                    parent_choices: [0; 8],
                    include_session_ids: [true; 8],
                    tool_pairs: 1,
                    neutral_records: 1,
                };
                let history = build_valid_history(&scenario);
                let source = write_valid_source(&history, GENERATED_LIMITS, tail_alignment)
                    .expect("boundary matrix source must be writable");
                let selection = select(&source, GENERATED_LIMITS)
                    .expect("boundary matrix source must be selectable");
                let candidate = match selection {
                    ClaudeHistorySelection::Candidate(candidate) => candidate,
                    ClaudeHistorySelection::Ineligible(reason) => {
                        panic!(
                            "{line_ending:?}/{tail_alignment:?}/unterminated={unterminated_final_record} was ineligible: {reason:?}"
                        );
                    }
                };

                assert_eq!(
                    candidate.into_bytes(),
                    source.bytes[source.newest_boundary_offset..],
                );
            }
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
            write_valid_source(&history, GENERATED_LIMITS, scenario.tail_alignment),
            "write generated valid source",
        )?;
        let selection = property_result(
            select(&source, GENERATED_LIMITS),
            "select generated valid source",
        )?;
        let candidate = expect_candidate(selection)?;

        prop_assert_eq!(
            candidate.bytes.as_slice(),
            &source.bytes[source.newest_boundary_offset..],
        );
        assert_candidate_invariants(candidate, &source, GENERATED_LIMITS)?;
    }

    #[test]
    fn arbitrary_bounded_record_sequences_never_panic_and_preserve_accepted_invariants(
        generated in generated_lines_strategy(),
    ) {
        let records = generated
            .iter()
            .map(encode_generated_line)
            .collect::<Vec<_>>();
        let source = property_result(
            write_raw_source(&records, GENERATED_LIMITS),
            "write arbitrary generated source",
        )?;
        let selection = property_result(
            select(&source, GENERATED_LIMITS),
            "select arbitrary generated source",
        )?;

        if let ClaudeHistorySelection::Candidate(candidate) = selection {
            let view = CandidateView {
                source_size: candidate.source_size(),
                candidate_size: candidate.candidate_size(),
                bytes: candidate.into_bytes(),
            };
            assert_candidate_invariants(view, &source, GENERATED_LIMITS)?;
        }
    }

    #[test]
    fn generated_candidate_and_record_sizes_enforce_exact_boundaries(
        padding in 256_usize..=512,
    ) {
        let line_ending = LineEnding::Lf;
        let boundary_uuid = native_uuid(100);
        let summary_uuid = native_uuid(101);
        let candidate_records = vec![
            compact_boundary(SESSION_ID, &boundary_uuid, line_ending),
            compact_summary(
                SESSION_ID,
                &boundary_uuid,
                &summary_uuid,
                line_ending,
            ),
            neutral_record(padding, line_ending),
        ];
        let candidate = concatenate(&candidate_records);
        let record_size = candidate_records
            .iter()
            .map(Vec::len)
            .max()
            .expect("generated candidate must contain records");
        prop_assert_eq!(record_size, candidate_records[2].len());

        let exact_candidate_limits = SelectionLimits {
            candidate_max_bytes: candidate.len() as u64,
            record_max_bytes: record_size,
        };
        let mut exact_file = NamedTempFile::new()
            .map_err(|error| TestCaseError::fail(format!("create exact source: {error}")))?;
        let outside = b"outside-tail-window\n";
        property_result(exact_file.write_all(outside), "write exact source prefix")?;
        property_result(exact_file.write_all(&candidate), "write exact candidate")?;
        property_result(exact_file.flush(), "flush exact candidate")?;
        let exact_source = TestSource {
            file: exact_file,
            bytes: outside.iter().copied().chain(candidate.iter().copied()).collect(),
            newest_boundary_offset: outside.len(),
        };

        let exact = property_result(
            select(&exact_source, exact_candidate_limits),
            "select exact-size candidate",
        )?;
        let exact_candidate = expect_candidate(exact)?;
        prop_assert_eq!(exact_candidate.candidate_size, candidate.len() as u64);
        assert_candidate_invariants(exact_candidate, &exact_source, exact_candidate_limits)?;

        let candidate_over_limits = SelectionLimits {
            candidate_max_bytes: candidate.len().saturating_sub(1) as u64,
            ..exact_candidate_limits
        };
        let over = property_result(
            select(&exact_source, candidate_over_limits),
            "select one-byte-over candidate",
        )?;
        assert_ineligible(over)?;

        let record_limits = SelectionLimits {
            candidate_max_bytes: GENERATED_LIMITS.candidate_max_bytes,
            record_max_bytes: record_size,
        };
        let record_history = ValidHistory {
            retained_records: candidate_records,
            newest_record_index: 0,
        };
        let record_source = property_result(
            write_valid_source(
                &record_history,
                record_limits,
                TailAlignment::MiddleOfRecord,
            ),
            "write exact-record source",
        )?;
        let exact_record = property_result(
            select(&record_source, record_limits),
            "select exact-size record",
        )?;
        let exact_record_candidate = expect_candidate(exact_record)?;
        assert_candidate_invariants(exact_record_candidate, &record_source, record_limits)?;

        let record_over_limits = SelectionLimits {
            record_max_bytes: record_size.saturating_sub(1),
            ..record_limits
        };
        prop_assert!(
            candidate
                .split_inclusive(|byte| *byte == b'\n')
                .take(2)
                .all(|record| record.len() <= record_over_limits.record_max_bytes),
            "record over-limit fixture hid the compact boundary",
        );
        let over = property_result(
            select(&record_source, record_over_limits),
            "select one-byte-over record",
        )?;
        assert_ineligible(over)?;
    }
}
