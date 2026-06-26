use super::*;

#[tokio::test]
async fn sandbox_default_exec_succeeds() {
    let sandbox = MockSandbox::new("test-1");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: "echo hello",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await;
    let exec = result.unwrap();
    assert_eq!(exec.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(exec.stdout.is_empty());
}

#[tokio::test]
async fn sandbox_exec_rejects_invalid_env_key_without_recording_call() {
    let sandbox = MockSandbox::new("test-1");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: "echo hello",
            timeout: Duration::from_secs(5),
            env: &[("BAD-NAME", "x")],
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await;
    let err = match result {
        Ok(_) => panic!("invalid env key should be rejected"),
        Err(err) => err,
    };

    assert_operation_error(
        err,
        SandboxOperation::Exec,
        SandboxOperationReason::Other,
        "invalid environment variable name",
    );
    assert!(sandbox.exec_calls().is_empty());
}

#[tokio::test]
async fn sandbox_queued_exec_results() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::Exited { exit_code: 42 },
        stdout: b"out".to_vec(),
        stderr: b"err".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::WaitFailed,
        stdout: Vec::new(),
        stderr: b"wait failed".to_vec(),
        diagnostic: "wait failed".to_string(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    sandbox.push_exec_result(Err(SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: "boom".into(),
    }));

    let req = ExecRequest {
        cmd: "test",
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };

    // First call returns queued result.
    let r1 = sandbox.exec(&req).await.unwrap();
    assert_eq!(r1.termination, ExecTermination::Exited { exit_code: 42 });
    assert_eq!(r1.stdout, b"out");

    // Second call preserves a queued non-exited terminal state.
    let r2 = sandbox.exec(&req).await.unwrap();
    assert_eq!(r2.termination, ExecTermination::WaitFailed);
    assert_eq!(r2.stderr, b"wait failed");
    assert_eq!(r2.diagnostic, "wait failed");

    // Third call returns queued error.
    let r3 = sandbox.exec(&req).await;
    assert!(r3.is_err());

    // Fourth call falls back to default (exit 0).
    let r4 = sandbox.exec(&req).await.unwrap();
    assert_eq!(r4.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn sandbox_exec_applies_mock_capture_budget() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        b"stdout".to_vec(),
        b"stderr".to_vec(),
    )));

    let result = sandbox
        .exec(&ExecRequest {
            cmd: "test",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            stdin_bytes: None,
            output_limits: ExecOutputLimits::separate(3, 4),
        })
        .await
        .unwrap();

    assert_eq!(result.stdout, b"std");
    assert!(result.stdout_truncated);
    assert_eq!(result.stderr, b"stde");
    assert!(result.stderr_truncated);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}
