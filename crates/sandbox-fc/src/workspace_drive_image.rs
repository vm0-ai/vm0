use std::path::Path;
use std::time::{Duration, Instant};

use sandbox::{SandboxError, SandboxInitializationPhase, WorkspaceDriveSeedImage};

use crate::command;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceDriveImagePrepareStage {
    SeedSparseCopy,
    FreshFormat,
}

pub(crate) trait WorkspaceDriveImagePrepareObserver: Send {
    fn mark_workspace_drive_present(&mut self);

    fn mark_workspace_seed_image_used(&mut self);

    fn record_stage_result(
        &mut self,
        stage: WorkspaceDriveImagePrepareStage,
        started_at: Instant,
        result: sandbox::Result<()>,
    ) -> sandbox::Result<()>;
}

pub(crate) async fn prepare_workspace_drive_image(
    path: &Path,
    config: &sandbox::WorkspaceDriveConfig,
    mut observer: Option<&mut dyn WorkspaceDriveImagePrepareObserver>,
) -> sandbox::Result<()> {
    if let Some(observer) = observer.as_deref_mut() {
        observer.mark_workspace_drive_present();
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("create workspace image dir: {e}"),
            })?;
    }

    match config.seed_image.as_ref() {
        Some(WorkspaceDriveSeedImage::Copy(source_image)) => {
            if let Some(observer) = observer.as_deref_mut() {
                observer.mark_workspace_seed_image_used();
            }
            return copy_workspace_drive_seed_image(
                path,
                source_image,
                workspace_drive_size_bytes(config.size_mb),
                observer,
            )
            .await;
        }
        Some(WorkspaceDriveSeedImage::Move(source_image)) => {
            if let Some(observer) = observer.as_deref_mut() {
                observer.mark_workspace_seed_image_used();
            }
            return move_workspace_drive_seed_image(
                path,
                source_image,
                workspace_drive_size_bytes(config.size_mb),
            )
            .await;
        }
        None => {}
    }

    let file = tokio::fs::File::create(path)
        .await
        .map_err(|e| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("create workspace image {}: {e}", path.display()),
        })?;
    file.set_len(workspace_drive_size_bytes(config.size_mb))
        .await
        .map_err(|e| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("set workspace image size {}: {e}", path.display()),
        })?;
    drop(file);

    let path_str = path.to_str().ok_or_else(|| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("workspace image path is not UTF-8: {}", path.display()),
    })?;
    let stage_started = Instant::now();
    let result = command::exec_with_timeout(
        "mkfs.ext4",
        &["-F", "-q", path_str],
        Duration::from_secs(60),
    )
    .await
    .map(|_| ())
    .map_err(|e| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("format workspace image: {e}"),
    });
    record_stage_result(
        observer,
        WorkspaceDriveImagePrepareStage::FreshFormat,
        stage_started,
        result,
    )?;
    Ok(())
}

async fn copy_workspace_drive_seed_image(
    target: &Path,
    source: &Path,
    expected_size_bytes: u64,
    observer: Option<&mut dyn WorkspaceDriveImagePrepareObserver>,
) -> sandbox::Result<()> {
    validate_workspace_seed_source(source, expected_size_bytes).await?;

    let source_str = source
        .to_str()
        .ok_or_else(|| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "workspace seed image path is not UTF-8: {}",
                source.display()
            ),
        })?;
    let target_str = target
        .to_str()
        .ok_or_else(|| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("workspace image path is not UTF-8: {}", target.display()),
        })?;

    let stage_started = Instant::now();
    let result = command::exec_with_timeout(
        "cp",
        &["--sparse=always", "--", source_str, target_str],
        Duration::from_secs(300),
    )
    .await
    .map(|_| ())
    .map_err(|e| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("copy workspace seed image: {e}"),
    });
    record_stage_result(
        observer,
        WorkspaceDriveImagePrepareStage::SeedSparseCopy,
        stage_started,
        result,
    )?;

    validate_workspace_seed_target(target, expected_size_bytes, "copied").await
}

async fn move_workspace_drive_seed_image(
    target: &Path,
    source: &Path,
    expected_size_bytes: u64,
) -> sandbox::Result<()> {
    validate_workspace_seed_source(source, expected_size_bytes).await?;
    if let Err(e) = std::fs::rename(source, target) {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "move workspace seed image {} to {}: {e}",
                source.display(),
                target.display()
            ),
        });
    }
    validate_workspace_seed_target(target, expected_size_bytes, "moved").await
}

async fn validate_workspace_seed_source(
    source: &Path,
    expected_size_bytes: u64,
) -> sandbox::Result<()> {
    let source_metadata =
        tokio::fs::symlink_metadata(source)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("read workspace seed image {}: {e}", source.display()),
            })?;
    if !source_metadata.is_file() {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "workspace seed image is not a regular file: {}",
                source.display()
            ),
        });
    }
    if source_metadata.len() != expected_size_bytes {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "workspace seed image size mismatch for {}: expected {} bytes, got {} bytes",
                source.display(),
                expected_size_bytes,
                source_metadata.len()
            ),
        });
    }
    Ok(())
}

