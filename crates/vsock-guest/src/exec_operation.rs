use std::collections::HashMap;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use vsock_proto::{
    self, ExecCapturedOutput, ExecControlNonce, ExecControlPolicy, ExecLifecyclePolicy,
    ExecOutputPolicy, ExecOutputStream, ExecTermination, ExecTimeoutPolicy, MSG_ERROR,
    MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_STARTED,
};

use crate::drain::{BoundedDrainResult, BoundedStreamConfig, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::exec_control::ExecControlGuard;
use crate::log::log;
use crate::process::{
    ProcessTreeKillTarget, extract_exit_code, kill_and_reap_child_with_target,
    kill_process_tree_target, process_tree_kill_target, refresh_process_tree_kill_target,
};
use crate::quiesce::OperationGuard;
use crate::shell_command::{
    SpawnedShellCommand, format_env_diagnostics, spawn_shell_command_with_pipes,
    truncate_command_preview,
};
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::wait::{
    DRAIN_DEADLINE_SECS, WaitOutcome, await_drain_deadline,
    wait_with_kill_timeout_or_cancelled_either_with_target,
};
use crate::writer::GuestWriter;

const THREAD_EXEC_OPERATION_WORKER: &str = "vsock-exec-operation-worker";
const THREAD_EXEC_OPERATION_STDIN: &str = "vsock-exec-operation-stdin";
const THREAD_EXEC_OPERATION_STDOUT: &str = "vsock-exec-operation-stdout";
const THREAD_EXEC_OPERATION_STDERR: &str = "vsock-exec-operation-stderr";
const THREAD_EXEC_OPERATION_OUTPUT: &str = "vsock-exec-operation-output";
const STDIN_WRITE_CANCELLED: &str = "stdin write cancelled";
const OUTPUT_CHANNEL_CAPACITY: usize = 32;
const FRAME_BODY_HEADER_LEN: usize = 1 + 4; // message type + sequence
const EXEC_OUTPUT_PAYLOAD_OVERHEAD: usize = 1 + 4 + 1 + 4;
const EXEC_RESULT_EXITED_LEN: usize = 1 + 4;
const EXEC_RESULT_DURATION_LEN: usize = 4;
const EXEC_RESULT_DIAGNOSTIC_LEN_FIELD: usize = 2;
const EXEC_RESULT_MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;
const EXEC_CAPTURED_OUTPUT_OVERHEAD: usize = 1 + 1 + 4;
const EXEC_DISCARDED_OUTPUT_LEN: usize = 1;
const EXEC_OPERATION_STAGE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub(crate) struct ExecOperationRegistry {
    inner: Arc<Mutex<HashMap<u32, ExecOperationRegistryEntry>>>,
}

#[derive(Clone)]
struct ExecOperationRegistryEntry {
    cancel: Arc<AtomicBool>,
    label_preview: String,
}

impl ExecOperationRegistry {
    pub(crate) fn register(&self, seq: u32, label: &str) -> Result<ExecOperationRegistration, ()> {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&seq) {
            return Err(());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        active.insert(
            seq,
            ExecOperationRegistryEntry {
                cancel: cancel.clone(),
                label_preview: truncate_command_preview(label),
            },
        );
        Ok(ExecOperationRegistration {
            registry: self.clone(),
            seq,
            cancel,
        })
    }

    pub(crate) fn cancel(&self, seq: u32) -> Option<String> {
        let active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let cancel = active.get(&seq)?;
        cancel.cancel.store(true, Ordering::Release);
        Some(cancel.label_preview.clone())
    }

    fn remove_if_same(&self, seq: u32, cancel: &Arc<AtomicBool>) {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active
            .get(&seq)
            .is_some_and(|existing| Arc::ptr_eq(&existing.cancel, cancel))
        {
            active.remove(&seq);
        }
    }
}

pub(crate) struct ExecOperationRegistration {
    registry: ExecOperationRegistry,
    seq: u32,
    cancel: Arc<AtomicBool>,
}

impl ExecOperationRegistration {
    fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    fn complete(&self) {
        self.registry.remove_if_same(self.seq, &self.cancel);
    }
}

impl Drop for ExecOperationRegistration {
    fn drop(&mut self) {
        self.complete();
    }
}

#[derive(Clone, Copy)]
struct WaitFailureContext<'a> {
    seq: u32,
    started: Instant,
    stdout_policy: ExecOutputPolicy,
    stderr_policy: ExecOutputPolicy,
    registration: &'a ExecOperationRegistration,
    writer: &'a GuestWriter,
    operation_guard: &'a OperationGuard,
    exec_control_guard: Option<&'a ExecControlGuard>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExecOperationLifecycle {
    OneShot,
    Supervised,
}

#[derive(Clone, Copy)]
enum ExecOperationTimeout {
    Duration { timeout_ms: u32 },
    None,
}

impl ExecOperationTimeout {
    fn wait_timeout_ms(self) -> u32 {
        match self {
            Self::Duration { timeout_ms } => timeout_ms,
            Self::None => 0,
        }
    }
}

pub(crate) struct ExecOperationWorkerRequest {
    seq: u32,
    lifecycle: ExecOperationLifecycle,
    timeout: ExecOperationTimeout,
    command: String,
    env: Vec<(String, String)>,
    sudo: bool,
    label: String,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
    expected_exit_codes: Vec<i32>,
    stdin_bytes: Option<Vec<u8>>,
    control: ExecControlPolicy,
    exec_control_guard: Option<ExecControlGuard>,
    exec_control_bootstrap_endpoint: Option<String>,
}

