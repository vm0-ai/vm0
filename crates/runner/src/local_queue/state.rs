use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

use super::types::{ActiveInputEntry, JobRequest, JobResponse};
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

enum CancelTargetLookup {
    Resolved(CancelTargetState),
    NeedsJobFile,
}

enum JobFileScan {
    Complete(Vec<PathBuf>),
    ScanFailed(Vec<PathBuf>),
}

struct JobProfileDirScan {
    paths: Vec<PathBuf>,
    complete: bool,
}

struct JobPresenceScan {
    found: HashSet<RunId>,
    complete: bool,
}

impl JobPresenceScan {
    fn target_state(&self, run_id: RunId) -> CancelTargetState {
        if self.found.contains(&run_id) {
            CancelTargetState::Pending
        } else if self.complete {
            CancelTargetState::NotPending
        } else {
            CancelTargetState::Unknown
        }
    }
}

impl LocalQueue {
    pub(crate) fn new(group_dir: PathBuf) -> Self {
        Self { group_dir }
    }

    pub(crate) fn group_dir(&self) -> &Path {
        &self.group_dir
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

            let mut job_paths = Vec::new();
            for entry in entries.filter_map(Result::ok) {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_file() {
                    continue;
                }
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("job") {
                    job_paths.push(path);
                }
            }
            job_paths.sort();

            for path in job_paths {
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Ok(run_id) = stem.parse::<RunId>() else {
                    continue;
                };
                match self.claim_path_occupied(run_id) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(e) => {
                        warn!(run_id = %run_id, error = %e, "local: cannot stat claim path");
                        continue;
                    }
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
        if let Err(e) = super::ensure_claims_dir(&self.group_dir) {
            warn!(path = %super::claims_dir(&self.group_dir).display(), error = %e, "local: failed to create claim dir");
            return LocalClaimResult::NotClaimed;
        }
        let claim_file = super::claim_path(&self.group_dir, run_id);
        if super::create_private_marker(&claim_file, "local claim marker").is_err() {
            return LocalClaimResult::NotClaimed;
        }
        if self.result_file_has_content(run_id) {
            info!(run_id = %run_id, "local: job already has result, skipping claim");
            let _ = std::fs::remove_file(&claim_file);
            return LocalClaimResult::NotClaimed;
        }

        let buf = match super::read_private_file(job_file, "local job file") {
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
            self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
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
                self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
                return LocalClaimResult::NotClaimed;
            }
        };
        if request_profile != partition_profile {
            let error = format!(
                "job profile mismatch: request={request_profile}, partition={partition_profile}"
            );
            warn!(run_id = %run_id, error = %error, "local: invalid job profile");
            self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
            return LocalClaimResult::NotClaimed;
        }

        LocalClaimResult::Claimed {
            request: Box::new(request),
            request_profile,
        }
    }

    pub(crate) fn fail_claimed_job_sync(&self, run_id: RunId, error: String) {
        let claim_file = super::claim_path(&self.group_dir, run_id);
        self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
    }

    pub(crate) fn complete_job_sync(&self, run_id: RunId, exit_code: i32, error: Option<String>) {
        if !self.write_result_sync(run_id, exit_code, error.as_deref()) {
            if self.remove_job_files_if_present(run_id) {
                let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
                let _ = std::fs::remove_file(super::claim_path(&self.group_dir, run_id));
                self.cleanup_active_inputs_sync(run_id);
            }
            return;
        }
        let _ = self.remove_job_files_if_present(run_id);
        // Best-effort cleanup of cancel file (may have been written after the
        // last discover() scan but before the job actually finished).
        let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
        let _ = std::fs::remove_file(super::claim_path(&self.group_dir, run_id));
        self.cleanup_active_inputs_sync(run_id);
    }

