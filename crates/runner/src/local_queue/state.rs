use std::path::{Path, PathBuf};

use tracing::{info, warn};

use super::types::{JobRequest, JobResponse};
use crate::ids::RunId;

#[derive(Clone)]
pub(crate) struct LocalDiscoveredJob {
    pub(crate) run_id: RunId,
    pub(crate) profile_name: String,
    pub(crate) job_path: PathBuf,
}

pub(crate) enum LocalClaimResult {
    Claimed {
        request: Box<JobRequest>,
        request_profile: String,
    },
    NotClaimed,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CancelTargetState {
    Pending,
    NotPending,
    Unknown,
}

pub(crate) struct LocalCancelMarker {
    pub(crate) run_id: RunId,
    pub(crate) target_state: CancelTargetState,
}

/// Shared file-state checks for the local queue protocol.
#[derive(Clone)]
pub(crate) struct LocalQueue {
    group_dir: PathBuf,
}

enum JobFileLookup {
    Found(PathBuf),
    NotFound,
    ScanFailed,
}

impl LocalQueue {
    pub(crate) fn new(group_dir: PathBuf) -> Self {
        Self { group_dir }
    }

    pub(crate) fn discover_candidate_sync(
        &self,
        supported_profiles: &[String],
        start: usize,
    ) -> Option<LocalDiscoveredJob> {
        if supported_profiles.is_empty() {
            return None;
        }

        let profile_count = supported_profiles.len();
        for offset in 0..profile_count {
            let Some(profile) = supported_profiles.get(start.wrapping_add(offset) % profile_count)
            else {
                continue;
            };
            let profile_dir = match super::profile_jobs_dir(&self.group_dir, profile) {
                Ok(dir) => dir,
                Err(e) => {
                    warn!(profile, error = %e, "local: invalid supported profile");
                    continue;
                }
            };
            let entries = match std::fs::read_dir(&profile_dir) {
                Ok(e) => e,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warn!(path = %profile_dir.display(), error = %e, "local: cannot read profile job dir");
                    continue;
                }
            };

            let mut job_paths: Vec<_> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("job"))
                .collect();
            job_paths.sort();

