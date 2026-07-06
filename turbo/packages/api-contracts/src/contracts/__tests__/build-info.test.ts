import { describe, expect, it } from "vitest";

import {
  buildCommitShaSchema,
  buildInfoContract,
  buildInfoResponseSchema,
  buildVersionSchema,
} from "../build-info";

const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("build info contract", () => {
  it("defines the build info endpoint", () => {
    expect(buildInfoContract.get.method).toBe("GET");
    expect(buildInfoContract.get.path).toBe("/api/build-info");
  });

  it("accepts a valid build info response body", () => {
    expect(
      buildInfoResponseSchema.parse({ commitSha: TEST_SHA, version: "1.2.3" }),
    ).toEqual({
      commitSha: TEST_SHA,
      version: "1.2.3",
    });
    expect(
      buildInfoResponseSchema.parse({ commitSha: null, version: null }),
    ).toEqual({ commitSha: null, version: null });
    expect(buildInfoResponseSchema.parse({ commitSha: TEST_SHA })).toEqual({
      commitSha: TEST_SHA,
    });
  });

  it("rejects malformed commit SHAs", () => {
    expect(buildCommitShaSchema.safeParse("local-dev").success).toBe(false);
    expect(buildCommitShaSchema.safeParse("abc123").success).toBe(false);
    expect(buildCommitShaSchema.safeParse(TEST_SHA.toUpperCase()).success).toBe(
      false,
    );
  });

  it("rejects malformed build versions", () => {
    expect(buildVersionSchema.safeParse("").success).toBe(false);
  });
});
