use crate::LOG_TAG;
use crate::error::DownloadError;
use guest_common::log_info;
use std::io::Read;
use std::sync::LazyLock;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);

/// Global HTTP agent with timeout and system certificate verification.
/// Uses platform verifier to trust system CA certificates (including proxy CA).
static HTTP_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    use ureq::tls::{RootCerts, TlsConfig};

    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent()
});

/// Open the archive byte stream. HTTP is the production path today; `file://`
/// is used by the runner-side storage cache to feed host-staged tarballs that
/// were pushed into the guest over vsock.
pub(crate) fn open_archive(url: &str) -> Result<Box<dyn Read>, DownloadError> {
    if let Some(path) = url.strip_prefix("file://") {
        log_info!(LOG_TAG, "Reading local archive");
        let file = std::fs::File::open(path)
            .map_err(|e| DownloadError::fatal(format!("Failed to open local archive: {e}")))?;
        return Ok(Box::new(file));
    }

    let response = HTTP_AGENT.get(url).call().map_err(|e| {
        let (retriable, status_code, message) = match &e {
            // Retry on server errors (5xx) and rate limiting (429)
            ureq::Error::StatusCode(code) => (
                *code >= 500 || *code == 429,
                Some(*code),
                format!("HTTP status {code}"),
            ),
            _ => (true, None, "HTTP transport error".to_string()), // network/timeout errors are retriable
        };
        DownloadError::transport(message, retriable, status_code)
    })?;
    Ok(Box::new(response.into_body().into_reader()))
}
