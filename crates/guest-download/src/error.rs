pub(crate) struct DownloadError {
    pub(crate) message: String,
    pub(crate) retriable: bool,
    pub(crate) status_code: Option<u16>,
}

impl DownloadError {
    pub(crate) fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retriable: false,
            status_code: None,
        }
    }

    pub(crate) fn transport(
        message: impl Into<String>,
        retriable: bool,
        status_code: Option<u16>,
    ) -> Self {
        Self {
            message: message.into(),
            retriable,
            status_code,
        }
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
