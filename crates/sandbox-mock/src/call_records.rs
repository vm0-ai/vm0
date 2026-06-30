use std::path::PathBuf;
use std::time::Duration;

use ::sandbox::{ExecOutputLimits, ProcessControlMode, ProcessOutputMode};

/// Behavior override applied to exec calls whose command contains the pattern.
pub struct ExecMatcher {
    /// Substring to match against `ExecRequest.cmd`.
    pub pattern: String,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Captured `exec` request fields recorded for test assertions.
///
/// The record intentionally keeps environment variable names but not their
/// values. Stdin bytes and output limits are captured because downstream tests
/// assert those request properties directly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecCall {
    /// Command string passed to `ExecRequest.cmd`.
    pub cmd: String,
    /// Timeout passed to `ExecRequest.timeout`.
    pub timeout: Duration,
    /// Environment variable names from `ExecRequest.env`.
    ///
    /// Environment values are not recorded in this field.
    pub env_keys: Vec<String>,
    /// Whether the exec request was made with sudo privileges.
    pub sudo: bool,
    /// Stdin bytes supplied to the exec request, when present.
    pub stdin_bytes: Option<Vec<u8>>,
    /// Output limits supplied to the exec request.
    pub output_limits: ExecOutputLimits,
}

/// Captured `start_process` request fields recorded for test assertions.
///
/// Unlike [`ExecCall`], this record captures environment values as well as
/// names because tests use it to assert guest-agent bootstrap environment
/// construction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartProcessCall {
    /// Command string passed to `StartProcessRequest.cmd`.
    pub cmd: String,
    /// Timeout passed to `StartProcessRequest.timeout`.
    pub timeout: Duration,
    /// Environment variable names and values from `StartProcessRequest.env`.
    pub env: Vec<(String, String)>,
    /// Whether the process request was made with sudo privileges.
    pub sudo: bool,
    /// Output mode requested for the guest process.
    pub output: ProcessOutputMode,
    /// Control mode requested for the guest process.
    pub control: ProcessControlMode,
}

/// Captured `wait_process` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WaitProcessCall {
    /// Timeout passed to `Sandbox::wait_process`.
    pub timeout: Duration,
}

/// Captured process-cancel request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCancelCall {
    /// Timeout supplied to the process cancel handle.
    pub timeout: Duration,
}

/// Captured process-control request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessControlCall {
    /// Message id supplied to the process-control handle.
    pub message_id: String,
    /// Payload bytes supplied to the process-control handle.
    pub payload: Vec<u8>,
    /// Timeout supplied to the process-control handle.
    pub timeout: Duration,
}

/// Captured `write_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteFileCall {
    /// Guest path passed to `write_file`.
    pub path: String,
    /// Content bytes passed to `write_file`.
    pub content: Vec<u8>,
}

/// Captured `write_files` batch request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteFilesCall {
    /// Guest files passed to `write_files`.
    pub files: Vec<WriteFileCall>,
}

/// Captured `read_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadFileCall {
    /// Guest path passed to `read_file`.
    pub path: String,
    /// Maximum byte count passed to `read_file`.
    pub max_bytes: u64,
}

/// Captured `copy_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopyFileCall {
    /// Guest path requested as the copy source.
    pub path: String,
    /// Host path requested as the copy destination.
    pub host_path: PathBuf,
    /// Maximum byte count requested for the copy.
    pub max_bytes: u64,
    /// Timeout requested for the copy operation.
    pub timeout: Duration,
    /// Whether a backend-reported missing or non-regular guest source should
    /// succeed without writing the host destination.
    pub missing_ok: bool,
}
