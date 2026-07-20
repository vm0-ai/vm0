use super::*;
use std::sync::Arc;

#[tokio::test]
async fn sandbox_default_exec_succeeds() {
    let sandbox = MockSandbox::new("test-1");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: "echo hello",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
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
            expected_exit_codes: &[],
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
        expected_exit_codes: &[],
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
async fn sandbox_persistent_exec_matcher_serves_repeated_calls_after_one_shot_override() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_persistent_exec_matcher(ExecMatcher {
        pattern: "prepare".into(),
        exit_code: 0,
        stdout: b"healthy".to_vec(),
        stderr: Vec::new(),
    });
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "prepare".into(),
        exit_code: 4,
        stdout: Vec::new(),
        stderr: b"cleanup failed".to_vec(),
    });
    let sandbox = MockSandbox::with_overrides("persistent", overrides);
    let request = ExecRequest {
        cmd: "prepare",
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
    };

    assert_eq!(
        sandbox.exec(&request).await.unwrap().termination,
        ExecTermination::Exited { exit_code: 4 }
    );
    assert_eq!(sandbox.exec(&request).await.unwrap().stdout, b"healthy");
    assert_eq!(sandbox.exec(&request).await.unwrap().stdout, b"healthy");
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
            expected_exit_codes: &[],
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

#[tokio::test]
async fn sandbox_exec_matcher_applies_capture_limits_and_is_one_shot() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "echo hello".into(),
        exit_code: 42,
        stdout: b"stdout".to_vec(),
        stderr: b"stderr".to_vec(),
    });
    let factory = MockSandboxFactory::with_overrides(overrides);
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let request = ExecRequest {
        cmd: "echo hello world",
        timeout: Duration::from_secs(5),
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: ExecOutputLimits::separate(3, 4),
    };

    let matched = sandbox.exec(&request).await.unwrap();
    assert_eq!(
        matched.termination,
        ExecTermination::Exited { exit_code: 42 }
    );
    assert_eq!(matched.stdout, b"std");
    assert!(matched.stdout_truncated);
    assert_eq!(matched.stderr, b"stde");
    assert!(matched.stderr_truncated);

    let fallback = sandbox.exec(&request).await.unwrap();
    assert_eq!(
        fallback.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert!(fallback.stdout.is_empty());
    assert!(!fallback.stdout_truncated);
    assert!(fallback.stderr.is_empty());
    assert!(!fallback.stderr_truncated);
}
