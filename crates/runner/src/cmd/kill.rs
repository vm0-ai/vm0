//! Kill a running sandbox and clean up resources.
//!
//! When the parent runner daemon is alive, killing the Firecracker process
//! group is sufficient — the runner detects the exit via `monitor_process` →
//! `crash_notify` and handles all cleanup (proxy, netns, workspace, status).
//!
//! Manual cleanup (workspace + socket dir) is only performed for orphan
//! processes whose parent runner has already died.

use std::process::ExitCode;

use clap::Args;
use sandbox_fc::RuntimePaths;
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::process::{self, FirecrackerProcessInfo};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

#[derive(Args)]
pub struct KillArgs {
    /// Run ID (full UUID or unique prefix)
    run_id: String,

    /// Skip confirmation prompt
    #[arg(long, short)]
    force: bool,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run_kill(args: KillArgs) -> RunnerResult<ExitCode> {
    // Phase 1: Discover running processes
    let discovered = process::discover_all().await;
    let runner_pids: Vec<u32> = discovered.runners.iter().map(|r| r.pid).collect();

    // Phase 2: Resolve target
    let target = resolve_target(&args.run_id, &discovered.firecrackers)?;
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
        println!("Killed sandbox {} (PID {})", target.run_id, target.pid);
    } else {
        println!(
            "Failed to kill sandbox {} (PID {}) — process may have already exited",
            target.run_id, target.pid
        );
    }

    // Phase 5: Cleanup based on orphan status
    if is_orphan {
        let results = cleanup_orphan(&target.run_id, target.base_dir.as_deref()).await;
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
        run_id = %target.run_id,
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

fn resolve_target<'a>(
    input: &str,
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    if input.is_empty() {
        return Err(RunnerError::Config("run_id must not be empty".into()));
    }

    let matches: Vec<&FirecrackerProcessInfo> = firecrackers
        .iter()
        .filter(|fc| fc.run_id.starts_with(input))
        .collect();

    match matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "no running sandbox matches '{input}'"
        ))),
        [single] => Ok(single),
        _ => {
            let ids: Vec<&str> = matches.iter().map(|fc| fc.run_id.as_str()).collect();
            Err(RunnerError::Config(format!(
                "ambiguous prefix '{input}', matches: {}",
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

async fn cleanup_orphan(run_id: &str, base_dir: Option<&std::path::Path>) -> Vec<(String, bool)> {
    let mut results = Vec::new();

    // Workspace dir
    if let Some(bd) = base_dir {
        let workspace = bd.join("workspaces").join(run_id);
        let label = format!("Workspace: {}", workspace.display());
        let success = remove_dir_if_exists(&workspace).await;
        results.push((label, success));
    }

    // Socket dir
    let sock_dir = RuntimePaths::new().sock_dir(run_id);
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
    println!("Kill sandbox {}?", fc.run_id);
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

    fn make_fc(pid: u32, run_id: &str) -> FirecrackerProcessInfo {
        FirecrackerProcessInfo {
            pid,
            ppid: None,
            run_id: run_id.into(),
            base_dir: Some(PathBuf::from("/data/r1")),
        }
    }

    #[test]
    fn resolve_target_full_uuid() {
        let fcs = vec![make_fc(100, "550e8400-e29b-41d4-a716-446655440000")];
        let result = resolve_target("550e8400-e29b-41d4-a716-446655440000", &fcs);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().pid, 100);
    }

    #[test]
    fn resolve_target_prefix_match() {
        let fcs = vec![make_fc(100, "550e8400-e29b-41d4-a716-446655440000")];
        let result = resolve_target("550e8400", &fcs);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().pid, 100);
    }

    #[test]
    fn resolve_target_ambiguous() {
        let fcs = vec![
            make_fc(100, "550e8400-aaaa-0000-0000-000000000000"),
            make_fc(101, "550e8400-bbbb-0000-0000-000000000000"),
        ];
        let result = resolve_target("550e8400", &fcs);
        let Err(e) = result else {
            panic!("expected error");
        };
        let msg = e.to_string();
        assert!(msg.contains("ambiguous"), "error: {msg}");
    }

    #[test]
    fn resolve_target_no_match() {
        let fcs = vec![make_fc(100, "550e8400-e29b-41d4-a716-446655440000")];
        let result = resolve_target("deadbeef", &fcs);
        let Err(e) = result else {
            panic!("expected error");
        };
        let msg = e.to_string();
        assert!(msg.contains("no running sandbox"), "error: {msg}");
    }

    #[tokio::test]
    async fn kill_process_group_nonexistent_pid() {
        // u32::MAX exceeds any valid PID — /proc/{pid}/stat won't exist
        assert!(!kill_process_group(u32::MAX).await);
    }

    #[test]
    fn resolve_target_empty_input() {
        let fcs = vec![make_fc(100, "550e8400-e29b-41d4-a716-446655440000")];
        let result = resolve_target("", &fcs);
        let Err(e) = result else {
            panic!("expected error");
        };
        let msg = e.to_string();
        assert!(msg.contains("must not be empty"), "error: {msg}");
    }
}
