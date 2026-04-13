//! R2 cache for unified `runner build` image artifacts.
//!
//! Single-key bundle per image hash: `runner-images/{hash}.tar.zst` in the
//! existing `R2_USER_STORAGES_BUCKET_NAME` bucket. The 4 files from
//! `ImagePaths::expected_files()` are packed dense (no sparse-tar handling);
//! `cow.img` sparseness is restored on unpack via best-effort
//! `fallocate(FALLOC_FL_PUNCH_HOLE)`.
//!
//! ## Lifecycle
//!
//! 1. `runner build` computes hash and checks local cache (existing logic).
//! 2. On miss, after acquiring `image_lock(hash)`, it tries `try_download`.
//! 3. On download miss, it does the local rootfs+snapshot build (existing logic).
//! 4. After `is_image_complete()` succeeds, it calls `upload`.
//!
//! Atomicity guarantees:
//! - Multipart upload is atomic from consumer POV (object only appears after
//!   `CompleteMultipartUpload`); abandoned segments are auto-cleaned by R2's
//!   default 7-day lifecycle.
//! - Download unpacks into a `{hash}.tmp/` staging directory then `rename`s
//!   to `{hash}/` — partial unpack from a crash never produces a false-positive
//!   `is_image_complete()` hit.
//!
//! Configuration semantics: `from_env` returns `Ok(None)` only when **all four**
//! `R2_*` env vars are unset or empty (dev/test path). Setting 1-3 of 4 is a
//! fatal `PartialConfig` error — almost certainly a typo'd secret rotation, and
//! silently disabling cache fleet-wide is worse than failing the deploy.
//!
//! Streaming: both upload and download avoid temp files entirely. Upload uses a
//! `tokio::io::duplex` pipe to couple the sync tar+zstd producer (on a blocking
//! thread) to the async multipart consumer. Download uses `SyncIoBridge` to
//! adapt the async S3 body into a sync `Read` for the blocking unpack thread.
//! Memory peak per upload ≈ `(2 + CONCURRENCY + 1) × PART_SIZE` — duplex buffer,
//! in-flight upload chunks, and the part being read — bounded regardless of
//! image size. Currently ~112 MiB with `PART_SIZE` = 16 MiB and `CONCURRENCY` = 4.
//!
//! Image size limit: `PART_SIZE * 10000 ≈ 160 GiB` (S3 multipart hard limit).
//! Current images are well under 30 GiB; revisit if `PART_SIZE` decreases.
//!
//! ## R2-side cleanup
//!
//! Completed objects (`runner-images/{hash}.tar.zst`) are **never deleted on
//! upload**. Each `IMAGE_CACHE_VERSION` bump, build-script change, guest
//! binary rebuild, or firecracker/kernel upgrade produces a new hash and
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
//! - **Local staging directory**: a hard-killed `try_download` may leave
//!   `images/{hash}.tmp/` on disk. The next `try_download` removes it as
//!   the first action, so the leak is bounded to one stale dir per hash
//!   and self-heals on next attempt.
//! - **R2 multipart upload session**: a cancelled `upload` after
//!   `create_multipart_upload` returned but before `Complete` runs leaks
//!   the `upload_id` server-side (Drop can't `.await` to call
//!   `abort_multipart_upload`). R2's default 7-day lifecycle cleans
//!   abandoned segments, capping the wasted storage cost.
//! - **`spawn_blocking` pack / unpack tasks**: tokio cannot cancel
//!   blocking tasks. After parent cancellation, the producer/consumer
//!   thread runs until it hits BrokenPipe or natural EOF — wasted CPU for
//!   a few seconds, no resource leak.
//!
//! ## Corrupt-object eviction
//!
//! A structurally-valid archive whose extracted content fails
//! `is_image_complete` (e.g. uploaded by an old/buggy producer, or
//! attacker-controlled IAM key writing a bogus tar to a predicted hash
//! key) would otherwise dead-lock the fleet's cache for that hash: every
//! host downloads → unpacks → fails completeness → rebuilds locally →
//! `upload`'s `exists()` dedup-skips → the bad object stays, forever.
//!
//! `cmd::build::run_build` defends by passing `force = true` to `upload`
//! whenever it observes "download Ok(true) but is_image_complete=false".
//! That bypasses the dedup check and atomically overwrites the bad object
//! in a single PUT — robust against `s3:DeleteObject` permission being
//! revoked or transiently failing (which a `delete + retry-upload`
//! sequence would not be).
//!
//! ## Tar entry security
//!
//! `tar::Archive::unpack` (0.4) has two relevant behaviors when consuming an
//! attacker-influenced archive:
//!
//! 1. **Path traversal (`..` components) is silently dropped**. Verified by
//!    `unpack_rejects_path_traversal`. The malicious entry is skipped; the
//!    staging dir ends up missing one or more expected files;
//!    `is_image_complete()` (in `cmd::build`) rejects the partial result; the
//!    caller falls back to local build. Safe.
//!
//! 2. **Symlink and hardlink entries are accepted**. An attacker with R2
//!    write access could craft a tar where each expected filename is a
//!    symlink to a host path (e.g. `rootfs.ext4 -> /etc/shadow`);
//!    `is_image_complete` would pass and Firecracker would consume the
//!    linked content. Currently relies on the R2 IAM trust boundary;
//!    defense-in-depth (rejecting non-regular-file entries) is tracked as a
//!    follow-up — out of scope for this PR.
//!
//! **Maintenance note**: `is_image_complete()` is the structural check that
//! catches case (1). If you add a new file to the image, you MUST extend
//! `is_image_complete()` accordingly — otherwise an attacker-controlled tar
//! that omits the new file would still pass the completeness check.

