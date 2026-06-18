use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use std::{fmt, io};

use vsock_proto::{ExecTermination, MSG_ERROR, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT};

use crate::{
    CompositeNormalOperation, ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput,
    FrameWriteObserver, Shared, VsockHost, exec_operation,
    normal_request_on_shared_with_write_observer,
    request_on_shared_with_composite_operation_and_observer,
};

use super::{normalize_file_exec_stderr, shell_quote, validate_guest_file_path};

/// Maximum content per write_file message. Leaves headroom below
/// [`vsock_proto::MAX_MESSAGE_SIZE`] for the path and frame overhead.
pub(super) const WRITE_FILE_CHUNK_LIMIT: usize = 15 * 1024 * 1024;
const WRITE_FILE_TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_WRITE_FILE_RESULT];

/// Timeout (ms) for short helper commands (mv, rm) used during chunked writes.
const HELPER_EXEC_TIMEOUT_MS: u32 = 5000;

/// Shorter timeout (ms) for best-effort cleanup when the connection may
/// already be broken. Avoids blocking for a full 5 s on a dead socket.
const CLEANUP_EXEC_TIMEOUT_MS: u32 = 1000;

enum WriteFileChunkTracking<'a> {
    Tracked,
    Composite(&'a mut CompositeNormalOperation),
}

#[derive(Debug)]
struct WriteFileGuestError(String);

impl fmt::Display for WriteFileGuestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WriteFileGuestError {}

fn write_file_guest_error(message: impl Into<String>) -> io::Error {
    io::Error::other(WriteFileGuestError(message.into()))
}

fn error_is_write_file_guest_error(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|error| error.is::<WriteFileGuestError>())
}

struct ChunkedWriteCleanupGuard {
    shared: Option<Arc<Shared>>,
    command: String,
    sudo: bool,
    write_observer: FrameWriteObserver,
    cleanup_armed: Arc<AtomicBool>,
}

impl ChunkedWriteCleanupGuard {
    fn new(
        shared: Arc<Shared>,
        command: String,
        sudo: bool,
        write_observer: FrameWriteObserver,
        cleanup_armed: Arc<AtomicBool>,
    ) -> Self {
        Self {
            shared: Some(shared),
            command,
            sudo,
            write_observer,
            cleanup_armed,
        }
    }

    fn disarm(&mut self) {
        self.shared = None;
    }

    async fn cleanup_now(
        &mut self,
        normal_operation: &mut CompositeNormalOperation,
    ) -> io::Result<()> {
        if !self.cleanup_armed.load(Ordering::Acquire) {
            self.disarm();
            return Ok(());
        }

        let result = if let Some(shared) = self.shared.as_ref() {
            cleanup_timeout(
                exec_operation::exec_operation_cleanup_with_composite_on_shared_and_observer(
                    shared,
                    &self.command,
                    CLEANUP_EXEC_TIMEOUT_MS,
                    &[],
                    self.sudo,
                    normal_operation,
                    self.write_observer.clone(),
                ),
                CLEANUP_EXEC_TIMEOUT_MS,
            )
            .await
            .and_then(|result| validate_cleanup_result(result).map_err(|err| err.error))
        } else {
            Ok(())
        };
        if result.is_ok() {
            self.disarm();
        }
        result
    }
}

async fn cleanup_timeout<F>(cleanup: F, timeout_ms: u32) -> io::Result<ExecOperationResult>
where
    F: Future<Output = io::Result<ExecOperationResult>>,
{
    tokio::time::timeout(Duration::from_millis(timeout_ms as u64), cleanup)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "cleanup command timed out"))?
}

struct WriteHelperExecError {
    error: io::Error,
    terminal_proven: bool,
}

impl WriteHelperExecError {
    fn terminal(error: io::Error) -> Self {
        Self {
            error,
            terminal_proven: true,
        }
    }

    fn unproven(error: io::Error) -> Self {
        Self {
            error,
            terminal_proven: false,
        }
    }

