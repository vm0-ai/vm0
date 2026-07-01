//! Codex auth setup failures should stop before launching the CLI.
//!
//! This test uses the real guest-agent binary because the fail-closed boundary
//! lives in `main.rs`, not in the public `cli::setup_codex` helper.

mod common;

use guest_contracts::diagnostics::{FailureClass, FailureDiagnostic};
use shell_quote::quote_shell_arg;
use std::path::Path;
use std::process::Command;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn codex_auth_setup_failure_exits_before_cli_spawn() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let fake_codex = tmp.path().join("codex");
    let invoked_marker = tmp.path().join("codex-invoked");
    let runtime_dir = tmp.path().join("runtime");
    let codex_home_path = tmp.path().join(".codex");
    std::fs::write(&codex_home_path, b"not a directory")?;
    write_fake_codex(&fake_codex, &invoked_marker)?;

    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let output = Command::new(guest_agent)
        .env_clear()
        .env("CLI_AGENT_TYPE", "codex")
        .env("USE_MOCK_CODEX", "true")
        .env("VM0_MOCK_CODEX_PATH", &fake_codex)
        .env("VM0_RUN_ID", "codex-auth-setup-fail-closed")
        .env("VM0_PROMPT", "should not reach codex")
        .env("VM0_API_URL", "http://127.0.0.1:1")
        .env("VM0_API_TOKEN", "")
        .env("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc")
        .env("VM0_SANDBOX_REUSE_RESULT", "reused")
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        )
        .env("HOME", tmp.path())
        .output()?;

    assert!(
        !output.status.success(),
        "guest-agent should fail when Codex auth setup cannot reconcile"
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(
        !invoked_marker.exists(),
        "guest-agent must not launch Codex after auth setup fails"
    );

    let error_path = guest_contracts::runtime_paths::checkpoint_error_file(&runtime_dir);
    let error = std::fs::read_to_string(error_path)?;
    assert!(
        error.contains("Codex auth setup failed"),
        "guest error should describe Codex auth setup failure: {error}"
    );

    let diagnostic_path = guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir);
    let diagnostic: FailureDiagnostic = serde_json::from_slice(&std::fs::read(diagnostic_path)?)?;
    assert_eq!(diagnostic.failure_class, FailureClass::CliExecutionError);

    Ok(())
}

fn write_fake_codex(path: &Path, marker: &Path) -> TestResult {
    let marker_path = marker.to_string_lossy();
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf invoked > {}\nexit 0\n",
            quote_shell_arg(&marker_path)
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}
