//! `runner local cancel` — cancel a job running on a local runner via file queue.
//!
//! Writes a `{run_id}.cancel` file into the group directory. The runner's
//! `LocalProvider` picks it up on its next poll and triggers the corresponding
//! cancellation token.

use std::process::ExitCode;

use clap::Args;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
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
    if args.run.is_empty() {
        return Err(RunnerError::Config("run_id must not be empty".into()));
    }
    crate::group::validate_or_err(&args.group)?;

    let home = HomePaths::new()?;
    let group_dir = home.groups_dir().join(&args.group);

    if !group_dir.is_dir() {
        return Err(RunnerError::Config(format!(
            "group directory does not exist: {}",
            group_dir.display()
        )));
    }

    let run_id = resolve_run_id(&group_dir, &args.run)?;

    let cancel_path = group_dir.join(format!("{run_id}.cancel"));
    std::fs::write(&cancel_path, b"")
        .map_err(|e| RunnerError::Internal(format!("write cancel file: {e}")))?;

    eprintln!("cancel request written for {run_id}");
    Ok(ExitCode::SUCCESS)
}

/// Resolve a (possibly prefix) run ID against `.claim` files in the group
/// directory.  Returns an error if the prefix is ambiguous or matches nothing.
fn resolve_run_id(group_dir: &std::path::Path, prefix: &str) -> RunnerResult<RunId> {
    // Try exact UUID parse first.
    if let Ok(id) = prefix.parse::<RunId>() {
        let claim = group_dir.join(format!("{id}.claim"));
        if claim.exists() {
            return Ok(id);
        }
        return Err(RunnerError::Config(format!(
            "no claimed job found for {id}"
        )));
    }

    // Prefix match against .claim files.
    let entries = std::fs::read_dir(group_dir)
        .map_err(|e| RunnerError::Config(format!("read group dir: {e}")))?;

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
        std::fs::write(dir.path().join(format!("{id}.claim")), b"").unwrap();

        let resolved = resolve_run_id(dir.path(), &id.to_string()).unwrap();
        assert_eq!(resolved, id);
    }

    #[test]
    fn resolve_prefix_match() {
        let dir = tempfile::tempdir().unwrap();
        let id = RunId::new_v4();
        std::fs::write(dir.path().join(format!("{id}.claim")), b"").unwrap();

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
        std::fs::write(dir.path().join(format!("{id1}.claim")), b"").unwrap();
        std::fs::write(dir.path().join(format!("{id2}.claim")), b"").unwrap();

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
}
