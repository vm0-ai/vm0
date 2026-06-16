use std::path::{Path, PathBuf};

use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::head_object::HeadObjectError;

#[cfg(test)]
use super::keys::key_for_hash;
use super::{R2Error, R2ImageCache, keys::key_for_template_hash, multipart::MultipartUploadGuard};

impl R2ImageCache {
    /// Returns `Ok(true)` if the legacy `runner-images/{hash}.tar.zst` object exists.
    #[cfg(test)]
    pub async fn exists(&self, hash: &str) -> Result<bool, R2Error> {
        let key = key_for_hash(hash);
        self.exists_key(&key).await
    }

    async fn exists_key(&self, key: &str) -> Result<bool, R2Error> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(SdkError::ServiceError(e)) if matches!(e.err(), HeadObjectError::NotFound(_)) => {
                Ok(false)
            }
            Err(e) => Err(R2Error::S3(format!("head_object {key}: {e:?}"))),
        }
    }

    /// Pack `files` into `tar.zst` and stream-upload to `runner-images/{hash}.tar.zst`.
    /// No temp file: a tokio duplex pipe couples the synchronous tar+zstd
    /// producer (running on a blocking thread) to the async multipart consumer.
    ///
    /// **`force = false`** (the common case): skip the upload if the object
    /// already exists (head_object dedup) — saves bandwidth when peers have
    /// already uploaded the same hash.
    ///
    /// **`force = true`**: skip the dedup check and always upload, atomically
    /// replacing whatever is currently at the key. Used by `cmd::build` after
    /// detecting a corrupt prior upload (download succeeded but template.ext4
    /// is missing). Going through `delete + dedup-upload` would deadlock the
    /// fleet's cache if `DeleteObject` permission is missing or transiently
    /// failing — `force` keeps the overwrite on the multipart upload path and
    /// does not depend on `s3:DeleteObject`.
    ///
    /// The client is built from explicit R2 credentials, so it avoids AWS
    /// credential/endpoint discovery stalls. Outer call sites (CI/systemd)
    /// bound total wall time.
    #[cfg(test)]
    pub async fn upload(&self, hash: &str, files: &[PathBuf], force: bool) -> Result<(), R2Error> {
        let key = key_for_hash(hash);
        self.upload_key(&key, files, force).await
    }

    /// Upload a reusable template object under `runner-templates/`.
    pub async fn upload_template(
        &self,
        hash: &str,
        rootfs: &Path,
        force: bool,
    ) -> Result<(), R2Error> {
        let key = key_for_template_hash(hash);
        self.upload_key(&key, &[rootfs.to_path_buf()], force).await
    }

    /// Returns `Ok(true)` if the shared template object exists.
    pub async fn template_exists(&self, hash: &str) -> Result<bool, R2Error> {
        let key = key_for_template_hash(hash);
        self.exists_key(&key).await
    }

    async fn upload_key(&self, key: &str, files: &[PathBuf], force: bool) -> Result<(), R2Error> {
        if !force && self.exists_key(key).await? {
            tracing::info!("R2 already has {key}, skipping upload");
            return Ok(());
        }

        let create = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await?;
        let upload_id = create
            .upload_id()
            .ok_or_else(|| R2Error::S3("create_multipart_upload: no upload_id".into()))?
            .to_string();
        let mut upload_guard = MultipartUploadGuard::new(
            self.client.clone(),
            self.bucket.clone(),
            key.to_string(),
            upload_id,
        );

        // Run the full pack→stream→complete pipeline, then abort if anything
        // failed (including Complete itself — server-side validation errors
        // can fail Complete after all parts uploaded successfully).
        let result = self
            .do_multipart_upload(key, upload_guard.upload_id(), files)
            .await;
        if result.is_err() {
            // Best-effort abort; the guard remains armed if this await is
            // cancelled so Drop can still schedule a detached abort.
            upload_guard.abort().await;
        } else {
            upload_guard.disarm();
        }
        result
    }
}
