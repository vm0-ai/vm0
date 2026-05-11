use std::collections::HashSet;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::process::{Child, ChildStdin};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use vsock_proto::{
    self, BoundedExecStream, BoundedExecTermination, MSG_BOUNDED_EXEC_OUTPUT_CHUNK,
    MSG_BOUNDED_EXEC_RESULT,
};

use crate::drain::{BoundedDrainResult, BoundedStreamConfig, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::exec::{format_env_diagnostics, spawn_bounded_exec_command, truncate_preview};
use crate::log::log;
use crate::process::kill_and_reap_child;
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::wait::{
    DRAIN_DEADLINE_SECS, WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_cancelled_any,
};
use crate::writer::GuestWriter;

const THREAD_BOUNDED_EXEC_WORKER: &str = "vsock-bounded-exec-worker";
const THREAD_BOUNDED_STDOUT: &str = "vsock-bounded-stdout";
const THREAD_BOUNDED_STDERR: &str = "vsock-bounded-stderr";
const THREAD_BOUNDED_STDIN: &str = "vsock-bounded-stdin";
const STREAM_CHUNK_WRITE_DEADLINE: Duration = Duration::from_secs(2);
const STDIN_WRITE_POLL_TIMEOUT_MS: libc::c_int = 100;

pub(crate) type BoundedExecCleanup = Box<dyn FnOnce() + Send + 'static>;

pub(crate) struct BoundedExecWorkerRequest {
    pub(crate) seq: u32,
    pub(crate) timeout_ms: u32,
    pub(crate) command: String,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) sudo: bool,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) stdout: BoundedOutputRequest,
    pub(crate) stderr: BoundedOutputRequest,
}

#[derive(Clone, Copy)]
pub(crate) struct BoundedOutputRequest {
    pub(crate) capture: vsock_proto::BoundedExecCapturePolicy,
    pub(crate) stream: Option<BoundedStreamConfig>,
}

impl BoundedOutputRequest {
    fn from_proto(policy: vsock_proto::BoundedExecOutputPolicy) -> Self {
        Self {
            capture: policy.capture,
            stream: policy.stream.map(|stream| BoundedStreamConfig {
                chunk_limit_bytes: stream.chunk_limit_bytes as usize,
                stream_limit_bytes: stream.limit_bytes as usize,
            }),
        }
    }

    fn requires_pipe(self) -> bool {
        matches!(
            self.capture,
            vsock_proto::BoundedExecCapturePolicy::Capture { .. }
        ) || self.stream.is_some()
    }

    fn final_limit_bytes(self) -> Option<usize> {
        match self.capture {
            vsock_proto::BoundedExecCapturePolicy::Discard => None,
            vsock_proto::BoundedExecCapturePolicy::Capture { limit_bytes } => {
                Some(limit_bytes as usize)
            }
        }
    }
}

impl BoundedExecWorkerRequest {
    pub(crate) fn from_decoded(seq: u32, decoded: vsock_proto::DecodedBoundedExec<'_>) -> Self {
        Self {
            seq,
            timeout_ms: decoded.timeout_ms,
            command: decoded.command.to_owned(),
            env: decoded
                .env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            sudo: decoded.sudo,
            stdin: decoded.stdin.map(<[u8]>::to_vec),
            stdout: BoundedOutputRequest::from_proto(decoded.stdout),
            stderr: BoundedOutputRequest::from_proto(decoded.stderr),
        }
    }
}

struct BoundedDrainWorker {
    seq: u32,
    stream: BoundedExecStream,
    final_limit_bytes: Option<usize>,
    stream_config: Option<BoundedStreamConfig>,
    writer: GuestWriter,
    drain_cancel: Arc<AtomicBool>,
    command_cancel: Arc<AtomicBool>,
    drain_done_tx: mpsc::Sender<()>,
}

struct BoundedExecResultFrame<'a> {
    seq: u32,
    termination: BoundedExecTermination,
    duration_ms: u64,
    stdout: vsock_proto::BoundedExecOutput<'a>,
    stderr: vsock_proto::BoundedExecOutput<'a>,
    diagnostic: Option<&'a str>,
}

struct BoundedStdinWorker {
    handle: JoinHandle<()>,
    error_rx: mpsc::Receiver<String>,
    done_rx: mpsc::Receiver<()>,
    pipe_link: Option<String>,
}

struct BoundedExecCleanupGuard(Option<BoundedExecCleanup>);

impl BoundedExecCleanupGuard {
    fn new(cleanup: BoundedExecCleanup) -> Self {
        Self(Some(cleanup))
    }
}

impl Drop for BoundedExecCleanupGuard {
    fn drop(&mut self) {
        if let Some(cleanup) = self.0.take() {
            cleanup();
        }
    }
}

