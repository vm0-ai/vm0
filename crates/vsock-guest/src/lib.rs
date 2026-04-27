//! Vsock Guest library for Firecracker VM host-guest communication.
//!
//! This library provides the core functionality for host-guest IPC via vsock
//! or Unix sockets. It can be used standalone or embedded in other binaries
//! like guest-init.
//!
//! Protocol encoding/decoding is handled by the `vsock-proto` crate.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, MSG_ERROR, MSG_EXEC, MSG_EXEC_RESULT, MSG_PING, MSG_PONG, MSG_PROCESS_EXIT, MSG_READY,
    MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK,
    MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, ProtocolError, RawMessage,
};

/// Flag indicating shutdown was received (don't reconnect after shutdown).
///
/// Process-level static: safe because integration tests use `handle_connection` per-thread
/// (not `run()`), and each test gets its own connection. Only `run()` reads this flag.
static SHUTDOWN_RECEIVED: AtomicBool = AtomicBool::new(false);

// Vsock constants (only used on Linux)
#[cfg(target_os = "linux")]
const VSOCK_CID_HOST: u32 = 2;

/// Read buffer size for the connection event loop (local tuning constant).
const READ_BUFFER_SIZE: usize = 64 * 1024; // 64KB

/// Exit code returned when command times out (same as bash/Python)
const EXIT_CODE_TIMEOUT: i32 = 124;

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;

/// Buffer size for reading stdout chunks from a spawned process.
const STDOUT_CHUNK_SIZE: usize = 8 * 1024;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// `send_process_exit()` anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
const DRAIN_DEADLINE_SECS: u64 = 5;

/// Convert a ProtocolError to an io::Error
fn to_io_error(e: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Get the user to execute commands as
/// - Debug builds: None (run as current user via sh -c)
/// - Release builds: Some("user") (run as user via su - user -c)
///
/// The rootfs must have the "user" account (UID 1000) configured with passwordless sudo.
/// See: crates/runner/scripts/build-rootfs.sh for user account setup.
fn get_exec_user() -> Option<&'static str> {
    #[cfg(debug_assertions)]
    {
        None
    }

    #[cfg(not(debug_assertions))]
    {
        // Default user for command execution (UID 1000, matching E2B sandbox)
        Some("user")
    }
}

/// Shell-escape a value by wrapping in single quotes and escaping embedded `'`.
fn shell_escape_value(val: &str) -> String {
    format!("'{}'", val.replace('\'', "'\\''"))
}

/// Prepend environment variable exports to a command string.
///
/// Returns the command unchanged when `env` is empty. Otherwise produces
/// `export KEY='value' KEY2='value2'; command` so the variables are
/// available for shell expansion in the command.
fn prepend_env(command: &str, env: &[(&str, &str)]) -> String {
    if env.is_empty() {
        return command.to_string();
    }
    let mut parts = String::from("export ");
    for (i, (key, val)) in env.iter().enumerate() {
        if i > 0 {
            parts.push(' ');
        }
        parts.push_str(key);
        parts.push('=');
        parts.push_str(&shell_escape_value(val));
    }
    parts.push_str("; ");
    parts.push_str(command);
    parts
}

/// Build a Command to execute a shell command as the appropriate user.
///
/// When `sudo` is true the command runs as root, bypassing `su - user` and
/// the PAM overhead that comes with it.
///
/// In release builds the guest-init process is already root, so `sh -c`
/// suffices. In debug builds the process is a normal user, so `sudo sh -c`
/// is needed to elevate.
fn build_exec_command(command: &str, sudo: bool) -> Command {
    match get_exec_user() {
        Some(user) => {
            if sudo {
                // Release: already root — run directly
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("su");
                c.arg("-").arg(user).arg("-c").arg(command);
                c
            }
        }
        None => {
            if sudo {
                // Debug: not root — elevate with sudo
                let mut c = Command::new("sudo");
                c.arg("sh").arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            }
        }
    }
}

/// Truncate a command string for logging, preserving UTF-8 boundaries
fn truncate_preview(s: &str) -> String {
    if s.len() <= COMMAND_PREVIEW_MAX_LEN {
        return s.to_string();
    }
    // Find a safe UTF-8 boundary at or before the max length
    let end = s
        .char_indices()
        .take_while(|(i, _)| *i < COMMAND_PREVIEW_MAX_LEN)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(COMMAND_PREVIEW_MAX_LEN);
    format!("{}...", &s[..end])
}

/// Extract exit code from ExitStatus, mapping signals to 128 + signal number
#[cfg(unix)]
fn extract_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| status.signal().map(|sig| 128 + sig).unwrap_or(1))
}

#[cfg(not(unix))]
fn extract_exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Log a message to stderr
pub fn log(level: &str, msg: &str) {
    eprintln!("[vsock-guest] [{level}] {msg}");
}

/// Parse ppid and pgid from a `/proc/[pid]/stat` line.
///
/// Format: `"pid (comm) state ppid pgid session ..."` — the comm field can
/// contain spaces and parentheses, so we locate the LAST `)` first.
fn parse_stat_ppid_pgid(stat: &str) -> Option<(u32, u32)> {
    let close_paren = stat.rfind(')')?;
    if close_paren + 2 >= stat.len() {
        return None;
    }
    let remainder = &stat[close_paren + 2..]; // skip ") "
    let fields: Vec<&str> = remainder.split_whitespace().collect();
    // fields: [0]=state [1]=ppid [2]=pgid [3]=session ...
    let ppid = fields.get(1)?.parse().ok()?;
    let pgid = fields.get(2)?.parse().ok()?;
    Some((ppid, pgid))
}

/// Find the process-group ID of a direct child of `parent_pid`.
///
/// In release builds, commands are wrapped in `su - user -c "..."`.
/// `su` forks internally and the child calls `setsid()`, creating a new
/// session and process group. `kill(-parent_pid, SIGKILL)` only reaches
/// the `su` process's group — the child's group (where the actual command
/// runs) is missed.
///
/// This function scans `/proc` to find that child and returns its PGID so
/// the timeout killer can send SIGKILL to both process groups.
///
/// Must be called BEFORE killing the parent, because once the parent dies
/// the child's PPID changes to 1 (init).
fn find_child_pgid(parent_pid: u32) -> Option<u32> {
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let name = entry.file_name();
        let Ok(pid) = name.to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };

        let Some((ppid, pgid)) = parse_stat_ppid_pgid(&stat) else {
            continue;
        };

        if ppid == parent_pid {
            return Some(pgid);
        }
    }
    None
}

/// Kill a process group and, if `su -` created a child session, also kill
/// that child's process group.
///
/// # Safety
///
/// `child_id` must be a valid PID from `Command::spawn()`.
/// Returns `true` if the primary kill (the direct child's group) succeeded.
unsafe fn kill_process_tree(child_id: u32) -> bool {
    // Find su's child PGID BEFORE killing — after kill, PPID changes to 1.
    let child_pgid = find_child_pgid(child_id);

    // Kill the direct child's process group (the su wrapper).
    let ret = unsafe { libc::kill(-(child_id as i32), libc::SIGKILL) };
    if ret != 0 {
        let err = std::io::Error::last_os_error();
        log(
            "WARN",
            &format!("timeout kill(-{child_id}, SIGKILL) failed: {err}"),
        );
        return false;
    }

    // Kill the session/process group created by su's child after setsid().
    // Skip if the child is in the same group (no setsid happened, e.g. debug builds).
    // Guard pgid != 0: kill(0, sig) sends to the calling process's own group.
    if let Some(pgid) = child_pgid
        && pgid != 0
        && pgid != child_id
    {
        let ret = unsafe { libc::kill(-(pgid as i32), libc::SIGKILL) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            log(
                "WARN",
                &format!("timeout kill(-{pgid}, SIGKILL) for su child group failed: {err}"),
            );
        }
    }

    true
}