            for path in job_paths {
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Ok(run_id) = stem.parse::<RunId>() else {
                    continue;
                };
                if super::claim_path(&self.group_dir, run_id).exists() {
                    continue;
                }
                if self.result_file_has_content(run_id) {
                    continue;
                }
                return Some(LocalDiscoveredJob {
                    run_id,
                    profile_name: profile.clone(),
                    job_path: path,
                });
            }
        }
        None
    }

    pub(crate) fn claim_job_sync(
        &self,
        run_id: RunId,
        partition_profile: &str,
        job_file: &Path,
    ) -> LocalClaimResult {
        // Atomic claim via O_EXCL — only the first runner to create the file wins.
        let claim_dir = super::claims_dir(&self.group_dir);
        if let Err(e) = std::fs::create_dir_all(&claim_dir) {
            warn!(path = %claim_dir.display(), error = %e, "local: failed to create claim dir");
            return LocalClaimResult::NotClaimed;
        }
        let claim_file = super::claim_path(&self.group_dir, run_id);
        if std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&claim_file)
            .is_err()
        {
            return LocalClaimResult::NotClaimed;
        }
        if self.result_file_has_content(run_id) {
            info!(run_id = %run_id, "local: job already has result, skipping claim");
            let _ = std::fs::remove_file(&claim_file);
            return LocalClaimResult::NotClaimed;
        }

        let buf = match std::fs::read(job_file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                warn!(run_id = %run_id, error = %e, "local: failed to read job file");
                let _ = std::fs::remove_file(&claim_file);
                return LocalClaimResult::NotClaimed;
            }
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: unreadable job file, marking job as failed");
                self.fail_claimed_job_sync_with_claim(
                    run_id,
                    &claim_file,
                    job_file,
                    format!("failed to read job file: {e}"),
                );
                return LocalClaimResult::NotClaimed;
            }
        };
        let request: JobRequest = match serde_json::from_slice(&buf) {
            Ok(r) => r,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: invalid job JSON, marking job as failed");
                // Submit writes .job atomically (tmp + rename), so a malformed
                // .job is a permanent error — retrying the parse will just
                // spin. Keep the claim until after the result attempt so other
                // local runners do not repeatedly process the same poison job.
                // If the result write fails, the claim is released and the job
                // remains retryable. If it succeeds, the result becomes the
                // durable terminal marker before the bad job is removed.
                self.fail_claimed_job_sync_with_claim(
                    run_id,
                    &claim_file,
                    job_file,
                    format!("invalid job JSON: {e}"),
                );
                return LocalClaimResult::NotClaimed;
            }
        };

        if request.job_id != run_id {
            let error = format!(
                "job id mismatch: request={}, filename={run_id}",
                request.job_id
            );
            warn!(run_id = %run_id, error = %error, "local: invalid job id");
            self.fail_claimed_job_sync_with_claim(run_id, &claim_file, job_file, error);
            return LocalClaimResult::NotClaimed;
        }

        let request_profile = match request.profile.clone() {
            Some(profile) => profile,
            None if partition_profile == crate::profile::DEFAULT_PROFILE => {
                crate::profile::DEFAULT_PROFILE.to_owned()
            }
            None => {
                let error =
                    format!("missing job profile in non-default partition: {partition_profile}");
                warn!(run_id = %run_id, error = %error, "local: invalid job profile");
                self.fail_claimed_job_sync_with_claim(run_id, &claim_file, job_file, error);
                return LocalClaimResult::NotClaimed;
            }
        };
        if request_profile != partition_profile {
            let error = format!(
                "job profile mismatch: request={request_profile}, partition={partition_profile}"
            );
            warn!(run_id = %run_id, error = %error, "local: invalid job profile");
            self.fail_claimed_job_sync_with_claim(run_id, &claim_file, job_file, error);
            return LocalClaimResult::NotClaimed;
        }

        LocalClaimResult::Claimed {
            request: Box::new(request),
            request_profile,
        }
    }

    pub(crate) fn fail_claimed_job_sync(&self, run_id: RunId, job_file: &Path, error: String) {
        let claim_file = super::claim_path(&self.group_dir, run_id);
        self.fail_claimed_job_sync_with_claim(run_id, &claim_file, job_file, error);
    }

    pub(crate) fn complete_job_sync(&self, run_id: RunId, exit_code: i32, error: Option<String>) {
        if !self.write_result_sync(run_id, exit_code, error.as_deref()) {
            if self.remove_job_file_if_present(run_id) {
                let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
                let _ = std::fs::remove_file(super::claim_path(&self.group_dir, run_id));
            }
            return;
        }
        // Best-effort cleanup of cancel file (may have been written after the
        // last discover() scan but before the job actually finished).
        let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
        let _ = std::fs::remove_file(super::claim_path(&self.group_dir, run_id));
    }

    pub(crate) fn collect_cancel_markers_sync(&self) -> Vec<LocalCancelMarker> {
        let cancel_dir = super::cancels_dir(&self.group_dir);
        let entries = match std::fs::read_dir(&cancel_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn!(path = %cancel_dir.display(), error = %e, "local: cannot read cancel dir");
                return Vec::new();
            }
        };
        let mut cancel_markers = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("cancel") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(run_id) = stem.parse::<RunId>() else {
                continue;
            };
            if seen.insert(run_id) {
                cancel_markers.push(LocalCancelMarker {
                    run_id,
                    target_state: self.cancel_target_state(run_id),
                });
            }
        }
        cancel_markers
    }

    pub(crate) fn remove_cancel_files_sync(&self, run_ids: Vec<RunId>) {
        for run_id in run_ids {
            let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
        }
    }

    fn cancel_target_state(&self, run_id: RunId) -> CancelTargetState {
        if self.result_file_has_content(run_id) {
            return CancelTargetState::NotPending;
        }
        if super::claim_path(&self.group_dir, run_id).exists() {
            return CancelTargetState::Pending;
        }
        match self.lookup_job_file(run_id) {
            JobFileLookup::Found(_) => CancelTargetState::Pending,
            JobFileLookup::NotFound => CancelTargetState::NotPending,
            JobFileLookup::ScanFailed => CancelTargetState::Unknown,
        }
    }

    pub(crate) fn result_file_has_content(&self, run_id: RunId) -> bool {
        let result_path = super::result_path(&self.group_dir, run_id);
        std::fs::metadata(result_path)
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false)
    }

    pub(crate) fn remove_job_file_if_present(&self, run_id: RunId) -> bool {
        match self.lookup_job_file(run_id) {
            JobFileLookup::Found(path) => match std::fs::remove_file(&path) {
                Ok(()) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                Err(e) => {
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: failed to remove job file after result failure");
                    false
                }
            },
            JobFileLookup::NotFound => true,
            JobFileLookup::ScanFailed => false,
        }
    }

    pub(crate) fn write_result_sync(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
    ) -> bool {
        let response = JobResponse {
            run_id,
            exit_code,
            error: error.map(String::from),
        };
        let json = match serde_json::to_vec(&response) {
            Ok(j) => j,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to serialize result");
                return false;
            }
        };

        let result_dir = super::results_dir(&self.group_dir);
        if let Err(e) = std::fs::create_dir_all(&result_dir) {
            warn!(path = %result_dir.display(), error = %e, "local: failed to create result dir");
            return false;
        }

        // Atomic write: tmp then rename, so submit never reads a partial file.
        let tmp_file = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
        let result_file = super::result_path(&self.group_dir, run_id);
        if let Err(e) = std::fs::write(&tmp_file, &json) {
            warn!(run_id = %run_id, error = %e, "local: failed to write result file");
            let _ = std::fs::remove_file(&tmp_file);
            return false;
        }
        if let Err(e) = std::fs::rename(&tmp_file, &result_file) {
            warn!(run_id = %run_id, error = %e, "local: failed to rename result file");
            let _ = std::fs::remove_file(&tmp_file);
            return false;
        }
        true
    }

    fn fail_claimed_job_sync_with_claim(
        &self,
        run_id: RunId,
        claim_file: &Path,
        job_file: &Path,
        error: String,
    ) {
        if self.write_result_sync(run_id, 1, Some(&error)) {
            let _ = std::fs::remove_file(job_file);
        }
        let _ = std::fs::remove_file(claim_file);
    }

    fn lookup_job_file(&self, run_id: RunId) -> JobFileLookup {
        let jobs_dir = super::jobs_dir(&self.group_dir);
        let orgs = match std::fs::read_dir(&jobs_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return JobFileLookup::NotFound,
            Err(e) => {
                warn!(path = %jobs_dir.display(), error = %e, "local: cannot scan jobs dir for job file");
                return JobFileLookup::ScanFailed;
            }
        };

        for org in orgs.filter_map(Result::ok) {
            if !org.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
                continue;
            }
            let org_path = org.path();
            let profiles = match std::fs::read_dir(&org_path) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warn!(path = %org_path.display(), error = %e, "local: cannot scan profile org dir for job file");
                    return JobFileLookup::ScanFailed;
                }
            };
            for profile in profiles.filter_map(Result::ok) {
                if !profile.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
                    continue;
                }
                let path = profile.path().join(format!("{run_id}.job"));
                match std::fs::metadata(&path) {
                    Ok(_) => return JobFileLookup::Found(path),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        warn!(run_id = %run_id, path = %path.display(), error = %e, "local: cannot stat job file");
                        return JobFileLookup::ScanFailed;
                    }
                }
            }
        }

        JobFileLookup::NotFound
    }
}
