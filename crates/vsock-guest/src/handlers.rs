use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
#[cfg(test)]
use std::process::Child;
use std::process::{Command, Stdio};
use std::sync::Arc;
#[cfg(any(debug_assertions, feature = "test-support"))]
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use vsock_proto::{
    self, BorrowedRawMessage, MSG_ERROR, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_WRITE_FILE_RESULT,
    MSG_WRITE_FILES_RESULT,
};

use crate::containment::ContainmentManager;
use crate::drain::drain_into_vec_cancellable;
use crate::error::to_io_error;
use crate::log::log;
use crate::process::{ContainedChild, SpawnContainmentError, extract_exit_code, spawn_contained};
#[cfg(test)]
use crate::process::{kill_and_reap_child, spawn_in_own_process_group};
use crate::quiesce::OperationGuard;
use crate::shutdown::handle_shutdown;
use crate::threading::{SystemThreadSpawner, ThreadSpawner, spawn_scoped_named};
use crate::user::apply_write_file_identity;
use crate::wait::{
    WaitOutcome, await_drain_deadline, terminate_contained_child,
    wait_contained_with_timeout_and_pre_reap_cleanup,
};

const THREAD_WRITE_STDERR: &str = "vsock-write-stderr";
const THREAD_WRITE_STDIN: &str = "vsock-write-stdin";
const WRITE_TIMEOUT_MS: u32 = 30_000;
const GUEST_WRITE_FILE_PATH: &str = "/sbin/guest-write-file";
#[cfg(any(debug_assertions, feature = "test-support"))]
static DEBUG_GUEST_WRITE_FILE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(crate) enum MessageOutcome {
    Response(Vec<u8>),
    Shutdown(Vec<u8>),
}

pub(crate) struct DecodedWriteFileMessage<'a> {
    path: &'a str,
    content: &'a [u8],
    use_sudo: bool,
    append: bool,
    private: bool,
}

pub(crate) struct DecodedWriteFilesMessage<'a> {
    payload: &'a [u8],
    file_count: usize,
    content_bytes: usize,
}

pub(crate) struct GuardedWriteResponse {
    pub(crate) frame: Vec<u8>,
    pub(crate) fatal: bool,
}

/// Handle write_file message
fn handle_write_file(
    path: &str,
    content: &[u8],
    use_sudo: bool,
    append: bool,
    private: bool,
    operation_guard: &OperationGuard,
) -> (bool, String, bool) {
    log(
        "INFO",
        &format!(
            "write_file: path={} size={} sudo={} append={} private={}",
            path,
            content.len(),
            use_sudo,
            append,
            private,
        ),
    );

    let process = match spawn_write_file_command(
        path,
        use_sudo,
        append,
        private,
        &operation_guard.containment(),
    ) {
        Ok(process) => process,
        Err(error) => {
            let fatal = error.is_fatal();
            return (
                false,
                format!("Failed to spawn write command: {error}"),
                fatal,
            );
        }
    };

    wait_contained_write_file_child(process, content, SystemThreadSpawner, |diagnostic| {
        operation_guard.poison(diagnostic.to_owned());
    })
}

fn handle_write_files(
    payload: &[u8],
    file_count: usize,
    content_bytes: usize,
    operation_guard: &OperationGuard,
) -> (bool, String, bool) {
    log(
        "INFO",
        &format!("write_files: files={file_count} content_bytes={content_bytes}"),
    );

    let process = match spawn_write_files_command(&operation_guard.containment()) {
        Ok(process) => process,
        Err(error) => {
            let fatal = error.is_fatal();
            return (
                false,
                format!("Failed to spawn batch write command: {error}"),
                fatal,
            );
        }
    };

    wait_contained_write_file_child(process, payload, SystemThreadSpawner, |diagnostic| {
        operation_guard.poison(diagnostic.to_owned());
    })
}

#[cfg(test)]
fn wait_write_file_child<S>(child: Child, content: &[u8], spawner: S) -> (bool, String)
where
    S: ThreadSpawner,
{
    wait_write_file_child_with_timeout(child, content, WRITE_TIMEOUT_MS, spawner)
}

