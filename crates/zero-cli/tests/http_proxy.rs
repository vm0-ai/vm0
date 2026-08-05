use std::fs::{self, File};
use std::io::{self, Read as _, Seek as _, Write as _};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use api_contracts::generated::routes::runners::heartbeat::HEARTBEAT;
use zero_cli::config::RuntimeConfig;
use zero_cli::http::ApiClient;

const CHILD_MARKER: &str = "ZERO_CLI_HTTP_PROXY_CHILD";
const EXPECT_ERROR_MARKER: &str = "ZERO_CLI_HTTP_PROXY_EXPECT_ERROR";
const HANG_READY_PATH: &str = "ZERO_CLI_HTTP_PROXY_HANG_READY_PATH";
const HANG_STDERR_MARKER: &str = "proxy child reached deliberate stall";
const CHILD_RUN_TIMEOUT: Duration = Duration::from_secs(10);
const CHILD_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_READY_TIMEOUT: Duration = Duration::from_secs(5);
const REGRESSION_CLEANUP_BOUND: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(1);
const HTTP_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";

#[test]
fn http_client_honors_lowercase_proxy_environment_precedence() -> io::Result<()> {
    let server = HttpServer::start()?;
    let proxy_url = format!("http://{}", server.address());
    let child = spawn_proxy_child(
        "http://zero-cli.invalid",
        &proxy_url,
        "http://127.0.0.1:1",
        None,
        false,
    )?;
    let request = finish_proxy_case(child, server)?;

    assert!(request.starts_with("POST http://zero-cli.invalid/api/runners/heartbeat HTTP/1.1\r\n"));
    Ok(())
}

#[test]
fn http_client_honors_no_proxy_environment() -> io::Result<()> {
    let server = HttpServer::start()?;
    let api_url = format!("http://{}", server.address());
    let child = spawn_proxy_child(
        &api_url,
        "http://127.0.0.1:1",
        "http://127.0.0.1:1",
        Some("127.0.0.1"),
        false,
    )?;
    let request = finish_proxy_case(child, server)?;

    assert!(request.starts_with("POST /api/runners/heartbeat HTTP/1.1\r\n"));
    Ok(())
}

#[test]
fn http_proxy_is_the_https_fallback_when_https_proxy_is_absent() -> io::Result<()> {
    let server = HttpServer::start()?;
    let proxy_url = format!("http://{}", server.address());
    let child = spawn_proxy_child(
        "https://zero-cli.invalid",
        &proxy_url,
        "http://127.0.0.1:1",
        None,
        true,
    )?;
    let request = finish_proxy_case(child, server)?;

    assert!(request.starts_with("CONNECT zero-cli.invalid:443 HTTP/1.1\r\n"));
    Ok(())
}

#[test]
fn child_timeout_kills_and_reaps_child_and_stops_server() -> io::Result<()> {
    let server = HttpServer::start()?;
    let ready_dir = tempfile::tempdir()?;
    let ready_path = ready_dir.path().join("ready");
    let mut command = child_test_command("proxy_child_hangs_after_marking_ready")?;
    command.env(HANG_READY_PATH, &ready_path);
    let child = CommandExecution::spawn(&mut command)?;
    #[cfg(unix)]
    let child_pid = child.id()?;

    wait_for_ready(&ready_path, CHILD_READY_TIMEOUT)?;
    let cleanup_started = Instant::now();
    let child_error = child
        .wait_with_timeout(Duration::ZERO)
        .expect_err("deliberately stalled proxy child should time out");
    let server_outcome = server.finish()?;

    assert_eq!(child_error.kind(), io::ErrorKind::TimedOut);
    assert!(child_error.to_string().contains(HANG_STDERR_MARKER));
    assert!(child_error.to_string().contains("reap=completed with"));
    assert_eq!(server_outcome, ServerOutcome::Cancelled);
    assert!(
        cleanup_started.elapsed() < REGRESSION_CLEANUP_BOUND,
        "child and server cleanup exceeded {REGRESSION_CLEANUP_BOUND:?}"
    );
    #[cfg(unix)]
    assert_child_reaped(child_pid)?;

    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum ServerOutcome {
    Request(Vec<u8>),
    Cancelled,
}

struct HttpServer {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<io::Result<ServerOutcome>>>,
}

impl HttpServer {
    fn start() -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("zero-cli-http-proxy-test-server".to_owned())
            .spawn(move || serve_http(listener, &thread_stop))?;
        Ok(Self {
            address,
            stop,
            thread: Some(thread),
        })
    }

    const fn address(&self) -> SocketAddr {
        self.address
    }

    fn finish(mut self) -> io::Result<ServerOutcome> {
        self.stop.store(true, Ordering::Release);
        join_server_thread(&mut self.thread)
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = join_server_thread(&mut self.thread);
    }
}

