use std::path::PathBuf;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

use super::test_support::{
    MOCK_REQUEST_READ_TIMEOUT, MockFirecrackerApi, MockRequest, MockResponse, read_mock_request,
};
use super::{ApiClient, ApiError};
use crate::config::RateLimiterConfig;

fn assert_request(request: &MockRequest, method: &str, path: &str) {
    assert_eq!(request.method, method, "raw request: {}", request.raw);
    assert_eq!(request.path, path, "raw request: {}", request.raw);
}

fn request_body_json(request: &MockRequest) -> serde_json::Value {
    serde_json::from_str(&request.body)
        .unwrap_or_else(|error| panic!("invalid JSON body: {error}; raw request: {}", request.raw))
}

fn test_rate_limiter(size: u64) -> RateLimiterConfig {
    RateLimiterConfig {
        bandwidth: Some(crate::config::TokenBucketConfig {
            size,
            refill_time: crate::config::RATE_LIMITER_REFILL_TIME_MS,
        }),
        ops: None,
    }
}

async fn run_with_split_response<T, Fut>(
    response: MockResponse,
    call: impl FnOnce(PathBuf) -> Fut,
) -> (T, MockRequest)
where
    Fut: std::future::Future<Output = T>,
{
    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("fc.sock");
    let listener = UnixListener::bind(&sock_path).unwrap();
    let (request_tx, request_rx) = oneshot::channel();
    let (header_written_tx, header_written_rx) = oneshot::channel();
    let (write_body_tx, write_body_rx) = oneshot::channel();
    let server = async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_mock_request(&mut stream).await.unwrap();
        request_tx.send(request).unwrap();

        let header = format!(
            "HTTP/1.1 {} {}\r\nContent-Length: {}\r\n\r\n",
            response.status,
            response.reason,
            response.body.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        header_written_tx.send(()).unwrap();

        write_body_rx.await.unwrap();
        stream.write_all(response.body.as_bytes()).await.unwrap();
    };
    tokio::pin!(server);

    let client = call(sock_path);
    tokio::pin!(client);

    tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, async {
        tokio::select! {
            result = header_written_rx => result.unwrap(),
            _ = &mut client => panic!("client completed before split response header"),
            result = &mut server => panic!("mock server exited before split response header: {result:?}"),
        }
    })
    .await
    .expect("timed out waiting for split response header");
    write_body_tx.send(()).unwrap();

    let (output, ()) = tokio::time::timeout(MOCK_REQUEST_READ_TIMEOUT, async {
        tokio::join!(&mut client, &mut server)
    })
    .await
    .expect("timed out waiting for split response completion");
    let request = request_rx.await.unwrap();
    (output, request)
}

#[tokio::test]
async fn mock_firecracker_api_reads_split_request_body() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let mut stream = UnixStream::connect(api.socket_path()).await.unwrap();

    stream
        .write_all(
            b"PUT /split HTTP/1.1\r\n\
              Host: localhost\r\n\
              Content-Length: 14\r\n\
              \r\n",
        )
        .await
        .unwrap();
    stream.write_all(br#"{"split":true}"#).await.unwrap();

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/split");
    assert_eq!(request.body, r#"{"split":true}"#);
}

#[test]
fn api_error_is_retryable_connection_refused() {
    let err = ApiError::Connect(std::io::Error::new(
        std::io::ErrorKind::ConnectionRefused,
        "connection refused",
    ));
    assert!(err.is_retryable());
}

#[test]
fn api_error_is_not_retryable_permission_denied() {
    let err = ApiError::Connect(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "permission denied",
    ));
    assert!(!err.is_retryable());
}

#[test]
fn api_error_is_retryable_http_server_error() {
    let err = ApiError::Http {
        status: 500,
        body: "internal error".to_string(),
    };
    assert!(err.is_retryable());
}

#[test]
fn api_error_is_retryable_http_client_error() {
    // Client errors (4xx) are also retryable — the implementation treats
    // all Http variants as retryable (e.g. Firecracker may return 400
    // during startup before the VM is ready).
    let err = ApiError::Http {
        status: 400,
        body: "bad request".to_string(),
    };
    assert!(err.is_retryable());
}

#[test]
fn api_error_is_retryable_other() {
    let err = ApiError::Other("timeout".to_string());
    assert!(err.is_retryable());
}

#[tokio::test]
async fn wait_for_ready_succeeds_on_200() {
    let mut api = MockFirecrackerApi::repeating(MockResponse::ok());
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.wait_for_ready(Duration::from_secs(2)).await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "GET", "/");
}

#[tokio::test]
async fn wait_for_ready_times_out_on_missing_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.sock");
    let client = ApiClient::new(&path);
    let result = client.wait_for_ready(Duration::ZERO).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("timed out"), "got: {err}");
}