impl BoundedStdinWorker {
    fn is_pending(&self) -> bool {
        matches!(self.done_rx.try_recv(), Err(mpsc::TryRecvError::Empty))
    }

    fn finish(self) -> mpsc::Receiver<String> {
        let _ = self.handle.join();
        self.error_rx
    }
}

#[derive(Debug)]
enum GuestBoundedOutput {
    Discarded,
    Captured(BoundedDrainResult),
}

impl GuestBoundedOutput {
    fn empty_for_policy(policy: BoundedOutputRequest) -> Self {
        if policy.final_limit_bytes().is_some() {
            Self::Captured(BoundedDrainResult::default())
        } else {
            Self::Discarded
        }
    }

    fn as_proto(&self) -> vsock_proto::BoundedExecOutput<'_> {
        match self {
            Self::Discarded => vsock_proto::BoundedExecOutput::Discarded,
            Self::Captured(result) => vsock_proto::BoundedExecOutput::Captured {
                bytes: &result.output,
                truncated: result.truncated,
            },
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Discarded => 0,
            Self::Captured(result) => result.output.len(),
        }
    }

    fn truncated(&self) -> bool {
        match self {
            Self::Discarded => false,
            Self::Captured(result) => result.truncated,
        }
    }
}

pub(crate) fn spawn_bounded_exec_worker(
    request: BoundedExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    request_cancel: Arc<AtomicBool>,
    cleanup: BoundedExecCleanup,
) -> io::Result<()> {
    spawn_bounded_exec_worker_with_spawner(
        request,
        writer,
        connection_cancel,
        request_cancel,
        cleanup,
        SystemThreadSpawner,
    )
}

fn spawn_bounded_exec_worker_with_spawner<S>(
    request: BoundedExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    request_cancel: Arc<AtomicBool>,
    cleanup: BoundedExecCleanup,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let seq = request.seq;
    let stdout_policy = request.stdout;
    let stderr_policy = request.stderr;
    let worker_writer = writer.clone();
    let worker_spawner = spawner.clone();
    let cleanup_guard = BoundedExecCleanupGuard::new(cleanup);
    let result = spawner.spawn_unit(
        THREAD_BOUNDED_EXEC_WORKER,
        Box::new(move || {
            let _cleanup_guard = cleanup_guard;
            run_bounded_exec(
                request,
                worker_writer,
                connection_cancel,
                request_cancel,
                worker_spawner,
            );
        }),
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let diagnostic = format!("Failed to spawn bounded exec worker thread: {e}");
            let stdout = GuestBoundedOutput::empty_for_policy(stdout_policy);
            let stderr = GuestBoundedOutput::empty_for_policy(stderr_policy);
            send_bounded_exec_result(
                BoundedExecResultFrame {
                    seq,
                    termination: BoundedExecTermination::StartFailed,
                    duration_ms: 0,
                    stdout: stdout.as_proto(),
                    stderr: stderr.as_proto(),
                    diagnostic: Some(&diagnostic),
                },
                &writer,
            )
        }
    }
}

