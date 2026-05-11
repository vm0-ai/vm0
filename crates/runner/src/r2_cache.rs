//! R2 cache for `runner build` template artifacts.
//!
//! The current shared cache stores reusable template objects at
//! `runner-templates/{template_hash}.tar.zst` in the existing
//! `R2_USER_STORAGES_BUCKET_NAME` bucket. Rootfs images are customized locally
//! because they contain guest binaries and host-local CA material.
//! Snapshot files are always created locally because they contain host-specific
//! state (page cache, kernel metadata).
//!
//! ## Lifecycle
//!
//! 1. `runner build` computes a `template_hash` for the shared R2 object and
//!    a separate `rootfs_hash` for local images.
//! 2. `--warm-rootfs-cache` ensures the template R2 object exists. Existing
//!    objects are checked with HEAD only; normal builds still validate the
//!    archive before using it.
//! 3. Normal builds materialize the template object into a per-attempt local
//!    file (or build/upload it on miss), move the verified template into
//!    `rootfs.ext4.staging`, customize the staging image locally, verify it,
//!    and then atomically commit the rootfs.
//!
//! Atomicity guarantees:
//! - Multipart upload is atomic from consumer POV (object only appears after
//!   `CompleteMultipartUpload`); abandoned segments are auto-cleaned by R2's
//!   default 7-day lifecycle.
//! - Template download unpacks into a sibling staging directory and only renames
//!   `template.ext4` into the caller's destination after the archive is fully
//!   decoded and validated.
//!
//! Configuration semantics: `from_env` returns `Ok(None)` only when **all four**
//! `R2_*` env vars are unset or empty (dev/test path). Setting 1-3 of 4 is a
//! fatal `PartialConfig` error — almost certainly a typo'd secret rotation, and
//! silently disabling cache fleet-wide is worse than failing the deploy.
//!
//! Streaming: upload avoids temp files by using a `tokio::io::duplex` pipe to
//! couple the sync tar+zstd producer (on a blocking thread) to the async
//! multipart consumer. Download streams the S3 body through `SyncIoBridge` into
//! a sibling staging directory, then renames the extracted `template.ext4` to
//! the caller's destination. Callers that coordinate shared output paths should
//! pass an attempt-scoped destination and perform their own final publish step.
//! Memory peak per upload ≈ `(2 + CONCURRENCY + 1) × PART_SIZE` — duplex buffer,
//! in-flight upload chunks, and the part being read — bounded regardless of
//! image size. Currently ~112 MiB with `PART_SIZE` = 16 MiB and `CONCURRENCY` = 4.
//!
//! Image size limit: `PART_SIZE * 10000 ≈ 160 GiB` (S3 multipart hard limit).
//! Current images are well under 30 GiB; revisit if `PART_SIZE` decreases.
//!
//! ## R2-side cleanup
//!
//! Completed objects are **never deleted on upload**. Each template cache version
//! bump or template build script change produces a new template hash and
//! orphans the previous object.
//!
//! Cleanup happens via `gc_older_than`, called from `runner gc` (which the
//! deploy playbook runs after every release). Default TTL is 7 days. Each
//! host runs the same scan independently — `DeleteObjects` is idempotent for
//! already-absent keys, so concurrent fleet execution is safe and costs
//! ~1 LIST + 1 batched DELETE per host per gc cycle.
//!
//! R2's default 7-day lifecycle rule only cleans abandoned multipart
//! segments, **not** completed objects — which is why we need our own scan.
//!
//! **Clock skew caveat**: `gc_older_than` uses local `SystemTime::now()` to
//! compute the cutoff. If the host clock drifts ahead of R2 server time by
//! more than the TTL, GC over-deletes (worst case: wipes everything older
//! than `now_local - keep_days`, even objects that were just uploaded by
//! peers with correct clocks). Mitigation: keep NTP healthy. A clock behind
//! R2 is the safe direction (under-deletes, no data loss).
//!
//! ## Cancellation safety
//!
//! All operations in this module are safe to cancel (drop the future) at any
//! await point — no permanent state is left in an inconsistent way:
//!
//! - **Local staging directory**: a hard-killed template download may leave a
//!   `*.download.tmp/` directory beside the destination. The next download
//!   removes it as the first action, so the leak is bounded to one stale dir
//!   per destination and self-heals on next attempt.
//! - **R2 multipart upload session**: once `create_multipart_upload` returns,
//!   an owned guard aborts the upload on normal errors and schedules a
//!   best-effort abort if the upload future is cancelled before disarm.
//! - **`spawn_blocking` pack / unpack tasks**: tokio cannot cancel
//!   blocking tasks. After parent cancellation, the producer/consumer
//!   thread runs until it hits BrokenPipe or natural EOF — wasted CPU for
//!   a few seconds, no resource leak.
//!
//! ## Corrupt-object eviction
//!
//! A structurally-valid archive whose extracted content lacks template.ext4
//! (e.g. uploaded by an old/buggy producer, or attacker-controlled IAM
//! key writing a bogus tar to a predicted hash key) would otherwise
//! dead-lock the fleet's cache for that hash: every host downloads → unpacks
//! → finds no template → rebuilds locally → dedup-skips upload because the bad
//! object already exists.
//!
//! `cmd::build::run_build` defends by passing `force = true` to upload
//! whenever template download classifies an object as invalid. That bypasses the
//! dedup check and atomically overwrites the bad object via multipart complete.
//!
//! ## Tar entry security
//!
//! The `tar` crate (0.4) has two relevant behaviors when consuming an
//! attacker-influenced archive:
//!
//! 1. **Path traversal (`..` components) is silently dropped**. Verified by
//!    `unpack_rejects_path_traversal`. The malicious entry is skipped; the
//!    staging dir ends up missing template.ext4; the template download helper
//!    rejects that as an invalid object and the caller rebuilds locally. Safe.
//!
//! 2. **Symlink and hardlink entries are rejected**. `unpack_from_reader`
//!    iterates entries and rejects any whose type is not `Regular`,
//!    `Continuous`, or `GNUSparse` — symlinks, hardlinks, character/block
//!    devices, FIFOs, and extended-header pseudo-entries all cause an
//!    immediate error, preventing an attacker with R2 write access from
//!    crafting a tar where expected filenames are symlinks to host paths.
//!    (`GNUSparse` is retained for forward compatibility with any future
//!    sparse file in the archive; template.ext4 itself is packed as a
//!    regular file.)
//!
//! **Maintenance note**: `try_download_template_file_by_key` verifies that the
//! archive contains `template.ext4` and classifies a missing file as an invalid
//! object. If you add a new required member to the template R2 archive, extend that
//! validation accordingly — otherwise an attacker-controlled tar that omits the
//! new file would go undetected.

use std::path::{Path, PathBuf};

use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, ResponseChecksumValidation, SharedCredentialsProvider,
};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::head_object::HeadObjectError;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier};
use tokio::io::AsyncReadExt;

const LEGACY_ROOTFS_KEY_PREFIX: &str = "runner-images/";
const TEMPLATE_KEY_PREFIX: &str = "runner-templates/";
const TEMPLATE_FILE: &str = "template.ext4";
const ZSTD_LEVEL: i32 = 3;

/// Multipart part size. R2 minimum is 5 MiB (except last part); 16 MiB
/// keeps part count reasonable for large images and fits comfortably in memory.
const PART_SIZE: usize = 16 * 1024 * 1024;

/// All four R2 env vars must be set together. Missing all four → cache disabled
/// (dev path); missing 1-3 → fatal misconfiguration.
const ENV_VARS: [&str; 4] = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_USER_STORAGES_BUCKET_NAME",
];

