mod copy;
mod read;
mod write;

use std::io;

pub use copy::{CopyFileOptions, CopyFileResult};

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    pub(crate) const COPY_FILE_STREAM_MAX_BYTES: u64 = super::copy::COPY_FILE_STREAM_MAX_BYTES;
    pub(crate) const WRITE_FILE_CHUNK_LIMIT: usize = super::write::WRITE_FILE_CHUNK_LIMIT;
}