#[tokio::test]
async fn load_snapshot_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .load_snapshot("/snap/state", "/snap/memory", true)
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/snapshot/load");
    let body = request_body_json(&request);
    assert_eq!(body["snapshot_path"], "/snap/state");
    assert_eq!(body["mem_backend"]["backend_type"], "File");
    assert_eq!(body["mem_backend"]["backend_path"], "/snap/memory");
    assert_eq!(body["resume_vm"], true);
}

#[tokio::test]
async fn load_snapshot_can_leave_vm_paused() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .load_snapshot("/snap/state", "/snap/memory", false)
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/snapshot/load");
    let body = request_body_json(&request);
    assert_eq!(body["resume_vm"], false);
}

#[tokio::test]
async fn wait_for_ready_detects_deferred_socket() {
    let (mut api, bind_socket) = MockFirecrackerApi::deferred_repeating(MockResponse::ok());
    let sock_path = api.socket_path().to_path_buf();
    let waiter = tokio::spawn(async move {
        let client = ApiClient::new(&sock_path);
        client.wait_for_ready(Duration::from_secs(2)).await
    });

    bind_socket.send(()).unwrap();
    let result = waiter.await.unwrap();
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "GET", "/");
}

#[tokio::test]
async fn wait_for_ready_retries_until_success() {
    let mut api = MockFirecrackerApi::with_responses([
        MockResponse::internal_error_raw(""),
        MockResponse::internal_error_raw(""),
        MockResponse::internal_error_raw(""),
        MockResponse::ok(),
    ]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.wait_for_ready(Duration::from_secs(2)).await;
    assert!(result.is_ok());

    for _ in 0..4 {
        let request = api.next_request().await;
        assert_request(&request, "GET", "/");
    }
}

#[tokio::test]
async fn load_snapshot_error_falls_back_to_raw_body() {
    let mut api =
        MockFirecrackerApi::with_responses([MockResponse::internal_error_raw("plain text error")]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .load_snapshot("/snap/state", "/snap/memory", true)
        .await;
    let ApiError::Http { status, body } = result.unwrap_err() else {
        panic!("expected Http error");
    };
    assert_eq!(status, 500);
    assert_eq!(body, "plain text error");

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/snapshot/load");
}

#[tokio::test]
async fn load_snapshot_returns_error_on_non_204() {
    let fault_message = r#"bad "snapshot" \ path"#;
    let mut api =
        MockFirecrackerApi::with_responses([MockResponse::bad_request_fault(fault_message)]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .load_snapshot("/snap/state", "/snap/memory", true)
        .await;
    let ApiError::Http { status, body } = result.unwrap_err() else {
        panic!("expected Http error");
    };
    assert_eq!(status, 400);
    // fault_message is extracted from JSON response (matches TS behavior).
    assert_eq!(body, fault_message);

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/snapshot/load");
}

#[tokio::test]
async fn pause_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.pause().await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PATCH", "/vm");
    let body = request_body_json(&request);
    assert_eq!(body["state"], "Paused");
}

#[tokio::test]
async fn resume_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.resume().await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PATCH", "/vm");
    let body = request_body_json(&request);
    assert_eq!(body["state"], "Resumed");
}

#[tokio::test]
async fn create_snapshot_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.create_snapshot("/snap/state", "/snap/memory").await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/snapshot/create");
    let body = request_body_json(&request);
    assert_eq!(body["snapshot_type"], "Full");
    assert_eq!(body["snapshot_path"], "/snap/state");
    assert_eq!(body["mem_file_path"], "/snap/memory");
}

#[tokio::test]
async fn pause_returns_error_on_failure() {
    let mut api =
        MockFirecrackerApi::with_responses([MockResponse::bad_request_fault("cannot pause")]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let ApiError::Http { status, body } = client.pause().await.unwrap_err() else {
        panic!("expected Http error");
    };
    assert_eq!(status, 400);
    assert_eq!(body, "cannot pause");

    let request = api.next_request().await;
    assert_request(&request, "PATCH", "/vm");
}

#[tokio::test]
async fn configure_machine_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.configure_machine(2, 256).await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/machine-config");
    let body = request_body_json(&request);
    assert_eq!(body["vcpu_count"], 2);
    assert_eq!(body["mem_size_mib"], 256);
}

#[tokio::test]
async fn configure_boot_source_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .configure_boot_source("/path/to/kernel", "console=ttyS0")
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/boot-source");
    let body = request_body_json(&request);
    assert_eq!(body["kernel_image_path"], "/path/to/kernel");
    assert_eq!(body["boot_args"], "console=ttyS0");
}

