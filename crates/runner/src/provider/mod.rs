//! Job provider trait and implementations.
//!
//! The [`JobProvider`] trait abstracts job lifecycle (discovery, claiming,
//! completion reporting) so different transports can be plugged in without
//! changing the executor or main loop.

mod api;
mod local;

pub use api::ApiProvider;
pub use local::LocalProvider;
pub(crate) use local::{JobRequest, JobResponse};

use uuid::Uuid;

use crate::types::{ExecutionContext, HeartbeatState};

/// Abstraction over job lifecycle — discovery, claiming, and completion reporting.
///
/// The runner main loop calls [`discover()`](JobProvider::discover) to find work,
/// [`claim()`](JobProvider::claim) to claim it, and
/// [`complete()`](JobProvider::complete) to report results. All transport
/// details (Ably push, HTTP poll, WebSocket, etc.) are hidden behind this trait.
///
/// `discover()` and `claim()` are deliberately separate so that `discover()`
/// can live as a cancellable `select!` branch future while `claim()` runs
/// inside the branch handler where it cannot be interrupted.
#[async_trait::async_trait]
pub trait JobProvider: Send + Sync {
    /// Wait for the next job candidate. Returns `None` on shutdown signal.
    ///
    /// Implementations handle discovery (push/poll) internally. The returned
    /// tuple contains the candidate `run_id` and the profile name (e.g.
    /// `"vm0/default"`) for resource-budget pre-checking before
    /// [`claim()`](JobProvider::claim).
    ///
    /// This method has **no server-side side effects** and can be safely
    /// dropped (cancelled) at any `.await` point.
    async fn discover(&self) -> Option<(Uuid, String)>;

    /// Claim a discovered job. Returns `None` if the job was already claimed
    /// by another runner or an error occurred.
    ///
    /// Callers **must** invoke this from a non-cancellable context (e.g.
    /// inside a `select!` branch handler) to guarantee that a successful
    /// claim is always paired with a later [`complete()`](JobProvider::complete).
    async fn claim(&self, run_id: Uuid) -> Option<ExecutionContext>;

    /// Report job completion. Called concurrently from spawned executor tasks.
    ///
    /// Implementations manage auth tokens and retry logic internally.
    async fn complete(&self, run_id: Uuid, exit_code: i32, error: Option<&str>);

    /// Report runner state to the server. Fire-and-forget — failures are
    /// logged but do not affect runner operation.
    async fn heartbeat(&self, state: &HeartbeatState);

    /// Release discovery resources (subscriptions, background tasks).
    ///
    /// Called once after `discover()` returns `None` and before draining
    /// in-flight jobs. `complete()` calls may still arrive after this.
    async fn shutdown(&self);
}
