//! Content-addressable storage hash — Rust port of the TS implementation
//! at `turbo/apps/web/src/lib/infra/storage/content-hash.ts`.
//!
//! `version_id` in VAS *is* this hash — the TS function is the sole producer
//! across every prepare/commit route. Guest-side we recompute it locally so
//! the checkpoint step can skip the prepare+commit round-trips when the
//! artifact is unchanged since mount (see issue #10967).
//!
//! The two implementations must stay byte-identical. The inline `#[cfg(test)]`
//! suite below and its TS counterpart at
//! `turbo/apps/web/src/lib/infra/storage/__tests__/content-hash-parity.test.ts`
//! hardcode the same fixture vectors — a drift on either side fails CI.

use sha2::{Digest, Sha256};

/// Compute the content hash for a storage version.
///
/// Format matches the TS reference:
/// - empty files: `sha256("storage:<id>\n")`
/// - non-empty: `sha256("storage:<id>\n<path>:<hash>\n<path>:<hash>…")`
///   with entries sorted lexicographically.
///
/// The Rust byte-wise sort agrees with JS's default `Array.sort()` for any
/// BMP code points (UTF-8 byte order and UTF-16 code-unit order coincide
/// there). Non-BMP characters in a file path are the only theoretical
/// divergence and are not present in current VAS-backed workloads.
pub(crate) fn compute_content_hash<'a, I>(storage_id: &str, files: I) -> String
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut entries: Vec<String> = files
        .into_iter()
        .map(|(path, hash)| format!("{path}:{hash}"))
        .collect();

    let mut hasher = Sha256::new();
    if entries.is_empty() {
        hasher.update(format!("storage:{storage_id}\n").as_bytes());
    } else {
        entries.sort();
        let combined = format!("storage:{storage_id}\n{}", entries.join("\n"));
        hasher.update(combined.as_bytes());
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures below are shared with the TS parity test at
    // `turbo/apps/web/src/lib/infra/storage/__tests__/content-hash-parity.test.ts`.
    // Any change here must be mirrored there (and vice versa); CI runs both
    // sides, so a drift between TS `computeContentHashFromHashes` and this
    // Rust port fails fast.
    const STORAGE_A: &str = "01234567-89ab-cdef-0123-456789abcdef";
    const STORAGE_B: &str = "ffffffff-ffff-ffff-ffff-ffffffffffff";

    #[test]
    fn empty_files_hashes_storage_prefix_only() {
        let got = compute_content_hash(STORAGE_A, std::iter::empty());
        assert_eq!(
            got,
            "4c679c352da0ad578c21cc413e4afa83c32d467424725129795dda25d1c5ea4e"
        );
    }

    #[test]
    fn single_file() {
        let got = compute_content_hash(STORAGE_A, [("a.txt", "deadbeef")]);
        assert_eq!(
            got,
            "3d7165d60d7fd53858323feb1cc04b0116aee77858b4aea45beba855f7816fc0"
        );
    }

    #[test]
    fn multiple_files_sorted_regardless_of_input_order() {
        let got = compute_content_hash(
            STORAGE_A,
            [("b.txt", "222"), ("a.txt", "111"), ("c.txt", "333")],
        );
        assert_eq!(
            got,
            "384d77579354ce230d8a7465343e1530e2561eab48a94d63e0bf80f90307e24c"
        );
    }

    #[test]
    fn different_storage_id_yields_different_hash() {
        let got = compute_content_hash(STORAGE_B, std::iter::empty());
        assert_eq!(
            got,
            "d87bf91de459004a9512e649c3484a8ced316fe5547149ec3f6b6ae669ac79ff"
        );
    }

    #[test]
    fn nested_paths_sort_lexicographically() {
        let got = compute_content_hash(
            STORAGE_A,
            [
                ("src/main.rs", "bbb"),
                ("README.md", "ccc"),
                ("src/lib.rs", "aaa"),
            ],
        );
        assert_eq!(
            got,
            "e7158d0cbdae3793daa8352a6197eab9f772d8cb8784c941d921e81f5d4b09d6"
        );
    }
}
