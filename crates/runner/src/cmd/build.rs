use std::path::{Path, PathBuf};

use clap::Args;
use sandbox::SnapshotProvider;
use sha2::{Digest, Sha256};

use crate::ca;
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, ImagePaths, touch_mtime};
use crate::profile;
use crate::r2_cache::R2ImageCache;

const BUILD_SCRIPT: &str = include_str!("../../scripts/build-rootfs.sh");
const VERIFY_SCRIPT: &str = include_str!("../../scripts/verify-rootfs.sh");

/// Bump this to invalidate all cached images without changing any input files.
/// Affects both the local cache directory and the R2 object key (since the
/// version seeds the hash that names both).
///
/// Bumping leaves the previous-hash R2 objects orphaned; they're swept by
/// `runner gc` after the configured TTL (see `r2_cache::gc_older_than`).
const IMAGE_CACHE_VERSION: u32 = 2;

#[cfg(bundled_guests)]
mod embedded {
    pub const GUEST_INIT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_INIT"));
    pub const GUEST_DOWNLOAD: &[u8] = include_bytes!(env!("BUNDLED_GUEST_DOWNLOAD"));
    pub const GUEST_AGENT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_AGENT"));
    pub const GUEST_MOCK_CLAUDE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CLAUDE"));
    pub const GUEST_RESEED: &[u8] = include_bytes!(env!("BUNDLED_GUEST_RESEED"));
}

#[cfg(bundled_guests)]
fn bundled_guest(name: &str) -> Option<&'static [u8]> {
    match name {
        "guest-agent" => Some(embedded::GUEST_AGENT),
        "guest-download" => Some(embedded::GUEST_DOWNLOAD),
        "guest-init" => Some(embedded::GUEST_INIT),
        "guest-mock-claude" => Some(embedded::GUEST_MOCK_CLAUDE),
        "guest-reseed" => Some(embedded::GUEST_RESEED),
        _ => None,
    }
}

#[cfg(not(bundled_guests))]
fn bundled_guest(_name: &str) -> Option<&'static [u8]> {
    None
}

#[derive(Args)]
pub struct BuildArgs {
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-agent binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-agent binary (required)")
    )]
    guest_agent: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-download binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-download binary (required)")
    )]
    guest_download: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-init binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-init binary (required)")
    )]
    guest_init: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-mock-claude binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-mock-claude binary (required)")
    )]
    guest_mock_claude: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-reseed binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-reseed binary (required)")
    )]
    guest_reseed: Option<PathBuf>,
    /// Profile to build (determines VM resources and disk size)
    #[arg(long)]
    pub profile: String,
    /// Compute and print the image hash without building
    #[arg(long)]
    pub dry_run: bool,
}

