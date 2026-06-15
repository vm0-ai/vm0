#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use std::io::{ErrorKind, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_guest-write-file");

fn run_helper(args: &[&str], stdin: &[u8]) -> std::process::Output {
    run_helper_with_current_dir(args, stdin, None)
}

fn run_helper_in_dir(args: &[&str], stdin: &[u8], current_dir: &Path) -> std::process::Output {
    run_helper_with_current_dir(args, stdin, Some(current_dir))
}

fn run_helper_with_current_dir(
    args: &[&str],
    stdin: &[u8],
    current_dir: Option<&Path>,
) -> std::process::Output {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }

    let mut child = command.spawn().expect("spawn guest-write-file");
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

fn wait_with_timeout(child: std::process::Child, timeout: Duration) -> std::process::Output {
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(timeout) {
        Ok(output) => output.expect("wait guest-write-file"),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            terminate_child(pid);
            let _ = rx.recv_timeout(Duration::from_secs(1));
            panic!("guest-write-file did not exit within {timeout:?}");
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            panic!("guest-write-file waiter thread exited without sending output");
        }
    }
}

#[cfg(unix)]
fn terminate_child(pid: u32) {
    let _ = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

#[cfg(not(unix))]
fn terminate_child(_pid: u32) {
    // Tests run on Unix in CI; keep a non-Unix fallback for compilation.
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
fn create_mode_truncates_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    std::fs::write(&path, b"old longer content").unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"new");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"new");
}

#[test]
fn create_mode_writes_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"");

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(std::fs::read(path).unwrap(), b"");
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
fn append_mode_rejects_create_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing/out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--append", "--create-parents", path_str], b"hello");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot be used together"));
    assert!(!path.exists());
}

#[test]
fn path_starting_with_dash_is_treated_as_path_after_separator() {
    let dir = tempfile::tempdir().unwrap();

    let output = run_helper_in_dir(
        &["--create-parents", "--", "-literal.txt"],
        b"hello",
        dir.path(),
    );

    assert!(output.status.success(), "stderr={:?}", output.stderr);
    assert_eq!(
        std::fs::read(dir.path().join("-literal.txt")).unwrap(),
        b"hello"
    );
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

#[test]
fn create_parents_fails_when_parent_component_is_file() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("not-a-dir");
    std::fs::write(&parent, b"file").unwrap();
    let path = parent.join("out.txt");
    let path_str = path.to_str().unwrap();

    let output = run_helper(&["--create-parents", path_str], b"hello");

    assert!(!output.status.success());
    assert!(parent.is_file());
    assert!(!path.exists());
}

#[test]
fn create_mode_rejects_directory_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target");
    std::fs::create_dir(&path).unwrap();
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"hello");

    assert!(!output.status.success());
    assert!(path.is_dir());
}

#[cfg(unix)]
#[test]
fn create_mode_rejects_character_device_target() {
    let output = run_helper(&["/dev/null"], b"hello");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a regular file"));
}

#[cfg(unix)]
#[test]
fn create_mode_fails_fast_for_fifo_without_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fifo");
    mkfifo(&path);
    let path_str = path.to_str().unwrap();

    let output = run_helper(&[path_str], b"hello");

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
