import { describe, expect, it } from "vitest";

import { computeContentHashFromHashes } from "../storage-content-hash.service";

describe("computeContentHashFromHashes", () => {
  it("sorts formatted entries like JavaScript default string sort", () => {
    const got = computeContentHashFromHashes(
      "01234567-89ab-cdef-0123-456789abcdef",
      [
        { path: "\uE000.txt", hash: "222", size: 0 },
        { path: "\u{1F4A9}.txt", hash: "111", size: 0 },
      ],
    );

    expect(got).toBe(
      "537ee6d2902093ce26bea40719e1236c99f1d5394e26445cfe9cd6d9ae228f61",
    );
  });
});