    fn from_exec_wait(error: io::Error) -> Self {
        if exec_operation::error_is_exec_operation_guest_error(&error) {
            Self::terminal(error)
        } else {
            Self::unproven(error)
        }
    }
}

fn write_helper_exec_output(
    context: &str,
    result: ExecOperationResult,
) -> Result<(ExecTermination, Vec<u8>, String), WriteHelperExecError> {
    if result.stream_overflowed {
        return Err(WriteHelperExecError::unproven(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{context} exec operation unexpectedly overflowed a stream queue"),
        )));
    }

    let ExecOperationResult {
        termination,
        stdout,
        stderr,
        diagnostic,
        ..
    } = result;
    let _stdout = write_helper_exec_captured_output(context, "stdout", stdout)?;
    let (stderr, stderr_truncated) = write_helper_exec_captured_output(context, "stderr", stderr)?;

    Ok((
        termination,
        normalize_file_exec_stderr(stderr, stderr_truncated),
        diagnostic,
    ))
}

fn write_helper_exec_captured_output(
    context: &str,
    name: &str,
    output: ExecOwnedCapturedOutput,
) -> Result<(Vec<u8>, bool), WriteHelperExecError> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(WriteHelperExecError::unproven(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{context} exec result discarded {name} for capture request"),
        ))),
    }
}

fn write_helper_terminal_message(prefix: String, stderr: &[u8], diagnostic: &str) -> String {
    let mut details = Vec::new();
    if !stderr.is_empty() {
        details.push(format!("stderr: {}", String::from_utf8_lossy(stderr)));
    }
    if !diagnostic.is_empty() {
        details.push(format!("diagnostic: {diagnostic}"));
    }
    if details.is_empty() {
        prefix
    } else {
        format!("{prefix}: {}", details.join("; "))
    }
}

fn validate_cleanup_result(result: ExecOperationResult) -> Result<(), WriteHelperExecError> {
    let (termination, stderr, diagnostic) = write_helper_exec_output("cleanup command", result)?;
    match termination {
        ExecTermination::Exited { exit_code: 0 } => Ok(()),
        ExecTermination::Exited { exit_code } => {
            Err(WriteHelperExecError::terminal(io::Error::other(format!(
                "cleanup command failed with exit code {exit_code}: {}",
                String::from_utf8_lossy(&stderr)
            ))))
        }
        ExecTermination::TimedOut => Err(WriteHelperExecError::terminal(io::Error::new(
            io::ErrorKind::TimedOut,
            write_helper_terminal_message(
                "cleanup command timed out".to_string(),
                &stderr,
                &diagnostic,
            ),
        ))),
        ExecTermination::Cancelled => Err(WriteHelperExecError::terminal(io::Error::other(
            write_helper_terminal_message(
                "cleanup command was cancelled".to_string(),
                &stderr,
                &diagnostic,
            ),
        ))),
        ExecTermination::StartFailed => Err(WriteHelperExecError::terminal(io::Error::other(
            write_helper_terminal_message(
                "cleanup command exec start failed".to_string(),
                &stderr,
                &diagnostic,
            ),
        ))),
        ExecTermination::WaitFailed => Err(WriteHelperExecError::terminal(io::Error::other(
            write_helper_terminal_message(
                "cleanup command exec wait failed".to_string(),
                &stderr,
                &diagnostic,
            ),
        ))),
    }
}