/// Resolve a guest binary path: CLI arg takes priority, then bundled binary
/// written to a temp file, otherwise error.
async fn resolve_guest(
    cli_path: Option<PathBuf>,
    name: &str,
    tmp_dir: &Path,
) -> RunnerResult<PathBuf> {
    if let Some(p) = cli_path {
        return Ok(p);
    }
    if let Some(bytes) = bundled_guest(name) {
        let dest = tmp_dir.join(name);
        tokio::fs::write(&dest, bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("write bundled {name}: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .await
                .map_err(|e| RunnerError::Internal(format!("chmod {name}: {e}")))?;
        }
        return Ok(dest);
    }
    Err(RunnerError::Internal(format!(
        "missing --{} and no bundled binary available",
        name
    )))
}

/// Build a unified image (rootfs + snapshot) and return the image hash.
pub async fn run_build(args: BuildArgs, provider: &dyn SnapshotProvider) -> RunnerResult<()> {
    let def = profile::get(&args.profile)?;
    let dry_run = args.dry_run;

    // Create temp dir for any bundled guest binaries that need extracting.
    // IMPORTANT: tmp_dir must outlive build script execution — dropping it deletes extracted guests.
    let tmp_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;

    // Resolve all guest binary paths (CLI arg → bundled → error).
    let guest_agent = resolve_guest(args.guest_agent, "guest-agent", tmp_dir.path()).await?;
    let guest_download =
        resolve_guest(args.guest_download, "guest-download", tmp_dir.path()).await?;
    let guest_init = resolve_guest(args.guest_init, "guest-init", tmp_dir.path()).await?;
    let guest_mock_claude =
        resolve_guest(args.guest_mock_claude, "guest-mock-claude", tmp_dir.path()).await?;
    let guest_reseed = resolve_guest(args.guest_reseed, "guest-reseed", tmp_dir.path()).await?;

    // Fixed order for deterministic hashing — do NOT reorder.
    let bins: [(&Path, &str); 5] = [
        (guest_agent.as_path(), "/usr/local/bin/guest-agent"),
        (guest_download.as_path(), "/usr/local/bin/guest-download"),
        (guest_init.as_path(), "/sbin/guest-init"),
        (guest_reseed.as_path(), "/sbin/guest-reseed"),
        (
            guest_mock_claude.as_path(),
            "/usr/local/bin/guest-mock-claude",
        ),
    ];

    // Compute unified image hash from all rootfs + snapshot inputs.
    let hash = compute_image_hash(&bins, def.disk_mb, provider, def.vcpu, def.memory_mb).await?;
    tracing::info!("image hash: {hash}");
    // Machine-readable output — do not change format without updating consumers
    println!("image_hash={hash}");

    if dry_run {
        return Ok(());
    }

    let paths = HomePaths::new()?;

    // Ensure CA exists — rootfs build embeds the CA cert into the image.
    ca::ensure(&paths).await?;

    let image = ImagePaths::new(&paths, &hash);
    let output_dir = image.dir();

    if is_image_complete(&image).await? {
        tracing::info!("[OK] image already built: {}", output_dir.display());
        touch_mtime(output_dir);
        return Ok(());
    }

    // R2 cache init. Fatal on partial config (1-3 of 4 vars set) — better than
    // silently disabling cache for a typo'd secret rotation.
    let r2 = R2ImageCache::from_env()
        .await
        .map_err(|e| RunnerError::Internal(format!("R2 cache init: {e}")))?;
    if r2.is_none() {
        // Info, not warn — dev environments routinely run without R2 configured.
        tracing::info!("R2 cache disabled (R2_* env vars not set) — skipping download and upload");
    }

    // Acquire exclusive lock to prevent concurrent builds with the same hash.
    let _lock = lock::acquire(paths.image_lock(&hash)).await?;

    // Re-check after acquiring lock — another process may have completed the build.
    if is_image_complete(&image).await? {
        tracing::info!("[OK] image already built: {}", output_dir.display());
        touch_mtime(output_dir);
        return Ok(());
    }

    // Try R2 download before falling back to local build. try_download manages
    // its own staging directory and atomic rename, so output_dir stays absent
    // on failure (no false-positive cache hits from partial unpack).
    //
    // `force_reupload`: set when we observed a structurally-valid download
    // (Ok(true)) whose extracted content failed `is_image_complete`. Without
    // it the next `upload` call would dedup-skip on `exists() = true` and
    // leave the bad object in place, locking the entire fleet out of this
    // hash. We pass it through as `force` to `upload` rather than calling
    // `delete` first — force-upload is a single atomic PUT that doesn't
    // depend on `s3:DeleteObject` permission being healthy (a persistently
    // failing delete would otherwise leave the corruption stuck forever).
    let mut force_reupload = false;
    if let Some(cache) = &r2 {
        match cache.try_download(&hash, output_dir).await {
            Ok(true) => {
                if is_image_complete(&image).await? {
                    tracing::info!("[OK] image downloaded from R2: {}", output_dir.display());
                    touch_mtime(output_dir);
                    return Ok(());
                }
                tracing::warn!(
                    "R2 download for {hash} succeeded but image incomplete — \
                     will rebuild locally and force-overwrite the bad object"
                );
                force_reupload = true;
            }
            Ok(false) => tracing::info!("R2 cache miss for {hash} — building locally"),
            // Err is ambiguous (transient network vs. content corruption);
            // we don't force-overwrite here — false overwrite on a network
            // blip would amplify load (every host re-uploads the same hash).
            Err(e) => tracing::warn!("R2 download failed: {e} — falling back to local build"),
        }
    }

    // --- Phase 1: Build rootfs ---

    // Clean up any partial build from a previous failed attempt so we start fresh.
    if tokio::fs::try_exists(&output_dir).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(&output_dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("clean {}: {e}", output_dir.display())))?;
    }
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", output_dir.display())))?;

    // Write scripts to a temp directory
    let work_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(work_dir.path().join("build-rootfs.sh"), BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write build script: {e}")))?;
    tokio::fs::write(work_dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;

    let script_path = work_dir.path().join("build-rootfs.sh");
    let output_dir_str = output_dir.to_string_lossy();
    let guest_agent_str = guest_agent.to_string_lossy();
    let guest_download_str = guest_download.to_string_lossy();
    let guest_init_str = guest_init.to_string_lossy();
    let guest_mock_claude_str = guest_mock_claude.to_string_lossy();
    let guest_reseed_str = guest_reseed.to_string_lossy();
    let ca_dir = paths.ca_dir();
    let ca_dir_str = ca_dir.to_string_lossy();
    let debootstrap_dir = paths.debootstrap_dir();
    tokio::fs::create_dir_all(&debootstrap_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", debootstrap_dir.display())))?;
    let debootstrap_dir_str = debootstrap_dir.to_string_lossy();
    let disk_mb_str = def.disk_mb.to_string();

    let status = tokio::process::Command::new("bash")
        .arg(&script_path)
        .args([
            "--output-dir",
            &output_dir_str,
            "--ca-dir",
            &ca_dir_str,
            "--debootstrap-dir",
            &debootstrap_dir_str,
            "--hash",
            &hash,
            "--disk-mb",
            &disk_mb_str,
            "--guest-agent",
            &guest_agent_str,
            "--guest-download",
            &guest_download_str,
            "--guest-init",
            &guest_init_str,
            "--guest-mock-claude",
            &guest_mock_claude_str,
            "--guest-reseed",
            &guest_reseed_str,
            // Dummy nameserver — all UDP 53 is iptables-REDIRECT'd to dnsmasq.
            // Must be routable (not loopback/gateway) so packets leave the VM.
            "--dns-nameserver",
            "8.8.8.8",
        ])
        .stdin(std::process::Stdio::null())
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn build script: {e}")))?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "build-rootfs.sh failed with {status}"
        )));
    }

    // Verify rootfs contents (verify script is NOT part of the input hash)
    let rootfs_path = image.rootfs();
    let verify_path = work_dir.path().join("verify-rootfs.sh");
    let rootfs_str = rootfs_path.to_string_lossy();

    let status = tokio::process::Command::new("bash")
        .arg(&verify_path)
        .args(["--rootfs", &rootfs_str])
        .stdin(std::process::Stdio::null())
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn verify script: {e}")))?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "verify-rootfs.sh failed with {status}"
        )));
    }

    let rootfs_sz = file_sizes(&rootfs_path).await;
    tracing::info!(
        rootfs = %rootfs_path.display(),
        rootfs_logical = %rootfs_sz.0,
        rootfs_disk = %rootfs_sz.1,
        "rootfs creation complete"
    );

    // --- Phase 2: Build snapshot ---

    let create_config = sandbox::SnapshotCreateConfig {
        id: hash.clone(),
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path,
        output_dir: output_dir.to_path_buf(),
        vcpu_count: def.vcpu,
        memory_mb: def.memory_mb,
    };

    let output = provider.create_snapshot(create_config).await?;

    let (snapshot_sz, memory_sz, cow_sz) = tokio::join!(
        file_sizes(&output.snapshot_path),
        file_sizes(&output.memory_path),
        file_sizes(&output.cow_path),
    );
    tracing::info!(
        snapshot = %output.snapshot_path.display(),
        snapshot_logical = %snapshot_sz.0,
        snapshot_disk = %snapshot_sz.1,
        memory = %output.memory_path.display(),
        memory_logical = %memory_sz.0,
        memory_disk = %memory_sz.1,
        cow = %output.cow_path.display(),
        cow_logical = %cow_sz.0,
        cow_disk = %cow_sz.1,
        "snapshot creation complete"
    );

    // Synchronous R2 upload after Phase 2. Failure is non-fatal — the image is
    // already on local disk; subsequent hosts just won't get a cache hit.
    // `exists()` dedup inside `upload()` avoids same-deploy N-host duplicate
    // uploads; `force_reupload` bypasses dedup so a previously-detected
    // corrupt object gets atomically overwritten.
    if let Some(cache) = &r2 {
        let files = image.expected_files().to_vec();
        match cache.upload(&hash, &files, force_reupload).await {
            Ok(()) => tracing::info!("uploaded image to R2: {hash}"),
            Err(e) => tracing::warn!("R2 upload failed: {e} — image is on local disk"),
        }
    }

    tracing::info!("image creation complete: {hash}");
    Ok(())
}

