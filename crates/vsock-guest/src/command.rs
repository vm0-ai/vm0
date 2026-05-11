use std::collections::HashMap;
use std::io;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use vsock_proto::{
    self, CommandCapturedOutput, CommandOutputPolicy, CommandOutputStream, CommandTermination,
    MSG_COMMAND_OUTPUT, MSG_COMMAND_RESULT, MSG_ERROR,
};

use crate::drain::{BoundedDrainResult, BoundedStreamConfig, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::exec::{format_env_diagnostics, spawn_with_pipes, truncate_preview};
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child};
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::wait::{
    DRAIN_DEADLINE_SECS, WaitOutcome, await_drain_deadline,
    wait_with_kill_timeout_or_cancelled_either,
};
use crate::writer::GuestWriter;

const THREAD_COMMAND_WORKER: &str = "vsock-command-worker";
const THREAD_COMMAND_STDOUT: &str = "vsock-command-stdout";
const THREAD_COMMAND_STDERR: &str = "vsock-command-stderr";
const THREAD_COMMAND_OUTPUT: &str = "vsock-command-output";
const OUTPUT_CHANNEL_CAPACITY: usize = 32;
const FRAME_BODY_HEADER_LEN: usize = 1 + 4; // message type + sequence
const COMMAND_OUTPUT_PAYLOAD_OVERHEAD: usize = 1 + 4 + 1 + 4;
const COMMAND_RESULT_EXITED_LEN: usize = 1 + 4;
const COMMAND_RESULT_DURATION_LEN: usize = 4;
const COMMAND_RESULT_DIAGNOSTIC_LEN_FIELD: usize = 2;
const COMMAND_RESULT_MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;
const COMMAND_CAPTURED_OUTPUT_OVERHEAD: usize = 1 + 1 + 4;
const COMMAND_DISCARDED_OUTPUT_LEN: usize = 1;

#[derive(Clone, Default)]
pub(crate) struct CommandRegistry {
    inner: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
}

impl CommandRegistry {
    pub(crate) fn register(&self, seq: u32) -> Result<CommandRegistration, ()> {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&seq) {
            return Err(());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        active.insert(seq, cancel.clone());
        Ok(CommandRegistration {
            registry: self.clone(),
            seq,
            cancel,
        })
    }

    pub(crate) fn cancel(&self, seq: u32) -> bool {
        let active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(cancel) = active.get(&seq) else {
            return false;
        };
        cancel.store(true, Ordering::Release);
        true
    }

    fn remove_if_same(&self, seq: u32, cancel: &Arc<AtomicBool>) {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active
            .get(&seq)
            .is_some_and(|existing| Arc::ptr_eq(existing, cancel))
        {
            active.remove(&seq);
        }
    }
}

pub(crate) struct CommandRegistration {
    registry: CommandRegistry,
    seq: u32,
    cancel: Arc<AtomicBool>,
}

impl CommandRegistration {
    fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    fn complete(&self) {
        self.registry.remove_if_same(self.seq, &self.cancel);
    }
}

impl Drop for CommandRegistration {
    fn drop(&mut self) {
        self.complete();
    }
}

#[derive(Clone, Copy)]
struct WaitFailureContext<'a> {
    seq: u32,
    started: Instant,
    stdout_policy: CommandOutputPolicy,
    stderr_policy: CommandOutputPolicy,
    registration: &'a CommandRegistration,
    writer: &'a GuestWriter,
}

pub(crate) struct CommandWorkerRequest {
    seq: u32,
    timeout_ms: u32,
    command: String,
    env: Vec<(String, String)>,
    sudo: bool,
    label: String,
    stdout: CommandOutputPolicy,
    stderr: CommandOutputPolicy,
}

impl CommandWorkerRequest {
    pub(crate) fn from_decoded(seq: u32, decoded: vsock_proto::DecodedCommandStart<'_>) -> Self {
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
            label: decoded.label.to_owned(),
            stdout: decoded.stdout,
            stderr: decoded.stderr,
        }
    }
}

struct DrainWorker {
    stream: CommandOutputStream,
    policy: OutputSettings,
    output_tx: Option<SyncSender<StreamEvent>>,
    drain_cancel: Arc<AtomicBool>,
    command_cancel: Arc<AtomicBool>,
    drain_done_tx: mpsc::Sender<()>,
}

