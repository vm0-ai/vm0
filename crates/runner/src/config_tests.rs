use super::*;

/// 64 lowercase hex chars — matches `Sha256::digest(...).hex_encode()`.
const TEST_ROOTFS_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SNAPSHOT_HASH: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

struct ConfigFixture {
    dir: tempfile::TempDir,
    firecracker: std::path::PathBuf,
    kernel: std::path::PathBuf,
    home: HomePaths,
}

impl ConfigFixture {
    async fn new() -> Self {
        Self::with_artifacts(&[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await
    }

    async fn without_image_artifacts() -> Self {
        Self::with_artifacts(&[]).await
    }

    async fn with_artifacts(hashes: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let firecracker = dir.path().join("firecracker");
        let kernel = dir.path().join("vmlinux");
        for path in [&firecracker, &kernel] {
            tokio::fs::write(path, b"").await.unwrap();
        }
        let home = test_home_with_artifacts(dir.path(), hashes).await;

        Self {
            dir,
            firecracker,
            kernel,
            home,
        }
    }

    fn path(&self) -> &std::path::Path {
        self.dir.path()
    }

    fn config_path(&self) -> std::path::PathBuf {
        self.path().join("runner.yaml")
    }

    fn yaml(&self, body: &str) -> String {
        self.yaml_with_identity("test", "test/group", body)
    }

    fn yaml_with_identity(&self, name: &str, group: &str, body: &str) -> String {
        format!(
            r#"
name: {name}
group: {group}
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {firecracker}
  kernel: {kernel}
{body}"#,
            base_dir = self.path().display(),
            ca_dir = self.path().display(),
            firecracker = self.firecracker.display(),
            kernel = self.kernel.display(),
        )
    }

    fn yaml_with_default_profile(&self, extra: &str) -> String {
        self.yaml(&format!(
            r#"profiles:
  vm0/default:
    rootfs_hash: {rootfs_hash}
    snapshot_hash: {snapshot_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
{extra}"#,
            rootfs_hash = TEST_ROOTFS_HASH,
            snapshot_hash = TEST_SNAPSHOT_HASH,
        ))
    }

    async fn write_config(&self, yaml: &str) -> std::path::PathBuf {
        let config_path = self.config_path();
        tokio::fs::write(&config_path, yaml).await.unwrap();
        config_path
    }

    async fn load_config(
        &self,
        yaml: &str,
        validate_image_artifacts: bool,
    ) -> RunnerResult<RunnerConfig> {
        self.load_config_with_home(yaml, &self.home, validate_image_artifacts)
            .await
    }

    async fn load_config_with_home(
        &self,
        yaml: &str,
        home: &HomePaths,
        validate_image_artifacts: bool,
    ) -> RunnerResult<RunnerConfig> {
        let config_path = self.write_config(yaml).await;
        load_with_home(&config_path, home, validate_image_artifacts).await
    }
}

/// Create a HomePaths rooted in a temp dir and populate fake image files
/// for the given (rootfs_hash, snapshot_hash) pairs so config validation passes.
async fn test_home_with_artifacts(dir: &std::path::Path, hashes: &[(&str, &str)]) -> HomePaths {
    let home = HomePaths::with_root(dir.join("vm0-runner"));
    for &(rootfs_hash, snapshot_hash) in hashes {
        let rootfs = RootfsPaths::new(&home, rootfs_hash);
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
        if !snapshot_hash.is_empty() {
            let snapshot = rootfs.snapshot(snapshot_hash);
            tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
            for path in [
                snapshot.snapshot_bin(),
                snapshot.memory_bin(),
                snapshot.cow_img(),
                snapshot.cow_bitmap(),
            ] {
                tokio::fs::write(&path, b"").await.unwrap();
            }
            tokio::fs::write(
                snapshot.complete_marker(),
                sandbox_fc::SNAPSHOT_COMPLETE_MARKER_CONTENT,
            )
            .await
            .unwrap();
        }
    }
    home
}

fn make_profiles() -> BTreeMap<String, ProfileConfig> {
    let mut profiles = BTreeMap::new();
    profiles.insert(
        "vm0/default".into(),
        ProfileConfig {
            rootfs_hash: TEST_ROOTFS_HASH.into(),
            snapshot_hash: TEST_SNAPSHOT_HASH.into(),
            vcpu: 2,
            memory_mb: 4096,
            rootfs_disk_mb: 8192,
            workspace_disk_mb: 16384,
        },
    );
    profiles
}

#[tokio::test]
async fn load_config_with_profiles() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_identity(
        "test-runner",
        "vm0/prod",
        &format!(
            r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
sandbox:
  max_concurrent: 8
  concurrency_factor: 2.0
server:
  url: https://api.example.com
  token: secret
"#,
            hash = TEST_ROOTFS_HASH,
            snap_hash = TEST_SNAPSHOT_HASH,
        ),
    );

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.name, "test-runner");
    assert_eq!(config.profiles.len(), 1);
    let default = &config.profiles["vm0/default"];
    assert_eq!(default.vcpu, 2);
    assert_eq!(default.rootfs_hash, TEST_ROOTFS_HASH);
    assert_eq!(default.rootfs_disk_mb, 8192);
    assert_eq!(default.workspace_disk_mb, 16384);
    assert_eq!(config.sandbox.max_concurrent, 8);
    assert!((config.sandbox.concurrency_factor - 2.0).abs() < f64::EPSILON);
    let server = config.server.unwrap();
    assert_eq!(server.url, "https://api.example.com");
    assert_eq!(server.token, "secret");
}

#[tokio::test]
async fn load_rejects_legacy_disk_mb_without_split_disk_fields() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    disk_mb: 12288
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string().contains("rootfs_disk_mb") || err.to_string().contains("workspace_disk_mb"),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn load_defaults_for_sandbox() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile("");

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.sandbox.max_concurrent, DEFAULT_MAX_CONCURRENT);
    assert!((config.sandbox.concurrency_factor - DEFAULT_CONCURRENCY_FACTOR).abs() < f64::EPSILON);
    assert!(config.server.is_none());
}

