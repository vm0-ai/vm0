/// Errors from block-cow device operations.
#[derive(Debug, thiserror::Error)]
pub enum BlockCowError {
    #[error("failed to execute `{program}`: {source}")]
    Command {
        program: String,
        source: std::io::Error,
    },

    #[error("`{program}` failed: {stderr}")]
    CommandFailed { program: String, stderr: String },

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("device not active: {0}")]
    NotActive(String),
}

pub type Result<T> = std::result::Result<T, BlockCowError>;
