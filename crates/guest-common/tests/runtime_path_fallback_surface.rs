use std::path::Path;

#[test]
fn log_and_telemetry_do_not_reintroduce_runtime_path_env_fallbacks() -> std::io::Result<()> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let log_rs = read_source(manifest_dir, "src/log.rs")?;
    let telemetry_rs = read_source(manifest_dir, "src/telemetry.rs")?;

    assert_no_fallback_surface(&log_rs, "src/log.rs");
    assert_no_fallback_surface(&telemetry_rs, "src/telemetry.rs");

    Ok(())
}

fn read_source(manifest_dir: &Path, relative_path: &str) -> Result<String, std::io::Error> {
    let path = manifest_dir.join(relative_path);
    std::fs::read_to_string(&path).map_err(|error| {
        std::io::Error::new(error.kind(), format!("read {}: {error}", path.display()))
    })
}

fn assert_no_fallback_surface(source: &str, label: &str) {
    let source = non_comment_lines(source).collect::<Vec<_>>().join("\n");
    assert!(
        !source.contains("static RUN_ID"),
        "{label} must not cache VM0_RUN_ID in process-global state"
    );
    assert!(
        !source.contains("RUN_ID_ENV"),
        "{label} must not read VM0_RUN_ID to derive runtime log paths"
    );
    assert!(
        !source.contains("run_dir_from_env"),
        "{label} must not derive runtime log paths from process env"
    );
    assert!(
        !source.contains("enable_system_log_file"),
        "{label} must not expose env-derived system log setup"
    );

    let compact_source = source
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    assert!(
        !compact_source.contains("fnsandbox_ops_log()"),
        "{label} must not expose env-derived sandbox ops path lookup"
    );
}

fn non_comment_lines(source: &str) -> impl Iterator<Item = &str> {
    source
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with("//"))
}
