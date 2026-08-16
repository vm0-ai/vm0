//! Shared retry policy for bounded runner-side object downloads.

use std::time::Duration;

use reqwest::{Error, StatusCode};

/// Maximum time allowed for one bounded object-download request.
pub(crate) const OBJECT_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum number of total attempts for a bounded object download.
pub(crate) const OBJECT_DOWNLOAD_MAX_ATTEMPTS: usize = 3;
/// Delay between retry attempts for a bounded object download.
pub(crate) const OBJECT_DOWNLOAD_RETRY_DELAY: Duration = Duration::from_millis(200);

/// Return whether an HTTP response status represents a transient download failure.
pub(crate) fn is_retryable_http_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

/// Return whether a status-free reqwest error represents a transient download failure.
pub(crate) fn is_retryable_reqwest_error(error: &Error) -> bool {
    // Truncated/protocol-level body reads can surface as decode-style errors
    // without a status, and those should retry like other transient downloads.
    !(error.is_builder() || error.is_redirect())
}

/// Return the retry delay, disabling sleeps in the test binary.
pub(crate) const fn object_download_retry_delay() -> Duration {
    if cfg!(test) {
        Duration::ZERO
    } else {
        OBJECT_DOWNLOAD_RETRY_DELAY
    }
}

/// Wait between retries while avoiding a timer dependency when tests disable the delay.
pub(crate) async fn sleep_object_download_retry_delay() {
    let delay = object_download_retry_delay();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;

    use super::{
        OBJECT_DOWNLOAD_MAX_ATTEMPTS, OBJECT_DOWNLOAD_RETRY_DELAY, OBJECT_DOWNLOAD_TIMEOUT,
        is_retryable_http_status, is_retryable_reqwest_error, object_download_retry_delay,
    };

    #[test]
    fn bounded_object_download_policy_values_are_stable() {
        assert_eq!(OBJECT_DOWNLOAD_TIMEOUT, Duration::from_secs(30));
        assert_eq!(OBJECT_DOWNLOAD_MAX_ATTEMPTS, 3);
        assert_eq!(OBJECT_DOWNLOAD_RETRY_DELAY, Duration::from_millis(200));
        assert_eq!(object_download_retry_delay(), Duration::ZERO);
    }

    #[test]
    fn only_rate_limit_and_server_statuses_are_retryable() {
        assert!(is_retryable_http_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(is_retryable_http_status(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(is_retryable_http_status(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(!is_retryable_http_status(reqwest::StatusCode::OK));
        assert!(!is_retryable_http_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!is_retryable_http_status(reqwest::StatusCode::NOT_FOUND));
        assert!(!is_retryable_http_status(reqwest::StatusCode::FOUND));
    }

    #[tokio::test]
    async fn transport_predicate_retries_transient_errors_but_excludes_builder_and_redirect() {
        let builder_error = reqwest::Client::new()
            .get("not-a-url")
            .build()
            .expect_err("invalid URL should produce a builder error");
        assert!(!is_retryable_reqwest_error(&builder_error));

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("transport test listener should bind");
        let address = listener
            .local_addr()
            .expect("transport test listener should expose an address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener
                .accept()
                .await
                .expect("transport test should accept a request");
            drop(stream);
        });
        let transport_error = tokio::time::timeout(
            Duration::from_secs(5),
            reqwest::Client::new()
                .get(format!("http://{address}/"))
                .send(),
        )
        .await
        .expect("transport test request should finish")
        .expect_err("closed response should produce a transport error");
        assert!(transport_error.status().is_none());
        assert!(is_retryable_reqwest_error(&transport_error));
        server.await.expect("transport test server should finish");

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("redirect test listener should bind");
        let address = listener
            .local_addr()
            .expect("redirect test listener should expose an address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("redirect test should accept a request");
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("redirect test response should be written");
        });
        let redirect_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                attempt.error("redirect disabled for test")
            }))
            .build()
            .expect("redirect test client should build");
        let redirect_error = tokio::time::timeout(
            Duration::from_secs(5),
            redirect_client.get(format!("http://{address}/")).send(),
        )
        .await
        .expect("redirect test request should finish")
        .expect_err("redirect policy should produce an error");
        assert!(redirect_error.is_redirect());
        assert!(!is_retryable_reqwest_error(&redirect_error));
        server.await.expect("redirect test server should finish");
    }
}
