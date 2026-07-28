use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use ::sandbox::*;
use async_trait::async_trait;

use crate::call_records::RemoteExecCall;
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
    recorded_exec_calls: Mutex<Vec<RemoteExecCall>>,
    recorded_kill_ids: Mutex<Vec<String>>,
}

impl MockSandboxControl {
    /// Create a control mock that records remote exec calls and kill ids.
    ///
    /// The `base_dir` is the root used by [`SandboxControl::runtime_dir`] to
    /// resolve each sandbox's runtime socket directory for orphan cleanup.
    /// Remote exec records its inputs and returns a queued result, or ordinary
    /// exit code 0 by default; it does not execute the command or derive a
    /// working directory from `base_dir`. Remote kill likewise returns its next
    /// queued result, or [`RemoteKillResult::Accepted`] if its queue is empty.
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
            exec_results: Mutex::new(VecDeque::new()),
            kill_results: Mutex::new(VecDeque::new()),
            recorded_exec_calls: Mutex::new(Vec::new()),
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

    /// Return every call made to `exec_remote`, in call order.
    pub fn recorded_exec_calls(&self) -> Vec<RemoteExecCall> {
        self.recorded_exec_calls.lock_ignoring_poison().clone()
    }

    /// Return every command string passed to `exec_remote`, in call order.
    pub fn recorded_commands(&self) -> Vec<String> {
        self.recorded_exec_calls
            .lock_ignoring_poison()
            .iter()
            .map(|call| call.command.clone())
            .collect()
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
        sandbox_id: &str,
        command: &str,
        timeout: Duration,
        sudo: bool,
    ) -> std::result::Result<RemoteExecResult, SandboxControlError> {
        self.recorded_exec_calls
            .lock_ignoring_poison()
            .push(RemoteExecCall {
                sandbox_id: sandbox_id.to_string(),
                command: command.to_string(),
                timeout,
                sudo,
            });
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
