use std::fs::File;
use std::path::{Path, PathBuf};

use clap::Args;
use nix::fcntl::Flock;
use sandbox::SnapshotProvider;
use sha2::{Digest, Sha256};

use crate::ca;
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, RootfsPaths, touch_mtime};
use crate::profile;
use crate::r2_cache::R2ImageCache;

const TEMPLATE_BUILD_SCRIPT: &str = include_str!("../../scripts/build-template.sh");
const VERIFY_SCRIPT: &str = include_str!("../../scripts/verify-rootfs.sh");
const CUSTOMIZE_SCRIPT: &str = include_str!("../../scripts/customize-rootfs.sh");

const GUEST_AGENT_DEST: &str = "/usr/local/bin/guest-agent";
const GUEST_DOWNLOAD_DEST: &str = "/usr/local/bin/guest-download";
const GUEST_INIT_DEST: &str = "/sbin/guest-init";
const GUEST_RESEED_DEST: &str = "/sbin/guest-reseed";
const GUEST_MOCK_CLAUDE_DEST: &str = "/usr/local/bin/guest-mock-claude";
const GUEST_MOCK_CODEX_DEST: &str = "/usr/local/bin/guest-mock-codex";
const ROOTFS_DNS_NAMESERVER: &str = "8.8.8.8";
const TEMPLATE_FILE: &str = "template.ext4";
const TEMPLATE_DOWNLOAD_FILE: &str = "downloaded-template.ext4";
const TEMPLATE_WARM_DIR_PREFIX: &str = "template-warm-";
const TEMPLATE_WARM_ATTEMPT_DIR_PREFIX: &str = "attempt-";
const TEMPLATE_BUILD_DIR_PREFIX: &str = "template-build-";
const TEMPLATE_ATTEMPT_DIR_SUFFIX: &str = ".tmp";

/// Bump to invalidate all shared template images in R2.
///
/// Bumping orphans previous R2 objects; swept by `runner gc` after TTL.
const TEMPLATE_CACHE_VERSION: u32 = 1;

/// Bump to invalidate all local rootfs images.
///
/// Rootfs images are not shared through R2 because they include guest binaries
/// and host-local CA material.
const ROOTFS_CACHE_VERSION: u32 = 1;

/// Bump to invalidate all cached snapshots (local only; R2 stores only the template).
const SNAPSHOT_CACHE_VERSION: u32 = 3;

#[cfg(bundled_guests)]
mod embedded {
    pub const GUEST_INIT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_INIT"));
    pub const GUEST_DOWNLOAD: &[u8] = include_bytes!(env!("BUNDLED_GUEST_DOWNLOAD"));
    pub const GUEST_AGENT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_AGENT"));
    pub const GUEST_MOCK_CLAUDE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CLAUDE"));
    pub const GUEST_MOCK_CODEX: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CODEX"));
    pub const GUEST_RESEED: &[u8] = include_bytes!(env!("BUNDLED_GUEST_RESEED"));
}

#[cfg(bundled_guests)]
fn bundled_guest(name: &str) -> Option<&'static [u8]> {
    match name {
        "guest-agent" => Some(embedded::GUEST_AGENT),
        "guest-download" => Some(embedded::GUEST_DOWNLOAD),
        "guest-init" => Some(embedded::GUEST_INIT),
        "guest-mock-claude" => Some(embedded::GUEST_MOCK_CLAUDE),
        "guest-mock-codex" => Some(embedded::GUEST_MOCK_CODEX),
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
        arg(long, help = "Path to guest-mock-codex binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-mock-codex binary (required)")
    )]
    guest_mock_codex: Option<PathBuf>,
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
    /// Build or upload only the shared R2 template cache, without creating a snapshot
    #[arg(long)]
    pub warm_rootfs_cache: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BuildMode {
    FullImage,
    WarmRootfsCache,
}

