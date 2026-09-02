#![cfg(target_os = "linux")]

//! Root-required real-Firecracker proof for weighted host CPU placement.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::future::join_all;
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, FactoryConfig, HostCpuPlacementConfig,
    HostCpuPlacementMode, ResourceLimits, RuntimeConfig, Sandbox, SandboxConfig, SandboxRuntime,
};
use sandbox_fc::FirecrackerRuntime;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const CONTROL_WEIGHT: u32 = 200;
const GUESTS_WEIGHT: u32 = 9_800;
const SAMPLE_WARMUP: Duration = Duration::from_secs(1);
const SAMPLE_WINDOW: Duration = Duration::from_secs(5);
const SATURATED_SAMPLES: u64 = 3;
const TEST_VCPUS: [u32; 4] = [1, 1, 4, 4];
const CPU_LOAD_COMMAND: &str = "sh -c 'for i in $(seq 1 $(nproc)); do timeout 8 sh -c \
    \"while :; do :; done\" & done; wait || true'";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestMode {
    Baseline,
    Managed,
}

impl TestMode {
    fn from_env() -> TestResult<Self> {
        match required_env("VM0_HOST_CPU_TEST_MODE")?.as_str() {
            "baseline" => Ok(Self::Baseline),
            "managed" => Ok(Self::Managed),
            value => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("VM0_HOST_CPU_TEST_MODE must be baseline or managed, got {value:?}"),
            )
            .into()),
        }
    }
}

struct RunningSandbox {
    vcpu: u32,
    sandbox: Box<dyn Sandbox>,
}

struct Measurement {
    usage: Vec<u64>,
    control_ticks: u64,
    control_max_gap_micros: u64,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires root, Firecracker fixtures, NBD, and delegated cgroup v2"]
async fn real_firecracker_guests_receive_weighted_host_cpu_service() -> TestResult<()> {
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "test requires root").into());
    }
    let mode = TestMode::from_env()?;
    let firecracker = required_path("VM0_HOST_CPU_TEST_FIRECRACKER")?;
    let kernel = required_path("VM0_HOST_CPU_TEST_KERNEL")?;
    let rootfs = required_path("VM0_HOST_CPU_TEST_ROOTFS")?;
    let base_dir = PathBuf::from(required_env("VM0_HOST_CPU_TEST_BASE_DIR")?);
    fs::create_dir_all(&base_dir)?;

    let host_cpu_placement = match mode {
        TestMode::Baseline => None,
        TestMode::Managed => Some(
            HostCpuPlacementConfig::new(
                CONTROL_WEIGHT,
                GUESTS_WEIGHT,
                HostCpuPlacementMode::Required,
            )
            .map_err(io::Error::other)?,
        ),
    };
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement,
    })
    .await?;
    let mut factory = runtime
        .create_factory(FactoryConfig {
            profile: "vm0/host-cpu-metal".into(),
            binary_path: firecracker,
            kernel_path: kernel,
            rootfs_path: rootfs,
            base_dir,
            snapshot: None,
        })
        .await?;

    let mut sandboxes = Vec::with_capacity(TEST_VCPUS.len());
    for vcpu in TEST_VCPUS {
        let mut sandbox = factory
            .create(SandboxConfig {
                id: sandbox::SandboxId::new_v4(),
                resources: ResourceLimits {
                    cpu_count: vcpu,
                    memory_mb: 512,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await?;
        sandbox.start().await?;
        sandboxes.push(RunningSandbox { vcpu, sandbox });
    }

    let cgroup_root = delegated_root()?;
    if mode == TestMode::Managed {
        verify_managed_hierarchy(&cgroup_root, &sandboxes)?;
    }

    let mut saturated_usage = vec![0_u64; sandboxes.len()];
    let mut saturated_control_ticks = 0_u64;
    let mut saturated_control_max_gap_micros = 0_u64;
    for sample in 0..SATURATED_SAMPLES {
        let measurement =
            run_load_and_measure(mode, &cgroup_root, &sandboxes, &[0, 1, 2, 3]).await?;
        assert_eq!(measurement.usage.len(), saturated_usage.len());
        for (index, (total, usage)) in saturated_usage
            .iter_mut()
            .zip(measurement.usage.iter().copied())
            .enumerate()
        {
            assert!(
                usage > 0,
                "sandbox {index} made no CPU progress in sample {sample}"
            );
            *total = total.saturating_add(usage);
        }
        saturated_control_ticks = saturated_control_ticks.saturating_add(measurement.control_ticks);
        saturated_control_max_gap_micros =
            saturated_control_max_gap_micros.max(measurement.control_max_gap_micros);
    }
    assert!(
        saturated_control_ticks > 100,
        "Runner control ticker made insufficient progress: {}",
        saturated_control_ticks
    );
    assert!(
        saturated_control_max_gap_micros < 1_000_000,
        "Runner control ticker was not scheduled for {} microseconds",
        saturated_control_max_gap_micros
    );

    let normalized = saturated_usage
        .iter()
        .zip(&sandboxes)
        .map(|(usage, sandbox)| *usage as f64 / f64::from(sandbox.vcpu))
        .collect::<Vec<_>>();
    let normalized_ratio = ratio(&normalized)?;
    println!("HOST_CPU_NORMALIZED_RATIO={normalized_ratio:.6}");
    println!("HOST_CPU_CONTROL_TICKS={saturated_control_ticks}");
    println!("HOST_CPU_CONTROL_MAX_GAP_MICROS={saturated_control_max_gap_micros}");

    if mode == TestMode::Managed {
        let max_ratio = required_env("VM0_HOST_CPU_TEST_MAX_NORMALIZED_RATIO")?
            .parse::<f64>()
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("parse VM0_HOST_CPU_TEST_MAX_NORMALIZED_RATIO: {error}"),
                )
            })?;
        assert!(
            normalized_ratio <= max_ratio,
            "normalized Guest CPU progress ratio {normalized_ratio:.3} exceeds baseline-derived {max_ratio:.3}: {normalized:?}"
        );

        let selected = 2;
        let borrowing = run_load_and_measure(mode, &cgroup_root, &sandboxes, &[selected]).await?;
        let saturated_selected = saturated_usage
            .get(selected)
            .copied()
            .ok_or_else(|| io::Error::other("selected saturated sandbox is missing"))?
            / SATURATED_SAMPLES;
        let borrowing_selected = borrowing
            .usage
            .get(selected)
            .copied()
            .ok_or_else(|| io::Error::other("selected borrowing sandbox is missing"))?;
        assert!(
            borrowing_selected as f64 >= saturated_selected as f64 * 1.4,
            "remaining Guest did not borrow idle CPU: saturated={saturated_selected}, borrowing={borrowing_selected}"
        );
    }

    while let Some(running) = sandboxes.pop() {
        factory.destroy(running.sandbox).await;
    }
    if mode == TestMode::Managed {
        verify_no_guest_leaves(&cgroup_root)?;
    }
    factory.shutdown().await;
    runtime.shutdown().await;
    Ok(())
}