impl ExecOperationWorkerRequest {
    pub(crate) fn from_decoded(
        seq: u32,
        decoded: vsock_proto::DecodedExecStart<'_>,
    ) -> io::Result<Self> {
        let lifecycle = match decoded.lifecycle {
            ExecLifecyclePolicy::OneShot => ExecOperationLifecycle::OneShot,
            ExecLifecyclePolicy::Supervised => ExecOperationLifecycle::Supervised,
        };
        let timeout = match decoded.timeout {
            ExecTimeoutPolicy::Duration { timeout_ms } => {
                if timeout_ms == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "exec timeout duration must be positive",
                    ));
                }
                ExecOperationTimeout::Duration { timeout_ms }
            }
            ExecTimeoutPolicy::None => {
                if lifecycle != ExecOperationLifecycle::Supervised {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "exec timeout policy none requires supervised lifecycle",
                    ));
                }
                ExecOperationTimeout::None
            }
        };
        if lifecycle == ExecOperationLifecycle::OneShot
            && decoded.control != ExecControlPolicy::Disabled
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "exec control policy requires supervised lifecycle",
            ));
        }

        Ok(Self {
            seq,
            lifecycle,
            timeout,
            command: decoded.command.to_owned(),
            env: decoded
                .env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            sudo: decoded.sudo,
            label: decoded.label.to_owned(),
            stdout: decoded.stdout,
            stderr: decoded.stderr,
            expected_exit_codes: decoded.expected_exit_codes,
            stdin_bytes: decoded.stdin_bytes.map(Vec::from),
            control: decoded.control,
            exec_control_guard: None,
            exec_control_bootstrap_endpoint: None,
        })
    }

    pub(crate) fn exec_control_registration(&self) -> Option<(ExecControlNonce, bool)> {
        match self.control {
            ExecControlPolicy::Disabled => None,
            ExecControlPolicy::Enabled {
                control_nonce,
                sink,
            } => Some((control_nonce, sink)),
        }
    }

    pub(crate) fn attach_exec_control(
        &mut self,
        guard: ExecControlGuard,
        bootstrap_endpoint: Option<String>,
    ) {
        debug_assert!(matches!(self.control, ExecControlPolicy::Enabled { .. }));
        self.exec_control_guard = Some(guard);
        self.exec_control_bootstrap_endpoint = bootstrap_endpoint;
    }
}

struct DrainWorker {
    stream: ExecOutputStream,
    policy: OutputSettings,
    output_tx: Option<SyncSender<StreamEvent>>,
    drain_cancel: Arc<AtomicBool>,
    exec_cancel: Arc<AtomicBool>,
    drain_done_tx: mpsc::Sender<()>,
}

struct StreamEvent {
    stream: ExecOutputStream,
    chunk: Vec<u8>,
    truncated: bool,
}

struct StdinWriter {
    handle: JoinHandle<()>,
    done_rx: mpsc::Receiver<()>,
    result_rx: mpsc::Receiver<io::Result<()>>,
    cancel: Arc<AtomicBool>,
    cancel_wake_writer: OwnedFd,
}

#[derive(Clone, Copy)]
struct OutputSettings {
    capture_limit_bytes: Option<usize>,
    stream: Option<BoundedStreamConfig>,
}

struct ExecResultFrame<'a> {
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'a>,
    stderr: ExecCapturedOutput<'a>,
    diagnostic: &'a str,
}

pub(crate) fn start_exec_operation(
    request: ExecOperationWorkerRequest,
    operation_guard: OperationGuard,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    registry: ExecOperationRegistry,
) -> io::Result<()> {
    start_exec_operation_with_spawner(
        request,
        operation_guard,
        writer,
        connection_cancel,
        registry,
        SystemThreadSpawner,
    )
}

fn start_exec_operation_with_spawner<S>(
    request: ExecOperationWorkerRequest,
    operation_guard: OperationGuard,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    registry: ExecOperationRegistry,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let seq = request.seq;
    let registration = match registry.register(seq, &request.label) {
        Ok(registration) => registration,
        Err(()) => {
            return send_error_response(seq, "exec operation already active", &writer);
        }
    };
    let exec_cancel = registration.cancel_token();
    let stdout_policy = request.stdout;
    let stderr_policy = request.stderr;
    let worker_writer = writer.clone();
    let worker_spawner = spawner.clone();
    let worker_operation_guard = operation_guard.clone();
    let result = spawner.spawn_unit(
        THREAD_EXEC_OPERATION_WORKER,
        Box::new(move || {
            run_exec_operation_worker(
                request,
                worker_writer,
                connection_cancel,
                exec_cancel,
                registration,
                worker_operation_guard,
                worker_spawner,
            );
        }),
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let diagnostic = format!("Failed to spawn exec operation worker thread: {e}");
            log(
                "ERROR",
                &format!("exec operation: worker spawn failed seq={seq}: {e}"),
            );
            send_exec_result_after_lock(
                ExecResultFrame {
                    seq,
                    termination: ExecTermination::StartFailed,
                    duration_ms: 0,
                    stdout: empty_output_for_policy(stdout_policy),
                    stderr: empty_output_for_policy(stderr_policy),
                    diagnostic: &diagnostic,
                },
                &writer,
                || operation_guard.release(),
            )
        }
    }
}

pub(crate) fn cancel_exec_operation(registry: &ExecOperationRegistry, seq: u32) {
    if let Some(label_preview) = registry.cancel(seq) {
        log(
            "INFO",
            &format!("exec operation: cancel requested seq={seq} label={label_preview}"),
        );
    }
}

pub(crate) fn send_error_response(seq: u32, message: &str, writer: &GuestWriter) -> io::Result<()> {
    let payload = vsock_proto::encode_error(message);
    let response = vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&response)
}

