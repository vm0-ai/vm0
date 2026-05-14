use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
#[cfg(any(debug_assertions, feature = "test-support"))]
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use vsock_proto::{
    self, MSG_ERROR, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_WRITE_FILE_RESULT, RawMessage,
};

use crate::drain::drain_into_vec_cancellable;
use crate::error::to_io_error;
use crate::exec::spawn_in_own_process_group;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, kill_process_tree};
use crate::shutdown::handle_shutdown;
use crate::threading::{SystemThreadSpawner, ThreadSpawner, spawn_scoped_named};
use crate::user::apply_write_file_identity;
use crate::wait::{WaitOutcome, await_drain_deadline, wait_with_kill_timeout};

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

    let child = match spawn_write_file_command(path, use_sudo, append) {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn write command: {e}")),
    };

    wait_write_file_child(child, content, SystemThreadSpawner)
}

fn wait_write_file_child<S>(child: Child, content: &[u8], spawner: S) -> (bool, String)
where
    S: ThreadSpawner,
{
    wait_write_file_child_with_timeout(child, content, WRITE_TIMEOUT_MS, spawner)
}

fn wait_write_file_child_with_timeout<S>(
    mut child: Child,
    content: &[u8],
    timeout_ms: u32,
    spawner: S,
) -> (bool, String)
where
    S: ThreadSpawner,
{
    let child_pid = child.id();
    let stdin_pipe = match child.stdin.take() {
        Some(p) => p,
        None => {
            kill_and_reap_child(child);
            return (false, "missing stdin pipe".to_string());
        }
    };
    // Drain stderr concurrently with wait via the cancellable helper. Stdout
    // is `Stdio::null()` so there's no orphan-fd hazard there. Stdin is also
    // written from a helper thread so a child that stalls before reading stdin
    // cannot block the connection loop before timeout enforcement starts.
    // After the child exits, the drain thread either reaches EOF naturally or
    // — if a grandchild somehow still holds stderr — is cut at the deadline so
    // its last write returns EPIPE.
    // Defensive: same invariant as the exec drain helper — reap the child if
    // its stderr is somehow already gone, so we don't leave a zombie.
    let stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None => {
            kill_and_reap_child(child);
            return (false, "missing stderr pipe".to_string());
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
                kill_and_reap_child(child);
                return (false, format!("Failed to spawn stderr drain thread: {e}"));
            }
        }
    };

    std::thread::scope(|scope| {
        let (stdin_done_tx, stdin_done_rx) = std::sync::mpsc::channel::<()>();
        let stdin_handle = match spawn_scoped_named(scope, THREAD_WRITE_STDIN, move || {
            let mut stdin = stdin_pipe;
            let result = stdin.write_all(content);
            let _ = stdin_done_tx.send(());
            result
        }) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, std::sync::atomic::Ordering::Release);
                kill_and_reap_child(child);
                let _ = await_drain_deadline(&done_rx, 1, &cancel);
                let _ = stderr_handle.join();
                return (false, format!("Failed to spawn stdin writer thread: {e}"));
            }
        };

        let outcome = wait_with_kill_timeout(child, timeout_ms);
        if matches!(outcome, WaitOutcome::Exited(_) | WaitOutcome::WaitFailed(_))
            && matches!(
                stdin_done_rx.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            )
        {
            // The direct helper exited, but a descendant may still hold the
            // stdin pipe open without reading from it. Kill the helper's
            // process group before joining the writer, otherwise write_all()
            // can block forever on a full pipe.
            let _ = unsafe { kill_process_tree(child_pid) };
        }
        let stdin_result = match stdin_handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };

        let _ = await_drain_deadline(&done_rx, 1, &cancel);
        let stderr = stderr_handle.join().unwrap_or_default();

        match outcome {
            WaitOutcome::TimedOut => (false, "write timed out".to_string()),
            WaitOutcome::Cancelled => (false, "write cancelled".to_string()),
            WaitOutcome::WaitFailed(msg) => (false, format!("write wait failed: {msg}")),
            WaitOutcome::Exited(s) => {
                let exit_code = extract_exit_code(s);
                if exit_code != 0 {
                    let stderr_str = String::from_utf8_lossy(&stderr);
                    return (false, format!("write failed: {stderr_str}"));
                }
                if let Err(e) = stdin_result {
                    return (false, format!("Failed to write to stdin: {e}"));
                }
                (true, String::new())
            }
        }
    })
}

fn spawn_write_file_command(path: &str, use_sudo: bool, append: bool) -> io::Result<Child> {
    let mut command = Command::new(guest_write_file_path());
    if append {
        command.arg("--append");
    } else if !use_sudo {
        command.arg("--create-parents");
    }
    command
        .arg("--")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_write_file_identity(&mut command, use_sudo)?;
    spawn_in_own_process_group(&mut command)
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
pub(crate) fn set_debug_guest_write_file_path(path: PathBuf) -> Result<(), PathBuf> {
    *DEBUG_GUEST_WRITE_FILE_PATH
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(path);
    Ok(())
}

pub(crate) fn decode_write_file_message(
    msg: &RawMessage,
) -> io::Result<DecodedWriteFileMessage<'_>> {
    let (path, content, use_sudo, append) =
        vsock_proto::decode_write_file(&msg.payload).map_err(to_io_error)?;
    Ok(DecodedWriteFileMessage {
        path,
        content,
        use_sudo,
        append,
    })
}

pub(crate) fn handle_decoded_write_file_message(
    seq: u32,
    decoded: DecodedWriteFileMessage<'_>,
) -> io::Result<Vec<u8>> {
    let (success, error) = handle_write_file(
        decoded.path,
        decoded.content,
        decoded.use_sudo,
        decoded.append,
    );
    let payload = vsock_proto::encode_write_file_result(success, &error);
    vsock_proto::encode(MSG_WRITE_FILE_RESULT, seq, &payload).map_err(to_io_error)
}

/// Handle incoming message and return the connection-loop outcome.
///
/// Command operation, `MSG_SPAWN_WATCH`, and guarded write-file operations are
/// handled separately in `handle_connection`.
pub(crate) fn handle_message(msg: &RawMessage) -> io::Result<MessageOutcome> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(MessageOutcome::Response(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_SHUTDOWN => Ok(MessageOutcome::Shutdown(handle_shutdown(msg.seq)?)),
        _ => {
            let payload =
                vsock_proto::encode_error(&format!("Unknown message type: 0x{:02X}", msg.msg_type));
            Ok(MessageOutcome::Response(
                vsock_proto::encode(MSG_ERROR, msg.seq, &payload).map_err(to_io_error)?,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let _ = unsafe { crate::process::kill_process_tree(pid) };
        let _ = wait_with_kill_timeout(child, 100);

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

    #[test]
    fn write_file_kills_lingering_process_group_after_parent_exit() {
        let _guard = WRITE_FILE_CHILD_TESTS.lock().unwrap();
        let child = spawn_write_file_test_child("sleep 60 <&0 >/dev/null 2>/dev/null & exit 0");
        let pid = child.id();
        let content = vec![b'x'; 1024 * 1024];

        let (success, error) =
            wait_write_file_child_with_timeout(child, &content, 1_000, SystemThreadSpawner);

        assert!(!success);
        assert!(error.contains("Failed to write to stdin"), "got: {error}");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }
}
