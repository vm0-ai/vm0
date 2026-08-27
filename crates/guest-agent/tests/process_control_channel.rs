//! Integration coverage for the guest-agent process-control channel.
//!
//! Lower-level protocol status mapping, nonce validation, queue limits, and
//! concurrent routing live in vsock-host/vsock-guest tests. This test keeps the
//! guest-agent layer focused on the real bootstrap path: host vsock -> spawned
//! guest-agent process -> ControlHandle IPC -> host ack.

mod common;

use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use shell_quote::quote_shell_arg;
use tokio::io::unix::AsyncFd;
use vsock_host::{ExecOwnedCapturedOutput, SupervisedExecControl, SupervisedExecRequest};
use vsock_proto::{ExecOutputPolicy, ExecOutputStream, ExecTermination, ExecTimeoutPolicy};

const PRE_READY_CONTROL_MESSAGE_ID: &str = "process-control-before-cli-ready";
const READY_CONTROL_MESSAGE_ID: &str = "process-control-after-cli-ready";

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

struct MockStartGate {
    writer: File,
}

struct ConnectionHarness {
    host: Option<vsock_host::VsockHost>,
    guest: Option<thread::JoinHandle<io::Result<()>>>,
}

impl MockStartGate {
    fn create(dir: &Path, mock: &Path) -> TestResult<(Self, PathBuf)> {
        let fifo = dir.join("mock-start.fifo");
        let c_fifo = std::ffi::CString::new(fifo.as_os_str().as_bytes())?;
        // SAFETY: c_fifo is a valid NUL-terminated path and the mode is a
        // normal POSIX permission mask for a test-only FIFO.
        if unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) } != 0 {
            return Err(io::Error::last_os_error().into());
        }

        // Keep both FIFO ends open so the wrapper can block on its read even
        // when the test releases it before the wrapper reaches that read.
        // SAFETY: c_fifo remains valid for the call and ownership of the
        // returned descriptor transfers to File below.
        let fd = unsafe {
            libc::open(
                c_fifo.as_ptr(),
                libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: fd is a freshly opened descriptor owned by this function.
        let writer = unsafe { File::from_raw_fd(fd) };

        let wrapper = dir.join("gated-mock-claude.sh");
        let script = format!(
            "#!/bin/sh\nIFS= read -r _ < {}\nexec {} \"$@\"\n",
            quote_shell_arg(&fifo.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        );
        std::fs::write(&wrapper, script)?;
        let mut permissions = std::fs::metadata(&wrapper)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&wrapper, permissions)?;

        Ok((Self { writer }, wrapper))
    }

    fn release(&mut self) -> io::Result<()> {
        self.writer.write_all(b"start\n")
    }
}

impl ConnectionHarness {
    fn new(host: vsock_host::VsockHost, guest: thread::JoinHandle<io::Result<()>>) -> Self {
        Self {
            host: Some(host),
            guest: Some(guest),
        }
    }

    #[allow(clippy::expect_used)]
    fn host(&self) -> &vsock_host::VsockHost {
        self.host
            .as_ref()
            .expect("connection harness host should be present")
    }

    fn finish(mut self) -> TestResult<()> {
        drop(self.host.take());
        if let Some(guest) = self.guest.take() {
            join_guest(guest)?;
        }
        Ok(())
    }
}

impl Drop for ConnectionHarness {
    fn drop(&mut self) {
        drop(self.host.take());
        if let Some(guest) = self.guest.take() {
            let _ = join_guest(guest);
        }
    }
}

