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

use clap::Args;
use sandbox::{RemoteKillResult, SandboxControl, SandboxControlError};
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::process::{
    self, DiscoveredProcesses, FirecrackerProcessIdentity, FirecrackerProcessInfo, ProcessStat,
};
use crate::run_resolution;

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
            println!(
                "Refused to kill sandbox {} (PID {}) - {error}",
                initial.target.sandbox_id, initial.target.pid
            );
            return Ok(ExitCode::FAILURE);
        }
    };
    let is_orphan = process::is_orphan(current.target.pid, &current.runner_pids).await;
    let outcome = kill_current_target(
        &args,
        &initial.target,
        current.target.clone(),
        is_orphan,
        control,
    )
    .await;
    report_kill_outcome(&initial.target, &current.target, &outcome, control).await;

    info!(
        sandbox_id = %current.target.sandbox_id,
        pid = current.target.pid,
        orphan = is_orphan,
        outcome = ?outcome,
        "kill command completed"
    );

    if outcome.is_success() {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::FAILURE)
    }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
struct KillTarget {
    pid: u32,
    ppid: Option<u32>,
    sandbox_id: String,
    base_dir: Option<PathBuf>,
    identity: Option<FirecrackerProcessIdentity>,
}

impl From<&FirecrackerProcessInfo> for KillTarget {
    fn from(process: &FirecrackerProcessInfo) -> Self {
        Self {
            pid: process.pid,
            ppid: process.ppid,
            sandbox_id: process.sandbox_id.clone(),
            base_dir: process.base_dir.clone(),
            identity: process.identity.clone(),
        }
    }
}

struct ResolvedKillTarget {
    target: KillTarget,
    runner_pids: Vec<u32>,
}

#[derive(Debug)]
enum KillOutcome {
    OwnerAccepted(RemoteKillResult),
    OrphanKilled,
    AlreadyExitedOrChanged,
    SignalFailed,
    RefusedManagedControlFailed(String),
    RefusedTargetChanged(String),
}

impl KillOutcome {
    fn is_success(&self) -> bool {
        matches!(
            self,
            KillOutcome::OwnerAccepted(_) | KillOutcome::OrphanKilled
        )
    }
}

async fn discover_and_resolve_target(args: &KillArgs) -> RunnerResult<ResolvedKillTarget> {
    let discovered = process::discover_all().await;
    let runner_pids: Vec<u32> = discovered.runners.iter().map(|r| r.pid).collect();
    let target = resolve_target(args, &discovered).await?;

    Ok(ResolvedKillTarget {
        target: target.into(),
        runner_pids,
    })
}

async fn resolve_target<'a>(
    args: &KillArgs,
    discovered: &'a DiscoveredProcesses,
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    if let Some(ref run_id) = args.run {
        let mappings = run_resolution::collect_active_run_mappings(&discovered.runners).await;
        return resolve_by_run_id(run_id, &mappings, &discovered.firecrackers);
    }

    if let Some(ref sandbox_id) = args.sandbox {
        return resolve_by_sandbox_id(sandbox_id, &discovered.firecrackers);
    }

    Err(RunnerError::Config(
        "one of --run or --sandbox is required".into(),
    ))
}

async fn rediscover_same_target(
    args: &KillArgs,
    initial: &KillTarget,
) -> Result<ResolvedKillTarget, String> {
    let current = discover_and_resolve_target(args)
        .await
        .map_err(|error| error.to_string())?;
    ensure_same_target_after_confirmation(args, initial, &current.target)?;
    Ok(current)
}