fn run_exec_operation_worker<S>(
    request: ExecOperationWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    exec_cancel: Arc<AtomicBool>,
    registration: ExecOperationRegistration,
    operation_guard: OperationGuard,
    spawner: S,
) where
    S: ThreadSpawner,
{
    let started = Instant::now();
    if let Err(diagnostic) = validate_request(&request) {
        send_final_and_complete(
            &registration,
            ExecResultFrame {
                seq: request.seq,
                termination: ExecTermination::StartFailed,
                duration_ms: duration_ms(started),
                stdout: empty_output_for_policy(request.stdout),
                stderr: empty_output_for_policy(request.stderr),
                diagnostic: &diagnostic,
            },
            &writer,
            &operation_guard,
            request.exec_control_guard.as_ref(),
        );
        return;
    }

    let env_refs = env_refs(&request.env);
    let mut env_with_control;
    let effective_env = if let Some(endpoint) = request.exec_control_bootstrap_endpoint.as_deref() {
        env_with_control = Vec::with_capacity(env_refs.len() + 1);
        env_with_control.extend_from_slice(&env_refs);
        env_with_control.push((process_control_ipc::BOOTSTRAP_ENV, endpoint));
        env_with_control.as_slice()
    } else {
        env_refs.as_slice()
    };
    let spawned = match spawn_shell_command_with_pipes(
        &request.command,
        effective_env,
        request.sudo,
        request.stdin_bytes.is_some(),
    ) {
        Ok(spawned) => spawned,
        Err(e) => {
            let diagnostic = format!(
                "Failed to execute: {e} ({})",
                format_env_diagnostics(&request.command, &env_refs)
            );
            send_final_and_complete(
                &registration,
                ExecResultFrame {
                    seq: request.seq,
                    termination: ExecTermination::StartFailed,
                    duration_ms: duration_ms(started),
                    stdout: empty_output_for_policy(request.stdout),
                    stderr: empty_output_for_policy(request.stderr),
                    diagnostic: &diagnostic,
                },
                &writer,
                &operation_guard,
                request.exec_control_guard.as_ref(),
            );
            return;
        }
    };

    let SpawnedShellCommand {
        mut child,
        env_script,
    } = spawned;
    let _env_script = env_script;
    let child_pid = child.id();
    let mut kill_target = process_tree_kill_target(child_pid);
    let failure = WaitFailureContext {
        seq: request.seq,
        started,
        stdout_policy: request.stdout,
        stderr_policy: request.stderr,
        registration: &registration,
        writer: &writer,
        operation_guard: &operation_guard,
        exec_control_guard: request.exec_control_guard.as_ref(),
    };

    if request.lifecycle == ExecOperationLifecycle::Supervised
        && let Err(e) = send_exec_started(request.seq, child.id(), &writer)
    {
        log(
            "WARN",
            &format!(
                "exec operation: failed to send exec_started seq={} label={}: {e}",
                request.seq,
                truncate_command_preview(&request.label)
            ),
        );
        kill_and_reap_child_with_target(child, kill_target);
        release_exec_control_guard(request.exec_control_guard.as_ref());
        operation_guard.release();
        registration.complete();
        return;
    }

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_and_send_wait_failed(child, kill_target, "missing stdout pipe", failure);
            return;
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            kill_and_send_wait_failed(child, kill_target, "missing stderr pipe", failure);
            return;
        }
    };
    let stdin_writer = match request.stdin_bytes.as_ref() {
        Some(stdin_bytes) => {
            let Some(stdin) = child.stdin.take() else {
                kill_and_send_wait_failed(child, kill_target, "missing stdin pipe", failure);
                return;
            };
            match spawn_exec_operation_stdin(stdin, stdin_bytes.clone(), spawner.clone()) {
                Ok(writer) => Some(writer),
                Err(e) => {
                    kill_and_send_wait_failed(
                        child,
                        kill_target,
                        &format!("failed to spawn stdin writer thread: {e}"),
                        failure,
                    );
                    return;
                }
            }
        }
        None => None,
    };

    let stdout_settings = output_settings(request.stdout);
    let stderr_settings = output_settings(request.stderr);
    let needs_stream = stdout_settings.stream.is_some() || stderr_settings.stream.is_some();
    let drain_cancel = Arc::new(AtomicBool::new(false));
    let (drain_done_tx, drain_done_rx) = mpsc::channel::<()>();

    let (output_tx, output_handle) = if needs_stream {
        let (tx, rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
        let label_preview = truncate_command_preview(&request.label);
        match spawn_output_writer(
            request.seq,
            label_preview,
            rx,
            writer.clone(),
            exec_cancel.clone(),
            drain_cancel.clone(),
            spawner.clone(),
        ) {
            Ok(handle) => (Some(tx), Some(handle)),
            Err(e) => {
                kill_join_stdin_and_send_wait_failed(
                    child,
                    kill_target,
                    stdin_writer,
                    &format!("failed to spawn exec output writer thread: {e}"),
                    failure,
                );
                return;
            }
        }
    } else {
        (None, None)
    };

    let stdout_spawn = spawn_exec_operation_drain(
        stdout,
        DrainWorker {
            stream: ExecOutputStream::Stdout,
            policy: stdout_settings,
            output_tx: output_tx.clone(),
            drain_cancel: drain_cancel.clone(),
            exec_cancel: exec_cancel.clone(),
            drain_done_tx: drain_done_tx.clone(),
        },
        spawner.clone(),
    );
    let (stdout_handle, stdout_result_rx) = match stdout_spawn {
        Ok(parts) => parts,
        Err(e) => {
            drain_cancel.store(true, Ordering::Release);
            drop(output_tx);
            kill_join_stdin_and_send_wait_failed(
                child,
                kill_target,
                stdin_writer,
                &format!("failed to spawn stdout drain thread: {e}"),
                failure,
            );
            join_output_writer(output_handle);
            return;
        }
    };

    let stderr_spawn = spawn_exec_operation_drain(
        stderr,
        DrainWorker {
            stream: ExecOutputStream::Stderr,
            policy: stderr_settings,
            output_tx: output_tx.clone(),
            drain_cancel: drain_cancel.clone(),
            exec_cancel: exec_cancel.clone(),
            drain_done_tx: drain_done_tx.clone(),
        },
        spawner.clone(),
    );
    let (stderr_handle, stderr_result_rx) = match stderr_spawn {
        Ok(parts) => parts,
        Err(e) => {
            exec_cancel.store(true, Ordering::Release);
            drain_cancel.store(true, Ordering::Release);
            drop(output_tx);
            kill_and_reap_child_with_target(child, kill_target);
            join_stdin_writer_after_kill(stdin_writer);
            let _ = stdout_handle.join();
            join_output_writer(output_handle);
            send_final_and_complete(
                &registration,
                ExecResultFrame {
                    seq: request.seq,
                    termination: ExecTermination::WaitFailed,
                    duration_ms: duration_ms(started),
                    stdout: empty_output_for_policy(request.stdout),
                    stderr: empty_output_for_policy(request.stderr),
                    diagnostic: &format!("failed to spawn stderr drain thread: {e}"),
                },
                &writer,
                &operation_guard,
                request.exec_control_guard.as_ref(),
            );
            return;
        }
    };
    drop(drain_done_tx);
    drop(output_tx);

    refresh_process_tree_kill_target(&mut kill_target);
    let outcome = wait_with_kill_timeout_or_cancelled_either_with_target(
        child,
        kill_target,
        request.timeout.wait_timeout_ms(),
        &connection_cancel,
        &exec_cancel,
    );
    join_stdin_writer_after_wait(stdin_writer, kill_target, request.seq, &request.label);
    if matches!(outcome, WaitOutcome::Cancelled | WaitOutcome::TimedOut)
        || connection_cancel.load(Ordering::Acquire)
        || exec_cancel.load(Ordering::Acquire)
    {
        exec_cancel.store(true, Ordering::Release);
        drain_cancel.store(true, Ordering::Release);
    }

    let completed = await_drain_deadline(&drain_done_rx, 2, &drain_cancel);
    if completed < 2 {
        log(
            "WARN",
            &format!(
                "exec operation: drain deadline reached seq={} label={} after {DRAIN_DEADLINE_SECS}s",
                request.seq,
                truncate_command_preview(&request.label)
            ),
        );
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();
    join_output_writer(output_handle);
    let stdout_result = stdout_result_rx.recv().unwrap_or_default();
    let stderr_result = stderr_result_rx.recv().unwrap_or_default();

    let (termination, diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            ExecTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            String::new(),
        ),
        WaitOutcome::TimedOut => (ExecTermination::TimedOut, String::new()),
        WaitOutcome::Cancelled => (ExecTermination::Cancelled, String::new()),
        WaitOutcome::WaitFailed(msg) => (
            ExecTermination::WaitFailed,
            format!("Failed to wait: {msg}"),
        ),
    };

    log_exec_terminal_if_notable(
        &request,
        started,
        termination,
        &stdout_result,
        &stderr_result,
        &diagnostic,
    );

    send_final_and_complete(
        &registration,
        ExecResultFrame {
            seq: request.seq,
            termination,
            duration_ms: duration_ms(started),
            stdout: captured_output(&stdout_result),
            stderr: captured_output(&stderr_result),
            diagnostic: &diagnostic,
        },
        &writer,
        &operation_guard,
        request.exec_control_guard.as_ref(),
    );
}