/// Check whether all expected image outputs exist in the directory.
async fn is_image_complete(image: &ImagePaths) -> RunnerResult<bool> {
    for path in image.expected_files() {
        let exists = tokio::fs::try_exists(&path)
            .await
            .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Read a sysfs file, trimming whitespace. Returns empty string on failure.
fn read_sysfs_trimmed(path: &str) -> String {
    match std::fs::read_to_string(path) {
        Ok(s) => s.trim().to_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            tracing::warn!("failed to read {path}: {e}");
            String::new()
        }
    }
}

/// Read CPU microcode/revision version.
///
/// On x86_64: `/sys/devices/system/cpu/cpu0/microcode/version`
/// On ARM64: `/sys/devices/system/cpu/cpu0/regs/identification/revidr_el1`
fn read_cpu_microcode() -> Option<String> {
    let paths = [
        "/sys/devices/system/cpu/cpu0/microcode/version",
        "/sys/devices/system/cpu/cpu0/regs/identification/revidr_el1",
    ];
    for path in paths {
        match std::fs::read_to_string(path) {
            Ok(v) => {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_owned());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("failed to read {path}: {e}"),
        }
    }
    None
}

/// Read a stable CPU model identifier from `/proc/cpuinfo`.
///
/// On ARM64 this extracts `CPU implementer`, `CPU part`, and `CPU variant`
/// (e.g. "0x41:0xd40:0x1" for Neoverse V1 / Graviton 3).
/// On x86_64 this extracts the `model name` line.
fn read_cpu_model() -> Option<String> {
    let cpuinfo = match std::fs::read_to_string("/proc/cpuinfo") {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("failed to read /proc/cpuinfo: {e}");
            return None;
        }
    };

    // ARM64: combine implementer + part + variant
    let get = |key: &str| -> Option<&str> {
        cpuinfo.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.trim() == key {
                Some(v.trim())
            } else {
                None
            }
        })
    };

    if let (Some(implementer), Some(part)) = (get("CPU implementer"), get("CPU part")) {
        let variant = get("CPU variant").unwrap_or("0x0");
        return Some(format!("{implementer}:{part}:{variant}"));
    }

    // x86_64: use model name
    if let Some(model) = get("model name") {
        return Some(model.to_owned());
    }

    tracing::warn!("could not determine CPU model from /proc/cpuinfo");
    None
}