#[tokio::test]
async fn load_rejects_empty_profiles() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml("profiles: {}\n");

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string().contains("profiles must not be empty"),
        "got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_invalid_profile_name() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  bad-name:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(
        err.to_string().contains("invalid profile name"),
        "got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_invalid_rootfs_hash() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    // `../etc` would escape `images_dir()` if joined unchecked. The
    // validator must reject this at config-load time, before any
    // filesystem I/O on the bad path.
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: ../etc
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("invalid image hash"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_invalid_snapshot_hash() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: ../etc
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("invalid image hash"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_zero_vcpu_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 0
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_zero_rootfs_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 0
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_zero_workspace_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 0
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("non-zero"), "got: {err}");
}

#[tokio::test]
async fn load_accepts_vcpu_at_maximum() {
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 1024
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    // vcpu == MAX_VCPU should be accepted (validation uses >, not >=)
    let result = fixture.load_config(&yaml, true).await;
    assert!(result.is_ok(), "got: {}", result.unwrap_err());
}

#[tokio::test]
async fn load_rejects_excessive_vcpu_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2048
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_excessive_memory_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 2000000
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_excessive_rootfs_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 2000000
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_excessive_workspace_disk_mb_in_profile() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml(&format!(
        r#"
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 2000000
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    ));

    let err = fixture.load_config(&yaml, true).await.unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "got: {err}");
}

#[tokio::test]
async fn load_rejects_incomplete_image() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    // Create rootfs.ext4 but NO snapshot files — validation should fail.
    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();

    let yaml = fixture.yaml_with_default_profile("");

    let err = fixture
        .load_config_with_home(&yaml, &home, true)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "expected missing file error, got: {err}"
    );
}

#[tokio::test]
async fn load_defers_missing_image_checks() {
    let fixture = ConfigFixture::without_image_artifacts().await;
    let yaml = fixture.yaml_with_default_profile("");
    let config_path = fixture.write_config(&yaml).await;

    let config = load(&config_path).await.unwrap();
    let profile = config.profiles.get("vm0/default").unwrap();
    assert_eq!(profile.rootfs_hash, TEST_ROOTFS_HASH);
    assert_eq!(profile.snapshot_hash, TEST_SNAPSHOT_HASH);
}

#[tokio::test]
async fn load_defers_malformed_complete_marker_check() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in [
        snapshot.snapshot_bin(),
        snapshot.memory_bin(),
        snapshot.cow_img(),
        snapshot.cow_bitmap(),
    ] {
        tokio::fs::write(&path, b"").await.unwrap();
    }
    tokio::fs::write(snapshot.complete_marker(), b"partial marker")
        .await
        .unwrap();

    let yaml = fixture.yaml_with_default_profile("");

    let config = fixture
        .load_config_with_home(&yaml, &home, false)
        .await
        .unwrap();
    let profile = config.profiles.get("vm0/default").unwrap();
    let err = validate_profile_image_artifacts("vm0/default", profile, &home)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("complete marker") && err.to_string().contains("invalid"),
        "expected deferred invalid complete marker error, got: {err}"
    );
}

