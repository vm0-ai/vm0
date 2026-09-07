use super::*;
use sandbox::SandboxOperationWriteStage;

#[tokio::test]
async fn start_process_partial_write_error_rejects_later_guest_work() {
    for backend_crashed in [false, true] {
        let sandbox = test_sandbox_with_state(SandboxState::Running);
        let mut guest = attach_mock_shutdown_guest(&sandbox).await;
        // Exceed the Unix socket's send buffer so a prefix can be observed while
        // the complete frame remains unwritten.
        let payload = "x".repeat(4 * 1024 * 1024);
        let request = StartProcessRequest {
            cmd: "prefetch",
            timeout: Duration::from_secs(5),
            start_timeout: Duration::from_secs(5),
            env: &[("PAYLOAD", &payload)],
            sudo: false,
            output: ProcessOutputMode::buffered(sandbox::EXEC_OUTPUT_LIMIT_1_MIB),
        };
        let start = sandbox.start_process(&request);
        tokio::pin!(start);
        let mut prefix = [0u8; 16];
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                result = guest.read_exact(&mut prefix) => { result.unwrap(); }
                result = &mut start => panic!("start ended before prefix: {:?}", result.err()),
            }
        })
        .await
        .expect("start must emit a partial frame");
        if backend_crashed {
            // Model the observed-state window before the crash notification
            // is published, so the ordinary write result owns this race.
            sandbox
                .state
                .store(SandboxState::Crashed as u8, Ordering::Release);
        }
        // The oversized frame is still incomplete, so the start cannot be
        // awaiting a guest reply when the transport is closed.
        drop(guest);
        let result = tokio::time::timeout(Duration::from_secs(5), start)
            .await
            .expect("partial start write should fail without waiting for its deadline");
        let error = result.err().expect("partial start frame must fail");
        let SandboxError::OperationWrite {
            operation,
            stage,
            source,
        } = error
        else {
            panic!("write classification must survive backend-crash detection: {error:?}");
        };
        assert_eq!(operation, SandboxOperation::StartProcess);
        assert_eq!(stage, SandboxOperationWriteStage::FrameWrite);
        assert_eq!(source.kind(), io::ErrorKind::BrokenPipe);
        assert!(
            source
                .get_ref()
                .unwrap()
                .is::<guest_control_client::RequestWriteError>()
        );

        let later_request = StartProcessRequest {
            cmd: "later-work",
            ..request
        };
        assert!(sandbox.start_process(&later_request).await.is_err());
    }
}