#[cfg(test)]
fn wait_write_file_child_with_timeout<S>(
    child: Child,
    content: &[u8],
    timeout_ms: u32,
    spawner: S,
) -> (bool, String)
where
    S: ThreadSpawner,
{
    let process = match ContainedChild::from_process_group(child) {
        Ok(process) => process,
        Err(error) => return (false, format!("write containment setup failed: {error}")),
    };
    let (success, error, _) =
        wait_contained_write_file_child_with_timeout(process, content, timeout_ms, spawner, |_| {});
    (success, error)
}

fn wait_contained_write_file_child<S, F>(
    process: ContainedChild,
    content: &[u8],
    spawner: S,
    on_fatal: F,
) -> (bool, String, bool)
where
    S: ThreadSpawner,
    F: Fn(&str),
{
    wait_contained_write_file_child_with_timeout(
        process,
        content,
        WRITE_TIMEOUT_MS,
        spawner,
        on_fatal,
    )
}

fn wait_contained_write_file_child_with_timeout<S, F>(
    mut process: ContainedChild,
    content: &[u8],
    timeout_ms: u32,
    spawner: S,
    on_fatal: F,
) -> (bool, String, bool)
where
    S: ThreadSpawner,
    F: Fn(&str),
{
    let stdin_pipe = match process.child.stdin.take() {
        Some(p) => p,
        None => {
            return cleanup_write_failure(process, "missing stdin pipe");
        }
    };
    // Drain stderr concurrently with wait via the cancellable helper. Stdout
    // is `Stdio::null()` so there's no orphan-fd hazard there. Stdin is also
    // written from a helper thread so a child that stalls before reading stdin
    // cannot block the connection loop before timeout enforcement starts.
    // After the child exits, the drain thread either reaches EOF naturally or
    // — if a grandchild somehow still holds stderr — is cut at the deadline so
    // its last write returns EPIPE.
    // Defensive: same invariant as the shared drain helper — reap the child if
    // its stderr is somehow already gone, so we don't leave a zombie.
    let stderr_pipe = match process.child.stderr.take() {
        Some(p) => p,
        None => {
            return cleanup_write_failure(process, "missing stderr pipe");
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let stderr_handle = {
        let drain_cancel = cancel.clone();
        match spawner.spawn_vec(
            THREAD_WRITE_STDERR,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stderr_pipe, &drain_cancel);
                let _ = done_tx.send(());
                buf
            }),
        ) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                drop(stdin_pipe);
                return cleanup_write_failure(
                    process,
                    &format!("Failed to spawn stderr drain thread: {e}"),
                );
            }
        }
    };

    std::thread::scope(|scope| {
        let (stdin_done_tx, stdin_done_rx) = std::sync::mpsc::channel::<()>();
        let stdin_cancel = Arc::new(AtomicBool::new(false));
        let stdin_cancel_worker = stdin_cancel.clone();
        let stdin_handle = match spawn_scoped_named(scope, THREAD_WRITE_STDIN, move || {
            let mut stdin = stdin_pipe;
            let result = write_all_cancellable(&mut stdin, content, &stdin_cancel_worker);
            let _ = stdin_done_tx.send(());
            result
        }) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                let cleanup = terminate_contained_child(process);
                let _ = await_drain_deadline(&done_rx, 1, &cancel);
                let _ = stderr_handle.join();
                return match cleanup {
                    Ok(()) => (
                        false,
                        format!("Failed to spawn stdin writer thread: {e}"),
                        false,
                    ),
                    Err(cleanup_error) => (
                        false,
                        format!(
                            "Failed to spawn stdin writer thread: {e}; exec containment cleanup failed: {cleanup_error}"
                        ),
                        true,
                    ),
                };
            }
        };

        let outcome = wait_contained_with_timeout_and_pre_reap_cleanup(process, timeout_ms, || {
            let pending = matches!(
                stdin_done_rx.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            );
            if pending {
                stdin_cancel.store(true, Ordering::Release);
            }
            pending
        });
        if let WaitOutcome::Fatal(diagnostic) = &outcome {
            on_fatal(diagnostic);
            cancel.store(true, Ordering::Release);
        }
        stdin_cancel.store(true, Ordering::Release);
        let stdin_result = match stdin_handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };

        let _ = await_drain_deadline(&done_rx, 1, &cancel);
        let stderr = stderr_handle.join().unwrap_or_default();

        match outcome {
            WaitOutcome::TimedOut => (false, "write timed out".to_string(), false),
            WaitOutcome::Cancelled => (false, "write cancelled".to_string(), false),
            WaitOutcome::WaitFailed(msg) => (false, format!("write wait failed: {msg}"), false),
            WaitOutcome::Fatal(msg) => (false, msg, true),
            WaitOutcome::Exited(s) => {
                let exit_code = extract_exit_code(s);
                if exit_code != 0 {
                    let stderr_str = String::from_utf8_lossy(&stderr);
                    return (false, format!("write failed: {stderr_str}"), false);
                }
                if let Err(e) = stdin_result {
                    return (false, format!("Failed to write to stdin: {e}"), false);
                }
                (true, String::new(), false)
            }
        }
    })
}