fn run_bounded_exec<S>(
    request: BoundedExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    request_cancel: Arc<AtomicBool>,
    spawner: S,
) where
    S: ThreadSpawner,
{
    log(
        "INFO",
        &format!(
            "bounded_exec: {} (timeout={}ms, sudo={}, stdin={}, stdout={}, stderr={}, {})",
            truncate_preview(&request.command),
            request.timeout_ms,
            request.sudo,
            request.stdin.as_ref().map_or(0, Vec::len),
            format_output_policy(request.stdout),
            format_output_policy(request.stderr),
            format_env_diagnostics(&request.command, &env_refs(&request.env)),
        ),
    );

    let started = Instant::now();
    if let Err(error) = validate_request(&request) {
        let stdout = GuestBoundedOutput::empty_for_policy(request.stdout);
        let stderr = GuestBoundedOutput::empty_for_policy(request.stderr);
        send_final_best_effort(
            request.seq,
            BoundedExecTermination::StartFailed,
            duration_ms(started),
            &stdout,
            &stderr,
            Some(&error),
            &writer,
        );
        return;
    }

    if cancellation_requested(&connection_cancel, &request_cancel) {
        send_cancelled_without_output(
            request.seq,
            started,
            request.stdout,
            request.stderr,
            &writer,
        );
        return;
    }

    let env_refs = env_refs(&request.env);
    let spawned = match spawn_bounded_exec_command(
        &request.command,
        &env_refs,
        request.sudo,
        request.stdin.is_some(),
        request.stdout.requires_pipe(),
        request.stderr.requires_pipe(),
    ) {
        Ok(spawned) => spawned,
        Err(e) => {
            let diagnostic = format!(
                "Failed to execute: {e} ({})",
                format_env_diagnostics(&request.command, &env_refs)
            );
            let stdout = GuestBoundedOutput::empty_for_policy(request.stdout);
            let stderr = GuestBoundedOutput::empty_for_policy(request.stderr);
            let _ = send_bounded_exec_result(
                BoundedExecResultFrame {
                    seq: request.seq,
                    termination: BoundedExecTermination::StartFailed,
                    duration_ms: duration_ms(started),
                    stdout: stdout.as_proto(),
                    stderr: stderr.as_proto(),
                    diagnostic: Some(&diagnostic),
                },
                &writer,
            );
            return;
        }
    };

    let crate::exec::SpawnedCommand {
        mut child,
        env_script,
    } = spawned;
    let _env_script = env_script;

    if cancellation_requested(&connection_cancel, &request_cancel) {
        kill_and_send_cancelled(
            request.seq,
            started,
            child,
            request.stdout,
            request.stderr,
            &writer,
        );
        return;
    }

    let stdout = if request.stdout.requires_pipe() {
        match child.stdout.take() {
            Some(stdout) => Some(stdout),
            None => {
                kill_and_send_wait_failed(
                    request.seq,
                    started,
                    child,
                    request.stdout,
                    request.stderr,
                    "missing stdout pipe",
                    &writer,
                );
                return;
            }
        }
    } else {
        None
    };
    let stderr = if request.stderr.requires_pipe() {
        match child.stderr.take() {
            Some(stderr) => Some(stderr),
            None => {
                kill_and_send_wait_failed(
                    request.seq,
                    started,
                    child,
                    request.stdout,
                    request.stderr,
                    "missing stderr pipe",
                    &writer,
                );
                return;
            }
        }
    } else {
        None
    };
    let stdin = if request.stdin.is_some() {
        match child.stdin.take() {
            Some(stdin) => Some(stdin),
            None => {
                kill_and_send_wait_failed(
                    request.seq,
                    started,
                    child,
                    request.stdout,
                    request.stderr,
                    "missing stdin pipe",
                    &writer,
                );
                return;
            }
        }
    } else {
        None
    };

    let drain_cancel = Arc::new(AtomicBool::new(false));
    let command_cancel = Arc::new(AtomicBool::new(false));
    let stdin_cancel = Arc::new(AtomicBool::new(false));
    let (drain_done_tx, drain_done_rx) = mpsc::channel::<()>();

    let stdout_worker = match stdout {
        Some(stdout) => {
            match spawn_bounded_drain(
                stdout,
                BoundedDrainWorker {
                    seq: request.seq,
                    stream: BoundedExecStream::Stdout,
                    final_limit_bytes: request.stdout.final_limit_bytes(),
                    stream_config: request.stdout.stream,
                    writer: writer.clone(),
                    drain_cancel: drain_cancel.clone(),
                    command_cancel: command_cancel.clone(),
                    drain_done_tx: drain_done_tx.clone(),
                },
                spawner.clone(),
            ) {
                Ok(parts) => Some(parts),
                Err(e) => {
                    drain_cancel.store(true, Ordering::Release);
                    kill_and_send_wait_failed(
                        request.seq,
                        started,
                        child,
                        request.stdout,
                        request.stderr,
                        &format!("failed to spawn stdout drain thread: {e}"),
                        &writer,
                    );
                    return;
                }
            }
        }
        None => None,
    };

    let stderr_worker = match stderr {
        Some(stderr) => {
            match spawn_bounded_drain(
                stderr,
                BoundedDrainWorker {
                    seq: request.seq,
                    stream: BoundedExecStream::Stderr,
                    final_limit_bytes: request.stderr.final_limit_bytes(),
                    stream_config: request.stderr.stream,
                    writer: writer.clone(),
                    drain_cancel: drain_cancel.clone(),
                    command_cancel: command_cancel.clone(),
                    drain_done_tx: drain_done_tx.clone(),
                },
                spawner.clone(),
            ) {
                Ok(parts) => Some(parts),
                Err(e) => {
                    drain_cancel.store(true, Ordering::Release);
                    command_cancel.store(true, Ordering::Release);
                    kill_and_reap_child(child);
                    if let Some((stdout_handle, _)) = stdout_worker {
                        let _ = stdout_handle.join();
                    }
                    let stdout_output = GuestBoundedOutput::empty_for_policy(request.stdout);
                    let stderr_output = GuestBoundedOutput::empty_for_policy(request.stderr);
                    let diagnostic = format!("failed to spawn stderr drain thread: {e}");
                    let _ = send_bounded_exec_result(
                        BoundedExecResultFrame {
                            seq: request.seq,
                            termination: BoundedExecTermination::WaitFailed,
                            duration_ms: duration_ms(started),
                            stdout: stdout_output.as_proto(),
                            stderr: stderr_output.as_proto(),
                            diagnostic: Some(&diagnostic),
                        },
                        &writer,
                    );
                    return;
                }
            }
        }
        None => None,
    };

    let stdin_worker = match (stdin, request.stdin) {
        (Some(stdin), Some(stdin_bytes)) => {
            match spawn_stdin_writer(
                stdin,
                stdin_bytes,
                command_cancel.clone(),
                stdin_cancel.clone(),
                spawner.clone(),
            ) {
                Ok(worker) => Some(worker),
                Err(e) => {
                    drain_cancel.store(true, Ordering::Release);
                    command_cancel.store(true, Ordering::Release);
                    stdin_cancel.store(true, Ordering::Release);
                    kill_and_reap_child(child);
                    if let Some((stdout_handle, _)) = stdout_worker {
                        let _ = stdout_handle.join();
                    }
                    if let Some((stderr_handle, _)) = stderr_worker {
                        let _ = stderr_handle.join();
                    }
                    let stdout_output = GuestBoundedOutput::empty_for_policy(request.stdout);
                    let stderr_output = GuestBoundedOutput::empty_for_policy(request.stderr);
                    let diagnostic = format!("failed to spawn stdin writer thread: {e}");
                    let _ = send_bounded_exec_result(
                        BoundedExecResultFrame {
                            seq: request.seq,
                            termination: BoundedExecTermination::WaitFailed,
                            duration_ms: duration_ms(started),
                            stdout: stdout_output.as_proto(),
                            stderr: stderr_output.as_proto(),
                            diagnostic: Some(&diagnostic),
                        },
                        &writer,
                    );
                    return;
                }
            }
        }
        _ => None,
    };
    drop(drain_done_tx);

    let outcome = wait_with_kill_timeout_or_cancelled_any(
        child,
        request.timeout_ms,
        &[
            connection_cancel.as_ref(),
            request_cancel.as_ref(),
            command_cancel.as_ref(),
        ],
    );
    if matches!(outcome, WaitOutcome::Cancelled)
        || connection_cancel.load(Ordering::Acquire)
        || request_cancel.load(Ordering::Acquire)
        || command_cancel.load(Ordering::Acquire)
    {
        drain_cancel.store(true, Ordering::Release);
    }
    // The direct child may have exited or been killed, but a descendant can
    // still hold stdin open without reading it. Clean up any process still
    // holding this exact stdin pipe before waiting for stdout/stderr drain.
    //
    // Do this even if the stdin writer already finished: pipe capacity is
    // platform-dependent, so a small-enough stdin payload can be fully buffered
    // while a daemonized descendant still leaks the read end.
    if let Some(pipe_link) = stdin_worker
        .as_ref()
        .and_then(|worker| worker.pipe_link.as_deref())
    {
        kill_processes_holding_pipe(pipe_link);
    }
    if stdin_worker
        .as_ref()
        .is_some_and(BoundedStdinWorker::is_pending)
    {
        stdin_cancel.store(true, Ordering::Release);
    }
    if matches!(
        outcome,
        WaitOutcome::TimedOut | WaitOutcome::Cancelled | WaitOutcome::WaitFailed(_)
    ) {
        stdin_cancel.store(true, Ordering::Release);
    }

    let expected_drains =
        usize::from(stdout_worker.is_some()) + usize::from(stderr_worker.is_some());
    let completed = await_drain_deadline(&drain_done_rx, expected_drains, &drain_cancel);
    if completed < expected_drains {
        log(
            "WARN",
            &format!("bounded_exec: drain deadline reached after {DRAIN_DEADLINE_SECS}s",),
        );
    }

    let stdout_output = finish_drain_worker(request.stdout, stdout_worker);
    let stderr_output = finish_drain_worker(request.stderr, stderr_worker);
    stdin_cancel.store(true, Ordering::Release);
    let stdin_error_rx = stdin_worker.map(BoundedStdinWorker::finish);

    let mut diagnostic = None;
    let mut termination = match outcome {
        WaitOutcome::Exited(status) => BoundedExecTermination::Exited {
            exit_code: crate::process::extract_exit_code(status),
        },
        WaitOutcome::TimedOut => BoundedExecTermination::TimedOut,
        WaitOutcome::Cancelled => BoundedExecTermination::Cancelled,
        WaitOutcome::WaitFailed(msg) => {
            diagnostic = Some(format!("Failed to wait: {msg}"));
            BoundedExecTermination::WaitFailed
        }
    };

    if let Some(stdin_error_rx) = stdin_error_rx
        && let Ok(stdin_error) = stdin_error_rx.try_recv()
    {
        termination = BoundedExecTermination::WaitFailed;
        diagnostic = Some(format!("Failed to write stdin: {stdin_error}"));
    }

    log(
        "INFO",
        &format!(
            "bounded_exec result: termination={termination:?}, stdout_len={}, stderr_len={}, stdout_truncated={}, stderr_truncated={}, diagnostic={}",
            stdout_output.len(),
            stderr_output.len(),
            stdout_output.truncated(),
            stderr_output.truncated(),
            diagnostic.is_some(),
        ),
    );

    send_final_best_effort(
        request.seq,
        termination,
        duration_ms(started),
        &stdout_output,
        &stderr_output,
        diagnostic.as_deref(),
        &writer,
    );
}

