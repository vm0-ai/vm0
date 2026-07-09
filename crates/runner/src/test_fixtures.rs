use std::ffi::OsStr;
use std::io;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

use crate::ids::RunId;
use crate::types::ExecutionContext;

const RAW_HTTP_FIXTURE_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_OUTPUT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_OUTPUT_HEAD_BYTES: usize = 8 * 1024;
const CHILD_OUTPUT_TAIL_BYTES: usize = 8 * 1024;
const CHILD_OUTPUT_READ_CHUNK_BYTES: usize = 8 * 1024;
const CHILD_ENV_GUARD_ACTIVE_PREFIX: &str = "vm0 ignored child env guard active: ";

pub(crate) struct OneShotSessionHistoryServer {
    url: String,
    task: Option<JoinHandle<io::Result<()>>>,
}

#[derive(Clone, Copy)]
enum ResponseBodyEncoding {
    Raw,
    Chunked,
}

struct SessionHistoryFixtureResponse {
    status: String,
    body: Vec<u8>,
    content_length: Option<u64>,
    headers: Vec<(&'static str, &'static str)>,
    body_encoding: ResponseBodyEncoding,
    request_received: Option<oneshot::Sender<()>>,
    release_response: Option<Arc<Notify>>,
}

struct ChildOutput {
    head: Vec<u8>,
    tail: Vec<u8>,
    truncated_bytes: usize,
}

impl OneShotSessionHistoryServer {
    pub(crate) async fn respond_once(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
    ) -> Self {
        Self::spawn(SessionHistoryFixtureResponse {
            status: status.into(),
            body: body.into(),
            content_length,
            headers: Vec::new(),
            body_encoding: ResponseBodyEncoding::Raw,
            request_received: None,
            release_response: None,
        })
        .await
    }

    pub(crate) async fn respond_once_with_headers(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
        headers: Vec<(&'static str, &'static str)>,
    ) -> Self {
        Self::spawn(SessionHistoryFixtureResponse {
            status: status.into(),
            body: body.into(),
            content_length,
            headers,
            body_encoding: ResponseBodyEncoding::Raw,
            request_received: None,
            release_response: None,
        })
        .await
    }

    pub(crate) async fn respond_once_chunked(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
    ) -> Self {
        Self::spawn(SessionHistoryFixtureResponse {
            status: status.into(),
            body: body.into(),
            content_length: None,
            headers: vec![("Transfer-Encoding", "chunked")],
            body_encoding: ResponseBodyEncoding::Chunked,
            request_received: None,
            release_response: None,
        })
        .await
    }

    pub(crate) async fn respond_once_after_request(
        body: impl Into<Vec<u8>> + Send + 'static,
        request_received: oneshot::Sender<()>,
        release_response: Arc<Notify>,
    ) -> Self {
        let body = body.into();
        let content_length = Some(body.len() as u64);
        Self::spawn(SessionHistoryFixtureResponse {
            status: "200 OK".to_string(),
            body,
            content_length,
            headers: Vec::new(),
            body_encoding: ResponseBodyEncoding::Raw,
            request_received: Some(request_received),
            release_response: Some(release_response),
        })
        .await
    }

    pub(crate) fn url(&self) -> String {
        self.url.clone()
    }

    pub(crate) async fn assert_served(mut self) {
        let mut task = self
            .task
            .take()
            .expect("session history fixture task should be present");
        match tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, &mut task).await {
            Ok(result) => {
                result
                    .expect("session history fixture server task should not panic")
                    .expect("session history fixture server should not fail");
            }
            Err(_) => {
                task.abort();
                let _ = task.await;
                panic!("session history fixture server should finish");
            }
        }
    }

    async fn spawn(response: SessionHistoryFixtureResponse) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(serve_session_history_once(listener, response));

        Self {
            url: format!("http://{address}/history.blob?token=secret"),
            task: Some(task),
        }
    }
}

