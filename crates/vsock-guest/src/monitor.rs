use std::io::{self, Write};
use std::process::{Child, ChildStdout};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use vsock_proto::{self, MSG_ERROR, MSG_PROCESS_EXIT, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK};

use crate::drain::{drain_into_vec_cancellable, drain_until_eof_or_cancelled};
use crate::error::to_io_error;
use crate::exec::{EnvScriptGuard, format_env_diagnostics, spawn_with_pipes, truncate_preview};
use crate::log::log;
use crate::process::{ChildReapGuard, kill_and_reap_child};
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::wait::{
    DRAIN_DEADLINE_SECS, await_drain_deadline, finalize_buffered_result, finalize_wait_outcome,
    wait_with_drain_and_timeout_or_cancelled_with_spawner, wait_with_kill_timeout_or_cancelled,
};
use crate::writer::GuestWriter;

const THREAD_STREAM_MONITOR: &str = "vsock-stream-monitor";
const THREAD_BUFFERED_MONITOR: &str = "vsock-buffered-monitor";
const THREAD_STREAM_STDERR: &str = "vsock-stream-stderr";
const THREAD_STREAM_STDOUT: &str = "vsock-stream-stdout";

struct StreamingMonitorRequest {
    pid: u32,
    child: Child,
    timeout_ms: u32,
    stdout_pipe: Option<ChildStdout>,
    log_path: Option<String>,
    env_script: Option<EnvScriptGuard>,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
}

struct BufferedMonitorRequest {
    pid: u32,
    child: Child,
    timeout_ms: u32,
    env_script: Option<EnvScriptGuard>,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
}

struct StreamingSetupFailure {
    pid: u32,
    child: Child,
    cancel: Arc<AtomicBool>,
    drain_done_tx: std::sync::mpsc::Sender<()>,
    stderr_handle: Option<JoinHandle<Vec<u8>>>,
    stdout_handle: Option<JoinHandle<()>>,
    env_script: Option<EnvScriptGuard>,
    writer: GuestWriter,
    error: String,
}

pub(crate) struct SpawnWatchRequest<'a> {
    pub(crate) timeout_ms: u32,
    pub(crate) command: &'a str,
    pub(crate) env: &'a [(&'a str, &'a str)],
    pub(crate) sudo: bool,
    pub(crate) stream_stdout: bool,
    pub(crate) stdout_log_path: Option<&'a str>,
}

/// Handle spawn_watch: spawn the child, write `MSG_SPAWN_WATCH_RESULT` over
/// the wire, THEN start the background monitor. Returns immediately; exit is
/// later reported via `MSG_PROCESS_EXIT`.
///
/// When `stream_stdout` is true, stdout is streamed to the host via
/// `MSG_STDOUT_CHUNK` messages. `stdout_log_path`, when present, additionally
/// tees those chunks to a file path inside the VM.
///
/// The result-before-monitor ordering is critical: the streaming monitor
/// thread also writes to the same socket (via the shared `writer` mutex),
/// and `MSG_STDOUT_CHUNK` messages must not arrive at the host before the
/// `MSG_SPAWN_WATCH_RESULT` for this pid — the host only registers the
/// stdout channel when it processes the result, so earlier chunks would
/// be dropped.
pub(crate) fn handle_spawn_watch(
    request: SpawnWatchRequest<'_>,
    seq: u32,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
) -> io::Result<()> {
    handle_spawn_watch_with_spawner(request, seq, writer, connection_cancel, SystemThreadSpawner)
}

