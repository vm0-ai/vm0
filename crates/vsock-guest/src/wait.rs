use std::io;
use std::os::unix::io::AsRawFd;
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::drain::{drain_into_vec_cancellable, drain_until_eof_or_cancelled};
use crate::process::{extract_exit_code, kill_process_tree};

/// Exit code returned when command times out (same as bash/Python)
pub(crate) const EXIT_CODE_TIMEOUT: i32 = 124;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// `send_process_exit()` anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
const WAIT_CANCEL_POLL_INTERVAL_MS: u64 = 50;

/// Outcome of child wait helpers.
pub(crate) enum WaitOutcome {
    /// Child exited with this status.
    Exited(ExitStatus),
    /// Child was killed after its timeout elapsed.
    TimedOut,
    /// Child was killed because its owning connection was cancelled.
    Cancelled,
    /// `wait()` itself failed; carries the error message.
    WaitFailed(String),
}

#[derive(Clone, Copy)]
pub(crate) enum BoundedDrainStream {
    Stdout,
    Stderr,
}

pub(crate) struct BoundedDrainEvent {
    pub(crate) stream: BoundedDrainStream,
    pub(crate) sequence: u32,
    pub(crate) chunk: Vec<u8>,
    pub(crate) truncated: bool,
}

pub(crate) type BoundedDrainSender = Arc<dyn Fn(BoundedDrainEvent) -> bool + Send + Sync>;

pub(crate) struct BoundedDrainBuffer {
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}

pub(crate) struct BoundedWaitResult {
    pub(crate) outcome: WaitOutcome,
    pub(crate) stdout: BoundedDrainBuffer,
    pub(crate) stderr: BoundedDrainBuffer,
    pub(crate) duration: Duration,
}

enum KillReason {
    Timeout,
    Cancelled,
}

/// Wait for drain workers to complete within the shared drain deadline, then
/// cancel any laggards.
pub(crate) fn await_drain_deadline(
    done_rx: &mpsc::Receiver<()>,
    expected: usize,
    cancel: &AtomicBool,
) -> usize {
    let deadline = Instant::now() + Duration::from_secs(DRAIN_DEADLINE_SECS);
    let mut completed = 0usize;
    while completed < expected {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match done_rx.recv_timeout(remaining) {
            Ok(()) => completed += 1,
            Err(_) => break,
        }
    }
    cancel.store(true, Ordering::Release);
    completed
}

/// Wait for `child` to exit, optionally killing it after `timeout_ms`.
/// `timeout_ms == 0` means "no timeout".
///
/// This **does not touch stdout/stderr** — caller must take them off the
/// `Child` and drain them concurrently (see [`drain_until_eof_or_cancelled`]),
/// otherwise a child producing more than the kernel pipe buffer (~64 KB) will
/// deadlock on its next write while we wait.
pub(crate) fn wait_with_kill_timeout(mut child: Child, timeout_ms: u32) -> WaitOutcome {
    if timeout_ms == 0 {
        return match child.wait() {
            Ok(status) => WaitOutcome::Exited(status),
            Err(e) => WaitOutcome::WaitFailed(e.to_string()),
        };
    }

    let cancel = AtomicBool::new(false);
    wait_with_kill_timeout_or_cancelled(child, timeout_ms, &cancel)
}

/// Wait for `child` to exit, killing and reaping it when either the configured
/// timeout expires or `cancel` is signalled.
///
/// `timeout_ms == 0` still means "no timeout"; cancellation remains active so
/// work tied to a disconnected host connection cannot outlive that connection
/// indefinitely.
pub(crate) fn wait_with_kill_timeout_or_cancelled(
    mut child: Child,
    timeout_ms: u32,
    cancel: &AtomicBool,
) -> WaitOutcome {
    let child_id = child.id();
    let deadline = if timeout_ms > 0 {
        let now = Instant::now();
        Some(
            now.checked_add(Duration::from_millis(u64::from(timeout_ms)))
                .unwrap_or(now),
        )
    } else {
        None
    };
    let poll_interval = Duration::from_millis(WAIT_CANCEL_POLL_INTERVAL_MS);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status),
            Ok(None) => {}
            Err(e) => return WaitOutcome::WaitFailed(e.to_string()),
        }

        let now = Instant::now();
        let reason = if deadline.is_some_and(|deadline| now >= deadline) {
            Some(KillReason::Timeout)
        } else if cancel.load(Ordering::Acquire) {
            Some(KillReason::Cancelled)
        } else {
            None
        };

        if let Some(reason) = reason {
            // SAFETY: child_id is a valid PID from Command::spawn.
            let killed = unsafe { kill_process_tree(child_id) } || child.kill().is_ok();
            return match child.wait() {
                Err(e) => WaitOutcome::WaitFailed(e.to_string()),
                Ok(status) if !killed => WaitOutcome::Exited(status),
                Ok(_) => match reason {
                    KillReason::Timeout => WaitOutcome::TimedOut,
                    KillReason::Cancelled => WaitOutcome::Cancelled,
                },
            };
        }

        let sleep_for = deadline
            .map(|deadline| deadline.saturating_duration_since(now).min(poll_interval))
            .unwrap_or(poll_interval);
        if !sleep_for.is_zero() {
            thread::sleep(sleep_for);
        }
    }
}

