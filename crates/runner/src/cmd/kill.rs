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

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use sandbox::{RemoteKillResult, SandboxControl, SandboxControlError};
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;
use crate::process::{
    self, DiscoveredProcesses, FirecrackerProcessIdentity, FirecrackerProcessInfo, ProcessStat,
    ProcessStatRead,
};
use crate::run_resolution;

const ORPHAN_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const ORPHAN_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

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

                let discovered_after_error = process::discover_all_with_status().await;
                if should_cleanup_disappeared_initial_orphan(
                    &initial.target,
                    is_initial_orphan,
                    discovered_after_error.proc_scan_complete,
                    &discovered_after_error.processes,
                ) && initial_process_confirmed_terminated(&initial.target).await
                {
                    let outcome = KillOutcome::OrphanAlreadyExited(initial.target.clone());
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
enum RediscoverTargetError {
    Resolve(String),
    Changed(String),
}

impl RediscoverTargetError {
    fn allows_disappeared_orphan_cleanup(&self) -> bool {
        matches!(self, Self::Resolve(_))
    }
}

impl std::fmt::Display for RediscoverTargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Resolve(error) | Self::Changed(error) => f.write_str(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
struct KillTarget {
    pid: u32,
    ppid: Option<u32>,
    run_id: Option<String>,
    sandbox_id: String,
    base_dir: Option<PathBuf>,
    identity: Option<FirecrackerProcessIdentity>,
}

impl From<&FirecrackerProcessInfo> for KillTarget {
    fn from(process: &FirecrackerProcessInfo) -> Self {
        Self {
            pid: process.pid,
            ppid: process.ppid,
            run_id: None,
            sandbox_id: process.sandbox_id.clone(),
            base_dir: process.base_dir.clone(),
            identity: process.identity.clone(),
        }
    }
}

struct ResolvedProcessTarget<'a> {
    process: &'a FirecrackerProcessInfo,
    run_id: Option<String>,
}

struct ResolvedKillTarget {
    target: KillTarget,
    runner_pids: Vec<u32>,
}

struct LiveRunnerContext {
    runner_pids: Vec<u32>,
    run_mappings: Option<run_resolution::ActiveRunMappings>,
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

async fn discover_and_resolve_target(args: &KillArgs) -> RunnerResult<ResolvedKillTarget> {
    let home = HomePaths::new()?;
    let live_runner_context = live_runner_context(&home, args.run.is_some()).await?;
    let discovered = process::discover_all().await;
    let resolved = resolve_target(args, &discovered, live_runner_context.run_mappings.as_ref())?;
    let mut target = KillTarget::from(resolved.process);
    target.run_id = resolved.run_id;

    Ok(ResolvedKillTarget {
        target,
        runner_pids: live_runner_context.runner_pids,
    })
}

async fn live_runner_context(
    home: &HomePaths,
    include_run_mappings: bool,
) -> RunnerResult<LiveRunnerContext> {
    let live_runners = crate::live_runner_instances::try_list(home).await?;
    let runner_pids = live_runners.iter().map(|runner| runner.pid).collect();
    let run_mappings = if include_run_mappings {
        Some(run_resolution::collect_active_run_mappings(&live_runners).await)
    } else {
        None
    };
    Ok(LiveRunnerContext {
        runner_pids,
        run_mappings,
    })
}

fn resolve_target<'a>(
    args: &KillArgs,
    discovered: &'a DiscoveredProcesses,
    run_mappings: Option<&run_resolution::ActiveRunMappings>,
) -> RunnerResult<ResolvedProcessTarget<'a>> {
    if let Some(ref run_id) = args.run {
        let mappings = run_mappings.ok_or_else(|| {
            RunnerError::Config("run mappings are required when resolving --run".into())
        })?;
        let resolved = resolve_by_run_id(run_id, mappings, &discovered.firecrackers)?;
        return Ok(ResolvedProcessTarget {
            process: resolved.process,
            run_id: Some(resolved.run_id),
        });
    }

    if let Some(ref sandbox_id) = args.sandbox {
        return Ok(ResolvedProcessTarget {
            process: resolve_by_sandbox_id(sandbox_id, &discovered.firecrackers)?,
            run_id: None,
        });
    }

    Err(RunnerError::Config(
        "one of --run or --sandbox is required".into(),
    ))
}

async fn rediscover_same_target(
    args: &KillArgs,
    initial: &KillTarget,
) -> Result<ResolvedKillTarget, RediscoverTargetError> {
    let current = discover_and_resolve_target(args)
        .await
        .map_err(|error| RediscoverTargetError::Resolve(error.to_string()))?;
    ensure_same_target_after_confirmation(args, initial, &current.target)
        .map_err(RediscoverTargetError::Changed)?;
    Ok(current)
}

async fn rediscover_same_sandbox_process(
    expected: &KillTarget,
) -> Result<ResolvedKillTarget, RediscoverTargetError> {
    let home =
        HomePaths::new().map_err(|error| RediscoverTargetError::Resolve(error.to_string()))?;
    let live_runner_context = live_runner_context(&home, false)
        .await
        .map_err(|error| RediscoverTargetError::Resolve(error.to_string()))?;
    let discovered = process::discover_all().await;
    let target = resolve_same_sandbox_process(expected, &discovered)?;

    Ok(ResolvedKillTarget {
        target,
        runner_pids: live_runner_context.runner_pids,
    })
}

fn resolve_same_sandbox_process(
    expected: &KillTarget,
    discovered: &DiscoveredProcesses,
) -> Result<KillTarget, RediscoverTargetError> {
    let matches: Vec<&FirecrackerProcessInfo> = discovered
        .firecrackers
        .iter()
        .filter(|process| process.sandbox_id == expected.sandbox_id)
        .collect();
    let process = match matches.as_slice() {
        [single] => *single,
        [] => {
            return Err(RediscoverTargetError::Resolve(format!(
                "sandbox '{}' no longer has a firecracker process",
                expected.sandbox_id
            )));
        }
        _ => {
            let pids: Vec<String> = matches
                .iter()
                .map(|process| process.pid.to_string())
                .collect();
            return Err(RediscoverTargetError::Resolve(format!(
                "sandbox '{}' has multiple firecracker processes: PID {}",
                expected.sandbox_id,
                pids.join(", ")
            )));
        }
    };
    let target = KillTarget::from(process);
    let target = KillTarget {
        run_id: expected.run_id.clone(),
        ..target
    };
    if !same_firecracker_identity(expected, &target) {
        return Err(RediscoverTargetError::Changed(
            "sandbox process already exited or changed identity".into(),
        ));
    }
    Ok(target)
}