fn handle_spawn_watch_with_spawner<S>(
    request: SpawnWatchRequest<'_>,
    seq: u32,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    log(
        "INFO",
        &format!(
            "spawn_watch: {} (timeout={}ms, sudo={}, stream={}, {})",
            truncate_preview(request.command),
            request.timeout_ms,
            request.sudo,
            request.stream_stdout,
            format_env_diagnostics(request.command, request.env),
        ),
    );

    let spawned = match spawn_with_pipes(request.command, request.env, request.sudo) {
        Ok(c) => c,
        Err(e) => {
            let payload = vsock_proto::encode_error(&format!(
                "Failed to spawn: {e} ({})",
                format_env_diagnostics(request.command, request.env)
            ));
            let response = vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
            writer.write_frame(&response)?;
            return Ok(());
        }
    };
    let crate::exec::SpawnedCommand {
        mut child,
        env_script,
    } = spawned;

    let pid = child.id();
    log("INFO", &format!("spawn_watch: started pid={pid}"));

    // Write the response BEFORE spawning the monitor thread.
    // The monitor thread contends for the same writer mutex to send
    // stdout chunks / process_exit. Writing here guarantees the
    // spawn_watch_result is on the wire first.
    //
    // If encoding or writing fails after spawn but before either monitor
    // takes ownership of `child`, we must reap here — `Child`'s `Drop`
    // does not wait, so a `?`-propagated error would leak the child as an
    // orphan/zombie inside the VM.
    let payload = vsock_proto::encode_spawn_watch_result(pid);
    let response = match vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, seq, &payload) {
        Ok(r) => r,
        Err(e) => {
            kill_and_reap_child(child);
            return Err(to_io_error(e));
        }
    };
    if let Err(e) = writer.write_frame(&response) {
        kill_and_reap_child(child);
        return Err(e);
    }

    if request.stream_stdout {
        // Streaming mode: stream stdout to vsock chunks, optionally teeing to a guest file.
        // Take stdout from child so we can read it in a separate thread.
        let stdout_pipe = child.stdout.take();
        if let Err(e) = spawn_streaming_monitor(
            StreamingMonitorRequest {
                pid,
                child,
                timeout_ms: request.timeout_ms,
                stdout_pipe,
                log_path: request.stdout_log_path.map(str::to_owned),
                env_script,
                writer,
                connection_cancel,
            },
            spawner,
        ) {
            log(
                "ERROR",
                &format!("spawn_watch: failed to spawn streaming monitor for pid={pid}: {e}"),
            );
        }
    } else {
        // Buffered mode: stdout/stderr drained via cancellable helper, sent
        // in a single MSG_PROCESS_EXIT after wait.
        if let Err(e) = spawn_buffered_monitor(
            BufferedMonitorRequest {
                pid,
                child,
                timeout_ms: request.timeout_ms,
                env_script,
                writer,
                connection_cancel,
            },
            spawner,
        ) {
            log(
                "ERROR",
                &format!("spawn_watch: failed to spawn buffered monitor for pid={pid}: {e}"),
            );
        }
    }

    Ok(())
}

/// Streaming monitor: streams stdout chunks to vsock, optionally tees stdout
/// chunks to a guest file, drains stderr into a buffer, and races both
/// against `child.wait()`.
///
/// Architecture:
/// - Monitor thread: waits for child exit, timeout, or connection cancellation
/// - Stderr reader thread: drains stderr into a `Vec<u8>` (cancellable)
/// - Stdout reader thread: streams chunks to log + vsock (cancellable)
/// - Drain deadline: after child wait completes, bounds lingering pipe readers
///
/// If a grandchild keeps pipe fds open past child exit, the deadline fires
/// the cancel flag — both reader threads exit promptly, dropping their fds
/// and turning the next grandchild write into EPIPE / SIGPIPE. Without that,
/// the readers would block on the inherited fds and continue forwarding
/// `MSG_STDOUT_CHUNK` for an already-exited pid (or grow our stderr buffer
/// indefinitely).
fn spawn_streaming_monitor(
    request: StreamingMonitorRequest,
    spawner: impl ThreadSpawner,
) -> io::Result<()> {
    spawn_streaming_monitor_with_spawner(request, spawner)
}

