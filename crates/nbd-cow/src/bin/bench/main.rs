//! Benchmark: NBD COW vs dm-snapshot.
//!
//! Runs fio workloads on both a dm-snapshot device and an NBD COW device,
//! then compares VM-visible IOPS, latency, AND actual host disk IOPS.
//!
//! Requires: root, nbd kernel module, fio, losetup, dmsetup.

mod args;
mod backends;
mod devices;
mod diskstats;
mod fio;
mod metrics;

use args::{BenchCommand, MIN_BASE_SIZE_MB, base_size_bytes, parse_bench_args, usage};
use backends::{run_dm_snapshot_bench, run_nbd_cow_bench};
use devices::{
    cleanup_stale_dm_mappings, cleanup_stale_nbd_devices, create_sparse_file, is_root,
    nbd_module_loaded, tool_exists,
};
use diskstats::detect_host_disk;
use fio::FioWorkload;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = parse_bench_args(&args).unwrap_or_else(|e| {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    });
    let BenchCommand::Run { base_size_mb } = command else {
        println!("{}", usage());
        return;
    };
    let base_size = base_size_bytes(base_size_mb).unwrap_or_else(|| {
        eprintln!(
            "ERROR: invalid base image size: {base_size_mb} MB (minimum {MIN_BASE_SIZE_MB} MB)"
        );
        std::process::exit(1);
    });

    eprintln!("=== NBD COW vs dm-snapshot Benchmark ===");
    eprintln!("Base image size: {base_size_mb} MB");

    // Check prerequisites
    if !is_root() {
        eprintln!("ERROR: must run as root");
        std::process::exit(1);
    }
    for tool in &["fio", "losetup", "dmsetup"] {
        if !tool_exists(tool) {
            eprintln!("ERROR: {tool} not found in PATH");
            std::process::exit(1);
        }
    }
    if !nbd_module_loaded() {
        eprintln!("ERROR: nbd kernel module not loaded; load with: modprobe nbd nbds_max=4096");
        std::process::exit(1);
    }

    // Detect host disk
    let host_disk = detect_host_disk().unwrap_or_else(|e| {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    });
    eprintln!("Host disk: {host_disk}");
    eprintln!();

    let work_dir = tempfile::Builder::new()
        .prefix("nbd-cow-bench-")
        .tempdir()
        .unwrap_or_else(|e| {
            eprintln!("ERROR: failed to create benchmark work directory: {e}");
            std::process::exit(1);
        });
    let work_dir_path = work_dir.path();
    eprintln!("Work directory: {}", work_dir_path.display());

    let base_path = work_dir_path.join("base.img");

    // Create base image
    eprintln!("== Creating base image ==");
    if let Err(e) = create_sparse_file(&base_path, base_size) {
        eprintln!("ERROR: {e}");
        drop(work_dir);
        std::process::exit(1);
    }

    let workloads = vec![
        FioWorkload {
            name: "rand4k-read",
            args: "--rw=randread --bs=4k --size=256m --numjobs=4 --direct=1",
        },
        FioWorkload {
            name: "rand4k-write",
            args: "--rw=randwrite --bs=4k --size=256m --numjobs=4 --direct=1",
        },
        FioWorkload {
            name: "seq128k-read",
            args: "--rw=read --bs=128k --size=512m --direct=1",
        },
        FioWorkload {
            name: "seq128k-write",
            args: "--rw=write --bs=128k --size=512m --direct=1",
        },
        FioWorkload {
            name: "mixed-70r30w",
            args: "--rw=randrw --rwmixread=70 --bs=4k --size=256m --direct=1",
        },
    ];

    // --- dm-snapshot benchmark ---
    eprintln!("== Benchmarking dm-snapshot ==");
    cleanup_stale_dm_mappings();
    let mut bench_failed = false;
    let dm_name = work_dir_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("bench-cow-{}-{name}", std::process::id()))
        .unwrap_or_else(|| format!("bench-cow-{}", std::process::id()));
    let dm_result = run_dm_snapshot_bench(
        work_dir_path,
        &base_path,
        base_size,
        &workloads,
        &host_disk,
        &dm_name,
    )
    .await;
    let dm_results = match dm_result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("dm-snapshot bench failed: {e}");
            bench_failed = true;
            vec![]
        }
    };

    // --- NBD COW benchmark ---
    eprintln!("== Benchmarking NBD COW ==");
    // Clean up any stale NBD devices from previous runs
    cleanup_stale_nbd_devices();
    let nbd_results =
        match run_nbd_cow_bench(work_dir_path, &base_path, base_size, &workloads, &host_disk).await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("NBD COW bench failed: {e}");
                bench_failed = true;
                vec![]
            }
        };

    // --- Print results ---
    eprintln!("== Results ==");
    eprintln!();
    println!(
        "{:<16} {:>10} {:>10} {:>10} {:>12} {:>10} {:>10} {:>10} {:>12}",
        "Workload",
        "DM IOPS",
        "DM p50",
        "DM p99",
        "DM disk-IO",
        "NBD IOPS",
        "NBD p50",
        "NBD p99",
        "NBD disk-IO"
    );
    println!("{}", "-".repeat(118));

    for (i, wl) in workloads.iter().enumerate() {
        let dm = dm_results.get(i);
        let nbd = nbd_results.get(i);
        println!(
            "{:<16} {:>10} {:>8}us {:>8}us {:>10}/s {:>10} {:>8}us {:>8}us {:>10}/s",
            wl.name,
            dm.map_or("-".into(), |r| r.vm_iops.to_string()),
            dm.map_or("-".into(), |r| r.lat_p50_us.to_string()),
            dm.map_or("-".into(), |r| r.lat_p99_us.to_string()),
            dm.map_or("-".into(), |r| r.host_disk_iops.to_string()),
            nbd.map_or("-".into(), |r| r.vm_iops.to_string()),
            nbd.map_or("-".into(), |r| r.lat_p50_us.to_string()),
            nbd.map_or("-".into(), |r| r.lat_p99_us.to_string()),
            nbd.map_or("-".into(), |r| r.host_disk_iops.to_string()),
        );
    }

    // Cleanup
    eprintln!();
    eprintln!("== Cleaning up ==");
    drop(work_dir);
    eprintln!("Done.");

    if bench_failed {
        std::process::exit(1);
    }
}
