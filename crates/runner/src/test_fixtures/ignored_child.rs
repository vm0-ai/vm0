use std::ffi::OsStr;
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

#[cfg(target_os = "linux")]
use crate::process::{ProcessStatRead, process_stat_is_live, read_process_stat_checked};

const CHILD_OUTPUT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_READINESS_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "linux")]
const CHILD_SESSION_SCAN_INTERVAL: Duration = Duration::from_millis(10);
const CHILD_OUTPUT_HEAD_BYTES: usize = 8 * 1024;
const CHILD_OUTPUT_TAIL_BYTES: usize = 8 * 1024;
const CHILD_OUTPUT_READ_CHUNK_BYTES: usize = 8 * 1024;
const CHILD_ENV_GUARD_ACTIVE_PREFIX: &str = "vm0 ignored child env guard active: ";

struct ChildOutput {
    head: Vec<u8>,
    tail: Vec<u8>,
    truncated_bytes: usize,
}

struct IgnoredChildSession {
    #[cfg(target_os = "linux")]
    session_id: libc::pid_t,
}

#[cfg(target_os = "linux")]
struct SessionMember {
    pid: libc::pid_t,
    pidfd: OwnedFd,
}

#[cfg(target_os = "linux")]
struct SessionScan {
    live_pids: Vec<libc::pid_t>,
    members: Vec<SessionMember>,
    error: Option<String>,
}

impl IgnoredChildSession {
    fn configure_command(command: &mut tokio::process::Command) {
        #[cfg(target_os = "linux")]
        // SAFETY: `setsid` is async-signal-safe and the closure performs no
        // work beyond that syscall and converting its errno on failure.
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid()
                    .map(drop)
                    .map_err(std::io::Error::from)
            });
        }
        #[cfg(not(target_os = "linux"))]
        let _ = command;
    }

    fn from_child(child: &tokio::process::Child) -> Self {
        #[cfg(target_os = "linux")]
        {
            let child_pid = child.id().expect("ignored child PID must be available");
            let session_id =
                libc::pid_t::try_from(child_pid).expect("ignored child PID must fit in pid_t");
            Self { session_id }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = child;
            Self {}
        }
    }

    async fn kill_members(&self, deadline: tokio::time::Instant) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            kill_session_members(self.session_id, deadline).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = deadline;
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
async fn kill_session_members(
    session_id: libc::pid_t,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let mut first_error = None;

    loop {
        let scan = match tokio::time::timeout_at(deadline, scan_session_members(session_id)).await {
            Ok(Ok(scan)) => scan,
            Ok(Err(error)) => {
                return Err(match first_error {
                    Some(first_error) => format!("{first_error}; {error}"),
                    None => error,
                });
            }
            Err(_) => {
                let timeout = format!(
                    "session {session_id} scan timed out after {}ms",
                    CHILD_KILL_WAIT_TIMEOUT.as_millis()
                );
                return Err(match first_error {
                    Some(first_error) => format!("{first_error}; {timeout}"),
                    None => timeout,
                });
            }
        };
        if first_error.is_none() {
            first_error = scan.error;
        }
        if scan.live_pids.is_empty() {
            return match first_error {
                Some(error) => Err(error),
                None => Ok(()),
            };
        }

        for member in scan.members {
            if let Err(error) = signal_pidfd(&member.pidfd, libc::SIGKILL)
                && error.raw_os_error() != Some(libc::ESRCH)
                && first_error.is_none()
            {
                first_error = Some(format!(
                    "pidfd signal failed for session {session_id} member {}: {error}",
                    member.pid
                ));
            }
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let live_pids = scan
                .live_pids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let timeout = format!(
                "session {session_id} remained live after {}ms (pids: {live_pids})",
                CHILD_KILL_WAIT_TIMEOUT.as_millis()
            );
            return Err(match first_error {
                Some(error) => format!("{error}; {timeout}"),
                None => timeout,
            });
        }
        tokio::time::sleep(remaining.min(CHILD_SESSION_SCAN_INTERVAL)).await;
    }
}

