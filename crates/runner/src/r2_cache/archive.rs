use std::path::{Path, PathBuf};

use super::{R2Error, io_other};

pub(super) const TEMPLATE_FILE: &str = "template.ext4";
const ZSTD_LEVEL: i32 = 3;

pub(super) fn pack_to_writer<W: std::io::Write>(
    writer: W,
    files: &[PathBuf],
) -> Result<(), R2Error> {
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
pub(super) fn unpack_from_reader<R: std::io::Read>(reader: R, dest: &Path) -> Result<(), R2Error> {
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
pub(super) async fn unpack_into_staging<R>(reader: R, staging: &Path) -> Result<(), R2Error>
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
