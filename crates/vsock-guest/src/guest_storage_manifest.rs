use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use vsock_proto::{ExecCapturedOutput, ExecTermination, GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES};

use crate::drain::{BoundedDrainResult, DrainCancellation, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::process_containment::{
    ExecProcessContainment, ProcessContainmentCleanupMode, ProcessContainmentError,
    ProcessContainmentMode,
};
use crate::quiesce::OperationGuard;
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};
use crate::worker_ownership::{
    ShutdownConnectionOnDrop, SingleActiveAdmission, SingleActivePermit,
};
use crate::writer::GuestWriter;

const PRODUCTION_PROGRAM: &str = "/usr/local/bin/guest-download";
const THREAD_WORKER: &str = "vsock-guest-storage-manifest";
const THREAD_STDIN: &str = "vsock-guest-storage-stdin";
const THREAD_STDOUT: &str = "vsock-guest-storage-stdout";
const THREAD_STDERR: &str = "vsock-guest-storage-stderr";
const MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;

#[derive(Clone)]
pub(crate) enum GuestStorageManifestProgram {
    Production,
    Test(PathBuf),
}

impl GuestStorageManifestProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(path)
    }

    fn path(&self) -> &Path {
        match self {
            Self::Production => Path::new(PRODUCTION_PROGRAM),
            Self::Test(path) => path,
        }
    }
}

pub(crate) enum GuestStorageManifestSubmitError {
    Busy,
    Disconnected,
    Start(io::Error),
}

struct GuestStorageManifestRequest {
    seq: u32,
    timeout_ms: u32,
    run_id: String,
    runtime_dir: String,
    manifest_json: Vec<u8>,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

pub(crate) struct GuestStorageManifestWorker {
    state: Mutex<GuestStorageManifestWorkerState>,
    writer: GuestWriter,
    program: GuestStorageManifestProgram,
    admission: SingleActiveAdmission,
    connection_cancel: Arc<AtomicBool>,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
}

struct GuestStorageManifestWorkerState {
    sender: Option<SyncSender<GuestStorageManifestRequest>>,
    handle: Option<JoinHandle<()>>,
}

impl GuestStorageManifestWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: GuestStorageManifestProgram,
        process_containment_mode: ProcessContainmentMode,
        drain_deadline: Duration,
    ) -> Self {
        Self {
            state: Mutex::new(GuestStorageManifestWorkerState {
                sender: None,
                handle: None,
            }),
            writer,
            program,
            admission: SingleActiveAdmission::new(),
            connection_cancel,
            process_containment_mode,
            drain_deadline,
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.admission.try_acquire()
    }

    pub(crate) fn submit(
        &self,
        submission: GuestStorageManifestSubmission<'_>,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), GuestStorageManifestSubmitError> {
        let sender = self.sender()?;
        let request = GuestStorageManifestRequest {
            seq: submission.seq,
            timeout_ms: submission.timeout_ms,
            run_id: submission.run_id.to_owned(),
            runtime_dir: submission.runtime_dir.to_owned(),
            manifest_json: submission.manifest_json.to_vec(),
            operation_guard,
            admission,
        };
        match sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(GuestStorageManifestSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => {
                Err(GuestStorageManifestSubmitError::Disconnected)
            }
        }
    }

    fn sender(
        &self,
    ) -> Result<SyncSender<GuestStorageManifestRequest>, GuestStorageManifestSubmitError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(sender) = &state.sender {
            return Ok(sender.clone());
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        let writer = self.writer.clone();
        let worker_cancel = Arc::clone(&self.connection_cancel);
        let program = self.program.clone();
        let process_containment_mode = self.process_containment_mode;
        let drain_deadline = self.drain_deadline;
        let handle = thread::Builder::new()
            .name(THREAD_WORKER.to_string())
            .spawn(move || {
                let _shutdown_on_exit = ShutdownConnectionOnDrop::new(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) = handle_request(
                        request,
                        &writer,
                        &worker_cancel,
                        &program,
                        process_containment_mode,
                        drain_deadline,
                    ) {
                        log(
                            "ERROR",
                            &format!("guest storage manifest worker failed: {error}"),
                        );
                        break;
                    }
                }
            })
            .map_err(GuestStorageManifestSubmitError::Start)?;
        state.sender = Some(sender.clone());
        state.handle = Some(handle);
        Ok(sender)
    }
}

