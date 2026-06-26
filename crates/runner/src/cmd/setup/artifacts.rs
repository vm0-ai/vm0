use std::path::PathBuf;

use crate::deps::{
    FIRECRACKER_SHA256_AARCH64, FIRECRACKER_SHA256_X86_64, FIRECRACKER_VERSION,
    KERNEL_SHA256_AARCH64, KERNEL_SHA256_X86_64, KERNEL_VERSION, MITMDUMP_SHA256_AARCH64,
    MITMDUMP_SHA256_X86_64, MITMDUMP_TAR_ENTRY, MITMPROXY_VERSION, firecracker_tar_entry,
    firecracker_url, kernel_url, mitmdump_url,
};
use crate::error::RunnerResult;
use crate::paths::HomePaths;

use super::{
    SETUP_EXECUTABLE_ARTIFACT_MODE, SETUP_KERNEL_ARTIFACT_MODE, download_and_extract,
    download_to_temp, ensure_artifact_installed, select_sha, verify_and_install,
};

enum SetupArtifactSource {
    Direct,
    TarEntry { entry_name: String },
}

struct SetupArtifact {
    label: &'static str,
    display_name: String,
    target: PathBuf,
    expected_sha: String,
    mode: u32,
    url: String,
    source: SetupArtifactSource,
}

pub(super) async fn install_firecracker(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    install_setup_artifact(firecracker_artifact(paths, arch)).await
}

pub(super) async fn install_kernel(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    install_setup_artifact(kernel_artifact(paths, arch)).await
}

pub(super) async fn install_mitmdump(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    install_setup_artifact(mitmdump_artifact(paths, arch)).await
}

async fn install_setup_artifact(artifact: SetupArtifact) -> RunnerResult<()> {
    if ensure_artifact_installed(&artifact.target, &artifact.expected_sha, artifact.mode).await? {
        tracing::info!(
            "[OK] {} already installed, skipping download",
            artifact.display_name
        );
        return Ok(());
    }

    tracing::info!("downloading {} from {}", artifact.label, artifact.url);

    let produced = match &artifact.source {
        SetupArtifactSource::Direct => {
            download_to_temp(&artifact.url, &artifact.target, "download", artifact.label).await?
        }
        SetupArtifactSource::TarEntry { entry_name } => {
            download_and_extract(&artifact.url, artifact.label, entry_name, &artifact.target)
                .await?
        }
    };

    verify_and_install(
        produced,
        &artifact.expected_sha,
        artifact.label,
        &artifact.target,
        artifact.mode,
    )
    .await?;
    tracing::info!("[OK] {} installed", artifact.display_name);
    Ok(())
}

fn firecracker_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "firecracker",
        display_name: format!("firecracker {FIRECRACKER_VERSION}"),
        target: paths.firecracker_bin(FIRECRACKER_VERSION),
        expected_sha: select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64)
            .to_owned(),
        mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
        url: firecracker_url(arch),
        source: SetupArtifactSource::TarEntry {
            entry_name: firecracker_tar_entry(arch),
        },
    }
}

fn kernel_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "kernel",
        display_name: format!("kernel vmlinux-{KERNEL_VERSION}"),
        target: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        expected_sha: select_sha(arch, KERNEL_SHA256_X86_64, KERNEL_SHA256_AARCH64).to_owned(),
        mode: SETUP_KERNEL_ARTIFACT_MODE,
        url: kernel_url(arch),
        source: SetupArtifactSource::Direct,
    }
}

