//! Content-addressable storage hash — Rust port of the TS implementation at
//! `turbo/apps/api/src/signals/services/storage-content-hash.service.ts`.
//!
//! `version_id` in VAS *is* this hash — the TS function is the sole producer
//! across every prepare/commit route. Guest-side we recompute it locally so
//! the checkpoint step can skip the prepare+commit round-trips when the
//! artifact is unchanged since mount (see issue #10967).
//!
//! The two implementations must stay byte-identical. The inline `#[cfg(test)]`
//! suite below and its TS counterpart in `turbo/apps/api/src/signals/services`
//! hardcode the same fixture vectors — a drift on either side fails CI.

use sha2::{Digest, Sha256};
use thiserror::Error;

const STORAGE_CONTENT_HASH_PREFIX: &[u8] = b"vm0-storage-content-hash-v2\0";

#[derive(Debug, Error, PartialEq)]
pub(crate) enum ContentHashError {
    #[error("content hash field length exceeds u32")]
    FieldLengthTooLarge,
    #[error("file hash must be SHA-256 hex: {0}")]
    InvalidFileHash(#[from] hex::FromHexError),
}

struct CanonicalEntry<'a> {
    path: &'a str,
    hash: [u8; 32],
}

fn update_u32(hasher: &mut Sha256, value: usize) -> Result<(), ContentHashError> {
    let value = u32::try_from(value).map_err(|_| ContentHashError::FieldLengthTooLarge)?;
    hasher.update(value.to_be_bytes());
    Ok(())
}

fn update_length_prefixed_bytes(hasher: &mut Sha256, bytes: &[u8]) -> Result<(), ContentHashError> {
    update_u32(hasher, bytes.len())?;
    hasher.update(bytes);
    Ok(())
}

fn sha256_digest_from_hex(hash: &str) -> Result<[u8; 32], ContentHashError> {
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hash, &mut bytes)?;
    Ok(bytes)
}

