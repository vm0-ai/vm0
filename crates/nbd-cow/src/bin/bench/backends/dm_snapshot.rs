use std::path::Path;

use crate::devices::{DmMappingGuard, LoopDeviceGuard, TempFileCleanup, create_sparse_file};
use crate::fio::{FioResult, FioWorkload, run_fio_with_iostat};

use super::result_after_cleanup;

pub(crate) async fn run_dm_snapshot_bench(
    work_dir: &Path,
    base_path: &Path,
    base_size: u64,
    workloads: &[FioWorkload],
    host_disk: &str,
    dm_name_prefix: &str,
) -> Result<Vec<FioResult>, String> {
    let cow_path = work_dir.join("dm-cow.img");
    let sectors = base_size / 512;
    let mut results = Vec::new();

    let mut base_loop = LoopDeviceGuard::attach(base_path, true)?;

    for (index, wl) in workloads.iter().enumerate() {
        let _cow_file_cleanup = TempFileCleanup::new(cow_path.clone());
        create_sparse_file(&cow_path, base_size)?;
        let mut cow_loop = LoopDeviceGuard::attach(&cow_path, false)?;
        let dm_name = format!("{dm_name_prefix}-{index}");

        let table = format!(
            "0 {sectors} snapshot {} {} P 8",
            base_loop.device(),
            cow_loop.device()
        );
        let mut dm_mapping = DmMappingGuard::create(&dm_name, &table)?;

        let device = dm_mapping.device_path();
        eprintln!("  Running fio ({}) on {device}...", wl.name);

        let result = run_fio_with_iostat(&device, wl, host_disk).await;
        let mut cleanup_errors = Vec::new();
        if let Err(e) = dm_mapping.remove() {
            cleanup_errors.push(format!("failed to remove dm mapping {dm_name}: {e}"));
        }
        let cow_loop_device = cow_loop.device().to_string();
        if let Err(e) = cow_loop.detach() {
            cleanup_errors.push(format!(
                "failed to detach loop device {cow_loop_device}: {e}"
            ));
        }
        let result = result_after_cleanup(result, cleanup_errors)?;
        results.push(result);
    }

    base_loop.detach()?;
    Ok(results)
}