    pub(crate) fn write_active_input_sync(&self, entry: &ActiveInputEntry) -> std::io::Result<()> {
        if entry.sequence == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "local active input sequence must be greater than zero",
            ));
        }
        if entry.message_id.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "local active input message id must not be empty",
            ));
        }
        if entry.text.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "local active input text must not be empty",
            ));
        }
        let run_dir = super::ensure_run_inputs_dir(&self.group_dir, entry.run_id)?;
        let bytes = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
        let tmp_path = run_dir.join(format!(
            "{:020}.{}.json.tmp",
            entry.sequence,
            RunId::new_v4()
        ));
        let final_path = super::active_input_path(&self.group_dir, entry.run_id, entry.sequence);
        if let Err(e) =
            super::write_private_file(&tmp_path, &bytes, "local active-input temporary file")
        {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        if let Err(e) = std::fs::hard_link(&tmp_path, &final_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(std::io::Error::new(
                e.kind(),
                format!(
                    "publish local active-input file {}: {e}",
                    final_path.display()
                ),
            ));
        }
        let _ = std::fs::remove_file(&tmp_path);
        Ok(())
    }

    pub(crate) fn read_active_input_entries_from_sequence_sync(
        &self,
        run_id: RunId,
        min_sequence: u64,
    ) -> Vec<ActiveInputEntry> {
        let run_dir = super::run_inputs_dir(&self.group_dir, run_id);
        match std::fs::symlink_metadata(&run_dir) {
            Ok(_) => {
                if let Err(e) = super::validate_run_inputs_dir(&self.group_dir, run_id) {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: invalid active-input directory");
                    return Vec::new();
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: cannot stat active-input directory");
                return Vec::new();
            }
        }

        let entries = match std::fs::read_dir(&run_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: cannot read active-input directory");
                return Vec::new();
            }
        };

        let mut parsed = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(sequence) = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(|stem| stem.parse::<u64>().ok())
            else {
                continue;
            };
            if sequence < min_sequence {
                continue;
            }
            let Ok(bytes) = super::read_private_file(&path, "local active-input file") else {
                continue;
            };
            let Ok(input) = serde_json::from_slice::<ActiveInputEntry>(&bytes) else {
                continue;
            };
            if input.run_id != run_id
                || input.sequence != sequence
                || input.message_id.is_empty()
                || input.text.is_empty()
            {
                continue;
            }
            parsed.push(input);
        }
        parsed.sort_by_key(|entry| entry.sequence);
        parsed
    }

    pub(crate) fn cleanup_active_inputs_sync(&self, run_id: RunId) {
        let run_dir = super::run_inputs_dir(&self.group_dir, run_id);
        match std::fs::symlink_metadata(&run_dir) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                if let Err(e) = super::validate_run_inputs_dir(&self.group_dir, run_id) {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: invalid active-input directory during cleanup");
                    return;
                }
                if let Err(e) = std::fs::remove_dir_all(&run_dir)
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: failed to clean active-input directory");
                }
            }
            Ok(metadata) if metadata.file_type().is_file() => {
                if let Err(e) = super::validate_inputs_dir(&self.group_dir) {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: invalid active-input parent directory during cleanup");
                    return;
                }
                if let Err(e) = std::fs::remove_file(&run_dir)
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: failed to clean active-input file");
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: cannot stat active-input directory for cleanup");
            }
        }
    }

    pub(crate) fn collect_cancel_markers_sync(&self) -> Vec<LocalCancelMarker> {
        let cancel_dir = super::cancels_dir(&self.group_dir);
        if let Err(e) = validate_optional_cancel_dir(&self.group_dir, &cancel_dir) {
            warn!(path = %cancel_dir.display(), error = %e, "local: invalid cancel dir");
            return Vec::new();
        }
        let entries = match std::fs::read_dir(&cancel_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn!(path = %cancel_dir.display(), error = %e, "local: cannot read cancel dir");
                return Vec::new();
            }
        };
        let mut cancel_markers = Vec::new();
        let mut unresolved_run_ids = Vec::new();
        let mut seen = HashSet::new();
        for entry in entries.filter_map(Result::ok) {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
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
                match self.cancel_target_state_before_job_lookup(run_id) {
                    CancelTargetLookup::Resolved(target_state) => {
                        cancel_markers.push(LocalCancelMarker {
                            run_id,
                            target_state,
                        });
                    }
                    CancelTargetLookup::NeedsJobFile => {
                        unresolved_run_ids.push(run_id);
                        cancel_markers.push(LocalCancelMarker {
                            run_id,
                            target_state: CancelTargetState::Unknown,
                        });
                    }
                }
            }
        }
        if !unresolved_run_ids.is_empty() {
            let job_presence = self.lookup_job_files_for_cancel_targets(&unresolved_run_ids);
            let unresolved: HashSet<RunId> = unresolved_run_ids.into_iter().collect();
            for marker in &mut cancel_markers {
                if unresolved.contains(&marker.run_id) {
                    marker.target_state = job_presence.target_state(marker.run_id);
                }
            }
        }
        cancel_markers
    }

    pub(crate) fn remove_cancel_files_sync(&self, run_ids: Vec<RunId>) {
        for run_id in run_ids {
            let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
        }
    }

    fn cancel_target_state_before_job_lookup(&self, run_id: RunId) -> CancelTargetLookup {
        if self.result_file_has_content(run_id) {
            return CancelTargetLookup::Resolved(CancelTargetState::NotPending);
        }
        match self.claim_marker_exists(run_id) {
            Ok(true) => return CancelTargetLookup::Resolved(CancelTargetState::Pending),
            Ok(false) => {}
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: cannot stat claim marker");
                return CancelTargetLookup::Resolved(CancelTargetState::Unknown);
            }
        }
        CancelTargetLookup::NeedsJobFile
    }

    fn claim_marker_exists(&self, run_id: RunId) -> std::io::Result<bool> {
        super::marker_file_exists(
            &super::claim_path(&self.group_dir, run_id),
            "local claim marker",
        )
    }

    fn claim_path_occupied(&self, run_id: RunId) -> std::io::Result<bool> {
        super::marker_path_occupied(
            &super::claim_path(&self.group_dir, run_id),
            "local claim marker",
        )
    }

    pub(crate) fn result_file_has_content(&self, run_id: RunId) -> bool {
        let result_path = super::result_path(&self.group_dir, run_id);
        super::private_file_has_content(&result_path, "local result file").unwrap_or(false)
    }

    pub(crate) fn remove_job_files_if_present(&self, run_id: RunId) -> bool {
        let (paths, mut removed_all) = match self.collect_job_file_paths(run_id) {
            JobFileScan::Complete(paths) => (paths, true),
            JobFileScan::ScanFailed(paths) => (paths, false),
        };

        for path in paths {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: failed to remove job file after terminal result");
                    removed_all = false;
                }
            };
        }

        removed_all
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

        let result_dir = match super::ensure_results_dir(&self.group_dir) {
            Ok(dir) => dir,
            Err(e) => {
                warn!(path = %super::results_dir(&self.group_dir).display(), error = %e, "local: failed to create result dir");
                return false;
            }
        };

        // Atomic write: tmp then rename, so submit never reads a partial file.
        let tmp_file = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
        let result_file = super::result_path(&self.group_dir, run_id);
        if let Err(e) = super::write_private_file(&tmp_file, &json, "local result temporary file") {
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

    fn fail_claimed_job_sync_with_claim(&self, run_id: RunId, claim_file: &Path, error: String) {
        if self.write_result_sync(run_id, 1, Some(&error)) {
            let _ = self.remove_job_files_if_present(run_id);
            self.cleanup_active_inputs_sync(run_id);
        }
        let _ = std::fs::remove_file(claim_file);
    }

    fn lookup_job_files_for_cancel_targets(&self, run_ids: &[RunId]) -> JobPresenceScan {
        let profile_dirs = self.collect_job_profile_dirs();
        lookup_job_files_in_profile_dirs(run_ids, &profile_dirs.paths, profile_dirs.complete)
    }

    fn collect_job_profile_dirs(&self) -> JobProfileDirScan {
        let jobs_dir = super::jobs_dir(&self.group_dir);
        let mut paths = Vec::new();
        let orgs = match std::fs::read_dir(&jobs_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return JobProfileDirScan {
                    paths,
                    complete: true,
                };
            }
            Err(e) => {
                warn!(path = %jobs_dir.display(), error = %e, "local: cannot scan jobs dir for job profile dirs");
                return JobProfileDirScan {
                    paths,
                    complete: false,
                };
            }
        };

        for org in orgs {
            let org = match org {
                Ok(entry) => entry,
                Err(e) => {
                    warn!(path = %jobs_dir.display(), error = %e, "local: cannot scan jobs dir entry for job profile dirs");
                    return JobProfileDirScan {
                        paths,
                        complete: false,
                    };
                }
            };
            let org_file_type = match org.file_type() {
                Ok(file_type) => file_type,
                Err(e) => {
                    warn!(path = %org.path().display(), error = %e, "local: cannot stat profile org dir entry for job profile dirs");
                    return JobProfileDirScan {
                        paths,
                        complete: false,
                    };
                }
            };
            if !org_file_type.is_dir() {
                continue;
            }
            let org_path = org.path();
            let profiles = match std::fs::read_dir(&org_path) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warn!(path = %org_path.display(), error = %e, "local: cannot scan profile org dir for job profile dirs");
                    return JobProfileDirScan {
                        paths,
                        complete: false,
                    };
                }
            };
            for profile in profiles {
                let profile = match profile {
                    Ok(entry) => entry,
                    Err(e) => {
                        warn!(path = %org_path.display(), error = %e, "local: cannot scan profile dir entry for job profile dirs");
                        return JobProfileDirScan {
                            paths,
                            complete: false,
                        };
                    }
                };
                let profile_file_type = match profile.file_type() {
                    Ok(file_type) => file_type,
                    Err(e) => {
                        warn!(path = %profile.path().display(), error = %e, "local: cannot stat profile dir entry for job profile dirs");
                        return JobProfileDirScan {
                            paths,
                            complete: false,
                        };
                    }
                };
                if profile_file_type.is_dir() {
                    paths.push(profile.path());
                }
            }
        }

        JobProfileDirScan {
            paths,
            complete: true,
        }
    }

    fn collect_job_file_paths(&self, run_id: RunId) -> JobFileScan {
        let profile_dirs = self.collect_job_profile_dirs();
        let mut paths = Vec::new();

        for profile_dir in profile_dirs.paths {
            let path = profile_dir.join(format!("{run_id}.job"));
            match std::fs::symlink_metadata(&path) {
                Ok(_) => {
                    paths.push(path);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: cannot stat job file");
                    return JobFileScan::ScanFailed(paths);
                }
            }
        }

        if profile_dirs.complete {
            JobFileScan::Complete(paths)
        } else {
            JobFileScan::ScanFailed(paths)
        }
    }
}

