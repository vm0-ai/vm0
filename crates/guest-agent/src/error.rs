//! Error types for the guest agent.

/// Agent error type covering all failure modes.
#[derive(thiserror::Error, Debug)]
pub enum AgentError {
    /// HTTP helper boundary failure: request send/retry exhaustion, non-2xx
    /// status, response body read, or response JSON parsing for webhook/S3 calls.
    #[error("http: {0}")]
    Http(String),

    /// Local OS I/O failure outside the HTTP helper, such as filesystem access,
    /// temporary directory creation, or child-process stdout/stderr pipes.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parse/serialize failure outside HTTP response handling.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    /// Guest CLI or child-process lifecycle failure, including command setup,
    /// missing pipes, timeout/termination, heartbeat fatal errors, and task panics.
    #[error("execution: {0}")]
    Execution(String),

    /// Checkpoint, session-history, or artifact snapshot workflow failure inside
    /// the guest-agent; this does not refer to Firecracker/rootfs snapshots.
    #[error("checkpoint: {0}")]
    Checkpoint(String),

    /// Telemetry flush channel is unavailable because the uploader task was not
    /// initialized, has exited, or dropped the per-flush response channel.
    #[error("telemetry uploader unavailable")]
    TelemetryUnavailable,
}