#[tokio::test]
async fn configure_drive_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .configure_drive("rootfs", "/path/to/rootfs", true, true, None)
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/drives/rootfs");
    let body = request_body_json(&request);
    assert_eq!(body["drive_id"], "rootfs");
    assert_eq!(body["path_on_host"], "/path/to/rootfs");
    assert_eq!(body["is_root_device"], true);
    assert_eq!(body["is_read_only"], true);
    assert!(body.get("rate_limiter").is_none());
}

#[tokio::test]
async fn configure_drive_with_rate_limiter_serializes_limiter() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let limiter = RateLimiterConfig {
        bandwidth: Some(crate::config::TokenBucketConfig {
            size: 1024,
            refill_time: 100,
        }),
        ops: Some(crate::config::TokenBucketConfig {
            size: 10,
            refill_time: 100,
        }),
    };
    let result = client
        .configure_drive("rootfs", "/path/to/rootfs", true, true, Some(&limiter))
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/drives/rootfs");
    let body = request_body_json(&request);
    assert_eq!(body["drive_id"], "rootfs");
    assert_eq!(body["path_on_host"], "/path/to/rootfs");
    assert_eq!(body["is_root_device"], true);
    assert_eq!(body["is_read_only"], true);
    assert_eq!(body["rate_limiter"]["bandwidth"]["size"], 1024);
    assert_eq!(body["rate_limiter"]["bandwidth"]["refill_time"], 100);
    assert_eq!(body["rate_limiter"]["ops"]["size"], 10);
}

#[tokio::test]
async fn patch_drive_rate_limiter_serializes_partial_drive() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let limiter = test_rate_limiter(2048);

    let result = client.patch_drive_rate_limiter("rootfs", &limiter).await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PATCH", "/drives/rootfs");
    let body = request_body_json(&request);
    assert_eq!(body["drive_id"], "rootfs");
    assert_eq!(body["rate_limiter"]["bandwidth"]["size"], 2048);
}

#[tokio::test]
async fn configure_network_interface_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client
        .configure_network_interface("eth0", "02:00:00:00:00:01", "vm0-tap", None, None)
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/network-interfaces/eth0");
    let body = request_body_json(&request);
    assert_eq!(body["iface_id"], "eth0");
    assert_eq!(body["guest_mac"], "02:00:00:00:00:01");
    assert_eq!(body["host_dev_name"], "vm0-tap");
    assert!(body.get("rx_rate_limiter").is_none());
    assert!(body.get("tx_rate_limiter").is_none());
}

#[tokio::test]
async fn configure_network_interface_with_rate_limiters_serializes_limiters() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let rx = test_rate_limiter(4096);
    let tx = test_rate_limiter(8192);
    let result = client
        .configure_network_interface("eth0", "02:00:00:00:00:01", "vm0-tap", Some(&rx), Some(&tx))
        .await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/network-interfaces/eth0");
    let body = request_body_json(&request);
    assert_eq!(body["iface_id"], "eth0");
    assert_eq!(body["guest_mac"], "02:00:00:00:00:01");
    assert_eq!(body["host_dev_name"], "vm0-tap");
    assert_eq!(body["rx_rate_limiter"]["bandwidth"]["size"], 4096);
    assert_eq!(body["tx_rate_limiter"]["bandwidth"]["size"], 8192);
}

#[tokio::test]
async fn patch_network_rate_limiters_serializes_partial_network_interface() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let rx = test_rate_limiter(4096);
    let tx = test_rate_limiter(8192);

    let result = client.patch_network_rate_limiters("eth0", &rx, &tx).await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PATCH", "/network-interfaces/eth0");
    let body = request_body_json(&request);
    assert_eq!(body["iface_id"], "eth0");
    assert_eq!(body["rx_rate_limiter"]["bandwidth"]["size"], 4096);
    assert_eq!(body["tx_rate_limiter"]["bandwidth"]["size"], 8192);
}

#[tokio::test]
async fn configure_vsock_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.configure_vsock(3, "/tmp/vsock.sock").await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/vsock");
    let body = request_body_json(&request);
    assert_eq!(body["guest_cid"], 3);
    assert_eq!(body["uds_path"], "/tmp/vsock.sock");
}

#[tokio::test]
async fn start_instance_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.start_instance().await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/actions");
    let body = request_body_json(&request);
    assert_eq!(body["action_type"], "InstanceStart");
}

#[tokio::test]
async fn patch_balloon_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.patch_balloon(512).await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PATCH", "/balloon");
    let body = request_body_json(&request);
    assert_eq!(body["amount_mib"], 512);
}