/// Compute a unified hash from all rootfs + snapshot inputs.
///
/// Inputs:
///   - `IMAGE_CACHE_VERSION` — bump to force invalidation
///   - `BUILD_SCRIPT` — rootfs build script content
///   - `disk_mb` — disk size from profile
///   - guest binaries — sorted by destination path
///   - `provider.config_hash()` — boot args, guest network config
///   - `FIRECRACKER_VERSION` / `KERNEL_VERSION` — binary versions
///   - `vcpu` / `memory_mb` — VM resource settings
///   - host kernel version (`uname -r`)
///   - CPU model (implementer:part:variant on ARM, model name on x86)
///   - CPU microcode/revision version
///   - BIOS version and release
///
/// **Changing this function invalidates all cached images.**
async fn compute_image_hash(
    guest_bins: &[(&Path, &str)],
    disk_mb: u32,
    provider: &dyn SnapshotProvider,
    vcpu: u32,
    memory_mb: u32,
) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    // Cache version seed — bump IMAGE_CACHE_VERSION to force invalidation.
    hasher.update(b"version:");
    hasher.update(IMAGE_CACHE_VERSION.to_le_bytes());

    // Rootfs inputs
    hasher.update(b"script:");
    hasher.update(BUILD_SCRIPT.as_bytes());
    hasher.update(b"disk_mb:");
    hasher.update(disk_mb.to_le_bytes());

    for (src, dest) in guest_bins {
        let content = tokio::fs::read(src)
            .await
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", src.display())))?;
        let tag = format!("bin:{dest}:");
        hasher.update(tag.as_bytes());
        hasher.update(&content);
    }

    // Snapshot inputs
    hasher.update(b"fc_config:");
    hasher.update(provider.config_hash().as_bytes());
    hasher.update(b"firecracker:");
    hasher.update(FIRECRACKER_VERSION.as_bytes());
    hasher.update(b"kernel:");
    hasher.update(KERNEL_VERSION.as_bytes());
    hasher.update(b"vcpu:");
    hasher.update(vcpu.to_le_bytes());
    hasher.update(b"memory_mb:");
    hasher.update(memory_mb.to_le_bytes());

    // Host kernel version — snapshots are not portable across kernel versions
    // because KVM exposes different registers (e.g. ARM64 firmware pseudo-regs).
    let uname =
        nix::sys::utsname::uname().map_err(|e| RunnerError::Internal(format!("uname: {e}")))?;
    hasher.update(b"host_kernel:");
    hasher.update(uname.release().as_encoded_bytes());

    // CPU model — different CPU models expose different registers and features,
    // making snapshots non-portable (e.g. Graviton 2 vs 3).
    hasher.update(b"cpu_model:");
    let cpu_id = read_cpu_model().unwrap_or_default();
    hasher.update(cpu_id.as_bytes());

    // CPU microcode/revision — microcode updates can change available MSRs (x86)
    // or CPU behavior (ARM). Gracefully defaults to empty if not available.
    hasher.update(b"cpu_microcode:");
    hasher.update(read_cpu_microcode().unwrap_or_default().as_bytes());

    // BIOS/firmware version and revision — firmware updates can change ACPI tables,
    // CPU feature advertisement, and memory map, affecting KVM register state in
    // snapshots. Both fields can change independently.
    hasher.update(b"bios_version:");
    hasher.update(read_sysfs_trimmed("/sys/devices/virtual/dmi/id/bios_version").as_bytes());
    hasher.update(b"bios_release:");
    hasher.update(read_sysfs_trimmed("/sys/devices/virtual/dmi/id/bios_release").as_bytes());

    Ok(hex::encode(hasher.finalize()))
}

