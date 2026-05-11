use crate::LOG_TAG;
use guest_common::{log_info, log_warn};
use std::fs;
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InstructionNormalization {
    mount_path: String,
    target_filename: String,
}

impl InstructionNormalization {
    pub(crate) fn new(mount_path: String, target_filename: String) -> Self {
        Self {
            mount_path,
            target_filename,
        }
    }
}

pub(crate) fn normalize_instruction_files(entries: &[InstructionNormalization]) {
    const CANDIDATES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

    for entry in entries {
        let target_filename = entry.target_filename.as_str();
        if !valid_instruction_filename(target_filename) {
            log_warn!(
                LOG_TAG,
                "Skipping invalid instructions target filename: {}",
                target_filename
            );
            continue;
        }

        let mount_path = Path::new(&entry.mount_path);
        let target_path = mount_path.join(target_filename);
        if target_path.exists() {
            remove_alternate_instruction_files(mount_path, target_filename);
            continue;
        }

        let source = CANDIDATES
            .iter()
            .filter(|candidate| **candidate != target_filename)
            .map(|candidate| mount_path.join(candidate))
            .find(|path| path.is_file());

        let Some(source_path) = source else {
            log_warn!(
                LOG_TAG,
                "No instructions file found to normalize at {}",
                entry.mount_path
            );
            continue;
        };

        match fs::copy(&source_path, &target_path) {
            Ok(_) => log_info!(
                LOG_TAG,
                "Normalized instructions file {} -> {}",
                source_path.display(),
                target_path.display()
            ),
            Err(e) => log_warn!(
                LOG_TAG,
                "Failed to normalize instructions file {} -> {}: {}",
                source_path.display(),
                target_path.display(),
                e
            ),
        }

        if target_path.exists() {
            remove_alternate_instruction_files(mount_path, target_filename);
        }
    }
}

fn valid_instruction_filename(filename: &str) -> bool {
    matches!(filename, "CLAUDE.md" | "AGENTS.md")
}

fn remove_alternate_instruction_files(mount_path: &Path, target_filename: &str) {
    for candidate in ["CLAUDE.md", "AGENTS.md"] {
        if candidate == target_filename {
            continue;
        }

        let path = mount_path.join(candidate);
        if !path.exists() {
            continue;
        }

        match fs::remove_file(&path) {
            Ok(_) => log_info!(
                LOG_TAG,
                "Removed non-runtime instructions file {}",
                path.display()
            ),
            Err(e) => log_warn!(
                LOG_TAG,
                "Failed to remove non-runtime instructions file {}: {}",
                path.display(),
                e
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    #[test]
    fn normalize_instruction_files_copies_claude_to_agents_for_codex_target() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("CLAUDE.md"), "runtime instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("AGENTS.md")).unwrap(),
            "runtime instructions"
        );
        assert!(!mount.join("CLAUDE.md").exists());
    }

    #[test]
    fn normalize_instruction_files_leaves_existing_target_unchanged() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("CLAUDE.md"), "legacy").unwrap();
        fs::write(mount.join("AGENTS.md"), "canonical").unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("AGENTS.md")).unwrap(),
            "canonical"
        );
        assert!(!mount.join("CLAUDE.md").exists());
    }
}
