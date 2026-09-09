use super::*;
use guest_control_proto::{ExecCapturedOutput, ExecTermination as WireTermination};

#[derive(Clone, Copy)]
struct TerminalCase {
    expected: bool,
    termination: WireTermination,
    diagnostic: &'static str,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

#[tokio::test]
async fn expected_process_timeout_preserves_result_and_connection_without_warning() {
    let clean = TerminalCase {
        expected: true,
        termination: WireTermination::TimedOut,
        diagnostic: "",
        stdout_truncated: false,
        stderr_truncated: false,
    };
    for (case, level) in [
        (clean, Level::INFO),
        (
            TerminalCase {
                expected: false,
                ..clean
            },
            Level::WARN,
        ),
        (
            TerminalCase {
                diagnostic: "cleanup failed",
                ..clean
            },
            Level::WARN,
        ),
        (
            TerminalCase {
                stdout_truncated: true,
                ..clean
            },
            Level::WARN,
        ),
        (
            TerminalCase {
                stderr_truncated: true,
                ..clean
            },
            Level::WARN,
        ),
        (
            TerminalCase {
                termination: WireTermination::StartFailed,
                ..clean
            },
            Level::WARN,
        ),
        (
            TerminalCase {
                termination: WireTermination::WaitFailed,
                ..clean
            },
            Level::WARN,
        ),
        (
            TerminalCase {
                termination: WireTermination::Cancelled,
                ..clean
            },
            Level::WARN,
        ),
    ] {
        let sandbox = test_sandbox_with_state(SandboxState::Running);
        let mut guest = attach_mock_shutdown_guest(&sandbox).await;
        let request = StartProcessRequest {
            cmd: "bounded-optional-work",
            timeout: Duration::from_secs(10),
            timeout_is_expected: case.expected,
            start_timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            output: ProcessOutputMode::buffered(sandbox::EXEC_OUTPUT_LIMIT_1_MIB),
        };
        let ((exit, ()), events) = tokio::time::timeout(
            Duration::from_secs(5),
            capture_async_log_events(async {
                tokio::join!(
                    async {
                        let handle = sandbox.start_process(&request).await.unwrap();
                        sandbox
                            .wait_process(handle, Duration::from_secs(5))
                            .await
                            .unwrap()
                    },
                    async {
                        let start = read_vsock_message(&mut guest).await;
                        assert_eq!(start.msg_type, guest_control_proto::MSG_EXEC_START);
                        let decoded =
                            guest_control_proto::decode_exec_start(&start.payload).unwrap();
                        assert_eq!(decoded.role, ExecProcessRole::Workload);
                        assert_eq!(
                            decoded.timeout,
                            ExecTimeoutPolicy::Duration { timeout_ms: 10_000 }
                        );
                        let mut frames = guest_control_proto::encode(
                            guest_control_proto::MSG_EXEC_STARTED,
                            start.seq,
                            &guest_control_proto::encode_exec_started(73).unwrap(),
                        )
                        .unwrap();
                        frames.extend(
                            guest_control_proto::encode(
                                guest_control_proto::MSG_EXEC_RESULT,
                                start.seq,
                                &guest_control_proto::encode_exec_result(
                                    case.termination,
                                    10_075,
                                    ExecCapturedOutput::Captured {
                                        bytes: b"out",
                                        truncated: case.stdout_truncated,
                                    },
                                    ExecCapturedOutput::Captured {
                                        bytes: b"err",
                                        truncated: case.stderr_truncated,
                                    },
                                    case.diagnostic,
                                )
                                .unwrap(),
                            )
                            .unwrap(),
                        );
                        // Deliver both frames together: logging intent must exist
                        // before the start future can return its handle.
                        guest.write_all(&frames).await.unwrap();
                    },
                )
            }),
        )
        .await
        .expect("terminal process response must complete");
        assert_eq!(
            exit.termination,
            exec_termination_from_vsock_termination(case.termination)
        );
        assert_eq!(exit.guest_duration_ms, Some(10_075));
        assert_eq!(exit.stdout, b"out");
        assert_eq!(exit.stderr, b"err");
        assert_eq!(exit.diagnostic, case.diagnostic);
        assert_eq!(exit.stdout_truncated, case.stdout_truncated);
        assert_eq!(exit.stderr_truncated, case.stderr_truncated);
        let event = captured_event(&events, "exec operation terminal result");
        assert_eq!(event.level, level);
        assert_event_field(
            event,
            "terminal_reason",
            if level == Level::INFO {
                "expected_timeout"
            } else {
                "notable"
            },
        );
        assert_event_field(event, "guest_duration_ms", "10075");
        assert_eq!(
            captured_message_count(&events, "exec operation terminal result"),
            1
        );
        if level == Level::INFO {
            assert!(
                events
                    .iter()
                    .all(|event| event.level != Level::WARN && event.level != Level::ERROR)
            );
        }

        // A real terminal result releases normal-operation ownership, even when
        // the bounded workload failed. Verify the next public guest operation.
        let next_request = ExecRequest {
            cmd: "true",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: sandbox::EXEC_OUTPUT_LIMIT_1_MIB,
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(sandbox.exec(&next_request), async {
                let next = read_vsock_message(&mut guest).await;
                assert_eq!(next.msg_type, guest_control_proto::MSG_EXEC_START);
                let payload = guest_control_proto::encode_exec_result(
                    WireTermination::Exited { exit_code: 0 },
                    1,
                    ExecCapturedOutput::Captured {
                        bytes: b"",
                        truncated: false,
                    },
                    ExecCapturedOutput::Captured {
                        bytes: b"",
                        truncated: false,
                    },
                    "",
                )
                .unwrap();
                guest
                    .write_all(
                        &guest_control_proto::encode(
                            guest_control_proto::MSG_EXEC_RESULT,
                            next.seq,
                            &payload,
                        )
                        .unwrap(),
                    )
                    .await
                    .unwrap();
            },)
        })
        .await
        .expect("connection must remain usable after terminal result");
        assert_eq!(
            result.unwrap().termination,
            ExecTermination::Exited { exit_code: 0 }
        );
    }
}
