//! Kill a running sandbox and clean up resources.
//!
//! When the parent runner daemon is alive, this command asks the owning runner
//! to terminate the sandbox via the local control socket. The owner still holds
//! the process monitor and `Child` handle, so it can kill the process group and
//! handle normal cleanup without reconstructing ownership from `/proc`.
//!
//! Manual cleanup (workspace + socket dir) is only performed for orphan
//! processes whose parent runner has already died.
//!
//! Resolution: the user must specify either `--run <ID>` or `--sandbox <ID>`.
//! `--run` consults each live runner's `status.json` to translate a `run_id`
//! prefix into the `sandbox_id` that identifies the Firecracker VM, then
//! locates the FC by that `sandbox_id`. `--sandbox` matches the prefix
//! directly against running FC processes — useful for orphan sandboxes
//! whose parent runner has already died and whose `status.json` is gone.

use std::path::Path;
use std::process::ExitCode;

use clap::Args;
use sandbox::{RemoteKillResult, SandboxControl, SandboxControlError};
use tracing::info;

use crate::error::RunnerResult;
use crate::process;

mod orphan;
mod target;
#[cfg(test)]
mod test_support;

use orphan::{OrphanExitFailure, Outcome as OrphanOutcome};
use target::{
    KillTarget, discover_and_resolve_target, rediscover_same_sandbox_process,
    rediscover_same_target,
};

#[derive(Args)]
#[command(group = clap::ArgGroup::new("target").required(true))]
pub struct KillArgs {
    /// Target by run ID (full UUID or prefix) — resolved to a sandbox
    /// via status.json.
    #[arg(long, group = "target")]
    run: Option<String>,

    /// Target by sandbox ID (full UUID or prefix) — matched directly
    /// against running firecracker processes.
    #[arg(long, group = "target")]
    sandbox: Option<String>,

    /// Skip confirmation prompt
    #[arg(long, short)]
    force: bool,
}

pub async fn run_kill(args: KillArgs, control: &dyn SandboxControl) -> RunnerResult<ExitCode> {
    let initial = discover_and_resolve_target(&args).await?;
    let is_initial_orphan = process::is_orphan(initial.target.pid, &initial.runner_pids).await;

    if !args.force {
        print_target_info(&initial.target, is_initial_orphan);
        if !confirm().await {
            println!("Aborted.");
            return Ok(ExitCode::SUCCESS);
        }
    }

    let current = match rediscover_same_target(&args, &initial.target).await {
        Ok(current) => current,
        Err(error) => {
            if error.allows_disappeared_orphan_cleanup() {
                if let Ok(refreshed) = rediscover_same_sandbox_process(&initial.target).await
                    && process::is_orphan(refreshed.target.pid, &refreshed.runner_pids).await
                {
                    let outcome = if should_refuse_run_orphan_fallback(&args, is_initial_orphan) {
                        KillOutcome::RefusedTargetChanged(
                            "run target is no longer active; refusing orphan fallback for an initially managed sandbox".into(),
                        )
                    } else {
                        kill_current_target(refreshed.target.clone(), true, control).await
                    };
                    let exit_code =
                        finish_kill_outcome(&initial.target, &refreshed.target, &outcome, control)
                            .await;
                    info!(
                        sandbox_id = %refreshed.target.sandbox_id,
                        pid = refreshed.target.pid,
                        orphan = true,
                        rediscover_error = %error,
                        outcome = ?outcome,
                        "kill command fell back to owner-aware orphan handling after target rediscovery failed"
                    );
                    return Ok(exit_code);
                }

                if let Some(orphan_outcome) =
                    orphan::confirmed_disappeared_outcome(&initial.target, is_initial_orphan).await
                {
                    let outcome = KillOutcome::from(orphan_outcome);
                    let exit_code =
                        finish_kill_outcome(&initial.target, &initial.target, &outcome, control)
                            .await;
                    info!(
                        sandbox_id = %initial.target.sandbox_id,
                        pid = initial.target.pid,
                        orphan = true,
                        rediscover_error = %error,
                        outcome = ?outcome,
                        "kill command cleaned up orphan target that disappeared during rediscovery"
                    );
                    return Ok(exit_code);
                }
            }
            println!(
                "Refused to kill sandbox {} (PID {}) - {error}",
                initial.target.sandbox_id, initial.target.pid
            );
            return Ok(ExitCode::FAILURE);
        }
    };
    let is_orphan = process::is_orphan(current.target.pid, &current.runner_pids).await;
    let outcome = kill_current_target(current.target.clone(), is_orphan, control).await;
    let exit_code = finish_kill_outcome(&initial.target, &current.target, &outcome, control).await;

    info!(
        sandbox_id = %current.target.sandbox_id,
        pid = current.target.pid,
        orphan = is_orphan,
        outcome = ?outcome,
        "kill command completed"
    );

    Ok(exit_code)
}

