use crate::support::*;
use bytes::Bytes;
use httpmock::prelude::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

// =========================================================================
// put_presigned
// =========================================================================

#[tokio::test]
async fn put_presigned_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-success")
            .header("Content-Type", "application/octet-stream");
        then.status(200);
    });

    let url = format!("{}/test/put-success", server.base_url());
    let data = Bytes::from_static(b"test data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn transport_only_client_can_send_presigned_upload_without_api_config()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-transport-only");
        then.respond_with(|req| upload_validation_response(req, b"transport-only upload", "21"));
    });

    let url = format!("{}/test/put-transport-only", server.base_url());
    let http = guest_agent::http::HttpClient::new()?;
    http.put_presigned(
        &url,
        Bytes::from_static(b"transport-only upload"),
        "application/octet-stream",
    )
    .await?;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn put_presigned_does_not_send_api_headers() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-no-api-headers");
        then.respond_with(|req| {
            if request_header_absent(req, "authorization")
                && request_header_absent(req, "x-vercel-protection-bypass")
            {
                http_status(200)
            } else {
                http_status(400)
            }
        });
    });

    let url = format!("{}/test/put-no-api-headers", server.base_url());
    let data = Bytes::from_static(b"test data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-retry");
        then.respond_with(retry_then_response(1, http_status(200)));
    });

    let url = format!("{}/test/put-retry", server.base_url());
    let data = Bytes::from_static(b"retry data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

// =========================================================================
// put_presigned 4xx handling
// =========================================================================

#[tokio::test]
async fn put_presigned_4xx_returns_immediately_no_retry() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-403");
        then.status(403);
    });

    let url = format!("{}/test/put-403", server.base_url());
    let data = Bytes::from_static(b"forbidden data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    // Should fail immediately — only 1 call, no retries.
    mock.assert_calls_async(1).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_429_retries() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-429");
        then.status(429);
    });

    let url = format!("{}/test/put-429", server.base_url());
    let data = Bytes::from_static(b"rate limited data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    // 429 is retriable — should exhaust all retries.
    mock.assert_calls_async(3).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

// =========================================================================
// put_presigned_file (streaming upload)
// =========================================================================

#[tokio::test]
async fn put_presigned_file_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("test.bin");
    std::fs::write(&file_path, b"streaming test data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-success")
            .header("Content-Type", "application/gzip")
            .body("streaming test data");
        then.status(200);
    });

    let url = format!("{}/test/put-file-success", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_sets_content_length() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("sized.bin");
    let data = vec![0xABu8; 1024];
    std::fs::write(&file_path, &data).unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-content-length")
            .header("Content-Length", "1024");
        then.status(200);
    });

    let url = format!("{}/test/put-file-content-length", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_then_succeed() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_fails_if_source_shrinks() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry-shrunk.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();

    let mutation_done = Arc::new(AtomicBool::new(false));
    let mutation_done_for_mock = Arc::clone(&mutation_done);
    let file_path_for_mock = file_path.clone();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry-shrunk");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                mutation_done_for_mock.store(
                    std::fs::write(&file_path_for_mock, b"short").is_ok(),
                    Ordering::SeqCst,
                );
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry-shrunk", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(mutation_done.load(Ordering::SeqCst));
    assert!(result.is_err());
    let calls = mock.calls_async().await;
    assert_eq!(calls, 1);
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_uses_original_length_if_source_grows() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry-grown.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();

    let mutation_done = Arc::new(AtomicBool::new(false));
    let mutation_done_for_mock = Arc::clone(&mutation_done);
    let file_path_for_mock = file_path.clone();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry-grown");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                mutation_done_for_mock.store(
                    std::fs::write(&file_path_for_mock, b"retry file data plus extra").is_ok(),
                    Ordering::SeqCst,
                );
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry-grown", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(mutation_done.load(Ordering::SeqCst));
    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_retry_uses_original_handle_if_path_is_replaced() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("retry-replaced.bin");
    let replacement_path = dir.path().join("replacement.bin");
    std::fs::write(&file_path, b"retry file data").unwrap();
    std::fs::write(&replacement_path, b"changed content").unwrap();

    let mutation_done = Arc::new(AtomicBool::new(false));
    let mutation_done_for_mock = Arc::clone(&mutation_done);
    let file_path_for_mock = file_path.clone();
    let replacement_path_for_mock = replacement_path.clone();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-retry-replaced");
        let attempts = AtomicUsize::new(0);
        then.respond_with(move |req| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                mutation_done_for_mock.store(
                    std::fs::rename(&replacement_path_for_mock, &file_path_for_mock).is_ok(),
                    Ordering::SeqCst,
                );
                return http_status(500);
            }

            upload_validation_response(req, b"retry file data", "15")
        });
    });

    let url = format!("{}/test/put-file-retry-replaced", server.base_url());
    let path = file_path.clone();
    let result = http_client!()
        .put_presigned_file(&url, &path, "application/gzip")
        .await;

    assert!(mutation_done.load(Ordering::SeqCst));
    assert!(result.is_ok());
    mock.assert_calls_async(2).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_large_multi_chunk() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("large.bin");
    // 600000 bytes — spans multiple 256 KiB streaming chunks.
    let data = vec![0x42u8; 600000];
    std::fs::write(&file_path, &data).unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-large")
            .header("Content-Length", "600000");
        then.status(200);
    });

    let url = format!("{}/test/put-file-large", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn put_presigned_file_4xx_no_retry() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("forbidden.bin");
    std::fs::write(&file_path, b"forbidden data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-403");
        then.status(403);
    });

    let url = format!("{}/test/put-file-403", server.base_url());
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_err());
    mock.delete_async().await;
}

// =========================================================================
// Edge cases
// =========================================================================

#[tokio::test]
async fn put_presigned_retry_exhausted() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-exhaust");
        then.status(500);
    });

    let url = format!("{}/test/put-exhaust", server.base_url());
    let data = Bytes::from_static(b"exhaust data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(3).await;
    assert!(result.is_err());
    mock.delete_async().await;
}
