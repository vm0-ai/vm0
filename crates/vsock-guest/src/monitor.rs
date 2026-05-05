use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use vsock_proto::{self, MSG_ERROR, MSG_PROCESS_EXIT, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK};

use crate::drain::{drain_into_vec_cancellable, drain_until_eof_or_cancelled};
use crate::error::to_io_error;
use crate::exec::{prepend_env, spawn_with_pipes, truncate_preview};
use crate::log::log;
use crate::wait::{
    DRAIN_DEADLINE_SECS, await_drain_deadline, finalize_buffered_result, finalize_wait_outcome,
    wait_with_drain_and_timeout_or_cancelled, wait_with_kill_timeout_or_cancelled,
};
use crate::writer::GuestWriter;

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
    log(
        "INFO",
        &format!(
            "spawn_watch: {} (timeout={}ms, sudo={}, env_count={}, stream={})",
            truncate_preview(request.command),
            request.timeout_ms,
            request.sudo,
            request.env.len(),
            request.stream_stdout,
        ),
    );
    let command = prepend_env(request.command, request.env);

    let mut child = match spawn_with_pipes(&command, request.sudo) {
        Ok(c) => c,
        Err(e) => {
            let payload = vsock_proto::encode_error(&format!("Failed to spawn: {e}"));
            let response = vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
            writer.write_frame(&response)?;
            return Ok(());
        }
    };

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
            let _ = child.kill();
            let _ = child.wait();
            return Err(to_io_error(e));
        }
    };
    if let Err(e) = writer.write_frame(&response) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }

    if request.stream_stdout {
        // Streaming mode: stream stdout to vsock chunks, optionally teeing to a guest file.
        // Take stdout from child so we can read it in a separate thread.
        let stdout_pipe = child.stdout.take();
        spawn_streaming_monitor(
            pid,
            child,
            request.timeout_ms,
            stdout_pipe,
            request.stdout_log_path.map(str::to_owned),
            writer,
            connection_cancel,
        );
    } else {
        // Buffered mode: stdout/stderr drained via cancellable helper, sent
        // in a single MSG_PROCESS_EXIT after wait.
        spawn_buffered_monitor(pid, child, request.timeout_ms, writer, connection_cancel);
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
    pid: u32,
    mut child: std::process::Child,
    timeout_ms: u32,
    stdout_pipe: Option<std::process::ChildStdout>,
    log_path: Option<String>,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
) {
    thread::spawn(move || {
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
            let cancel = cancel.clone();
            let tx = drain_done_tx.clone();
            Some(thread::spawn(move || {
                let buf = drain_into_vec_cancellable(stderr, &cancel);
                let _ = tx.send(());
                buf
            }))
        } else {
            None
        };

        // Stream stdout to file + vsock in a dedicated thread.
        let stdout_handle = if let Some(stdout) = stdout_pipe {
            let cancel = cancel.clone();
            let tx = drain_done_tx.clone();
            let stdout_writer = writer.clone();
            Some(thread::spawn(move || {
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

                drain_until_eof_or_cancelled(stdout, &cancel, |chunk| {
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
                        cancel.store(true, Ordering::Release);
                    }
                });
                let _ = tx.send(());
            }))
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
    });
}

/// Buffered monitor: waits for process exit while concurrently draining
/// stdout/stderr via the cancellable helper, then sends `MSG_PROCESS_EXIT`.
fn spawn_buffered_monitor(
    pid: u32,
    child: std::process::Child,
    timeout_ms: u32,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let (outcome, stdout, stderr_buf) =
            wait_with_drain_and_timeout_or_cancelled(child, timeout_ms, &connection_cancel);
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
    });
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