#[tokio::test]
async fn validate_profile_image_artifacts_rejects_missing_cow_bitmap() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in [
        snapshot.snapshot_bin(),
        snapshot.memory_bin(),
        snapshot.cow_img(),
    ] {
        tokio::fs::write(&path, b"").await.unwrap();
    }
    tokio::fs::write(
        snapshot.complete_marker(),
        sandbox_fc::SNAPSHOT_COMPLETE_MARKER_CONTENT,
    )
    .await
    .unwrap();

    let profile = ProfileConfig {
        rootfs_hash: TEST_ROOTFS_HASH.into(),
        snapshot_hash: TEST_SNAPSHOT_HASH.into(),
        vcpu: 2,
        memory_mb: 4096,
        rootfs_disk_mb: 8192,
        workspace_disk_mb: 16384,
    };
    let err = validate_profile_image_artifacts("vm0/default", &profile, &home)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("cow.img.bitmap"),
        "expected missing cow bitmap error, got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_snapshot_without_complete_marker() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in [
        snapshot.snapshot_bin(),
        snapshot.memory_bin(),
        snapshot.cow_img(),
        snapshot.cow_bitmap(),
    ] {
        tokio::fs::write(&path, b"").await.unwrap();
    }

    let yaml = fixture.yaml_with_default_profile("");

    let err = fixture
        .load_config_with_home(&yaml, &home, true)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains(".snapshot-complete"),
        "expected missing complete marker error, got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_snapshot_with_malformed_complete_marker() {
    let fixture = ConfigFixture::without_image_artifacts().await;

    let home = HomePaths::with_root(fixture.path().join("vm0-runner"));
    let rootfs = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    let snapshot = rootfs.snapshot(TEST_SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    for path in [
        snapshot.snapshot_bin(),
        snapshot.memory_bin(),
        snapshot.cow_img(),
        snapshot.cow_bitmap(),
    ] {
        tokio::fs::write(&path, b"").await.unwrap();
    }
    tokio::fs::write(snapshot.complete_marker(), b"partial marker")
        .await
        .unwrap();

    let yaml = fixture.yaml_with_default_profile("");

    let err = fixture
        .load_config_with_home(&yaml, &home, true)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("complete marker") && err.to_string().contains("invalid"),
        "expected invalid complete marker error, got: {err}"
    );
}

#[tokio::test]
async fn load_rejects_invalid_concurrency_factor() {
    let fixture = ConfigFixture::new().await;

    for bad_value in ["0.0", "-1.0", ".nan", ".inf", "-.inf"] {
        let yaml = fixture.yaml_with_default_profile(&format!(
            r#"sandbox:
  concurrency_factor: {bad_value}
"#
        ));

        let err = fixture.load_config(&yaml, true).await.unwrap_err();
        assert!(
            err.to_string().contains("concurrency_factor"),
            "expected concurrency_factor error for {bad_value}, got: {err}"
        );
    }
}