impl BuildMode {
    fn from_args(args: &BuildArgs) -> Self {
        if args.warm_rootfs_cache {
            Self::WarmRootfsCache
        } else {
            Self::FullImage
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum TemplateCache<'a> {
    Disabled,
    BestEffort(&'a R2ImageCache),
    Required(&'a R2ImageCache),
}

impl<'a> TemplateCache<'a> {
    fn from_optional(mode: BuildMode, cache: Option<&'a R2ImageCache>) -> RunnerResult<Self> {
        match (mode, cache) {
            (BuildMode::FullImage, Some(cache)) => Ok(Self::BestEffort(cache)),
            (BuildMode::WarmRootfsCache, Some(cache)) => Ok(Self::Required(cache)),
            (BuildMode::FullImage, None) => Ok(Self::Disabled),
            (BuildMode::WarmRootfsCache, None) => Err(RunnerError::Internal(
                "--warm-rootfs-cache requires all R2_* template cache environment variables".into(),
            )),
        }
    }

    fn as_cache(self) -> Option<&'a R2ImageCache> {
        match self {
            Self::Disabled => None,
            Self::BestEffort(cache) | Self::Required(cache) => Some(cache),
        }
    }

    fn is_required(self) -> bool {
        matches!(self, Self::Required(_))
    }

    fn is_disabled(self) -> bool {
        matches!(self, Self::Disabled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TemplateUploadIntent {
    Deduplicated,
    ForceOverwriteInvalidRemote,
}

impl TemplateUploadIntent {
    fn force(self) -> bool {
        matches!(self, Self::ForceOverwriteInvalidRemote)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteTemplateDecision {
    UseDownloaded,
    BuildAndUpload(TemplateUploadIntent),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TemplateMaterializationMode {
    FullImage,
    WarmRootfsCache,
}

impl TemplateMaterializationMode {
    fn is_warm_cache(self) -> bool {
        matches!(self, Self::WarmRootfsCache)
    }
}

#[derive(Clone, Copy, Debug)]
enum TemplateMaterializationTarget<'a> {
    RootfsStaging(&'a Path),
    RemoteCacheOnly,
}

impl TemplateMaterializationTarget<'_> {
    fn mode(self) -> TemplateMaterializationMode {
        match self {
            Self::RootfsStaging(_) => TemplateMaterializationMode::FullImage,
            Self::RemoteCacheOnly => TemplateMaterializationMode::WarmRootfsCache,
        }
    }

    fn materialize_downloaded(
        self,
        input: &TemplateInput<'_>,
        downloaded_template: &Path,
    ) -> RunnerResult<()> {
        match self {
            Self::RootfsStaging(staging) => {
                move_file_sync(downloaded_template, staging, "materialize template")?;
                tracing::info!(
                    "[OK] template downloaded from R2 into staging: {}",
                    staging.display()
                );
                Ok(())
            }
            Self::RemoteCacheOnly => {
                tracing::info!("[OK] template already in R2: {}", input.template_hash);
                Ok(())
            }
        }
    }

    fn materialize_built(self, built_template: &Path) -> RunnerResult<()> {
        match self {
            Self::RootfsStaging(staging) => {
                move_file_sync(built_template, staging, "move template to staging")
            }
            Self::RemoteCacheOnly => Ok(()),
        }
    }
}

struct TemplateInput<'a> {
    paths: &'a HomePaths,
    template_hash: &'a str,
    cache: TemplateCache<'a>,
    disk_mb: u32,
}

struct RootfsBuildInput<'a> {
    template: TemplateInput<'a>,
    rootfs_paths: &'a RootfsPaths,
    guests: &'a GuestBinaries,
}

enum RootfsImageLock {
    Shared { _guard: Flock<File> },
    Exclusive { _guard: Flock<File> },
}

impl RootfsImageLock {
    fn is_exclusive(&self) -> bool {
        matches!(self, Self::Exclusive { .. })
    }

    #[cfg(test)]
    fn is_shared(&self) -> bool {
        matches!(self, Self::Shared { .. })
    }
}

async fn acquire_rootfs_lock_for_image_build(
    paths: &HomePaths,
    rootfs_hash: &str,
    rootfs_paths: &RootfsPaths,
) -> RunnerResult<RootfsImageLock> {
    acquire_rootfs_lock_for_image_build_inner(paths, rootfs_hash, rootfs_paths, || {}).await
}

async fn acquire_rootfs_lock_for_image_build_inner(
    paths: &HomePaths,
    rootfs_hash: &str,
    rootfs_paths: &RootfsPaths,
    mut before_shared_lock: impl FnMut(),
) -> RunnerResult<RootfsImageLock> {
    let rootfs_lock_path = paths.rootfs_lock(rootfs_hash);

    loop {
        if is_rootfs_present(rootfs_paths).await? {
            before_shared_lock();
            tracing::info!(
                "acquiring shared rootfs lock for image build: {}",
                rootfs_lock_path.display()
            );
            let guard = lock::acquire_shared(rootfs_lock_path.clone()).await?;
            if is_rootfs_present(rootfs_paths).await? {
                return Ok(RootfsImageLock::Shared { _guard: guard });
            }
            drop(guard);
            tracing::info!(
                "rootfs disappeared while acquiring shared rootfs lock; retrying image build lock"
            );
            continue;
        }

        tracing::info!(
            "acquiring exclusive rootfs lock for image build: {}",
            rootfs_lock_path.display()
        );
        let guard = lock::acquire(rootfs_lock_path.clone()).await?;
        if is_rootfs_present(rootfs_paths).await? {
            drop(guard);
            tracing::info!(
                "rootfs appeared while acquiring exclusive rootfs lock; retrying with shared lock"
            );
            continue;
        }

        return Ok(RootfsImageLock::Exclusive { _guard: guard });
    }
}

struct BuildHashes {
    template_hash: String,
    rootfs_hash: Option<String>,
    snapshot_hash: Option<String>,
}

struct TemplateLockRelease(Option<Box<dyn FnOnce() + Send>>);

impl TemplateLockRelease {
    #[cfg(test)]
    fn none() -> Self {
        Self(None)
    }

    fn from_release(release: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(release)))
    }

    fn release(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

impl Drop for TemplateLockRelease {
    fn drop(&mut self) {
        self.release();
    }
}

struct GuestBinaries {
    // Keeps extracted bundled guest binaries alive for hash computation and
    // customize-rootfs.sh execution.
    _temp_dir: tempfile::TempDir,
    guest_agent: PathBuf,
    guest_download: PathBuf,
    guest_init: PathBuf,
    guest_mock_claude: PathBuf,
    guest_mock_codex: PathBuf,
    guest_reseed: PathBuf,
}

impl GuestBinaries {
    async fn resolve(args: &mut BuildArgs) -> RunnerResult<Self> {
        let temp_dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
        let temp_path = temp_dir.path();
        let guest_agent = resolve_guest(args.guest_agent.take(), "guest-agent", temp_path).await?;
        let guest_download =
            resolve_guest(args.guest_download.take(), "guest-download", temp_path).await?;
        let guest_init = resolve_guest(args.guest_init.take(), "guest-init", temp_path).await?;
        let guest_mock_claude = resolve_guest(
            args.guest_mock_claude.take(),
            "guest-mock-claude",
            temp_path,
        )
        .await?;
        let guest_mock_codex =
            resolve_guest(args.guest_mock_codex.take(), "guest-mock-codex", temp_path).await?;
        let guest_reseed =
            resolve_guest(args.guest_reseed.take(), "guest-reseed", temp_path).await?;

        Ok(Self {
            _temp_dir: temp_dir,
            guest_agent,
            guest_download,
            guest_init,
            guest_mock_claude,
            guest_mock_codex,
            guest_reseed,
        })
    }

    fn hash_inputs(&self) -> [(&Path, &str); 6] {
        [
            (self.guest_agent.as_path(), GUEST_AGENT_DEST),
            (self.guest_download.as_path(), GUEST_DOWNLOAD_DEST),
            (self.guest_init.as_path(), GUEST_INIT_DEST),
            (self.guest_reseed.as_path(), GUEST_RESEED_DEST),
            (self.guest_mock_claude.as_path(), GUEST_MOCK_CLAUDE_DEST),
            (self.guest_mock_codex.as_path(), GUEST_MOCK_CODEX_DEST),
        ]
    }
}

/// Resolve a guest binary path: CLI arg takes priority, then bundled binary.
///
/// The returned path always points into `tmp_dir`, so hash computation and
/// rootfs customization consumes the same bytes even if the original CLI
/// path is replaced while the build is running.
async fn resolve_guest(
    cli_path: Option<PathBuf>,
    name: &str,
    tmp_dir: &Path,
) -> RunnerResult<PathBuf> {
    let dest = tmp_dir.join(name);
    if let Some(p) = cli_path {
        tokio::fs::copy(&p, &dest).await.map_err(|e| {
            RunnerError::Internal(format!(
                "copy {name} {} → {}: {e}",
                p.display(),
                dest.display()
            ))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .await
                .map_err(|e| RunnerError::Internal(format!("chmod {name}: {e}")))?;
        }
        return Ok(dest);
    }
    if let Some(bytes) = bundled_guest(name) {
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

/// Build an image (template from R2 cache or local build, snapshot always local).
pub async fn run_build(mut args: BuildArgs, provider: &dyn SnapshotProvider) -> RunnerResult<()> {
    let def = profile::get(&args.profile)?;
    let dry_run = args.dry_run;
    let mode = BuildMode::from_args(&args);
    let paths = HomePaths::new()?;

    let guests = match mode {
        BuildMode::FullImage => Some(GuestBinaries::resolve(&mut args).await?),
        BuildMode::WarmRootfsCache => None,
    };

    let template_hash = compute_template_hash(def.disk_mb);
    let hashes = match mode {
        BuildMode::WarmRootfsCache => BuildHashes {
            template_hash,
            rootfs_hash: None,
            snapshot_hash: None,
        },
        BuildMode::FullImage => {
            let guests = guests.as_ref().ok_or_else(|| {
                RunnerError::Internal("full image build missing guest binaries".into())
            })?;
            // Ensure CA exists before hashing the rootfs. The shared template
            // hash deliberately excludes CA, but the local rootfs identity must
            // change if this host's CA changes.
            ca::ensure(&paths).await?;
            let ca_fingerprint = compute_ca_cert_fingerprint(&paths).await?;
            let rootfs_hash = compute_rootfs_hash(
                &template_hash,
                &guests.hash_inputs(),
                &ca_fingerprint,
                def.disk_mb,
            )
            .await?;
            let snapshot_hash = compute_snapshot_hash(
                &rootfs_hash,
                def.vcpu,
                def.memory_mb,
                FIRECRACKER_VERSION,
                KERNEL_VERSION,
                &provider.config_hash(),
            );
            BuildHashes {
                template_hash,
                rootfs_hash: Some(rootfs_hash),
                snapshot_hash: Some(snapshot_hash),
            }
        }
    };

    tracing::info!(
        template_hash = %hashes.template_hash,
        rootfs_hash = hashes.rootfs_hash.as_deref().unwrap_or("<warm-only>"),
        snapshot_hash = hashes.snapshot_hash.as_deref().unwrap_or("<warm-only>"),
        "computed build hashes"
    );
    // Machine-readable output consumed by CI workflows and ansible playbooks.
    // Keep stdout limited to config-facing hashes; the internal template
    // hash is already emitted through tracing above.
    if let Some(rootfs_hash) = hashes.rootfs_hash.as_ref() {
        println!("rootfs_hash={rootfs_hash}");
    }
    if let Some(snapshot_hash) = hashes.snapshot_hash.as_ref() {
        println!("snapshot_hash={snapshot_hash}");
    }

    if dry_run {
        return Ok(());
    }

    let rootfs_hash = hashes.rootfs_hash.as_deref();
    let snapshot_hash = hashes.snapshot_hash.as_deref();
    let rootfs_paths = rootfs_hash.map(|hash| RootfsPaths::new(&paths, hash));
    let snapshot_paths = rootfs_paths
        .as_ref()
        .zip(snapshot_hash)
        .map(|(rootfs, hash)| rootfs.snapshot(hash));
    let snapshot_dir = snapshot_paths.as_ref().map(|snapshot| snapshot.dir());

    // Fast path: both rootfs and snapshot already present.
    if let (
        BuildMode::FullImage,
        Some(rootfs_paths),
        Some(snapshot_dir),
        Some(rootfs_hash),
        Some(snapshot_hash),
    ) = (
        mode,
        rootfs_paths.as_ref(),
        snapshot_dir,
        rootfs_hash,
        snapshot_hash,
    ) && is_rootfs_present(rootfs_paths).await?
        && provider.is_complete(snapshot_dir).await.unwrap_or(false)
    {
        let _rootfs_lock = lock::acquire_shared(paths.rootfs_lock(rootfs_hash)).await?;
        let rootfs_still_present = is_rootfs_present(rootfs_paths).await?;
        let _snapshot_lock = lock::acquire_shared(paths.snapshot_lock(snapshot_hash)).await?;
        if rootfs_still_present && provider.is_complete(snapshot_dir).await.unwrap_or(false) {
            tracing::info!(
                "[OK] image already built: rootfs={rootfs_hash}, snapshot={snapshot_hash}"
            );
            touch_mtime(rootfs_paths.dir());
            touch_mtime(snapshot_dir);
            return Ok(());
        }
        tracing::info!(
            "existing image changed while acquiring shared locks; continuing with build"
        );
    }

    // R2 cache init. Fatal on partial config (1-3 of 4 vars set) — better than
    // silently disabling cache for a typo'd secret rotation.
    let r2 = R2ImageCache::from_env()
        .await
        .map_err(|e| RunnerError::Internal(format!("R2 cache init: {e}")))?;
    let template_cache = TemplateCache::from_optional(mode, r2.as_ref())?;
    if template_cache.is_disabled() {
        // Info, not warn — dev environments routinely run without R2 configured.
        tracing::info!("R2 cache disabled (R2_* env vars not set) — skipping download and upload");
    }

    let template_input = TemplateInput {
        paths: &paths,
        template_hash: &hashes.template_hash,
        cache: template_cache,
        disk_mb: def.disk_mb,
    };

    match mode {
        BuildMode::WarmRootfsCache => {
            let template_lock_path = paths.template_lock(&hashes.template_hash);
            tracing::info!(
                "acquiring exclusive template lock for warm build: {}",
                template_lock_path.display()
            );
            let _template_lock = lock::acquire(template_lock_path).await?;
            ensure_template_cached_under_lock(&template_input).await?;
            tracing::info!(
                "template cache warm complete: template={}",
                hashes.template_hash
            );
            Ok(())
        }

        BuildMode::FullImage => {
            let rootfs_hash = rootfs_hash.ok_or_else(|| {
                RunnerError::Internal("full image build missing rootfs hash".into())
            })?;
            let snapshot_hash = snapshot_hash.ok_or_else(|| {
                RunnerError::Internal("full image build missing snapshot hash".into())
            })?;
            let rootfs_paths = rootfs_paths.as_ref().ok_or_else(|| {
                RunnerError::Internal("full image build missing rootfs paths".into())
            })?;
            let snapshot_dir = snapshot_dir.ok_or_else(|| {
                RunnerError::Internal("full image build missing snapshot dir".into())
            })?;
            let guests = guests.as_ref().ok_or_else(|| {
                RunnerError::Internal("full image build missing guest binaries".into())
            })?;
            // Keep a rootfs lock through snapshot creation so GC cannot reap
            // the rootfs while the snapshot provider is reading it. Existing
            // immutable rootfs images only need a shared lock; exclusive is
            // required only when this process may write `rootfs.ext4`.
            let _rootfs_lock =
                acquire_rootfs_lock_for_image_build(&paths, rootfs_hash, rootfs_paths).await?;
            let input = RootfsBuildInput {
                template: template_input,
                rootfs_paths,
                guests,
            };
            if _rootfs_lock.is_exclusive() {
                let template_lock_path = paths.template_lock(&hashes.template_hash);
                tracing::info!(
                    "acquiring exclusive template lock for image build: {}",
                    template_lock_path.display()
                );
                let template_lock = lock::acquire(template_lock_path).await?;
                let release_template_lock =
                    TemplateLockRelease::from_release(move || drop(template_lock));
                ensure_rootfs_under_lock(input, release_template_lock).await?;
            } else {
                tracing::info!(
                    "[OK] rootfs already present: {}",
                    rootfs_paths.dir().display()
                );
            }

            let snapshot_lock = lock::acquire(paths.snapshot_lock(snapshot_hash)).await?;
            if provider.is_complete(snapshot_dir).await.unwrap_or(false) {
                tracing::info!(
                    "[OK] image already built: rootfs={rootfs_hash}, snapshot={snapshot_hash}"
                );
                touch_mtime(rootfs_paths.dir());
                touch_mtime(snapshot_dir);
                return Ok(());
            }

            build_snapshot(
                &paths,
                rootfs_paths,
                snapshot_hash,
                snapshot_dir,
                def,
                provider,
                snapshot_lock,
            )
            .await?;

            tracing::info!(
                "image creation complete: rootfs={rootfs_hash}, snapshot={snapshot_hash}"
            );
            Ok(())
        }
    }
}

async fn build_snapshot(
    paths: &HomePaths,
    rootfs_paths: &RootfsPaths,
    snapshot_hash: &str,
    snapshot_dir: &Path,
    def: &profile::ProfileDef,
    provider: &dyn SnapshotProvider,
    snapshot_lock: Flock<File>,
) -> RunnerResult<()> {
    // Snapshot dir is nested under the rootfs dir:
    // <images>/<rootfs_hash>/snapshots/<snapshot_hash>/
    tokio::fs::create_dir_all(snapshot_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", snapshot_dir.display())))?;

    let create_config = sandbox::SnapshotCreateConfig {
        id: snapshot_hash.to_string(),
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path: rootfs_paths.rootfs(),
        output_dir: snapshot_dir.to_path_buf(),
        vcpu_count: def.vcpu,
        memory_mb: def.memory_mb,
    };

    let pending = provider.create_uncommitted_snapshot(create_config).await?;
    let output = shielded_snapshot_publish(
        pending,
        snapshot_lock,
        snapshot_hash.to_string(),
        snapshot_dir.to_path_buf(),
    )
    .await?;

    let (snapshot_sz, memory_sz, cow_sz) = tokio::join!(
        file_sizes(&output.snapshot_path),
        file_sizes(&output.memory_path),
        file_sizes(&output.cow_path),
    );
    tracing::info!(
        snapshot_logical = %snapshot_sz.0,
        snapshot_disk = %snapshot_sz.1,
        memory_logical = %memory_sz.0,
        memory_disk = %memory_sz.1,
        cow_logical = %cow_sz.0,
        cow_disk = %cow_sz.1,
        "snapshot creation complete"
    );

    Ok(())
}

async fn shielded_snapshot_publish(
    pending: Box<dyn sandbox::PendingSnapshotPublish>,
    snapshot_lock: Flock<File>,
    snapshot_hash: String,
    snapshot_dir: PathBuf,
) -> RunnerResult<sandbox::SnapshotOutput> {
    let (result_tx, result_rx) =
        tokio::sync::oneshot::channel::<Result<sandbox::SnapshotOutput, sandbox::SnapshotError>>();

    tokio::spawn(async move {
        let result =
            commit_or_discard_pending_snapshot(pending, &snapshot_hash, &snapshot_dir).await;
        drop(snapshot_lock);

        if let Err(result) = result_tx.send(result) {
            match result {
                Ok(_) => {
                    tracing::info!(
                        snapshot_hash,
                        snapshot_dir = %snapshot_dir.display(),
                        "detached snapshot publish committed after caller cancellation"
                    );
                }
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        snapshot_hash,
                        snapshot_dir = %snapshot_dir.display(),
                        "detached snapshot publish failed after caller cancellation"
                    );
                }
            }
        }
    });

    match result_rx.await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(err.into()),
        Err(err) => Err(RunnerError::Internal(format!(
            "snapshot publish task ended before reporting completion: {err}"
        ))),
    }
}

async fn commit_or_discard_pending_snapshot(
    mut pending: Box<dyn sandbox::PendingSnapshotPublish>,
    snapshot_hash: &str,
    snapshot_dir: &Path,
) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
    match pending.commit().await {
        Ok(output) => Ok(output),
        Err(err) => {
            if let Err(discard_err) = pending.discard().await {
                tracing::warn!(
                    error = %discard_err,
                    snapshot_hash,
                    snapshot_dir = %snapshot_dir.display(),
                    "failed to discard uncommitted snapshot after publish failure"
                );
            }
            Err(err)
        }
    }
}

async fn ensure_rootfs_under_lock(
    input: RootfsBuildInput<'_>,
    mut release_template_lock: TemplateLockRelease,
) -> RunnerResult<()> {
    let publish = LocalFilePublish::for_rootfs(input.rootfs_paths);

    // Clear any `rootfs.ext4.staging` residue from a previous crashed or
    // failed build. Holding the rootfs flock means the previous writer has
    // already exited (kernel releases flocks on process death), so any
    // staging file on disk is guaranteed to be stale — never a concurrent
    // writer's work-in-progress. This is the recovery arm of the
    // staging-rename contract; see `RootfsPaths::rootfs_staging`.
    publish.cleanup_stale_staging_best_effort().await;

    let need_rootfs = !is_rootfs_present(input.rootfs_paths).await?;
    let mut scripts = RootfsScripts::new();

    if need_rootfs {
        let result = async {
            obtain_template_to_staging(&input.template, input.rootfs_paths, &mut scripts).await?;
            release_template_lock.release();
            let work_dir_path = scripts.path().await?;
            customize_rootfs_staging(&input, &work_dir_path).await?;
            verify_rootfs(input.rootfs_paths, &work_dir_path).await?;
            // Commit the rootfs. Same-filesystem rename is POSIX-atomic, so
            // `rootfs.ext4` only becomes visible once customization and
            // verification have fully succeeded.
            publish.commit().await?;
            tracing::info!("rootfs committed: {}", publish.stable().display());
            Ok(())
        }
        .await;
        publish.finish_after_result(result).await?;
    } else {
        tracing::info!(
            "[OK] rootfs already present: {}",
            input.rootfs_paths.dir().display()
        );
        release_template_lock.release();
    }

    Ok(())
}

async fn ensure_template_cached_under_lock(input: &TemplateInput<'_>) -> RunnerResult<()> {
    input.cache.as_cache().ok_or_else(|| {
        RunnerError::Internal("--warm-rootfs-cache requires R2 template cache".into())
    })?;
    let mut scripts = RootfsScripts::new();
    let work_dir_path = scripts.path().await?;
    // Keep warm-up staging on the runner image volume, not the system temp
    // filesystem. Even a cache hit downloads a full template for validation,
    // and /tmp may be much smaller than the runner data disk.
    let warm_parent = template_warm_parent_dir(input.paths, input.template_hash);
    cleanup_template_warm_parent(&warm_parent).await?;
    let warm_dir = template_attempt_dir(&warm_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);

    let result = materialize_template_from_r2_or_build(
        input,
        &warm_dir,
        &work_dir_path,
        TemplateMaterializationTarget::RemoteCacheOnly,
    )
    .await;

    finish_template_warm_dir_result(&warm_parent, &warm_dir, result).await
}

fn template_attempt_dir(parent: &Path, prefix: &str) -> PathBuf {
    parent.join(format!(
        "{prefix}{}{TEMPLATE_ATTEMPT_DIR_SUFFIX}",
        uuid::Uuid::new_v4()
    ))
}

fn template_warm_parent_dir(paths: &HomePaths, template_hash: &str) -> PathBuf {
    paths
        .images_dir()
        .join(format!("{TEMPLATE_WARM_DIR_PREFIX}{template_hash}"))
}

fn is_template_attempt_dir_name(name: &str, prefix: &str) -> bool {
    name.starts_with(prefix) && name.ends_with(TEMPLATE_ATTEMPT_DIR_SUFFIX)
}

async fn cleanup_stale_template_attempt_dirs(parent: &Path, prefix: &str) -> RunnerResult<()> {
    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "read template attempt parent {}: {e}",
                parent.display()
            )));
        }
    };

    while let Some(entry) = entries.next_entry().await.map_err(|e| {
        RunnerError::Internal(format!(
            "read template attempt entry in {}: {e}",
            parent.display()
        ))
    })? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_template_attempt_dir_name(name, prefix) {
            remove_path_if_exists(&entry.path(), "stale template attempt dir").await?;
        }
    }