pub(crate) struct GuestStorageManifestSubmission<'a> {
    pub(crate) seq: u32,
    pub(crate) timeout_ms: u32,
    pub(crate) run_id: &'a str,
    pub(crate) runtime_dir: &'a str,
    pub(crate) manifest_json: &'a [u8],
}

impl Drop for GuestStorageManifestWorker {
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
            log("ERROR", "guest storage manifest worker panicked");
        }
    }
}

struct GuestStorageManifestOutput {
    termination: ExecTermination,
    duration_ms: u32,
    stdout: BoundedDrainResult,
    stderr: BoundedDrainResult,
    diagnostic: String,
}

fn handle_request(
    request: GuestStorageManifestRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &GuestStorageManifestProgram,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
) -> io::Result<()> {
    let GuestStorageManifestRequest {
        seq,
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
        operation_guard,
        admission,
    } = request;
    let output = run_manifest(RunManifestInput {
        seq,
        program: program.path(),
        timeout_ms,
        run_id: &run_id,
        runtime_dir: &runtime_dir,
        manifest_json,
        connection_cancel,
        process_containment_mode,
        drain_deadline,
    });
    let stdout = captured_output(&output.stdout);
    let stderr = captured_output(&output.stderr);
    let mut frame = Vec::new();
    vsock_proto::encode_guest_storage_manifest_result_frame_into(
        &mut frame,
        seq,
        output.termination,
        output.duration_ms,
        stdout,
        stderr,
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

struct RunManifestInput<'a> {
    seq: u32,
    program: &'a Path,
    timeout_ms: u32,
    run_id: &'a str,
    runtime_dir: &'a str,
    manifest_json: Vec<u8>,
    connection_cancel: &'a AtomicBool,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
}

fn run_manifest(input: RunManifestInput<'_>) -> GuestStorageManifestOutput {
    let RunManifestInput {
        seq,
        program,
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
        connection_cancel,
        process_containment_mode,
        drain_deadline,
    } = input;
    let started = Instant::now();
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to initialize storage output drain cancellation: {error}"),
            );
        }
    };
    let process_containment = match ExecProcessContainment::create(
        seq,
        process_containment_mode,
        vsock_proto::ExecProcessRole::Workload,
    ) {
        Ok(process_containment) => process_containment,
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to initialize storage helper process containment: {error}"),
            );
        }
    };
    let mut prepared_containment = match process_containment.prepare_command() {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to prepare storage helper process containment: {error}"),
            );
        }
    };
    let mut command = Command::new(program);
    command
        .arg("--manifest-stdin")
        .env(guest_contracts::env::RUN_ID_ENV, run_id)
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            runtime_dir,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepared_containment.configure_placement(&mut command);
    if let Err(error) = crate::user::apply_command_identity(&mut command, false) {
        let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
        return failed_output(
            ExecTermination::StartFailed,
            started,
            format!("Failed to select sandbox user for storage helper: {error}"),
        );
    }
    prepared_containment.configure_process_inspection(&mut command);
    let mut child = match spawn_in_own_process_group(&mut command) {
        Ok(child) => child,
        Err(error) => {
            let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to start storage helper: {error}"),
            );
        }
    };

    let Some(stdin) = child.stdin.take() else {
        return abort_spawned(
            child,
            process_containment,
            started,
            "storage helper stdin pipe missing",
        );
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        return abort_spawned(
            child,
            process_containment,
            started,
            "storage helper stdout pipe missing",
        );
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdin);
        drop(stdout);
        return abort_spawned(
            child,
            process_containment,
            started,
            "storage helper stderr pipe missing",
        );
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
            drop(stdin);
            drop(stderr);
            kill_and_reap_child(child);
            let cleanup = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                append_cleanup_failure(
                    format!("Failed to start storage helper stdout drain: {error}"),
                    cleanup.err().as_ref(),
                ),
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
            drop(stdin);
            kill_and_reap_child(child);
            let cleanup = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
            drop(drain_done_tx);
            let _ = stdout_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                append_cleanup_failure(
                    format!("Failed to start storage helper stderr drain: {error}"),
                    cleanup.err().as_ref(),
                ),
            );
        }
    };
    let stdin_writer = match spawn_stdin(stdin, manifest_json) {
        Ok(writer) => writer,
        Err(error) => {
            drain_cancel.cancel();
            kill_and_reap_child(child);
            let cleanup = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
            drop(drain_done_tx);
            let _ = stdout_drain.join();
            let _ = stderr_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                append_cleanup_failure(
                    format!("Failed to start storage helper stdin writer: {error}"),
                    cleanup.err().as_ref(),
                ),
            );
        }
    };
    drop(drain_done_tx);

    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        timeout_ms,
        connection_cancel,
        // Reap the group before the exited leader can release its process-group
        // identity, so helper descendants cannot outlive this fixed operation.
        || true,
    );
    let cancellation_observed = connection_cancel.load(Ordering::Acquire);
    let cleanup_mode = cleanup_mode_for_wait_outcome(&outcome, cancellation_observed);
    let containment_result = process_containment.cleanup(cleanup_mode);
    let stdin_result = stdin_writer.join();
    if !matches!(outcome, WaitOutcome::Exited(_))
        || cancellation_observed
        || containment_result.is_err()
    {
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

    let (mut termination, mut diagnostic) = match outcome {
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
            format!("Failed to wait for storage helper: {message}"),
        ),
    };
    if let Err(error) = stdin_result
        && matches!(termination, ExecTermination::Exited { .. })
    {
        log(
            "WARN",
            &format!("storage helper stdin writer finished with error: {error}"),
        );
    }
    if let Err(error) = containment_result {
        termination = ExecTermination::WaitFailed;
        diagnostic = append_cleanup_failure(diagnostic, Some(&error));
    }

    GuestStorageManifestOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stdout,
        stderr,
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn abort_spawned(
    child: Child,
    process_containment: ExecProcessContainment,
    started: Instant,
    diagnostic: &str,
) -> GuestStorageManifestOutput {
    kill_and_reap_child(child);
    let cleanup = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
    failed_output(
        ExecTermination::WaitFailed,
        started,
        append_cleanup_failure(diagnostic.to_string(), cleanup.err().as_ref()),
    )
}

