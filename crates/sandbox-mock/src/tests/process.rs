use super::*;
use std::sync::Arc;

#[tokio::test]
async fn overrides_record_start_process_output_modes_in_order() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let buffered = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();
    assert!(!buffered.has_stdout_receiver());

    let streamed = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::stream(),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();
    assert!(streamed.has_stdout_receiver());

    assert_eq!(
        overrides.start_process_calls(),
        vec![
            StartProcessCall {
                cmd: "agent".to_string(),
                timeout: Duration::from_secs(5),
                env: Vec::new(),
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            },
            StartProcessCall {
                cmd: "agent".to_string(),
                timeout: Duration::from_secs(5),
                env: Vec::new(),
                sudo: false,
                output: ProcessOutputMode::stream(),
                control: ProcessControlMode::None,
            },
        ]
    );
}

#[tokio::test]
async fn start_process_emits_queued_stdout_chunks() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
        bytes: b"partial".to_vec(),
        truncated: true,
    }]);
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::stream(),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let chunk = stdout_rx.recv().await.unwrap();

    assert_eq!(chunk.bytes, b"partial");
    assert!(chunk.truncated);
    assert!(stdout_rx.recv().await.is_none());
}

#[tokio::test]
async fn start_process_returns_control_handle_when_requested() {
    let runtime = MockSandboxRuntime::new();
    let factory = runtime.create_factory(test_factory_config()).await.unwrap();
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();

    let without_control = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();
    assert!(without_control.control_handle().is_none());

    let with_control = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::Enabled,
        })
        .await
        .unwrap();
    let control = with_control
        .control_handle()
        .expect("enabled control should expose a handle");
    let ack = control
        .control("msg-1", b"payload", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(ack.message_id, "msg-1");
}

#[tokio::test]
async fn process_control_calls_are_recorded_when_overrides_are_enabled() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::Enabled,
        })
        .await
        .unwrap();
    let control = handle
        .control_handle()
        .expect("enabled control should expose a handle");

    control
        .control("msg-1", b"payload", Duration::from_millis(250))
        .await
        .unwrap();

    assert_eq!(
        overrides.process_control_calls(),
        vec![ProcessControlCall {
            message_id: "msg-1".to_string(),
            payload: b"payload".to_vec(),
            timeout: Duration::from_millis(250),
        }]
    );
}

#[tokio::test]
async fn queued_process_control_errors_are_consumed_fifo() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_process_control_error("control failed");
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::Enabled,
        })
        .await
        .unwrap();
    let control = handle
        .control_handle()
        .expect("enabled control should expose a handle");

    let err = control
        .control("msg-1", b"payload-1", Duration::from_secs(1))
        .await
        .unwrap_err();
    let ack = control
        .control("msg-2", b"payload-2", Duration::from_secs(1))
        .await
        .unwrap();

    assert!(err.to_string().contains("control failed"));
    assert_eq!(ack.message_id, "msg-2");
    assert_eq!(overrides.process_control_calls().len(), 2);
}

#[tokio::test]
async fn start_process_rejects_invalid_stream_configuration() {
    let runtime = MockSandboxRuntime::new();
    let factory = runtime.create_factory(test_factory_config()).await.unwrap();
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();

    for output in [
        ProcessOutputMode::Stream {
            stream_limit_bytes: 1024,
            chunk_limit_bytes: 0,
            queue_capacity: 1,
            stderr_capture_limit_bytes: None,
        },
        ProcessOutputMode::Stream {
            stream_limit_bytes: 1024,
            chunk_limit_bytes: 16,
            queue_capacity: 0,
            stderr_capture_limit_bytes: None,
        },
    ] {
        match sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output,
                control: ProcessControlMode::None,
            })
            .await
        {
            Ok(_) => panic!("invalid stream configuration should be rejected"),
            Err(SandboxError::Operation {
                operation, reason, ..
            }) => {
                assert_eq!(operation, SandboxOperation::StartProcess);
                assert_eq!(reason, SandboxOperationReason::Other);
            }
            Err(other) => panic!("expected start_process operation error, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn start_process_rejects_invalid_env_key() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test-1", Arc::clone(&overrides));
    let result = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[("1BAD", "x")],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await;
    let err = match result {
        Ok(_) => panic!("invalid env key should be rejected"),
        Err(err) => err,
    };

    assert_operation_error(
        err,
        SandboxOperation::StartProcess,
        SandboxOperationReason::Other,
        "invalid environment variable name",
    );
    assert!(overrides.start_process_calls().is_empty());
}

