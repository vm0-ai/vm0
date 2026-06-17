//! Shared local file-queue protocol for `runner local` commands and provider.

mod fs;
mod paths;
mod state;
mod types;

pub(crate) use fs::{
    create_private_marker, ensure_cancels_dir, ensure_claims_dir, ensure_group_dir,
    ensure_profile_jobs_dir, ensure_results_dir, marker_file_exists, marker_path_occupied,
    open_private_new_file, private_file_has_content, read_private_file, validate_cancels_dir,
    validate_claims_dir, validate_group_dir, write_private_file, write_private_marker,
};
pub(crate) use paths::{
    cancel_path, cancels_dir, claim_path, claims_dir, job_path, jobs_dir, profile_jobs_dir,
    result_path, results_dir,
};
pub(crate) use state::{CancelTargetState, LocalClaimResult, LocalDiscoveredJob, LocalQueue};
pub(crate) use types::{JobRequest, JobResponse};