async fn run_load_and_measure(
    mode: TestMode,
    cgroup_root: &Path,
    sandboxes: &[RunningSandbox],
    active: &[usize],
) -> TestResult<Measurement> {
    let active_sandboxes = active
        .iter()
        .map(|index| {
            sandboxes
                .get(*index)
                .map(|running| &*running.sandbox)
                .ok_or_else(|| io::Error::other(format!("active sandbox {index} is missing")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let load = async {
        let results = join_all(active_sandboxes.into_iter().map(burn_cpu)).await;
        for result in results {
            let result = result?;
            assert!(
                matches!(result.termination, ExecTermination::Exited { exit_code: 0 }),
                "CPU load failed: {:?}: {}",
                result.termination,
                String::from_utf8_lossy(&result.stderr)
            );
        }
        TestResult::Ok(())
    };
    let sample = async {
        tokio::time::sleep(SAMPLE_WARMUP).await;
        let before = read_usage(mode, cgroup_root, sandboxes)?;
        let stop = Arc::new(AtomicBool::new(false));
        let ticks = Arc::new(AtomicU64::new(0));
        let max_gap_micros = Arc::new(AtomicU64::new(0));
        let ticker_stop = Arc::clone(&stop);
        let ticker_ticks = Arc::clone(&ticks);
        let ticker_max_gap_micros = Arc::clone(&max_gap_micros);
        let ticker = tokio::task::spawn_blocking(move || {
            let mut previous = std::time::Instant::now();
            while !ticker_stop.load(Ordering::Relaxed) {
                let now = std::time::Instant::now();
                let gap_micros =
                    u64::try_from(now.duration_since(previous).as_micros()).unwrap_or(u64::MAX);
                ticker_max_gap_micros.fetch_max(gap_micros, Ordering::Relaxed);
                previous = now;
                ticker_ticks.fetch_add(1, Ordering::Relaxed);
                std::hint::spin_loop();
            }
        });
        tokio::time::sleep(SAMPLE_WINDOW).await;
        let after = read_usage(mode, cgroup_root, sandboxes)?;
        stop.store(true, Ordering::Relaxed);
        ticker.await?;
        let usage = after
            .iter()
            .zip(before)
            .map(|(after, before)| after.saturating_sub(before))
            .collect();
        TestResult::Ok(Measurement {
            usage,
            control_ticks: ticks.load(Ordering::Relaxed),
            control_max_gap_micros: max_gap_micros.load(Ordering::Relaxed),
        })
    };
    let (load_result, measurement) = tokio::join!(load, sample);
    load_result?;
    measurement
}

async fn burn_cpu(sandbox: &dyn Sandbox) -> sandbox::Result<sandbox::ExecResult> {
    sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: CPU_LOAD_COMMAND,
                timeout: Duration::from_secs(15),
                env: &[],
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "host-cpu-metal-load",
        )
        .await
}

fn read_usage(
    mode: TestMode,
    cgroup_root: &Path,
    sandboxes: &[RunningSandbox],
) -> TestResult<Vec<u64>> {
    sandboxes
        .iter()
        .map(|sandbox| match mode {
            TestMode::Baseline => process_cpu_ticks(sandbox_pid(sandbox)?),
            TestMode::Managed => {
                cgroup_usage_usec(&cgroup_root.join("guests").join(sandbox.sandbox.id()))
            }
        })
        .collect()
}

fn process_cpu_ticks(pid: u32) -> TestResult<u64> {
    let task_dir = PathBuf::from(format!("/proc/{pid}/task"));
    let mut total = 0_u64;
    for task in fs::read_dir(task_dir)? {
        let stat = fs::read_to_string(task?.path().join("stat"))?;
        let close = stat.rfind(')').ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "process stat lacks command terminator",
            )
        })?;
        let fields = stat
            .get(close + 2..)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "process stat is truncated"))?
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        let user = parse_stat_field(&fields, 11)?;
        let system = parse_stat_field(&fields, 12)?;
        total = total.saturating_add(user).saturating_add(system);
    }
    Ok(total)
}

