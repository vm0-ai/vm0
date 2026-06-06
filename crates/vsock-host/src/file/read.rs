use std::io;
use std::time::Duration;

use crate::{ExecCaptureRequest, FrameWriteObserver, VsockHost, exec_operation};

use super::shell_quote;

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
        self.read_file_with_write_observer(
            path,
            max_bytes,
            timeout_ms,
            FrameWriteObserver::default(),
        )
        .await
    }

    /// Read a small file and report when the helper exec frame is about to be
    /// written to the guest.
    pub async fn read_file_with_write_observer(
        &self,
        path: &str,
        max_bytes: u64,
        timeout_ms: u32,
        write_observer: FrameWriteObserver,
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
            .exec_capture_with_write_observer(
                ExecCaptureRequest {
                    timeout_ms,
                    command: &command,
                    env: &[],
                    sudo: false,
                    label: "read-file",
                    stdout_limit_bytes,
                    stderr_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                    expected_exit_codes: &[MISSING_FILE_EXIT_CODE],
                    stdin_bytes: None,
                    wait_timeout: Duration::from_millis(timeout_ms as u64 + 5000),
                },
                write_observer,
            )
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
}
