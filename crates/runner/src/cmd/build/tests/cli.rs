use super::fixtures::*;
use super::*;

#[test]
fn build_args_parse_warm_rootfs_cache_flag() {
    let mut args = build_args().to_vec();
    args.push("--warm-rootfs-cache");

    let cli = <TestBuildCli as clap::Parser>::try_parse_from(args).unwrap();

    assert!(cli.args.warm_rootfs_cache);
    assert!(!cli.args.dry_run);
    assert_eq!(BuildMode::from_args(&cli.args), BuildMode::WarmRootfsCache);
}

#[test]
fn build_args_parse_warm_rootfs_cache_without_guest_binaries() {
    let cli = <TestBuildCli as clap::Parser>::try_parse_from([
        "runner-build",
        "--profile",
        "vm0/default",
        "--warm-rootfs-cache",
    ])
    .unwrap();

    assert_eq!(BuildMode::from_args(&cli.args), BuildMode::WarmRootfsCache);
    assert!(cli.args.guest_agent.is_none());
    assert!(cli.args.guest_download.is_none());
    assert!(cli.args.guest_init.is_none());
    assert!(cli.args.guest_mock_claude.is_none());
    assert!(cli.args.guest_mock_codex.is_none());
    assert!(cli.args.guest_reseed.is_none());
    assert!(cli.args.guest_write_file.is_none());
}

#[test]
fn build_mode_defaults_to_full_image() {
    let cli = <TestBuildCli as clap::Parser>::try_parse_from(build_args()).unwrap();

    assert_eq!(BuildMode::from_args(&cli.args), BuildMode::FullImage);
}

#[test]
fn required_warm_cache_requires_r2_config() {
    let err = TemplateCache::from_optional(BuildMode::WarmRootfsCache, None).unwrap_err();

    assert!(
        err.to_string()
            .contains("--warm-rootfs-cache requires all R2_*")
    );
}
