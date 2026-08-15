use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::active_input::{
    API_ACTIVE_INPUT_RECHECK_INTERVAL, ActiveInputNotifications, ActiveInputSource,
    local_active_input_delivery_id,
};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context,
    sandbox_read_file_error, test_executor_config, test_telemetry,
};
use crate::http::{HttpClient, HttpClientConfig};
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;
use crate::types::SandboxReuseResult;

const DELIVERY_ID: &str = "b1e2ad6d-930a-4d51-aa40-7952d54f978b";
const EVENT_ID: &str = "e6bc287d-8c08-464e-831a-cad771610157";

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

enum HttpServerAction {
    Respond(String),
    Disconnect,
}

async fn spawn_http_server(
    responses: Vec<String>,
) -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    spawn_http_server_with_actions(
        responses
            .into_iter()
            .map(HttpServerAction::Respond)
            .collect(),
    )
    .await
}

async fn spawn_http_server_with_actions(
    actions: Vec<HttpServerAction>,
) -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        for action in actions {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            if let HttpServerAction::Respond(response) = action {
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
                let mut closed = [0_u8; 1];
                assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
            }
            request_tx.send(request).unwrap();
        }
    });
    (api_url, request_rx, server)
}

fn api_active_input_source(
    api_url: String,
    run_id: crate::ids::RunId,
    notifications: &ActiveInputNotifications,
    client_session_id: &str,
) -> ActiveInputSource {
    ActiveInputSource::api(
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: client_session_id.to_string(),
            })
            .unwrap(),
            "runner-token".to_string(),
        ),
        run_id,
        "sandbox-token".to_string(),
        notifications.subscribe(run_id),
    )
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
            local_active_input_delivery_id(run_id, 1),
            local_active_input_delivery_id(run_id, 2),
            local_active_input_delivery_id(run_id, 3),
        ]
    );
    let payloads = calls
        .iter()
        .map(|call| serde_json::from_slice::<serde_json::Value>(&call.payload).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(payloads[0]["text"], "first");
    assert_eq!(payloads[1]["text"], "duplicate");
    assert_eq!(payloads[2]["text"], "third");
    assert_eq!(
        payloads[0]["deliveryId"],
        local_active_input_delivery_id(run_id, 1)
    );
    assert_eq!(
        payloads[1]["deliveryId"],
        local_active_input_delivery_id(run_id, 2)
    );
    assert_eq!(
        payloads[2]["deliveryId"],
        local_active_input_delivery_id(run_id, 3)
    );
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
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");

    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response("200 OK", r#"{"outcome":"empty"}"#),
        http_response("503 Service Unavailable", r#"{"error":"transient"}"#),
        http_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retry delivered"}}"#,
            ),
        ),
    ])
    .await;

    let notifications = ActiveInputNotifications::new();
    let source =
        api_active_input_source(api_url, run_id, &notifications, "active-input-retry-test");
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

    let initial_reserve = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_rx.recv())
        .await
        .expect("initial active-input reserve request should reach the server")
        .expect("active-input request channel should remain open");
    assert!(initial_reserve.starts_with(&format!("POST {reserve_path} ")));
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
    assert_eq!(remaining_requests.len(), 2);
    assert!(remaining_requests[0].starts_with(&format!("POST {reserve_path} ")));
    assert!(remaining_requests[1].starts_with(&format!("POST {reserve_path} ")));

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["deliveryId"], DELIVERY_ID);
    assert_eq!(payload["text"], "retry delivered");
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
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");

    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response("200 OK", r#"{"outcome":"empty"}"#),
        http_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"recheck delivered"}}"#,
            ),
        ),
    ])
    .await;

    let notifications = ActiveInputNotifications::new();
    let source =
        api_active_input_source(api_url, run_id, &notifications, "active-input-recheck-test");
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

    let initial_reserve = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, request_rx.recv())
        .await
        .expect("initial active-input reserve request should reach the server")
        .expect("active-input request channel should remain open");
    assert!(initial_reserve.starts_with(&format!("POST {reserve_path} ")));

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
    assert_eq!(remaining_requests.len(), 1);
    assert!(remaining_requests[0].starts_with(&format!("POST {reserve_path} ")));

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap()["text"],
        "recheck delivered"
    );
}

#[tokio::test]
async fn run_in_sandbox_retries_local_active_input_with_same_id_after_uncertain_error() {
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
    assert_eq!(
        overrides
            .process_control_calls()
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            local_active_input_delivery_id(run_id, 1),
            local_active_input_delivery_id(run_id, 1),
            local_active_input_delivery_id(run_id, 2),
        ]
    );
}