/// Outcome of [`wait_with_kill_timeout`].
enum WaitOutcome {
    /// Child exited with this status.
    Exited(ExitStatus),
    /// Child was killed by the timeout watchdog.
    TimedOut,
    /// `wait()` itself failed; carries the error message.
    WaitFailed(String),
}

/// Wait for `child` to exit, optionally killing it after `timeout_ms`.
/// `timeout_ms == 0` means "no timeout".
///
/// This **does not touch stdout/stderr** — caller must take them off the
/// `Child` and drain them concurrently (see [`drain_until_eof_or_cancelled`]),
/// otherwise a child producing more than the kernel pipe buffer (~64 KB) will
/// deadlock on its next write while we wait.
fn wait_with_kill_timeout(mut child: std::process::Child, timeout_ms: u32) -> WaitOutcome {
    use std::sync::mpsc;

    if timeout_ms == 0 {
        return match child.wait() {
            Ok(s) => WaitOutcome::Exited(s),
            Err(e) => WaitOutcome::WaitFailed(e.to_string()),
        };
    }

    let timeout = Duration::from_millis(u64::from(timeout_ms));
    let child_id = child.id();

    // Channel to signal that the child has exited and the watchdog can stand down.
    let (tx, rx) = mpsc::channel::<()>();

    // Watchdog: kills the process tree if `recv_timeout` expires before the
    // child reports exit. Its return value *is* the "did we time out?" verdict.
    let timeout_handle = thread::spawn(move || -> bool {
        if rx.recv_timeout(timeout).is_err() {
            // SAFETY: child_id is a valid PID from Command::spawn.
            return unsafe { kill_process_tree(child_id) };
        }
        false
    });

    let status = child.wait();
    let _ = tx.send(());
    let killed_by_timeout = timeout_handle.join().unwrap_or(false);

    match status {
        Ok(_) if killed_by_timeout => WaitOutcome::TimedOut,
        Ok(s) => WaitOutcome::Exited(s),
        Err(e) => WaitOutcome::WaitFailed(e.to_string()),
    }
}

/// Set `O_NONBLOCK` on `raw_fd`. Returns false on fcntl failure.
///
/// Used so a drain thread can `poll()` with a short timeout and break out on
/// a cancel flag, instead of getting stuck in a blocking `read()` while a
/// leaked grandchild holds the pipe write end open past child exit.
fn set_nonblocking(raw_fd: std::os::unix::io::RawFd) -> bool {
    // SAFETY: raw_fd is a valid fd taken from a `Child`'s pipe.
    let flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFL) };
    if flags < 0 {
        return false;
    }
    // SAFETY: raw_fd is valid; flags is the value just read from F_GETFL.
    let r = unsafe { libc::fcntl(raw_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    r >= 0
}

/// Drain `pipe` until EOF or `cancel` is set, calling `on_chunk` for each
/// non-empty read.
///
/// Cancel mechanism: each iteration polls for input with a 100 ms timeout, so
/// the cancel flag is observed at most ~100 ms after it's set. When the loop
/// returns, the caller's drop of the underlying `ChildStdout` / `ChildStderr`
/// closes the read end of the pipe — at which point any still-writing
/// producer (e.g. an orphaned grandchild) gets EPIPE / SIGPIPE on its next
/// write. That's the property a tempfile-based capture cannot offer: a
/// regular file is always writable, so a leaked daemon would grow tmpfs
/// memory indefinitely.
fn drain_until_eof_or_cancelled<R>(
    mut pipe: R,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(&[u8]),
) where
    R: Read + std::os::unix::io::AsRawFd,
{
    let raw_fd = pipe.as_raw_fd();
    // If we can't set non-blocking, fall back to a blocking read. We lose the
    // cancel property (drain may hang past deadline) but produce correct data
    // for the common case. fcntl never fails in practice on a valid pipe fd.
    let nonblocking = set_nonblocking(raw_fd);

    let mut chunk = [0u8; STDOUT_CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        if nonblocking {
            let mut pfd = libc::pollfd {
                fd: raw_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: pfd is a valid pollfd; nfds=1 matches the array length.
            let r = unsafe { libc::poll(&mut pfd, 1, 100) };
            if r < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if r == 0 {
                continue; // timeout — re-check cancel
            }
        }
        match pipe.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => on_chunk(chunk.get(..n).unwrap_or_default()),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Buffered variant of [`drain_until_eof_or_cancelled`]: accumulates
/// everything read into a `Vec<u8>` and returns it.
fn drain_into_vec_cancellable<R>(pipe: R, cancel: &AtomicBool) -> Vec<u8>
where
    R: Read + std::os::unix::io::AsRawFd,
{
    let mut buf = Vec::new();
    drain_until_eof_or_cancelled(pipe, cancel, |chunk| buf.extend_from_slice(chunk));
    buf
}

/// Spawn `command` with stdout/stderr piped — used by both buffered exec and
/// streaming spawn-watch.
fn spawn_with_pipes(command: &str, sudo: bool) -> io::Result<std::process::Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        build_exec_command(command, sudo)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
    }
    #[cfg(not(unix))]
    {
        build_exec_command(command, sudo)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
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
fn wait_with_drain_and_timeout(
    mut child: std::process::Child,
    timeout_ms: u32,
) -> (WaitOutcome, Vec<u8>, Vec<u8>) {
    use std::sync::mpsc;

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

    let outcome = wait_with_kill_timeout(child, timeout_ms);

    // Grace period for in-flight bytes — most clean exits finish drain within
    // a few ms. We bound the wait at DRAIN_DEADLINE_SECS to defang
    // orphaned grandchildren that still hold the pipe.
    let deadline = std::time::Instant::now() + Duration::from_secs(DRAIN_DEADLINE_SECS);
    let mut completed = 0;
    while completed < 2 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match done_rx.recv_timeout(remaining) {
            Ok(()) => completed += 1,
            Err(_) => break,
        }
    }
    cancel.store(true, Ordering::Release);

    let stdout_buf = stdout_handle.join().unwrap_or_default();
    let stderr_buf = stderr_handle.join().unwrap_or_default();

    (outcome, stdout_buf, stderr_buf)
}

/// Resolve a [`WaitOutcome`] + drained bytes into the `(exit_code, stdout, stderr)`
/// triple the protocol returns. Timeout overrides any drained stderr with the
/// canonical "Timeout" body so callers can disambiguate from a real exit-1.
fn finalize_buffered_result(
    outcome: WaitOutcome,
    stdout: Vec<u8>,
    stderr_buf: Vec<u8>,
) -> (i32, Vec<u8>, Vec<u8>) {
    let (exit_code, stderr) = match outcome {
        WaitOutcome::TimedOut => (EXIT_CODE_TIMEOUT, b"Timeout".to_vec()),
        WaitOutcome::Exited(s) => (extract_exit_code(s), stderr_buf),
        WaitOutcome::WaitFailed(msg) => (1, format!("Failed to wait: {msg}").into_bytes()),
    };
    (exit_code, stdout, stderr)
}

/// Handle exec message
fn handle_exec(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
) -> (i32, Vec<u8>, Vec<u8>) {
    log(
        "INFO",
        &format!(
            "exec: {} (timeout={}ms, sudo={}, env_count={})",
            truncate_preview(command),
            timeout_ms,
            sudo,
            env.len(),
        ),
    );
    let command = prepend_env(command, env);

    let child = match spawn_with_pipes(&command, sudo) {
        Ok(c) => c,
        Err(e) => {
            return (
                1,
                Vec::new(),
                format!("Failed to execute: {e}").into_bytes(),
            );
        }
    };

    let (outcome, stdout, stderr_buf) = wait_with_drain_and_timeout(child, timeout_ms);
    let result = finalize_buffered_result(outcome, stdout, stderr_buf);

    log(
        "INFO",
        &format!(
            "exec result: exit_code={}, stdout_len={}, stderr_len={}",
            result.0,
            result.1.len(),
            result.2.len()
        ),
    );
    result
}

/// Handle write_file message
fn handle_write_file(path: &str, content: &[u8], use_sudo: bool, append: bool) -> (bool, String) {
    log(
        "INFO",
        &format!(
            "write_file: path={} size={} sudo={} append={}",
            path,
            content.len(),
            use_sudo,
            append,
        ),
    );

    // Execute as 'user' (UID 1000) to match E2B sandbox behavior
    // Use subprocess instead of direct fs::write to run as user
    const WRITE_TIMEOUT_MS: u32 = 30_000;

    let escaped_path = path.replace('\'', "'\\''");

    // Build the write command: tee for privileged writes (build_exec_command
    // handles root elevation), cat for normal writes with parent dir creation.
    let write_cmd = if use_sudo {
        let tee_flag = if append { "-a " } else { "" };
        format!("tee {tee_flag}'{escaped_path}'")
    } else if append {
        // Append mode: parent directory already exists from the first chunk.
        format!("cat >> '{escaped_path}'")
    } else {
        // Create parent directory if needed, then write
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                format!(
                    "mkdir -p '{}' && cat > '{escaped_path}'",
                    parent.display().to_string().replace('\'', "'\\''"),
                )
            } else {
                format!("cat > '{escaped_path}'")
            }
        } else {
            format!("cat > '{escaped_path}'")
        }
    };

    let mut child = match build_exec_command(&write_cmd, use_sudo)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn write command: {e}")),
    };

    // Write content to stdin and close it
    if let Some(mut stdin) = child.stdin.take()
        && let Err(e) = stdin.write_all(content)
    {
        let _ = child.kill();
        let _ = child.wait(); // Prevent zombie process
        return (false, format!("Failed to write to stdin: {e}"));
    }
    // stdin is dropped here, closing the pipe

    // Drain stderr concurrently with wait via the cancellable helper. Stdout
    // is `Stdio::null()` so there's no orphan-fd hazard there. After the
    // child exits, the drain thread either reaches EOF naturally or — if a
    // grandchild somehow still holds stderr — is cut at the deadline so its
    // last write returns EPIPE.
    // Defensive: same invariant as wait_with_drain_and_timeout — reap the
    // child if its stderr is somehow already gone, so we don't leave a zombie.
    let stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return (false, "missing stderr pipe".to_string());
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let stderr_handle = {
        let cancel = cancel.clone();
        thread::spawn(move || {
            let buf = drain_into_vec_cancellable(stderr_pipe, &cancel);
            let _ = done_tx.send(());
            buf
        })
    };

    let outcome = wait_with_kill_timeout(child, WRITE_TIMEOUT_MS);

    // Wait for drain to finish naturally up to the deadline; otherwise cancel
    // so the drain thread drops its fd and a still-writing grandchild gets
    // EPIPE on its next write.
    let _ = done_rx.recv_timeout(Duration::from_secs(DRAIN_DEADLINE_SECS));
    cancel.store(true, Ordering::Release);
    let stderr = stderr_handle.join().unwrap_or_default();

    match outcome {
        WaitOutcome::TimedOut => (false, "write timed out".to_string()),
        WaitOutcome::WaitFailed(msg) => (false, format!("write wait failed: {msg}")),
        WaitOutcome::Exited(s) => {
            let exit_code = extract_exit_code(s);
            if exit_code != 0 {
                let stderr_str = String::from_utf8_lossy(&stderr);
                return (false, format!("write failed: {stderr_str}"));
            }
            (true, String::new())
        }
    }
}

