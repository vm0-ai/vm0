use std::io;
use std::ops::Deref;
use std::path::Path;
use std::sync::Once;
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
    host: Option<VsockHost>,
    guest: Option<JoinHandle<io::Result<()>>>,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        install_write_file_helper();

        let dir = std::env::temp_dir()
            .join(format!("vsock-test-{}", std::process::id()))
            .join(format!("{:?}", std::thread::current().id()));
        std::fs::create_dir_all(&dir).expect("failed to create temp dir");
        let base_path = dir.join("vsock").to_string_lossy().to_string();
        let listener_path = format!("{base_path}_1000");

        let mut guest = Some(start_guest(&listener_path));
        let host = match VsockHost::wait_for_connection(&base_path, Duration::from_secs(5)).await {
            Ok(host) => host,
            Err(err) => {
                if let Some(g) = guest.take() {
                    let _ = g.join();
                }
                let _ = std::fs::remove_dir_all(&dir);
                panic!("host connection failed: {err}");
            }
        };

        Self {
            dir,
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
        if let Some(g) = self.guest.take() {
            let _ = g.join();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