fn spawn_streaming_monitor_with_spawner<S>(
    request: StreamingMonitorRequest,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let StreamingMonitorRequest {
        pid,
        child,
        timeout_ms,
        stdout_pipe,
        log_path,
        env_script,
        writer,
        connection_cancel,
    } = request;
    let child_guard = ChildReapGuard::new(child);
    let monitor_spawner = spawner.clone();
    let exit_writer = writer.clone();
    let result = spawner.spawn_unit(
        THREAD_STREAM_MONITOR,
        Box::new(move || {
            let Some(child) = child_guard.into_child() else {
                log(
                    "ERROR",
                    "spawn_watch: streaming monitor child guard was empty",
                );
                return;
            };
            run_streaming_monitor(
                StreamingMonitorRequest {
                    pid,
                    child,
                    timeout_ms,
                    stdout_pipe,
                    log_path,
                    env_script,
                    writer,
                    connection_cancel,
                },
                monitor_spawner,
            );
        }),
    );
    if let Err(e) = &result {
        send_process_exit(
            pid,
            1,
            &[],
            format!("Failed to spawn streaming monitor thread: {e}").as_bytes(),
            &exit_writer,
        );
    }
    result.map(|_| ())
}

fn run_streaming_monitor<S>(request: StreamingMonitorRequest, spawner: S)
where
    S: ThreadSpawner,
{
    let StreamingMonitorRequest {
        pid,
        mut child,
        timeout_ms,
        stdout_pipe,
        log_path,
        env_script,
        writer,
        connection_cancel,
    } = request;
    let _env_script = env_script;
    let cancel = Arc::new(AtomicBool::new(false));
    let (drain_done_tx, drain_done_rx) = std::sync::mpsc::channel::<()>();

    // Spawn both drain threads BEFORE `child.wait()`. They run
    // concurrently with the child, so neither pipe (~64 KB) can fill
    // and block the child. If we instead waited on the child first
    // and drained after, a chatty child would deadlock on its next
    // write to a full pipe and never exit. Order between the two
    // spawn calls is irrelevant — both happen before wait, and they
    // run in parallel.
    let stderr_handle = if let Some(stderr) = child.stderr.take() {
        let drain_cancel = cancel.clone();
        let tx = drain_done_tx.clone();
        match spawner.spawn_vec(
            THREAD_STREAM_STDERR,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stderr, &drain_cancel);
                let _ = tx.send(());
                buf
            }),
        ) {
            Ok(handle) => Some(handle),
            Err(e) => {
                finish_streaming_setup_failure(StreamingSetupFailure {
                    pid,
                    child,
                    cancel,
                    drain_done_tx,
                    stderr_handle: None,
                    stdout_handle: None,
                    env_script: _env_script,
                    writer,
                    error: format!("Failed to spawn stderr drain thread: {e}"),
                });
                return;
            }
        }
    } else {
        None
    };

    // Stream stdout to file + vsock in a dedicated thread.
    let stdout_handle = if let Some(stdout) = stdout_pipe {
        let drain_cancel = cancel.clone();
        let tx = drain_done_tx.clone();
        let stdout_writer = writer.clone();
        match spawner.spawn_unit(
            THREAD_STREAM_STDOUT,
            Box::new(move || {
                let mut log_file = match log_path.as_deref() {
                    Some(path) => match std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                    {
                        Ok(f) => Some(f),
                        Err(e) => {
                            log(
                                "WARN",
                                &format!("spawn_watch: failed to open log file {path}: {e}"),
                            );
                            None
                        }
                    },
                    None => None,
                };

                drain_until_eof_or_cancelled(stdout, &drain_cancel, |chunk| {
                    // Write to log file (best-effort)
                    if let Some(ref mut f) = log_file {
                        let _ = f.write_all(chunk);
                    }
                    // Send chunk via vsock (best-effort). On write failure,
                    // signal cancel so the helper exits at the top of the
                    // next iteration: the drain thread drops its pipe fd,
                    // the child gets EPIPE / SIGPIPE on its next stdout
                    // write, and the long-running process terminates
                    // promptly. Without this, a host-side disconnect would
                    // leave the agent running until JOB_TIMEOUT while we
                    // logged a WARN per chunk.
                    //
                    // Note: the cancel flag is shared with the stderr
                    // drain, so this also stops stderr capture. That's
                    // intentional — on host disconnect the
                    // `MSG_PROCESS_EXIT` we'd send (carrying that stderr)
                    // is itself unreachable, so retaining bytes we cannot
                    // deliver buys nothing.
                    let payload = vsock_proto::encode_stdout_chunk(pid, chunk);
                    if let Ok(msg) = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, &payload)
                        && let Err(e) = stdout_writer.write_frame(&msg)
                    {
                        log(
                            "WARN",
                            &format!("spawn_watch: failed to send stdout chunk: {e}"),
                        );
                        drain_cancel.store(true, Ordering::Release);
                    }
                });
                let _ = tx.send(());
            }),
        ) {
            Ok(handle) => Some(handle),
            Err(e) => {
                finish_streaming_setup_failure(StreamingSetupFailure {
                    pid,
                    child,
                    cancel,
                    drain_done_tx,
                    stderr_handle,
                    stdout_handle: None,
                    env_script: _env_script,
                    writer,
                    error: format!("Failed to spawn stdout drain thread: {e}"),
                });
                return;
            }
        }
    } else {
        None
    };
    drop(drain_done_tx); // so recv returns Disconnected when both threads die

    // child wait is now UNBLOCKED — no pipe fds are held by this thread.
    let outcome = wait_with_kill_timeout_or_cancelled(child, timeout_ms, &connection_cancel);
    if matches!(outcome, crate::wait::WaitOutcome::Cancelled)
        || connection_cancel.load(Ordering::Acquire)
    {
        cancel.store(true, Ordering::Release);
    }

    // Shared drain deadline: stdout + stderr share a single budget.
    // This matches guest-agent's 5s drain behavior.
    let expected = stdout_handle.is_some() as usize + stderr_handle.is_some() as usize;
    let completed = await_drain_deadline(&drain_done_rx, expected, &cancel);
    // await_drain_deadline cancels either side that's still draining. The
    // thread observes the flag within ~100 ms (poll cadence), drops its fd,
    // and grandchild writes start failing with EPIPE.
    if completed < expected {
        log(
            "WARN",
            &format!(
                "spawn_watch: pid={pid} drain deadline reached after \
                     {DRAIN_DEADLINE_SECS}s, possible orphaned child process",
            ),
        );
    }

    let stderr = stderr_handle
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    if let Some(h) = stdout_handle {
        let _ = h.join();
    }

    let (exit_code, stderr) = finalize_wait_outcome(outcome, stderr);

    log(
        "INFO",
        &format!(
            "spawn_watch: pid={} exited with code={}, stderr_len={} (streamed)",
            pid,
            exit_code,
            stderr.len()
        ),
    );

    send_process_exit(pid, exit_code, &[], &stderr, &writer);
}

