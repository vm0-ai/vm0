//! `runner local cancel` — cancel a job running on a local runner via file queue.
//!
//! Writes a `{run_id}.cancel` file into the group cancel directory. The local
//! runner's cancel watcher picks it up and triggers the corresponding
//! cancellation token.

use std::process::ExitCode;

use clap::Args;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue;
use crate::paths::HomePaths;

#[derive(Args)]
pub struct CancelArgs {
    /// Run ID (full UUID or prefix) of the job to cancel
    #[arg(long)]
    run: String,
    /// Runner group name
    #[arg(long)]
    group: String,
}

pub async fn run_cancel(args: CancelArgs) -> RunnerResult<ExitCode> {
    run_cancel_with_home(args, HomePaths::new()?).await
}

async fn run_cancel_with_home(args: CancelArgs, home: HomePaths) -> RunnerResult<ExitCode> {
    if args.run.is_empty() {
        return Err(RunnerError::Config("run_id must not be empty".into()));
    }
    crate::group::validate_or_err(&args.group)?;

    let group_dir = home.groups_dir().join(&args.group);

    if !group_dir.is_dir() {
        return Err(RunnerError::Config(format!(
            "group directory does not exist: {}",
            group_dir.display()
        )));
    }

    let run_id = resolve_run_id(&group_dir, &args.run)?;

    let cancel_dir = local_queue::cancels_dir(&group_dir);
    std::fs::create_dir_all(&cancel_dir)
        .map_err(|e| RunnerError::Internal(format!("create cancel dir: {e}")))?;
    let cancel_path = local_queue::cancel_path(&group_dir, run_id);
    std::fs::write(&cancel_path, b"")
        .map_err(|e| RunnerError::Internal(format!("write cancel file: {e}")))?;

    eprintln!("cancel request written for {run_id}");
    Ok(ExitCode::SUCCESS)
}

/// Resolve a (possibly prefix) run ID against group-wide `.claim` files.
/// Returns an error if the prefix is ambiguous or matches nothing.
fn resolve_run_id(group_dir: &std::path::Path, prefix: &str) -> RunnerResult<RunId> {
    // Try exact UUID parse first.
    if let Ok(id) = prefix.parse::<RunId>() {
        let claim = local_queue::claim_path(group_dir, id);
        if claim.exists() {
            return Ok(id);
        }
        return Err(RunnerError::Config(format!(
            "no claimed job found for {id}"
        )));
    }

    // Prefix match against .claim files.
    let claims_dir = local_queue::claims_dir(group_dir);
    let entries = match std::fs::read_dir(&claims_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(RunnerError::Config(format!(
                "no claimed job matches prefix '{prefix}'"
            )));
        }
        Err(e) => return Err(RunnerError::Config(format!("read claims dir: {e}"))),
    };

    let mut matches = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("claim") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.starts_with(prefix)
            && let Ok(id) = stem.parse::<RunId>()
        {
            matches.push(id);
        }
    }

    match matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "no claimed job matches prefix '{prefix}'"
        ))),
        [id] => Ok(*id),
        _ => {
            let n = matches.len();
            let ids: Vec<String> = matches.iter().map(|id| id.to_string()).collect();
            Err(RunnerError::Config(format!(
                "prefix '{prefix}' is ambiguous ({n} matches): {}",
                ids.join(", ")
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_exact_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id), b"").unwrap();

        let resolved = resolve_run_id(dir.path(), &id.to_string()).unwrap();
        assert_eq!(resolved, id);
    }

    #[test]
    fn resolve_prefix_match() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id), b"").unwrap();

        let prefix = &id.to_string()[..8];
        let resolved = resolve_run_id(dir.path(), prefix).unwrap();
        assert_eq!(resolved, id);
    }

    #[test]
    fn resolve_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_run_id(dir.path(), "deadbeef").unwrap_err();
        assert!(err.to_string().contains("no claimed job"), "got: {err}");
    }

    #[test]
    fn resolve_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = RunId::new_v4();
        let id2 = RunId::new_v4();
        std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id1), b"").unwrap();
        std::fs::write(local_queue::claim_path(dir.path(), id2), b"").unwrap();

        // Empty prefix matches every `.claim` file, so two files guarantee ambiguity.
        let err = resolve_run_id(dir.path(), "").unwrap_err();
        assert!(err.to_string().contains("ambiguous"), "got: {err}");
    }

    #[test]
    fn resolve_exact_uuid_no_claim() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        // No .claim file written.
        let err = resolve_run_id(dir.path(), &id.to_string()).unwrap_err();
        assert!(err.to_string().contains("no claimed job"), "got: {err}");
    }

    #[tokio::test]
    async fn run_cancel_writes_group_wide_cancel_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        std::fs::create_dir_all(local_queue::claims_dir(&group_dir)).unwrap();
        let run_id = RunId::new_v4();
        std::fs::write(local_queue::claim_path(&group_dir, run_id), b"").unwrap();

        let code = run_cancel_with_home(
            CancelArgs {
                run: run_id.to_string(),
                group: "test/group".into(),
            },
            home,
        )
        .await
        .unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        assert!(local_queue::cancel_path(&group_dir, run_id).exists());
    }
}
