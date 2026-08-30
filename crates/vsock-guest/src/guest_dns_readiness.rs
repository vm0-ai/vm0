use std::io;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use vsock_proto::{
    GUEST_DNS_READINESS_MAX_ANSWER_BYTES, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES,
    GuestDnsReadinessTermination, MSG_GUEST_DNS_READINESS_RESULT,
};

use crate::drain::{BoundedDrainResult, DrainCancellation, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::quiesce::OperationGuard;
use crate::user::apply_command_identity;
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};
use crate::worker_ownership::{
    ShutdownConnectionOnDrop, SingleActiveAdmission, SingleActivePermit,
};
use crate::writer::GuestWriter;

const PRODUCTION_PROGRAM: &str = "/usr/bin/getent";
const RESOLVER_DATABASE: &str = "ahostsv4";
const RESOLVER_OPTIONS: &str = "attempts:1 timeout:1";
const OUTPUT_DRAIN_DEADLINE: Duration = Duration::from_secs(1);
const THREAD_WORKER: &str = "vsock-guest-dns-readiness";
const THREAD_STDOUT: &str = "vsock-guest-dns-stdout";
const THREAD_STDERR: &str = "vsock-guest-dns-stderr";

#[derive(Clone)]
pub(crate) enum GuestDnsReadinessProgram {
    Production,
    Test(PathBuf),
}

impl GuestDnsReadinessProgram {
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

pub(crate) enum GuestDnsReadinessSubmitError {
    Busy,
    Disconnected,
    Start(io::Error),
}

struct GuestDnsReadinessRequest {
    seq: u32,
    timeout_ms: u32,
    hostname: String,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

pub(crate) struct GuestDnsReadinessWorker {
    state: Mutex<GuestDnsReadinessWorkerState>,
    writer: GuestWriter,
    program: GuestDnsReadinessProgram,
    admission: SingleActiveAdmission,
    connection_cancel: Arc<AtomicBool>,
}

struct GuestDnsReadinessWorkerState {
    sender: Option<SyncSender<GuestDnsReadinessRequest>>,
    handle: Option<JoinHandle<()>>,
}

impl GuestDnsReadinessWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: GuestDnsReadinessProgram,
    ) -> Self {
        Self {
            state: Mutex::new(GuestDnsReadinessWorkerState {
                sender: None,
                handle: None,
            }),
            writer,
            program,
            admission: SingleActiveAdmission::new(),
            connection_cancel,
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.admission.try_acquire()
    }

    pub(crate) fn submit(
        &self,
        seq: u32,
        timeout_ms: u32,
        hostname: &str,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), GuestDnsReadinessSubmitError> {
        let sender = self.sender()?;
        let request = GuestDnsReadinessRequest {
            seq,
            timeout_ms,
            hostname: hostname.to_owned(),
            operation_guard,
            admission,
        };
        match sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(GuestDnsReadinessSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => Err(GuestDnsReadinessSubmitError::Disconnected),
        }
    }

    fn sender(&self) -> Result<SyncSender<GuestDnsReadinessRequest>, GuestDnsReadinessSubmitError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(sender) = &state.sender {
            return Ok(sender.clone());
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        let writer = self.writer.clone();
        let worker_cancel = Arc::clone(&self.connection_cancel);
        let program = self.program.clone();
        let handle = thread::Builder::new()
            .name(THREAD_WORKER.to_string())
            .spawn(move || {
                let _shutdown_on_exit = ShutdownConnectionOnDrop::new(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) = handle_request(request, &writer, &worker_cancel, &program) {
                        log(
                            "ERROR",
                            &format!("guest DNS readiness worker failed: {error}"),
                        );
                        break;
                    }
                }
            })
            .map_err(GuestDnsReadinessSubmitError::Start)?;
        state.sender = Some(sender.clone());
        state.handle = Some(handle);
        Ok(sender)
    }
}

impl Drop for GuestDnsReadinessWorker {
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
            log("ERROR", "guest DNS readiness worker panicked");
        }
    }
}

struct GuestDnsReadinessOutput {
    termination: GuestDnsReadinessTermination,
    duration_ms: u32,
    answer: Vec<u8>,
    output_truncated: bool,
    diagnostic: String,
}

fn handle_request(
    request: GuestDnsReadinessRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &GuestDnsReadinessProgram,
) -> io::Result<()> {
    let GuestDnsReadinessRequest {
        seq,
        timeout_ms,
        hostname,
        operation_guard,
        admission,
    } = request;
    let output = run_probe(program.path(), timeout_ms, &hostname, connection_cancel);
    let payload = vsock_proto::encode_guest_dns_readiness_result(
        output.termination,
        output.duration_ms,
        &output.answer,
        output.output_truncated,
        &output.diagnostic,
    )
    .map_err(to_io_error)?;
    let frame =
        vsock_proto::encode(MSG_GUEST_DNS_READINESS_RESULT, seq, &payload).map_err(to_io_error)?;

    writer
        .write_frame_after_lock_unless_cancelled(&frame, connection_cancel, || {
            operation_guard.release();
            drop(admission);
        })
        .map(|_| ())
}

