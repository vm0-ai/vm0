use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};

use super::BuildArgs;

const GUEST_AGENT_DEST: &str = "/usr/local/bin/guest-agent";
const GUEST_DOWNLOAD_DEST: &str = "/usr/local/bin/guest-download";
const GUEST_INIT_DEST: &str = "/sbin/guest-init";
const GUEST_RESEED_DEST: &str = "/sbin/guest-reseed";
const GUEST_WRITE_FILE_DEST: &str = "/sbin/guest-write-file";
const GUEST_MOCK_CLAUDE_DEST: &str = "/usr/local/bin/guest-mock-claude";
const GUEST_MOCK_CODEX_DEST: &str = "/usr/local/bin/guest-mock-codex";

#[cfg(bundled_guests)]
mod embedded {
    pub const GUEST_INIT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_INIT"));
    pub const GUEST_DOWNLOAD: &[u8] = include_bytes!(env!("BUNDLED_GUEST_DOWNLOAD"));
    pub const GUEST_AGENT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_AGENT"));
    pub const GUEST_MOCK_CLAUDE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CLAUDE"));
    pub const GUEST_MOCK_CODEX: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CODEX"));
    pub const GUEST_RESEED: &[u8] = include_bytes!(env!("BUNDLED_GUEST_RESEED"));
    pub const GUEST_WRITE_FILE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_WRITE_FILE"));
}

#[cfg(bundled_guests)]
fn bundled_guest(name: &str) -> Option<&'static [u8]> {
    match name {
        "guest-agent" => Some(embedded::GUEST_AGENT),
        "guest-download" => Some(embedded::GUEST_DOWNLOAD),
        "guest-init" => Some(embedded::GUEST_INIT),
        "guest-mock-claude" => Some(embedded::GUEST_MOCK_CLAUDE),
        "guest-mock-codex" => Some(embedded::GUEST_MOCK_CODEX),
        "guest-reseed" => Some(embedded::GUEST_RESEED),
        "guest-write-file" => Some(embedded::GUEST_WRITE_FILE),
        _ => None,
    }
}

#[cfg(not(bundled_guests))]
fn bundled_guest(_name: &str) -> Option<&'static [u8]> {
    None
}

pub(super) struct GuestBinaries {
    // Keeps extracted bundled guest binaries alive for hash computation and
    // customize-rootfs.sh execution.
    pub(super) _temp_dir: tempfile::TempDir,
    pub(super) guest_agent: PathBuf,
    pub(super) guest_download: PathBuf,
    pub(super) guest_init: PathBuf,
    pub(super) guest_mock_claude: PathBuf,
    pub(super) guest_mock_codex: PathBuf,
    pub(super) guest_reseed: PathBuf,
    pub(super) guest_write_file: PathBuf,
}

impl GuestBinaries {
    pub(super) async fn resolve(args: &mut BuildArgs) -> RunnerResult<Self> {
        let temp_dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
        let temp_path = temp_dir.path();
        let guest_agent = resolve_guest(args.guest_agent.take(), "guest-agent", temp_path).await?;
        let guest_download =
            resolve_guest(args.guest_download.take(), "guest-download", temp_path).await?;
        let guest_init = resolve_guest(args.guest_init.take(), "guest-init", temp_path).await?;
        let guest_mock_claude = resolve_guest(
            args.guest_mock_claude.take(),
            "guest-mock-claude",
            temp_path,
        )
        .await?;
        let guest_mock_codex =
            resolve_guest(args.guest_mock_codex.take(), "guest-mock-codex", temp_path).await?;
        let guest_reseed =
            resolve_guest(args.guest_reseed.take(), "guest-reseed", temp_path).await?;
        let guest_write_file =
            resolve_guest(args.guest_write_file.take(), "guest-write-file", temp_path).await?;

        Ok(Self {
            _temp_dir: temp_dir,
            guest_agent,
            guest_download,
            guest_init,
            guest_mock_claude,
            guest_mock_codex,
            guest_reseed,
            guest_write_file,
        })
    }