fn parse_stat_field(fields: &[&str], index: usize) -> TestResult<u64> {
    fields
        .get(index)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "process stat field missing"))?
        .parse::<u64>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error).into())
}

fn cgroup_usage_usec(path: &Path) -> TestResult<u64> {
    for line in fs::read_to_string(path.join("cpu.stat"))?.lines() {
        if let Some(value) = line.strip_prefix("usage_usec ") {
            return value
                .parse::<u64>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error).into());
        }
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "cpu.stat lacks usage_usec").into())
}

fn verify_managed_hierarchy(root: &Path, sandboxes: &[RunningSandbox]) -> TestResult<()> {
    assert!(
        fs::read_to_string(root.join("cgroup.subtree_control"))?
            .split_ascii_whitespace()
            .any(|controller| controller == "cpu")
    );
    assert!(
        fs::read_to_string(root.join("guests/cgroup.subtree_control"))?
            .split_ascii_whitespace()
            .any(|controller| controller == "cpu")
    );
    assert_eq!(read_u32(root.join("control/cpu.weight"))?, CONTROL_WEIGHT);
    assert_eq!(read_u32(root.join("guests/cpu.weight"))?, GUESTS_WEIGHT);
    assert!(
        fs::read_to_string(root.join("cgroup.procs"))?
            .trim()
            .is_empty()
    );
    for sandbox in sandboxes {
        let leaf = root.join("guests").join(sandbox.sandbox.id());
        assert_eq!(read_u32(leaf.join("cpu.weight"))?, sandbox.vcpu);
        let expected_membership = format!(
            "{}/guests/{}",
            current_unified_membership()?.trim_end_matches("/control"),
            sandbox.sandbox.id()
        );
        let pid = sandbox_pid(sandbox)?;
        for task in fs::read_dir(format!("/proc/{pid}/task"))? {
            let membership = fs::read_to_string(task?.path().join("cgroup"))?;
            assert_eq!(unified_membership(&membership)?, expected_membership);
        }
    }
    Ok(())
}

fn verify_no_guest_leaves(root: &Path) -> TestResult<()> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(root.join("guests"))? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            entries.push(entry.file_name());
        }
    }
    assert!(entries.is_empty(), "stale Guest CPU cgroups: {entries:?}");
    Ok(())
}

fn delegated_root() -> TestResult<PathBuf> {
    let membership = current_unified_membership()?;
    let control = Path::new("/sys/fs/cgroup").join(membership.trim_start_matches('/'));
    control.parent().map(Path::to_path_buf).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "control cgroup has no parent").into()
    })
}

fn current_unified_membership() -> TestResult<String> {
    unified_membership(&fs::read_to_string("/proc/self/cgroup")?)
}

fn unified_membership(raw: &str) -> TestResult<String> {
    let mut matches = raw.lines().filter_map(|line| line.strip_prefix("0::"));
    let value = matches.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "unified cgroup membership missing",
        )
    })?;
    if matches.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "multiple unified cgroup memberships",
        )
        .into());
    }
    Ok(value.to_owned())
}

fn sandbox_pid(sandbox: &RunningSandbox) -> TestResult<u32> {
    sandbox.sandbox.host_process_pid().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "Firecracker host PID unavailable").into()
    })
}

fn ratio(values: &[f64]) -> TestResult<f64> {
    let min = values.iter().copied().reduce(f64::min).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "no normalized CPU measurements",
        )
    })?;
    let max = values.iter().copied().reduce(f64::max).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "no normalized CPU measurements",
        )
    })?;
    if min <= 0.0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "zero CPU progress").into());
    }
    Ok(max / min)
}

fn read_u32(path: PathBuf) -> TestResult<u32> {
    fs::read_to_string(path)?
        .trim()
        .parse::<u32>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error).into())
}

fn required_path(name: &str) -> TestResult<PathBuf> {
    let path = PathBuf::from(required_env(name)?);
    if !path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{name} is not a file: {}", path.display()),
        )
        .into());
    }
    Ok(path)
}

fn required_env(name: &str) -> TestResult<String> {
    std::env::var(name).map_err(|error| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("{name}: {error}")).into()
    })
}