/// Coordinate child wait + concurrent stdout/stderr drain + timeout-driven kill.
///
/// Drain threads run in parallel with `wait()` so a chatty child cannot
/// deadlock on a full pipe buffer. After the child exits we wait up to
/// [`DRAIN_DEADLINE_SECS`] for both drain threads to finish naturally
/// — that's the grace window for in-flight bytes. If the deadline elapses
/// (typically because an orphaned grandchild still holds the pipe), we set
/// the cancel flag; drain threads observe it within ~100 ms and return,
/// which drops the read end of the pipe. The orphan's next write then sees
/// EPIPE / SIGPIPE, so neither kernel pipe buffers nor our heap accumulate
/// further bytes.
pub(crate) fn wait_with_drain_and_timeout_or_cancelled(
    mut child: Child,
    timeout_ms: u32,
    external_cancel: &AtomicBool,
) -> (WaitOutcome, Vec<u8>, Vec<u8>) {
    // Defensive: if either pipe is missing the caller broke the
    // `spawn_with_pipes` invariant. Reap the child before returning so we
    // don't leave a zombie — `Child`'s `Drop` doesn't wait.
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return (
                WaitOutcome::WaitFailed("missing stdout pipe".to_string()),
                Vec::new(),
                Vec::new(),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return (
                WaitOutcome::WaitFailed("missing stderr pipe".to_string()),
                Vec::new(),
                Vec::new(),
            );
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = mpsc::channel::<()>();

    let stdout_handle = {
        let cancel = cancel.clone();
        let tx = done_tx.clone();
        thread::spawn(move || {
            let buf = drain_into_vec_cancellable(stdout, &cancel);
            let _ = tx.send(());
            buf
        })
    };
    let stderr_handle = {
        let cancel = cancel.clone();
        let tx = done_tx.clone();
        thread::spawn(move || {
            let buf = drain_into_vec_cancellable(stderr, &cancel);
            let _ = tx.send(());
            buf
        })
    };
    drop(done_tx); // so recv returns Disconnected if both drain threads die

    let outcome = wait_with_kill_timeout_or_cancelled(child, timeout_ms, external_cancel);
    if matches!(outcome, WaitOutcome::Cancelled) || external_cancel.load(Ordering::Acquire) {
        cancel.store(true, Ordering::Release);
    }

    let _ = await_drain_deadline(&done_rx, 2, &cancel);

    let stdout_buf = stdout_handle.join().unwrap_or_default();
    let stderr_buf = stderr_handle.join().unwrap_or_default();

    (outcome, stdout_buf, stderr_buf)
}

pub(crate) fn wait_with_bounded_drain_and_timeout_or_cancelled(
    mut child: Child,
    timeout_ms: u32,
    stdin: Vec<u8>,
    stdout_limit: usize,
    stderr_limit: usize,
    stream_sender: Option<BoundedDrainSender>,
    external_cancel: &AtomicBool,
) -> BoundedWaitResult {
    let start = Instant::now();

    let child_stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return BoundedWaitResult {
                outcome: WaitOutcome::WaitFailed("missing stdin pipe".to_string()),
                stdout: BoundedDrainBuffer {
                    bytes: Vec::new(),
                    truncated: false,
                },
                stderr: BoundedDrainBuffer {
                    bytes: Vec::new(),
                    truncated: false,
                },
                duration: start.elapsed(),
            };
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return BoundedWaitResult {
                outcome: WaitOutcome::WaitFailed("missing stdout pipe".to_string()),
                stdout: BoundedDrainBuffer {
                    bytes: Vec::new(),
                    truncated: false,
                },
                stderr: BoundedDrainBuffer {
                    bytes: Vec::new(),
                    truncated: false,
                },
                duration: start.elapsed(),
            };
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return BoundedWaitResult {
                outcome: WaitOutcome::WaitFailed("missing stderr pipe".to_string()),
                stdout: BoundedDrainBuffer {
                    bytes: Vec::new(),
                    truncated: false,
                },
                stderr: BoundedDrainBuffer {
                    bytes: Vec::new(),
                    truncated: false,
                },
                duration: start.elapsed(),
            };
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = mpsc::channel::<()>();

    let stdin_cancel = Arc::new(AtomicBool::new(false));
    let stdin_handle = {
        let stdin_cancel = stdin_cancel.clone();
        thread::spawn(move || write_stdin_cancellable(child_stdin, &stdin, &stdin_cancel))
    };

    let stdout_handle = {
        let cancel = cancel.clone();
        let tx = done_tx.clone();
        let stream_sender = stream_sender.clone();
        thread::spawn(move || {
            let buf = drain_bounded_cancellable(
                stdout,
                &cancel,
                stdout_limit,
                BoundedDrainStream::Stdout,
                stream_sender,
            );
            let _ = tx.send(());
            buf
        })
    };
    let stderr_handle = {
        let cancel = cancel.clone();
        let tx = done_tx.clone();
        thread::spawn(move || {
            let buf = drain_bounded_cancellable(
                stderr,
                &cancel,
                stderr_limit,
                BoundedDrainStream::Stderr,
                stream_sender,
            );
            let _ = tx.send(());
            buf
        })
    };
    drop(done_tx);

    let outcome = wait_with_kill_timeout_or_cancelled(child, timeout_ms, external_cancel);
    stdin_cancel.store(true, Ordering::Release);
    if matches!(outcome, WaitOutcome::Cancelled) || external_cancel.load(Ordering::Acquire) {
        cancel.store(true, Ordering::Release);
    }

    let _ = await_drain_deadline(&done_rx, 2, &cancel);
    let _ = stdin_handle.join();

    BoundedWaitResult {
        outcome,
        stdout: stdout_handle.join().unwrap_or(BoundedDrainBuffer {
            bytes: Vec::new(),
            truncated: false,
        }),
        stderr: stderr_handle.join().unwrap_or(BoundedDrainBuffer {
            bytes: Vec::new(),
            truncated: false,
        }),
        duration: start.elapsed(),
    }
}

fn drain_bounded_cancellable<R>(
    pipe: R,
    cancel: &AtomicBool,
    limit: usize,
    stream: BoundedDrainStream,
    stream_sender: Option<BoundedDrainSender>,
) -> BoundedDrainBuffer
where
    R: std::os::unix::io::AsRawFd,
{
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let mut sequence = 0u32;
    drain_until_eof_or_cancelled(pipe, cancel, |chunk| {
        let remaining = limit.saturating_sub(bytes.len());
        if remaining == 0 {
            truncated = true;
            return;
        }

        let keep = remaining.min(chunk.len());
        let kept = chunk.get(..keep).unwrap_or_default();
        bytes.extend_from_slice(kept);

        let chunk_truncated = keep < chunk.len();
        truncated |= chunk_truncated;
        if let Some(sender) = &stream_sender
            && !kept.is_empty()
        {
            let ok = sender(BoundedDrainEvent {
                stream,
                sequence,
                chunk: kept.to_vec(),
                truncated: chunk_truncated,
            });
            sequence = sequence.wrapping_add(1);
            if !ok {
                truncated = true;
                cancel.store(true, Ordering::Release);
            }
        }
    });
    BoundedDrainBuffer { bytes, truncated }
}

fn write_stdin_cancellable<W>(stdin: W, bytes: &[u8], cancel: &AtomicBool)
where
    W: AsRawFd,
{
    let raw_fd = stdin.as_raw_fd();
    // `poll(POLLOUT)` only proves some capacity exists. A blocking pipe write
    // with a larger buffer can still block before cancellation is observed, so
    // make this fd nonblocking for the lifetime of the stdin writer thread.
    // SAFETY: raw_fd belongs to `stdin`, which is owned by this function.
    let flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFL) };
    if flags >= 0 {
        // SAFETY: raw_fd is valid and the fd is closed when `stdin` is dropped.
        let _ = unsafe { libc::fcntl(raw_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    }

    let mut written = 0usize;
    while written < bytes.len() {
        if cancel.load(Ordering::Acquire) {
            break;
        }

        let mut pfd = libc::pollfd {
            fd: raw_fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: pfd is valid and describes the stdin fd owned by this
        // function for the duration of the write loop.
        let r = unsafe { libc::poll(&mut pfd, 1, WAIT_CANCEL_POLL_INTERVAL_MS as libc::c_int) };
        if r < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if r == 0 {
            continue;
        }
        if pfd.revents & libc::POLLNVAL != 0 {
            break;
        }
        if pfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            break;
        }
        if pfd.revents & libc::POLLOUT == 0 {
            continue;
        }

        let Some(remaining) = bytes.get(written..) else {
            break;
        };
        // SAFETY: raw_fd belongs to `stdin`, which remains alive until this
        // function returns. `remaining` points to valid memory for its length.
        let n = unsafe { libc::write(raw_fd, remaining.as_ptr().cast(), remaining.len()) };
        if n == 0 {
            break;
        }
        if n < 0 {
            let kind = io::Error::last_os_error().kind();
            if matches!(kind, io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                continue;
            }
            break;
        }
        written = written.saturating_add(n as usize);
    }
    drop(stdin);
}

/// Resolve a [`WaitOutcome`] + drained stderr into protocol exit fields.
/// Timeout overrides any drained stderr with the canonical "Timeout" body so
/// callers can disambiguate from a real exit-1.
pub(crate) fn finalize_wait_outcome(outcome: WaitOutcome, stderr_buf: Vec<u8>) -> (i32, Vec<u8>) {
    match outcome {
        WaitOutcome::TimedOut => (EXIT_CODE_TIMEOUT, b"Timeout".to_vec()),
        WaitOutcome::Cancelled => (1, b"Connection cancelled".to_vec()),
        WaitOutcome::Exited(s) => (extract_exit_code(s), stderr_buf),
        WaitOutcome::WaitFailed(msg) => (1, format!("Failed to wait: {msg}").into_bytes()),
    }
}

pub(crate) fn finalize_buffered_result(
    outcome: WaitOutcome,
    stdout: Vec<u8>,
    stderr_buf: Vec<u8>,
) -> (i32, Vec<u8>, Vec<u8>) {
    let (exit_code, stderr) = finalize_wait_outcome(outcome, stderr_buf);
    (exit_code, stdout, stderr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn successful_status() -> ExitStatus {
        Command::new("true").status().unwrap()
    }

    #[test]
    fn finalize_wait_outcome_preserves_exit_status_and_stderr() {
        let stderr = b"stderr bytes".to_vec();

        let (code, finalized_stderr) =
            finalize_wait_outcome(WaitOutcome::Exited(successful_status()), stderr.clone());

        assert_eq!(code, 0);
        assert_eq!(finalized_stderr, stderr);
    }

    #[test]
    fn finalize_wait_outcome_timeout_overrides_stderr() {
        let (code, stderr) = finalize_wait_outcome(WaitOutcome::TimedOut, b"real stderr".to_vec());

        assert_eq!(code, EXIT_CODE_TIMEOUT);
        assert_eq!(stderr, b"Timeout".to_vec());
    }

    #[test]
    fn finalize_wait_outcome_cancelled_reports_connection_cancelled() {
        let (code, stderr) = finalize_wait_outcome(WaitOutcome::Cancelled, b"real stderr".to_vec());

        assert_eq!(code, 1);
        assert_eq!(stderr, b"Connection cancelled".to_vec());
    }

    #[test]
    fn finalize_wait_outcome_preserves_wait_failed_message() {
        let (code, stderr) = finalize_wait_outcome(
            WaitOutcome::WaitFailed("wait failed".to_string()),
            b"ignored".to_vec(),
        );

        assert_eq!(code, 1);
        assert_eq!(stderr, b"Failed to wait: wait failed".to_vec());
    }

    #[test]
    fn finalize_buffered_result_timeout_preserves_stdout() {
        let (code, stdout, stderr) = finalize_buffered_result(
            WaitOutcome::TimedOut,
            b"partial stdout".to_vec(),
            b"real stderr".to_vec(),
        );

        assert_eq!(code, EXIT_CODE_TIMEOUT);
        assert_eq!(stdout, b"partial stdout".to_vec());
        assert_eq!(stderr, b"Timeout".to_vec());
    }
}