fn join_server_thread(
    thread: &mut Option<JoinHandle<io::Result<ServerOutcome>>>,
) -> io::Result<ServerOutcome> {
    let thread = thread
        .take()
        .ok_or_else(|| io::Error::other("proxy server thread was already joined"))?;
    thread
        .join()
        .map_err(|_| io::Error::other("proxy server thread panicked"))?
}

fn serve_http(listener: TcpListener, stop: &AtomicBool) -> io::Result<ServerOutcome> {
    let Some(mut stream) = accept_until_stopped(&listener, stop)? else {
        return Ok(ServerOutcome::Cancelled);
    };
    stream.set_nonblocking(true)?;
    let Some(request) = read_request_until_stopped(&mut stream, stop)? else {
        return Ok(ServerOutcome::Cancelled);
    };
    if !write_response_until_stopped(&mut stream, stop)? {
        return Ok(ServerOutcome::Cancelled);
    }
    Ok(ServerOutcome::Request(request))
}

fn accept_until_stopped(
    listener: &TcpListener,
    stop: &AtomicBool,
) -> io::Result<Option<TcpStream>> {
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(None);
        }
        match listener.accept() {
            Ok((stream, _)) => return Ok(Some(stream)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

fn read_request_until_stopped(
    stream: &mut TcpStream,
    stop: &AtomicBool,
) -> io::Result<Option<Vec<u8>>> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(None);
        }
        match stream.read(&mut buffer) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "proxy client closed before completing request headers",
                ));
            }
            Ok(count) => {
                let bytes = buffer
                    .get(..count)
                    .ok_or_else(|| io::Error::other("proxy request read exceeded buffer"))?;
                request.extend_from_slice(bytes);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    return Ok(Some(request));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

fn write_response_until_stopped(stream: &mut TcpStream, stop: &AtomicBool) -> io::Result<bool> {
    let mut written = 0;
    while written < HTTP_RESPONSE.len() {
        if stop.load(Ordering::Acquire) {
            return Ok(false);
        }
        let remaining = HTTP_RESPONSE
            .get(written..)
            .ok_or_else(|| io::Error::other("proxy response write exceeded buffer"))?;
        match stream.write(remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "proxy response stream stopped accepting bytes",
                ));
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

struct CommandExecution {
    child: Option<Child>,
    stdout: File,
    stderr: File,
}

impl CommandExecution {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        let stdout = tempfile::tempfile()?;
        let stderr = tempfile::tempfile()?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout.try_clone()?))
            .stderr(Stdio::from(stderr.try_clone()?));
        Ok(Self {
            child: Some(command.spawn()?),
            stdout,
            stderr,
        })
    }

    #[cfg(unix)]
    fn id(&self) -> io::Result<u32> {
        self.child
            .as_ref()
            .map(Child::id)
            .ok_or_else(|| io::Error::other("proxy child was already consumed"))
    }

    fn wait(self) -> io::Result<Output> {
        self.wait_with_timeout(CHILD_RUN_TIMEOUT)
    }

    fn wait_with_timeout(mut self, timeout: Duration) -> io::Result<Output> {
        let mut child = self
            .child
            .take()
            .ok_or_else(|| io::Error::other("proxy child was already consumed"))?;
        let deadline = Instant::now() + timeout;

        loop {
            match child.try_wait() {
                Ok(Some(status)) => return self.read_output(status),
                Ok(None) => {}
                Err(error) => {
                    let cleanup = terminate_and_reap(child);
                    let diagnostics = self.read_diagnostics();
                    return Err(io::Error::new(
                        error.kind(),
                        format!(
                            "failed to observe proxy child completion: {error}; cleanup: {cleanup}; \
                             {diagnostics}"
                        ),
                    ));
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(remaining.min(POLL_INTERVAL));
        }

        let cleanup = terminate_and_reap(child);
        let diagnostics = self.read_diagnostics();
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("proxy child timed out after {timeout:?}; cleanup: {cleanup}; {diagnostics}"),
        ))
    }

    fn read_output(&mut self, status: ExitStatus) -> io::Result<Output> {
        let (stdout, stderr) = self.read_streams()?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }

    fn read_diagnostics(&mut self) -> String {
        match self.read_streams() {
            Ok((stdout, stderr)) => format!(
                "stdout={:?}; stderr={:?}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            ),
            Err(error) => format!("failed to read captured output: {error}"),
        }
    }

    fn read_streams(&mut self) -> io::Result<(Vec<u8>, Vec<u8>)> {
        Ok((
            read_captured_stream(&mut self.stdout, "stdout")?,
            read_captured_stream(&mut self.stderr, "stderr")?,
        ))
    }
}