fn ensure_same_target_after_confirmation(
    args: &KillArgs,
    initial: &KillTarget,
    current: &KillTarget,
) -> Result<(), String> {
    if args.run.is_some() {
        match (&initial.run_id, &current.run_id) {
            (Some(initial_run), Some(current_run)) if initial_run == current_run => {}
            (Some(initial_run), Some(current_run)) => {
                return Err(format!(
                    "run target changed from run '{}' to '{}'",
                    initial_run, current_run
                ));
            }
            _ => {
                return Err("run target could not be verified by active run identity".into());
            }
        }
        if current.sandbox_id != initial.sandbox_id {
            return Err(format!(
                "run target changed from sandbox '{}' to '{}'",
                initial.sandbox_id, current.sandbox_id
            ));
        }
        return Ok(());
    }

    if args.sandbox.is_some() {
        if current.sandbox_id != initial.sandbox_id {
            return Err(format!(
                "sandbox target changed from '{}' to '{}'",
                initial.sandbox_id, current.sandbox_id
            ));
        }
        if !same_firecracker_identity(initial, current) {
            return Err("sandbox process already exited or changed identity".into());
        }
        return Ok(());
    }

    Err("one of --run or --sandbox is required".into())
}

fn same_firecracker_identity(initial: &KillTarget, current: &KillTarget) -> bool {
    match (&initial.identity, &current.identity) {
        (Some(initial), Some(current)) => initial == current,
        _ => false,
    }
}

fn should_cleanup_disappeared_initial_orphan(
    initial: &KillTarget,
    was_orphan: bool,
    proc_scan_complete: bool,
    discovered_after_error: &DiscoveredProcesses,
) -> bool {
    proc_scan_complete
        && was_orphan
        && target_has_workspace_identity(initial)
        && !discovered_has_same_or_unidentified_firecracker(initial, discovered_after_error)
}

fn should_refuse_run_orphan_fallback(args: &KillArgs, is_initial_orphan: bool) -> bool {
    args.run.is_some() && !is_initial_orphan
}

fn target_has_workspace_identity(target: &KillTarget) -> bool {
    match (&target.base_dir, &target.identity) {
        (Some(base_dir), Some(identity)) => {
            identity.sandbox_id == target.sandbox_id && identity.base_dir.as_ref() == Some(base_dir)
        }
        _ => false,
    }
}

fn discovered_has_same_or_unidentified_firecracker(
    initial: &KillTarget,
    discovered: &DiscoveredProcesses,
) -> bool {
    discovered.firecrackers.iter().any(|process| {
        process.sandbox_id == initial.sandbox_id || process.workspace_identity_incomplete()
    })
}

/// Resolve a `--run` prefix to a single Firecracker process.
///
/// Maps run_id → sandbox_id via the provided mappings, then locates the FC
/// by sandbox_id. The caller is responsible for collecting `mappings` via
/// [`run_resolution::collect_active_run_mappings`] so this function stays pure and
/// testable.
struct ResolvedRunProcess<'a> {
    run_id: String,
    process: &'a FirecrackerProcessInfo,
}

fn resolve_by_run_id<'a>(
    input: &str,
    mappings: &run_resolution::ActiveRunMappings,
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<ResolvedRunProcess<'a>> {
    let mapping = run_resolution::resolve_run_mapping(input, mappings)?;
    let fc_matches: Vec<&FirecrackerProcessInfo> = firecrackers
        .iter()
        .filter(|fc| fc.sandbox_id == mapping.sandbox_id)
        .collect();
    match fc_matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "run '{input}' maps to sandbox '{}' but no firecracker process for it",
            mapping.sandbox_id
        ))),
        [single] => Ok(ResolvedRunProcess {
            run_id: mapping.run_id,
            process: single,
        }),
        _ => {
            let pids: Vec<String> = fc_matches.iter().map(|fc| fc.pid.to_string()).collect();
            let pid_list = pids.join(", ");
            Err(RunnerError::Config(format!(
                "run '{input}' maps to sandbox '{sandbox_id}' but multiple firecracker processes match it: PID {pid_list}",
                sandbox_id = mapping.sandbox_id,
            )))
        }
    }
}