fn write_all_cancellable<W>(writer: &mut W, content: &[u8], cancel: &AtomicBool) -> io::Result<()>
where
    W: Write + AsRawFd,
{
    let fd = writer.as_raw_fd();
    set_nonblocking(fd)?;
    let mut written = 0usize;
    while written < content.len() {
        if cancel.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "write cancelled",
            ));
        }
        let remaining = content
            .get(written..)
            .ok_or_else(|| io::Error::other("write offset exceeded content length"))?;
        match writer.write(remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "failed to write content",
                ));
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_write_ready(fd, cancel)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn set_nonblocking(fd: libc::c_int) -> io::Result<()> {
    // SAFETY: fd is the owned write-helper stdin descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: F_SETFL updates status flags on the same open descriptor.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn wait_write_ready(fd: libc::c_int, cancel: &AtomicBool) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "write cancelled",
            ));
        }
        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: pollfd points to one initialized descriptor entry.
        let result = unsafe { libc::poll(&mut pollfd, 1, 50) };
        if result > 0 {
            if pollfd.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "write-helper stdin descriptor is invalid",
                ));
            }
            if pollfd.revents & (libc::POLLOUT | libc::POLLHUP | libc::POLLERR) != 0 {
                return Ok(());
            }
        } else if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

fn cleanup_write_failure(process: ContainedChild, diagnostic: &str) -> (bool, String, bool) {
    match terminate_contained_child(process) {
        Ok(()) => (false, diagnostic.to_owned(), false),
        Err(error) => (
            false,
            format!("{diagnostic}; exec containment cleanup failed: {error}"),
            true,
        ),
    }
}

fn write_file_command_args(
    use_sudo: bool,
    append: bool,
    private: bool,
) -> io::Result<Vec<&'static str>> {
    if private && use_sudo {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private write_file cannot use sudo",
        ));
    }

    let mut args = Vec::new();
    if private {
        args.push("--private");
    }
    if append {
        args.push("--append");
    } else if !use_sudo && !private {
        args.push("--create-parents");
    }
    Ok(args)
}

fn spawn_write_file_command(
    path: &str,
    use_sudo: bool,
    append: bool,
    private: bool,
    containment: &ContainmentManager,
) -> Result<ContainedChild, SpawnContainmentError> {
    let mut command = Command::new(guest_write_file_path());
    for arg in write_file_command_args(use_sudo, append, private)? {
        command.arg(arg);
    }
    command
        .arg("--")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    spawn_contained(&mut command, containment, |command| {
        apply_write_file_identity(command, use_sudo)
    })
}

fn spawn_write_files_command(
    containment: &ContainmentManager,
) -> Result<ContainedChild, SpawnContainmentError> {
    let mut command = Command::new(guest_write_file_path());
    command
        .arg("--batch")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    spawn_contained(&mut command, containment, |command| {
        apply_write_file_identity(command, false)
    })
}