fn validate_request(request: &ExecOperationWorkerRequest) -> Result<(), String> {
    let stdout_capture = capture_limit_bytes(request.stdout);
    let stderr_capture = capture_limit_bytes(request.stderr);
    let capture_total = stdout_capture
        .unwrap_or(0)
        .checked_add(stderr_capture.unwrap_or(0))
        .ok_or_else(|| "exec capture limits overflow".to_string())?;
    let capture_budget = exec_result_capture_budget(request.stdout, request.stderr);
    if capture_total > capture_budget {
        return Err(format!(
            "exec capture limits exceed protocol result frame budget: {capture_total} > {capture_budget}"
        ));
    }

    let max_chunk = vsock_proto::MAX_MESSAGE_SIZE
        .saturating_sub(FRAME_BODY_HEADER_LEN)
        .saturating_sub(EXEC_OUTPUT_PAYLOAD_OVERHEAD);
    for (name, policy) in [("stdout", request.stdout), ("stderr", request.stderr)] {
        if let Some(stream) = stream_config(policy)
            && stream.chunk_limit_bytes > max_chunk
        {
            return Err(format!(
                "exec {name} stream chunk limit exceeds protocol frame budget: {} > {max_chunk}",
                stream.chunk_limit_bytes
            ));
        }
    }

    Ok(())
}

fn exec_result_capture_budget(
    stdout_policy: ExecOutputPolicy,
    stderr_policy: ExecOutputPolicy,
) -> usize {
    let fixed = FRAME_BODY_HEADER_LEN
        + EXEC_RESULT_EXITED_LEN
        + EXEC_RESULT_DURATION_LEN
        + exec_result_output_overhead(stdout_policy)
        + exec_result_output_overhead(stderr_policy)
        + EXEC_RESULT_DIAGNOSTIC_LEN_FIELD
        + EXEC_RESULT_MAX_DIAGNOSTIC_BYTES;
    vsock_proto::MAX_MESSAGE_SIZE.saturating_sub(fixed)
}

