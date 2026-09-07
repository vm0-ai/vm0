use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::info;

use super::{
    CowPoolConfig, CowPoolError, PreparedCowSlot, PrewarmedSlot, SlotSpawner, destroy_slot_async,
};
use crate::command;
use crate::duration::duration_ms;

const COW_SPARSE_COPY_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub(super) struct CowFileConfig {
    pub(super) workspaces_dir: PathBuf,
    pub(super) base_size: u64,
    pub(super) golden_cow: Option<PathBuf>,
}

impl From<&CowPoolConfig> for CowFileConfig {
    fn from(config: &CowPoolConfig) -> Self {
        Self {
            workspaces_dir: config.workspaces_dir.clone(),
            base_size: config.base_size,
            golden_cow: config.golden_cow.clone(),
        }
    }
}

pub(super) fn default_slot_spawner() -> SlotSpawner {
    Arc::new(|config| tokio::spawn(prepare_slot(config)))
}

// ---------------------------------------------------------------------------
// Slot creation and teardown helpers
// ---------------------------------------------------------------------------

async fn prepare_slot(config: CowPoolConfig) -> Result<PreparedCowSlot, CowPoolError> {
    let file_started = Instant::now();
    let create_config = CowFileConfig::from(&config);
    let slot = create_slot(&create_config).await?;
    let file_elapsed_ms = duration_ms(file_started.elapsed());

    let nbd_started = Instant::now();
    let device_result = config
        .device_pool
        .create_cow_device(&config.base_image, &slot.cow_file(), config.base_size)
        .await;
    let nbd_elapsed_ms = duration_ms(nbd_started.elapsed());
    info!(
        file_elapsed_ms,
        nbd_elapsed_ms,
        success = device_result.is_ok(),
        "prepared COW slot resources"
    );

    let device = match device_result {
        Ok(device) => device,
        Err(error) => {
            destroy_slot_async(slot).await;
            return Err(CowPoolError::CowDeviceCreation(error.to_string()));
        }
    };
    Ok(PreparedCowSlot::new(slot, device))
}

/// Create a pre-warmed slot: workspace directory + COW file.
pub(super) async fn create_slot(config: &CowFileConfig) -> Result<PrewarmedSlot, CowPoolError> {
    create_slot_with_copy_timeout(config, COW_SPARSE_COPY_TIMEOUT).await
}

pub(super) async fn create_slot_with_copy_timeout(
    config: &CowFileConfig,
    copy_timeout: Duration,
) -> Result<PrewarmedSlot, CowPoolError> {
    let id = uuid::Uuid::new_v4().to_string();
    let workspace = config.workspaces_dir.join(&id);
    let cow_file = workspace.join("cow.img");

    if let Err(e) = create_cow_file(config, &workspace, &cow_file, copy_timeout).await {
        // Best-effort cleanup: remove any partially-created workspace.
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        return Err(e);
    }

    Ok(PrewarmedSlot::new(id, workspace))
}

/// Create the COW file: sparse-copy from golden image or allocate fresh.
async fn create_cow_file(
    config: &CowFileConfig,
    workspace: &Path,
    cow_file: &Path,
    copy_timeout: Duration,
) -> Result<(), CowPoolError> {
    tokio::fs::create_dir_all(workspace)
        .await
        .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    match &config.golden_cow {
        Some(golden) => {
            let expected_blocks = validate_base_size(config.base_size)?;
            sparse_copy(golden, cow_file, copy_timeout).await?;
            ensure_owner_read_write(cow_file).await?;
            let cow_file_len = tokio::fs::metadata(cow_file)
                .await
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?
                .len();
            // Snapshot restore requires the dirty bitmap sidecar to preserve COW reads.
            let golden_bitmap = nbd_cow::cow::bitmap_path_for(golden);
            let cow_bitmap = nbd_cow::cow::bitmap_path_for(cow_file);
            sparse_copy(&golden_bitmap, &cow_bitmap, copy_timeout).await?;
            tokio::task::spawn_blocking(move || {
                validate_cow_bitmap(&cow_bitmap, cow_file_len, expected_blocks)
            })
            .await
            .map_err(|e| CowPoolError::CowFileCreation(format!("bitmap validation join: {e}")))??;
        }
        None => {
            validate_base_size(config.base_size)?;
            let f = tokio::fs::File::create(cow_file)
                .await
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
            f.set_len(config.base_size)
                .await
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

async fn ensure_owner_read_write(path: &Path) -> Result<(), CowPoolError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    let mode_with_owner_rw = mode | 0o600;
    if mode_with_owner_rw != mode {
        permissions.set_mode(mode_with_owner_rw);
        tokio::fs::set_permissions(path, permissions)
            .await
            .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    }
    Ok(())
}

async fn sparse_copy(src: &Path, dst: &Path, timeout: Duration) -> Result<(), CowPoolError> {
    let args = [
        OsStr::new("--sparse=always"),
        OsStr::new("--"),
        src.as_os_str(),
        dst.as_os_str(),
    ];
    command::exec_status_os_with_timeout(OsStr::new("cp"), &args, timeout)
        .await
        .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))
}