fn validate_request(request: &BoundedExecWorkerRequest) -> Result<(), String> {
    let stdout_limit = request.stdout.final_limit_bytes().unwrap_or(0);
    let stderr_limit = request.stderr.final_limit_bytes().unwrap_or(0);
    let total_limit = stdout_limit
        .checked_add(stderr_limit)
        .ok_or_else(|| "bounded exec final output limits overflow".to_string())?;
    if total_limit > vsock_proto::MAX_BOUNDED_EXEC_RESULT_OUTPUT_BYTES {
        return Err(format!(
            "bounded exec final output limits exceed protocol result frame: {} > {}",
            total_limit,
            vsock_proto::MAX_BOUNDED_EXEC_RESULT_OUTPUT_BYTES
        ));
    }

    for stream in [request.stdout.stream, request.stderr.stream]
        .into_iter()
        .flatten()
    {
        let stream_chunk_limit = stream.chunk_limit_bytes;
        if stream_chunk_limit < vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES {
            return Err(format!(
                "bounded exec stream chunk limit below minimum: {} < {}",
                stream.chunk_limit_bytes,
                vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES
            ));
        }
        if stream_chunk_limit > vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES {
            return Err(format!(
                "bounded exec stream chunk limit exceeds protocol frame: {} > {}",
                stream.chunk_limit_bytes,
                vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES
            ));
        }
    }

    Ok(())
}