/// Resolve a `--sandbox` prefix to a single Firecracker process.
///
/// Matches directly against running FC processes by sandbox_id prefix.
fn resolve_by_sandbox_id<'a>(
    input: &str,
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    if input.is_empty() {
        return Err(RunnerError::Config("sandbox id must not be empty".into()));
    }
    let fc_matches: Vec<&FirecrackerProcessInfo> = firecrackers
        .iter()
        .filter(|fc| fc.sandbox_id.starts_with(input))
        .collect();
    match fc_matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "no running sandbox matches '{input}'"
        ))),
        [single] => Ok(single),
        _ => {
            let ids: Vec<&str> = fc_matches.iter().map(|fc| fc.sandbox_id.as_str()).collect();
            Err(RunnerError::Config(format!(
                "ambiguous sandbox prefix '{input}', matches: {}",
                ids.join(", ")
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Process kill
// ---------------------------------------------------------------------------

async fn kill_current_target(
    current: KillTarget,
    is_orphan: bool,
    control: &dyn SandboxControl,
) -> KillOutcome {
    match control.kill_remote(&current.sandbox_id).await {
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
                return already_gone_orphan_outcome(expected).await;
            }
            return KillOutcome::RefusedTargetChanged(error.to_string());
        }
    };
    if !process::is_orphan(refreshed.target.pid, &refreshed.runner_pids).await {
        return KillOutcome::RefusedManagedControlFailed(owner_error.to_string());
    }

    kill_orphan_process_group(&refreshed.target).await
}

async fn kill_orphan_process_group(target: &KillTarget) -> KillOutcome {
    let identity = match validate_orphan_target(target).await {
        OrphanTargetValidation::Valid { identity } => identity,
        OrphanTargetValidation::AlreadyGone => {
            return already_gone_orphan_outcome(target).await;
        }
        OrphanTargetValidation::Changed => {
            return KillOutcome::AlreadyExitedOrChanged(target.clone());
        }
    };

    match signal_process_group(target.pid, identity.pgid) {
        ProcessGroupSignalResult::Signaled => match wait_for_orphan_exit(&identity).await {
            Ok(()) => KillOutcome::OrphanKilled(target.clone()),
            Err(failure) => KillOutcome::OrphanTerminationUnconfirmed {
                target: target.clone(),
                failure,
            },
        },
        ProcessGroupSignalResult::AlreadyGone => already_gone_orphan_outcome(target).await,
        ProcessGroupSignalResult::Failed => KillOutcome::SignalFailed(target.clone()),
    }
}

async fn already_gone_orphan_outcome(target: &KillTarget) -> KillOutcome {
    let discovered = process::discover_all_with_status().await;
    if should_cleanup_disappeared_initial_orphan(
        target,
        true,
        discovered.proc_scan_complete,
        &discovered.processes,
    ) && initial_process_confirmed_terminated(target).await
    {
        KillOutcome::OrphanAlreadyExited(target.clone())
    } else {
        KillOutcome::AlreadyExitedOrChanged(target.clone())
    }
}

enum OrphanTargetValidation {
    Valid {
        identity: FirecrackerProcessIdentity,
    },
    AlreadyGone,
    Changed,
}

async fn validate_orphan_target(target: &KillTarget) -> OrphanTargetValidation {
    let Some(identity) = &target.identity else {
        tracing::warn!(
            pid = target.pid,
            sandbox_id = %target.sandbox_id,
            "refusing orphan kill without process identity"
        );
        return OrphanTargetValidation::Changed;
    };

    if identity.pid != target.pid {
        tracing::warn!(
            pid = target.pid,
            identity_pid = identity.pid,
            "refusing orphan kill with inconsistent process identity"
        );
        return OrphanTargetValidation::Changed;
    }

    let stat = match process::read_process_stat_checked(target.pid).await {
        ProcessStatRead::Found(stat) => stat,
        ProcessStatRead::Missing => {
            tracing::warn!(
                pid = target.pid,
                "orphan target disappeared before validation"
            );
            return OrphanTargetValidation::AlreadyGone;
        }
        ProcessStatRead::Unreadable(error) => {
            tracing::warn!(
                pid = target.pid,
                %error,
                "refusing orphan kill because process stat is unreadable"
            );
            return OrphanTargetValidation::Changed;
        }
        ProcessStatRead::Invalid => {
            tracing::warn!(
                pid = target.pid,
                "refusing orphan kill because process stat is invalid"
            );
            return OrphanTargetValidation::Changed;
        }
    };
    if !process_stat_matches_identity(identity, &stat) {
        tracing::warn!(
            pid = target.pid,
            expected_pgid = identity.pgid,
            current_pgid = stat.pgid,
            expected_starttime = identity.starttime,
            current_starttime = stat.starttime,
            "refusing orphan kill after process identity changed"
        );
        return OrphanTargetValidation::Changed;
    }
    if !process::process_stat_is_live(&stat) {
        tracing::warn!(
            pid = target.pid,
            state = %stat.state,
            "orphan target already exited and is waiting to be reaped"
        );
        return OrphanTargetValidation::AlreadyGone;
    }

    let Some(cmdline) = process::read_cmdline(target.pid).await else {
        tracing::warn!(
            pid = target.pid,
            "failed to read cmdline before orphan kill"
        );
        return classify_orphan_validation_after_unreadable_pid_fact(target.pid, identity).await;
    };
    if !process::is_firecracker_cmdline(&cmdline) {
        tracing::warn!(
            pid = target.pid,
            "refusing orphan kill for non-firecracker cmdline"
        );
        return OrphanTargetValidation::Changed;
    }

    let cwd_info = process::read_cwd(target.pid)
        .await
        .and_then(|cwd| process::parse_workspace_cwd(&cwd));
    if !orphan_identity_matches_facts(identity, &stat, true, cwd_info.as_ref()) {
        tracing::warn!(
            pid = target.pid,
            sandbox_id = %target.sandbox_id,
            "refusing orphan kill after workspace identity changed"
        );
        return classify_orphan_validation_after_unreadable_pid_fact(target.pid, identity).await;
    }

    let final_stat = match process::read_process_stat_checked(target.pid).await {
        ProcessStatRead::Found(stat) => stat,
        ProcessStatRead::Missing => {
            tracing::warn!(
                pid = target.pid,
                "orphan target disappeared during validation"
            );
            return OrphanTargetValidation::AlreadyGone;
        }
        ProcessStatRead::Unreadable(error) => {
            tracing::warn!(
                pid = target.pid,
                %error,
                "refusing orphan kill because process stat became unreadable"
            );
            return OrphanTargetValidation::Changed;
        }
        ProcessStatRead::Invalid => {
            tracing::warn!(
                pid = target.pid,
                "refusing orphan kill because process stat became invalid"
            );
            return OrphanTargetValidation::Changed;
        }
    };
    if !process_stat_matches_identity(identity, &final_stat) {
        tracing::warn!(
            pid = target.pid,
            expected_pgid = identity.pgid,
            current_pgid = final_stat.pgid,
            expected_starttime = identity.starttime,
            current_starttime = final_stat.starttime,
            "refusing orphan kill after process identity changed during validation"
        );
        return OrphanTargetValidation::Changed;
    }
    if !process::process_stat_is_live(&final_stat) {
        tracing::warn!(
            pid = target.pid,
            state = %final_stat.state,
            "orphan target exited during validation and is waiting to be reaped"
        );
        return OrphanTargetValidation::AlreadyGone;
    }

    OrphanTargetValidation::Valid {
        identity: identity.clone(),
    }
}

async fn classify_orphan_validation_after_unreadable_pid_fact(
    pid: u32,
    identity: &FirecrackerProcessIdentity,
) -> OrphanTargetValidation {
    match process::read_process_stat_checked(pid).await {
        ProcessStatRead::Found(stat)
            if process_stat_matches_identity(identity, &stat)
                && !process::process_stat_is_live(&stat) =>
        {
            OrphanTargetValidation::AlreadyGone
        }
        ProcessStatRead::Found(stat) if process_stat_matches_identity(identity, &stat) => {
            OrphanTargetValidation::Changed
        }
        ProcessStatRead::Found(_) => OrphanTargetValidation::Changed,
        ProcessStatRead::Missing => OrphanTargetValidation::AlreadyGone,
        ProcessStatRead::Unreadable(_) | ProcessStatRead::Invalid => {
            OrphanTargetValidation::Changed
        }
    }
}

async fn initial_process_confirmed_terminated(target: &KillTarget) -> bool {
    let Some(identity) = &target.identity else {
        return false;
    };
    matches!(
        classify_orphan_exit_observation(
            identity,
            process::read_process_stat_checked(target.pid).await,
        ),
        OrphanExitObservation::Terminated
    )
}

#[derive(Debug, Eq, PartialEq)]
enum OrphanExitObservation {
    Live,
    Terminated,
    IdentityChanged {
        expected_pgid: u32,
        observed_pgid: u32,
        expected_starttime: u64,
        observed_starttime: u64,
    },
    Unverifiable(String),
}

#[derive(Debug, Eq, PartialEq)]
enum OrphanExitFailure {
    TimedOut,
    IdentityChanged {
        expected_pgid: u32,
        observed_pgid: u32,
        expected_starttime: u64,
        observed_starttime: u64,
    },
    Unverifiable(String),
}

impl std::fmt::Display for OrphanExitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut => f.write_str("process is still live at the termination deadline"),
            Self::IdentityChanged {
                expected_pgid,
                observed_pgid,
                expected_starttime,
                observed_starttime,
            } => write!(
                f,
                "process identity changed while waiting for termination \
                 (PGID {expected_pgid} -> {observed_pgid}, starttime \
                 {expected_starttime} -> {observed_starttime})"
            ),
            Self::Unverifiable(error) => {
                write!(f, "process termination could not be verified: {error}")
            }
        }
    }
}

