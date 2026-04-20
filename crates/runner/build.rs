// Build scripts are compile-time only — panic/expect/unwrap are appropriate for fatal errors.
#![allow(clippy::panic, clippy::expect_used, clippy::unwrap_used)]

use std::path::PathBuf;
use std::{env, fs};

fn main() {
    println!("cargo::rustc-check-cfg=cfg(bundled_guests)");

    // Rebuild when embedded files change (include_str! tracks deps for rustc,
    // but CI artifact caches may not — explicit rerun-if-changed ensures correctness).
    println!("cargo::rerun-if-changed=scripts/build-rootfs.sh");
    println!("cargo::rerun-if-changed=scripts/verify-rootfs.sh");

    generate_addon_files();

    // Build scripts run with cwd=CARGO_MANIFEST_DIR (crates/runner/), but
    // GUEST_*_PATH values are relative to the workspace root (crates/).
    // Resolve relative paths against the workspace root so canonicalize works.
    let workspace_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR should have a parent")
        .to_path_buf();

    let guests = [
        ("GUEST_AGENT_PATH", "BUNDLED_GUEST_AGENT"),
        ("GUEST_DOWNLOAD_PATH", "BUNDLED_GUEST_DOWNLOAD"),
        ("GUEST_INIT_PATH", "BUNDLED_GUEST_INIT"),
        ("GUEST_MOCK_CLAUDE_PATH", "BUNDLED_GUEST_MOCK_CLAUDE"),
        ("GUEST_RESEED_PATH", "BUNDLED_GUEST_RESEED"),
    ];

    // Always rebuild when any of these env vars change.
    for (env_var, _) in &guests {
        println!("cargo::rerun-if-env-changed={env_var}");
    }

    // All-or-nothing: either all GUEST_*_PATH vars are set, or none.
    let paths: Vec<_> = guests
        .iter()
        .filter_map(|(env_var, _)| std::env::var(env_var).ok().map(|v| (*env_var, v)))
        .collect();

    if !paths.is_empty() && paths.len() != guests.len() {
        let set: Vec<_> = paths.iter().map(|(k, _)| *k).collect();
        let missing: Vec<_> = guests
            .iter()
            .filter(|(k, _)| !set.contains(k))
            .map(|(k, _)| *k)
            .collect();
        panic!(
            "partial GUEST_*_PATH env vars: set={set:?}, missing={missing:?} — must set all or none"
        );
    }

    if paths.len() == guests.len() {
        println!("cargo::rustc-cfg=bundled_guests");
        for ((_, bundled_key), (_, raw_path)) in guests.iter().zip(paths.iter()) {
            let resolved = if std::path::Path::new(raw_path).is_relative() {
                workspace_root.join(raw_path)
            } else {
                PathBuf::from(raw_path)
            };
            let abs = std::fs::canonicalize(&resolved)
                .unwrap_or_else(|e| panic!("{raw_path} (resolved to {}): {e}", resolved.display()));
            let abs_str = abs
                .to_str()
                .unwrap_or_else(|| panic!("non-UTF-8 path: {}", abs.display()));
            println!("cargo::rustc-env={bundled_key}={abs_str}");
            println!("cargo::rerun-if-changed={abs_str}");
        }
    }
}

/// Scan `mitm-addon/src/*.py` and generate `addon_files.rs` with all file contents
/// embedded via `include_str!()`. Adding a new `.py` file requires zero Rust changes.
fn generate_addon_files() {
    let src_dir = PathBuf::from("mitm-addon/src");

    // Rebuild when any file in the directory changes (additions/deletions).
    println!("cargo::rerun-if-changed={}", src_dir.display());

    let mut entries: Vec<(String, PathBuf)> = fs::read_dir(&src_dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", src_dir.display()))
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "py") {
                let name = path.file_name().unwrap().to_str().unwrap().to_string();
                let abs = fs::canonicalize(&path)
                    .unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()));
                println!("cargo::rerun-if-changed={}", abs.display());
                Some((name, abs))
            } else {
                None
            }
        })
        .collect();

    // Sort for deterministic output.
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from("const ADDON_FILES: &[(&str, &str)] = &[\n");
    for (name, abs) in &entries {
        // Use forward slashes for include_str! paths (works on all platforms).
        let path_str = abs.display().to_string().replace('\\', "/");
        code.push_str(&format!(
            "    (\"{name}\", include_str!(\"{path_str}\")),\n"
        ));
    }
    code.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("addon_files.rs"), code).unwrap();
}