    pub(super) fn hash_inputs(&self) -> [(&Path, &str); 7] {
        [
            (self.guest_agent.as_path(), GUEST_AGENT_DEST),
            (self.guest_download.as_path(), GUEST_DOWNLOAD_DEST),
            (self.guest_init.as_path(), GUEST_INIT_DEST),
            (self.guest_reseed.as_path(), GUEST_RESEED_DEST),
            (self.guest_write_file.as_path(), GUEST_WRITE_FILE_DEST),
            (self.guest_mock_claude.as_path(), GUEST_MOCK_CLAUDE_DEST),
            (self.guest_mock_codex.as_path(), GUEST_MOCK_CODEX_DEST),
        ]
    }
}

/// Resolve a guest binary path: CLI arg takes priority, then bundled binary.
///
/// The returned path always points into `tmp_dir`, so hash computation and
/// rootfs customization consumes the same bytes even if the original CLI
/// path is replaced while the build is running.
async fn resolve_guest(
    cli_path: Option<PathBuf>,
    name: &str,
    tmp_dir: &Path,
) -> RunnerResult<PathBuf> {
    let dest = tmp_dir.join(name);
    if let Some(p) = cli_path {
        tokio::fs::copy(&p, &dest).await.map_err(|e| {
            RunnerError::Internal(format!(
                "copy {name} {} → {}: {e}",
                p.display(),
                dest.display()
            ))
        })?;
    } else if let Some(bytes) = bundled_guest(name) {
        tokio::fs::write(&dest, bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("write bundled {name}: {e}")))?;
    } else {
        return Err(RunnerError::Internal(format!(
            "missing --{} and no bundled binary available",
            name
        )));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| RunnerError::Internal(format!("chmod {name}: {e}")))?;
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_binaries_hash_inputs_preserve_destination_order() {
        let temp_dir = tempfile::tempdir().unwrap();
        let guest_agent = temp_dir.path().join("guest-agent");
        let guest_download = temp_dir.path().join("guest-download");
        let guest_init = temp_dir.path().join("guest-init");
        let guest_reseed = temp_dir.path().join("guest-reseed");
        let guest_write_file = temp_dir.path().join("guest-write-file");
        let guest_mock_claude = temp_dir.path().join("guest-mock-claude");
        let guest_mock_codex = temp_dir.path().join("guest-mock-codex");
        let guests = GuestBinaries {
            _temp_dir: temp_dir,
            guest_agent: guest_agent.clone(),
            guest_download: guest_download.clone(),
            guest_init: guest_init.clone(),
            guest_mock_claude: guest_mock_claude.clone(),
            guest_mock_codex: guest_mock_codex.clone(),
            guest_reseed: guest_reseed.clone(),
            guest_write_file: guest_write_file.clone(),
        };

        assert_eq!(
            guests.hash_inputs(),
            [
                (guest_agent.as_path(), GUEST_AGENT_DEST),
                (guest_download.as_path(), GUEST_DOWNLOAD_DEST),
                (guest_init.as_path(), GUEST_INIT_DEST),
                (guest_reseed.as_path(), GUEST_RESEED_DEST),
                (guest_write_file.as_path(), GUEST_WRITE_FILE_DEST),
                (guest_mock_claude.as_path(), GUEST_MOCK_CLAUDE_DEST),
                (guest_mock_codex.as_path(), GUEST_MOCK_CODEX_DEST),
            ]
        );
    }

    #[tokio::test]
    async fn resolve_guest_snapshots_cli_binary_into_temp_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("source-guest");
        tokio::fs::write(&source, b"v1").await.unwrap();

        let tmp_dir = tempfile::tempdir().unwrap();
        let resolved = resolve_guest(Some(source.clone()), "guest-agent", tmp_dir.path())
            .await
            .unwrap();

        tokio::fs::write(&source, b"v2").await.unwrap();
        assert_eq!(tokio::fs::read(&resolved).await.unwrap(), b"v1");
        assert!(resolved.starts_with(tmp_dir.path()));
        assert_ne!(resolved, source);
    }
}
