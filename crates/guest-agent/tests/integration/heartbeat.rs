use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

// =========================================================================
// Heartbeat
// =========================================================================

#[tokio::test]
async fn heartbeat_first_success() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| {
            observer_for_mock.record();
            http_status(200)
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop(http_client!(), shutdown_clone).await
    });

    // Wait for the first heartbeat to land, then shut down.
    observer
        .wait_for(
            1,
            MOCK_CALL_TIMEOUT,
            "heartbeat_first_success initial heartbeat",
        )
        .await;
    shutdown.cancel();

    let result = handle.await.unwrap();
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn heartbeat_first_failure_fatal() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(500);
    });

    let shutdown = CancellationToken::new();
    let result = guest_agent::heartbeat::heartbeat_loop(http_client!(), shutdown).await;

    assert!(result.is_err());
    mock.assert_calls_async(3).await;
    mock.delete_async().await;
}

#[tokio::test]
async fn heartbeat_consecutive_failures_fatal() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| {
            if observer_for_mock.record() == 1 {
                return http_status(200);
            }

            json_http_response(401, json!({"error": {"message": "Run expired"}}))
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_with_interval(
            http_client!(),
            shutdown_clone,
            TEST_HEARTBEAT_INTERVAL,
        )
        .await
    });

    // heartbeat_loop should exit after MAX_CONSECUTIVE_HEARTBEAT_FAILURES.
    let result = tokio::time::timeout(Duration::from_secs(30), handle)
        .await
        .expect("heartbeat_loop should exit within timeout")
        .expect("task should not panic");

    // Clean up mocks before assertions to avoid leaks on panic.
    let heartbeat_calls = observer.calls();
    mock.delete_async().await;
    shutdown.cancel();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("consecutive"),
        "error should mention consecutive failures: {err}"
    );

    // 401 is a 4xx error -> post_json returns immediately (no internal retries),
    // so the sequence is one success followed by the fatal failure window.
    assert_eq!(heartbeat_calls, 4);
}

#[tokio::test]
async fn heartbeat_recovery_resets_counter() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let server = &*MOCK_SERVER;
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| match observer_for_mock.record() {
            2 | 3 | 5 | 6 => json_http_response(401, json!({"error": {"message": "Run expired"}})),
            _ => http_status(200),
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_with_interval(
            http_client!(),
            shutdown_clone,
            TEST_HEARTBEAT_INTERVAL,
        )
        .await
    });

    // Sequence: success -> 2 failures -> success -> 2 failures -> success.
    // Without recovery resetting the failure counter, the second failure pair
    // would reach the fatal threshold before call 7.
    observer
        .wait_for(
            7,
            MOCK_CALL_TIMEOUT,
            "heartbeat_recovery_resets_counter full sequence",
        )
        .await;

    let heartbeat_calls = observer.calls();

    // The loop should still be running. Stop it before deleting the mock so no
    // background heartbeat can race with mock teardown.
    shutdown.cancel();
    let result = tokio::time::timeout(Duration::from_secs(30), handle)
        .await
        .expect("heartbeat_loop should exit within timeout")
        .expect("task should not panic");
    mock.delete_async().await;

    assert!(
        result.is_ok(),
        "heartbeat_loop should exit Ok after shutdown, not Err"
    );
    assert!(heartbeat_calls >= 7);
}
