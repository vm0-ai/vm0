use std::fs::File;
use std::path::{Path, PathBuf};

use clap::Args;
use nix::fcntl::Flock;
use sandbox::SnapshotProvider;

use crate::ca;
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, RootfsPaths, touch_mtime};
use crate::profile;
use crate::r2_cache::R2ImageCache;

mod guest;
mod hashes;
mod local_publish;
mod scripts;
mod sizes;
mod snapshot;

use guest::GuestBinaries;
use hashes::{
    compute_ca_cert_fingerprint, compute_rootfs_hash, compute_snapshot_hash, compute_template_hash,
};
use local_publish::LocalFilePublish;
use scripts::{RootfsScripts, rootfs_script_command, run_rootfs_script};
use sizes::file_sizes;

const ROOTFS_DNS_NAMESERVER: &str = "8.8.8.8";
const TEMPLATE_FILE: &str = "template.ext4";
const TEMPLATE_DOWNLOAD_FILE: &str = "downloaded-template.ext4";
const TEMPLATE_WARM_DIR_PREFIX: &str = "template-warm-";
const TEMPLATE_WARM_ATTEMPT_DIR_PREFIX: &str = "attempt-";
const TEMPLATE_BUILD_DIR_PREFIX: &str = "template-build-";
const TEMPLATE_ATTEMPT_DIR_SUFFIX: &str = ".tmp";

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
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-write-file binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-write-file binary (required)")
    )]
    guest_write_file: Option<PathBuf>,
    /// Profile to build (determines VM resources and disk sizes)
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

#[derive(Clone, Copy, Debug)]
enum TemplateMaterializationTarget<'a> {
    RootfsStaging(&'a Path),
    RemoteCacheOnly,
}