fn exec_result_output_overhead(policy: ExecOutputPolicy) -> usize {
    if capture_limit_bytes(policy).is_some() {
        EXEC_CAPTURED_OUTPUT_OVERHEAD
    } else {
        EXEC_DISCARDED_OUTPUT_LEN
    }
}

fn output_settings(policy: ExecOutputPolicy) -> OutputSettings {
    OutputSettings {
        capture_limit_bytes: capture_limit_bytes(policy),
        stream: stream_config(policy),
    }
}

fn capture_limit_bytes(policy: ExecOutputPolicy) -> Option<usize> {
    match policy {
        ExecOutputPolicy::Discard | ExecOutputPolicy::Stream { .. } => None,
        ExecOutputPolicy::Capture { limit_bytes } => Some(limit_bytes as usize),
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes,
            ..
        } => Some(capture_limit_bytes as usize),
    }
}

fn stream_config(policy: ExecOutputPolicy) -> Option<BoundedStreamConfig> {
    match policy {
        ExecOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        }
        | ExecOutputPolicy::CaptureAndStream {
            stream_limit_bytes: limit_bytes,
            chunk_limit_bytes,
            ..
        } => Some(BoundedStreamConfig {
            chunk_limit_bytes: chunk_limit_bytes as usize,
            stream_limit_bytes: limit_bytes as usize,
        }),
        ExecOutputPolicy::Discard | ExecOutputPolicy::Capture { .. } => None,
    }
}

fn spawn_output_writer<S>(
    seq: u32,
    label_preview: String,
    rx: Receiver<StreamEvent>,
    writer: GuestWriter,
    exec_cancel: Arc<AtomicBool>,
    drain_cancel: Arc<AtomicBool>,
    spawner: S,
) -> io::Result<JoinHandle<()>>
where
    S: ThreadSpawner,
{
    spawner.spawn_unit(
        THREAD_EXEC_OPERATION_OUTPUT,
        Box::new(move || {
            let mut output_seq = 0u32;
            for event in rx {
                if exec_cancel.load(Ordering::Acquire) {
                    break;
                }
                let payload = match vsock_proto::encode_exec_output(
                    event.stream,
                    output_seq,
                    &event.chunk,
                    event.truncated,
                ) {
                    Ok(payload) => payload,
                    Err(e) => {
                        log(
                            "ERROR",
                            &format!(
                                "exec operation: failed to encode output seq={seq} label={label_preview}: {e}"
                            ),
                        );
                        exec_cancel.store(true, Ordering::Release);
                        drain_cancel.store(true, Ordering::Release);
                        break;
                    }
                };
                output_seq = output_seq.wrapping_add(1);
                let frame = match vsock_proto::encode(MSG_EXEC_OUTPUT, seq, &payload) {
                    Ok(frame) => frame,
                    Err(e) => {
                        log(
                            "ERROR",
                            &format!(
                                "exec operation: failed to encode output frame seq={seq} label={label_preview}: {e}"
                            ),
                        );
                        exec_cancel.store(true, Ordering::Release);
                        drain_cancel.store(true, Ordering::Release);
                        break;
                    }
                };
                if let Err(e) = writer.write_frame(&frame) {
                    log(
                        "WARN",
                        &format!(
                            "exec operation: failed to send output chunk seq={seq} label={label_preview}: {e}"
                        ),
                    );
                    exec_cancel.store(true, Ordering::Release);
                    drain_cancel.store(true, Ordering::Release);
                    break;
                }
            }
        }),
    )
}

fn spawn_exec_operation_drain<R, S>(
    pipe: R,
    worker: DrainWorker,
    spawner: S,
) -> io::Result<(JoinHandle<()>, mpsc::Receiver<BoundedDrainResult>)>
where
    R: std::os::unix::io::AsRawFd + Send + 'static,
    S: ThreadSpawner,
{
    let DrainWorker {
        stream,
        policy,
        output_tx,
        drain_cancel,
        exec_cancel,
        drain_done_tx,
    } = worker;
    let (result_tx, result_rx) = mpsc::channel();
    let thread_name = match stream {
        ExecOutputStream::Stdout => THREAD_EXEC_OPERATION_STDOUT,
        ExecOutputStream::Stderr => THREAD_EXEC_OPERATION_STDERR,
    };
    let handle = spawner.spawn_unit(
        thread_name,
        Box::new(move || {
            let result = drain_bounded_cancellable(
                pipe,
                &drain_cancel,
                policy.capture_limit_bytes,
                policy.stream,
                |chunk, truncated| {
                    let Some(tx) = &output_tx else {
                        return true;
                    };
                    if exec_cancel.load(Ordering::Acquire) || drain_cancel.load(Ordering::Acquire) {
                        return false;
                    }
                    match tx.send(StreamEvent {
                        stream,
                        chunk: chunk.to_vec(),
                        truncated,
                    }) {
                        Ok(()) => true,
                        Err(_) => {
                            exec_cancel.store(true, Ordering::Release);
                            drain_cancel.store(true, Ordering::Release);
                            false
                        }
                    }
                },
            );
            let _ = result_tx.send(result);
            let _ = drain_done_tx.send(());
        }),
    )?;
    Ok((handle, result_rx))
}

