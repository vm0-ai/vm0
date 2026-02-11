#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("backend not available: {0}")]
    BackendNotAvailable(String),

    #[error("sandbox creation failed: {0}")]
    CreationFailed(String),

    #[error("sandbox start failed: {0}")]
    StartFailed(String),

    #[error("execution failed: {0}")]
    ExecFailed(String),

    #[error("invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, SandboxError>;