/// Handle shutdown message — acknowledge and suppress reconnection.
///
/// The guest rootfs is ext4 on an ephemeral COW device that is destroyed
/// when the VM is killed, so there is nothing to sync. The primary purpose
/// of this handler is to set `SHUTDOWN_RECEIVED` so the reconnection loop
/// in `run()` exits cleanly instead of retrying (which it would otherwise
/// do, since reconnection is the normal path after snapshot restore).
fn handle_shutdown(seq: u32) -> io::Result<Vec<u8>> {
    log("INFO", "Shutdown requested");
    SHUTDOWN_RECEIVED.store(true, Ordering::SeqCst);
    vsock_proto::encode(MSG_SHUTDOWN_ACK, seq, &[]).map_err(to_io_error)
}

struct SpawnWatchRequest<'a> {
    timeout_ms: u32,
    command: &'a str,
    env: &'a [(&'a str, &'a str)],
    sudo: bool,
    stream_stdout: bool,
    stdout_log_path: Option<&'a str>,
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
fn handle_spawn_watch(
    request: SpawnWatchRequest<'_>,
    seq: u32,
    writer: Arc<Mutex<UnixStream>>,
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
            let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
            w.write_all(&response)?;
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
    {
        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = w.write_all(&response) {
            drop(w);
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
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
        );
    } else {
        // Buffered mode: stdout/stderr drained via cancellable helper, sent
        // in a single MSG_PROCESS_EXIT after wait.
        spawn_buffered_monitor(pid, child, request.timeout_ms, writer);
    }

    Ok(())
}