    Ok(())
}

async fn cleanup_template_warm_parent(parent: &Path) -> RunnerResult<()> {
    match tokio::fs::symlink_metadata(parent).await {
        Ok(metadata) if metadata.is_dir() => {
            cleanup_stale_template_attempt_dirs(parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX).await
        }
        Ok(_) => remove_path_if_exists(parent, "stale template warm parent").await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat template warm parent {}: {e}",
            parent.display()
        ))),
    }
}

async fn remove_path_if_exists(path: &Path, label: &str) -> RunnerResult<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat {label} {}: {e}",
            path.display()
        )))?,
    };

    let result = if metadata.is_dir() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    result.map_err(|e| RunnerError::Internal(format!("remove {label} {}: {e}", path.display())))
}

async fn remove_dir_all_if_exists(path: &Path, label: &str) -> RunnerResult<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove {label} {}: {e}",
            path.display()
        ))),
    }
}

async fn finish_temp_dir_result(
    path: &Path,
    label: &str,
    result: RunnerResult<()>,
) -> RunnerResult<()> {
    let cleanup = remove_dir_all_if_exists(path, label).await;
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(cleanup_err)) => Err(cleanup_err),
        (Err(original_err), Ok(())) => Err(original_err),
        (Err(original_err), Err(cleanup_err)) => {
            tracing::warn!(
                "failed to remove {label} {} after an earlier error: {cleanup_err}",
                path.display()
            );
            Err(original_err)
        }
    }
}

async fn finish_template_warm_dir_result(
    parent: &Path,
    attempt: &Path,
    result: RunnerResult<()>,
) -> RunnerResult<()> {
    let result = finish_temp_dir_result(attempt, "template warm dir", result).await;
    match remove_empty_dir_if_exists(parent).await {
        Ok(()) => result,
        Err(parent_err) => match result {
            Ok(()) => Err(parent_err),
            Err(original_err) => {
                tracing::warn!(
                    "failed to remove template warm parent {} after an earlier error: {parent_err}",
                    parent.display()
                );
                Err(original_err)
            }
        },
    }
}

async fn remove_empty_dir_if_exists(path: &Path) -> RunnerResult<()> {
    match tokio::fs::remove_dir(path).await {
        Ok(()) => Ok(()),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(e) => Err(RunnerError::Internal(format!(
            "remove empty template warm parent {}: {e}",
            path.display()
        ))),
    }
}

async fn obtain_template_to_staging(
    input: &TemplateInput<'_>,
    rootfs_paths: &RootfsPaths,
    scripts: &mut RootfsScripts,
) -> RunnerResult<()> {
    let staging = rootfs_paths.rootfs_staging();
    cleanup_stale_template_attempt_dirs(rootfs_paths.dir(), TEMPLATE_BUILD_DIR_PREFIX).await?;
    let attempt_dir = template_attempt_dir(rootfs_paths.dir(), TEMPLATE_BUILD_DIR_PREFIX);

    let result = async {
        let work_dir_path = scripts.path().await?;
        materialize_template_from_r2_or_build(
            input,
            &attempt_dir,
            &work_dir_path,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
    }
    .await;

    finish_temp_dir_result(&attempt_dir, "template build dir", result).await
}

async fn materialize_template_from_r2_or_build(
    input: &TemplateInput<'_>,
    attempt_dir: &Path,
    work_dir: &Path,
    target: TemplateMaterializationTarget<'_>,
) -> RunnerResult<()> {
    tokio::fs::create_dir_all(attempt_dir).await.map_err(|e| {
        RunnerError::Internal(format!(
            "create template attempt dir {}: {e}",
            attempt_dir.display()
        ))
    })?;

    let downloaded_template = attempt_dir.join(TEMPLATE_DOWNLOAD_FILE);
    match resolve_remote_template(input, &downloaded_template, work_dir, target.mode()).await? {
        RemoteTemplateDecision::UseDownloaded => {
            target.materialize_downloaded(input, &downloaded_template)
        }
        RemoteTemplateDecision::BuildAndUpload(upload_intent) => {
            build_template_locally(input, attempt_dir, work_dir).await?;
            let built_template = attempt_dir.join(TEMPLATE_FILE);
            upload_template_to_r2(input, &built_template, upload_intent.force()).await?;
            target.materialize_built(&built_template)
        }
    }
}

async fn resolve_remote_template(
    input: &TemplateInput<'_>,
    downloaded_template: &Path,
    work_dir: &Path,
    mode: TemplateMaterializationMode,
) -> RunnerResult<RemoteTemplateDecision> {
    let Some(cache) = input.cache.as_cache() else {
        return Ok(RemoteTemplateDecision::BuildAndUpload(
            TemplateUploadIntent::Deduplicated,
        ));
    };

    match cache
        .try_download_template_to_file(input.template_hash, downloaded_template)
        .await
    {
        Ok(true) => match verify_template_file(downloaded_template, work_dir).await {
            Ok(()) => Ok(RemoteTemplateDecision::UseDownloaded),
            Err(e) => {
                if mode.is_warm_cache() {
                    tracing::warn!(
                        "R2 template object for {} failed warm validation ({e}) — \
                         rebuilding locally and force-overwriting the bad object",
                        input.template_hash
                    );
                } else {
                    tracing::warn!(
                        "R2 template object for {} failed validation ({e}) — \
                         rebuilding locally and force-overwriting the bad object",
                        input.template_hash
                    );
                }
                Ok(RemoteTemplateDecision::BuildAndUpload(
                    TemplateUploadIntent::ForceOverwriteInvalidRemote,
                ))
            }
        },
        Ok(false) => {
            tracing::info!(
                "R2 template cache miss for {} — building locally",
                input.template_hash
            );
            Ok(RemoteTemplateDecision::BuildAndUpload(
                TemplateUploadIntent::Deduplicated,
            ))
        }
        Err(e) if e.is_invalid_object() => {
            if mode.is_warm_cache() {
                tracing::warn!(
                    "R2 template object for {} is invalid during warm ({e}) — \
                     rebuilding locally and force-overwriting the bad object",
                    input.template_hash
                );
            } else {
                tracing::warn!(
                    "R2 template object for {} is invalid ({e}) — \
                     rebuilding locally and force-overwriting the bad object",
                    input.template_hash
                );
            }
            Ok(RemoteTemplateDecision::BuildAndUpload(
                TemplateUploadIntent::ForceOverwriteInvalidRemote,
            ))
        }
        Err(e) if input.cache.is_required() => Err(RunnerError::Internal(format!(
            "R2 template download failed while warming cache: {e}"
        ))),
        Err(e) => {
            tracing::warn!("R2 template download failed: {e} — falling back to local build");
            Ok(RemoteTemplateDecision::BuildAndUpload(
                TemplateUploadIntent::Deduplicated,
            ))
        }
    }
}

fn move_file_sync(source: &Path, destination: &Path, label: &str) -> RunnerResult<()> {
    std::fs::rename(source, destination).map_err(|e| {
        RunnerError::Internal(format!(
            "{label} {} → {}: {e}",
            source.display(),
            destination.display()
        ))
    })
}

struct RootfsScripts {
    temp_dir: Option<tempfile::TempDir>,
}

impl RootfsScripts {
    fn new() -> Self {
        Self { temp_dir: None }
    }

    async fn path(&mut self) -> RunnerResult<PathBuf> {
        if self.temp_dir.is_none() {
            self.temp_dir = Some(create_rootfs_scripts_dir().await?);
        }
        match self.temp_dir.as_ref() {
            Some(dir) => Ok(dir.path().to_path_buf()),
            None => Err(RunnerError::Internal(
                "rootfs scripts dir was not initialized".into(),
            )),
        }
    }
}

async fn create_rootfs_scripts_dir() -> RunnerResult<tempfile::TempDir> {
    let dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(dir.path().join("build-template.sh"), TEMPLATE_BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write template build script: {e}")))?;
    tokio::fs::write(dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;
    tokio::fs::write(dir.path().join("customize-rootfs.sh"), CUSTOMIZE_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write customize script: {e}")))?;
    Ok(dir)
}

fn rootfs_script_command(script: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg(script).stdin(std::process::Stdio::null());
    cmd.process_group(0);
    cmd.kill_on_drop(true);

    // SAFETY: `set_pdeathsig` calls `prctl(PR_SET_PDEATHSIG)`, which is
    // async-signal-safe. It narrows the window where a parent runner crash
    // releases flocks while a rootfs script keeps mutating staging files.
    unsafe {
        cmd.pre_exec(|| {
            nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL)
                .map_err(std::io::Error::from)
        });
    }

    cmd
}

struct RootfsScriptProcess {
    child: tokio::process::Child,
    pgid: Option<nix::unistd::Pid>,
}

impl Drop for RootfsScriptProcess {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
        }
    }
}

async fn run_rootfs_script(
    mut cmd: tokio::process::Command,
    label: &str,
) -> RunnerResult<std::process::ExitStatus> {
    let child = cmd
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("spawn {label}: {e}")))?;
    let pgid = child.id().map(|pid| nix::unistd::Pid::from_raw(pid as i32));
    let mut process = RootfsScriptProcess { child, pgid };

    let status = process
        .child
        .wait()
        .await
        .map_err(|e| RunnerError::Internal(format!("wait for {label}: {e}")))?;
    if status.success() {
        process.pgid = None;
    }
    Ok(status)
}

async fn build_template_locally(
    input: &TemplateInput<'_>,
    output_dir: &Path,
    work_dir: &Path,
) -> RunnerResult<()> {
    tokio::fs::create_dir_all(output_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", output_dir.display())))?;

    // Local template build — the slow path (debootstrap + apt install).
    let debootstrap_dir = input.paths.debootstrap_dir();
    tokio::fs::create_dir_all(&debootstrap_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", debootstrap_dir.display())))?;
    let debootstrap_lock_path = input.paths.debootstrap_lock();
    drop(lock::open_lock_file(&debootstrap_lock_path)?);
    let disk_mb_str = input.disk_mb.to_string();

    let mut cmd = rootfs_script_command(&work_dir.join("build-template.sh"));
    cmd.arg("--output-dir")
        .arg(output_dir)
        .arg("--debootstrap-dir")
        .arg(&debootstrap_dir)
        .arg("--debootstrap-lock")
        .arg(&debootstrap_lock_path)
        .arg("--hash")
        .arg(input.template_hash)
        .arg("--disk-mb")
        .arg(&disk_mb_str);
    let status = run_rootfs_script(cmd, "build-template.sh").await?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "build-template.sh failed with {status}"
        )));
    }

    let template = output_dir.join(TEMPLATE_FILE);
    if !tokio::fs::try_exists(&template).await.unwrap_or(false) {
        return Err(RunnerError::Internal(format!(
            "build-template.sh did not create {}",
            template.display()
        )));
    }
    verify_template_file(&template, work_dir).await?;

    let template_sz = file_sizes(&template).await;
    tracing::info!(
        template_logical = %template_sz.0,
        template_disk = %template_sz.1,
        "template creation complete"
    );

    Ok(())
}

async fn verify_rootfs(rootfs_paths: &RootfsPaths, work_dir: &Path) -> RunnerResult<()> {
    verify_rootfs_file(&rootfs_paths.rootfs_staging(), work_dir, "rootfs").await?;

    let rootfs_sz = file_sizes(&rootfs_paths.rootfs_staging()).await;
    tracing::info!(
        rootfs_logical = %rootfs_sz.0,
        rootfs_disk = %rootfs_sz.1,
        "rootfs verification complete"
    );

    Ok(())
}

async fn verify_template_file(rootfs: &Path, work_dir: &Path) -> RunnerResult<()> {
    verify_rootfs_file(rootfs, work_dir, "template").await?;

    let rootfs_sz = file_sizes(rootfs).await;
    tracing::info!(
        rootfs_logical = %rootfs_sz.0,
        rootfs_disk = %rootfs_sz.1,
        "template verification complete"
    );

    Ok(())
}

async fn verify_rootfs_file(rootfs: &Path, work_dir: &Path, mode: &str) -> RunnerResult<()> {
    let mut cmd = rootfs_script_command(&work_dir.join("verify-rootfs.sh"));
    cmd.arg("--rootfs").arg(rootfs).arg("--mode").arg(mode);
    let status = run_rootfs_script(cmd, "verify-rootfs.sh").await?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "verify-rootfs.sh failed with {status}"
        )));
    }

    Ok(())
}

async fn upload_template_to_r2(
    input: &TemplateInput<'_>,
    rootfs: &Path,
    force: bool,
) -> RunnerResult<()> {
    let (cache, required) = match input.cache {
        TemplateCache::Disabled => return Ok(()),
        TemplateCache::BestEffort(cache) => (cache, false),
        TemplateCache::Required(cache) => (cache, true),
    };

    match cache
        .upload_template(input.template_hash, rootfs, force)
        .await
    {
        Ok(()) => {
            tracing::info!("uploaded template to R2: {}", input.template_hash);
            Ok(())
        }
        Err(e) if required => Err(RunnerError::Internal(format!(
            "R2 upload failed while warming template cache: {e}"
        ))),
        Err(e) => {
            tracing::warn!("R2 upload failed: {e} — template is on local disk");
            Ok(())
        }
    }
}

