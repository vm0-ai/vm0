use std::path::{Path, PathBuf};

use aws_sdk_s3::error::SdkError;

#[cfg(test)]
use super::keys::key_for_hash;
use super::{
    R2DownloadError, R2Error, R2ImageCache,
    archive::{TEMPLATE_FILE, unpack_into_staging},
    io_other,
    keys::key_for_template_hash,
};

impl R2ImageCache {
    /// Try to download `runner-images/{hash}.tar.zst`, streaming directly
    /// through zstd decode + tar unpack into a sibling staging directory,
    /// then atomic rename to `final_dir`. No temp file — bounded memory
    /// regardless of image size.
    ///
    /// The client is built from explicit R2 credentials, so it avoids AWS
    /// credential/endpoint discovery stalls. Outer call sites (CI/systemd)
    /// bound total wall time.
    #[cfg(test)]
    pub async fn try_download(
        &self,
        hash: &str,
        final_dir: &Path,
    ) -> Result<bool, R2DownloadError> {
        let key = key_for_hash(hash);
        let resp = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(r) => r,
            Err(SdkError::ServiceError(e))
                if matches!(
                    e.err(),
                    aws_sdk_s3::operation::get_object::GetObjectError::NoSuchKey(_)
                ) =>
            {
                return Ok(false);
            }
            Err(e) => {
                return Err(R2DownloadError::Request(R2Error::S3(format!(
                    "get_object: {e:?}"
                ))));
            }
        };

        // Atomic via staging dir + rename. Cleanup-on-error covers the entire
        // staging lifecycle — a partial unpack can leave many GB on disk even
        // though `final_dir` is never created. Without cleanup, a failed download
        // followed by a local build could fill the disk before GC catches up.
        let staging = staging_dir(final_dir);
        let body_reader = resp.body.into_async_read();

        let _ = tokio::fs::remove_dir_all(&staging).await;
        if let Err(e) = tokio::fs::create_dir_all(&staging).await {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(R2DownloadError::Local(R2Error::Io(e)));
        }

        if let Err(e) = unpack_into_staging(body_reader, &staging).await {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(R2DownloadError::InvalidObject(e));
        }

        if let Err(e) = finalize_staging(&staging, final_dir).await {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(R2DownloadError::Local(e));
        }

        Ok(true)
    }

    /// Try to download `runner-templates/{hash}.tar.zst` and materialize its
    /// `template.ext4` member directly at `destination`. The archive is unpacked
    /// into a sibling staging directory first; only the template file is moved
    /// into place, and extra archive members are discarded with the staging dir.
    pub async fn try_download_template_to_file(
        &self,
        hash: &str,
        destination: &Path,
    ) -> Result<bool, R2DownloadError> {
        let key = key_for_template_hash(hash);
        self.try_download_template_file_by_key(&key, destination)
            .await
    }

    async fn try_download_template_file_by_key(
        &self,
        key: &str,
        destination: &Path,
    ) -> Result<bool, R2DownloadError> {
        let staging = file_staging_dir(destination);
        // Clean stale residue from a previously crashed download even if this
        // attempt later turns into a cache miss or request error. Successful
        // downloads also recreate this directory from scratch below.
        remove_dir_all_if_exists(&staging)
            .await
            .map_err(R2DownloadError::Local)?;

        let resp = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(r) => r,
            Err(SdkError::ServiceError(e))
                if matches!(
                    e.err(),
                    aws_sdk_s3::operation::get_object::GetObjectError::NoSuchKey(_)
                ) =>
            {
                return Ok(false);
            }
            Err(e) => {
                return Err(R2DownloadError::Request(R2Error::S3(format!(
                    "get_object {key}: {e:?}"
                ))));
            }
        };

        let Some(parent) = destination.parent() else {
            return Err(R2DownloadError::Local(R2Error::Io(io_other(format!(
                "destination has no parent: {}",
                destination.display()
            )))));
        };
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| R2DownloadError::Local(R2Error::Io(e)))?;

        let body_reader = resp.body.into_async_read();

        if let Err(e) = tokio::fs::create_dir_all(&staging).await {
            return Err(finish_file_staging_error(
                &staging,
                R2DownloadError::Local(R2Error::Io(e)),
            )
            .await);
        }

        if let Err(e) = unpack_into_staging(body_reader, &staging).await {
            return Err(
                finish_file_staging_error(&staging, R2DownloadError::InvalidObject(e)).await,
            );
        }

        let unpacked_template = staging.join(TEMPLATE_FILE);
        match tokio::fs::symlink_metadata(&unpacked_template).await {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::InvalidObject(R2Error::Io(io_other(
                        "template archive template.ext4 is not a regular file",
                    ))),
                )
                .await);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::InvalidObject(R2Error::Io(io_other(
                        "template archive missing template.ext4",
                    ))),
                )
                .await);
            }
            Err(e) => {
                return Err(finish_file_staging_error(
                    &staging,
                    R2DownloadError::Local(R2Error::Io(e)),
                )
                .await);
            }
        }

        if let Err(e) = tokio::fs::rename(&unpacked_template, destination).await {
            return Err(finish_file_staging_error(
                &staging,
                R2DownloadError::Local(R2Error::Io(e)),
            )
            .await);
        }
        remove_dir_all_if_exists(&staging)
            .await
            .map_err(R2DownloadError::Local)?;

        Ok(true)
    }
}

/// Finish the unpack: atomic rename `staging` to `final_dir`. Same-parent
/// rename is atomic on ext4/xfs.
#[cfg(test)]
pub(super) async fn finalize_staging(staging: &Path, final_dir: &Path) -> Result<(), R2Error> {
    if let Err(e) = tokio::fs::rename(staging, final_dir).await {
        // Expected recovery path: a previous `runner build` for this hash
        // crashed after creating final_dir but before the build finished.
        // Wipe the stale directory and retry the rename.
        tracing::info!(
            "{} already exists (likely stale from a partial run: {e}); replacing",
            final_dir.display()
        );
        if let Err(e) = tokio::fs::remove_dir_all(final_dir).await {
            // Log but keep trying the rename — it may still succeed if the
            // directory is empty/orphaned in a recoverable way.  EBUSY here
            // typically indicates a stale bind mount from a crashed snapshot
            // creation; the retry rename will then fail with the real cause.
            tracing::warn!("remove_dir_all {}: {e}", final_dir.display());
        }
        tokio::fs::rename(staging, final_dir).await?;
    }
    Ok(())
}

/// `images/{hash}` -> `images/{hash}.tmp` (sibling, same parent → atomic rename).
#[cfg(test)]
pub(super) fn staging_dir(final_dir: &Path) -> PathBuf {
    let mut name = final_dir
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    final_dir.with_file_name(name)
}

pub(super) fn file_staging_dir(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".download.tmp");
    destination.with_file_name(name)
}

async fn remove_dir_all_if_exists(path: &Path) -> Result<(), R2Error> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(R2Error::Io(e)),
    }
}

pub(super) async fn finish_file_staging_error(
    staging: &Path,
    original: R2DownloadError,
) -> R2DownloadError {
    match remove_dir_all_if_exists(staging).await {
        Ok(()) => original,
        Err(cleanup_err) => {
            tracing::warn!(
                "failed to remove download staging {} after an earlier error ({original}): {cleanup_err}",
                staging.display()
            );
            original
        }
    }
}
