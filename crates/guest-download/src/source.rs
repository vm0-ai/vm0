use crate::LOG_TAG;
use crate::error::DownloadError;
use guest_common::log_info;
use std::cell::Cell;
use std::io;
use std::io::Read;
use std::rc::Rc;
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

/// Open the archive byte stream. HTTP/HTTPS URLs use the direct remote-fetch
/// path; `file://` URLs are the runner storage-cache path for guest-local
/// tarballs staged over vsock.
pub(crate) fn open_archive(url: &str) -> Result<ArchiveSource, DownloadError> {
    if let Some(path) = url.strip_prefix("file://") {
        log_info!(LOG_TAG, "Reading local archive");
        let file = std::fs::File::open(path)
            .map_err(|e| DownloadError::fatal(format!("Failed to open local archive: {e}")))?;
        return Ok(ArchiveSource::local(file));
    }

    let response = HTTP_AGENT.get(url).call().map_err(|e| {
        let (retriable, message) = classify_http_error(&e);
        DownloadError::transport(message, retriable)
    })?;
    Ok(ArchiveSource::http(response.into_body().into_reader()))
}

fn classify_http_error(error: &ureq::Error) -> (bool, String) {
    // Never render the raw error: URI-bearing variants can expose presigned credentials.
    match error {
        // Retry on server errors (5xx) and rate limiting (429).
        ureq::Error::StatusCode(code) => {
            (*code >= 500 || *code == 429, format!("HTTP status {code}"))
        }
        ureq::Error::HostNotFound => (true, request_error_message("dns")),
        ureq::Error::Timeout(timeout) => (
            true,
            format!(
                "HTTP request error (kind=timeout phase={})",
                timeout_phase(*timeout)
            ),
        ),
        ureq::Error::ConnectionFailed => (true, request_error_message("connection")),
        ureq::Error::Io(error) => (
            true,
            format!("HTTP request error (kind=io io_kind={:?})", error.kind()),
        ),
        ureq::Error::Tls(_)
        | ureq::Error::Pem(_)
        | ureq::Error::Rustls(_)
        | ureq::Error::TlsRequired => (true, request_error_message("tls")),
        ureq::Error::InvalidProxyUrl | ureq::Error::ConnectProxyFailed(_) => {
            (true, request_error_message("proxy"))
        }
        ureq::Error::Protocol(_)
        | ureq::Error::RedirectFailed
        | ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::TooManyRedirects
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::Decompress(_, _)
        | ureq::Error::BodyStalled => (true, request_error_message("protocol")),
        ureq::Error::Http(_) | ureq::Error::BadUri(_) | ureq::Error::RequireHttpsOnly(_) => {
            (false, request_error_message("invalid_request"))
        }
        ureq::Error::Other(_) => (true, request_error_message("unknown")),
        _ => (true, request_error_message("unknown")),
    }
}

fn request_error_message(kind: &'static str) -> String {
    format!("HTTP request error (kind={kind})")
}

fn timeout_phase(timeout: ureq::Timeout) -> &'static str {
    match timeout {
        ureq::Timeout::Global => "global",
        ureq::Timeout::PerCall => "per_call",
        ureq::Timeout::Resolve => "resolve",
        ureq::Timeout::Connect => "connect",
        ureq::Timeout::SendRequest => "send_request",
        ureq::Timeout::Await100 => "await_100",
        ureq::Timeout::SendBody => "send_body",
        ureq::Timeout::RecvResponse => "recv_response",
        ureq::Timeout::RecvBody => "recv_body",
        _ => "unknown",
    }
}

pub(crate) struct ArchiveSource {
    reader: Box<dyn Read>,
    http_body_read_failure: HttpBodyReadFailure,
}

impl ArchiveSource {
    pub(crate) fn local(reader: impl Read + 'static) -> Self {
        Self {
            reader: Box::new(reader),
            http_body_read_failure: HttpBodyReadFailure::disabled(),
        }
    }

    fn http(reader: impl Read + 'static) -> Self {
        let http_body_read_failure = HttpBodyReadFailure::enabled();
        Self {
            reader: Box::new(HttpBodyReader {
                reader,
                failure: http_body_read_failure.clone(),
            }),
            http_body_read_failure,
        }
    }

    pub(crate) fn into_parts(self) -> (Box<dyn Read>, HttpBodyReadFailure) {
        (self.reader, self.http_body_read_failure)
    }
}

#[derive(Clone)]
pub(crate) struct HttpBodyReadFailure {
    failed: Option<Rc<Cell<bool>>>,
}

impl HttpBodyReadFailure {
    fn enabled() -> Self {
        Self {
            failed: Some(Rc::new(Cell::new(false))),
        }
    }

    fn disabled() -> Self {
        Self { failed: None }
    }

    fn mark_failed(&self) {
        if let Some(failed) = &self.failed {
            failed.set(true);
        }
    }

    pub(crate) fn failed(&self) -> bool {
        self.failed.as_ref().is_some_and(|failed| failed.get())
    }
}

struct HttpBodyReader<R> {
    reader: R,
    failure: HttpBodyReadFailure,
}

impl<R: Read> Read for HttpBodyReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.reader.read(buffer) {
            Ok(bytes_read) => Ok(bytes_read),
            Err(e) => {
                self.failure.mark_failed();
                Err(e)
            }
        }
    }
}