#[derive(Debug, thiserror::Error)]
pub enum R2Error {
    #[error("R2 partially configured ({}/4 set), missing: {}", present.len(), missing.join(", "))]
    PartialConfig {
        present: Vec<String>,
        missing: Vec<String>,
    },
    #[error("s3: {0}")]
    S3(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum R2DownloadError {
    #[error("request failed: {0}")]
    Request(#[source] R2Error),
    #[error("invalid cache object: {0}")]
    InvalidObject(#[source] R2Error),
    #[error("local filesystem failed: {0}")]
    Local(#[source] R2Error),
}

impl R2DownloadError {
    pub fn is_invalid_object(&self) -> bool {
        matches!(self, Self::InvalidObject(_))
    }
}

impl<E, R> From<SdkError<E, R>> for R2Error
where
    E: std::fmt::Debug,
    R: std::fmt::Debug,
{
    fn from(e: SdkError<E, R>) -> Self {
        Self::S3(format!("{e:?}"))
    }
}

/// Cache handle. Cheap to clone (the underlying SDK client is `Arc`-internal).
#[derive(Clone)]
pub struct R2ImageCache {
    client: aws_sdk_s3::Client,
    bucket: String,
}

impl std::fmt::Debug for R2ImageCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("R2ImageCache")
            .field("bucket", &self.bucket)
            .finish_non_exhaustive()
    }
}

impl R2ImageCache {
    /// Returns `Ok(None)` if all four env vars are unset or empty — build proceeds without R2.
    /// Returns `Ok(Some(_))` if all four are set to non-empty values.
    /// Returns `Err(PartialConfig { .. })` if 1-3 are set — likely a typo'd
    /// secret rotation; surface loudly rather than silently disable.
    ///
    /// Empty strings count as unset: callers (Ansible, GH Actions) often
    /// substitute `""` for missing secrets, and `""` is never a valid R2
    /// credential — treating it as unset is more robust than failing later.
    pub async fn from_env() -> Result<Option<Self>, R2Error> {
        let present: Vec<String> = ENV_VARS
            .iter()
            .filter(|v| std::env::var(v).map(|s| !s.is_empty()).unwrap_or(false))
            .map(|s| s.to_string())
            .collect();

        match present.len() {
            0 => return Ok(None),
            4 => {}
            _ => {
                let missing: Vec<String> = ENV_VARS
                    .iter()
                    .filter(|v| !present.iter().any(|p| p == *v))
                    .map(|s| s.to_string())
                    .collect();
                return Err(R2Error::PartialConfig { present, missing });
            }
        }

        // safe: all four guaranteed present (and non-empty) by the match above
        let account_id = std::env::var("R2_ACCOUNT_ID").map_err(io_other)?;
        let access_key = std::env::var("R2_ACCESS_KEY_ID").map_err(io_other)?;
        let secret_key = std::env::var("R2_SECRET_ACCESS_KEY").map_err(io_other)?;
        let bucket = std::env::var("R2_USER_STORAGES_BUCKET_NAME").map_err(io_other)?;

        let endpoint = format!("https://{account_id}.r2.cloudflarestorage.com");
        let creds = Credentials::new(access_key, secret_key, None, None, "r2-env");
        // Build the S3 config directly without going through `aws_config::defaults()`
        // — that's the entry point for the credential / region / endpoint discovery
        // chain, which can hit IMDS on EC2-like hosts and waste seconds on metal.
        // We have all four values explicitly, so skip the chain entirely.
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("auto"))
            .endpoint_url(endpoint)
            .credentials_provider(SharedCredentialsProvider::new(creds))
            // The SDK default enables GetObject checksum validation when supported.
            // R2/S3 multipart objects may return part-level checksums that the Rust
            // SDK cannot validate, which only produces noisy warnings. We do not
            // explicitly request checksum validation on R2 cache downloads.
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        let client = aws_sdk_s3::Client::from_conf(config);

        Ok(Some(Self { client, bucket }))
    }

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
        if !tokio::fs::try_exists(&unpacked_template)
            .await
            .unwrap_or(false)
        {
            return Err(finish_file_staging_error(
                &staging,
                R2DownloadError::InvalidObject(R2Error::Io(io_other(
                    "template archive missing template.ext4",
                ))),
            )
            .await);
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

    /// Delete legacy rootfs objects and shared template objects older
    /// than `max_age`. Returns `(deleted_count, freed_bytes)`. Idempotent under
    /// concurrent fleet execution: every host runs the same scan and
    /// `DeleteObjects` returns success for already-absent keys (S3 spec). Each
    /// invocation costs ~1 LIST + 1 batched DELETE per non-empty page.
    ///
    /// Per-key errors (e.g. AccessDenied — NOT NoSuchKey) are surfaced via
    /// `tracing::warn!` and excluded from `deleted_count`.
    pub async fn gc_older_than(&self, max_age: std::time::Duration) -> Result<(u64, u64), R2Error> {
        let cutoff = cutoff_unix_secs(std::time::SystemTime::now(), max_age)?;

        let mut total_deleted = 0u64;
        let mut total_freed = 0u64;
        for prefix in [LEGACY_ROOTFS_KEY_PREFIX, TEMPLATE_KEY_PREFIX] {
            let (deleted, freed) = self.gc_prefix_older_than(prefix, cutoff).await?;
            total_deleted = total_deleted.saturating_add(deleted);
            total_freed = total_freed.saturating_add(freed);
        }
        Ok((total_deleted, total_freed))
    }

    async fn gc_prefix_older_than(&self, prefix: &str, cutoff: i64) -> Result<(u64, u64), R2Error> {
        let mut continuation_token: Option<String> = None;
        let mut total_deleted = 0u64;
        let mut total_freed = 0u64;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);
            if let Some(token) = continuation_token.as_ref() {
                req = req.continuation_token(token);
            }
            let resp = req.send().await?;

            let (to_delete, batch_freed) = select_expired_in_page(resp.contents(), cutoff)?;

            if !to_delete.is_empty() {
                // S3 bounds list/delete pages at 1000 each, so usize→u64 never
                // saturates in practice; saturating-cast for style consistency
                // with the `u64::try_from(obj.size()...)` pattern elsewhere.
                let count = u64::try_from(to_delete.len()).unwrap_or(u64::MAX);
                let delete = Delete::builder()
                    .set_objects(Some(to_delete))
                    .quiet(true)
                    .build()
                    .map_err(|e| R2Error::S3(format!("Delete build: {e:?}")))?;
                let del_resp = self
                    .client
                    .delete_objects()
                    .bucket(&self.bucket)
                    .delete(delete)
                    .send()
                    .await?;
                // S3/R2 batch-delete returns per-key errors in `errors`; the
                // request itself is 200 OK regardless. Quiet mode means
                // successful deletes are NOT echoed, only failures are. Real
                // failures here = AccessDenied / quota / etc. — never
                // NoSuchKey, which the spec treats as success.
                let err_count = u64::try_from(del_resp.errors().len()).unwrap_or(u64::MAX);
                if err_count > 0 {
                    tracing::warn!(
                        "r2: delete_objects had {err_count} per-key failure(s); first: {:?}",
                        del_resp.errors().first()
                    );
                }
                let actual_deleted = count.saturating_sub(err_count);
                total_deleted = total_deleted.saturating_add(actual_deleted);
                // freed_bytes is best-effort: we don't know which specific
                // keys failed, so attribute proportionally.
                if count > 0 {
                    let proportional = batch_freed
                        .saturating_mul(actual_deleted)
                        .checked_div(count)
                        .unwrap_or(0);
                    total_freed = total_freed.saturating_add(proportional);
                }
            }

            if !resp.is_truncated().unwrap_or(false) {
                break;
            }
            // Both branches below validate at the S3-API boundary. They
            // surface as `R2Error::S3` (rather than silently breaking the
            // loop) so operators see clear errors when S3 misbehaves
            // instead of a quietly under-deleted GC cycle. `runner gc`
            // already logs and swallows R2 errors at the outer call site
            // (R2 errors never fail the deploy — see #9120).
            let next_token = resp
                .next_continuation_token()
                .ok_or_else(|| {
                    R2Error::S3(
                        "list_objects_v2: is_truncated=true with no \
                         next_continuation_token (R2/S3 spec violation)"
                            .into(),
                    )
                })?
                .to_string();
            if continuation_token.as_deref() == Some(next_token.as_str()) {
                return Err(R2Error::S3(format!(
                    "list_objects_v2 returned identical continuation_token \
                     twice ({next_token}) — pagination would loop indefinitely"
                )));
            }
            continuation_token = Some(next_token);
        }
        Ok((total_deleted, total_freed))
    }

    async fn do_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        files: &[PathBuf],
    ) -> Result<(), R2Error> {
        let parts = self.stream_upload(key, upload_id, files).await?;
        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(parts))
                    .build(),
            )
            .send()
            .await?;
        Ok(())
    }

    /// Stream-pack `files` and upload as multipart parts. Returns the completed
    /// parts list ready for `CompleteMultipartUpload`. Failure of either the
    /// producer (pack) or the consumer (upload) propagates as `Err`; the caller
    /// is responsible for aborting the multipart upload in that case.
    async fn stream_upload(
        &self,
        key: &str,
        upload_id: &str,
        files: &[PathBuf],
    ) -> Result<Vec<CompletedPart>, R2Error> {
        // Duplex buffer ≈ 2× PART_SIZE so the producer can stay one part ahead
        // of the consumer without backpressure stalls.
        let (writer, reader) = tokio::io::duplex(PART_SIZE * 2);
        let files_owned: Vec<PathBuf> = files.to_vec();

        // Producer: pack tar.zst into the duplex writer end, then drop everything
        // (which closes the writer, signalling EOF to the consumer).
        let pack_handle = tokio::task::spawn_blocking(move || -> Result<(), R2Error> {
            let sync_writer = tokio_util::io::SyncIoBridge::new(writer);
            pack_to_writer(sync_writer, &files_owned)
        });

        // Consumer: stream PART_SIZE chunks to S3 multipart with bounded
        // concurrency. If this errors, dropping `reader` closes the duplex pipe
        // and the producer will get a BrokenPipe write error.
        let parts_result = self.upload_parts_streaming(key, upload_id, reader).await;

        // Always wait for the producer to drain. A producer error matters even
        // if the consumer "succeeded" — it means parts contain truncated data.
        let pack_result = pack_handle.await.map_err(|e| R2Error::Io(io_other(e)))?;

        // Error precedence: consumer error wins (it's the original cause; pack's
        // BrokenPipe is downstream noise). If consumer succeeded but pack errored,
        // surface the pack error so the caller skips Complete.
        match (parts_result, pack_result) {
            (Err(consumer_err), _) => Err(consumer_err),
            (Ok(_), Err(pack_err)) => Err(pack_err),
            (Ok(parts), Ok(())) => Ok(parts),
        }
    }

    async fn upload_parts_streaming(
        &self,
        key: &str,
        upload_id: &str,
        mut reader: tokio::io::DuplexStream,
    ) -> Result<Vec<CompletedPart>, R2Error> {
        // Bounded concurrency: 4 in-flight parts gives ~75% reduction in wall
        // time vs serial without saturating the bucket's per-prefix throughput.
        const CONCURRENCY: usize = 4;

        let mut tasks: tokio::task::JoinSet<Result<(i32, CompletedPart), R2Error>> =
            tokio::task::JoinSet::new();
        let mut parts: Vec<(i32, CompletedPart)> = Vec::new();
        let mut part_number: i32 = 1;
        let mut eof = false;

        while !eof || !tasks.is_empty() {
            // Refill the in-flight window by reading and spawning more parts.
            while !eof && tasks.len() < CONCURRENCY {
                let mut buf = vec![0u8; PART_SIZE];
                let n = read_full(&mut reader, &mut buf).await?;
                if n == 0 {
                    eof = true;
                    break;
                }
                buf.truncate(n);
                // Vec → Bytes is zero-copy (transfers ownership). Avoids the
                // ~16 MiB memcpy per part that `to_vec()` would do.
                let chunk = bytes::Bytes::from(buf);
                let pn = part_number;
                let client = self.client.clone();
                let bucket = self.bucket.clone();
                let key_owned = key.to_string();
                let upload_id_owned = upload_id.to_string();
                tasks.spawn(async move {
                    let resp = client
                        .upload_part()
                        .bucket(&bucket)
                        .key(&key_owned)
                        .upload_id(&upload_id_owned)
                        .part_number(pn)
                        .body(ByteStream::from(chunk))
                        .send()
                        .await?;
                    // S3 / R2 always return ETag for a successful upload_part.
                    // A missing ETag here would silently produce a CompletedPart
                    // that fails Complete with "InvalidPart"; surface a clearer
                    // error pinned to the offending part_number instead.
                    let e_tag = resp
                        .e_tag()
                        .ok_or_else(|| {
                            R2Error::S3(format!("upload_part {pn}: missing e_tag in response"))
                        })?
                        .to_string();
                    Ok((
                        pn,
                        CompletedPart::builder()
                            .e_tag(e_tag)
                            .part_number(pn)
                            .build(),
                    ))
                });
                part_number = part_number
                    .checked_add(1)
                    .ok_or_else(|| R2Error::Io(io_other("part_number overflow")))?;
                if n < PART_SIZE {
                    eof = true;
                    break;
                }
            }

            // Drain at least one completion. JoinSet returns None only when
            // empty, which our outer loop condition prevents.
            if let Some(joined) = tasks.join_next().await {
                let (pn, part) = joined.map_err(|e| R2Error::Io(io_other(e)))??;
                parts.push((pn, part));
            }
        }

        // Parts must be in part_number order for CompleteMultipartUpload.
        parts.sort_by_key(|(pn, _)| *pn);
        Ok(parts.into_iter().map(|(_, p)| p).collect())
    }
}

