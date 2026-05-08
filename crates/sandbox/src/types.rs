use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundedExecStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundedExecTermination {
    Exited { exit_code: i32 },
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedExecOutputEvent {
    pub stream: BoundedExecStream,
    pub sequence: u32,
    pub chunk: Vec<u8>,
    pub truncated: bool,
}

pub struct BoundedExecStreamRequest {
    pub event_tx: tokio::sync::mpsc::UnboundedSender<BoundedExecOutputEvent>,
    pub stdout: bool,
    pub stderr: bool,
    pub chunk_limit_bytes: u32,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
}

pub struct BoundedExecRequest<'a> {
    pub cmd: &'a str,
    pub timeout: Duration,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
    pub stdin: Option<&'a [u8]>,
    pub stdout_limit_bytes: u32,
    pub stderr_limit_bytes: u32,
    pub stream: Option<BoundedExecStreamRequest>,
}

impl BoundedExecRequest<'_> {
    /// Return the timeout as whole milliseconds, saturating at `u32::MAX`.
    pub fn timeout_ms(&self) -> u32 {
        u32::try_from(self.timeout.as_millis()).unwrap_or(u32::MAX)
    }
}

pub struct BoundedExecResult {
    pub termination: BoundedExecTermination,
    pub duration: Duration,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

pub struct ExecRequest<'a> {
    pub cmd: &'a str,
    pub timeout: Duration,
    pub env: &'a [(&'a str, &'a str)],
    pub sudo: bool,
}

impl ExecRequest<'_> {
    /// Return the timeout as whole milliseconds, saturating at `u32::MAX`.
    pub fn timeout_ms(&self) -> u32 {
        u32::try_from(self.timeout.as_millis()).unwrap_or(u32::MAX)
    }
}

pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub struct SpawnHandle {
    pub pid: u32,
    /// Receives stdout chunks in real-time when the guest streams them.
    /// `None` when the backend does not support streaming.
    pub stdout_rx: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpawnOutputMode<'a> {
    Buffered,
    Stream { guest_log_path: Option<&'a str> },
}

impl<'a> SpawnOutputMode<'a> {
    pub fn streams_stdout(self) -> bool {
        matches!(self, Self::Stream { .. })
    }

    pub fn guest_log_path(self) -> Option<&'a str> {
        match self {
            Self::Buffered => None,
            Self::Stream { guest_log_path } => guest_log_path,
        }
    }
}

pub struct ProcessExit {
    pub pid: u32,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_ms_normal() {
        let req = ExecRequest {
            cmd: "echo hi",
            timeout: Duration::from_millis(5000),
            env: &[],
            sudo: false,
        };
        assert_eq!(req.timeout_ms(), 5000);
    }

    #[test]
    fn timeout_ms_zero() {
        let req = ExecRequest {
            cmd: "true",
            timeout: Duration::ZERO,
            env: &[],
            sudo: false,
        };
        assert_eq!(req.timeout_ms(), 0);
    }

    #[test]
    fn timeout_ms_saturates_at_u32_max() {
        let req = ExecRequest {
            cmd: "sleep infinity",
            timeout: Duration::from_secs(u64::MAX / 1000),
            env: &[],
            sudo: false,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }

    #[test]
    fn timeout_ms_exact_u32_max() {
        let req = ExecRequest {
            cmd: "cmd",
            timeout: Duration::from_millis(u32::MAX as u64),
            env: &[],
            sudo: false,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }

    #[test]
    fn bounded_timeout_ms_saturates_at_u32_max() {
        let req = BoundedExecRequest {
            cmd: "sleep infinity",
            timeout: Duration::from_secs(u64::MAX / 1000),
            env: &[],
            sudo: false,
            stdin: None,
            stdout_limit_bytes: 0,
            stderr_limit_bytes: 0,
            stream: None,
        };
        assert_eq!(req.timeout_ms(), u32::MAX);
    }
}
