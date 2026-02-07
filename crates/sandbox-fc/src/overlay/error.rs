use crate::command::CommandError;

pub type Result<T> = std::result::Result<T, OverlayError>;

#[derive(Debug, thiserror::Error)]
pub enum OverlayError {
    #[error(transparent)]
    Command(#[from] CommandError),

    #[error("overlay pool not initialized")]
    NotInitialized,

    #[error("failed to create overlay file: {0}")]
    FileCreation(String),
}