impl TemplateMaterializationTarget<'_> {
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
    rootfs_disk_mb: u32,
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

    let template_hash = compute_template_hash(def.rootfs_disk_mb);
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
                def.rootfs_disk_mb,
            )
            .await?;
            let snapshot_hash = compute_snapshot_hash(
                &rootfs_hash,
                def.vcpu,
                def.memory_mb,
                def.workspace_disk_mb,
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
        rootfs_disk_mb: def.rootfs_disk_mb,
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

            snapshot::build_snapshot(
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
    let mut scripts = RootfsScripts::new();
    ensure_template_cached_under_lock_with_scripts(input, &mut scripts).await
}

async fn ensure_template_cached_under_lock_with_scripts(
    input: &TemplateInput<'_>,
    scripts: &mut RootfsScripts,
) -> RunnerResult<()> {
    let cache = input.cache.as_cache().ok_or_else(|| {
        RunnerError::Internal("--warm-rootfs-cache requires R2 template cache".into())
    })?;

    let warm_parent = template_warm_parent_dir(input.paths, input.template_hash);
    cleanup_template_warm_parent(&warm_parent).await?;
    remove_empty_dir_if_exists(&warm_parent).await?;

    match cache.template_exists(input.template_hash).await {
        Ok(true) => {
            tracing::info!("[OK] template already in R2: {}", input.template_hash);
            return Ok(());
        }
        Ok(false) => {
            tracing::info!(
                "R2 template cache miss for {} — building locally",
                input.template_hash
            );
        }
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "R2 template HEAD failed while warming cache: {e}"
            )));
        }
    }

    let work_dir_path = scripts.path().await?;
    // Keep warm-up staging on the runner image volume, not the system temp
    // filesystem. A cache miss builds a full template image before uploading,
    // and /tmp may be much smaller than the runner data disk.
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
    match resolve_remote_template(input, &downloaded_template, work_dir).await? {
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
                if input.cache.is_required() {
                    tracing::warn!(
                        "R2 template object for {} failed required-cache validation ({e}) — \
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
            if input.cache.is_required() {
                tracing::warn!(
                    "R2 template object for {} is invalid in required-cache mode ({e}) — \
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
            "R2 template download failed while template cache is required: {e}"
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
    let rootfs_disk_mb_str = input.rootfs_disk_mb.to_string();

    let mut cmd = rootfs_script_command(&work_dir.join("build-template.sh"));
    cmd.arg("--output-dir")
        .arg(output_dir)
        .arg("--debootstrap-dir")
        .arg(&debootstrap_dir)
        .arg("--debootstrap-lock")
        .arg(&debootstrap_lock_path)
        .arg("--hash")
        .arg(input.template_hash)
        .arg("--rootfs-disk-mb")
        .arg(&rootfs_disk_mb_str);
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
            "R2 upload failed while template cache is required: {e}"
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
        .arg(&input.guests.guest_reseed)
        .arg("--guest-write-file")
        .arg(&input.guests.guest_write_file);
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

#[cfg(test)]
mod tests {
    use super::*;
    use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};
    use std::sync::Arc;

    #[derive(clap::Parser)]
    struct TestBuildCli {
        #[command(flatten)]
        args: BuildArgs,
    }

    fn build_args() -> [&'static str; 17] {
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
            "--guest-write-file",
            "/tmp/guest-write-file",
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
                rootfs_disk_mb: 8192,
            },
            rootfs_paths: rootfs,
            guests,
        }
    }

    fn test_guest_binaries() -> GuestBinaries {
        let temp_dir = tempfile::tempdir().unwrap();
        let guest = temp_dir.path().join("guest");
        std::fs::write(&guest, b"guest").unwrap();
        let guest_write_file = guest.clone();
        GuestBinaries {
            _temp_dir: temp_dir,
            guest_agent: guest.clone(),
            guest_download: guest.clone(),
            guest_init: guest.clone(),
            guest_mock_claude: guest.clone(),
            guest_mock_codex: guest.clone(),
            guest_reseed: guest,
            guest_write_file,
        }
    }

    fn template_input<'a>(home: &'a HomePaths, cache: TemplateCache<'a>) -> TemplateInput<'a> {
        TemplateInput {
            paths: home,
            template_hash: "test-template-hash",
            cache,
            rootfs_disk_mb: 128,
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

        (RootfsScripts::from_temp_dir(temp_dir), work_dir)
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
        assert!(cli.args.guest_write_file.is_none());
    }

    #[test]
    fn build_mode_defaults_to_full_image() {
        let cli = <TestBuildCli as clap::Parser>::try_parse_from(build_args()).unwrap();

        assert_eq!(BuildMode::from_args(&cli.args), BuildMode::FullImage);
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
            rootfs_disk_mb: 8192,
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
                .contains("R2 template download failed while template cache is required"),
            "got {err}"
        );
        assert!(
            !work_dir.join("build-template-called").exists(),
            "required download failure must fail before local rebuild"
        );
    }

    #[tokio::test]
    async fn warm_cache_existing_remote_uses_head_without_download_or_build() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let head = mock!(Client::head_object)
            .match_requests(|req| {
                req.bucket() == Some("test-bucket")
                    && req.key() == Some("runner-templates/test-template-hash.tar.zst")
            })
            .then_output(|| HeadObjectOutput::builder().build());
        let cache = mock_r2_cache(&[&head]);
        let input = template_input(&home, TemplateCache::Required(&cache));

        ensure_template_cached_under_lock(&input).await.unwrap();

        assert_eq!(head.num_calls(), 1);
        assert!(
            !template_warm_parent_dir(&home, "test-template-hash").exists(),
            "warm cache hit should not create local template staging"
        );
    }

    #[tokio::test]
    async fn warm_cache_head_hit_cleans_stale_local_attempts() {
        use aws_sdk_s3::Client;
        use aws_sdk_s3::operation::head_object::HeadObjectOutput;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let warm_parent = template_warm_parent_dir(&home, "test-template-hash");
        let stale_attempt = template_attempt_dir(&warm_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
        tokio::fs::create_dir_all(&stale_attempt).await.unwrap();
        tokio::fs::write(stale_attempt.join(TEMPLATE_FILE), b"stale")
            .await
            .unwrap();
        let head = mock!(Client::head_object)
            .match_requests(|req| {
                req.bucket() == Some("test-bucket")
                    && req.key() == Some("runner-templates/test-template-hash.tar.zst")
            })
            .then_output(|| HeadObjectOutput::builder().build());
        let cache = mock_r2_cache(&[&head]);
        let input = template_input(&home, TemplateCache::Required(&cache));

        ensure_template_cached_under_lock(&input).await.unwrap();

        assert_eq!(head.num_calls(), 1);
        assert!(
            !warm_parent.exists(),
            "warm HEAD hit must still clean stale local warm attempt residue"
        );
    }

    #[tokio::test]
    async fn warm_cache_head_request_failure_is_fatal() {
        use aws_sdk_s3::Client;

        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let head = mock!(Client::head_object)
            .sequence()
            .http_status(
                500,
                Some("<Error><Code>InternalError</Code></Error>".into()),
            )
            .build();
        let cache = mock_r2_cache(&[&head]);
        let input = template_input(&home, TemplateCache::Required(&cache));

        let err = ensure_template_cached_under_lock(&input).await.unwrap_err();

        assert!(
            err.to_string()
                .contains("R2 template HEAD failed while warming cache"),
            "got {err}"
        );
        assert!(
            !template_warm_parent_dir(&home, "test-template-hash").exists(),
            "warm cache should fail before local template staging when HEAD fails"
        );
    }

    #[tokio::test]
    async fn warm_cache_miss_builds_and_uploads_after_head_miss() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let head = template_head_miss_rule();
        let get = template_get_miss_rule();
        let (create, upload_part, complete) = multipart_success_rules();
        let cache = mock_r2_cache(&[&head, &get, &create, &upload_part, &complete]);
        let input = template_input(&home, TemplateCache::Required(&cache));
        let (mut scripts, _work_dir) = fake_rootfs_scripts().await;

        ensure_template_cached_under_lock_with_scripts(&input, &mut scripts)
            .await
            .unwrap();

        assert!(
            head.num_calls() >= 2,
            "warm miss should HEAD for warm preflight and upload dedup"
        );
        assert_eq!(get.num_calls(), 1);
        assert_eq!(create.num_calls(), 1);
        assert_eq!(upload_part.num_calls(), 1);
        assert_eq!(complete.num_calls(), 1);
        assert!(
            !template_warm_parent_dir(&home, "test-template-hash").exists(),
            "successful warm miss should clean local template staging"
        );
    }

    #[tokio::test]
    async fn warm_cache_head_miss_uses_template_uploaded_by_another_runner() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let head = template_head_miss_rule();
        let get = template_get_rule(template_archive_bytes(b"concurrent-template").await);
        let cache = mock_r2_cache(&[&head, &get]);
        let input = template_input(&home, TemplateCache::Required(&cache));
        let (mut scripts, work_dir) = fake_rootfs_scripts().await;

        ensure_template_cached_under_lock_with_scripts(&input, &mut scripts)
            .await
            .unwrap();

        assert_eq!(head.num_calls(), 1);
        assert_eq!(get.num_calls(), 1);
        assert!(
            !work_dir.join("build-template-called").exists(),
            "warm should not build locally when another runner uploaded after HEAD miss"
        );
        assert!(
            !template_warm_parent_dir(&home, "test-template-hash").exists(),
            "successful concurrent-upload warm should clean local template staging"
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
                .contains("R2 upload failed while template cache is required"),
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

    #[tokio::test]
    async fn is_rootfs_present_nonexistent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "does-not-exist");

        assert!(!is_rootfs_present(&rootfs).await.unwrap());
    }
}
