use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use guest_contracts::workspace_mount::{WORKSPACE_DRIVE_MOUNT_TIMEOUT_MS, WORKSPACE_MOUNT_SCRIPT};
use vsock_proto::{ExecCapturedOutput, ExecTermination, WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES};

use crate::drain::{BoundedDrainResult, DrainCancellation, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::quiesce::OperationGuard;
use crate::shell_command::{EnvScriptGuard, PreparedShellCommand, build_shell_command_with_env};
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};
use crate::worker_ownership::{
    ShutdownConnectionOnDrop, SingleActiveAdmission, SingleActivePermit,
};
use crate::writer::GuestWriter;

const WORKSPACE_DIR: &str = "/home/user/workspace";
const WORKSPACE_DEVICE: &str = "/dev/vdb";
const WORKSPACE_MOUNTINFO_PATH: &str = "/proc/self/mountinfo";
const THREAD_WORKER: &str = "vsock-workspace-drive-mount";
const THREAD_STDOUT: &str = "vsock-workspace-mount-stdout";
const THREAD_STDERR: &str = "vsock-workspace-mount-stderr";
const MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;

#[derive(Clone)]
pub(crate) enum WorkspaceDriveMountProgram {
    Production,
    Test { path: PathBuf, timeout_ms: u32 },
}

impl WorkspaceDriveMountProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf, timeout_ms: u32) -> Self {
        Self::Test { path, timeout_ms }
    }

    fn timeout_ms(&self) -> u32 {
        match self {
            Self::Production => WORKSPACE_DRIVE_MOUNT_TIMEOUT_MS,
            Self::Test { timeout_ms, .. } => *timeout_ms,
        }
    }

    fn spawn(&self) -> io::Result<SpawnedWorkspaceMountCommand> {
        let command = workspace_mount_command();
        // This empty typed operation fixes every execution choice. An owned
        // process group keeps timeout, disconnect, and pre-reap descendant
        // cleanup without creating a generic workload cgroup for each mount.
        let (mut command, env_script) = match self {
            Self::Production => {
                let PreparedShellCommand {
                    command,
                    env_script,
                } = build_shell_command_with_env(&command, &[], true)?;
                (command, env_script)
            }
            Self::Test { path, .. } => {
                let mut program = Command::new(path);
                program.arg("-c").arg(command);
                (program, None)
            }
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::user::apply_command_identity(&mut command, true)?;
        let child = spawn_in_own_process_group(&mut command)?;
        Ok(SpawnedWorkspaceMountCommand { child, env_script })
    }
}

struct SpawnedWorkspaceMountCommand {
    child: Child,
    env_script: Option<EnvScriptGuard>,
}

pub(crate) enum WorkspaceDriveMountSubmitError {
    Busy,
    Disconnected,
    Start(io::Error),
}

struct WorkspaceDriveMountRequest {
    seq: u32,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

pub(crate) struct WorkspaceDriveMountWorker {
    state: Mutex<WorkspaceDriveMountWorkerState>,
    writer: GuestWriter,
    program: WorkspaceDriveMountProgram,
    admission: SingleActiveAdmission,
    connection_cancel: Arc<AtomicBool>,
    drain_deadline: Duration,
}

struct WorkspaceDriveMountWorkerState {
    sender: Option<SyncSender<WorkspaceDriveMountRequest>>,
    handle: Option<JoinHandle<()>>,
}

impl WorkspaceDriveMountWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: WorkspaceDriveMountProgram,
        drain_deadline: Duration,
    ) -> Self {
        Self {
            state: Mutex::new(WorkspaceDriveMountWorkerState {
                sender: None,
                handle: None,
            }),
            writer,
            program,
            admission: SingleActiveAdmission::new(),
            connection_cancel,
            drain_deadline,
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.admission.try_acquire()
    }

    pub(crate) fn submit(
        &self,
        seq: u32,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), WorkspaceDriveMountSubmitError> {
        let sender = self.sender()?;
        let request = WorkspaceDriveMountRequest {
            seq,
            operation_guard,
            admission,
        };
        match sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(WorkspaceDriveMountSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => Err(WorkspaceDriveMountSubmitError::Disconnected),
        }
    }

    fn sender(
        &self,
    ) -> Result<SyncSender<WorkspaceDriveMountRequest>, WorkspaceDriveMountSubmitError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(sender) = &state.sender {
            return Ok(sender.clone());
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        let writer = self.writer.clone();
        let worker_cancel = Arc::clone(&self.connection_cancel);
        let program = self.program.clone();
        let drain_deadline = self.drain_deadline;
        let handle = thread::Builder::new()
            .name(THREAD_WORKER.to_string())
            .spawn(move || {
                let _shutdown_on_exit = ShutdownConnectionOnDrop::new(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) =
                        handle_request(request, &writer, &worker_cancel, &program, drain_deadline)
                    {
                        log(
                            "ERROR",
                            &format!("workspace drive mount worker failed: {error}"),
                        );
                        break;
                    }
                }
            })
            .map_err(WorkspaceDriveMountSubmitError::Start)?;
        state.sender = Some(sender.clone());
        state.handle = Some(handle);
        Ok(sender)
    }
}