fn run_probe(
    program: &Path,
    timeout_ms: u32,
    hostname: &str,
    connection_cancel: &AtomicBool,
) -> GuestDnsReadinessOutput {
    let started = Instant::now();
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            return failed_output(
                GuestDnsReadinessTermination::StartFailed,
                started,
                format!("failed to initialize guest DNS output drain cancellation: {error}"),
            );
        }
    };
    let mut command = Command::new(program);
    command
        .arg(RESOLVER_DATABASE)
        .arg(hostname)
        .env("RES_OPTIONS", RESOLVER_OPTIONS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Err(error) = apply_command_identity(&mut command, false) {
        return failed_output(
            GuestDnsReadinessTermination::StartFailed,
            started,
            format!("failed to select sandbox user: {error}"),
        );
    }
    let mut child = match spawn_in_own_process_group(&mut command) {
        Ok(child) => child,
        Err(error) => {
            return failed_output(
                GuestDnsReadinessTermination::StartFailed,
                started,
                format!("failed to start guest DNS readiness process: {error}"),
            );
        }
    };
    let Some(stdout) = child.stdout.take() else {
        kill_and_reap_child(child);
        return failed_output(
            GuestDnsReadinessTermination::WaitFailed,
            started,
            "guest DNS readiness stdout pipe missing".to_string(),
        );
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdout);
        kill_and_reap_child(child);
        return failed_output(
            GuestDnsReadinessTermination::WaitFailed,
            started,
            "guest DNS readiness stderr pipe missing".to_string(),
        );
    };

    let (drain_done_tx, drain_done_rx) = mpsc::channel();
    let stdout_drain = match spawn_drain(
        stdout.into(),
        GUEST_DNS_READINESS_MAX_ANSWER_BYTES,
        Arc::clone(&drain_cancel),
        drain_done_tx.clone(),
        THREAD_STDOUT,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drop(stderr);
            kill_and_reap_child(child);
            return failed_output(
                GuestDnsReadinessTermination::WaitFailed,
                started,
                format!("failed to start guest DNS stdout drain: {error}"),
            );
        }
    };
    let stderr_drain = match spawn_drain(
        stderr.into(),
        GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES,
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
                GuestDnsReadinessTermination::WaitFailed,
                started,
                format!("failed to start guest DNS stderr drain: {error}"),
            );
        }
    };
    drop(drain_done_tx);

    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        timeout_ms,
        connection_cancel,
        // Reap the group before the exited leader can release its process-group
        // identity, so an NSS helper cannot outlive the readiness operation.
        || true,
    );
    if !matches!(outcome, WaitOutcome::Exited(_)) {
        drain_cancel.cancel();
    }
    let completed = await_drain_deadline(&drain_done_rx, 2, &drain_cancel, OUTPUT_DRAIN_DEADLINE);
    let stdout_result = stdout_drain.join();
    let stderr_result = stderr_drain.join();
    let drains_incomplete = completed < 2 || stdout_result.is_err() || stderr_result.is_err();
    let stdout_result = stdout_result.unwrap_or_default();
    let stderr_result = stderr_result.unwrap_or_default();

    let (termination, wait_diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            GuestDnsReadinessTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            None,
        ),
        WaitOutcome::TimedOut => (GuestDnsReadinessTermination::TimedOut, None),
        WaitOutcome::Cancelled => (GuestDnsReadinessTermination::Cancelled, None),
        WaitOutcome::WaitFailed(message) => (
            GuestDnsReadinessTermination::WaitFailed,
            Some(format!(
                "failed to wait for guest DNS readiness process: {message}"
            )),
        ),
    };
    let answer = stdout_result.captured.unwrap_or_default();
    let diagnostic = wait_diagnostic.unwrap_or_else(|| {
        String::from_utf8_lossy(&stderr_result.captured.unwrap_or_default()).into_owned()
    });
    GuestDnsReadinessOutput {
        termination,
        duration_ms: elapsed_ms(started),
        answer,
        output_truncated: drains_incomplete
            || stdout_result.capture_truncated
            || stderr_result.capture_truncated,
        diagnostic: truncate_utf8(diagnostic, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES),
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
    pipe: OwnedFd,
    limit: usize,
    cancel: Arc<DrainCancellation>,
    done_tx: mpsc::Sender<()>,
    thread_name: &'static str,
) -> io::Result<DrainHandle> {
    let (result_tx, result_rx) = mpsc::channel();
    let handle = thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let result = drain_bounded_cancellable(pipe, &cancel, Some(limit), None, |_, _| true);
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        })?;
    Ok(DrainHandle { handle, result_rx })
}

fn failed_output(
    termination: GuestDnsReadinessTermination,
    started: Instant,
    diagnostic: String,
) -> GuestDnsReadinessOutput {
    GuestDnsReadinessOutput {
        termination,
        duration_ms: elapsed_ms(started),
        answer: Vec::new(),
        output_truncated: false,
        diagnostic: truncate_utf8(diagnostic, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES),
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
