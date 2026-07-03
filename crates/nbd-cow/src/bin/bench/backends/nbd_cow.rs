use std::path::Path;

use nbd_cow::{DestroyRetryPolicy, pool::DevicePoolHandle};

use crate::devices::{TempFileCleanup, nbd_module_loaded};
use crate::fio::{FioResult, FioWorkload, run_fio_with_iostat};

use super::result_after_cleanup;

pub(crate) async fn run_nbd_cow_bench(
    work_dir: &Path,
    base_path: &Path,
    base_size: u64,
    workloads: &[FioWorkload],
    host_disk: &str,
) -> Result<Vec<FioResult>, String> {
    let mut results = Vec::new();

    if !nbd_module_loaded() {
        return Err(
            "nbd kernel module not loaded; load with: modprobe nbd nbds_max=4096".to_string(),
        );
    }

    eprintln!("  NBD module loaded, setting up NBD COW device...");

    let device_pool = DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());

    let result: Result<Vec<FioResult>, String> = async {
        for wl in workloads {
            let cow_path = work_dir.join("nbd-cow.img");
            let _cow_file_cleanup = TempFileCleanup::new(cow_path.clone());

            let device = device_pool
                .create_cow_device(base_path, &cow_path, base_size)
                .await
                .map_err(|e| format!("failed to create NBD COW device: {e}"))?;

            let dev_path = device.device_path().to_string_lossy().to_string();
            eprintln!("  Running fio ({}) on {dev_path}...", wl.name);

            let fio_result = run_fio_with_iostat(&dev_path, wl, host_disk).await;
            let destroy_result = device
                .destroy_with_retries(DestroyRetryPolicy {
                    attempts: 1,
                    delay: std::time::Duration::ZERO,
                })
                .await;

            let cleanup_errors = destroy_result
                .err()
                .map(|e| vec![format!("failed to destroy NBD device: {e}")])
                .unwrap_or_default();
            let result = result_after_cleanup(fio_result, cleanup_errors)?;
            results.push(result);
        }

        Ok(results)
    }
    .await;

    device_pool.cleanup().await;
    result
}
