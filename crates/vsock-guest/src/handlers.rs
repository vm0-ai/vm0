use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
#[cfg(debug_assertions)]
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;

use vsock_proto::{
    self, MSG_ERROR, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT,
    RawMessage,
};

use crate::drain::drain_into_vec_cancellable;
use crate::error::to_io_error;
use crate::exec::{
    format_env_diagnostics, spawn_in_own_process_group, spawn_with_pipes, truncate_preview,
};
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child};
use crate::shutdown::handle_shutdown;
use crate::threading::{SystemThreadSpawner, ThreadSpawner, spawn_scoped_named};
use crate::user::apply_write_file_identity;
use crate::wait::{
    WaitOutcome, await_drain_deadline, finalize_buffered_result,
    wait_with_drain_and_timeout_or_cancelled, wait_with_kill_timeout,
};

const THREAD_WRITE_STDERR: &str = "vsock-write-stderr";
const THREAD_WRITE_STDIN: &str = "vsock-write-stdin";
const WRITE_TIMEOUT_MS: u32 = 30_000;
const GUEST_WRITE_FILE_PATH: &str = "/sbin/guest-write-file";
#[cfg(debug_assertions)]
static DEBUG_GUEST_WRITE_FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

pub(crate) enum MessageOutcome {
    Response(Vec<u8>),
    Shutdown(Vec<u8>),
}

/// Handle exec message
pub(crate) fn handle_exec(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    connection_cancel: &AtomicBool,
) -> (i32, Vec<u8>, Vec<u8>) {
    log(
        "INFO",
        &format!(
            "exec: {} (timeout={}ms, sudo={}, {})",
            truncate_preview(command),
            timeout_ms,
            sudo,
            format_env_diagnostics(command, env),
        ),
    );

    let spawned = match spawn_with_pipes(command, env, sudo) {
        Ok(c) => c,
        Err(e) => {
            return (
                1,
                Vec::new(),
                format!(
                    "Failed to execute: {e} ({})",
                    format_env_diagnostics(command, env)
                )
                .into_bytes(),
            );
        }
    };
    let crate::exec::SpawnedCommand {
        child,
        env_script: _env_script,
    } = spawned;

    let (outcome, stdout, stderr_buf) =
        wait_with_drain_and_timeout_or_cancelled(child, timeout_ms, connection_cancel);
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
        let stdin_handle = match spawn_scoped_named(scope, THREAD_WRITE_STDIN, move || {
            let mut stdin = stdin_pipe;
            stdin.write_all(content)
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
    #[cfg(debug_assertions)]
    {
        DEBUG_GUEST_WRITE_FILE_PATH
            .get()
            .cloned()
            .unwrap_or_else(|| PathBuf::from(GUEST_WRITE_FILE_PATH))
    }

    #[cfg(not(debug_assertions))]
    {
        PathBuf::from(GUEST_WRITE_FILE_PATH)
    }
}

#[cfg(debug_assertions)]
pub(crate) fn set_debug_guest_write_file_path(path: PathBuf) -> Result<(), PathBuf> {
    DEBUG_GUEST_WRITE_FILE_PATH.set(path)
}

/// Handle incoming message and return the connection-loop outcome.
///
/// `MSG_EXEC` and `MSG_SPAWN_WATCH` are handled separately in
/// `handle_connection` because they run in background threads.
pub(crate) fn handle_message(msg: &RawMessage) -> io::Result<MessageOutcome> {
    log(
        "INFO",
        &format!("Received: type=0x{:02X} seq={}", msg.msg_type, msg.seq),
    );

    match msg.msg_type {
        MSG_PING => Ok(MessageOutcome::Response(
            vsock_proto::encode(MSG_PONG, msg.seq, &[]).map_err(to_io_error)?,
        )),
        MSG_WRITE_FILE => {
            let (path, content, use_sudo, append) =
                vsock_proto::decode_write_file(&msg.payload).map_err(to_io_error)?;
            let (success, error) = handle_write_file(path, content, use_sudo, append);
            let payload = vsock_proto::encode_write_file_result(success, &error);
            Ok(MessageOutcome::Response(
                vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload)
                    .map_err(to_io_error)?,
            ))
        }
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
    use std::sync::{Mutex, Once};

    static TEST_HELPER: Once = Once::new();
    static TEST_HELPER_EXEC: Mutex<()> = Mutex::new(());

    fn install_sleeping_write_file_helper() {
        TEST_HELPER.call_once(|| {
            let path =
                std::env::temp_dir().join(format!("vm0-guest-write-file-{}", std::process::id()));
            std::fs::write(&path, "#!/bin/sh\nsleep 60\ncat >/dev/null\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            set_debug_guest_write_file_path(path).unwrap();
        });
    }

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_command_starts_as_process_group_leader() {
        let _guard = TEST_HELPER_EXEC.lock().unwrap();
        install_sleeping_write_file_helper();
        let mut child = spawn_write_file_command("/tmp/out.txt", false, false).unwrap();
        let pid = child.id();

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        let _ = unsafe { crate::process::kill_process_tree(pid) };
        let _ = child.wait();

        assert_eq!(pgid, pid as libc::pid_t);
    }

    #[test]
    fn write_file_stderr_drain_spawn_failure_kills_and_reaps_child() {
        let _guard = TEST_HELPER_EXEC.lock().unwrap();
        install_sleeping_write_file_helper();
        let child = spawn_write_file_command("/tmp/out.txt", false, false).unwrap();
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
        let _guard = TEST_HELPER_EXEC.lock().unwrap();
        install_sleeping_write_file_helper();
        let child = spawn_write_file_command("/tmp/out.txt", false, false).unwrap();
        let pid = child.id();
        let content = vec![b'x'; 1024 * 1024];

        let (success, error) =
            wait_write_file_child_with_timeout(child, &content, 100, SystemThreadSpawner);

        assert!(!success);
        assert_eq!(error, "write timed out");
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }
}
