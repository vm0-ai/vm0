#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use std::io::{ErrorKind, Write};
use std::process::{Command, Stdio};

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
    child.wait_with_output().expect("wait guest-write-file")
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