fn cancellation_requested(connection_cancel: &AtomicBool, request_cancel: &AtomicBool) -> bool {
    connection_cancel.load(Ordering::Acquire) || request_cancel.load(Ordering::Acquire)
}

fn format_output_policy(policy: BoundedOutputRequest) -> String {
    let capture = match policy.capture {
        vsock_proto::BoundedExecCapturePolicy::Discard => "discard".to_string(),
        vsock_proto::BoundedExecCapturePolicy::Capture { limit_bytes } => {
            format!("capture({limit_bytes})")
        }
    };
    let stream = match policy.stream {
        Some(stream) => format!(
            "stream(limit={}, chunk={})",
            stream.stream_limit_bytes, stream.chunk_limit_bytes
        ),
        None => "no-stream".to_string(),
    };
    format!("{capture}+{stream}")
}

fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn spawn_bounded_drain<R, S>(
    pipe: R,
    worker: BoundedDrainWorker,
    spawner: S,
) -> io::Result<(JoinHandle<()>, mpsc::Receiver<BoundedDrainResult>)>
where
    R: AsRawFd + Send + 'static,
    S: ThreadSpawner,
{
    let BoundedDrainWorker {
        seq,
        stream,
        final_limit_bytes,
        stream_config,
        writer,
        drain_cancel,
        command_cancel,
        drain_done_tx,
    } = worker;
    let (result_tx, result_rx) = mpsc::channel();
    let thread_name = match stream {
        BoundedExecStream::Stdout => THREAD_BOUNDED_STDOUT,
        BoundedExecStream::Stderr => THREAD_BOUNDED_STDERR,
    };
    let handle = spawner.spawn_unit(
        thread_name,
        Box::new(move || {
            let mut sequence = 0u32;
            let result = drain_bounded_cancellable(
                pipe,
                &drain_cancel,
                final_limit_bytes,
                stream_config,
                |chunk, truncated| {
                    let send_result = send_bounded_exec_output_chunk(
                        seq, stream, sequence, chunk, truncated, &writer,
                    );
                    sequence = sequence.wrapping_add(1);
                    if let Err(e) = send_result {
                        log(
                            "WARN",
                            &format!("bounded_exec: failed to send output chunk: {e}"),
                        );
                        command_cancel.store(true, Ordering::Release);
                        drain_cancel.store(true, Ordering::Release);
                        return false;
                    }
                    true
                },
            );
            let _ = result_tx.send(result);
            let _ = drain_done_tx.send(());
        }),
    )?;
    Ok((handle, result_rx))
}