#[derive(Debug)]
enum KillOutcome {
    OwnerAccepted(RemoteKillResult),
    OrphanKilled(KillTarget),
    OrphanAlreadyExited(KillTarget),
    OrphanTerminationUnconfirmed {
        target: KillTarget,
        failure: OrphanExitFailure,
    },
    AlreadyExitedOrChanged(KillTarget),
    SignalFailed(KillTarget),
    RefusedManagedIdle,
    RefusedManagedControlFailed(String),
    RefusedTargetChanged(String),
}

impl From<OrphanOutcome> for KillOutcome {
    fn from(outcome: OrphanOutcome) -> Self {
        match outcome {
            OrphanOutcome::Killed(target) => Self::OrphanKilled(target),
            OrphanOutcome::AlreadyExited(target) => Self::OrphanAlreadyExited(target),
            OrphanOutcome::TerminationUnconfirmed { target, failure } => {
                Self::OrphanTerminationUnconfirmed { target, failure }
            }
            OrphanOutcome::AlreadyExitedOrChanged(target) => Self::AlreadyExitedOrChanged(target),
            OrphanOutcome::SignalFailed(target) => Self::SignalFailed(target),
        }
    }
}

fn should_refuse_run_orphan_fallback(args: &KillArgs, is_initial_orphan: bool) -> bool {
    args.run.is_some() && !is_initial_orphan
}

async fn kill_current_target(
    current: KillTarget,
    is_orphan: bool,
    control: &dyn SandboxControl,
) -> KillOutcome {
    match control.kill_remote(current.control_target()).await {
        Ok(RemoteKillResult::RefusedIdle) => KillOutcome::RefusedManagedIdle,
        Ok(result) => KillOutcome::OwnerAccepted(result),
        Err(error) => retry_as_orphan_if_owner_disappeared(&current, error, is_orphan).await,
    }
}

async fn retry_as_orphan_if_owner_disappeared(
    expected: &KillTarget,
    owner_error: SandboxControlError,
    was_orphan: bool,
) -> KillOutcome {
    let refreshed = match rediscover_same_sandbox_process(expected).await {
        Ok(refreshed) => refreshed,
        Err(error) => {
            if was_orphan && error.allows_disappeared_orphan_cleanup() {
                let outcome = orphan::confirmed_disappeared_outcome(expected, was_orphan)
                    .await
                    .unwrap_or_else(|| OrphanOutcome::AlreadyExitedOrChanged(expected.clone()));
                return KillOutcome::from(outcome);
            }
            return KillOutcome::RefusedTargetChanged(error.to_string());
        }
    };
    if !process::is_orphan(refreshed.target.pid, &refreshed.runner_pids).await {
        return KillOutcome::RefusedManagedControlFailed(owner_error.to_string());
    }

    KillOutcome::from(orphan::terminate(&refreshed.target).await)
}

