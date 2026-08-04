use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::ffi::OsStringExt as _;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

const CLI_PKG_URL: &str = "https://static.vm0.io/okou-cli/test-commit/package.tgz";

#[test]
fn unknown_command_preserves_arguments_streams_and_exit_status() {
    let temp_dir = tempfile::tempdir().unwrap();
    let npx_path = temp_dir.path().join("npx");
    let args_path = temp_dir.path().join("args");
    let stdin_path = temp_dir.path().join("stdin");

    fs::write(
        &npx_path,
        r#"#!/bin/sh
printf '%s\n' "$@" > "$ZERO_CLI_TEST_ARGS_PATH"
/bin/cat > "$ZERO_CLI_TEST_STDIN_PATH"
printf 'forwarded stdout'
printf 'forwarded stderr' >&2
exit 23
"#,
    )
    .unwrap();
    fs::set_permissions(&npx_path, fs::Permissions::from_mode(0o755)).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_zero-cli"))
        .args(["definitely-unknown", "two words"])
        .env("PATH", temp_dir.path())
        .env("CLI_PKG_URL", CLI_PKG_URL)
        .env("ZERO_CLI_TEST_ARGS_PATH", &args_path)
        .env("ZERO_CLI_TEST_STDIN_PATH", &stdin_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"forwarded stdin").unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();

    assert_eq!(output.status.code(), Some(23));
    assert_eq!(output.stdout, b"forwarded stdout");
    assert_eq!(output.stderr, b"forwarded stderr");
    assert_eq!(
        fs::read_to_string(args_path).unwrap(),
        "--yes\n--package=https://static.vm0.io/okou-cli/test-commit/package.tgz\nzero\ndefinitely-unknown\ntwo words\n"
    );
    assert_eq!(fs::read(stdin_path).unwrap(), b"forwarded stdin");
}

#[test]
fn fallback_preserves_non_unicode_os_argument_boundaries() {
    let temp_dir = tempfile::tempdir().unwrap();
    let npx_path = temp_dir.path().join("npx");
    let args_path = temp_dir.path().join("args");

    fs::write(
        &npx_path,
        r#"#!/bin/sh
printf '%s\0' "$@" > "$ZERO_CLI_TEST_ARGS_PATH"
"#,
    )
    .unwrap();
    fs::set_permissions(&npx_path, fs::Permissions::from_mode(0o755)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_zero-cli"))
        .args([
            OsString::from("unknown"),
            OsString::from("two words"),
            OsString::from_vec(vec![b'r', b'a', b'w', 0xff, b'x']),
            OsString::new(),
        ])
        .env("PATH", temp_dir.path())
        .env("CLI_PKG_URL", CLI_PKG_URL)
        .env("ZERO_CLI_TEST_ARGS_PATH", &args_path)
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        fs::read(args_path).unwrap(),
        b"--yes\0--package=https://static.vm0.io/okou-cli/test-commit/package.tgz\0zero\0unknown\0two words\0raw\xffx\0\0"
    );
}

#[test]
fn fallback_exec_preserves_process_identity_and_signal_delivery() {
    let temp_dir = tempfile::tempdir().unwrap();
    let npx_path = temp_dir.path().join("npx");

    fs::write(
        &npx_path,
        r#"#!/bin/sh
trap 'exit 42' TERM
printf '%s\n' "$$"
while :; do :; done
"#,
    )
    .unwrap();
    fs::set_permissions(&npx_path, fs::Permissions::from_mode(0o755)).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_zero-cli"))
        .arg("unknown")
        .env("PATH", temp_dir.path())
        .env("CLI_PKG_URL", CLI_PKG_URL)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let original_pid = child.id();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let fallback_pid: u32 = ready.trim().parse().unwrap();

    assert_eq!(fallback_pid, original_pid);
    // SAFETY: `original_pid` is the live child process created immediately above.
    let result = unsafe { libc::kill(original_pid.cast_signed(), libc::SIGTERM) };
    assert_eq!(result, 0);

    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(42));
}

#[test]
fn fallback_exec_failure_does_not_emit_arguments_or_tokens() {
    let temp_dir = tempfile::tempdir().unwrap();
    let sensitive_argument = "sensitive-command-argument";
    let sensitive_token = "sensitive-zero-token";

    let output = Command::new(env!("CARGO_BIN_EXE_zero-cli"))
        .args(["unknown", sensitive_argument])
        .env("PATH", temp_dir.path())
        .env("ZERO_TOKEN", sensitive_token)
        .output()
        .unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(stderr.contains("failed to execute the npm Zero CLI fallback"));
    assert!(!stderr.contains(sensitive_argument));
    assert!(!stderr.contains(sensitive_token));
}
