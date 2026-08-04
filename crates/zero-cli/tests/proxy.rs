use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

#[test]
fn delegates_to_the_published_zero_cli_process() {
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
        .args(["search", "two words"])
        .env("PATH", temp_dir.path())
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
        "-p\n@vm0/cli\nzero\nsearch\ntwo words\n"
    );
    assert_eq!(fs::read(stdin_path).unwrap(), b"forwarded stdin");
}