fn guest_write_file_path() -> PathBuf {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        DEBUG_GUEST_WRITE_FILE_PATH
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| PathBuf::from(GUEST_WRITE_FILE_PATH))
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        PathBuf::from(GUEST_WRITE_FILE_PATH)
    }
}

#[cfg(any(debug_assertions, feature = "test-support"))]
pub(crate) fn set_debug_guest_write_file_path(path: PathBuf) {
    *DEBUG_GUEST_WRITE_FILE_PATH
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(path);
}

pub(crate) fn decode_write_file_message(
    payload: &[u8],
) -> Result<DecodedWriteFileMessage<'_>, vsock_proto::ProtocolError> {
    let (path, content, use_sudo, append, private) = vsock_proto::decode_write_file(payload)?;
    Ok(DecodedWriteFileMessage {
        path,
        content,
        use_sudo,
        append,
        private,
    })
}

pub(crate) fn decode_write_files_message(
    payload: &[u8],
) -> Result<DecodedWriteFilesMessage<'_>, vsock_proto::ProtocolError> {
    let files = vsock_proto::decode_write_files(payload)?;
    let content_bytes = files.iter().map(|file| file.content.len()).sum();
    Ok(DecodedWriteFilesMessage {
        payload,
        file_count: files.len(),
        content_bytes,
    })
}

pub(crate) fn handle_decoded_write_file_message(
    seq: u32,
    decoded: DecodedWriteFileMessage<'_>,
    operation_guard: &OperationGuard,
) -> io::Result<GuardedWriteResponse> {
    let (success, error, fatal) = handle_write_file(
        decoded.path,
        decoded.content,
        decoded.use_sudo,
        decoded.append,
        decoded.private,
        operation_guard,
    );
    if fatal {
        operation_guard.poison(error.clone());
    }
    let payload = vsock_proto::encode_write_file_result(success, &error);
    let frame = vsock_proto::encode(MSG_WRITE_FILE_RESULT, seq, &payload).map_err(to_io_error)?;
    Ok(GuardedWriteResponse { frame, fatal })
}

pub(crate) fn handle_decoded_write_files_message(
    seq: u32,
    decoded: DecodedWriteFilesMessage<'_>,
    operation_guard: &OperationGuard,
) -> io::Result<GuardedWriteResponse> {
    let (success, error, fatal) = handle_write_files(
        decoded.payload,
        decoded.file_count,
        decoded.content_bytes,
        operation_guard,
    );
    if fatal {
        operation_guard.poison(error.clone());
    }
    let payload = vsock_proto::encode_write_files_result(success, &error);
    let frame = vsock_proto::encode(MSG_WRITE_FILES_RESULT, seq, &payload).map_err(to_io_error)?;
    Ok(GuardedWriteResponse { frame, fatal })
}

/// Handle basic incoming messages and return the connection-loop outcome.
///
/// Exec operation and guarded write-file operations are handled separately by
/// the connection dispatcher.
pub(crate) fn handle_basic_message(msg: BorrowedRawMessage<'_>) -> io::Result<MessageOutcome> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(MessageOutcome::Response(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_SHUTDOWN => {
            if let Err(error) =
                vsock_proto::decode_empty_payload("shutdown payload must be empty", msg.payload)
            {
                return encode_error_response(msg.seq, &error.to_string());
            }
            Ok(MessageOutcome::Shutdown(handle_shutdown(msg.seq)?))
        }
        _ => encode_error_response(
            msg.seq,
            &format!("Unknown message type: 0x{:02X}", msg.msg_type),
        ),
    }
}

