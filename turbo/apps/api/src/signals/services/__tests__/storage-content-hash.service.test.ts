import { describe, expect, it } from "vitest";

import {
  computeContentHashFromHashes,
  computeSystemSkillContentHash,
  type FileEntryWithHash,
} from "../storage-content-hash.service";

const STORAGE_A = "01234567-89ab-cdef-0123-456789abcdef";
const STORAGE_B = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function file(path: string, hash: string, size = 1): FileEntryWithHash {
  return { path, hash, size };
}

describe("computeContentHashFromHashes", () => {
  it.each([
    {
      name: "empty storage",
      storageId: STORAGE_A,
      files: [],
      expected:
        "afde087ee3ce79ab8360daf49e5f68fe1bbb49153775fff6eff5e7ccd7ecdb57",
    },
    {
      name: "single file",
      storageId: STORAGE_A,
      files: [file("a.txt", HASH_A)],
      expected:
        "b7c8d9f8fe72381faeeeff30bab820e075ff048240f16ccc3ecec23e6ab32918",
    },
    {
      name: "multiple files",
      storageId: STORAGE_A,
      files: [
        file("b.txt", HASH_B),
        file("a.txt", HASH_A),
        file("c.txt", HASH_C),
      ],
      expected:
        "4a91b8c9ac9c083131b960cc1d97d25aab243b841e29cbbd187597e6b82d5231",
    },
    {
      name: "colon path",
      storageId: STORAGE_A,
      files: [file("dir:name/file.txt", HASH_A)],
      expected:
        "24eb7994557105120ffa3f444cb7384d275a9a0e6ffe53d8828366af54375b93",
    },
    {
      name: "newline path",
      storageId: STORAGE_A,
      files: [file("line1\nline2.txt", HASH_A)],
      expected:
        "26d1a10c31ec4a704d4a76dcb858fb7633495c012624c07b99d31cdbee376740",
    },
    {
      name: "non-BMP path",
      storageId: STORAGE_A,
      files: [file("emoji-😀.txt", HASH_A)],
      expected:
        "231bec6d6d3c0d8ae2e9d740cf476156aa0fb7d555ccccf3acd033bc784842dd",
    },
    {
      name: "different storage id",
      storageId: STORAGE_B,
      files: [],
      expected:
        "2fc5c81fee486da6a906b4c3e2d0036c3580784963a75521d817b4c54b055da7",
    },
  ])("matches the v2 golden vector for $name", (testCase) => {
    expect(
      computeContentHashFromHashes(testCase.storageId, testCase.files),
    ).toBe(testCase.expected);
  });

  it("computes the same hash regardless of file order", () => {
    const files = [
      file("b.txt", HASH_B),
      file("a.txt", HASH_A),
      file("c.txt", HASH_C),
    ];

    expect(computeContentHashFromHashes(STORAGE_A, files)).toBe(
      computeContentHashFromHashes(STORAGE_A, [...files].reverse()),
    );
  });

  it("canonicalizes file hash casing", () => {
    expect(
      computeContentHashFromHashes(STORAGE_A, [file("a.txt", HASH_A)]),
    ).toBe(
      computeContentHashFromHashes(STORAGE_A, [
        file("a.txt", HASH_A.toUpperCase()),
      ]),
    );
  });

  it("separates file lists that collided under the old text format", () => {
    const first = computeContentHashFromHashes(STORAGE_A, [
      file("a", "1".repeat(64)),
      file("b", "2".repeat(64)),
    ]);
    const second = computeContentHashFromHashes(STORAGE_A, [
      file(`a:${"1".repeat(64)}\nb`, "2".repeat(64)),
    ]);

    expect(first).toBe(
      "49ebfcd2f3a4d5050ab39c789f5bed874014ebae3efa9cc08af3c79db5ab8def",
    );
    expect(second).toBe(
      "365babcde9af438dbba697ccfec0260f7a704785e481a4842cfaaf0468eb68b5",
    );
    expect(first).not.toBe(second);
  });

  it("rejects invalid file hashes", () => {
    expect(() => {
      computeContentHashFromHashes(STORAGE_A, [file("a.txt", "g".repeat(64))]);
    }).toThrow("File hash must be SHA-256 hex");
  });
});

describe("computeSystemSkillContentHash", () => {
  it("uses a canonical file-list hash with a separate domain", () => {
    expect(
      computeSystemSkillContentHash(
        "https://github.com/vm0-ai/vm0-skills/tree/main/base44",
        [
          file("SKILL.md", HASH_A, 100),
          file("refs/examples:demo.md", HASH_B, 50),
        ],
      ),
    ).toBe("e764015f47875727a22b46c03cc1e0d37bba7bbd3fab32e9a0d9eda688ef689b");
  });
});
