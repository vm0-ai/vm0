use crate::LOG_TAG;
use guest_common::{log_info, log_warn};
use std::fs;
use std::io;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstructionFilename {
    Claude,
    Agents,
}

enum InstructionPathState {
    Missing,
    RegularFile,
    NonRegular,
    MetadataError(io::Error),
}

impl InstructionFilename {
    const ALL: [Self; 2] = [Self::Claude, Self::Agents];

    fn parse(filename: &str) -> Option<Self> {
        match filename {
            "CLAUDE.md" => Some(Self::Claude),
            "AGENTS.md" => Some(Self::Agents),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE.md",
            Self::Agents => "AGENTS.md",
        }
    }
}

pub(crate) fn normalize_instruction_files(entries: &[InstructionNormalization]) {
    for entry in entries {
        let raw_target_filename = entry.target_filename.as_str();
        let Some(target_filename) = InstructionFilename::parse(raw_target_filename) else {
            log_warn!(
                LOG_TAG,
                "Skipping invalid instructions target filename: {}",
                raw_target_filename
            );
            continue;
        };

        let mount_path = Path::new(&entry.mount_path);
        let target_path = mount_path.join(target_filename.as_str());
        match lstat_instruction_path_state(&target_path) {
            InstructionPathState::RegularFile => {
                remove_alternate_instruction_files(mount_path, target_filename);
                continue;
            }
            InstructionPathState::Missing => {}
            InstructionPathState::NonRegular => {
                log_warn!(
                    LOG_TAG,
                    "Skipping instructions normalization because target is not a regular file: {}",
                    target_path.display()
                );
                continue;
            }
            InstructionPathState::MetadataError(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to inspect instructions target {}: {}",
                    target_path.display(),
                    e
                );
                continue;
            }
        }

        let source = InstructionFilename::ALL
            .iter()
            .copied()
            .filter(|candidate| *candidate != target_filename)
            .map(|candidate| mount_path.join(candidate.as_str()))
            .find(|path| {
                matches!(
                    lstat_instruction_path_state(path),
                    InstructionPathState::RegularFile
                )
            });

        let Some(source_path) = source else {
            log_warn!(
                LOG_TAG,
                "No instructions file found to normalize at {}",
                entry.mount_path
            );
            continue;
        };

        match fs::copy(&source_path, &target_path) {
            Ok(_) => {
                log_info!(
                    LOG_TAG,
                    "Normalized instructions file {} -> {}",
                    source_path.display(),
                    target_path.display()
                );
                remove_alternates_after_successful_copy(mount_path, target_filename, &target_path);
            }
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to normalize instructions file {} -> {}: {}",
                    source_path.display(),
                    target_path.display(),
                    e
                );
                remove_failed_instruction_target(&target_path);
            }
        }
    }
}

fn lstat_instruction_path_state(path: &Path) -> InstructionPathState {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => InstructionPathState::RegularFile,
        Ok(_) => InstructionPathState::NonRegular,
        Err(e) if e.kind() == io::ErrorKind::NotFound => InstructionPathState::Missing,
        Err(e) => InstructionPathState::MetadataError(e),
    }
}

fn remove_alternates_after_successful_copy(
    mount_path: &Path,
    target_filename: InstructionFilename,
    target_path: &Path,
) {
    match lstat_instruction_path_state(target_path) {
        InstructionPathState::RegularFile => {
            remove_alternate_instruction_files(mount_path, target_filename);
        }
        InstructionPathState::Missing => log_warn!(
            LOG_TAG,
            "Normalized instructions target is missing after copy: {}",
            target_path.display()
        ),
        InstructionPathState::NonRegular => log_warn!(
            LOG_TAG,
            "Normalized instructions target is not a regular file after copy: {}",
            target_path.display()
        ),
        InstructionPathState::MetadataError(e) => log_warn!(
            LOG_TAG,
            "Failed to inspect normalized instructions target {}: {}",
            target_path.display(),
            e
        ),
    }
}

fn remove_failed_instruction_target(target_path: &Path) {
    if !matches!(
        lstat_instruction_path_state(target_path),
        InstructionPathState::RegularFile
    ) {
        return;
    }

    match fs::remove_file(target_path) {
        Ok(_) => log_info!(
            LOG_TAG,
            "Removed failed instructions target {}",
            target_path.display()
        ),
        Err(e) => log_warn!(
            LOG_TAG,
            "Failed to remove failed instructions target {}: {}",
            target_path.display(),
            e
        ),
    }
}

fn remove_alternate_instruction_files(mount_path: &Path, target_filename: InstructionFilename) {
    for candidate in InstructionFilename::ALL {
        if candidate == target_filename {
            continue;
        }

        let path = mount_path.join(candidate.as_str());
        match lstat_instruction_path_state(&path) {
            InstructionPathState::Missing => continue,
            InstructionPathState::RegularFile | InstructionPathState::NonRegular => {}
            InstructionPathState::MetadataError(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to inspect non-runtime instructions file {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
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
    fn normalize_instruction_files_copies_agents_to_claude_for_claude_target() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".claude");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("AGENTS.md"), "runtime instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "CLAUDE.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "runtime instructions"
        );
        assert!(!mount.join("AGENTS.md").exists());
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

    #[test]
    fn normalize_instruction_files_keeps_alternate_when_target_is_directory() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(mount.join("AGENTS.md")).unwrap();
        fs::write(mount.join("CLAUDE.md"), "runtime instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "runtime instructions"
        );
        assert!(mount.join("AGENTS.md").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_keeps_alternate_when_target_is_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("target.md"), "linked target").unwrap();
        fs::write(mount.join("CLAUDE.md"), "runtime instructions").unwrap();
        std::os::unix::fs::symlink(mount.join("target.md"), mount.join("AGENTS.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "runtime instructions"
        );
        assert!(
            mount
                .join("AGENTS.md")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_removes_dangling_alternate_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("AGENTS.md"), "runtime instructions").unwrap();
        std::os::unix::fs::symlink(mount.join("missing.md"), mount.join("CLAUDE.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert!(mount.join("CLAUDE.md").symlink_metadata().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_ignores_alternate_symlink_source() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("linked.md"), "runtime instructions").unwrap();
        std::os::unix::fs::symlink(mount.join("linked.md"), mount.join("CLAUDE.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert!(mount.join("AGENTS.md").symlink_metadata().is_err());
        assert!(
            mount
                .join("CLAUDE.md")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn normalize_instruction_files_skips_invalid_target_without_deleting_files() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("CLAUDE.md"), "claude").unwrap();
        fs::write(mount.join("AGENTS.md"), "agents").unwrap();

        normalize_instruction_files(&[InstructionNormalization::new(
            mount.to_string_lossy().into(),
            "../outside.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "claude"
        );
        assert_eq!(
            fs::read_to_string(mount.join("AGENTS.md")).unwrap(),
            "agents"
        );
        assert!(!dir.path().join("outside.md").exists());
    }
}
