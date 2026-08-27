//! Reusable mock Codex app-server contract used by the binary and tests.
//!
//! The mock speaks Codex app-server newline-delimited JSON-RPC over stdio and
//! persists JSONL session artifacts under the resolved Codex home. The artifact
//! root is resolved as follows: a non-empty `$CODEX_HOME` takes precedence; an
//! empty `$CODEX_HOME` is treated as unset, so `$HOME/.codex` is used, falling
//! back to `/home/user/.codex` when `$HOME` is unavailable.

mod app_server;
mod session;

pub use app_server::run_app_server;
pub use session::{
    codex_home, find_session_file, read_session_file, session_artifacts, session_files,
};
