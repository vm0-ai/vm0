use std::io::{self, Write};
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
    DRAIN_DEADLINE_SECS, WaitOutcome, await_drain_deadline,
    wait_with_kill_timeout_or_cancelled_either,
};
use crate::writer::GuestWriter;

const THREAD_BOUNDED_EXEC_WORKER: &str = "vsock-bounded-exec-worker";
const THREAD_BOUNDED_STDOUT: &str = "vsock-bounded-stdout";
const THREAD_BOUNDED_STDERR: &str = "vsock-bounded-stderr";
const THREAD_BOUNDED_STDIN: &str = "vsock-bounded-stdin";
const STREAM_CHUNK_WRITE_DEADLINE: Duration = Duration::from_secs(2);

pub(crate) struct BoundedExecWorkerRequest {
    pub(crate) seq: u32,
    pub(crate) timeout_ms: u32,
    pub(crate) command: String,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) sudo: bool,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) stdout_limit_bytes: u32,
    pub(crate) stderr_limit_bytes: u32,
    pub(crate) stream_stdout: bool,
    pub(crate) stream_stderr: bool,
    pub(crate) stream_chunk_limit_bytes: u32,
    pub(crate) stdout_stream_limit_bytes: u32,
    pub(crate) stderr_stream_limit_bytes: u32,
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
            stdout_limit_bytes: decoded.stdout_limit_bytes,
            stderr_limit_bytes: decoded.stderr_limit_bytes,
            stream_stdout: decoded.stream_stdout,
            stream_stderr: decoded.stream_stderr,
            stream_chunk_limit_bytes: decoded.stream_chunk_limit_bytes,
            stdout_stream_limit_bytes: decoded.stdout_stream_limit_bytes,
            stderr_stream_limit_bytes: decoded.stderr_stream_limit_bytes,
        }
    }
}

struct BoundedDrainWorker {
    seq: u32,
    stream: BoundedExecStream,
    final_limit_bytes: usize,
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
    stdout: &'a [u8],
    stderr: &'a [u8],
    stdout_truncated: bool,
    stderr_truncated: bool,
}

pub(crate) fn spawn_bounded_exec_worker(
    request: BoundedExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
) -> io::Result<()> {
    spawn_bounded_exec_worker_with_spawner(request, writer, connection_cancel, SystemThreadSpawner)
}