fn lookup_job_files_in_profile_dirs(
    run_ids: &[RunId],
    profile_dirs: &[PathBuf],
    profile_dir_scan_complete: bool,
) -> JobPresenceScan {
    let mut found = HashSet::new();
    let mut remaining: HashSet<RunId> = run_ids.iter().copied().collect();
    let mut complete = profile_dir_scan_complete;

    for profile_dir in profile_dirs {
        if remaining.is_empty() {
            break;
        }
        let targets: Vec<RunId> = remaining.iter().copied().collect();
        for run_id in targets {
            let path = profile_dir.join(format!("{run_id}.job"));
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_file() => {
                    found.insert(run_id);
                    remaining.remove(&run_id);
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    complete = false;
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: cannot stat cancel target job file");
                }
            }
        }
    }

    JobPresenceScan { found, complete }
}

fn validate_optional_cancel_dir(group_dir: &Path, cancel_dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(cancel_dir) {
        Ok(_) => super::validate_cancels_dir(group_dir).map(|_| ()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(std::io::Error::new(
            e.kind(),
            format!(
                "stat local queue cancels directory {}: {e}",
                cancel_dir.display()
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn write_job_request(group_dir: &Path, run_id: RunId, profile: &str) -> PathBuf {
        let job_path = super::super::job_path(group_dir, profile, run_id).unwrap();
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        let request = JobRequest {
            job_id: run_id,
            prompt: "secret prompt".into(),
            cli_agent_type: "claude-code".into(),
            vars: None,
            environment: None,
            secret_environment: None,
            user_timezone: None,
            profile: Some(profile.to_owned()),
            session_id: Some("session-123".into()),
            feature_flags: None,
            active_input: None,
        };
        std::fs::write(&job_path, serde_json::to_vec(&request).unwrap()).unwrap();
        job_path
    }

    fn write_cancel_marker(group_dir: &Path, run_id: RunId) -> PathBuf {
        let cancel_path = super::super::cancel_path(group_dir, run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        cancel_path
    }

    fn collect_marker_states(queue: &LocalQueue) -> HashMap<RunId, CancelTargetState> {
        queue
            .collect_cancel_markers_sync()
            .into_iter()
            .map(|marker| (marker.run_id, marker.target_state))
            .collect()
    }

    fn assert_marker_state(
        states: &HashMap<RunId, CancelTargetState>,
        run_id: RunId,
        expected: CancelTargetState,
    ) {
        assert_eq!(states.get(&run_id), Some(&expected));
    }

    #[test]
    fn write_result_sync_creates_private_result_file() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();

        assert!(queue.write_result_sync(run_id, 1, Some("sensitive error")));

        assert_eq!(mode(&super::super::results_dir(group_dir)), 0o700);
        assert_eq!(mode(&super::super::result_path(group_dir, run_id)), 0o600);
    }

    #[test]
    fn write_result_sync_tightens_existing_permissive_result_dir() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let result_dir = super::super::results_dir(group_dir);
        std::fs::create_dir_all(&result_dir).unwrap();
        std::fs::set_permissions(&result_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let queue = LocalQueue::new(group_dir.to_path_buf());

        assert!(queue.write_result_sync(RunId::new_v4(), 0, None));

        assert_eq!(mode(&result_dir), 0o700);
    }

    #[test]
    fn claim_job_sync_creates_private_claim_file() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        let job_path = write_job_request(group_dir, run_id, profile);

        let claim = queue.claim_job_sync(run_id, profile, &job_path);

        assert!(matches!(claim, LocalClaimResult::Claimed { .. }));
        assert_eq!(mode(&super::super::claims_dir(group_dir)), 0o700);
        assert_eq!(mode(&super::super::claim_path(group_dir, run_id)), 0o600);
    }

    #[test]
    fn active_input_write_creates_private_files_and_reads_in_numeric_order() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let entry_10 = ActiveInputEntry {
            run_id,
            sequence: 10,
            message_id: "msg-10".to_string(),
            text: "ten".to_string(),
        };
        let entry_2 = ActiveInputEntry {
            run_id,
            sequence: 2,
            message_id: "msg-2".to_string(),
            text: "two".to_string(),
        };

        queue.write_active_input_sync(&entry_10).unwrap();
        queue.write_active_input_sync(&entry_2).unwrap();

        assert_eq!(mode(&super::super::inputs_dir(group_dir)), 0o700);
        assert_eq!(
            mode(&super::super::run_inputs_dir(group_dir, run_id)),
            0o700
        );
        assert_eq!(
            mode(&super::super::active_input_path(group_dir, run_id, 2)),
            0o600
        );
        assert_eq!(
            queue.read_active_input_entries_from_sequence_sync(run_id, 0),
            vec![entry_2, entry_10]
        );
    }

    #[test]
    fn active_input_read_ignores_malformed_or_mismatched_files() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let other_run_id = RunId::new_v4();
        let valid = ActiveInputEntry {
            run_id,
            sequence: 1,
            message_id: "msg-1".to_string(),
            text: "one".to_string(),
        };
        queue.write_active_input_sync(&valid).unwrap();
        let run_dir = super::super::run_inputs_dir(group_dir, run_id);
        std::fs::write(run_dir.join("00000000000000000002.json"), b"not-json").unwrap();
        std::fs::write(
            run_dir.join("00000000000000000003.json"),
            serde_json::to_vec(&ActiveInputEntry {
                run_id: other_run_id,
                sequence: 3,
                message_id: "msg-3".to_string(),
                text: "wrong run".to_string(),
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            run_dir.join("00000000000000000004.json"),
            serde_json::to_vec(&ActiveInputEntry {
                run_id,
                sequence: 5,
                message_id: "msg-5".to_string(),
                text: "wrong sequence".to_string(),
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            run_dir.join("00000000000000000005.json"),
            serde_json::to_vec(&ActiveInputEntry {
                run_id,
                sequence: 5,
                message_id: String::new(),
                text: "empty message id".to_string(),
            })
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            queue.read_active_input_entries_from_sequence_sync(run_id, 0),
            vec![valid]
        );
    }

    #[test]
    fn active_input_read_skips_entries_before_min_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let entry_1 = ActiveInputEntry {
            run_id,
            sequence: 1,
            message_id: "msg-1".to_string(),
            text: "one".to_string(),
        };
        let entry_3 = ActiveInputEntry {
            run_id,
            sequence: 3,
            message_id: "msg-3".to_string(),
            text: "three".to_string(),
        };
        queue.write_active_input_sync(&entry_1).unwrap();
        queue.write_active_input_sync(&entry_3).unwrap();

        assert_eq!(
            queue.read_active_input_entries_from_sequence_sync(run_id, 2),
            vec![entry_3]
        );
    }

    #[test]
    fn active_input_write_rejects_duplicate_sequence_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let original = ActiveInputEntry {
            run_id,
            sequence: 1,
            message_id: "msg-1".to_string(),
            text: "one".to_string(),
        };
        let duplicate = ActiveInputEntry {
            run_id,
            sequence: 1,
            message_id: "msg-duplicate".to_string(),
            text: "duplicate".to_string(),
        };

        queue.write_active_input_sync(&original).unwrap();
        let error = queue.write_active_input_sync(&duplicate).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            queue.read_active_input_entries_from_sequence_sync(run_id, 0),
            vec![original]
        );
    }

    #[test]
    fn active_input_write_rejects_zero_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let queue = LocalQueue::new(dir.path().to_path_buf());

        let error = queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id: RunId::new_v4(),
                sequence: 0,
                message_id: "msg-0".to_string(),
                text: "zero".to_string(),
            })
            .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn active_input_write_rejects_empty_message_id() {
        let dir = tempfile::tempdir().unwrap();
        let queue = LocalQueue::new(dir.path().to_path_buf());

        let error = queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id: RunId::new_v4(),
                sequence: 1,
                message_id: String::new(),
                text: "one".to_string(),
            })
            .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn active_input_cleanup_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id,
                sequence: 1,
                message_id: "msg-1".to_string(),
                text: "one".to_string(),
            })
            .unwrap();

        queue.cleanup_active_inputs_sync(run_id);
        queue.cleanup_active_inputs_sync(run_id);

        assert!(!super::super::run_inputs_dir(group_dir, run_id).exists());
    }

    #[test]
    fn fail_claimed_job_sync_cleans_active_inputs_after_terminal_result() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        let job_path = write_job_request(group_dir, run_id, profile);
        queue
            .write_active_input_sync(&ActiveInputEntry {
                run_id,
                sequence: 1,
                message_id: "msg-1".to_string(),
                text: "one".to_string(),
            })
            .unwrap();

        queue.fail_claimed_job_sync(run_id, "failed before execution".to_string());

        assert!(queue.result_file_has_content(run_id));
        assert!(!job_path.exists());
        assert!(!super::super::run_inputs_dir(group_dir, run_id).exists());
    }

    #[test]
    fn active_input_cleanup_does_not_follow_inputs_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("group");
        let target_dir = dir.path().join("target");
        let run_id = RunId::new_v4();
        std::fs::create_dir_all(&group_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        let target_file = target_dir.join(run_id.to_string());
        std::fs::write(&target_file, b"do not delete").unwrap();
        symlink(&target_dir, super::super::inputs_dir(&group_dir)).unwrap();

        LocalQueue::new(group_dir).cleanup_active_inputs_sync(run_id);

        assert!(target_file.exists());
    }

    #[test]
    fn discover_candidate_skips_job_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        let job_path = super::super::job_path(group_dir, profile, run_id).unwrap();
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-job");
        std::fs::write(&target, b"{}").unwrap();
        symlink(&target, &job_path).unwrap();

        assert!(
            queue
                .discover_candidate_sync(&[profile.to_owned()], 0)
                .is_none(),
            "job symlinks must not be discovered"
        );
    }

    #[test]
    fn claim_job_sync_rejects_job_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        let job_path = super::super::job_path(group_dir, profile, run_id).unwrap();
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-job");
        std::fs::write(&target, b"{}").unwrap();
        symlink(&target, &job_path).unwrap();

        let claim = queue.claim_job_sync(run_id, profile, &job_path);

        assert!(matches!(claim, LocalClaimResult::NotClaimed));
        assert!(
            std::fs::symlink_metadata(&job_path).is_err(),
            "failed symlink jobs should be removed after terminal result write"
        );
        assert!(queue.result_file_has_content(run_id));
    }

    #[test]
    fn discover_candidate_skips_occupied_claim_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        write_job_request(group_dir, run_id, profile);
        let claims_dir = super::super::claims_dir(group_dir);
        std::fs::create_dir_all(&claims_dir).unwrap();
        let target = dir.path().join("target-claim");
        std::fs::write(&target, b"").unwrap();
        symlink(&target, super::super::claim_path(group_dir, run_id)).unwrap();

        assert!(
            queue
                .discover_candidate_sync(&[profile.to_owned()], 0)
                .is_none(),
            "an occupied claim path should be skipped because claim create_new cannot win it"
        );
    }

    #[test]
    fn discover_candidate_skips_dangling_claim_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        write_job_request(group_dir, run_id, profile);
        let claims_dir = super::super::claims_dir(group_dir);
        std::fs::create_dir_all(&claims_dir).unwrap();
        symlink(
            dir.path().join("missing-target-claim"),
            super::super::claim_path(group_dir, run_id),
        )
        .unwrap();

        assert!(
            queue
                .discover_candidate_sync(&[profile.to_owned()], 0)
                .is_none(),
            "a dangling claim symlink should still occupy the atomic claim path"
        );
    }

    #[test]
    fn collect_cancel_markers_ignores_claim_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let claims_dir = super::super::claims_dir(group_dir);
        std::fs::create_dir_all(&claims_dir).unwrap();
        let target = dir.path().join("target-claim");
        std::fs::write(&target, b"").unwrap();
        symlink(&target, super::super::claim_path(group_dir, run_id)).unwrap();
        write_cancel_marker(group_dir, run_id);

        let states = collect_marker_states(&queue);

        assert_marker_state(&states, run_id, CancelTargetState::NotPending);
    }

    #[test]
    fn result_file_has_content_ignores_result_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let result_path = super::super::result_path(group_dir, run_id);
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-result");
        std::fs::write(&target, b"terminal").unwrap();
        symlink(&target, &result_path).unwrap();

        assert!(
            !queue.result_file_has_content(run_id),
            "result symlinks must not be treated as terminal markers"
        );
    }

    #[test]
    fn collect_cancel_markers_ignores_result_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let profile = crate::profile::DEFAULT_PROFILE;
        write_job_request(group_dir, run_id, profile);
        let result_path = super::super::result_path(group_dir, run_id);
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-result");
        std::fs::write(&target, b"terminal").unwrap();
        symlink(&target, &result_path).unwrap();
        write_cancel_marker(group_dir, run_id);

        let states = collect_marker_states(&queue);

        assert_marker_state(&states, run_id, CancelTargetState::Pending);
    }

    #[test]
    fn collect_cancel_markers_resolves_batch_job_presence_across_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let default_job = RunId::new_v4();
        let large_job = RunId::new_v4();
        let missing = RunId::new_v4();
        let terminal = RunId::new_v4();
        let claimed = RunId::new_v4();

        write_job_request(group_dir, default_job, crate::profile::DEFAULT_PROFILE);
        write_job_request(group_dir, large_job, "vm0/large");
        write_job_request(group_dir, terminal, crate::profile::DEFAULT_PROFILE);
        assert!(queue.write_result_sync(terminal, 0, None));
        std::fs::create_dir_all(super::super::claims_dir(group_dir)).unwrap();
        std::fs::write(super::super::claim_path(group_dir, claimed), b"").unwrap();

        for run_id in [default_job, large_job, missing, terminal, claimed] {
            write_cancel_marker(group_dir, run_id);
        }

        let states = collect_marker_states(&queue);

        assert_marker_state(&states, default_job, CancelTargetState::Pending);
        assert_marker_state(&states, large_job, CancelTargetState::Pending);
        assert_marker_state(&states, missing, CancelTargetState::NotPending);
        assert_marker_state(&states, terminal, CancelTargetState::NotPending);
        assert_marker_state(&states, claimed, CancelTargetState::Pending);
    }

    #[test]
    fn collect_cancel_markers_keeps_unresolved_targets_unknown_when_job_scan_fails() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        write_cancel_marker(group_dir, run_id);
        std::fs::write(super::super::jobs_dir(group_dir), b"not a directory").unwrap();

        let states = collect_marker_states(&queue);

        assert_marker_state(&states, run_id, CancelTargetState::Unknown);
    }

    #[test]
    fn batch_job_lookup_preserves_found_targets_when_later_path_stat_fails() {
        let dir = tempfile::tempdir().unwrap();
        let found_run_id = RunId::new_v4();
        let unresolved_run_id = RunId::new_v4();
        let profile_dir = dir.path().join("profile");
        std::fs::create_dir(&profile_dir).unwrap();
        std::fs::write(profile_dir.join(format!("{found_run_id}.job")), b"{}").unwrap();
        let not_a_profile_dir = dir.path().join("not-a-profile-dir");
        std::fs::write(&not_a_profile_dir, b"not a directory").unwrap();

        let scan = lookup_job_files_in_profile_dirs(
            &[found_run_id, unresolved_run_id],
            &[profile_dir, not_a_profile_dir],
            true,
        );

        assert_eq!(scan.target_state(found_run_id), CancelTargetState::Pending);
        assert_eq!(
            scan.target_state(unresolved_run_id),
            CancelTargetState::Unknown
        );
    }

    #[test]
    fn collect_cancel_markers_ignores_job_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let job_path =
            super::super::job_path(group_dir, crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-job");
        std::fs::write(&target, b"{}").unwrap();
        symlink(&target, &job_path).unwrap();
        write_cancel_marker(group_dir, run_id);

        let states = collect_marker_states(&queue);

        assert_marker_state(&states, run_id, CancelTargetState::NotPending);
    }

    #[test]
    fn collect_cancel_markers_ignores_unrelated_job_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let unrelated_run_id = RunId::new_v4();
        let profile_dir =
            super::super::profile_jobs_dir(group_dir, crate::profile::DEFAULT_PROFILE).unwrap();
        std::fs::create_dir_all(&profile_dir).unwrap();
        std::fs::write(profile_dir.join("not-a-run-id.job"), b"{}").unwrap();
        std::fs::write(profile_dir.join(format!("{unrelated_run_id}.job")), b"{}").unwrap();
        write_cancel_marker(group_dir, run_id);

        let states = collect_marker_states(&queue);

        assert_marker_state(&states, run_id, CancelTargetState::NotPending);
    }

    #[test]
    fn collect_cancel_markers_ignores_cancel_file_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path();
        let queue = LocalQueue::new(group_dir.to_path_buf());
        let run_id = RunId::new_v4();
        let cancel_path = super::super::cancel_path(group_dir, run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        let target = dir.path().join("target-cancel");
        std::fs::write(&target, b"").unwrap();
        symlink(&target, &cancel_path).unwrap();

        assert!(queue.collect_cancel_markers_sync().is_empty());
    }

    #[test]
    fn collect_cancel_markers_rejects_cancel_dir_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("group");
        std::fs::create_dir(&group_dir).unwrap();
        let target = dir.path().join("target-cancels");
        std::fs::create_dir(&target).unwrap();
        let run_id = RunId::new_v4();
        std::fs::write(target.join(format!("{run_id}.cancel")), b"").unwrap();
        symlink(&target, super::super::cancels_dir(&group_dir)).unwrap();
        let queue = LocalQueue::new(group_dir);

        assert!(queue.collect_cancel_markers_sync().is_empty());
    }
}