impl Drop for OneShotSessionHistoryServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn serve_session_history_once(
    listener: TcpListener,
    response: SessionHistoryFixtureResponse,
) -> io::Result<()> {
    let (mut stream, _) = listener.accept().await?;
    let mut request = [0u8; 1024];
    let request_bytes = stream.read(&mut request).await?;
    if request_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "session history fixture received an empty request",
        ));
    }

    if let Some(request_received) = response.request_received {
        let _ = request_received.send(());
    }
    if let Some(release_response) = response.release_response {
        release_response.notified().await;
    }

    let content_length_header = response
        .content_length
        .map(|content_length| format!("Content-Length: {content_length}\r\n"))
        .unwrap_or_default();
    let extra_headers = response
        .headers
        .into_iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let response_head = format!(
        "HTTP/1.1 {}\r\n{content_length_header}{extra_headers}Connection: close\r\n\r\n",
        response.status
    );
    stream.write_all(response_head.as_bytes()).await?;
    match response.body_encoding {
        ResponseBodyEncoding::Raw => {
            stream.write_all(&response.body).await?;
        }
        ResponseBodyEncoding::Chunked => {
            let chunk_header = format!("{:x}\r\n", response.body.len());
            stream.write_all(chunk_header.as_bytes()).await?;
            stream.write_all(&response.body).await?;
            stream.write_all(b"\r\n0\r\n\r\n").await?;
        }
    }
    Ok(())
}

pub(crate) fn execution_context_for_test(run_id: RunId) -> ExecutionContext {
    ExecutionContext {
        run_id,
        prompt: "test".into(),
        append_system_prompt: None,
        _agent_compose_version_id: None,
        vars: None,
        checkpoint_id: None,
        sandbox_token: "tok".into(),
        storage_manifest: None,
        environment: None,
        resume_session: None,
        secret_values: None,
        local_secret_env_keys: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        cli_agent_type: String::new(),
        real_agent_in_preview: None,
        api_start_time: None,
        user_timezone: None,
        capture_network_bodies: None,
        firewalls: None,
        network_policies: None,
        network_policy_refreshes: None,
        disallowed_tools: None,
        tools: None,
        settings: None,
        experimental_profile: None,
        feature_flags: None,
        billable_firewalls: vec![],
        model_usage_provider: None,
        codex_runtime_config: None,
    }
}