#[tokio::test]
async fn generate_then_load_round_trip() {
    let fixture = ConfigFixture::new().await;
    let runner_dir = fixture.path().join("my-runner");
    let config = RunnerConfig {
        name: "test-runner".into(),
        group: "vm0/prod".into(),
        base_dir: runner_dir.clone(),
        ca_dir: fixture.path().to_path_buf(),
        firecracker: FirecrackerConfig {
            binary: fixture.firecracker.clone(),
            kernel: fixture.kernel.clone(),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig {
            max_concurrent: 8,
            concurrency_factor: 2.0,
            ..SandboxConfig::default()
        },
        server: Some(ServerConfig {
            url: "https://api.example.com".into(),
            token: "secret".into(),
        }),
    };

    generate(&config).await.unwrap();

    let generated = tokio::fs::read_to_string(runner_dir.join("runner.yaml"))
        .await
        .unwrap();
    assert!(generated.contains("rootfs_disk_mb: 8192"));
    assert!(generated.contains("workspace_disk_mb: 16384"));
    assert!(
        generated
            .lines()
            .all(|line| !line.trim_start().starts_with("disk_mb:"))
    );

    let loaded = load_with_home(&runner_dir.join("runner.yaml"), &fixture.home, true)
        .await
        .unwrap();
    assert_eq!(loaded, config);
}

#[tokio::test]
async fn load_resolves_relative_paths() {
    let dir = tempfile::tempdir().unwrap();

    let sub = dir.path().join("artifacts");
    tokio::fs::create_dir_all(&sub).await.unwrap();
    for name in ["firecracker", "vmlinux"] {
        tokio::fs::write(sub.join(name), b"").await.unwrap();
    }
    let home =
        test_home_with_artifacts(dir.path(), &[(TEST_ROOTFS_HASH, TEST_SNAPSHOT_HASH)]).await;

    let yaml = format!(
        r#"
name: test
group: test/group
base_dir: my-runner
ca_dir: artifacts
firecracker:
  binary: artifacts/firecracker
  kernel: artifacts/vmlinux
profiles:
  vm0/default:
    rootfs_hash: {hash}
    snapshot_hash: {snap_hash}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 16384
"#,
        hash = TEST_ROOTFS_HASH,
        snap_hash = TEST_SNAPSHOT_HASH,
    );

    let config_path = dir.path().join("runner.yaml");
    tokio::fs::write(&config_path, yaml).await.unwrap();

    let config = load_with_home(&config_path, &home, true).await.unwrap();

    assert!(config.base_dir.is_absolute());
    assert_eq!(config.base_dir, dir.path().join("my-runner"));
    assert_eq!(config.ca_dir, sub);
    assert_eq!(config.firecracker.binary, sub.join("firecracker"));
    assert_eq!(config.firecracker.kernel, sub.join("vmlinux"));
}

#[test]
fn factory_config_resolves_paths() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());

    let config = RunnerConfig {
        name: "test".into(),
        group: "test/group".into(),
        base_dir: dir.path().join("runner"),
        ca_dir: dir.path().join("ca"),
        firecracker: FirecrackerConfig {
            binary: dir.path().join("firecracker"),
            kernel: dir.path().join("vmlinux"),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig::default(),
        server: None,
    };

    let profile = &config.profiles["vm0/default"];
    let fc = config.factory_config("vm0/default", profile, &home);

    assert_eq!(fc.binary_path, dir.path().join("firecracker"));
    assert_eq!(fc.kernel_path, dir.path().join("vmlinux"));
    let rootfs_paths = RootfsPaths::new(&home, TEST_ROOTFS_HASH);
    assert_eq!(fc.rootfs_path, rootfs_paths.rootfs());
    assert_eq!(fc.profile, "vm0/default");
    let snap = fc.snapshot.unwrap();
    assert_eq!(snap.hash, TEST_SNAPSHOT_HASH);
    let snapshot_paths = RootfsPaths::new(&home, TEST_ROOTFS_HASH).snapshot(TEST_SNAPSHOT_HASH);
    assert_eq!(snap.output_dir, snapshot_paths.dir().to_path_buf());
}

#[tokio::test]
async fn idle_pool_config_round_trip() {
    let fixture = ConfigFixture::new().await;
    let runner_dir = fixture.path().join("my-runner");
    let config = RunnerConfig {
        name: "test-runner".into(),
        group: "vm0/prod".into(),
        base_dir: runner_dir.clone(),
        ca_dir: fixture.path().to_path_buf(),
        firecracker: FirecrackerConfig {
            binary: fixture.firecracker.clone(),
            kernel: fixture.kernel.clone(),
        },
        profiles: make_profiles(),
        sandbox: SandboxConfig {
            max_concurrent: 4,
            concurrency_factor: 1.5,
            idle_timeout_secs: 600,
            max_idle: 10,
        },
        server: None,
    };

    generate(&config).await.unwrap();

    let loaded = load_with_home(&runner_dir.join("runner.yaml"), &fixture.home, true)
        .await
        .unwrap();
    assert_eq!(loaded.sandbox.idle_timeout_secs, 600);
    assert_eq!(loaded.sandbox.max_idle, 10);
    assert_eq!(loaded, config);
}

#[tokio::test]
async fn idle_pool_defaults_when_omitted() {
    // YAML without any idle pool fields
    let fixture = ConfigFixture::new().await;
    let yaml = fixture.yaml_with_default_profile("");

    let config = fixture.load_config(&yaml, true).await.unwrap();
    assert_eq!(config.sandbox.idle_timeout_secs, DEFAULT_IDLE_TIMEOUT_SECS);
    assert_eq!(config.sandbox.max_idle, 0);
}