#[tokio::test]
async fn process_control_channel_reaches_guest_agent() -> TestResult<()> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let (mut mock_start_gate, gated_mock) = MockStartGate::create(tmp.path(), &mock)?;
    let run_id = format!(
        "process-control-channel-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );

    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let prompt = "@active-input-smoke:2";
    let workdir = tmp.path().to_string_lossy().into_owned();
    let mock_path = gated_mock.to_string_lossy().into_owned();
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), &run_id)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: prompt.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let run_payload_path = run_payload_path.to_string_lossy().into_owned();
    let env = [
        ("CLI_AGENT_TYPE", "claude-code"),
        (
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_path.as_str(),
        ),
        ("USE_MOCK_CLAUDE", "true"),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "1",
        ),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        ),
        (guest_contracts::env::RUN_ID_ENV, run_id.as_str()),
        (
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            run_payload_path.as_str(),
        ),
        ("VM0_API_BACKEND_URL", "http://127.0.0.1:1"),
        ("VM0_API_TOKEN", ""),
        (
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        ),
        (
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        ),
        ("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true"),
        ("HOME", workdir.as_str()),
    ];

    common::ensure_canonical_workspace_for_test()?;
    let connection = start_host_and_guest(tmp.path()).await?;
    let command = canonical_process_control_guest_agent_wrapper_command(guest_agent);
    let sudo = needs_sudo_for_canonical_workspace();
    let mut handle = connection
        .host()
        .start_supervised_exec(SupervisedExecRequest {
            role: vsock_proto::ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 30_000 },
            command: &command,
            env: &env,
            sudo,
            label: "guest-agent-process-control-channel",
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 1024 * 1024,
                chunk_limit_bytes: 8192,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: 1024 * 1024,
            },
            expected_exit_codes: &[],
            stdin_bytes: None,
            control: SupervisedExecControl::Enabled { sink: true },
            stream_queue_capacity: None,
            start_timeout: Duration::from_secs(10),
        })
        .await?;
    let mut stdout_rx = handle
        .take_stream_receiver()
        .ok_or("supervised exec should expose stdout stream")?;

    let pre_ready_payload = guest_contracts::active_input::encode_active_input(
        "1e208848-53bc-440a-85d8-adcd048e167c",
        "before-ready",
    )?;
    let pre_ready_ack = handle
        .control(
            PRE_READY_CONTROL_MESSAGE_ID,
            &pre_ready_payload,
            Duration::from_secs(10),
        )
        .await?;

    mock_start_gate.release()?;
    let mut stdout = collect_stdout_until(
        &mut stdout_rx,
        b"READY_FOR_ACTIVE_INPUT",
        Duration::from_secs(10),
    )
    .await?;

    let ready_payload = guest_contracts::active_input::encode_active_input(
        "e6c121e3-9a6f-4835-87c0-a31b042f3008",
        "after-ready",
    )?;
    let ack = handle
        .control(
            READY_CONTROL_MESSAGE_ID,
            &ready_payload,
            Duration::from_secs(10),
        )
        .await?;

    let exit = handle.wait(Duration::from_secs(20)).await?;
    stdout.extend(collect_stdout(&mut stdout_rx, Duration::from_secs(5)).await?);

    connection.finish()?;

    assert_eq!(pre_ready_ack.message_id, PRE_READY_CONTROL_MESSAGE_ID);
    assert_eq!(ack.message_id, READY_CONTROL_MESSAGE_ID);
    assert!(
        matches!(exit.termination, ExecTermination::Exited { exit_code: 0 }),
        "guest-agent failed: termination={:?} diagnostic={} stderr={}",
        exit.termination,
        exit.diagnostic,
        captured_output_lossy(&exit.stderr)
    );
    assert!(
        String::from_utf8_lossy(&stdout).contains("RESULT=before-ready+after-ready"),
        "guest-agent stdout did not include active-input result: {}",
        String::from_utf8_lossy(&stdout)
    );

    Ok(())
}

#[tokio::test]
async fn process_control_enabled_plain_run_does_not_wait_for_stdin_eof() -> TestResult<()> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let run_id = format!(
        "process-control-plain-run-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );

    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let prompt = "printf no-active-input";
    let workdir = tmp.path().to_string_lossy().into_owned();
    let mock_path = mock.to_string_lossy().into_owned();
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), &run_id)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: prompt.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let run_payload_path = run_payload_path.to_string_lossy().into_owned();
    let env = [
        ("CLI_AGENT_TYPE", "claude-code"),
        (
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_path.as_str(),
        ),
        ("USE_MOCK_CLAUDE", "true"),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "1",
        ),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        ),
        (guest_contracts::env::RUN_ID_ENV, run_id.as_str()),
        (
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            run_payload_path.as_str(),
        ),
        ("VM0_API_BACKEND_URL", "http://127.0.0.1:1"),
        ("VM0_API_TOKEN", ""),
        (
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        ),
        (
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        ),
        ("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true"),
        ("HOME", workdir.as_str()),
    ];

    common::ensure_canonical_workspace_for_test()?;
    let connection = start_host_and_guest(tmp.path()).await?;
    let command = guest_agent_wrapper_command(guest_agent);
    let sudo = needs_sudo_for_canonical_workspace();
    let handle = connection
        .host()
        .start_supervised_exec(SupervisedExecRequest {
            role: vsock_proto::ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 30_000 },
            command: &command,
            env: &env,
            sudo,
            label: "guest-agent-process-control-plain-run",
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: 1024 * 1024,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: 1024 * 1024,
            },
            expected_exit_codes: &[],
            stdin_bytes: None,
            control: SupervisedExecControl::Enabled { sink: true },
            stream_queue_capacity: None,
            start_timeout: Duration::from_secs(10),
        })
        .await?;

    let exit = handle.wait(Duration::from_secs(20)).await?;

    connection.finish()?;

    let stdout = captured_output_lossy(&exit.stdout);
    assert!(
        matches!(exit.termination, ExecTermination::Exited { exit_code: 0 }),
        "guest-agent failed: termination={:?} diagnostic={} stdout={} stderr={}",
        exit.termination,
        exit.diagnostic,
        stdout,
        captured_output_lossy(&exit.stderr)
    );
    assert!(
        stdout.contains("no-active-input"),
        "guest-agent stdout did not include plain run result: {stdout}"
    );

    Ok(())
}

