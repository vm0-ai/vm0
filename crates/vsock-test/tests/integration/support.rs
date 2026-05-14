use std::io;
use std::ops::Deref;
use std::path::Path;
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use vsock_host::VsockHost;

static WRITE_FILE_HELPER: Once = Once::new();
const WRITE_FILE_HELPER_BIN: &str = env!("CARGO_BIN_EXE_guest-write-file-test-helper");

fn install_write_file_helper() {
    WRITE_FILE_HELPER.call_once(|| {
        vsock_guest::set_debug_guest_write_file_path_for_tests(WRITE_FILE_HELPER_BIN.into())
            .expect("set guest-write-file test helper path");
    });
}

/// Spawn a guest agent in a background OS thread that connects to the given socket path.
///
/// Retries connection up to 50 times with 10ms delay to handle the race between
/// host listener bind and guest connect.
fn start_guest(socket_path: &str) -> JoinHandle<io::Result<()>> {
    let path = socket_path.to_owned();
    thread::spawn(move || {
        let stream = retry_connect(&path)?;
        vsock_guest::handle_connection(stream)
    })
}

fn retry_connect(path: &str) -> io::Result<std::os::unix::net::UnixStream> {
    for i in 0..50 {
        match vsock_guest::connect_unix(path) {
            Ok(stream) => return Ok(stream),
            Err(e) if i < 49 => {
                let _ = e;
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
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
    tokio::time::timeout(timeout, async {
        loop {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for path {path:?}"));
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

        let mut guest = Some(start_guest(&listener_path));
        let host = match VsockHost::wait_for_connection(&base_path, Duration::from_secs(5)).await {
            Ok(host) => host,
            Err(err) => {
                cleanup_guest(&mut guest);
                panic!("host connection failed: {err}");
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

    pub(crate) async fn wait_spawn(
        &self,
        handle: vsock_host::SpawnWatchHandle,
        timeout: Duration,
    ) -> io::Result<vsock_host::ProcessExitEvent> {
        tokio::time::timeout(timeout, handle.wait())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "wait timeout"))?
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
