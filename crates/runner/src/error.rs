#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("api error: {0}")]
    Api(String),

    #[error("job already claimed by another runner")]
    AlreadyClaimed,

    #[error("sandbox error: {0}")]
    Sandbox(#[from] sandbox::SandboxError),

    #[error("config error: {0}")]
    Config(String),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("snapshot error: {0}")]
    Snapshot(#[from] sandbox_fc::SnapshotError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type RunnerResult<T> = Result<T, RunnerError>;
