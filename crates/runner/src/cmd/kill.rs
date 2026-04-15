//! Kill a running sandbox and clean up resources.
//!
//! When the parent runner daemon is alive, killing the Firecracker process
//! group is sufficient — the runner detects the exit via `monitor_process` →
//! `crash_notify` and handles all cleanup (proxy, netns, workspace, status).
//!
//! Manual cleanup (workspace + socket dir) is only performed for orphan
//! processes whose parent runner has already died.
//!
//! Resolution: user-facing input is a `run_id` (what API/dashboard reports).
//! We consult each live runner's `status.json` to translate `run_id` prefix
//! into the internal `sandbox_id` that identifies the Firecracker VM, then
//! locate the FC by `sandbox_id`. For orphan FCs whose parent runner is
//! gone (and therefore no `status.json` reachable), we fall back to direct
//! `sandbox_id` prefix matching.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Args;
use sandbox::SandboxControl;
use serde::Deserialize;
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::process::{self, FirecrackerProcessInfo, RunnerProcessInfo};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

#[derive(Args)]
pub struct KillArgs {
    /// Run ID (full UUID or unique prefix). For orphan sandboxes whose
    /// parent runner has already died, a sandbox_id prefix is also accepted.
    run_id: String,

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

    // Phase 2: Resolve target — via status.json run_id lookup, then fallback.
    let target =
        resolve_target(&args.run_id, &discovered.runners, &discovered.firecrackers).await?;
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

/// Resolve user input to a single Firecracker process.
///
/// Uses each runner's `status.json` to map a `run_id` prefix to the matching
/// `sandbox_id`, then locates the FC. Falls back to direct `sandbox_id`
/// prefix matching when the user's input doesn't match any active run —
/// this covers orphan FCs whose parent runner is no longer running.
async fn resolve_target<'a>(
    input: &str,
    runners: &[RunnerProcessInfo],
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    let mut status_entries: Vec<(String, String)> = Vec::new();
    for runner in runners {
        let Some(base_dir) = load_base_dir(&runner.config_path).await else {
            continue;
        };
        if let Some(entries) = read_active_runs(&base_dir).await {
            status_entries.extend(entries);
        }
    }
    resolve_target_core(input, &status_entries, firecrackers)
}

/// Pure resolution core — separated from I/O so it can be unit tested.
///
/// `status_entries` is the union of `(run_id, sandbox_id)` tuples read from
/// every reachable runner's `status.json`.
fn resolve_target_core<'a>(
    input: &str,
    status_entries: &[(String, String)],
    firecrackers: &'a [FirecrackerProcessInfo],
) -> RunnerResult<&'a FirecrackerProcessInfo> {
    if input.is_empty() {
        return Err(RunnerError::Config("run_id must not be empty".into()));
    }

    // Step 1: match input as a run_id prefix via status.json.
    //
    // Dedup after filtering: two runner processes can share a config_path
    // (rolling-restart transient, symlinked base_dirs) or resolve to the
    // same status.json, causing identical entries to appear twice. Without
    // dedup, a unique prefix would wrongly trigger an ambiguity error.
    let mut matching: Vec<&(String, String)> = status_entries
        .iter()
        .filter(|(rid, _)| rid.starts_with(input))
        .collect();
    matching.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    matching.dedup();

    match matching.as_slice() {
        [(_, sandbox_id)] => firecrackers
            .iter()
            .find(|fc| fc.sandbox_id == *sandbox_id)
            .ok_or_else(|| {
                RunnerError::Config(format!(
                    "run '{input}' maps to sandbox '{sandbox_id}' but no firecracker process for it"
                ))
            }),
        [] => {
            // Step 2 fallback: orphan path. The parent runner may be gone,
            // so status.json is unreadable. Match input directly against
            // firecracker sandbox_ids.
            let fc_matches: Vec<&FirecrackerProcessInfo> = firecrackers
                .iter()
                .filter(|fc| fc.sandbox_id.starts_with(input))
                .collect();
            match fc_matches.as_slice() {
                [] => Err(RunnerError::Config(format!(
                    "no active run or running sandbox matches '{input}'. Did the job already complete?"
                ))),
                [single] => Ok(single),
                _ => {
                    let ids: Vec<&str> =
                        fc_matches.iter().map(|fc| fc.sandbox_id.as_str()).collect();
                    Err(RunnerError::Config(format!(
                        "ambiguous sandbox prefix '{input}', matches: {}",
                        ids.join(", ")
                    )))
                }
            }
        }
        _ => {
            let lines: Vec<String> = matching
                .iter()
                .map(|(rid, sid)| format!("run={rid} sandbox={sid}"))
                .collect();
            Err(RunnerError::Config(format!(
                "ambiguous prefix '{input}', matches: [{}]",
                lines.join(", ")
            )))
        }
    }
}