#[tokio::test]
async fn get_balloon_statistics_parses_response() {
    let body = r#"{"target_mib":512,"actual_mib":256,"target_pages":131072,"actual_pages":65536,"free_memory":1073741824,"available_memory":1610612736,"total_memory":2147483648}"#;
    let mut api = MockFirecrackerApi::with_responses([MockResponse::ok_body(body)]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let stats = client.get_balloon_statistics().await.unwrap();
    assert_eq!(stats.target_mib, 512);
    assert_eq!(stats.actual_mib, 256);
    assert_eq!(stats.target_pages, 131072);
    assert_eq!(stats.actual_pages, 65536);
    assert_eq!(stats.free_memory, Some(1_073_741_824));
    assert_eq!(stats.available_memory, Some(1_610_612_736));
    assert_eq!(stats.total_memory, Some(2_147_483_648));
    // Optional fields not in response should be None.
    assert_eq!(stats.swap_in, None);
    assert_eq!(stats.major_faults, None);

    let request = api.next_request().await;
    assert_request(&request, "GET", "/balloon/statistics");
}

#[tokio::test]
async fn get_balloon_statistics_reads_split_response_body() {
    let body = r#"{"target_mib":768,"actual_mib":384,"target_pages":196608,"actual_pages":98304}"#;
    let (result, request) =
        run_with_split_response(MockResponse::ok_body(body), |sock_path| async move {
            let client = ApiClient::new(&sock_path);
            client.get_balloon_statistics().await
        })
        .await;

    let stats = result.unwrap();
    assert_eq!(stats.target_mib, 768);
    assert_eq!(stats.actual_mib, 384);
    assert_eq!(stats.target_pages, 196_608);
    assert_eq!(stats.actual_pages, 98_304);

    assert_request(&request, "GET", "/balloon/statistics");
}

#[tokio::test]
async fn load_snapshot_error_reads_split_response_body() {
    let fault_message = "snapshot body arrived after headers";
    let (result, request) = run_with_split_response(
        MockResponse::bad_request_fault(fault_message),
        |sock_path| async move {
            let client = ApiClient::new(&sock_path);
            client
                .load_snapshot("/snap/state", "/snap/memory", true)
                .await
        },
    )
    .await;

    let ApiError::Http { status, body } = result.unwrap_err() else {
        panic!("expected Http error");
    };
    assert_eq!(status, 400);
    assert_eq!(body, fault_message);
    assert_request(&request, "PUT", "/snapshot/load");
}

#[tokio::test]
async fn get_balloon_statistics_handles_minimal_response() {
    let body = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0}"#;
    let mut api = MockFirecrackerApi::with_responses([MockResponse::ok_body(body)]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let stats = client.get_balloon_statistics().await.unwrap();
    assert_eq!(stats.target_mib, 0);
    assert_eq!(stats.actual_mib, 0);
    assert_eq!(stats.free_memory, None);
    assert_eq!(stats.available_memory, None);

    let request = api.next_request().await;
    assert_request(&request, "GET", "/balloon/statistics");
}

#[tokio::test]
async fn get_balloon_statistics_returns_error_on_malformed_response() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::ok_body("{not json")]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let ApiError::Other(message) = client.get_balloon_statistics().await.unwrap_err() else {
        panic!("expected parse error");
    };
    assert!(
        message.contains("parse balloon statistics"),
        "got: {message}"
    );

    let request = api.next_request().await;
    assert_request(&request, "GET", "/balloon/statistics");
}

#[tokio::test]
async fn configure_balloon_succeeds_on_204() {
    let mut api = MockFirecrackerApi::with_responses([MockResponse::no_content()]);
    let sock_path = api.socket_path().to_path_buf();
    let client = ApiClient::new(&sock_path);
    let result = client.configure_balloon(0, true, 0).await;
    assert!(result.is_ok());

    let request = api.next_request().await;
    assert_request(&request, "PUT", "/balloon");
    let body = request_body_json(&request);
    assert_eq!(body["amount_mib"], 0);
    assert_eq!(body["deflate_on_oom"], true);
    assert_eq!(body["stats_polling_interval_s"], 0);
}

#[tokio::test]
async fn wait_for_ready_fails_fast_on_permission_denied() {
    // Root bypasses file permissions; skip this test.
    if nix::unistd::getuid().is_root() {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("fc.sock");

    // Create a socket then remove all permissions so connect gets PermissionDenied.
    let _listener = UnixListener::bind(&sock_path).unwrap();

    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o000)).unwrap();

    let client = ApiClient::new(&sock_path);
    let start = std::time::Instant::now();
    let result = client.wait_for_ready(Duration::from_secs(5)).await;
    let elapsed = start.elapsed();

    // Should fail immediately, not spin for 5 seconds.
    assert!(result.is_err(), "expected error");
    assert!(
        elapsed < Duration::from_secs(1),
        "should fail fast, took {elapsed:?}"
    );
    let ApiError::Connect(ref io_err) = result.unwrap_err() else {
        panic!("expected Connect error");
    };
    assert_eq!(io_err.kind(), std::io::ErrorKind::PermissionDenied);
}
