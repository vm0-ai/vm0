//! Third-party dependency metadata: versions, checksums, and download URLs.

pub const FIRECRACKER_VERSION: &str = "v1.15.1";
pub const KERNEL_VERSION: &str = "6.1.155";
/// Canonical mitmproxy release for runner artifacts and the embedded add-on.
pub const MITMPROXY_VERSION: &str = "12.2.3";

// Exact identities for installed artifacts, keyed by arch.
pub const FIRECRACKER_SIZE_X86_64: u64 = 3_417_392;
pub const FIRECRACKER_SIZE_AARCH64: u64 = 3_119_984;
pub const FIRECRACKER_SHA256_X86_64: &str =
    "7e8b57e88c459396d4680d83dcdd8c7f72305447cb55b11f4ac98ad70a3f7825";
pub const FIRECRACKER_SHA256_AARCH64: &str =
    "e9ce7466c3b0d879d7a9158f4bf710dd5e131bbc5e580e5269fec66d5b5a0f0a";
pub const KERNEL_SIZE_X86_64: u64 = 44_279_576;
pub const KERNEL_SIZE_AARCH64: u64 = 17_111_552;
pub const KERNEL_SHA256_X86_64: &str =
    "e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2";
pub const KERNEL_SHA256_AARCH64: &str =
    "e3544b10603acbf3db492cb52e000d22ba202cb4b63b9add027565683e11c591";
pub const MITMDUMP_SIZE_X86_64: u64 = 39_172_624;
pub const MITMDUMP_SIZE_AARCH64: u64 = 36_908_488;
pub const MITMDUMP_SHA256_X86_64: &str =
    "8466d978a58317cd267b91a9dae84b0c4fb630c299515849a52744d34e9e04cf";
pub const MITMDUMP_SHA256_AARCH64: &str =
    "47612c592db3b0b80164aee2dd1be1f3841d5430891f7ebeabf2284a7cc490b9";

// Exact identities for compressed source archives, keyed by arch.
pub const FIRECRACKER_ARCHIVE_SIZE_X86_64: u64 = 7_622_285;
pub const FIRECRACKER_ARCHIVE_SIZE_AARCH64: u64 = 7_422_699;
pub const FIRECRACKER_ARCHIVE_SHA256_X86_64: &str =
    "d4a32ab2322d887ca1bc4a4e7afa9cc35393e6362dfc2b3becb389d362e4275a";
pub const FIRECRACKER_ARCHIVE_SHA256_AARCH64: &str =
    "00654ac1e702a22744121ea9f10a4f792ebd7c3a744cba587dfac9fcb79b41a5";
pub const MITMPROXY_ARCHIVE_SIZE_X86_64: u64 = 119_209_168;
pub const MITMPROXY_ARCHIVE_SIZE_AARCH64: u64 = 112_694_307;
pub const MITMPROXY_ARCHIVE_SHA256_X86_64: &str =
    "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5";
pub const MITMPROXY_ARCHIVE_SHA256_AARCH64: &str =
    "b358643a6c4f4b39e33d985350f660b724fece95687d7daa899ef0c4e211f681";

/// System CA certificate bundle path. The standalone mitmproxy binary bundles its
/// own (incomplete) certifi CA store; we override it with the host's system store.
pub const SYSTEM_CA_BUNDLE: &str = "/etc/ssl/certs/ca-certificates.crt";

/// "v1.15.1" → "v1.15"
const FIRECRACKER_MINOR: &str = strip_patch(FIRECRACKER_VERSION);

#[allow(clippy::panic, clippy::indexing_slicing)] // compile-time only
const fn strip_patch(version: &str) -> &str {
    let bytes = version.as_bytes();
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        if bytes[i] == b'.' {
            // SAFETY: splitting a UTF-8 str at an ASCII '.' boundary yields valid UTF-8
            return unsafe {
                std::str::from_utf8_unchecked(std::slice::from_raw_parts(bytes.as_ptr(), i))
            };
        }
    }
    panic!("FIRECRACKER_VERSION must be in vMAJOR.MINOR.PATCH format")
}

