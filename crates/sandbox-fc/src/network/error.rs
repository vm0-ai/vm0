use crate::command::CommandError;

pub type Result<T> = std::result::Result<T, NetworkError>;

#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    #[error(transparent)]
    Command(#[from] CommandError),

    #[error("no pool index available (all slots are locked by other processes)")]
    NoPoolIndexAvailable,

    #[error("namespace limit reached: max {max} namespaces allowed")]
    NamespaceLimitReached { max: u32 },

    #[error("failed to detect default network interface from: {0}")]
    NoDefaultInterface(String),

    #[error("failed to open lock file: {0}")]
    LockOpen(String),
}
