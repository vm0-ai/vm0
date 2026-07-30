use std::time::Duration;

use tracing::{debug, info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

use super::systemctl::{
    BoundedSystemctlOutcome, SystemdReloadState, read_systemd_reload_state,
    read_systemd_reload_state_bounded, run_systemctl, run_systemctl_bounded,
};
use super::{RunnerServiceUnit, ServiceFuture};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SystemdReloadRequirement {
    Dirty,
    DirtyOrNotFound,
}

impl SystemdReloadRequirement {
    fn requires_reload(self, state: SystemdReloadState) -> bool {
        state.need_daemon_reload() || matches!(self, Self::DirtyOrNotFound) && state.is_not_found()
    }
}

trait SystemdReloadOps {
    fn read_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdReloadState>;
    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()>;
}

struct RealSystemdReloadOps {
    command_timeout: Option<Duration>,
}

impl SystemdReloadOps for RealSystemdReloadOps {
    fn read_state<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
    ) -> ServiceFuture<'a, SystemdReloadState> {
        Box::pin(async move {
            match self.command_timeout {
                Some(duration) => read_systemd_reload_state_bounded(unit, duration).await,
                None => read_systemd_reload_state(unit).await,
            }
        })
    }

    fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
        Box::pin(async move {
            match self.command_timeout {
                Some(duration) => {
                    match run_systemctl_bounded(&["daemon-reload"], duration).await? {
                        BoundedSystemctlOutcome::Success => Ok(()),
                        BoundedSystemctlOutcome::Failed(status) => Err(RunnerError::Internal(
                            format!("systemctl daemon-reload exited with {status} during cleanup"),
                        )),
                        BoundedSystemctlOutcome::TimedOut => Err(RunnerError::Internal(format!(
                            "systemctl daemon-reload timed out after {}s during cleanup",
                            duration.as_secs()
                        ))),
                    }
                }
                None => run_systemctl(&["daemon-reload"]).await,
            }
        })
    }
}

async fn acquire_systemd_reload_lock(
    home: &HomePaths,
    unit: &RunnerServiceUnit,
    lock_timeout: Option<Duration>,
) -> RunnerResult<nix::fcntl::Flock<std::fs::File>> {
    let path = home.systemd_daemon_reload_lock();
    match lock_timeout {
        Some(duration) => tokio::time::timeout(duration, crate::lock::acquire(path))
            .await
            .map_err(|_| {
                RunnerError::Internal(format!(
                    "timed out waiting {}s for systemd daemon-reload lock while updating {}",
                    duration.as_secs(),
                    unit.unit_name()
                ))
            })?,
        None => crate::lock::acquire(path).await,
    }
}

async fn coordinate_systemd_reload_with_ops(
    unit: &RunnerServiceUnit,
    home: &HomePaths,
    requirement: SystemdReloadRequirement,
    lock_timeout: Option<Duration>,
    ops: &mut impl SystemdReloadOps,
) -> RunnerResult<bool> {
    let _reload_lock = acquire_systemd_reload_lock(home, unit, lock_timeout).await?;

    let should_reload = match ops.read_state(unit).await {
        Ok(state) => requirement.requires_reload(state),
        Err(error) => {
            warn!(
                unit = %unit.unit_name(),
                error = %error,
                "failed to read systemd reload state; falling back to daemon-reload"
            );
            true
        }
    };

    if !should_reload {
        debug!(
            unit = %unit.unit_name(),
            "systemd reload skipped because the unit mutation is already effective"
        );
        return Ok(false);
    }

    ops.daemon_reload().await?;
    info!(unit = %unit.unit_name(), "systemd daemon reloaded");
    Ok(true)
}

pub(super) async fn coordinate_systemd_reload(
    unit: &RunnerServiceUnit,
    requirement: SystemdReloadRequirement,
) -> RunnerResult<bool> {
    let home = HomePaths::new()?;
    coordinate_systemd_reload_with_ops(
        unit,
        &home,
        requirement,
        None,
        &mut RealSystemdReloadOps {
            command_timeout: None,
        },
    )
    .await
}

