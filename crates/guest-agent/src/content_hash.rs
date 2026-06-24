//! Content-addressable storage hash — Rust port of the TS implementation
//! at `turbo/apps/api/src/signals/services/storage-content-hash.service.ts`.
//!
//! `version_id` in VAS *is* this hash — the TS function is the sole producer
//! across every prepare/commit route. Guest-side we recompute it locally so
//! the checkpoint step can skip the prepare+commit round-trips when the
//! artifact is unchanged since mount (see issue #10967).
//!
//! The two implementations must stay byte-identical. The inline `#[cfg(test)]`
//! suite below hardcodes fixture vectors for the Rust port; changes here must
//! be checked against TS `computeContentHashFromHashes`.

use sha2::{Digest, Sha256};
use std::cmp::Ordering;

#[derive(Clone, Copy)]
struct ContentHashEntry<'a> {
    path: &'a str,
    hash: &'a str,
}

/// Compute the content hash for a storage version.
///
/// Format matches the TS reference:
/// - empty files: `sha256("storage:<id>\n")`
/// - non-empty: `sha256("storage:<id>\n<path>:<hash>\n<path>:<hash>…")`
///   with formatted entries sorted like JS's default `Array.sort()`.
///
/// JS default string sorting compares UTF-16 code units. Rust must mirror that
/// rule exactly, then still hash the selected formatted entries as UTF-8 bytes.
pub(crate) fn compute_content_hash<'a, I>(storage_id: &str, files: I) -> String
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut entries: Vec<ContentHashEntry<'a>> = files
        .into_iter()
        .map(|(path, hash)| ContentHashEntry { path, hash })
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(b"storage:");
    hasher.update(storage_id.as_bytes());
    hasher.update(b"\n");

    if !entries.is_empty() {
        entries.sort_by(|left, right| compare_formatted_entries(*left, *right));
        for (index, entry) in entries.iter().enumerate() {
            if index > 0 {
                hasher.update(b"\n");
            }
            hasher.update(entry.path.as_bytes());
            hasher.update(b":");
            hasher.update(entry.hash.as_bytes());
        }
    }

    hex::encode(hasher.finalize())
}

fn compare_formatted_entries(left: ContentHashEntry<'_>, right: ContentHashEntry<'_>) -> Ordering {
    let mut left_code_units = formatted_entry_code_units(left);
    let mut right_code_units = formatted_entry_code_units(right);

    loop {
        match (left_code_units.next(), right_code_units.next()) {
            (Some(left), Some(right)) => match left.cmp(&right) {
                Ordering::Equal => {}
                ordering => return ordering,
            },
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }
}

fn formatted_entry_code_units<'a>(entry: ContentHashEntry<'a>) -> impl Iterator<Item = u16> + 'a {
    entry
        .path
        .encode_utf16()
        .chain(std::iter::once(u16::from(b':')))
        .chain(entry.hash.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures below must stay aligned with TS `computeContentHashFromHashes` at
    // `turbo/apps/api/src/signals/services/storage-content-hash.service.ts`.
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

    #[test]
    fn colon_paths_sort_like_formatted_entries() {
        let got = compute_content_hash(STORAGE_A, [("a", "b:1"), ("a:b", "0")]);

        assert_eq!(
            got,
            sha256_hex(&format!("storage:{STORAGE_A}\na:b:0\na:b:1"))
        );
        assert_ne!(
            got,
            sha256_hex(&format!("storage:{STORAGE_A}\na:b:1\na:b:0"))
        );
    }

    #[test]
    fn non_bmp_paths_sort_like_javascript_default_string_sort() {
        let got = compute_content_hash(
            STORAGE_A,
            [("\u{E000}.txt", "222"), ("\u{1F4A9}.txt", "111")],
        );

        assert_eq!(
            got,
            "537ee6d2902093ce26bea40719e1236c99f1d5394e26445cfe9cd6d9ae228f61"
        );
        assert_ne!(
            got,
            "ca324bd07923a77d854946f3977a7fe57c5078d64f393a98e0c6e2b5dc4a30f0"
        );
    }

    fn sha256_hex(input: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        hex::encode(hasher.finalize())
    }
}
