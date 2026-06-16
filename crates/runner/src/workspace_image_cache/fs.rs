use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

#[cfg(not(test))]
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use tokio::fs;
use tokio::io::AsyncReadExt;

use chrono::SecondsFormat;

use crate::error::{RunnerError, RunnerResult};

use super::SessionWorkspaceCache;
use super::types::{CacheBudget, FsStats};

pub(super) const WORKSPACE_IMAGE_COPY_TIMEOUT: Duration = Duration::from_secs(300);

impl SessionWorkspaceCache {
    pub(super) async fn fs_stats(&self) -> RunnerResult<FsStats> {
        #[cfg(test)]
        {
            Ok(self.inner.fs_stats_override)
        }

        #[cfg(not(test))]
        {
            let path = self.workspace_image_cache_fs_stats_path();
            statvfs_bytes(&path).await
        }
    }
}

pub(super) fn is_workspace_tmp_path_name(name: &str) -> bool {
    name.starts_with("current.ext4.tmp.") || name.starts_with("metadata.json.tmp.")
}

pub(super) fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

pub(super) fn fs_stats_with_additional_available(stats: FsStats, bytes: u64) -> FsStats {
    FsStats {
        total_bytes: stats.total_bytes,
        available_bytes: stats
            .available_bytes
            .saturating_add(bytes)
            .min(stats.total_bytes),
    }
}

pub(super) fn existing_fs_stats_path(path: &Path) -> PathBuf {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match std::fs::metadata(candidate) {
            Ok(_) => return candidate.to_path_buf(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                current = candidate.parent();
            }
            Err(_) => return candidate.to_path_buf(),
        }
    }
    path.to_path_buf()
}

pub(super) async fn workspace_cache_path_allocated_bytes(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path).await else {
        return 0;
    };
    if metadata.is_dir() {
        directory_tree_allocated_bytes(path).await
    } else {
        allocated_bytes(&metadata)
    }
}

pub(super) async fn remove_workspace_cache_path_if_exists(path: &Path) -> std::io::Result<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }
    Ok(true)
}

pub(super) async fn remove_non_directory_workspace_cache_entry(path: &Path) -> RunnerResult<bool> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if metadata.is_dir() {
        return Ok(false);
    }
    remove_workspace_cache_path_if_exists(path).await?;
    Ok(true)
}

pub(super) async fn ensure_workspace_cache_entry_dir(path: &Path) -> RunnerResult<()> {
    remove_non_directory_workspace_cache_entry(path).await?;
    fs::create_dir_all(path).await?;
    let metadata = fs::symlink_metadata(path).await?;
    if metadata.is_dir() {
        return Ok(());
    }
    Err(RunnerError::Internal(format!(
        "workspace image cache entry is not a directory: {}",
        path.display()
    )))
}

pub(super) fn has_copy_headroom(stats: FsStats, budget: CacheBudget, allocated_bytes: u64) -> bool {
    stats.available_bytes.saturating_sub(allocated_bytes) >= budget.min_free_bytes
}

pub(super) async fn sparse_copy(src: &Path, dst: &Path) -> RunnerResult<()> {
    sparse_copy_with_timeout(src, dst, WORKSPACE_IMAGE_COPY_TIMEOUT).await
}

pub(super) async fn sparse_copy_with_timeout(
    src: &Path,
    dst: &Path,
    timeout: Duration,
) -> RunnerResult<()> {
    let mut command = tokio::process::Command::new("cp");
    command
        .arg("--sparse=always")
        .arg("--no-dereference")
        .arg("--")
        .arg(src)
        .arg(dst)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("exec cp: {e}")))?;
    let Some(stderr) = child.stderr.take() else {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(RunnerError::Internal("cp stderr pipe unavailable".into()));
    };
    let stderr_task = tokio::spawn(read_child_output(stderr));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err(RunnerError::Internal(format!("wait cp: {e}")));
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err(RunnerError::Internal(format!(
                "cp --sparse=always --no-dereference {} {} timed out after {}ms",
                src.display(),
                dst.display(),
                timeout.as_millis()
            )));
        }
    };
    let stderr = stderr_task
        .await
        .map_err(|e| RunnerError::Internal(format!("cp stderr task failed: {e}")))?
        .map_err(|e| RunnerError::Internal(format!("read cp stderr: {e}")))?;
    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr);
    Err(RunnerError::Internal(format!(
        "cp --sparse=always --no-dereference {} {} failed: {}",
        src.display(),
        dst.display(),
        stderr.trim()
    )))
}

pub(super) async fn read_child_output<R>(mut output: R) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(not(test))]
pub(super) async fn statvfs_bytes(path: &Path) -> RunnerResult<FsStats> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || statvfs_bytes_sync(&path))
        .await
        .map_err(|e| RunnerError::Internal(format!("statvfs task failed: {e}")))?
}

pub(super) async fn entry_file_type_is_dir(entry: &fs::DirEntry) -> RunnerResult<bool> {
    entry_file_type_matches(entry, std::fs::FileType::is_dir).await
}

pub(super) async fn cache_entry_dir_is_dir(path: &Path) -> RunnerResult<bool> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub(super) async fn entry_file_type_matches(
    entry: &fs::DirEntry,
    matches: fn(&std::fs::FileType) -> bool,
) -> RunnerResult<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(matches(&file_type)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

#[cfg(not(test))]
pub(super) fn statvfs_bytes_sync(path: &Path) -> RunnerResult<FsStats> {
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let bytes = path.as_os_str().as_bytes();
    let c_path = std::ffi::CString::new(bytes).map_err(|_| {
        RunnerError::Internal(format!(
            "statvfs path contains nul byte: {}",
            path.display()
        ))
    })?;
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stats = unsafe { stats.assume_init() };
    let block_size = stats.f_frsize;
    Ok(FsStats {
        total_bytes: stats.f_blocks.saturating_mul(block_size),
        available_bytes: stats.f_bavail.saturating_mul(block_size),
    })
}

pub(super) async fn directory_tree_allocated_bytes(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&dir).await else {
            continue;
        };
        total = total.saturating_add(allocated_bytes(&metadata));
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path).await else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(path);
            } else {
                total = total.saturating_add(allocated_bytes(&metadata));
            }
        }
    }
    total
}

pub(super) fn local_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
