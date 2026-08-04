use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

use crate::executor::agent_run::build_agent_start_command;

#[test]
fn agent_start_command_reports_missing_agent_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("missing-agent");

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(127));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "agent bootstrap failed: guest-agent is missing\n"
    );
}

#[test]
fn agent_start_command_reports_non_executable_agent_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("guest-agent");
    fs::write(&agent_path, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&agent_path, fs::Permissions::from_mode(0o644)).unwrap();

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(126));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "agent bootstrap failed: guest-agent is not executable\n"
    );
}

#[test]
fn agent_start_command_reports_non_file_agent_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let agent_path = dir.path().join("guest-agent");
    fs::create_dir(&agent_path).unwrap();

    let output = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command(agent_path.to_str().unwrap()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(126));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "agent bootstrap failed: guest-agent is not a regular file\n"
    );
}

#[test]
fn agent_start_command_keeps_agent_stderr_merged_into_stdout() {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(build_agent_start_command("/bin/sh"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"printf 'agent stdout\\n'\nprintf 'agent stderr\\n' >&2\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "agent stdout\nagent stderr\n"
    );
    assert!(output.stderr.is_empty());
}