struct StreamEvent {
    stream: CommandOutputStream,
    chunk: Vec<u8>,
    truncated: bool,
}

#[derive(Clone, Copy)]
struct OutputSettings {
    capture_limit_bytes: Option<usize>,
    stream: Option<BoundedStreamConfig>,
}

struct CommandResultFrame<'a> {
    seq: u32,
    termination: CommandTermination,
    duration_ms: u32,
    stdout: CommandCapturedOutput<'a>,
    stderr: CommandCapturedOutput<'a>,
    diagnostic: &'a str,
}

pub(crate) fn start_command_operation(
    request: CommandWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    registry: CommandRegistry,
) -> io::Result<()> {
    start_command_operation_with_spawner(
        request,
        writer,
        connection_cancel,
        registry,
        SystemThreadSpawner,
    )
}

fn start_command_operation_with_spawner<S>(
    request: CommandWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    registry: CommandRegistry,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let seq = request.seq;
    let registration = match registry.register(seq) {
        Ok(registration) => registration,
        Err(()) => {
            return send_command_error(seq, "command operation already active", &writer);
        }
    };
    let command_cancel = registration.cancel_token();
    let stdout_policy = request.stdout;
    let stderr_policy = request.stderr;
    let worker_writer = writer.clone();
    let worker_spawner = spawner.clone();
    let result = spawner.spawn_unit(
        THREAD_COMMAND_WORKER,
        Box::new(move || {
            run_command_worker(
                request,
                worker_writer,
                connection_cancel,
                command_cancel,
                registration,
                worker_spawner,
            );
        }),
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let diagnostic = format!("Failed to spawn command worker thread: {e}");
            send_command_result(
                CommandResultFrame {
                    seq,
                    termination: CommandTermination::StartFailed,
                    duration_ms: 0,
                    stdout: empty_output_for_policy(stdout_policy),
                    stderr: empty_output_for_policy(stderr_policy),
                    diagnostic: &diagnostic,
                },
                &writer,
            )
        }
    }
}

pub(crate) fn cancel_command_operation(registry: &CommandRegistry, seq: u32) {
    if registry.cancel(seq) {
        log("INFO", &format!("command: cancelled seq={seq}"));
    }
}

pub(crate) fn send_command_error(seq: u32, message: &str, writer: &GuestWriter) -> io::Result<()> {
    let payload = vsock_proto::encode_error(message);
    let response = vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&response)
}