impl Drop for WorkspaceDriveMountWorker {
    fn drop(&mut self) {
        self.connection_cancel.store(true, Ordering::Release);
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        drop(state.sender.take());
        if let Some(handle) = state.handle.take()
            && handle.join().is_err()
        {
            log("ERROR", "workspace drive mount worker panicked");
        }
    }
}

struct WorkspaceDriveMountOutput {
    termination: ExecTermination,
    duration_ms: u32,
    stdout: BoundedDrainResult,
    stderr: BoundedDrainResult,
    diagnostic: String,
}

fn handle_request(
    request: WorkspaceDriveMountRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &WorkspaceDriveMountProgram,
    drain_deadline: Duration,
) -> io::Result<()> {
    let WorkspaceDriveMountRequest {
        seq,
        operation_guard,
        admission,
    } = request;
    let output = run_mount(RunMountInput {
        program,
        connection_cancel,
        drain_deadline,
    });
    let mut frame = Vec::new();
    vsock_proto::encode_workspace_drive_mount_result_frame_into(
        &mut frame,
        seq,
        output.termination,
        output.duration_ms,
        captured_output(&output.stdout),
        captured_output(&output.stderr),
        &output.diagnostic,
    )
    .map_err(to_io_error)?;

    writer
        .write_frame_after_lock_unless_cancelled(&frame, connection_cancel, || {
            operation_guard.release();
            drop(admission);
        })
        .map(|_| ())
}

struct RunMountInput<'a> {
    program: &'a WorkspaceDriveMountProgram,
    connection_cancel: &'a AtomicBool,
    drain_deadline: Duration,
}

