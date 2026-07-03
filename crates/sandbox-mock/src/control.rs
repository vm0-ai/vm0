use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use ::sandbox::*;
use async_trait::async_trait;

use crate::support::LockIgnoringPoison;

/// A mock [`SandboxControl`] for testing exec/kill commands.
///
/// Queue custom results with [`push_exec_remote_result`](Self::push_exec_remote_result)
/// or [`push_kill_remote_result`](Self::push_kill_remote_result).
/// When queues are empty, exec returns ordinary exit code 0 and kill returns accepted.
pub struct MockSandboxControl {
    base_dir: PathBuf,
    exec_results: Mutex<VecDeque<std::result::Result<RemoteExecResult, SandboxControlError>>>,
    kill_results: Mutex<VecDeque<std::result::Result<RemoteKillResult, SandboxControlError>>>,
    recorded_commands: Mutex<Vec<String>>,
    recorded_kill_ids: Mutex<Vec<String>>,
}

impl MockSandboxControl {
    /// Create a control mock that records remote exec commands and kill ids.
    ///
    /// The `base_dir` is used as the remote exec working directory. Result
    /// queues start empty, so remote exec succeeds with ordinary exit code 0
    /// and remote kill returns accepted by default.
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
            exec_results: Mutex::new(VecDeque::new()),
            kill_results: Mutex::new(VecDeque::new()),
            recorded_commands: Mutex::new(Vec::new()),
            recorded_kill_ids: Mutex::new(Vec::new()),
        }
    }

    /// Queue an exec remote result. Results are consumed in FIFO order.
    pub fn push_exec_remote_result(
        &self,
        result: std::result::Result<RemoteExecResult, SandboxControlError>,
    ) {
        self.exec_results.lock_ignoring_poison().push_back(result);
    }

    /// Return every command string passed to `exec_remote`, in call order.
    pub fn recorded_commands(&self) -> Vec<String> {
        self.recorded_commands.lock_ignoring_poison().clone()
    }

    /// Queue a kill remote result. Results are consumed in FIFO order.
    pub fn push_kill_remote_result(
        &self,
        result: std::result::Result<RemoteKillResult, SandboxControlError>,
    ) {
        self.kill_results.lock_ignoring_poison().push_back(result);
    }

    /// Return every sandbox id passed to `kill_remote`, in call order.
    pub fn recorded_kill_ids(&self) -> Vec<String> {
        self.recorded_kill_ids.lock_ignoring_poison().clone()
    }
}

#[async_trait]
impl SandboxControl for MockSandboxControl {
    async fn exec_remote(
        &self,
        _sandbox_id: &str,
        command: &str,
        _timeout: Duration,
        _sudo: bool,
    ) -> std::result::Result<RemoteExecResult, SandboxControlError> {
        self.recorded_commands
            .lock_ignoring_poison()
            .push(command.to_string());
        self.exec_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or_else(|| {
                Ok(RemoteExecResult {
                    termination: ExecTermination::Exited { exit_code: 0 },
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    diagnostic: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
    }

    async fn kill_remote(
        &self,
        sandbox_id: &str,
    ) -> std::result::Result<RemoteKillResult, SandboxControlError> {
        self.recorded_kill_ids
            .lock_ignoring_poison()
            .push(sandbox_id.to_string());
        self.kill_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(RemoteKillResult::Accepted))
    }

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        self.base_dir.join(sandbox_id)
    }
}
