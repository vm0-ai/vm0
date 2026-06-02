//! Sandbox factory creation and shutdown for `runner start`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use sandbox::{SandboxFactory, SandboxRuntime};
use tracing::{info, warn};

use super::TeardownTimer;
use crate::config::{self, ProfileConfig};
use crate::error::RunnerResult;
use crate::paths::HomePaths;

/// A sandbox factory shared across concurrent job executors.
///
/// Uses `Arc<Box<...>>` instead of `Arc<dyn ...>` because `Arc::try_unwrap`
/// requires a sized type -- `dyn SandboxFactory` is unsized, but `Box<dyn
/// SandboxFactory>` is sized, allowing `try_unwrap` at shutdown.
pub(super) type SharedFactory = Arc<Box<dyn SandboxFactory>>;

/// Build one sandbox factory per configured profile.
pub(super) async fn start_factories(
    profiles: &BTreeMap<String, ProfileConfig>,
    firecracker: &config::FirecrackerConfig,
    base_dir: &Path,
    home: &HomePaths,
    runtime: &mut dyn SandboxRuntime,
) -> RunnerResult<BTreeMap<String, (SharedFactory, bool)>> {
    let mut factories: BTreeMap<String, (SharedFactory, bool)> = BTreeMap::new();
    for (profile_name, profile_config) in profiles {
        let factory_config = config::RunnerConfig::build_factory_config(
            firecracker,
            base_dir,
            profile_name,
            profile_config,
            home,
        );
        let restore_guest_state = factory_config.snapshot.is_some();
        let factory_result = runtime.create_factory(factory_config).await;
        let factory = match factory_result {
            Ok(factory) => factory,
            Err(e) => {
                shutdown_factories(&mut factories, runtime, None).await;
                return Err(e.into());
            }
        };
        factories.insert(
            profile_name.clone(),
            (Arc::new(factory), restore_guest_state),
        );
        info!(profile = %profile_name, "factory started");
    }
    Ok(factories)
}

