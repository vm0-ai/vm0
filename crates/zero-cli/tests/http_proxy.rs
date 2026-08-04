use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use api_contracts::generated::routes::runners::heartbeat::HEARTBEAT;
use zero_cli::config::RuntimeConfig;
use zero_cli::http::ApiClient;

const CHILD_MARKER: &str = "ZERO_CLI_HTTP_PROXY_CHILD";
const EXPECT_ERROR_MARKER: &str = "ZERO_CLI_HTTP_PROXY_EXPECT_ERROR";

#[test]
fn http_client_honors_lowercase_proxy_environment_precedence() {
    let (address, requests, server) = start_http_server();
    let proxy_url = format!("http://{address}");
    let output = run_child(
        "http://zero-cli.invalid",
        &proxy_url,
        "http://127.0.0.1:1",
        None,
        false,
    );
    let request = finish_http_server(&output, address, requests, server);

    assert!(request.starts_with("POST http://zero-cli.invalid/api/runners/heartbeat HTTP/1.1\r\n"));
}

#[test]
fn http_client_honors_no_proxy_environment() {
    let (address, requests, server) = start_http_server();
    let api_url = format!("http://{address}");
    let output = run_child(
        &api_url,
        "http://127.0.0.1:1",
        "http://127.0.0.1:1",
        Some("127.0.0.1"),
        false,
    );
    let request = finish_http_server(&output, address, requests, server);

    assert!(request.starts_with("POST /api/runners/heartbeat HTTP/1.1\r\n"));
}

#[test]
fn http_proxy_is_the_https_fallback_when_https_proxy_is_absent() {
    let (address, requests, server) = start_http_server();
    let proxy_url = format!("http://{address}");
    let output = run_child(
        "https://zero-cli.invalid",
        &proxy_url,
        "http://127.0.0.1:1",
        None,
        true,
    );
    let request = finish_http_server(&output, address, requests, server);

    assert!(request.starts_with("CONNECT zero-cli.invalid:443 HTTP/1.1\r\n"));
}

fn start_http_server() -> (SocketAddr, Receiver<Vec<u8>>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (request_sender, request_receiver) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .unwrap();
        request_sender.send(request).unwrap();
    });
    (address, request_receiver, server)
}

fn run_child(
    api_url: &str,
    lowercase_proxy: &str,
    uppercase_proxy: &str,
    no_proxy: Option<&str>,
    expect_error: bool,
) -> Output {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "proxy_child_uses_runtime_http_client",
            "--nocapture",
        ])
        .env(CHILD_MARKER, "1")
        .env("ZERO_TOKEN", "proxy-test-token")
        .env("VM0_API_BACKEND_URL", api_url)
        .env("http_proxy", lowercase_proxy)
        .env("HTTP_PROXY", uppercase_proxy)
        .env_remove("https_proxy")
        .env_remove("HTTPS_PROXY")
        .env_remove("all_proxy")
        .env_remove("ALL_PROXY")
        .env_remove("no_proxy")
        .env_remove("NO_PROXY");
    if expect_error {
        command.env(EXPECT_ERROR_MARKER, "1");
    } else {
        command.env_remove(EXPECT_ERROR_MARKER);
    }
    if let Some(no_proxy) = no_proxy {
        command.env("no_proxy", no_proxy).env("NO_PROXY", "");
    }
    command.output().unwrap()
}

fn finish_http_server(
    output: &Output,
    address: SocketAddr,
    requests: Receiver<Vec<u8>>,
    server: JoinHandle<()>,
) -> String {
    if !output.status.success() {
        let mut rescue = TcpStream::connect(address).unwrap();
        rescue
            .write_all(b"GET /rescue HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
    }
    let request = requests.recv_timeout(Duration::from_secs(2)).unwrap();
    server.join().unwrap();
    assert!(
        output.status.success(),
        "proxy child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(request).unwrap()
}

#[test]
#[ignore = "runs only as an environment-isolated child of the proxy integration tests"]
fn proxy_child_uses_runtime_http_client() {
    if std::env::var_os(CHILD_MARKER).is_none() {
        return;
    }
    let config = RuntimeConfig::from_env().unwrap();
    let client = ApiClient::from_config(&config).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    let result = runtime.block_on(
        client
            .request_route(HEARTBEAT)
            .timeout(Duration::from_secs(3))
            .send("proxy request failed"),
    );
    if std::env::var_os(EXPECT_ERROR_MARKER).is_some() {
        assert!(result.is_err());
    } else {
        result.unwrap();
    }
}
