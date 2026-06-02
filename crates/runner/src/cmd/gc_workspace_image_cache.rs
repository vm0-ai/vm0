use clap::Args;

use crate::error::RunnerResult;
use crate::paths::{HomePaths, RunnerPaths};
use crate::workspace_image_cache::SessionWorkspaceCache;

#[derive(Args)]
pub struct GcWorkspaceImageCacheArgs {
    /// Show what would be deleted without actually deleting.
    #[arg(long)]
    dry_run: bool,
}

pub async fn run_gc_workspace_image_cache(args: GcWorkspaceImageCacheArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;
    run_gc_workspace_image_cache_with_home(args, &home).await
}

async fn run_gc_workspace_image_cache_with_home(
    args: GcWorkspaceImageCacheArgs,
    home: &HomePaths,
) -> RunnerResult<()> {
    let cache = SessionWorkspaceCache::shared(
        RunnerPaths::new(home.runners_dir().join("_cache-gc")),
        home,
        "",
    );
    let freed = cache.gc(args.dry_run).await?;
    let verb = if args.dry_run {
        "would be freed"
    } else {
        "freed"
    };
    tracing::info!("workspace image cache: {freed} bytes {verb}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;

    use crate::ids::RunId;
    use crate::paths::{scoped_session_workspace_cache_key, session_workspace_cache_key};

    fn tmp_image_path(home: &HomePaths, cache_key: &str, run_id: RunId) -> PathBuf {
        home.workspace_image_cache_dir()
            .join(cache_key)
            .join(format!("current.ext4.tmp.{run_id}"))
    }

    #[tokio::test]
    async fn gc_workspace_image_cache_cleans_shared_cache_root() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        let tmp = tmp_image_path(&home, &cache_key, RunId::new_v4());
        tokio::fs::create_dir_all(tmp.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&tmp, b"partial image").await.unwrap();

        run_gc_workspace_image_cache_with_home(GcWorkspaceImageCacheArgs { dry_run: false }, &home)
            .await
            .unwrap();

        assert!(!tmp.exists());
    }

    #[tokio::test]
    async fn gc_workspace_image_cache_dry_run_preserves_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let cache_key = session_workspace_cache_key("sess-1", "/workspace");
        let tmp = tmp_image_path(&home, &cache_key, RunId::new_v4());
        tokio::fs::create_dir_all(tmp.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&tmp, b"partial image").await.unwrap();

        run_gc_workspace_image_cache_with_home(GcWorkspaceImageCacheArgs { dry_run: true }, &home)
            .await
            .unwrap();

        assert!(tmp.exists());
    }

    #[tokio::test]
    async fn gc_workspace_image_cache_preserves_valid_group_scoped_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let cache_key = scoped_session_workspace_cache_key(
            "vm0/test",
            "vm0/default",
            "sess-1",
            "/workspace",
            b"image".len() as u64,
        );
        let entry_dir = home.workspace_image_cache_dir().join(&cache_key);
        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        let current = entry_dir.join("current.ext4");
        tokio::fs::write(&current, b"image").await.unwrap();
        let current_metadata = std::fs::metadata(&current).unwrap();
        let metadata = serde_json::json!({
            "formatVersion": 1,
            "keyVersion": 1,
            "cacheScope": "vm0/test",
            "profileName": "vm0/default",
            "sessionId": "sess-1",
            "workingDir": "/workspace",
            "lastCompletedAt": "2026-05-28T00:00:00.000Z",
            "lastUsedAt": "2026-05-28T00:00:00.000Z",
            "lastTerminalStatus": "success",
            "workspaceTrust": "clean",
            "logicalImageSizeBytes": current_metadata.len(),
            "allocatedBytes": current_metadata.blocks().saturating_mul(512),
            "currentImage": {
                "dev": current_metadata.dev(),
                "ino": current_metadata.ino(),
                "len": current_metadata.len(),
            },
            "driveLayout": "workspace-drive-v1",
            "storageFingerprints": {
                "storages": {},
                "artifacts": {},
            },
            "state": "current",
        });
        tokio::fs::write(
            entry_dir.join("metadata.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .await
        .unwrap();

        run_gc_workspace_image_cache_with_home(GcWorkspaceImageCacheArgs { dry_run: false }, &home)
            .await
            .unwrap();

        assert!(current.exists());
        assert!(entry_dir.join("metadata.json").exists());
    }
}
