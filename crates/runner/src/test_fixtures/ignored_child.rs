use std::ffi::OsStr;
use std::io;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

const CHILD_OUTPUT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_OUTPUT_HEAD_BYTES: usize = 8 * 1024;
const CHILD_OUTPUT_TAIL_BYTES: usize = 8 * 1024;
const CHILD_OUTPUT_READ_CHUNK_BYTES: usize = 8 * 1024;
const CHILD_ENV_GUARD_ACTIVE_PREFIX: &str = "vm0 ignored child env guard active: ";

struct ChildOutput {
    head: Vec<u8>,
    tail: Vec<u8>,
    truncated_bytes: usize,
}

pub(crate) async fn run_ignored_child_test(
    child_test_name: &str,
    env_guard: (&str, &str),
    child_env: &[(&str, Option<&str>)],
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
    for &(key, value) in child_env {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
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
            "test_fixtures::ignored_child::tests::run_ignored_child_test_large_success_output_child",
            (LARGE_SUCCESS_OUTPUT_CHILD_ENV, "1"),
            &[],
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
            "test_fixtures::ignored_child::tests::run_ignored_child_test_large_output_child",
            (LARGE_OUTPUT_CHILD_ENV, "1"),
            &[],
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
        expected = "ignored child test test_fixtures::ignored_child::tests::run_ignored_child_test_timeout_child timed out after"
    )]
    async fn run_ignored_child_test_times_out() {
        run_ignored_child_test(
            "test_fixtures::ignored_child::tests::run_ignored_child_test_timeout_child",
            (TIMEOUT_CHILD_ENV, "1"),
            &[],
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