async fn customize_rootfs_staging(
    input: &RootfsBuildInput<'_>,
    work_dir: &Path,
) -> RunnerResult<()> {
    let staging = input.rootfs_paths.rootfs_staging();
    let ca_dir = input.template.paths.ca_dir();
    let mut cmd = rootfs_script_command(&work_dir.join("customize-rootfs.sh"));
    cmd.arg("--rootfs")
        .arg(&staging)
        .arg("--ca-dir")
        .arg(&ca_dir)
        .arg("--dns-nameserver")
        .arg(ROOTFS_DNS_NAMESERVER)
        .arg("--guest-agent")
        .arg(&input.guests.guest_agent)
        .arg("--guest-download")
        .arg(&input.guests.guest_download)
        .arg("--guest-init")
        .arg(&input.guests.guest_init)
        .arg("--guest-mock-claude")
        .arg(&input.guests.guest_mock_claude)
        .arg("--guest-mock-codex")
        .arg(&input.guests.guest_mock_codex)
        .arg("--guest-reseed")
        .arg(&input.guests.guest_reseed);
    let status = run_rootfs_script(cmd, "customize-rootfs.sh").await?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "customize-rootfs.sh failed with {status}"
        )));
    }

    Ok(())
}

/// Check whether rootfs.ext4 exists.
///
/// Under the staging-rename contract, `rootfs.ext4` only exists if the
/// full assembly pipeline (download/build + customization) has committed,
/// so `true` here implies "fully built and ready to use". A concurrent
/// in-progress build writes to `rootfs.ext4.staging`, which this function
/// intentionally ignores.
async fn is_rootfs_present(rootfs: &RootfsPaths) -> RunnerResult<bool> {
    tokio::fs::try_exists(rootfs.rootfs())
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", rootfs.rootfs().display())))
}

struct LocalFilePublish {
    staging: PathBuf,
    stable: PathBuf,
}

impl LocalFilePublish {
    fn new(staging: PathBuf, stable: PathBuf) -> Self {
        Self { staging, stable }
    }

    fn for_rootfs(rootfs: &RootfsPaths) -> Self {
        Self::new(rootfs.rootfs_staging(), rootfs.rootfs())
    }

    fn stable(&self) -> &Path {
        &self.stable
    }

    /// Delete any staging file left behind by a previous publish attempt.
    ///
    /// For rootfs this is called under the rootfs flock before work continues,
    /// so any staging file is crash residue, not a live writer's in-progress
    /// file. Non-existence is the common case and not logged. Removal is best
    /// effort: a failure here leaves the next write step to fail or overwrite.
    ///
    /// Keep this synchronous while the caller owns the rootfs lock. A cancelled
    /// Tokio fs operation can continue on the blocking pool after the lock is
    /// dropped, which is not safe for the fixed staging path.
    async fn cleanup_stale_staging_best_effort(&self) {
        match std::fs::symlink_metadata(&self.staging) {
            Ok(metadata) => {
                tracing::warn!(
                    "removing stale rootfs staging file from a previous failed build: {}",
                    self.staging.display()
                );
                let result = if metadata.file_type().is_dir() {
                    std::fs::remove_dir_all(&self.staging)
                } else {
                    std::fs::remove_file(&self.staging)
                };
                if let Err(e) = result {
                    tracing::warn!(
                        "failed to remove stale staging path {}: {e}",
                        self.staging.display()
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(
                    "check staging {}: {e} (continuing; any residue will be overwritten)",
                    self.staging.display()
                );
            }
        }
    }

    /// Atomic commit: rename staging to stable.
    ///
    /// Same-filesystem rename is POSIX-atomic, so this is the single step
    /// that makes the published file visible to future presence checks.
    async fn commit(&self) -> RunnerResult<()> {
        std::fs::rename(&self.staging, &self.stable).map_err(|e| {
            RunnerError::Internal(format!(
                "commit rootfs {} → {}: {e}",
                self.staging.display(),
                self.stable.display()
            ))
        })
    }

    async fn finish_after_result(&self, result: RunnerResult<()>) -> RunnerResult<()> {
        match result {
            Ok(()) => Ok(()),
            Err(original_err) => {
                match remove_file_if_exists_sync(&self.staging, "failed rootfs staging file") {
                    Ok(()) => Err(original_err),
                    Err(cleanup_err) => {
                        tracing::warn!(
                            "failed to remove rootfs staging {} after an earlier error: {cleanup_err}",
                            self.staging.display()
                        );
                        Err(original_err)
                    }
                }
            }
        }
    }
}

fn remove_file_if_exists_sync(path: &Path, label: &str) -> RunnerResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RunnerError::Internal(format!(
            "remove {label} {}: {e}",
            path.display()
        ))),
    }
}

/// Compute a template hash for shared R2 image caching.
///
/// Inputs:
///   - `TEMPLATE_CACHE_VERSION` — bump to force invalidation
///   - `TEMPLATE_BUILD_SCRIPT` — template build script content
///   - `disk_mb` — disk size from profile
///
/// Guest binaries and host-local CA are deliberately excluded; those belong
/// to the local rootfs hash.
///
/// **Changing this function invalidates all shared template images.**
fn compute_template_hash(disk_mb: u32) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"template_version:");
    hasher.update(TEMPLATE_CACHE_VERSION.to_le_bytes());
    hasher.update(b"template_script:");
    hasher.update(TEMPLATE_BUILD_SCRIPT.as_bytes());
    hasher.update(b"arch:");
    hasher.update(std::env::consts::ARCH.as_bytes());
    hasher.update(b"disk_mb:");
    hasher.update(disk_mb.to_le_bytes());

    hex::encode(hasher.finalize())
}

/// Compute the local rootfs hash.
///
/// This hash is what runner configs use. It includes the shared template hash plus
/// every rootfs-only input that changes the bootable rootfs content.
async fn compute_rootfs_hash(
    template_hash: &str,
    guest_bins: &[(&Path, &str)],
    ca_fingerprint: &str,
    disk_mb: u32,
) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    hasher.update(b"rootfs_version:");
    hasher.update(ROOTFS_CACHE_VERSION.to_le_bytes());
    hasher.update(b"template:");
    hasher.update(template_hash.as_bytes());
    hasher.update(b"customize_script:");
    hasher.update(CUSTOMIZE_SCRIPT.as_bytes());
    hasher.update(b"disk_mb:");
    hasher.update(disk_mb.to_le_bytes());
    hasher.update(b"ca_fingerprint:");
    hasher.update(ca_fingerprint.as_bytes());
    hasher.update(b"dns_nameserver:");
    hasher.update(ROOTFS_DNS_NAMESERVER.as_bytes());

    for (src, dest) in guest_bins {
        let content = tokio::fs::read(src)
            .await
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", src.display())))?;
        let tag = format!("bin:{dest}:");
        hasher.update(tag.as_bytes());
        hasher.update(&content);
    }

    Ok(hex::encode(hasher.finalize()))
}

async fn compute_ca_cert_fingerprint(paths: &HomePaths) -> RunnerResult<String> {
    let cert = paths.ca_dir().join(ca::CA_CERT);
    let content = tokio::fs::read(&cert)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA cert {}: {e}", cert.display())))?;
    Ok(hex::encode(Sha256::digest(content)))
}

/// Compute a snapshot hash from all inputs that affect snapshot content.
///
/// This hash is local-only (R2 stores only the shared template). It covers:
///   - `SNAPSHOT_CACHE_VERSION` — manual bump counter
///   - `rootfs_hash` — the rootfs this snapshot is built from
///   - `vcpu`, `memory_mb` — VM resource config
///   - `fc_version`, `kernel_version` — Firecracker and guest kernel versions
///   - `provider_config_hash` — sandbox-fc internal config (boot args, prewarm, etc.)
fn compute_snapshot_hash(
    rootfs_hash: &str,
    vcpu: u32,
    memory_mb: u32,
    fc_version: &str,
    kernel_version: &str,
    provider_config_hash: &str,
) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"snapshot_version:");
    hasher.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
    hasher.update(b"rootfs:");
    hasher.update(rootfs_hash.as_bytes());
    hasher.update(b"vcpu:");
    hasher.update(vcpu.to_le_bytes());
    hasher.update(b"memory_mb:");
    hasher.update(memory_mb.to_le_bytes());
    hasher.update(b"fc_version:");
    hasher.update(fc_version.as_bytes());
    hasher.update(b"kernel_version:");
    hasher.update(kernel_version.as_bytes());
    hasher.update(b"provider_config:");
    hasher.update(provider_config_hash.as_bytes());

    hex::encode(hasher.finalize())
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
    use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[derive(clap::Parser)]
    struct TestBuildCli {
        #[command(flatten)]
        args: BuildArgs,
    }

    fn build_args() -> [&'static str; 15] {
        [
            "runner-build",
            "--guest-agent",
            "/tmp/guest-agent",
            "--guest-download",
            "/tmp/guest-download",
            "--guest-init",
            "/tmp/guest-init",
            "--guest-mock-claude",
            "/tmp/guest-mock-claude",
            "--guest-mock-codex",
            "/tmp/guest-mock-codex",
            "--guest-reseed",
            "/tmp/guest-reseed",
            "--profile",
            "vm0/default",
        ]
    }

    fn rootfs_input<'a>(
        home: &'a HomePaths,
        rootfs: &'a RootfsPaths,
        guests: &'a GuestBinaries,
        cache: TemplateCache<'a>,
    ) -> RootfsBuildInput<'a> {
        RootfsBuildInput {
            template: TemplateInput {
                paths: home,
                template_hash: "test-template-hash",
                cache,
                disk_mb: 16384,
            },
            rootfs_paths: rootfs,
            guests,
        }
    }

    fn test_guest_binaries() -> GuestBinaries {
        let temp_dir = tempfile::tempdir().unwrap();
        let guest = temp_dir.path().join("guest");
        std::fs::write(&guest, b"guest").unwrap();
        GuestBinaries {
            _temp_dir: temp_dir,
            guest_agent: guest.clone(),
            guest_download: guest.clone(),
            guest_init: guest.clone(),
            guest_mock_claude: guest.clone(),
            guest_mock_codex: guest.clone(),
            guest_reseed: guest,
        }
    }

    fn template_input<'a>(home: &'a HomePaths, cache: TemplateCache<'a>) -> TemplateInput<'a> {
        TemplateInput {
            paths: home,
            template_hash: "test-template-hash",
            cache,
            disk_mb: 128,
        }
    }

    fn mock_r2_cache(rules: &[&Rule]) -> R2ImageCache {
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, rules);
        R2ImageCache::with_client(client, "test-bucket".to_string())
    }

    async fn fake_rootfs_scripts() -> (RootfsScripts, PathBuf) {
        let temp_dir = tempfile::tempdir().unwrap();
        let work_dir = temp_dir.path().to_path_buf();
        tokio::fs::write(
            work_dir.join("build-template.sh"),
            r#"#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$output_dir" ]]; then
  exit 2
fi

mkdir -p "$output_dir"
printf built-template > "$output_dir/template.ext4"
printf called > "$script_dir/build-template-called"
"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            work_dir.join("verify-rootfs.sh"),
            r#"#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
rootfs=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs)
      rootfs="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$rootfs" || ! -f "$rootfs" ]]; then
  exit 2
fi
if [[ "$(cat "$rootfs")" == "verify-fail" ]]; then
  exit 1
fi

