//! `runner local input` — send active input to a running local job via file queue.

use std::process::ExitCode;

use clap::Args;

use crate::active_input::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, identified_active_input_payload_len,
};
use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{self, ActiveInputEntry};
use crate::paths::HomePaths;

#[derive(Args)]
pub struct InputArgs {
    /// Run ID of the claimed local job
    #[arg(long)]
    run: RunId,
    /// Runner group name
    #[arg(long)]
    group: String,
    /// Monotonically increasing active-input sequence number
    #[arg(long)]
    sequence: u64,
    /// Active-input text
    #[arg(long)]
    text: String,
}

pub fn run_input(args: InputArgs) -> RunnerResult<ExitCode> {
    run_input_with_home(args, HomePaths::new()?)
}

fn run_input_with_home(args: InputArgs, home: HomePaths) -> RunnerResult<ExitCode> {
    crate::group::validate_or_err(&args.group)?;
    if args.sequence == 0 {
        return Err(RunnerError::Config(
            "active-input sequence must be greater than zero".into(),
        ));
    }
    if args.text.is_empty() {
        return Err(RunnerError::Config(
            "active-input text must not be empty".into(),
        ));
    }
    let payload_len = identified_active_input_payload_len(&args.text).map_err(|e| {
        RunnerError::Internal(format!(
            "serialize active-input payload for validation: {e}"
        ))
    })?;
    if payload_len > ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES {
        return Err(RunnerError::Config(format!(
            "active-input serialized payload must be <= {ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES} bytes"
        )));
    }

    let group_dir = home.groups_dir().join(&args.group);
    if !group_dir.is_dir() {
        return Err(RunnerError::Config(format!(
            "group directory does not exist: {}",
            group_dir.display()
        )));
    }
    local_queue::validate_group_dir(&group_dir).map_err(|e| {
        RunnerError::Config(format!(
            "invalid group directory {}: {e}",
            group_dir.display()
        ))
    })?;

    let claim_path = local_queue::claim_path(&group_dir, args.run);
    let claimed = local_queue::marker_file_exists(&claim_path, "local claim marker")
        .map_err(|e| RunnerError::Config(e.to_string()))?;
    if !claimed {
        return Err(RunnerError::Config(format!(
            "no claimed local job found for {}",
            args.run
        )));
    }

    local_queue::LocalQueue::new(group_dir)
        .write_active_input_sync(&ActiveInputEntry {
            run_id: args.run,
            sequence: args.sequence,
            text: args.text,
        })
        .map_err(|e| RunnerError::Internal(format!("write local active input: {e}")))?;

    eprintln!("active input {} written for {}", args.sequence, args.run);
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn writes_active_input_for_claimed_job() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        let run_id = RunId::new_v4();
        local_queue::ensure_claims_dir(&group_dir).unwrap();
        local_queue::write_private_marker(
            &local_queue::claim_path(&group_dir, run_id),
            "test claim marker",
        )
        .unwrap();

        let code = run_input_with_home(
            InputArgs {
                run: run_id,
                group: "test/group".into(),
                sequence: 5,
                text: "pressure-finish".into(),
            },
            home,
        )
        .unwrap();

        assert_eq!(code, ExitCode::SUCCESS);
        let entries = local_queue::LocalQueue::new(group_dir.clone())
            .read_active_input_entries_from_sequence_sync(run_id, 0);
        assert_eq!(
            entries,
            vec![ActiveInputEntry {
                run_id,
                sequence: 5,
                text: "pressure-finish".into(),
            }]
        );
        let input_path = local_queue::active_input_path(&group_dir, run_id, 5);
        assert_eq!(
            std::fs::metadata(input_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn rejects_input_for_unclaimed_job() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join("test/group");
        local_queue::ensure_claims_dir(&group_dir).unwrap();
        let run_id = RunId::new_v4();

        let error = run_input_with_home(
            InputArgs {
                run: run_id,
                group: "test/group".into(),
                sequence: 1,
                text: "late-input".into(),
            },
            home,
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("no claimed local job found"),
            "got: {error}"
        );
        assert!(!local_queue::run_inputs_dir(&group_dir, run_id).exists());
    }
}
