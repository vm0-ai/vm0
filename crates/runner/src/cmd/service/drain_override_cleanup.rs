use std::time::Duration;

use crate::error::{RunnerError, RunnerResult};

use super::drain_override::{
    DrainRestartOverrideRemoval, remove_drain_restart_override_outcome,
    write_drain_restart_override,
};
use super::reload::{
    SystemdReloadRequirement, coordinate_systemd_reload, coordinate_systemd_reload_bounded,
};
use super::{RunnerServiceUnit, ServiceFuture};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DrainOverrideReloadPolicy {
    Unbounded,
    Bounded {
        lock_timeout: Duration,
        command_timeout: Duration,
    },
}

trait DrainOverrideCleanupOps {
    fn remove_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval>;
    fn restore_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()>;
    fn reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
        policy: DrainOverrideReloadPolicy,
    ) -> ServiceFuture<'a, ()>;
}

struct RealDrainOverrideCleanupOps;

impl DrainOverrideCleanupOps for RealDrainOverrideCleanupOps {
    fn remove_override(
        &mut self,
        unit: &RunnerServiceUnit,
    ) -> RunnerResult<DrainRestartOverrideRemoval> {
        remove_drain_restart_override_outcome(unit)
    }

    fn restore_override(&mut self, unit: &RunnerServiceUnit) -> RunnerResult<()> {
        write_drain_restart_override(unit).map(|_| ())
    }

    fn reload<'a>(
        &'a mut self,
        unit: &'a RunnerServiceUnit,
        requirement: SystemdReloadRequirement,
        policy: DrainOverrideReloadPolicy,
    ) -> ServiceFuture<'a, ()> {
        Box::pin(async move {
            match policy {
                DrainOverrideReloadPolicy::Unbounded => {
                    coordinate_systemd_reload(unit, requirement).await?;
                }
                DrainOverrideReloadPolicy::Bounded {
                    lock_timeout,
                    command_timeout,
                } => {
                    coordinate_systemd_reload_bounded(
                        unit,
                        requirement,
                        lock_timeout,
                        command_timeout,
                    )
                    .await?;
                }
            }
            Ok(())
        })
    }
}

fn cleanup_reload_error(
    unit: &RunnerServiceUnit,
    reload_error: RunnerError,
    restore_error: RunnerError,
) -> RunnerError {
    RunnerError::Internal(format!(
        "failed to reload systemd after removing drain restart override for {}: {reload_error}; additionally failed to restore drain restart override: {restore_error}",
        unit.unit_name()
    ))
}

async fn restore_after_failed_cleanup(
    unit: &RunnerServiceUnit,
    policy: DrainOverrideReloadPolicy,
    ops: &mut impl DrainOverrideCleanupOps,
) -> RunnerResult<()> {
    if let Err(error) = ops.restore_override(unit) {
        return Err(RunnerError::Internal(format!(
            "failed to restore drain restart override for {} after cleanup reload failure: {error}",
            unit.unit_name()
        )));
    }

    if let Err(error) = ops
        .reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(true),
            policy,
        )
        .await
    {
        return Err(RunnerError::Internal(format!(
            "failed to reload systemd after restoring drain restart override for {}: {error}",
            unit.unit_name()
        )));
    }

    Ok(())
}

async fn reconcile_drain_restart_override_removal_with_ops(
    unit: &RunnerServiceUnit,
    policy: DrainOverrideReloadPolicy,
    ops: &mut impl DrainOverrideCleanupOps,
) -> RunnerResult<()> {
    let remove_result = ops.remove_override(unit);
    let removed = remove_result
        .as_ref()
        .is_ok_and(|outcome| outcome.override_removed());

    let reload_result = ops
        .reload(
            unit,
            SystemdReloadRequirement::dirty().with_drain_override(false),
            policy,
        )
        .await;

    if let Err(reload_error) = reload_result {
        let reload_error = if removed {
            match restore_after_failed_cleanup(unit, policy, ops).await {
                Ok(()) => reload_error,
                Err(restore_error) => cleanup_reload_error(unit, reload_error, restore_error),
            }
        } else {
            reload_error
        };

        return match remove_result {
            Ok(_) => Err(reload_error),
            Err(remove_error) => Err(RunnerError::Internal(format!(
                "failed to remove drain restart override for {}: {remove_error}; additionally failed to reload systemd: {reload_error}",
                unit.unit_name()
            ))),
        };
    }

    remove_result.map(|_| ())
}

