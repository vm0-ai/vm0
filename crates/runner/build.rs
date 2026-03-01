use std::process;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(bundled_guests)");
    let guests = [
        ("GUEST_AGENT_PATH", "BUNDLED_GUEST_AGENT"),
        ("GUEST_DOWNLOAD_PATH", "BUNDLED_GUEST_DOWNLOAD"),
        ("GUEST_INIT_PATH", "BUNDLED_GUEST_INIT"),
        ("GUEST_MOCK_CLAUDE_PATH", "BUNDLED_GUEST_MOCK_CLAUDE"),
    ];

    // Always rebuild when any of these env vars change.
    for (env_var, _) in &guests {
        println!("cargo:rerun-if-env-changed={env_var}");
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
        eprintln!(
            "cargo:warning=partial GUEST_*_PATH env vars: set={set:?}, missing={missing:?} — must set all or none"
        );
        process::exit(1);
    }

    if paths.len() == guests.len() {
        println!("cargo:rustc-cfg=bundled_guests");
        for ((_, bundled_key), (_, raw_path)) in guests.iter().zip(paths.iter()) {
            let abs = match std::fs::canonicalize(raw_path) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("cargo:warning={raw_path}: {e}");
                    process::exit(1);
                }
            };
            let Some(abs_str) = abs.to_str() else {
                eprintln!("cargo:warning=non-UTF-8 path: {}", abs.display());
                process::exit(1);
            };
            println!("cargo:rustc-env={bundled_key}={abs_str}");
            println!("cargo:rerun-if-changed={abs_str}");
        }
    }
}