fn mitmdump_artifact(paths: &HomePaths, arch: &str) -> SetupArtifact {
    SetupArtifact {
        label: "mitmdump",
        display_name: format!("mitmdump {MITMPROXY_VERSION}"),
        target: paths.mitmdump_bin(MITMPROXY_VERSION),
        expected_sha: select_sha(arch, MITMDUMP_SHA256_X86_64, MITMDUMP_SHA256_AARCH64).to_owned(),
        mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
        url: mitmdump_url(arch),
        source: SetupArtifactSource::TarEntry {
            entry_name: MITMDUMP_TAR_ENTRY.to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use httpmock::Method::GET;
    use httpmock::MockServer;
    use sha2::{Digest, Sha256};

    use super::*;

    fn sha256_hex(content: &[u8]) -> String {
        hex::encode(Sha256::digest(content))
    }

    fn mode(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn tarball_with_entry(entry_name: &str, content: &[u8]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, entry_name, content)
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn artifact_descriptors_preserve_metadata_by_arch() {
        let paths = HomePaths::with_root(PathBuf::from("/setup-root"));

        let firecracker_x86 = firecracker_artifact(&paths, "x86_64");
        assert_eq!(
            firecracker_x86.target,
            paths.firecracker_bin(FIRECRACKER_VERSION)
        );
        assert_eq!(firecracker_x86.mode, SETUP_EXECUTABLE_ARTIFACT_MODE);
        assert_eq!(firecracker_x86.expected_sha, FIRECRACKER_SHA256_X86_64);
        assert_eq!(firecracker_x86.url, firecracker_url("x86_64"));
        assert!(matches!(
            &firecracker_x86.source,
            SetupArtifactSource::TarEntry { entry_name }
                if entry_name == &firecracker_tar_entry("x86_64")
        ));

        let firecracker_aarch64 = firecracker_artifact(&paths, "aarch64");
        assert_eq!(firecracker_aarch64.expected_sha, FIRECRACKER_SHA256_AARCH64);
        assert_eq!(firecracker_aarch64.url, firecracker_url("aarch64"));
        assert!(matches!(
            &firecracker_aarch64.source,
            SetupArtifactSource::TarEntry { entry_name }
                if entry_name == &firecracker_tar_entry("aarch64")
        ));

        let kernel_x86 = kernel_artifact(&paths, "x86_64");
        assert_eq!(
            kernel_x86.target,
            paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION)
        );
        assert_eq!(kernel_x86.mode, SETUP_KERNEL_ARTIFACT_MODE);
        assert_eq!(kernel_x86.expected_sha, KERNEL_SHA256_X86_64);
        assert_eq!(kernel_x86.url, kernel_url("x86_64"));
        assert!(matches!(kernel_x86.source, SetupArtifactSource::Direct));

        let kernel_aarch64 = kernel_artifact(&paths, "aarch64");
        assert_eq!(kernel_aarch64.expected_sha, KERNEL_SHA256_AARCH64);
        assert_eq!(kernel_aarch64.url, kernel_url("aarch64"));

        let mitmdump_x86 = mitmdump_artifact(&paths, "x86_64");
        assert_eq!(mitmdump_x86.target, paths.mitmdump_bin(MITMPROXY_VERSION));
        assert_eq!(mitmdump_x86.mode, SETUP_EXECUTABLE_ARTIFACT_MODE);
        assert_eq!(mitmdump_x86.expected_sha, MITMDUMP_SHA256_X86_64);
        assert_eq!(mitmdump_x86.url, mitmdump_url("x86_64"));
        assert!(matches!(
            &mitmdump_x86.source,
            SetupArtifactSource::TarEntry { entry_name } if entry_name.as_str() == MITMDUMP_TAR_ENTRY
        ));

        let mitmdump_aarch64 = mitmdump_artifact(&paths, "aarch64");
        assert_eq!(mitmdump_aarch64.expected_sha, MITMDUMP_SHA256_AARCH64);
        assert_eq!(mitmdump_aarch64.url, mitmdump_url("aarch64"));
    }

    #[tokio::test]
    async fn installed_artifact_skips_download() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"already installed";
        let target = dir.path().join("artifact.bin");
        std::fs::write(&target, content).unwrap();
        std::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(SETUP_EXECUTABLE_ARTIFACT_MODE),
        )
        .unwrap();

        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/artifact.bin");
                then.status(200).body("should not download");
            })
            .await;
        let artifact = SetupArtifact {
            label: "test",
            display_name: "test artifact".to_owned(),
            target: target.clone(),
            expected_sha: sha256_hex(content),
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/artifact.bin"),
            source: SetupArtifactSource::Direct,
        };

        install_setup_artifact(artifact).await.unwrap();

        download.assert_calls_async(0).await;
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn direct_artifact_downloads_and_installs() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"direct artifact".to_vec();
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/direct.bin");
                then.status(200).body(content.clone());
            })
            .await;
        let target = dir.path().join("nested").join("direct.bin");
        let artifact = SetupArtifact {
            label: "direct",
            display_name: "direct artifact".to_owned(),
            target: target.clone(),
            expected_sha: sha256_hex(&content),
            mode: SETUP_KERNEL_ARTIFACT_MODE,
            url: server.url("/direct.bin"),
            source: SetupArtifactSource::Direct,
        };

        install_setup_artifact(artifact).await.unwrap();

        download.assert_calls_async(1).await;
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(mode(&target), SETUP_KERNEL_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn tar_entry_artifact_downloads_extracts_and_installs() {
        let dir = tempfile::tempdir().unwrap();
        let server = MockServer::start_async().await;
        let content = b"tar entry artifact".to_vec();
        let tarball = tarball_with_entry("tool", &content);
        let download = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.tar.gz");
                then.status(200).body(tarball.clone());
            })
            .await;
        let target = dir.path().join("nested").join("tool");
        let artifact = SetupArtifact {
            label: "tar-entry",
            display_name: "tar entry artifact".to_owned(),
            target: target.clone(),
            expected_sha: sha256_hex(&content),
            mode: SETUP_EXECUTABLE_ARTIFACT_MODE,
            url: server.url("/archive.tar.gz"),
            source: SetupArtifactSource::TarEntry {
                entry_name: "tool".to_owned(),
            },
        };

        install_setup_artifact(artifact).await.unwrap();

        download.assert_calls_async(1).await;
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }
}