fn run_command_worker<S>(
    request: CommandWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    command_cancel: Arc<AtomicBool>,
    registration: CommandRegistration,
    spawner: S,
) where
    S: ThreadSpawner,
{
    log(
        "INFO",
        &format!(
            "command: label={} {} (timeout={}ms, sudo={}, {})",
            truncate_preview(&request.label),
            truncate_preview(&request.command),
            request.timeout_ms,
            request.sudo,
            format_env_diagnostics(&request.command, &env_refs(&request.env)),
        ),
    );

    let started = Instant::now();
    if let Err(diagnostic) = validate_request(&request) {
        send_final_and_complete(
            &registration,
            CommandResultFrame {
                seq: request.seq,
                termination: CommandTermination::StartFailed,
                duration_ms: duration_ms(started),
                stdout: empty_output_for_policy(request.stdout),
                stderr: empty_output_for_policy(request.stderr),
                diagnostic: &diagnostic,
            },
            &writer,
        );
        return;
    }

    let env_refs = env_refs(&request.env);
    let spawned = match spawn_with_pipes(&request.command, &env_refs, request.sudo) {
        Ok(spawned) => spawned,
        Err(e) => {
            let diagnostic = format!(
                "Failed to execute: {e} ({})",
                format_env_diagnostics(&request.command, &env_refs)
            );
            send_final_and_complete(
                &registration,
                CommandResultFrame {
                    seq: request.seq,
                    termination: CommandTermination::StartFailed,
                    duration_ms: duration_ms(started),
                    stdout: empty_output_for_policy(request.stdout),
                    stderr: empty_output_for_policy(request.stderr),
                    diagnostic: &diagnostic,
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
    let failure = WaitFailureContext {
        seq: request.seq,
        started,
        stdout_policy: request.stdout,
        stderr_policy: request.stderr,
        registration: &registration,
        writer: &writer,
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_and_send_wait_failed(child, "missing stdout pipe", failure);
            return;
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            kill_and_send_wait_failed(child, "missing stderr pipe", failure);
            return;
        }
    };

    let stdout_settings = output_settings(request.stdout);
    let stderr_settings = output_settings(request.stderr);
    let needs_stream = stdout_settings.stream.is_some() || stderr_settings.stream.is_some();
    let drain_cancel = Arc::new(AtomicBool::new(false));
    let (drain_done_tx, drain_done_rx) = mpsc::channel::<()>();

    let (output_tx, output_handle) = if needs_stream {
        let (tx, rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
        match spawn_output_writer(
            request.seq,
            rx,
            writer.clone(),
            command_cancel.clone(),
            drain_cancel.clone(),
            spawner.clone(),
        ) {
            Ok(handle) => (Some(tx), Some(handle)),
            Err(e) => {
                kill_and_send_wait_failed(
                    child,
                    &format!("failed to spawn command output writer thread: {e}"),
                    failure,
                );
                return;
            }
        }
    } else {
        (None, None)
    };

    let stdout_spawn = spawn_command_drain(
        stdout,
        DrainWorker {
            stream: CommandOutputStream::Stdout,
            policy: stdout_settings,
            output_tx: output_tx.clone(),
            drain_cancel: drain_cancel.clone(),
            command_cancel: command_cancel.clone(),
            drain_done_tx: drain_done_tx.clone(),
        },
        spawner.clone(),
    );
    let (stdout_handle, stdout_result_rx) = match stdout_spawn {
        Ok(parts) => parts,
        Err(e) => {
            drain_cancel.store(true, Ordering::Release);
            drop(output_tx);
            kill_and_send_wait_failed(
                child,
                &format!("failed to spawn stdout drain thread: {e}"),
                failure,
            );
            join_output_writer(output_handle);
            return;
        }
    };

    let stderr_spawn = spawn_command_drain(
        stderr,
        DrainWorker {
            stream: CommandOutputStream::Stderr,
            policy: stderr_settings,
            output_tx: output_tx.clone(),
            drain_cancel: drain_cancel.clone(),
            command_cancel: command_cancel.clone(),
            drain_done_tx: drain_done_tx.clone(),
        },
        spawner.clone(),
    );
    let (stderr_handle, stderr_result_rx) = match stderr_spawn {
        Ok(parts) => parts,
        Err(e) => {
            command_cancel.store(true, Ordering::Release);
            drain_cancel.store(true, Ordering::Release);
            drop(output_tx);
            kill_and_reap_child(child);
            let _ = stdout_handle.join();
            join_output_writer(output_handle);
            send_final_and_complete(
                &registration,
                CommandResultFrame {
                    seq: request.seq,
                    termination: CommandTermination::WaitFailed,
                    duration_ms: duration_ms(started),
                    stdout: empty_output_for_policy(request.stdout),
                    stderr: empty_output_for_policy(request.stderr),
                    diagnostic: &format!("failed to spawn stderr drain thread: {e}"),
                },
                &writer,
            );
            return;
        }
    };
    drop(drain_done_tx);
    drop(output_tx);

    let outcome = wait_with_kill_timeout_or_cancelled_either(
        child,
        request.timeout_ms,
        &connection_cancel,
        &command_cancel,
    );
    if matches!(outcome, WaitOutcome::Cancelled | WaitOutcome::TimedOut)
        || connection_cancel.load(Ordering::Acquire)
        || command_cancel.load(Ordering::Acquire)
    {
        command_cancel.store(true, Ordering::Release);
        drain_cancel.store(true, Ordering::Release);
    }

    let completed = await_drain_deadline(&drain_done_rx, 2, &drain_cancel);
    if completed < 2 {
        log(
            "WARN",
            &format!("command: drain deadline reached after {DRAIN_DEADLINE_SECS}s"),
        );
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();
    join_output_writer(output_handle);
    let stdout_result = stdout_result_rx.recv().unwrap_or_default();
    let stderr_result = stderr_result_rx.recv().unwrap_or_default();

    let (termination, diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            CommandTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            String::new(),
        ),
        WaitOutcome::TimedOut => (CommandTermination::TimedOut, String::new()),
        WaitOutcome::Cancelled => (CommandTermination::Cancelled, String::new()),
        WaitOutcome::WaitFailed(msg) => (
            CommandTermination::WaitFailed,
            format!("Failed to wait: {msg}"),
        ),
    };

    log(
        "INFO",
        &format!(
            "command result: seq={}, termination={:?}, stdout_len={}, stderr_len={}, stdout_truncated={}, stderr_truncated={}",
            request.seq,
            termination,
            stdout_result.captured.as_ref().map_or(0, Vec::len),
            stderr_result.captured.as_ref().map_or(0, Vec::len),
            stdout_result.capture_truncated,
            stderr_result.capture_truncated,
        ),
    );

    send_final_and_complete(
        &registration,
        CommandResultFrame {
            seq: request.seq,
            termination,
            duration_ms: duration_ms(started),
            stdout: captured_output(&stdout_result),
            stderr: captured_output(&stderr_result),
            diagnostic: &diagnostic,
        },
        &writer,
    );
}

fn validate_request(request: &CommandWorkerRequest) -> Result<(), String> {
    let stdout_capture = capture_limit_bytes(request.stdout);
    let stderr_capture = capture_limit_bytes(request.stderr);
    let capture_total = stdout_capture
        .unwrap_or(0)
        .checked_add(stderr_capture.unwrap_or(0))
        .ok_or_else(|| "command capture limits overflow".to_string())?;
    let capture_budget = command_result_capture_budget(request.stdout, request.stderr);
    if capture_total > capture_budget {
        return Err(format!(
            "command capture limits exceed protocol result frame budget: {capture_total} > {capture_budget}"
        ));
    }

    let max_chunk = vsock_proto::MAX_MESSAGE_SIZE
        .saturating_sub(FRAME_BODY_HEADER_LEN)
        .saturating_sub(COMMAND_OUTPUT_PAYLOAD_OVERHEAD);
    for (name, policy) in [("stdout", request.stdout), ("stderr", request.stderr)] {
        if let Some(stream) = stream_config(policy)
            && stream.chunk_limit_bytes > max_chunk
        {
            return Err(format!(
                "command {name} stream chunk limit exceeds protocol frame budget: {} > {max_chunk}",
                stream.chunk_limit_bytes
            ));
        }
    }

    Ok(())
}

fn command_result_capture_budget(
    stdout_policy: CommandOutputPolicy,
    stderr_policy: CommandOutputPolicy,
) -> usize {
    let fixed = FRAME_BODY_HEADER_LEN
        + COMMAND_RESULT_EXITED_LEN
        + COMMAND_RESULT_DURATION_LEN
        + command_result_output_overhead(stdout_policy)
        + command_result_output_overhead(stderr_policy)
        + COMMAND_RESULT_DIAGNOSTIC_LEN_FIELD
        + COMMAND_RESULT_MAX_DIAGNOSTIC_BYTES;
    vsock_proto::MAX_MESSAGE_SIZE.saturating_sub(fixed)
}

fn command_result_output_overhead(policy: CommandOutputPolicy) -> usize {
    if capture_limit_bytes(policy).is_some() {
        COMMAND_CAPTURED_OUTPUT_OVERHEAD
    } else {
        COMMAND_DISCARDED_OUTPUT_LEN
    }
}

fn output_settings(policy: CommandOutputPolicy) -> OutputSettings {
    OutputSettings {
        capture_limit_bytes: capture_limit_bytes(policy),
        stream: stream_config(policy),
    }
}

fn capture_limit_bytes(policy: CommandOutputPolicy) -> Option<usize> {
    match policy {
        CommandOutputPolicy::Discard | CommandOutputPolicy::Stream { .. } => None,
        CommandOutputPolicy::Capture { limit_bytes } => Some(limit_bytes as usize),
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes,
            ..
        } => Some(capture_limit_bytes as usize),
    }
}

fn stream_config(policy: CommandOutputPolicy) -> Option<BoundedStreamConfig> {
    match policy {
        CommandOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        }
        | CommandOutputPolicy::CaptureAndStream {
            stream_limit_bytes: limit_bytes,
            chunk_limit_bytes,
            ..
        } => Some(BoundedStreamConfig {
            chunk_limit_bytes: chunk_limit_bytes as usize,
            stream_limit_bytes: limit_bytes as usize,
        }),
        CommandOutputPolicy::Discard | CommandOutputPolicy::Capture { .. } => None,
    }
}

fn spawn_output_writer<S>(
    seq: u32,
    rx: Receiver<StreamEvent>,
    writer: GuestWriter,
    command_cancel: Arc<AtomicBool>,
    drain_cancel: Arc<AtomicBool>,
    spawner: S,
) -> io::Result<JoinHandle<()>>
where
    S: ThreadSpawner,
{
    spawner.spawn_unit(
        THREAD_COMMAND_OUTPUT,
        Box::new(move || {
            let mut output_seq = 0u32;
            for event in rx {
                if command_cancel.load(Ordering::Acquire) {
                    break;
                }
                let payload = match vsock_proto::encode_command_output(
                    event.stream,
                    output_seq,
                    &event.chunk,
                    event.truncated,
                ) {
                    Ok(payload) => payload,
                    Err(e) => {
                        log("ERROR", &format!("command: failed to encode output: {e}"));
                        command_cancel.store(true, Ordering::Release);
                        drain_cancel.store(true, Ordering::Release);
                        break;
                    }
                };
                output_seq = output_seq.wrapping_add(1);
                let frame = match vsock_proto::encode(MSG_COMMAND_OUTPUT, seq, &payload) {
                    Ok(frame) => frame,
                    Err(e) => {
                        log(
                            "ERROR",
                            &format!("command: failed to encode output frame: {e}"),
                        );
                        command_cancel.store(true, Ordering::Release);
                        drain_cancel.store(true, Ordering::Release);
                        break;
                    }
                };
                if let Err(e) = writer.write_frame(&frame) {
                    log(
                        "WARN",
                        &format!("command: failed to send output chunk: {e}"),
                    );
                    command_cancel.store(true, Ordering::Release);
                    drain_cancel.store(true, Ordering::Release);
                    break;
                }
            }
        }),
    )
}

fn spawn_command_drain<R, S>(
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
        command_cancel,
        drain_done_tx,
    } = worker;
    let (result_tx, result_rx) = mpsc::channel();
    let thread_name = match stream {
        CommandOutputStream::Stdout => THREAD_COMMAND_STDOUT,
        CommandOutputStream::Stderr => THREAD_COMMAND_STDERR,
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
                    if command_cancel.load(Ordering::Acquire)
                        || drain_cancel.load(Ordering::Acquire)
                    {
                        return false;
                    }
                    match tx.send(StreamEvent {
                        stream,
                        chunk: chunk.to_vec(),
                        truncated,
                    }) {
                        Ok(()) => true,
                        Err(_) => {
                            command_cancel.store(true, Ordering::Release);
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

fn kill_and_send_wait_failed(child: Child, diagnostic: &str, failure: WaitFailureContext<'_>) {
    kill_and_reap_child(child);
    send_final_and_complete(
        failure.registration,
        CommandResultFrame {
            seq: failure.seq,
            termination: CommandTermination::WaitFailed,
            duration_ms: duration_ms(failure.started),
            stdout: empty_output_for_policy(failure.stdout_policy),
            stderr: empty_output_for_policy(failure.stderr_policy),
            diagnostic,
        },
        failure.writer,
    );
}

fn send_final_and_complete(
    registration: &CommandRegistration,
    frame: CommandResultFrame<'_>,
    writer: &GuestWriter,
) {
    let result = send_command_result(frame, writer);
    registration.complete();
    if let Err(e) = result {
        log("ERROR", &format!("Failed to send command_result: {e}"));
    }
}

fn send_command_result(frame: CommandResultFrame<'_>, writer: &GuestWriter) -> io::Result<()> {
    let payload = vsock_proto::encode_command_result(
        frame.termination,
        frame.duration_ms,
        frame.stdout,
        frame.stderr,
        frame.diagnostic,
    )
    .map_err(to_io_error)?;
    let encoded =
        vsock_proto::encode(MSG_COMMAND_RESULT, frame.seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&encoded)
}

fn captured_output(result: &BoundedDrainResult) -> CommandCapturedOutput<'_> {
    match result.captured.as_deref() {
        Some(bytes) => CommandCapturedOutput::Captured {
            bytes,
            truncated: result.capture_truncated,
        },
        None => CommandCapturedOutput::Discarded,
    }
}

fn empty_output_for_policy(policy: CommandOutputPolicy) -> CommandCapturedOutput<'static> {
    match policy {
        CommandOutputPolicy::Capture { .. } | CommandOutputPolicy::CaptureAndStream { .. } => {
            CommandCapturedOutput::Captured {
                bytes: &[],
                truncated: false,
            }
        }
        CommandOutputPolicy::Discard | CommandOutputPolicy::Stream { .. } => {
            CommandCapturedOutput::Discarded
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

fn join_output_writer(handle: Option<JoinHandle<()>>) {
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use std::io::Read;
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

    fn request(seq: u32, command: &str) -> CommandWorkerRequest {
        CommandWorkerRequest {
            seq,
            timeout_ms: 0,
            command: command.to_string(),
            env: Vec::new(),
            sudo: false,
            label: "test".to_string(),
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
        }
    }

    fn wait_for_registry_release(registry: &CommandRegistry, seq: u32) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if registry.register(seq).is_ok() {
                return;
            }
            std::thread::yield_now();
        }
        panic!("command registry entry for seq={seq} was not released");
    }

    #[test]
    fn registry_rejects_duplicate_active_sequence_and_cleans_on_drop() {
        let registry = CommandRegistry::default();
        let first = registry.register(7).unwrap();
        assert!(registry.register(7).is_err());
        drop(first);
        assert!(registry.register(7).is_ok());
    }

    #[test]
    fn registry_cancel_sets_token_and_unknown_cancel_is_noop() {
        let registry = CommandRegistry::default();
        let registration = registry.register(8).unwrap();
        assert!(registry.cancel(8));
        assert!(registration.cancel.load(Ordering::Acquire));
        assert!(!registry.cancel(9));
    }

    #[test]
    fn command_worker_spawn_failure_returns_start_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = CommandRegistry::default();

        start_command_operation_with_spawner(
            request(42, "echo should-not-run"),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_COMMAND_WORKER),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_COMMAND_RESULT);
        assert_eq!(msg.seq, 42);
        let result = vsock_proto::decode_command_result(&msg.payload).unwrap();
        assert_eq!(result.termination, CommandTermination::StartFailed);
        assert!(result.diagnostic.contains("command worker thread"));
        wait_for_registry_release(&registry, 42);
    }

    #[test]
    fn duplicate_active_command_returns_error() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = CommandRegistry::default();
        let _registration = registry.register(11).unwrap();

        start_command_operation_with_spawner(
            request(11, "echo duplicate"),
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
        let registry = CommandRegistry::default();

        start_command_operation_with_spawner(
            request(43, "sleep 60"),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_COMMAND_STDOUT),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_COMMAND_RESULT);
        assert_eq!(msg.seq, 43);
        let result = vsock_proto::decode_command_result(&msg.payload).unwrap();
        assert_eq!(result.termination, CommandTermination::WaitFailed);
        assert!(result.diagnostic.contains("stdout drain thread"));
        wait_for_registry_release(&registry, 43);
    }

    #[test]
    fn stderr_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = CommandRegistry::default();

        start_command_operation_with_spawner(
            request(45, "sleep 60"),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_COMMAND_STDERR),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_COMMAND_RESULT);
        assert_eq!(msg.seq, 45);
        let result = vsock_proto::decode_command_result(&msg.payload).unwrap();
        assert_eq!(result.termination, CommandTermination::WaitFailed);
        assert!(result.diagnostic.contains("stderr drain thread"));
        wait_for_registry_release(&registry, 45);
    }

    #[test]
    fn output_writer_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = CommandRegistry::default();
        let mut request = request(44, "sleep 60");
        request.stdout = CommandOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        };

        start_command_operation_with_spawner(
            request,
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_COMMAND_OUTPUT),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_COMMAND_RESULT);
        assert_eq!(msg.seq, 44);
        let result = vsock_proto::decode_command_result(&msg.payload).unwrap();
        assert_eq!(result.termination, CommandTermination::WaitFailed);
        assert!(result.diagnostic.contains("output writer thread"));
        wait_for_registry_release(&registry, 44);
    }
}
