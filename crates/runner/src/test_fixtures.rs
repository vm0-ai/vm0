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

pub(crate) struct OneShotSessionHistoryServer {
    url: String,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl OneShotSessionHistoryServer {
    pub(crate) async fn respond_once(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
    ) -> Self {
        Self::spawn(status, body, content_length, None, None).await
    }

    pub(crate) async fn respond_once_after_request(
        body: impl Into<Vec<u8>> + Send + 'static,
        request_received: oneshot::Sender<()>,
        release_response: Arc<Notify>,
    ) -> Self {
        let body = body.into();
        let content_length = Some(body.len() as u64);
        Self::spawn(
            "200 OK",
            body,
            content_length,
            Some(request_received),
            Some(release_response),
        )
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

    async fn spawn(
        status: impl Into<String>,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
        request_received: Option<oneshot::Sender<()>>,
        release_response: Option<Arc<Notify>>,
    ) -> Self {
        let body = body.into();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(serve_session_history_once(
            listener,
            status.into(),
            body,
            content_length,
            request_received,
            release_response,
        ));

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
    status: String,
    body: Vec<u8>,
    content_length: Option<u64>,
    request_received: Option<oneshot::Sender<()>>,
    release_response: Option<Arc<Notify>>,
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

    if let Some(request_received) = request_received {
        let _ = request_received.send(());
    }
    if let Some(release_response) = release_response {
        release_response.notified().await;
    }

    let content_length_header = content_length
        .map(|content_length| format!("Content-Length: {content_length}\r\n"))
        .unwrap_or_default();
    let response = format!("HTTP/1.1 {status}\r\n{content_length_header}Connection: close\r\n\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.write_all(&body).await?;
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
        debug_no_mock_claude: None,
        debug_no_mock_codex: None,
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
    }
}

pub(crate) async fn run_ignored_child_test(
    child_test_name: &str,
    env: &[(&str, &str)],
    timeout: Duration,
) {
    assert!(
        !child_test_name.is_empty(),
        "ignored child test name must not be empty"
    );
    assert!(!env.is_empty(), "ignored child test must have an env guard");
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
    for (key, value) in env {
        command.env(key, value);
    }

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
            let _ = child.start_kill();
            let _ = child.wait().await;
            let (stdout, stderr) = collect_child_output(stdout_task, stderr_task).await;
            panic!(
                "ignored child test {child_test_name} wait failed: {error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
            );
        }
        Err(_) => {
            let _ = child.start_kill();
            let killed_status = child.wait().await;
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
}

async fn read_child_output<R>(mut output: R) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    output.read_to_end(&mut buffer).await?;
    Ok(buffer)
}

async fn collect_child_output(
    mut stdout_task: JoinHandle<io::Result<Vec<u8>>>,
    mut stderr_task: JoinHandle<io::Result<Vec<u8>>>,
) -> (String, String) {
    let timeout = tokio::time::sleep(CHILD_OUTPUT_TIMEOUT);
    tokio::pin!(timeout);

    let mut stdout = None;
    let mut stderr = None;

    loop {
        tokio::select! {
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
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    )
}

fn child_output(
    stream_name: &str,
    result: Result<io::Result<Vec<u8>>, tokio::task::JoinError>,
) -> Vec<u8> {
    match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => panic!("read ignored child test {stream_name}: {error}"),
        Err(error) => panic!("join ignored child test {stream_name} reader: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT_CHILD_ENV: &str = "VM0_RUN_IGNORED_CHILD_TIMEOUT_TEST";

    #[tokio::test]
    #[should_panic(expected = "timed out")]
    async fn run_ignored_child_test_times_out() {
        run_ignored_child_test(
            "test_fixtures::tests::run_ignored_child_test_timeout_child",
            &[(TIMEOUT_CHILD_ENV, "1")],
            Duration::from_millis(10),
        )
        .await;
    }

    #[test]
    #[ignore]
    fn run_ignored_child_test_timeout_child() {
        if std::env::var_os(TIMEOUT_CHILD_ENV).is_none() {
            return;
        }

        std::thread::sleep(Duration::from_secs(60));
    }
}
