//! Integration coverage for the guest-agent process-control channel.
//!
//! Lower-level protocol status mapping, nonce validation, queue limits, and
//! concurrent routing live in vsock-host/vsock-guest tests. This test keeps the
//! guest-agent layer focused on the real bootstrap path: host vsock -> spawned
//! guest-agent process -> ControlHandle IPC -> host ack.

mod common;

use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{fs::File, thread};

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use tokio::io::unix::AsyncFd;

const PRE_READY_CONTROL_MESSAGE_ID: &str = "process-control-before-cli-ready";
const READY_CONTROL_MESSAGE_ID: &str = "process-control-after-cli-ready";

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

struct FifoGuard {
    path: PathBuf,
}

struct FifoGate {
    file: Option<File>,
}

struct RunFileGuard {
    run_id: String,
}

struct ConnectionHarness {
    host: Option<vsock_host::VsockHost>,
    guest: Option<thread::JoinHandle<io::Result<()>>>,
}

impl FifoGuard {
    fn create(path: PathBuf) -> TestResult<Self> {
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: c_path is a valid NUL-terminated path and the mode is a
        // normal POSIX permission mask for a test-only FIFO.
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl FifoGate {
    fn open(path: &Path) -> io::Result<Self> {
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: c_path is NUL-terminated, flags request one read/write
        // nonblocking FIFO fd, and ownership transfers to File on success.
        let fd = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fd is a freshly opened descriptor owned by this function.
        let file = unsafe { File::from_raw_fd(fd) };
        Ok(Self { file: Some(file) })
    }

    fn release(&mut self, payload: &[u8]) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.write_all(payload)?;
        }
        Ok(())
    }
}

impl RunFileGuard {
    fn new(run_id: &str) -> Self {
        Self {
            run_id: run_id.to_owned(),
        }
    }
}

impl Drop for FifoGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for RunFileGuard {
    fn drop(&mut self) {
        for path in run_scoped_files(&self.run_id) {
            let _ = std::fs::remove_file(path);
        }
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
    let fifo = FifoGuard::create(tmp.path().join("release.fifo"))?;
    let ready = tmp.path().join("fifo.ready");
    let run_id = format!(
        "process-control-channel-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let _run_files = RunFileGuard::new(&run_id);

    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let prompt = format!(
        "exec 3< {}; IFS= read -r _ <&3; touch {}; IFS= read -r _ <&3; echo process-control-channel-done",
        shell_quote_path(fifo.path()),
        shell_quote_path(&ready)
    );
    let workdir = tmp.path().to_string_lossy().into_owned();
    let mock_path = mock.to_string_lossy().into_owned();
    let env = [
        ("VM0_MOCK_CLAUDE_PATH", mock_path.as_str()),
        ("USE_MOCK_CLAUDE", "true"),
        ("VM0_POST_RESULT_SIGTERM_GRACE_SECS", "1"),
        ("VM0_POST_RESULT_SIGKILL_GRACE_SECS", "1"),
        ("VM0_RUN_ID", run_id.as_str()),
        ("VM0_PROMPT", prompt.as_str()),
        ("VM0_WORKING_DIR", workdir.as_str()),
        ("VM0_API_URL", "http://127.0.0.1:1"),
        ("VM0_API_TOKEN", ""),
        ("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc"),
        ("VM0_SANDBOX_REUSE_RESULT", "reused"),
        ("HOME", workdir.as_str()),
    ];

    let mut fifo_gate = FifoGate::open(fifo.path())?;
    let connection = start_host_and_guest(tmp.path()).await?;
    let mut handle = connection
        .host()
        .spawn_process_with_control_sink(&shell_quote(guest_agent), 30_000, &env, false, true, None)
        .await?;
    let mut stdout_rx = handle
        .take_stdout_receiver()
        .ok_or("spawned process should expose stdout stream")?;

    let pre_ready_ack = handle
        .control(
            PRE_READY_CONTROL_MESSAGE_ID,
            br#"{"type":"active-input","text":"before-ready"}"#,
            Duration::from_secs(10),
        )
        .await?;

    fifo_gate.release(b"ready\n")?;
    wait_for_path(&ready, Duration::from_secs(10)).await?;

    let ack = handle
        .control(
            READY_CONTROL_MESSAGE_ID,
            br#"{"type":"active-input","text":"after-ready"}"#,
            Duration::from_secs(10),
        )
        .await?;

    fifo_gate.release(b"release\n")?;
    let exit = tokio::time::timeout(Duration::from_secs(20), handle.wait()).await??;
    let stdout = collect_stdout(&mut stdout_rx, Duration::from_secs(5)).await?;

    connection.finish()?;

    assert_eq!(pre_ready_ack.message_id, PRE_READY_CONTROL_MESSAGE_ID);
    assert_eq!(ack.message_id, READY_CONTROL_MESSAGE_ID);
    assert_eq!(
        exit.exit_code,
        0,
        "guest-agent failed, stderr: {}",
        String::from_utf8_lossy(&exit.stderr)
    );
    assert!(
        String::from_utf8_lossy(&stdout).contains("process-control-channel-done"),
        "guest-agent stdout did not include mock CLI completion marker: {}",
        String::from_utf8_lossy(&stdout)
    );

    Ok(())
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
    stdout_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stdout = Vec::new();
        while let Some(chunk) = stdout_rx.recv().await {
            stdout.extend_from_slice(&chunk);
        }
        stdout
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out draining stdout"))
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

fn run_scoped_files(run_id: &str) -> [String; 11] {
    [
        format!("/tmp/vm0-session-{run_id}.txt"),
        format!("/tmp/vm0-session-history-{run_id}.txt"),
        format!("/tmp/vm0-event-error-{run_id}"),
        format!("/tmp/vm0-checkpoint-error-{run_id}"),
        format!("/tmp/vm0-system-{run_id}.log"),
        format!("/tmp/vm0-agent-{run_id}.log"),
        format!("/tmp/vm0-metrics-{run_id}.jsonl"),
        format!("/tmp/vm0-sandbox-ops-{run_id}.jsonl"),
        format!("/tmp/vm0-telemetry-system-log-pos-{run_id}.txt"),
        format!("/tmp/vm0-telemetry-metrics-pos-{run_id}.txt"),
        format!("/tmp/vm0-telemetry-sandbox-ops-pos-{run_id}.txt"),
    ]
}

fn shell_quote_path(path: &Path) -> String {
    shell_quote(&path.to_string_lossy())
}

fn shell_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\\''"))
}
