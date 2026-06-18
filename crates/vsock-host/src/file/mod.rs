mod copy;
mod read;
mod write;

use std::io;

use crate::exec_operation;

pub use copy::{CopyFileOptions, CopyFileResult};

const MISSING_FILE_EXIT_CODE: i32 = 66;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn validate_guest_file_path(path: &str) -> io::Result<()> {
    if path.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest file path must not be empty",
        ));
    }
    if path.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest file path contains NUL bytes",
        ));
    }
    Ok(())
}

fn read_regular_file_command(path: &str, missing_file_exit_code: i32) -> String {
    let path = shell_quote(path);
    format!(
        "if test -f {path}; then cat 2>/dev/null < {path} || {{ test -f {path} || exit {missing_file_exit_code}; printf '%s\\n' 'failed to read file' >&2; exit 1; }}; else exit {missing_file_exit_code}; fi"
    )
}

fn normalize_file_exec_stderr(mut stderr: Vec<u8>, stderr_truncated: bool) -> Vec<u8> {
    if stderr_truncated {
        exec_operation::append_diagnostic(&mut stderr, "stderr truncated");
    }
    stderr
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

#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = super::copy::COPY_FILE_STREAM_CHUNK_LIMIT;
    pub(crate) const COPY_FILE_STREAM_MAX_BYTES: u64 = super::copy::COPY_FILE_STREAM_MAX_BYTES;
    pub(crate) const WRITE_FILE_CHUNK_LIMIT: usize = super::write::WRITE_FILE_CHUNK_LIMIT;
}