fn finish_drain_worker(
    policy: BoundedOutputRequest,
    worker: Option<(JoinHandle<()>, mpsc::Receiver<BoundedDrainResult>)>,
) -> GuestBoundedOutput {
    let Some((handle, result_rx)) = worker else {
        return GuestBoundedOutput::empty_for_policy(policy);
    };
    let _ = handle.join();
    let result = result_rx.recv().unwrap_or_default();
    if policy.final_limit_bytes().is_some() {
        GuestBoundedOutput::Captured(result)
    } else {
        GuestBoundedOutput::Discarded
    }
}

fn spawn_stdin_writer<S>(
    stdin: ChildStdin,
    stdin_bytes: Vec<u8>,
    command_cancel: Arc<AtomicBool>,
    stdin_cancel: Arc<AtomicBool>,
    spawner: S,
) -> io::Result<BoundedStdinWorker>
where
    S: ThreadSpawner,
{
    let (error_tx, error_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let pipe_link = stdin_pipe_link(&stdin);
    let handle = spawner.spawn_unit(
        THREAD_BOUNDED_STDIN,
        Box::new(move || {
            let write_result = write_stdin_cancellable(
                &stdin,
                &stdin_bytes,
                command_cancel.as_ref(),
                stdin_cancel.as_ref(),
            );
            drop(stdin);
            let _ = done_tx.send(());
            if let Err(e) = write_result {
                if e.kind() == io::ErrorKind::BrokenPipe {
                    return;
                }
                let _ = error_tx.send(e.to_string());
                command_cancel.store(true, Ordering::Release);
            }
        }),
    )?;
    Ok(BoundedStdinWorker {
        handle,
        error_rx,
        done_rx,
        pipe_link,
    })
}

fn stdin_pipe_link(stdin: &ChildStdin) -> Option<String> {
    let path = format!("/proc/self/fd/{}", stdin.as_raw_fd());
    let target = std::fs::read_link(path).ok()?;
    let link = target.to_string_lossy().into_owned();
    link.starts_with("pipe:[").then_some(link)
}

fn kill_processes_holding_pipe(pipe_link: &str) {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };

    let self_pid = std::process::id();
    // SAFETY: getpgrp has no preconditions.
    let self_pgid = unsafe { libc::getpgrp() };
    let mut killed_pgroups = HashSet::new();

    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }

        let fd_dir = entry.path().join("fd");
        let Ok(fds) = std::fs::read_dir(fd_dir) else {
            continue;
        };
        let mut holds_pipe = false;
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            if target.to_string_lossy() == pipe_link {
                holds_pipe = true;
                break;
            }
        }
        if !holds_pipe {
            continue;
        }

        // SAFETY: pid came from /proc. getpgid may fail if the process exits.
        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        if pgid <= 0 || pgid == self_pgid || !killed_pgroups.insert(pgid) {
            continue;
        }

        // SAFETY: pgid is positive and not our own process group.
        let _ = unsafe { libc::kill(-pgid, libc::SIGKILL) };
    }
}

fn write_stdin_cancellable(
    stdin: &ChildStdin,
    bytes: &[u8],
    command_cancel: &AtomicBool,
    stdin_cancel: &AtomicBool,
) -> io::Result<()> {
    let fd = stdin.as_raw_fd();
    set_fd_nonblocking(fd)?;
    let mut written = 0usize;
    while written < bytes.len() {
        if command_cancel.load(Ordering::Acquire) || stdin_cancel.load(Ordering::Acquire) {
            return Ok(());
        }

        let Some(remaining) = bytes.get(written..) else {
            return Err(io::Error::other("stdin write offset exceeded input length"));
        };
        match write_nonblocking(fd, remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "stdin write returned zero bytes",
                ));
            }
            Ok(n) => {
                written = written
                    .checked_add(n)
                    .filter(|next| *next <= bytes.len())
                    .ok_or_else(|| io::Error::other("stdin write exceeded input length"))?;
            }
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                wait_stdin_writable(fd, command_cancel, stdin_cancel)?
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn set_fd_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl is called with a valid fd owned by ChildStdin.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        return Ok(());
    }

    // SAFETY: fcntl only updates descriptor flags for this owned fd.
    let ret = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_nonblocking(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    // SAFETY: bytes is a valid readable buffer and write does not retain it.
    let ret = unsafe { libc::write(fd, bytes.as_ptr().cast::<libc::c_void>(), bytes.len()) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ret as usize)
}