#[cfg(target_os = "linux")]
async fn scan_session_members(session_id: libc::pid_t) -> Result<SessionScan, String> {
    let mut entries = tokio::fs::read_dir("/proc")
        .await
        .map_err(|error| format!("read /proc for session {session_id}: {error}"))?;
    let mut live_pids = Vec::new();
    let mut members = Vec::new();
    let mut first_error = None;

    loop {
        let entry = entries
            .next_entry()
            .await
            .map_err(|error| format!("iterate /proc for session {session_id}: {error}"))?;
        let Some(entry) = entry else {
            break;
        };
        let Some(pid_text) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let Ok(raw_pid) = libc::pid_t::try_from(pid) else {
            continue;
        };

        let before = match read_process_stat_checked(pid).await {
            ProcessStatRead::Found(stat) if process_stat_is_live(&stat) => stat,
            ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
            ProcessStatRead::Unreadable(error) => {
                record_owned_stat_error(
                    raw_pid,
                    session_id,
                    format!("read /proc/{pid}/stat: {error}"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
            ProcessStatRead::Invalid => {
                record_owned_stat_error(
                    raw_pid,
                    session_id,
                    format!("parse /proc/{pid}/stat"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
        };
        if process_session_id(raw_pid) != Ok(session_id) {
            continue;
        }

        let pidfd = match open_pidfd(raw_pid) {
            Ok(Some(pidfd)) => pidfd,
            Ok(None) => continue,
            Err(error) => {
                live_pids.push(raw_pid);
                if first_error.is_none() {
                    first_error = Some(format!(
                        "pidfd_open failed for session {session_id} member {raw_pid}: {error}"
                    ));
                }
                continue;
            }
        };

        match read_process_stat_checked(pid).await {
            ProcessStatRead::Found(stat)
                if process_stat_is_live(&stat) && stat.starttime == before.starttime => {}
            ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
            ProcessStatRead::Unreadable(error) => {
                record_owned_stat_error(
                    raw_pid,
                    session_id,
                    format!("re-read /proc/{pid}/stat: {error}"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
            ProcessStatRead::Invalid => {
                record_owned_stat_error(
                    raw_pid,
                    session_id,
                    format!("re-parse /proc/{pid}/stat"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
        }
        if process_session_id(raw_pid) != Ok(session_id) {
            continue;
        }

        live_pids.push(raw_pid);
        members.push(SessionMember {
            pid: raw_pid,
            pidfd,
        });
    }

    Ok(SessionScan {
        live_pids,
        members,
        error: first_error,
    })
}

#[cfg(target_os = "linux")]
fn record_owned_stat_error(
    pid: libc::pid_t,
    session_id: libc::pid_t,
    error: String,
    live_pids: &mut Vec<libc::pid_t>,
    first_error: &mut Option<String>,
) {
    if process_session_id(pid) != Ok(session_id) {
        return;
    }
    live_pids.push(pid);
    if first_error.is_none() {
        *first_error = Some(format!(
            "session {session_id} member {pid} process state unavailable: {error}"
        ));
    }
}

#[cfg(target_os = "linux")]
fn process_session_id(pid: libc::pid_t) -> Result<libc::pid_t, nix::errno::Errno> {
    nix::unistd::getsid(Some(nix::unistd::Pid::from_raw(pid))).map(nix::unistd::Pid::as_raw)
}

#[cfg(target_os = "linux")]
fn open_pidfd(pid: libc::pid_t) -> io::Result<Option<OwnedFd>> {
    // SAFETY: `pidfd_open` does not dereference user pointers and `pid` came
    // from the kernel-owned `/proc` directory.
    let result = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error);
    }
    let fd = RawFd::try_from(result)
        .map_err(|_| io::Error::other("pidfd_open returned an invalid file descriptor"))?;
    // SAFETY: `fd` is a new descriptor returned by `pidfd_open`.
    Ok(Some(unsafe { OwnedFd::from_raw_fd(fd) }))
}

#[cfg(target_os = "linux")]
fn signal_pidfd(pidfd: &OwnedFd, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: `pidfd` is valid, `signal` is a standard signal, and a null
    // siginfo pointer requests ordinary signal semantics.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(crate) async fn run_ignored_child_test(
    child_test_name: &str,
    env_guard: (&str, &str),
    child_env: &[(&str, Option<&str>)],
    timeout: Duration,
) {
    run_ignored_child_test_with_readiness(child_test_name, env_guard, child_env, timeout, None)
        .await;
}

async fn run_ignored_child_test_with_readiness(
    child_test_name: &str,
    env_guard: (&str, &str),
    child_env: &[(&str, Option<&str>)],
    timeout: Duration,
    readiness_path: Option<&Path>,
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
    IgnoredChildSession::configure_command(&mut command);
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
    let child_session = IgnoredChildSession::from_child(&child);
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

    if let Some(readiness_path) = readiness_path
        && let Err(error) = wait_for_child_readiness(readiness_path).await
    {
        let cleanup = kill_ignored_child(&mut child, &child_session).await;
        let (stdout, stderr) = collect_child_output(stdout_task, stderr_task).await;
        panic!(
            "ignored child test {child_test_name} readiness failed: {error}; cleanup result: {cleanup:?}\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
    }

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let kill_error = kill_ignored_child(&mut child, &child_session).await.err();
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
            let killed_status = kill_ignored_child(&mut child, &child_session).await;
            let (stdout, stderr) = collect_child_output(stdout_task, stderr_task).await;
            let timeout_ms = timeout.as_millis();
            match killed_status {
                Ok(status) => panic!(
                    "ignored child test {child_test_name} timed out after {timeout_ms}ms; killed child status: {status}\nstdout:\n{stdout}\nstderr:\n{stderr}"
                ),
                Err(error) => panic!(
                    "ignored child test {child_test_name} timed out after {timeout_ms}ms; cleanup after kill failed: {error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
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
    child_session: &IgnoredChildSession,
) -> Result<std::process::ExitStatus, String> {
    let kill_error = child.start_kill().err();
    let deadline = tokio::time::Instant::now() + CHILD_KILL_WAIT_TIMEOUT;
    let session_error = child_session.kill_members(deadline).await.err();
    let wait_result = wait_for_child_until(child, deadline).await;

    match (session_error, wait_result) {
        (None, Ok(status)) => Ok(status),
        (Some(session_error), Ok(status)) => Err(cleanup_error(
            kill_error,
            Some(session_error),
            format!("killed child status: {status}"),
        )),
        (session_error, Err(wait_error)) => {
            Err(cleanup_error(kill_error, session_error, wait_error))
        }
    }
}

async fn wait_for_child_until(
    child: &mut tokio::process::Child,
    deadline: tokio::time::Instant,
) -> Result<std::process::ExitStatus, String> {
    match child.try_wait() {
        Ok(Some(status)) => return Ok(status),
        Ok(None) => {}
        Err(error) => return Err(format!("wait after kill failed: {error}")),
    }

    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(format!("wait after kill failed: {error}")),
        Err(_) => Err(format!(
            "wait after kill timed out after {}ms",
            CHILD_KILL_WAIT_TIMEOUT.as_millis()
        )),
    }
}

fn cleanup_error(
    kill_error: Option<io::Error>,
    session_error: Option<String>,
    wait_result: String,
) -> String {
    let mut errors = Vec::new();
    if let Some(kill_error) = kill_error {
        errors.push(format!("start kill failed: {kill_error}"));
    }
    if let Some(session_error) = session_error {
        errors.push(format!("session cleanup failed: {session_error}"));
    }
    errors.push(wait_result);
    errors.join("; ")
}

async fn wait_for_child_readiness(path: &Path) -> Result<(), String> {
    let readiness = async {
        loop {
            match tokio::fs::read(path).await {
                Ok(contents) if contents.ends_with(b"\n") => return Ok(()),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("read {}: {error}", path.display())),
            }
            tokio::task::yield_now().await;
        }
    };

    tokio::time::timeout(CHILD_READINESS_TIMEOUT, readiness)
        .await
        .map_err(|_| {
            format!(
                "timed out after {}ms waiting for {}",
                CHILD_READINESS_TIMEOUT.as_millis(),
                path.display()
            )
        })?
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
    #[cfg(target_os = "linux")]
    use std::os::unix::process::CommandExt as _;

    use super::*;

    const LARGE_SUCCESS_OUTPUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_LARGE_SUCCESS_OUTPUT_TEST";
    const LARGE_OUTPUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_LARGE_OUTPUT_TEST";
    const TIMEOUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_TIMEOUT_TEST";

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

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn run_ignored_child_test_timeout_kills_separate_process_group_descendant() {
        let dir = tempfile::tempdir().unwrap();
        let readiness_path = dir.path().join("descendant-ready");
        let task_readiness_path = readiness_path.clone();
        let readiness_value = task_readiness_path
            .to_str()
            .expect("temporary readiness path must be UTF-8")
            .to_owned();
        let child_test_name =
            "test_fixtures::ignored_child::tests::run_ignored_child_test_timeout_child";

        let task = tokio::spawn(async move {
            run_ignored_child_test_with_readiness(
                child_test_name,
                (TIMEOUT_CHILD_ENV, &readiness_value),
                &[],
                Duration::from_millis(10),
                Some(&task_readiness_path),
            )
            .await;
        });

        let panic = task
            .await
            .expect_err("timed out ignored child must panic")
            .into_panic();
        let panic_message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .expect("ignored child panic must contain a string message");
        assert!(
            panic_message.contains(&format!(
                "ignored child test {child_test_name} timed out after"
            )),
            "unexpected ignored child panic: {panic_message}"
        );
        assert!(
            panic_message.contains("killed child status:"),
            "ignored child cleanup did not complete successfully: {panic_message}"
        );

        let identity = read_descendant_identity(&readiness_path);
        assert_eq!(identity.pgid, identity.pid);
        match read_process_stat_checked(identity.pid).await {
            ProcessStatRead::Found(stat) => assert!(
                stat.starttime != identity.starttime || !process_stat_is_live(&stat),
                "separate-process-group descendant {} remained live after fixture timeout",
                identity.pid
            ),
            ProcessStatRead::Missing => {}
            ProcessStatRead::Unreadable(error) => {
                panic!(
                    "could not verify separate-process-group descendant {} cleanup: {error}",
                    identity.pid
                );
            }
            ProcessStatRead::Invalid => {
                panic!(
                    "could not parse separate-process-group descendant {} state after cleanup",
                    identity.pid
                );
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn run_ignored_child_test_timeout_child() {
        let Ok(readiness_path) = std::env::var(TIMEOUT_CHILD_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((TIMEOUT_CHILD_ENV, &readiness_path)) {
            return;
        }

        let mut command = std::process::Command::new("sleep");
        command
            .arg("60")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut descendant = command.spawn().expect("spawn timeout descendant");
        let pid = descendant.id();
        let ProcessStatRead::Found(stat) = crate::process::read_process_stat_checked_blocking(pid)
        else {
            panic!("timeout descendant process stat must be readable");
        };
        assert!(process_stat_is_live(&stat));
        assert_eq!(stat.pgid, pid);
        let child_session = nix::unistd::getsid(None).expect("read ignored child session");
        let descendant_session = nix::unistd::getsid(Some(nix::unistd::Pid::from_raw(
            libc::pid_t::try_from(pid).expect("timeout descendant PID must fit in pid_t"),
        )))
        .expect("read timeout descendant session");
        assert_eq!(descendant_session, child_session);
        std::fs::write(
            &readiness_path,
            format!("{pid} {} {}\n", stat.pgid, stat.starttime),
        )
        .expect("write timeout descendant readiness");

        std::thread::sleep(Duration::from_secs(60));
        descendant.kill().expect("kill timeout descendant");
        descendant.wait().expect("reap timeout descendant");
    }

    #[cfg(target_os = "linux")]
    struct DescendantIdentity {
        pid: u32,
        pgid: u32,
        starttime: u64,
    }

    #[cfg(target_os = "linux")]
    fn read_descendant_identity(path: &Path) -> DescendantIdentity {
        let contents = std::fs::read_to_string(path).expect("read timeout descendant readiness");
        let mut fields = contents.split_whitespace();
        let pid = fields
            .next()
            .expect("timeout descendant readiness must contain PID")
            .parse()
            .expect("timeout descendant PID must be valid");
        let pgid = fields
            .next()
            .expect("timeout descendant readiness must contain PGID")
            .parse()
            .expect("timeout descendant PGID must be valid");
        let starttime = fields
            .next()
            .expect("timeout descendant readiness must contain start time")
            .parse()
            .expect("timeout descendant start time must be valid");
        assert_eq!(fields.next(), None);
        DescendantIdentity {
            pid,
            pgid,
            starttime,
        }
    }
}
