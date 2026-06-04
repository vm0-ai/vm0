use std::path::{Path, PathBuf};

use tracing::warn;

use crate::ids::RunId;

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

    pub(crate) fn group_dir(&self) -> &Path {
        &self.group_dir
    }

    pub(crate) fn has_pending_cancel_target(&self, run_id: RunId) -> bool {
        if self.result_file_has_content(run_id) {
            return false;
        }
        if super::claim_path(&self.group_dir, run_id).exists() {
            return true;
        }
        match self.lookup_job_file(run_id) {
            JobFileLookup::Found(_) => true,
            JobFileLookup::NotFound => false,
            JobFileLookup::ScanFailed => true,
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