fn spawn_exec_operation_stdin<W, S>(
    mut stdin: W,
    stdin_bytes: Vec<u8>,
    spawner: S,
) -> io::Result<StdinWriter>
where
    W: AsRawFd + Write + Send + 'static,
    S: ThreadSpawner,
{
    set_nonblocking(stdin.as_raw_fd())?;
    let (cancel_wake_reader, cancel_wake_writer) = stdin_cancel_pipe()?;
    let cancel = Arc::new(AtomicBool::new(false));
    let writer_cancel = Arc::clone(&cancel);
    let (done_tx, done_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let handle = spawner.spawn_unit(
        THREAD_EXEC_OPERATION_STDIN,
        Box::new(move || {
            let result = write_stdin_cancellable(
                &mut stdin,
                &stdin_bytes,
                &writer_cancel,
                cancel_wake_reader.as_raw_fd(),
            );
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        }),
    )?;
    Ok(StdinWriter {
        handle,
        done_rx,
        result_rx,
        cancel,
        cancel_wake_writer,
    })
}

fn stdin_cancel_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: `pipe2` initializes two file descriptors in `fds` on success.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK | libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors were freshly returned by `pipe`.
    let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: both descriptors were freshly returned by `pipe`.
    let write_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok((read_fd, write_fd))
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fcntl` reads flags for an open file descriptor owned by the caller.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        return Ok(());
    }
    // SAFETY: `fcntl` updates flags for the same open file descriptor.
    let ret = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_stdin_cancellable<W>(
    stdin: &mut W,
    stdin_bytes: &[u8],
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<()>
where
    W: AsRawFd + Write,
{
    let mut written = 0usize;
    while written < stdin_bytes.len() {
        if cancel.load(Ordering::Acquire) {
            return Err(stdin_write_cancelled());
        }
        let remaining = stdin_bytes
            .get(written..)
            .ok_or_else(|| io::Error::other("stdin write offset out of range"))?;
        match stdin.write(remaining) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "write stdin")),
            Ok(n) => written += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                wait_stdin_writable_or_cancelled(stdin.as_raw_fd(), cancel_fd, cancel)?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn wait_stdin_writable_or_cancelled(
    fd: RawFd,
    cancel_fd: RawFd,
    cancel: &AtomicBool,
) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(stdin_write_cancelled());
        }
        let mut pollfds = [
            libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel_fd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: `pollfds` points to two initialized descriptor entries.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, -1) };
        if result > 0 {
            let stdin_revents = pollfds[0].revents;
            let cancel_revents = pollfds[1].revents;
            if cancel.load(Ordering::Acquire)
                || cancel_revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)
                    != 0
            {
                return Err(stdin_write_cancelled());
            }
            if stdin_revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "stdin pipe fd invalid",
                ));
            }
            if stdin_revents & (libc::POLLOUT | libc::POLLHUP | libc::POLLERR) != 0 {
                return Ok(());
            }
            continue;
        }
        if result == 0 {
            continue;
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn request_stdin_writer_cancel(writer: &StdinWriter) {
    writer.cancel.store(true, Ordering::Release);
    let byte = [1u8];
    loop {
        // SAFETY: `cancel_wake_writer` is an open nonblocking pipe descriptor
        // owned by `writer`; the byte buffer is valid for this call.
        let result = unsafe {
            libc::write(
                writer.cancel_wake_writer.as_raw_fd(),
                byte.as_ptr().cast(),
                byte.len(),
            )
        };
        if result >= 0 {
            return;
        }
        let err = io::Error::last_os_error();
        match err.kind() {
            io::ErrorKind::Interrupted => {}
            io::ErrorKind::WouldBlock | io::ErrorKind::BrokenPipe => return,
            _ => {
                log(
                    "WARN",
                    &format!("exec operation: failed to wake stdin writer cancel: {err}"),
                );
                return;
            }
        }
    }
}

fn stdin_write_cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, STDIN_WRITE_CANCELLED)
}

fn is_stdin_write_cancelled(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Interrupted && error.to_string() == STDIN_WRITE_CANCELLED
}

fn join_stdin_writer_after_wait(
    writer: Option<StdinWriter>,
    kill_target: ProcessTreeKillTarget,
    seq: u32,
    label: &str,
) {
    let Some(writer) = writer else {
        return;
    };
    if matches!(writer.done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)) {
        // The direct shell is no longer running, but a descendant can still
        // keep stdin open. Stop the writer before joining it so bounded stdin
        // cannot strand this worker thread.
        request_stdin_writer_cancel(&writer);
        let _ = unsafe { kill_process_tree_target(kill_target) };
    }
    join_stdin_writer(writer, seq, label);
}

fn join_stdin_writer_after_kill(writer: Option<StdinWriter>) {
    if let Some(writer) = writer {
        request_stdin_writer_cancel(&writer);
        join_stdin_writer(writer, 0, "");
    }
}

fn join_stdin_writer(writer: StdinWriter, seq: u32, label: &str) {
    match writer.handle.join() {
        Ok(()) => {}
        Err(panic) => std::panic::resume_unwind(panic),
    }
    match writer.result_rx.recv() {
        Ok(Ok(())) | Err(_) => {}
        Ok(Err(e)) if is_stdin_write_cancelled(&e) => {}
        Ok(Err(e)) => {
            let label_preview = truncate_command_preview(label);
            log(
                "WARN",
                &format!(
                    "exec operation: stdin writer finished with error seq={seq} label={label_preview}: {e}"
                ),
            );
        }
    }
}

fn kill_and_send_wait_failed(
    child: Child,
    kill_target: ProcessTreeKillTarget,
    diagnostic: &str,
    failure: WaitFailureContext<'_>,
) {
    kill_and_reap_child_with_target(child, kill_target);
    send_final_and_complete(
        failure.registration,
        ExecResultFrame {
            seq: failure.seq,
            termination: ExecTermination::WaitFailed,
            duration_ms: duration_ms(failure.started),
            stdout: empty_output_for_policy(failure.stdout_policy),
            stderr: empty_output_for_policy(failure.stderr_policy),
            diagnostic,
        },
        failure.writer,
        failure.operation_guard,
        failure.exec_control_guard,
    );
}

fn kill_join_stdin_and_send_wait_failed(
    child: Child,
    kill_target: ProcessTreeKillTarget,
    stdin_writer: Option<StdinWriter>,
    diagnostic: &str,
    failure: WaitFailureContext<'_>,
) {
    kill_and_reap_child_with_target(child, kill_target);
    join_stdin_writer_after_kill(stdin_writer);
    send_final_and_complete(
        failure.registration,
        ExecResultFrame {
            seq: failure.seq,
            termination: ExecTermination::WaitFailed,
            duration_ms: duration_ms(failure.started),
            stdout: empty_output_for_policy(failure.stdout_policy),
            stderr: empty_output_for_policy(failure.stderr_policy),
            diagnostic,
        },
        failure.writer,
        failure.operation_guard,
        failure.exec_control_guard,
    );
}

fn send_final_and_complete(
    registration: &ExecOperationRegistration,
    frame: ExecResultFrame<'_>,
    writer: &GuestWriter,
    operation_guard: &OperationGuard,
    exec_control_guard: Option<&ExecControlGuard>,
) {
    let result = send_exec_result_after_lock(frame, writer, || {
        release_exec_control_guard(exec_control_guard);
        operation_guard.release();
        registration.complete();
    });
    if result.is_err() {
        release_exec_control_guard(exec_control_guard);
        operation_guard.release();
        registration.complete();
    }
    if let Err(e) = result {
        log("ERROR", &format!("Failed to send exec_result: {e}"));
    }
}

fn release_exec_control_guard(guard: Option<&ExecControlGuard>) {
    if let Some(guard) = guard {
        guard.release();
    }
}

fn send_exec_started(seq: u32, pid: u32, writer: &GuestWriter) -> io::Result<()> {
    let payload = vsock_proto::encode_exec_started(pid).map_err(to_io_error)?;
    let encoded = vsock_proto::encode(MSG_EXEC_STARTED, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&encoded)
}

fn send_exec_result_after_lock<F>(
    frame: ExecResultFrame<'_>,
    writer: &GuestWriter,
    after_lock: F,
) -> io::Result<()>
where
    F: FnOnce(),
{
    let payload = vsock_proto::encode_exec_result(
        frame.termination,
        frame.duration_ms,
        frame.stdout,
        frame.stderr,
        frame.diagnostic,
    )
    .map_err(to_io_error)?;
    let encoded = vsock_proto::encode(MSG_EXEC_RESULT, frame.seq, &payload).map_err(to_io_error)?;
    writer.write_frame_after_lock(&encoded, after_lock)
}

fn captured_output(result: &BoundedDrainResult) -> ExecCapturedOutput<'_> {
    match result.captured.as_deref() {
        Some(bytes) => ExecCapturedOutput::Captured {
            bytes,
            truncated: result.capture_truncated,
        },
        None => ExecCapturedOutput::Discarded,
    }
}

fn empty_output_for_policy(policy: ExecOutputPolicy) -> ExecCapturedOutput<'static> {
    match policy {
        ExecOutputPolicy::Capture { .. } | ExecOutputPolicy::CaptureAndStream { .. } => {
            ExecCapturedOutput::Captured {
                bytes: &[],
                truncated: false,
            }
        }
        ExecOutputPolicy::Discard | ExecOutputPolicy::Stream { .. } => {
            ExecCapturedOutput::Discarded
        }
    }
}

fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn duration_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn exec_termination_is_notable(termination: ExecTermination, expected_exit_codes: &[i32]) -> bool {
    !matches!(
        termination,
        ExecTermination::Exited { exit_code }
            if exit_code == 0 || expected_exit_codes.contains(&exit_code)
    )
}

fn log_exec_terminal_if_notable(
    request: &ExecOperationWorkerRequest,
    started: Instant,
    termination: ExecTermination,
    stdout_result: &BoundedDrainResult,
    stderr_result: &BoundedDrainResult,
    diagnostic: &str,
) {
    let elapsed = started.elapsed();
    let slow = elapsed >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD;
    let notable = exec_termination_is_notable(termination, &request.expected_exit_codes)
        || stdout_result.capture_truncated
        || stderr_result.capture_truncated
        || !diagnostic.is_empty();

    if !slow && !notable {
        return;
    }

    log(
        "WARN",
        &format!(
            "exec result: seq={} label={} elapsed_ms={} termination={:?} stdout_len={} stderr_len={} stdout_truncated={} stderr_truncated={} diagnostic_present={}",
            request.seq,
            truncate_command_preview(&request.label),
            elapsed.as_millis(),
            termination,
            stdout_result.captured.as_ref().map_or(0, Vec::len),
            stderr_result.captured.as_ref().map_or(0, Vec::len),
            stdout_result.capture_truncated,
            stderr_result.capture_truncated,
            !diagnostic.is_empty(),
        ),
    );
}

fn join_output_writer(handle: Option<JoinHandle<()>>) {
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

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

    fn request(seq: u32, command: &str) -> ExecOperationWorkerRequest {
        ExecOperationWorkerRequest {
            seq,
            lifecycle: ExecOperationLifecycle::OneShot,
            timeout: ExecOperationTimeout::Duration { timeout_ms: 0 },
            command: command.to_string(),
            env: Vec::new(),
            sudo: false,
            label: "test".to_string(),
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: Vec::new(),
            stdin_bytes: None,
            control: ExecControlPolicy::Disabled,
            exec_control_guard: None,
            exec_control_bootstrap_endpoint: None,
        }
    }

    fn operation_guard() -> OperationGuard {
        crate::quiesce::OperationState::default().acquire().unwrap()
    }

    fn assert_registry_released(registry: &ExecOperationRegistry, seq: u32) {
        let registration = registry.register(seq, "test");
        assert!(
            registration.is_ok(),
            "exec operation registry entry for seq={seq} was not released"
        );
    }

    #[test]
    fn exec_termination_notable_tracks_nonzero_exit() {
        assert!(!exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 0 },
            &[]
        ));
        assert!(exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 1 },
            &[]
        ));
        assert!(!exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 66 },
            &[66]
        ));
        assert!(exec_termination_is_notable(
            ExecTermination::TimedOut,
            &[124]
        ));
    }

    #[test]
    fn registry_rejects_duplicate_active_sequence_and_cleans_on_drop() {
        let registry = ExecOperationRegistry::default();
        let first = registry.register(7, "first").unwrap();
        assert!(registry.register(7, "duplicate").is_err());
        drop(first);
        assert!(registry.register(7, "second").is_ok());
    }

    #[test]
    fn registry_cancel_sets_token_and_unknown_cancel_is_noop() {
        let registry = ExecOperationRegistry::default();
        let registration = registry.register(8, "cancel-me").unwrap();
        assert_eq!(registry.cancel(8).as_deref(), Some("cancel-me"));
        assert!(registration.cancel.load(Ordering::Acquire));
        assert!(registry.cancel(9).is_none());
    }

    #[test]
    fn registry_cancel_returns_truncated_label_preview() {
        let registry = ExecOperationRegistry::default();
        let long_label = format!("{}🔥tail", "a".repeat(99));
        let registration = registry.register(10, &long_label).unwrap();

        let preview = registry.cancel(10).unwrap();
        assert_eq!(preview, truncate_command_preview(&long_label));
        assert!(preview.ends_with("..."));
        assert!(preview.len() < long_label.len());
        assert!(!preview.contains('🔥'));
        assert!(registration.cancel.load(Ordering::Acquire));
    }

    #[test]
    fn exec_operation_worker_spawn_failure_returns_start_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();

        start_exec_operation_with_spawner(
            request(42, "echo should-not-run"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_WORKER),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 42);
        let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::StartFailed);
        assert!(result.diagnostic.contains("exec operation worker thread"));
        assert_registry_released(&registry, 42);
    }

    #[test]
    fn duplicate_active_exec_operation_returns_error() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let _registration = registry.register(11, "duplicate").unwrap();

        start_exec_operation_with_spawner(
            request(11, "echo duplicate"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry,
            SystemThreadSpawner,
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_ERROR);
        let error = vsock_proto::decode_error(&msg.payload).unwrap();
        assert!(error.contains("already active"));
    }

    #[test]
    fn stdout_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();

        start_exec_operation_with_spawner(
            request(43, "sleep 60"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDOUT),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 43);
        let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("stdout drain thread"));
        assert_registry_released(&registry, 43);
    }

    #[test]
    fn stdin_writer_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let mut request = request(46, "sleep 60");
        request.stdin_bytes = Some(b"stdin".to_vec());

        start_exec_operation_with_spawner(
            request,
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDIN),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 46);
        let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("stdin writer thread"));
        assert_registry_released(&registry, 46);
    }

    #[test]
    fn stdin_writer_cancel_unblocks_full_pipe() {
        let mut fds = [0; 2];
        // SAFETY: `pipe` initializes two file descriptors in `fds` on success.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: both descriptors were freshly returned by `pipe`.
        let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        // SAFETY: both descriptors were freshly returned by `pipe`.
        let mut write_file = unsafe { File::from_raw_fd(fds[1]) };
        set_nonblocking(write_file.as_raw_fd()).unwrap();

        let fill = [0u8; 4096];
        loop {
            match write_file.write(&fill) {
                Ok(0) => panic!("pipe write returned zero while filling"),
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("failed to fill pipe: {e}"),
            }
        }

        let writer =
            spawn_exec_operation_stdin(write_file, b"blocked".to_vec(), SystemThreadSpawner)
                .unwrap();
        request_stdin_writer_cancel(&writer);
        if let Err(e) = writer.done_rx.recv_timeout(Duration::from_secs(5)) {
            drop(read_fd);
            join_stdin_writer(writer, 0, "");
            panic!("stdin writer cancel did not wake blocked writer: {e}");
        }
        join_stdin_writer(writer, 0, "");
        drop(read_fd);
    }

    #[test]
    fn stdin_cancel_pipe_is_nonblocking_and_close_on_exec() {
        let (read_fd, write_fd) = stdin_cancel_pipe().unwrap();

        for fd in [read_fd.as_raw_fd(), write_fd.as_raw_fd()] {
            // SAFETY: fd is open for the duration of this assertion.
            let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            assert!(status_flags >= 0);
            assert_ne!(status_flags & libc::O_NONBLOCK, 0);

            // SAFETY: fd is open for the duration of this assertion.
            let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(descriptor_flags >= 0);
            assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
        }
    }

    #[test]
    fn stderr_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();

        start_exec_operation_with_spawner(
            request(45, "sleep 60"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDERR),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 45);
        let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("stderr drain thread"));
        assert_registry_released(&registry, 45);
    }

    #[test]
    fn output_writer_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let mut request = request(44, "sleep 60");
        request.stdout = ExecOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        };

        start_exec_operation_with_spawner(
            request,
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_OUTPUT),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 44);
        let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("output writer thread"));
        assert_registry_released(&registry, 44);
    }
}
