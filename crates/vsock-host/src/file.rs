use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT,
};

use crate::{
    CompositeNormalOperation, ExecCaptureRequest, ExecOperationResult, ExecOutputEvent,
    ExecOwnedCapturedOutput, ExecResult, ExecStreamRequest, Shared, VsockHost, exec_operation,
    normal_request_on_shared, request_on_shared_with_composite_operation,
};

const COPY_TEMP_CREATE_ATTEMPTS: usize = 16;
const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = 64 * 1024;
const COPY_FILE_STREAM_MAX_BYTES: u64 = 64 * 1024 * 1024;
// Copying is the one built-in streaming consumer that must tolerate the host
// reader briefly outrunning the temp-file writer without failing the exec operation.
const COPY_FILE_STREAM_QUEUE_CAPACITY: usize = exec_operation::MAX_EXEC_STREAM_CAPACITY;
static COPY_TEMP_NONCE: AtomicU64 = AtomicU64::new(1);

/// Maximum content per write_file message. Leaves headroom below
/// [`vsock_proto::MAX_MESSAGE_SIZE`] for the path and frame overhead.
const WRITE_FILE_CHUNK_LIMIT: usize = 15 * 1024 * 1024;
const WRITE_FILE_TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_WRITE_FILE_RESULT];

/// Timeout (ms) for short helper commands (mv, rm) used during chunked writes.
const HELPER_EXEC_TIMEOUT_MS: u32 = 5000;

/// Shorter timeout (ms) for best-effort cleanup when the connection may
/// already be broken. Avoids blocking for a full 5 s on a dead socket.
const CLEANUP_EXEC_TIMEOUT_MS: u32 = 1000;

/// Request parameters for copying a guest file to a host path through exec
/// operation streaming.
#[derive(Debug, Clone, Copy)]
pub struct CopyFileOptions {
    pub max_bytes: u64,
    pub timeout_ms: u32,
    pub missing_ok: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopyFileResult {
    pub bytes_copied: u64,
}

enum CopyFileExecStatus {
    Present,
    Missing,
}

enum CopyFileOutcome {
    Copied { bytes_copied: u64 },
    Missing,
}

struct CopyFileToTempError {
    error: io::Error,
    terminal_proven: bool,
}

impl CopyFileToTempError {
    fn unproven(error: io::Error) -> Self {
        Self {
            error,
            terminal_proven: false,
        }
    }

    fn terminal(error: io::Error) -> Self {
        Self {
            error,
            terminal_proven: true,
        }
    }

    fn from_exec_wait(error: io::Error) -> Self {
        if file_operation_error_is_terminal(&error) {
            Self::terminal(error)
        } else {
            Self::unproven(error)
        }
    }

    fn after_cancel(error: io::Error, cancel_result: io::Result<ExecOperationResult>) -> Self {
        Self {
            error,
            terminal_proven: cancel_result.is_ok(),
        }
    }
}

enum WriteFileChunkTracking<'a> {
    Tracked,
    Composite(&'a mut CompositeNormalOperation),
}

struct ChunkedWriteCleanupGuard {
    shared: Option<Arc<Shared>>,
    command: String,
    sudo: bool,
}

impl ChunkedWriteCleanupGuard {
    fn new(shared: Arc<Shared>, command: String, sudo: bool) -> Self {
        Self {
            shared: Some(shared),
            command,
            sudo,
        }
    }

    fn disarm(&mut self) {
        self.shared = None;
    }