fn run_mount(input: RunMountInput<'_>) -> WorkspaceDriveMountOutput {
    let RunMountInput {
        program,
        connection_cancel,
        drain_deadline,
    } = input;
    let started = Instant::now();
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to initialize workspace mount output drain cancellation: {error}"),
            );
        }
    };
    let SpawnedWorkspaceMountCommand {
        mut child,
        env_script,
    } = match program.spawn() {
        Ok(spawned) => spawned,
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to start workspace mount helper: {error}"),
            );
        }
    };
    let _env_script = env_script;
    let Some(stdout) = child.stdout.take() else {
        return abort_spawned(child, started, "workspace mount helper stdout pipe missing");
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdout);
        return abort_spawned(child, started, "workspace mount helper stderr pipe missing");
    };

    let (drain_done_tx, drain_done_rx) = mpsc::channel();
    let stdout_drain = match spawn_drain(
        stdout,
        Arc::clone(&drain_cancel),
        drain_done_tx.clone(),
        THREAD_STDOUT,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drop(stderr);
            kill_and_reap_child(child);
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                format!("Failed to start workspace mount stdout drain: {error}"),
            );
        }
    };
    let stderr_drain = match spawn_drain(
        stderr,
        Arc::clone(&drain_cancel),
        drain_done_tx.clone(),
        THREAD_STDERR,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drain_cancel.cancel();
            kill_and_reap_child(child);
            drop(drain_done_tx);
            let _ = stdout_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                format!("Failed to start workspace mount stderr drain: {error}"),
            );
        }
    };
    drop(drain_done_tx);

    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        program.timeout_ms(),
        connection_cancel,
        || true,
    );
    let cancellation_observed = connection_cancel.load(Ordering::Acquire);
    if !matches!(outcome, WaitOutcome::Exited(_)) || cancellation_observed {
        drain_cancel.cancel();
    }
    let completed = await_drain_deadline(&drain_done_rx, 2, &drain_cancel, drain_deadline);
    let stdout_result = stdout_drain.join();
    let stderr_result = stderr_drain.join();
    let drains_incomplete = completed < 2 || stdout_result.is_err() || stderr_result.is_err();
    let mut stdout = stdout_result.unwrap_or_default();
    let mut stderr = stderr_result.unwrap_or_default();
    if drains_incomplete {
        stdout.capture_truncated = true;
        stderr.capture_truncated = true;
    }
    if stdout.captured.is_none() {
        stdout.captured = Some(Vec::new());
    }
    if stderr.captured.is_none() {
        stderr.captured = Some(Vec::new());
    }

    let (termination, diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            ExecTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            String::new(),
        ),
        WaitOutcome::TimedOut => (ExecTermination::TimedOut, String::new()),
        WaitOutcome::Cancelled => (ExecTermination::Cancelled, String::new()),
        WaitOutcome::WaitFailed(message) => (
            ExecTermination::WaitFailed,
            format!("Failed to wait for workspace mount helper: {message}"),
        ),
    };
    WorkspaceDriveMountOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stdout,
        stderr,
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn workspace_mount_command() -> String {
    format!(
        "workspace_dir='{WORKSPACE_DIR}'\nworkspace_device='{WORKSPACE_DEVICE}'\nworkspace_mountinfo_path='{WORKSPACE_MOUNTINFO_PATH}'\n{WORKSPACE_MOUNT_SCRIPT}"
    )
}

fn abort_spawned(child: Child, started: Instant, diagnostic: &str) -> WorkspaceDriveMountOutput {
    kill_and_reap_child(child);
    failed_output(ExecTermination::WaitFailed, started, diagnostic.to_string())
}

struct DrainHandle {
    handle: JoinHandle<()>,
    result_rx: mpsc::Receiver<BoundedDrainResult>,
}

impl DrainHandle {
    fn join(self) -> Result<BoundedDrainResult, ()> {
        if self.handle.join().is_err() {
            return Err(());
        }
        self.result_rx.recv().map_err(|_| ())
    }
}

fn spawn_drain(
    pipe: impl Into<std::os::fd::OwnedFd> + Send + 'static,
    cancel: Arc<DrainCancellation>,
    done_tx: mpsc::Sender<()>,
    thread_name: &'static str,
) -> io::Result<DrainHandle> {
    let (result_tx, result_rx) = mpsc::channel();
    let handle = thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let result = drain_bounded_cancellable(
                pipe,
                &cancel,
                Some(WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES),
                None,
                |_, _| true,
            );
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        })?;
    Ok(DrainHandle { handle, result_rx })
}

fn failed_output(
    termination: ExecTermination,
    started: Instant,
    diagnostic: String,
) -> WorkspaceDriveMountOutput {
    WorkspaceDriveMountOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stdout: BoundedDrainResult {
            captured: Some(Vec::new()),
            capture_truncated: false,
            stream_truncated: false,
        },
        stderr: BoundedDrainResult {
            captured: Some(Vec::new()),
            capture_truncated: false,
            stream_truncated: false,
        },
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn captured_output(result: &BoundedDrainResult) -> ExecCapturedOutput<'_> {
    ExecCapturedOutput::Captured {
        bytes: result.captured.as_deref().unwrap_or_default(),
        truncated: result.capture_truncated,
    }
}

fn elapsed_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn truncate_utf8(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}