fn ensure_same_target_after_confirmation(
    args: &KillArgs,
    initial: &KillTarget,
    current: &KillTarget,
) -> Result<(), String> {
    if args.run.is_some() {
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

/// Resolve a `--run` prefix to a single Firecracker process.
///
/// Maps run_id → sandbox_id via the provided mappings, then locates the FC
/// by sandbox_id. The caller is responsible for collecting `mappings` via
/// [`run_resolution::collect_active_run_mappings`] so this function stays pure and
/// testable.
fn resolve_by_run_id<'a>(
    input: &str,
    mappings: &run_resolution::ActiveRunMappings,
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    let sandbox_id = run_resolution::resolve_run_to_sandbox(input, mappings)?;
    let fc_matches: Vec<&FirecrackerProcessInfo> = firecrackers
        .iter()
        .filter(|fc| fc.sandbox_id == sandbox_id)
        .collect();
    match fc_matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "run '{input}' maps to sandbox '{sandbox_id}' but no firecracker process for it"
        ))),
        [single] => Ok(single),
        _ => {
            let pids: Vec<String> = fc_matches.iter().map(|fc| fc.pid.to_string()).collect();
            Err(RunnerError::Config(format!(
                "run '{input}' maps to sandbox '{sandbox_id}' but multiple firecracker processes match it: PID {}",
                pids.join(", ")
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
    args: &KillArgs,
    initial: &KillTarget,
    current: KillTarget,
    is_orphan: bool,
    control: &dyn SandboxControl,
) -> KillOutcome {
    if is_orphan {
        return kill_orphan_process_group(initial).await;
    }

    match control.kill_remote(&current.sandbox_id).await {
        Ok(result) => KillOutcome::OwnerAccepted(result),
        Err(error) => retry_as_orphan_if_owner_disappeared(args, initial, error).await,
    }
}

async fn retry_as_orphan_if_owner_disappeared(
    args: &KillArgs,
    initial: &KillTarget,
    owner_error: SandboxControlError,
) -> KillOutcome {
    let refreshed = match rediscover_same_target(args, initial).await {
        Ok(refreshed) => refreshed,
        Err(error) => return KillOutcome::RefusedTargetChanged(error),
    };
    if !process::is_orphan(refreshed.target.pid, &refreshed.runner_pids).await {
        return KillOutcome::RefusedManagedControlFailed(owner_error.to_string());
    }

    kill_orphan_process_group(initial).await
}

async fn kill_orphan_process_group(target: &KillTarget) -> KillOutcome {
    let Some(pgid) = validated_orphan_pgid(target).await else {
        return KillOutcome::AlreadyExitedOrChanged;
    };

    if signal_process_group(target.pid, pgid) {
        KillOutcome::OrphanKilled
    } else {
        KillOutcome::SignalFailed
    }
}

async fn validated_orphan_pgid(target: &KillTarget) -> Option<u32> {
    let Some(identity) = &target.identity else {
        tracing::warn!(
            pid = target.pid,
            sandbox_id = %target.sandbox_id,
            "refusing orphan kill without process identity"
        );
        return None;
    };

    if identity.pid != target.pid {
        tracing::warn!(
            pid = target.pid,
            identity_pid = identity.pid,
            "refusing orphan kill with inconsistent process identity"
        );
        return None;
    }

    let Some(stat) = process::read_process_stat(target.pid).await else {
        tracing::warn!(
            pid = target.pid,
            "failed to read process stat before orphan kill"
        );
        return None;
    };
    let stat_matches = stat.pgid == identity.pgid && stat.starttime == identity.starttime;
    if !stat_matches {
        tracing::warn!(
            pid = target.pid,
            expected_pgid = identity.pgid,
            current_pgid = stat.pgid,
            expected_starttime = identity.starttime,
            current_starttime = stat.starttime,
            "refusing orphan kill after process identity changed"
        );
        return None;
    }

    let Some(cmdline) = process::read_cmdline(target.pid).await else {
        tracing::warn!(
            pid = target.pid,
            "failed to read cmdline before orphan kill"
        );
        return None;
    };
    if !process::is_firecracker_cmdline(&cmdline) {
        tracing::warn!(
            pid = target.pid,
            "refusing orphan kill for non-firecracker cmdline"
        );
        return None;
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
        return None;
    }

    Some(identity.pgid)
}

fn orphan_identity_matches_facts(
    identity: &FirecrackerProcessIdentity,
    stat: &ProcessStat,
    is_firecracker_cmdline: bool,
    cwd_info: Option<&(String, PathBuf)>,
) -> bool {
    stat.pgid == identity.pgid
        && stat.starttime == identity.starttime
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
        (Some(_), None) => false,
        (None, Some(_)) => false,
        (None, None) => true,
    }
}

/// Send `SIGKILL` to a validated process group.
fn signal_process_group(pid: u32, pgid: u32) -> bool {
    if pgid == 0 {
        tracing::warn!(pid, "refusing to signal process group 0");
        return false;
    }

    let Ok(pgid_i32) = i32::try_from(pgid) else {
        return false;
    };

    match nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pgid_i32),
        nix::sys::signal::Signal::SIGKILL,
    ) {
        Ok(()) => {
            info!(pid, pgid = pgid_i32, "killed process group");
            true
        }
        Err(e) => {
            tracing::warn!(pid, pgid = pgid_i32, error = %e, "failed to kill process group");
            false
        }
    }
}

async fn report_kill_outcome(
    initial: &KillTarget,
    current: &KillTarget,
    outcome: &KillOutcome,
    control: &dyn SandboxControl,
) {
    match outcome {
        KillOutcome::OwnerAccepted(RemoteKillResult::Accepted) => {
            println!(
                "Owning runner accepted kill for sandbox {} (PID {}).",
                current.sandbox_id, current.pid
            );
            println!("Owning runner will handle cleanup.");
        }
        KillOutcome::OwnerAccepted(RemoteKillResult::AlreadyStopped) => {
            println!(
                "Sandbox {} is already stopping or stopped.",
                current.sandbox_id
            );
            println!("Owning runner will handle cleanup.");
        }
        KillOutcome::OrphanKilled => {
            println!(
                "Killed orphan sandbox {} (PID {})",
                initial.sandbox_id, initial.pid
            );
            if initial.base_dir.is_some() {
                let results =
                    cleanup_orphan(&initial.sandbox_id, initial.base_dir.as_deref(), control).await;
                print_cleanup_results(&results);
            } else {
                println!(
                    "Skipped orphan cleanup because sandbox workspace identity is unavailable."
                );
            }
        }
        KillOutcome::AlreadyExitedOrChanged => {
            println!(
                "Refused to kill sandbox {} (PID {}) - process already exited or changed identity",
                initial.sandbox_id, initial.pid
            );
        }
        KillOutcome::SignalFailed => {
            println!(
                "Failed to kill sandbox {} (PID {})",
                initial.sandbox_id, initial.pid
            );
        }
        KillOutcome::RefusedManagedControlFailed(error) => {
            println!(
                "Refused direct kill for managed sandbox {} (PID {}) - owning runner control failed: {error}",
                current.sandbox_id, current.pid
            );
        }
        KillOutcome::RefusedTargetChanged(error) => {
            println!(
                "Refused to kill sandbox {} (PID {}) - {error}",
                initial.sandbox_id, initial.pid
            );
        }
    }
}