fn finish_streaming_setup_failure(failure: StreamingSetupFailure) {
    let StreamingSetupFailure {
        pid,
        child,
        cancel,
        drain_done_tx,
        stderr_handle,
        stdout_handle,
        env_script,
        writer,
        error,
    } = failure;
    let _env_script = env_script;
    cancel.store(true, Ordering::Release);
    drop(drain_done_tx);
    kill_and_reap_child(child);
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }
    if let Some(handle) = stdout_handle {
        let _ = handle.join();
    }
    send_process_exit(pid, 1, &[], error.as_bytes(), &writer);
}

/// Buffered monitor: waits for process exit while concurrently draining
/// stdout/stderr via the cancellable helper, then sends `MSG_PROCESS_EXIT`.
fn spawn_buffered_monitor(
    request: BufferedMonitorRequest,
    spawner: impl ThreadSpawner,
) -> io::Result<()> {
    spawn_buffered_monitor_with_spawner(request, spawner)
}

fn spawn_buffered_monitor_with_spawner<S>(
    request: BufferedMonitorRequest,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let BufferedMonitorRequest {
        pid,
        child,
        timeout_ms,
        env_script,
        writer,
        connection_cancel,
    } = request;
    let child_guard = ChildReapGuard::new(child);
    let exit_writer = writer.clone();
    let monitor_spawner = spawner.clone();
    let result = spawner.spawn_unit(
        THREAD_BUFFERED_MONITOR,
        Box::new(move || {
            let Some(child) = child_guard.into_child() else {
                log(
                    "ERROR",
                    "spawn_watch: buffered monitor child guard was empty",
                );
                return;
            };
            let (outcome, stdout, stderr_buf) =
                wait_with_drain_and_timeout_or_cancelled_with_spawner(
                    child,
                    timeout_ms,
                    &connection_cancel,
                    monitor_spawner,
                );
            let (exit_code, stdout, stderr) = finalize_buffered_result(outcome, stdout, stderr_buf);

            log(
                "INFO",
                &format!(
                    "spawn_watch: pid={} exited with code={}, stdout_len={}, stderr_len={}",
                    pid,
                    exit_code,
                    stdout.len(),
                    stderr.len()
                ),
            );

            send_process_exit(pid, exit_code, &stdout, &stderr, &writer);
            drop(env_script);
        }),
    );
    if let Err(e) = &result {
        send_process_exit(
            pid,
            1,
            &[],
            format!("Failed to spawn buffered monitor thread: {e}").as_bytes(),
            &exit_writer,
        );
    }
    result.map(|_| ())
}

