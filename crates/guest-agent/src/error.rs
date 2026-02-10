//! Error types for the guest agent.

/// Agent error type covering all failure modes.
#[derive(thiserror::Error, Debug)]
pub enum AgentError {
    #[error("http: {0}")]
    Http(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("execution: {0}")]
    Execution(String),

    #[error("checkpoint: {0}")]
    Checkpoint(String),
}
