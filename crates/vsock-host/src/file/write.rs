use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use vsock_proto::{MSG_ERROR, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT};

use crate::{
    CompositeNormalOperation, ExecCaptureRequest, ExecResult, FrameWriteObserver, Shared,
    VsockHost, exec_operation, normal_request_on_shared_with_write_observer,
    request_on_shared_with_composite_operation_and_observer,
};

use super::{file_operation_error_is_terminal, shell_quote};

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
                exec_operation::exec_cleanup_with_composite_on_shared_and_observer(
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
            .and_then(validate_cleanup_result)
        } else {
            Ok(())
        };
        if result.is_ok() {
            self.disarm();
        }
        result
    }
}

async fn cleanup_timeout<F>(cleanup: F, timeout_ms: u32) -> io::Result<ExecResult>
where
    F: Future<Output = io::Result<ExecResult>>,
{
    tokio::time::timeout(Duration::from_millis(timeout_ms as u64), cleanup)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "cleanup command timed out"))?
}

fn validate_cleanup_result(result: ExecResult) -> io::Result<()> {
    if result.exit_code == 0 {
        return Ok(());
    }

    Err(io::Error::other(format!(
        "cleanup command failed with exit code {}: {}",
        result.exit_code,
        String::from_utf8_lossy(&result.stderr)
    )))
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
                    exec_operation::exec_cleanup_untracked_on_shared_with_write_observer(
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
            let terminal_error = file_operation_error_is_terminal(&error);
            let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
            if terminal_error && cleanup_result.is_ok() {
                normal_operation.complete()?;
            }
            return Err(error);
        }

        // Atomic rename temp → target.
        let mv_cmd = format!("mv -f -- {quoted_tmp} {}", shell_quote(path));
        match exec_operation::exec_capture_with_composite_on_shared_and_observer(
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
        {
            Ok(r) if r.exit_code == 0 => {
                cleanup_guard.disarm();
                normal_operation.complete()?;
                Ok(())
            }
            Ok(r) => {
                let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
                let error = io::Error::other(format!(
                    "failed to rename temp file to {path}: {}",
                    String::from_utf8_lossy(&r.stderr),
                ));
                if cleanup_result.is_ok() {
                    normal_operation.complete()?;
                }
                Err(error)
            }
            Err(e) => {
                // Connection likely broken — short timeout to avoid blocking.
                let terminal_error = file_operation_error_is_terminal(&e);
                let cleanup_result = cleanup_guard.cleanup_now(&mut normal_operation).await;
                if terminal_error && cleanup_result.is_ok() {
                    normal_operation.complete()?;
                }
                Err(e)
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
            return Err(io::Error::other(msg));
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
            return Err(io::Error::other(error));
        }

        Ok(())
    }
}
