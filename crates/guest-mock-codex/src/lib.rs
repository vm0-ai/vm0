//! Reusable mock Codex app-server contract used by the binary and tests.
//!
//! The mock speaks Codex app-server newline-delimited JSON-RPC over stdio and
//! persists JSONL session artifacts under `$CODEX_HOME`.

mod app_server;
mod session;

pub use app_server::run_app_server;
pub use session::{
    codex_home, find_session_file, read_session_file, session_artifacts, session_files,
};
