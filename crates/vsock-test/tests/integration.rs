use std::io;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::time::sleep;

/// Spawn a guest agent in a background OS thread that connects to the given socket path.
///
/// Retries connection up to 50 times with 10ms delay (matching vsock-guest's reconnect logic)
/// to handle the race between host listener bind and guest connect.
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

/// Create a unique temp directory for socket files and return (dir_path, base_vsock_path).
/// Caller must clean up the directory when done.
fn make_vsock_path() -> (std::path::PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("vsock-test-{}", std::process::id()));
    // Each test runs in its own async task, use thread id for uniqueness
    let dir = dir.join(format!("{:?}", std::thread::current().id()));
    std::fs::create_dir_all(&dir).expect("failed to create temp dir");
    let base = dir.join("vsock").to_string_lossy().to_string();
    (dir, base)
}

fn cleanup(dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn test_exec() {
    let (dir, base_path) = make_vsock_path();
    let listener_path = format!("{base_path}_1000");
    let guest = start_guest(&listener_path);

    let mut host = vsock_host::VsockHost::wait_for_connection(&base_path, Duration::from_secs(5))
        .await
        .expect("host connection failed");

    let result = host.exec("echo hello", 5000).await.expect("exec failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    assert!(result.stderr.is_empty());

    drop(host);
    guest
        .join()
        .expect("guest thread panicked")
        .expect("guest returned error");
    cleanup(&dir);
}

#[tokio::test]
async fn test_write_file() {
    let (dir, base_path) = make_vsock_path();
    let listener_path = format!("{base_path}_1000");
    let guest = start_guest(&listener_path);

    let mut host = vsock_host::VsockHost::wait_for_connection(&base_path, Duration::from_secs(5))
        .await
        .expect("host connection failed");

    let file_path = format!("{base_path}_testfile.txt");
    let content = b"hello from vsock-test";

    host.write_file(&file_path, content, false)
        .await
        .expect("write_file failed");

    // Verify by reading the file back via exec
    let result = host
        .exec(&format!("cat '{file_path}'"), 5000)
        .await
        .expect("exec cat failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, content);

    drop(host);
    guest
        .join()
        .expect("guest thread panicked")
        .expect("guest returned error");
    cleanup(&dir);
}

#[tokio::test]
async fn test_spawn_watch() {
    let (dir, base_path) = make_vsock_path();
    let listener_path = format!("{base_path}_1000");
    let guest = start_guest(&listener_path);

    let mut host = vsock_host::VsockHost::wait_for_connection(&base_path, Duration::from_secs(5))
        .await
        .expect("host connection failed");

    let pid = host
        .spawn_watch("echo done", 5000)
        .await
        .expect("spawn_watch failed");

    assert!(pid > 0);

    let event = host
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("wait_for_exit failed");

    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"done\n");
    assert!(event.stderr.is_empty());

    drop(host);
    guest
        .join()
        .expect("guest thread panicked")
        .expect("guest returned error");
    cleanup(&dir);
}

#[tokio::test]
async fn test_shutdown() {
    let (dir, base_path) = make_vsock_path();
    let listener_path = format!("{base_path}_1000");
    let guest = start_guest(&listener_path);

    let mut host = vsock_host::VsockHost::wait_for_connection(&base_path, Duration::from_secs(5))
        .await
        .expect("host connection failed");

    // Small delay to ensure connection is fully stable
    sleep(Duration::from_millis(50)).await;

    let acked = host.shutdown(Duration::from_secs(5)).await;
    assert!(acked);

    drop(host);
    guest
        .join()
        .expect("guest thread panicked")
        .expect("guest returned error");
    cleanup(&dir);
}