pub(crate) async fn run_ignored_child_test(
    child_test_name: &str,
    env_guard: (&str, &str),
    timeout: Duration,
) {
    let (env_guard_key, env_guard_value) = env_guard;
    assert!(
        !child_test_name.is_empty(),
        "ignored child test name must not be empty"
    );
    assert!(
        !env_guard_key.is_empty(),
        "ignored child test env guard key must not be empty"
    );
    assert!(
        !env_guard_value.is_empty(),
        "ignored child test env guard value must not be empty"
    );
    assert!(
        !timeout.is_zero(),
        "ignored child test timeout must not be zero"
    );

    let mut command =
        tokio::process::Command::new(std::env::current_exe().expect("resolve current test binary"));
    command
        .arg("--exact")
        .arg(child_test_name)
        .arg("--ignored")
        .arg("--nocapture")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env(env_guard_key, env_guard_value);

    let mut child = command.spawn().expect("spawn ignored child test");
    let stdout = child
        .stdout
        .take()
        .expect("ignored child test stdout must be piped");
    let stderr = child
        .stderr
        .take()
        .expect("ignored child test stderr must be piped");
    let stdout_task = tokio::spawn(read_child_output(stdout));
    let stderr_task = tokio::spawn(read_child_output(stderr));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let kill_error = kill_ignored_child(&mut child).await.err();
            let (stdout, stderr) = collect_child_output(stdout_task, stderr_task).await;
            match kill_error {
                Some(kill_error) => panic!(
                    "ignored child test {child_test_name} wait failed: {error}; {kill_error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
                ),
                None => panic!(
                    "ignored child test {child_test_name} wait failed: {error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
                ),
            }
        }
        Err(_) => {
            let killed_status = kill_ignored_child(&mut child).await;
            let (stdout, stderr) = collect_child_output(stdout_task, stderr_task).await;
            let timeout_ms = timeout.as_millis();
            match killed_status {
                Ok(status) => panic!(
                    "ignored child test {child_test_name} timed out after {timeout_ms}ms; killed child status: {status}\nstdout:\n{stdout}\nstderr:\n{stderr}"
                ),
                Err(error) => panic!(
                    "ignored child test {child_test_name} timed out after {timeout_ms}ms; wait after kill failed: {error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
                ),
            }
        }
    };

    let (stdout, stderr) = collect_child_output(stdout_task, stderr_task).await;
    assert!(
        status.success(),
        "ignored child test {child_test_name} failed\nstatus: {status}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stdout.contains(child_test_name),
        "ignored child test {child_test_name} did not run\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stdout.contains(&format!("{CHILD_ENV_GUARD_ACTIVE_PREFIX}{env_guard_key}")),
        "ignored child test {child_test_name} did not activate env guard {env_guard_key}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

async fn kill_ignored_child(
    child: &mut tokio::process::Child,
) -> Result<std::process::ExitStatus, String> {
    let kill_error = child.start_kill().err();
    let timeout = tokio::time::sleep(CHILD_KILL_WAIT_TIMEOUT);
    tokio::pin!(timeout);

    tokio::select! {
        biased;

        wait_result = child.wait() => {
            match wait_result {
                Ok(status) => Ok(status),
                Err(error) => Err(kill_wait_error(
                    kill_error,
                    format!("wait after kill failed: {error}"),
                )),
            }
        }
        _ = &mut timeout => {
            Err(kill_wait_error(
                kill_error,
                format!(
                    "wait after kill timed out after {}ms",
                    CHILD_KILL_WAIT_TIMEOUT.as_millis()
                ),
            ))
        }
    }
}

fn kill_wait_error(kill_error: Option<std::io::Error>, wait_error: String) -> String {
    match kill_error {
        Some(kill_error) => format!("start kill failed: {kill_error}; {wait_error}"),
        None => wait_error,
    }
}

pub(crate) fn ignored_child_test_env_guard_enabled(env_guard: (&str, &str)) -> bool {
    let (env_guard_key, env_guard_value) = env_guard;
    if std::env::var_os(env_guard_key).as_deref() != Some(OsStr::new(env_guard_value)) {
        return false;
    }

    println!("{CHILD_ENV_GUARD_ACTIVE_PREFIX}{env_guard_key}");
    true
}

async fn read_child_output<R>(mut output: R) -> io::Result<ChildOutput>
where
    R: AsyncRead + Unpin,
{
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let mut total_bytes = 0usize;
    let mut chunk = [0u8; CHILD_OUTPUT_READ_CHUNK_BYTES];

    loop {
        let read = output.read(&mut chunk).await?;
        if read == 0 {
            break;
        }

        total_bytes = total_bytes.saturating_add(read);
        let remaining = CHILD_OUTPUT_HEAD_BYTES.saturating_sub(head.len());
        let keep = remaining.min(read);
        if keep > 0 {
            head.extend_from_slice(&chunk[..keep]);
        }

        if keep < read {
            tail.extend_from_slice(&chunk[keep..read]);
            if tail.len() > CHILD_OUTPUT_TAIL_BYTES {
                tail.drain(..tail.len() - CHILD_OUTPUT_TAIL_BYTES);
            }
        }
    }

    Ok(ChildOutput {
        truncated_bytes: total_bytes.saturating_sub(head.len() + tail.len()),
        head,
        tail,
    })
}

async fn collect_child_output(
    mut stdout_task: JoinHandle<io::Result<ChildOutput>>,
    mut stderr_task: JoinHandle<io::Result<ChildOutput>>,
) -> (String, String) {
    let timeout = tokio::time::sleep(CHILD_OUTPUT_TIMEOUT);
    tokio::pin!(timeout);

    let mut stdout = None;
    let mut stderr = None;

    loop {
        tokio::select! {
            biased;

            result = &mut stdout_task, if stdout.is_none() => {
                stdout = Some(child_output("stdout", result));
            }
            result = &mut stderr_task, if stderr.is_none() => {
                stderr = Some(child_output("stderr", result));
            }
            _ = &mut timeout => {
                stdout_task.abort();
                stderr_task.abort();
                panic!(
                    "collect ignored child test output timed out after {}ms",
                    CHILD_OUTPUT_TIMEOUT.as_millis()
                );
            }
        }

        if stdout.is_some() && stderr.is_some() {
            break;
        }
    }

    let stdout = stdout.expect("stdout reader result must be set");
    let stderr = stderr.expect("stderr reader result must be set");
    (
        format_child_output("stdout", stdout),
        format_child_output("stderr", stderr),
    )
}

fn child_output(
    stream_name: &str,
    result: Result<io::Result<ChildOutput>, tokio::task::JoinError>,
) -> ChildOutput {
    match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => panic!("read ignored child test {stream_name}: {error}"),
        Err(error) => panic!("join ignored child test {stream_name} reader: {error}"),
    }
}