printf called >> "$script_dir/verify-rootfs-called"
"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            work_dir.join("customize-rootfs.sh"),
            "#!/usr/bin/env bash\n",
        )
        .await
        .unwrap();

        (
            RootfsScripts {
                temp_dir: Some(temp_dir),
            },
            work_dir,
        )
    }

    async fn template_archive_bytes(content: &[u8]) -> Vec<u8> {
        let content = content.to_vec();
        tokio::task::spawn_blocking(move || {
            let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
            let mut archive = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(u64::try_from(content.len()).unwrap());
            header.set_mode(0o644);
            header.set_cksum();
            let mut reader = content.as_slice();
            archive
                .append_data(&mut header, TEMPLATE_FILE, &mut reader)
                .unwrap();
            archive.finish().unwrap();
            let encoder = archive.into_inner().unwrap();
            encoder.finish().unwrap()
        })
        .await
        .unwrap()
    }

    async fn empty_template_archive_bytes() -> Vec<u8> {
        tokio::task::spawn_blocking(move || {
            let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
            let mut archive = tar::Builder::new(encoder);
            archive.finish().unwrap();
            let encoder = archive.into_inner().unwrap();
            encoder.finish().unwrap()
        })
        .await
        .unwrap()
    }

    fn template_get_rule(body: Vec<u8>) -> Rule {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectOutput;
        use aws_sdk_s3::primitives::ByteStream;

        let body = Arc::new(body);
        let body_for_closure = Arc::clone(&body);
        mock!(Client::get_object)
            .match_requests(|req| {
                req.bucket() == Some("test-bucket")
                    && req.key() == Some("runner-templates/test-template-hash.tar.zst")
            })
            .then_output(move || {
                GetObjectOutput::builder()
                    .body(ByteStream::from((*body_for_closure).clone()))
                    .build()
            })
    }

    fn template_get_miss_rule() -> Rule {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::get_object::GetObjectError;
        use aws_sdk_s3::types::error::NoSuchKey;

        mock!(Client::get_object)
            .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()))
    }

    fn template_head_miss_rule() -> Rule {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectError;
        use aws_sdk_s3::types::error::NotFound;

        mock!(Client::head_object)
            .then_error(|| HeadObjectError::NotFound(NotFound::builder().build()))
    }

    fn multipart_success_rules() -> (Rule, Rule, Rule) {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
        use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
        use aws_sdk_s3::operation::upload_part::UploadPartOutput;

        let create = mock!(Client::create_multipart_upload).then_output(|| {
            CreateMultipartUploadOutput::builder()
                .upload_id("test-upload-id")
                .build()
        });
        let upload_part = mock!(Client::upload_part)
            .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
        let complete = mock!(Client::complete_multipart_upload)
            .then_output(|| CompleteMultipartUploadOutput::builder().build());
        (create, upload_part, complete)
    }

    struct RecordingPendingSnapshotPublish {
        output_dir: PathBuf,
        committed: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl sandbox::PendingSnapshotPublish for RecordingPendingSnapshotPublish {
        async fn commit(&mut self) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
            self.committed.store(true, Ordering::SeqCst);
            let output = sandbox::SnapshotOutput {
                snapshot_path: self.output_dir.join("snapshot.bin"),
                memory_path: self.output_dir.join("memory.bin"),
                cow_path: self.output_dir.join("cow.img"),
            };
            tokio::fs::write(&output.snapshot_path, b"snapshot").await?;
            tokio::fs::write(&output.memory_path, b"memory").await?;
            tokio::fs::write(&output.cow_path, b"cow").await?;
            Ok(output)
        }

        async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
            Ok(())
        }
    }

    struct RecordingSnapshotProvider {
        create_uncommitted_called: Arc<AtomicBool>,
        create_snapshot_called: Arc<AtomicBool>,
        committed: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl SnapshotProvider for RecordingSnapshotProvider {
        async fn create_uncommitted_snapshot(
            &self,
            config: sandbox::SnapshotCreateConfig,
        ) -> Result<Box<dyn sandbox::PendingSnapshotPublish>, sandbox::SnapshotError> {
            self.create_uncommitted_called.store(true, Ordering::SeqCst);
            Ok(Box::new(RecordingPendingSnapshotPublish {
                output_dir: config.output_dir,
                committed: Arc::clone(&self.committed),
            }))
        }

        async fn create_snapshot(
            &self,
            _config: sandbox::SnapshotCreateConfig,
        ) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
            self.create_snapshot_called.store(true, Ordering::SeqCst);
            Err(sandbox::SnapshotError::Setup(
                "build_snapshot should use create_uncommitted_snapshot".into(),
            ))
        }

        fn config_hash(&self) -> String {
            "recording-provider".into()
        }

        async fn is_complete(&self, _output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
            Ok(false)
        }
    }

    struct FailingPendingSnapshotPublish {
        discarded: Arc<AtomicBool>,
        discard_error: Option<&'static str>,
    }

    #[async_trait::async_trait]
    impl sandbox::PendingSnapshotPublish for FailingPendingSnapshotPublish {
        async fn commit(&mut self) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
            Err(sandbox::SnapshotError::Teardown("publish failed".into()))
        }

        async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
            self.discarded.store(true, Ordering::SeqCst);
            match self.discard_error {
                Some(message) => Err(sandbox::SnapshotError::Teardown(message.into())),
                None => Ok(()),
            }
        }
    }

    struct FailingSnapshotProvider {
        discarded: Arc<AtomicBool>,
        discard_error: Option<&'static str>,
    }

    #[async_trait::async_trait]
    impl SnapshotProvider for FailingSnapshotProvider {
        async fn create_uncommitted_snapshot(
            &self,
            _config: sandbox::SnapshotCreateConfig,
        ) -> Result<Box<dyn sandbox::PendingSnapshotPublish>, sandbox::SnapshotError> {
            Ok(Box::new(FailingPendingSnapshotPublish {
                discarded: Arc::clone(&self.discarded),
                discard_error: self.discard_error,
            }))
        }

        fn config_hash(&self) -> String {
            "failing-provider".into()
        }

        async fn is_complete(&self, _output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
            Ok(false)
        }
    }

    enum ControlledCommitOutcome {
        Success,
        Failure,
    }

    struct ControlledPendingSnapshotPublish {
        output_dir: PathBuf,
        commit_outcome: ControlledCommitOutcome,
        commit_entered: Option<tokio::sync::oneshot::Sender<()>>,
        commit_release: Option<tokio::sync::oneshot::Receiver<()>>,
        commit_done: Option<tokio::sync::oneshot::Sender<()>>,
        discard_entered: Option<tokio::sync::oneshot::Sender<()>>,
        discard_release: Option<tokio::sync::oneshot::Receiver<()>>,
        discard_done: Option<tokio::sync::oneshot::Sender<()>>,
    }

    #[async_trait::async_trait]
    impl sandbox::PendingSnapshotPublish for ControlledPendingSnapshotPublish {
        async fn commit(&mut self) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
            if let Some(tx) = self.commit_entered.take() {
                let _ = tx.send(());
            }
            if let Some(rx) = self.commit_release.take() {
                let _ = rx.await;
            }
            if let Some(tx) = self.commit_done.take() {
                let _ = tx.send(());
            }

            match self.commit_outcome {
                ControlledCommitOutcome::Success => Ok(sandbox::SnapshotOutput {
                    snapshot_path: self.output_dir.join("snapshot.bin"),
                    memory_path: self.output_dir.join("memory.bin"),
                    cow_path: self.output_dir.join("cow.img"),
                }),
                ControlledCommitOutcome::Failure => {
                    Err(sandbox::SnapshotError::Teardown("publish failed".into()))
                }
            }
        }

        async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
            if let Some(tx) = self.discard_entered.take() {
                let _ = tx.send(());
            }
            if let Some(rx) = self.discard_release.take() {
                let _ = rx.await;
            }
            if let Some(tx) = self.discard_done.take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    async fn acquire_test_snapshot_lock(home: &HomePaths, snapshot_hash: &str) -> Flock<File> {
        lock::acquire(home.snapshot_lock(snapshot_hash))
            .await
            .expect("acquire test snapshot lock")
    }

    async fn assert_lock_blocked(lock_path: PathBuf) {
        let err = lock::try_acquire(lock_path)
            .await
            .expect_err("snapshot lock should still be held");
        assert!(
            err.to_string().contains("already held"),
            "unexpected lock error: {err}"
        );
    }

    async fn wait_until_lock_available(lock_path: PathBuf) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match lock::try_acquire(lock_path.clone()).await {
                    Ok(guard) => {
                        drop(guard);
                        break;
                    }
                    Err(err) if err.to_string().contains("already held") => {
                        tokio::task::yield_now().await;
                    }
                    Err(err) => panic!("unexpected lock error: {err}"),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for snapshot lock to be released"));
    }

    struct ProcessGroupCleanup {
        pgid_file: PathBuf,
    }

    impl Drop for ProcessGroupCleanup {
        fn drop(&mut self) {
            if let Ok(raw_pgid) = std::fs::read_to_string(&self.pgid_file)
                && let Ok(pgid) = raw_pgid.parse::<i32>()
            {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pgid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }

    async fn write_process_group_leak_script(dir: &Path) -> PathBuf {
        let script = dir.join("leak-process-group.sh");
        tokio::fs::write(
            &script,
            r#"#!/usr/bin/env bash
set -euo pipefail

pgid_file="$1"
started_file="$2"
survived_file="$3"
mode="${4:-fail}"

printf '%s' "$$" > "$pgid_file"
(
  trap '' HUP TERM INT
  printf started > "$started_file"
  sleep 0.1
  printf survived > "$survived_file"
) &

while [[ ! -f "$started_file" ]]; do
  sleep 0.01
done

if [[ "$mode" == "wait" ]]; then
  sleep 30
fi

exit 1
"#,
        )
        .await
        .unwrap();
        script
    }

    async fn wait_for_file(path: &Path) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if tokio::fs::try_exists(path).await.unwrap_or(false) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {}", path.display()));
    }

    #[cfg(target_os = "linux")]
    fn process_group_has_live_members(pgid_file: &Path) -> bool {
        let raw_pgid = std::fs::read_to_string(pgid_file).expect("read test pgid");
        let pgid: i32 = raw_pgid.parse().expect("parse test pgid");
        let entries = std::fs::read_dir("/proc").expect("read /proc");
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                continue;
            };
            let Some((_, fields)) = stat.rsplit_once(") ") else {
                continue;
            };
            let mut fields = fields.split_whitespace();
            let state = fields.next().and_then(|value| value.chars().next());
            let _ppid = fields.next();
            let pgrp = fields.next().and_then(|value| value.parse::<i32>().ok());
            if pgrp == Some(pgid) && state != Some('Z') {
                return true;
            }
        }
        false
    }

    #[cfg(not(target_os = "linux"))]
    fn process_group_has_live_members(pgid_file: &Path) -> bool {
        let raw_pgid = std::fs::read_to_string(pgid_file).expect("read test pgid");
        let pgid = nix::unistd::Pid::from_raw(raw_pgid.parse().expect("parse test pgid"));
        match nix::sys::signal::killpg(pgid, None) {
            Ok(()) => true,
            Err(nix::errno::Errno::ESRCH) => false,
            Err(_) => true,
        }
    }

    async fn assert_process_group_stopped_without_survival_marker(
        pgid_file: &Path,
        survived_file: &Path,
    ) {
        wait_for_file(pgid_file).await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !process_group_has_live_members(pgid_file) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for process group in {pgid_file:?} to exit"));
        assert!(
            !tokio::fs::try_exists(survived_file).await.unwrap_or(false),
            "rootfs script process group was not killed; child wrote {}",
            survived_file.display()
        );
    }

    #[tokio::test]
    async fn run_rootfs_script_kills_process_group_after_script_failure() {
        let dir = tempfile::tempdir().unwrap();
        let pgid = dir.path().join("pgid");
        let started = dir.path().join("started");
        let survived = dir.path().join("survived");
        let script = write_process_group_leak_script(dir.path()).await;
        let _cleanup = ProcessGroupCleanup {
            pgid_file: pgid.clone(),
        };

        let mut cmd = rootfs_script_command(&script);
        cmd.arg(&pgid).arg(&started).arg(&survived).arg("fail");

        let status = run_rootfs_script(cmd, "leak-process-group.sh")
            .await
            .unwrap();

        assert!(!status.success());
        assert!(started.exists(), "test child should have started");
        assert_process_group_stopped_without_survival_marker(&pgid, &survived).await;
    }

    #[tokio::test]
    async fn run_rootfs_script_kills_process_group_when_future_is_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let pgid = dir.path().join("pgid");
        let started = dir.path().join("started");
        let survived = dir.path().join("survived");
        let script = write_process_group_leak_script(dir.path()).await;
        let _cleanup = ProcessGroupCleanup {
            pgid_file: pgid.clone(),
        };

        let mut cmd = rootfs_script_command(&script);
        cmd.arg(&pgid).arg(&started).arg(&survived).arg("wait");

        let handle =
            tokio::spawn(async move { run_rootfs_script(cmd, "leak-process-group.sh").await });
        wait_for_file(&started).await;
        handle.abort();
        let _ = handle.await;

        assert_process_group_stopped_without_survival_marker(&pgid, &survived).await;
    }

    #[test]
    fn guest_binaries_hash_inputs_preserve_destination_order() {
        let temp_dir = tempfile::tempdir().unwrap();
        let guest_agent = temp_dir.path().join("guest-agent");
        let guest_download = temp_dir.path().join("guest-download");
        let guest_init = temp_dir.path().join("guest-init");
        let guest_reseed = temp_dir.path().join("guest-reseed");
        let guest_mock_claude = temp_dir.path().join("guest-mock-claude");
        let guest_mock_codex = temp_dir.path().join("guest-mock-codex");
        let guests = GuestBinaries {
            _temp_dir: temp_dir,
            guest_agent: guest_agent.clone(),
            guest_download: guest_download.clone(),
            guest_init: guest_init.clone(),
            guest_mock_claude: guest_mock_claude.clone(),
            guest_mock_codex: guest_mock_codex.clone(),
            guest_reseed: guest_reseed.clone(),
        };

        assert_eq!(
            guests.hash_inputs(),
            [
                (guest_agent.as_path(), GUEST_AGENT_DEST),
                (guest_download.as_path(), GUEST_DOWNLOAD_DEST),
                (guest_init.as_path(), GUEST_INIT_DEST),
                (guest_reseed.as_path(), GUEST_RESEED_DEST),
                (guest_mock_claude.as_path(), GUEST_MOCK_CLAUDE_DEST),
                (guest_mock_codex.as_path(), GUEST_MOCK_CODEX_DEST),
            ]
        );
    }

    #[tokio::test]
    async fn resolve_guest_snapshots_cli_binary_into_temp_dir() {
        let source_dir = tempfile::tempdir().unwrap();
        let tmp_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("guest-agent-source");
        tokio::fs::write(&source, b"old-binary").await.unwrap();

        let resolved = resolve_guest(Some(source.clone()), "guest-agent", tmp_dir.path())
            .await
            .unwrap();
        tokio::fs::write(&source, b"new-binary").await.unwrap();

        assert_eq!(resolved, tmp_dir.path().join("guest-agent"));
        assert_eq!(tokio::fs::read(&resolved).await.unwrap(), b"old-binary");
    }

    #[tokio::test]
    async fn build_snapshot_uses_explicit_pending_publish_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let rootfs_paths = RootfsPaths::new(&home, "rootfs-hash");
        tokio::fs::create_dir_all(rootfs_paths.dir()).await.unwrap();
        tokio::fs::write(rootfs_paths.rootfs(), b"rootfs")
            .await
            .unwrap();
        let snapshot_dir = dir.path().join("snapshot");
        let create_uncommitted_called = Arc::new(AtomicBool::new(false));
        let create_snapshot_called = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        let provider = RecordingSnapshotProvider {
            create_uncommitted_called: Arc::clone(&create_uncommitted_called),
            create_snapshot_called: Arc::clone(&create_snapshot_called),
            committed: Arc::clone(&committed),
        };
        let def = profile::ProfileDef {
            vcpu: 1,
            memory_mb: 128,
            disk_mb: 16,
        };

        build_snapshot(
            &home,
            &rootfs_paths,
            "snapshot-hash",
            &snapshot_dir,
            &def,
            &provider,
            acquire_test_snapshot_lock(&home, "snapshot-hash").await,
        )
        .await
        .unwrap();

        assert!(create_uncommitted_called.load(Ordering::SeqCst));
        assert!(committed.load(Ordering::SeqCst));
        assert!(
            !create_snapshot_called.load(Ordering::SeqCst),
            "build_snapshot should not use the compatibility create_snapshot path"
        );
        assert!(snapshot_dir.join("snapshot.bin").exists());
        assert!(snapshot_dir.join("memory.bin").exists());
        assert!(snapshot_dir.join("cow.img").exists());
    }

    #[tokio::test]
    async fn build_snapshot_discards_pending_publish_after_commit_failure() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let rootfs_paths = RootfsPaths::new(&home, "rootfs-hash");
        tokio::fs::create_dir_all(rootfs_paths.dir()).await.unwrap();
        tokio::fs::write(rootfs_paths.rootfs(), b"rootfs")
            .await
            .unwrap();
        let snapshot_dir = dir.path().join("snapshot");
        let discarded = Arc::new(AtomicBool::new(false));
        let provider = FailingSnapshotProvider {
            discarded: Arc::clone(&discarded),
            discard_error: None,
        };
        let def = profile::ProfileDef {
            vcpu: 1,
            memory_mb: 128,
            disk_mb: 16,
        };

        let err = build_snapshot(
            &home,
            &rootfs_paths,
            "snapshot-hash",
            &snapshot_dir,
            &def,
            &provider,
            acquire_test_snapshot_lock(&home, "snapshot-hash").await,
        )
        .await
        .expect_err("snapshot publish should fail");

        assert!(
            matches!(err, RunnerError::Snapshot(sandbox::SnapshotError::Teardown(ref message)) if message == "publish failed"),
            "got: {err:?}"
        );
        assert!(
            discarded.load(Ordering::SeqCst),
            "build_snapshot should explicitly discard after commit failure"
        );
    }

    #[tokio::test]
    async fn build_snapshot_preserves_commit_error_when_discard_fails() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let rootfs_paths = RootfsPaths::new(&home, "rootfs-hash");
        tokio::fs::create_dir_all(rootfs_paths.dir()).await.unwrap();
        tokio::fs::write(rootfs_paths.rootfs(), b"rootfs")
            .await
            .unwrap();
        let snapshot_dir = dir.path().join("snapshot");
        let discarded = Arc::new(AtomicBool::new(false));
        let provider = FailingSnapshotProvider {
            discarded: Arc::clone(&discarded),
            discard_error: Some("discard failed"),
        };
        let def = profile::ProfileDef {
            vcpu: 1,
            memory_mb: 128,
            disk_mb: 16,
        };

        let err = build_snapshot(
            &home,
            &rootfs_paths,
            "snapshot-hash",
            &snapshot_dir,
            &def,
            &provider,
            acquire_test_snapshot_lock(&home, "snapshot-hash").await,
        )
        .await
        .expect_err("snapshot publish should fail");

        assert!(
            matches!(err, RunnerError::Snapshot(sandbox::SnapshotError::Teardown(ref message)) if message == "publish failed"),
            "discard failure must not mask the publish failure, got: {err:?}"
        );
        assert!(
            discarded.load(Ordering::SeqCst),
            "build_snapshot should still try discard after commit failure"
        );
    }

    #[tokio::test]
    async fn shielded_snapshot_publish_keeps_lock_after_waiter_cancelled_until_commit_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let snapshot_hash = "snapshot-hash";
        let snapshot_lock_path = home.snapshot_lock(snapshot_hash);
        let snapshot_lock = lock::acquire(snapshot_lock_path.clone())
            .await
            .expect("acquire snapshot lock");
        let snapshot_dir = dir.path().join("snapshot");
        let (commit_entered_tx, commit_entered_rx) = tokio::sync::oneshot::channel();
        let (commit_release_tx, commit_release_rx) = tokio::sync::oneshot::channel();
        let (commit_done_tx, commit_done_rx) = tokio::sync::oneshot::channel();
        let pending = ControlledPendingSnapshotPublish {
            output_dir: snapshot_dir.clone(),
            commit_outcome: ControlledCommitOutcome::Success,
            commit_entered: Some(commit_entered_tx),
            commit_release: Some(commit_release_rx),
            commit_done: Some(commit_done_tx),
            discard_entered: None,
            discard_release: None,
            discard_done: None,
        };

        let waiter = tokio::spawn(shielded_snapshot_publish(
            Box::new(pending),
            snapshot_lock,
            snapshot_hash.to_string(),
            snapshot_dir,
        ));
        commit_entered_rx.await.expect("commit should start");
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());

        assert_lock_blocked(snapshot_lock_path.clone()).await;

        commit_release_tx
            .send(())
            .expect("release commit waiter after cancellation");
        commit_done_rx.await.expect("commit should finish");
        wait_until_lock_available(snapshot_lock_path).await;
    }

    #[tokio::test]
    async fn shielded_snapshot_publish_keeps_lock_after_waiter_cancelled_until_discard_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let snapshot_hash = "snapshot-hash";
        let snapshot_lock_path = home.snapshot_lock(snapshot_hash);
        let snapshot_lock = lock::acquire(snapshot_lock_path.clone())
            .await
            .expect("acquire snapshot lock");
        let snapshot_dir = dir.path().join("snapshot");
        let (commit_entered_tx, commit_entered_rx) = tokio::sync::oneshot::channel();
        let (commit_release_tx, commit_release_rx) = tokio::sync::oneshot::channel();
        let (discard_entered_tx, discard_entered_rx) = tokio::sync::oneshot::channel();
        let (discard_release_tx, discard_release_rx) = tokio::sync::oneshot::channel();
        let (discard_done_tx, discard_done_rx) = tokio::sync::oneshot::channel();
        let pending = ControlledPendingSnapshotPublish {
            output_dir: snapshot_dir.clone(),
            commit_outcome: ControlledCommitOutcome::Failure,
            commit_entered: Some(commit_entered_tx),
            commit_release: Some(commit_release_rx),
            commit_done: None,
            discard_entered: Some(discard_entered_tx),
            discard_release: Some(discard_release_rx),
            discard_done: Some(discard_done_tx),
        };

        let waiter = tokio::spawn(shielded_snapshot_publish(
            Box::new(pending),
            snapshot_lock,
            snapshot_hash.to_string(),
            snapshot_dir,
        ));
        commit_entered_rx.await.expect("commit should start");
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());

        assert_lock_blocked(snapshot_lock_path.clone()).await;

        commit_release_tx
            .send(())
            .expect("release failing commit after cancellation");
        discard_entered_rx.await.expect("discard should start");
        assert_lock_blocked(snapshot_lock_path.clone()).await;

        discard_release_tx
            .send(())
            .expect("release discard after cancellation");
        discard_done_rx.await.expect("discard should finish");
        wait_until_lock_available(snapshot_lock_path).await;
    }

    #[test]
    fn build_args_parse_warm_rootfs_cache_flag() {
        let mut args = build_args().to_vec();
        args.push("--warm-rootfs-cache");

        let cli = <TestBuildCli as clap::Parser>::try_parse_from(args).unwrap();

        assert!(cli.args.warm_rootfs_cache);
        assert!(!cli.args.dry_run);
        assert_eq!(BuildMode::from_args(&cli.args), BuildMode::WarmRootfsCache);
    }

    #[test]
    fn build_args_parse_warm_rootfs_cache_without_guest_binaries() {
        let cli = <TestBuildCli as clap::Parser>::try_parse_from([
            "runner-build",
            "--profile",
            "vm0/default",
            "--warm-rootfs-cache",
        ])
        .unwrap();

        assert_eq!(BuildMode::from_args(&cli.args), BuildMode::WarmRootfsCache);
        assert!(cli.args.guest_agent.is_none());
        assert!(cli.args.guest_download.is_none());
        assert!(cli.args.guest_init.is_none());
        assert!(cli.args.guest_mock_claude.is_none());
        assert!(cli.args.guest_mock_codex.is_none());
        assert!(cli.args.guest_reseed.is_none());
    }

    #[test]
    fn build_mode_defaults_to_full_image() {
        let cli = <TestBuildCli as clap::Parser>::try_parse_from(build_args()).unwrap();

        assert_eq!(BuildMode::from_args(&cli.args), BuildMode::FullImage);
    }

    #[tokio::test]
    async fn rootfs_scripts_writes_embedded_scripts_once() {
        let mut scripts = RootfsScripts::new();

        let first = scripts.path().await.unwrap();
        let second = scripts.path().await.unwrap();

        assert_eq!(first, second);
        assert!(first.join("build-template.sh").exists());
        assert!(first.join("verify-rootfs.sh").exists());
        assert!(first.join("customize-rootfs.sh").exists());
    }

    #[test]
    fn required_warm_cache_requires_r2_config() {
        let err = TemplateCache::from_optional(BuildMode::WarmRootfsCache, None).unwrap_err();

        assert!(
            err.to_string()
                .contains("--warm-rootfs-cache requires all R2_*")
        );
    }

    #[tokio::test]
    async fn best_effort_upload_allows_missing_r2_cache() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let template = dir.path().join(TEMPLATE_FILE);
        tokio::fs::write(&template, b"template").await.unwrap();
        let input = TemplateInput {
            paths: &home,
            template_hash: "best-effort-hash",
            cache: TemplateCache::Disabled,
            disk_mb: 16384,
        };

        upload_template_to_r2(&input, &template, false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn full_image_r2_hit_materializes_without_local_build() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "r2-hit-rootfs");
        let archive = template_archive_bytes(b"downloaded-template").await;
        let get = template_get_rule(archive);
        let cache = mock_r2_cache(&[&get]);
        let input = template_input(&home, TemplateCache::BestEffort(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = rootfs.dir().join("attempt.tmp");
        let staging = rootfs.rootfs_staging();

        materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read(&staging).await.unwrap(),
            b"downloaded-template"
        );
        assert!(
            !work_dir.join("build-template-called").exists(),
            "valid R2 hit must not rebuild locally"
        );
        assert_eq!(get.num_calls(), 1);
    }

    #[tokio::test]
    async fn full_image_download_request_failure_falls_back_to_local_build() {
        use aws_sdk_s3::Client;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "r2-download-fallback-rootfs");
        let get = mock!(Client::get_object)
            .sequence()
            .http_status(
                500,
                Some("<Error><Code>InternalError</Code></Error>".into()),
            )
            .build();
        let head = template_head_miss_rule();
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
        let input = template_input(&home, TemplateCache::BestEffort(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = rootfs.dir().join("attempt.tmp");
        let staging = rootfs.rootfs_staging();

        materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
        .unwrap();

        assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
        assert!(work_dir.join("build-template-called").exists());
        assert!(
            get.num_calls() >= 1,
            "SDK may retry request failures before best-effort fallback"
        );
        assert_eq!(head.num_calls(), 1, "force=false should consult head");
        assert_eq!(create.num_calls(), 1);
    }

    #[tokio::test]
    async fn full_image_upload_failure_is_nonfatal_after_cache_miss() {
        use aws_sdk_s3::Client;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "r2-upload-best-effort-rootfs");
        let get = template_get_miss_rule();
        let head = mock!(Client::head_object)
            .sequence()
            .http_status(
                500,
                Some("<Error><Code>InternalError</Code></Error>".into()),
            )
            .build();
        let cache = mock_r2_cache(&[&get, &head]);
        let input = template_input(&home, TemplateCache::BestEffort(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = rootfs.dir().join("attempt.tmp");
        let staging = rootfs.rootfs_staging();

        materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
        .unwrap();

        assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
        assert!(
            head.num_calls() >= 1,
            "SDK may retry upload preflight failures before best-effort fallback"
        );
    }

    #[tokio::test]
    async fn full_image_invalid_remote_object_force_overwrites_r2() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "r2-invalid-rootfs");
        let get = template_get_rule(empty_template_archive_bytes().await);
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
        let input = template_input(&home, TemplateCache::BestEffort(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = rootfs.dir().join("attempt.tmp");
        let staging = rootfs.rootfs_staging();

        materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
        .unwrap();

        assert_eq!(tokio::fs::read(&staging).await.unwrap(), b"built-template");
        assert_eq!(
            head.num_calls(),
            0,
            "invalid remote object must force upload and skip head"
        );
        assert_eq!(create.num_calls(), 1);
        assert_eq!(upload_part.num_calls(), 1);
        assert_eq!(complete.num_calls(), 1);
    }

    #[tokio::test]
    async fn full_image_failed_downloaded_template_verification_does_not_publish_bad_template() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "r2-verify-failed-rootfs");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"old-staging")
            .await
            .unwrap();
        let get = template_get_rule(template_archive_bytes(b"verify-fail").await);
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
        let input = template_input(&home, TemplateCache::BestEffort(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = rootfs.dir().join("attempt.tmp");
        let staging = rootfs.rootfs_staging();

        materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RootfsStaging(&staging),
        )
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read(&staging).await.unwrap(),
            b"built-template",
            "failed downloaded verification must rebuild instead of publishing the bad file"
        );
        assert_eq!(
            head.num_calls(),
            0,
            "verification failure must force upload"
        );
        assert_eq!(create.num_calls(), 1);
    }

    #[tokio::test]
    async fn warm_cache_download_request_failure_is_fatal() {
        use aws_sdk_s3::Client;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let get = mock!(Client::get_object)
            .sequence()
            .http_status(
                500,
                Some("<Error><Code>InternalError</Code></Error>".into()),
            )
            .build();
        let cache = mock_r2_cache(&[&get]);
        let input = template_input(&home, TemplateCache::Required(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = home.images_dir().join("warm-attempt.tmp");

        let err = materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RemoteCacheOnly,
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string()
                .contains("R2 template download failed while warming cache"),
            "got {err}"
        );
        assert!(
            !work_dir.join("build-template-called").exists(),
            "required download failure must fail before local rebuild"
        );
    }

    #[tokio::test]
    async fn warm_cache_upload_failure_is_fatal() {
        use aws_sdk_s3::Client;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let get = template_get_miss_rule();
        let head = mock!(Client::head_object)
            .sequence()
            .http_status(
                500,
                Some("<Error><Code>InternalError</Code></Error>".into()),
            )
            .build();
        let cache = mock_r2_cache(&[&get, &head]);
        let input = template_input(&home, TemplateCache::Required(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = home.images_dir().join("warm-attempt.tmp");

        let err = materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RemoteCacheOnly,
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string()
                .contains("R2 upload failed while warming template cache"),
            "got {err}"
        );
        assert!(work_dir.join("build-template-called").exists());
        assert!(
            head.num_calls() >= 1,
            "SDK may retry upload preflight failures before returning required error"
        );
    }

    #[tokio::test]
    async fn warm_cache_invalid_remote_object_force_overwrites_r2() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let get = template_get_rule(empty_template_archive_bytes().await);
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_r2_cache(&[&get, &head, &create, &upload_part, &complete]);
        let input = template_input(&home, TemplateCache::Required(&cache));
        let (_scripts, work_dir) = fake_rootfs_scripts().await;
        let attempt_dir = home.images_dir().join("warm-attempt.tmp");

        materialize_template_from_r2_or_build(
            &input,
            &attempt_dir,
            &work_dir,
            TemplateMaterializationTarget::RemoteCacheOnly,
        )
        .await
        .unwrap();

        assert!(work_dir.join("build-template-called").exists());
        assert_eq!(
            head.num_calls(),
            0,
            "invalid remote object must force upload and skip head"
        );
        assert_eq!(create.num_calls(), 1);
        assert_eq!(upload_part.num_calls(), 1);
        assert_eq!(complete.num_calls(), 1);
    }

    #[test]
    fn template_cache_full_image_can_run_without_r2() {
        let cache = TemplateCache::from_optional(BuildMode::FullImage, None).unwrap();

        assert!(cache.is_disabled());
    }

    #[tokio::test]
    async fn existing_rootfs_best_effort_allows_missing_r2_cache() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "best-effort-local-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
            .await
            .unwrap();
        let guests = test_guest_binaries();
        let input = rootfs_input(&home, &rootfs, &guests, TemplateCache::Disabled);

        ensure_rootfs_under_lock(input, TemplateLockRelease::none())
            .await
            .unwrap();
        assert!(
            rootfs.rootfs().exists(),
            "best-effort build must not remove a valid local rootfs when R2 is missing"
        );
    }

    #[tokio::test]
    async fn existing_rootfs_releases_template_lock_callback() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "release-local-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
            .await
            .unwrap();
        let guests = test_guest_binaries();
        let input = rootfs_input(&home, &rootfs, &guests, TemplateCache::Disabled);
        let released = Arc::new(AtomicUsize::new(0));
        let released_for_callback = Arc::clone(&released);

        ensure_rootfs_under_lock(
            input,
            TemplateLockRelease::from_release(move || {
                released_for_callback.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .await
        .unwrap();

        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn template_lock_release_runs_on_drop() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let released = Arc::new(AtomicUsize::new(0));
        let released_for_callback = Arc::clone(&released);
        {
            let _release = TemplateLockRelease::from_release(move || {
                released_for_callback.fetch_add(1, Ordering::SeqCst);
            });
        }

        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn warm_template_attempt_dir_stays_on_runner_image_volume() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let images_dir = home.images_dir();
        let warm_parent = template_warm_parent_dir(&home, "abc123");

        let warm_dir = template_attempt_dir(&warm_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
        let file_name = warm_dir.file_name().and_then(|name| name.to_str()).unwrap();

        assert!(warm_dir.starts_with(&images_dir));
        assert!(warm_dir.starts_with(&warm_parent));
        assert!(!is_template_attempt_dir_name(
            file_name,
            TEMPLATE_BUILD_DIR_PREFIX
        ));
        assert!(is_template_attempt_dir_name(
            file_name,
            TEMPLATE_WARM_ATTEMPT_DIR_PREFIX
        ));
    }

    #[tokio::test]
    async fn temp_dir_cleanup_failure_fails_successful_operation() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir");
        tokio::fs::write(&file_path, b"not a directory")
            .await
            .unwrap();

        let err = finish_temp_dir_result(&file_path, "test temp dir", Ok(()))
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("remove test temp dir"),
            "cleanup failure should surface on success, got {err}"
        );
    }

    #[tokio::test]
    async fn temp_dir_cleanup_preserves_original_error() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir");
        tokio::fs::write(&file_path, b"not a directory")
            .await
            .unwrap();

        let err = finish_temp_dir_result(
            &file_path,
            "test temp dir",
            Err(RunnerError::Internal("original failure".into())),
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("original failure"),
            "original error should win when operation and cleanup both fail, got {err}"
        );
    }

    #[tokio::test]
    async fn template_warm_cleanup_removes_empty_parent() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let parent = template_warm_parent_dir(&home, "abc123");
        let attempt = template_attempt_dir(&parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
        tokio::fs::create_dir_all(&attempt).await.unwrap();

        finish_template_warm_dir_result(&parent, &attempt, Ok(()))
            .await
            .unwrap();

        assert!(!attempt.exists());
        assert!(
            !parent.exists(),
            "successful warm cleanup should not leave empty parent dirs"
        );
    }

    #[tokio::test]
    async fn template_warm_cleanup_preserves_original_error_when_parent_cleanup_fails() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("not-a-dir");
        let attempt = parent.join("attempt");
        tokio::fs::write(&parent, b"file").await.unwrap();

        let err = finish_template_warm_dir_result(
            &parent,
            &attempt,
            Err(RunnerError::Internal("warm failed".into())),
        )
        .await
        .unwrap_err();

        assert!(err.to_string().contains("warm failed"));
    }

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

    #[test]
    fn compute_template_hash_deterministic() {
        let h1 = compute_template_hash(16384);
        let h2 = compute_template_hash(16384);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn compute_template_hash_sensitive_to_disk_size() {
        assert_ne!(
            compute_template_hash(16384),
            compute_template_hash(32768),
            "template hash must change when the ext4 disk size changes"
        );
    }

    #[tokio::test]
    async fn compute_rootfs_hash_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        tokio::fs::write(&bin, b"binary-content").await.unwrap();
        let bins: &[(&Path, &str)] = &[(&bin, "/usr/local/bin/guest-agent")];

        let h1 = compute_rootfs_hash("template-hash", bins, "ca-fingerprint", 16384)
            .await
            .unwrap();
        let h2 = compute_rootfs_hash("template-hash", bins, "ca-fingerprint", 16384)
            .await
            .unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[tokio::test]
    async fn template_hash_ignores_guest_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let template_a = compute_template_hash(16384);
        let template_b = compute_template_hash(16384);
        assert_eq!(
            template_a, template_b,
            "template hash must not depend on guest binary content"
        );
    }

    #[tokio::test]
    async fn compute_rootfs_hash_sensitive_to_rootfs_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let base = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();

        let different_content = compute_rootfs_hash(
            "template-a",
            &[(&bin_b, "/usr/local/bin/guest-agent")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(
            base, different_content,
            "hash must change with binary content"
        );

        let different_disk = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            32768,
        )
        .await
        .unwrap();
        assert_ne!(base, different_disk, "hash must change with disk_mb");

        let different_dest = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-download")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(base, different_dest, "hash must change with dest path");

        let different_ca = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-b",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(base, different_ca, "hash must change with CA fingerprint");

        let different_template = compute_rootfs_hash(
            "template-b",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(base, different_template, "hash must change with template");
    }

    #[test]
    fn compute_snapshot_hash_deterministic() {
        let h1 = compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "config_xxx");
        let h2 = compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "config_xxx");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn compute_snapshot_hash_sensitive_to_each_field() {
        let base = compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "cfg");

        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_bbb", 2, 4096, "v1.14.1", "6.1.155", "cfg"),
            "must change with rootfs_hash"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 4, 4096, "v1.14.1", "6.1.155", "cfg"),
            "must change with vcpu"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 8192, "v1.14.1", "6.1.155", "cfg"),
            "must change with memory_mb"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.15.0", "6.1.155", "cfg"),
            "must change with fc_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.2.0", "cfg"),
            "must change with kernel_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "cfg2"),
            "must change with provider_config_hash"
        );
    }

    #[tokio::test]
    async fn is_rootfs_present_checks_rootfs_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "test-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        assert!(!is_rootfs_present(&rootfs).await.unwrap());

        tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
        assert!(is_rootfs_present(&rootfs).await.unwrap());
    }

    #[tokio::test]
    async fn rootfs_image_lock_uses_shared_for_existing_rootfs_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs_hash = "existing-rootfs-hash";
        let rootfs = RootfsPaths::new(&home, rootfs_hash);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();
        let _running_runner = lock::acquire_shared(home.rootfs_lock(rootfs_hash))
            .await
            .unwrap();

        let image_lock = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            acquire_rootfs_lock_for_image_build(&home, rootfs_hash, &rootfs),
        )
        .await
        .expect("existing rootfs must not wait for an exclusive lock")
        .unwrap();

        assert!(image_lock.is_shared());
    }

    #[tokio::test]
    async fn rootfs_image_lock_uses_exclusive_for_missing_rootfs() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs_hash = "missing-rootfs-hash";
        let rootfs = RootfsPaths::new(&home, rootfs_hash);

        let image_lock = acquire_rootfs_lock_for_image_build(&home, rootfs_hash, &rootfs)
            .await
            .unwrap();

        assert!(image_lock.is_exclusive());
    }

    #[tokio::test]
    async fn rootfs_image_lock_retries_exclusive_when_existing_rootfs_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs_hash = "disappearing-rootfs-hash";
        let rootfs = RootfsPaths::new(&home, rootfs_hash);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();

        let mut removed = false;
        let image_lock =
            acquire_rootfs_lock_for_image_build_inner(&home, rootfs_hash, &rootfs, || {
                if !removed {
                    std::fs::remove_file(rootfs.rootfs()).unwrap();
                    removed = true;
                }
            })
            .await
            .unwrap();

        assert!(removed);
        assert!(image_lock.is_exclusive());
    }

    #[tokio::test]
    async fn rootfs_image_lock_retries_shared_when_another_builder_commits_rootfs() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs_hash = "committed-by-other-builder-hash";
        let rootfs = RootfsPaths::new(&home, rootfs_hash);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        let builder_lock = lock::acquire(home.rootfs_lock(rootfs_hash)).await.unwrap();

        let task_home = home.clone();
        let task_rootfs_hash = rootfs_hash.to_string();
        let image_lock_task = tokio::spawn(async move {
            let task_rootfs = RootfsPaths::new(&task_home, &task_rootfs_hash);
            acquire_rootfs_lock_for_image_build(&task_home, &task_rootfs_hash, &task_rootfs).await
        });

        tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();
        drop(builder_lock);

        let image_lock = tokio::time::timeout(std::time::Duration::from_secs(2), image_lock_task)
            .await
            .expect("builder should retry with a shared lock after rootfs commit")
            .unwrap()
            .unwrap();

        assert!(image_lock.is_shared());
    }

    /// Staging contract: the in-progress `rootfs.ext4.staging` must not
    /// cause `is_rootfs_present` to report the rootfs as built. If it did,
    /// a crashed build partway through customization would still fast-path
    /// on the next run — reintroducing #11007.
    #[tokio::test]
    async fn is_rootfs_present_ignores_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "staging-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // Staging alone → not present.
        tokio::fs::write(rootfs.rootfs_staging(), b"partial")
            .await
            .unwrap();
        assert!(!is_rootfs_present(&rootfs).await.unwrap());

        // Committed file → present, even with lingering staging.
        tokio::fs::write(rootfs.rootfs(), b"committed")
            .await
            .unwrap();
        assert!(is_rootfs_present(&rootfs).await.unwrap());
    }

    #[tokio::test]
    async fn local_file_publish_removes_stale_file_residue() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "cleanup-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"crash-residue")
            .await
            .unwrap();
        assert!(rootfs.rootfs_staging().exists());

        publish.cleanup_stale_staging_best_effort().await;
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_removes_stale_directory_residue() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "cleanup-dir-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);

        tokio::fs::create_dir_all(rootfs.rootfs_staging().join("nested"))
            .await
            .unwrap();
        tokio::fs::write(
            rootfs.rootfs_staging().join("nested").join("partial"),
            b"leftover",
        )
        .await
        .unwrap();

        publish.cleanup_stale_staging_best_effort().await;
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_stale_cleanup_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "noop-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // No staging file — must not error.
        publish.cleanup_stale_staging_best_effort().await;
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_stale_cleanup_leaves_committed_rootfs_alone() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "preserve-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs(), b"real-rootfs")
            .await
            .unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"residue")
            .await
            .unwrap();

        publish.cleanup_stale_staging_best_effort().await;
        assert!(rootfs.rootfs().exists(), "committed rootfs must survive");
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_finish_removes_staging_after_error() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "failed-cleanup-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"partial-rootfs")
            .await
            .unwrap();

        let err = publish
            .finish_after_result(Err(RunnerError::Internal("customize failed".into())))
            .await
            .unwrap_err();

        assert!(err.to_string().contains("customize failed"));
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn local_file_publish_finish_preserves_original_error_when_cleanup_fails() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "failed-cleanup-dir-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.rootfs_staging())
            .await
            .unwrap();

        let err = publish
            .finish_after_result(Err(RunnerError::Internal("verify failed".into())))
            .await
            .unwrap_err();

        assert!(err.to_string().contains("verify failed"));
        assert!(
            rootfs.rootfs_staging().is_dir(),
            "cleanup failure must not mask the original build error"
        );
    }

    #[tokio::test]
    async fn local_file_publish_commit_renames_to_rootfs() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "commit-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"customized")
            .await
            .unwrap();

        publish.commit().await.unwrap();

        assert!(!rootfs.rootfs_staging().exists());
        assert!(rootfs.rootfs().exists());
        let content = tokio::fs::read(rootfs.rootfs()).await.unwrap();
        assert_eq!(content, b"customized");
    }

    /// End-to-end contract simulation for the template materialization +
    /// customization path: the verified template is moved into staging,
    /// customization mutates staging, and commit atomically publishes the rootfs.
    #[tokio::test]
    async fn staging_contract_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "happy-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // Simulate a verified template being moved into staging.
        tokio::fs::write(rootfs.rootfs_staging(), b"template-download")
            .await
            .unwrap();

        // Customize staging → commit.
        tokio::fs::write(rootfs.rootfs_staging(), b"customized")
            .await
            .unwrap();
        publish.commit().await.unwrap();

        assert!(rootfs.rootfs().exists());
        assert!(!rootfs.rootfs_staging().exists());
        assert!(is_rootfs_present(&rootfs).await.unwrap());
    }

    /// Crash simulation: template download succeeded, but the process died before
    /// normal error cleanup could run. The next build must see no committed
    /// rootfs and stale staging cleanup must wipe the partial file.
    #[tokio::test]
    async fn staging_contract_crash_leaves_recoverable_state() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "fail-hash");
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"template-download")
            .await
            .unwrap();
        // Pretend the process crashed: staging persists, rootfs.ext4 absent.

        assert!(!is_rootfs_present(&rootfs).await.unwrap());
        assert!(rootfs.rootfs_staging().exists());

        // Next build's cleanup step.
        publish.cleanup_stale_staging_best_effort().await;
        assert!(!rootfs.rootfs_staging().exists());
        assert!(!is_rootfs_present(&rootfs).await.unwrap());
    }

    #[tokio::test]
    async fn stale_template_attempt_dir_is_removed_before_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "template-build-residue-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        let build_dir = rootfs.dir().join(format!(
            "{TEMPLATE_BUILD_DIR_PREFIX}old{TEMPLATE_ATTEMPT_DIR_SUFFIX}"
        ));
        tokio::fs::create_dir_all(build_dir.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(build_dir.join("nested").join("partial"), b"leftover")
            .await
            .unwrap();

        cleanup_stale_template_attempt_dirs(rootfs.dir(), TEMPLATE_BUILD_DIR_PREFIX)
            .await
            .unwrap();

        assert!(
            !build_dir.exists(),
            "stale local template build output must not survive into a later R2-hit build"
        );
    }

    #[tokio::test]
    async fn stale_template_attempt_file_is_removed_before_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "template-build-file-residue-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        let build_dir = rootfs.dir().join(format!(
            "{TEMPLATE_BUILD_DIR_PREFIX}old{TEMPLATE_ATTEMPT_DIR_SUFFIX}"
        ));
        tokio::fs::write(&build_dir, b"not a directory")
            .await
            .unwrap();

        cleanup_stale_template_attempt_dirs(rootfs.dir(), TEMPLATE_BUILD_DIR_PREFIX)
            .await
            .unwrap();

        assert!(
            !build_dir.exists(),
            "stale local template build file must not block later template materialization"
        );
    }

    #[tokio::test]
    async fn template_attempt_cleanup_preserves_other_hash_parent() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let this_parent = template_warm_parent_dir(&home, "this-hash");
        let other_parent = template_warm_parent_dir(&home, "other-hash");
        let this_dir = template_attempt_dir(&this_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
        let other_dir = template_attempt_dir(&other_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
        tokio::fs::create_dir_all(&this_dir).await.unwrap();
        tokio::fs::create_dir_all(&other_dir).await.unwrap();

        cleanup_stale_template_attempt_dirs(&this_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX)
            .await
            .unwrap();

        assert!(!this_dir.exists());
        assert!(
            other_dir.exists(),
            "template warm cleanup for one hash must not remove another hash's active attempt"
        );
    }

    #[tokio::test]
    async fn template_warm_parent_cleanup_removes_stale_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let parent = template_warm_parent_dir(&home, "abc123");
        tokio::fs::create_dir_all(home.images_dir()).await.unwrap();
        tokio::fs::write(&parent, b"not a directory").await.unwrap();

        cleanup_template_warm_parent(&parent).await.unwrap();

        assert!(
            !parent.exists(),
            "malformed warm parent file must not block later warm attempts"
        );
    }

    /// Guard the `[sync:ca-constants]` contract between customize-rootfs.sh
    /// and verify-rootfs.sh. Drift would cause silent CA
    /// customization/verification failures on rootfs images.
    #[test]
    fn ca_constants_in_sync_across_scripts() {
        let ca_cert_line = r#"CA_CERT_FILE="mitmproxy-ca-cert.pem""#;
        let ca_dest_line = r#"CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt""#;

        assert!(
            CUSTOMIZE_SCRIPT.contains(ca_cert_line),
            "customize-rootfs.sh missing CA_CERT_FILE constant — sync with other scripts"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(ca_dest_line),
            "customize-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );

        // verify-rootfs.sh only uses CA_ROOTFS_DEST (it reads the cert from
        // inside the rootfs, not from the host CA_DIR).
        assert!(
            VERIFY_SCRIPT.contains(ca_dest_line),
            "verify-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );
    }

    /// Guard: customize-rootfs.sh must verify the CA actually made it into the
    /// system bundle after `update-ca-certificates`. `update-ca-certificates`
    /// can exit 0 while silently omitting our cert (e.g. malformed PEM),
    /// which would later surface as an opaque snapshot/VM-boot TLS error.
    /// See #9482.
    #[test]
    fn customize_rootfs_verifies_bundle_after_update() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("update-ca-certificates"),
            "customize-rootfs.sh must call update-ca-certificates"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("proxy CA not found in system bundle"),
            "customize-rootfs.sh must verify proxy CA landed in system bundle after \
             update-ca-certificates (silent failure guard; see #9482)"
        );
        assert!(
            !CUSTOMIZE_SCRIPT.contains("keytool -delete"),
            "customize-rootfs.sh starts from a CA-free template; duplicate Java aliases \
             should fail instead of being silently replaced"
        );
    }

    #[test]
    fn template_build_script_excludes_rootfs_only_inputs() {
        for forbidden in [
            "--guest-agent",
            "--guest-download",
            "--guest-init",
            "--guest-mock-claude",
            "--guest-mock-codex",
            "--guest-reseed",
            "--ca-dir",
            "--dns-nameserver",
            "CA_ROOTFS_DEST",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(
                !TEMPLATE_BUILD_SCRIPT.contains(forbidden),
                "template build script must not embed rootfs-only input: {forbidden}"
            );
        }
    }

    #[test]
    fn customize_script_uses_chroot_install_for_destinations() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo chroot \"$MOUNT_DIR\" install -D"),
            "customize-rootfs.sh should install inside the chroot so /sbin -> /usr/sbin \
             resolves like it does at boot"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("realpath -m -- \"$parent\""),
            "customize-rootfs.sh should resolve destination parents inside the chroot"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("runtime mount"),
            "customize-rootfs.sh should reject writes that resolve under /proc, /sys, or /dev"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo chroot \"$MOUNT_DIR\" rm -f -- \"$safe_dest\""),
            "customize-rootfs.sh should replace existing target symlinks instead of \
             overwriting through them"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("mktemp -d -p \"$MOUNT_DIR\""),
            "customize-rootfs.sh should create temp files directly under the mounted root, \
             not below an untrusted in-rootfs parent like /tmp"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("/proc, /sys, and /dev are not mounted yet"),
            "customize-rootfs.sh should document why file writes happen before runtime bind mounts"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("unsafe rootfs destination component"),
            "customize-rootfs.sh should reject lexical path escapes before chroot install"
        );
    }

    #[test]
    fn customize_script_fails_when_cleanup_fails() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("local status=$?"),
            "customize-rootfs.sh cleanup should preserve the original command status"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("cleanup_failed=1"),
            "customize-rootfs.sh should track cleanup failures"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("if ! rmdir \"$MOUNT_DIR\""),
            "customize-rootfs.sh should treat mount temp dir cleanup failure as a cleanup failure"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("error: rootfs cleanup failed"),
            "customize-rootfs.sh should fail a successful customization if cleanup fails"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("exit \"$status\""),
            "customize-rootfs.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn build_script_fails_when_successful_cleanup_fails() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("local status=$?"),
            "build-template.sh cleanup should preserve the original command status"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("error: template build cleanup failed"),
            "build-template.sh should fail a successful build if temp rootfs cleanup fails"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("exit \"$status\""),
            "build-template.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn build_script_outputs_template_file() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"TEMPLATE_FILE="template.ext4""#),
            "build-template.sh should produce a template image, not the rootfs image filename"
        );
    }

    #[test]
    fn build_script_publishes_debootstrap_cache_atomically() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"CACHE_TMP_TAR="${cache_tar}.tmp.$$""#),
            "build-template.sh should stage debootstrap cache writes in a process-scoped temp file"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"--make-tarball="$CACHE_TMP_TAR""#),
            "build-template.sh must not write debootstrap output directly to the stable cache path"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"--unpack-tarball="$(realpath "$CACHE_TMP_TAR")""#),
            "build-template.sh should validate the temp tarball before publishing it"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"mv -f "$CACHE_TMP_TAR" "$cache_tar""#),
            "build-template.sh should atomically publish the verified debootstrap cache tarball"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT
                .contains(r#"[[ -n "$CACHE_TMP_TAR" ]] && ! rm -f "$CACHE_TMP_TAR""#),
            "build-template.sh should remove unpublished debootstrap cache temp files on cleanup"
        );
        assert!(
            !TEMPLATE_BUILD_SCRIPT.contains(r#"--make-tarball="$cache_tar""#),
            "build-template.sh must not publish partial debootstrap cache tarballs on cancellation"
        );
    }

    #[test]
    fn build_script_locks_only_debootstrap_cache_access() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("--debootstrap-lock"),
            "build-template.sh should receive the same debootstrap cache lock path used by GC"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("flock \"$lock_fd\""),
            "build-template.sh should lock shared debootstrap cache access"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("exec {lock_fd}>>\"$DEBOOTSTRAP_LOCK\""),
            "build-template.sh should open the pre-created lock file without truncating it"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("flock -u \"$lock_fd\""),
            "build-template.sh should release the debootstrap cache lock after unpack"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("debootstrap_cache_locked\n  flock -u"),
            "build-template.sh should release the cache lock before chroot package install and mkfs"
        );
    }

    #[test]
    fn rootfs_scripts_enter_private_mount_namespace() {
        for (name, script) in [
            ("build-template.sh", TEMPLATE_BUILD_SCRIPT),
            ("customize-rootfs.sh", CUSTOMIZE_SCRIPT),
            ("verify-rootfs.sh", VERIFY_SCRIPT),
        ] {
            assert!(
                script.contains(r#"UNSHARE_SENTINEL="--__vm0_unshared__""#),
                "{name} should use a sentinel so sudo does not need to preserve env vars"
            );
            assert!(
                script.contains("unshare --mount --propagation private"),
                "{name} should isolate mounts so SIGKILL cannot leak host-visible rootfs mounts"
            );
        }
    }

    #[test]
    fn customize_script_uses_autoclear_loop_mount() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo mount -o loop \"$ROOTFS\" \"$MOUNT_DIR\""),
            "customize-rootfs.sh should let mount create an autoclear loop device"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo mount --bind /proc")
                && CUSTOMIZE_SCRIPT.contains("sudo mount --bind /sys")
                && CUSTOMIZE_SCRIPT.contains("sudo mount --bind /dev"),
            "customize-rootfs.sh should run keytool in the same proc/sys/dev chroot environment \
             as the old rootfs build path"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo umount -R \"$target\""),
            "customize-rootfs.sh should recursively unmount runtime bind mounts"
        );
        assert!(
            !CUSTOMIZE_SCRIPT.contains("losetup --find --show"),
            "customize-rootfs.sh should not keep an explicit loop device that can leak on SIGKILL"
        );
    }

    #[test]
    fn verify_script_retries_and_surfaces_cleanup_failures() {
        assert!(
            VERIFY_SCRIPT.contains("unmount_with_retries()"),
            "verify-rootfs.sh should retry unmount to avoid transient loop mount leaks"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"error: ${MODE} verification cleanup failed"#),
            "verify-rootfs.sh should fail successful verification if cleanup fails"
        );
        assert!(
            VERIFY_SCRIPT.contains("if ! rmdir \"$MOUNT_DIR\""),
            "verify-rootfs.sh should treat mount temp dir cleanup failure as a cleanup failure"
        );
        assert!(
            VERIFY_SCRIPT.contains("exit \"$status\""),
            "verify-rootfs.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn verify_script_has_template_and_rootfs_modes() {
        assert!(
            VERIFY_SCRIPT.contains("--mode)"),
            "verify-rootfs.sh should accept --mode"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"$MODE" != "template""#)
                || VERIFY_SCRIPT.contains(r#"$MODE" == "template""#),
            "verify-rootfs.sh should have a template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"$MODE" == "rootfs""#),
            "verify-rootfs.sh should gate guest/CA checks to rootfs mode"
        );
    }

    #[test]
    fn verify_script_rejects_rootfs_only_content_in_template_mode() {
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only guest binary"),
            "verify-rootfs.sh should reject guest binaries in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only proxy CA certificate"),
            "verify-rootfs.sh should reject injected proxy CA files in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only environment CA settings"),
            "verify-rootfs.sh should reject injected CA environment settings in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only resolv.conf content"),
            "verify-rootfs.sh should reject customized resolver state in template mode"
        );
    }

    #[tokio::test]
    async fn is_rootfs_present_nonexistent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "does-not-exist");

        assert!(!is_rootfs_present(&rootfs).await.unwrap());
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