fn encode_error_response(seq: u32, message: &str) -> io::Result<MessageOutcome> {
    let payload = vsock_proto::encode_error(message);
    Ok(MessageOutcome::Response(
        vsock_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::io::{BufRead, BufReader};
    #[cfg(target_os = "linux")]
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "linux")]
    use crate::test_support::{kill_pidfd_and_wait, open_pidfd, wait_for_pidfd_exit};
    use crate::threading::test_support::FailingThreadSpawner;
    use std::sync::Mutex;

    static WRITE_FILE_CHILD_TESTS: Mutex<()> = Mutex::new(());

    fn spawn_write_file_test_child(script: &str) -> Child {
        // Use a stable shell binary instead of a freshly written temp
        // executable; some CI filesystems can transiently reject immediate exec
        // of a just-created file with ETXTBSY.
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        spawn_in_own_process_group(&mut command).unwrap()
    }

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_child_starts_as_process_group_leader() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60");
        let pid = child.id();

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        kill_and_reap_child(child);

        assert_eq!(pgid, pid as libc::pid_t);
    }

    #[test]
    fn write_file_stderr_drain_spawn_failure_kills_and_reaps_child() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60");
        let pid = child.id();

        let (success, error) = wait_write_file_child(
            child,
            b"",
            FailingThreadSpawner::fail_once(THREAD_WRITE_STDERR),
        );

        assert!(!success);
        assert!(error.contains("stderr drain thread"));
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn write_file_command_args_use_private_mode_without_create_parents() {
        let args = write_file_command_args(false, false, true).unwrap();

        assert_eq!(args, vec!["--private"]);
    }

    #[test]
    fn write_file_command_args_use_private_append_mode() {
        let args = write_file_command_args(false, true, true).unwrap();

        assert_eq!(args, vec!["--private", "--append"]);
    }

    #[test]
    fn write_file_command_args_reject_private_sudo() {
        let error = write_file_command_args(true, false, true).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn write_file_timeout_kills_child_while_stdin_writer_is_blocked() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60; cat >/dev/null");
        let pid = child.id();
        let content = vec![b'x'; 1024 * 1024];

        let (success, error) =
            wait_write_file_child_with_timeout(child, &content, 10, SystemThreadSpawner);

        assert!(!success);
        assert_eq!(error, "write timed out");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn write_file_kills_lingering_process_group_after_parent_exit() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let fifo_path = std::env::temp_dir().join(format!(
            "vsock-write-file-stdin-{}-{}.fifo",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                "mkfifo \"$FIFO\"; \
                 exec 3<&0; \
                 sleep 60 <&3 >/dev/null 2>/dev/null & \
                 printf '%s\\n' \"$!\"; \
                 exec 3<&-; \
                 read _ < \"$FIFO\"; \
                 rm -f \"$FIFO\"; \
                 exit 0",
            )
            .env("FIFO", &fifo_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = spawn_in_own_process_group(&mut command).unwrap();
        let pid = child.id();
        let stdout = child.stdout.take().unwrap();
        let mut descendant_pid = String::new();
        BufReader::new(stdout)
            .read_line(&mut descendant_pid)
            .unwrap();
        let descendant_pid = descendant_pid.trim().parse::<libc::pid_t>().unwrap();
        let descendant_pidfd = open_pidfd(descendant_pid).unwrap();
        let mut fifo = std::fs::OpenOptions::new()
            .write(true)
            .open(&fifo_path)
            .unwrap();
        writeln!(fifo, "exit").unwrap();
        drop(fifo);
        let content = vec![b'x'; 1024 * 1024];

        let (success, error) =
            wait_write_file_child_with_timeout(child, &content, 1_000, SystemThreadSpawner);
        let _ = std::fs::remove_file(&fifo_path);

        assert!(!success);
        assert!(error.contains("Failed to write to stdin"), "got: {error}");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
        match wait_for_pidfd_exit(&descendant_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&descendant_pidfd).unwrap_or_else(|cleanup| {
                    panic!(
                        "failed to clean up lingering descendant pid {descendant_pid}: {cleanup}"
                    )
                });
                panic!("lingering descendant pid {descendant_pid} should be terminated");
            }
            Err(error) => {
                let cleanup = kill_pidfd_and_wait(&descendant_pidfd);
                panic!(
                    "failed to wait for lingering descendant pid {descendant_pid}: {error}; cleanup={cleanup:?}"
                );
            }
        }
    }
}