    async fn cleanup_now(
        &mut self,
        normal_operation: &mut CompositeNormalOperation,
    ) -> io::Result<()> {
        let result = if let Some(shared) = self.shared.as_ref() {
            cleanup_timeout(
                exec_operation::exec_cleanup_with_composite_on_shared(
                    shared,
                    &self.command,
                    CLEANUP_EXEC_TIMEOUT_MS,
                    &[],
                    self.sudo,
                    normal_operation,
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

        let command = std::mem::take(&mut self.command);
        let sudo = self.sudo;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = cleanup_timeout(
                    exec_operation::exec_cleanup_untracked_on_shared(
                        &shared,
                        &command,
                        CLEANUP_EXEC_TIMEOUT_MS,
                        &[],
                        sudo,
                    ),
                    CLEANUP_EXEC_TIMEOUT_MS,
                )
                .await;
            });
        }
    }
}

struct HostTempFileGuard {
    path: PathBuf,
    active: bool,
}

impl HostTempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, active: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    async fn remove_now(&mut self) {
        if self.active {
            self.active = false;
            remove_temp_file(&self.path).await;
        }
    }

    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for HostTempFileGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn copy_temp_path(host_path: &Path, process_id: u32, seq: u32, nonce: u64) -> PathBuf {
    let file_name = host_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "copy".into());
    host_path.with_file_name(format!(".{file_name}.vm0tmp-{process_id}-{seq}-{nonce}"))
}

fn file_operation_error_is_terminal(error: &io::Error) -> bool {
    !matches!(
        error.kind(),
        io::ErrorKind::TimedOut
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::InvalidData
    )
}

async fn remove_temp_file(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

async fn create_copy_temp_file(
    host_path: &Path,
    seq: u32,
) -> io::Result<(PathBuf, tokio::fs::File)> {
    for _ in 0..COPY_TEMP_CREATE_ATTEMPTS {
        let nonce = COPY_TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
        let temp_path = copy_temp_path(host_path, std::process::id(), seq, nonce);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "copy_file could not create a unique temp file after {COPY_TEMP_CREATE_ATTEMPTS} attempts"
        ),
    ))
}

async fn write_copy_stream_event(
    temp_file: &mut tokio::fs::File,
    bytes_copied: &mut u64,
    max_bytes: u64,
    event: ExecOutputEvent,
) -> io::Result<()> {
    if event.stream != ExecOutputStream::Stdout {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copy_file received stderr stream event",
        ));
    }
    if event.truncated {
        return Err(io::Error::other("copy_file stdout stream was truncated"));
    }
    *bytes_copied = bytes_copied
        .checked_add(event.chunk.len() as u64)
        .ok_or_else(|| io::Error::other("copy_file byte count overflow"))?;
    if *bytes_copied > max_bytes {
        return Err(io::Error::other(format!(
            "copy_file exceeded {max_bytes} bytes"
        )));
    }
    temp_file.write_all(&event.chunk).await
}

fn copy_exec_stderr(result: &ExecOperationResult) -> io::Result<(Vec<u8>, bool)> {
    match &result.stderr {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes.clone(), *truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copy_file exec operation discarded stderr capture",
        )),
    }
}

fn validate_copy_exec_result(
    path: &str,
    result: ExecOperationResult,
    missing_ok: bool,
) -> io::Result<CopyFileExecStatus> {
    if result.stream_overflowed {
        return Err(io::Error::other(
            "copy_file stream queue overflowed before all chunks were written",
        ));
    }
    if !matches!(&result.stdout, ExecOwnedCapturedOutput::Discarded) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "copy_file exec operation unexpectedly captured stdout",
        ));
    }
    let (mut stderr, stderr_truncated) = copy_exec_stderr(&result)?;
    if stderr_truncated {
        exec_operation::append_diagnostic(&mut stderr, "stderr truncated");
    }
    match result.termination {
        ExecTermination::Exited { exit_code: 0 } if !stderr_truncated => {
            Ok(CopyFileExecStatus::Present)
        }
        ExecTermination::Exited { exit_code: 0 } => Err(io::Error::other(format!(
            "copy_file stderr exceeded diagnostic limit for {path}: {}",
            String::from_utf8_lossy(&stderr)
        ))),
        ExecTermination::Exited { exit_code: 66 } if missing_ok => Ok(CopyFileExecStatus::Missing),
        ExecTermination::Exited { exit_code: 66 } => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("guest file not found: {path}"),
        )),
        ExecTermination::Exited { exit_code } => Err(io::Error::other(format!(
            "copy_file failed for {path} with exit code {exit_code}: {}",
            String::from_utf8_lossy(&stderr)
        ))),
        ExecTermination::TimedOut => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("copy_file timed out for {path}"),
        )),
        ExecTermination::Cancelled => Err(io::Error::other(format!(
            "copy_file was cancelled for {path}: {}",
            result.diagnostic
        ))),
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            Err(io::Error::other(format!(
                "copy_file exec operation failed for {path}: {}",
                result.diagnostic
            )))
        }
    }
}

