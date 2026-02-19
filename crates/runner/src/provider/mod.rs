//! Job provider trait and implementations.
//!
//! The [`JobProvider`] trait abstracts job lifecycle (discovery, claiming,
//! completion reporting) so different transports can be plugged in without
//! changing the executor or main loop.

mod api;

pub use api::ApiProvider;

use uuid::Uuid;

use crate::types::ExecutionContext;

/// Abstraction over job lifecycle — discovery, claiming, and completion reporting.
///
/// The runner main loop calls [`next_job()`](JobProvider::next_job) to get work
/// and [`complete()`](JobProvider::complete) to report results. All transport
/// details (Ably push, HTTP poll, WebSocket, etc.) are hidden behind this trait.
#[async_trait::async_trait]
pub trait JobProvider: Send + Sync {
    /// Wait for the next available job. Returns `None` on shutdown signal.
    ///
    /// Implementations handle discovery (push/poll), claiming, and retry logic
    /// internally. The returned [`ExecutionContext`] is ready for execution.
    async fn next_job(&self) -> Option<ExecutionContext>;

    /// Report job completion. Called concurrently from spawned executor tasks.
    ///
    /// Implementations manage auth tokens and retry logic internally.
    async fn complete(&self, run_id: Uuid, exit_code: i32, error: Option<&str>);
}
