use std::io;
use std::ops::Deref;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use tokio::io::unix::AsyncFd;
use vsock_host::VsockHost;

static WRITE_FILE_HELPER: Once = Once::new();
const WRITE_FILE_HELPER_BIN: &str = env!("CARGO_BIN_EXE_guest-write-file-test-helper");

fn install_write_file_helper() {
    WRITE_FILE_HELPER.call_once(|| {
        vsock_guest::set_debug_guest_write_file_path_for_tests(WRITE_FILE_HELPER_BIN.into());
    });
}

/// Spawn a guest agent in a background OS thread that connects to the given socket path.
fn start_guest(socket_path: &str) -> JoinHandle<io::Result<()>> {
    let path = socket_path.to_owned();
    thread::spawn(move || {
        let stream = vsock_guest::connect_unix(&path)?;
        vsock_guest::handle_connection(stream)
    })
}

fn cleanup_guest(guest: &mut Option<JoinHandle<io::Result<()>>>) {
    if let Some(g) = guest.take() {
        let _ = g.join();
    }
}

fn create_temp_dir(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("create temp dir")
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn shell_quote_path(path: &Path) -> String {
    shell_quote(path.to_str().expect("test path must be valid UTF-8"))
}

pub(crate) async fn wait_for_path(path: &Path, timeout: Duration) {
    wait_for_path_result(path, timeout)
        .await
        .unwrap_or_else(|error| panic!("timed out waiting for path {path:?}: {error}"));
}

/// Test harness: creates temp dir, starts guest thread, connects host.
///
/// Implements `Drop` to clean up temp dirs and join guest threads even on panic.
pub(crate) struct Harness {
    pub(crate) dir: std::path::PathBuf,
    _dir_guard: tempfile::TempDir,
    host: Option<VsockHost>,
    guest: Option<JoinHandle<io::Result<()>>>,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        install_write_file_helper();

        let dir_guard = create_temp_dir("vsock-test");
        let dir = dir_guard.path().to_path_buf();
        let base_path = dir.join("vsock").to_string_lossy().to_string();
        let listener_path = format!("{base_path}_1000");
        let listener = std::path::PathBuf::from(&listener_path);

        let host_base_path = base_path.clone();
        let host_task = tokio::spawn(async move {
            VsockHost::wait_for_connection(&host_base_path, Duration::from_secs(5)).await
        });

        if let Err(err) = wait_for_path_result(&listener, Duration::from_secs(5)).await {
            host_task.abort();
            let _ = host_task.await;
            panic!("host listener did not become ready: {err}");
        }

        let mut guest = Some(start_guest(&listener_path));
        let host = match host_task.await {
            Ok(Ok(host)) => host,
            Ok(Err(err)) => {
                cleanup_guest(&mut guest);
                panic!("host connection failed: {err}");
            }
            Err(err) => {
                cleanup_guest(&mut guest);
                panic!("host listener task failed: {err}");
            }
        };

        Self {
            dir,
            _dir_guard: dir_guard,
            host: Some(host),
            guest,
        }
    }

    pub(crate) fn finish(mut self) {
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            g.join()
                .expect("guest thread panicked")
                .expect("guest returned error");
        }
    }

    /// Finish without asserting guest result (for shutdown tests where guest exits differently)
    pub(crate) fn finish_ignore_guest(mut self) {
        drop(self.host.take());
        if let Some(g) = self.guest.take() {
            let _ = g.join();
        }
    }
}

async fn wait_for_path_result(path: &Path, timeout: Duration) -> io::Result<()> {
    tokio::time::timeout(timeout, wait_for_path_event(path))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "path wait timed out"))?
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

impl Deref for Harness {
    type Target = VsockHost;
    fn deref(&self) -> &VsockHost {
        self.host.as_ref().unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        // Drop host first to close the connection, then join guest thread.
        drop(self.host.take());
        cleanup_guest(&mut self.guest);
    }
}

#[test]
fn cleanup_guest_joins_guest() {
    let guest_finished = Arc::new(AtomicBool::new(false));
    let guest_finished_for_thread = Arc::clone(&guest_finished);
    let mut guest = Some(thread::spawn(move || {
        guest_finished_for_thread.store(true, Ordering::SeqCst);
        Ok(())
    }));

    cleanup_guest(&mut guest);

    assert!(guest.is_none());
    assert!(guest_finished.load(Ordering::SeqCst));
}

#[test]
fn create_temp_dir_returns_distinct_direct_temp_children() {
    let first = create_temp_dir("vsock-test-unique");
    let second = create_temp_dir("vsock-test-unique");

    assert_ne!(first.path(), second.path());
    assert_eq!(first.path().parent(), Some(std::env::temp_dir().as_path()));
    assert_eq!(second.path().parent(), Some(std::env::temp_dir().as_path()));
}
