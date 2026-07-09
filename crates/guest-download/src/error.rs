pub(crate) struct DownloadError {
    pub(crate) message: String,
    pub(crate) retriable: bool,
}

impl DownloadError {
    pub(crate) fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retriable: false,
        }
    }

    pub(crate) fn transport(message: impl Into<String>, retriable: bool) -> Self {
        Self {
            message: message.into(),
            retriable,
        }
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