struct MultipartUploadGuard {
    client: aws_sdk_s3::Client,
    bucket: String,
    key: String,
    upload_id: String,
    runtime: tokio::runtime::Handle,
    armed: bool,
}

impl MultipartUploadGuard {
    fn new(client: aws_sdk_s3::Client, bucket: String, key: String, upload_id: String) -> Self {
        Self {
            client,
            bucket,
            key,
            upload_id,
            runtime: tokio::runtime::Handle::current(),
            armed: true,
        }
    }

    fn upload_id(&self) -> &str {
        &self.upload_id
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn abort(&mut self) {
        if !self.armed {
            return;
        }
        abort_multipart_upload(
            self.client.clone(),
            self.bucket.clone(),
            self.key.clone(),
            self.upload_id.clone(),
            "failed multipart upload",
        )
        .await;
        self.disarm();
    }
}

impl Drop for MultipartUploadGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        drop(self.runtime.spawn(abort_multipart_upload(
            self.client.clone(),
            self.bucket.clone(),
            self.key.clone(),
            self.upload_id.clone(),
            "cancelled multipart upload",
        )));
    }
}

async fn abort_multipart_upload(
    client: aws_sdk_s3::Client,
    bucket: String,
    key: String,
    upload_id: String,
    reason: &'static str,
) {
    if let Err(e) = client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(&key)
        .upload_id(&upload_id)
        .send()
        .await
    {
        tracing::warn!(
            error = %e,
            key,
            upload_id,
            reason,
            "failed to abort R2 multipart upload"
        );
    }
}

#[cfg(test)]
fn key_for_hash(hash: &str) -> String {
    format!("{LEGACY_ROOTFS_KEY_PREFIX}{hash}.tar.zst")
}

fn key_for_template_hash(hash: &str) -> String {
    format!("{TEMPLATE_KEY_PREFIX}{hash}.tar.zst")
}

/// Filter a single ListObjectsV2 page down to the keys that should be
/// deleted (`last_modified < cutoff`), and sum their reported sizes.
/// Skips entries with no `last_modified` or no `key` (defensive — shouldn't
/// happen for real R2 responses but the SDK type makes them Optional).
/// Negative `size` values are clamped to 0 before being summed.
///
/// Boundary: an object whose `last_modified == cutoff` is **kept**
/// (`>= cutoff` is the skip condition). This biases toward retention.
fn select_expired_in_page(
    objects: &[aws_sdk_s3::types::Object],
    cutoff: i64,
) -> Result<(Vec<ObjectIdentifier>, u64), R2Error> {
    let mut to_delete: Vec<ObjectIdentifier> = Vec::new();
    let mut batch_freed = 0u64;
    for obj in objects {
        let Some(last_modified) = obj.last_modified() else {
            continue;
        };
        if last_modified.secs() >= cutoff {
            continue;
        }
        let Some(key) = obj.key() else { continue };
        let size = u64::try_from(obj.size().unwrap_or(0).max(0)).unwrap_or(0);
        let oid = ObjectIdentifier::builder()
            .key(key)
            .build()
            .map_err(|e| R2Error::S3(format!("ObjectIdentifier build: {e:?}")))?;
        to_delete.push(oid);
        batch_freed = batch_freed.saturating_add(size);
    }
    Ok((to_delete, batch_freed))
}

/// Compute the unix-seconds cutoff for "anything older than this is stale".
/// Returns an i64 to match aws_smithy_types::DateTime::secs(). Saturates to
/// 0 when `max_age` exceeds `now` (e.g. dev clock at epoch).
fn cutoff_unix_secs(
    now: std::time::SystemTime,
    max_age: std::time::Duration,
) -> Result<i64, R2Error> {
    let now_secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| R2Error::Io(io_other(e)))?
        .as_secs();
    let cutoff_secs = now_secs.saturating_sub(max_age.as_secs());
    i64::try_from(cutoff_secs)
        .map_err(|_| R2Error::Io(io_other("system clock beyond i64 unix-seconds range")))
}

/// Pack `files` as a tar.zst stream into `writer`. Each file is appended under
/// its basename only (no path components). Sync — call from spawn_blocking.
///
/// zstd encoding is multi-threaded (capped at 4 workers) so encoding stays
/// ahead of the multipart consumer instead of becoming the new bottleneck
/// after concurrent uploads.
fn pack_to_writer<W: std::io::Write>(writer: W, files: &[PathBuf]) -> Result<(), R2Error> {
    let mut encoder = zstd::stream::write::Encoder::new(writer, ZSTD_LEVEL)?;
    encoder.multithread(zstd_workers())?;
    let mut builder = tar::Builder::new(encoder);
    for path in files {
        let name = path.file_name().ok_or_else(|| {
            R2Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("file has no name: {}", path.display()),
            ))
        })?;
        builder.append_path_with_name(path, name)?;
    }
    // Explicit finalization order:
    //   1. tar trailer (two zero blocks)        — `into_inner` calls `finish` first
    //   2. zstd frame footer                     — `Encoder::finish`
    // Avoid `auto_finish()` which silently swallows errors during drop.
    let encoder = builder.into_inner()?;
    encoder.finish()?;
    Ok(())
}

/// Worker count for multi-threaded zstd encoding. Capped at 4 because:
/// - extra workers add memory (each gets its own input buffer)
/// - upload-side concurrency is also 4, so going wider gives diminishing returns
/// - tests run on possibly-small CI runners
fn zstd_workers() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(4) as u32)
        .unwrap_or(2)
}

/// Unpack a tar.zst stream from `reader` into `dest`. Sync — call from spawn_blocking.
///
/// Defense-in-depth: rejects any tar entry that is not a regular file or
/// GNU sparse file (symlinks, hardlinks, devices, etc.). An attacker with
/// R2 write access
/// could otherwise craft a tar where expected filenames are symlinks to
/// host paths, bypassing the caller's post-download rootfs check and
/// exposing host files to Firecracker. See module-level "Tar entry
/// security" docs.
fn unpack_from_reader<R: std::io::Read>(reader: R, dest: &Path) -> Result<(), R2Error> {
    let zr = zstd::stream::read::Decoder::new(reader)?;
    let mut archive = tar::Archive::new(zr);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if !matches!(
            kind,
            tar::EntryType::Regular | tar::EntryType::Continuous | tar::EntryType::GNUSparse
        ) {
            let path_display = entry
                .path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<invalid path>".into());
            return Err(R2Error::Io(std::io::Error::other(format!(
                "rejected non-regular tar entry (type {kind:?}): {path_display}"
            ))));
        }
        entry.unpack_in(dest)?;
    }
    Ok(())
}

/// Stream a tar.zst body from an async `reader` into `staging` (sync via
/// `SyncIoBridge` on a blocking thread). Caller is responsible for creating
/// the staging directory beforehand and for `finalize_staging` afterwards.
async fn unpack_into_staging<R>(reader: R, staging: &Path) -> Result<(), R2Error>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let staging_for_blocking = staging.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), R2Error> {
        let sync_reader = tokio_util::io::SyncIoBridge::new(reader);
        unpack_from_reader(sync_reader, &staging_for_blocking)
    })
    .await
    .map_err(|e| R2Error::Io(io_other(e)))?
}