/// Return `(logical, disk)` as human-readable strings (e.g. "65.2 MiB").
///
/// `logical` is the apparent file size; `disk` is the actual disk usage
/// (from `st_blocks`), which can be much smaller for sparse files like rootfs.
async fn file_sizes(path: &Path) -> (String, String) {
    use std::os::unix::fs::MetadataExt;
    match tokio::fs::metadata(path).await {
        Ok(m) => {
            const BYTES_PER_BLOCK: u64 = 512;
            let logical = human_bytes(m.len());
            let disk = human_bytes(m.blocks() * BYTES_PER_BLOCK);
            (logical, disk)
        }
        Err(_) => ("?".into(), "?".into()),
    }
}

fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.1} GiB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.1} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_formatting() {
        let cases: &[(u64, &str)] = &[
            (0, "0 B"),
            (1, "1 B"),
            (1023, "1023 B"),
            (1024, "1.0 KiB"),
            (1536, "1.5 KiB"),
            (1048576, "1.0 MiB"),
            (10 * 1048576, "10.0 MiB"),
            (1073741824, "1.0 GiB"),
            (2 * 1073741824 + 536870912, "2.5 GiB"),
        ];
        for &(input, expected) in cases {
            assert_eq!(human_bytes(input), expected, "human_bytes({input})");
        }
    }

    #[tokio::test]
    async fn compute_image_hash_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        tokio::fs::write(&bin, b"binary-content").await.unwrap();
        let bins: &[(&Path, &str)] = &[(&bin, "/usr/local/bin/guest-agent")];
        let provider = sandbox_mock::MockSnapshotProvider;

        let h1 = compute_image_hash(bins, 16384, &provider, 2, 2048)
            .await
            .unwrap();
        let h2 = compute_image_hash(bins, 16384, &provider, 2, 2048)
            .await
            .unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    /// Verify that each parameterized input changes the hash.
    ///
    /// Note: host-specific inputs (kernel version, CPU model, microcode, BIOS)
    /// are read from the runtime environment and cannot be varied in tests.
    /// Their inclusion is validated by `compute_image_hash_deterministic`.
    #[tokio::test]
    async fn compute_image_hash_sensitive_to_all_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();
        let provider = sandbox_mock::MockSnapshotProvider;

        let base = compute_image_hash(
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            16384,
            &provider,
            2,
            2048,
        )
        .await
        .unwrap();

        // Different binary content
        let different_content = compute_image_hash(
            &[(&bin_b, "/usr/local/bin/guest-agent")],
            16384,
            &provider,
            2,
            2048,
        )
        .await
        .unwrap();
        assert_ne!(
            base, different_content,
            "hash must change with binary content"
        );

        // Different disk_mb
        let different_disk = compute_image_hash(
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            32768,
            &provider,
            2,
            2048,
        )
        .await
        .unwrap();
        assert_ne!(base, different_disk, "hash must change with disk_mb");

        // Different dest path
        let different_dest = compute_image_hash(
            &[(&bin_a, "/usr/local/bin/guest-download")],
            16384,
            &provider,
            2,
            2048,
        )
        .await
        .unwrap();
        assert_ne!(base, different_dest, "hash must change with dest path");

        // Different vcpu
        let different_vcpu = compute_image_hash(
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            16384,
            &provider,
            4,
            2048,
        )
        .await
        .unwrap();
        assert_ne!(base, different_vcpu, "hash must change with vcpu");

        // Different memory_mb
        let different_memory = compute_image_hash(
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            16384,
            &provider,
            2,
            4096,
        )
        .await
        .unwrap();
        assert_ne!(base, different_memory, "hash must change with memory_mb");

        // Different provider
        let different_provider = compute_image_hash(
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            16384,
            &sandbox_fc::FirecrackerSnapshotProvider,
            2,
            2048,
        )
        .await
        .unwrap();
        assert_ne!(base, different_provider, "hash must change with provider");
    }

    #[tokio::test]
    async fn is_image_complete_requires_all_four_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let image = ImagePaths::new(&home, "test-hash");
        tokio::fs::create_dir_all(image.dir()).await.unwrap();

        // Empty directory → incomplete
        assert!(!is_image_complete(&image).await.unwrap());

        // Only rootfs → incomplete
        tokio::fs::write(image.rootfs(), b"").await.unwrap();
        assert!(!is_image_complete(&image).await.unwrap());

        // rootfs + snapshot.bin → incomplete
        tokio::fs::write(image.snapshot_bin(), b"").await.unwrap();
        assert!(!is_image_complete(&image).await.unwrap());

        // rootfs + snapshot.bin + memory.bin → incomplete
        tokio::fs::write(image.memory_bin(), b"").await.unwrap();
        assert!(!is_image_complete(&image).await.unwrap());

        // All four files → complete
        tokio::fs::write(image.cow_img(), b"").await.unwrap();
        assert!(is_image_complete(&image).await.unwrap());
    }

    #[tokio::test]
    async fn is_image_complete_nonexistent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let image = ImagePaths::new(&home, "does-not-exist");

        assert!(!is_image_complete(&image).await.unwrap());
    }

    #[tokio::test]
    async fn file_sizes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();

        let (logical, disk) = file_sizes(&path).await;
        assert_eq!(logical, "1.0 KiB");
        assert_ne!(disk, "?");
    }

    #[tokio::test]
    async fn file_sizes_nonexistent_file() {
        let (logical, disk) = file_sizes(Path::new("/nonexistent/file.bin")).await;
        assert_eq!(logical, "?");
        assert_eq!(disk, "?");
    }
}
