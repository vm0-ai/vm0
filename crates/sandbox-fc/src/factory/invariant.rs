use sha2::{Digest, Sha256};

use crate::network::{GUEST_NETWORK, generate_boot_args};

/// Shell command executed during snapshot creation to pre-warm guest state.
/// Changing this invalidates all cached snapshots (included in [`config_hash`]).
///
/// **Note:** Do NOT wrap this in `su - user -c '...'` — the vsock-guest exec
/// handler already wraps commands with `su - user -c` in release builds.
/// Double-wrapping creates nested sessions where inner processes escape the
/// process group, surviving SIGKILL on timeout as orphans frozen into the
/// snapshot.
///
/// - `claude --print --verbose --output-format stream-json hi`:
///   exercises the full CLI initialization path matching the real guest-agent
///   invocation (module loading, config parsing, API client setup) so all
///   relevant memory pages are captured in the snapshot. Fails with
///   "Invalid API key" but still loads the complete module graph. The claude
///   binary is a Bun-compiled executable (not Node.js), so
///   `NODE_COMPILE_CACHE` has no effect.
/// - `codex --help`: codex ships as a Node.js CLI (npm `@openai/codex`); the
///   `--help` path exits cleanly without credentials yet `require`s the full
///   module graph and triggers V8 JIT compilation, so the resolved-and-parsed
///   bytecode is captured in the snapshot. Each warmup is wrapped in its own
///   `(... || true)` sub-shell so a failure on one framework does not block
///   the other from warming.
pub const PREWARM_SCRIPT: &str = "\
    (claude --print --verbose --output-format stream-json hi 2>/dev/null || true); \
    (codex --help >/dev/null 2>&1 || true)";

/// Balloon device configuration (invariant across all sandboxes).
#[derive(serde::Serialize)]
pub struct BalloonConfig {
    pub amount_mib: u32,
    pub deflate_on_oom: bool,
    pub stats_polling_interval_s: u32,
}

/// Invariant configuration shared by all sandboxes.
///
/// These parameters affect snapshot output and are used by:
/// - [`config_hash`] — deterministic fingerprint for snapshot cache invalidation
/// - [`crate::sandbox::FirecrackerSandbox::build_config`] — fresh boot JSON configuration
/// - Snapshot creation API calls in `snapshot.rs`
///
/// Adding a field here automatically changes the config hash (via `Serialize`)
/// and makes it available to all consumers.
///
/// **Important:** `serde_json` serializes struct fields in declaration order.
/// Reordering fields changes the hash and invalidates all cached snapshots.
#[derive(serde::Serialize)]
pub struct InvariantConfig {
    pub boot_args: String,
    pub guest_mac: &'static str,
    pub tap_name: &'static str,
    /// TAP MAC used in netns setup for ARP. Not in the Firecracker config JSON,
    /// but affects snapshot behavior (guest ARP cache is baked into the snapshot).
    pub tap_mac: &'static str,
    pub iface_id: &'static str,
    pub guest_cid: u32,
    pub balloon: BalloonConfig,
    pub prewarm_script: &'static str,
    /// Drive layout identifier. Changing the number or type of drives
    /// requires a new snapshot — bump this constant to invalidate the
    /// config hash and force re-creation.
    pub drive_layout: &'static str,
}

impl InvariantConfig {
    pub fn new() -> Self {
        Self {
            boot_args: generate_boot_args(),
            guest_mac: GUEST_NETWORK.guest_mac,
            tap_name: GUEST_NETWORK.tap_name,
            tap_mac: GUEST_NETWORK.tap_mac,
            iface_id: "eth0",
            guest_cid: 3,
            balloon: BalloonConfig {
                amount_mib: 0,
                deflate_on_oom: true,
                stats_polling_interval_s: 5,
            },
            prewarm_script: PREWARM_SCRIPT,
            drive_layout: "nbd-cow-workspace-v1",
        }
    }
}

/// SHA-256 fingerprint of all sandbox-fc internal configuration that affects
/// snapshot output.
///
/// Derived from `InvariantConfig` serialization — adding a field to that
/// struct automatically changes this hash.
///
/// This is the backing implementation for [`sandbox::SandboxFactory::config_hash`].
/// It is also available as a free function so callers that don't have a
/// factory instance (e.g. the snapshot subcommand) can compute the hash.
/// # Panics
/// Cannot panic — `InvariantConfig` contains only primitives and `String`.
#[allow(clippy::expect_used)]
pub fn config_hash() -> String {
    let config = InvariantConfig::new();
    let json = serde_json::to_string(&config).expect("serialize invariant config");
    hex::encode(Sha256::digest(json.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_hash_is_deterministic() {
        let h1 = config_hash();
        let h2 = config_hash();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn prewarm_script_warms_both_frameworks() {
        assert!(
            PREWARM_SCRIPT.contains("claude"),
            "PREWARM_SCRIPT must warm the claude CLI"
        );
        assert!(
            PREWARM_SCRIPT.contains("codex"),
            "PREWARM_SCRIPT must warm the codex CLI"
        );
    }

    #[test]
    fn invariant_config_has_all_expected_fields() {
        let config = InvariantConfig::new();
        let json = serde_json::to_value(&config).unwrap();
        let obj = json.as_object().unwrap();

        // Guard against accidental field additions/removals that would
        // silently change the config hash and invalidate all snapshots.
        let expected_fields = [
            "boot_args",
            "guest_mac",
            "tap_name",
            "tap_mac",
            "iface_id",
            "guest_cid",
            "balloon",
            "prewarm_script",
            "drive_layout",
        ];
        for field in &expected_fields {
            assert!(obj.contains_key(*field), "missing field: {field}");
        }
        assert_eq!(
            obj.len(),
            expected_fields.len(),
            "unexpected field count — adding/removing fields changes the config hash"
        );
    }

    #[test]
    fn config_hash_matches_snapshot_provider_trait() {
        let provider = crate::FirecrackerSnapshotProvider;
        let trait_hash = sandbox::SnapshotProvider::config_hash(&provider);
        let direct_hash = config_hash();
        assert_eq!(trait_hash, direct_hash);
    }
}
