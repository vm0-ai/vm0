use aws_sdk_s3::types::{Delete, ObjectIdentifier};

use super::{
    R2Error, R2ImageCache, io_other,
    keys::{LEGACY_ROOTFS_KEY_PREFIX, TEMPLATE_KEY_PREFIX},
};

impl R2ImageCache {
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
}

/// Filter a single ListObjectsV2 page down to the keys that should be
/// deleted (`last_modified < cutoff`), and sum their reported sizes.
/// Skips entries with no `last_modified` or no `key` (defensive — shouldn't
/// happen for real R2 responses but the SDK type makes them Optional).
/// Negative `size` values are clamped to 0 before being summed.
///
/// Boundary: an object whose `last_modified == cutoff` is **kept**
/// (`>= cutoff` is the skip condition). This biases toward retention.
pub(super) fn select_expired_in_page(
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
pub(super) fn cutoff_unix_secs(
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
