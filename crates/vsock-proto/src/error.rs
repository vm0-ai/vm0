/// Protocol error.
#[derive(Debug, Clone)]
pub enum ProtocolError {
    MessageTooLarge(usize),
    MessageTooSmall(usize),
    InvalidPayload(&'static str),
    PayloadTooLarge(&'static str, usize),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MessageTooLarge(size) => write!(f, "message too large: {size}"),
            Self::MessageTooSmall(size) => write!(f, "message too small: {size}"),
            Self::InvalidPayload(msg) => write!(f, "invalid payload: {msg}"),
            Self::PayloadTooLarge(field, size) => {
                write!(f, "payload field too large: {field} ({size} bytes)")
            }
        }
    }
}

impl std::error::Error for ProtocolError {}
