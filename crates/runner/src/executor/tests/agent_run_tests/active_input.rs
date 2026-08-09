use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::active_input::{
    API_ACTIVE_INPUT_RECHECK_INTERVAL, ActiveInputNotifications, ActiveInputSource,
};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context, test_executor_config,
    test_telemetry,
};
use crate::http::{HttpClient, HttpClientConfig};
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;
use crate::types::SandboxReuseResult;

async fn read_http_request(socket: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = socket.read(&mut buffer).await.unwrap();
        assert!(read > 0, "connection closed before HTTP headers completed");
        request.extend_from_slice(&buffer[..read]);
        if let Some(header_end) = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        {
            break header_end;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let body_len = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while request.len() < header_end + body_len {
        let read = socket.read(&mut buffer).await.unwrap();
        assert!(read > 0, "connection closed before HTTP body completed");
        request.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8(request).unwrap()
}

fn http_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

async fn spawn_http_server(
    responses: Vec<String>,
) -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
            request_tx.send(request).unwrap();
        }
    });
    (api_url, request_rx, server)
}

#[tokio::test]
async fn run_in_sandbox_forwards_local_active_inputs_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    let queue = LocalQueue::new(group_dir.clone());
    for entry in [
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            text: "first".to_string(),
        },
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 2,
            text: "duplicate".to_string(),
        },
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 3,
            text: "third".to_string(),
        },
    ] {
        queue.write_active_input_sync(&entry).unwrap();
    }
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
    let run_id = ctx.run_id;
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(3, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    let calls = overrides.process_control_calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            format!("active-input:{run_id}:1"),
            format!("active-input:{run_id}:2"),
            format!("active-input:{run_id}:3"),
        ]
    );
    let payloads = calls
        .iter()
        .map(|call| serde_json::from_slice::<serde_json::Value>(&call.payload).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(payloads[0]["text"], "first");
    assert_eq!(payloads[1]["text"], "duplicate");
    assert_eq!(payloads[2]["text"], "third");
}

#[tokio::test]
async fn run_in_sandbox_retries_api_active_input_after_transient_read_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let active_input_path = format!("/api/runners/runs/{run_id}/active-inputs");
    let claim_path = format!("{active_input_path}/claim");

    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response("200 OK", r#"{"eventIds":[]}"#),
        http_response("503 Service Unavailable", r#"{"error":"transient"}"#),
        http_response("200 OK", r#"{"eventIds":["event-1"]}"#),
        http_response("200 OK", r#"{"prompt":"retry delivered"}"#),
    ])
    .await;

    let notifications = ActiveInputNotifications::new();
    let source = ActiveInputSource::api(
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: "active-input-retry-test".to_string(),
            })
            .unwrap(),
            "runner-token".to_string(),
        ),
        run_id,
        "sandbox-token".to_string(),
        notifications.subscribe(run_id),
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);
    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let initial_list = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_rx.recv())
        .await
        .expect("initial active-input list request should reach the server")
        .expect("active-input request channel should remain open");
    assert!(initial_list.starts_with(&format!("GET {active_input_path} ")));
    notifications.notify(run_id);

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await,
        "active input should be retried without another notification"
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, server)
        .await
        .expect("active-input server should finish")
        .unwrap();
    let mut remaining_requests = Vec::new();
    while let Some(request) = request_rx.recv().await {
        remaining_requests.push(request);
    }
    assert_eq!(remaining_requests.len(), 3);
    assert!(remaining_requests[0].starts_with(&format!("GET {active_input_path} ")));
    assert!(remaining_requests[1].starts_with(&format!("GET {active_input_path} ")));
    assert!(remaining_requests[2].starts_with(&format!("POST {claim_path} ")));

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap()["text"],
        "retry delivered"
    );
}

#[tokio::test]
async fn run_in_sandbox_rechecks_api_active_input_without_notification() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let active_input_path = format!("/api/runners/runs/{run_id}/active-inputs");
    let claim_path = format!("{active_input_path}/claim");

    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response("200 OK", r#"{"eventIds":[]}"#),
        http_response("200 OK", r#"{"eventIds":["event-1"]}"#),
        http_response("200 OK", r#"{"prompt":"fallback delivered"}"#),
    ])
    .await;

    let notifications = ActiveInputNotifications::new();
    let source = ActiveInputSource::api(
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: "active-input-fallback-test".to_string(),
            })
            .unwrap(),
            "runner-token".to_string(),
        ),
        run_id,
        "sandbox-token".to_string(),
        notifications.subscribe(run_id),
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);
    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let initial_list = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_rx.recv())
        .await
        .expect("initial active-input list request should reach the server")
        .expect("active-input request channel should remain open");
    assert!(initial_list.starts_with(&format!("GET {active_input_path} ")));

    tokio::time::pause();
    tokio::task::yield_now().await;
    tokio::time::advance(API_ACTIVE_INPUT_RECHECK_INTERVAL).await;
    tokio::time::resume();

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await,
        "active input should be rechecked without a notification"
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, server)
        .await
        .expect("active-input server should finish")
        .unwrap();
    let mut remaining_requests = Vec::new();
    while let Some(request) = request_rx.recv().await {
        remaining_requests.push(request);
    }
    assert_eq!(remaining_requests.len(), 2);
    assert!(remaining_requests[0].starts_with(&format!("GET {active_input_path} ")));
    assert!(remaining_requests[1].starts_with(&format!("POST {claim_path} ")));

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap()["text"],
        "fallback delivered"
    );
}

#[tokio::test]
async fn run_in_sandbox_drops_active_input_after_control_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_io_error(
        std::io::ErrorKind::TimedOut,
        "simulated transient control error",
    );
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    LocalQueue::new(group_dir.clone())
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            text: "first".to_string(),
        })
        .unwrap();
    LocalQueue::new(group_dir.clone())
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 2,
            text: "second".to_string(),
        })
        .unwrap();
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
    let run_id = ctx.run_id;
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert!(result.failure.is_none());
    assert_eq!(
        overrides
            .process_control_calls()
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            format!("active-input:{run_id}:1"),
            format!("active-input:{run_id}:2"),
        ]
    );
}