impl Drop for CommandExecution {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = terminate_and_reap(child);
        }
    }
}

fn read_captured_stream(file: &mut File, name: &str) -> io::Result<Vec<u8>> {
    file.rewind()
        .map_err(|error| io::Error::new(error.kind(), format!("rewind child {name}: {error}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io::Error::new(error.kind(), format!("read child {name}: {error}")))?;
    Ok(bytes)
}

fn terminate_and_reap(mut child: Child) -> String {
    let kill = match child.kill() {
        Ok(()) => "signal sent".to_owned(),
        Err(error) => format!("failed: {error}"),
    };
    let reap = match reap_child_with_timeout(child, CHILD_CLEANUP_TIMEOUT) {
        Ok(status) => format!("completed with {status}"),
        Err(error) => format!("failed: {error}"),
    };
    format!("kill={kill}, reap={reap}")
}

fn reap_child_with_timeout(mut child: Child, timeout: Duration) -> io::Result<ExitStatus> {
    let (status_tx, status_rx) = mpsc::channel();
    let reaper = thread::spawn(move || {
        let _ = status_tx.send(child.wait());
    });
    match status_rx.recv_timeout(timeout) {
        Ok(status) => {
            reaper
                .join()
                .map_err(|_| io::Error::other("proxy child reaper panicked"))?;
            status
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            drop(reaper);
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("proxy child was not reaped within {timeout:?}"),
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            drop(reaper);
            Err(io::Error::other("proxy child reaper exited without status"))
        }
    }
}

fn child_test_command(test_name: &str) -> io::Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command.args(["--ignored", "--exact", test_name, "--nocapture"]);
    Ok(command)
}

fn spawn_proxy_child(
    api_url: &str,
    lowercase_proxy: &str,
    uppercase_proxy: &str,
    no_proxy: Option<&str>,
    expect_error: bool,
) -> io::Result<CommandExecution> {
    let mut command = child_test_command("proxy_child_uses_runtime_http_client")?;
    command
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
    CommandExecution::spawn(&mut command)
}

fn finish_proxy_case(child: CommandExecution, server: HttpServer) -> io::Result<String> {
    let child_result = child.wait();
    let server_result = server.finish();
    match (child_result, server_result) {
        (Ok(output), Ok(ServerOutcome::Request(request))) if output.status.success() => {
            String::from_utf8(request)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        }
        (Ok(output), Ok(server_outcome)) => Err(io::Error::other(format!(
            "proxy child exited with {}; stdout={:?}; stderr={:?}; server={server_outcome:?}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))),
        (Ok(output), Err(server_error)) => Err(io::Error::new(
            server_error.kind(),
            format!(
                "proxy server failed after child exited with {}; stdout={:?}; stderr={:?}: \
                 {server_error}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
        )),
        (Err(child_error), Ok(server_outcome)) => Err(io::Error::new(
            child_error.kind(),
            format!("{child_error}; server={server_outcome:?}"),
        )),
        (Err(child_error), Err(server_error)) => Err(io::Error::new(
            child_error.kind(),
            format!("{child_error}; proxy server cleanup failed: {server_error}"),
        )),
    }
}

fn wait_for_ready(path: &Path, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match fs::read(path) {
            Ok(contents) if contents == b"ready" => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("proxy child did not become ready within {timeout:?}"),
            ));
        }
        thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

#[cfg(unix)]
fn assert_child_reaped(pid: u32) -> io::Result<()> {
    let pid = libc::pid_t::try_from(pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "proxy child PID does not fit in pid_t",
        )
    })?;
    let mut status = 0;
    // SAFETY: the child execution owner has already returned the direct
    // child's wait status; WNOHANG only verifies that it is no longer waitable.
    let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    let error = io::Error::last_os_error();
    if result == -1 && error.raw_os_error() == Some(libc::ECHILD) {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "proxy child {pid} remained waitable after cleanup: waitpid={result}, error={error}"
        )))
    }
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

#[test]
#[ignore = "runs only as a deliberately stalled proxy lifecycle child"]
fn proxy_child_hangs_after_marking_ready() {
    let Some(ready_path) = std::env::var_os(HANG_READY_PATH) else {
        return;
    };
    eprintln!("{HANG_STDERR_MARKER}");
    io::stderr().flush().unwrap();
    fs::write(ready_path, b"ready").unwrap();
    loop {
        thread::park();
    }
}