fn wait_stdin_writable(
    fd: RawFd,
    command_cancel: &AtomicBool,
    stdin_cancel: &AtomicBool,
) -> io::Result<()> {
    loop {
        if command_cancel.load(Ordering::Acquire) || stdin_cancel.load(Ordering::Acquire) {
            return Ok(());
        }

        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: pfd points to one initialized descriptor entry.
        let ret = unsafe { libc::poll(&mut pfd, 1, STDIN_WRITE_POLL_TIMEOUT_MS) };
        if ret < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if ret == 0 {
            continue;
        }
        if pfd.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "stdin fd is invalid",
            ));
        }
        if pfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stdin pipe is no longer writable",
            ));
        }
        if pfd.revents & libc::POLLOUT != 0 {
            return Ok(());
        }
    }
}

fn send_cancelled_without_output(
    seq: u32,
    started: Instant,
    stdout_policy: BoundedOutputRequest,
    stderr_policy: BoundedOutputRequest,
    writer: &GuestWriter,
) {
    let stdout = GuestBoundedOutput::empty_for_policy(stdout_policy);
    let stderr = GuestBoundedOutput::empty_for_policy(stderr_policy);
    let _ = send_bounded_exec_result(
        BoundedExecResultFrame {
            seq,
            termination: BoundedExecTermination::Cancelled,
            duration_ms: duration_ms(started),
            stdout: stdout.as_proto(),
            stderr: stderr.as_proto(),
            diagnostic: None,
        },
        writer,
    );
}

fn kill_and_send_cancelled(
    seq: u32,
    started: Instant,
    child: Child,
    stdout_policy: BoundedOutputRequest,
    stderr_policy: BoundedOutputRequest,
    writer: &GuestWriter,
) {
    kill_and_reap_child(child);
    send_cancelled_without_output(seq, started, stdout_policy, stderr_policy, writer);
}

fn kill_and_send_wait_failed(
    seq: u32,
    started: Instant,
    child: Child,
    stdout_policy: BoundedOutputRequest,
    stderr_policy: BoundedOutputRequest,
    error: &str,
    writer: &GuestWriter,
) {
    kill_and_reap_child(child);
    let stdout = GuestBoundedOutput::empty_for_policy(stdout_policy);
    let stderr = GuestBoundedOutput::empty_for_policy(stderr_policy);
    let _ = send_bounded_exec_result(
        BoundedExecResultFrame {
            seq,
            termination: BoundedExecTermination::WaitFailed,
            duration_ms: duration_ms(started),
            stdout: stdout.as_proto(),
            stderr: stderr.as_proto(),
            diagnostic: Some(error),
        },
        writer,
    );
}

fn send_final_best_effort(
    seq: u32,
    termination: BoundedExecTermination,
    duration_ms: u64,
    stdout: &GuestBoundedOutput,
    stderr: &GuestBoundedOutput,
    diagnostic: Option<&str>,
    writer: &GuestWriter,
) {
    if let Err(e) = send_bounded_exec_result(
        BoundedExecResultFrame {
            seq,
            termination,
            duration_ms,
            stdout: stdout.as_proto(),
            stderr: stderr.as_proto(),
            diagnostic,
        },
        writer,
    ) {
        log("ERROR", &format!("Failed to send bounded_exec_result: {e}"));
    }
}

fn send_bounded_exec_result(
    frame: BoundedExecResultFrame<'_>,
    writer: &GuestWriter,
) -> io::Result<()> {
    let BoundedExecResultFrame {
        seq,
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    } = frame;
    let payload = match vsock_proto::encode_bounded_exec_result(
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    ) {
        Ok(payload) => payload,
        Err(e) => {
            log(
                "ERROR",
                &format!("Failed to encode bounded_exec_result: {e}"),
            );
            let diagnostic = format!("Failed to encode bounded exec result: {e}");
            vsock_proto::encode_bounded_exec_result(
                BoundedExecTermination::WaitFailed,
                duration_ms,
                vsock_proto::BoundedExecOutput::Discarded,
                vsock_proto::BoundedExecOutput::Discarded,
                Some(&diagnostic),
            )
            .map_err(to_io_error)?
        }
    };
    let encoded =
        vsock_proto::encode(MSG_BOUNDED_EXEC_RESULT, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&encoded)
}

fn send_bounded_exec_output_chunk(
    seq: u32,
    stream: BoundedExecStream,
    sequence: u32,
    chunk: &[u8],
    truncated: bool,
    writer: &GuestWriter,
) -> io::Result<()> {
    let payload = vsock_proto::encode_bounded_exec_output_chunk(stream, sequence, chunk, truncated)
        .map_err(to_io_error)?;
    let encoded =
        vsock_proto::encode(MSG_BOUNDED_EXEC_OUTPUT_CHUNK, seq, &payload).map_err(to_io_error)?;
    writer.write_frame_with_deadline(&encoded, STREAM_CHUNK_WRITE_DEADLINE)
}