fn validate_rename_result(
    path: &str,
    result: ExecOperationResult,
) -> Result<(), WriteHelperExecError> {
    let (termination, stderr, diagnostic) = write_helper_exec_output("rename command", result)?;
    match termination {
        ExecTermination::Exited { exit_code: 0 } => Ok(()),
        ExecTermination::Exited { exit_code } => {
            Err(WriteHelperExecError::terminal(io::Error::other(format!(
                "failed to rename temp file to {path} with exit code {exit_code}: {}",
                String::from_utf8_lossy(&stderr)
            ))))
        }
        ExecTermination::TimedOut => Err(WriteHelperExecError::terminal(io::Error::new(
            io::ErrorKind::TimedOut,
            write_helper_terminal_message(
                format!("rename command timed out while moving temp file to {path}"),
                &stderr,
                &diagnostic,
            ),
        ))),
        ExecTermination::Cancelled => Err(WriteHelperExecError::terminal(io::Error::other(
            write_helper_terminal_message(
                format!("rename command was cancelled while moving temp file to {path}"),
                &stderr,
                &diagnostic,
            ),
        ))),
        ExecTermination::StartFailed => Err(WriteHelperExecError::terminal(io::Error::other(
            write_helper_terminal_message(
                format!("rename command exec start failed while moving temp file to {path}"),
                &stderr,
                &diagnostic,
            ),
        ))),
        ExecTermination::WaitFailed => Err(WriteHelperExecError::terminal(io::Error::other(
            write_helper_terminal_message(
                format!("rename command exec wait failed while moving temp file to {path}"),
                &stderr,
                &diagnostic,
            ),
        ))),
    }
}

impl Drop for ChunkedWriteCleanupGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else {
            return;
        };
        if !self.cleanup_armed.load(Ordering::Acquire) {
            return;
        }

        let command = std::mem::take(&mut self.command);
        let sudo = self.sudo;
        let write_observer = FrameWriteObserver::default();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = cleanup_timeout(
                    exec_operation::exec_operation_cleanup_untracked_on_shared_with_write_observer(
                        &shared,
                        &command,
                        CLEANUP_EXEC_TIMEOUT_MS,
                        &[],
                        sudo,
                        write_observer,
                    ),
                    CLEANUP_EXEC_TIMEOUT_MS,
                )
                .await;
            });
        }
    }
}

fn write_observer_that_arms_cleanup(
    write_observer: FrameWriteObserver,
    cleanup_armed: Arc<AtomicBool>,
) -> FrameWriteObserver {
    FrameWriteObserver::new(move || {
        write_observer.record_write_start()?;
        cleanup_armed.store(true, Ordering::Release);
        Ok(())
    })
}

impl VsockHost {
    /// Write a file on the guest.
    ///
    /// Content larger than 15 MB is automatically split into multiple
    /// messages using the `WRITE_FILE_FLAG_APPEND` protocol flag. Chunks are written
    /// to a temporary file and atomically renamed to the target path after
    /// the last chunk succeeds, so a partial transfer never leaves a
    /// truncated file at the destination.
    ///
    /// Non-sudo writes create missing parent directories on the guest.
    pub async fn write_file(&self, path: &str, content: &[u8], sudo: bool) -> io::Result<()> {
        self.write_file_with_write_observer(path, content, sudo, FrameWriteObserver::default())
            .await
    }

