use std::io::{self, Write};
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use vsock_proto::{
    self, MSG_ERROR, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT,
    RawMessage,
};

use crate::drain::drain_into_vec_cancellable;
use crate::error::to_io_error;
use crate::exec::{
    build_exec_command, format_env_diagnostics, spawn_in_own_process_group, spawn_with_pipes,
    truncate_preview,
};
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child};
use crate::shutdown::handle_shutdown;
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::wait::{
    WaitOutcome, await_drain_deadline, finalize_buffered_result,
    wait_with_drain_and_timeout_or_cancelled, wait_with_kill_timeout,
};

const THREAD_WRITE_STDERR: &str = "vsock-write-stderr";
const WRITE_TIMEOUT_MS: u32 = 30_000;

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

    // Execute as 'user' (UID 1000) to match E2B sandbox behavior
    // Use subprocess instead of direct fs::write to run as user
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

    let mut child = match spawn_write_file_command(&write_cmd, use_sudo) {
        Ok(c) => c,
        Err(e) => return (false, format!("Failed to spawn write command: {e}")),
    };

    // Write content to stdin and close it
    if let Some(mut stdin) = child.stdin.take()
        && let Err(e) = stdin.write_all(content)
    {
        kill_and_reap_child(child);
        return (false, format!("Failed to write to stdin: {e}"));
    }
    // stdin is dropped here, closing the pipe

    wait_write_file_child(child, SystemThreadSpawner)
}

fn wait_write_file_child<S>(mut child: Child, spawner: S) -> (bool, String)
where
    S: ThreadSpawner,
{
    // Drain stderr concurrently with wait via the cancellable helper. Stdout
    // is `Stdio::null()` so there's no orphan-fd hazard there. After the
    // child exits, the drain thread either reaches EOF naturally or — if a
    // grandchild somehow still holds stderr — is cut at the deadline so its
    // last write returns EPIPE.
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
                kill_and_reap_child(child);
                return (false, format!("Failed to spawn stderr drain thread: {e}"));
            }
        }
    };

    let outcome = wait_with_kill_timeout(child, WRITE_TIMEOUT_MS);

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
            (true, String::new())
        }
    }
}

fn spawn_write_file_command(write_cmd: &str, use_sudo: bool) -> io::Result<Child> {
    let mut command = build_exec_command(write_cmd, use_sudo);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    spawn_in_own_process_group(&mut command)
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

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_command_starts_as_process_group_leader() {
        let mut child = spawn_write_file_command("sleep 10", false).unwrap();
        let pid = child.id();

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        let _ = unsafe { crate::process::kill_process_tree(pid) };
        let _ = child.wait();

        assert_eq!(pgid, pid as libc::pid_t);
    }

    #[test]
    fn write_file_stderr_drain_spawn_failure_kills_and_reaps_child() {
        let child = spawn_write_file_command("sleep 60", false).unwrap();
        let pid = child.id();

        let (success, error) =
            wait_write_file_child(child, FailingThreadSpawner::fail_once(THREAD_WRITE_STDERR));

        assert!(!success);
        assert!(error.contains("stderr drain thread"));
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }
}
