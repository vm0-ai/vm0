use chrono::Utc;
use serde_json::Value;
use std::io;

use crate::session::{
    build_session_path, codex_home, emit_events, ensure_runtime_session_path_usable,
    write_session_file,
};

/// Embedded JSONL fixtures selectable via `MOCK_CODEX_FIXTURE=<name>`.
///
/// Each fixture's first event must be `thread.started{thread_id}` with a
/// canonical UUID thread id; that id is used to compute the on-disk session
/// path so the guest-agent's checkpoint scan finds the same payload that was
/// emitted to stdout. Adding a new fixture: drop a `*.jsonl` file under
/// `fixtures/`, append a `(name, include_str!(...))` row here, and refer
/// to it from the bats test by `MOCK_CODEX_FIXTURE=<name>`.
const FIXTURES: &[(&str, &str)] = &[
    (
        "event-mapping-rich",
        include_str!("../fixtures/event-mapping-rich.jsonl"),
    ),
    ("turn-failed", include_str!("../fixtures/turn-failed.jsonl")),
    ("error-event", include_str!("../fixtures/error-event.jsonl")),
    (
        "invalid-api-key",
        include_str!("../fixtures/invalid-api-key.jsonl"),
    ),
];

/// Look up a fixture by name. Returns the fixture's raw JSONL content.
pub fn lookup_fixture(name: &str) -> Option<&'static str> {
    FIXTURES.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

/// Run a fixture: parse JSONL, extract thread id from `thread.started`,
/// emit events to stdout, and persist the session file under `$CODEX_HOME`
/// so checkpoint reads see the same content the CLI saw.
pub fn run_fixture(content: &str) -> io::Result<()> {
    let events = parse_fixture_events(content)?;
    let thread_id = extract_thread_id(&events).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "fixture missing thread.started/thread_id",
        )
    })?;
    let home = codex_home();
    let path = build_session_path(&home, Utc::now().date_naive(), &thread_id)?;
    ensure_runtime_session_path_usable(&home, &path)?;

    let mut stdout = io::stdout().lock();
    emit_events(&mut stdout, &events)?;

    write_session_file(&path, &events)
}

/// Parse JSONL fixture content into a vector of `Value`. Empty lines
/// (incl. trailing newline) are skipped.
fn parse_fixture_events(content: &str) -> io::Result<Vec<Value>> {
    content
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
        })
        .collect()
}

/// Extract the thread id from the first `thread.started` event in a
/// parsed fixture, if present.
fn extract_thread_id(events: &[Value]) -> Option<String> {
    events
        .iter()
        .find(|event| event.get("type").and_then(|value| value.as_str()) == Some("thread.started"))
        .and_then(|event| event.get("thread_id").and_then(|value| value.as_str()))
        .map(String::from)
}