impl VsockHost {
    /// Read a small file from the guest through exec capture.
    ///
    /// Missing files return `Ok(None)`. Files larger than `max_bytes` return
    /// an error instead of silently returning truncated bytes.
    pub async fn read_file(
        &self,
        path: &str,
        max_bytes: u64,
        timeout_ms: u32,
    ) -> io::Result<Option<Vec<u8>>> {
        let stdout_limit_bytes = u32::try_from(max_bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "read_file max_bytes exceeds exec capture limit",
            )
        })?;
        if stdout_limit_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "read_file max_bytes must be positive",
            ));
        }

        const MISSING_FILE_EXIT_CODE: i32 = 66;
        let command = format!(
            "if test -f {path}; then cat -- {path}; else exit {MISSING_FILE_EXIT_CODE}; fi",
            path = shell_quote(path)
        );
        let result = self
            .exec_capture(ExecCaptureRequest {
                timeout_ms,
                command: &command,
                env: &[],
                sudo: false,
                label: "read-file",
                stdout_limit_bytes,
                stderr_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                expected_exit_codes: &[MISSING_FILE_EXIT_CODE],
                wait_timeout: Duration::from_millis(timeout_ms as u64 + 5000),
            })
            .await?;
        if result.exit_code == MISSING_FILE_EXIT_CODE {
            return Ok(None);
        }
        if result.exit_code != 0 {
            return Err(io::Error::other(format!(
                "failed to read file {path}: {}",
                String::from_utf8_lossy(&result.stderr)
            )));
        }
        if result.stdout_truncated {
            return Err(io::Error::other(format!(
                "file {path} exceeded {max_bytes} bytes"
            )));
        }
        if result.stderr_truncated {
            return Err(io::Error::other(format!(
                "stderr while reading file {path} exceeded diagnostic limit"
            )));
        }
        Ok(Some(result.stdout))
    }

    /// Stream a guest file to a host path and atomically rename it into place
    /// after the exec operation exits successfully.
    pub async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> io::Result<CopyFileResult> {
        if options.max_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy_file max_bytes must be positive",
            ));
        }
        if options.max_bytes > COPY_FILE_STREAM_MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("copy_file max_bytes must be at most {COPY_FILE_STREAM_MAX_BYTES}"),
            ));
        }
        let stream_limit_bytes = u32::try_from(options.max_bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy_file max_bytes exceeds exec stream limit",
            )
        })?;
        if options.timeout_ms == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "copy_file timeout must be positive",
            ));
        }

        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await?;
        }

        let (temp_path, temp_file) =
            create_copy_temp_file(host_path, self.shared.next_seq()).await?;
        let mut temp_guard = HostTempFileGuard::new(temp_path);
        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;
        let copy_result = self
            .copy_file_to_temp(
                path,
                temp_file,
                stream_limit_bytes,
                options.timeout_ms,
                options.missing_ok,
                &mut normal_operation,
            )
            .await;
        match copy_result {
            Ok(CopyFileOutcome::Copied { bytes_copied }) => {
                match tokio::fs::rename(temp_guard.path(), host_path).await {
                    Ok(()) => {
                        temp_guard.disarm();
                        normal_operation.complete()?;
                        Ok(CopyFileResult { bytes_copied })
                    }
                    Err(err) => {
                        temp_guard.remove_now().await;
                        normal_operation.complete()?;
                        Err(err)
                    }
                }
            }
            Ok(CopyFileOutcome::Missing) => {
                temp_guard.remove_now().await;
                normal_operation.complete()?;
                Ok(CopyFileResult { bytes_copied: 0 })
            }
            Err(err) => {
                temp_guard.remove_now().await;
                if err.terminal_proven {
                    normal_operation.complete()?;
                }
                Err(err.error)
            }
        }
    }

    async fn copy_file_to_temp(
        &self,
        path: &str,
        mut temp_file: tokio::fs::File,
        stream_limit_bytes: u32,
        timeout_ms: u32,
        missing_ok: bool,
        normal_operation: &mut CompositeNormalOperation,
    ) -> Result<CopyFileOutcome, CopyFileToTempError> {
        const MISSING_FILE_EXIT_CODE: i32 = 66;
        let command = format!(
            "if test -f {path}; then cat -- {path}; else exit {MISSING_FILE_EXIT_CODE}; fi",
            path = shell_quote(path)
        );
        let expected_exit_codes: &[i32] = if missing_ok {
            &[MISSING_FILE_EXIT_CODE]
        } else {
            &[]
        };
        let mut handle = exec_operation::exec_operation_stream_with_composite_on_shared(
            &self.shared,
            ExecStreamRequest {
                timeout_ms,
                command: &command,
                env: &[],
                sudo: false,
                label: "copy-file",
                stdout: ExecOutputPolicy::Stream {
                    limit_bytes: stream_limit_bytes,
                    chunk_limit_bytes: COPY_FILE_STREAM_CHUNK_LIMIT,
                },
                stderr: ExecOutputPolicy::Capture {
                    limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                },
                expected_exit_codes,
                stream_queue_capacity: Some(COPY_FILE_STREAM_QUEUE_CAPACITY),
            },
            normal_operation,
        )
        .await
        .map_err(CopyFileToTempError::unproven)?;
        let mut cancel_on_drop = exec_operation::ExecOperationCancelOnDropGuard::new(&handle);
        let mut stream_rx = handle.take_stream_receiver().ok_or_else(|| {
            CopyFileToTempError::unproven(io::Error::new(
                io::ErrorKind::InvalidData,
                "copy_file exec operation did not create a stream receiver",
            ))
        })?;
        let wait_timeout = Duration::from_millis(timeout_ms as u64 + 5000);
        let mut bytes_copied = 0u64;

        let drain_result = tokio::time::timeout(wait_timeout, async {
            while let Some(event) = stream_rx.recv().await {
                write_copy_stream_event(
                    &mut temp_file,
                    &mut bytes_copied,
                    stream_limit_bytes as u64,
                    event,
                )
                .await?;
            }
            io::Result::Ok(())
        })
        .await;
        match drain_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                let cancel_result = handle
                    .cancel_and_wait_for_terminal(Duration::from_secs(1))
                    .await;
                if let Some(cancel_on_drop) = &mut cancel_on_drop {
                    cancel_on_drop.disarm();
                }
                return Err(CopyFileToTempError::after_cancel(err, cancel_result));
            }
            Err(_) => {
                let cancel_result = handle
                    .cancel_and_wait_for_terminal(Duration::from_secs(1))
                    .await;
                if let Some(cancel_on_drop) = &mut cancel_on_drop {
                    cancel_on_drop.disarm();
                }
                return Err(CopyFileToTempError::after_cancel(
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("copy_file stream drain timed out for {path}"),
                    ),
                    cancel_result,
                ));
            }
        };

        let result = handle
            .wait(Duration::from_secs(5))
            .await
            .map_err(CopyFileToTempError::from_exec_wait)?;
        if let Some(cancel_on_drop) = &mut cancel_on_drop {
            cancel_on_drop.disarm();
        }
        match validate_copy_exec_result(path, result, missing_ok)
            .map_err(CopyFileToTempError::terminal)?
        {
            CopyFileExecStatus::Present => {}
            CopyFileExecStatus::Missing => return Ok(CopyFileOutcome::Missing),
        }
        temp_file
            .flush()
            .await
            .map_err(CopyFileToTempError::terminal)?;

        Ok(CopyFileOutcome::Copied { bytes_copied })
    }

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
        if content.len() <= WRITE_FILE_CHUNK_LIMIT {
            return self
                .write_file_chunk(path, content, sudo, false, WriteFileChunkTracking::Tracked)
                .await;
        }

        let mut normal_operation = CompositeNormalOperation::reserve(&self.shared)?;

        // Write chunks to a per-call temp file, then atomic rename. The
        // suffix prevents concurrent large writes to the same destination
        // from appending to or cleaning up each other's staging file.
        let tmp = format!("{path}.vm0tmp-{}", self.shared.next_seq());
        let quoted_tmp = shell_quote(&tmp);
        let rm_tmp = format!("rm -f -- {quoted_tmp}");
        let mut cleanup_guard =
            ChunkedWriteCleanupGuard::new(Arc::clone(&self.shared), rm_tmp, sudo);

        let result = async {
            for (i, chunk) in content.chunks(WRITE_FILE_CHUNK_LIMIT).enumerate() {
                self.write_file_chunk(
                    &tmp,
                    chunk,
                    sudo,
                    i > 0,
                    WriteFileChunkTracking::Composite(&mut normal_operation),
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
        match exec_operation::exec_capture_with_composite_on_shared(
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
                wait_timeout: Duration::from_millis(HELPER_EXEC_TIMEOUT_MS as u64 + 5000),
            },
            &mut normal_operation,
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
    ) -> io::Result<()> {
        let payload = vsock_proto::encode_write_file(path, content, sudo, append)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        let timeout = Duration::from_secs(300);
        let resp = match tracking {
            WriteFileChunkTracking::Tracked => {
                normal_request_on_shared(
                    &self.shared,
                    MSG_WRITE_FILE,
                    &payload,
                    WRITE_FILE_TERMINAL_MSG_TYPES,
                    timeout,
                )
                .await?
            }
            WriteFileChunkTracking::Composite(normal_operation) => {
                request_on_shared_with_composite_operation(
                    &self.shared,
                    MSG_WRITE_FILE,
                    &payload,
                    WRITE_FILE_TERMINAL_MSG_TYPES,
                    timeout,
                    normal_operation,
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

#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) const COPY_FILE_STREAM_MAX_BYTES: u64 = super::COPY_FILE_STREAM_MAX_BYTES;
    pub(crate) const WRITE_FILE_CHUNK_LIMIT: usize = super::WRITE_FILE_CHUNK_LIMIT;
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn copy_temp_path_distinguishes_process_seq_and_nonce() {
        let host_path = PathBuf::from("/tmp/system.log");

        let base = copy_temp_path(&host_path, 101, 7, 1);
        assert_ne!(base, copy_temp_path(&host_path, 102, 7, 1));
        assert_ne!(base, copy_temp_path(&host_path, 101, 8, 1));
        assert_ne!(base, copy_temp_path(&host_path, 101, 7, 2));
        assert_eq!(
            base.file_name().and_then(|name| name.to_str()),
            Some(".system.log.vm0tmp-101-7-1")
        );
    }

    #[tokio::test]
    async fn create_copy_temp_file_uses_unique_paths_for_same_seq() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-temp-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");

        let (first_path, first_file) = create_copy_temp_file(&host_path, 7).await.unwrap();
        let (second_path, second_file) = create_copy_temp_file(&host_path, 7).await.unwrap();

        assert_ne!(first_path, second_path);
        assert!(first_path.exists());
        assert!(second_path.exists());
        drop(first_file);
        drop(second_file);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_temp_file_guard_removes_temp_on_drop() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-temp-guard-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".system.log.vm0tmp-guard");
        std::fs::write(&path, b"partial").unwrap();

        {
            let _guard = HostTempFileGuard::new(path.clone());
        }

        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_file_stream_settings_cover_max_copy_without_queue_overflow() {
        assert_eq!(
            COPY_FILE_STREAM_MAX_BYTES,
            COPY_FILE_STREAM_CHUNK_LIMIT as u64 * 1024
        );
        assert_eq!(
            COPY_FILE_STREAM_QUEUE_CAPACITY,
            exec_operation::test_support::MAX_STREAM_CAPACITY
        );
    }
}
