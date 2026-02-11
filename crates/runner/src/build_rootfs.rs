use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use clap::Args;
use sha2::{Digest, Sha256};

use crate::command::{Privilege, exec, exec_ignore_errors};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

const EMBEDDED_DOCKERFILE: &str = include_str!("../rootfs.Dockerfile");

const IMAGE_NAME: &str = "vm0-rootfs";
const CONTAINER_NAME: &str = "vm0-rootfs-tmp";

const GUEST_BINARIES: &[(&str, &str)] = &[
    ("guest-init", "/sbin/guest-init"),
    ("guest-download", "/usr/local/bin/guest-download"),
    ("guest-agent", "/usr/local/bin/guest-agent"),
    ("guest-mock-claude", "/usr/local/bin/guest-mock-claude"),
];

const RESOLV_CONF: &str = "\
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1
";

#[derive(Args)]
pub struct BuildRootfsArgs {
    /// Directory containing guest binaries (guest-init, guest-download, guest-agent, guest-mock-claude)
    #[arg(long)]
    guest_bins: PathBuf,
    /// Override output directory (default: content-addressed in ~/.vm0-runner/rootfs/)
    #[arg(long)]
    output_dir: Option<PathBuf>,
    /// Override embedded Dockerfile
    #[arg(long)]
    dockerfile: Option<PathBuf>,
}