fn spawn_bounded_exec_worker_with_spawner<S>(
    request: BoundedExecWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let seq = request.seq;
    let worker_writer = writer.clone();
    let worker_spawner = spawner.clone();
    let result = spawner.spawn_unit(
        THREAD_BOUNDED_EXEC_WORKER,
        Box::new(move || {
            run_bounded_exec(request, worker_writer, connection_cancel, worker_spawner);
        }),
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let stderr = format!("Failed to spawn bounded exec worker thread: {e}");
            send_bounded_exec_result(
                BoundedExecResultFrame {
                    seq,
                    termination: BoundedExecTermination::StartFailed,
                    duration_ms: 0,
                    stdout: &[],
                    stderr: stderr.as_bytes(),
                    stdout_truncated: false,
                    stderr_truncated: false,
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
    spawner: S,
) where
    S: ThreadSpawner,
{
    log(
        "INFO",
        &format!(
            "bounded_exec: {} (timeout={}ms, sudo={}, stdin={}, stdout_limit={}, stderr_limit={}, stream_stdout={}, stream_stderr={}, {})",
            truncate_preview(&request.command),
            request.timeout_ms,
            request.sudo,
            request.stdin.as_ref().map_or(0, Vec::len),
            request.stdout_limit_bytes,
            request.stderr_limit_bytes,
            request.stream_stdout,
            request.stream_stderr,
            format_env_diagnostics(&request.command, &env_refs(&request.env)),
        ),
    );

    let started = Instant::now();
    if let Err(error) = validate_request(&request) {
        send_final_best_effort(
            request.seq,
            BoundedExecTermination::StartFailed,
            duration_ms(started),
            &BoundedDrainResult::default(),
            &BoundedDrainResult {
                output: error.into_bytes(),
                truncated: false,
            },
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
    ) {
        Ok(spawned) => spawned,
        Err(e) => {
            let stderr = format!(
                "Failed to execute: {e} ({})",
                format_env_diagnostics(&request.command, &env_refs)
            );
            let _ = send_bounded_exec_result(
                BoundedExecResultFrame {
                    seq: request.seq,
                    termination: BoundedExecTermination::StartFailed,
                    duration_ms: duration_ms(started),
                    stdout: &[],
                    stderr: stderr.as_bytes(),
                    stdout_truncated: false,
                    stderr_truncated: false,
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

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            kill_and_send_wait_failed(request.seq, started, child, "missing stdout pipe", &writer);
            return;
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            kill_and_send_wait_failed(request.seq, started, child, "missing stderr pipe", &writer);
            return;
        }
    };
    let stdin = if request.stdin.is_some() {
        match child.stdin.take() {
            Some(stdin) => Some(stdin),
            None => {
                kill_and_send_wait_failed(
                    request.seq,
                    started,
                    child,
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
    let (drain_done_tx, drain_done_rx) = mpsc::channel::<()>();

    let stdout_rx = spawn_bounded_drain(
        stdout,
        BoundedDrainWorker {
            seq: request.seq,
            stream: BoundedExecStream::Stdout,
            final_limit_bytes: request.stdout_limit_bytes as usize,
            stream_config: stream_config(
                request.stream_stdout,
                request.stream_chunk_limit_bytes,
                request.stdout_stream_limit_bytes,
            ),
            writer: writer.clone(),
            drain_cancel: drain_cancel.clone(),
            command_cancel: command_cancel.clone(),
            drain_done_tx: drain_done_tx.clone(),
        },
        spawner.clone(),
    );
    let (stdout_handle, stdout_result_rx) = match stdout_rx {
        Ok(parts) => parts,
        Err(e) => {
            drain_cancel.store(true, Ordering::Release);
            kill_and_send_wait_failed(
                request.seq,
                started,
                child,
                &format!("failed to spawn stdout drain thread: {e}"),
                &writer,
            );
            return;
        }
    };

    let stderr_rx = spawn_bounded_drain(
        stderr,
        BoundedDrainWorker {
            seq: request.seq,
            stream: BoundedExecStream::Stderr,
            final_limit_bytes: request.stderr_limit_bytes as usize,
            stream_config: stream_config(
                request.stream_stderr,
                request.stream_chunk_limit_bytes,
                request.stderr_stream_limit_bytes,
            ),
            writer: writer.clone(),
            drain_cancel: drain_cancel.clone(),
            command_cancel: command_cancel.clone(),
            drain_done_tx: drain_done_tx.clone(),
        },
        spawner.clone(),
    );
    let (stderr_handle, stderr_result_rx) = match stderr_rx {
        Ok(parts) => parts,
        Err(e) => {
            drain_cancel.store(true, Ordering::Release);
            kill_and_reap_child(child);
            let _ = stdout_handle.join();
            let _ = send_bounded_exec_result(
                BoundedExecResultFrame {
                    seq: request.seq,
                    termination: BoundedExecTermination::WaitFailed,
                    duration_ms: duration_ms(started),
                    stdout: &[],
                    stderr: format!("failed to spawn stderr drain thread: {e}").as_bytes(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                },
                &writer,
            );
            return;
        }
    };

    let stdin_worker = match (stdin, request.stdin) {
        (Some(stdin), Some(stdin_bytes)) => {
            match spawn_stdin_writer(stdin, stdin_bytes, command_cancel.clone(), spawner.clone()) {
                Ok(worker) => Some(worker),
                Err(e) => {
                    drain_cancel.store(true, Ordering::Release);
                    command_cancel.store(true, Ordering::Release);
                    kill_and_reap_child(child);
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    let _ = send_bounded_exec_result(
                        BoundedExecResultFrame {
                            seq: request.seq,
                            termination: BoundedExecTermination::WaitFailed,
                            duration_ms: duration_ms(started),
                            stdout: &[],
                            stderr: format!("failed to spawn stdin writer thread: {e}").as_bytes(),
                            stdout_truncated: false,
                            stderr_truncated: false,
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

    let outcome = wait_with_kill_timeout_or_cancelled_either(
        child,
        request.timeout_ms,
        &connection_cancel,
        &command_cancel,
    );
    if matches!(outcome, WaitOutcome::Cancelled)
        || connection_cancel.load(Ordering::Acquire)
        || command_cancel.load(Ordering::Acquire)
    {
        drain_cancel.store(true, Ordering::Release);
    }

    let completed = await_drain_deadline(&drain_done_rx, 2, &drain_cancel);
    if completed < 2 {
        log(
            "WARN",
            &format!("bounded_exec: drain deadline reached after {DRAIN_DEADLINE_SECS}s",),
        );
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();
    let stdin_error_rx = stdin_worker.map(|(stdin_handle, stdin_error_rx)| {
        let _ = stdin_handle.join();
        stdin_error_rx
    });
    let stdout_result = stdout_result_rx.recv().unwrap_or_default();
    let mut stderr_result = stderr_result_rx.recv().unwrap_or_default();

    let mut termination = match outcome {
        WaitOutcome::Exited(status) => BoundedExecTermination::Exited {
            exit_code: crate::process::extract_exit_code(status),
        },
        WaitOutcome::TimedOut => BoundedExecTermination::TimedOut,
        WaitOutcome::Cancelled => BoundedExecTermination::Cancelled,
        WaitOutcome::WaitFailed(msg) => {
            if stderr_result.output.is_empty() {
                stderr_result.output = format!("Failed to wait: {msg}").into_bytes();
                stderr_result.truncated = false;
            }
            BoundedExecTermination::WaitFailed
        }
    };

    if let Some(stdin_error_rx) = stdin_error_rx
        && let Ok(stdin_error) = stdin_error_rx.try_recv()
    {
        termination = BoundedExecTermination::WaitFailed;
        stderr_result.output = format!("Failed to write stdin: {stdin_error}").into_bytes();
        stderr_result.truncated = false;
    }

    log(
        "INFO",
        &format!(
            "bounded_exec result: termination={termination:?}, stdout_len={}, stderr_len={}, stdout_truncated={}, stderr_truncated={}",
            stdout_result.output.len(),
            stderr_result.output.len(),
            stdout_result.truncated,
            stderr_result.truncated,
        ),
    );

    send_final_best_effort(
        request.seq,
        termination,
        duration_ms(started),
        &stdout_result,
        &stderr_result,
        &writer,
    );
}

fn validate_request(request: &BoundedExecWorkerRequest) -> Result<(), String> {
    let stdout_limit = request.stdout_limit_bytes as usize;
    let stderr_limit = request.stderr_limit_bytes as usize;
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

    if request.stream_stdout || request.stream_stderr {
        let stream_chunk_limit = request.stream_chunk_limit_bytes as usize;
        if stream_chunk_limit < vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES {
            return Err(format!(
                "bounded exec stream chunk limit below minimum: {} < {}",
                request.stream_chunk_limit_bytes,
                vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES
            ));
        }
        if stream_chunk_limit > vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES {
            return Err(format!(
                "bounded exec stream chunk limit exceeds protocol frame: {} > {}",
                request.stream_chunk_limit_bytes,
                vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES
            ));
        }
    }

    Ok(())
}

fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn stream_config(
    enabled: bool,
    chunk_limit_bytes: u32,
    stream_limit_bytes: u32,
) -> Option<BoundedStreamConfig> {
    enabled.then_some(BoundedStreamConfig {
        chunk_limit_bytes: chunk_limit_bytes as usize,
        stream_limit_bytes: stream_limit_bytes as usize,
    })
}

fn spawn_bounded_drain<R, S>(
    pipe: R,
    worker: BoundedDrainWorker,
    spawner: S,
) -> io::Result<(JoinHandle<()>, mpsc::Receiver<BoundedDrainResult>)>
where
    R: std::os::unix::io::AsRawFd + Send + 'static,
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

fn spawn_stdin_writer<S>(
    mut stdin: ChildStdin,
    stdin_bytes: Vec<u8>,
    command_cancel: Arc<AtomicBool>,
    spawner: S,
) -> io::Result<(JoinHandle<()>, mpsc::Receiver<String>)>
where
    S: ThreadSpawner,
{
    let (error_tx, error_rx) = mpsc::channel();
    let handle = spawner.spawn_unit(
        THREAD_BOUNDED_STDIN,
        Box::new(move || {
            let write_result = stdin.write_all(&stdin_bytes);
            drop(stdin);
            if let Err(e) = write_result {
                if e.kind() == io::ErrorKind::BrokenPipe {
                    return;
                }
                let _ = error_tx.send(e.to_string());
                command_cancel.store(true, Ordering::Release);
            }
        }),
    )?;
    Ok((handle, error_rx))
}

fn kill_and_send_wait_failed(
    seq: u32,
    started: Instant,
    child: Child,
    error: &str,
    writer: &GuestWriter,
) {
    kill_and_reap_child(child);
    let _ = send_bounded_exec_result(
        BoundedExecResultFrame {
            seq,
            termination: BoundedExecTermination::WaitFailed,
            duration_ms: duration_ms(started),
            stdout: &[],
            stderr: error.as_bytes(),
            stdout_truncated: false,
            stderr_truncated: false,
        },
        writer,
    );
}

fn send_final_best_effort(
    seq: u32,
    termination: BoundedExecTermination,
    duration_ms: u64,
    stdout: &BoundedDrainResult,
    stderr: &BoundedDrainResult,
    writer: &GuestWriter,
) {
    if let Err(e) = send_bounded_exec_result(
        BoundedExecResultFrame {
            seq,
            termination,
            duration_ms,
            stdout: &stdout.output,
            stderr: &stderr.output,
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
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
        stdout_truncated,
        stderr_truncated,
    } = frame;
    let payload = match vsock_proto::encode_bounded_exec_result(
        termination,
        duration_ms,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
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
                &[],
                diagnostic.as_bytes(),
                false,
                false,
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
