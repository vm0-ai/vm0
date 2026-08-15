use chrono::DateTime;
use guest_common::log::{clear_system_log_file, emit, set_system_log_file};
use std::io::{Read as _, Seek as _};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const CHILD_TEST_NAME: &str = "system_log_append_failure_preserves_stderr_child";
const CHILD_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);
const APPEND_FAILURE_MARKER: &str = "] [WARN] [sandbox:guest-common] failed to append system log:";
const ORIGINAL_LINE_MARKER: &str = "] [WARN] [sandbox:guest-agent] system log path is not writable";

#[test]
fn system_log_append_failure_preserves_stderr() {
    let mut captured_stderr = tempfile::tempfile().expect("create child stderr capture");
    let mut command = Command::new(std::env::current_exe().expect("resolve current test binary"));
    command
        .arg("--exact")
        .arg(CHILD_TEST_NAME)
        .arg("--ignored")
        .arg("--nocapture")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            captured_stderr
                .try_clone()
                .expect("clone child stderr capture"),
        ));

    let child = command.spawn().expect("spawn isolated logging test");
    let status = wait_for_child(child, CHILD_TIMEOUT);

    captured_stderr
        .rewind()
        .expect("rewind child stderr capture");
    let mut stderr = String::new();
    captured_stderr
        .read_to_string(&mut stderr)
        .expect("read child stderr capture");

    let status = status.unwrap_or_else(|error| {
        panic!("isolated logging test did not complete: {error}\nstderr:\n{stderr}")
    });
    assert!(
        status.success(),
        "isolated logging test failed with {status}\nstderr:\n{stderr}",
    );

    let failure_line = only_matching_line(&stderr, "append-failure warning", |line| {
        line.contains(APPEND_FAILURE_MARKER)
    })
    .expect("find append-failure warning");
    assert_complete_structured_line(&stderr, failure_line, APPEND_FAILURE_MARKER)
        .expect("validate append-failure warning");

    let original_line = only_matching_line(&stderr, "original structured log", |line| {
        line.ends_with(ORIGINAL_LINE_MARKER)
    })
    .expect("find original structured log");
    assert_complete_structured_line(&stderr, original_line, ORIGINAL_LINE_MARKER)
        .expect("validate original structured log");
}

#[test]
#[ignore = "run through the process-isolated parent test"]
fn system_log_append_failure_preserves_stderr_child() {
    let dir = tempfile::tempdir().expect("create invalid system-log fixture");
    let parent = dir.path().join("parent-file");
    std::fs::write(&parent, "not a directory").expect("create system-log parent file");
    let path = parent.join("system.log");

    set_system_log_file(&path);
    emit(
        "WARN",
        "sandbox:guest-agent",
        format_args!("system log path is not writable"),
    );
    clear_system_log_file();

    assert!(
        !path.exists(),
        "test setup expected the system-log append to fail",
    );
}

fn wait_for_child(mut child: Child, timeout: Duration) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                let cleanup = terminate_and_reap(child);
                return Err(format!(
                    "failed to observe child completion: {error}; cleanup: {cleanup}"
                ));
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let cleanup = terminate_and_reap(child);
            return Err(format!("timed out after {timeout:?}; cleanup: {cleanup}"));
        }
        std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
    }
}

fn terminate_and_reap(mut child: Child) -> String {
    let kill = match child.kill() {
        Ok(()) => "signal sent".to_owned(),
        Err(error) => format!("failed: {error}"),
    };
    let (status_tx, status_rx) = mpsc::channel();
    let reaper = std::thread::spawn(move || {
        let _ = status_tx.send(child.wait());
    });
    let reap = match status_rx.recv_timeout(CHILD_REAP_TIMEOUT) {
        Ok(Ok(status)) => match reaper.join() {
            Ok(()) => format!("completed with {status}"),
            Err(_) => "reaper panicked after reporting child status".to_owned(),
        },
        Ok(Err(error)) => {
            drop(reaper);
            format!("wait failed: {error}")
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            drop(reaper);
            format!("timed out after {CHILD_REAP_TIMEOUT:?}")
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            drop(reaper);
            "reaper exited without a child status".to_owned()
        }
    };
    format!("kill={kill}, reap={reap}")
}

fn only_matching_line<'a>(
    output: &'a str,
    description: &str,
    mut predicate: impl FnMut(&str) -> bool,
) -> Result<&'a str, String> {
    let mut matches = output.lines().filter(|line| predicate(line));
    let line = matches
        .next()
        .ok_or_else(|| format!("missing {description} in stderr: {output:?}"))?;
    if matches.next().is_some() {
        return Err(format!(
            "found multiple {description} lines in stderr: {output:?}"
        ));
    }
    Ok(line)
}

fn assert_complete_structured_line(output: &str, line: &str, marker: &str) -> Result<(), String> {
    let (timestamp_prefix, _) = line
        .split_once(marker)
        .ok_or_else(|| format!("line omitted expected marker {marker:?}: {line:?}"))?;
    let timestamp = timestamp_prefix
        .strip_prefix('[')
        .ok_or_else(|| format!("structured line omitted timestamp prefix: {line:?}"))?;
    DateTime::parse_from_rfc3339(timestamp).map_err(|error| {
        format!("structured line has invalid timestamp {timestamp:?}: {line:?}: {error}")
    })?;
    if !output.contains(&format!("{line}\n")) {
        return Err(format!(
            "structured line was not newline-terminated: {line:?}"
        ));
    }
    Ok(())
}