/// Send a process_exit notification over vsock (best-effort).
fn send_process_exit(pid: u32, exit_code: i32, stdout: &[u8], stderr: &[u8], writer: &GuestWriter) {
    let payload = vsock_proto::encode_process_exit(pid, exit_code, stdout, stderr);
    let exit_msg = match vsock_proto::encode(MSG_PROCESS_EXIT, 0, &payload) {
        Ok(msg) => msg,
        Err(e) => {
            log("ERROR", &format!("Failed to encode process_exit: {}", e));
            return;
        }
    };
    if let Err(e) = writer.write_frame(&exit_msg) {
        log("ERROR", &format!("Failed to send process_exit: {}", e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use crate::wait::THREAD_DRAIN_STDOUT;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
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

    #[test]
    fn spawn_watch_outer_monitor_spawn_failure_reports_process_exit_and_reaps_child() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let cancel = Arc::new(AtomicBool::new(false));

        handle_spawn_watch_with_spawner(
            SpawnWatchRequest {
                timeout_ms: 0,
                command: "sleep 60",
                env: &[],
                sudo: false,
                stream_stdout: true,
                stdout_log_path: None,
            },
            7,
            writer,
            cancel,
            FailingThreadSpawner::fail_once(THREAD_STREAM_MONITOR),
        )
        .unwrap();

        let result = read_message(&mut host);
        assert_eq!(result.msg_type, MSG_SPAWN_WATCH_RESULT);
        assert_eq!(result.seq, 7);
        let pid = vsock_proto::decode_spawn_watch_result(&result.payload).unwrap();

        let exit = read_message(&mut host);
        assert_eq!(exit.msg_type, MSG_PROCESS_EXIT);
        let (exit_pid, code, stdout, stderr) =
            vsock_proto::decode_process_exit(&exit.payload).unwrap();
        assert_eq!(exit_pid, pid);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            String::from_utf8_lossy(stderr).contains("streaming monitor thread"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(stderr),
        );
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn streaming_monitor_stdout_drain_spawn_failure_reports_process_exit_and_reaps_child() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let cancel = Arc::new(AtomicBool::new(false));

        handle_spawn_watch_with_spawner(
            SpawnWatchRequest {
                timeout_ms: 0,
                command: "sleep 60",
                env: &[],
                sudo: false,
                stream_stdout: true,
                stdout_log_path: None,
            },
            8,
            writer,
            cancel,
            FailingThreadSpawner::fail_once(THREAD_STREAM_STDOUT),
        )
        .unwrap();

        let result = read_message(&mut host);
        assert_eq!(result.msg_type, MSG_SPAWN_WATCH_RESULT);
        assert_eq!(result.seq, 8);
        let pid = vsock_proto::decode_spawn_watch_result(&result.payload).unwrap();

        let exit = read_message(&mut host);
        assert_eq!(exit.msg_type, MSG_PROCESS_EXIT);
        let (exit_pid, code, stdout, stderr) =
            vsock_proto::decode_process_exit(&exit.payload).unwrap();
        assert_eq!(exit_pid, pid);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            String::from_utf8_lossy(stderr).contains("stdout drain thread"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(stderr),
        );
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn streaming_monitor_stderr_drain_spawn_failure_reports_process_exit_and_reaps_child() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let cancel = Arc::new(AtomicBool::new(false));

        handle_spawn_watch_with_spawner(
            SpawnWatchRequest {
                timeout_ms: 0,
                command: "sleep 60",
                env: &[],
                sudo: false,
                stream_stdout: true,
                stdout_log_path: None,
            },
            10,
            writer,
            cancel,
            FailingThreadSpawner::fail_once(THREAD_STREAM_STDERR),
        )
        .unwrap();

        let result = read_message(&mut host);
        assert_eq!(result.msg_type, MSG_SPAWN_WATCH_RESULT);
        assert_eq!(result.seq, 10);
        let pid = vsock_proto::decode_spawn_watch_result(&result.payload).unwrap();

        let exit = read_message(&mut host);
        assert_eq!(exit.msg_type, MSG_PROCESS_EXIT);
        let (exit_pid, code, stdout, stderr) =
            vsock_proto::decode_process_exit(&exit.payload).unwrap();
        assert_eq!(exit_pid, pid);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            String::from_utf8_lossy(stderr).contains("stderr drain thread"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(stderr),
        );
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn buffered_spawn_watch_outer_monitor_spawn_failure_reports_process_exit_and_reaps_child() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let cancel = Arc::new(AtomicBool::new(false));

        handle_spawn_watch_with_spawner(
            SpawnWatchRequest {
                timeout_ms: 0,
                command: "sleep 60",
                env: &[],
                sudo: false,
                stream_stdout: false,
                stdout_log_path: None,
            },
            9,
            writer,
            cancel,
            FailingThreadSpawner::fail_once(THREAD_BUFFERED_MONITOR),
        )
        .unwrap();

        let result = read_message(&mut host);
        assert_eq!(result.msg_type, MSG_SPAWN_WATCH_RESULT);
        assert_eq!(result.seq, 9);
        let pid = vsock_proto::decode_spawn_watch_result(&result.payload).unwrap();

        let exit = read_message(&mut host);
        assert_eq!(exit.msg_type, MSG_PROCESS_EXIT);
        let (exit_pid, code, stdout, stderr) =
            vsock_proto::decode_process_exit(&exit.payload).unwrap();
        assert_eq!(exit_pid, pid);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            String::from_utf8_lossy(stderr).contains("buffered monitor thread"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(stderr),
        );
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn buffered_monitor_drain_spawn_failure_reports_process_exit_and_reaps_child() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let cancel = Arc::new(AtomicBool::new(false));

        handle_spawn_watch_with_spawner(
            SpawnWatchRequest {
                timeout_ms: 0,
                command: "sleep 60",
                env: &[],
                sudo: false,
                stream_stdout: false,
                stdout_log_path: None,
            },
            11,
            writer,
            cancel,
            FailingThreadSpawner::fail_once(THREAD_DRAIN_STDOUT),
        )
        .unwrap();

        let result = read_message(&mut host);
        assert_eq!(result.msg_type, MSG_SPAWN_WATCH_RESULT);
        assert_eq!(result.seq, 11);
        let pid = vsock_proto::decode_spawn_watch_result(&result.payload).unwrap();

        let exit = read_message(&mut host);
        assert_eq!(exit.msg_type, MSG_PROCESS_EXIT);
        let (exit_pid, code, stdout, stderr) =
            vsock_proto::decode_process_exit(&exit.payload).unwrap();
        assert_eq!(exit_pid, pid);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            String::from_utf8_lossy(stderr).contains("stdout drain thread"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(stderr),
        );
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }
}