/// Streaming monitor: streams stdout chunks to vsock, optionally tees stdout
/// chunks to a guest file, drains stderr into a buffer, and races both
/// against `child.wait()`.
///
/// Architecture:
/// - Timeout killer thread: kills process group after deadline
/// - Stderr reader thread: drains stderr into a `Vec<u8>` (cancellable)
/// - Stdout reader thread: streams chunks to log + vsock (cancellable)
/// - Monitor thread: waits for `child.wait()`, then applies drain deadline
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
    writer: Arc<Mutex<UnixStream>>,
) {
    thread::spawn(move || {
        // Set up timeout BEFORE the stdout loop — if the process runs past the
        // deadline it must be killed even while we are still reading output.
        let child_id = child.id();
        let (timeout_done_tx, timeout_handle) = if timeout_ms > 0 {
            let timeout = Duration::from_millis(u64::from(timeout_ms));
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let handle = thread::spawn(move || -> bool {
                if rx.recv_timeout(timeout).is_err() {
                    // SAFETY: child_id is a valid PID.
                    return unsafe { kill_process_tree(child_id) };
                }
                false
            });
            (Some(tx), Some(handle))
        } else {
            (None, None)
        };

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
            let stdout_writer = Arc::clone(&writer);
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
                    if let Ok(msg) = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, &payload) {
                        let mut w = stdout_writer.lock().unwrap_or_else(|e| e.into_inner());
                        if let Err(e) = w.write_all(&msg) {
                            log(
                                "WARN",
                                &format!("spawn_watch: failed to send stdout chunk: {e}"),
                            );
                            cancel.store(true, Ordering::Release);
                        }
                    }
                });
                let _ = tx.send(());
            }))
        } else {
            None
        };
        drop(drain_done_tx); // so recv returns Disconnected when both threads die

        // child.wait() is now UNBLOCKED — no pipe fds held by this thread.
        let status = child.wait();

        // Signal timeout thread that process completed.
        // Must send() not drop — dropping disconnects the channel, which
        // recv_timeout treats as an error and would fire the killer.
        if let Some(tx) = timeout_done_tx {
            let _ = tx.send(());
        }

        // Shared drain deadline: stdout + stderr share a single budget.
        // This matches guest-agent's 5s drain behavior.
        let expected = stdout_handle.is_some() as usize + stderr_handle.is_some() as usize;
        let deadline = std::time::Instant::now() + Duration::from_secs(DRAIN_DEADLINE_SECS);
        let mut completed = 0usize;
        while completed < expected {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match drain_done_rx.recv_timeout(remaining) {
                Ok(()) => completed += 1,
                Err(_) => break,
            }
        }
        // Cancel either side that's still draining. The thread observes the
        // flag within ~100 ms (poll cadence), drops its fd, and grandchild
        // writes start failing with EPIPE.
        cancel.store(true, Ordering::Release);
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

        let killed_by_timeout = timeout_handle
            .map(|h| h.join().unwrap_or(false))
            .unwrap_or(false);
        let (exit_code, stderr) = if killed_by_timeout {
            (EXIT_CODE_TIMEOUT, b"Timeout".to_vec())
        } else {
            match status {
                Ok(s) => (extract_exit_code(s), stderr),
                Err(e) => (1, format!("Failed to wait: {e}").into_bytes()),
            }
        };

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
    writer: Arc<Mutex<UnixStream>>,
) {
    thread::spawn(move || {
        let (outcome, stdout, stderr_buf) = wait_with_drain_and_timeout(child, timeout_ms);
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
fn send_process_exit(
    pid: u32,
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
    writer: &Arc<Mutex<UnixStream>>,
) {
    let payload = vsock_proto::encode_process_exit(pid, exit_code, stdout, stderr);
    let exit_msg = match vsock_proto::encode(MSG_PROCESS_EXIT, 0, &payload) {
        Ok(msg) => msg,
        Err(e) => {
            log("ERROR", &format!("Failed to encode process_exit: {}", e));
            return;
        }
    };
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = w.write_all(&exit_msg) {
        log("ERROR", &format!("Failed to send process_exit: {}", e));
    }
}

/// Handle incoming message and return response.
///
/// `MSG_EXEC` and `MSG_SPAWN_WATCH` are handled separately in
/// `handle_connection` because they run in background threads.
fn handle_message(msg: &RawMessage) -> io::Result<Option<Vec<u8>>> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(Some(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_WRITE_FILE => {
            let (path, content, use_sudo, append) =
                vsock_proto::decode_write_file(&msg.payload).map_err(to_io_error)?;
            let (success, error) = handle_write_file(path, content, use_sudo, append);
            let payload = vsock_proto::encode_write_file_result(success, &error);
            Ok(Some(
                vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload)
                    .map_err(to_io_error)?,
            ))
        }
        MSG_SHUTDOWN => Ok(Some(handle_shutdown(msg.seq)?)),
        _ => {
            let payload =
                vsock_proto::encode_error(&format!("Unknown message type: 0x{:02X}", msg.msg_type));
            Ok(Some(
                vsock_proto::encode(MSG_ERROR, msg.seq, &payload).map_err(to_io_error)?,
            ))
        }
    }
}

/// Connect to vsock (Linux only - this binary runs inside Firecracker VM)
#[cfg(target_os = "linux")]
pub fn connect_vsock() -> io::Result<UnixStream> {
    use std::os::unix::io::FromRawFd;

    // SAFETY: Creating a vsock socket with valid constants. fd is checked for errors below.
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let addr = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as u16,
        svm_reserved1: 0,
        svm_port: vsock_proto::VSOCK_PORT,
        svm_cid: VSOCK_CID_HOST,
        svm_zero: [0; 4],
    };

    // SAFETY: fd is a valid socket from above, addr is properly initialized, and
    // size_of returns the correct sockaddr_vm size. Errors are checked below.
    let ret = unsafe {
        libc::connect(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as u32,
        )
    };

    if ret < 0 {
        // SAFETY: fd is a valid open socket descriptor, and we're about to return an error.
        unsafe { libc::close(fd) };
        return Err(io::Error::last_os_error());
    }

    // SAFETY: fd is a valid, connected socket descriptor. Ownership transfers to UnixStream.
    Ok(unsafe { UnixStream::from_raw_fd(fd) })
}

/// Stub for non-Linux platforms (for IDE support)
#[cfg(not(target_os = "linux"))]
pub fn connect_vsock() -> io::Result<UnixStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "vsock is only supported on Linux",
    ))
}

/// Connect to Unix socket (for testing)
pub fn connect_unix(path: &str) -> io::Result<UnixStream> {
    UnixStream::connect(path)
}

/// Handle connection - the main event loop
/// Uses separate reader/writer to avoid deadlock between main loop and background threads
pub fn handle_connection(stream: UnixStream) -> io::Result<()> {
    // Clone the stream to get separate reader and writer
    // This avoids deadlock: reader can block while writer sends process_exit
    let mut reader = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));

    let mut decoder = vsock_proto::Decoder::new();

    // Send ready signal
    {
        let ready = vsock_proto::encode(MSG_READY, 0, &[]).map_err(to_io_error)?;
        // Recover from poisoned mutex: prefer sending ready over propagating a
        // panic from an unrelated thread.
        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(&ready)?;
    }
    log("INFO", "Sent ready signal");

    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        // Read from stream (reader is separate, no lock needed)
        let n = reader.read(&mut buf)?;

        if n == 0 {
            break;
        }

        // n <= buf.len() is guaranteed by read()
        for msg in decoder
            .decode(buf.get(..n).unwrap_or_default())
            .map_err(to_io_error)?
        {
            // MSG_EXEC and MSG_SPAWN_WATCH run in background threads to avoid
            // blocking the event loop. A blocking child process (e.g. reading a
            // pipe fd) would otherwise stall all subsequent messages.
            if msg.msg_type == MSG_SPAWN_WATCH {
                let d = vsock_proto::decode_spawn_watch(&msg.payload).map_err(to_io_error)?;
                // handle_spawn_watch writes the response itself (before
                // spawning the streaming thread) to prevent a race where
                // stdout chunks could arrive at the host before the result.
                handle_spawn_watch(
                    SpawnWatchRequest {
                        timeout_ms: d.exec.timeout_ms,
                        command: d.exec.command,
                        env: &d.exec.env,
                        sudo: d.exec.sudo,
                        stream_stdout: d.stream_stdout,
                        stdout_log_path: d.stdout_log_path,
                    },
                    msg.seq,
                    Arc::clone(&writer),
                )?;
            } else if msg.msg_type == MSG_EXEC {
                log(
                    "INFO",
                    &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
                );
                let d = vsock_proto::decode_exec(&msg.payload).map_err(to_io_error)?;
                let timeout_ms = d.timeout_ms;
                let command = d.command.to_owned();
                let env: Vec<(String, String)> = d
                    .env
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect();
                let sudo = d.sudo;
                let seq = msg.seq;
                let w = Arc::clone(&writer);
                thread::spawn(move || {
                    let env_refs: Vec<(&str, &str)> =
                        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                    let (exit_code, stdout, stderr) =
                        handle_exec(timeout_ms, &command, &env_refs, sudo);
                    let payload = vsock_proto::encode_exec_result(exit_code, &stdout, &stderr);
                    let encoded = match vsock_proto::encode(MSG_EXEC_RESULT, seq, &payload) {
                        Ok(msg) => msg,
                        Err(e) => {
                            log("ERROR", &format!("Failed to encode exec_result: {}", e));
                            return;
                        }
                    };
                    let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                    if let Err(e) = w.write_all(&encoded) {
                        log("ERROR", &format!("Failed to send exec_result: {}", e));
                    }
                });
            } else {
                let response = handle_message(&msg)?;
                if let Some(response) = response {
                    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                    w.write_all(&response)?;
                }
            }
        }
    }

    log("INFO", "Host disconnected");
    Ok(())
}

/// Maximum reconnection attempts before giving up
const MAX_RECONNECT_ATTEMPTS: u32 = 50;
/// Delay between reconnection attempts (10ms for fast reconnect after snapshot restore)
const RECONNECT_DELAY_MS: u64 = 10;

