use crate::command::CommandError;

pub type Result<T> = std::result::Result<T, NetworkError>;

#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    #[error(transparent)]
    Command(#[from] CommandError),

    #[error("pool index {index} out of range (max {max})")]
    IndexOutOfRange { index: u32, max: u32 },

    #[error("namespace limit reached: max {max} namespaces allowed")]
    NamespaceLimitReached { max: u32 },

    #[error("failed to detect default network interface from: {0}")]
    NoDefaultInterface(String),
}