fn classify_orphan_exit_observation(
    identity: &FirecrackerProcessIdentity,
    read: ProcessStatRead,
) -> OrphanExitObservation {
    match read {
        ProcessStatRead::Found(stat) if !process_stat_matches_identity(identity, &stat) => {
            OrphanExitObservation::IdentityChanged {
                expected_pgid: identity.pgid,
                observed_pgid: stat.pgid,
                expected_starttime: identity.starttime,
                observed_starttime: stat.starttime,
            }
        }
        ProcessStatRead::Found(stat) if process::process_stat_is_live(&stat) => {
            OrphanExitObservation::Live
        }
        ProcessStatRead::Found(_) | ProcessStatRead::Missing => OrphanExitObservation::Terminated,
        ProcessStatRead::Unreadable(error) => {
            OrphanExitObservation::Unverifiable(error.to_string())
        }
        ProcessStatRead::Invalid => {
            OrphanExitObservation::Unverifiable("process stat is invalid".into())
        }
    }
}

async fn wait_for_orphan_exit(
    identity: &FirecrackerProcessIdentity,
) -> Result<(), OrphanExitFailure> {
    wait_for_orphan_exit_with(
        identity,
        ORPHAN_EXIT_TIMEOUT,
        ORPHAN_EXIT_POLL_INTERVAL,
        process::read_process_stat_checked,
    )
    .await
}

async fn wait_for_orphan_exit_with<ReadStat, ReadStatFuture>(
    identity: &FirecrackerProcessIdentity,
    timeout: Duration,
    poll_interval: Duration,
    mut read_stat: ReadStat,
) -> Result<(), OrphanExitFailure>
where
    ReadStat: FnMut(u32) -> ReadStatFuture,
    ReadStatFuture: std::future::Future<Output = ProcessStatRead>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let failure =
            match classify_orphan_exit_observation(identity, read_stat(identity.pid).await) {
                OrphanExitObservation::Terminated => return Ok(()),
                OrphanExitObservation::IdentityChanged {
                    expected_pgid,
                    observed_pgid,
                    expected_starttime,
                    observed_starttime,
                } => {
                    return Err(OrphanExitFailure::IdentityChanged {
                        expected_pgid,
                        observed_pgid,
                        expected_starttime,
                        observed_starttime,
                    });
                }
                OrphanExitObservation::Live => OrphanExitFailure::TimedOut,
                OrphanExitObservation::Unverifiable(error) => {
                    OrphanExitFailure::Unverifiable(error)
                }
            };

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(failure);
        }
        tokio::time::sleep(poll_interval.min(deadline - now)).await;
    }
}

fn process_stat_matches_identity(
    identity: &FirecrackerProcessIdentity,
    stat: &ProcessStat,
) -> bool {
    stat.pgid == identity.pgid && stat.starttime == identity.starttime
}

fn orphan_identity_matches_facts(
    identity: &FirecrackerProcessIdentity,
    stat: &ProcessStat,
    is_firecracker_cmdline: bool,
    cwd_info: Option<&(String, PathBuf)>,
) -> bool {
    process_stat_matches_identity(identity, stat)
        && is_firecracker_cmdline
        && workspace_identity_matches(identity, cwd_info)
}

