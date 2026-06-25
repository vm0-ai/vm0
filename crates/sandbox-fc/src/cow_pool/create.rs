use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use super::{CowPoolConfig, CowPoolError, PrewarmedSlot, SlotSpawner};

pub(super) fn default_slot_spawner() -> SlotSpawner {
    Arc::new(|config| tokio::task::spawn_blocking(move || create_slot(&config)))
}

// ---------------------------------------------------------------------------
// Slot creation and teardown helpers
// ---------------------------------------------------------------------------

/// Create a pre-warmed slot: workspace directory + COW file.
pub(super) fn create_slot(config: &CowPoolConfig) -> Result<PrewarmedSlot, CowPoolError> {
    let id = uuid::Uuid::new_v4().to_string();
    let workspace = config.workspaces_dir.join(&id);
    let cow_file = workspace.join("cow.img");

    if let Err(e) = create_cow_file(config, &workspace, &cow_file) {
        // Best-effort cleanup: remove any partially-created workspace.
        let _ = std::fs::remove_dir_all(&workspace);
        return Err(e);
    }

    Ok(PrewarmedSlot::new(id, workspace))
}

/// Create the COW file: sparse-copy from golden image or allocate fresh.
fn create_cow_file(
    config: &CowPoolConfig,
    workspace: &Path,
    cow_file: &Path,
) -> Result<(), CowPoolError> {
    std::fs::create_dir_all(workspace).map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    match &config.golden_cow {
        Some(golden) => {
            let expected_blocks = validate_base_size(config.base_size)?;
            sparse_copy(golden, cow_file)?;
            ensure_owner_read_write(cow_file)?;
            let cow_file_len = std::fs::metadata(cow_file)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?
                .len();
            // Snapshot restore requires the dirty bitmap sidecar to preserve COW reads.
            let golden_bitmap = nbd_cow::cow::bitmap_path_for(golden);
            let cow_bitmap = nbd_cow::cow::bitmap_path_for(cow_file);
            sparse_copy(&golden_bitmap, &cow_bitmap)?;
            validate_cow_bitmap(&cow_bitmap, cow_file_len, expected_blocks)?;
        }
        None => {
            validate_base_size(config.base_size)?;
            let f = std::fs::File::create(cow_file)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
            f.set_len(config.base_size)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
        }
    }
    Ok(())
}

fn validate_cow_bitmap(
    bitmap_path: &Path,
    cow_file_len: u64,
    expected_blocks: usize,
) -> Result<(), CowPoolError> {
    nbd_cow::cow::validate_bitmap_cow_coverage(
        bitmap_path,
        cow_file_len,
        nbd_cow::BLOCK_SIZE,
        expected_blocks,
    )
    .map_err(|e| CowPoolError::CowFileCreation(format!("invalid COW bitmap: {e}")))
}

fn validate_base_size(base_size: u64) -> Result<usize, CowPoolError> {
    if base_size == 0 {
        return Err(CowPoolError::CowFileCreation(
            "base image size is empty".to_string(),
        ));
    }

    let block_size = nbd_cow::BLOCK_SIZE as u64;
    if !base_size.is_multiple_of(block_size) {
        return Err(CowPoolError::CowFileCreation(format!(
            "base image size {base_size} is not a multiple of {block_size} bytes"
        )));
    }

    let expected_blocks = usize::try_from(base_size / block_size).map_err(|_| {
        CowPoolError::CowFileCreation("base image block count is too large".to_string())
    })?;
    Ok(expected_blocks)
}

fn ensure_owner_read_write(path: &Path) -> Result<(), CowPoolError> {
    let metadata =
        std::fs::metadata(path).map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    let mode_with_owner_rw = mode | 0o600;
    if mode_with_owner_rw != mode {
        permissions.set_mode(mode_with_owner_rw);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    }
    Ok(())
}

/// Synchronous sparse copy via `cp --sparse=always`.
fn sparse_copy(src: &Path, dst: &Path) -> Result<(), CowPoolError> {
    let output = std::process::Command::new("cp")
        .arg("--sparse=always")
        .arg("--")
        .arg(src)
        .arg(dst)
        .output()
        .map_err(|e| CowPoolError::CowFileCreation(format!("exec cp: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CowPoolError::CowFileCreation(format!(
            "cp --sparse=always failed: {stderr}"
        )));
    }
    Ok(())
}
