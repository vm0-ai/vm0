#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use std::io::{ErrorKind, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_guest-write-file");

fn run_helper(args: &[&str], stdin: &[u8]) -> std::process::Output {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn guest-write-file");
    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(stdin)
        .or_else(|e| {
            if e.kind() == ErrorKind::BrokenPipe {
                Ok(())
            } else {
                Err(e)
            }
        })
        .expect("write stdin");
    wait_with_timeout(child, Duration::from_secs(5))
}

fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> std::process::Output {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().expect("poll guest-write-file").is_some() {
            return child.wait_with_output().expect("wait guest-write-file");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("guest-write-file did not exit within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn create_mode_creates_missing_parents_and_writes_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a/b/c/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--create-parents", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"hello");
}

#[test]
fn append_mode_appends_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    std::fs::write(&path, b"first").unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", path_str], b"second");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"firstsecond");
}

#[test]
fn append_mode_creates_missing_file_when_parent_exists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", path_str], b"hello");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"hello");
}

#[test]
fn append_mode_does_not_create_missing_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", path_str], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such file"));
    assert!(!path.exists());
}

#[test]
fn create_mode_without_create_parents_does_not_create_missing_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such file"));
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn create_mode_fails_fast_for_fifo_without_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fifo");
    mkfifo(&path);
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("guest-write-file"));
}

#[cfg(unix)]
#[test]
fn create_mode_rejects_fifo_with_reader() {
    use std::os::unix::fs::OpenOptionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fifo");
    mkfifo(&path);
    let _reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&path)
        .unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a regular file"));
}

#[cfg(unix)]
fn mkfifo(path: &std::path::Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(
        result,
        0,
        "mkfifo failed: {}",
        std::io::Error::last_os_error()
    );
}