fn print_cleanup_results(results: &[(String, bool)]) {
    if results.is_empty() {
        return;
    }

    println!("Orphan cleanup:");
    for (step, success) in results {
        let icon = if *success { "ok" } else { "FAIL" };
        println!("  [{icon}] {step}");
    }
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

async fn cleanup_orphan(
    sandbox_id: &str,
    base_dir: Option<&Path>,
    control: &dyn SandboxControl,
) -> Vec<(String, bool)> {
    let mut results = Vec::new();

    // Workspace dir
    if let Some(bd) = base_dir {
        let workspace = bd.join("workspaces").join(sandbox_id);
        let label = format!("Workspace: {}", workspace.display());
        let success = remove_dir_if_exists(&workspace).await;
        results.push((label, success));
    }

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
    use std::path::PathBuf;

    use sandbox_mock::MockSandboxControl;

    use super::*;

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
        let initial = make_target(200, "sbox-old");
        let current = make_target(201, "sbox-new");

        let error = ensure_same_target_after_confirmation(&args, &initial, &current).unwrap_err();

        assert!(error.contains("run target changed"), "{error}");
        assert!(error.contains("sbox-old"), "{error}");
        assert!(error.contains("sbox-new"), "{error}");
    }

    #[test]
    fn orphan_identity_facts_match() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = ProcessStat {
            pgid: identity.pgid,
            starttime: identity.starttime,
        };
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
    fn orphan_identity_rejects_non_firecracker_cmdline() {
        let target = make_target(200, "sbox-123");
        let identity = target.identity.as_ref().unwrap();
        let stat = ProcessStat {
            pgid: identity.pgid,
            starttime: identity.starttime,
        };
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
        let stat = ProcessStat {
            pgid: identity.pgid,
            starttime: identity.starttime,
        };
        let cwd_info = ("sbox-other".to_string(), PathBuf::from("/data/r1"));

        assert!(!orphan_identity_matches_facts(
            identity,
            &stat,
            true,
            Some(&cwd_info)
        ));
    }

    #[tokio::test]
    async fn managed_target_requests_owner_control() {
        let control = MockSandboxControl::new("/tmp/test");
        let initial = make_target(200, "sbox-123");
        let current = initial.clone();
        let args = KillArgs {
            run: None,
            sandbox: Some("sbox-123".into()),
            force: true,
        };

        let outcome = kill_current_target(&args, &initial, current, false, &control).await;

        assert!(matches!(
            outcome,
            KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
        ));
        assert_eq!(control.recorded_kill_ids(), vec!["sbox-123"]);
    }

    #[test]
    fn signal_process_group_rejects_zero_pgid() {
        assert!(!signal_process_group(1234, 0));
    }

    #[tokio::test]
    async fn orphan_kill_nonexistent_pid_fails_closed() {
        // u32::MAX exceeds any valid PID — /proc/{pid}/stat won't exist
        let target = KillTarget {
            pid: u32::MAX,
            ppid: None,
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
            KillOutcome::AlreadyExitedOrChanged
        ));
    }

    // -----------------------------------------------------------------------
    // Orphan cleanup tests (using sandbox-mock)
    // -----------------------------------------------------------------------

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

        let results = cleanup_orphan("sbox-123", Some(base), &control).await;

        assert_eq!(results.len(), 2);
        assert!(results[0].1, "workspace cleanup should succeed");
        assert!(results[1].1, "socket cleanup should succeed");
        assert!(!workspace.exists());
        assert!(!sock_dir.exists());
    }

    #[tokio::test]
    async fn cleanup_orphan_succeeds_when_dirs_missing() {
        let control = MockSandboxControl::new("/tmp/nonexistent-base");
        let results = cleanup_orphan(
            "sbox-456",
            Some(std::path::Path::new("/tmp/no-such-dir")),
            &control,
        )
        .await;

        // Both should "succeed" — NotFound is treated as success
        assert_eq!(results.len(), 2);
        assert!(results[0].1);
        assert!(results[1].1);
    }

    #[tokio::test]
    async fn cleanup_orphan_no_base_dir() {
        let control = MockSandboxControl::new("/tmp/test");
        let results = cleanup_orphan("sbox-789", None, &control).await;

        // Only socket dir cleanup, no workspace
        assert_eq!(results.len(), 1);
        assert!(results[0].0.contains("Socket dir"));
    }
}