async fn validate_workspace_seed_target(
    target: &Path,
    expected_size_bytes: u64,
    action: &str,
) -> sandbox::Result<()> {
    let target_metadata =
        tokio::fs::symlink_metadata(target)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("read {action} workspace image {}: {e}", target.display()),
            })?;
    if !target_metadata.is_file() {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "{action} workspace image is not a regular file: {}",
                target.display()
            ),
        });
    }
    if target_metadata.len() != expected_size_bytes {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "{action} workspace image size mismatch for {}: expected {} bytes, got {} bytes",
                target.display(),
                expected_size_bytes,
                target_metadata.len()
            ),
        });
    }

    Ok(())
}

fn workspace_drive_size_bytes(size_mb: u32) -> u64 {
    u64::from(size_mb) * 1024 * 1024
}

fn record_stage_result(
    observer: Option<&mut dyn WorkspaceDriveImagePrepareObserver>,
    stage: WorkspaceDriveImagePrepareStage,
    started_at: Instant,
    result: sandbox::Result<()>,
) -> sandbox::Result<()> {
    match observer {
        Some(observer) => observer.record_stage_result(stage, started_at, result),
        None => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    #[derive(Default)]
    struct RecordingObserver {
        workspace_drive_present: bool,
        workspace_seed_image_used: bool,
        stages: Vec<WorkspaceDriveImagePrepareStage>,
    }

    impl WorkspaceDriveImagePrepareObserver for RecordingObserver {
        fn mark_workspace_drive_present(&mut self) {
            self.workspace_drive_present = true;
        }

        fn mark_workspace_seed_image_used(&mut self) {
            self.workspace_seed_image_used = true;
        }

        fn record_stage_result(
            &mut self,
            stage: WorkspaceDriveImagePrepareStage,
            _started_at: Instant,
            result: sandbox::Result<()>,
        ) -> sandbox::Result<()> {
            self.stages.push(stage);
            result
        }
    }

    #[test]
    fn workspace_drive_size_bytes_converts_mib_to_bytes() {
        assert_eq!(workspace_drive_size_bytes(16), 16 * 1024 * 1024);
    }

    #[tokio::test]
    async fn prepare_workspace_drive_image_without_seed_formats_fresh_image() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("nested").join("workspace.ext4");
        let mut observer = RecordingObserver::default();

        prepare_workspace_drive_image(
            &target,
            &sandbox::WorkspaceDriveConfig {
                size_mb: 16,
                seed_image: None,
            },
            Some(&mut observer),
        )
        .await
        .unwrap();

        let metadata = tokio::fs::metadata(&target).await.unwrap();
        assert_eq!(metadata.len(), workspace_drive_size_bytes(16));
        assert!(observer.workspace_drive_present);
        assert!(!observer.workspace_seed_image_used);
        assert_eq!(
            observer.stages,
            vec![WorkspaceDriveImagePrepareStage::FreshFormat]
        );
    }

    #[tokio::test]
    async fn prepare_workspace_drive_image_sparse_copies_seed_image() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("seed.ext4");
        let target = tmp.path().join("nested").join("workspace.ext4");
        let marker_offset = 4096;
        let marker = b"vm0";
        let mut observer = RecordingObserver::default();

        let mut source_file = tokio::fs::File::create(&source).await.unwrap();
        source_file
            .set_len(workspace_drive_size_bytes(1))
            .await
            .unwrap();
        source_file
            .seek(SeekFrom::Start(marker_offset))
            .await
            .unwrap();
        source_file.write_all(marker).await.unwrap();
        source_file.flush().await.unwrap();
        drop(source_file);

        prepare_workspace_drive_image(
            &target,
            &sandbox::WorkspaceDriveConfig {
                size_mb: 1,
                seed_image: Some(WorkspaceDriveSeedImage::Copy(source.clone())),
            },
            Some(&mut observer),
        )
        .await
        .unwrap();

        let metadata = tokio::fs::metadata(&target).await.unwrap();
        assert_eq!(metadata.len(), workspace_drive_size_bytes(1));
        assert!(observer.workspace_drive_present);
        assert!(observer.workspace_seed_image_used);
        assert_eq!(
            observer.stages,
            vec![WorkspaceDriveImagePrepareStage::SeedSparseCopy]
        );

        let mut target_file = tokio::fs::File::open(&target).await.unwrap();
        target_file
            .seek(SeekFrom::Start(marker_offset))
            .await
            .unwrap();
        let mut copied_marker = [0; 3];
        target_file.read_exact(&mut copied_marker).await.unwrap();
        assert_eq!(&copied_marker, marker);
    }

    #[tokio::test]
    async fn prepare_workspace_drive_image_rejects_seed_image_size_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("seed.ext4");
        let target = tmp.path().join("workspace.ext4");

        let source_file = tokio::fs::File::create(&source).await.unwrap();
        source_file
            .set_len(workspace_drive_size_bytes(1) - 1)
            .await
            .unwrap();
        drop(source_file);

        let err = prepare_workspace_drive_image(
            &target,
            &sandbox::WorkspaceDriveConfig {
                size_mb: 1,
                seed_image: Some(WorkspaceDriveSeedImage::Copy(source)),
            },
            None,
        )
        .await
        .unwrap_err();

        match err {
            SandboxError::Initialization { phase, message } => {
                assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
                assert!(message.contains("workspace seed image size mismatch"));
            }
            other => panic!("expected workspace seed initialization error, got {other:?}"),
        }
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn prepare_workspace_drive_image_moves_seed_image() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("seed.ext4");
        let target = tmp.path().join("nested").join("workspace.ext4");
        let marker_offset = 4096;
        let marker = b"vm0";
        let mut observer = RecordingObserver::default();

        let mut source_file = tokio::fs::File::create(&source).await.unwrap();
        source_file
            .set_len(workspace_drive_size_bytes(1))
            .await
            .unwrap();
        source_file
            .seek(SeekFrom::Start(marker_offset))
            .await
            .unwrap();
        source_file.write_all(marker).await.unwrap();
        source_file.flush().await.unwrap();
        drop(source_file);

        prepare_workspace_drive_image(
            &target,
            &sandbox::WorkspaceDriveConfig {
                size_mb: 1,
                seed_image: Some(WorkspaceDriveSeedImage::Move(source.clone())),
            },
            Some(&mut observer),
        )
        .await
        .unwrap();

        assert!(!source.exists());
        let metadata = tokio::fs::metadata(&target).await.unwrap();
        assert_eq!(metadata.len(), workspace_drive_size_bytes(1));
        assert!(observer.workspace_drive_present);
        assert!(observer.workspace_seed_image_used);
        assert!(observer.stages.is_empty());

        let mut target_file = tokio::fs::File::open(&target).await.unwrap();
        target_file
            .seek(SeekFrom::Start(marker_offset))
            .await
            .unwrap();
        let mut moved_marker = [0; 3];
        target_file.read_exact(&mut moved_marker).await.unwrap();
        assert_eq!(&moved_marker, marker);
    }

    #[tokio::test]
    async fn prepare_workspace_drive_image_rejects_move_seed_image_size_mismatch_without_moving() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("seed.ext4");
        let target = tmp.path().join("workspace.ext4");

        let source_file = tokio::fs::File::create(&source).await.unwrap();
        source_file
            .set_len(workspace_drive_size_bytes(1) - 1)
            .await
            .unwrap();
        drop(source_file);

        let err = prepare_workspace_drive_image(
            &target,
            &sandbox::WorkspaceDriveConfig {
                size_mb: 1,
                seed_image: Some(WorkspaceDriveSeedImage::Move(source.clone())),
            },
            None,
        )
        .await
        .unwrap_err();

        match err {
            SandboxError::Initialization { phase, message } => {
                assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
                assert!(message.contains("workspace seed image size mismatch"));
            }
            other => panic!("expected workspace seed initialization error, got {other:?}"),
        }
        assert!(source.exists());
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn prepare_workspace_drive_image_rejects_move_seed_symlink_without_moving() {
        let tmp = tempfile::tempdir().unwrap();
        let real_source = tmp.path().join("real-seed.ext4");
        let source_link = tmp.path().join("seed-link.ext4");
        let target = tmp.path().join("workspace.ext4");

        let source_file = tokio::fs::File::create(&real_source).await.unwrap();
        source_file
            .set_len(workspace_drive_size_bytes(1))
            .await
            .unwrap();
        drop(source_file);
        std::os::unix::fs::symlink(&real_source, &source_link).unwrap();

        let err = prepare_workspace_drive_image(
            &target,
            &sandbox::WorkspaceDriveConfig {
                size_mb: 1,
                seed_image: Some(WorkspaceDriveSeedImage::Move(source_link.clone())),
            },
            None,
        )
        .await
        .unwrap_err();

        match err {
            SandboxError::Initialization { phase, message } => {
                assert_eq!(phase, SandboxInitializationPhase::SandboxAllocation);
                assert!(message.contains("workspace seed image is not a regular file"));
            }
            other => panic!("expected workspace seed initialization error, got {other:?}"),
        }
        assert!(real_source.exists());
        assert!(source_link.exists());
        assert!(!target.exists());
    }
}