pub(super) async fn reconcile_drain_restart_override_removal(
    unit: &RunnerServiceUnit,
    policy: DrainOverrideReloadPolicy,
) -> RunnerResult<()> {
    reconcile_drain_restart_override_removal_with_ops(
        unit,
        policy,
        &mut RealDrainOverrideCleanupOps,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Debug, Eq, PartialEq)]
    enum Event {
        Remove,
        Restore,
        Reload(DrainOverrideReloadPolicy, SystemdReloadRequirement),
    }

    struct FakeDrainOverrideCleanupOps {
        remove_result: Option<RunnerResult<DrainRestartOverrideRemoval>>,
        restore_result: Option<RunnerResult<()>>,
        reload_results: VecDeque<RunnerResult<()>>,
        events: Vec<Event>,
    }

    impl DrainOverrideCleanupOps for FakeDrainOverrideCleanupOps {
        fn remove_override(
            &mut self,
            _unit: &RunnerServiceUnit,
        ) -> RunnerResult<DrainRestartOverrideRemoval> {
            self.events.push(Event::Remove);
            self.remove_result.take().unwrap()
        }

        fn restore_override(&mut self, _unit: &RunnerServiceUnit) -> RunnerResult<()> {
            self.events.push(Event::Restore);
            self.restore_result.take().unwrap_or(Ok(()))
        }

        fn reload<'a>(
            &'a mut self,
            _unit: &'a RunnerServiceUnit,
            requirement: SystemdReloadRequirement,
            policy: DrainOverrideReloadPolicy,
        ) -> ServiceFuture<'a, ()> {
            self.events.push(Event::Reload(policy, requirement));
            Box::pin(std::future::ready(
                self.reload_results.pop_front().unwrap_or(Ok(())),
            ))
        }
    }

    fn service_unit() -> RunnerServiceUnit {
        RunnerServiceUnit::from_suffix("test").unwrap()
    }

    fn fake_error(message: &str) -> RunnerError {
        RunnerError::Internal(message.to_string())
    }

    fn fake_ops(
        remove_result: RunnerResult<DrainRestartOverrideRemoval>,
        reload_results: impl IntoIterator<Item = RunnerResult<()>>,
    ) -> FakeDrainOverrideCleanupOps {
        FakeDrainOverrideCleanupOps {
            remove_result: Some(remove_result),
            restore_result: None,
            reload_results: reload_results.into_iter().collect(),
            events: Vec::new(),
        }
    }

    fn bounded_policy() -> DrainOverrideReloadPolicy {
        DrainOverrideReloadPolicy::Bounded {
            lock_timeout: Duration::from_secs(20),
            command_timeout: Duration::from_secs(10),
        }
    }

    #[tokio::test]
    async fn absent_override_is_reconciled_through_both_reload_policies() {
        for policy in [DrainOverrideReloadPolicy::Unbounded, bounded_policy()] {
            let mut ops = fake_ops(Ok(DrainRestartOverrideRemoval::AlreadyAbsent), []);

            reconcile_drain_restart_override_removal_with_ops(&service_unit(), policy, &mut ops)
                .await
                .unwrap();

            assert_eq!(
                ops.events,
                [
                    Event::Remove,
                    Event::Reload(
                        policy,
                        SystemdReloadRequirement::dirty().with_drain_override(false),
                    ),
                ]
            );
        }
    }

    #[tokio::test]
    async fn failed_retry_does_not_restore_override_absent_before_this_attempt() {
        let mut ops = fake_ops(
            Ok(DrainRestartOverrideRemoval::AlreadyAbsent),
            [Err(fake_error("reload failed"))],
        );

        let error = reconcile_drain_restart_override_removal_with_ops(
            &service_unit(),
            DrainOverrideReloadPolicy::Unbounded,
            &mut ops,
        )
        .await
        .unwrap_err();

        assert_eq!(error.to_string(), "internal error: reload failed");
        assert_eq!(
            ops.events,
            [
                Event::Remove,
                Event::Reload(
                    DrainOverrideReloadPolicy::Unbounded,
                    SystemdReloadRequirement::dirty().with_drain_override(false),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn failed_directory_cleanup_reload_does_not_restore_override() {
        let mut ops = fake_ops(
            Ok(DrainRestartOverrideRemoval::DirectoryRemoved),
            [Err(fake_error("reload failed"))],
        );

        let error = reconcile_drain_restart_override_removal_with_ops(
            &service_unit(),
            DrainOverrideReloadPolicy::Unbounded,
            &mut ops,
        )
        .await
        .unwrap_err();

        assert_eq!(error.to_string(), "internal error: reload failed");
        assert_eq!(
            ops.events,
            [
                Event::Remove,
                Event::Reload(
                    DrainOverrideReloadPolicy::Unbounded,
                    SystemdReloadRequirement::dirty().with_drain_override(false),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn failed_removal_reload_restores_with_same_policy() {
        let policy = bounded_policy();
        let mut ops = fake_ops(
            Ok(DrainRestartOverrideRemoval::OverrideRemoved),
            [Err(fake_error("reload failed")), Ok(())],
        );

        let error =
            reconcile_drain_restart_override_removal_with_ops(&service_unit(), policy, &mut ops)
                .await
                .unwrap_err();

        assert_eq!(error.to_string(), "internal error: reload failed");
        assert_eq!(
            ops.events,
            [
                Event::Remove,
                Event::Reload(
                    policy,
                    SystemdReloadRequirement::dirty().with_drain_override(false),
                ),
                Event::Restore,
                Event::Reload(
                    policy,
                    SystemdReloadRequirement::dirty().with_drain_override(true),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn removal_and_reload_failures_keep_both_errors_without_restoration() {
        let mut ops = fake_ops(
            Err(fake_error("remove failed")),
            [Err(fake_error("reload failed"))],
        );

        let error = reconcile_drain_restart_override_removal_with_ops(
            &service_unit(),
            DrainOverrideReloadPolicy::Unbounded,
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("remove failed"));
        assert!(error.to_string().contains("reload failed"));
        assert!(!ops.events.contains(&Event::Restore));
    }

    #[tokio::test]
    async fn reload_and_restoration_failures_keep_both_errors() {
        let mut ops = fake_ops(
            Ok(DrainRestartOverrideRemoval::OverrideRemoved),
            [Err(fake_error("reload failed"))],
        );
        ops.restore_result = Some(Err(fake_error("restore failed")));

        let error = reconcile_drain_restart_override_removal_with_ops(
            &service_unit(),
            DrainOverrideReloadPolicy::Unbounded,
            &mut ops,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("reload failed"));
        assert!(error.to_string().contains("restore failed"));
    }
}
