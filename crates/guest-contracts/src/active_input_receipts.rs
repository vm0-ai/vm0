//! Durable Guest acceptance-receipt journal shared with Runner recovery.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::runtime_paths;

/// Maximum accepted delivery identities retained for one run.
pub const MAX_ACTIVE_INPUT_RECEIPT_IDS: usize = 1_024;
/// Maximum encoded receipt-journal size.
pub const MAX_ACTIVE_INPUT_RECEIPT_JOURNAL_BYTES: usize = 64 * 1_024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveInputReceiptJournal {
    run_id: String,
    delivery_ids: Vec<String>,
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn validate_run_id(run_id: &str) -> io::Result<()> {
    runtime_paths::validate_run_id(run_id)
        .map_err(|error| invalid_data(format!("invalid receipt-journal run id: {error}")))
}

fn validate_delivery_ids(delivery_ids: &[String]) -> io::Result<()> {
    if delivery_ids.len() > MAX_ACTIVE_INPUT_RECEIPT_IDS {
        return Err(invalid_data(format!(
            "receipt journal contains more than {MAX_ACTIVE_INPUT_RECEIPT_IDS} delivery ids"
        )));
    }

    let mut seen = HashSet::with_capacity(delivery_ids.len());
    for delivery_id in delivery_ids {
        let parsed = Uuid::parse_str(delivery_id)
            .map_err(|_| invalid_data("receipt journal contains an invalid delivery id"))?;
        if parsed.hyphenated().to_string() != *delivery_id {
            return Err(invalid_data(
                "receipt journal delivery ids must use canonical UUID form",
            ));
        }
        if !seen.insert(delivery_id.as_str()) {
            return Err(invalid_data(
                "receipt journal contains a duplicate delivery id",
            ));
        }
    }
    Ok(())
}

fn validate_journal(
    journal: ActiveInputReceiptJournal,
    expected_run_id: &str,
) -> io::Result<Vec<String>> {
    validate_run_id(expected_run_id)?;
    if journal.run_id != expected_run_id {
        return Err(invalid_data(
            "receipt journal run id does not match the run",
        ));
    }
    validate_delivery_ids(&journal.delivery_ids)?;
    Ok(journal.delivery_ids)
}

/// Read and validate the outstanding acceptance receipts for one run.
///
/// A missing journal is equivalent to an empty outstanding set. The file is
/// read through the bounded private runtime-file boundary before JSON parsing.
pub fn read_active_input_receipt_journal(
    path: impl AsRef<Path>,
    expected_run_id: &str,
) -> io::Result<Vec<String>> {
    let Some(bytes) =
        runtime_paths::read_private_bounded(path, MAX_ACTIVE_INPUT_RECEIPT_JOURNAL_BYTES)?
    else {
        validate_run_id(expected_run_id)?;
        return Ok(Vec::new());
    };
    let journal = serde_json::from_slice::<ActiveInputReceiptJournal>(&bytes)
        .map_err(|error| invalid_data(format!("invalid active-input receipt journal: {error}")))?;
    validate_journal(journal, expected_run_id)
}

/// Atomically publish the outstanding acceptance receipts for one run.
///
/// The snapshot contains only the exact run id and canonical delivery UUIDs.
/// Callers retain ordering; duplicate ids, malformed ids, and over-limit
/// snapshots are rejected before the previous complete journal is replaced.
pub fn write_active_input_receipt_journal(
    path: impl AsRef<Path>,
    run_id: &str,
    delivery_ids: &[String],
) -> io::Result<()> {
    validate_run_id(run_id)?;
    validate_delivery_ids(delivery_ids)?;
    let bytes = serde_json::to_vec(&ActiveInputReceiptJournal {
        run_id: run_id.to_owned(),
        delivery_ids: delivery_ids.to_vec(),
    })
    .map_err(|error| invalid_data(format!("serialize active-input receipt journal: {error}")))?;
    if bytes.len() > MAX_ACTIVE_INPUT_RECEIPT_JOURNAL_BYTES {
        return Err(invalid_data(format!(
            "receipt journal exceeds {MAX_ACTIVE_INPUT_RECEIPT_JOURNAL_BYTES} bytes"
        )));
    }
    runtime_paths::replace_private_atomic(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN_ID: &str = "run-123";
    const FIRST_ID: &str = "b1e2ad6d-930a-4d51-aa40-7952d54f978b";
    const SECOND_ID: &str = "e6bc287d-8c08-464e-831a-cad771610157";

    #[test]
    fn missing_journal_is_empty() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/active-input-receipts.json");

        assert_eq!(
            read_active_input_receipt_journal(path, RUN_ID).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn journal_round_trips_and_replaces_complete_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/active-input-receipts.json");
        write_active_input_receipt_journal(&path, RUN_ID, &[FIRST_ID.to_owned()]).unwrap();
        write_active_input_receipt_journal(
            &path,
            RUN_ID,
            &[FIRST_ID.to_owned(), SECOND_ID.to_owned()],
        )
        .unwrap();

        assert_eq!(
            read_active_input_receipt_journal(&path, RUN_ID).unwrap(),
            vec![FIRST_ID.to_owned(), SECOND_ID.to_owned()]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn journal_rejects_run_mismatch_invalid_and_duplicate_ids() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/active-input-receipts.json");
        write_active_input_receipt_journal(&path, RUN_ID, &[FIRST_ID.to_owned()]).unwrap();

        assert_eq!(
            read_active_input_receipt_journal(&path, "another-run")
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            write_active_input_receipt_journal(&path, RUN_ID, &["invalid".to_owned()])
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            write_active_input_receipt_journal(
                &path,
                RUN_ID,
                &[FIRST_ID.to_owned(), FIRST_ID.to_owned()],
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidData
        );

        let too_many_ids = (0..=MAX_ACTIVE_INPUT_RECEIPT_IDS)
            .map(|index| {
                Uuid::from_u128(u128::try_from(index).unwrap())
                    .hyphenated()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            write_active_input_receipt_journal(&path, RUN_ID, &too_many_ids)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn malformed_or_oversized_journal_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/active-input-receipts.json");
        runtime_paths::replace_private_atomic(
            &path,
            br#"{"runId":"run-123","deliveryIds":[],"extra":true}"#,
        )
        .unwrap();
        assert_eq!(
            read_active_input_receipt_journal(&path, RUN_ID)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        runtime_paths::replace_private_atomic(
            &path,
            vec![b'x'; MAX_ACTIVE_INPUT_RECEIPT_JOURNAL_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            read_active_input_receipt_journal(&path, RUN_ID)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_final_file_and_parent_symlinks_are_rejected() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("run");
        std::fs::create_dir(&run_dir).unwrap();
        let target = temp.path().join("target");
        std::fs::write(&target, b"unchanged").unwrap();
        let path = run_dir.join("active-input-receipts.json");
        symlink(&target, &path).unwrap();
        assert_eq!(
            write_active_input_receipt_journal(&path, RUN_ID, &[FIRST_ID.to_owned()])
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");

        std::fs::remove_file(&path).unwrap();
        runtime_paths::replace_private_atomic(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(
            read_active_input_receipt_journal(&path, RUN_ID)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            write_active_input_receipt_journal(&path, RUN_ID, &[FIRST_ID.to_owned()])
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        let linked_parent = temp.path().join("linked-run");
        symlink(&run_dir, &linked_parent).unwrap();
        assert_eq!(
            read_active_input_receipt_journal(
                linked_parent.join("active-input-receipts.json"),
                RUN_ID,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[cfg(unix)]
    #[test]
    fn special_file_is_rejected_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("run");
        std::fs::create_dir(&run_dir).unwrap();
        let path = run_dir.join("active-input-receipts.json");
        let path_c = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: `path_c` is NUL-terminated and names a missing temporary path.
        assert_eq!(unsafe { libc::mkfifo(path_c.as_ptr(), 0o600) }, 0);

        assert_eq!(
            read_active_input_receipt_journal(&path, RUN_ID)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            write_active_input_receipt_journal(&path, RUN_ID, &[FIRST_ID.to_owned()])
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
