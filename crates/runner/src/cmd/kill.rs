//! Kill a running sandbox and clean up resources.
//!
//! When the parent runner daemon is alive, killing the Firecracker process
//! group is sufficient — the runner detects the exit via `monitor_process` →
//! `crash_notify` and handles all cleanup (proxy, netns, workspace, status).
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

use std::process::ExitCode;

use clap::Args;
use sandbox::SandboxControl;
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::process::{self, FirecrackerProcessInfo};
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
    // Phase 1: Discover running processes
    let discovered = process::discover_all().await;
    let runner_pids: Vec<u32> = discovered.runners.iter().map(|r| r.pid).collect();

    // Phase 2: Resolve target — mode depends on which flag was passed.
    let target = if let Some(ref run_id) = args.run {
        let mappings = run_resolution::collect_active_run_mappings(&discovered.runners).await;
        resolve_by_run_id(run_id, &mappings, &discovered.firecrackers)?
    } else if let Some(ref sandbox_id) = args.sandbox {
        resolve_by_sandbox_id(sandbox_id, &discovered.firecrackers)?
    } else {
        return Err(RunnerError::Config(
            "one of --run or --sandbox is required".into(),
        ));
    };
    let is_orphan = process::is_orphan(target.pid, &runner_pids).await;

    // Phase 3: Confirm (unless --force)
    if !args.force {
        print_target_info(target, is_orphan);
        if !confirm().await {
            println!("Aborted.");
            return Ok(ExitCode::SUCCESS);
        }
    }

    // Phase 4: Kill process group
    let killed = kill_process_group(target.pid).await;
    if killed {
        println!("Killed sandbox {} (PID {})", target.sandbox_id, target.pid);
    } else {
        println!(
            "Failed to kill sandbox {} (PID {}) — process may have already exited",
            target.sandbox_id, target.pid
        );
    }

    // Phase 5: Cleanup based on orphan status
    if is_orphan {
        let results = cleanup_orphan(&target.sandbox_id, target.base_dir.as_deref(), control).await;
        if !results.is_empty() {
            println!("Orphan cleanup:");
            for (step, success) in &results {
                let icon = if *success { "ok" } else { "FAIL" };
                println!("  [{icon}] {step}");
            }
        }
    } else {
        let ppid_str = target.ppid.map_or("unknown".into(), |p| p.to_string());
        println!("Parent runner (PID {ppid_str}) will handle cleanup.");
    }

    info!(
        sandbox_id = %target.sandbox_id,
        pid = target.pid,
        orphan = is_orphan,
        killed,
        "kill command completed"
    );

    if killed {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::FAILURE)
    }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

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
    firecrackers
        .iter()
        .find(|fc| fc.sandbox_id == sandbox_id)
        .ok_or_else(|| {
            RunnerError::Config(format!(
                "run '{input}' maps to sandbox '{sandbox_id}' but no firecracker process for it"
            ))
        })
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

/// Kill the process group containing the given PID.
///
/// Reads the PGID from `/proc/{pid}/stat` and sends `SIGKILL` to the entire
/// group via `killpg`. This ensures intermediate processes in the spawn chain
/// (`sudo`, `ip netns exec`) are also terminated.
async fn kill_process_group(pid: u32) -> bool {
    // Read the actual PGID — the firecracker PID differs from the PGID
    // because .process_group(0) is set on the outer sudo command.
    let Some(pgid) = process::read_pgid(pid).await else {
        tracing::warn!(pid, "failed to read PGID from /proc");
        return false;
    };
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

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

async fn cleanup_orphan(
    sandbox_id: &str,
    base_dir: Option<&std::path::Path>,
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
async fn remove_dir_if_exists(path: &std::path::Path) -> bool {
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

fn print_target_info(fc: &FirecrackerProcessInfo, is_orphan: bool) {
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

    use super::*;

    fn make_fc(pid: u32, sandbox_id: &str) -> FirecrackerProcessInfo {
        FirecrackerProcessInfo {
            pid,
            ppid: None,
            sandbox_id: sandbox_id.into(),
            base_dir: Some(PathBuf::from("/data/r1")),
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

    #[tokio::test]
    async fn kill_process_group_nonexistent_pid() {
        // u32::MAX exceeds any valid PID — /proc/{pid}/stat won't exist
        assert!(!kill_process_group(u32::MAX).await);
    }

    // -----------------------------------------------------------------------
    // Orphan cleanup tests (using sandbox-mock)
    // -----------------------------------------------------------------------

    use sandbox_mock::MockSandboxControl;

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