pub(super) async fn coordinate_systemd_reload_bounded(
    unit: &RunnerServiceUnit,
    requirement: SystemdReloadRequirement,
    lock_timeout: Duration,
    command_timeout: Duration,
) -> RunnerResult<bool> {
    let home = HomePaths::new()?;
    coordinate_systemd_reload_with_ops(
        unit,
        &home,
        requirement,
        Some(lock_timeout),
        &mut RealSystemdReloadOps {
            command_timeout: Some(command_timeout),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    #[derive(Clone)]
    struct FakeSystemdReloadOps {
        dirty: Arc<AtomicBool>,
        query_error: bool,
        reload_count: Arc<AtomicUsize>,
    }

    impl SystemdReloadOps for FakeSystemdReloadOps {
        fn read_state<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
        ) -> ServiceFuture<'a, SystemdReloadState> {
            Box::pin(std::future::ready(if self.query_error {
                Err(RunnerError::Internal("query failed".to_string()))
            } else {
                Ok(SystemdReloadState::for_test(
                    false,
                    self.dirty.load(Ordering::SeqCst),
                ))
            }))
        }

        fn daemon_reload(&mut self) -> ServiceFuture<'_, ()> {
            self.reload_count.fetch_add(1, Ordering::SeqCst);
            self.dirty.store(false, Ordering::SeqCst);
            Box::pin(std::future::ready(Ok(())))
        }
    }

    fn fake_ops(dirty: bool) -> FakeSystemdReloadOps {
        FakeSystemdReloadOps {
            dirty: Arc::new(AtomicBool::new(dirty)),
            query_error: false,
            reload_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[test]
    fn install_requires_reload_for_not_found_unit() {
        let state = SystemdReloadState::for_test(true, false);

        assert!(
            SystemdReloadRequirement::DirtyOrNotFound.requires_reload(state),
            "a newly written unit must be loaded before start"
        );
        assert!(!SystemdReloadRequirement::Dirty.requires_reload(state));
    }

    #[tokio::test]
    async fn query_failure_falls_back_to_daemon_reload() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let mut ops = fake_ops(false);
        ops.query_error = true;

        assert!(
            coordinate_systemd_reload_with_ops(
                &unit,
                &home,
                SystemdReloadRequirement::Dirty,
                None,
                &mut ops,
            )
            .await
            .unwrap()
        );
        assert_eq!(ops.reload_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn different_units_coalesce_one_dirty_generation_under_real_flock() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let unit_a = RunnerServiceUnit::from_suffix("reload-a").unwrap();
        let unit_b = RunnerServiceUnit::from_suffix("reload-b").unwrap();
        let ops = fake_ops(true);
        let mut ops_a = ops.clone();
        let mut ops_b = ops.clone();

        let (result_a, result_b) = tokio::join!(
            coordinate_systemd_reload_with_ops(
                &unit_a,
                &home,
                SystemdReloadRequirement::Dirty,
                None,
                &mut ops_a,
            ),
            coordinate_systemd_reload_with_ops(
                &unit_b,
                &home,
                SystemdReloadRequirement::Dirty,
                None,
                &mut ops_b,
            ),
        );

        let performed = [result_a.unwrap(), result_b.unwrap()]
            .into_iter()
            .filter(|performed| *performed)
            .count();
        assert_eq!(performed, 1);
        assert_eq!(ops.reload_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_coordinator_times_out_waiting_for_global_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let unit = RunnerServiceUnit::from_suffix("test").unwrap();
        let _holder = crate::lock::acquire(home.systemd_daemon_reload_lock())
            .await
            .unwrap();
        let mut ops = fake_ops(true);

        let error = coordinate_systemd_reload_with_ops(
            &unit,
            &home,
            SystemdReloadRequirement::Dirty,
            Some(Duration::from_secs(1)),
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("systemd daemon-reload lock"));
        assert_eq!(ops.reload_count.load(Ordering::SeqCst), 0);
    }
}