#[tokio::test]
async fn run_in_sandbox_retries_reserve_when_first_request_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response("404 Not Found", r#"{"error":"not found"}"#),
        http_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"reserve delivered"}}"#,
            ),
        ),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-first-not-found-test",
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

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
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
        .unwrap()
        .unwrap();

    let mut requests = Vec::new();
    while let Some(request) = request_rx.recv().await {
        requests.push(request);
    }
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["deliveryId"], DELIVERY_ID);
    assert_eq!(payload["text"], "reserve delivered");
}

#[tokio::test]
async fn run_in_sandbox_retrieves_reservation_after_lost_first_response() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let reserved = http_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retrieved delivery"}}"#,
        ),
    );
    let (api_url, mut request_rx, server) = spawn_http_server_with_actions(vec![
        HttpServerAction::Disconnect,
        HttpServerAction::Respond(reserved),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-lost-reserve-response-test",
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

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    server.await.unwrap();

    let mut requests = Vec::new();
    while let Some(request) = request_rx.recv().await {
        requests.push(request);
    }
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
}

#[tokio::test]
async fn run_in_sandbox_keeps_using_reserve_after_ambiguous_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response("503 Service Unavailable", r#"{"error":"transient"}"#),
        http_response("404 Not Found", r#"{"error":"not found"}"#),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-reserve-only-test",
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

    tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, server)
        .await
        .unwrap()
        .unwrap();
    let mut requests = Vec::new();
    while let Some(request) = request_rx.recv().await {
        requests.push(request);
    }
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_stops_when_reserve_reports_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let (api_url, _request_rx, server) =
        spawn_http_server(vec![http_response("200 OK", r#"{"outcome":"terminal"}"#)]).await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-terminal-test",
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

    server.await.unwrap();
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_retries_not_written_delivery_with_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::Failed {
        kind: sandbox::ProcessControlFailureKind::Operation,
        write_state: sandbox::ProcessControlWriteState::NotWritten,
        error: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "not written"),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let (api_url, _request_rx, server) = spawn_http_server(vec![http_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retry exact delivery"}}"#,
        ),
    )])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-not-written-test",
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
    server.await.unwrap();
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|call| call.message_id == DELIVERY_ID));
    assert_eq!(calls[0].payload, calls[1].payload);
}

#[tokio::test]
async fn run_in_sandbox_retries_guest_backpressure_with_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    for status in [
        sandbox::ProcessControlGuestStatus::QueueFull,
        sandbox::ProcessControlGuestStatus::SinkUnavailable,
    ] {
        overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::GuestStatus {
            status,
            diagnostic: "retryable guest backpressure".to_string(),
        });
    }
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let (api_url, _request_rx, server) = spawn_http_server(vec![http_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retry guest backpressure"}}"#,
        ),
    )])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-guest-backpressure-test",
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
    server.await.unwrap();
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|call| call.message_id == DELIVERY_ID));
    assert!(
        calls
            .windows(2)
            .all(|pair| pair[0].payload == pair[1].payload)
    );
}

#[tokio::test]
async fn run_in_sandbox_suppresses_possibly_written_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_io_error(
        std::io::ErrorKind::TimedOut,
        "delivery acknowledgement timed out",
    );
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve = http_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"uncertain delivery"}}"#,
        ),
    );
    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        reserve.clone(),
        reserve,
        http_response("200 OK", r#"{"outcome":"empty"}"#),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-possibly-written-test",
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

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    request_rx.recv().await.unwrap();
    notifications.notify(run_id);
    request_rx.recv().await.unwrap();
    notifications.notify(run_id);
    request_rx.recv().await.unwrap();
    assert_eq!(overrides.process_control_calls().len(), 1);
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    server.await.unwrap();
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
}

#[tokio::test]
async fn run_in_sandbox_carries_failed_journal_receipt_to_completion() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    overrides.push_read_file_result(Err(sandbox_read_file_error(
        "transient guest file read failure",
    )));
    overrides.push_read_file_result(Ok(Some(
        format!(r#"{{"runId":"{run_id}","deliveryIds":["{DELIVERY_ID}"]}}"#).into_bytes(),
    )));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let receipt_path =
        format!("/api/runners/runs/{run_id}/active-inputs/deliveries/{DELIVERY_ID}/receipt");
    let (api_url, mut request_rx, server) = spawn_http_server(vec![
        http_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"recover receipt"}}"#,
            ),
        ),
        http_response("503 Service Unavailable", r#"{"error":"transient"}"#),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-journal-recovery-test",
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

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
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
        result.active_input_delivery_ids,
        vec![DELIVERY_ID.to_string()]
    );
    server.await.unwrap();
    let first_request = request_rx.recv().await.unwrap();
    let second_request = request_rx.recv().await.unwrap();
    assert!(first_request.starts_with(&format!("POST {reserve_path} ")));
    assert!(second_request.starts_with(&format!("POST {receipt_path} ")));
}