async fn collect_stdout_until(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<vsock_host::ExecOutputEvent>,
    needle: &[u8],
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stdout = Vec::new();
        while let Some(event) = stdout_rx.recv().await {
            if event.stream == ExecOutputStream::Stdout && !event.truncated {
                stdout.extend_from_slice(&event.chunk);
                if stdout.windows(needle.len()).any(|window| window == needle) {
                    return Ok(stdout);
                }
            }
        }
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "stdout closed before expected marker",
        ))
    })
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "timed out waiting for stdout marker",
        )
    })?
}

async fn start_host_and_guest(dir: &Path) -> TestResult<ConnectionHarness> {
    let base_path = dir.join("vsock").to_string_lossy().to_string();
    let listener_path = format!("{base_path}_1000");
    let listener = PathBuf::from(&listener_path);
    let host_base_path = base_path.clone();
    let mut host_task = tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&host_base_path, Duration::from_secs(5)).await
    });

    let listener_ready: io::Result<()> = tokio::select! {
        ready = wait_for_path(&listener, Duration::from_secs(5)) => ready,
        completed = &mut host_task => {
            match completed {
                Ok(Ok(host)) => {
                    drop(host);
                    Err(io::Error::other("host accepted a guest before the test started one"))
                }
                Ok(Err(error)) => Err(error),
                Err(error) => Err(io::Error::other(format!("host listener task failed: {error}"))),
            }
        }
    };
    if let Err(error) = listener_ready {
        host_task.abort();
        let _ = host_task.await;
        return Err(error.into());
    }

    let guest = thread::spawn(move || {
        let stream = vsock_guest::connect_unix(&listener_path)?;
        vsock_guest::handle_connection(stream)
    });

    let host = match host_task.await? {
        Ok(host) => host,
        Err(error) => {
            let _ = join_guest(guest);
            return Err(error.into());
        }
    };
    Ok(ConnectionHarness::new(host, guest))
}

async fn collect_stdout(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<vsock_host::ExecOutputEvent>,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stdout = Vec::new();
        while let Some(event) = stdout_rx.recv().await {
            if event.stream == ExecOutputStream::Stdout && !event.truncated {
                stdout.extend_from_slice(&event.chunk);
            }
        }
        stdout
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out draining stdout"))
}

fn captured_output_lossy(output: &ExecOwnedCapturedOutput) -> String {
    match output {
        ExecOwnedCapturedOutput::Discarded => String::new(),
        ExecOwnedCapturedOutput::Captured { bytes, .. } => String::from_utf8_lossy(bytes).into(),
    }
}

async fn wait_for_path(path: &Path, timeout: Duration) -> io::Result<()> {
    tokio::time::timeout(timeout, wait_for_path_event(path))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out waiting for {}", path.display()),
            )
        })?
}

async fn wait_for_path_event(path: &Path) -> io::Result<()> {
    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;

    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let async_fd = async_inotify_fd(inotify)?;
    loop {
        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        if tokio::fs::try_exists(path).await? {
            return Ok(());
        }
    }
}

fn async_inotify_fd(inotify: Inotify) -> io::Result<AsyncFd<OwnedFd>> {
    let fd: OwnedFd = inotify.into();
    AsyncFd::new(fd).map_err(|error| io::Error::other(format!("AsyncFd: {error}")))
}

fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: fd is a valid non-blocking inotify descriptor borrowed from
        // AsyncFd. The stack buffer is valid for the requested byte length.
        let result = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}

fn join_guest(guest: thread::JoinHandle<io::Result<()>>) -> TestResult<()> {
    guest
        .join()
        .map_err(|_| io::Error::other("guest thread panicked"))??;
    Ok(())
}

fn guest_agent_wrapper_command(guest_agent: &str) -> String {
    quote_shell_arg(guest_agent)
}

fn canonical_process_control_guest_agent_wrapper_command(guest_agent: &str) -> String {
    // The test process can itself run under vm0 and inherit an incomplete
    // cgroup bootstrap pair. Keep this unmanaged fixture isolated from it.
    format!(
        "if [ -z \"${{{}+x}}\" ]; then export {}=\"${}\"; fi; unset {} {} {} {} {}; exec {}",
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        process_control_ipc::BOOTSTRAP_ENV,
        process_control_ipc::BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
        quote_shell_arg(guest_agent)
    )
}

fn needs_sudo_for_canonical_workspace() -> bool {
    let parent = Path::new("/home/user");
    if parent.exists() {
        return !path_is_writable(parent);
    }
    !path_is_writable(Path::new("/home"))
}

fn path_is_writable(path: &Path) -> bool {
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: c_path is a valid NUL-terminated path.
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}