use std::path::{Path, PathBuf};

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region, SharedCredentialsProvider};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::head_object::HeadObjectError;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier};
use tokio::io::AsyncReadExt;

const KEY_PREFIX: &str = "runner-images/";
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
            .build();
        let client = aws_sdk_s3::Client::from_conf(config);

        Ok(Some(Self { client, bucket }))
    }

    /// Returns `Ok(true)` if `runner-images/{hash}.tar.zst` exists.
    pub async fn exists(&self, hash: &str) -> Result<bool, R2Error> {
        let key = key_for_hash(hash);
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(SdkError::ServiceError(e)) if matches!(e.err(), HeadObjectError::NotFound(_)) => {
                Ok(false)
            }
            Err(e) => Err(R2Error::S3(format!("head_object: {e:?}"))),
        }
    }

    /// Try to download `runner-images/{hash}.tar.zst`, streaming directly
    /// through zstd decode + tar unpack into a sibling staging directory,
    /// then best-effort sparse-restore `cow.img`, then atomic rename to
    /// `final_dir`. No temp file — bounded memory regardless of image size.
    ///
    /// Network hangs are bounded by the AWS SDK's own per-operation timeouts;
    /// outer call sites (CI/systemd) bound total wall time.
    pub async fn try_download(&self, hash: &str, final_dir: &Path) -> Result<bool, R2Error> {
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
            Err(e) => return Err(R2Error::S3(format!("get_object: {e:?}"))),
        };

        // Atomic via staging dir + rename. Cleanup-on-error covers the entire
        // staging lifecycle — a partial unpack can leave many GB on disk even
        // though `final_dir` is never created. Without cleanup, a failed download
        // followed by a local build could fill the disk before GC catches up.
        let staging = staging_dir(final_dir);
        let body_reader = resp.body.into_async_read();
        let outcome = async {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            tokio::fs::create_dir_all(&staging).await?;
            unpack_into_staging(body_reader, &staging).await?;
            finalize_staging(&staging, final_dir).await
        }
        .await;
        if outcome.is_err() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
        }
        outcome?;
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
    /// detecting a corrupt prior upload (download succeeded but
    /// `is_image_complete` failed). Going through `delete + dedup-upload`
    /// would deadlock the fleet's cache if `DeleteObject` permission is
    /// missing or transiently failing — `force` is a single-round-trip atomic
    /// overwrite that doesn't depend on `s3:DeleteObject`.
    ///
    /// Network hangs are bounded by the AWS SDK's own per-operation timeouts;
    /// outer call sites (CI/systemd) bound total wall time.
    pub async fn upload(&self, hash: &str, files: &[PathBuf], force: bool) -> Result<(), R2Error> {
        if !force && self.exists(hash).await? {
            tracing::info!("R2 already has {hash}, skipping upload");
            return Ok(());
        }

        let key = key_for_hash(hash);
        let create = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await?;
        let upload_id = create
            .upload_id()
            .ok_or_else(|| R2Error::S3("create_multipart_upload: no upload_id".into()))?
            .to_string();

        // Run the full pack→stream→complete pipeline, then abort if anything
        // failed (including Complete itself — server-side validation errors
        // can fail Complete after all parts uploaded successfully).
        let result = self.do_multipart_upload(&key, &upload_id, files).await;
        if result.is_err() {
            // Best-effort abort; R2's 7-day default lifecycle catches misses.
            let _ = self
                .client
                .abort_multipart_upload()
                .bucket(&self.bucket)
                .key(&key)
                .upload_id(&upload_id)
                .send()
                .await;
        }
        result
    }

    /// Delete `runner-images/*` objects older than `max_age`. Returns
    /// `(deleted_count, freed_bytes)`. Idempotent under concurrent fleet
    /// execution: every host runs the same scan and `DeleteObjects` returns
    /// success for already-absent keys (S3 spec). Each invocation costs ~1
    /// LIST + 1 batched DELETE per page (max 1000 objects/page).
    ///
    /// Per-key errors (e.g. AccessDenied — NOT NoSuchKey) are surfaced via
    /// `tracing::warn!` and excluded from `deleted_count`.
    pub async fn gc_older_than(&self, max_age: std::time::Duration) -> Result<(u64, u64), R2Error> {
        let cutoff = cutoff_unix_secs(std::time::SystemTime::now(), max_age)?;

        let mut continuation_token: Option<String> = None;
        let mut total_deleted = 0u64;
        let mut total_freed = 0u64;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(KEY_PREFIX);
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
            let next_token = match resp.next_continuation_token() {
                Some(t) => t.to_string(),
                None => break, // truncated but no token — defensive exit
            };
            // Defensive: detect a server returning the same token twice
            // (would be an S3 bug, but cheap to guard against).
            if continuation_token.as_deref() == Some(next_token.as_str()) {
                tracing::warn!(
                    "r2: list_objects_v2 returned identical continuation_token; aborting paginated scan"
                );
                break;
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

fn key_for_hash(hash: &str) -> String {
    format!("{KEY_PREFIX}{hash}.tar.zst")
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
fn unpack_from_reader<R: std::io::Read>(reader: R, dest: &Path) -> Result<(), R2Error> {
    let zr = zstd::stream::read::Decoder::new(reader)?;
    tar::Archive::new(zr).unpack(dest)?;
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

/// Finish the unpack: best-effort sparse-restore `cow.img`, then atomic rename
/// `staging` to `final_dir`. Same-parent rename is atomic on ext4/xfs.
async fn finalize_staging(staging: &Path, final_dir: &Path) -> Result<(), R2Error> {
    let cow = staging.join("cow.img");
    if let Ok(meta) = tokio::fs::metadata(&cow).await {
        let len = meta.len();
        if len > 0 {
            let result = tokio::task::spawn_blocking(move || punch_hole(&cow, len))
                .await
                .map_err(|e| R2Error::Io(io_other(e)))?;
            if let Err(e) = result {
                tracing::warn!("punch_hole on cow.img failed: {e}");
            }
        }
    }

    if let Err(e) = tokio::fs::rename(staging, final_dir).await {
        // Expected recovery path: a previous `runner build` for this hash
        // crashed after creating final_dir but before is_image_complete
        // would pass. Wipe the stale directory and retry the rename.
        tracing::info!(
            "{} already exists (likely stale from a partial run: {e}); replacing",
            final_dir.display()
        );
        let _ = tokio::fs::remove_dir_all(final_dir).await;
        tokio::fs::rename(staging, final_dir).await?;
    }
    Ok(())
}

/// `images/{hash}` -> `images/{hash}.tmp` (sibling, same parent → atomic rename).
fn staging_dir(final_dir: &Path) -> PathBuf {
    let mut name = final_dir
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    final_dir.with_file_name(name)
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

/// Best-effort `FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE` over the whole file.
/// Logs and swallows EOPNOTSUPP (tmpfs); returns Err for other failures.
fn punch_hole(path: &Path, len: u64) -> Result<(), R2Error> {
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    let len_i64 = i64::try_from(len).map_err(|_| {
        R2Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("file size too large for fallocate: {len}"),
        ))
    })?;
    match nix::fcntl::fallocate(
        &f,
        nix::fcntl::FallocateFlags::FALLOC_FL_PUNCH_HOLE
            | nix::fcntl::FallocateFlags::FALLOC_FL_KEEP_SIZE,
        0,
        len_i64,
    ) {
        Ok(()) => Ok(()),
        Err(nix::Error::EOPNOTSUPP) => {
            tracing::warn!(
                "filesystem doesn't support FALLOC_FL_PUNCH_HOLE; cow.img will remain dense \
                 ({len} bytes on disk)"
            );
            Ok(())
        }
        Err(e) => Err(R2Error::Io(std::io::Error::other(e.to_string()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format() {
        assert_eq!(key_for_hash("abc123"), "runner-images/abc123.tar.zst");
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

    /// Write the four canonical image files into `dir` with the same byte
    /// content for both packing and verification. cow.img is sparse (16 MiB
    /// logical, only first 1 MiB written).
    async fn write_mock_image_files(dir: &Path) -> Vec<PathBuf> {
        let rootfs = dir.join("rootfs.ext4");
        let snapshot = dir.join("snapshot.bin");
        let memory = dir.join("memory.bin");
        let cow = dir.join("cow.img");

        // Distinct content per file so cross-contamination shows up as a diff.
        tokio::fs::write(&rootfs, b"rootfs-content".repeat(1024))
            .await
            .unwrap();
        tokio::fs::write(&snapshot, b"snapshot-bin").await.unwrap();
        tokio::fs::write(&memory, vec![0u8; 4 * 1024 * 1024])
            .await
            .unwrap();

        // Sparse cow.img: 16 MiB logical, 1 MiB at the front.
        let cow_file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&cow)
            .unwrap();
        cow_file.set_len(16 * 1024 * 1024).unwrap();
        drop(cow_file);
        tokio::fs::write(&cow, vec![0xAB; 1024 * 1024])
            .await
            .unwrap();
        // Re-truncate to logical size after writing data — write() truncates.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&cow)
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .unwrap();

        vec![rootfs, snapshot, memory, cow]
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
    async fn pack_then_unpack_round_trips_4_files() {
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

        // All 4 file names exist and round-trip the prefix bytes.
        for name in ["rootfs.ext4", "snapshot.bin", "memory.bin", "cow.img"] {
            let dst = final_dir.join(name);
            let src = src_dir.path().join(name);
            assert!(dst.exists(), "{name} should exist after unpack");
            let dst_meta = std::fs::metadata(&dst).unwrap();
            let src_meta = std::fs::metadata(&src).unwrap();
            assert_eq!(
                dst_meta.len(),
                src_meta.len(),
                "{name} logical size mismatch"
            );
        }

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

    /// `finalize_staging` skips `punch_hole` when `cow.img` is empty (size=0).
    /// Different branch from `finalize_works_without_cow_img` — there the
    /// file is absent; here it exists with zero length. Both must succeed
    /// without invoking the fallocate syscall (which is undefined for len=0).
    #[tokio::test]
    async fn finalize_skips_punch_hole_on_zero_byte_cow() {
        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");
        let staging = staging_dir(&final_dir);
        tokio::fs::create_dir_all(&staging).await.unwrap();
        tokio::fs::write(staging.join("cow.img"), b"")
            .await
            .unwrap();
        tokio::fs::write(staging.join("rootfs.ext4"), b"data")
            .await
            .unwrap();

        finalize_staging(&staging, &final_dir).await.unwrap();

        let cow_meta = std::fs::metadata(final_dir.join("cow.img")).unwrap();
        assert_eq!(cow_meta.len(), 0, "0-byte cow.img preserved as-is");
        assert!(!staging.exists(), "staging consumed by rename");
    }

    /// `finalize_staging` skips `punch_hole` cleanly when `cow.img` is absent.
    /// Defends against future producers that ship without cow.img.
    #[tokio::test]
    async fn finalize_works_without_cow_img() {
        let dst_root = tempfile::tempdir().unwrap();
        let final_dir = dst_root.path().join("hash");
        let staging = staging_dir(&final_dir);
        tokio::fs::create_dir_all(&staging).await.unwrap();
        tokio::fs::write(staging.join("rootfs.ext4"), b"data")
            .await
            .unwrap();
        // Intentionally: no cow.img.

        finalize_staging(&staging, &final_dir).await.unwrap();

        assert!(final_dir.exists());
        assert!(final_dir.join("rootfs.ext4").exists());
        assert!(!final_dir.join("cow.img").exists());
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
    /// must not panic — it's the canary for `is_image_complete()` invariants
    /// changing in the future.
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
}