    /// Write a file on the guest and report before each helper frame is
    /// written to the guest.
    pub async fn write_file_with_write_observer(
        &self,
        path: &str,
        content: &[u8],
        sudo: bool,
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        validate_guest_file_path(path)?;
        if content.len() <= WRITE_FILE_CHUNK_LIMIT {
            return self
                .write_file_chunk(
                    path,
                    content,
                    sudo,
                    false,
                    WriteFileChunkTracking::Tracked,
                    write_observer,
                )
                .await;
        }

        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;

        // Write chunks to a per-call temp file, then atomic rename. The
        // suffix prevents concurrent large writes to the same destination
        // from appending to or cleaning up each other's staging file.
        let tmp = format!("{path}.vm0tmp-{}", self.shared.next_seq());
        let quoted_tmp = shell_quote(&tmp);
        let rm_tmp = format!("rm -f -- {quoted_tmp}");
        let cleanup_armed = Arc::new(AtomicBool::new(false));
        let write_observer =
            write_observer_that_arms_cleanup(write_observer, Arc::clone(&cleanup_armed));
        let mut cleanup_guard = ChunkedWriteCleanupGuard::new(
            Arc::clone(&self.shared),
            rm_tmp,
            sudo,
            write_observer.clone(),
            cleanup_armed,
        );

        let result = async {
            for (i, chunk) in content.chunks(WRITE_FILE_CHUNK_LIMIT).enumerate() {
                self.write_file_chunk(
                    &tmp,
                    chunk,
                    sudo,
                    i > 0,
                    WriteFileChunkTracking::Composite(&mut normal_operation),
                    write_observer.clone(),
                )
                .await?;
            }
            io::Result::Ok(())
        }
        .await;

        if let Err(error) = result {
            // Best-effort cleanup of the temp file.
            let terminal_error = error_is_write_file_guest_error(&error);
            let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
            if terminal_error && cleanup_result.is_ok() {
                normal_operation.complete()?;
            }
            return Err(error);
        }

        // `-T` keeps directory targets from being treated as destination directories.
        let mv_cmd = format!("mv -fT -- {quoted_tmp} {}", shell_quote(path));
        let rename_result =
            exec_operation::exec_operation_capture_with_composite_on_shared_and_observer(
                &self.shared,
                ExecCaptureRequest {
                    command: &mv_cmd,
                    timeout_ms: HELPER_EXEC_TIMEOUT_MS,
                    env: &[],
                    sudo,
                    label: "write-file-rename",
                    stdout_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                    stderr_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                    expected_exit_codes: &[],
                    stdin_bytes: None,
                    wait_timeout: Duration::from_millis(HELPER_EXEC_TIMEOUT_MS as u64 + 5000),
                },
                &mut normal_operation,
                write_observer,
            )
            .await
            .map_err(WriteHelperExecError::from_exec_wait)
            .and_then(|result| validate_rename_result(path, result));
        match rename_result {
            Ok(()) => {
                cleanup_guard.disarm();
                normal_operation.complete()?;
                Ok(())
            }
            Err(err) => {
                // Terminal proof only releases the tracker after cleanup also
                // succeeds; unproven helper failures remain fail-closed.
                let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
                if err.terminal_proven && cleanup_result.is_ok() {
                    normal_operation.complete()?;
                }
                Err(err.error)
            }
        }
    }

    /// Send a single write_file message and validate the response.
    async fn write_file_chunk(
        &self,
        path: &str,
        content: &[u8],
        sudo: bool,
        append: bool,
        tracking: WriteFileChunkTracking<'_>,
        write_observer: FrameWriteObserver,
    ) -> io::Result<()> {
        let payload = vsock_proto::encode_write_file(path, content, sudo, append)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        let timeout = Duration::from_secs(300);
        let resp = match tracking {
            WriteFileChunkTracking::Tracked => {
                normal_request_on_shared_with_write_observer(
                    &self.shared,
                    MSG_WRITE_FILE,
                    &payload,
                    WRITE_FILE_TERMINAL_MSG_TYPES,
                    timeout,
                    write_observer,
                )
                .await?
            }
            WriteFileChunkTracking::Composite(normal_operation) => {
                request_on_shared_with_composite_operation_and_observer(
                    &self.shared,
                    MSG_WRITE_FILE,
                    &payload,
                    WRITE_FILE_TERMINAL_MSG_TYPES,
                    timeout,
                    normal_operation,
                    write_observer,
                )
                .await?
            }
        };

        if resp.msg_type == MSG_ERROR {
            let msg = vsock_proto::decode_error(&resp.payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            return Err(write_file_guest_error(msg));
        }

        if resp.msg_type != MSG_WRITE_FILE_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected response type: 0x{:02X}", resp.msg_type),
            ));
        }

        let (success, error) = vsock_proto::decode_write_file_result(&resp.payload)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

        if !success {
            return Err(write_file_guest_error(error));
        }

        Ok(())
    }
}
