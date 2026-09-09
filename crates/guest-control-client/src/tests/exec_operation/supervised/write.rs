use std::error::Error;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use nix::sys::socket::{Shutdown, setsockopt, shutdown, sockopt};
use tokio::io::AsyncReadExt;

use super::super::super::support::{
    host_from_stream, is_connected, make_pair, mock_handshake, operation_count,
};
use super::support::supervised_request;
use crate::{RequestWriteError, RequestWriteStage, SupervisedExecRequest};

#[tokio::test]
async fn supervised_process_partial_write_error_preserves_cause_and_rejects_later_work() {
    let (host_stream, mut guest) = make_pair();
    setsockopt(&host_stream, sockopt::SndBuf, &4096usize).unwrap();
    let host_task = tokio::spawn(async move { host_from_stream(host_stream).await.unwrap() });
    mock_handshake(&mut guest).await;
    let host = Arc::new(host_task.await.unwrap());
    let mut task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let stdin_bytes = vec![0xA5; guest_control_proto::MAX_EXEC_STDIN_BYTES];
            host.start_supervised_process(SupervisedExecRequest {
                stdin_bytes: Some(&stdin_bytes),
                ..supervised_request("partial-write")
            })
            .await
        })
    };

    // Observe real bytes before shutting down only the host's write half. The host
    // reader stays open, so this must fail write_all rather than the response wait.
    let mut prefix = [0u8; 16];
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            result = guest.read_exact(&mut prefix) => { result.unwrap(); }
            result = &mut task => panic!("start ended before prefix: {:?}", result.unwrap().err()),
        }
    })
    .await
    .expect("start frame prefix must be written");
    assert!(!task.is_finished());
    shutdown(host.shared.fd, Shutdown::Write).unwrap();
    let mut partial = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), guest.read_to_end(&mut partial))
        .await
        .unwrap()
        .unwrap();
    assert!(prefix.len() + partial.len() < guest_control_proto::MAX_EXEC_STDIN_BYTES);
    let error = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .expect("an incomplete frame must fail the process start");
    assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    let write = error
        .get_ref()
        .and_then(|source| source.downcast_ref::<RequestWriteError>())
        .expect("ordinary partial write must retain its typed boundary");
    assert_eq!(write.stage(), RequestWriteStage::FrameWrite);
    let cause = write.source().unwrap().downcast_ref::<io::Error>().unwrap();
    assert_eq!(cause.kind(), error.kind());
    assert_eq!(cause.raw_os_error(), Some(nix::libc::EPIPE));
    assert_eq!(error.to_string(), cause.to_string());
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!is_connected(&host));
    assert_eq!(operation_count(&host), 0);
    assert!(
        host.start_supervised_process(supervised_request("later-work"))
            .await
            .is_err()
    );
    assert_eq!(operation_count(&host), 0);
}