pub async fn run_build_rootfs(args: BuildRootfsArgs) -> RunnerResult<()> {
    check_dependencies()?;
    validate_guest_bins(&args.guest_bins)?;
    let docker = detect_docker_privilege().await?;
    let paths = HomePaths::new()?;

    // Resolve Dockerfile content
    let dockerfile = match &args.dockerfile {
        Some(path) => tokio::fs::read_to_string(path)
            .await
            .map_err(|e| RunnerError::Config(format!("read dockerfile {}: {e}", path.display())))?,
        None => EMBEDDED_DOCKERFILE.to_string(),
    };

    // Compute input hash (deterministic inputs only — no CA)
    let hash = compute_input_hash(&dockerfile, &args.guest_bins).await?;
    tracing::info!("rootfs input hash: {hash}");

    // Resolve output directory
    let output_dir = match &args.output_dir {
        Some(dir) => dir.clone(),
        None => paths.rootfs_dir().join(&hash),
    };
    let rootfs_path = output_dir.join("rootfs.squashfs");

    // Skip if content-addressed rootfs already exists
    if tokio::fs::try_exists(&rootfs_path).await.unwrap_or(false) {
        tracing::info!("[OK] rootfs already exists: {}", rootfs_path.display());
        return Ok(());
    }

    // Create output directory
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", output_dir.display())))?;

    // Generate proxy CA into output directory
    generate_proxy_ca(&output_dir).await?;

    // Docker build + export
    let dockerfile_dir = write_dockerfile_to_temp(&dockerfile)?;
    docker_build(dockerfile_dir.path(), docker).await?;
    let tar_path = docker_export(docker).await?;

    // Extract and inject
    let extract_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    extract_and_inject(&tar_path, extract_dir.path(), &args.guest_bins, &output_dir).await?;
    let _ = tokio::fs::remove_file(&tar_path).await;

    // Create squashfs to temp, verify, then move into place
    let tmp_rootfs = rootfs_path.with_extension(format!("tmp.{}", std::process::id()));
    create_squashfs(extract_dir.path(), &tmp_rootfs).await?;
    drop(extract_dir);

    verify_rootfs(&tmp_rootfs).await?;

    // Atomic rename into final location
    tokio::fs::rename(&tmp_rootfs, &rootfs_path)
        .await
        .map_err(|e| RunnerError::Internal(format!("rename rootfs: {e}")))?;

    tracing::info!("[OK] rootfs built: {}", rootfs_path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

fn check_dependencies() -> RunnerResult<()> {
    let deps = ["docker", "mksquashfs", "openssl"];
    let missing: Vec<&str> = deps
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();

    if !missing.is_empty() {
        return Err(RunnerError::Config(format!(
            "missing required dependencies: {}",
            missing.join(", ")
        )));
    }
    tracing::info!("[OK] all dependencies found");
    Ok(())
}

fn validate_guest_bins(dir: &Path) -> RunnerResult<()> {
    let missing: Vec<&str> = GUEST_BINARIES
        .iter()
        .filter(|(name, _)| !dir.join(name).exists())
        .map(|(name, _)| *name)
        .collect();

    if !missing.is_empty() {
        return Err(RunnerError::Config(format!(
            "missing guest binaries in {}: {}",
            dir.display(),
            missing.join(", ")
        )));
    }
    tracing::info!("[OK] all guest binaries found");
    Ok(())
}

async fn detect_docker_privilege() -> RunnerResult<Privilege> {
    if exec("docker", &["info"], Privilege::User).await.is_ok() {
        tracing::info!("[OK] docker accessible without sudo");
        return Ok(Privilege::User);
    }
    if exec("docker", &["info"], Privilege::Sudo).await.is_ok() {
        tracing::info!("[OK] docker accessible with sudo");
        return Ok(Privilege::Sudo);
    }
    Err(RunnerError::Config(
        "docker not accessible (even with sudo)".into(),
    ))
}

// ---------------------------------------------------------------------------
// Input hash
// ---------------------------------------------------------------------------

async fn compute_input_hash(dockerfile: &str, guest_bins_dir: &Path) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    // Hash Dockerfile content
    hasher.update(b"dockerfile:");
    hasher.update(dockerfile.as_bytes());

    // Hash guest binaries (sorted by name for determinism)
    let mut bin_names: Vec<&str> = GUEST_BINARIES.iter().map(|(name, _)| *name).collect();
    bin_names.sort();

    for name in bin_names {
        let path = guest_bins_dir.join(name);
        let content = tokio::fs::read(&path)
            .await
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", path.display())))?;
        let tag = format!("bin:{name}:");
        hasher.update(tag.as_bytes());
        hasher.update(&content);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

// ---------------------------------------------------------------------------
// Proxy CA generation
// ---------------------------------------------------------------------------

async fn generate_proxy_ca(dir: &Path) -> RunnerResult<()> {
    let cert_path = dir.join("mitmproxy-ca-cert.pem");
    let key_path = dir.join("mitmproxy-ca-key.pem");
    let combined_path = dir.join("mitmproxy-ca.pem");

    if tokio::fs::try_exists(&cert_path).await.unwrap_or(false)
        && tokio::fs::try_exists(&combined_path).await.unwrap_or(false)
    {
        tracing::info!("[OK] proxy CA already exists, skipping generation");
        return Ok(());
    }

    tracing::info!("generating proxy CA certificate...");

    let key_str = key_path.to_string_lossy();
    let cert_str = cert_path.to_string_lossy();

    // Generate RSA 4096 private key
    exec(
        "openssl",
        &["genrsa", "-out", &key_str, "4096"],
        Privilege::User,
    )
    .await?;

    // Generate self-signed certificate (10 years)
    exec(
        "openssl",
        &[
            "req",
            "-new",
            "-x509",
            "-days",
            "3650",
            "-key",
            &key_str,
            "-out",
            &cert_str,
            "-subj",
            "/CN=mitmproxy/O=mitmproxy",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
        ],
        Privilege::User,
    )
    .await?;

    // Create combined PEM (cert + key) for mitmproxy
    let cert_content = tokio::fs::read_to_string(&cert_path)
        .await
        .map_err(|e| RunnerError::Internal(format!("read cert: {e}")))?;
    let key_content = tokio::fs::read_to_string(&key_path)
        .await
        .map_err(|e| RunnerError::Internal(format!("read key: {e}")))?;
    let combined = format!("{cert_content}{key_content}");
    tokio::fs::write(&combined_path, &combined)
        .await
        .map_err(|e| RunnerError::Internal(format!("write combined pem: {e}")))?;

    // Set permissions: key and combined = 600, cert = 644
    tokio::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod key: {e}")))?;
    tokio::fs::set_permissions(&combined_path, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod combined: {e}")))?;
    tokio::fs::set_permissions(&cert_path, std::fs::Permissions::from_mode(0o644))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod cert: {e}")))?;

    tracing::info!("[OK] proxy CA generated");
    Ok(())
}

// ---------------------------------------------------------------------------
// Docker build & export
// ---------------------------------------------------------------------------

fn write_dockerfile_to_temp(content: &str) -> RunnerResult<tempfile::TempDir> {
    let dir = tempfile::tempdir()
        .map_err(|e| RunnerError::Internal(format!("create dockerfile temp dir: {e}")))?;
    std::fs::write(dir.path().join("Dockerfile"), content)
        .map_err(|e| RunnerError::Internal(format!("write Dockerfile: {e}")))?;
    Ok(dir)
}

async fn docker_build(dockerfile_dir: &Path, docker: Privilege) -> RunnerResult<()> {
    tracing::info!("building docker image...");
    let dir_str = dockerfile_dir.to_string_lossy();
    exec("docker", &["build", "-t", IMAGE_NAME, &dir_str], docker).await?;
    tracing::info!("[OK] docker image built");
    Ok(())
}

async fn docker_export(docker: Privilege) -> RunnerResult<PathBuf> {
    tracing::info!("exporting docker filesystem...");

    // Remove any existing temp container
    exec_ignore_errors("docker", &["rm", "-f", CONTAINER_NAME], docker).await;

    // Create container (don't start it)
    exec(
        "docker",
        &["create", "--name", CONTAINER_NAME, IMAGE_NAME],
        docker,
    )
    .await?;

    // Export to temp file
    let tar_path = std::env::temp_dir().join(format!("vm0-rootfs-{}.tar", std::process::id()));
    let tar_str = tar_path.to_string_lossy();
    let result = exec(
        "docker",
        &["export", CONTAINER_NAME, "-o", &tar_str],
        docker,
    )
    .await;

    // Always cleanup container
    exec_ignore_errors("docker", &["rm", "-f", CONTAINER_NAME], docker).await;

    result?;
    tracing::info!("[OK] filesystem exported");
    Ok(tar_path)
}

// ---------------------------------------------------------------------------
// Extract & inject
// ---------------------------------------------------------------------------

async fn extract_and_inject(
    tar_path: &Path,
    extract_dir: &Path,
    guest_bins: &Path,
    ca_dir: &Path,
) -> RunnerResult<()> {
    tracing::info!("extracting and injecting files...");

    let tar_str = tar_path.to_string_lossy();
    let dir_str = extract_dir.to_string_lossy();

    // Extract tar
    exec("tar", &["-xf", &tar_str, "-C", &dir_str], Privilege::Sudo).await?;

    // Write resolv.conf
    let resolv_path = extract_dir.join("etc/resolv.conf");
    let resolv_str = resolv_path.to_string_lossy();
    // Remove existing (may be a symlink)
    exec_ignore_errors("rm", &["-f", &resolv_str], Privilege::Sudo).await;
    write_file_as_root(&resolv_path, RESOLV_CONF).await?;

    // Install guest binaries
    for (name, dest) in GUEST_BINARIES {
        let src = guest_bins.join(name);
        let target = extract_dir.join(dest.trim_start_matches('/'));
        let src_str = src.to_string_lossy();
        let target_str = target.to_string_lossy();
        exec("cp", &[&src_str, &target_str], Privilege::Sudo).await?;
        exec("chmod", &["755", &target_str], Privilege::Sudo).await?;
        tracing::info!("[OK] installed {name}");
    }

    // Install proxy CA certificate
    let ca_cert = ca_dir.join("mitmproxy-ca-cert.pem");
    if !tokio::fs::try_exists(&ca_cert).await.unwrap_or(false) {
        return Err(RunnerError::Internal(
            "proxy CA cert not found — generate_proxy_ca should have been called first".into(),
        ));
    }
    let ca_target = extract_dir.join("usr/local/share/ca-certificates/vm0-proxy-ca.crt");
    let ca_target_dir = extract_dir.join("usr/local/share/ca-certificates");
    let ca_target_dir_str = ca_target_dir.to_string_lossy();
    let ca_cert_str = ca_cert.to_string_lossy();
    let ca_target_str = ca_target.to_string_lossy();

    exec("mkdir", &["-p", &ca_target_dir_str], Privilege::Sudo).await?;
    exec("cp", &[&ca_cert_str, &ca_target_str], Privilege::Sudo).await?;
    exec("chmod", &["644", &ca_target_str], Privilege::Sudo).await?;

    // Update system CA bundle
    exec(
        "chroot",
        &[&dir_str, "update-ca-certificates"],
        Privilege::Sudo,
    )
    .await?;
    tracing::info!("[OK] proxy CA installed and system bundle updated");

    Ok(())
}

/// Write content to a file using sudo tee.
async fn write_file_as_root(path: &Path, content: &str) -> RunnerResult<()> {
    let path_str = path.to_string_lossy();

    let mut child = tokio::process::Command::new("sudo")
        .args(["tee", &path_str])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| RunnerError::Internal(format!("spawn tee: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|e| RunnerError::Internal(format!("write to tee: {e}")))?;
        // Drop stdin to close it, signaling EOF to tee
    }

    let status = child
        .wait()
        .await
        .map_err(|e| RunnerError::Internal(format!("wait tee: {e}")))?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "tee {} failed with {}",
            path_str, status
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Squashfs creation
// ---------------------------------------------------------------------------

async fn create_squashfs(source_dir: &Path, output: &Path) -> RunnerResult<()> {
    tracing::info!("creating squashfs image...");

    // Ensure parent directory exists
    if let Some(parent) = output.parent() {
        let parent_str = parent.to_string_lossy();
        exec("mkdir", &["-p", &parent_str], Privilege::Sudo).await?;
    }

    let source_str = source_dir.to_string_lossy();
    let output_str = output.to_string_lossy();

    exec(
        "mksquashfs",
        &[
            &source_str,
            &output_str,
            "-comp",
            "xz",
            "-noappend",
            "-quiet",
        ],
        Privilege::Sudo,
    )
    .await?;

    tracing::info!("[OK] squashfs created");
    Ok(())
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async fn verify_rootfs(rootfs_path: &Path) -> RunnerResult<()> {
    tracing::info!("verifying rootfs...");

    // Check file size
    let metadata = tokio::fs::metadata(rootfs_path)
        .await
        .map_err(|e| RunnerError::Internal(format!("stat rootfs: {e}")))?;
    let size = metadata.len();
    if size < 50_000_000 {
        tracing::warn!("rootfs seems small: {} bytes", size);
    }

    // Mount squashfs
    let mount_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create mount dir: {e}")))?;
    let mount_str = mount_dir.path().to_string_lossy().to_string();
    let rootfs_str = rootfs_path.to_string_lossy();

    exec(
        "mount",
        &["-t", "squashfs", "-o", "loop,ro", &rootfs_str, &mount_str],
        Privilege::Sudo,
    )
    .await?;

    // Run checks, collecting errors
    let result = verify_mounted(mount_dir.path()).await;

    // Always unmount
    exec_ignore_errors("umount", &[&mount_str], Privilege::Sudo).await;

    result?;
    tracing::info!("[OK] rootfs verification passed");
    Ok(())
}

async fn verify_mounted(mount_point: &Path) -> RunnerResult<()> {
    let mut errors = Vec::new();

    // Check python3
    let python_path = mount_point.join("usr/bin/python3");
    if !python_path.exists() {
        errors.push("python3 not found at /usr/bin/python3".to_string());
    } else {
        tracing::info!("  python3: found");
    }

    // Check guest binaries
    for (name, dest) in GUEST_BINARIES {
        let path = mount_point.join(dest.trim_start_matches('/'));
        if !path.exists() {
            errors.push(format!("{name} not found at {dest}"));
        } else {
            tracing::info!("  {name}: found");
        }
    }

    // Check proxy CA certificate file
    let ca_path = mount_point.join("usr/local/share/ca-certificates/vm0-proxy-ca.crt");
    if !ca_path.exists() {
        errors.push("proxy CA certificate not found".to_string());
    } else {
        tracing::info!("  proxy CA file: found");
    }

    // Check proxy CA in system bundle
    let bundle_path = mount_point.join("etc/ssl/certs/ca-certificates.crt");
    if bundle_path.exists() && ca_path.exists() {
        // Read second line of CA cert as a unique identifier
        let ca_content = std::fs::read_to_string(&ca_path).unwrap_or_default();
        let ca_line = ca_content.lines().nth(1).unwrap_or_default();
        if !ca_line.is_empty() {
            let bundle_content = std::fs::read_to_string(&bundle_path).unwrap_or_default();
            if bundle_content.contains(ca_line) {
                tracing::info!("  proxy CA bundle: updated");
            } else {
                errors.push(
                    "proxy CA not found in system CA bundle (update-ca-certificates may have failed)"
                        .to_string(),
                );
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "rootfs verification failed:\n  {}",
            errors.join("\n  ")
        )))
    }
}
