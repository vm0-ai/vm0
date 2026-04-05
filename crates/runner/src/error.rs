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
    Snapshot(#[from] sandbox::SnapshotError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type RunnerResult<T> = Result<T, RunnerError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_api_error() {
        let e = RunnerError::Api("timeout".into());
        assert_eq!(e.to_string(), "api error: timeout");
    }

    #[test]
    fn display_already_claimed() {
        let e = RunnerError::AlreadyClaimed;
        assert_eq!(e.to_string(), "job already claimed by another runner");
    }

    #[test]
    fn display_config_error() {
        let e = RunnerError::Config("missing field".into());
        assert_eq!(e.to_string(), "config error: missing field");
    }

    #[test]
    fn display_internal_error() {
        let e = RunnerError::Internal("unexpected".into());
        assert_eq!(e.to_string(), "internal error: unexpected");
    }

    #[test]
    fn from_sandbox_error() {
        let sandbox_err = sandbox::SandboxError::CreationFailed("no kvm".into());
        let runner_err: RunnerError = sandbox_err.into();
        assert!(runner_err.to_string().contains("no kvm"));
        assert!(matches!(runner_err, RunnerError::Sandbox(_)));
    }

    #[test]
    fn from_snapshot_error() {
        let snap_err = sandbox::SnapshotError::Setup("missing kernel".into());
        let runner_err: RunnerError = snap_err.into();
        assert!(runner_err.to_string().contains("missing kernel"));
        assert!(matches!(runner_err, RunnerError::Snapshot(_)));
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let runner_err: RunnerError = io_err.into();
        assert!(runner_err.to_string().contains("file missing"));
        assert!(matches!(runner_err, RunnerError::Io(_)));
    }
}
