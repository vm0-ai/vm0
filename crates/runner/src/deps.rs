//! Third-party dependency metadata: versions, checksums, and download URLs.

pub const FIRECRACKER_VERSION: &str = "v1.14.1";
pub const KERNEL_VERSION: &str = "6.1.155";
pub const MITMPROXY_VERSION: &str = "12.2.1";

// SHA256 checksums for installed artifacts, keyed by arch.
pub const FIRECRACKER_SHA256_X86_64: &str =
    "ef68f03e2dcaa4c07347a4b11989bedb350c982e62da7a3f74bc40f4f840e0ce";
pub const FIRECRACKER_SHA256_AARCH64: &str =
    "d1bc4cbd166a3b572cdb55019634aed48a5426e2253f126b18654596367d2bf4";
pub const KERNEL_SHA256_X86_64: &str =
    "e41c7048bd2475e7e788153823fcb9166a7e0b78c4c443bd6446d015fa735f53";
pub const KERNEL_SHA256_AARCH64: &str =
    "61baeae1ac6197be4fc5c71fa78df266acdc33c54570290d2f611c2b42c105be";
pub const MITMDUMP_SHA256_X86_64: &str =
    "0adfd86a006b593dce745b989f305f14acd94edadf7f998b6985555b44838167";
pub const MITMDUMP_SHA256_AARCH64: &str =
    "48fb2cd30945f03faa5cc2797dd6e5762f09ebe8754da87ac8c372dc82e694df";

/// "v1.14.1" → "v1.14"
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