/// Compute the content hash for a storage version.
///
/// Format matches the TS reference. The hash input is a v2 canonical byte
/// stream, not delimiter-joined text:
/// - domain/version prefix
/// - u32be storage id byte length + UTF-8 storage id bytes
/// - u32be entry count
/// - for each entry sorted by `(path UTF-8 bytes, file digest bytes)`:
///   - u32be path byte length + UTF-8 path bytes
///   - 32-byte SHA-256 file digest parsed from hex
pub(crate) fn compute_content_hash<'a, I>(
    storage_id: &str,
    files: I,
) -> Result<String, ContentHashError>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut entries: Vec<CanonicalEntry<'a>> = files
        .into_iter()
        .map(|(path, hash)| {
            Ok(CanonicalEntry {
                path,
                hash: sha256_digest_from_hex(hash)?,
            })
        })
        .collect::<Result<_, ContentHashError>>()?;
    entries.sort_by(|a, b| {
        a.path
            .as_bytes()
            .cmp(b.path.as_bytes())
            .then_with(|| a.hash.cmp(&b.hash))
    });

    let mut hasher = Sha256::new();
    hasher.update(STORAGE_CONTENT_HASH_PREFIX);
    update_length_prefixed_bytes(&mut hasher, storage_id.as_bytes())?;
    update_u32(&mut hasher, entries.len())?;
    for entry in entries {
        update_length_prefixed_bytes(&mut hasher, entry.path.as_bytes())?;
        hasher.update(entry.hash);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures below are shared with the TS parity test at
    // `turbo/apps/api/src/signals/services/__tests__/storage-content-hash.service.test.ts`.
    // Any change here must be mirrored there (and vice versa); CI runs both
    // sides, so a drift between TS `computeContentHashFromHashes` and this Rust
    // port fails fast.
    const STORAGE_A: &str = "01234567-89ab-cdef-0123-456789abcdef";
    const STORAGE_B: &str = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    #[test]
    fn empty_files_hashes_v2_canonical_bytes() {
        let got = compute_content_hash(STORAGE_A, std::iter::empty());
        assert_eq!(
            got.as_deref(),
            Ok("afde087ee3ce79ab8360daf49e5f68fe1bbb49153775fff6eff5e7ccd7ecdb57")
        );
    }

    #[test]
    fn single_file() {
        let got = compute_content_hash(STORAGE_A, [("a.txt", HASH_A)]);
        assert_eq!(
            got.as_deref(),
            Ok("b7c8d9f8fe72381faeeeff30bab820e075ff048240f16ccc3ecec23e6ab32918")
        );
    }

    #[test]
    fn multiple_files_sorted_regardless_of_input_order() {
        let got = compute_content_hash(
            STORAGE_A,
            [("b.txt", HASH_B), ("a.txt", HASH_A), ("c.txt", HASH_C)],
        );
        assert_eq!(
            got.as_deref(),
            Ok("4a91b8c9ac9c083131b960cc1d97d25aab243b841e29cbbd187597e6b82d5231")
        );

        let reversed = compute_content_hash(
            STORAGE_A,
            [("c.txt", HASH_C), ("a.txt", HASH_A), ("b.txt", HASH_B)],
        );
        assert_eq!(got, reversed);
    }

    #[test]
    fn delimiter_bearing_paths_have_golden_vectors() {
        let colon = compute_content_hash(STORAGE_A, [("dir:name/file.txt", HASH_A)]);
        assert_eq!(
            colon.as_deref(),
            Ok("24eb7994557105120ffa3f444cb7384d275a9a0e6ffe53d8828366af54375b93")
        );

        let newline = compute_content_hash(STORAGE_A, [("line1\nline2.txt", HASH_A)]);
        assert_eq!(
            newline.as_deref(),
            Ok("26d1a10c31ec4a704d4a76dcb858fb7633495c012624c07b99d31cdbee376740")
        );

        let non_bmp = compute_content_hash(STORAGE_A, [("emoji-😀.txt", HASH_A)]);
        assert_eq!(
            non_bmp.as_deref(),
            Ok("231bec6d6d3c0d8ae2e9d740cf476156aa0fb7d555ccccf3acd033bc784842dd")
        );
    }

    #[test]
    fn different_storage_id_yields_different_hash() {
        let got = compute_content_hash(STORAGE_B, std::iter::empty());
        assert_eq!(
            got.as_deref(),
            Ok("2fc5c81fee486da6a906b4c3e2d0036c3580784963a75521d817b4c54b055da7")
        );
    }

    #[test]
    fn file_hash_casing_is_canonicalized() {
        let lowercase = compute_content_hash(STORAGE_A, [("a.txt", HASH_A)]);
        let uppercase_hash = HASH_A.to_uppercase();
        let uppercase = compute_content_hash(STORAGE_A, [("a.txt", uppercase_hash.as_str())]);
        assert_eq!(lowercase, uppercase);
    }

    #[test]
    fn old_text_format_collision_inputs_are_separated() {
        let hash_1 = "1111111111111111111111111111111111111111111111111111111111111111";
        let hash_2 = "2222222222222222222222222222222222222222222222222222222222222222";

        let first = compute_content_hash(STORAGE_A, [("a", hash_1), ("b", hash_2)]);
        let colliding_path = format!("a:{hash_1}\nb");
        let second = compute_content_hash(STORAGE_A, [(colliding_path.as_str(), hash_2)]);

        assert_eq!(
            first.as_deref(),
            Ok("49ebfcd2f3a4d5050ab39c789f5bed874014ebae3efa9cc08af3c79db5ab8def")
        );
        assert_eq!(
            second.as_deref(),
            Ok("365babcde9af438dbba697ccfec0260f7a704785e481a4842cfaaf0468eb68b5")
        );
        assert_ne!(first, second);
    }
}