fn workspace_identity_matches(
    identity: &FirecrackerProcessIdentity,
    cwd_info: Option<&(String, PathBuf)>,
) -> bool {
    match (&identity.base_dir, cwd_info) {
        (Some(expected_base_dir), Some((sandbox_id, base_dir))) => {
            sandbox_id == &identity.sandbox_id && base_dir == expected_base_dir
        }
        _ => false,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessGroupSignalResult {
    Signaled,
    AlreadyGone,
    Failed,
}

/// Send `SIGKILL` to a validated process group.
fn signal_process_group(pid: u32, pgid: u32) -> ProcessGroupSignalResult {
    if pgid <= 1 {
        tracing::warn!(pid, pgid, "refusing to signal system process group");
        return ProcessGroupSignalResult::Failed;
    }

    let Ok(pgid_i32) = i32::try_from(pgid) else {
        return ProcessGroupSignalResult::Failed;
    };
    if nix::unistd::getpgrp().as_raw() == pgid_i32 {
        tracing::warn!(pid, pgid = pgid_i32, "refusing to signal own process group");
        return ProcessGroupSignalResult::Failed;
    }

    match nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pgid_i32),
        nix::sys::signal::Signal::SIGKILL,
    ) {
        Ok(()) => {
            info!(pid, pgid = pgid_i32, "killed process group");
            ProcessGroupSignalResult::Signaled
        }
        Err(nix::errno::Errno::ESRCH) => {
            info!(
                pid,
                pgid = pgid_i32,
                "process group already exited before signal"
            );
            ProcessGroupSignalResult::AlreadyGone
        }
        Err(e) => {
            tracing::warn!(pid, pgid = pgid_i32, error = %e, "failed to kill process group");
            ProcessGroupSignalResult::Failed
        }
    }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::PathBuf;

    use sandbox_mock::MockSandboxControl;
    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const ORPHAN_KILL_CHILD_ENV: &str = "VM0_RUNNER_ORPHAN_KILL_TEST_CHILD";
    const ORPHAN_KILL_READY_LINE: &str = "vm0 orphan kill test ready";

    fn make_fc(pid: u32, sandbox_id: &str) -> FirecrackerProcessInfo {
        FirecrackerProcessInfo {
            pid,
            ppid: None,
            sandbox_id: sandbox_id.into(),
            base_dir: Some(PathBuf::from("/data/r1")),
            identity: None,
        }
    }

    fn make_target(pid: u32, sandbox_id: &str) -> KillTarget {
        KillTarget {
            pid,
            ppid: None,
            run_id: None,
            sandbox_id: sandbox_id.into(),
            base_dir: Some(PathBuf::from("/data/r1")),
            identity: Some(FirecrackerProcessIdentity {
                pid,
                pgid: pid + 1000,
                starttime: 123456,
                sandbox_id: sandbox_id.into(),
                base_dir: Some(PathBuf::from("/data/r1")),
            }),
        }
    }

    fn make_target_at_base(pid: u32, sandbox_id: &str, base_dir: &Path) -> KillTarget {
        let mut target = make_target(pid, sandbox_id);
        target.base_dir = Some(base_dir.to_path_buf());
        target.identity.as_mut().unwrap().base_dir = Some(base_dir.to_path_buf());
        target
    }

    fn make_run_target(pid: u32, run_id: &str, sandbox_id: &str) -> KillTarget {
        KillTarget {
            run_id: Some(run_id.into()),
            ..make_target(pid, sandbox_id)
        }
    }

    fn make_fc_from_target(target: &KillTarget) -> FirecrackerProcessInfo {
        FirecrackerProcessInfo {
            pid: target.pid,
            ppid: target.ppid,
            sandbox_id: target.sandbox_id.clone(),
            base_dir: target.base_dir.clone(),
            identity: target.identity.clone(),
        }
    }

    fn process_stat(identity: &FirecrackerProcessIdentity) -> ProcessStat {
        process_stat_with_state(identity, 'S')
    }

    fn process_stat_with_state(identity: &FirecrackerProcessIdentity, state: char) -> ProcessStat {
        ProcessStat {
            state,
            ppid: 7,
            pgid: identity.pgid,
            starttime: identity.starttime,
        }
    }

    /// Build an `ActiveRunMappings` from a vec of `(run_id, sandbox_id)` pairs
    /// with zero read failures — the common test case.
    fn mappings(entries: Vec<(String, String)>) -> run_resolution::ActiveRunMappings {
        let total = if entries.is_empty() { 0 } else { 1 };
        run_resolution::ActiveRunMappings {
            entries,
            runners_total: total,
            runners_failed: 0,
        }
    }

    #[tokio::test]
    async fn live_runner_context_uses_registry_pids_for_orphan_owners() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        let handle = crate::live_runner_instances::publish(
            &home,
            crate::live_runner_instances::LiveRunnerInstanceMetadata {
                config_path: dir.path().join("benchmark.yaml"),
                base_dir: dir.path().join("benchmark-base"),
                runner_name: "bench-runner".into(),
                runner_group: "vm0/test".into(),
                subcommand: "benchmark".into(),
            },
        )
        .await
        .unwrap();

        let context = live_runner_context(&home, false).await.unwrap();

        assert_eq!(context.runner_pids, vec![std::process::id()]);
        assert!(context.run_mappings.is_none());
        assert!(handle.remove_if_current().await.unwrap());
    }

    #[tokio::test]
    async fn live_runner_context_fails_when_registry_cannot_be_validated() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        std::fs::create_dir_all(dir.path().join("vm0-runner")).unwrap();
        std::fs::write(home.live_runner_instances_dir(), b"not a directory").unwrap();

        let error = match live_runner_context(&home, false).await {
            Ok(_) => panic!("expected unreadable registry to fail"),
            Err(error) => error,
        };

        assert!(
            error.to_string().contains("validate live runner instances"),
            "{error}"
        );
    }

    // -- resolve_by_run_id (run_id → FC lookup via status + FC list) ---------

    #[test]
    fn by_run_id_mapped_sandbox_not_running() {
        let status = mappings(vec![("run-x-1".into(), "sandbox-gone".into())]);
        let fcs: Vec<FirecrackerProcessInfo> = vec![];
        let Err(e) = resolve_by_run_id("run-x", &status, &fcs) else {
            panic!("expected error when sandbox has no firecracker process");
        };
        let msg = e.to_string();
        assert!(msg.contains("run 'run-x'"), "{msg}");
        assert!(msg.contains("sandbox-gone"), "{msg}");
        assert!(msg.contains("no firecracker process"), "{msg}");
    }

    #[test]
    fn by_run_id_rejects_duplicate_sandbox_processes() {
        let status = mappings(vec![("run-x-1".into(), "sandbox-dup".into())]);
        let fcs = vec![make_fc(200, "sandbox-dup"), make_fc(201, "sandbox-dup")];

        let Err(e) = resolve_by_run_id("run-x", &status, &fcs) else {
            panic!("expected error when multiple firecracker processes share a sandbox id");
        };
        let msg = e.to_string();

        assert!(msg.contains("multiple firecracker processes"), "{msg}");
        assert!(msg.contains("200"), "{msg}");
        assert!(msg.contains("201"), "{msg}");
    }

    #[test]
    fn resolve_target_uses_supplied_registry_mappings() {
        let args = KillArgs {
            run: Some("run-live".into()),
            sandbox: None,
            force: true,
        };
        let discovered = DiscoveredProcesses {
            firecrackers: vec![make_fc(200, "sandbox-live")],
            mitmdumps: vec![],
            dnsmasqs: vec![],
        };
        let supplied_mappings = mappings(vec![("run-live-123".into(), "sandbox-live".into())]);

        let resolved = resolve_target(&args, &discovered, Some(&supplied_mappings)).unwrap();

        assert_eq!(resolved.process.pid, 200);
        assert_eq!(resolved.run_id.as_deref(), Some("run-live-123"));
    }

    // -- resolve_by_sandbox_id tests -----------------------------------------

    #[test]
    fn by_sandbox_id_prefix_match() {
        let fcs = vec![make_fc(200, "orphan-sandbox-id-123")];
        let result = resolve_by_sandbox_id("orphan-sandbox", &fcs);
        assert_eq!(result.unwrap().pid, 200);
    }

    #[test]
    fn by_sandbox_id_ambiguous() {
        let fcs = vec![
            make_fc(400, "orphan-aaa-111"),
            make_fc(401, "orphan-aaa-222"),
        ];
        let Err(e) = resolve_by_sandbox_id("orphan-aaa", &fcs) else {
            panic!("expected ambiguity error");
        };
        let msg = e.to_string();
        assert!(msg.contains("ambiguous"), "{msg}");
        assert!(msg.contains("orphan-aaa-111"), "{msg}");
        assert!(msg.contains("orphan-aaa-222"), "{msg}");
    }

    #[test]
    fn by_sandbox_id_no_match() {
        let fcs = vec![make_fc(100, "sbox-A")];
        let result = resolve_by_sandbox_id("nonexistent", &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn by_sandbox_id_empty_input() {
        let fcs = vec![make_fc(100, "sbox-A")];
        let result = resolve_by_sandbox_id("", &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn by_sandbox_id_empty_list() {
        let fcs: Vec<FirecrackerProcessInfo> = vec![];
        let result = resolve_by_sandbox_id("abc", &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn sandbox_reresolution_requires_same_process_identity() {
        let args = KillArgs {
            run: None,
            sandbox: Some("sbox".into()),
            force: true,
        };
        let initial = make_target(200, "sbox-123");
        let mut current = make_target(200, "sbox-123");
        current.identity.as_mut().unwrap().starttime += 1;

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("changed identity"), "{error}");
    }

    #[test]
    fn run_reresolution_requires_same_sandbox() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };
        let initial = make_run_target(200, "run-123", "sbox-old");
        let current = make_run_target(201, "run-123", "sbox-new");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("run target changed"), "{error}");
        assert!(error.contains("sbox-old"), "{error}");
        assert!(error.contains("sbox-new"), "{error}");
    }

    #[test]
    fn run_reresolution_requires_same_run_identity() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };
        let initial = make_run_target(200, "run-old", "sbox-reused");
        let current = make_run_target(200, "run-new", "sbox-reused");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("run target changed from run"), "{error}");
        assert!(error.contains("run-old"), "{error}");
        assert!(error.contains("run-new"), "{error}");
    }

    #[test]
    fn run_reresolution_rejects_missing_run_identity() {
        let args = KillArgs {
            run: Some("run".into()),
            sandbox: None,
            force: true,
        };
        let initial = make_run_target(200, "run-old", "sbox-reused");
        let current = make_target(200, "sbox-reused");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("active run identity"), "{error}");
    }

    #[test]
    fn same_sandbox_fallback_accepts_exact_identity_without_run_status() {
        let expected = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![make_fc_from_target(&expected)]);

        let target = resolve_same_sandbox_process(&expected, &discovered).unwrap();

        assert_eq!(target, expected);
    }

    #[test]
    fn same_sandbox_fallback_rejects_changed_process_identity() {
        let expected = make_target(200, "sbox-123");
        let mut changed = make_target(200, "sbox-123");
        changed.identity.as_mut().unwrap().starttime += 1;
        let discovered = discovered_with_firecrackers(vec![make_fc_from_target(&changed)]);

        let error = resolve_same_sandbox_process(&expected, &discovered).unwrap_err();

        assert!(error.to_string().contains("changed identity"));
    }

    fn discovered_with_firecrackers(
        firecrackers: Vec<FirecrackerProcessInfo>,
    ) -> DiscoveredProcesses {
        DiscoveredProcesses {
            firecrackers,
            mitmdumps: vec![],
            dnsmasqs: vec![],
        }
    }

    #[test]
    fn disappeared_initial_orphan_with_identity_allows_cleanup() {
        let initial = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![]);

        assert!(should_cleanup_disappeared_initial_orphan(
            &initial,
            true,
            true,
            &discovered
        ));
    }

    #[test]
    fn incomplete_process_scan_rejects_disappeared_orphan_cleanup() {
        let initial = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![]);

        assert!(!should_cleanup_disappeared_initial_orphan(
            &initial,
            true,
            false,
            &discovered
        ));
    }

    #[test]
    fn disappeared_initial_managed_target_rejects_cleanup() {
        let initial = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![]);

        assert!(!should_cleanup_disappeared_initial_orphan(
            &initial,
            false,
            true,
            &discovered
        ));
    }

    #[test]
    fn disappeared_initial_without_workspace_identity_rejects_cleanup() {
        let mut initial = make_target(200, "sbox-123");
        initial.identity.as_mut().unwrap().base_dir = None;
        let discovered = discovered_with_firecrackers(vec![]);

        assert!(!should_cleanup_disappeared_initial_orphan(
            &initial,
            true,
            true,
            &discovered
        ));
    }

    #[test]
    fn disappeared_initial_with_same_sandbox_still_running_rejects_cleanup() {
        let initial = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![make_fc(201, "sbox-123")]);

        assert!(!should_cleanup_disappeared_initial_orphan(
            &initial,
            true,
            true,
            &discovered
        ));
    }

    #[test]
    fn disappeared_initial_with_unidentified_firecracker_rejects_cleanup() {
        let initial = make_target(200, "sbox-123");
        let discovered = discovered_with_firecrackers(vec![FirecrackerProcessInfo {
            pid: 201,
            ppid: None,
            sandbox_id: "pid-201".into(),
            base_dir: None,
            identity: None,
        }]);

        assert!(!should_cleanup_disappeared_initial_orphan(
            &initial,
            true,
            true,
            &discovered
        ));
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

    #[test]
    fn orphan_identity_facts_match() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = process_stat(identity);
        let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

        assert!(orphan_identity_matches_facts(
            identity,
            &stat,
            true,
            Some(&cwd_info)
        ));
    }

    #[test]
    fn orphan_identity_rejects_changed_starttime() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = ProcessStat {
            state: 'S',
            ppid: 7,
            pgid: identity.pgid,
            starttime: identity.starttime + 1,
        };
        let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

        assert!(!orphan_identity_matches_facts(
            identity,
            &stat,
            true,
            Some(&cwd_info)
        ));
    }

    #[test]
    fn orphan_identity_rejects_changed_pgid() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = ProcessStat {
            state: 'S',
            ppid: 7,
            pgid: identity.pgid + 1,
            starttime: identity.starttime,
        };
        let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

        assert!(!orphan_identity_matches_facts(
            identity,
            &stat,
            true,
            Some(&cwd_info)
        ));
    }

    #[test]
    fn process_stat_identity_match_requires_stable_pgid_and_starttime() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let matching = process_stat(identity);
        let changed_starttime = ProcessStat {
            state: 'S',
            ppid: 7,
            pgid: identity.pgid,
            starttime: identity.starttime + 1,
        };
        let changed_pgid = ProcessStat {
            state: 'S',
            ppid: 7,
            pgid: identity.pgid + 1,
            starttime: identity.starttime,
        };
        let changed_ppid = ProcessStat {
            state: 'S',
            ppid: 9,
            pgid: identity.pgid,
            starttime: identity.starttime,
        };

        assert!(process_stat_matches_identity(identity, &matching));
        assert!(process_stat_matches_identity(identity, &changed_ppid));
        assert!(!process_stat_matches_identity(identity, &changed_starttime));
        assert!(!process_stat_matches_identity(identity, &changed_pgid));
    }

    #[test]
    fn orphan_identity_rejects_non_firecracker_cmdline() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = process_stat(identity);
        let cwd_info = ("sbox-123".to_string(), PathBuf::from("/data/r1"));

        assert!(!orphan_identity_matches_facts(
            identity,
            &stat,
            false,
            Some(&cwd_info)
        ));
    }

    #[test]
    fn orphan_identity_rejects_changed_workspace() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = process_stat(identity);
        let cwd_info = ("sbox-other".to_string(), PathBuf::from("/data/r1"));

        assert!(!orphan_identity_matches_facts(
            identity,
            &stat,
            true,
            Some(&cwd_info)
        ));
    }

    #[test]
    fn orphan_identity_rejects_missing_workspace_identity() {
        let mut target = make_target(200, "sbox-123");
        target.base_dir = None;
        target.identity.as_mut().unwrap().base_dir = None;
        let identity = target.identity.as_ref().unwrap();
        let stat = process_stat(identity);

        assert!(!orphan_identity_matches_facts(identity, &stat, true, None));
    }

    #[test]
    fn zombie_process_stat_is_already_exited() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let zombie = ProcessStat {
            state: 'Z',
            ppid: 7,
            pgid: identity.pgid,
            starttime: identity.starttime,
        };

        assert!(process_stat_matches_identity(identity, &zombie));
        assert!(!process::process_stat_is_live(&zombie));
    }

    #[test]
    fn dead_process_stat_is_already_exited() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let dead = ProcessStat {
            state: 'X',
            ppid: 7,
            pgid: identity.pgid,
            starttime: identity.starttime,
        };

        assert!(process_stat_matches_identity(identity, &dead));
        assert!(!process::process_stat_is_live(&dead));
    }

    #[test]
    fn orphan_exit_observation_distinguishes_live_and_terminal_states() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();

        assert_eq!(
            classify_orphan_exit_observation(
                identity,
                ProcessStatRead::Found(process_stat(identity)),
            ),
            OrphanExitObservation::Live
        );
        for state in ['Z', 'X', 'x'] {
            assert_eq!(
                classify_orphan_exit_observation(
                    identity,
                    ProcessStatRead::Found(process_stat_with_state(identity, state)),
                ),
                OrphanExitObservation::Terminated
            );
        }
        assert_eq!(
            classify_orphan_exit_observation(identity, ProcessStatRead::Missing),
            OrphanExitObservation::Terminated
        );
    }

    #[test]
    fn orphan_exit_observation_rejects_identity_changes() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let changed = ProcessStat {
            pgid: identity.pgid + 1,
            starttime: identity.starttime + 1,
            ..process_stat(identity)
        };

        assert_eq!(
            classify_orphan_exit_observation(identity, ProcessStatRead::Found(changed)),
            OrphanExitObservation::IdentityChanged {
                expected_pgid: identity.pgid,
                observed_pgid: identity.pgid + 1,
                expected_starttime: identity.starttime,
                observed_starttime: identity.starttime + 1,
            }
        );
    }

    #[test]
    fn orphan_exit_observation_rejects_unverifiable_reads() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();

        assert!(matches!(
            classify_orphan_exit_observation(
                identity,
                ProcessStatRead::Unreadable(std::io::Error::from(
                    std::io::ErrorKind::PermissionDenied,
                )),
            ),
            OrphanExitObservation::Unverifiable(_)
        ));
        assert_eq!(
            classify_orphan_exit_observation(identity, ProcessStatRead::Invalid),
            OrphanExitObservation::Unverifiable("process stat is invalid".into())
        );
    }

    #[tokio::test]
    async fn orphan_exit_wait_observes_delayed_termination() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let mut reads = VecDeque::from([
            ProcessStatRead::Found(process_stat(identity)),
            ProcessStatRead::Found(process_stat_with_state(identity, 'Z')),
        ]);

        let result = wait_for_orphan_exit_with(
            identity,
            Duration::from_secs(1),
            Duration::ZERO,
            move |_| std::future::ready(reads.pop_front().unwrap()),
        )
        .await;

        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn orphan_exit_wait_times_out_while_identity_is_live() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();

        let result = wait_for_orphan_exit_with(identity, Duration::ZERO, Duration::ZERO, |_| {
            std::future::ready(ProcessStatRead::Found(process_stat(identity)))
        })
        .await;

        assert_eq!(result, Err(OrphanExitFailure::TimedOut));
    }

    #[tokio::test]
    async fn orphan_exit_wait_fails_when_identity_changes() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let changed = ProcessStat {
            pgid: identity.pgid + 1,
            starttime: identity.starttime + 1,
            ..process_stat(identity)
        };

        let result =
            wait_for_orphan_exit_with(identity, Duration::from_secs(1), Duration::ZERO, |_| {
                std::future::ready(ProcessStatRead::Found(changed.clone()))
            })
            .await;

        let Err(failure) = result else {
            panic!("changed process identity should fail the exit wait");
        };
        assert_eq!(
            failure,
            OrphanExitFailure::IdentityChanged {
                expected_pgid: identity.pgid,
                observed_pgid: identity.pgid + 1,
                expected_starttime: identity.starttime,
                observed_starttime: identity.starttime + 1,
            }
        );
        assert_eq!(
            failure.to_string(),
            "process identity changed while waiting for termination \
             (PGID 1200 -> 1201, starttime 123456 -> 123457)"
        );
    }

    #[tokio::test]
    async fn orphan_exit_wait_recovers_from_transient_unverifiable_read() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let mut reads = VecDeque::from([ProcessStatRead::Invalid, ProcessStatRead::Missing]);

        let result = wait_for_orphan_exit_with(
            identity,
            Duration::from_secs(1),
            Duration::ZERO,
            move |_| std::future::ready(reads.pop_front().unwrap()),
        )
        .await;

        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn orphan_exit_wait_fails_when_observation_remains_unverifiable() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();

        let result = wait_for_orphan_exit_with(identity, Duration::ZERO, Duration::ZERO, |_| {
            std::future::ready(ProcessStatRead::Invalid)
        })
        .await;

        let Err(failure) = result else {
            panic!("unverifiable process state should fail at the exit deadline");
        };
        assert_eq!(
            failure,
            OrphanExitFailure::Unverifiable("process stat is invalid".into())
        );
        assert_eq!(
            failure.to_string(),
            "process termination could not be verified: process stat is invalid"
        );
    }

    #[tokio::test]
    async fn orphan_kill_validates_signals_and_waits_for_real_exit() {
        run_ignored_child_test(
            "cmd::kill::tests::orphan_kill_validates_signals_and_waits_for_real_exit_child",
            (ORPHAN_KILL_CHILD_ENV, "1"),
            &[],
            Duration::from_secs(30),
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "spawned by orphan_kill_validates_signals_and_waits_for_real_exit"]
    async fn orphan_kill_validates_signals_and_waits_for_real_exit_child() {
        if !ignored_child_test_env_guard_enabled((ORPHAN_KILL_CHILD_ENV, "1")) {
            return;
        }

        let base_dir = tempfile::tempdir().unwrap();
        let sandbox_id = "test-sandbox";
        let workspace = base_dir.path().join("workspaces").join(sandbox_id);
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let firecracker = base_dir.path().join("firecracker");
        std::os::unix::fs::symlink("/bin/sh", &firecracker).unwrap();

        let mut child = tokio::process::Command::new(&firecracker)
            .arg("-c")
            .arg("printf '%s\\n' \"$1\"; IFS= read -r _")
            .arg("vm0-orphan-kill-test")
            .arg(ORPHAN_KILL_READY_LINE)
            .current_dir(&workspace)
            .process_group(0)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stdout_lines = BufReader::new(stdout).lines();
        let ready_line = tokio::time::timeout(Duration::from_secs(5), stdout_lines.next_line())
            .await
            .expect("fake firecracker readiness timed out")
            .expect("read fake firecracker readiness")
            .expect("fake firecracker exited before readiness");
        assert_eq!(ready_line, ORPHAN_KILL_READY_LINE);

        let pid = child.id().unwrap();
        let ProcessStatRead::Found(stat) = process::read_process_stat_checked(pid).await else {
            panic!("spawned process stat should be readable");
        };
        let target = KillTarget {
            pid,
            ppid: None,
            run_id: None,
            sandbox_id: sandbox_id.into(),
            base_dir: Some(base_dir.path().to_path_buf()),
            identity: Some(FirecrackerProcessIdentity {
                pid,
                pgid: stat.pgid,
                starttime: stat.starttime,
                sandbox_id: sandbox_id.into(),
                base_dir: Some(base_dir.path().to_path_buf()),
            }),
        };

        let outcome = kill_orphan_process_group(&target).await;
        assert!(
            matches!(&outcome, KillOutcome::OrphanKilled(killed) if killed == &target),
            "unexpected orphan kill outcome: {outcome:?}"
        );

        let status = child.wait().await.unwrap();
        assert!(!status.success());
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
        assert_eq!(control.recorded_kill_ids(), vec!["sbox-123"]);
    }

    #[tokio::test]
    async fn managed_idle_target_is_refused() {
        let control = MockSandboxControl::new("/tmp/test");
        control.push_kill_remote_result(Ok(RemoteKillResult::RefusedIdle));
        let current = make_target(200, "sbox-123");

        let outcome = kill_current_target(current, false, &control).await;

        assert!(matches!(outcome, KillOutcome::RefusedManagedIdle));
        assert_eq!(control.recorded_kill_ids(), vec!["sbox-123"]);
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
        assert_eq!(control.recorded_kill_ids(), vec!["sbox-123"]);
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

    #[test]
    fn signal_process_group_rejects_zero_pgid() {
        assert_eq!(
            signal_process_group(1234, 0),
            ProcessGroupSignalResult::Failed
        );
    }

    #[test]
    fn signal_process_group_rejects_init_pgid() {
        assert_eq!(
            signal_process_group(1234, 1),
            ProcessGroupSignalResult::Failed
        );
    }

    #[test]
    fn signal_process_group_rejects_own_pgid() {
        let current_pgid = u32::try_from(nix::unistd::getpgrp().as_raw()).unwrap();

        assert_eq!(
            signal_process_group(1234, current_pgid),
            ProcessGroupSignalResult::Failed
        );
    }

    #[test]
    fn signal_process_group_reports_already_gone_for_missing_group() {
        let missing_pgid = i32::MAX as u32;

        assert_eq!(
            signal_process_group(1234, missing_pgid),
            ProcessGroupSignalResult::AlreadyGone
        );
    }

    #[tokio::test]
    async fn orphan_kill_nonexistent_pid_reports_gone_when_cleanup_is_safe() {
        // u32::MAX exceeds any valid PID — /proc/{pid}/stat won't exist
        let target = KillTarget {
            pid: u32::MAX,
            ppid: None,
            run_id: None,
            sandbox_id: "sbox-missing".into(),
            base_dir: Some(PathBuf::from("/data/r1")),
            identity: Some(FirecrackerProcessIdentity {
                pid: u32::MAX,
                pgid: 1234,
                starttime: 123456,
                sandbox_id: "sbox-missing".into(),
                base_dir: Some(PathBuf::from("/data/r1")),
            }),
        };

        assert!(matches!(
            kill_orphan_process_group(&target).await,
            KillOutcome::OrphanAlreadyExited(_)
        ));
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