/// Shut down all factories, then release shared runtime resources.
pub(super) async fn shutdown_factories(
    factories: &mut BTreeMap<String, (SharedFactory, bool)>,
    runtime: &mut dyn SandboxRuntime,
    teardown: Option<&TeardownTimer>,
) {
    for (name, (factory, _)) in std::mem::take(factories) {
        match Arc::try_unwrap(factory) {
            Ok(mut f) => {
                let phase = teardown.map(|timer| {
                    let phase_start = Instant::now();
                    info!(
                        phase = "factory_shutdown",
                        profile = %name,
                        elapsed_ms = timer.elapsed_ms(),
                        "teardown phase started"
                    );
                    phase_start
                });
                f.shutdown().await;
                if let (Some(timer), Some(phase)) = (teardown, phase) {
                    info!(
                        phase = "factory_shutdown",
                        profile = %name,
                        phase_ms = TeardownTimer::duration_ms(phase.elapsed()),
                        elapsed_ms = timer.elapsed_ms(),
                        "teardown phase complete"
                    );
                }
            }
            Err(_) => warn!(profile = %name, "factory still referenced at shutdown"),
        }
    }
    // Clean up runtime-owned shared resources (netns and NBD device pools).
    let phase = teardown.map(|timer| timer.phase_start("runtime_shutdown"));
    runtime.shutdown().await;
    if let (Some(timer), Some(phase)) = (teardown, phase) {
        timer.phase_complete("runtime_shutdown", phase);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use sandbox::{Sandbox, SandboxError, SandboxInitializationPhase};

    struct RecordingRuntime {
        create_calls: AtomicUsize,
        factory_shutdowns: Arc<AtomicUsize>,
        factory_configs: Mutex<Vec<sandbox::FactoryConfig>>,
        runtime_shutdowns: AtomicUsize,
        fail_at: usize,
    }

    impl RecordingRuntime {
        fn new(fail_at: usize) -> Self {
            Self {
                create_calls: AtomicUsize::new(0),
                factory_shutdowns: Arc::new(AtomicUsize::new(0)),
                factory_configs: Mutex::new(Vec::new()),
                runtime_shutdowns: AtomicUsize::new(0),
                fail_at,
            }
        }
    }

    #[async_trait]
    impl SandboxRuntime for RecordingRuntime {
        async fn create_factory(
            &self,
            config: sandbox::FactoryConfig,
        ) -> sandbox::Result<Box<dyn SandboxFactory>> {
            let call = self.create_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == self.fail_at {
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::Factory,
                    message: "factory failed".into(),
                });
            }
            self.factory_configs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(config);
            Ok(Box::new(RecordingFactory {
                shutdowns: Arc::clone(&self.factory_shutdowns),
            }))
        }

        async fn shutdown(&mut self) {
            self.runtime_shutdowns.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct RecordingFactory {
        shutdowns: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl SandboxFactory for RecordingFactory {
        fn name(&self) -> &str {
            "recording"
        }

        fn config_hash(&self) -> String {
            "recording".into()
        }

        async fn create(
            &self,
            _config: sandbox::SandboxConfig,
        ) -> sandbox::Result<Box<dyn Sandbox>> {
            panic!("factory lifecycle tests do not create sandboxes")
        }

        async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {}

        async fn shutdown(&mut self) {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn profile(rootfs_hash: &str, snapshot_hash: &str) -> ProfileConfig {
        ProfileConfig {
            rootfs_hash: rootfs_hash.into(),
            snapshot_hash: snapshot_hash.into(),
            vcpu: 2,
            memory_mb: 4096,
            rootfs_disk_mb: 8192,
            workspace_disk_mb: 10240,
        }
    }

    #[tokio::test]
    async fn start_factories_shuts_down_started_factories_after_create_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let base_dir = temp.path().join("base");
        let firecracker = config::FirecrackerConfig {
            binary: temp.path().join("firecracker"),
            kernel: temp.path().join("vmlinux"),
        };
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/first".into(), profile("rootfs-1", "snapshot-1"));
        profiles.insert("vm0/second".into(), profile("rootfs-2", "snapshot-2"));
        let mut runtime = RecordingRuntime::new(2);

        let result = start_factories(&profiles, &firecracker, &base_dir, &home, &mut runtime).await;

        assert!(result.is_err());
        assert_eq!(runtime.create_calls.load(Ordering::SeqCst), 2);
        assert_eq!(runtime.factory_shutdowns.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn start_factories_shuts_down_runtime_after_first_factory_create_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(temp.path().join("home"));
        let base_dir = temp.path().join("base");
        let firecracker = config::FirecrackerConfig {
            binary: temp.path().join("firecracker"),
            kernel: temp.path().join("vmlinux"),
        };
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/first".into(), profile("rootfs-1", "snapshot-1"));
        profiles.insert("vm0/second".into(), profile("rootfs-2", "snapshot-2"));
        let mut runtime = RecordingRuntime::new(1);

        let result = start_factories(&profiles, &firecracker, &base_dir, &home, &mut runtime).await;

        assert!(result.is_err());
        assert_eq!(runtime.create_calls.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.factory_shutdowns.load(Ordering::SeqCst), 0);
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shutdown_factories_skips_factories_that_are_still_referenced() {
        let mut runtime = RecordingRuntime::new(usize::MAX);
        let factory_shutdowns = Arc::clone(&runtime.factory_shutdowns);
        let retained_factory: SharedFactory = Arc::new(Box::new(RecordingFactory {
            shutdowns: Arc::clone(&factory_shutdowns),
        }));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/first".into(), (Arc::clone(&retained_factory), false));

        shutdown_factories(&mut factories, &mut runtime, None).await;

        assert!(factories.is_empty());
        assert_eq!(factory_shutdowns.load(Ordering::SeqCst), 0);
        assert_eq!(runtime.runtime_shutdowns.load(Ordering::SeqCst), 1);
        drop(retained_factory);
    }
}