/// Run the vsock guest agent with the given options.
/// Includes reconnection logic for snapshot restore scenarios where
/// the connection is lost when VM is paused and resumed.
pub fn run(unix_socket: Option<&str>) -> io::Result<()> {
    log("INFO", "Starting vsock guest...");

    let mut attempts = 0u32;

    loop {
        let result = if let Some(path) = unix_socket {
            log("INFO", &format!("Connecting to Unix socket: {}...", path));
            connect_unix(path).and_then(|stream| {
                log("INFO", "Connected");
                // Reset attempts on successful connection
                attempts = 0;
                handle_connection(stream)
            })
        } else {
            log("INFO", "Connecting to host (CID=2)...");
            connect_vsock().and_then(|stream| {
                log("INFO", "Connected");
                // Reset attempts on successful connection
                attempts = 0;
                handle_connection(stream)
            })
        };

        attempts += 1;

        match result {
            Ok(()) => {
                // If shutdown was received, exit gracefully without reconnecting
                if SHUTDOWN_RECEIVED.load(Ordering::SeqCst) {
                    log("INFO", "Shutdown complete, exiting");
                    return Ok(());
                }
                // Connection closed gracefully, try to reconnect
                if attempts >= MAX_RECONNECT_ATTEMPTS {
                    log(
                        "ERROR",
                        &format!(
                            "Max reconnect attempts ({}) reached",
                            MAX_RECONNECT_ATTEMPTS
                        ),
                    );
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "Max reconnect attempts reached",
                    ));
                }
                log(
                    "INFO",
                    &format!(
                        "Connection closed, reconnecting ({}/{})...",
                        attempts, MAX_RECONNECT_ATTEMPTS
                    ),
                );
                std::thread::sleep(std::time::Duration::from_millis(RECONNECT_DELAY_MS));
            }
            Err(e) => {
                // Connection error, try to reconnect
                if attempts >= MAX_RECONNECT_ATTEMPTS {
                    log(
                        "ERROR",
                        &format!(
                            "Max reconnect attempts ({}) reached: {}",
                            MAX_RECONNECT_ATTEMPTS, e
                        ),
                    );
                    return Err(e);
                }
                log(
                    "WARN",
                    &format!(
                        "Connection error: {}, reconnecting ({}/{})...",
                        e, attempts, MAX_RECONNECT_ATTEMPTS
                    ),
                );
                std::thread::sleep(std::time::Duration::from_millis(RECONNECT_DELAY_MS));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_escape_simple() {
        assert_eq!(shell_escape_value("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_with_single_quotes() {
        assert_eq!(shell_escape_value("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_empty() {
        assert_eq!(shell_escape_value(""), "''");
    }

    #[test]
    fn prepend_env_empty() {
        assert_eq!(prepend_env("echo hi", &[]), "echo hi");
    }

    #[test]
    fn prepend_env_single() {
        assert_eq!(
            prepend_env("echo hi", &[("FOO", "bar")]),
            "export FOO='bar'; echo hi"
        );
    }

    #[test]
    fn prepend_env_multiple() {
        let result = prepend_env("cmd", &[("A", "1"), ("B", "2")]);
        assert_eq!(result, "export A='1' B='2'; cmd");
    }

    #[test]
    fn prepend_env_with_special_chars() {
        let result = prepend_env("cmd", &[("KEY", "it's a \"test\"")]);
        assert_eq!(result, "export KEY='it'\\''s a \"test\"'; cmd");
    }

    /// Helper: send a MSG_EXEC via the writer half, read MSG_EXEC_RESULT from the
    /// reader half, and return `(exit_code, stdout, stderr)`.
    fn send_exec_and_read_result(
        writer: &mut impl std::io::Write,
        reader: &mut impl std::io::Read,
        seq: u32,
        command: &str,
        timeout_ms: u32,
    ) -> (i32, Vec<u8>, Vec<u8>) {
        let payload = vsock_proto::encode_exec(timeout_ms, command, &[], false);
        let msg = vsock_proto::encode(MSG_EXEC, seq, &payload).unwrap();
        writer.write_all(&msg).unwrap();

        // Read response — first 4 bytes are length header
        let mut hdr = [0u8; 4];
        reader.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        reader.read_exact(&mut body).unwrap();

        // Decode
        let mut full = Vec::with_capacity(4 + body_len);
        full.extend_from_slice(&hdr);
        full.extend_from_slice(&body);
        let mut decoder = vsock_proto::Decoder::new();
        let msgs = decoder.decode(&full).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_EXEC_RESULT);
        assert_eq!(msgs[0].seq, seq);
        vsock_proto::decode_exec_result(&msgs[0].payload)
            .map(|(code, out, err)| (code, out.to_vec(), err.to_vec()))
            .unwrap()
    }

    /// Verify that a slow exec does not block a fast exec that arrives later.
    /// This is the core regression test for the non-blocking exec fix.
    #[test]
    fn slow_exec_does_not_block_fast_exec() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();

        // Run handle_connection in a background thread (it blocks on read)
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Read and discard the MSG_READY sent by handle_connection
        let mut hdr = [0u8; 4];
        host_stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        host_stream.read_exact(&mut body).unwrap();

        // Send a slow exec (sleep 5) — we won't wait for its result
        let slow_payload = vsock_proto::encode_exec(5000, "sleep 5", &[], false);
        let slow_msg = vsock_proto::encode(MSG_EXEC, 1, &slow_payload).unwrap();
        host_stream.write_all(&slow_msg).unwrap();

        // Give it a moment to start processing
        thread::sleep(Duration::from_millis(100));

        // Send a fast exec — this should return quickly despite the slow one
        let fast_payload = vsock_proto::encode_exec(5000, "echo ok", &[], false);
        let fast_msg = vsock_proto::encode(MSG_EXEC, 2, &fast_payload).unwrap();
        host_stream.write_all(&fast_msg).unwrap();

        // Read responses — we need to find seq=2 (the fast one) within 3 seconds.
        // Before the fix, this would block on the slow exec.
        host_stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();

        let mut decoder = vsock_proto::Decoder::new();
        let mut found_fast = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);

        while std::time::Instant::now() < deadline {
            let mut buf = [0u8; 4096];
            match host_stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                        if msg.seq == 2 && msg.msg_type == MSG_EXEC_RESULT {
                            let (code, stdout, _) =
                                vsock_proto::decode_exec_result(&msg.payload).unwrap();
                            assert_eq!(code, 0);
                            assert_eq!(String::from_utf8_lossy(stdout).trim(), "ok");
                            found_fast = true;
                        }
                    }
                    if found_fast {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("read error: {e}"),
            }
        }

        assert!(
            found_fast,
            "fast exec (seq=2) should complete while slow exec is still running"
        );

        // Shut down: drop the stream so handle_connection sees EOF
        drop(host_stream);
        let _ = handle.join();
    }

    #[test]
    fn truncate_preview_short_string() {
        let s = "echo hello";
        assert_eq!(truncate_preview(s), "echo hello");
    }

    #[test]
    fn truncate_preview_exact_limit() {
        let s = "x".repeat(COMMAND_PREVIEW_MAX_LEN);
        assert_eq!(truncate_preview(&s), s);
    }

    #[test]
    fn truncate_preview_over_limit() {
        let s = "y".repeat(COMMAND_PREVIEW_MAX_LEN + 50);
        let result = truncate_preview(&s);
        // Single-byte ASCII: truncates to exactly COMMAND_PREVIEW_MAX_LEN + "..."
        assert_eq!(
            result,
            format!("{}{}", "y".repeat(COMMAND_PREVIEW_MAX_LEN), "...")
        );
    }

    #[test]
    fn truncate_preview_multibyte_utf8() {
        // Each '🔥' is 4 bytes. Fill to just over the limit.
        let emoji = "🔥".repeat(COMMAND_PREVIEW_MAX_LEN / 4 + 5);
        let result = truncate_preview(&emoji);
        assert!(result.ends_with("..."));
        // Must not panic from slicing in the middle of a UTF-8 sequence
        assert!(result.is_char_boundary(result.len() - 3));
    }

    #[test]
    fn build_exec_command_normal() {
        let cmd = build_exec_command("echo hello", false);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sh -c "echo hello"
        // In release builds: su - user -c "echo hello"
        assert!(
            (prog == "sh" && args == ["-c", "echo hello"])
                || (prog == "su" && args == ["-", "user", "-c", "echo hello"]),
            "unexpected command: {prog} {args:?}"
        );
    }

    #[test]
    fn build_exec_command_sudo() {
        let cmd = build_exec_command("reboot", true);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sudo sh -c "reboot"
        // In release builds: sh -c "reboot"
        assert!(
            (prog == "sudo" && args == ["sh", "-c", "reboot"])
                || (prog == "sh" && args == ["-c", "reboot"]),
            "unexpected sudo command: {prog} {args:?}"
        );
    }

    #[test]
    fn extract_exit_code_success() {
        let status = Command::new("true").status().unwrap();
        assert_eq!(extract_exit_code(status), 0);
    }

    #[test]
    fn extract_exit_code_failure() {
        let status = Command::new("false").status().unwrap();
        assert_eq!(extract_exit_code(status), 1);
    }

    #[test]
    fn extract_exit_code_specific() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("exit 42")
            .status()
            .unwrap();
        assert_eq!(extract_exit_code(status), 42);
    }

    #[test]
    fn extract_exit_code_signal_kill() {
        // Kill a process with SIGKILL and verify 128 + 9 = 137
        let mut child = Command::new("sleep").arg("60").spawn().unwrap();
        unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
        let status = child.wait().unwrap();
        assert_eq!(extract_exit_code(status), 137);
    }

    /// Verify that a normal exec still returns correct results.
    #[test]
    fn exec_returns_correct_result() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
        let mut host_writer = host_stream.try_clone().unwrap();
        let mut host_reader = host_stream;

        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        let mut hdr = [0u8; 4];
        host_reader.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        host_reader.read_exact(&mut body).unwrap();

        host_reader
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

        let (code, stdout, _stderr) =
            send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "echo hello", 5000);
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "hello");

        drop(host_writer);
        drop(host_reader);
        let _ = handle.join();
    }

    /// Buffered exec killed by timeout returns exit code 124.
    #[test]
    fn exec_timeout_returns_124() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
        let mut host_writer = host_stream.try_clone().unwrap();
        let mut host_reader = host_stream;

        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        let mut hdr = [0u8; 4];
        host_reader.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        host_reader.read_exact(&mut body).unwrap();

        host_reader
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

        // sleep 60 with a 500ms timeout → killed by timeout
        let (code, _stdout, stderr) =
            send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "sleep 60", 500);
        assert_eq!(code, EXIT_CODE_TIMEOUT);
        assert_eq!(String::from_utf8_lossy(&stderr), "Timeout");

        drop(host_writer);
        drop(host_reader);
        let _ = handle.join();
    }

    /// Regression for #9701: `timeout_ms == 0` must mean "no timeout", not
    /// "kill immediately". Before the fix, `wait_with_timeout` built a
    /// `Duration::ZERO` and the killer thread fired on the first tick,
    /// returning exit 124 ("Timeout") for any command.
    #[test]
    fn exec_timeout_zero_means_no_timeout() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
        let mut host_writer = host_stream.try_clone().unwrap();
        let mut host_reader = host_stream;

        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        let mut hdr = [0u8; 4];
        host_reader.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        host_reader.read_exact(&mut body).unwrap();

        host_reader
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

        let (code, stdout, stderr) =
            send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "echo hello", 0);
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout), "hello\n");
        assert_eq!(stderr, b"");

        drop(host_writer);
        drop(host_reader);
        let _ = handle.join();
    }

    // -----------------------------------------------------------------------
    // Helpers for spawn_watch streaming tests
    // -----------------------------------------------------------------------

    /// Read one framed message from the stream and discard it.
    fn read_and_discard_message(stream: &mut impl std::io::Read) {
        let mut hdr = [0u8; 4];
        stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).unwrap();
    }

    /// Like `Read::read`, but retries on EINTR. `read_exact` retries
    /// internally; bare `read()` does not, and llvm-cov / profilers
    /// occasionally send signals that surface as EINTR on blocking reads.
    fn read_retry_eintr(stream: &mut impl std::io::Read, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            match stream.read(buf) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                other => return other,
            }
        }
    }

    /// Send a MSG_SPAWN_WATCH message with streaming enabled.
    fn send_spawn_watch(
        stream: &mut impl std::io::Write,
        seq: u32,
        command: &str,
        log_path: Option<&str>,
        timeout_ms: u32,
    ) {
        let payload =
            vsock_proto::encode_spawn_watch(timeout_ms, command, &[], false, true, log_path)
                .unwrap();
        let msg = vsock_proto::encode(MSG_SPAWN_WATCH, seq, &payload).unwrap();
        stream.write_all(&msg).unwrap();
    }

    /// Read all streaming messages for a spawn_watch command in a single loop.
    /// Uses one decoder to avoid losing messages when the OS batches multiple
    /// protocol frames into a single read buffer.
    ///
    /// Returns `(pid, stdout_data, exit_code, stderr)`.
    fn read_streaming_result(
        stream: &mut impl std::io::Read,
        seq: u32,
    ) -> (u32, Vec<u8>, i32, Vec<u8>) {
        let mut decoder = vsock_proto::Decoder::new();
        let mut buf = [0u8; 4096];
        let mut pid: Option<u32> = None;
        let mut stdout_data = Vec::new();
        loop {
            let n = read_retry_eintr(stream, &mut buf).unwrap();
            assert!(n > 0, "unexpected EOF waiting for streaming result");
            for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                // Pick up the PID from spawn_watch_result
                if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == seq {
                    pid = Some(vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap());
                    continue;
                }
                let Some(p) = pid else { continue };

                // Collect stdout chunks and return on process_exit
                if msg.msg_type == MSG_STDOUT_CHUNK
                    && let Ok((chunk_pid, data)) = vsock_proto::decode_stdout_chunk(&msg.payload)
                    && chunk_pid == p
                {
                    stdout_data.extend_from_slice(data);
                } else if msg.msg_type == MSG_PROCESS_EXIT
                    && let Ok((exit_pid, code, _stdout, stderr)) =
                        vsock_proto::decode_process_exit(&msg.payload)
                    && exit_pid == p
                {
                    return (p, stdout_data, code, stderr.to_vec());
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Streaming monitor integration tests
    // -----------------------------------------------------------------------

    /// Verify that streaming stdout works correctly for a normal command.
    #[test]
    fn streaming_monitor_normal_exit() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        let log_path = format!("/tmp/vsock-test-normal-{}.log", std::process::id());
        send_spawn_watch(&mut host_stream, 1, "echo hello", Some(&log_path), 5000);

        host_stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout_data).trim(), "hello");

        // Cleanup
        let _ = std::fs::remove_file(&log_path);
        drop(host_stream);
        let _ = handle.join();
    }

    /// Stream-only mode sends stdout chunks to the host without creating a
    /// guest-side tee file.
    #[test]
    fn streaming_monitor_stream_only_does_not_write_guest_log() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        let log_path = format!("/tmp/vsock-test-stream-only-{}.log", std::process::id());
        std::fs::write(&log_path, "preexisting\n").unwrap();
        send_spawn_watch(&mut host_stream, 1, "echo stream-only", None, 5000);

        host_stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout_data).trim(), "stream-only");
        let log_content = std::fs::read_to_string(&log_path).unwrap();
        assert_eq!(log_content, "preexisting\n");

        drop(host_stream);
        let _ = handle.join();
        let _ = std::fs::remove_file(&log_path);
    }

    /// Regression test: if the main child exits but an orphaned background
    /// process holds the stdout fd open, `send_process_exit` must still arrive
    /// within the drain deadline (DRAIN_DEADLINE_SECS).
    ///
    /// Before the fix, the monitor thread blocked forever on `stdout.read()`
    /// because the orphaned process kept the pipe write end open.
    #[test]
    fn streaming_monitor_drains_on_orphaned_stdout() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        // Command that writes to stdout, then spawns a background process
        // that inherits (and holds open) the stdout fd. The main shell exits
        // immediately but the backgrounded `sleep` keeps the pipe alive.
        let log_path = format!("/tmp/vsock-test-orphan-{}.log", std::process::id());
        send_spawn_watch(
            &mut host_stream,
            1,
            "echo orphan-test; sleep 30 &",
            Some(&log_path),
            0, // no timeout — relies entirely on drain deadline
        );

        // Set read timeout: drain deadline (5s) + generous margin (7s)
        host_stream
            .set_read_timeout(Some(Duration::from_secs(12)))
            .unwrap();

        let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, 0);
        assert!(
            String::from_utf8_lossy(&stdout_data).contains("orphan-test"),
            "expected stdout to contain 'orphan-test', got: {:?}",
            String::from_utf8_lossy(&stdout_data),
        );

        // Cleanup: kill the orphaned sleep process (best-effort)
        let _ = std::process::Command::new("pkill")
            .args(["-f", "sleep 30"])
            .status();
        let _ = std::fs::remove_file(&log_path);
        drop(host_stream);
        let _ = handle.join();
    }

    /// Verify that a streaming process killed by timeout returns exit code 124
    /// and delivers process_exit promptly.
    ///
    /// The timeout killer fires while the stdout thread is reading. SIGKILL
    /// breaks the pipe (EOF), the stdout thread exits, and the monitor thread
    /// reports exit_code = EXIT_CODE_TIMEOUT (124).
    #[test]
    fn streaming_monitor_timeout_kills_process() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        // Discard MSG_READY
        read_and_discard_message(&mut host_stream);

        // Command that runs longer than the timeout.
        // timeout_ms = 1000 (1s), command sleeps 60s → killed after 1s.
        let log_path = format!("/tmp/vsock-test-timeout-{}.log", std::process::id());
        send_spawn_watch(
            &mut host_stream,
            1,
            "echo timeout-test; sleep 60",
            Some(&log_path),
            1000, // 1 second timeout
        );

        // Timeout (1s) + drain (5s) + margin (4s)
        host_stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();

        let (pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(exit_code, EXIT_CODE_TIMEOUT);
        assert_eq!(String::from_utf8_lossy(&stderr), "Timeout");
        assert!(
            String::from_utf8_lossy(&stdout_data).contains("timeout-test"),
            "expected stdout to contain 'timeout-test', got: {:?}",
            String::from_utf8_lossy(&stdout_data),
        );

        let _ = std::fs::remove_file(&log_path);
        drop(host_stream);
        let _ = handle.join();
    }

    // -----------------------------------------------------------------------
    // Buffered (cancellable-drain) regression tests for #11077
    // -----------------------------------------------------------------------

    /// Send a `MSG_SPAWN_WATCH` with the buffered (no `stdout_log_path`) shape.
    fn send_spawn_watch_buffered(
        stream: &mut impl std::io::Write,
        seq: u32,
        command: &str,
        timeout_ms: u32,
    ) {
        let payload =
            vsock_proto::encode_spawn_watch(timeout_ms, command, &[], false, false, None).unwrap();
        let msg = vsock_proto::encode(MSG_SPAWN_WATCH, seq, &payload).unwrap();
        stream.write_all(&msg).unwrap();
    }

    /// Read `MSG_SPAWN_WATCH_RESULT` + `MSG_PROCESS_EXIT` for a buffered
    /// spawn_watch and return `(pid, exit_code, stdout, stderr)`.
    fn read_buffered_spawn_watch_result(
        stream: &mut impl std::io::Read,
        seq: u32,
    ) -> (u32, i32, Vec<u8>, Vec<u8>) {
        let mut decoder = vsock_proto::Decoder::new();
        let mut buf = [0u8; 4096];
        let mut pid: Option<u32> = None;
        loop {
            let n = read_retry_eintr(stream, &mut buf).unwrap();
            assert!(
                n > 0,
                "unexpected EOF waiting for buffered spawn_watch result"
            );
            for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == seq {
                    pid = Some(vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap());
                    continue;
                }
                let Some(p) = pid else { continue };
                if msg.msg_type == MSG_PROCESS_EXIT
                    && let Ok((exit_pid, code, stdout, stderr)) =
                        vsock_proto::decode_process_exit(&msg.payload)
                    && exit_pid == p
                {
                    return (p, code, stdout.to_vec(), stderr.to_vec());
                }
            }
        }
    }

    /// Regression for #11077 (`MSG_EXEC` side): with `timeout_ms = 0`, a
    /// backgrounded grandchild that inherits the stdout fd must NOT keep
    /// `MSG_EXEC_RESULT` from arriving after the foreground shell exits.
    /// Pre-fix, `wait_with_output` blocked on stdout EOF and waited the full
    /// ~30 s for the orphaned `sleep` to release the fd. Post-fix, the
    /// drain thread cancels at the deadline (well below 30 s) and we return.
    #[test]
    fn exec_returns_when_orphaned_grandchild_holds_stdout() {
        use std::os::unix::net::UnixStream as StdUnixStream;
        use std::time::Instant;

        let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
        let mut host_writer = host_stream.try_clone().unwrap();
        let mut host_reader = host_stream;

        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        read_and_discard_message(&mut host_reader); // MSG_READY

        host_reader
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();

        let start = Instant::now();
        let (code, stdout, _stderr) = send_exec_and_read_result(
            &mut host_writer,
            &mut host_reader,
            1,
            "echo orphan-exec; sleep 30 &",
            0,
        );
        let elapsed = start.elapsed();

        assert_eq!(code, 0);
        assert!(
            String::from_utf8_lossy(&stdout).contains("orphan-exec"),
            "expected stdout to contain 'orphan-exec', got: {:?}",
            String::from_utf8_lossy(&stdout),
        );
        assert!(
            elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS + 5),
            "MSG_EXEC_RESULT should arrive within drain deadline, took {elapsed:?}",
        );

        // Cleanup: kill the orphaned sleep
        let _ = std::process::Command::new("pkill")
            .args(["-f", "sleep 30"])
            .status();
        drop(host_writer);
        drop(host_reader);
        let _ = handle.join();
    }

    /// Returns true iff `pid` is still a live (or zombie-but-unreaped) process
    /// the test owner has permission to signal. Implemented via `kill(pid, 0)`,
    /// the canonical existence check. After bash dies via SIGPIPE the kernel
    /// reaps it (we're not its parent — it was reparented to PID 1 when its
    /// process group died), so this transitions to false.
    fn pid_alive(pid: u32) -> bool {
        // SAFETY: `kill` with sig=0 is a no-op existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// Regression for #11077: when the host drops the vsock connection
    /// mid-stream, the streaming monitor's stdout drain hits a write failure
    /// on its next chunk forward, signals cancel, drops the pipe fd, and the
    /// child receives SIGPIPE on its next stdout write — terminating well
    /// inside the drain deadline rather than running until `JOB_TIMEOUT`.
    ///
    /// Pre-cancel-fix this loop was preserved by an explicit `break` on write
    /// failure; the refactor moved chunk handling into a closure that has no
    /// way to break the helper's loop, so we re-introduce the same fast-stop
    /// behavior via the cancel flag. This test pins that behavior down.
    #[test]
    fn streaming_terminates_child_on_vsock_disconnect() {
        use std::os::unix::net::UnixStream as StdUnixStream;
        use std::time::Instant;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });
        read_and_discard_message(&mut host_stream); // MSG_READY

        // Long-running command that writes stdout every ~50 ms — gives the
        // streaming drain a chunk to forward at high frequency, so the post-
        // disconnect write failure is observed promptly.
        let log_path = format!("/tmp/vsock-test-disco-{}.log", std::process::id());
        send_spawn_watch(
            &mut host_stream,
            1,
            "while true; do echo tick; sleep 0.05; done",
            Some(&log_path),
            0, // no timeout — we want SIGPIPE, not the kill watchdog, to terminate
        );

        host_stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();

        // Read until we observe both `MSG_SPAWN_WATCH_RESULT` (for the pid)
        // and at least one `MSG_STDOUT_CHUNK` (proving the drain is live).
        let mut decoder = vsock_proto::Decoder::new();
        let mut buf = [0u8; 4096];
        let mut pid: Option<u32> = None;
        let mut got_chunk = false;
        let stream_deadline = Instant::now() + Duration::from_secs(3);
        while pid.is_none() || !got_chunk {
            assert!(
                Instant::now() < stream_deadline,
                "did not see spawn_watch_result + stdout chunk in time (pid={pid:?}, chunk={got_chunk})",
            );
            let n = read_retry_eintr(&mut host_stream, &mut buf).unwrap();
            for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == 1 {
                    pid = vsock_proto::decode_spawn_watch_result(&msg.payload).ok();
                } else if msg.msg_type == MSG_STDOUT_CHUNK {
                    got_chunk = true;
                }
            }
        }
        let pid = pid.unwrap();
        assert!(
            pid_alive(pid),
            "child should still be running before disconnect"
        );

        // Disconnect: dropping host_stream closes the host end of the
        // UnixStream pair. The next chunk-forward attempt in the guest
        // returns BrokenPipe → on_chunk closure stores cancel → drain
        // breaks → ChildStdout drops → bash gets SIGPIPE on its next echo.
        drop(host_stream);
        let _ = handle.join();

        // Wait for the child to terminate. Timing budget: ≤100 ms drain
        // poll + 50 ms next echo + tear-down. 5 s deadline is generous.
        let kill_deadline = Instant::now() + Duration::from_secs(5);
        while pid_alive(pid) {
            if Instant::now() >= kill_deadline {
                // Best-effort cleanup before failing
                // SAFETY: pid was obtained from MSG_SPAWN_WATCH_RESULT.
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                let _ = std::fs::remove_file(&log_path);
                panic!("pid {pid} did not terminate within 5s after vsock disconnect");
            }
            thread::sleep(Duration::from_millis(50));
        }

        let _ = std::fs::remove_file(&log_path);
    }

    /// Regression: a child producing > 64 KB on **both** stdout and stderr
    /// concurrently must not deadlock. The kernel pipe buffer is ~64 KB; if
    /// either drain were sequential (waiting for the other to finish first),
    /// the second pipe would fill, the child would block on its next write,
    /// and the test would hit the read timeout.
    ///
    /// Pins down the concurrent-drain invariant of `wait_with_drain_and_timeout`
    /// shared by `MSG_EXEC` and buffered `MSG_SPAWN_WATCH`. The streaming
    /// path in `spawn_streaming_monitor` follows the same
    /// stderr-thread-before-stdout-thread structure for the same reason.
    #[test]
    fn buffered_spawn_watch_concurrent_large_stdout_stderr() {
        use std::os::unix::net::UnixStream as StdUnixStream;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });
        read_and_discard_message(&mut host_stream); // MSG_READY

        // Read timeout well above any reasonable runtime. If we deadlock on
        // a full pipe, the child blocks on write(), drain returns nothing,
        // and we hit this timeout — the failure mode this test guards.
        host_stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();

        // Each pipeline produces exactly 100 KB; the two pipelines run
        // concurrently so stdout and stderr are interleaved producers.
        // 100 KB > the ~64 KB pipe buffer on Linux, so a single-threaded
        // drainer would visibly stall.
        send_spawn_watch_buffered(
            &mut host_stream,
            1,
            "{ yes A | head -c 102400; } & { yes B | head -c 102400 >&2; } & wait",
            10_000,
        );
        let (pid, code, stdout, stderr) = read_buffered_spawn_watch_result(&mut host_stream, 1);

        assert!(pid > 0);
        assert_eq!(code, 0);
        assert_eq!(
            stdout.len(),
            102_400,
            "stdout should be exactly 100 KB, got {} bytes",
            stdout.len(),
        );
        assert_eq!(
            stderr.len(),
            102_400,
            "stderr should be exactly 100 KB, got {} bytes",
            stderr.len(),
        );
        assert!(stdout.iter().all(|&b| b == b'A' || b == b'\n'));
        assert!(stderr.iter().all(|&b| b == b'B' || b == b'\n'));

        drop(host_stream);
        let _ = handle.join();
    }

    /// Regression for #11077 (`MSG_SPAWN_WATCH` buffered side): symmetric to
    /// `streaming_monitor_drains_on_orphaned_stdout`. Pre-fix, the buffered
    /// monitor used the same `wait_with_output` and hung on a leaked stdout
    /// fd. Post-fix, drain threads observe the cancel flag at the deadline,
    /// drop the pipe read end, and the orphan's next write returns EPIPE.
    #[test]
    fn buffered_spawn_watch_returns_when_orphaned_grandchild_holds_stdout() {
        use std::os::unix::net::UnixStream as StdUnixStream;
        use std::time::Instant;

        let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
        let handle = thread::spawn(move || {
            let _ = handle_connection(guest_stream);
        });

        read_and_discard_message(&mut host_stream); // MSG_READY

        host_stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();

        let start = Instant::now();
        send_spawn_watch_buffered(&mut host_stream, 1, "echo orphan-buf; sleep 30 &", 0);
        let (pid, code, stdout, _stderr) = read_buffered_spawn_watch_result(&mut host_stream, 1);
        let elapsed = start.elapsed();

        assert!(pid > 0);
        assert_eq!(code, 0);
        assert!(
            String::from_utf8_lossy(&stdout).contains("orphan-buf"),
            "expected stdout to contain 'orphan-buf', got: {:?}",
            String::from_utf8_lossy(&stdout),
        );
        assert!(
            elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS + 5),
            "MSG_PROCESS_EXIT should arrive within drain deadline, took {elapsed:?}",
        );

        let _ = std::process::Command::new("pkill")
            .args(["-f", "sleep 30"])
            .status();
        drop(host_stream);
        let _ = handle.join();
    }

    #[test]
    fn parse_stat_ppid_pgid_normal() {
        let stat = "42 (bash) S 10 42 42 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 100 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((10, 42)));
    }

    #[test]
    fn parse_stat_ppid_pgid_comm_with_spaces() {
        // comm can contain spaces and parens
        let stat = "99 (Web Content (123)) S 50 99 99 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((50, 99)));
    }

    #[test]
    fn parse_stat_ppid_pgid_setsid_child() {
        // After setsid(): pgid (77) differs from parent's pgid
        let stat = "77 (su) S 42 77 77 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((42, 77)));
    }

    #[test]
    fn parse_stat_ppid_pgid_empty() {
        assert_eq!(parse_stat_ppid_pgid(""), None);
    }

    #[test]
    fn parse_stat_ppid_pgid_truncated() {
        // Only has closing paren, no fields after
        assert_eq!(parse_stat_ppid_pgid("1 (x)"), None);
    }

    #[test]
    fn parse_stat_ppid_pgid_not_enough_fields() {
        // Has state but no ppid/pgid
        assert_eq!(parse_stat_ppid_pgid("1 (x) S\n"), None);
    }

    #[test]
    fn parse_stat_ppid_pgid_empty_comm() {
        let stat = "1 () S 10 42 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((10, 42)));
    }

    #[test]
    fn parse_stat_ppid_pgid_no_closing_paren() {
        assert_eq!(parse_stat_ppid_pgid("1 bash S 10 42 42"), None);
    }
}
