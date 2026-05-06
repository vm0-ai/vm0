// Build scripts are compile-time only — panic/expect/unwrap are appropriate for fatal errors.
#![allow(clippy::panic, clippy::expect_used, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    println!("cargo::rustc-check-cfg=cfg(bundled_guests)");

    // Rebuild when embedded files change (include_str! tracks deps for rustc,
    // but CI artifact caches may not — explicit rerun-if-changed ensures correctness).
    println!("cargo::rerun-if-changed=scripts/build-template.sh");
    println!("cargo::rerun-if-changed=scripts/customize-rootfs.sh");
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
        ("GUEST_MOCK_CODEX_PATH", "BUNDLED_GUEST_MOCK_CODEX"),
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

/// Recursively scan `mitm-addon/src/**` and generate `addon_files.rs` with all
/// addon-runtime file contents embedded via `include_str!()`. Keys are paths
/// relative to `src/` (e.g. `"usage/counters.py"`) so the runtime extractor can
/// recreate the directory structure. Adding a new file — at any depth — requires
/// zero Rust changes.
///
/// Files picked up:
///
/// - `*.py` — Python addon source consumed by mitmdump at runtime.
/// - `LICENSE*`, `COPYING*`, `NOTICE*` — license / attribution files from
///   vendored third-party packages (e.g. `vendor/ijson/LICENSE.txt`).
///   Required to ship with the binary to satisfy BSD-3-Clause §2, Apache-2.0
///   §4(d), etc.  Extracting them at `{addon_dir}/vendor/*/LICENSE*` alongside
///   the code keeps the source and its license physically co-located both in
///   the binary and on disk.
fn generate_addon_files() {
    let src_dir = PathBuf::from("mitm-addon/src");

    // Rebuild when any file in the directory tree changes (additions/deletions).
    println!("cargo::rerun-if-changed={}", src_dir.display());

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    collect_addon_files(&src_dir, &src_dir, &mut entries);

    // Sort by relative path for deterministic output (multiple `__init__.py`
    // entries share a basename but differ by directory).
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from("const ADDON_FILES: &[(&str, &str)] = &[\n");
    for (rel, abs) in &entries {
        // Use forward slashes for include_str! paths (works on all platforms).
        let path_str = abs.display().to_string().replace('\\', "/");
        code.push_str(&format!("    (\"{rel}\", include_str!(\"{path_str}\")),\n"));
    }
    code.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("addon_files.rs"), code).unwrap();
}

fn collect_addon_files(root: &Path, cur: &Path, out: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(cur).unwrap_or_else(|e| panic!("read {}: {e}", cur.display())) {
        let path = entry.unwrap().path();
        if path.is_dir() {
            // Skip Python byte-cache / venv directories that may appear during
            // local test runs — the addon image must not ship compiled caches.
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "__pycache__" || name.starts_with('.') {
                continue;
            }
            collect_addon_files(root, &path, out);
            continue;
        }
        if should_embed(&path) {
            let abs = fs::canonicalize(&path)
                .unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()));
            println!("cargo::rerun-if-changed={}", abs.display());
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, abs));
        }
    }
}

/// Decide whether a file under `mitm-addon/src/` ships with the runner binary.
///
/// Accepts `.py` (addon sources) and the conventional license / attribution
/// filenames used by third-party packages (e.g. vendored ijson's
/// `LICENSE.txt`).  `include_str!` requires valid UTF-8, which all of these
/// always are in practice.
fn should_embed(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "py") {
        return true;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.starts_with("LICENSE") || name.starts_with("COPYING") || name.starts_with("NOTICE")
}