fn cleanup_mode_for_wait_outcome(
    outcome: &WaitOutcome,
    cancellation_observed: bool,
) -> ProcessContainmentCleanupMode {
    if cancellation_observed {
        return ProcessContainmentCleanupMode::Forced;
    }
    match outcome {
        WaitOutcome::Exited(_) => ProcessContainmentCleanupMode::Graceful,
        WaitOutcome::TimedOut | WaitOutcome::Cancelled | WaitOutcome::WaitFailed(_) => {
            ProcessContainmentCleanupMode::Forced
        }
    }
}

fn append_cleanup_failure(diagnostic: String, error: Option<&ProcessContainmentError>) -> String {
    let Some(error) = error else {
        return diagnostic;
    };
    if diagnostic.is_empty() {
        format!("Failed to clean storage helper process containment: {error}")
    } else {
        format!("{diagnostic}; failed to clean storage helper process containment: {error}")
    }
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
                Some(GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES),
                None,
                |_, _| true,
            );
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        })?;
    Ok(DrainHandle { handle, result_rx })
}

struct StdinWriter {
    handle: JoinHandle<io::Result<()>>,
}

impl StdinWriter {
    fn join(self) -> io::Result<()> {
        self.handle
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }
}

fn spawn_stdin(mut stdin: ChildStdin, manifest_json: Vec<u8>) -> io::Result<StdinWriter> {
    let handle = thread::Builder::new()
        .name(THREAD_STDIN.to_string())
        .spawn(move || {
            let result = stdin.write_all(&manifest_json);
            drop(stdin);
            result
        })?;
    Ok(StdinWriter { handle })
}

fn failed_output(
    termination: ExecTermination,
    started: Instant,
    diagnostic: String,
) -> GuestStorageManifestOutput {
    GuestStorageManifestOutput {
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
