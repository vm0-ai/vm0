use std::time::Duration;

use guest_control_proto::{FileWriteStage, FileWriteStatus};

use crate::support::{
    Harness, blocking_write_path, release_blocking_write, wait_for_blocking_write,
};

const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

#[tokio::test]
async fn private_write_status_survives_quiesce_and_tracks_the_next_write() {
    let h = Harness::new().await;
    assert_eq!(
        h.host().file_write_status(QUERY_TIMEOUT).await.unwrap(),
        FileWriteStatus {
            sequence: 0,
            stage: FileWriteStage::Idle,
        }
    );
    let mut previous_sequence = 0;
    for content in [b"first".as_slice(), b"second".as_slice()] {
        let path = h.dir.join("private/context.json");
        h.host()
            .write_private_file(path.to_str().unwrap(), content)
            .await
            .unwrap();
        h.host().quiesce_operations(QUERY_TIMEOUT).await.unwrap();
        let status = tokio::time::timeout(QUERY_TIMEOUT, async {
            loop {
                let status = h.host().file_write_status(QUERY_TIMEOUT).await.unwrap();
                if status.stage == FileWriteStage::ResponseSent {
                    break status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(status.sequence > previous_sequence);
        previous_sequence = status.sequence;
        assert_eq!(std::fs::read(path).unwrap(), content);
        h.host().resume_operations(QUERY_TIMEOUT).await.unwrap();
    }
    h.finish();
}

#[tokio::test]
async fn private_write_status_does_not_reopen_an_uncertain_or_quiescing_connection() {
    let h = Harness::new().await;
    let path = blocking_write_path(&h.dir, "private-diagnostic");
    {
        let write = h
            .host()
            .write_private_file(path.to_str().unwrap(), b"synthetic private content");
        tokio::pin!(write);
        tokio::select! {
            result = wait_for_blocking_write(&path, QUERY_TIMEOUT) => result.unwrap(),
            result = &mut write => panic!("write ended before helper blocked: {result:?}"),
        }
        h.host()
            .quiesce_operations(QUERY_TIMEOUT)
            .await
            .unwrap_err();
        let status = h.host().file_write_status(QUERY_TIMEOUT).await.unwrap();
        assert_ne!(status.sequence, 0);
        assert_eq!(status.stage, FileWriteStage::WaitingForHelper);
        assert_eq!(status.encode_payload().len(), 5);
        // Drop the unresolved write. Its operation token must remain fail-closed.
    }
    assert_eq!(
        h.host()
            .file_write_status(QUERY_TIMEOUT)
            .await
            .unwrap()
            .stage,
        FileWriteStage::WaitingForHelper
    );
    assert!(h.host().try_fence_normal_operations().is_err());
    let later = h.dir.join("must-not-write");
    assert!(
        h.host()
            .write_private_file(later.to_str().unwrap(), b"later")
            .await
            .is_err()
    );
    assert!(!later.exists());
    release_blocking_write(&path);
    h.finish_ignore_guest();
}