fn format_child_output(stream_name: &str, output: ChildOutput) -> String {
    let mut bytes = output.head;
    if output.truncated_bytes > 0 {
        bytes.extend_from_slice(
            format!(
                "\n[truncated {} bytes from ignored child test {stream_name}]\n",
                output.truncated_bytes
            )
            .as_bytes(),
        );
    }
    bytes.extend_from_slice(&output.tail);
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LARGE_SUCCESS_OUTPUT_CHILD_ENV: &str = "VM0_RUN_IGNORED_CHILD_LARGE_SUCCESS_OUTPUT_TEST";
    const LARGE_OUTPUT_CHILD_ENV: &str = "VM0_RUN_IGNORED_CHILD_LARGE_OUTPUT_TEST";
    const TIMEOUT_CHILD_ENV: &str = "VM0_RUN_IGNORED_CHILD_TIMEOUT_TEST";

    #[tokio::test]
    async fn run_ignored_child_test_preserves_tail_after_large_output() {
        run_ignored_child_test(
            "test_fixtures::tests::run_ignored_child_test_large_success_output_child",
            (LARGE_SUCCESS_OUTPUT_CHILD_ENV, "1"),
            Duration::from_secs(5),
        )
        .await;
    }

    #[test]
    #[ignore]
    fn run_ignored_child_test_large_success_output_child() {
        if !ignored_child_test_env_guard_enabled((LARGE_SUCCESS_OUTPUT_CHILD_ENV, "1")) {
            return;
        }

        write_large_ignored_child_stdout();
    }

    #[tokio::test]
    #[should_panic(expected = "[truncated ")]
    async fn run_ignored_child_test_truncates_large_output() {
        run_ignored_child_test(
            "test_fixtures::tests::run_ignored_child_test_large_output_child",
            (LARGE_OUTPUT_CHILD_ENV, "1"),
            Duration::from_secs(5),
        )
        .await;
    }

    #[test]
    #[ignore]
    fn run_ignored_child_test_large_output_child() {
        if !ignored_child_test_env_guard_enabled((LARGE_OUTPUT_CHILD_ENV, "1")) {
            return;
        }

        write_large_ignored_child_stdout();
        panic!("large output child failed intentionally");
    }

    fn write_large_ignored_child_stdout() {
        let output =
            vec![
                b'x';
                CHILD_OUTPUT_HEAD_BYTES + CHILD_OUTPUT_TAIL_BYTES + CHILD_OUTPUT_READ_CHUNK_BYTES
            ];
        std::io::Write::write_all(&mut std::io::stdout().lock(), &output)
            .expect("write large ignored child stdout");
    }

    #[tokio::test]
    #[should_panic(
        expected = "ignored child test test_fixtures::tests::run_ignored_child_test_timeout_child timed out after"
    )]
    async fn run_ignored_child_test_times_out() {
        run_ignored_child_test(
            "test_fixtures::tests::run_ignored_child_test_timeout_child",
            (TIMEOUT_CHILD_ENV, "1"),
            Duration::from_millis(10),
        )
        .await;
    }

    #[test]
    #[ignore]
    fn run_ignored_child_test_timeout_child() {
        if !ignored_child_test_env_guard_enabled((TIMEOUT_CHILD_ENV, "1")) {
            return;
        }

        std::thread::sleep(Duration::from_secs(60));
    }
}