fn duration_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;

    use crate::threading::test_support::FailingThreadSpawner;

    fn capture_output(limit_bytes: u32) -> BoundedOutputRequest {
        BoundedOutputRequest {
            capture: vsock_proto::BoundedExecCapturePolicy::Capture { limit_bytes },
            stream: None,
        }
    }

    fn bounded_request(seq: u32, command: &str) -> BoundedExecWorkerRequest {
        BoundedExecWorkerRequest {
            seq,
            timeout_ms: 5_000,
            command: command.to_string(),
            env: Vec::new(),
            sudo: false,
            stdin: None,
            stdout: capture_output(1024),
            stderr: capture_output(1024),
        }
    }

    fn read_message(stream: &mut UnixStream) -> vsock_proto::RawMessage {
        let mut hdr = [0u8; 4];
        stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).unwrap();

        let mut full = Vec::with_capacity(4 + body_len);
        full.extend_from_slice(&hdr);
        full.extend_from_slice(&body);
        let mut decoder = vsock_proto::Decoder::new();
        let mut messages = decoder.decode(&full).unwrap();
        assert_eq!(messages.len(), 1);
        messages.remove(0)
    }

    fn assert_bounded_exec_result(
        stream: &mut UnixStream,
        seq: u32,
        expected_termination: BoundedExecTermination,
        expected_diagnostic: &str,
    ) {
        let msg = read_message(stream);
        assert_eq!(msg.msg_type, MSG_BOUNDED_EXEC_RESULT);
        assert_eq!(msg.seq, seq);
        let decoded = vsock_proto::decode_bounded_exec_result(&msg.payload).unwrap();
        assert_eq!(decoded.termination, expected_termination);
        let diagnostic = decoded.diagnostic.unwrap_or_default();
        assert!(
            diagnostic.contains(expected_diagnostic),
            "expected diagnostic to contain {expected_diagnostic:?}, got {diagnostic:?}",
        );
    }

    #[test]
    fn bounded_exec_worker_spawn_failure_returns_start_failed_result() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let cleanup_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cleanup_count_for_hook = Arc::clone(&cleanup_count);

        spawn_bounded_exec_worker_with_spawner(
            bounded_request(41, "echo should-not-run"),
            writer,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Box::new(move || {
                cleanup_count_for_hook.fetch_add(1, Ordering::SeqCst);
            }),
            FailingThreadSpawner::fail_once(THREAD_BOUNDED_EXEC_WORKER),
        )
        .unwrap();

        assert_bounded_exec_result(
            &mut host,
            41,
            BoundedExecTermination::StartFailed,
            "bounded exec worker thread",
        );
        assert_eq!(cleanup_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stdout_drain_spawn_failure_returns_wait_failed_result() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        run_bounded_exec(
            bounded_request(42, "sleep 60"),
            GuestWriter::new(guest),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            FailingThreadSpawner::fail_once(THREAD_BOUNDED_STDOUT),
        );

        assert_bounded_exec_result(
            &mut host,
            42,
            BoundedExecTermination::WaitFailed,
            "stdout drain thread",
        );
    }

    #[test]
    fn stderr_drain_spawn_failure_returns_wait_failed_result() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        run_bounded_exec(
            bounded_request(43, "sleep 60"),
            GuestWriter::new(guest),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            FailingThreadSpawner::fail_once(THREAD_BOUNDED_STDERR),
        );

        assert_bounded_exec_result(
            &mut host,
            43,
            BoundedExecTermination::WaitFailed,
            "stderr drain thread",
        );
    }

    #[test]
    fn stdin_writer_spawn_failure_returns_wait_failed_result() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request = bounded_request(44, "sleep 60");
        request.stdin = Some(vec![b'x'; 1024]);

        run_bounded_exec(
            request,
            GuestWriter::new(guest),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            FailingThreadSpawner::fail_once(THREAD_BOUNDED_STDIN),
        );

        assert_bounded_exec_result(
            &mut host,
            44,
            BoundedExecTermination::WaitFailed,
            "stdin writer thread",
        );
    }

    #[test]
    fn request_cancel_before_spawn_returns_cancelled_without_running_command() {
        let marker = std::env::temp_dir().join(format!(
            "vsock-guest-cancel-before-spawn-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&marker);
        let command = format!("touch {}", marker.display());
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

        run_bounded_exec(
            bounded_request(45, &command),
            GuestWriter::new(guest),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(true)),
            SystemThreadSpawner,
        );

        assert_bounded_exec_result(&mut host, 45, BoundedExecTermination::Cancelled, "");
        assert!(
            !marker.exists(),
            "pre-cancelled bounded exec should not run the command",
        );
    }
}