/// Load only the `base_dir` field from a runner config (best-effort).
///
/// Read / parse failures log at `warn` level and return `None` so a single
/// broken runner config doesn't stop resolution for the rest.
async fn load_base_dir(config_path: &Path) -> Option<PathBuf> {
    #[derive(Deserialize)]
    struct ConfigShape {
        base_dir: PathBuf,
    }
    let content = match tokio::fs::read_to_string(config_path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %config_path.display(), error = %e, "skipping runner: cannot read config");
            return None;
        }
    };
    let shape: ConfigShape = match serde_yaml_ng::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %config_path.display(), error = %e, "skipping runner: cannot parse config");
            return None;
        }
    };
    // Resolve relative base_dir against the config file's directory.
    if shape.base_dir.is_absolute() {
        Some(shape.base_dir)
    } else {
        config_path.parent().map(|p| p.join(&shape.base_dir))
    }
}

/// Read `{base_dir}/status.json` and extract `(run_id, sandbox_id)` for
/// every active run. Returns `None` if the file is missing or unparseable
/// (logs at `warn` level so the operator sees the miss immediately).
async fn read_active_runs(base_dir: &Path) -> Option<Vec<(String, String)>> {
    #[derive(Deserialize)]
    struct StatusShape {
        active_runs: Vec<ActiveRunShape>,
    }
    #[derive(Deserialize)]
    struct ActiveRunShape {
        run_id: String,
        sandbox_id: String,
    }
    let path = base_dir.join("status.json");
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "skipping runner: cannot read status.json");
            return None;
        }
    };
    let shape: StatusShape = match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "skipping runner: cannot parse status.json");
            return None;
        }
    };
    Some(
        shape
            .active_runs
            .into_iter()
            .map(|r| (r.run_id, r.sandbox_id))
            .collect(),
    )
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

    #[test]
    fn resolve_target_run_id_prefix_via_status_json() {
        // User gives a run_id prefix; status.json maps it to a sandbox_id
        // that differs (the reuse case). We should locate the FC by sandbox_id.
        let status = vec![(
            "550e8400-run-1111-2222-aaaaaaaaaaaa".into(),
            "sbox-9999".into(),
        )];
        let fcs = vec![make_fc(100, "sbox-9999")];
        let result = resolve_target_core("550e8400", &status, &fcs);
        assert!(result.is_ok(), "{:?}", result.err().map(|e| e.to_string()));
        assert_eq!(result.unwrap().pid, 100);
    }

    #[test]
    fn resolve_target_orphan_fallback_uses_sandbox_id() {
        // No active runs (parent runner dead). User gives sandbox_id prefix.
        let status: Vec<(String, String)> = vec![];
        let fcs = vec![make_fc(200, "orphan-sandbox-id-123")];
        let result = resolve_target_core("orphan-sandbox", &status, &fcs);
        assert!(result.is_ok(), "{:?}", result.err().map(|e| e.to_string()));
        assert_eq!(result.unwrap().pid, 200);
    }

    #[test]
    fn resolve_target_orphan_ambiguous_prefix() {
        // Orphan fallback with a prefix matching two sandboxes.
        let status: Vec<(String, String)> = vec![];
        let fcs = vec![
            make_fc(400, "orphan-aaa-111"),
            make_fc(401, "orphan-aaa-222"),
        ];
        let Err(e) = resolve_target_core("orphan-aaa", &status, &fcs) else {
            panic!("expected ambiguity error");
        };
        let msg = e.to_string();
        assert!(msg.contains("ambiguous sandbox prefix"), "{msg}");
        assert!(msg.contains("orphan-aaa-111"), "{msg}");
        assert!(msg.contains("orphan-aaa-222"), "{msg}");
    }

    #[test]
    fn resolve_target_ambiguous_prefix_lists_both_ids() {
        // Two runs share a run_id prefix — error message must include both
        // run_id and sandbox_id for each match so the user can disambiguate.
        let status = vec![
            ("abc-111".into(), "sbox-A".into()),
            ("abc-222".into(), "sbox-B".into()),
        ];
        let fcs = vec![make_fc(300, "sbox-A"), make_fc(301, "sbox-B")];
        let Err(e) = resolve_target_core("abc", &status, &fcs) else {
            panic!("expected ambiguity error");
        };
        let msg = e.to_string();
        assert!(msg.contains("ambiguous"), "{msg}");
        assert!(msg.contains("abc-111"), "{msg}");
        assert!(msg.contains("abc-222"), "{msg}");
        assert!(msg.contains("sbox-A"), "{msg}");
        assert!(msg.contains("sbox-B"), "{msg}");
    }

    #[test]
    fn resolve_target_full_run_id() {
        let status = vec![(
            "550e8400-e29b-41d4-a716-446655440000".into(),
            "sbox-full".into(),
        )];
        let fcs = vec![make_fc(100, "sbox-full")];
        let result = resolve_target_core("550e8400-e29b-41d4-a716-446655440000", &status, &fcs);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().pid, 100);
    }

    #[test]
    fn resolve_target_no_match() {
        let status = vec![("abc-111".into(), "sbox-A".into())];
        let fcs = vec![make_fc(100, "sbox-A")];
        let Err(e) = resolve_target_core("deadbeef", &status, &fcs) else {
            panic!("expected error");
        };
        let msg = e.to_string();
        assert!(
            msg.contains("no active run") || msg.contains("no running sandbox"),
            "{msg}"
        );
    }

    #[test]
    fn resolve_target_empty_input() {
        let status: Vec<(String, String)> = vec![];
        let fcs = vec![make_fc(100, "sbox-A")];
        let Err(e) = resolve_target_core("", &status, &fcs) else {
            panic!("expected error");
        };
        let msg = e.to_string();
        assert!(msg.contains("must not be empty"), "{msg}");
    }

    #[test]
    fn resolve_target_empty_list() {
        let status: Vec<(String, String)> = vec![];
        let fcs: Vec<FirecrackerProcessInfo> = vec![];
        let result = resolve_target_core("abc", &status, &fcs);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_target_mapped_sandbox_not_running() {
        // status.json says run-X maps to sandbox-gone, but FC process is gone.
        // Report the mapping so the user can understand what happened.
        let status = vec![("run-x-1".into(), "sandbox-gone".into())];
        let fcs: Vec<FirecrackerProcessInfo> = vec![];
        let Err(e) = resolve_target_core("run-x", &status, &fcs) else {
            panic!("expected error");
        };
        let msg = e.to_string();
        assert!(msg.contains("sandbox-gone"), "{msg}");
    }

    #[test]
    fn resolve_target_aggregates_across_runners() {
        // Entries from two different runners' status.json files are merged
        // into status_entries. Prefix matching still resolves unambiguously
        // when the prefix only hits one runner's runs.
        let status = vec![
            // From runner-1
            ("aaa-111".into(), "sbox-A".into()),
            // From runner-2
            ("bbb-222".into(), "sbox-B".into()),
        ];
        let fcs = vec![
            make_fc(100, "sbox-A"),
            FirecrackerProcessInfo {
                pid: 101,
                ppid: None,
                sandbox_id: "sbox-B".into(),
                base_dir: Some(PathBuf::from("/data/r2")),
            },
        ];
        let result = resolve_target_core("aaa", &status, &fcs);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().pid, 100);

        let result = resolve_target_core("bbb", &status, &fcs);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().pid, 101);
    }

    #[test]
    fn resolve_target_dedups_duplicate_status_entries() {
        // Two runners sharing the same config_path (or a symlinked base_dir)
        // cause us to read the same status.json twice. Without dedup, a
        // unique prefix would wrongly hit the ambiguity branch.
        let status = vec![
            ("R1".into(), "S1".into()),
            ("R1".into(), "S1".into()), // exact duplicate
        ];
        let fcs = vec![make_fc(100, "S1")];
        let result = resolve_target_core("R1", &status, &fcs);
        assert!(
            result.is_ok(),
            "duplicate entries must be deduped, got: {:?}",
            result.err().map(|e| e.to_string())
        );
        assert_eq!(result.unwrap().pid, 100);
    }

    #[test]
    fn resolve_target_true_duplicate_not_confused_with_ambiguous() {
        // Prefix "R" matches two distinct runs: still ambiguous (correct).
        // But identical entries for the same run don't contribute extra.
        let status = vec![
            ("R1".into(), "S1".into()),
            ("R1".into(), "S1".into()), // dedup this
            ("R2".into(), "S2".into()),
        ];
        let fcs = vec![make_fc(100, "S1"), make_fc(101, "S2")];
        let Err(e) = resolve_target_core("R", &status, &fcs) else {
            panic!("expected ambiguity for R1 vs R2");
        };
        let msg = e.to_string();
        // Exactly one line per distinct entry — R1 should not repeat.
        let r1_count = msg.matches("R1").count();
        assert_eq!(r1_count, 1, "R1 should appear once after dedup: {msg}");
        assert!(msg.contains("R2"), "{msg}");
    }

    #[test]
    fn resolve_target_active_wins_over_orphan_fallback() {
        // If input matches via status.json, we take that path even if a
        // sandbox_id in the orphan list shares the same prefix.
        let status = vec![("aaa-run-1".into(), "sbox-tracked".into())];
        let fcs = vec![
            make_fc(100, "sbox-tracked"),
            make_fc(101, "aaa-unrelated-sandbox"), // looks like a prefix match
        ];
        let result = resolve_target_core("aaa", &status, &fcs);
        assert!(result.is_ok());
        // Should resolve via status-path to the tracked sandbox, not the
        // orphan-path match on "aaa-unrelated-sandbox".
        assert_eq!(result.unwrap().pid, 100);
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
