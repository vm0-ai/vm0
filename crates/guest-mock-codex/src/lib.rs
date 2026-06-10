//! Reusable mock Codex contract used by the `guest-mock-codex` binary and tests.
//!
//! The mock emits Codex `exec --json` protocol events on stdout and persists a
//! JSONL session file under Codex's date-partitioned session tree:
//! `$CODEX_HOME/sessions/YYYY/MM/DD/<thread_id>.jsonl`.
//!
//! Resume can also append to runner-restored rollout filenames, matching the
//! real Codex CLI's filesystem resume candidates.

use chrono::Utc;
use std::io;
use uuid::Uuid;

mod events;
mod fixtures;
mod prompt;
mod session;

pub use events::build_events;
pub use fixtures::{lookup_fixture, run_fixture};
pub use prompt::join_prompt;
pub use session::{
    append_session_file, build_session_path, codex_home, emit_events, find_session_file,
    read_session_file, session_artifacts, session_files, write_session_file,
};

/// Execute a new synthetic turn with a UUID v7 thread id.
pub fn run_new(prompt: &str) -> io::Result<()> {
    let thread_id = Uuid::now_v7().to_string();
    run_turn(&thread_id, prompt, false)
}

/// Execute a synthetic resume turn with the supplied canonical UUID thread id.
pub fn run_resume(thread_id: &str, prompt: &str) -> io::Result<()> {
    run_turn(thread_id, prompt, true)
}

/// Persist the three-event synthetic turn, then emit it on stdout
/// under `$CODEX_HOME`.
fn run_turn(thread_id: &str, prompt: &str, is_resume: bool) -> io::Result<()> {
    let home = codex_home();
    let today = Utc::now().date_naive();
    let events = build_events(thread_id, prompt);

    if is_resume {
        session::persist_resume_session(&home, today, thread_id, &events)?;
    } else {
        session::persist_new_session(&home, today, thread_id, &events)?;
    }

    let mut stdout = io::stdout().lock();
    emit_events(&mut stdout, &events)
}