/// Tarball entry name for firecracker binary.
pub fn firecracker_tar_entry(arch: &str) -> String {
    format!("firecracker-{FIRECRACKER_VERSION}-{arch}")
}

pub fn firecracker_url(arch: &str) -> String {
    format!(
        "https://github.com/firecracker-microvm/firecracker/releases/download/{FIRECRACKER_VERSION}/firecracker-{FIRECRACKER_VERSION}-{arch}.tgz"
    )
}

pub fn kernel_url(arch: &str) -> String {
    format!(
        "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/{FIRECRACKER_MINOR}/{arch}/vmlinux-{KERNEL_VERSION}"
    )
}

/// Tarball entry name for mitmdump binary.
pub const MITMDUMP_TAR_ENTRY: &str = "mitmdump";

pub fn mitmdump_url(arch: &str) -> String {
    format!(
        "https://downloads.mitmproxy.org/{MITMPROXY_VERSION}/mitmproxy-{MITMPROXY_VERSION}-linux-{arch}.tar.gz"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MITMPROXY_COMPAT_SOURCE: &str = include_str!("../mitm-addon/src/mitmproxy_compat.py");
    const MITM_ADDON_PYPROJECT: &str = include_str!("../mitm-addon/pyproject.toml");

    fn quoted_values<'a>(source: &'a str, prefix: &str, suffix: &str) -> Vec<&'a str> {
        source
            .lines()
            .filter_map(|line| line.strip_prefix(prefix)?.strip_suffix(suffix))
            .collect()
    }

    #[test]
    fn strip_patch_version() {
        assert_eq!(FIRECRACKER_MINOR, "v1.15");
    }

    #[test]
    fn url_functions_include_arch() {
        // Verify arch substitution works (not just substring presence)
        assert_ne!(firecracker_url("x86_64"), firecracker_url("aarch64"));
        assert_ne!(kernel_url("x86_64"), kernel_url("aarch64"));
        assert_ne!(mitmdump_url("x86_64"), mitmdump_url("aarch64"));
        assert_ne!(
            firecracker_tar_entry("x86_64"),
            firecracker_tar_entry("aarch64")
        );
    }

    #[test]
    fn sha256_checksums_are_valid_hex() {
        for sha in [
            FIRECRACKER_SHA256_X86_64,
            FIRECRACKER_SHA256_AARCH64,
            FIRECRACKER_ARCHIVE_SHA256_X86_64,
            FIRECRACKER_ARCHIVE_SHA256_AARCH64,
            KERNEL_SHA256_X86_64,
            KERNEL_SHA256_AARCH64,
            MITMDUMP_SHA256_X86_64,
            MITMDUMP_SHA256_AARCH64,
            MITMPROXY_ARCHIVE_SHA256_X86_64,
            MITMPROXY_ARCHIVE_SHA256_AARCH64,
        ] {
            assert_eq!(sha.len(), 64, "SHA256 hex should be 64 chars: {sha}");
            assert!(
                sha.chars().all(|c| c.is_ascii_hexdigit()),
                "SHA256 should be valid hex: {sha}"
            );
        }
    }

    #[test]
    fn mitmproxy_version_contract_matches_python_runtime_and_tests() {
        let runtime_versions = quoted_values(
            MITMPROXY_COMPAT_SOURCE,
            "_SUPPORTED_MITMPROXY_VERSION = \"",
            "\"",
        );
        assert_eq!(
            runtime_versions.as_slice(),
            &[MITMPROXY_VERSION],
            "mitmproxy runtime guard must contain exactly one version matching MITMPROXY_VERSION"
        );

        let test_versions = quoted_values(MITM_ADDON_PYPROJECT, "    \"mitmproxy==", "\",");
        assert_eq!(
            test_versions.as_slice(),
            &[MITMPROXY_VERSION],
            "mitmproxy test dependencies must contain exactly one version matching MITMPROXY_VERSION"
        );
    }
}
