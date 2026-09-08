use super::*;
use guest_control_proto::{
    FileWriteStage, FileWriteStatus, MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT,
};

#[derive(Clone, Copy, Debug)]
enum DiagnosticReply {
    Matching,
    MatchingPrivateBatch,
    DifferentRequest,
    InvalidStage,
    NoReply,
    BackendCrash,
}

#[tokio::test]
async fn private_write_timeout_collects_one_bounded_diagnostic_without_replacing_the_error() {
    for reply in [
        DiagnosticReply::Matching,
        DiagnosticReply::MatchingPrivateBatch,
        DiagnosticReply::DifferentRequest,
        DiagnosticReply::InvalidStage,
        DiagnosticReply::NoReply,
        DiagnosticReply::BackendCrash,
    ] {
        let sandbox = test_sandbox_with_state(SandboxState::Running);
        let mut guest = attach_mock_shutdown_guest(&sandbox).await;
        let started = Instant::now();
        let ((result, write_sequence), events) = tokio::time::timeout(
            Duration::from_secs(65),
            capture_async_log_events(async {
                tokio::join!(
                    async {
                        if matches!(reply, DiagnosticReply::MatchingPrivateBatch) {
                            sandbox
                                .write_private_files(&[
                                    WriteFileEntry {
                                        path: "/tmp/synthetic-context.json",
                                        content: b"synthetic content",
                                    },
                                    WriteFileEntry {
                                        path: "/tmp/synthetic-accounts.json",
                                        content: b"synthetic accounts",
                                    },
                                ])
                                .await
                        } else {
                            sandbox
                                .write_private_file(
                                    "/tmp/synthetic-context.json",
                                    b"synthetic content",
                                )
                                .await
                        }
                    },
                    async {
                        let write = read_vsock_message(&mut guest).await;
                        assert_eq!(
                            write.msg_type,
                            if matches!(reply, DiagnosticReply::MatchingPrivateBatch) {
                                guest_control_proto::MSG_WRITE_PRIVATE_FILES
                            } else {
                                guest_control_proto::MSG_WRITE_FILE
                            }
                        );
                        // Advance only after socket receipt; keep real time during
                        // I/O so automatic clock advancement cannot race the peer.
                        tokio::time::pause();
                        // Cross the timer wheel's millisecond rounding boundary.
                        tokio::time::advance(Duration::from_millis(60_001)).await;
                        tokio::time::resume();
                        let query = read_vsock_message(&mut guest).await;
                        assert_eq!(query.msg_type, MSG_FILE_WRITE_STATUS);
                        assert!(query.payload.is_empty());
                        let payload = match reply {
                            DiagnosticReply::Matching | DiagnosticReply::MatchingPrivateBatch => {
                                Some(
                                    FileWriteStatus {
                                        sequence: write.seq,
                                        stage: FileWriteStage::WaitingForHelper,
                                    }
                                    .encode_payload(),
                                )
                            }
                            DiagnosticReply::DifferentRequest => Some(
                                FileWriteStatus {
                                    sequence: write.seq + 1,
                                    stage: FileWriteStage::ResponseSent,
                                }
                                .encode_payload(),
                            ),
                            DiagnosticReply::InvalidStage => Some([0, 0, 0, 1, 255]),
                            DiagnosticReply::NoReply => {
                                tokio::time::pause();
                                tokio::time::advance(Duration::from_millis(1_001)).await;
                                tokio::time::resume();
                                None
                            }
                            DiagnosticReply::BackendCrash => {
                                sandbox.publish_state(SandboxState::Crashed);
                                guest.shutdown().await.unwrap();
                                None
                            }
                        };
                        if let Some(payload) = payload {
                            guest
                                .write_all(
                                    &guest_control_proto::encode(
                                        MSG_FILE_WRITE_STATUS_RESULT,
                                        query.seq,
                                        &payload,
                                    )
                                    .unwrap(),
                                )
                                .await
                                .unwrap();
                        }
                        write.seq
                    }
                )
            }),
        )
        .await
        .expect("write and diagnostic must finish within their budgets");
        assert!(
            matches!(
                result,
                Err(SandboxError::OperationTimeout {
                    operation: SandboxOperation::WriteFile,
                    stage: sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse,
                    timeout_ms: 60_000
                })
            ),
            "{reply:?}: {result:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(62),
            "{reply:?}: {:?}",
            started.elapsed()
        );
        let diagnostics: Vec<_> = events
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("private file-write timeout guest diagnostic")
            })
            .collect();
        assert_eq!(diagnostics.len(), 1, "{reply:?}: {events:?}");
        let event = diagnostics[0];
        assert_eq!(event.level, Level::WARN);
        assert_eq!(event.fields["write_sequence"], write_sequence.to_string());
        let outcome = match reply {
            DiagnosticReply::Matching | DiagnosticReply::MatchingPrivateBatch => "matched",
            DiagnosticReply::DifferentRequest => "different_request",
            _ => "unavailable",
        };
        assert_eq!(event.fields["diagnostic_outcome"], outcome);
        if matches!(
            reply,
            DiagnosticReply::Matching
                | DiagnosticReply::MatchingPrivateBatch
                | DiagnosticReply::DifferentRequest
        ) {
            assert_eq!(event.fields.len(), 6);
            assert_eq!(
                event.fields["guest_write_stage"],
                if matches!(
                    reply,
                    DiagnosticReply::Matching | DiagnosticReply::MatchingPrivateBatch
                ) {
                    "waiting_for_helper"
                } else {
                    "response_sent"
                }
            );
        } else {
            assert_eq!(event.fields.len(), 5);
            assert_eq!(
                event.fields["diagnostic_error_kind"],
                match reply {
                    DiagnosticReply::InvalidStage => "InvalidData",
                    DiagnosticReply::NoReply => "TimedOut",
                    _ => "ConnectionReset",
                }
            );
        }
        assert!(
            sandbox
                .guest
                .lock()
                .await
                .as_ref()
                .unwrap()
                .try_fence_normal_operations()
                .is_err()
        );
        assert!(
            sandbox
                .write_private_file("/tmp/later", b"later")
                .await
                .is_err()
        );
    }
}
