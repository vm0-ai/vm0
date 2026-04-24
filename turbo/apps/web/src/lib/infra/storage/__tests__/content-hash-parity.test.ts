import { describe, it, expect } from "vitest";
import { computeContentHashFromHashes } from "../content-hash";

/**
 * Lockstep parity vectors with the Rust guest-agent port at
 * `crates/guest-agent/src/content_hash.rs`. Both sides run the *same* inputs
 * through their respective implementations and assert the *same* hex output.
 *
 * If the TS producer changes shape (prefix, separator, sort, encoding) without
 * a matching change on the Rust side, the guest-side skip check in
 * `checkpoint::snapshot_artifacts` will silently disagree with the version_id
 * VAS actually assigns — every snapshot would then be uploaded unnecessarily,
 * or worse, a matching hash would fail to match. Keeping the vectors mirrored
 * in both test suites turns that drift into a CI failure on whichever side
 * diverged first.
 */
describe("content-hash TS↔Rust parity", () => {
  const STORAGE_A = "01234567-89ab-cdef-0123-456789abcdef";
  const STORAGE_B = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  it("empty files hashes storage prefix only", () => {
    expect(computeContentHashFromHashes(STORAGE_A, [])).toBe(
      "4c679c352da0ad578c21cc413e4afa83c32d467424725129795dda25d1c5ea4e",
    );
  });

  it("single file", () => {
    expect(
      computeContentHashFromHashes(STORAGE_A, [
        { path: "a.txt", hash: "deadbeef", size: 0 },
      ]),
    ).toBe("3d7165d60d7fd53858323feb1cc04b0116aee77858b4aea45beba855f7816fc0");
  });

  it("multiple files sorted regardless of input order", () => {
    expect(
      computeContentHashFromHashes(STORAGE_A, [
        { path: "b.txt", hash: "222", size: 0 },
        { path: "a.txt", hash: "111", size: 0 },
        { path: "c.txt", hash: "333", size: 0 },
      ]),
    ).toBe("384d77579354ce230d8a7465343e1530e2561eab48a94d63e0bf80f90307e24c");
  });

  it("different storage id yields different hash", () => {
    expect(computeContentHashFromHashes(STORAGE_B, [])).toBe(
      "d87bf91de459004a9512e649c3484a8ced316fe5547149ec3f6b6ae669ac79ff",
    );
  });

  it("nested paths sort lexicographically", () => {
    expect(
      computeContentHashFromHashes(STORAGE_A, [
        { path: "src/main.rs", hash: "bbb", size: 0 },
        { path: "README.md", hash: "ccc", size: 0 },
        { path: "src/lib.rs", hash: "aaa", size: 0 },
      ]),
    ).toBe("e7158d0cbdae3793daa8352a6197eab9f772d8cb8784c941d921e81f5d4b09d6");
  });
});