#[tokio::test]
async fn wait_process_rejects_consumed_guest_process_handle() {
    let runtime = MockSandboxRuntime::new();
    let factory = runtime.create_factory(test_factory_config()).await.unwrap();
    let sandbox = factory.create(test_sandbox_config()).await.unwrap();
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();

    let consumed = handle.take_waiter();
    assert!(consumed.is_some());
    match sandbox.wait_process(handle, Duration::from_secs(5)).await {
        Ok(_) => panic!("wait_process should reject an already consumed handle"),
        Err(SandboxError::Operation {
            operation,
            reason,
            message,
        }) => {
            assert_eq!(operation, SandboxOperation::WaitProcess);
            assert_eq!(reason, SandboxOperationReason::Other);
            assert!(message.contains("already consumed"));
        }
        Err(other) => panic!("expected wait_process operation error, got {other:?}"),
    }
}

#[tokio::test]
async fn wait_process_returns_queued_process_exit() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let mut exit = ProcessExit::new(77, 0, b"out".to_vec(), b"err".to_vec());
    exit.stream_overflowed = true;
    overrides.push_wait_process_exit(exit);
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();

    let result = sandbox
        .wait_process(handle, Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(result.pid, 77);
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(result.stream_overflowed);
}

#[tokio::test]
async fn wait_process_default_exit_is_unchanged_without_queued_exit() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();

    let result = sandbox
        .wait_process(handle, Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(result.pid, 1);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn wait_process_drops_unclaimed_stdout_receiver_before_waiting() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(MockSandboxOverrides::with_wait_process_gate(Arc::clone(
        &gate,
    )));
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
    let handle = GuestProcessHandle::new(
        1,
        Some(stdout_rx),
        None,
        GuestProcessWaiter::new(|_timeout| {
            Box::pin(std::future::pending::<std::io::Result<ProcessExit>>())
        }),
    );

    let wait =
        tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
    tokio::time::timeout(test_timeout(), stdout_tx.closed())
        .await
        .expect("wait_process should drop an unclaimed stdout receiver before blocking");

    gate.notify_waiters();
    wait.await.unwrap().unwrap();
}

#[tokio::test]
async fn wait_process_lifecycle_gate_blocks_until_released() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("test", overrides);
    let handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();

    let wait =
        tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert!(
        !wait.is_finished(),
        "wait_process should block until the lifecycle gate is released",
    );

    gate.release_one();
    let result = wait.await.unwrap().unwrap();
    assert_eq!(result.pid, 1);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn wait_process_lifecycle_gate_clear_only_affects_future_waits() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let first_sandbox = MockSandbox::with_overrides("first", Arc::clone(&overrides));
    let first_handle = first_sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();

    let first_wait = tokio::spawn(async move {
        first_sandbox
            .wait_process(first_handle, Duration::from_secs(5))
            .await
    });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

    overrides.clear_wait_process_lifecycle_gate();
    assert!(
        !first_wait.is_finished(),
        "clearing the gate must not release an already-entered wait_process",
    );

    let second_sandbox = MockSandbox::with_overrides("second", overrides);
    let second_handle = second_sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();
    let second_result = tokio::time::timeout(
        test_timeout(),
        second_sandbox.wait_process(second_handle, Duration::from_secs(5)),
    )
    .await
    .expect("future wait_process calls should bypass a cleared gate")
    .unwrap();
    assert_eq!(
        second_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );

    gate.release_one();
    let first_result = first_wait.await.unwrap().unwrap();
    assert_eq!(
        first_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
}

#[tokio::test]
async fn process_cancel_releases_wait_process_lifecycle_gate() {
    let gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(gate.clone());
    let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
    let mut handle = sandbox
        .start_process(&StartProcessRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
            control: ProcessControlMode::None,
        })
        .await
        .unwrap();
    let cancel = handle
        .take_cancel_handle()
        .expect("mock process should expose a cancel handle");

    let wait =
        tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

    cancel.cancel(Duration::from_secs(1)).await.unwrap();
    let result = wait.await.unwrap().unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(overrides.process_cancel_calls().len(), 1);
}