/// Finish the unpack: atomic rename `staging` to `final_dir`. Same-parent
/// rename is atomic on ext4/xfs.
#[cfg(test)]
async fn finalize_staging(staging: &Path, final_dir: &Path) -> Result<(), R2Error> {
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
fn staging_dir(final_dir: &Path) -> PathBuf {
    let mut name = final_dir
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    final_dir.with_file_name(name)
}

fn file_staging_dir(destination: &Path) -> PathBuf {
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

async fn finish_file_staging_error(staging: &Path, original: R2DownloadError) -> R2DownloadError {
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

fn io_other<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// Read up to `buf.len()` bytes from `reader`, returning the actual count.
/// Returns 0 only at true EOF. Generic over any `AsyncRead` so we can use it
/// for both `tokio::fs::File` and `tokio::io::DuplexStream`.
async fn read_full<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<usize, R2Error> {
    let mut total = 0;
    while total < buf.len() {
        let slice = buf
            .get_mut(total..)
            .ok_or_else(|| R2Error::Io(io_other("buf overrun")))?;
        let n = reader.read(slice).await?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n)
            .ok_or_else(|| R2Error::Io(io_other("read offset overflow")))?;
    }
    Ok(total)
}

#[cfg(test)]
impl R2ImageCache {
    /// Test-only constructor. Lets unit tests inject a mock `aws_sdk_s3::Client`
    /// (built via `aws_smithy_mocks::mock_client!`) without going through
    /// `from_env`, which reads process env vars. Production code MUST construct
    /// via `from_env`.
    pub(crate) fn with_client(client: aws_sdk_s3::Client, bucket: String) -> Self {
        Self { client, bucket }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};

    /// Build a mock `R2ImageCache` from a set of rules. Use `RuleMode::MatchAny`
    /// (the issue's operations don't rely on ordered rule exhaustion; per-rule
    /// `match_requests` filters disambiguate overlap when present).
    fn mock_cache(bucket: &str, rules: &[&Rule]) -> R2ImageCache {
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, rules);
        R2ImageCache::with_client(client, bucket.to_string())
    }

    async fn wait_for_rule_calls(rule: &Rule, expected: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if rule.num_calls() == expected {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {expected} mock call(s)"));
    }

    #[test]
    fn key_format() {
        assert_eq!(key_for_hash("abc123"), "runner-images/abc123.tar.zst");
        assert_eq!(
            key_for_template_hash("abc123"),
            "runner-templates/abc123.tar.zst"
        );
    }

    // ---- cutoff math (gc_older_than helper) -----------------------------

    #[test]
    fn cutoff_subtracts_max_age_from_now() {
        let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let max_age = std::time::Duration::from_secs(1_000);
        assert_eq!(cutoff_unix_secs(now, max_age).unwrap(), 999_000);
    }

    #[test]
    fn cutoff_saturates_to_zero_when_age_exceeds_now() {
        // Defensive: a dev/test clock near epoch shouldn't underflow.
        let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(100);
        let max_age = std::time::Duration::from_secs(1_000);
        assert_eq!(cutoff_unix_secs(now, max_age).unwrap(), 0);
    }

    #[test]
    fn cutoff_zero_max_age_equals_now() {
        // `--r2-keep-days 0` is rejected at the CLI layer; this test exists
        // so a future caller can't silently regress that contract here.
        let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
        let zero = std::time::Duration::from_secs(0);
        assert_eq!(cutoff_unix_secs(now, zero).unwrap(), 42);
    }

    #[test]
    fn cutoff_with_duration_max_saturates_to_zero() {
        // Pathological input shouldn't underflow into a huge positive cutoff.
        let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        assert_eq!(cutoff_unix_secs(now, std::time::Duration::MAX).unwrap(), 0);
    }

    // ---- select_expired_in_page (gc_older_than filter) ------------------

    fn obj(key: &str, last_modified_secs: i64, size: i64) -> aws_sdk_s3::types::Object {
        aws_sdk_s3::types::Object::builder()
            .key(key)
            .last_modified(aws_sdk_s3::primitives::DateTime::from_secs(
                last_modified_secs,
            ))
            .size(size)
            .build()
    }

    #[test]
    fn select_expired_filters_by_cutoff() {
        let objects = [
            obj("old1", 100, 10),
            obj("fresh", 200, 20),
            obj("old2", 50, 30),
        ];
        let (selected, freed) = select_expired_in_page(&objects, 150).unwrap();
        let keys: Vec<&str> = selected.iter().map(|o| o.key.as_str()).collect();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&"old1"));
        assert!(keys.contains(&"old2"));
        assert!(!keys.contains(&"fresh"));
        assert_eq!(freed, 40); // 10 + 30
    }

    #[test]
    fn select_expired_keeps_object_at_exact_cutoff() {
        // `>=` is the skip predicate, so equality biases toward retention.
        // Important contract: an upload that just happened "right at" the
        // GC cycle's cutoff isn't aggressively swept.
        let objects = [obj("boundary", 100, 1)];
        let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
        assert_eq!(selected.len(), 0);
        assert_eq!(freed, 0);
    }

    #[test]
    fn select_expired_skips_object_without_last_modified() {
        // ListObjectsV2 always sets last_modified for real R2 responses,
        // but the SDK type is Option — guard the None branch.
        let objects = [aws_sdk_s3::types::Object::builder()
            .key("orphan")
            .size(10)
            .build()];
        let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
        assert_eq!(selected.len(), 0);
        assert_eq!(freed, 0);
    }

    #[test]
    fn select_expired_skips_object_without_key() {
        let objects = [aws_sdk_s3::types::Object::builder()
            .last_modified(aws_sdk_s3::primitives::DateTime::from_secs(50))
            .size(10)
            .build()];
        let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
        assert_eq!(selected.len(), 0);
        assert_eq!(freed, 0);
    }

    #[test]
    fn select_expired_clamps_negative_size_to_zero() {
        // Defensive against a pathological SDK / R2 response.
        let objects = [obj("weird", 50, -1)];
        let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(freed, 0);
    }

    #[test]
    fn select_expired_empty_page_returns_empty() {
        let (selected, freed) = select_expired_in_page(&[], 100).unwrap();
        assert!(selected.is_empty());
        assert_eq!(freed, 0);
    }

    #[test]
    fn staging_dir_is_sibling() {
        let final_dir = Path::new("/var/lib/vm0-runner/images/abc123");
        let staging = staging_dir(final_dir);
        assert_eq!(
            staging,
            PathBuf::from("/var/lib/vm0-runner/images/abc123.tmp")
        );
        // Same parent — required for atomic rename.
        assert_eq!(staging.parent(), final_dir.parent());
    }

    /// `from_env` requires all-or-nothing on the four env vars.
    /// Tests use a single var with each scenario via temporary process env;
    /// concurrent execution is safe — `with_clean_r2_env` serializes via
    /// `ENV_LOCK` so the snapshot/mutate/restore window is exclusive.
    #[tokio::test]
    async fn from_env_returns_none_when_all_missing() {
        with_clean_r2_env(|| async {
            let result = R2ImageCache::from_env().await.unwrap();
            assert!(result.is_none(), "all four missing → None");
        })
        .await;
    }

    #[tokio::test]
    async fn from_env_returns_some_when_all_present() {
        with_clean_r2_env(|| async {
            // SAFETY: env mutation is serialized by ENV_LOCK in with_clean_r2_env.
            unsafe {
                std::env::set_var("R2_ACCOUNT_ID", "test-account");
                std::env::set_var("R2_ACCESS_KEY_ID", "test-key");
                std::env::set_var("R2_SECRET_ACCESS_KEY", "test-secret");
                std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
            }
            let result = R2ImageCache::from_env().await.unwrap();
            assert!(result.is_some(), "all four set → Some");
            assert_eq!(result.unwrap().bucket, "test-bucket");
        })
        .await;
    }

    #[tokio::test]
    async fn from_env_treats_empty_string_as_unset() {
        // Callers often substitute "" for missing secrets (e.g.
        // `${R2_ACCOUNT_ID:-}` in shell, `lookup('env', ...)` in Ansible).
        // Empty strings are never valid R2 credentials — treat as unset.
        with_clean_r2_env(|| async {
            unsafe {
                for v in &ENV_VARS {
                    std::env::set_var(v, "");
                }
            }
            let result = R2ImageCache::from_env().await.unwrap();
            assert!(result.is_none(), "all four empty → None, not Some");
        })
        .await;
    }

    #[tokio::test]
    async fn from_env_errors_on_partial_config() {
        // Set 2 of 4 — should return PartialConfig with the right partition.
        with_clean_r2_env(|| async {
            unsafe {
                std::env::set_var("R2_ACCOUNT_ID", "test");
                std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "test");
            }
            let err = R2ImageCache::from_env().await.unwrap_err();
            match err {
                R2Error::PartialConfig { present, missing } => {
                    assert_eq!(present.len(), 2);
                    assert_eq!(missing.len(), 2);
                    assert!(present.contains(&"R2_ACCOUNT_ID".to_string()));
                    assert!(present.contains(&"R2_USER_STORAGES_BUCKET_NAME".to_string()));
                    assert!(missing.contains(&"R2_ACCESS_KEY_ID".to_string()));
                    assert!(missing.contains(&"R2_SECRET_ACCESS_KEY".to_string()));
                }
                e => panic!("expected PartialConfig, got {e:?}"),
            }
        })
        .await;
    }

    /// Process-wide lock that serializes env-mutating tests in this module so
    /// they're correct even when the test harness runs threads in parallel
    /// (CI uses `cargo llvm-cov` without `--test-threads=1`). Held across the
    /// inner `tokio::spawn(...).await` because env vars are process-global —
    /// without the lock, two concurrent tests would clobber each other's
    /// snapshot/restore. Async-aware so holding across await is sound.
    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Helper: snapshot and clear all R2 env vars before running, restore after.
    /// Panic-safe: the closure runs in a `tokio::spawn` task so a panic doesn't
    /// skip the restore. SAFETY of `set_var` / `remove_var`: serialized by
    /// `ENV_LOCK` above, so no concurrent env mutation can occur.
    async fn with_clean_r2_env<F, Fut>(f: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let _guard = ENV_LOCK.lock().await;
        let saved: Vec<(&str, Option<String>)> = ENV_VARS
            .iter()
            .map(|v| (*v, std::env::var(v).ok()))
            .collect();
        unsafe {
            for v in &ENV_VARS {
                std::env::remove_var(v);
            }
        }
        let join = tokio::spawn(f()).await;
        unsafe {
            for (k, v) in saved {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
        // Now propagate any panic from the test body so the test fails properly.
        join.unwrap();
    }

    // ---- pack / unpack round-trip --------------------------------------

    /// Write the rootfs file (the only file cached in R2) into `dir`.
    async fn write_mock_image_files(dir: &Path) -> Vec<PathBuf> {
        let rootfs = dir.join("rootfs.ext4");
        tokio::fs::write(&rootfs, b"rootfs-content".repeat(1024))
            .await
            .unwrap();
        vec![rootfs]
    }

    /// Helper: full atomic unpack from an on-disk archive (test-only path).
    /// Mirrors what `try_download` does after the S3 GET succeeds: open file,
    /// stream into staging, finalize. Lets the round-trip tests exercise the
    /// same code as production without an S3 mock.
    async fn unpack_archive_for_test(archive: &Path, final_dir: &Path) -> Result<(), R2Error> {
        let staging = staging_dir(final_dir);
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tokio::fs::create_dir_all(&staging).await?;
        let f = tokio::fs::File::open(archive).await?;
        unpack_into_staging(f, &staging).await?;
        finalize_staging(&staging, final_dir).await?;
        Ok(())
    }

    #[tokio::test]
    async fn pack_then_unpack_round_trips_rootfs() {
        let src_dir = tempfile::tempdir().unwrap();
        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash-abc");

        let src_files = write_mock_image_files(src_dir.path()).await;

        let archive = tempfile::NamedTempFile::new().unwrap();
        let archive_path = archive.path().to_path_buf();
        let files_for_pack = src_files.clone();
        tokio::task::spawn_blocking(move || {
            let f = std::fs::File::create(&archive_path).unwrap();
            pack_to_writer(f, &files_for_pack)
        })
        .await
        .unwrap()
        .unwrap();

        unpack_archive_for_test(archive.path(), &final_dir)
            .await
            .unwrap();

        let dst = final_dir.join("rootfs.ext4");
        let src = src_dir.path().join("rootfs.ext4");
        assert!(dst.exists(), "rootfs.ext4 should exist after unpack");
        let dst_meta = std::fs::metadata(&dst).unwrap();
        let src_meta = std::fs::metadata(&src).unwrap();
        assert_eq!(dst_meta.len(), src_meta.len(), "rootfs size mismatch");

        // Staging directory should no longer exist after the rename.
        assert!(!staging_dir(&final_dir).exists());
    }

    #[tokio::test]
    async fn unpack_atomic_no_partial_final_dir_on_failure() {
        // A truncated tar.zst (random bytes that aren't a valid zstd stream)
        // should fail mid-unpack and leave final_dir absent.
        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash-bad");

        let bad_archive = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(bad_archive.path(), b"not a valid zstd stream").unwrap();

        let result = unpack_archive_for_test(bad_archive.path(), &final_dir).await;
        assert!(result.is_err(), "unpack of garbage should fail");
        assert!(
            !final_dir.exists(),
            "final_dir must NOT exist after a failed unpack — \
             this is what prevents false-positive cache hits"
        );
    }

    #[tokio::test]
    async fn pack_uses_basename_only() {
        // Files passed to pack_to_writer may have arbitrary parent paths;
        // they should be stored under their basename in the tar so unpack
        // produces a flat directory.
        let src_dir = tempfile::tempdir().unwrap();
        let nested = src_dir.path().join("deeply/nested/path");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        let nested_file = nested.join("rootfs.ext4");
        tokio::fs::write(&nested_file, b"hello").await.unwrap();

        let archive = tempfile::NamedTempFile::new().unwrap();
        let archive_path = archive.path().to_path_buf();
        let files = vec![nested_file];
        tokio::task::spawn_blocking(move || {
            let f = std::fs::File::create(&archive_path).unwrap();
            pack_to_writer(f, &files)
        })
        .await
        .unwrap()
        .unwrap();

        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("out");
        unpack_archive_for_test(archive.path(), &final_dir)
            .await
            .unwrap();

        assert!(final_dir.join("rootfs.ext4").exists());
        // No nested directory in the unpacked output.
        assert!(!final_dir.join("deeply").exists());
    }

    #[tokio::test]
    async fn from_env_errors_on_partial_with_some_empty_strings() {
        // Real-world misconfiguration: 2 secrets typo'd to empty, 2 set.
        // Empty counts as unset (per from_env_treats_empty_string_as_unset),
        // so this should be PartialConfig with present=2, missing=2 — NOT
        // silently disabled (which would happen if all four were empty).
        with_clean_r2_env(|| async {
            unsafe {
                std::env::set_var("R2_ACCOUNT_ID", "real-value");
                std::env::set_var("R2_ACCESS_KEY_ID", ""); // typo'd to empty
                std::env::set_var("R2_SECRET_ACCESS_KEY", ""); // typo'd to empty
                std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "real-value");
            }
            let err = R2ImageCache::from_env().await.unwrap_err();
            match err {
                R2Error::PartialConfig { present, missing } => {
                    assert_eq!(present.len(), 2, "two non-empty present");
                    assert_eq!(missing.len(), 2, "two empty treated as missing");
                    assert!(missing.contains(&"R2_ACCESS_KEY_ID".to_string()));
                    assert!(missing.contains(&"R2_SECRET_ACCESS_KEY".to_string()));
                }
                e => panic!("expected PartialConfig, got {e:?}"),
            }
        })
        .await;
    }

    // ---- defensive / security edge cases --------------------------------

    /// Helper: pack a synchronous closure on a blocking thread.
    async fn pack_blocking<F>(archive: &Path, f: F) -> Result<(), R2Error>
    where
        F: FnOnce(std::fs::File) -> Result<(), R2Error> + Send + 'static,
    {
        let p = archive.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let out = std::fs::File::create(&p).unwrap();
            f(out)
        })
        .await
        .unwrap()
    }

    /// Hand-write a 512-byte ustar header so we can put `..` in the path —
    /// `tar::Builder` defends against this on the write side too.
    fn craft_tar_with_path(name: &[u8], data: &[u8]) -> Vec<u8> {
        assert!(name.len() < 100);
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        let size_str = format!("{:011o}\0", data.len());
        header[124..136].copy_from_slice(size_str.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        // cksum is computed with these 8 bytes counted as spaces.
        header[148..156].copy_from_slice(b"        ");
        header[156] = b'0'; // typeflag: regular file
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let cksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
        let cksum_str = format!("{cksum:06o}\0 ");
        header[148..156].copy_from_slice(cksum_str.as_bytes());

        let mut tar = Vec::with_capacity(512 + 512 + 1024);
        tar.extend_from_slice(&header);
        let mut data_block = [0u8; 512];
        data_block[..data.len()].copy_from_slice(data);
        tar.extend_from_slice(&data_block);
        // Two zero blocks mark end-of-archive.
        tar.extend_from_slice(&[0u8; 1024]);
        tar
    }

    /// Hand-write a ustar header with a specific typeflag byte. Used to test
    /// that `unpack_from_reader` rejects non-regular entries.
    /// `typeflag`: `b'2'` = symlink, `b'1'` = hardlink, etc.
    /// `link_target`: written into the linkname field (bytes 157..257).
    fn craft_tar_with_typeflag(name: &[u8], typeflag: u8, link_target: &[u8]) -> Vec<u8> {
        assert!(name.len() < 100);
        assert!(link_target.len() < 100);
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        // size = 0 for symlinks/hardlinks
        header[124..136].copy_from_slice(b"00000000000\0");
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].copy_from_slice(b"        ");
        header[156] = typeflag;
        header[157..157 + link_target.len()].copy_from_slice(link_target);
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let cksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
        let cksum_str = format!("{cksum:06o}\0 ");
        header[148..156].copy_from_slice(cksum_str.as_bytes());

        let mut tar = Vec::with_capacity(512 + 1024);
        tar.extend_from_slice(&header);
        // No data blocks for symlinks/hardlinks. Two zero blocks = end-of-archive.
        tar.extend_from_slice(&[0u8; 1024]);
        tar
    }

    /// `tar::Archive::unpack` must reject entries whose path escapes via `..` so
    /// attacker-controlled artifacts can't write outside the staging directory
    /// (defense-in-depth — R2 bucket is private, but if an IAM key leaked, this
    /// would prevent escalation).
    #[tokio::test]
    async fn unpack_rejects_path_traversal() {
        let raw_tar = craft_tar_with_path(b"../escaped.txt", b"hello");
        let archive = tempfile::NamedTempFile::new().unwrap();
        let archive_path = archive.path().to_path_buf();
        tokio::task::spawn_blocking(move || {
            let out = std::fs::File::create(&archive_path).unwrap();
            let mut zw = zstd::stream::write::Encoder::new(out, 1).unwrap();
            std::io::Write::write_all(&mut zw, &raw_tar).unwrap();
            zw.finish().unwrap();
        })
        .await
        .unwrap();

        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");
        // tar 0.4 silently SKIPS entries with `..` components (returns Ok(false)
        // from Entry::unpack_in) and Archive::unpack happily continues. So the
        // unpack succeeds with an empty staging dir → finalize_staging renames
        // it to final_dir which exists but is empty. The security invariant is
        // not "must error" — it is "must not write outside dst".
        unpack_archive_for_test(archive.path(), &final_dir)
            .await
            .unwrap();

        // Critical: nothing escaped to the parent of staging/final_dir.
        assert!(
            !dst_root.path().join("escaped.txt").exists(),
            "escaped.txt MUST NOT appear at the dst_root level"
        );
        // The malicious entry was dropped, so final_dir is empty.
        let entries: Vec<_> = std::fs::read_dir(&final_dir).unwrap().collect();
        assert!(
            entries.is_empty(),
            "malicious entry should be dropped, final_dir empty, got {entries:?}"
        );
    }

    /// Helper: assert that a tar with the given typeflag is rejected by
    /// `unpack_from_reader`. Covers symlink, hardlink, and any other
    /// non-regular entry type.
    async fn assert_unpack_rejects_typeflag(typeflag: u8, link_target: &[u8]) {
        let raw_tar = craft_tar_with_typeflag(b"rootfs.ext4", typeflag, link_target);
        let archive = tempfile::NamedTempFile::new().unwrap();
        let archive_path = archive.path().to_path_buf();
        tokio::task::spawn_blocking(move || {
            let out = std::fs::File::create(&archive_path).unwrap();
            let mut zw = zstd::stream::write::Encoder::new(out, 1).unwrap();
            std::io::Write::write_all(&mut zw, &raw_tar).unwrap();
            zw.finish().unwrap();
        })
        .await
        .unwrap();

        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");
        let err = unpack_archive_for_test(archive.path(), &final_dir)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("rejected non-regular tar entry"),
            "expected rejection error, got: {msg}"
        );
        assert!(
            !final_dir.exists(),
            "final_dir must not be created on error"
        );
    }

    /// Symlink entries must be rejected — an attacker could point
    /// `rootfs.ext4` at `/etc/shadow` to leak host file contents.
    #[tokio::test]
    async fn unpack_rejects_symlink_entries() {
        assert_unpack_rejects_typeflag(b'2', b"/etc/shadow").await;
    }

    /// Hardlink entries must be rejected — could alias existing host files.
    #[tokio::test]
    async fn unpack_rejects_hardlink_entries() {
        assert_unpack_rejects_typeflag(b'1', b"/etc/passwd").await;
    }

    /// `finalize_staging` performs the atomic rename for a rootfs-only archive.
    #[tokio::test]
    async fn finalize_renames_rootfs_only_staging() {
        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");
        let staging = staging_dir(&final_dir);
        tokio::fs::create_dir_all(&staging).await.unwrap();
        tokio::fs::write(staging.join("rootfs.ext4"), b"data")
            .await
            .unwrap();

        finalize_staging(&staging, &final_dir).await.unwrap();

        assert!(final_dir.exists());
        assert!(final_dir.join("rootfs.ext4").exists());
        assert!(!staging.exists(), "staging consumed by rename");
    }

    /// Defensive retry path: when `final_dir` already exists, `rename` fails
    /// once, the function removes the destination, and retries.
    #[tokio::test]
    async fn finalize_overwrites_existing_final_dir() {
        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");

        // Pre-populate `final_dir` with stale content the test will overwrite.
        tokio::fs::create_dir_all(&final_dir).await.unwrap();
        tokio::fs::write(final_dir.join("stale.txt"), b"old")
            .await
            .unwrap();

        // Build fresh staging.
        let staging = staging_dir(&final_dir);
        tokio::fs::create_dir_all(&staging).await.unwrap();
        tokio::fs::write(staging.join("fresh.txt"), b"new")
            .await
            .unwrap();

        finalize_staging(&staging, &final_dir).await.unwrap();

        assert!(final_dir.join("fresh.txt").exists(), "new content arrived");
        assert!(
            !final_dir.join("stale.txt").exists(),
            "old content was wiped before rename"
        );
    }

    /// `pack_to_writer` propagates I/O errors from `append_path_with_name` —
    /// e.g., source file removed between `expected_files()` enumeration and pack.
    #[tokio::test]
    async fn pack_errors_on_missing_source_file() {
        let archive = tempfile::NamedTempFile::new().unwrap();
        let nonexistent = PathBuf::from("/definitely/does/not/exist/rootfs.ext4");
        let result = pack_blocking(archive.path(), move |out| {
            pack_to_writer(out, std::slice::from_ref(&nonexistent))
        })
        .await;
        match result {
            Err(R2Error::Io(_)) => {} // expected
            other => panic!("expected R2Error::Io for missing source, got {other:?}"),
        }
    }

    /// `R2ImageCache::Debug` must not leak credentials — if logs ever capture
    /// `{:?}` on a cache (e.g. via `tracing` instrumentation), only the
    /// bucket name should appear, not account_id / access_key / secret.
    #[tokio::test]
    async fn debug_format_does_not_leak_credentials() {
        with_clean_r2_env(|| async {
            // SAFETY: env mutation is serialized by ENV_LOCK in with_clean_r2_env.
            unsafe {
                std::env::set_var("R2_ACCOUNT_ID", "secret-account-id-do-not-leak");
                std::env::set_var("R2_ACCESS_KEY_ID", "AKIAEXAMPLEDONOTLEAK");
                std::env::set_var("R2_SECRET_ACCESS_KEY", "secret-key-MUST-NOT-appear-in-logs");
                std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
            }
            let cache = R2ImageCache::from_env().await.unwrap().unwrap();
            let dbg = format!("{cache:?}");
            assert!(
                !dbg.contains("secret-account-id-do-not-leak"),
                "Debug leaked account_id: {dbg}"
            );
            assert!(
                !dbg.contains("AKIAEXAMPLEDONOTLEAK"),
                "Debug leaked access_key_id: {dbg}"
            );
            assert!(
                !dbg.contains("secret-key-MUST-NOT-appear-in-logs"),
                "Debug leaked secret_key: {dbg}"
            );
            assert!(
                dbg.contains("test-bucket"),
                "Debug should still expose bucket for diagnostic value: {dbg}"
            );
        })
        .await;
    }

    /// Empty file list: pack succeeds and produces a valid (empty) tar.zst.
    /// Round-trip unpack gives an empty `final_dir`. This is degenerate but
    /// must not panic — it's the canary for the caller's post-download
    /// completeness check (currently: rootfs.ext4 presence) to catch.
    #[tokio::test]
    async fn pack_unpack_empty_files_list() {
        let archive = tempfile::NamedTempFile::new().unwrap();
        pack_blocking(archive.path(), |out| pack_to_writer(out, &[]))
            .await
            .unwrap();

        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");
        unpack_archive_for_test(archive.path(), &final_dir)
            .await
            .unwrap();

        assert!(final_dir.exists());
        let entries: Vec<_> = std::fs::read_dir(&final_dir).unwrap().collect();
        assert!(
            entries.is_empty(),
            "empty pack → empty unpack, got {entries:?}"
        );
    }

    // ---- S3 mock smoke test --------------------------------------------
    //
    // Proves that `R2ImageCache::with_client` + the `mock_client!` macro
    // dispatch correctly through to a real `aws_sdk_s3::Client`. Detailed
    // coverage of `exists`, `upload`, `try_download`, `gc_older_than` against
    // mocked S3 responses lives in the test modules added by subsequent
    // commits.

    #[tokio::test]
    async fn with_client_dispatches_through_mock() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let cache = mock_cache("test-bucket", &[&head]);
        assert!(cache.exists("any-hash").await.unwrap());
        assert_eq!(head.num_calls(), 1);
    }

    // ---- upload: force + dedup + multipart lifecycle -------------------
    //
    // Size the payload below `PART_SIZE` (16 MiB) so the happy path issues
    // exactly one `upload_part` — keeps mock setup compact. Multi-part
    // correctness is already exercised structurally by the pack/unpack
    // round-trip test.

    /// Write one small file (1 KiB) that `upload()` will pack into a tar.zst.
    async fn small_src_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rootfs.ext4");
        tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();
        (dir, path)
    }

    /// Mock-rule factory for the happy-path multipart triad.
    /// Returns (create, upload_part, complete) rules. Caller wires them with
    /// any head_object rule needed by the specific test.
    fn multipart_success_rules() -> (Rule, Rule, Rule) {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
        use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
        use aws_sdk_s3::operation::upload_part::UploadPartOutput;

        let create = mock!(Client::create_multipart_upload).then_output(|| {
            CreateMultipartUploadOutput::builder()
                .upload_id("test-upload-id")
                .build()
        });
        let upload_part = mock!(Client::upload_part)
            .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
        let complete = mock!(Client::complete_multipart_upload)
            .then_output(|| CompleteMultipartUploadOutput::builder().build());
        (create, upload_part, complete)
    }

    /// `force = true` MUST NOT call `head_object` — the corrupt-eviction
    /// contract: after detecting a bad object (download succeeded but
    /// rootfs.ext4 missing), the caller relies on `upload(_, _, true)` to
    /// force-overwrite without re-checking existence (which would still
    /// say "exists, skip").
    #[tokio::test]
    async fn upload_force_true_bypasses_exists_check() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

        let (_dir, path) = small_src_file().await;
        cache.upload("abc", &[path], true).await.unwrap();

        assert_eq!(head.num_calls(), 0, "force=true must skip head_object");
        assert_eq!(create.num_calls(), 1);
        assert_eq!(upload_part.num_calls(), 1);
        assert_eq!(complete.num_calls(), 1);
    }

    /// `force = false` + object exists → dedup-skip; multipart triad never
    /// runs. Saves bandwidth across peer hosts.
    #[tokio::test]
    async fn upload_force_false_dedup_skips_when_exists() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

        let (_dir, path) = small_src_file().await;
        cache.upload("abc", &[path], false).await.unwrap();

        assert_eq!(head.num_calls(), 1, "head_object consulted exactly once");
        assert_eq!(
            create.num_calls(),
            0,
            "dedup short-circuits before multipart"
        );
        assert_eq!(upload_part.num_calls(), 0);
        assert_eq!(complete.num_calls(), 0);
    }

    /// `force = false` + `head_object` returns `NotFound` → proceed through
    /// the full multipart pipeline. Distinct from force=true (which skips
    /// head entirely) because here head IS consulted, it just returns miss.
    #[tokio::test]
    async fn upload_force_false_proceeds_when_not_found() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectError;
        use aws_sdk_s3::types::error::NotFound;

        let head = mock!(Client::head_object)
            .then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

        let (_dir, path) = small_src_file().await;
        cache.upload("abc", &[path], false).await.unwrap();

        assert_eq!(head.num_calls(), 1);
        assert_eq!(create.num_calls(), 1);
        assert_eq!(complete.num_calls(), 1);
    }

    #[tokio::test]
    async fn upload_template_uses_template_prefix() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
        use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
        use aws_sdk_s3::operation::upload_part::UploadPartOutput;

        let create = mock!(Client::create_multipart_upload)
            .match_requests(|req| {
                req.bucket() == Some("test-bucket")
                    && req.key() == Some("runner-templates/abc.tar.zst")
            })
            .then_output(|| {
                CreateMultipartUploadOutput::builder()
                    .upload_id("test-upload-id")
                    .build()
            });
        let upload_part = mock!(Client::upload_part)
            .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
        let complete = mock!(Client::complete_multipart_upload)
            .then_output(|| CompleteMultipartUploadOutput::builder().build());
        let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete]);

        let (_dir, path) = small_src_file().await;
        cache.upload_template("abc", &path, true).await.unwrap();

        assert_eq!(create.num_calls(), 1);
        assert_eq!(upload_part.num_calls(), 1);
        assert_eq!(complete.num_calls(), 1);
    }

    /// `complete_multipart_upload` failure (server-side validation after all
    /// parts uploaded) MUST trigger `abort_multipart_upload`. Without this,
    /// the abandoned upload_id lingers until R2's 7-day lifecycle sweeps it.
    #[tokio::test]
    async fn upload_aborts_multipart_when_complete_fails() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
        use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
        use aws_sdk_s3::operation::upload_part::UploadPartOutput;

        let create = mock!(Client::create_multipart_upload).then_output(|| {
            CreateMultipartUploadOutput::builder()
                .upload_id("test-upload-id")
                .build()
        });
        let upload_part = mock!(Client::upload_part)
            .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
        // CompleteMultipartUpload returns a 500 so the SDK surfaces it as an
        // SdkError — r2_cache converts that to R2Error::S3 via the From impl.
        // Using `http_status` (provided by `aws-smithy-mocks`) avoids
        // pulling `aws-smithy-types` / `aws-smithy-runtime-api` in as
        // explicit dev-deps.
        let complete = mock!(Client::complete_multipart_upload)
            .sequence()
            .http_status(
                500,
                Some("<Error><Code>InternalError</Code></Error>".into()),
            )
            .build();
        let abort = mock!(Client::abort_multipart_upload)
            .then_output(|| AbortMultipartUploadOutput::builder().build());

        let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete, &abort]);

        let (_dir, path) = small_src_file().await;
        let result = cache.upload("abc", &[path], true).await;

        assert!(matches!(result, Err(R2Error::S3(_))), "got {result:?}");
        assert!(complete.num_calls() >= 1, "complete was dispatched");
        // abort is the contract under test; exactly one abort is expected
        // even if the SDK retried `complete` internally — r2_cache issues
        // one best-effort abort per failed upload (not per retry).
        assert_eq!(abort.num_calls(), 1, "abort MUST run on Complete failure");
    }

    /// Dropping the upload future after `CreateMultipartUpload` must not leave
    /// server-side multipart state behind until R2 lifecycle cleanup. The guard
    /// schedules a detached abort on drop, which is the cancellation path that
    /// normal error-return tests do not exercise.
    #[tokio::test]
    async fn multipart_upload_guard_aborts_on_drop() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;

        let abort = mock!(Client::abort_multipart_upload)
            .match_requests(|req| {
                req.bucket() == Some("test-bucket")
                    && req.key() == Some("runner-templates/abc.tar.zst")
                    && req.upload_id() == Some("test-upload-id")
            })
            .then_output(|| AbortMultipartUploadOutput::builder().build());
        let cache = mock_cache("test-bucket", &[&abort]);

        drop(MultipartUploadGuard::new(
            cache.client.clone(),
            cache.bucket.clone(),
            key_for_template_hash("abc"),
            "test-upload-id".to_string(),
        ));

        wait_for_rule_calls(&abort, 1).await;
    }

    /// Missing `e_tag` on `upload_part` response → `R2Error::S3` with the
    /// part_number interpolated, so operators can pin a `Complete`-time
    /// "InvalidPart" to the specific failed upload without log archaeology.
    #[tokio::test]
    async fn upload_part_missing_etag_errors_with_part_number() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
        use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
        use aws_sdk_s3::operation::upload_part::UploadPartOutput;

        let create = mock!(Client::create_multipart_upload).then_output(|| {
            CreateMultipartUploadOutput::builder()
                .upload_id("test-upload-id")
                .build()
        });
        // Response with no `e_tag`: surfaces as pinned error, Complete never
        // runs (pack→stream→complete pipeline short-circuits on upload error).
        let upload_part =
            mock!(Client::upload_part).then_output(|| UploadPartOutput::builder().build());
        // Abort is best-effort on any error path — include a mock so the SDK
        // dispatch doesn't panic on unmatched.
        let abort = mock!(Client::abort_multipart_upload)
            .then_output(|| AbortMultipartUploadOutput::builder().build());

        let cache = mock_cache("test-bucket", &[&create, &upload_part, &abort]);

        let (_dir, path) = small_src_file().await;
        let err = cache.upload("abc", &[path], true).await.unwrap_err();

        match err {
            R2Error::S3(msg) => {
                assert!(
                    msg.contains("upload_part 1"),
                    "want pinned part_number: {msg}"
                );
                assert!(msg.contains("missing e_tag"), "want missing e_tag: {msg}");
            }
            other => panic!("expected R2Error::S3 with pinned part_number, got {other:?}"),
        }
    }

    // ---- exists + try_download error mapping and staging cleanup -------

    /// `exists()` MUST map `HeadObjectError::NotFound` to `Ok(false)` — that's
    /// what distinguishes a genuine cache miss from an error the caller
    /// should log and back off on. Flip the mapping and operators get silent
    /// re-uploads on AccessDenied.
    #[tokio::test]
    async fn exists_returns_false_on_not_found() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectError;
        use aws_sdk_s3::types::error::NotFound;

        let head = mock!(Client::head_object)
            .then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
        let cache = mock_cache("test-bucket", &[&head]);
        assert!(!cache.exists("any").await.unwrap());
        assert_eq!(head.num_calls(), 1);
    }

    /// `try_download()` MUST map `GetObjectError::NoSuchKey` to `Ok(false)`
    /// (symmetric to `exists_returns_false_on_not_found`). It also MUST NOT
    /// create a staging directory for a miss — the caller falls back to
    /// local build and expects `final_dir` absent.
    #[tokio::test]
    async fn try_download_returns_false_on_no_such_key() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectError;
        use aws_sdk_s3::types::error::NoSuchKey;

        let get = mock!(Client::get_object)
            .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let final_dir = dst.path().join("hash");
        let result = cache.try_download("hash", &final_dir).await.unwrap();

        assert!(!result, "NoSuchKey → Ok(false)");
        assert!(!final_dir.exists(), "final_dir MUST remain absent on miss");
        assert!(
            !staging_dir(&final_dir).exists(),
            "no staging dir on miss (short-circuit before staging creation)"
        );
    }

    /// Pack a tar.zst archive from a test file in-memory. Used to synthesize
    /// a valid body for a mocked `get_object` response.
    async fn build_test_archive_bytes() -> Vec<u8> {
        let src = tempfile::tempdir().unwrap();
        let name = src.path().join("rootfs.ext4");
        tokio::fs::write(&name, b"hello").await.unwrap();
        let files = vec![name];
        // `src` lives until this fn returns, which happens after the await
        // resolves — by which point `pack_to_writer` has finished reading
        // the file. Natural drop at end-of-scope is sufficient.
        tokio::task::spawn_blocking(move || {
            let mut buf: Vec<u8> = Vec::new();
            pack_to_writer(&mut buf, &files).unwrap();
            buf
        })
        .await
        .unwrap()
    }

    async fn build_template_archive_bytes() -> Vec<u8> {
        let src = tempfile::tempdir().unwrap();
        let name = src.path().join(TEMPLATE_FILE);
        tokio::fs::write(&name, b"hello").await.unwrap();
        let files = vec![name];
        tokio::task::spawn_blocking(move || {
            let mut buf: Vec<u8> = Vec::new();
            pack_to_writer(&mut buf, &files).unwrap();
            buf
        })
        .await
        .unwrap()
    }

    async fn build_template_archive_bytes_with_extra() -> Vec<u8> {
        let src = tempfile::tempdir().unwrap();
        let template = src.path().join(TEMPLATE_FILE);
        let extra = src.path().join("extra.txt");
        tokio::fs::write(&template, b"hello").await.unwrap();
        tokio::fs::write(&extra, b"discard me").await.unwrap();
        let files = vec![template, extra];
        tokio::task::spawn_blocking(move || {
            let mut buf: Vec<u8> = Vec::new();
            pack_to_writer(&mut buf, &files).unwrap();
            buf
        })
        .await
        .unwrap()
    }

    async fn build_empty_archive_bytes() -> Vec<u8> {
        tokio::task::spawn_blocking(move || {
            let mut buf: Vec<u8> = Vec::new();
            pack_to_writer(&mut buf, &[]).unwrap();
            buf
        })
        .await
        .unwrap()
    }

    async fn zstd_bytes(raw_tar: Vec<u8>) -> Vec<u8> {
        tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            let mut encoder = zstd::stream::write::Encoder::new(&mut out, 1).unwrap();
            std::io::Write::write_all(&mut encoder, &raw_tar).unwrap();
            encoder.finish().unwrap();
            out
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn try_download_template_materializes_template_file() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_template_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object)
            .match_requests(|req| {
                req.bucket() == Some("test-bucket")
                    && req.key() == Some("runner-templates/hash.tar.zst")
            })
            .then_output(move || {
                GetObjectOutput::builder()
                    .body(ByteStream::from((*archive_for_closure).clone()))
                    .build()
            });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");

        let result = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap();

        assert!(result, "valid template body → Ok(true)");
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned"
        );
    }

    #[tokio::test]
    async fn try_download_template_replaces_existing_destination_on_valid_archive() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_template_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");
        tokio::fs::write(&destination, b"old-rootfs").await.unwrap();

        let result = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap();

        assert!(result, "valid template body -> Ok(true)");
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned"
        );
    }

    #[tokio::test]
    async fn try_download_template_rejects_path_traversal_archive() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(zstd_bytes(craft_tar_with_path(b"../escaped.txt", b"bad")).await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");

        let err = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap_err();

        assert!(
            matches!(err, R2DownloadError::InvalidObject(_)),
            "path traversal archive must be classified as invalid cache object, got {err:?}"
        );
        assert!(!dst.path().join("escaped.txt").exists());
        assert!(!destination.exists());
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned"
        );
    }

    #[tokio::test]
    async fn try_download_template_discards_extra_archive_members() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_template_archive_bytes_with_extra().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");

        let result = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap();

        assert!(result, "valid template body -> Ok(true)");
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
        assert!(
            !dst.path().join("extra.txt").exists(),
            "extra archive members must be discarded with download staging"
        );
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned"
        );
    }

    #[tokio::test]
    async fn try_download_template_rejects_archive_missing_template() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_empty_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");

        let err = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap_err();

        assert!(
            matches!(err, R2DownloadError::InvalidObject(_)),
            "archive missing template.ext4 must be treated as corrupt template cache, got {err:?}"
        );
        assert!(!destination.exists());
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned"
        );
    }

    #[tokio::test]
    async fn try_download_template_preserves_destination_until_archive_validates() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_empty_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");
        tokio::fs::write(&destination, b"existing-rootfs")
            .await
            .unwrap();

        let err = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap_err();

        assert!(
            matches!(err, R2DownloadError::InvalidObject(_)),
            "archive missing template.ext4 must be treated as corrupt template cache, got {err:?}"
        );
        assert_eq!(
            tokio::fs::read(&destination).await.unwrap(),
            b"existing-rootfs"
        );
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned"
        );
    }

    #[tokio::test]
    async fn try_download_template_classifies_destination_failure_as_local() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_template_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");
        tokio::fs::create_dir_all(&destination).await.unwrap();

        let err = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap_err();

        assert!(
            matches!(err, R2DownloadError::Local(R2Error::Io(_))),
            "local destination failure must not be treated as corrupt R2 cache, got {err:?}"
        );
        assert!(
            destination.is_dir(),
            "local destination directory should remain for operator inspection"
        );
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging directory must be cleaned after destination failures"
        );
    }

    #[tokio::test]
    async fn finish_file_staging_error_preserves_original_error_when_cleanup_fails() {
        let dst = tempfile::tempdir().unwrap();
        let staging = dst.path().join("rootfs.ext4.download.tmp");
        tokio::fs::write(&staging, b"not a directory")
            .await
            .unwrap();

        let err = finish_file_staging_error(
            &staging,
            R2DownloadError::InvalidObject(R2Error::Io(io_other("bad archive"))),
        )
        .await;

        assert!(
            matches!(err, R2DownloadError::InvalidObject(_)),
            "cleanup failure must not mask invalid-object classification, got {err:?}"
        );
        assert!(
            staging.exists(),
            "test setup should leave the uncleanable staging path in place"
        );
    }

    #[tokio::test]
    async fn try_download_template_wipes_download_staging_on_unpack_error() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let get = mock!(Client::get_object).then_output(|| {
            GetObjectOutput::builder()
                .body(ByteStream::from_static(b"not a valid zstd stream"))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");

        let err = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap_err();

        assert!(
            matches!(err, R2DownloadError::InvalidObject(_)),
            "bad body must be classified as invalid cache object, got {err:?}"
        );
        assert!(!destination.exists(), "destination MUST remain absent");
        assert!(
            !file_staging_dir(&destination).exists(),
            "download staging MUST be wiped on unpack errors"
        );
    }

    #[tokio::test]
    async fn try_download_template_miss_cleans_prior_download_staging() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectError;
        use aws_sdk_s3::types::error::NoSuchKey;

        let get = mock!(Client::get_object)
            .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");
        let stale_download = file_staging_dir(&destination);
        tokio::fs::create_dir_all(&stale_download).await.unwrap();
        tokio::fs::write(stale_download.join("partial"), b"crash residue")
            .await
            .unwrap();

        let result = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap();

        assert!(!result, "NoSuchKey -> Ok(false)");
        assert!(
            !destination.exists(),
            "cache miss must not create destination"
        );
        assert!(
            !stale_download.exists(),
            "prior download staging must be removed even on cache miss"
        );
    }

    #[tokio::test]
    async fn try_download_template_errors_when_prior_download_staging_cannot_be_cleaned() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectError;
        use aws_sdk_s3::types::error::NoSuchKey;

        let get = mock!(Client::get_object)
            .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let destination = dst.path().join("rootfs.ext4.staging");
        let stale_download = file_staging_dir(&destination);
        tokio::fs::write(&stale_download, b"not a directory")
            .await
            .unwrap();

        let err = cache
            .try_download_template_to_file("hash", &destination)
            .await
            .unwrap_err();

        assert!(
            matches!(err, R2DownloadError::Local(R2Error::Io(_))),
            "uncleanable prior download staging must be surfaced, got {err:?}"
        );
        assert!(
            stale_download.exists(),
            "failed cleanup should leave evidence for operator inspection"
        );
    }

    /// Download body is not a valid zstd stream → unpack fails → the
    /// cleanup-on-error branch wipes staging AND leaves `final_dir` absent.
    /// Without cleanup, a failed download + local rebuild could fill the
    /// disk with staging residue.
    #[tokio::test]
    async fn try_download_wipes_staging_on_unpack_error() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let get = mock!(Client::get_object).then_output(|| {
            GetObjectOutput::builder()
                .body(ByteStream::from_static(b"not a valid zstd stream"))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let final_dir = dst.path().join("hash");
        let result = cache.try_download("hash", &final_dir).await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, R2DownloadError::InvalidObject(_)),
            "bad body must be classified as invalid cache object, got {err:?}"
        );
        assert!(!final_dir.exists(), "final_dir MUST remain absent");
        assert!(
            !staging_dir(&final_dir).exists(),
            "staging MUST be wiped — this is the disk-leak guard"
        );
    }

    /// Local filesystem failures after a valid download must not be
    /// classified as invalid R2 objects. The caller should not force-overwrite
    /// a healthy cache key when the local target path is the problem.
    #[tokio::test]
    async fn try_download_classifies_finalize_failure_as_local() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_test_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let final_dir = dst.path().join("hash");
        tokio::fs::write(&final_dir, b"not a directory")
            .await
            .unwrap();

        let err = cache.try_download("hash", &final_dir).await.unwrap_err();

        assert!(
            matches!(err, R2DownloadError::Local(_)),
            "target path failure must be local, got {err:?}"
        );
        assert!(final_dir.is_file(), "local target file should remain");
        assert!(
            !staging_dir(&final_dir).exists(),
            "staging MUST be wiped after finalize failure"
        );
    }

    /// A staging dir from a prior crashed run MUST be wiped before the next
    /// `try_download` unpacks fresh content. Otherwise old junk would leak
    /// into `final_dir` via the rename.
    #[tokio::test]
    async fn try_download_wipes_prior_crashed_staging_dir() {
        use std::sync::Arc;

        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let archive = Arc::new(build_test_archive_bytes().await);
        let archive_for_closure = Arc::clone(&archive);
        let get = mock!(Client::get_object).then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
        let cache = mock_cache("test-bucket", &[&get]);

        let dst = tempfile::tempdir().unwrap();
        let final_dir = dst.path().join("hash");
        let staging = staging_dir(&final_dir);

        // Simulate a prior crashed run: populate staging with junk the
        // fresh download must overwrite.
        tokio::fs::create_dir_all(&staging).await.unwrap();
        tokio::fs::write(staging.join("stale.txt"), b"old crash residue")
            .await
            .unwrap();

        let result = cache.try_download("hash", &final_dir).await.unwrap();

        assert!(result, "valid body → Ok(true)");
        assert!(final_dir.exists(), "final_dir populated");
        assert!(
            final_dir.join("rootfs.ext4").exists(),
            "fresh content arrived"
        );
        assert!(
            !final_dir.join("stale.txt").exists(),
            "stale staging content MUST NOT survive into final_dir"
        );
        assert!(!staging.exists(), "staging consumed by rename");
    }

    // ---- gc_older_than: pagination + per-key delete errors -------------

    /// `gc_older_than` MUST follow `continuation_token` across multiple
    /// `list_objects_v2` pages. Regression here would silently under-delete
    /// (first page processed, subsequent pages dropped) — fleet cache grows
    /// unbounded with orphaned image objects.
    #[tokio::test]
    async fn gc_paginates_across_two_pages() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
        use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
        use aws_sdk_s3::primitives::DateTime;
        use aws_sdk_s3::types::Object;

        // All objects timestamped at unix epoch (last_modified = 0); any
        // non-trivial `max_age` puts the cutoff well after 0 → all expired.
        let page1 = ListObjectsV2Output::builder()
            .is_truncated(true)
            .next_continuation_token("tok1")
            .contents(
                Object::builder()
                    .key("runner-images/a.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(100)
                    .build(),
            )
            .contents(
                Object::builder()
                    .key("runner-images/b.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(200)
                    .build(),
            )
            .build();
        let page2 = ListObjectsV2Output::builder()
            .is_truncated(false)
            .contents(
                Object::builder()
                    .key("runner-images/c.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(300)
                    .build(),
            )
            .build();
        let empty_template_page = ListObjectsV2Output::builder().is_truncated(false).build();

        let list = mock!(Client::list_objects_v2)
            .sequence()
            .output(move || page1.clone())
            .output(move || page2.clone())
            .output(move || empty_template_page.clone())
            .build();
        // Quiet-mode delete responses don't echo successes; no `errors`.
        let delete =
            mock!(Client::delete_objects).then_output(|| DeleteObjectsOutput::builder().build());

        let cache = mock_cache("test-bucket", &[&list, &delete]);

        let (deleted, freed) = cache
            .gc_older_than(std::time::Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(deleted, 3, "2 objects from page1 + 1 from page2");
        assert_eq!(freed, 600, "100 + 200 + 300");
        assert_eq!(
            list.num_calls(),
            3,
            "pagination followed next_token and template prefix was scanned"
        );
        assert_eq!(delete.num_calls(), 2, "one delete per non-empty page");
    }

    /// `gc_older_than` must also clean the shared template prefix. A
    /// regression here would leave the new cache family unbounded even though
    /// legacy `runner-images/` objects continue to be swept.
    #[tokio::test]
    async fn gc_deletes_shared_template_objects() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
        use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
        use aws_sdk_s3::primitives::DateTime;
        use aws_sdk_s3::types::Object;

        let empty_legacy_page = ListObjectsV2Output::builder().is_truncated(false).build();
        let template_page = ListObjectsV2Output::builder()
            .is_truncated(false)
            .contents(
                Object::builder()
                    .key("runner-templates/template.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(123)
                    .build(),
            )
            .build();

        let list = mock!(Client::list_objects_v2)
            .sequence()
            .output(move || empty_legacy_page.clone())
            .output(move || template_page.clone())
            .build();
        let delete =
            mock!(Client::delete_objects).then_output(|| DeleteObjectsOutput::builder().build());

        let cache = mock_cache("test-bucket", &[&list, &delete]);

        let (deleted, freed) = cache
            .gc_older_than(std::time::Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(deleted, 1);
        assert_eq!(freed, 123);
        assert_eq!(list.num_calls(), 2, "legacy and template prefixes scanned");
        assert_eq!(delete.num_calls(), 1, "template object delete issued");
    }

    /// `gc_older_than` MUST exclude per-key failures from `deleted_count` so
    /// operators don't over-report cleanup progress. `freed_bytes` uses
    /// proportional attribution — `60 * 2 / 3 = 40` — since the function
    /// can't know which specific key in the batch failed.
    #[tokio::test]
    async fn gc_excludes_per_key_failures_from_count() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
        use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
        use aws_sdk_s3::primitives::DateTime;
        use aws_sdk_s3::types::{Error as S3Error, Object};

        let page = ListObjectsV2Output::builder()
            .is_truncated(false)
            .contents(
                Object::builder()
                    .key("runner-images/a.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(10)
                    .build(),
            )
            .contents(
                Object::builder()
                    .key("runner-images/b.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(20)
                    .build(),
            )
            .contents(
                Object::builder()
                    .key("runner-images/c.tar.zst")
                    .last_modified(DateTime::from_secs(0))
                    .size(30)
                    .build(),
            )
            .build();
        let empty_template_page = ListObjectsV2Output::builder().is_truncated(false).build();
        let delete_resp = DeleteObjectsOutput::builder()
            .errors(
                S3Error::builder()
                    .key("runner-images/b.tar.zst")
                    .code("AccessDenied")
                    .message("denied")
                    .build(),
            )
            .build();

        let list = mock!(Client::list_objects_v2)
            .sequence()
            .output(move || page.clone())
            .output(move || empty_template_page.clone())
            .build();
        let delete = mock!(Client::delete_objects).then_output(move || delete_resp.clone());

        let cache = mock_cache("test-bucket", &[&list, &delete]);

        let (deleted, freed) = cache
            .gc_older_than(std::time::Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(deleted, 2, "1 of 3 failed → 2 counted as deleted");
        assert_eq!(
            freed, 40,
            "proportional attribution: batch_freed=60, actual/count=2/3 → 40"
        );
    }

    /// `gc_older_than` MUST surface (not silently break) when S3 returns
    /// `is_truncated=true` with no `next_continuation_token` — a spec
    /// violation that, if silently accepted, would silently under-delete.
    /// Returning `Err` lets `runner gc` log a clear cause instead of a
    /// quietly skipped page tail.
    #[tokio::test]
    async fn gc_errors_on_truncated_with_no_token() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;

        // is_truncated=true but next_continuation_token absent.
        let page = ListObjectsV2Output::builder().is_truncated(true).build();
        let list = mock!(Client::list_objects_v2).then_output(move || page.clone());

        let cache = mock_cache("test-bucket", &[&list]);
        let err = cache
            .gc_older_than(std::time::Duration::from_secs(1))
            .await
            .unwrap_err();

        match err {
            R2Error::S3(msg) => {
                assert!(
                    msg.contains("no next_continuation_token"),
                    "want descriptive message: {msg}"
                );
            }
            other => panic!("expected R2Error::S3 for missing token, got {other:?}"),
        }
    }

    /// `gc_older_than` MUST surface (not silently break) when S3 returns
    /// the same `next_continuation_token` twice. Without this guard, the
    /// loop would re-issue list_objects_v2 with the repeated token forever.
    #[tokio::test]
    async fn gc_errors_on_repeated_continuation_token() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;

        // Both calls return is_truncated=true with the same token "stuck-tok".
        let page = ListObjectsV2Output::builder()
            .is_truncated(true)
            .next_continuation_token("stuck-tok")
            .build();
        let list = mock!(Client::list_objects_v2).then_output(move || page.clone());

        let cache = mock_cache("test-bucket", &[&list]);
        let err = cache
            .gc_older_than(std::time::Duration::from_secs(1))
            .await
            .unwrap_err();

        match err {
            R2Error::S3(msg) => {
                assert!(
                    msg.contains("identical continuation_token"),
                    "want descriptive message: {msg}"
                );
                assert!(
                    msg.contains("stuck-tok"),
                    "want offending token in message: {msg}"
                );
            }
            other => panic!("expected R2Error::S3 for repeated token, got {other:?}"),
        }
        // Sanity: list was called at least twice — first sets
        // `continuation_token`, second triggers the equality check.
        // Use `>= 2` rather than strict equality to stay robust against
        // any future SDK retry behavior on the list operation.
        assert!(list.num_calls() >= 2, "got {}", list.num_calls());
    }
}