async fn finish_kill_outcome(
    initial: &KillTarget,
    current: &KillTarget,
    outcome: &KillOutcome,
    control: &dyn SandboxControl,
) -> ExitCode {
    if report_kill_outcome(initial, current, outcome, control).await {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn report_kill_outcome(
    initial: &KillTarget,
    current: &KillTarget,
    outcome: &KillOutcome,
    control: &dyn SandboxControl,
) -> bool {
    match outcome {
        KillOutcome::OwnerAccepted(RemoteKillResult::Accepted) => {
            println!(
                "Owning runner accepted kill for sandbox {} (PID {}).",
                current.sandbox_id, current.pid
            );
            println!("Owning runner will handle cleanup.");
            true
        }
        KillOutcome::OwnerAccepted(RemoteKillResult::AlreadyStopped) => {
            println!(
                "Sandbox {} is already stopping or stopped.",
                current.sandbox_id
            );
            println!("Owning runner will handle cleanup.");
            true
        }
        KillOutcome::OrphanKilled(target) => {
            println!(
                "Killed orphan sandbox {} (PID {})",
                target.sandbox_id, target.pid
            );
            cleanup_validated_orphan(target, control).await
        }
        KillOutcome::OrphanAlreadyExited(target) => {
            println!(
                "Orphan sandbox {} (PID {}) already exited before signal.",
                target.sandbox_id, target.pid
            );
            cleanup_validated_orphan(target, control).await
        }
        KillOutcome::OrphanTerminationUnconfirmed { target, failure } => {
            println!(
                "Failed to confirm termination of orphan sandbox {} (PID {}) - {failure}",
                target.sandbox_id, target.pid
            );
            println!("Preserved orphan workspace and runtime state for recovery.");
            false
        }
        KillOutcome::AlreadyExitedOrChanged(target) => {
            println!(
                "Refused to kill sandbox {} (PID {}) - process already exited or changed identity",
                target.sandbox_id, target.pid
            );
            false
        }
        KillOutcome::SignalFailed(target) => {
            println!(
                "Failed to kill sandbox {} (PID {})",
                target.sandbox_id, target.pid
            );
            false
        }
        KillOutcome::RefusedManagedControlFailed(error) => {
            println!(
                "Refused direct kill for managed sandbox {} (PID {}) - owning runner control failed: {error}",
                current.sandbox_id, current.pid
            );
            false
        }
        KillOutcome::OwnerAccepted(RemoteKillResult::RefusedIdle)
        | KillOutcome::RefusedManagedIdle => {
            println!(
                "Refused to kill managed idle sandbox {} (PID {}) - owning runner still owns its resources",
                current.sandbox_id, current.pid
            );
            println!(
                "Use runner drain/shutdown or wait for idle eviction so the owner can destroy it cleanly."
            );
            false
        }
        KillOutcome::RefusedTargetChanged(error) => {
            println!(
                "Refused to kill sandbox {} (PID {}) - {error}",
                initial.sandbox_id, initial.pid
            );
            false
        }
    }
}

async fn cleanup_validated_orphan(target: &KillTarget, control: &dyn SandboxControl) -> bool {
    if let Some(base_dir) = target.base_dir.as_deref() {
        let results = cleanup_orphan(&target.sandbox_id, base_dir, control).await;
        print_cleanup_results(&results)
    } else {
        println!("Skipped orphan cleanup because sandbox workspace identity is unavailable.");
        false
    }
}

fn print_cleanup_results(results: &[(String, bool)]) -> bool {
    if results.is_empty() {
        return true;
    }

    println!("Orphan cleanup:");
    for (step, success) in results {
        let icon = if *success { "ok" } else { "FAIL" };
        println!("  [{icon}] {step}");
    }
    results.iter().all(|(_, success)| *success)
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

async fn cleanup_orphan(
    sandbox_id: &str,
    base_dir: &Path,
    control: &dyn SandboxControl,
) -> Vec<(String, bool)> {
    let mut results = Vec::new();

    // Workspace dir
    let workspace = base_dir.join("workspaces").join(sandbox_id);
    let label = format!("Workspace: {}", workspace.display());
    let success = remove_dir_if_exists(&workspace).await;
    results.push((label, success));

    // Socket dir
    let sock_dir = control.runtime_dir(sandbox_id);
    let label = format!("Socket dir: {}", sock_dir.display());
    let success = remove_dir_if_exists(&sock_dir).await;
    results.push((label, success));

    results
}

/// Remove a directory, treating `NotFound` as success.
async fn remove_dir_if_exists(path: &Path) -> bool {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "failed to remove directory");
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

fn print_target_info(fc: &KillTarget, is_orphan: bool) {
    println!("Kill sandbox {}?", fc.sandbox_id);
    println!("  PID:    {}", fc.pid);
    if is_orphan {
        println!("  Status: orphan (parent runner not running)");
    } else {
        let ppid_str = fc.ppid.map_or("unknown".into(), |p| p.to_string());
        println!("  Status: managed by runner (PID {ppid_str})");
    }
    println!();
}

async fn confirm() -> bool {
    tokio::task::spawn_blocking(|| {
        use std::io::Write;
        print!("Proceed? [y/N] ");
        let _ = std::io::stdout().flush();
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).is_err() {
            return false;
        }
        let trimmed = input.trim().to_lowercase();
        trimmed == "y" || trimmed == "yes"
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!(error = %e, "confirmation prompt failed");
        false
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use sandbox::SandboxControlTarget;
    use sandbox_mock::MockSandboxControl;

    use super::test_support::make_target;
    use super::*;

    fn make_target_at_base(pid: u32, sandbox_id: &str, base_dir: &Path) -> KillTarget {
        let mut target = make_target(pid, sandbox_id);
        target.base_dir = Some(base_dir.to_path_buf());
        target.identity.as_mut().unwrap().base_dir = Some(base_dir.to_path_buf());
        target
    }

    #[test]
    fn run_fallback_refuses_initially_managed_target() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };

        assert!(should_refuse_run_orphan_fallback(&args, false));
    }

    #[test]
    fn run_fallback_allows_initial_orphan_target() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };

        assert!(!should_refuse_run_orphan_fallback(&args, true));
    }

    #[test]
    fn sandbox_fallback_allows_initially_managed_target() {
        let args = KillArgs {
            run: None,
            sandbox: Some("sbox".into()),
            force: true,
        };

        assert!(!should_refuse_run_orphan_fallback(&args, false));
    }

    #[tokio::test]
    async fn managed_target_requests_owner_control() {
        let control = MockSandboxControl::new("/tmp/test");
        let current = make_target(200, "sbox-123");

        let outcome = kill_current_target(current, false, &control).await;

        assert!(matches!(
            outcome,
            KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
        ));
        assert_eq!(
            control.recorded_kill_targets(),
            vec![SandboxControlTarget::sandbox("sbox-123")]
        );
    }

    #[tokio::test]
    async fn managed_run_target_preserves_full_run_identity() {
        let control = MockSandboxControl::new("/tmp/test");
        let mut current = make_target(200, "sbox-123");
        current.run_id = Some("run-full-id".into());

        let outcome = kill_current_target(current, false, &control).await;

        assert!(matches!(
            outcome,
            KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
        ));
        assert_eq!(
            control.recorded_kill_targets(),
            vec![SandboxControlTarget::run("run-full-id", "sbox-123")]
        );
    }

    #[tokio::test]
    async fn managed_idle_target_is_refused() {
        let control = MockSandboxControl::new("/tmp/test");
        control.push_kill_remote_result(Ok(RemoteKillResult::RefusedIdle));
        let current = make_target(200, "sbox-123");

        let outcome = kill_current_target(current, false, &control).await;

        assert!(matches!(outcome, KillOutcome::RefusedManagedIdle));
        assert_eq!(
            control.recorded_kill_targets(),
            vec![SandboxControlTarget::sandbox("sbox-123")]
        );
    }

    #[tokio::test]
    async fn apparent_orphan_prefers_owner_control_when_available() {
        let control = MockSandboxControl::new("/tmp/test");
        let current = make_target(200, "sbox-123");

        let outcome = kill_current_target(current, true, &control).await;

        assert!(matches!(
            outcome,
            KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
        ));
        assert_eq!(
            control.recorded_kill_targets(),
            vec![SandboxControlTarget::sandbox("sbox-123")]
        );
    }

    #[tokio::test]
    async fn orphan_target_uses_current_reresolved_identity() {
        let control = MockSandboxControl::new("/tmp/test");
        control.push_kill_remote_result(Err(SandboxControlError::NotFound("missing".into())));
        let current = make_target(u32::MAX - 2_000, "sbox-123");

        let outcome = kill_current_target(current.clone(), true, &control).await;

        match outcome {
            KillOutcome::OrphanAlreadyExited(target) => assert_eq!(target, current),
            other => panic!("expected current target to be reported gone, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // Orphan cleanup tests (using sandbox-mock)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn unconfirmed_orphan_termination_preserves_cleanup_paths() {
        let workspace_base = tempfile::tempdir().unwrap();
        let socket_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(socket_base.path());
        let target = make_target_at_base(200, "sbox-123", workspace_base.path());
        let workspace = workspace_base.path().join("workspaces/sbox-123");
        let socket_dir = control.runtime_dir("sbox-123");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&socket_dir).await.unwrap();
        let outcome = KillOutcome::OrphanTerminationUnconfirmed {
            target: target.clone(),
            failure: OrphanExitFailure::TimedOut,
        };

        let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

        assert_eq!(exit_code, ExitCode::FAILURE);
        assert!(workspace.exists());
        assert!(socket_dir.exists());
    }

    #[tokio::test]
    async fn confirmed_orphan_termination_cleans_paths_and_succeeds() {
        let workspace_base = tempfile::tempdir().unwrap();
        let socket_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(socket_base.path());
        let target = make_target_at_base(200, "sbox-123", workspace_base.path());
        let workspace = workspace_base.path().join("workspaces/sbox-123");
        let socket_dir = control.runtime_dir("sbox-123");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&socket_dir).await.unwrap();
        let outcome = KillOutcome::OrphanKilled(target.clone());

        let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

        assert_eq!(exit_code, ExitCode::SUCCESS);
        assert!(!workspace.exists());
        assert!(!socket_dir.exists());
    }

    #[tokio::test]
    async fn cleanup_failure_fails_command_and_attempts_remaining_steps() {
        let workspace_base = tempfile::tempdir().unwrap();
        let socket_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(socket_base.path());
        let target = make_target_at_base(200, "sbox-123", workspace_base.path());
        let workspace = workspace_base.path().join("workspaces/sbox-123");
        let socket_dir = control.runtime_dir("sbox-123");
        tokio::fs::create_dir_all(workspace.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&workspace, "not a directory")
            .await
            .unwrap();
        tokio::fs::create_dir_all(&socket_dir).await.unwrap();
        let outcome = KillOutcome::OrphanKilled(target.clone());

        let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

        assert_eq!(exit_code, ExitCode::FAILURE);
        assert!(workspace.exists());
        assert!(
            !socket_dir.exists(),
            "socket cleanup should still run after workspace cleanup fails"
        );
    }

    #[tokio::test]
    async fn already_exited_orphan_with_missing_paths_succeeds() {
        let workspace_base = tempfile::tempdir().unwrap();
        let socket_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(socket_base.path());
        let target = make_target_at_base(200, "sbox-123", workspace_base.path());
        let outcome = KillOutcome::OrphanAlreadyExited(target.clone());

        let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

        assert_eq!(exit_code, ExitCode::SUCCESS);
    }

    #[tokio::test]
    async fn cleanup_orphan_removes_workspace_and_socket_dir() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        // Create workspace dir that should be cleaned up
        let workspace = base.join("workspaces").join("sbox-123");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::write(workspace.join("file.txt"), "data")
            .await
            .unwrap();

        // Create socket dir via MockSandboxControl base path
        let sock_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(sock_base.path());
        let sock_dir = control.runtime_dir("sbox-123");
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();

        let results = cleanup_orphan("sbox-123", base, &control).await;

        assert_eq!(results.len(), 2);
        assert!(results[0].1, "workspace cleanup should succeed");
        assert!(results[1].1, "socket cleanup should succeed");
        assert!(!workspace.exists());
        assert!(!sock_dir.exists());
    }

    #[tokio::test]
    async fn cleanup_orphan_succeeds_when_dirs_missing() {
        let workspace_base = tempfile::tempdir().unwrap();
        let sock_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(sock_base.path());
        let workspace = workspace_base.path().join("workspaces").join("sbox-456");
        let sock_dir = control.runtime_dir("sbox-456");

        assert!(!workspace.exists(), "workspace should start missing");
        assert!(!sock_dir.exists(), "socket directory should start missing");

        let results = cleanup_orphan("sbox-456", workspace_base.path(), &control).await;

        // Both should "succeed" — NotFound is treated as success
        assert_eq!(results.len(), 2);
        assert!(results[0].1, "workspace cleanup should succeed");
        assert!(results[1].1, "socket cleanup should succeed");
    }
}
