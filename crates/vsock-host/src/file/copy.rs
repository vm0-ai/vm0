use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{ExecOutputPolicy, ExecOutputStream, ExecTermination};

use crate::{
    CompositeNormalOperation, ExecOperationResult, ExecOutputEvent, ExecOwnedCapturedOutput,
    ExecStreamRequest, FrameWriteObserver, VsockHost, exec_operation,
};

use super::{file_operation_error_is_terminal, shell_quote};

const COPY_TEMP_CREATE_ATTEMPTS: usize = 16;
const COPY_TEMP_FILE_MODE: u32 = 0o600;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = 64 * 1024;
pub(super) const COPY_FILE_STREAM_MAX_BYTES: u64 = 64 * 1024 * 1024;
// Copying is the one built-in streaming consumer that must tolerate the host
// reader briefly outrunning the temp-file writer without failing the exec operation.
const COPY_FILE_STREAM_QUEUE_CAPACITY: usize = exec_operation::MAX_EXEC_STREAM_CAPACITY;
static COPY_TEMP_NONCE: AtomicU64 = AtomicU64::new(1);

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

struct CopyFileToTempRequest<'a> {
    path: &'a str,
    stream_limit_bytes: u32,
    timeout_ms: u32,
    missing_ok: bool,
    write_observer: FrameWriteObserver,
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

fn copy_temp_path(host_path: &Path, process_id: u32, seq: u32, nonce: u64) -> PathBuf {
    let file_name = host_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "copy".into());
    host_path.with_file_name(format!(".{file_name}.vm0tmp-{process_id}-{seq}-{nonce}"))
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
    create_copy_temp_file_with_validator(host_path, seq, secure_copy_temp_file).await
}

async fn create_copy_temp_file_with_validator(
    host_path: &Path,
    seq: u32,
    validate: impl Fn(&tokio::fs::File, &Path) -> io::Result<()>,
) -> io::Result<(PathBuf, tokio::fs::File)> {
    for _ in 0..COPY_TEMP_CREATE_ATTEMPTS {
        let nonce = COPY_TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
        let temp_path = copy_temp_path(host_path, std::process::id(), seq, nonce);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(COPY_TEMP_FILE_MODE)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
            .open(&temp_path)
            .await
        {
            Ok(file) => {
                if let Err(err) = validate(&file, &temp_path) {
                    drop(file);
                    remove_temp_file(&temp_path).await;
                    return Err(err);
                }
                return Ok((temp_path, file));
            }
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

fn secure_copy_temp_file(file: &tokio::fs::File, path: &Path) -> io::Result<()> {
    let stat = fstat_copy_temp_file(file, path)?;
    let file_type = stat.st_mode & nix::libc::S_IFMT;
    if file_type != nix::libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("copy temp file {} is not a regular file", path.display()),
        ));
    }
    let expected_uid = unsafe { nix::libc::geteuid() };
    if stat.st_uid != expected_uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "copy temp file {} is owned by uid {}, but euid is {expected_uid}",
                path.display(),
                stat.st_uid
            ),
        ));
    }
    if stat.st_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("copy temp file {} is group/other writable", path.display()),
        ));
    }
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result =
        unsafe { nix::libc::fchmod(file.as_raw_fd(), COPY_TEMP_FILE_MODE as nix::libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod copy temp file {}: {}",
            path.display(),
            io::Error::last_os_error()
        )))
    }
}

fn fstat_copy_temp_file(file: &tokio::fs::File, path: &Path) -> io::Result<nix::libc::stat> {
    let mut stat = std::mem::MaybeUninit::<nix::libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live fd.
    let result = unsafe { nix::libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::other(format!(
            "stat copy temp file {}: {}",
            path.display(),
            io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    Ok(unsafe { stat.assume_init() })
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
    /// Stream a guest file to a host path and atomically rename it into place
    /// after the exec operation exits successfully.
    pub async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> io::Result<CopyFileResult> {
        self.copy_file_with_write_observer(path, host_path, options, FrameWriteObserver::default())
            .await
    }

    /// Stream a guest file to a host path and report when the helper exec
    /// frame is about to be written to the guest.
    pub async fn copy_file_with_write_observer(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
        write_observer: FrameWriteObserver,
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
                CopyFileToTempRequest {
                    path,
                    stream_limit_bytes,
                    timeout_ms: options.timeout_ms,
                    missing_ok: options.missing_ok,
                    write_observer,
                },
                temp_file,
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
        request: CopyFileToTempRequest<'_>,
        mut temp_file: tokio::fs::File,
        normal_operation: &mut CompositeNormalOperation,
    ) -> Result<CopyFileOutcome, CopyFileToTempError> {
        let CopyFileToTempRequest {
            path,
            stream_limit_bytes,
            timeout_ms,
            missing_ok,
            write_observer,
        } = request;
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
        let mut handle =
            exec_operation::exec_operation_stream_with_composite_on_shared_and_observer(
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
                    stdin_bytes: None,
                    stream_queue_capacity: Some(COPY_FILE_STREAM_QUEUE_CAPACITY),
                },
                normal_operation,
                write_observer,
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

    #[tokio::test]
    async fn create_copy_temp_file_removes_temp_when_validation_fails() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vsock-host-copy-temp-validation-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let host_path = dir.join("system.log");

        let error = create_copy_temp_file_with_validator(&host_path, 7, |_file, _path| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "forced validation failure",
            ))
        })
        .await
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(std::fs::read_dir(&dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("vm0tmp")
        }));
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
